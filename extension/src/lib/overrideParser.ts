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

  const detectMatchMode = (raw: string): "contains" | "exact" | null => {
    const n = norm(raw);
    if (
      n === "tam" ||
      n === "tam eşleşme" ||
      n === "exact" ||
      n === "==" ||
      n === "birebir"
    ) {
      return "exact";
    }
    if (
      n === "içerir" ||
      n === "icerir" ||
      n === "contains" ||
      n === "substring"
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
      const line = raw.trim();
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
  // it looks like a header.
  const filtered: { idx: number; line: string }[] = [];
  rawLines.forEach((raw, i) => {
    const line = raw.trim();
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

    // The last cell is treated as matchMode if it parses to one of the
    // known tokens (İçerir/Tam/exact/contains). Otherwise the heuristic
    // for notes kicks in (space OR length > 14).
    if (kwCells.length >= 1) {
      const last = kwCells[kwCells.length - 1];
      const parsedMode = detectMatchMode(last);
      if (parsedMode) {
        matchMode = parsedMode;
        kwCells = kwCells.slice(0, -1);
      } else if (kwCells.length >= 2) {
        const looksLikeNotes = last.includes(" ") || last.length > 14;
        if (looksLikeNotes) {
          notes = last;
          kwCells = kwCells.slice(0, -1);
        }
      }
    }

    const keywords = kwCells
      .flatMap((c) => c.split(","))
      .map((k) => k.trim())
      .filter(Boolean);
    pushRule(accountName, keywords, notes, idx, matchMode);
  });

  return { ok: parsed, errors, format: fmt };
}