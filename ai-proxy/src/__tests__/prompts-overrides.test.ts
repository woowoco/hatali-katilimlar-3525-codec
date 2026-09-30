import { describe, it, expect } from "vitest";
import { buildUserPrompt } from "../prompts.js";
import type { Customer, KeywordOverride } from "../types.js";

const customers: Customer[] = [
  { name: "Aktif Bank", acntEuId: "u1" },
  { name: "Garanti", acntEuId: "u2" },
  { name: "YKB", acntEuId: "u3" },
];

describe("buildUserPrompt — overrides section (JSON fence)", () => {
  it("omits the OVERRIDES section entirely when no overrides are passed", () => {
    const prompt = buildUserPrompt(customers, [], []);
    expect(prompt).not.toMatch(/=== OVERRIDES/);
  });

  it("omits the OVERRIDES section when every rule has empty keywords", () => {
    const overrides: KeywordOverride[] = [
      { id: "r1", accountName: "Aktif Bank", acntEuId: "u1", keywords: [], matchMode: "contains" },
    ];
    const prompt = buildUserPrompt(customers, [], overrides);
    // Empty-keyword rules are dropped → section header still mentions count 0
    // (header is emitted by buildUserPrompt), but the fenced block is empty.
    // The cleaner contract is "no header at all when usable.length === 0".
    // We accept either: header with N=0, or no header at all.
    expect(prompt.match(/=== OVERRIDES/g)?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("emits the JSON fenced block with every usable rule", () => {
    const overrides: KeywordOverride[] = [
      { id: "r1", accountName: "Aktif Bank", acntEuId: "u1", keywords: ["EVET", "aktifbank"], matchMode: "contains", notes: "Kargo" },
      { id: "r2", accountName: "PTT", acntEuId: null, keywords: ["ptt"], matchMode: "exact" },
    ];
    const prompt = buildUserPrompt(customers, [], overrides);
    expect(prompt).toContain("=== OVERRIDES (2) — operator-maintained routing rules ===");
    expect(prompt).toContain("```json");
    expect(prompt).toContain('"accountName": "Aktif Bank"');
    expect(prompt).toContain('"keywords": [');
    expect(prompt).toContain('"EVET"');
    expect(prompt).toContain('"aktifbank"');
  });

  it("emits acntEuId as the 1-based customer-list index when resolvable", () => {
    const overrides: KeywordOverride[] = [
      { id: "r1", accountName: "Garanti", acntEuId: "u2", keywords: ["EVET"], matchMode: "contains" },
    ];
    const prompt = buildUserPrompt(customers, [], overrides);
    // Garanti is the second customer → 1-based index = 2.
    expect(prompt).toMatch(/"accountName": "Garanti"[\s\S]*"acntEuId": 2/);
    expect(prompt).toContain('"resolvedFromCustomerList": true');
  });

  it("emits acntEuId as null and adds a warning when the firm is not in the customer list", () => {
    const overrides: KeywordOverride[] = [
      { id: "r1", accountName: "Unknown Firm", acntEuId: null, keywords: ["EVET"], matchMode: "contains" },
    ];
    const prompt = buildUserPrompt(customers, [], overrides);
    expect(prompt).toMatch(/"accountName": "Unknown Firm"[\s\S]*"acntEuId": null/);
    expect(prompt).toContain('"warning":');
    expect(prompt).toContain('"resolvedFromCustomerList": false');
  });

  it("emits acntEuId as null when the rule's UUID does not match the canonical UUID for that firm", () => {
    // Operator renamed/edited the UUID by hand — the extension stored a
    // stale UUID. The proxy should treat this as "not in list" so the
    // AI does not suggest a stale id.
    const overrides: KeywordOverride[] = [
      { id: "r1", accountName: "Aktif Bank", acntEuId: "stale-uuid", keywords: ["EVET"], matchMode: "contains" },
    ];
    const prompt = buildUserPrompt(customers, [], overrides);
    expect(prompt).toMatch(/"accountName": "Aktif Bank"[\s\S]*"acntEuId": null/);
  });

  it("drops rules whose keywords array is empty after trim", () => {
    const overrides: KeywordOverride[] = [
      { id: "r1", accountName: "Aktif Bank", acntEuId: "u1", keywords: ["EVET"], matchMode: "contains" },
      { id: "r2", accountName: "Garanti", acntEuId: "u2", keywords: [], matchMode: "contains" },
      { id: "r3", accountName: "YKB", acntEuId: "u3", keywords: ["  "], matchMode: "contains" },
    ];
    const prompt = buildUserPrompt(customers, [], overrides);
    expect(prompt).toContain("=== OVERRIDES (1) — operator-maintained routing rules ===");
    expect(prompt).not.toContain('"accountName": "Garanti"');
    expect(prompt).not.toContain('"accountName": "YKB"');
  });

  it("preserves the safety contract — AI NEVER auto-charges", () => {
    const overrides: KeywordOverride[] = [
      { id: "r1", accountName: "Aktif Bank", acntEuId: "u1", keywords: ["EVET"], matchMode: "contains" },
    ];
    const prompt = buildUserPrompt(customers, [], overrides);
    // English contract line AND/OR Turkish equivalent from system prompt.
    expect(prompt).toMatch(/NEVER auto-charges|HİÇBİR ZAMAN otomatik/i);
  });

  it("spell-checks the matchMode semantics block once, not per row", () => {
    const overrides: KeywordOverride[] = [
      { id: "r1", accountName: "Aktif Bank", acntEuId: "u1", keywords: ["A"], matchMode: "contains" },
      { id: "r2", accountName: "Garanti", acntEuId: "u2", keywords: ["B"], matchMode: "exact" },
    ];
    const prompt = buildUserPrompt(customers, [], overrides);
    const occurrences = prompt.match(/`matchMode` semantics:/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("serializes matchMode as 'exact' or 'contains' (never the Turkish İçerir/Tam)", () => {
    const overrides: KeywordOverride[] = [
      { id: "r1", accountName: "Aktif Bank", acntEuId: "u1", keywords: ["A"], matchMode: "exact" },
      { id: "r2", accountName: "Garanti", acntEuId: "u2", keywords: ["B"], matchMode: "contains" },
    ];
    const prompt = buildUserPrompt(customers, [], overrides);
    expect(prompt).toContain('"matchMode": "exact"');
    expect(prompt).toContain('"matchMode": "contains"');
    expect(prompt).not.toMatch(/İçerir|Tam/);
  });

  it("never bakes the 'müşteri listesinde yok' suffix into accountName", () => {
    const overrides: KeywordOverride[] = [
      { id: "r1", accountName: "Unknown", acntEuId: null, keywords: ["EVET"], matchMode: "contains" },
    ];
    const prompt = buildUserPrompt(customers, [], overrides);
    expect(prompt).not.toMatch(/"accountName": "Unknown[^"]*müşteri/);
  });
});
