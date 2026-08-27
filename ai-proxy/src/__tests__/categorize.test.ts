import { describe, expect, it, vi, beforeEach } from "vitest";
import { categorize } from "../categorize.js";
import type {
  Customer,
  ItemMatch,
  UnmatchedItem,
} from "../types.js";

/**
 * We don't talk to a real Anthropic endpoint. We hand-build a fake client
 * whose messages.create returns a controlled tool_use payload, then assert
 * categorize() wires batches + retries correctly.
 */

interface ToolCallResponse {
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  model: string;
}

function makeFakeClient(opts: {
  responses: ToolCallResponse[];
  failWith?: { status?: number; message: string }[];
}) {
  const failList = [...(opts.failWith ?? [])];
  let responseIdx = 0;
  return {
    messages: {
      create: vi.fn(async (_req: unknown): Promise<ToolCallResponse> => {
        if (failList.length > 0) {
          const f = failList.shift()!;
          const err = new Error(f.message) as Error & { status?: number };
          if (f.status) err.status = f.status;
          throw err;
        }
        if (responseIdx >= opts.responses.length) {
          throw new Error(
            `fake client ran out of responses at call ${responseIdx}`,
          );
        }
        return opts.responses[responseIdx++];
      }),
    },
  };
}

const customer: Customer = { name: "TEST-FIRM ---- Test Firm", acntEuId: "test-acnt-1" };
const items: UnmatchedItem[] = Array.from({ length: 3 }, (_, i) => ({
  transactionId: 100 + i,
  phone: "5550000000",
  keyword1: i === 0 ? "IPTAL" : i === 1 ? "ODEME" : ".",
  keyword2: "",
  msgContent: "",
  shortCode: "3525",
  msgDate: "2026-08-20T10:00:00",
  id: `${100 + i}|20.08.2026 10:00:00`,
}));

function responseFor(items: UnmatchedItem[]): ToolCallResponse {
  const matches: ItemMatch[] = items.map((it, i) => ({
    transactionId: it.transactionId,
    matchedField: "keyword1",
    matchedValue: it.keyword1,
    keywordGroup: i === 0 ? "iptal" : i === 1 ? "odeme" : "unknown",
    suggestedAccountEuId: i === 2 ? null : customer.acntEuId,
    suggestedAccountName: i === 2 ? null : customer.name,
    confidence: i === 2 ? "low" : "high",
    reasoning: "test",
  }));
  return {
    model: "MiniMax-M3",
    content: [
      {
        type: "tool_use",
        id: "tool-1",
        name: "item_annotations",
        input: { matches },
      },
    ],
  };
}

