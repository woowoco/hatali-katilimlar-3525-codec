import Anthropic from "@anthropic-ai/sdk";
import type {
  CategorizeRequest,
  CategorizeResponse,
  Customer,
  ItemMatch,
  KeywordOverride,
  UnmatchedItem,
} from "./types.js";
import {
  ITEM_ANNOTATIONS_TOOL,
  buildSystemPrompt,
  buildUserPrompt,
  chunkItems,
  validateMatches,
} from "./prompts.js";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
/**
 * Per-batch retry budget. Reduced from 3 → 2 because a 3-attempt budget
 * with adaptive timeouts (90 → 90 → 150) lets one slow batch monopolise
 * 5+ minutes of wall-clock time while 15 healthy batches sit idle — the
 * rest of the work would already be done if we'd moved on sooner. With
 * 2 attempts the worst case per bad batch is ~3 minutes (90 + 90 + small
 * backoff), and the operator still sees every txId via the Codec-fallback
 * synthesis path the worker uses after the second timeout.
 */
const MAX_RETRIES = 2;

/** Per-call deadline for one MiniMax request. Starts at the observed
 *  worst-case (~80 s for a 50-item batch under heavy parallelism) and
 *  climbs adaptively when consecutive calls time out — the proxy then
 *  surfaces a `batch-timeout` SSE event so the UI can warn the operator
 *  that some batches were dropped instead of letting the whole run die. */
const INITIAL_TIMEOUT_MS = 90_000;
const MAX_TIMEOUT_MS = 240_000;
const GLOBAL_BUDGET_MS = 10 * 60 * 1000;

/** Cap on recursive split-retry depth. log2(50)≈6 otherwise, which can
 *  cascade into multi-minute hangs even though each leaf is small. */
const MAX_SPLIT_DEPTH = 3;

/** Concurrent batches in flight. Tuned against MiniMax-M3 on 2026-08-27:
 *   1 worker × 50 items  → ~22 s, single batch
 *   3 workers × 100      → ~191 s for 300 items (slow)
 *   8 workers × 100      →  ~94 s for 800 items (some max_tokens cuts)
 *  16 workers × 50       →  ~78 s for 800 items (clean, no rate-limit)
 * Going beyond 16 has diminishing returns and risks MiniMax throttling. */
const CONCURRENCY = 16;

/**
 * Per-call deadline that climbs when the API keeps timing out. The first
 * hang uses the initial value (90 s in production, smaller in tests);
 * the second uses 150 s; the third and beyond stay at 240 s. Once any
 * call returns inside its window, the deadline resets to the initial
 * value — so a recovered API isn't penalised forever.
 *
 * Shared across all workers in a single categorize() run so the budget
 * is decided once and stays consistent between parallel callers.
 */
class AdaptiveTimeout {
  private current: number;
  private readonly initialMs: number;
  private readonly maxMs: number;
  private consecutiveTimeouts = 0;
  private readonly startedAt = Date.now();
  private readonly globalBudget: number;

  constructor(
    initial: number = INITIAL_TIMEOUT_MS,
    globalBudget: number = GLOBAL_BUDGET_MS,
    max: number = MAX_TIMEOUT_MS,
  ) {
    this.current = initial;
    this.initialMs = initial;
    this.maxMs = max;
    this.globalBudget = globalBudget;
  }

  /** True if the run has exceeded the global wall-clock budget. */
  isBudgetExceeded(): boolean {
    return Date.now() - this.startedAt >= this.globalBudget;
  }

  /** Current deadline to pass into setTimeout for the next call. */
  get ms(): number {
    return this.current;
  }

  /** Record a successful call — reset the backoff counter. */
  recordSuccess(): void {
    this.consecutiveTimeouts = 0;
    this.current = this.initialMs;
  }

  /** Record a timeout — bump the deadline toward the next tier.
   *  Tier scheme (matches the production narrative in the comment above):
   *    - 1st timeout → still use initial (we just learned what initial was)
   *    - 2nd timeout → 150 s
   *    - 3rd+ timeout → ceiling (240 s in production)
   */
  recordTimeout(): void {
    const tier = this.consecutiveTimeouts; // 0-based: first timeout = tier 0
    this.consecutiveTimeouts++;
    if (tier === 0) {
      this.current = this.initialMs;
    } else if (tier === 1) {
      this.current = Math.min(150_000, this.maxMs);
    } else {
      this.current = this.maxMs;
    }
  }
}

