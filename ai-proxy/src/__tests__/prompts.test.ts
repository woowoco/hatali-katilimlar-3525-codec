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
  // Two-firm customer list used by the int-ref roundtrip tests below.
  const customers = [
    { name: "Aktif Bank", acntEuId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
    { name: "Garanti",   acntEuId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
    { name: "Codec",     acntEuId: "00000000-0000-0000-0000-000000000000" },
  ];

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
    const { cleaned } = validateMatches(raw, items);
    expect(cleaned).toHaveLength(3);
    expect(cleaned[2].suggestedAccountEuId).toBeNull();
  });

  it("translates integer customer indices back to real UUIDs", () => {
    const raw = [
      {
        transactionId: 1,
        matchedField: "keyword1",
        matchedValue: "IPTAL",
        keywordGroup: "iptal",
        suggestedAccountEuId: 1,            // → customers[0].acntEuId
        suggestedAccountName: "Aktif Bank",
        confidence: "high",
        reasoning: "",
      },
      {
        transactionId: 2,
        matchedField: "keyword1",
        matchedValue: "ODEME",
        keywordGroup: "odeme",
        suggestedAccountEuId: 2,            // → customers[1].acntEuId
        suggestedAccountName: "Garanti",
        confidence: "high",
        reasoning: "",
      },
      {
        transactionId: 3,
        matchedField: "keyword1",
        matchedValue: ".",
        keywordGroup: "unknown",
        suggestedAccountEuId: null,         // → Codec
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
    ];
    const { cleaned } = validateMatches(raw, items, customers);
    expect(cleaned[0].suggestedAccountEuId).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(cleaned[1].suggestedAccountEuId).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
    expect(cleaned[2].suggestedAccountEuId).toBeNull();
  });

  it("routes out-of-range integer indices to Codec", () => {
    const raw = [
      {
        transactionId: 1,
        matchedField: "keyword1",
        matchedValue: "X",
        keywordGroup: "x",
        suggestedAccountEuId: 99,           // out of range
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
      {
        transactionId: 2,
        matchedField: "keyword1",
        matchedValue: "Y",
        keywordGroup: "y",
        suggestedAccountEuId: 0,            // 0 is not a valid 1-based index
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
      {
        transactionId: 3,
        matchedField: "keyword1",
        matchedValue: "Z",
        keywordGroup: "z",
        suggestedAccountEuId: "2",          // numeric string is tolerated
        suggestedAccountName: null,
        confidence: "low",
        reasoning: "",
      },
    ];
    const { cleaned } = validateMatches(raw, items, customers);
    expect(cleaned[0].suggestedAccountEuId).toBeNull();
    expect(cleaned[1].suggestedAccountEuId).toBeNull();
    expect(cleaned[2].suggestedAccountEuId).toBe("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  });

  it("returns missing txIds instead of throwing when coverage is incomplete", () => {
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
    const result = validateMatches(raw, items);
    expect(result.cleaned).toHaveLength(1);
    expect(result.cleaned[0].transactionId).toBe(1);
    expect(result.missing).toEqual([2, 3]);
    expect(result.invalid).toEqual([]);
  });

  it("isolates unknown transactionId into invalid[] instead of throwing", () => {
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
    const result = validateMatches(raw, items);
    expect(result.cleaned).toEqual([]);
    expect(result.invalid).toHaveLength(1);
    expect((result.invalid[0] as ItemMatch).transactionId).toBe(999);
    // Real items 1, 2, 3 are still missing — that surfaces via the
    // repair/synthesis path, not as a thrown error.
    expect(result.missing).toEqual([1, 2, 3]);
  });

  it("keeps the first occurrence of a duplicate txId and isolates the rest", () => {
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
    const result = validateMatches(raw, items);
    expect(result.cleaned).toHaveLength(1);
    expect(result.cleaned[0].matchedField).toBe("keyword1");
    expect(result.invalid).toHaveLength(1);
    expect((result.invalid[0] as ItemMatch).matchedField).toBe("keyword2");
    expect(result.missing).toEqual([2, 3]);
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
    const { cleaned } = validateMatches(raw, items);
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
    const { cleaned } = validateMatches(raw, items);
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
    const { cleaned } = validateMatches(raw, items);
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
    const { cleaned } = validateMatches(raw, items);
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
    const { cleaned } = validateMatches(raw, items);
    expect(cleaned[0].suggestedAccountName).toBeNull();
  });
});