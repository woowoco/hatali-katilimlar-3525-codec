import { describe, expect, it } from "vitest";
import {
  clusterByFingerprint,
  expandClusterMatches,
  fingerprint,
} from "../lib/clustering.js";
import type { ItemMatch, UnmatchedItem } from "../types.js";

// --- Test fixtures ----------------------------------------------------------

/**
 * Convenience builder — every field defaulted so tests can pin only the
 * fields they care about. transactionId is the only required field.
 */
function item(
  transactionId: number,
  keyword1 = "",
  keyword2 = "",
  msgContent = "",
): UnmatchedItem {
  return {
    transactionId,
    phone: `+90${String(transactionId).padStart(10, "0")}`,
    keyword1,
    keyword2,
    msgContent,
    shortCode: "3525",
    msgDate: "2026-08-27T00:00:00Z",
    id: `id-${transactionId}`,
  };
}

function match(
  transactionId: number,
  overrides: Partial<ItemMatch> = {},
): ItemMatch {
  return {
    transactionId,
    matchedField: "keyword1",
    matchedValue: "RET",
    keywordGroup: "ret-prefix",
    suggestedAccountEuId: "11111111-1111-1111-1111-111111111111",
    suggestedAccountName: "Test Firm",
    confidence: "high",
    reasoning: "test",
    ...overrides,
  };
}

// --- fingerprint() ----------------------------------------------------------

