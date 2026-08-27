import { describe, expect, it, vi } from "vitest";
import {
  buildKeywordRows,
  flattenSelection,
  groupSelectionByRow,
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
});

describe("buildKeywordRows", () => {
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
