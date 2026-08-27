import { describe, expect, it } from "vitest";
import { parseOverrideBulk } from "../lib/overrideParser.js";
import type { Customer } from "../types.js";

const CUSTOMERS: Customer[] = [
  { name: "Aktif Bank", acntEuId: "11111111-1111-1111-1111-111111111111" },
  { name: "PTT", acntEuId: "22222222-2222-2222-2222-222222222222" },
];

describe("parseOverrideBulk — pipe format", () => {
  it("parses firm | keywords | notes", () => {
    const r = parseOverrideBulk(
      "Aktif Bank | aktif, aktifbank | Kargo/EFT\nPTT | ptt | Kargo bildirimleri",
      CUSTOMERS,
    );
    expect(r.format).toBe("pipe");
    expect(r.errors).toEqual([]);
    expect(r.ok).toHaveLength(2);
    expect(r.ok[0].accountName).toBe("Aktif Bank");
    expect(r.ok[0].keywords).toEqual(["aktif", "aktifbank"]);
    expect(r.ok[0].notes).toBe("Kargo/EFT");
    expect(r.ok[0].acntEuId).toBe(CUSTOMERS[0].acntEuId);
    expect(r.ok[1].accountName).toBe("PTT");
  });

  it("allows notes-less pipe rows", () => {
    const r = parseOverrideBulk("Aktif Bank | aktif", CUSTOMERS);
    expect(r.ok).toHaveLength(1);
    expect(r.ok[0].notes).toBe("");
  });

  it("flags rows without | as errors", () => {
    const r = parseOverrideBulk("plain text without pipe", CUSTOMERS);
    expect(r.ok).toEqual([]);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("parseOverrideBulk — TSV (Excel default)", () => {
  it("parses tab-separated multi-column with header", () => {
    const r = parseOverrideBulk(
      [
        "Firma\tKeyword1\tKeyword2\tNot",
        "Aktif Bank\tPTT\tEVET\tKargo bildirimleri",
        "Aktif Bank\taktifbank\tHAYIR\tKredi geri ödemesi",
        "PTT\tptt\tpostahane",
      ].join("\n"),
      CUSTOMERS,
    );
    expect(r.format).toBe("tsv");
    expect(r.errors).toEqual([]);
    expect(r.ok).toHaveLength(3);

    // Row 1: header dropped, "Aktif Bank" with keywords PTT, EVET, notes "Kargo bildirimleri"
    expect(r.ok[0].accountName).toBe("Aktif Bank");
    expect(r.ok[0].keywords).toEqual(["PTT", "EVET"]);
    expect(r.ok[0].notes).toBe("Kargo bildirimleri");
    expect(r.ok[0].acntEuId).toBe(CUSTOMERS[0].acntEuId);

    // Row 2: same firm, different keywords
    expect(r.ok[1].accountName).toBe("Aktif Bank");
    expect(r.ok[1].keywords).toEqual(["aktifbank", "HAYIR"]);
    expect(r.ok[1].notes).toBe("Kredi geri ödemesi");

    // Row 3: 3-column row → 2 keyword cols, no notes
    expect(r.ok[2].accountName).toBe("PTT");
    expect(r.ok[2].keywords).toEqual(["ptt", "postahane"]);
    expect(r.ok[2].notes).toBe("");
  });

  it("treats last cell as notes only if it looks like notes", () => {
    const r = parseOverrideBulk(
      "Aktif Bank\tPTT\tEVET",
      CUSTOMERS,
    );
    // 3 cells total → 1 keyword col + 1 short last col; neither contains
    // space nor is long → both treated as keywords.
    expect(r.ok[0].keywords).toEqual(["PTT", "EVET"]);
    expect(r.ok[0].notes).toBe("");
  });

  it("splits comma-separated keywords inside a single cell", () => {
    const r = parseOverrideBulk(
      "Firma\tKeywords\nAktif Bank\taktif, aktifbank, akbank",
      CUSTOMERS,
    );
    expect(r.ok[0].keywords).toEqual(["aktif", "aktifbank", "akbank"]);
  });
});

describe("parseOverrideBulk — CSV", () => {
  it("parses comma-separated multi-column with header", () => {
    const r = parseOverrideBulk(
      [
        "Firma,Keyword1,Keyword2,Not",
        '"Aktif Bank, Inc.",PTT,EVET,"Kargo, acil"',
        "PTT,ptt,postahane,Kargo",
      ].join("\n"),
      CUSTOMERS,
    );
    expect(r.format).toBe("csv");
    expect(r.errors).toEqual([]);
    expect(r.ok).toHaveLength(2);
    expect(r.ok[0].accountName).toBe("Aktif Bank, Inc.");
    expect(r.ok[0].keywords).toEqual(["PTT", "EVET"]);
    expect(r.ok[0].notes).toBe("Kargo, acil");
  });

  it("preserves quoted commas and escaped double-quotes", () => {
    const r = parseOverrideBulk(
      'Müşteri,Keyword\n"Aktif ""Bank""",aktif',
      CUSTOMERS,
    );
    // Header "Müşteri,Keyword" matches firma+keyword → dropped.
    expect(r.ok).toHaveLength(1);
    expect(r.ok[0].accountName).toBe('Aktif "Bank"');
    expect(r.ok[0].keywords).toEqual(["aktif"]);
  });
});

describe("parseOverrideBulk — header skipping", () => {
  it("drops Turkish header keywords", () => {
    const r = parseOverrideBulk(
      "Firma\tAnahtar\tAçıklama\nAktif Bank\taktif\tKargo",
      CUSTOMERS,
    );
    expect(r.ok).toHaveLength(1);
    expect(r.ok[0].accountName).toBe("Aktif Bank");
  });

  it("drops English header keywords", () => {
    const r = parseOverrideBulk(
      "Customer,Keyword,Note\nAktif Bank,aktif,Kargo",
      CUSTOMERS,
    );
    expect(r.ok).toHaveLength(1);
    expect(r.ok[0].accountName).toBe("Aktif Bank");
  });

  it("drops header with firm + 3 columns (firm + keyword + note)", () => {
    const r = parseOverrideBulk(
      "Müşteri,Keyword,Not\nAktif Bank,aktif,kargo",
      CUSTOMERS,
    );
    expect(r.ok).toHaveLength(1);
    expect(r.ok[0].accountName).toBe("Aktif Bank");
  });

  it("does not drop a data row that only matches the firm token", () => {
    // First line "Aktif Bank firma" only matches the firm token (no
    // keyword/note token) → kept as data, no header skip. Both rows
    // reported as pipe-format errors because they lack `|`, but we
    // still import the second row (Aktif Bank | aktif has a | later).
    const r = parseOverrideBulk(
      "Aktif Bank firma\nAktif Bank | aktif",
      CUSTOMERS,
    );
    // First row → error (no pipe). Second row → 1 OK rule.
    expect(r.ok).toHaveLength(1);
    expect(r.ok[0].accountName).toBe("Aktif Bank");
    expect(r.ok[0].keywords).toEqual(["aktif"]);
    expect(r.errors.length).toBe(1);
  });
});

describe("parseOverrideBulk — validation", () => {
  it("errors on empty firm name", () => {
    const r = parseOverrideBulk(",keyword", CUSTOMERS);
    expect(r.ok).toEqual([]);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("errors on empty keywords", () => {
    const r = parseOverrideBulk("Aktif Bank,", CUSTOMERS);
    expect(r.errors.some((e) => e.includes("keyword gerekli"))).toBe(true);
  });

  it("resolves acntEuId from customer list (case-insensitive)", () => {
    const r = parseOverrideBulk("aktif BANK | aktif", CUSTOMERS);
    expect(r.ok[0].acntEuId).toBe(CUSTOMERS[0].acntEuId);
  });

  it("leaves acntEuId null when firm isn't in the customer list", () => {
    const r = parseOverrideBulk("Bilinmeyen | kw", CUSTOMERS);
    expect(r.ok[0].acntEuId).toBeNull();
  });
});

describe("parseOverrideBulk — empty / blank", () => {
  it("returns zero rules for empty input", () => {
    const r = parseOverrideBulk("", CUSTOMERS);
    expect(r.ok).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it("ignores blank lines and #-prefixed comments", () => {
    const r = parseOverrideBulk(
      "\n# yorum\n\nAktif Bank | aktif\n# başka yorum\n",
      CUSTOMERS,
    );
    expect(r.ok).toHaveLength(1);
  });
});

describe("parseOverrideBulk — auto-detect", () => {
  it("picks pipe when neither tabs nor commas are present", () => {
    const r = parseOverrideBulk("Aktif Bank | aktif", CUSTOMERS);
    expect(r.format).toBe("pipe");
  });

  it("picks tsv when tabs dominate", () => {
    const r = parseOverrideBulk("A\tB\tC\nD\tE\tF", CUSTOMERS);
    expect(r.format).toBe("tsv");
  });

  it("picks csv when commas dominate", () => {
    const r = parseOverrideBulk("A,B,C\nD,E,F", CUSTOMERS);
    expect(r.format).toBe("csv");
  });
});

describe("parseOverrideBulk — matchMode", () => {
  it("defaults to contains", () => {
    const r = parseOverrideBulk("Aktif Bank | aktif", CUSTOMERS);
    expect(r.ok[0].matchMode ?? "contains").toBe("contains");
  });

  it("parses pipe 4th part as exact when it says 'tam'", () => {
    const r = parseOverrideBulk(
      "Aktif Bank | EVET | Kredi onayı | tam",
      CUSTOMERS,
    );
    expect(r.ok[0].matchMode).toBe("exact");
    expect(r.ok[0].keywords).toEqual(["EVET"]);
    expect(r.ok[0].notes).toBe("Kredi onayı");
  });

  it("parses pipe 4th part as contains when it says 'içerir'", () => {
    const r = parseOverrideBulk(
      "Aktif Bank | aktif, aktifbank | | içerir",
      CUSTOMERS,
    );
    expect(r.ok[0].matchMode).toBe("contains");
    expect(r.ok[0].notes).toBe("");
  });

  it("falls back to appending to notes when 4th part isn't a mode token", () => {
    const r = parseOverrideBulk(
      "Aktif Bank | aktif | not1 | not2",
      CUSTOMERS,
    );
    expect(r.ok[0].matchMode).toBe("contains");
    expect(r.ok[0].notes).toBe("not1 | not2");
  });

  it("parses TSV last column as matchMode", () => {
    const r = parseOverrideBulk(
      "Müşteri\tKeyword\tMod\nAktif Bank\tEVET\ttam\nAktif Bank\taktifbank\ticerir",
      CUSTOMERS,
    );
    expect(r.ok).toHaveLength(2);
    expect(r.ok[0].matchMode).toBe("exact");
    expect(r.ok[0].keywords).toEqual(["EVET"]);
    expect(r.ok[1].matchMode).toBe("contains");
    expect(r.ok[1].keywords).toEqual(["aktifbank"]);
  });

  it("parses CSV last column as matchMode", () => {
    const r = parseOverrideBulk(
      "Müşteri,Keyword,Mod\nAktif Bank,EVET,exact",
      CUSTOMERS,
    );
    expect(r.ok[0].matchMode).toBe("exact");
  });

  it("accepts English tokens: exact / contains", () => {
    const r1 = parseOverrideBulk("Aktif Bank | EVET | | exact", CUSTOMERS);
    const r2 = parseOverrideBulk("Aktif Bank | aktif | | contains", CUSTOMERS);
    expect(r1.ok[0].matchMode).toBe("exact");
    expect(r2.ok[0].matchMode).toBe("contains");
  });
});