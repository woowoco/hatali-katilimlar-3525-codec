import type { Customer, KeywordOverride } from "../types.js";

/**
 * Result of bulk-parse. `format` is what the autodetect settled on so the
 * UI can show "12 kural eklendi (TSV)" as feedback.
 */
export interface ParseResult {
  ok: KeywordOverride[];
  errors: string[];
  format: "pipe" | "csv" | "tsv";
}

/**
 * Per-row preview data for the Excel-style preview table. The UI renders
 * each row verbatim (preserves user's column order — e.g. "Keyword3" stays
 * in column 3) so the operator can verify what got parsed before clicking
 * Ekle.
 *
 * `status` summary:
 *   - "ok": firm found in customer list AND has ≥1 keyword → will import
 *   - "firm-unknown": rule will import, BUT firm name isn't in customer list
 *     → model will get the rule, AI may suggest that name, but the
 *     charge handler will throw "accountEuId boş" when operator tries to POST.
 *     (Operator must change accountName to a real customer, OR add a customer.)
 *   - "no-firm": row skipped — accountName empty
 *   - "no-keywords": row skipped — no keyword cells
 *
 * `kind === "header"` rows are the detected header (display-only, skipped).
 */
export type PreviewStatus =
  | "ok"
  | "firm-unknown"
  | "no-firm"
  | "no-keywords"
  | "error";

export interface PreviewRow {
  /** 0-based index in the original raw text — used for error reporting. */
  sourceLine: number;
  kind: "header" | "rule";
  accountName: string;
  /** Raw cell values from columns 1..n-1 (Keyword1, Keyword2, ...). */
  keywordCells: string[];
  notes: string;
  matchMode: "contains" | "exact" | "";
  status: PreviewStatus;
  /** Human-readable reason for status (especially for errors). */
  statusMessage: string;
  /** Resolved acntEuId (null when firm-unknown or no-firm). */
  resolvedAcntEuId: string | null;
}

export interface PreviewResult {
  rows: PreviewRow[];
  format: "pipe" | "csv" | "tsv";
  okCount: number;
  warnCount: number;
  errorCount: number;
}

/**
 * Parse the operator's bulk paste. Supports three formats, picked
 * automatically by looking at the first few non-comment lines:
 *
 *   1. Pipe-separated ("Firma | kw1, kw2, kw3 | not")  — fallback
 *   2. TSV (Excel "Copy" output, tab-separated)        — preferred
 *   3. CSV (Excel "Save As CSV", comma-separated)
 *
 * In the multi-column formats, column 0 is the firm name. Columns 1..n-1
 * are keywords (each cell may itself contain comma-separated keywords).
 * The last column is treated as notes if it contains a space or is longer
 * than 14 characters (real keywords are short single words).
 *
 * If the first non-comment row looks like a header
 * (matches firma/keyword/not/anahtar/açıklama) it's silently dropped.
 *
 * Lines starting with `#` and blank lines are ignored.
 */
