import type {
  CategorizeBatchSummary,
  CategorizeResponse,
  Customer,
  ItemMatch,
  KeywordOverride,
  ModelInfo,
  UnmatchedItem,
} from "../types.js";
import { CODEC_ACCOUNT_EU_ID } from "../types.js";
import type { Firm, ItemSubset } from "./store.js";
import { DEMO_CATEGORIZE_RESPONSE } from "./api-mock.js";

interface ModelsResponse {
  default: string;
  models: ModelInfo[];
}

const DEMO_MODELS_RESPONSE: ModelsResponse = {
  default: "demo-mock",
  models: [{ id: "demo-mock", label: "Demo Mock", recommended: true }],
};

export async function fetchModels(
  proxyUrl: string,
  demoMode = false,
): Promise<ModelsResponse> {
  if (demoMode) return DEMO_MODELS_RESPONSE;
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
  opts: { stallTimeoutMs?: number; signal?: AbortSignal; demoMode?: boolean } = {},
): Promise<CategorizeResponse> {
  // Demo mode short-circuits the SSE stream — emits one batch-done then
  // a done event so the live progress UI still ticks. No network round-trip.
  if (opts.demoMode) {
    onProgress?.({
      batchIndex: 0,
      batchesTotal: 1,
      accumulatedMatches: 0,
      currentBatchSize: items.length,
      batchSummaries: {},
      finishedBatches: [],
      timedOutBatches: [],
      currentTimeoutMs: 90_000,
      consecutiveTimeouts: 0,
    });
    await sleep(50);
    onProgress?.({
      batchIndex: 0,
      batchesTotal: 1,
      accumulatedMatches: DEMO_CATEGORIZE_RESPONSE.matches.length,
      currentBatchSize: items.length,
      batchSummaries: {
        0: {
          i: 0,
          size: items.length,
          matches: DEMO_CATEGORIZE_RESPONSE.matches.length,
          accumulated: DEMO_CATEGORIZE_RESPONSE.matches.length,
          matchesList: DEMO_CATEGORIZE_RESPONSE.matches,
        },
      },
      finishedBatches: [0],
      timedOutBatches: [],
      currentTimeoutMs: 90_000,
      consecutiveTimeouts: 0,
    });
    return DEMO_CATEGORIZE_RESPONSE;
  }

  // Default stall ceiling — large enough that a 752-item run with the
  // warm-up pass + a slow tail batch (~204 s observed) doesn't get killed
  // by the timer even though events ARE flowing the whole time. The timer
  // is activity-based (reset on every reader.read() resolution below), so
  // a TRULY stuck proxy still surfaces an error fast — within
  // `stallTimeoutMs` of the LAST byte received, not of the fetch start.
  const stallTimeoutMs = opts.stallTimeoutMs ?? 600_000;

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
  // Running accumulator of every match produced by every completed batch
  // so far. Used to synthesise a partial result on error / stall / abort.
  // The proxy's `batch-done` event now carries the full matches array
  // (was just a count), so we can persist incrementally in /analyze.
  let accumulatedMatches: ItemMatch[] = [];
  let donePayload: CategorizeResponse | null = null;
  let errorMessage: string | null = null;

  // Activity-based stall timer: an absolute deadline that pump() resets
  // on every byte received from the proxy (heartbeats included). The
  // stall guard sleeps in small chunks and only throws when the deadline
  // is actually in the past — so a slow but-live run never trips the
  // timer, only a truly stuck proxy does.
  //
  // Bug history (2026-08-28): the previous timer was total wall-clock
  // and killed a 752-item run at t=180s even though batches 1..6 + 8..16
  // had all streamed through (only batch 7 was still in flight at
  // t=180s, finished at t=204s). Activity-based timer avoids that.
  let stallDeadline = Date.now() + stallTimeoutMs;
  const bumpStall = () => {
    stallDeadline = Date.now() + stallTimeoutMs;
  };

  const pump = async () => {
    while (true) {
      const { value, done } = await reader.read();
      // ANY chunk from the proxy — heartbeat or batch event — proves
      // the connection is alive. Reset the stall deadline BEFORE
      // processing the bytes so heartbeats also count as activity.
      if (!done) bumpStall();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line.
      let nl: number;
      while ((nl = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const parsed = parseSseEvent(raw);
        if (!parsed) continue;
        // Comments (heartbeats) start with ':' and carry no data, but
        // the bytes still count as activity — bump() ran above before
        // we got here, so heartbeats also reset the stall deadline.
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
          // Since 2026-08-28 the proxy ships the FULL matches array in
          // batch-done (it used to be just a count). Older proxies may
          // still send a number; we tolerate either shape.
          const rawMatches = data.matches as unknown;
          const batchMatchesList: ItemMatch[] = Array.isArray(rawMatches)
            ? (rawMatches as ItemMatch[])
            : [];
          const batchMatchesCount =
            typeof rawMatches === "number"
              ? rawMatches
              : batchMatchesList.length;
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
              [idx]: {
                i: idx,
                size,
                matches: batchMatchesCount,
                accumulated,
                matchesList: batchMatchesList,
              },
            },
            finishedBatches: info.finishedBatches.includes(idx)
              ? info.finishedBatches
              : [...info.finishedBatches, idx],
          };
          // Append this batch's matches to our running accumulator so
          // we can synthesise a partial donePayload on a mid-run abort.
          if (batchMatchesList.length > 0) {
            accumulatedMatches = accumulatedMatches.concat(batchMatchesList);
          }
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

  // Race the pump against an activity-based stall timer. Every byte
  // the proxy sends resets the deadline (`stallDeadline.bump()` inside
  // pump()), so a slow but-live run never trips the timer — only a
  // truly stuck proxy (no bytes for `stallTimeoutMs` straight) does.
  // Also race the caller's AbortSignal so a UI cancel doesn't have to
  // wait out the full stall window.
  let abortHandler: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    abortHandler = () => reject(new DOMException("aborted", "AbortError"));
    opts.signal?.addEventListener("abort", abortHandler);
  });

  const stallGuard = (async () => {
    while (true) {
      const remaining = Math.max(50, stallDeadline - Date.now());
      await sleep(remaining);
      if (Date.now() >= stallDeadline) {
        throw new Error(
          `proxy /categorize: no data for ${Math.round(stallTimeoutMs / 1000)}s (stalled)`,
        );
      }
      // Deadline got bumped during the sleep — loop again with the new remaining.
    }
  })();

  try {
    await Promise.race([pump(), stallGuard, aborted]);
  } finally {
    if (abortHandler) opts.signal?.removeEventListener("abort", abortHandler);
  }

  // Mid-run recovery: the run didn't reach a `done` event, but if we have
// any matches accumulated already we MUST surface them so the operator
// doesn't lose work to a later timeout / error / abort. Salvage the
// partial result into a synthesised CategorizeResponse; only throw when
// there's nothing at all to return.
if (!donePayload && accumulatedMatches.length > 0) {
  donePayload = {
    model,
    batches: info.batchesTotal ?? 0,
    items: accumulatedMatches.length,
    matches: accumulatedMatches,
    partial: true,
    failedBatches: [
      {
        batchIndex: -1,
        error:
          errorMessage ?? "proxy /categorize: stream ended without 'done' event",
      },
    ],
  };
}
if (errorMessage && !donePayload) {
  throw new Error(errorMessage);
}
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
  /**
   * transactionIds the operator explicitly removed from the table via the
   * per-row ✕ button. Treated like `chargedIds`: filtered out before
   * bucketing, never written to a row, drop a row to empty when every
   * match is in this set.
   */
  ignoredIds?: ReadonlySet<number>;
}