export interface CategorizeProgress {
  signal?: AbortSignal;
  onBatchStart?: (batchIndex: number, totalBatches: number, size: number) => void;
  onBatchDone?: (
    batchIndex: number,
    totalBatches: number,
    matches: ItemMatch[],
  ) => void;
  onBatchTimeout?: (
    batchIndex: number,
    totalBatches: number,
    timeoutMs: number,
    consecutiveTimeouts: number,
  ) => void;
  /**
   * Override the initial per-call timeout (ms). Used by tests to make
   * the adaptive budget observable in a fraction of a second. Production
   * callers leave this unset and the 90s default applies.
   */
  initialTimeoutMsOverride?: number;
  /**
   * Override the global wall-clock budget (ms). Tests shrink it to
   * force the budget-exceeded short-circuit; production callers leave
   * it unset.
   */
  globalBudgetMsOverride?: number;
  /**
   * Override the per-batch retry budget (default 3). Tests set this to
   * 1 so they don't wait through three exponential-backoff sleeps when
   * they're deliberately simulating a hang.
   */
  maxRetriesOverride?: number;
  /**
   * Override the ceiling tier (default 240 s). Tests shrink it so they
   * can verify the escalation reaches the ceiling within a fraction of
   * a second — production stays at 240 s.
   */
  maxTimeoutMsOverride?: number;
}

/**
 * Run per-item annotation across all unmatched items. Talks to MiniMax in
 * 50-sized chunks with up to CONCURRENCY batches in flight.
 * Returns one match record per input item.
 *
 * The AI is READ-ONLY. This function only produces structured annotations;
 * it never POSTs to Charged or anything else. Charging is always manual.
 */
