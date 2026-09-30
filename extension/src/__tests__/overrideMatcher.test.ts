import { describe, it, expect } from "vitest";
import { matchItem, firstMatch, computeRuleUsage } from "../lib/overrideMatcher.js";
import type { KeywordOverride, UnmatchedItem } from "../types.js";

function mkItem(over: Partial<UnmatchedItem> = {}): UnmatchedItem {
  return {
    transactionId: 1,
    phone: "+90 555 000 00 00",
    keyword1: "",
    keyword2: "",
    msgContent: "",
    shortCode: "3525",
    msgDate: "2026-09-30T10:00:00Z",
    id: "i1",
    ...over,
  };
}

function mkRule(over: Partial<KeywordOverride> = {}): KeywordOverride {
  return {
    id: over.id ?? "r1",
    accountName: over.accountName ?? "Aktif Bank",
    acntEuId: over.acntEuId ?? "u1",
    keywords: over.keywords ?? ["EVET"],
    matchMode: over.matchMode,
    notes: over.notes,
  };
}

describe("matchItem — contains (default)", () => {
  it("matches a keyword against keyword1 (case-insensitive)", () => {
    const rule = mkRule({ keywords: ["evet"] });
    const item = mkItem({ keyword1: "EVET" });
    const out = matchItem(item, [rule]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ ruleId: "r1", matchedKeyword: "evet", matchedField: "keyword1" });
  });

  it("matches substring inside keyword2", () => {
    const rule = mkRule({ keywords: ["AKTIFBANK"] });
    const item = mkItem({ keyword2: "AKTIFBANK IPTAL" });
    const out = matchItem(item, [rule]);
    expect(out).toHaveLength(1);
    expect(out[0].matchedField).toBe("keyword2");
  });

  it("matches inside msgContent", () => {
    const rule = mkRule({ keywords: ["kargo"] });
    const item = mkItem({ msgContent: "KARGO onay bekleniyor" });
    expect(matchItem(item, [rule])).toHaveLength(1);
  });

  it("returns empty when no field contains the keyword", () => {
    const rule = mkRule({ keywords: ["XYZ"] });
    const item = mkItem({ keyword1: "EVET", keyword2: "IPTAL", msgContent: "hello" });
    expect(matchItem(item, [rule])).toEqual([]);
  });

  it("returns empty when rule keywords array is empty (after trim)", () => {
    const rule = mkRule({ keywords: ["", "  "] });
    const item = mkItem({ keyword1: "EVET" });
    expect(matchItem(item, [rule])).toEqual([]);
  });

  it("reports the first matching keyword in rule order (deterministic)", () => {
    const rule = mkRule({ keywords: ["EVET", "aktifbank"] });
    const item = mkItem({ keyword1: "AKTIFBANK" });
    const out = matchItem(item, [rule]);
    expect(out).toHaveLength(1);
    // Returns the keyword AS WRITTEN in the rule, not the field value.
    expect(out[0].matchedKeyword).toBe("aktifbank");
  });

  it("scans fields in keyword1 → keyword2 → msgContent order", () => {
    const rule = mkRule({ keywords: ["EVET"] });
    const item = mkItem({ keyword1: "", keyword2: "EVET", msgContent: "EVET" });
    const out = matchItem(item, [rule]);
    expect(out[0].matchedField).toBe("keyword2");
  });
});

describe("matchItem — exact mode", () => {
  it("matches whole-field equality after trim (case-insensitive)", () => {
    const rule = mkRule({ keywords: ["EVET"], matchMode: "exact" });
    const item = mkItem({ keyword1: "  evet  " });
    expect(matchItem(item, [rule])).toHaveLength(1);
  });

  it("does NOT match when keyword1 contains the rule keyword as a substring", () => {
    const rule = mkRule({ keywords: ["EVET"], matchMode: "exact" });
    const item = mkItem({ keyword1: "EVET IPTAL" });
    expect(matchItem(item, [rule])).toEqual([]);
  });

  it("does NOT match when the field is empty", () => {
    const rule = mkRule({ keywords: ["EVET"], matchMode: "exact" });
    const item = mkItem({ keyword1: "" });
    expect(matchItem(item, [rule])).toEqual([]);
  });
});

describe("matchItem — multiple rules", () => {
  it("returns matches in input rule order", () => {
    const a = mkRule({ id: "a", keywords: ["A"] });
    const b = mkRule({ id: "b", keywords: ["B"] });
    const item = mkItem({ keyword1: "A B" });
    const out = matchItem(item, [a, b]);
    expect(out.map((m) => m.ruleId)).toEqual(["a", "b"]);
  });

  it("skips rules that don't match but keeps ones that do", () => {
    const a = mkRule({ id: "a", keywords: ["Z"] });
    const b = mkRule({ id: "b", keywords: ["EVET"] });
    const item = mkItem({ keyword1: "EVET" });
    const out = matchItem(item, [a, b]);
    expect(out.map((m) => m.ruleId)).toEqual(["b"]);
  });
});

describe("firstMatch", () => {
  it("returns the first rule's match", () => {
    const a = mkRule({ id: "a", keywords: ["EVET"] });
    const b = mkRule({ id: "b", keywords: ["IPTAL"] });
    const item = mkItem({ keyword1: "EVET IPTAL" });
    const out = firstMatch(item, [a, b]);
    expect(out?.ruleId).toBe("a");
  });

  it("returns null when nothing matches", () => {
    const item = mkItem({ keyword1: "OTHER" });
    expect(firstMatch(item, [mkRule({ keywords: ["EVET"] })])).toBeNull();
  });
});

describe("computeRuleUsage", () => {
  it("counts per-rule matches and samples up to cap transactionIds", () => {
    const ruleA = mkRule({ id: "a", keywords: ["EVET"] });
    const ruleB = mkRule({ id: "b", keywords: ["XYZ"] });
    const items: UnmatchedItem[] = [
      mkItem({ transactionId: 10, keyword1: "EVET" }),
      mkItem({ transactionId: 11, keyword1: "evet" }),
      mkItem({ transactionId: 12, keyword1: "IPTAL" }),
      mkItem({ transactionId: 13, keyword2: "EVET" }),
    ];
    const stats = computeRuleUsage([ruleA, ruleB], items, 3);
    const aStat = stats.find((s) => s.ruleId === "a")!;
    expect(aStat.matchCount).toBe(3);
    expect(aStat.sampleTransactionIds).toEqual([10, 11, 13]);
    const bStat = stats.find((s) => s.ruleId === "b")!;
    expect(bStat.matchCount).toBe(0);
    expect(bStat.sampleTransactionIds).toEqual([]);
  });

  it("emits one entry per input rule, in order", () => {
    const ruleA = mkRule({ id: "a", keywords: ["A"] });
    const ruleB = mkRule({ id: "b", keywords: ["B"] });
    const stats = computeRuleUsage([ruleA, ruleB], []);
    expect(stats.map((s) => s.ruleId)).toEqual(["a", "b"]);
  });
});