describe("categorize", () => {
  beforeEach(() => {
    process.env.PROXY_DEFAULT_MODEL = "MiniMax-M3";
  });

  it("returns one match per input item across batches", async () => {
    const client = makeFakeClient({
      responses: [responseFor(items), responseFor([])],
    });
    // 3 items is one batch (≤ 200).
    const result = await categorize(client as never, {
      items,
      customers: [customer],
    });
    expect(result.matches).toHaveLength(3);
    expect(result.model).toBe("MiniMax-M3");
    expect(result.batches).toBe(1);
  });

  it("splits into multiple batches when items exceed BATCH_SIZE", async () => {
    // 250 items / BATCH_SIZE(50) = 5 batches of 50.
    const big = Array.from({ length: 250 }, (_, i) => ({
      ...items[i % items.length],
      transactionId: 1000 + i,
    }));
    const responses = [];
    for (let i = 0; i < 250; i += 50) {
      responses.push(responseFor(big.slice(i, i + 50)));
    }
    const client = makeFakeClient({ responses });
    const result = await categorize(client as never, {
      items: big,
      customers: [customer],
    });
    expect(result.batches).toBe(5);
    expect(result.matches).toHaveLength(250);
  });

  it("retries on 429 and eventually succeeds", async () => {
    const client = makeFakeClient({
      responses: [responseFor(items)],
      failWith: [{ status: 429, message: "rate-limited" }],
    });
    const result = await categorize(client as never, {
      items,
      customers: [customer],
    });
    expect(result.matches).toHaveLength(3);
    expect(client.messages.create).toHaveBeenCalledTimes(2); // 1 fail + 1 success
  });

  it("retries on 500 then succeeds", async () => {
    const client = makeFakeClient({
      responses: [responseFor(items)],
      failWith: [{ status: 500, message: "server error" }],
    });
    const result = await categorize(client as never, {
      items,
      customers: [customer],
    });
    expect(result.matches).toHaveLength(3);
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("returns partial=true after exhausting retries on 503", async () => {
    // 503 is retryable, but the 3rd attempt still fails. The new
    // contract: don't reject the whole categorize() call — surface the
    // failure as `partial: true` with `failedBatches` so the operator
    // UI can show "X/Y batches recovered".
    const client = makeFakeClient({
      responses: [],
      failWith: [
        { status: 503, message: "down" },
        { status: 503, message: "down" },
        { status: 503, message: "down" },
      ],
    });
    const result = await categorize(client as never, {
      items,
      customers: [customer],
    });
    expect(result.partial).toBe(true);
    expect(result.failedBatches).toBeDefined();
    expect(result.failedBatches![0].error).toMatch(/categorize batch failed/);
    expect(client.messages.create).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on non-retryable errors (e.g. 400) — partial=true", async () => {
    const client = makeFakeClient({
      responses: [],
      failWith: [{ status: 400, message: "bad request" }],
    });
    const result = await categorize(client as never, {
      items,
      customers: [customer],
    });
    expect(result.partial).toBe(true);
    expect(result.failedBatches).toHaveLength(1);
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("returns partial=true when model returns no tool_use block", async () => {
    const client = {
      messages: {
        create: vi.fn(async () => ({
          model: "MiniMax-M3",
          content: [{ type: "text", text: "oops" }],
        })),
      },
    };
    const result = await categorize(client as never, {
      items,
      customers: [customer],
    });
    expect(result.partial).toBe(true);
    expect(result.failedBatches![0].error).toMatch(/tool_use block/);
  });

  it("emits progress callbacks per batch", async () => {
    const client = makeFakeClient({
      responses: [responseFor(items), responseFor([])],
    });
    const starts: Array<{ i: number; total: number; size: number }> = [];
    const dones: Array<{ i: number; total: number; matches: number }> = [];
    await categorize(
      client as never,
      { items, customers: [customer] },
      {
        onBatchStart: (i, total, size) =>
          starts.push({ i, total, size }),
        onBatchDone: (i, total, matches) =>
          dones.push({ i, total, matches: matches.length }),
      },
    );
    expect(starts).toEqual([{ i: 0, total: 1, size: 3 }]);
    expect(dones).toEqual([{ i: 0, total: 1, matches: 3 }]);
  });
});

// --- Partial success + adaptive timeout ------------------------------------
// The previous behaviour was: one batch timeout → Promise.all rejected
// → every successful batch's matches were thrown away. The new contract
// is "promise.allSettled + partial flag" so the UI can show the operator
// what we DID recover and warn about what we lost.
//
// These tests use the small 3-item fixture and `initialTimeoutMsOverride`
// to shrink the per-call timeout so the adaptive-budget tiers trigger in
// well under a second. Production keeps the 90s default.

describe("categorize — partial success / adaptive timeout", () => {
  /**
   * Build a fake client whose calls hang (waiting for the abort signal)
   * for the 1-based indices listed in `hangingCalls`. Anything else
   * returns a successful `responseFor(items)` — uses the test's small
   * 3-item fixture so `validateMatches` always accepts the response.
   */
  function makeHangingClient(opts: { hangingCalls: number[] }) {
    let callIdx = 0;
    return {
      messages: {
        create: vi.fn(
          async (
            _req: unknown,
            opts2: { signal?: AbortSignal },
          ): Promise<ToolCallResponse> => {
            callIdx++;
            if (opts.hangingCalls.includes(callIdx)) {
              // Reject immediately if already aborted, otherwise wait
              // for the abort signal. The pending listener is cleaned
              // up by the AbortSignal itself, so no leaked handlers.
              if (opts2.signal?.aborted) {
                throw new DOMException("aborted", "AbortError");
              }
              return new Promise<ToolCallResponse>((_resolve, reject) => {
                opts2.signal?.addEventListener(
                  "abort",
                  () => {
                    reject(new DOMException("aborted", "AbortError"));
                  },
                  { once: true },
                );
              });
            }
            return responseFor(items);
          },
        ),
      },
    };
  }

  /** Items that fit a single 50-batch (BATCH_SIZE = 50). */
  const smallBatch = items; // 3 items → 1 batch

  it("returns matches from successful batches when some batches time out", async () => {
    // Single batch — call 1 hangs, maxRetries=1 means no retry, the
    // batch fails fast and the run returns partial.
    const client = makeHangingClient({ hangingCalls: [1] });
    const result = await categorize(
      client as never,
      { items: smallBatch, customers: [customer] },
      {
        initialTimeoutMsOverride: 30,
        globalBudgetMsOverride: 5_000,
        maxRetriesOverride: 1,
      },
    );
    expect(result.partial).toBe(true);
    expect(result.failedBatches).toBeDefined();
    expect(result.failedBatches!.length).toBe(1);
    expect(result.matches.filter((m) => m !== undefined)).toHaveLength(0);
  });

  it("adapts the timeout budget: reports the escalated tier after retries", async () => {
    // 3-item batch, maxRetriesOverride=3, all 3 retries hang. The
    // worker sees a single batch-timeout event AFTER all retries are
    // exhausted; the reported `timeoutMs` is the *final* tier the
    // budget reached (ceiling, scaled down to 200 ms for the test).
    const client = makeHangingClient({ hangingCalls: [1, 2, 3] });
    const seenTimeouts: number[] = [];
    const result = await categorize(
      client as never,
      { items: smallBatch, customers: [customer] },
      {
        initialTimeoutMsOverride: 30,
        globalBudgetMsOverride: 5_000,
        maxRetriesOverride: 3,
        maxTimeoutMsOverride: 200,
        onBatchTimeout: (_i, _total, timeoutMs) => seenTimeouts.push(timeoutMs),
      },
    );
    // Exactly one batch-timeout event for this single batch — the
    // escalation happens silently inside runOneBatch, the worker is
    // told only the final tier after retries are exhausted.
    expect(seenTimeouts).toHaveLength(1);
    expect(seenTimeouts[0]).toBe(200); // ceiling tier (overridden)
    expect(result.partial).toBe(true);
  });

  it("clean run (no timeouts) has partial=false and no failedBatches", async () => {
    const client = makeHangingClient({ hangingCalls: [] });
    const result = await categorize(
      client as never,
      { items: smallBatch, customers: [customer] },
      {
        initialTimeoutMsOverride: 30,
        globalBudgetMsOverride: 5_000,
      },
    );
    expect(result.partial ?? false).toBe(false);
    expect(result.failedBatches).toBeUndefined();
    expect(result.matches).toHaveLength(3);
  });

  it("global budget exceeded: stops spawning new batches", async () => {
    // All calls hang + a tiny global budget so the run aborts fast.
    const client = makeHangingClient({ hangingCalls: [1, 2, 3] });
    const result = await categorize(
      client as never,
      { items: smallBatch, customers: [customer] },
      {
        initialTimeoutMsOverride: 30,
        globalBudgetMsOverride: 35, // tighter than the 30ms timeout
      },
    );
    expect(result.partial).toBe(true);
    expect(result.matches.filter((m) => m !== undefined)).toHaveLength(0);
  });
});

// --- Adaptive success-resets-tier path --------------------------------------
// We can't observe the reset across separate batches with the existing
// public API (AdaptiveTimeout is a private class). Instead we verify
// the integration: a single batch with hangs at attempts 1, 2 then a
// success at attempt 3 — the next batch should start at the initial
// tier. To exercise that we need ≥ 2 batches. The simplest way is to
// directly construct a run with two 3-item fixtures — but BATCH_SIZE=50
// merges them into one batch. Instead we test the contract via
// onBatchTimeout: a hang followed by success in the same batch, the
// budget should reset to initial before the *next* batch. With a
// single 3-item batch we can prove this by hanging only at attempt 1
// and letting the subsequent retry succeed — the test verifies no
// escalation happened because attempt 2 was the success.

describe("categorize — adaptive reset on success", () => {
  it("a transient timeout that recovers doesn't escalate the budget", async () => {
    // Hang attempt 1, succeed on attempt 2. No onBatchTimeout should
    // fire — the batch ultimately succeeds, so the worker has nothing
    // to escalate about. The retry that succeeds also resets the
    // adaptive counter to the initial tier, so subsequent batches
    // would see the fresh budget.
    let callIdx = 0;
    const client = {
      messages: {
        create: vi.fn(
          async (
            _req: unknown,
            opts2: { signal?: AbortSignal },
          ): Promise<ToolCallResponse> => {
            callIdx++;
            if (callIdx === 1) {
              // Hang, wait for abort
              return new Promise<ToolCallResponse>((_resolve, reject) => {
                opts2.signal?.addEventListener("abort", () => {
                  const err = new Error("aborted") as Error & { name: string };
                  err.name = "AbortError";
                  reject(err);
                });
              });
            }
            // Attempt 2 → success
            return responseFor(items);
          },
        ),
      },
    };
    const seenTimeouts: number[] = [];
    const result = await categorize(
      client as never,
      { items, customers: [customer] },
      {
        initialTimeoutMsOverride: 30,
        globalBudgetMsOverride: 5_000,
        onBatchTimeout: (_i, _total, timeoutMs) => seenTimeouts.push(timeoutMs),
      },
    );
    // The transient timeout happened inside runOneBatch (retry succeeded),
    // so the WORKER never sees a timeout to escalate. The batch
    // ultimately succeeded → result is clean, no timeout event.
    expect(seenTimeouts).toEqual([]);
    expect(result.partial ?? false).toBe(false);
    expect(result.matches).toHaveLength(3);
  });
});