export async function categorize(
  client: Anthropic,
  req: CategorizeRequest,
  progress: CategorizeProgress = {},
): Promise<CategorizeResponse> {
  const model = req.model ?? process.env.PROXY_DEFAULT_MODEL ?? "MiniMax-M3";
  const batches = chunkItems(req.items);
  const allMatches: ItemMatch[] = new Array(req.items.length);
  const runStartedAt = Date.now();
  const initialTimeout = progress.initialTimeoutMsOverride ?? INITIAL_TIMEOUT_MS;
  const globalBudget = progress.globalBudgetMsOverride ?? GLOBAL_BUDGET_MS;
  const maxTimeout = progress.maxTimeoutMsOverride ?? MAX_TIMEOUT_MS;
  const adaptive = new AdaptiveTimeout(initialTimeout, globalBudget, maxTimeout);

  console.log(
    `[categorize] model=${model} items=${req.items.length} batches=${batches.length} customers=${req.customers.length} concurrency=${CONCURRENCY} globalBudget=${Math.round(GLOBAL_BUDGET_MS / 1000)}s`,
  );

  // Worker pool: N concurrent in-flight batches, each reserved a slot.
  // Indices stay stable so progress events match SSE order 1..N, even
  // though completion order is non-deterministic.
  //
  // Each worker surfaces errors via `workerErrors` rather than throwing,
  // so a single batch failure (timeout, 500 storm, etc.) doesn't nuke
  // already-completed work. Final batch counts are summarised and the
  // `partial` flag flips if any batch was dropped.
  let next = 0;
  const totalBatches = batches.length;
  let batchesDone = 0;
  let batchesTimedOut = 0;
  // Keyed by batchIndex so we never double-count the same batch even if
  // a worker somehow surfaces the same failure twice (e.g. retries on a
  // partial response — a path we don't currently take but stay defensive).
  const workerErrorsByBatch = new Map<number, string>();

  // Warm-up pass: MiniMax's automatic prefix cache needs at least one
  // call to hash and prime the static prefix (system prompt + customer
  // list + tool schema — ~6.5k tokens). Running batch 0 alone before
  // fanning the rest out means the 15 follow-up calls hit a warm cache
  // instead of all 16 paying the full prefix cost. Single-batch runs
  // skip this entirely — nothing to share the cached prefix with.
  const warmupEnabled = totalBatches > 1;
  const poolStart = warmupEnabled ? 1 : 0;
  if (warmupEnabled) {
    const batch0 = batches[0];
    progress.onBatchStart?.(0, totalBatches, batch0.length);
    try {
      const matches = await runOneBatch(
        client,
        model,
        batch0,
        req.customers,
        progress.signal,
        0,
        req.overrides ?? [],
        adaptive,
        progress.maxRetriesOverride ?? MAX_RETRIES,
      );
      adaptive.recordSuccess();
      // Slot 0 of allMatches starts at offset 0; the worker pool starts
      // at poolStart, so there is no overlap risk.
      for (let j = 0; j < matches.length; j++) {
        allMatches[j] = matches[j];
      }
      progress.onBatchDone?.(0, totalBatches, matches);
      batchesDone++;
      const elapsed = Math.round((Date.now() - runStartedAt) / 1000);
      console.log(
        `[categorize] batch 1/${totalBatches} done (warm-up) · ${matches.length} matches · ${elapsed}s elapsed`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.includes("timed out");

      if (isTimeout) {
        // Same Codec-fallback recovery as the worker pool (see below):
        // a failed warm-up must NOT lose batch 0 — the worker pool would
        // skip batch 0 anyway since `next` already advanced past it.
        const synthMatches = batch0.map((it) => synthesizeCodecFallback(it.transactionId));
        for (let j = 0; j < synthMatches.length; j++) {
          allMatches[j] = synthMatches[j];
        }
        progress.onBatchDone?.(0, totalBatches, synthMatches);
        batchesDone++;
        workerErrorsByBatch.set(
          0,
          `MiniMax timeout during warm-up → ${synthMatches.length} Codec fallback synthesised: ${msg}`,
        );
        batchesTimedOut++;
        adaptive.recordTimeout();
        progress.onBatchTimeout?.(0, totalBatches, adaptive.ms, batchesTimedOut);
        const elapsed = Math.round((Date.now() - runStartedAt) / 1000);
        console.warn(
          `[categorize] batch 1/${totalBatches} TIMEOUT on warm-up · ${elapsed}s elapsed · ` +
            `synthesised ${synthMatches.length} Codec fallbacks (next timeout=${Math.round(adaptive.ms / 1000)}s)`,
        );
      } else {
        workerErrorsByBatch.set(0, msg);
        const elapsed = Math.round((Date.now() - runStartedAt) / 1000);
        console.error(
          `[categorize] batch 1/${totalBatches} failed on warm-up · ${elapsed}s elapsed: ${msg}`,
        );
      }
      // Continue anyway — a failed warm-up doesn't poison the remaining
      // batches. The partial flag will surface this to the operator
      // through failedBatches[batchIndex=0].
    }
  }

  const worker = async (workerId: number) => {
    while (true) {
      if (progress.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      if (adaptive.isBudgetExceeded()) {
        // Budget exceeded mid-run: stop claiming new batches. We do NOT
        // throw — the post-allSettled sweep below records each unclaimed
        // batch as a failedBatch entry so the operator sees them instead
        // of silently dropping them. (Previously this threw and
        // Promise.allSettled swallowed it; `next < totalBatches` batches
        // were unaccounted for in failedBatches.)
        return;
      }
      const i = next++;
      if (i >= totalBatches) return;
      const batch = batches[i];
      progress.onBatchStart?.(i, totalBatches, batch.length);

      let matches: ItemMatch[];
      try {
        matches = await runOneBatch(
          client,
          model,
          batch,
          req.customers,
          progress.signal,
          0,
          req.overrides ?? [],
          adaptive,
          progress.maxRetriesOverride ?? MAX_RETRIES,
        );
        adaptive.recordSuccess();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isTimeout = msg.includes("timed out");

        if (isTimeout) {
          // Timeouts after MAX_RETRIES are recovered as Codec-fallback
          // placeholders — every txId in this batch is synthesised with
          // `suggestedAccountEuId = null` so it lands in the
          // `__codec_fallback__` row of /review with a "synthetic" prefix
          // the operator can spot at a glance. The alternative — letting
          // the batch vanish — would mean those txIds never reach the
          // review screen and silently get past /categorize, defeating the
          // point of running it in the first place. The retry budget was
          // cut to 2 (see MAX_RETRIES) precisely so this fallback kicks
          // in within ~3 minutes per bad batch instead of 5+.
          const synthMatches = batch.map((it) => synthesizeCodecFallback(it.transactionId));
          matches = synthMatches;
          workerErrorsByBatch.set(
            i,
            `MiniMax timeout → ${synthMatches.length} Codec fallback synthesised: ${msg}`,
          );
          batchesTimedOut++;
          adaptive.recordTimeout();
          progress.onBatchTimeout?.(i, totalBatches, adaptive.ms, batchesTimedOut);
          const elapsed = Math.round((Date.now() - runStartedAt) / 1000);
          console.warn(
            `[categorize] batch ${i + 1}/${totalBatches} TIMEOUT on worker ${workerId} · ${elapsed}s elapsed · ` +
              `synthesised ${synthMatches.length} Codec fallbacks (next timeout=${Math.round(adaptive.ms / 1000)}s)`,
          );
        } else {
          workerErrorsByBatch.set(i, msg);
          const elapsed = Math.round((Date.now() - runStartedAt) / 1000);
          console.error(
            `[categorize] batch ${i + 1}/${totalBatches} failed on worker ${workerId} · ${elapsed}s elapsed: ${msg}`,
          );
          // Non-timeout failures (5xx storms, shape errors that exhausted
          // their retries, etc.) still drop the batch — the operator sees
          // the failedBatches list. We deliberately don't synthesise here
          // either: the underlying API error likely affects the data
          // shape, and silently inventing matches would hide the issue.
          continue;
        }
      }
      // Write matches into the preallocated slot so order is preserved
      // regardless of completion order.
      const baseOffset = i * 50;
      for (let j = 0; j < matches.length; j++) {
        allMatches[baseOffset + j] = matches[j];
      }

      progress.onBatchDone?.(i, totalBatches, matches);
      batchesDone++;
      const elapsed = Math.round((Date.now() - runStartedAt) / 1000);
      console.log(
        `[categorize] batch ${i + 1}/${totalBatches} done (worker ${workerId}) · ${matches.length} matches · ${elapsed}s elapsed`,
      );
    }
  };

  const workerCount = Math.min(CONCURRENCY, totalBatches - poolStart);
  // The first `poolStart` batches are already running (or done) — start
  // the worker counter from there so the fan-out picks up after them.
  next = poolStart;
  // allSettled: a single worker throwing (e.g. abort signal) won't lose
  // the work the other workers already produced. We aggregate below.
  await Promise.allSettled(
    Array.from({ length: workerCount }, (_, k) => worker(k + 1)),
  );

  // Sweep: any batch indices that workers never reached (next < totalBatches)
  // are recorded as failed. This is the bug surface that used to silently
  // drop unclaimed batches when the global budget tripped mid-run.
  if (next < totalBatches) {
    for (let k = next; k < totalBatches; k++) {
      if (!workerErrorsByBatch.has(k)) {
        workerErrorsByBatch.set(
          k,
          `categorize global budget exceeded (unclaimed batch ${k + 1}/${totalBatches})`,
        );
      }
    }
  }

  // If the abort signal fired, propagate that — the caller asked us to stop.
  if (progress.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  const partial = workerErrorsByBatch.size > 0;
  if (partial) {
    console.warn(
      `[categorize] partial result: ${batchesDone}/${totalBatches} batches succeeded, ${workerErrorsByBatch.size} failed (${batchesTimedOut} timeouts) — returning matches that were recovered`,
    );
  }

  const failedBatches = partial
    ? [...workerErrorsByBatch.entries()].map(([batchIndex, error]) => ({
        batchIndex,
        error,
      }))
    : undefined;

  return {
    model,
    batches: totalBatches,
    matches: allMatches,
    partial,
    failedBatches,
  };
}

async function runOneBatch(
  client: Anthropic,
  model: string,
  items: UnmatchedItem[],
  customers: Customer[],
  signal?: AbortSignal,
  depth = 0,
  overrides: KeywordOverride[] = [],
  adaptive?: AdaptiveTimeout,
  maxRetries: number = MAX_RETRIES,
): Promise<ItemMatch[]> {
  const callStartedAt = Date.now();
  let lastErr: unknown;

  // Compose the caller's signal with our per-call timeout so neither
  // alone can leave us hanging forever. The deadline is read from the
  // shared AdaptiveTimeout — first timeout → 90 s, second → 150 s,
  // third+ → 240 s — so a slow API gets breathing room while a healthy
  // one isn't penalised forever.
  let timeoutController = new AbortController();
  let deadline = adaptive?.ms ?? INITIAL_TIMEOUT_MS;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, deadline);
  let combinedSignal = combineSignals(signal, timeoutController.signal);

  // Fresh deadline + fresh signal for the next attempt. We rebuild the
  // timeout controller because the previous one's `abort` already fired
  // and the new attempt's request would immediately see `aborted=true`.
  const armNextAttempt = () => {
    deadline = adaptive?.ms ?? INITIAL_TIMEOUT_MS;
    timeoutController = new AbortController();
    timedOut = false;
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, deadline);
    combinedSignal = combineSignals(signal, timeoutController.signal);
  };

  // Initialise the working variables above (no-op assignments; just
  // keep TS happy about the closure ordering).

  try {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");

      try {
        const response = await client.messages.create(
          {
            model,
            // Sized so 50 items × full schema + reasoning fit comfortably.
            max_tokens: 16000,
            temperature: 0.2,
            system: buildSystemPrompt(),
            tools: [ITEM_ANNOTATIONS_TOOL],
            tool_choice: { type: "tool", name: "item_annotations" },
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: buildUserPrompt(customers, items, overrides) },
                ],
              },
            ],
          },
          { signal: combinedSignal },
        );

        const toolBlock = response.content.find((b) => b.type === "tool_use");
        if (!toolBlock || toolBlock.type !== "tool_use") {
          // Self-heal: if the model got cut off mid-tool_use because the
          // tool payload is bigger than max_tokens, split the batch in
          // half and retry. Capped at MAX_SPLIT_DEPTH to avoid runaway
          // cascades when the customer list is huge.
          const stopReason =
            (response as { stop_reason?: string }).stop_reason ?? "unknown";
          if (
            stopReason === "max_tokens" &&
            items.length > 1 &&
            depth < MAX_SPLIT_DEPTH
          ) {
            const mid = Math.ceil(items.length / 2);
            const left = await runOneBatch(
              client,
              model,
              items.slice(0, mid),
              customers,
              signal,
              depth + 1,
              overrides,
              adaptive,
            );
            const right = await runOneBatch(
              client,
              model,
              items.slice(mid),
              customers,
              signal,
              depth + 1,
              overrides,
              adaptive,
            );
            return [...left, ...right];
          }

          // Surface the actual response so we can tell *why* the model
          // refused or skipped tool_use.
          const blockTypes =
            response.content.map((b) => b.type).join(",") || "(empty)";
          const textPreview = response.content
            .filter((b) => b.type === "text")
            .map((b) => (b as { text?: string }).text ?? "")
            .join(" ")
            .slice(0, 320);
          const usage = (response as { usage?: unknown }).usage;
          throw new Error(
            `model response did not contain a tool_use block ` +
              `(model=${model}, stop_reason=${stopReason}, blocks=[${blockTypes}], ` +
              `usage=${JSON.stringify(usage) ?? "n/a"})` +
              (textPreview ? ` · text="${textPreview}…"` : ""),
          );
        }
        const input = toolBlock.input as { matches: ItemMatch[] };
        if (!Array.isArray(input?.matches)) {
          throw new Error(
            `tool_use input missing 'matches' array (got ${typeof input?.matches})`,
          );
        }

        // validateMatches is partial-tolerant: returns {cleaned, missing, invalid}.
        // We repair small gaps with a cheap follow-up call (prefix cache is warm)
        // and synthesise Codec-fallback placeholders for anything still missing,
        // so the operator never silently loses records.
        // validateMatches is partial-tolerant: returns {cleaned, missing, invalid}.
        // We repair small gaps with a cheap follow-up call (prefix cache is warm)
        // and synthesise Codec-fallback placeholders for anything still missing,
        // so the operator never silently loses records.
        const result = validateMatches(input.matches, items, customers);
        const cleaned: ItemMatch[] = [...result.cleaned];
        const covered = new Set(cleaned.map((m) => m.transactionId));

        if (result.missing.length > 0 && result.missing.length <= 5) {
          // Cheap repair: re-issue just the missing items. The customer
          // list + system prompt + tool schema are now cached on the API
          // side, so this is a fraction of the original call's price.
          // maxRetries=1 — one fresh attempt; if it fails too, we fall
          // through to synthesis below.
          console.log(
            `[runOneBatch] repair pass for ${result.missing.length} missing ` +
              `txIds (e.g. ${result.missing.slice(0, 5).join(", ")})`,
          );
          const missingSet = new Set(result.missing);
          const repairItems = items.filter((i) => missingSet.has(i.transactionId));
          try {
            const repaired = await runOneBatch(
              client, model, repairItems, customers,
              signal, depth + 1, overrides, adaptive, 1,
            );
            for (const m of repaired) {
              if (!covered.has(m.transactionId)) {
                cleaned.push(m);
                covered.add(m.transactionId);
              }
            }
          } catch (err) {
            console.warn(
              `[runOneBatch] repair pass failed (${err instanceof Error ? err.message : String(err)}) — falling back to synthesis`,
            );
          }
        }

        // Synthesise Codec-fallback placeholders for anything still
        // uncovered. These land in the __codec_fallback__ row in /review
        // (suggestedAccountEuId === null), with a `synthetic: …` reasoning
        // prefix the UI uses for the "Y kayıt AI kapsamadı" subtitle.
        for (const txId of result.missing) {
          if (!covered.has(txId)) {
            cleaned.push(synthesizeCodecFallback(txId));
            covered.add(txId);
          }
        }

        return cleaned;
      } catch (err) {
        lastErr = err;
        if (timedOut) {
          // Each retry-timeout escalates the adaptive budget so the
          // next attempt has more breathing room. After MAX_RETRIES we
          // surface a dedicated timeout error so the worker / SSE layer
          // can tell timeouts apart from 5xx / 429 storms.
          adaptive?.recordTimeout();
          if (attempt === maxRetries) {
            throw new Error(
              `MiniMax request timed out after ${Math.round(deadline / 1000)}s ` +
              `(items=${items.length}, depth=${depth})`,
            );
          }
          armNextAttempt();
          // Drop out of the retry loop early if the global budget has
          // been blown — otherwise a stuck batch could keep retrying
          // long after the caller lost patience.
          if (adaptive?.isBudgetExceeded()) {
            throw new Error(
              `MiniMax request timed out after ${Math.round(deadline / 1000)}s ` +
              `(items=${items.length}, depth=${depth})`,
            );
          }
          await sleep(400 * 2 ** attempt);
          continue;
        }
        const status = (err as { status?: number })?.status;
        const errMsg = err instanceof Error ? err.message : String(err);
        const isHttpRetryable =
          typeof status === "number" && RETRYABLE_STATUS.has(status);
        // Model-shape errors (missing tool_use block, missing `matches`
        // array) used to be fatal at attempt 1 — production saw batches
        // like "tool_use input missing 'matches' array" die on the very
        // first try. They're now retryable: transient glitches usually
        // clear on the second attempt, and we still give up after the
        // regular retry budget. The HTTP path is unchanged.
        const isShapeError =
          errMsg.startsWith("model response did not contain a tool_use block") ||
          errMsg.startsWith("tool_use input missing 'matches'");
        const isRetryable = isHttpRetryable || isShapeError;
        if (!isRetryable || attempt === maxRetries) {
          throw new Error(
            `categorize batch failed (attempt ${attempt}/${maxRetries}, depth=${depth}, ${Math.round((Date.now() - callStartedAt) / 1000)}s): ${stringifyError(err)}`,
          );
        }
        const delay = 400 * 2 ** attempt;
        await sleep(delay);
      }
    }
  } finally {
    clearTimeout(timeoutId);
  }

  throw new Error(
    `categorize batch exhausted retries: ${stringifyError(lastErr)}`,
  );
}

