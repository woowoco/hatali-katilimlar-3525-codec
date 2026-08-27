import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  buildUserPrompt,
  chunkItems,
  validateMatches,
} from "../prompts.js";
import type { ItemMatch, UnmatchedItem } from "../types.js";

function makeItem(id: number, kw1 = "", kw2 = "", body = ""): UnmatchedItem {
  return {
    transactionId: id,
    phone: `555${String(id).padStart(7, "0")}`,
    keyword1: kw1,
    keyword2: kw2,
    msgContent: body,
    shortCode: "3525",
    msgDate: "2026-08-20T10:00:00",
    id: `${id}|20.08.2026 10:00:00`,
  };
}

describe("chunkItems", () => {
  it("returns one chunk for empty input", () => {
    expect(chunkItems([])).toEqual([]);
  });
  it("respects the default batch size", () => {
    // 450 items / BATCH_SIZE(50) = 9 chunks.
    const arr = Array.from({ length: 450 }, (_, i) => i);
    const chunks = chunkItems(arr);
    expect(chunks).toHaveLength(9);
    expect(chunks[0]).toHaveLength(50);
    expect(chunks[1]).toHaveLength(50);
    expect(chunks[8]).toHaveLength(50);
  });
  it("supports custom size", () => {
    const arr = Array.from({ length: 10 }, (_, i) => i);
    const chunks = chunkItems(arr, 3);
    expect(chunks).toEqual([[0, 1, 2], [3, 4, 5], [6, 7, 8], [9]]);
  });
});

describe("buildSystemPrompt / buildUserPrompt", () => {
  it("system prompt mentions keyword-group requirement", () => {
    expect(buildSystemPrompt()).toMatch(/keywordGroup/i);
    expect(buildSystemPrompt()).toMatch(/read-only/i);
    // Should explicitly forbid invented ids.
    expect(buildSystemPrompt()).toMatch(/invent transactionIds/i);
  });

  it("user prompt includes every input item's transactionId", () => {
    const items = [makeItem(101, "IPTAL"), makeItem(102, "ODEME"), makeItem(103)];
    const text = buildUserPrompt([], items);
    expect(text).toContain("tx=101");
    expect(text).toContain("tx=102");
    expect(text).toContain("tx=103");
  });
});

