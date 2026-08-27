import type {
  CategorizeBatchSummary,
  CategorizeResponse,
  Customer,
  ItemMatch,
  KeywordOverride,
  ModelInfo,
  UnmatchedItem,
} from "../types.js";
import type { ItemSubset } from "./store.js";

interface ModelsResponse {
  default: string;
  models: ModelInfo[];
}

export async function fetchModels(proxyUrl: string): Promise<ModelsResponse> {
  const res = await fetch(`${proxyUrl}/models`);
  if (!res.ok) throw new Error(`proxy /models ${res.status}`);
  return res.json();
}

export interface CategorizeProgressInfo {
  /** 0-based index of the most recently started batch. */
  batchIndex?: number;
  /** Total batch count. Filled in once the first batch-start arrives. */
  batchesTotal: number | null;
  /** Match count so far (sum of matches across completed batches). */
  accumulatedMatches: number;
  /** Size of the current batch (items in flight). */
  currentBatchSize?: number;
  /** Per-batch summaries keyed by `i`. Populated as each batch finishes. */
  batchSummaries: Record<number, CategorizeBatchSummary>;
  /** Order in which batches finished — used to render the live list. */
  finishedBatches: number[];
  /** Indices of batches that timed out. UI surfaces these as warnings. */
  timedOutBatches: number[];
  /** Current adaptive timeout budget in ms (90s / 150s / 240s). */
  currentTimeoutMs: number;
  /** Consecutive timeouts so far — proxy raises the cap as this climbs. */
  consecutiveTimeouts: number;
}

/**
 * Stream /categorize as Server-Sent Events. Emits progress per batch
 * so the UI shows live counts even when the full run takes minutes
 * (multiple batches × MiniMax latency + retries).
 *
 * Throws on:
 *   - any non-2xx HTTP status
 *   - the proxy's `error` SSE event
 *   - the stream ending without a `done` event
 *   - a stall (no events for `stallTimeoutMs`)
 *   - the caller aborting via `opts.signal`
 */