/** Returns a signal that fires when either input aborts. */
function combineSignals(
  a: AbortSignal | undefined,
  b: AbortSignal,
): AbortSignal {
  if (!a) return b;
  const controller = new AbortController();
  const onA = () => controller.abort(a.reason);
  const onB = () => controller.abort(b.reason);
  if (a.aborted) controller.abort(a.reason);
  else a.addEventListener("abort", onA, { once: true });
  if (b.aborted) controller.abort(b.reason);
  else b.addEventListener("abort", onB, { once: true });
  return controller.signal;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Build a Codec-fallback placeholder match for a transactionId the AI
 * couldn't cover. The placeholder lands in the `__codec_fallback__` row
 * in /review (suggestedAccountEuId === null) — same shape as a real
 * "no firm" match from the model, just with a clearly-marked `reasoning`
 * prefix so the UI can surface a "Y kayıt AI kapsamadı" subtitle.
 *
 * The `synthetic:` prefix is the extension's signal that this row was
 * not produced by the LLM — it's a fallback so the operator still sees
 * the record instead of it vanishing after a batch failure.
 */
function synthesizeCodecFallback(transactionId: number): ItemMatch {
  return {
    transactionId,
    matchedField: "keyword1",
    matchedValue: "",
    keywordGroup: "unknown",
    suggestedAccountEuId: null,
    suggestedAccountName: null,
    confidence: "low",
    reasoning:
      "synthetic: AI bu kaydı sınıflandıramadı; operatör manuel inceleyecek.",
  };
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}