export function parseOverrideBulk(
  rawText: string,
  customers: readonly Customer[],
): ParseResult {
  const errors: string[] = [];
  const parsed: KeywordOverride[] = [];
  const norm = (s: string) => s.trim().toLowerCase();

  // Excel/TSV'den gelen "İçerir" → String.prototype.toLowerCase
  // Türkçe locale olmadan "i" + combining-dot-above üretir, listedeki
  // düz "içerir" ile eşleşmez. NFKD strip fallback ile yakala.
  const detectMatchMode = (raw: string): "contains" | "exact" | null => {
    const n = norm(raw);
    const stripped = n.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");
    const match = (s: string) => s === n || s === stripped;
    if (
      match("tam") ||
      match("tam eşleşme") ||
      match("exact") ||
      match("==") ||
      match("birebir")
    ) {
      return "exact";
    }
    if (
      match("içerir") ||
      match("icerir") ||
      match("contains") ||
      match("substring")
    ) {
      return "contains";
    }
    return null;
  };

  const rawLines = rawText.split(/\r?\n/);
  const dataLines = rawLines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  // Try the pipe parser first — if every data line has at least one "|"
  // and the first pipe is followed by something, treat it as pipe format.
  // Otherwise fall back to tab/comma detection.
  const detect = (): "tsv" | "csv" | "pipe" => {
    const allHavePipe = dataLines.every((l) => l.includes("|"));
    if (allHavePipe) return "pipe";
    const sample = dataLines.slice(0, 5).join("\n");
    const tabs = (sample.match(/\t/g) ?? []).length;
    const commas = (sample.match(/,/g) ?? []).length;
    if (tabs > 0 && tabs >= commas) return "tsv";
    if (commas > 0) return "csv";
    return "pipe";
  };

  const isHeaderLine = (cells: string[]): boolean => {
    // A real Excel/CSV header almost always combines a firm-column label
    // ("firma"/"müşteri"/"account") with a keyword-column label
    // ("keyword"/"anahtar") — or with a notes label. Match when at least
    // two of these token categories appear so a one-cell row like
    // ",keyword" doesn't trip the heuristic.
    const joined = cells.map(norm).join(" | ");
    const firmHits = ["firma", "müşteri", "customer", "account", "şirket"]
      .filter((t) => joined.includes(t));
    const kwHits = ["keyword", "anahtar", "tag", "etiket"]
      .filter((t) => joined.includes(t));
    const noteHits = ["not", "açıklama", "description", "note", "yorum"]
      .filter((t) => joined.includes(t));
    // Header if we see (firm + keyword) OR (firm + note) OR all three.
    return (
      (firmHits.length >= 1 && kwHits.length >= 1) ||
      (firmHits.length >= 1 && noteHits.length >= 1 && cells.length >= 3)
    );
  };

  const pushRule = (
    accountName: string,
    keywords: string[],
    notes: string,
    idx: number,
    matchMode: "contains" | "exact" = "contains",
  ) => {
    if (!accountName) {
      errors.push(`Satır ${idx + 1}: firma adı boş`);
      return;
    }
    if (keywords.length === 0) {
      errors.push(`Satır ${idx + 1}: en az bir keyword gerekli`);
      return;
    }
    const hit = customers.find((c) => norm(c.name) === norm(accountName));
    parsed.push({
      id: `ov-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
      accountName,
      acntEuId: hit?.acntEuId ?? null,
      keywords,
      notes,
      matchMode,
    });
  };

  if (dataLines.length === 0) {
    return { ok: parsed, errors, format: "pipe" };
  }

  const fmt = detect();

  if (fmt === "pipe") {
    rawLines.forEach((raw, i) => {
      // Leading-whitespace only trim — see comment above.
      const line = raw.replace(/^\s+/, "");
      if (!line || line.startsWith("#")) return;
      // Split on first 1-2 pipes: "Firma | kw1, kw2 | not | mode"
      const parts = line.split("|").map((p) => p.trim());
      if (parts.length < 2) {
        errors.push(`Satır ${i + 1}: "|" ayracı yok → "${line.slice(0, 60)}"`);
        return;
      }
      const [accountName, kwText, rawNotes, rawMode] = parts;
      const keywords = kwText
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      // Last "extra" pipe part is treated as matchMode if it parses to
      // one; otherwise it's appended to notes (so existing 3-part pipe
      // data still works).
      let notes = rawNotes ?? "";
      let matchMode: "contains" | "exact" = "contains";
      if (rawMode !== undefined) {
        const parsedMode = detectMatchMode(rawMode);
        if (parsedMode) {
          matchMode = parsedMode;
        } else {
          notes = [rawNotes, rawMode].filter(Boolean).join(" | ");
        }
      }
      pushRule(accountName, keywords, notes, i, matchMode);
    });
    return { ok: parsed, errors, format: "pipe" };
  }

  const sep = fmt === "tsv" ? "\t" : ",";

  const splitRow = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === sep) {
          out.push(cur);
          cur = "";
        } else cur += ch;
      }
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };

  // First pass: collect non-empty data lines. Drop the very first one if
  // it looks like a header. Capture the header so we can read which
  // columns are present (Not / Mod) — otherwise an operator who pastes
  // a 2-column sheet ("Firma | KW") without a Not column would have
  // their only keyword silently re-classified as "notes".
  let headerCells: string[] | null = null;
  for (const raw of rawLines) {
    // Trim only leading whitespace — keep trailing tabs/spaces because
    // they encode an empty trailing cell ("Firma\tKW\t" → 3 cells, the
    // last being ""). `String.prototype.trim()` would eat the trailing
    // tab and collapse the row to two cells, hiding the operator's
    // intent of declaring an empty Not column.
    const line = raw.replace(/^\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const firstCells = splitRow(line);
    if (isHeaderLine(firstCells)) {
      headerCells = firstCells;
    }
    break;
  }
  const columnHints = headerCells ? readColumnHints(headerCells) : { hasNot: false, hasMod: false };

  const filtered: { idx: number; line: string }[] = [];
  rawLines.forEach((raw, i) => {
    const line = raw.replace(/^\s+/, "");
    if (!line || line.startsWith("#")) return;
    filtered.push({ idx: i, line });
  });
  if (filtered.length > 0 && isHeaderLine(splitRow(filtered[0].line))) {
    filtered.shift();
  }

  filtered.forEach(({ idx, line }) => {
    const cells = splitRow(line);
    if (cells.length === 0) return;

    const accountName = cells[0];
    let kwCells = cells.slice(1);
    let notes = "";
    let matchMode: "contains" | "exact" = "contains";

    // Excel/TSV'nin 6-sütunlu şeması: Firma | KW1..N | Not | Mod.
    // Not ve Mod **opsiyonel**. Header'da ilgili kolon adı yoksa
    // sondan o kolonu çıkarmaya çalışma — operatörün tek keyword'ünü
    // yanlışlıkla "notes" veya "mode" yapma.
    //
    // Eğer header'da Mod varsa: önce sondan bir hücreyi Mod olarak
    // dene, çıkar. Eğer başarılıysa Not vardır (1 hücre daha kaldı).
    // Eğer header'da Mod yoksa: Not sütunu tespit edilmedi → matchMode
    // çıkarılmaz, son hücre keyword'tür.
    //
    // "Not" sütunu header'da varsa: sondan bir önceki hücreyi (Mod
    // çıkarıldıktan sonra yeni son) Not olarak al — boş olsa bile.
    if (columnHints.hasMod && kwCells.length > 0) {
      const last = kwCells[kwCells.length - 1];
      const parsedMode = detectMatchMode(last);
      if (parsedMode) {
        matchMode = parsedMode;
        kwCells = kwCells.slice(0, -1);
      }
    }
    if (columnHints.hasNot && kwCells.length > 0) {
      const last = kwCells[kwCells.length - 1];
      // Boş olsa bile Not sütununu notes'a al — operatör Excel'de
      // boş bırakmış olabilir. Görsel/UI'da boş görünür.
      notes = last;
      kwCells = kwCells.slice(0, -1);
    }

    const keywords = kwCells
      .flatMap((c) => c.split(","))
      .map((k) => k.trim())
      .filter(Boolean);
    pushRule(accountName, keywords, notes, idx, matchMode);
  });

  return { ok: parsed, errors, format: fmt };
}

/**
 * Read the very first (header) row and decide whether the operator's
 * sheet has explicit `Not` and/or `Mod` columns at the **right edge**
 * of the table.
 *
 * Excel convention: extra "trailing" semantic columns — operator notes
 * and a match-mode toggle — sit at the **end** of the row, never
 * interleaved with the keyword columns. So we look at the right-most
 * cell(s) of the header and decide from there:
 *
 *   - Last cell labeled "Mod/Mod benzeri" → hasMod=true, and the cell
 *     to its left (if labeled "Not benzeri") counts as Not.
 *   - Otherwise, if the last cell is labeled "Not benzeri" → hasNot=true.
 *   - Otherwise → neither. Treat all data cells as keywords so an
 *     operator pasting `Firma | Keyword` keeps both columns as data.
 *
 * Token match is case-insensitive AND accent-folded (NFKD strip + ı→i)
 * so Turkish "Not" / "Mod" / "İçerir" / "Eşleşme" headers all hit.
 */
function readColumnHints(headerCells: string[]): {
  hasNot: boolean;
  hasMod: boolean;
} {
  if (headerCells.length === 0) return { hasNot: false, hasMod: false };
  const notTokens = new Set(["not", "note", "notes", "açıklama", "description", "yorum"]);
  const modTokens = new Set(["mod", "mode", "eşleşme", "matchmode", "match"]);
  const matches = (h: string, set: Set<string>) => {
    if (!h) return false;
    const n = h.trim().toLowerCase();
    if (set.has(n)) return true;
    const stripped = n
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ı/g, "i");
    return set.has(stripped);
  };

  const lastIdx = headerCells.length - 1;
  if (matches(headerCells[lastIdx], modTokens)) {
    // Mod en sağda → Not onun solunda olabilir.
    const hasNot =
      lastIdx - 1 >= 0 && matches(headerCells[lastIdx - 1], notTokens);
    return { hasNot, hasMod: true };
  }
  if (matches(headerCells[lastIdx], notTokens)) {
    return { hasNot: true, hasMod: false };
  }
  return { hasNot: false, hasMod: false };
}

// --- previewOverrideBulk: Excel-style preview ------------------------------
//
// The companion to `parseOverrideBulk`. Instead of returning only the OK
// rules + error count, it returns one PreviewRow per source line so the
// UI can render an Excel-like table that mirrors what the operator pasted.
// Header rows are preserved (kind: "header") for display. Rows that will
// fail import carry an `error` status with a human-readable message.
//
// This function re-implements the parsing logic rather than reusing
// parseOverrideBulk so the per-row preview can keep the raw column order
// (Firma | Keyword1 | Keyword2 | Keyword3 | Not | Mod) intact — the OK
// list in parseOverrideBulk flattens all keyword cells into a single
// array, which loses column position. The Excel preview needs position
// because the operator's mental model is "Keyword2 column means the
// second keyword", not "third element of an array".

export function previewOverrideBulk(
  rawText: string,
  customers: readonly Customer[],
): PreviewResult {
  const norm = (s: string) => s.trim().toLowerCase();

  // Match mode keyword'ünü tespit et. Excel/TSV operatör yapıştırmalarında
  // sıkça "İçerir" (Türkçe büyük İ) geliyor — String.prototype.toLowerCase
  // Türkçe locale olmadan "İ" → "i" + combining dot above (U+0307) üretir
  // ve bizim listemizdeki "içerir" (düz i + ç) ile eşleşmez. Bu yüzden
  // hem toLowerCase hem de combining-mark-stripped fallback dene.
  const detectMatchMode = (raw: string): "contains" | "exact" | "" => {
    const n = norm(raw);
    const stripped = n.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");
    const match = (s: string) => s === n || s === stripped;
    if (
      match("tam") ||
      match("tam eşleşme") ||
      match("exact") ||
      match("==") ||
      match("birebir")
    ) {
      return "exact";
    }
    if (
      match("içerir") ||
      match("icerir") ||
      match("contains") ||
      match("substring")
    ) {
      return "contains";
    }
    return "";
  };

  const rawLines = rawText.split(/\r?\n/);

  const isHeaderLine = (cells: string[]): boolean => {
    const joined = cells.map(norm).join(" | ");
    const firmHits = ["firma", "müşteri", "customer", "account", "şirket"]
      .filter((t) => joined.includes(t));
    const kwHits = ["keyword", "anahtar", "tag", "etiket"]
      .filter((t) => joined.includes(t));
    const noteHits = ["not", "açıklama", "description", "note", "yorum"]
      .filter((t) => joined.includes(t));
    return (
      (firmHits.length >= 1 && kwHits.length >= 1) ||
      (firmHits.length >= 1 && noteHits.length >= 1 && cells.length >= 3)
    );
  };

  const dataLines = rawLines
    .map((l, i) => ({ raw: l, idx: i }))
    .filter((o) => {
      // Leading-whitespace-only trim (mirrors parseOverrideBulk).
      // Trailing tabs/spaces kept so empty trailing cells are visible.
      const t = o.raw.replace(/^\s+/, "");
      return t && !t.startsWith("#");
    });

  // Format detect — mirrors parseOverrideBulk.
  const detect = (): "tsv" | "csv" | "pipe" => {
    const sample = dataLines.slice(0, 5).map((o) => o.raw.replace(/^\s+/, "")).join("\n");
    const allHavePipe = dataLines.every((o) => o.raw.includes("|"));
    if (allHavePipe && dataLines.length > 0) return "pipe";
    const tabs = (sample.match(/\t/g) ?? []).length;
    const commas = (sample.match(/,/g) ?? []).length;
    if (tabs > 0 && tabs >= commas) return "tsv";
    if (commas > 0) return "csv";
    return "pipe";
  };

  const splitRow = (line: string, sep: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === sep) {
          out.push(cur);
          cur = "";
        } else cur += ch;
      }
    }
    out.push(cur);
    return out.map((c) => c.trim());
  };

  const rows: PreviewRow[] = [];
  let okCount = 0;
  let warnCount = 0;
  let errorCount = 0;

  if (dataLines.length === 0) {
    return { rows, format: "pipe", okCount: 0, warnCount: 0, errorCount: 0 };
  }

  const fmt = detect();

  if (fmt === "pipe") {
    rawLines.forEach((raw, i) => {
      // Leading-whitespace only trim — see comment above.
      const line = raw.replace(/^\s+/, "");
      if (!line || line.startsWith("#")) return;
      const parts = line.split("|").map((p) => p.trim());
      const accountName = parts[0] ?? "";
      const kwText = parts[1] ?? "";
      const rawNotes = parts[2] ?? "";
      const rawMode = parts[3] ?? "";
      // Pipe formatında tek hücre var (virgülle ayrılmış). Preview'da
      // KEYWORD1/2/3 kolonları zaten gösterilmiyor (sadece tsv/csv
      // yolu); yine de tutarlılık için ham listeyi keywordCells'e koy.
      const keywordCells = kwText
        .split(",")
        .map((k) => k.trim());
      const keywords = keywordCells.filter(Boolean);
      let notes = rawNotes;
      let matchMode: "contains" | "exact" | "" = "";
      const parsedMode = detectMatchMode(rawMode);
      if (parsedMode) {
        matchMode = parsedMode;
      } else if (rawMode) {
        notes = [rawNotes, rawMode].filter(Boolean).join(" | ");
      }
      const hit = customers.find((c) => norm(c.name) === norm(accountName));
      const status = classifyStatus(accountName, keywords, hit);
      rows.push({
        sourceLine: i + 1,
        kind: "rule",
        accountName,
        keywordCells,
        notes,
        matchMode,
        status: status.kind,
        statusMessage: status.message,
        resolvedAcntEuId: hit?.acntEuId ?? null,
      });
      tally(status.kind);
    });
    return { rows, format: "pipe", okCount, warnCount, errorCount };
  }

  const sep = fmt === "tsv" ? "\t" : ",";

  // Detect header on the first data line.
  // Don't trim raw here — String.prototype.trim strips tabs, which would
  // eat a leading separator on a row like "\tEVET" and merge it into a
  // single-cell rule. splitRow already trims each cell.
  const firstCells = splitRow(dataLines[0].raw, sep);
  let startIndex = 0;
  let headerCells: string[] | null = null;
  if (dataLines.length > 0 && isHeaderLine(firstCells)) {
    headerCells = firstCells;
    rows.push({
      sourceLine: dataLines[0].idx + 1,
      kind: "header",
      accountName: firstCells[0] ?? "",
      keywordCells: firstCells.slice(1),
      notes: "",
      matchMode: "",
      status: "ok",
      statusMessage: "başlık satırı (atlanır)",
      resolvedAcntEuId: null,
    });
    startIndex = 1;
  }
  const columnHints = headerCells
    ? readColumnHints(headerCells)
    : { hasNot: false, hasMod: false };

  for (let i = startIndex; i < dataLines.length; i++) {
    const { raw, idx } = dataLines[i];
    const cells = splitRow(raw, sep);
    if (cells.length === 0) continue;

    const accountName = cells[0];
    let kwCells = cells.slice(1);
    let notes = "";
    let matchMode: "contains" | "exact" | "" = "";

    // parseOverrideBulk ile aynı mantık: header'da `Not` / `Mod`
    // kolonları **declared** ise verideki sondan o hücreleri çıkar.
    // Yoksa hiç dokunma — operatörün 2-kolonlu yapıştırmasındaki
    // tek keyword'ü yanlışlıkla "notes" yapma.
    if (columnHints.hasMod && kwCells.length > 0) {
      const last = kwCells[kwCells.length - 1];
      const parsedMode = detectMatchMode(last);
      if (parsedMode) {
        matchMode = parsedMode;
        kwCells = kwCells.slice(0, -1);
      }
    }
    if (columnHints.hasNot && kwCells.length > 0) {
      const last = kwCells[kwCells.length - 1];
      notes = last;
      kwCells = kwCells.slice(0, -1);
    }

    // Excel/CSV preview'da 3 ayrı kolon (KEYWORD1/2/3) görüntülemek
    // için ham `kwCells`'i sakla — boş hücreleri koru. `keywords` ise
    // status sınıflandırması ve gerçek import için flat liste olarak
    // ayrı tutulur (boş hücreler düşer, virgülle ayrılmış alt
    // keyword'ler genişler).
    const keywordCells = kwCells;
    const keywords = kwCells
      .flatMap((c) => c.split(","))
      .map((k) => k.trim())
      .filter(Boolean);

    const hit = customers.find((c) => norm(c.name) === norm(accountName));
    const status = classifyStatus(accountName, keywords, hit);
    rows.push({
      sourceLine: idx + 1,
      kind: "rule",
      accountName,
      keywordCells,
      notes,
      matchMode,
      status: status.kind,
      statusMessage: status.message,
      resolvedAcntEuId: hit?.acntEuId ?? null,
    });
    tally(status.kind);
  }

  function classifyStatus(
    accountName: string,
    keywords: string[],
    hit: Customer | undefined,
  ): { kind: PreviewStatus; message: string } {
    if (!accountName.trim()) {
      return {
        kind: "no-firm",
        message: "Firma adı boş — satır atlanacak",
      };
    }
    if (keywords.length === 0) {
      return {
        kind: "no-keywords",
        message: "En az bir keyword gerekli — satır atlanacak",
      };
    }
    if (!hit) {
      return {
        kind: "firm-unknown",
        message: `"${accountName}" müşteri listesinde yok. Model bu adı öneri olarak kullanabilir, ama fiili ücretlendirme yapamaz (acntEuId boş).`,
      };
    }
    return { kind: "ok", message: "İçe aktarılacak" };
  }

  function tally(status: PreviewStatus): void {
    if (status === "ok") okCount++;
    else if (status === "firm-unknown") warnCount++;
    else errorCount++;
  }

  return { rows, format: fmt, okCount, warnCount, errorCount };
}