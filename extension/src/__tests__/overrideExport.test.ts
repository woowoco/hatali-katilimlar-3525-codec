import { describe, it, expect } from "vitest";
import {
  exportOverridesToJson,
  importOverridesFromJson,
  generateId,
  formatImportSummary,
  OVERRIDE_FILE_FORMAT,
  OVERRIDE_FILE_VERSION,
} from "../lib/overrideExport.js";
import type { KeywordOverride, OverrideFileEnvelope } from "../types.js";

function mkRule(over: Partial<KeywordOverride> = {}): KeywordOverride {
  return {
    id: over.id ?? generateId(0),
    accountName: over.accountName ?? "Aktif Bank",
    acntEuId: over.acntEuId ?? "u1",
    keywords: over.keywords ?? ["EVET"],
    matchMode: over.matchMode ?? "contains",
    notes: over.notes,
  };
}

describe("exportOverridesToJson", () => {
  it("produces an envelope with format/version/exportedAt/rules", () => {
    const env = exportOverridesToJson([mkRule()], () => new Date("2026-09-30T14:22:11.000Z"));
    expect(env.format).toBe(OVERRIDE_FILE_FORMAT);
    expect(env.version).toBe(OVERRIDE_FILE_VERSION);
    expect(env.exportedAt).toBe("2026-09-30T14:22:11.000Z");
    expect(env.rules).toHaveLength(1);
  });

  it("sorts by accountName (case-insensitive) then id", () => {
    const a = mkRule({ id: "a1", accountName: "Ziraat" });
    const b = mkRule({ id: "b1", accountName: "aktif bank" });
    const c = mkRule({ id: "c1", accountName: "Garanti" });
    const env = exportOverridesToJson([a, b, c]);
    expect(env.rules.map((r) => r.accountName)).toEqual(["aktif bank", "Garanti", "Ziraat"]);
  });

  it("round-trips: export → import yields identical list", () => {
    const rules = [
      mkRule({ id: "r1", accountName: "Aktif", keywords: ["EVET", "kargo"] }),
      mkRule({ id: "r2", accountName: "PTT", acntEuId: null, keywords: ["ptt"], matchMode: "exact" }),
    ];
    const env = exportOverridesToJson(rules);
    const text = JSON.stringify(env);
    const summary = importOverridesFromJson(text, []);
    expect(summary.rejected).toBeUndefined();
    expect(summary.added).toBe(2);
    expect(summary.updated).toBe(0);
    expect(summary.next).toHaveLength(2);
    const sortedImported = [...summary.next].sort((a, b) => a.id.localeCompare(b.id));
    const sortedOriginal = [...rules].sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < sortedImported.length; i++) {
      expect(sortedImported[i]).toEqual(sortedOriginal[i]);
    }
  });
});

describe("importOverridesFromJson — format gate", () => {
  it("rejects when format string is wrong", () => {
    const text = JSON.stringify({ format: "wrong", version: 2, rules: [] });
    const out = importOverridesFromJson(text, []);
    expect(out.rejected).toMatch(/Yanlış dosya formatı/);
    expect(out.next).toEqual([]);
  });

  it("rejects on JSON parse error", () => {
    const out = importOverridesFromJson("not json", []);
    expect(out.rejected).toMatch(/JSON parse hatası/);
    expect(out.next).toEqual([]);
  });

  it("rejects when rules is not an array", () => {
    const text = JSON.stringify({ format: OVERRIDE_FILE_FORMAT, version: 2, rules: "nope" });
    const out = importOverridesFromJson(text, []);
    expect(out.rejected).toMatch(/rules.*array/);
  });

  it("accepts legacy bare array (no envelope)", () => {
    const text = JSON.stringify([
      { id: "x", accountName: "Aktif", acntEuId: "u1", keywords: ["EVET"] },
    ]);
    const out = importOverridesFromJson(text, []);
    expect(out.rejected).toBeUndefined();
    expect(out.added).toBe(1);
    expect(out.next[0].accountName).toBe("Aktif");
  });
});

describe("importOverridesFromJson — per-rule validation", () => {
  it("drops rows with missing accountName and counts them", () => {
    const text = JSON.stringify({
      format: OVERRIDE_FILE_FORMAT,
      version: 2,
      rules: [
        { id: "ok", accountName: "Aktif", acntEuId: "u1", keywords: ["EVET"] },
        { id: "bad", accountName: "  ", acntEuId: null, keywords: ["X"] },
      ],
    });
    const out = importOverridesFromJson(text, []);
    expect(out.added).toBe(1);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].reason).toMatch(/accountName/);
  });

  it("drops rows with empty keywords array", () => {
    const text = JSON.stringify({
      format: OVERRIDE_FILE_FORMAT,
      version: 2,
      rules: [{ id: "bad", accountName: "X", acntEuId: null, keywords: [] }],
    });
    const out = importOverridesFromJson(text, []);
    expect(out.skipped[0].reason).toMatch(/keyword/);
  });

  it("strips blank keywords inside the array", () => {
    const text = JSON.stringify({
      format: OVERRIDE_FILE_FORMAT,
      version: 2,
      rules: [{ id: "ok", accountName: "X", acntEuId: null, keywords: ["EVET", "  ", "iptal"] }],
    });
    const out = importOverridesFromJson(text, []);
    expect(out.next[0].keywords).toEqual(["EVET", "iptal"]);
  });

  it("defaults matchMode to contains when omitted", () => {
    const text = JSON.stringify({
      format: OVERRIDE_FILE_FORMAT,
      version: 2,
      rules: [{ id: "ok", accountName: "X", acntEuId: null, keywords: ["E"] }],
    });
    const out = importOverridesFromJson(text, []);
    expect(out.next[0].matchMode).toBe("contains");
  });

  it("rejects unknown matchMode string", () => {
    const text = JSON.stringify({
      format: OVERRIDE_FILE_FORMAT,
      version: 2,
      rules: [{ id: "x", accountName: "X", acntEuId: null, keywords: ["E"], matchMode: "regex" }],
    });
    const out = importOverridesFromJson(text, []);
    expect(out.skipped[0].reason).toMatch(/matchMode/);
  });

  it("coerces whitespace-only acntEuId to null", () => {
    const text = JSON.stringify({
      format: OVERRIDE_FILE_FORMAT,
      version: 2,
      rules: [{ id: "x", accountName: "X", acntEuId: "   ", keywords: ["E"] }],
    });
    const out = importOverridesFromJson(text, []);
    expect(out.next[0].acntEuId).toBeNull();
  });
});

