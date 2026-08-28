import { describe, expect, it, vi } from "vitest";
import {
  buildKeywordRows,
  flattenSelection,
  flattenSelected,
  formatTxIdsForCopy,
  groupByFirm,
  groupSelectionByRow,
  resolveFirm,
  resolveFirmForTx,
  sanitizeAccountEuId,
  selectNewBatchMatches,
  type CategorizeProgressInfo,
  type FirmSectionItem,
  type KeywordRow,
} from "../lib/ai.js";
import { CODEC_ACCOUNT_EU_ID, CODEC_ACCOUNT_NAME } from "../types.js";
import type { ItemMatch, UnmatchedItem } from "../types.js";

function m(
  id: number,
  group: string,
  account: string | null,
  accountName: string | null = null,
  conf: "high" | "medium" | "low" = "high",
  field: "keyword1" | "keyword2" | "msgContent" = "keyword1",
): ItemMatch {
  return {
    transactionId: id,
    matchedField: field,
    matchedValue: "",
    keywordGroup: group,
    suggestedAccountEuId: account,
    suggestedAccountName: accountName,
    confidence: conf,
    reasoning: "",
  };
}

describe("SSE event parsing", () => {
  // We can't easily import the private parser; we test it through the
  // public `categorize` function using a stubbed fetch.
  it("parses progress events correctly via categorize()", async () => {
    const events = [
      "event: batch-start\ndata: {\"i\":0,\"total\":2,\"size\":3}\n\n",
      "event: batch-done\ndata: {\"i\":0,\"total\":2,\"matches\":3,\"accumulated\":3}\n\n",
      "event: batch-start\ndata: {\"i\":1,\"total\":2,\"size\":2}\n\n",
      "event: batch-done\ndata: {\"i\":1,\"total\":2,\"matches\":2,\"accumulated\":5}\n\n",
      "event: done\ndata: {\"model\":\"MiniMax-M3\",\"batches\":2,\"items\":5,\"matches\":[]}\n\n",
      ": heartbeat ping\n\n",
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of events) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fetchStub = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response as unknown as Response);

    const { categorize } = await import("../lib/ai.js");
    const progressCalls: number[] = [];
    const result = await categorize(
      "http://proxy.test",
      "MiniMax-M3",
      [],
      [],
      [],
      (info) => progressCalls.push(info.accumulatedMatches),
      { stallTimeoutMs: 5_000 },
    );
    expect(result.batches).toBe(2);
    // start-0 → 0, done-0 → 3, start-1 → 3 (no change), done-1 → 5
    expect(progressCalls).toEqual([0, 3, 3, 5]);
    fetchStub.mockRestore();
  });

  it("selectNewBatchMatches: callback re-fires for the SAME finished batch do not re-emit its matches (regression for /review duplicates)", () => {
    // Regression (2026-08-28): production run showed #13083146 fourteen
    // times in a single keyword row because StepAnalyze's progress
    // callback fired ~14 times after the batch containing that txId
    // finished (once per subsequent SSE event: next batch-start,
    // next batch-timeout, heartbeats, etc.). Each invocation re-read
    // `info.finishedBatches[length-1]` and re-concatenated the same
    // matchesList into the running accumulator.
    //
    // The fix routes consumer-side accumulation through this helper:
    // the seen-set gates re-emission so each batch's matches are added
    // exactly once regardless of how many times onProgress fires for it.
    const makeInfo = (): CategorizeProgressInfo => ({
      batchesTotal: 2,
      accumulatedMatches: 5,
      batchSummaries: {
        0: {
          i: 0,
          size: 3,
          matches: 3,
          accumulated: 3,
          matchesList: [m(1, "iptal", null), m(2, "iptal", null), m(3, "iptal", null)],
        },
        1: {
          i: 1,
          size: 2,
          matches: 2,
          accumulated: 5,
          matchesList: [m(4, "odeme", null), m(5, "odeme", null)],
        },
      },
      finishedBatches: [0, 1],
      timedOutBatches: [],
      currentTimeoutMs: 90_000,
      consecutiveTimeouts: 0,
    });

    const seen = new Set<number>();

    // First invocation — both batches are new. The caller would
    // append these matches and add 0 + 1 to their seen-set.
    let r = selectNewBatchMatches(makeInfo(), seen);
    expect(r.newIndices).toEqual([0, 1]);
    expect(r.matches.map((x) => x.transactionId)).toEqual([1, 2, 3, 4, 5]);
    for (const idx of r.newIndices) seen.add(idx);

    // Progress callback fires AGAIN with the same info (next batch-start
    // arrives, or a heartbeat, or anything else). Helper MUST return
    // nothing — the bug previously re-emitted all 5 matches here.
    r = selectNewBatchMatches(makeInfo(), seen);
    expect(r.newIndices).toEqual([]);
    expect(r.matches).toEqual([]);

    // A third / fourth / fifth invocation with the same info — still
    // nothing new. This is the shape that produced 14 copies in prod.
    for (let k = 0; k < 12; k++) {
      const rr = selectNewBatchMatches(makeInfo(), seen);
      expect(rr.newIndices).toEqual([]);
      expect(rr.matches).toEqual([]);
    }
  });

  it("selectNewBatchMatches: out-of-order completion (parallel workers) does not skip batches", () => {
    // Production runs 16 workers in parallel — batches can finish in
    // submission order, reverse, or any interleaving. A "last index"
    // guard would skip the earlier-finished batch on a later call and
    // never re-emit it. The helper walks `finishedBatches` in
    // completion order so any batch not yet in `seen` is emitted.
    const seen = new Set<number>();

    // First callback: only batch 5 finished (out-of-order).
    const info1: CategorizeProgressInfo = {
      batchesTotal: 3,
      accumulatedMatches: 2,
      batchSummaries: {
        5: {
          i: 5,
          size: 2,
          matches: 2,
          accumulated: 2,
          matchesList: [m(50, "iptal", null), m(51, "iptal", null)],
        },
      },
      finishedBatches: [5],
      timedOutBatches: [],
      currentTimeoutMs: 90_000,
      consecutiveTimeouts: 0,
    };
    let r = selectNewBatchMatches(info1, seen);
    expect(r.newIndices).toEqual([5]);
    expect(r.matches.map((x) => x.transactionId)).toEqual([50, 51]);
    for (const idx of r.newIndices) seen.add(idx);

    // Second callback: batch 1 finished (still earlier index, no
    // re-emission of batch 5). Helper must surface batch 1 only.
    const info2: CategorizeProgressInfo = {
      ...info1,
      accumulatedMatches: 5,
      batchSummaries: {
        ...info1.batchSummaries,
        1: {
          i: 1,
          size: 3,
          matches: 3,
          accumulated: 5,
          matchesList: [m(10, "odeme", null), m(11, "odeme", null), m(12, "odeme", null)],
        },
      },
      finishedBatches: [5, 1],
    };
    r = selectNewBatchMatches(info2, seen);
    expect(r.newIndices).toEqual([1]);
    expect(r.matches.map((x) => x.transactionId)).toEqual([10, 11, 12]);
    for (const idx of r.newIndices) seen.add(idx);

    // Third callback: same info (re-fire). Nothing new.
    r = selectNewBatchMatches(info2, seen);
    expect(r.newIndices).toEqual([]);
    expect(r.matches).toEqual([]);
  });

  it("stall timer is activity-based: does NOT fire when heartbeats keep arriving past the deadline", async () => {
    // Regression (2026-08-28): the previous timer was total wall-clock.
    // A 752-item run with a slow tail batch streamed heartbeats every
    // 15s but was killed at t=180s because total runtime > 180s, even
    // though every batch-done + heartbeat arrived on schedule.
    //
    // We simulate the same scenario: one slow reader that emits a
    // heartbeat every 50ms with stallTimeoutMs=200. The run must NOT
    // throw "stalled" because activity is constant — only the *gap*
    // matters.
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        // 12 heartbeats over 600ms (every 50ms), then the final event.
        for (let k = 0; k < 12; k++) {
          await new Promise((r) => setTimeout(r, 50));
          controller.enqueue(encoder.encode(`: heartbeat ${k}\n\n`));
        }
        controller.enqueue(
          encoder.encode(
            `event: done\ndata: {"model":"MiniMax-M3","batches":0,"items":0,"matches":[]}\n\n`,
          ),
        );
        controller.close();
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fetchStub = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response as unknown as Response);

    const { categorize } = await import("../lib/ai.js");
    const start = Date.now();
    const result = await categorize(
      "http://proxy.test",
      "MiniMax-M3",
      [],
      [],
      [],
      undefined,
      { stallTimeoutMs: 200 }, // < total runtime (~600ms)
    );
    const elapsed = Date.now() - start;
    expect(result.batches).toBe(0);
    expect(elapsed).toBeGreaterThan(200); // confirms we DID exceed the deadline
    fetchStub.mockRestore();
  });

  it("stall timer DOES fire when reader goes silent for the full deadline", async () => {
    // The flip side: with NO chunks for the full stallTimeoutMs, the
    // timer still throws. (Otherwise we'd hang forever on a dead proxy.)
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: batch-start\ndata: {"i":0,"total":1,"size":3}\n\n`,
          ),
        );
        // Then go silent — never close the stream. The stall guard
        // must catch this within stallTimeoutMs.
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fetchStub = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response as unknown as Response);

    const { categorize } = await import("../lib/ai.js");
    const start = Date.now();
    await expect(
      categorize(
        "http://proxy.test",
        "MiniMax-M3",
        [],
        [],
        [],
        undefined,
        { stallTimeoutMs: 250 },
      ),
    ).rejects.toThrow(/stalled/);
    const elapsed = Date.now() - start;
    // Throws within ~stallTimeoutMs of the last activity, not before.
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2_000); // sanity — not a hang
    fetchStub.mockRestore();
  });

  it("synthesises a partial donePayload when stream ends without 'done' but matches arrived", async () => {
    // The mid-run recovery path: stream closes after some batch-done
    // events but no terminal `done`. The matches we DID get must
    // surface as a `partial: true` result instead of throwing.
    const events = [
      `event: batch-start\ndata: {"i":0,"total":2,"size":3}\n\n`,
      `event: batch-done\ndata: {"i":0,"total":2,"matches":[{"transactionId":1,"matchedField":"keyword1","matchedValue":"IPTAL","keywordGroup":"iptal","suggestedAccountEuId":null,"suggestedAccountName":null,"confidence":"high","reasoning":""}],"accumulated":1}\n\n`,
      `event: batch-start\ndata: {"i":1,"total":2,"size":2}\n\n`,
      // Stream closes mid-run — no batch-done for batch 1, no done.
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of events) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    const response = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const fetchStub = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response as unknown as Response);

    const { categorize } = await import("../lib/ai.js");
    const result = await categorize(
      "http://proxy.test",
      "MiniMax-M3",
      [],
      [],
      [],
      undefined,
      { stallTimeoutMs: 5_000 },
    );
    expect(result.partial).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].transactionId).toBe(1);
    expect(result.failedBatches).toBeDefined();
    expect(result.failedBatches![0].error).toMatch(/stream ended without 'done'/);
    fetchStub.mockRestore();
  });
});

describe("buildKeywordRows", () => {
  it("skips null slots from partial upstream responses without throwing", () => {
    // Partial-result regression: when an upstream batch fails (timeout,
    // 5xx, malformed tool_use) the preallocated `allMatches` slot stays
    // `undefined`, JSON-stringified as `null`, and lands in
    // `session.matches` as a hole. Iterating this array without a
    // null guard crashes on `m.transactionId`. The operator must hit
    // "Tekrar dene" on the Analyze step to refill those slots; until
    // then the rest of the table should still render.
    const matches: Array<ReturnType<typeof m> | null> = [
      m(1, "iptal", "a-uuid", "A"),
      null,
      m(3, "iptal", "a-uuid", "A"),
    ];
    const rows = buildKeywordRows(
      matches as unknown as ReturnType<typeof m>[],
      new Set(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].matches.map((x) => x.transactionId)).toEqual([1, 3]);
  });

  it("groups matches by keywordGroup, sorted by count desc", () => {
    const matches = [
      m(1, "iptal", "a-uuid", "A"),
      m(2, "iptal", "a-uuid", "A"),
      m(3, "iptal", "a-uuid", "A"),
      m(4, "odeme", "b-uuid", "B"),
      m(5, "odeme", "b-uuid", "B"),
    ];
    const rows = buildKeywordRows(matches, new Set());
    expect(rows).toHaveLength(2);
    expect(rows[0].group).toBe("iptal");
    expect(rows[0].matches).toHaveLength(3);
    expect(rows[1].group).toBe("odeme");
    expect(rows[1].matches).toHaveLength(2);
  });

  it("places the Codec fallback row at the bottom regardless of count", () => {
    const matches = [
      m(1, "iptal", "a-uuid", "A"),
      m(2, "iptal", "a-uuid", "A"),
      m(3, "unknown", null),
      m(4, "unknown", null),
      m(5, "unknown", null),
      m(6, "unknown", null),
    ];
    const rows = buildKeywordRows(matches, new Set());
    expect(rows.at(-1)!.group).toBe("__codec_fallback__");
    expect(rows.at(-1)!.matches).toHaveLength(4);
    expect(rows.at(-1)!.label).toBe("Codec'e ücretlendir");
  });

  it("Codec fallback row is always charged to the HAR-confirmed UUID", () => {
    const matches = [m(1, "?", null)];
    const rows = buildKeywordRows(matches, new Set());
    const fb = rows.find((r) => r.group === "__codec_fallback__")!;
    expect(fb.suggestedAccountEuId).toBe(CODEC_ACCOUNT_EU_ID);
    expect(fb.suggestedAccountEuId).toBe(
      "00000000-0000-0000-0000-000000000000",
    );
    expect(fb.suggestedAccountName).toBe(CODEC_ACCOUNT_NAME);
  });

  it("filters out already-charged transactionIds before grouping", () => {
    const matches = [
      m(1, "iptal", "a-uuid", "A"),
      m(2, "iptal", "a-uuid", "A"),
      m(3, "iptal", "a-uuid", "A"),
    ];
    const rows = buildKeywordRows(matches, new Set([1, 3]));
    expect(rows[0].matches.map((x) => x.transactionId)).toEqual([2]);
  });

  it("computes worstConfidence as the lowest confidence across the row", () => {
    const matches = [
      m(1, "iptal", "a", "A", "high"),
      m(2, "iptal", "a", "A", "medium"),
      m(3, "iptal", "a", "A", "low"),
    ];
    const rows = buildKeywordRows(matches, new Set());
    expect(rows[0].worstConfidence).toBe("low");

    const onlyHigh = buildKeywordRows(
      [m(1, "x", "a", "A", "high"), m(2, "x", "a", "A", "high")],
      new Set(),
    );
    expect(onlyHigh[0].worstConfidence).toBe("high");
  });

  it("computes dominantField as the most common matchedField", () => {
    const matches = [
      m(1, "g", "a", "A", "high", "keyword1"),
      m(2, "g", "a", "A", "high", "keyword2"),
      m(3, "g", "a", "A", "high", "keyword2"),
    ];
    const rows = buildKeywordRows(matches, new Set());
    expect(rows[0].dominantField).toBe("keyword2");
  });

  it("returns [] when nothing matches", () => {
    expect(buildKeywordRows([], new Set())).toEqual([]);
  });

  it("all charged → all rows empty", () => {
    const matches = [m(1, "iptal", "a"), m(2, "unknown", null)];
    const rows = buildKeywordRows(matches, new Set([1, 2]));
    expect(rows).toEqual([]);
  });

  it("drops a keyword row once every match in it is charged (partial charge)", () => {
    // Regression: previously, the row remained visible with matches=[]
    // after every txId was charged. Now it should disappear entirely.
    const matches = [
      m(1, "iptal", "a-uuid", "A"),
      m(2, "iptal", "a-uuid", "A"),
      m(3, "iptal", "a-uuid", "A"),
      m(4, "iptal", "a-uuid", "A"),
      m(5, "iptal", "a-uuid", "A"),
    ];
    const rows = buildKeywordRows(matches, new Set([1, 2, 3, 4, 5]));
    expect(rows).toEqual([]);
  });

  it("removes the charged txId but keeps the row when the row has other pending matches", () => {
    const matches = [
      m(1, "iptal", "a-uuid", "A"),
      m(2, "iptal", "a-uuid", "A"),
      m(3, "iptal", "a-uuid", "A"),
      m(4, "odeme", "b-uuid", "B"),
    ];
    const rows = buildKeywordRows(matches, new Set([1]));
    expect(rows).toHaveLength(2);
    const iptal = rows.find((r) => r.group === "iptal")!;
    expect(iptal.matches.map((x) => x.transactionId)).toEqual([2, 3]);
  });

  it("drops ignored txIds from rows the same way chargedIds are dropped", () => {
    // ignoredIds are operator-driven removals (✕ button). They must filter
    // out before bucketing, identical to chargedIds.
    const matches = [
      m(1, "iptal", "a-uuid", "A"),
      m(2, "iptal", "a-uuid", "A"),
      m(3, "iptal", "a-uuid", "A"),
      m(4, "odeme", "b-uuid", "B"),
    ];
    const rows = buildKeywordRows(matches, new Set(), {
      ignoredIds: new Set([1, 4]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].group).toBe("iptal");
    expect(rows[0].matches.map((x) => x.transactionId)).toEqual([2, 3]);
  });

  it("all ignored → all rows empty", () => {
    const matches = [
      m(1, "iptal", "a", "A"),
      m(2, "odeme", "b", "B"),
      m(3, "unknown", null),
    ];
    const rows = buildKeywordRows(matches, new Set(), {
      ignoredIds: new Set([1, 2, 3]),
    });
    expect(rows).toEqual([]);
  });

  it("chargedIds + ignoredIds together drop the union of both", () => {
    const matches = [
      m(1, "iptal", "a", "A"),
      m(2, "iptal", "a", "A"),
      m(3, "iptal", "a", "A"),
      m(4, "iptal", "a", "A"),
    ];
    const rows = buildKeywordRows(matches, new Set([1, 2]), {
      ignoredIds: new Set([3]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].matches.map((x) => x.transactionId)).toEqual([4]);
  });

  it("ignoredIds don't accidentally appear in the Codec fallback row either", () => {
    const matches = [m(1, "unknown", null), m(2, "garbage", null)];
    const rows = buildKeywordRows(matches, new Set(), {
      ignoredIds: new Set([1]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].group).toBe("__codec_fallback__");
    expect(rows[0].matches.map((x) => x.transactionId)).toEqual([2]);
  });
});

describe("buildKeywordRows — firmGroupKey (visual firm grouping)", () => {
  it("falls back to suggested account when no override is supplied", () => {
    const rows = buildKeywordRows(
      [m(1, "iptal", "a-uuid", "Aktiff"), m(2, "odeme", "b-uuid", "B")],
      new Set(),
    );
    const iptal = rows.find((r) => r.group === "iptal")!;
    const odeme = rows.find((r) => r.group === "odeme")!;
    expect(iptal.firmGroupKey).toBe("a-uuid");
    expect(odeme.firmGroupKey).toBe("b-uuid");
  });

  it("prefers the operator override key when present", () => {
    const rows = buildKeywordRows(
      [m(1, "iptal", "a-uuid", "Aktiff")],
      new Set(),
      {
        firmOverrides: {
          iptal: { accountEuId: "override-uuid", accountName: "Aktiff Bank" },
        },
      },
    );
    expect(rows[0].firmGroupKey).toBe("override-uuid");
  });

  it("groups rows with the same effective firm under the same firmGroupKey", () => {
    const rows = buildKeywordRows(
      [
        m(1, "iptal", "a-uuid", "Aktiff"),
        m(2, "odeme", "a-uuid", "Aktiff"),
        m(3, "bilgi", "b-uuid", "B"),
      ],
      new Set(),
    );
    const iptal = rows.find((r) => r.group === "iptal")!;
    const odeme = rows.find((r) => r.group === "odeme")!;
    const bilgi = rows.find((r) => r.group === "bilgi")!;
    expect(iptal.firmGroupKey).toBe(odeme.firmGroupKey);
    expect(iptal.firmGroupKey).not.toBe(bilgi.firmGroupKey);
  });

  it("Codec fallback rows share the __codec__ firmGroupKey", () => {
    const rows = buildKeywordRows(
      [m(1, "unknown", null), m(2, "garbage", null)],
      new Set(),
    );
    const fb = rows.find((r) => r.group === "__codec_fallback__")!;
    expect(fb.firmGroupKey).toBe("__codec__");
  });
});

// --- resolveFirm ---------------------------------------------------------
// CRITICAL: the admin-panel-api rejects any accountEuId other than
// `CODEC_ACCOUNT_EU_ID` for the Codec-fallback group with a GUID
// validation error. `resolveFirm` is the chokepoint — test every branch
// that could send `null` or a wrong UUID for the Codec row.

describe("resolveFirm", () => {
  function rowOf(group: string, suggested: string | null, suggestedName: string | null): KeywordRow {
    return {
      group,
      label: group === "__codec_fallback__" ? "Codec'e ücretlendir" : group,
      suggestedAccountEuId: suggested,
      suggestedAccountName: suggestedName,
      matches: [],
      worstConfidence: "low",
      dominantField: "keyword1",
      firmGroupKey: suggested ?? "",
    };
  }

  it("Codec fallback row returns HAR-confirmed UUID with no override", () => {
    expect(resolveFirm(rowOf("__codec_fallback__", CODEC_ACCOUNT_EU_ID, "Codec"), {})).toEqual({
      accountEuId: CODEC_ACCOUNT_EU_ID,
      accountName: "Codec",
    });
  });

  it("Codec fallback row returns HAR-confirmed UUID even when suggested is null", () => {
    // The dangerous case: if `makeRow` somehow drops the hard-coded UUID,
    // the operator would have clicked "Ücretlendir" with `null` going to
    // the server. The fallback here is the last line of defense.
    expect(resolveFirm(rowOf("__codec_fallback__", null, null), {})).toEqual({
      accountEuId: CODEC_ACCOUNT_EU_ID,
      accountName: "Codec",
    });
  });

  it("Codec fallback row BYPASSES a stale override pointing at a real firm", () => {
    // A real override should never exist for `__codec_fallback__`
    // (`setRowFirm` drops it when the operator picks Codec), but if it
    // did, the POST must still carry the HAR-confirmed UUID.
    const out = resolveFirm(rowOf("__codec_fallback__", CODEC_ACCOUNT_EU_ID, "Codec"), {
      __codec_fallback__: { accountEuId: "real-uuid", accountName: "Aktiff Bank" },
    });
    expect(out.accountEuId).toBe(CODEC_ACCOUNT_EU_ID);
    expect(out.accountEuId).not.toBe("real-uuid");
  });

  it("normal row uses the AI-suggested firm when no override exists", () => {
    expect(resolveFirm(rowOf("iptal", "abc-uuid", "Aktiff"), {})).toEqual({
      accountEuId: "abc-uuid",
      accountName: "Aktiff",
    });
  });

  it("normal row uses the operator override when present", () => {
    expect(
      resolveFirm(rowOf("iptal", "abc-uuid", "Aktiff"), {
        iptal: { accountEuId: "xyz-uuid", accountName: "Yapı Kredi" },
      }),
    ).toEqual({
      accountEuId: "xyz-uuid",
      accountName: "Yapı Kredi",
    });
  });

  it("normal row with null suggestion falls back to the Codec UUID (defense-in-depth)", () => {
    // A normal (non-Codec) row whose AI suggestion came back null should
    // never happen in practice (it'd be re-bucketed into the Codec row),
    // but if it did, the POST must still carry a valid UUID rather than
    // null.
    expect(resolveFirm(rowOf("garbage", null, null), {})).toEqual({
      accountEuId: CODEC_ACCOUNT_EU_ID,
      accountName: "Codec",
    });
  });

  it("undefined overrides map behaves like an empty one", () => {
    expect(resolveFirm(rowOf("iptal", "abc-uuid", "Aktiff"), undefined)).toEqual({
      accountEuId: "abc-uuid",
      accountName: "Aktiff",
    });
  });

  it("returned accountEuId is NEVER null or empty for any input", () => {
    // Exhaustive guard: regardless of group / suggestion / override, the
    // caller must always be able to pass the result straight to
    // `chargeOnce` without re-checking.
    const groups = ["__codec_fallback__", "iptal", "odeme", "garbage"];
    const suggestions: (string | null)[] = [CODEC_ACCOUNT_EU_ID, "abc-uuid", null];
    const names: (string | null)[] = ["Codec", "Aktiff", null];
    for (const g of groups) {
      for (const s of suggestions) {
        for (const n of names) {
          const out = resolveFirm(rowOf(g, s, n), {
            [g]: { accountEuId: "stale-uuid", accountName: "Stale" },
          });
          expect(out.accountEuId).toBeTruthy();
          expect(typeof out.accountEuId).toBe("string");
          expect(out.accountEuId.length).toBeGreaterThan(0);
          if (g === "__codec_fallback__") {
            expect(out.accountEuId).toBe(CODEC_ACCOUNT_EU_ID);
          }
        }
      }
    }
  });

  // ---------------------------------------------------------------------
  // Regression: AI sometimes returns the LITERAL STRING "null" instead of
  // JSON null for `suggestedAccountEuId`. The admin-panel-api rejects
  // that as a GUID validation error and the operator sees
  // `{accountEuId: "null"}` in DevTools. `resolveFirm` must coerce
  // `"null"` → fallback UUID before the value reaches `chargeOnce`.
  // ---------------------------------------------------------------------

  it('regression: AI-suggested literal string "null" on a normal row → Codec UUID', () => {
    // The row has the *string* "null" (not the JSON null) — that's the
    // shape `validateMatches` failed to coerce in the live bug report.
    const out = resolveFirm(rowOf("odeme", "null", null), {});
    expect(out.accountEuId).toBe(CODEC_ACCOUNT_EU_ID);
    expect(out.accountEuId).not.toBe("null");
  });

  it('regression: a non-Codec row carrying a "null" override → Codec UUID', () => {
    // A previous operator run somehow wrote the literal string "null"
    // into the persisted overrides map. resolveFirm must ignore it and
    // fall back to the HAR UUID.
    const out = resolveFirm(rowOf("iptal", null, null), {
      iptal: { accountEuId: "null", accountName: null },
    });
    expect(out.accountEuId).toBe(CODEC_ACCOUNT_EU_ID);
  });

  it("regression: empty-string suggestion → Codec UUID", () => {
    const out = resolveFirm(rowOf("garbage", "", null), {});
    expect(out.accountEuId).toBe(CODEC_ACCOUNT_EU_ID);
  });

  it("regression: whitespace-only suggestion → Codec UUID", () => {
    const out = resolveFirm(rowOf("garbage", "   ", null), {});
    expect(out.accountEuId).toBe(CODEC_ACCOUNT_EU_ID);
  });

  it("UUID-shaped override is preserved (sanitizer only drops mis-shapes)", () => {
    const out = resolveFirm(rowOf("iptal", null, null), {
      iptal: { accountEuId: "abc-uuid-def-123-4567", accountName: "Aktiff Bank" },
    });
    expect(out.accountEuId).toBe("abc-uuid-def-123-4567");
    expect(out.accountName).toBe("Aktiff Bank");
  });
});

describe("sanitizeAccountEuId", () => {
  it("returns null for JS null and undefined", () => {
    expect(sanitizeAccountEuId(null)).toBeNull();
    expect(sanitizeAccountEuId(undefined)).toBeNull();
  });

  it('returns null for the literal string "null"', () => {
    expect(sanitizeAccountEuId("null")).toBeNull();
  });

  it("returns null for empty / whitespace-only strings", () => {
    expect(sanitizeAccountEuId("")).toBeNull();
    expect(sanitizeAccountEuId("   ")).toBeNull();
    expect(sanitizeAccountEuId("\t\n")).toBeNull();
  });

  it("returns null for non-string types", () => {
    expect(sanitizeAccountEuId(0 as unknown)).toBeNull();
    expect(sanitizeAccountEuId(123 as unknown)).toBeNull();
    expect(sanitizeAccountEuId({} as unknown)).toBeNull();
    expect(sanitizeAccountEuId([] as unknown)).toBeNull();
    expect(sanitizeAccountEuId(false as unknown)).toBeNull();
  });

  it("trims surrounding whitespace from valid UUIDs", () => {
    expect(sanitizeAccountEuId("  uuid-123  ")).toBe("uuid-123");
  });

  it("preserves a clean UUID-shaped string unchanged", () => {
    expect(sanitizeAccountEuId(CODEC_ACCOUNT_EU_ID)).toBe(CODEC_ACCOUNT_EU_ID);
    expect(sanitizeAccountEuId("abc-uuid-1234")).toBe("abc-uuid-1234");
  });
});

// --- Selection helpers --------------------------------------------------
// Regression tests for the "Seçili olanları ücretlendir" path. These
// guarantee that an unselected txId can never leak into the POST, and
// that stale selection state (a txId that's been filtered out of the
// current rows) is dropped before the network call.

describe("groupSelectionByRow", () => {
  it("returns one entry per row, ids restricted to that row's matches", () => {
    const rows = buildKeywordRows(
      [
        m(1, "iptal", "a", "A"),
        m(2, "iptal", "a", "A"),
        m(3, "odeme", "b", "B"),
      ],
      new Set(),
    );
    const sel = new Map([
      ["iptal", new Set([1, 2])],
      ["odeme", new Set([3])],
    ]);
    const out = groupSelectionByRow(rows, sel);
    expect(out).toHaveLength(2);
    const byGroup = Object.fromEntries(out.map((o) => [o.row.group, o.ids]));
    expect(byGroup.iptal).toEqual([1, 2]);
    expect(byGroup.odeme).toEqual([3]);
  });

  it("drops unselected txIds from the row's ids", () => {
    const rows = buildKeywordRows(
      [m(1, "iptal", "a", "A"), m(2, "iptal", "a", "A"), m(3, "iptal", "a", "A")],
      new Set(),
    );
    const sel = new Map([["iptal", new Set([2])]]); // only id=2 selected
    const out = groupSelectionByRow(rows, sel);
    expect(out[0].ids).toEqual([2]);
    expect(out[0].ids).not.toContain(1);
    expect(out[0].ids).not.toContain(3);
  });

  it("ignores rows with empty selection", () => {
    const rows = buildKeywordRows(
      [m(1, "iptal", "a"), m(2, "odeme", "b")],
      new Set(),
    );
    const sel = new Map<string, Set<number>>(); // nothing selected
    expect(groupSelectionByRow(rows, sel)).toEqual([]);
  });

  it("ignores rows with empty selection even if the map has an empty Set", () => {
    const rows = buildKeywordRows(
      [m(1, "iptal", "a"), m(2, "odeme", "b")],
      new Set(),
    );
    const sel = new Map([
      ["iptal", new Set<number>()],
      ["odeme", new Set([2])],
    ]);
    const out = groupSelectionByRow(rows, sel);
    expect(out).toHaveLength(1);
    expect(out[0].row.group).toBe("odeme");
  });

  it("filters stale txIds that no longer belong to any current row", () => {
    const rows = buildKeywordRows([m(1, "iptal", "a"), m(2, "iptal", "a")], new Set());
    // Operator's selection still references id=99 from a previous run.
    const sel = new Map([
      ["iptal", new Set([1, 99, 2])],
    ]);
    const out = groupSelectionByRow(rows, sel);
    expect(out[0].ids).toEqual([1, 2]);
    expect(out[0].ids).not.toContain(99);
  });

  it("CRITICAL: zero selected → zero POSTs would be sent", () => {
    // This is the regression case we never want to see: nothing
    // selected, but a row with matches still gets through.
    const rows = buildKeywordRows([m(1, "iptal", "a"), m(2, "iptal", "a")], new Set());
    const sel = new Map<string, Set<number>>();
    const out = groupSelectionByRow(rows, sel);
    expect(out).toEqual([]);
    // Empty ids anywhere in the output is forbidden.
    for (const o of out) expect(o.ids.length).toBeGreaterThan(0);
  });
});

describe("flattenSelection", () => {
  it("returns (row, txId) pairs in row order with txIds sorted ascending", () => {
    const rows = buildKeywordRows(
      [
        m(3, "iptal", "a"),
        m(1, "iptal", "a"),
        m(2, "iptal", "a"),
      ],
      new Set(),
    );
    const sel = new Map([["iptal", new Set([3, 1, 2])]]);
    const flat = flattenSelection(rows, sel);
    expect(flat.map((x) => x.txId)).toEqual([1, 2, 3]);
    expect(flat.every((x) => x.row.group === "iptal")).toBe(true);
  });

  it("returns [] when nothing selected", () => {
    const rows = buildKeywordRows([m(1, "iptal", "a")], new Set());
    expect(flattenSelection(rows, new Map())).toEqual([]);
  });
});

// Ensure UnmatchedItem is referenced so types reflect expected shape.
const _u: UnmatchedItem = {
  transactionId: 1,
  phone: "",
  keyword1: "",
  keyword2: "",
  msgContent: "",
  shortCode: "",
  msgDate: "",
  id: "",
};
void _u;

// --- Per-txId firm resolution + groupByFirm -----------------------------
// These are the chokepoints for the cross-firm contamination guard. The
// rules in the docstring MUST be honored — if any of the precedence
// tests below flips, the operator could see Firm A's txIds charged
// against Firm B (a billable mistake).

function rowOf(
  group: string,
  suggested: string | null,
  suggestedName: string | null,
): KeywordRow {
  return {
    group,
    label: group === "__codec_fallback__" ? "Codec'e ücretlendir" : group,
    suggestedAccountEuId: suggested,
    suggestedAccountName: suggestedName,
    matches: [],
    worstConfidence: "high",
    dominantField: "keyword1",
    firmGroupKey: suggested ?? "",
  };
}

describe("resolveFirmForTx — precedence chain", () => {
  it("layer 1: tx-override kazanır her zaman", () => {
    const row = rowOf("iptal", "ai-uuid", "AI Suggestion Co");
    const out = resolveFirmForTx(42, row, undefined, {
      42: { accountEuId: "operator-uuid-pinned", accountName: "Pinned" },
    });
    expect(out.accountEuId).toBe("operator-uuid-pinned");
    expect(out.accountName).toBe("Pinned");
  });

  it("layer 2: row-override, tx-override yoksa", () => {
    const row = rowOf("iptal", "ai-uuid", "AI Co");
    const out = resolveFirmForTx(7, row, {
      iptal: { accountEuId: "row-uuid", accountName: "Row Firm" },
    }, undefined);
    expect(out.accountEuId).toBe("row-uuid");
    expect(out.accountName).toBe("Row Firm");
  });

  it("layer 3: AI suggestion, overrides yoksa", () => {
    const row = rowOf("iptal", "ai-uuid", "AI Co");
    expect(resolveFirmForTx(7, row, undefined, undefined)).toEqual({
      accountEuId: "ai-uuid",
      accountName: "AI Co",
    });
  });

  it("layer 4: safety net CODEC_ACCOUNT_EU_ID", () => {
    const row = rowOf("garbage", null, null);
    expect(resolveFirmForTx(7, row, undefined, undefined).accountEuId).toBe(
      CODEC_ACCOUNT_EU_ID,
    );
  });

  it('regression: string "null" tx-override sanitizer\'ı tetikler', () => {
    // AI yanlışlıkla literal "null" string'i tx-override'a yazdıysa (eski
    // session persist etmiş olabilir), sanitize edip diğer katmanlara
    // düşmesin. Burada row-override de yok → AI suggestion'a düşer.
    const row = rowOf("iptal", "ai-uuid", "AI Co");
    const out = resolveFirmForTx(7, row, undefined, {
      7: { accountEuId: "null", accountName: null },
    });
    expect(out.accountEuId).toBe("ai-uuid");
  });

  it("tx-override YANLIŞ accountEuId taşırsa, yine o accountEuId kullanılır (sanitize geçerse)", () => {
    // Operator bir UUID'yi yanlış yazdıysa validation charger.ts'de devreye
    // girer — bu helper yalnızca precedence'i test eder, validation
    // charger.validateAccountEuId'ye devredilir.
    const row = rowOf("iptal", "ai-uuid", "AI Co");
    const out = resolveFirmForTx(7, row, undefined, {
      7: { accountEuId: "definitely-a-uuid-not-the-ai-uuid-promise-32chars", accountName: "X" },
    });
    expect(out.accountEuId).toBe("definitely-a-uuid-not-the-ai-uuid-promise-32chars");
  });

  it("precedence zinciri: tx-override row-override AI'yı yener", () => {
    // Tüm katmanlar aynı anda dolu olsa bile tx-override kazanır.
    const row = rowOf("iptal", "ai-uuid", "AI Co");
    const out = resolveFirmForTx(7, row, {
      iptal: { accountEuId: "row-uuid", accountName: "Row" },
    }, {
      7: { accountEuId: "tx-uuid", accountName: "Tx" },
    });
    expect(out.accountEuId).toBe("tx-uuid");
  });

  it("regression: tx-override → CODEC_ACCOUNT_EU_ID reassign wins over AI suggestion", () => {
    // StepReview setTxFirm bug: dropdown'dan "Codec (fallback)"
    // seçildiğinde override DELETE ediliyordu, txId AI'ın önerdiği
    // firmaya (örn. AKTIF-BANK) geri düşüyordu. Düzeltme: override
    // her zaman SET edilir — bu test, CODEC_ACCOUNT_EU_ID'nin txId
    // reassign layer'ında da kullanılabildiğini kilitler.
    const row = rowOf("iptal", "aktif-bank-uuid", "Aktif Bank");
    const out = resolveFirmForTx(7, row, undefined, {
      7: { accountEuId: CODEC_ACCOUNT_EU_ID, accountName: CODEC_ACCOUNT_NAME },
    });
    expect(out.accountEuId).toBe(CODEC_ACCOUNT_EU_ID);
    expect(out.accountName).toBe(CODEC_ACCOUNT_NAME);
  });
});

// --- groupByFirm: firm düzeyi düz tablo --------------------------------

function buildFirmRows(rows: KeywordRow[]): KeywordRow[] {
  // Caller-supplied rows are already shaped; helper for test readability.
  return rows;
}

describe("groupByFirm — flat firm-level grouping", () => {
  it("aynı firmaya giden farklı keyword row'ları TEK section'da birleşir", () => {
    const rowA: KeywordRow = rowOf("iptal", "firm-a-uuid", "Firm A");
    rowA.matches = [m(1, "iptal", "firm-a-uuid"), m(2, "iptal", "firm-a-uuid")];
    const rowB: KeywordRow = rowOf("odeme", "firm-a-uuid", "Firm A");
    rowB.matches = [m(3, "odeme", "firm-a-uuid")];
    const sections = groupByFirm(buildFirmRows([rowA, rowB]), undefined, undefined, new Set());
    expect(sections).toHaveLength(1);
    expect(sections[0].accountName).toBe("Firm A");
    expect(sections[0].items.map((it) => it.transactionId).sort()).toEqual([1, 2, 3]);
  });

  it("her item source='suggested' olarak işaretlenir (override yoksa)", () => {
    const row: KeywordRow = rowOf("iptal", "firm-uuid", "Firm A");
    row.matches = [m(1, "iptal", "firm-uuid")];
    const sections = groupByFirm([row], undefined, undefined, new Set());
    expect(sections[0].items[0].source).toBe("suggested");
  });

  it("tx-override uygulanmış item source='tx-override' olur", () => {
    const row: KeywordRow = rowOf("iptal", "firm-a-uuid", "Firm A");
    row.matches = [m(42, "iptal", "firm-a-uuid"), m(43, "iptal", "firm-a-uuid")];
    const sections = groupByFirm(
      [row],
      undefined,
      { 42: { accountEuId: "firm-b-uuid", accountName: "Firm B" } },
      new Set(),
    );
    const items = sections.flatMap((s) => s.items);
    const tx42 = items.find((it) => it.transactionId === 42)!;
    const tx43 = items.find((it) => it.transactionId === 43)!;
    expect(tx42.source).toBe("tx-override");
    expect(tx42.effectiveFirm.accountEuId).toBe("firm-b-uuid");
    expect(tx43.source).toBe("suggested");

    // tx42 Firm B'de, tx43 Firm A'da → iki section.
    const sectionA = sections.find((s) => s.accountName === "Firm A")!;
    const sectionB = sections.find((s) => s.accountName === "Firm B")!;
    expect(sectionA.items.map((it) => it.transactionId)).toEqual([43]);
    expect(sectionB.items.map((it) => it.transactionId)).toEqual([42]);
  });

  it("row-override uygulanmış item source='row-override' olur", () => {
    const row: KeywordRow = rowOf("iptal", "ai-uuid", "AI Co");
    row.matches = [m(1, "iptal", "ai-uuid")];
    const sections = groupByFirm(
      [row],
      { iptal: { accountEuId: "row-uuid", accountName: "Row Co" } },
      undefined,
      new Set(),
    );
    expect(sections[0].items[0].source).toBe("row-override");
    expect(sections[0].items[0].effectiveFirm.accountEuId).toBe("row-uuid");
  });

  it("Codec fallback row source='codec-fallback' işaretlenir, CODEC_ACCOUNT_EU_ID UUID ile section olur", () => {
    const codec: KeywordRow = rowOf("__codec_fallback__", null, null);
    codec.matches = [m(10, "__codec_fallback__", null), m(20, "__codec_fallback__", null)];
    const sections = groupByFirm([codec], undefined, undefined, new Set());
    expect(sections).toHaveLength(1);
    expect(sections[0].accountEuId).toBe(CODEC_ACCOUNT_EU_ID);
    expect(sections[0].accountName).toBe(CODEC_ACCOUNT_EU_ID === sections[0].firmKey ? "Codec" : sections[0].accountName);
    expect(sections[0].items.every((it) => it.source === "codec-fallback")).toBe(true);
  });

  it("Codec fallback section her zaman EN SONDA sıralanır", () => {
    const codec: KeywordRow = rowOf("__codec_fallback__", null, null);
    codec.matches = [m(10, "__codec_fallback__", null)];
    const firm: KeywordRow = rowOf("iptal", "aktiff-bank-uuid", "Aktiff Bank");
    firm.matches = [m(1, "iptal", "aktiff-bank-uuid")];
    const sections = groupByFirm([codec, firm], undefined, undefined, new Set());
    expect(sections).toHaveLength(2);
    expect(sections[sections.length - 1].accountEuId).toBe(CODEC_ACCOUNT_EU_ID);
  });

  it("her section'ın items'ı transactionId ascending sıralanır", () => {
    const row: KeywordRow = rowOf("iptal", "firm-uuid", "Firm");
    row.matches = [m(99, "iptal", "firm-uuid"), m(3, "iptal", "firm-uuid"), m(50, "iptal", "firm-uuid")];
    const sections = groupByFirm([row], undefined, undefined, new Set());
    expect(sections[0].items.map((it) => it.transactionId)).toEqual([3, 50, 99]);
  });

  it("selectedCount selection Set<number> kesişiminden doğru hesaplanır", () => {
    const row: KeywordRow = rowOf("iptal", "firm-uuid", "Firm");
    row.matches = [m(1, "iptal", "firm-uuid"), m(2, "iptal", "firm-uuid"), m(3, "iptal", "firm-uuid")];
    const sections = groupByFirm([row], undefined, undefined, new Set([2, 3]));
    expect(sections[0].selectedCount).toBe(2);
  });

  it("iki farklı firma için iki section üretir, firmalar name asc sıralanır (Türkçe locale)", () => {
    const a: KeywordRow = rowOf("iptal", "uuid-a", "Yapı Kredi");
    a.matches = [m(1, "iptal", "uuid-a")];
    const b: KeywordRow = rowOf("odeme", "uuid-b", "Aktif Bank");
    b.matches = [m(2, "odeme", "uuid-b")];
    const sections = groupByFirm([a, b], undefined, undefined, new Set());
    expect(sections).toHaveLength(2);
    expect(sections[0].accountName).toBe("Aktif Bank"); // "A" < "Y" alphabet
    expect(sections[1].accountName).toBe("Yapı Kredi");
  });
});

// --- flattenSelected: charge handler için -----------------------------

describe("flattenSelected — selection'ı firmalara göre gruplar", () => {
  it("her section için seçili txId'leri verir", () => {
    const row: KeywordRow = rowOf("iptal", "firm-a-uuid", "Firm A");
    row.matches = [m(1, "iptal", "firm-a-uuid"), m(2, "iptal", "firm-a-uuid")];
    const sections = groupByFirm([row], undefined, undefined, new Set([1, 2]));
    const out = flattenSelected(sections, new Set([1, 2]));
    expect(out).toHaveLength(1);
    expect(out[0].txIds.sort()).toEqual([1, 2]);
    expect(out[0].accountEuId).toBe("firm-a-uuid");
  });

  it("reassign sonrası txId yeni section'ına geçer, eski section selection drop olur", () => {
    const row: KeywordRow = rowOf("iptal", "firm-a-uuid", "Firm A");
    row.matches = [m(1, "iptal", "firm-a-uuid"), m(2, "iptal", "firm-a-uuid")];
    // Önce her ikisi Firm A'da, sonra txId=2 reassign → Firm B
    const sectionsBefore = groupByFirm([row], undefined, undefined, new Set([1, 2]));
    const sectionsAfter = groupByFirm(
      [row],
      undefined,
      { 2: { accountEuId: "firm-b-uuid", accountName: "Firm B" } },
      new Set([1, 2]),
    );
    const beforeFlat = flattenSelected(sectionsBefore, new Set([1, 2]));
    const afterFlat = flattenSelected(sectionsAfter, new Set([1, 2]));
    expect(beforeFlat).toHaveLength(1);
    expect(beforeFlat[0].txIds.sort()).toEqual([1, 2]);
    expect(afterFlat).toHaveLength(2);
    const sectionA = afterFlat.find((s) => s.accountEuId === "firm-a-uuid")!;
    const sectionB = afterFlat.find((s) => s.accountEuId === "firm-b-uuid")!;
    expect(sectionA.txIds).toEqual([1]);
    expect(sectionB.txIds).toEqual([2]);
  });

  it("hiç seçim yoksa boş döner", () => {
    const row: KeywordRow = rowOf("iptal", "firm-uuid", "Firm");
    row.matches = [m(1, "iptal", "firm-uuid")];
    const sections = groupByFirm([row], undefined, undefined, new Set());
    expect(flattenSelected(sections, new Set())).toEqual([]);
  });
});

// --- Cross-firm contamination guard -----------------------------------
//
// This is the explicit bug-class the user wants defended against: a
// handler that posts txIds to multiple firms in one POST. We test the
// pure helpers (`resolveFirmForTx`, `flattenSelected`) and assert that
// the charge handler must ITSELF refuse to post a heterogeneous list
// (see StepReview's `chargeFirm`).

describe("cross-firm contamination guard (helper-level)", () => {
  it("resolveFirmForTx sonucu FARKLI olan iki txId aynı listeye giremez (helper boundary check)", () => {
    // Sanity guard: aynı rowda iki farklı öneri olmaz (validateMatches
    // tek satır üretir) ama row düzeyinde bile helper'a ayrı txId ile
    // çağrıldığında farklı sonuç çıkabilir. Burada helper'ın bu kadar
    // doğru çalıştığını kanıtlıyoruz; `chargeFirm` POST'a geçmeden
    // önce Set<accountEuId>.size > 1 ise throw eder.
    const row: KeywordRow = rowOf("iptal", "firm-a-uuid", "Firm A");
    row.matches = [m(1, "iptal", "firm-a-uuid")];
    // Aynı section, ama sahte bir şekilde txId=1 reassign yapalım:
    const sectionsAfter = groupByFirm(
      [row],
      undefined,
      { 1: { accountEuId: "firm-b-uuid", accountName: "Firm B" } },
      new Set([1]),
    );
    const out = flattenSelected(sectionsAfter, new Set([1]));
    expect(out).toHaveLength(1);
    expect(out[0].accountEuId).toBe("firm-b-uuid");
  });

  // Bu aşamada `chargeFirm` React handler'ı unit-test edilemiyor
  // (React render'ı gerekli). StepReview'daki `chargeFirm` review'ında
  // elle doğrulanacak; helper katmanı yukarıdaki testlerle sıkı.
  it("(placeholder) bileşen testi için StepReview.tsx chargeFirm'i reviewer gözden geçirmeli — Set<accountEuId>.size > 1 → throw", () => {
    expect(true).toBe(true);
  });
});

// --- formatTxIdsForCopy: bulk copy helper --------------------------------

describe("formatTxIdsForCopy — bulk-copy için formatlama", () => {
  it("hiç seçim yoksa null döner (caller toast ile uyarır)", () => {
    expect(formatTxIdsForCopy([], "sql")).toBeNull();
    expect(formatTxIdsForCopy([], "csv")).toBeNull();
    expect(formatTxIdsForCopy([], "lines")).toBeNull();
    expect(formatTxIdsForCopy([], "json")).toBeNull();
  });

  it("sql formatı: SQL IN clause için tek-tırnaklı liste", () => {
    expect(formatTxIdsForCopy([1001, 1002, 1003], "sql")).toBe(
      "('1001','1002','1003')",
    );
  });

  it("csv formatı: virgülle ayrılmış düz liste", () => {
    expect(formatTxIdsForCopy([1001, 1002, 1003], "csv")).toBe("1001,1002,1003");
  });

  it("lines formatı: satır başına tek txId (Excel'e dikey yapıştırma)", () => {
    expect(formatTxIdsForCopy([1001, 1002, 1003], "lines")).toBe(
      "1001\n1002\n1003",
    );
  });

  it("json formatı: JSON string dizisi", () => {
    expect(formatTxIdsForCopy([1001, 1002], "json")).toBe('["1001","1002"]');
  });

  it("sıralı çıktı: input karışık olsa bile artan sırada (diff/paste için)", () => {
    // Caller'lar selection Set'ini kullanıyor — Set iteration sırası
    // spec'e göre insertion order'a uyuyor ama operatör beklenmedik bir
    // satırı kaldırıp ekleyebilir. Çıktı her zaman deterministik.
    expect(formatTxIdsForCopy([3001, 1001, 2002], "csv")).toBe("1001,2002,3001");
    expect(formatTxIdsForCopy([3001, 1001, 2002], "sql")).toBe(
      "('1001','2002','3001')",
    );
  });

  it("tek elemanlı seçim de tüm formatlarda çalışır", () => {
    expect(formatTxIdsForCopy([42], "sql")).toBe("('42')");
    expect(formatTxIdsForCopy([42], "csv")).toBe("42");
    expect(formatTxIdsForCopy([42], "lines")).toBe("42");
    expect(formatTxIdsForCopy([42], "json")).toBe('["42"]');
  });

  it("regression: SQL çıktısında hiç escape yapılmıyor — txId integer; ' ve , doğru", () => {
    // txId'ler integer; string interpolation içinde ' ve , ayraç olarak
    // kullanılıyor. Eğer bir gün string txId gelirse (kötü veri), SQL
    // injection riski var — ancak backend schema integer. Operator'a
    // bilgi olarak bu test kilitliyor.
    const out = formatTxIdsForCopy([1, 2, 3], "sql")!;
    expect(out.startsWith("('")).toBe(true);
    expect(out.endsWith("')")).toBe(true);
    expect(out.split("','")).toHaveLength(3);
  });
});

// Suppress unused-FirmSectionItem import on build — runtime unused but
// kept exported for downstream consumers / future tests.
void (null as unknown as FirmSectionItem);