export async function categorize(
  proxyUrl: string,
  model: string,
  items: UnmatchedItem[],
  customers: Customer[],
  overrides: KeywordOverride[] = [],
  onProgress?: (info: CategorizeProgressInfo) => void,
  opts: { stallTimeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CategorizeResponse> {
  // 3 minutes default — long enough for a 100-item batch under load
  // (worst observed: ~95s with 8 workers), but short enough that a
  // truly stuck proxy surfaces an error instead of hanging forever.
  const stallTimeoutMs = opts.stallTimeoutMs ?? 180_000;

  let res: Response;
  try {
    res = await fetch(`${proxyUrl}/categorize`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ items, customers, model, overrides }),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError") throw err;
    throw new Error(
      `proxy'ye bağlanılamadı (${proxyUrl}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `proxy /categorize ${res.status}: ${text.slice(0, 600) || "(boş gövde)"}`,
    );
  }
  if (!res.body) throw new Error("proxy /categorize: response has no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let info: CategorizeProgressInfo = {
    batchesTotal: null,
    accumulatedMatches: 0,
    batchSummaries: {},
    finishedBatches: [],
    timedOutBatches: [],
    currentTimeoutMs: 90_000,
    consecutiveTimeouts: 0,
  };
  let donePayload: CategorizeResponse | null = null;
  let errorMessage: string | null = null;

  const pump = async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line.
      let nl: number;
      while ((nl = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const parsed = parseSseEvent(raw);
        if (!parsed) continue;
        // Comments (heartbeats) start with ':' and carry no data.
        if (parsed.event === "comment") continue;
        const data = (parsed as SseEvent).data as Record<string, unknown>;
        if (parsed.event === "batch-start") {
          info = {
            ...info,
            batchIndex: data.i as number,
            batchesTotal: data.total as number,
            currentBatchSize: data.size as number,
          };
          onProgress?.(info);
        } else if (parsed.event === "batch-done") {
          const idx = data.i as number;
          const totalBatches = data.total as number;
          const batchMatches = data.matches as number;
          const accumulated = data.accumulated as number;
          // The proxy doesn't echo the batch size in batch-done, but the
          // matching batch-start did, so derive size from there.
          const prev = info.batchSummaries[idx];
          const size = prev?.size ?? 0;
          info = {
            ...info,
            batchIndex: idx,
            batchesTotal: totalBatches,
            accumulatedMatches: accumulated,
            batchSummaries: {
              ...info.batchSummaries,
              [idx]: { i: idx, size, matches: batchMatches, accumulated },
            },
            finishedBatches: info.finishedBatches.includes(idx)
              ? info.finishedBatches
              : [...info.finishedBatches, idx],
          };
          onProgress?.(info);
        } else if (parsed.event === "batch-timeout") {
          const idx = data.i as number;
          info = {
            ...info,
            timedOutBatches: info.timedOutBatches.includes(idx)
              ? info.timedOutBatches
              : [...info.timedOutBatches, idx],
            currentTimeoutMs: (data.timeoutMs as number) ?? info.currentTimeoutMs,
            consecutiveTimeouts:
              (data.consecutiveTimeouts as number) ?? info.consecutiveTimeouts,
          };
          onProgress?.(info);
        } else if (parsed.event === "done") {
          donePayload = {
            model: data.model as string,
            batches: data.batches as number,
            items: (data.items as number) ?? info.currentBatchSize ?? 0,
            matches: data.matches as CategorizeResponse["matches"],
            partial: (data.partial as boolean) ?? false,
            failedBatches: data.failedBatches as
              | CategorizeResponse["failedBatches"]
              | undefined,
          };
        } else if (parsed.event === "error") {
          errorMessage = data.error as string;
        }
      }
    }
  };

  // Race the pump against a stall timer. If we go `stallTimeoutMs`
  // without any data the proxy is probably stuck mid-batch; abort.
  // Also race the caller's AbortSignal so a UI cancel doesn't have to
  // wait out the full stall timer.
  let abortHandler: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    abortHandler = () => reject(new DOMException("aborted", "AbortError"));
    opts.signal?.addEventListener("abort", abortHandler);
  });

  try {
    await Promise.race([
      pump(),
      sleep(stallTimeoutMs).then(() => {
        throw new Error(
          `proxy /categorize stalled for ${Math.round(stallTimeoutMs / 1000)}s with no progress`,
        );
      }),
      aborted,
    ]);
  } finally {
    if (abortHandler) opts.signal?.removeEventListener("abort", abortHandler);
  }

  if (errorMessage) throw new Error(errorMessage);
  if (!donePayload) {
    throw new Error("proxy /categorize: stream ended without 'done' event");
  }
  return donePayload;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface SseEvent<T = unknown> {
  event: string;
  data: T;
}

function parseSseEvent(raw: string): SseEvent | { event: "comment" } | null {
  let event = "message";
  let data = "";
  for (const line of raw.split("\n")) {
    if (!line) continue;
    if (line.startsWith(":")) continue; // comment / heartbeat
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data += (data ? "\n" : "") + value;
  }
  if (event === "comment") return { event: "comment" };
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data: data as unknown };
  }
}

// --- Aggregations -----------------------------------------------------------

/**
 * Apply a user-chosen subset to the unmatched-items list. Returns the
 * slice that should be sent to /categorize. `null` subset / mode 'all'
 * returns the input unchanged.
 *
 * Half-open ranges are clamped to [0, items.length]; out-of-range
 * counts silently snap to "all available".
 */
export function applySubset<T>(items: T[], subset: ItemSubset | null | undefined): T[] {
  if (!subset || subset.mode === "all") return items;
  const total = items.length;
  switch (subset.mode) {
    case "head":
      return items.slice(0, Math.max(0, Math.min(subset.count, total)));
    case "tail":
      return items.slice(Math.max(0, total - subset.count));
    case "range": {
      const a = Math.max(0, Math.min(subset.start, total));
      const b = Math.max(a, Math.min(subset.end, total));
      return items.slice(a, b);
    }
  }
}

export interface KeywordRow {
  group: string; // keywordGroup slug, or "__codec_fallback__" for null-firm rows
  label: string; // human label
  suggestedAccountEuId: string | null;
  suggestedAccountName: string | null;
  matches: ItemMatch[];
  /** Min confidence across the row's matches. */
  worstConfidence: "high" | "medium" | "low";
  /** Dominant matchedField (the most common one in the row). */
  dominantField: "keyword1" | "keyword2" | "msgContent";
  /**
   * Stable key that groups rows by their *effective* firm:
   * override > most-common suggested > "__codec__". The UI uses this
   * to render visually-firm-grouped sections without merging rows
   * semantically (each row is still charged independently).
   */
  firmGroupKey: string;
}

export interface BuildKeywordRowsOptions {
  /**
   * Operator-applied per-row firm overrides (the same map stored on the
   * session). When present, the row's `firmGroupKey` reflects the
   * override rather than the AI's suggestion. Optional — missing keys
   * fall back to the AI's `suggestedAccountEuId`.
   */
  firmOverrides?: Record<
    string,
    { accountEuId: string; accountName: string | null }
  >;
}

/**
 * Bucket AI matches into rows. Rows with suggestedAccountEuId === null are
 * merged into a single synthetic '__codec_fallback__' row, presented to the
 * operator under "Codec'e ücretlendir".
 *
 * Rows whose every match is already charged are dropped — the operator
 * doesn't need to act on them. Already-charged txIds inside a still-active
 * row are filtered out before bucketing.
 */
export function buildKeywordRows(
  matches: ItemMatch[],
  chargedIds: ReadonlySet<number>,
  opts: BuildKeywordRowsOptions = {},
): KeywordRow[] {
  const byGroup = new Map<string, ItemMatch[]>();
  let codecRow: ItemMatch[] = [];

  for (const m of matches) {
    if (chargedIds.has(m.transactionId)) continue; // greyed out — already charged
    if (m.suggestedAccountEuId === null) {
      codecRow.push(m);
      continue;
    }
    const arr = byGroup.get(m.keywordGroup) ?? [];
    arr.push(m);
    byGroup.set(m.keywordGroup, arr);
  }

  const rows: KeywordRow[] = [];
  for (const [group, ms] of byGroup) {
    if (ms.length === 0) continue; // fully-charged bucket — drop the row
    rows.push(makeRow(group, ms, undefined, opts.firmOverrides?.[group]));
  }
  if (codecRow.length > 0) {
    rows.push(
      makeRow(
        "__codec_fallback__",
        codecRow,
        {
          suggestedAccountEuId: "00000000-0000-0000-0000-000000000000",
          suggestedAccountName: "Codec",
        },
        opts.firmOverrides?.["__codec_fallback__"],
      ),
    );
  }
  // Stable order: by count desc, then group name asc.
  rows.sort((a, b) => {
    const c = b.matches.length - a.matches.length;
    return c !== 0 ? c : a.group.localeCompare(b.group);
  });
  // Push codec fallback to the very bottom regardless of size.
  const codec = rows.find((r) => r.group === "__codec_fallback__");
  if (codec) {
    rows.splice(rows.indexOf(codec), 1);
    rows.push(codec);
  }
  return rows;
}

function makeRow(
  group: string,
  matches: ItemMatch[],
  override?: { suggestedAccountEuId: string | null; suggestedAccountName: string | null },
  firmOverride?: { accountEuId: string; accountName: string | null },
): KeywordRow {
  const fieldCount: Record<"keyword1" | "keyword2" | "msgContent", number> = {
    keyword1: 0,
    keyword2: 0,
    msgContent: 0,
  };
  let worst: "high" | "medium" | "low" = "high";
  for (const m of matches) {
    fieldCount[m.matchedField]++;
    if (worst === "high" && m.confidence !== "high") worst = m.confidence;
    else if (worst === "medium" && m.confidence === "low") worst = "low";
  }
  const dominantField =
    (Object.entries(fieldCount) as ["keyword1" | "keyword2" | "msgContent", number][])
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? "keyword1";

  // Pick the most common suggested account within the group as the row default.
  const accCount = new Map<string, number>();
  for (const m of matches) {
    if (!m.suggestedAccountEuId) continue;
    accCount.set(m.suggestedAccountEuId, (accCount.get(m.suggestedAccountEuId) ?? 0) + 1);
  }
  const topAcc = [...accCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const topMatch = topAcc ? matches.find((m) => m.suggestedAccountEuId === topAcc[0]) : null;

  // firmGroupKey: operator override > most-common suggested > "__codec__".
  // Used by the UI to render visually-firm-grouped sections. Empty string
  // means "no key computed" (kept stable for back-compat with tests
  // constructed without firmOverrides).
  let firmGroupKey = "";
  if (firmOverride?.accountEuId) {
    firmGroupKey = firmOverride.accountEuId;
  } else if (topAcc) {
    firmGroupKey = topAcc[0];
  } else if (group === "__codec_fallback__") {
    firmGroupKey = "__codec__";
  }

  return {
    group,
    label: group === "__codec_fallback__" ? "Codec'e ücretlendir" : group,
    suggestedAccountEuId: override?.suggestedAccountEuId ?? topMatch?.suggestedAccountEuId ?? null,
    suggestedAccountName: override?.suggestedAccountName ?? topMatch?.suggestedAccountName ?? null,
    matches,
    worstConfidence: worst,
    dominantField,
    firmGroupKey,
  };
}

/**
 * Group operator-selected txIds by their keyword row so the action bar's
 * "Ücretlendir" button can dispatch ONE POST per row with only the
 * selected ids. Pure helper — extracted from StepReview.tsx so we can
 * regression-test that unselected txIds never leak into the payload.
 *
 *  - `rows`             all keyword rows for the current analysis
 *  - `selectedByRow`    Map<rowGroup, Set<txId>> of operator selections
 *
 * Returns an ordered list of `{ row, ids }` for every row that has at
 * least one selected txId. `ids` is the intersection of the row's own
 * matches with the operator's selection — so even if the operator
 * somehow puts a txId into the set that no longer belongs to the row
 * (stale state), it would still be filtered out.
 */
export function groupSelectionByRow(
  rows: readonly KeywordRow[],
  selectedByRow: ReadonlyMap<string, ReadonlySet<number>>,
): { row: KeywordRow; ids: number[] }[] {
  const out: { row: KeywordRow; ids: number[] }[] = [];
  for (const row of rows) {
    const sel = selectedByRow.get(row.group);
    if (!sel || sel.size === 0) continue;
    const allowed = new Set(row.matches.map((m) => m.transactionId));
    const ids: number[] = [];
    for (const id of sel) {
      if (allowed.has(id)) ids.push(id);
    }
    if (ids.length > 0) out.push({ row, ids });
  }
  return out;
}

/**
 * Flatten the operator's selection to a list of (row, txId) pairs, in row
 * order then by txId ascending. Used by the copy action bar to format
 * selected ids for clipboard output.
 */
export function flattenSelection(
  rows: readonly KeywordRow[],
  selectedByRow: ReadonlyMap<string, ReadonlySet<number>>,
): { row: KeywordRow; txId: number }[] {
  const out: { row: KeywordRow; txId: number }[] = [];
  for (const row of rows) {
    const sel = selectedByRow.get(row.group);
    if (!sel) continue;
    const sorted = [...sel].sort((a, b) => a - b);
    for (const txId of sorted) out.push({ row, txId });
  }
  return out;
}