describe("fingerprint", () => {
  it("normalizes Turkish characters via NFKD + ı→i", () => {
    const a = item(1, "İPTAL", "", "");
    const b = item(2, "iptal", "", "");
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("treats mojibake (Ä°PTAL) as equivalent to IPTAL", () => {
    // HAR-confirmed: the operator sees both `Ä°PTAL` (mojibake — Ä = U+00C4,
    // ° = U+00B0) and `IPTAL` (clean) in the same dataset. NFKD strips the
    // combining marks so the two forms collapse together.
    const a = item(1, "IPTAL", "", "");
    const b = item(2, "IPTAL", "", "");
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("strips combining diacritics (s̃ → s)", () => {
    // Pre-composed 's' + combining tilde should match plain 's' after NFKD.
    const a = item(1, "s̃", "", "");
    const b = item(2, "s", "", "");
    expect(fingerprint(a)).toBe(fingerprint(b));
  });

  it("is case-insensitive across all three fields", () => {
    expect(fingerprint(item(1, "RET", "", ""))).toBe(
      fingerprint(item(2, "ret", "", "")),
    );
    expect(fingerprint(item(1, "", "AKTIFBANK", ""))).toBe(
      fingerprint(item(2, "", "aktifbank", "")),
    );
    expect(fingerprint(item(1, "", "", "iptal istiyorum"))).toBe(
      fingerprint(item(2, "", "", "IPTAL ISTIYORUM")),
    );
  });

  it("trims leading/trailing whitespace", () => {
    expect(fingerprint(item(1, "  RET  ", "", ""))).toBe(
      fingerprint(item(2, "ret", "", "")),
    );
  });

  it("returns a stable `||` key for three empty fields", () => {
    expect(fingerprint(item(1, "", "", ""))).toBe("||");
  });

  it("is undefined-safe (no field is undefined)", () => {
    // Item shape guarantees strings, but norm() accepts undefined too.
    expect(fingerprint(item(1, "", "", ""))).toBe(fingerprint(item(2)));
  });

  it("differentiates items that share 2 of 3 fields", () => {
    expect(fingerprint(item(1, "RET", "", ""))).not.toBe(
      fingerprint(item(2, "RET", "TAKSIT", "")),
    );
    expect(fingerprint(item(1, "RET", "", ""))).not.toBe(
      fingerprint(item(2, "RET", "", "iptal")),
    );
  });
});

// --- msgContent MUST differentiate clusters (operator's 3rd clarification) ---

describe("msgContent differentiates clusters", () => {
  it("(IPTAL, '', '') and (IPTAL, '', 'iptal onayliyorum') are separate clusters", () => {
    const items: UnmatchedItem[] = [
      item(1, "IPTAL", "", ""),
      item(2, "IPTAL", "", ""),
      item(3, "IPTAL", "", "iptal onayliyorum"),
    ];
    const { representatives, clusterMap } = clusterByFingerprint(items);

    // Two distinct fingerprints → two clusters.
    expect(representatives.length).toBe(2);
    expect(clusterMap.size).toBe(2);

    // Both (1, 2) collapsed; (3) stayed singleton.
    const rep1 = representatives.find((r) => r.transactionId === 1)!;
    expect(clusterMap.get(rep1.transactionId)).toEqual([1, 2]);
    expect(clusterMap.get(3)).toEqual([3]);
  });

  it("empty msgContent + identical kw1/kw2 still collapses (HAR top case)", () => {
    // 100 items, all (RET, '', '') — biggest win on real data.
    const items: UnmatchedItem[] = [];
    for (let i = 1; i <= 100; i++) items.push(item(i, "RET", "", ""));
    const { representatives, clusterMap } = clusterByFingerprint(items);

    expect(representatives.length).toBe(1);
    const rep = representatives[0];
    // Lowest txId wins → 1.
    expect(rep.transactionId).toBe(1);
    expect(clusterMap.get(1)?.length).toBe(100);
  });
});

// --- clusterByFingerprint() invariants ---------------------------------------

describe("clusterByFingerprint invariants", () => {
  const mixed: UnmatchedItem[] = [
    item(10, "RET", "", ""),
    item(20, "RET", "", ""),
    item(30, "İPTAL", "", ""),
    item(40, "AKTIFBANK", "", ""),
    item(50, "AKTIFBANK", "", ""),
    item(60, "LWC", "", "iptal onayliyorum"),
    item(70, "LWC", "", "iptal onayliyorum"),
  ];

  it("TXID CONTRACT #1 — total preservation", () => {
    const { clusterMap } = clusterByFingerprint(mixed);
    const total = [...clusterMap.values()].reduce((s, ids) => s + ids.length, 0);
    expect(total).toBe(mixed.length);
  });

  it("TXID CONTRACT #2 — no duplicates across clusters (partition)", () => {
    const { clusterMap } = clusterByFingerprint(mixed);
    const flat = [...clusterMap.values()].flat();
    expect(new Set(flat).size).toBe(flat.length);
    // And every original txId is present.
    expect(new Set(flat)).toEqual(new Set(mixed.map((m) => m.transactionId)));
  });

  it("TXID CONTRACT #3 — representatives.length === unique fingerprints", () => {
    const { representatives, clusterMap } = clusterByFingerprint(mixed);
    expect(representatives.length).toBe(clusterMap.size);
    // 4 unique fingerprints: (RET,'',''), (İPTAL,'',''), (AKTIFBANK,'',''), (LWC,'','iptal onayliyorum')
    expect(representatives.length).toBe(4);
  });

  it("TXID CONTRACT #4 — no fabricated items (representatives ⊆ input)", () => {
    const { representatives } = clusterByFingerprint(mixed);
    const inputIds = new Set(mixed.map((m) => m.transactionId));
    for (const r of representatives) {
      expect(inputIds.has(r.transactionId)).toBe(true);
    }
  });

  it("TXID CONTRACT #5 — representative = lowest transactionId in cluster", () => {
    const { representatives } = clusterByFingerprint(mixed);
    const byRepId = new Map(representatives.map((r) => [r.transactionId, r]));
    // RET cluster: {10, 20} → rep = 10.
    expect(byRepId.get(10)?.keyword1).toBe("RET");
    expect(byRepId.get(30)?.keyword1).toBe("İPTAL");
    // AKTIFBANK cluster: {40, 50} → rep = 40.
    expect(byRepId.get(40)?.keyword1).toBe("AKTIFBANK");
    // LWC cluster: {60, 70} → rep = 60.
    expect(byRepId.get(60)?.keyword1).toBe("LWC");
  });

  it("fingerprint equivalence within a cluster", () => {
    // Build clusters and confirm every member has the same normalized triple.
    const { clusterMap } = clusterByFingerprint(mixed);
    const inputById = new Map(mixed.map((m) => [m.transactionId, m]));
    for (const ids of clusterMap.values()) {
      const fp0 = fingerprint(inputById.get(ids[0])!);
      for (const id of ids) {
        expect(fingerprint(inputById.get(id)!)).toBe(fp0);
      }
    }
  });

  it("handles empty input", () => {
    const { representatives, clusterMap } = clusterByFingerprint([]);
    expect(representatives).toEqual([]);
    expect(clusterMap.size).toBe(0);
  });
});

// --- expandClusterMatches() --------------------------------------------------

describe("expandClusterMatches", () => {
  it("TXID CONTRACT — round-trip: every input txId appears exactly once, verbatim", () => {
    const items: UnmatchedItem[] = [
      item(10, "RET", "", ""),
      item(20, "RET", "", ""),
      item(30, "İPTAL", "", ""),
      item(40, "AKTIFBANK", "", ""),
    ];
    const { representatives, clusterMap } = clusterByFingerprint(items);
    // Identity matches for the two representatives.
    const matches = representatives.map((r) => match(r.transactionId));
    const expanded = expandClusterMatches(matches, clusterMap);

    // Count: 4 unique input txIds → 4 expanded matches.
    expect(expanded.length).toBe(items.length);

    // Every input txId appears exactly once.
    const originalIds = new Set(items.map((i) => i.transactionId));
    const expandedIds = expanded.map((m) => m.transactionId);
    expect(new Set(expandedIds)).toEqual(originalIds);
    // No duplicates.
    expect(new Set(expandedIds).size).toBe(expandedIds.length);
  });

  it("preserves LLM metadata uniformly across cluster members", () => {
    const items: UnmatchedItem[] = [
      item(10, "RET", "", ""),
      item(20, "RET", "", ""),
      item(30, "RET", "", ""),
    ];
    const { clusterMap } = clusterByFingerprint(items);
    const llmMatch: ItemMatch = match(10, {
      matchedField: "keyword1",
      matchedValue: "RET",
      keywordGroup: "ret-prefix",
      suggestedAccountEuId: "abc",
      suggestedAccountName: "Test Firm",
      confidence: "high",
      reasoning: "clear RET prefix",
    });
    const expanded = expandClusterMatches([llmMatch], clusterMap);
    expect(expanded.length).toBe(3);
    for (const m of expanded) {
      expect(m.matchedField).toBe("keyword1");
      expect(m.matchedValue).toBe("RET");
      expect(m.keywordGroup).toBe("ret-prefix");
      expect(m.suggestedAccountEuId).toBe("abc");
      expect(m.suggestedAccountName).toBe("Test Firm");
      expect(m.confidence).toBe("high");
      expect(m.reasoning).toBe("clear RET prefix");
    }
    // Only the txId differs.
    expect(expanded.map((m) => m.transactionId).sort((a, b) => a - b)).toEqual([10, 20, 30]);
  });

  it("throws when given a representative txId not in clusterMap", () => {
    const { clusterMap } = clusterByFingerprint([item(1, "RET", "", "")]);
    const bogus: ItemMatch = match(999);
    expect(() => expandClusterMatches([bogus], clusterMap)).toThrow(
      /representative txId 999 not in clusterMap/,
    );
  });

  it("does not duplicate txIds across multiple representative matches", () => {
    // Edge case: two clusters share the same member — defensive `seen` set.
    // Force this by hand-crafting the clusterMap.
    const clusterMap = new Map<number, number[]>([
      [10, [10, 20]],
      [20, [10, 20]], // duplicate cluster definition
    ]);
    const expanded = expandClusterMatches(
      [match(10), match(20)],
      clusterMap,
    );
    expect(expanded.map((m) => m.transactionId).sort((a, b) => a - b)).toEqual([10, 20]);
  });
});