describe("validateMatches", () => {
  const items = [makeItem(1, "IPTAL"), makeItem(2, "ODEME"), makeItem(3)];

  it("accepts a clean response covering every item", () => {
    const raw: ItemMatch[] = [
      {
        transactionId: 1,
        matchedField: "keyword1",
        matchedValue: "IPTAL",
        keywordGroup: "iptal",
        suggestedAccountEuId: "acc-1",
        suggestedAccountName: "Firm A",
        confidence: "high",
        reasoning: "iptal keyword",
      },
      {
        transactionId: 2,
        matchedField: "keyword1",
        matchedValue: "ODEME",
        keywordGroup: "odeme",
        suggestedAccountEuId: "acc-2",
        suggestedAccountName: "Firm B",
        confidence: "high",
        reasoning: "odeme keyword",
      },
      {
        transactionId: 3,
        matchedField: "keyword1",
        matchedValue: ".",
        keywordGroup: "unknown",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "garbage",
      },
    ];
    const cleaned = validateMatches(raw, items);
    expect(cleaned).toHaveLength(3);
    expect(cleaned[2].suggestedAccountEuId).toBeNull();
  });

  it("throws if an input item is not covered", () => {
    const raw: ItemMatch[] = [
      {
        transactionId: 1,
        matchedField: "keyword1",
        matchedValue: "IPTAL",
        keywordGroup: "iptal",
        suggestedAccountEuId: "acc-1",
        suggestedAccountName: "Firm A",
        confidence: "high",
        reasoning: "",
      },
    ];
    expect(() => validateMatches(raw, items)).toThrow(/not covered/i);
  });

  it("throws on unknown transactionId", () => {
    const raw: ItemMatch[] = [
      {
        transactionId: 999,
        matchedField: "keyword1",
        matchedValue: "X",
        keywordGroup: "x",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
    ];
    expect(() => validateMatches(raw, items)).toThrow(/unknown transactionId 999/i);
  });

  it("throws on duplicate transactionId", () => {
    const raw: ItemMatch[] = [
      {
        transactionId: 1,
        matchedField: "keyword1",
        matchedValue: "X",
        keywordGroup: "x",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
      {
        transactionId: 1,
        matchedField: "keyword2",
        matchedValue: "Y",
        keywordGroup: "x",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
    ];
    expect(() => validateMatches(raw, items)).toThrow(/multiple matches/i);
  });

  it("normalizes Turkish characters in keywordGroup to ASCII kebab-case", () => {
    const raw: ItemMatch[] = [
      {
        transactionId: 1,
        matchedField: "keyword1",
        matchedValue: "IPTAL",
        keywordGroup: "İPTAL İptali",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
      {
        transactionId: 2,
        matchedField: "keyword1",
        matchedValue: "ODEME",
        keywordGroup: "Ödeme Geri Alma",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
      {
        transactionId: 3,
        matchedField: "keyword1",
        matchedValue: ".",
        keywordGroup: "",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
    ];
    const cleaned = validateMatches(raw, items);
    expect(cleaned[0].keywordGroup).toBe("iptal-iptali");
    expect(cleaned[1].keywordGroup).toBe("odeme-geri-alma");
    expect(cleaned[2].keywordGroup).toBe("unknown");
  });

  it("falls back to 'keyword1' when matchedField is invalid", () => {
    const raw: ItemMatch[] = [
      {
        transactionId: 1,
        matchedField: "bogus" as never,
        matchedValue: "X",
        keywordGroup: "x",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
    ];
    // For tx=1 only; need to provide matches for tx=2,3 too.
    raw.push(
      {
        transactionId: 2,
        matchedField: "keyword1",
        matchedValue: "Y",
        keywordGroup: "y",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
      {
        transactionId: 3,
        matchedField: "keyword1",
        matchedValue: "Z",
        keywordGroup: "z",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
    );
    const cleaned = validateMatches(raw, items);
    expect(cleaned[0].matchedField).toBe("keyword1");
  });

  // ---------------------------------------------------------------------
  // Regression: the LLM has been seen to emit the LITERAL STRING "null"
  // (4 characters, JSON-encoded as `"null"`) in place of the JSON null
  // for `suggestedAccountEuId`. The tool schema now permits `["string",
  // "null"]`, but a future schema change could regress — so we also
  // coerce here. The downstream extension's `buildKeywordRows` filters
  // via strict `=== null`, so coerced-as-null entries land in the Codec
  // fallback bucket rather than slipping through as a regular row with
  // accountEuId=`"null"`.
  // ---------------------------------------------------------------------

  it('coerces literal string "null" → null for suggestedAccountEuId', () => {
    const raw: ItemMatch[] = [
      {
        transactionId: 1,
        matchedField: "keyword1",
        matchedValue: "IPTAL",
        keywordGroup: "iptal",
        suggestedAccountEuId: "null" as unknown as null,
        suggestedAccountName: "Firm A",
        confidence: "low",
        reasoning: "",
      },
      {
        transactionId: 2,
        matchedField: "keyword1",
        matchedValue: "ODEME",
        keywordGroup: "odeme",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
      {
        transactionId: 3,
        matchedField: "keyword1",
        matchedValue: ".",
        keywordGroup: "unknown",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
    ];
    const cleaned = validateMatches(raw, items);
    expect(cleaned[0].suggestedAccountEuId).toBeNull();
  });

  it("coerces empty-string + whitespace suggestedAccountEuId → null", () => {
    const raw: ItemMatch[] = [
      {
        transactionId: 1,
        matchedField: "keyword1",
        matchedValue: "X",
        keywordGroup: "x",
        suggestedAccountEuId: "" as unknown as null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
      {
        transactionId: 2,
        matchedField: "keyword1",
        matchedValue: "Y",
        keywordGroup: "y",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
      {
        transactionId: 3,
        matchedField: "keyword1",
        matchedValue: "Z",
        keywordGroup: "z",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
    ];
    const cleaned = validateMatches(raw, items);
    expect(cleaned[0].suggestedAccountEuId).toBeNull();
    expect(cleaned[1].suggestedAccountEuId).toBeNull();
  });

  it('coerces literal "null" string for suggestedAccountName → null', () => {
    const raw: ItemMatch[] = [
      {
        transactionId: 1,
        matchedField: "keyword1",
        matchedValue: "X",
        keywordGroup: "x",
        suggestedAccountEuId: "acc-1",
        suggestedAccountName: "null" as unknown as null,
        confidence: "low",
        reasoning: "",
      },
      {
        transactionId: 2,
        matchedField: "keyword1",
        matchedValue: "Y",
        keywordGroup: "y",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
      {
        transactionId: 3,
        matchedField: "keyword1",
        matchedValue: "Z",
        keywordGroup: "z",
        suggestedAccountEuId: null,
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
    ];
    const cleaned = validateMatches(raw, items);
    expect(cleaned[0].suggestedAccountName).toBeNull();
  });
});