describe("importOverridesFromJson — merge strategy", () => {
  it("replaces existing rule with same id (newer wins)", () => {
    const local = [mkRule({ id: "r1", accountName: "Old Name", keywords: ["X"] })];
    const text = JSON.stringify({
      format: OVERRIDE_FILE_FORMAT,
      version: 2,
      rules: [{ id: "r1", accountName: "New Name", acntEuId: null, keywords: ["Y"] }],
    });
    const out = importOverridesFromJson(text, local);
    expect(out.updated).toBe(1);
    expect(out.added).toBe(0);
    expect(out.next).toHaveLength(1);
    expect(out.next[0].accountName).toBe("New Name");
  });

  it("regenerates id when missing in imported row", () => {
    const text = JSON.stringify({
      format: OVERRIDE_FILE_FORMAT,
      version: 2,
      rules: [{ accountName: "Brand New", acntEuId: null, keywords: ["X"] }],
    });
    const out = importOverridesFromJson(text, []);
    expect(out.added).toBe(1);
    expect(out.next[0].id).toMatch(/^ov-\d+/);
  });

  it("replaces when imported id collides with an existing rule (newer wins)", () => {
    const local = [mkRule({ id: "dup", accountName: "Local" })];
    const text = JSON.stringify({
      format: OVERRIDE_FILE_FORMAT,
      version: 2,
      rules: [{ id: "dup", accountName: "Imported", acntEuId: null, keywords: ["Y"] }],
    });
    const out = importOverridesFromJson(text, local);
    // Same id → replace. The operator's edited file is authoritative.
    expect(out.added).toBe(0);
    expect(out.updated).toBe(1);
    expect(out.next).toHaveLength(1);
    expect(out.next[0].accountName).toBe("Imported");
  });

  it("preserves existing rules that have no imported counterpart", () => {
    const local = [
      mkRule({ id: "keep", accountName: "Keep me" }),
      mkRule({ id: "drop", accountName: "Don't touch" }),
    ];
    const text = JSON.stringify({
      format: OVERRIDE_FILE_FORMAT,
      version: 2,
      rules: [{ id: "new", accountName: "Added", acntEuId: null, keywords: ["X"] }],
    });
    const out = importOverridesFromJson(text, local);
    expect(out.next).toHaveLength(3);
    expect(out.next.map((r) => r.accountName).sort()).toEqual(["Added", "Don't touch", "Keep me"]);
  });
});

describe("formatImportSummary", () => {
  it("reports added + updated + skipped", () => {
    const text = JSON.stringify({
      format: OVERRIDE_FILE_FORMAT,
      version: 2,
      rules: [
        { id: "ok", accountName: "A", acntEuId: null, keywords: ["X"] },
        { accountName: "B", acntEuId: null, keywords: ["Y"] }, // no id → regenerated → added
      ],
    });
    const out = importOverridesFromJson(text, []);
    expect(formatImportSummary(out)).toMatch(/2 eklendi/);
  });

  it("shows the rejection reason", () => {
    const out = importOverridesFromJson("nope", []);
    expect(formatImportSummary(out)).toMatch(/JSON parse hatası/);
  });

  it("returns 'dosyada yeni kural yok' when nothing changed", () => {
    const text = JSON.stringify({ format: OVERRIDE_FILE_FORMAT, version: 2, rules: [] });
    const out = importOverridesFromJson(text, []);
    expect(formatImportSummary(out)).toMatch(/yeni kural yok/);
  });
});

describe("envelope shape integration", () => {
  it("can build an envelope by hand and re-import it", () => {
    const env: OverrideFileEnvelope = {
      format: OVERRIDE_FILE_FORMAT,
      version: 2,
      exportedAt: "2026-09-30T10:00:00.000Z",
      rules: [mkRule({ id: "abc", accountName: "Aktif Bank", keywords: ["EVET"] })],
    };
    const text = JSON.stringify(env);
    const out = importOverridesFromJson(text, []);
    expect(out.next).toHaveLength(1);
    expect(out.next[0].id).toBe("abc");
    expect(out.next[0].accountName).toBe("Aktif Bank");
  });
});