const EMPTY_SET: ReadonlySet<number> = new Set<number>();

/**
 * Bucket AI matches into rows. Rows with suggestedAccountEuId === null are
 * merged into a single synthetic '__codec_fallback__' row, presented to the
 * operator under "Codec'e ücretlendir".
 *
 * Rows whose every match is already charged are dropped — the operator
 * doesn't need to act on them. Already-charged txIds and operator-removed
 * (ignored) txIds are filtered out before bucketing; both lists reduce the
 * row's match count identically so the same `if (ms.length === 0) continue`
 * rule applies for either cause.
 */
export function buildKeywordRows(
  matches: ItemMatch[],
  chargedIds: ReadonlySet<number>,
  opts: BuildKeywordRowsOptions = {},
): KeywordRow[] {
  const ignoredIds = opts.ignoredIds ?? EMPTY_SET;
  const byGroup = new Map<string, ItemMatch[]>();
  let codecRow: ItemMatch[] = [];

  for (const m of matches) {
    // Partial-result guard: when an upstream batch fails (timeout, 5xx,
    // malformed tool_use input) the preallocated slot in `allMatches`
    // stays `undefined`, which JSON-stringifies as `null` in the
    // CategorizeResponse. We never get a chance to retry those
    // transactions here — the operator must click "Tekrar dene" on the
    // Analyze step. Skip the slot so the rest of the table stays usable.
    if (m == null) continue;
    if (chargedIds.has(m.transactionId)) continue; // greyed out — already charged
    if (ignoredIds.has(m.transactionId)) continue; // operator removed it from the table
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
 * Normalize an `accountEuId`-shaped value coming from the AI / persisted
 * session. Treats JS `null`/`undefined`, the literal STRING `"null"`, and
 * empty strings as "no firm" — returns `null` in those cases.
 *
 * Why this lives here: the AI tool schema and earlier `validateMatches`
 * already coerce JS null to `null`, but the LLM sometimes emits the
 * 4-character JSON STRING `"null"` instead (the tool schema's
 * `type: "string"` allowed it; the description just said "or null"). That
 * string survived `m.suggestedAccountEuId ?? null`, went through
 * `buildKeywordRows` (which uses strict `=== null` for the Codec bucket),
 * and ended up as the `row.suggestedAccountEuId` for a normal keyword row.
 * `resolveFirm` then handed it straight to `chargeOnce` and the POST body
 * was `"accountEuId": "null"` — which the server rejected with a GUID
 * validation error. This sanitizer is the chokepoint that makes
 * `resolveFirm` immune to that mis-shape.
 */
export function sanitizeAccountEuId(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed === "" || trimmed === "null") return null;
  return trimmed;
}

/**
 * Resolve the firm (accountEuId + accountName) that `chargeOnce` will use
 * for a given row. Pure helper — extracted from StepReview.tsx so the
 * codec-fallback semantics can be regression-tested.
 *
 * CRITICAL: the `__codec_fallback__` group ALWAYS returns the HAR-confirmed
 * UUID `00000000-0000-0000-0000-000000000000`. The admin-panel-api rejects
 * any other `accountEuId` for these rows with a GUID validation error, so
 * a stray override (or a stale `suggestedAccountEuId`) would silently send
 * `null` / a wrong UUID and break the POST. The override entry for a Codec
 * row is dropped at the source by `setRowFirm` (in StepReview), but this
 * function is the defense-in-depth that guarantees the UUID regardless.
 *
 * For non-Codec rows the AI's `suggestedAccountEuId` is run through
 * `sanitizeAccountEuId` so a literal string `"null"` (or any other
 * mis-shape) does NOT become the `accountEuId` we end up POSTing.
 */
export function resolveFirm(
  row: KeywordRow,
  firmOverrides: Record<
    string,
    { accountEuId: string; accountName: string | null }
  > | undefined,
): { accountEuId: string; accountName: string | null } {
  if (row.group === "__codec_fallback__") {
    return { accountEuId: CODEC_ACCOUNT_EU_ID, accountName: "Codec" };
  }
  const override = firmOverrides?.[row.group];
  if (override) {
    const sanitized = sanitizeAccountEuId(override.accountEuId);
    if (sanitized) return { accountEuId: sanitized, accountName: override.accountName };
  }
  const sanitized = sanitizeAccountEuId(row.suggestedAccountEuId);
  return {
    accountEuId: sanitized ?? CODEC_ACCOUNT_EU_ID,
    accountName: row.suggestedAccountName ?? "Codec",
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

// --- Per-txId firm resolution + flat firm-table grouping ------------------
//
// Below this banner: helpers for the firm-flat view in StepReview.tsx,
// where one table per firm holds every txId routed to that firm (across
// all AI keyword rows), and the operator can manually reassign any
// single txId to a different firm. The cross-firm contamination guard
// (defense layer #1 — see `docs/SAFETY-CONTRACT.md`) lives here.

export interface FirmSectionItem {
  transactionId: number;
  row: KeywordRow;
  match: ItemMatch;
  effectiveFirm: Firm;
  /**
   * Which layer of the precedence chain won for this item. Used by the
   * UI to apply a "tx-override" badge so the operator can see WHICH
   * txIds they've personally reassigned (vs. row-level overrides
   * inherited from the dropdown, vs. AI suggestions).
   */
  source: "tx-override" | "row-override" | "suggested" | "codec-fallback";
}

export interface FirmSection {
  /** Unique grouping key — equals `accountEuId` for every section. */
  firmKey: string;
  accountEuId: string;
  accountName: string | null;
  items: FirmSectionItem[];
  /** How many of `items` are in the operator's flat selection set. */
  selectedCount: number;
}

/**
 * Resolve the firm for a single txId RIGHT NOW, given the full state the
 * caller already has. Precedence (highest first):
 *   1. `txFirmOverrides[txId]`         — operator-set per-tx reassignment
 *   2. `firmOverrides[row.group]`       — operator-set per-row override
 *   3. `row.suggestedAccountEuId`       — AI suggestion (sanitized)
 *   4. `CODEC_ACCOUNT_EU_ID`            — safety-net Codec fallback
 *
 * This helper is the single source of truth for "what firm does this
 * txId belong to at this exact moment?". The charge handler MUST call
 * this for every txId in the POST — see `chargeFirm` in StepReview.tsx.
 * Caching the result across renders is forbidden; the whole point of
 * precedence layer #1 is that the operator can flip a single txId and
 * see the next render charge it under the new firm.
 */
export function resolveFirmForTx(
  txId: number,
  row: KeywordRow,
  firmOverrides: Record<string, Firm> | undefined,
  txFirmOverrides: Record<number, Firm> | undefined,
): Firm {
  const txOv = txFirmOverrides?.[txId];
  if (txOv) {
    const s = sanitizeAccountEuId(txOv.accountEuId);
    if (s) return { accountEuId: s, accountName: txOv.accountName };
  }
  // delegate to the existing helper so all the previously-tested sanitization
  // paths (string "null", null suggestion, override sanitization) still apply.
  return resolveFirm(row, firmOverrides);
}

/**
 * Walk the AI's keyword rows, resolve every txId to its CURRENT firm,
 * and bucket them into one section per firm. The output is a flat
 * table — one section per firm, no nested grouping by keyword.
 *
 * Pure helper — re-runs cheaply on every render. `rows` is assumed to
 * already be the `buildKeywordRows` output (charged + ignored filtered);
 * this function does not re-filter.
 *
 * Section order:
 *   1. Real firms first (by name, Turkish locale-aware).
 *   2. The Codec fallback section last if present.
 *
 * Within each section, items are sorted by `transactionId` ascending so
 * the operator can scan the table top-to-bottom without re-sorting.
 */
export function groupByFirm(
  rows: readonly KeywordRow[],
  firmOverrides: Record<string, Firm> | undefined,
  txFirmOverrides: Record<number, Firm> | undefined,
  selected: ReadonlySet<number>,
): FirmSection[] {
  const byFirm = new Map<
    string,
    { accountName: string | null; items: FirmSectionItem[]; selectedCount: number }
  >();
  const tr = (s: string) => s.toLocaleLowerCase("tr-TR");

  for (const row of rows) {
    for (const match of row.matches) {
      const txId = match.transactionId;
      const firm = resolveFirmForTx(txId, row, firmOverrides, txFirmOverrides);
      const key = firm.accountEuId;
      const source: FirmSectionItem["source"] =
        txFirmOverrides?.[txId]?.accountEuId === firm.accountEuId
          ? "tx-override"
          : firmOverrides?.[row.group]?.accountEuId === firm.accountEuId
            ? "row-override"
            : row.group === "__codec_fallback__"
              ? "codec-fallback"
              : "suggested";

      let section = byFirm.get(key);
      if (!section) {
        section = { accountName: firm.accountName, items: [], selectedCount: 0 };
        byFirm.set(key, section);
      }
      // If multiple sources disagree on the name for the same UUID, keep
      // the first we saw — names are display-only and the server keys
      // by UUID, so this is purely cosmetic.
      if (section.accountName == null && firm.accountName != null) {
        section.accountName = firm.accountName;
      }
      section.items.push({
        transactionId: txId,
        row,
        match,
        effectiveFirm: firm,
        source,
      });
      if (selected.has(txId)) section.selectedCount += 1;
    }
  }

  // Sort each section's items by txId ascending — stable, easy to scan.
  for (const section of byFirm.values()) {
    section.items.sort((a, b) => a.transactionId - b.transactionId);
  }

  // Sort sections: real firms first (by name), Codec fallback last.
  const sections: FirmSection[] = [];
  const codecSections: FirmSection[] = [];
  for (const [firmKey, sec] of byFirm) {
    const out: FirmSection = {
      firmKey,
      accountEuId: firmKey,
      accountName: sec.accountName ?? "Codec",
      items: sec.items,
      selectedCount: sec.selectedCount,
    };
    if (firmKey === CODEC_ACCOUNT_EU_ID) codecSections.push(out);
    else sections.push(out);
  }
  sections.sort((a, b) => tr(a.accountName ?? "").localeCompare(tr(b.accountName ?? "")));
  return [...sections, ...codecSections];
}

/**
 * Walk every firm section, return the txIds the operator has selected
 * grouped by section. Used by the charge handler so each section's
 * "Ücretlendir" button can pull only the ids that still belong to that
 * section under the current `txFirmOverrides` map.
 *
 * If a txId was selected under section A and then reassigned to section
 * B, this function surfaces it under section B (not A) — so the stale
 * A-side selection becomes a no-op rather than mixing firms.
 */
export function flattenSelected(
  sections: readonly FirmSection[],
  selected: ReadonlySet<number>,
): { firmKey: string; accountEuId: string; accountName: string | null; txIds: number[] }[] {
  const out: {
    firmKey: string;
    accountEuId: string;
    accountName: string | null;
    txIds: number[];
  }[] = [];
  for (const section of sections) {
    if (section.selectedCount === 0) continue;
    const txIds: number[] = [];
    for (const item of section.items) {
      if (selected.has(item.transactionId)) txIds.push(item.transactionId);
    }
    if (txIds.length === 0) continue;
    out.push({
      firmKey: section.firmKey,
      accountEuId: section.accountEuId,
      accountName: section.accountName,
      txIds,
    });
  }
  return out;
}

// --- Bulk-copy formats -----------------------------------------------------

/**
 * txId listesi için kullanıcının clipboard'a kopyalamak istediği format
 * tipleri. Eski "Seçili (N) Ücretlendir" butonunun yanına eklenen
 * dropdown / buton grubu bu enum'dan beslenir.
 *
 * - `sql`: SQL `IN (...)` için tek-tırnaklı liste → `('1001','1002',...)`.
 *   Backend `WHERE transactionId IN (...)` sorgularına yapıştırmak için.
 * - `csv`: Virgülle ayrılmış düz liste → `1001,1002,1003`. Excel'e
 *   yapıştırınca tek satır, hücreler ayrı.
 * - `lines`: Satır başına tek txId → `1001\n1002\n1003`. Excel'e yapıştırınca
 *   dikey sütun; ayrıca Slack/Teams mesajı olarak okunaklı.
 * - `json`: JSON dizisi → `["1001","1002",...]`. Script'lere geçmek için.
 */
export type BulkCopyFormat = "sql" | "csv" | "lines" | "json";

export const BULK_COPY_FORMATS: readonly BulkCopyFormat[] = [
  "sql",
  "csv",
  "lines",
  "json",
];

/** Display label for the copy-format buttons. */
export function bulkCopyLabel(format: BulkCopyFormat): string {
  switch (format) {
    case "sql":
      return "SQL";
    case "csv":
      return "CSV";
    case "lines":
      return "Satır";
    case "json":
      return "JSON";
  }
}

/**
 * Seçili txId listesini istenen formata çevir. Pure helper; UI çağırır,
 * çıktıyı `navigator.clipboard.writeText` ile panoya yazar.
 *
 * Hiçbir seçim yoksa null döner — caller toast ile uyarır.
 */
export function formatTxIdsForCopy(
  ids: readonly number[],
  format: BulkCopyFormat,
): string | null {
  if (ids.length === 0) return null;
  // Stable order: küçükten büyüğe sırala. chargeOnce zaten POST'a
  // gönderirken sırayı backend'e bırakır ama clipboard'a kopyalanan
  // metnin deterministik olması operatör için önemli (diff/paste).
  const sorted = [...ids].sort((a, b) => a - b);
  switch (format) {
    case "sql":
      return `('${sorted.join("','")}')`;
    case "csv":
      return sorted.join(",");
    case "lines":
      return sorted.join("\n");
    case "json":
      return JSON.stringify(sorted.map(String));
  }
}
