import { describe, expect, it } from "vitest";
import { parseOverrideBulk, previewOverrideBulk } from "../lib/overrideParser.js";
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

    // Row 3: 3-column row → son hücre yeni semantikte Not olur;
    // operatör 2 keyword istiyorsa Not sütununu da eklemeli.
    expect(r.ok[2].accountName).toBe("PTT");
    expect(r.ok[2].keywords).toEqual(["ptt"]);
    expect(r.ok[2].notes).toBe("postahane");
  });

  it("3-sütunlu satırda başlık yoksa tüm hücreler keyword olur", () => {
    // Yeni semantik: Not/Mod sütunları **header'a göre** tespit edilir.
    // Header yoksa tüm veri hücreleri keyword'tür — operatörün 2
    // keyword'ü yanlışlıkla "notes" yapılmaz. Eskiden heuristic bunu
    // "EVET uzun mu? → notes" şeklinde tahmin ediyordu; bu kaldırıldı
    // çünkü "izin yok" gibi kısa space'li ifadeleri yanlış sınıflıyordu.
    const r = parseOverrideBulk(
      "Aktif Bank\tPTT\tEVET",
      CUSTOMERS,
    );
    expect(r.ok[0].accountName).toBe("Aktif Bank");
    expect(r.ok[0].keywords).toEqual(["PTT", "EVET"]);
    expect(r.ok[0].notes).toBe("");
  });

  it("3-sütunlu satırda son hücre başlık 'Not' ise Not olarak ayrılır", () => {
    // Header "Firma\tKeyword1\tNot" → son kolon `Not` sütunudur.
    // Operatör tek keyword girdiğinde sondaki hücreyi Not olarak
    // parse etmeliyiz. Burada boş Not ile dolu Not'u ayırt edebilmek
    // için header-driven logic test ediliyor.
    const r = parseOverrideBulk(
      "Firma\tKeyword\tNot\nAktif Bank\tPTT\tKargo onayı",
      CUSTOMERS,
    );
    expect(r.ok).toHaveLength(1);
    expect(r.ok[0].accountName).toBe("Aktif Bank");
    expect(r.ok[0].keywords).toEqual(["PTT"]);
    expect(r.ok[0].notes).toBe("Kargo onayı");
  });

  it("splits comma-separated keywords inside a single cell", () => {
    const r = parseOverrideBulk(
      "Firma\tKeywords\tNot\nAktif Bank\taktif, aktifbank, akbank\t",
      CUSTOMERS,
    );
    // Not sütunu boş → notes = ""; keyword'ler virgülle ayrılarak parse.
    expect(r.ok[0].keywords).toEqual(["aktif", "aktifbank", "akbank"]);
    expect(r.ok[0].notes).toBe("");
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
    // Yeni semantik: sonda Not sütunu var. Tek keyword + Not için
    // operatör açıkça 3. kolonu (boş olsa bile) eklemeli — yoksa
    // "aktif" notes olarak ayrılır ve kural boş keyword yüzünden
    // atlanır. Burada explicit boş Not veriyoruz.
    const r = parseOverrideBulk(
      'Müşteri,Keyword,Not\n"Aktif ""Bank""",aktif,',
      CUSTOMERS,
    );
    // Header "Müşteri,Keyword,Not" matches firma+keyword+note → dropped.
    expect(r.ok).toHaveLength(1);
    expect(r.ok[0].accountName).toBe('Aktif "Bank"');
    expect(r.ok[0].keywords).toEqual(["aktif"]);
    expect(r.ok[0].notes).toBe("");
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

// --- previewOverrideBulk: Excel-style preview -----------------------------

describe("previewOverrideBulk — Excel-style preview table", () => {
  it("boş metin için boş sonuç döner", () => {
    const r = previewOverrideBulk("", CUSTOMERS);
    expect(r.rows).toEqual([]);
    expect(r.okCount).toBe(0);
    expect(r.warnCount).toBe(0);
    expect(r.errorCount).toBe(0);
  });

  it("TSV: başlık satırını kind='header' olarak döndürür", () => {
    const r = previewOverrideBulk(
      "Firma\tKeyword1\tKeyword2\tKeyword3\tNot\tMod\n" +
        "Aktif Bank\tPTT\tEVET\t\tKargo\tiçerir",
      CUSTOMERS,
    );
    expect(r.format).toBe("tsv");
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].kind).toBe("header");
    expect(r.rows[0].accountName).toBe("Firma");
    expect(r.rows[0].keywordCells).toEqual(["Keyword1", "Keyword2", "Keyword3", "Not", "Mod"]);
  });

  it("TSV: kullanıcının Excel verisini (Firma|Keyword1|Keyword2|Keyword3|Not|Mod) tam olarak parse eder", () => {
    // User's example: row with one keyword cell, then empty cells, then notes, then mode.
    // We use firm names that are clearly NOT in the customer fixture
    // (CUSTOMERS contains only "Aktif Bank" and "PTT") so that the
    // case-insensitive trim normalizer doesn't accidentally match.
    const tsv = [
      "Firma\tKeyword1\tKeyword2\tKeyword3\tNot\tMod",
      "AKTIFBANK\tEVET\tptt\tkredi\tCustomer listesindeki AKTIFBANK keywordune işlenmeli.\tiçerir",
      "AKTIFBANK\tHayır\tA fik bank\tizin yok\tCustomer listesindeki AKTIFBANK keywordune işlenmeli.\tiçerir",
      "UPT Bankacılık OTP\t0893028299000011\t\t\tCustomer listesindeki UPT keywordune işlenmeli.\tiçerir",
      "FLO\tFLİ\tflört\tfIo\tCustomer listesindeki FLO keywordune işlenmeli.\tiçerir",
    ].join("\n");
    const r = previewOverrideBulk(tsv, CUSTOMERS);
    expect(r.format).toBe("tsv");
    expect(r.rows).toHaveLength(5);
    expect(r.rows[0].kind).toBe("header");

    // Row 2: 3 keywords + notes + matchMode
    const r2 = r.rows[1];
    expect(r2.accountName).toBe("AKTIFBANK");
    expect(r2.keywordCells).toEqual(["EVET", "ptt", "kredi"]);
    expect(r2.notes).toMatch(/Customer listesindeki AKTIFBANK/);
    expect(r2.matchMode).toBe("contains");
    // AKTIFBANK is NOT in customer list → warning
    expect(r2.status).toBe("firm-unknown");
    expect(r2.resolvedAcntEuId).toBeNull();

    // Row 4: UPT Bankacılık OTP — only 1 keyword, empty Keyword2/3, then notes, then mode.
    // Boş Keyword2/3 hücreleri `keywordCells`'te korunur — preview'da
    // görsel placeholder (`—`) ile gösterilecek. Bu, Excel'den yapıştırılan
    // tabloda boş kolonların diğer kolon değerlerini kaydırmasını engeller.
    const r4 = r.rows[3];
    expect(r4.accountName).toBe("UPT Bankacılık OTP");
    expect(r4.keywordCells).toEqual(["0893028299000011", "", ""]);
    expect(r4.notes).toMatch(/UPT keywordune/);
    expect(r4.matchMode).toBe("contains");
    expect(r4.status).toBe("firm-unknown");

    // Counts: 1 header + 4 rules. 0 ok (no firm matches customer list
    // exactly), 4 firm-unknown, 0 errors.
    expect(r.okCount).toBe(0);
    expect(r.warnCount).toBe(4);
    expect(r.errorCount).toBe(0);
  });

  it("TSV: orta kolonlar boşken diğer kolon değerleri KAYMASIN — Excel'den direkt yapıştırılan veri", () => {
    // Kullanıcının ekran görüntüsündeki (Excel→extension) durum:
    //   AKTIFBANK | EVET | ptt | kredi | Customer... | İçerir
    //   AKTIFBANK | Hayır | A fık bank | izin yok | Customer... | İçerir
    //   UPT | 0893028299000011 | [BOŞ] | [BOŞ] | Customer... | İçerir
    //   FLO | FLi | flört | flo | Customer... | İçerir
    // UPT satırı kritik: Keyword2 ve Keyword3 BOŞ. Eski kodda flat-map
    // ile boş hücre düşüyor, "Customer..." Keyword2'ye kayıyordu. Yeni
    // davranışta `keywordCells` ham kwCells olarak korunuyor — boş
    // hücreler yerinde kalır, sütun kayması olmaz.
    const tsv =
      "Firma\tKeyword1\tKeyword2\tKeyword3\tNot\tMod\n" +
      "AKTIFBANK\tEVET\tptt\tkredi\tCustomer listesindeki AKTIFBANK\tİçerir\n" +
      "AKTIFBANK\tHayır\tA fık bank\tizin yok\tCustomer listesindeki AKTIFBANK\tİçerir\n" +
      "UPT\t0893028299000011\t\t\tCustomer listesindeki UPT\tİçerir\n" +
      "FLO\tFLi\tflört\tflo\tCustomer listesindeki FLO\tİçerir";
    const r = previewOverrideBulk(tsv, CUSTOMERS);

    // Satır 1: AKTIFBANK (Keyword2/3 dolu)
    expect(r.rows[1].accountName).toBe("AKTIFBANK");
    expect(r.rows[1].keywordCells).toEqual(["EVET", "ptt", "kredi"]);
    expect(r.rows[1].notes).toMatch(/AKTIFBANK/);

    // Satır 2: AKTIFBANK (farklı keyword'lerle)
    expect(r.rows[2].accountName).toBe("AKTIFBANK");
    expect(r.rows[2].keywordCells).toEqual(["Hayır", "A fık bank", "izin yok"]);

    // Satır 3: UPT — KRİTİK: Keyword2 ve Keyword3 boş, "Customer..."
    // Keyword2'ye KAYMAMALI. notes ise doğru parse edilmeli.
    expect(r.rows[3].accountName).toBe("UPT");
    expect(r.rows[3].keywordCells).toEqual(["0893028299000011", "", ""]);
    expect(r.rows[3].notes).toBe("Customer listesindeki UPT");
    expect(r.rows[3].matchMode).toBe("contains");

    // Satır 4: FLO (Keyword3 dolu)
    expect(r.rows[4].accountName).toBe("FLO");
    expect(r.rows[4].keywordCells).toEqual(["FLi", "flört", "flo"]);

    // Toplam sayım: 4 satır, hepsi firm-unknown (AKTIFBANK/UPT/FLO müşteri listesinde yok).
    expect(r.warnCount).toBe(4);
    expect(r.errorCount).toBe(0);
  });

  it("TSV: customer listesinde tam eşleşen firma varsa ok sayılır", () => {
    const r = previewOverrideBulk(
      "Firma\tKeyword1\tKeyword2\n" +
        "Aktif Bank\tEVET\tptt\n" +
        "BilinmeyenFirma\theyir",
      CUSTOMERS,
    );
    // First row matches "Aktif Bank" exactly (case-insensitive) → ok
    // Second row uses "BilinmeyenFirma" → doesn't match → firm-unknown
    expect(r.okCount).toBe(1);
    expect(r.warnCount).toBe(1);
    expect(r.rows[1].resolvedAcntEuId).toBe(CUSTOMERS[0].acntEuId);
    expect(r.rows[2].resolvedAcntEuId).toBeNull();
  });

  it("pipe format: firm listede yoksa firm-unknown uyarısı", () => {
    const r = previewOverrideBulk(
      "BilinmeyenFirma | EVET, ptt | notlar",
      CUSTOMERS,
    );
    expect(r.format).toBe("pipe");
    expect(r.rows[0].accountName).toBe("BilinmeyenFirma");
    expect(r.rows[0].status).toBe("firm-unknown");
    expect(r.rows[0].statusMessage).toMatch(/müşteri listesinde yok/);
  });

  it("boş firma adı → no-firm hatası", () => {
    const r = previewOverrideBulk(
      "Firma\tKeyword1\n\tEVET",
      CUSTOMERS,
    );
    expect(r.rows).toHaveLength(2);
    const rule = r.rows[1];
    expect(rule.status).toBe("no-firm");
    expect(rule.statusMessage).toMatch(/Firma adı boş/i);
  });

  it("keyword'süz satır → no-keywords hatası", () => {
    // Aktif Bank | (boş) | (not yeterince uzun olmadığı için not
    // olarak da ayrılmıyor) — sonuçta keywords=[], accountName var.
    const r = previewOverrideBulk(
      "Firma\tKeyword1\nAktif Bank\t",
      CUSTOMERS,
    );
    const rule = r.rows[1];
    expect(rule.status).toBe("no-keywords");
    expect(rule.statusMessage).toMatch(/en az bir keyword/i);
  });

  it("comment satırları (# ile başlayan) atlanır", () => {
    const r = previewOverrideBulk(
      "# Bu bir yorum\nAktif Bank | aktif | not",
      CUSTOMERS,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].accountName).toBe("Aktif Bank");
  });

  it("sourceLine: gerçek dosya satır numarası (1-based) döner", () => {
    const r = previewOverrideBulk(
      "# yorum\n\nAktif Bank | aktif",
      CUSTOMERS,
    );
    expect(r.rows[0].sourceLine).toBe(3);
  });

  it("matchMode 'tam' → exact; 'içerir' → contains; bilinmiyor → ''", () => {
    const r = previewOverrideBulk(
      [
        "Aktif Bank | kw1 | not1 | tam",
        "Aktif Bank | kw2 | not2 | içerir",
        "Aktif Bank | kw3 | not3 | bilinmiyor",
      ].join("\n"),
      CUSTOMERS,
    );
    expect(r.rows[0].matchMode).toBe("exact");
    expect(r.rows[1].matchMode).toBe("contains");
    expect(r.rows[2].matchMode).toBe("");
  });

  it("ok + uyarı + hata satırları karışık: counts doğru", () => {
    // Aktif Bank → CUSTOMERS[0] ile tam eşleşir (case-insensitive trim).
    // "Aktif bank" (boşluksuz) ile "Aktif Bank" eşleşmiyor — bu kasıtlı:
    // gerçek hayatta operatör bazen "AKTIFBANK" yazıp listede
    // "AKTIF-BANK ---- Aktif Bank" görünce "listede yok" uyarısı alıyor.
    // Testlerde bu farkı net tutmak için tamamen farklı bir isim kullanıyoruz.
    const r = previewOverrideBulk(
      [
        "Firma\tKeyword1",
        "Aktif Bank\tEVET",          // ok (matched)
        "BilinmeyenFirma\theyir",    // firm-unknown
        "\tkeywordless",             // no-firm (boş firma)
        "PTT\t",                     // no-keywords
      ].join("\n"),
      CUSTOMERS,
    );
    expect(r.okCount).toBe(1);
    expect(r.warnCount).toBe(1);
    expect(r.errorCount).toBe(2);
  });
});