import type {
  KeywordOverride,
  OverrideFileEnvelope,
  OverrideMatchMode,
} from "../types.js";

/**
 * JSON import/export for the operator-maintained override rules.
 *
 * The on-disk shape (see `docs/OVERRIDES-JSON-FORMAT.md`):
 *
 *   {
 *     "format": "hatali-katilimlar.overrides",
 *     "version": 2,
 *     "exportedAt": "2026-09-30T14:22:11.000Z",
 *     "rules": KeywordOverride[]
 *   }
 *
 * The envelope exists so future schema changes can migrate without
 * losing user rules. `version: 1` (legacy bare array, no envelope)
 * is auto-detected on import for backward compatibility with files
 * exported by earlier versions of the extension.
 */

export const OVERRIDE_FILE_FORMAT = "hatali-katilimlar.overrides" as const;
export const OVERRIDE_FILE_VERSION = 2 as const;

export interface ImportSummary {
  /** Rules appended (no id collision with the current local list). */
  added: number;
  /** Rules replaced because an imported id matched an existing one. */
  updated: number;
  /** Rules dropped with a reason string — joined for the toast. */
  skipped: { rule: unknown; reason: string }[];
  /** Final merged list — what should be persisted. */
  next: KeywordOverride[];
  /** True when the entire file was rejected (format mismatch or parse error). */
  rejected?: string;
}

/**
 * Build the export envelope from a rules list. Sorted by accountName
 * (case-insensitive) then id so two exports of the same data are
 * byte-identical — operators diffing files in git will get clean
 * output.
 */
export function exportOverridesToJson(
  rules: KeywordOverride[],
  now: () => Date = () => new Date(),
): OverrideFileEnvelope {
  const sorted = [...rules].sort((a, b) => {
    const an = a.accountName.toLowerCase();
    const bn = b.accountName.toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  return {
    format: OVERRIDE_FILE_FORMAT,
    version: OVERRIDE_FILE_VERSION,
    exportedAt: now().toISOString(),
    rules: sorted,
  };
}

/**
 * Parse a JSON string and merge its rules into the current local
 * list. Validation is strict about types but lenient about missing
 * optional fields; rows with unrecoverable problems are dropped with
 * a reason string instead of aborting the whole import.
 *
 * Merge strategy: dedupe by `id`, **newer wins** — if the imported
 * list contains an id that already exists locally, the imported rule
 * replaces the local one (operators editing their export on disk
 * expect their edits to be authoritative).
 *
 * A missing or duplicate `id` is regenerated as `ov-<ts>-<idx>-<rand>`
 * so the rule still imports — just as a brand-new row.
 *
 * Returns an `ImportSummary` whose `rejected` field is set when the
 * file's `format` does not match (or the JSON itself is malformed);
 * in that case `next` is the unchanged current list and callers
 * should NOT persist.
 */
export function importOverridesFromJson(
  text: string,
  current: KeywordOverride[],
): ImportSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      added: 0,
      updated: 0,
      skipped: [],
      next: current,
      rejected: `JSON parse hatası: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Detect legacy bare array — version 1, no envelope. Accepted as-is.
  const legacyBare = Array.isArray(parsed);
  if (!legacyBare) {
    const env = parsed as Partial<OverrideFileEnvelope>;
    if (env.format !== OVERRIDE_FILE_FORMAT) {
      return {
        added: 0,
        updated: 0,
        skipped: [],
        next: current,
        rejected: `Yanlış dosya formatı: beklenen "${OVERRIDE_FILE_FORMAT}", alınan "${env.format ?? "(yok)"}"`,
      };
    }
  }

  const rawRules: unknown = legacyBare
    ? parsed
    : (parsed as OverrideFileEnvelope).rules;
  if (!Array.isArray(rawRules)) {
    return {
      added: 0,
      updated: 0,
      skipped: [],
      next: current,
      rejected: "Dosyada `rules` array bulunamadı",
    };
  }

  const existingById = new Map(current.map((r) => [r.id, r]));
  const next: KeywordOverride[] = [...current];
  let added = 0;
  let updated = 0;
  const skipped: { rule: unknown; reason: string }[] = [];

  rawRules.forEach((raw, idx) => {
    const validated = validateRule(raw, idx);
    if ("reason" in validated) {
      skipped.push({ rule: raw, reason: validated.reason });
      return;
    }
    let rule = validated.rule;

    // Missing id → regenerate. A present id that collides with an
    // existing local rule REPLACES the local rule (newer wins):
    // operators editing their exported file expect their edits to be
    // authoritative, and silently dropping their change would surprise.
    if (!rule.id) {
      rule = { ...rule, id: generateId(idx) };
    }

    const existingIdx = next.findIndex((r) => r.id === rule.id);
    if (existingIdx >= 0) {
      next[existingIdx] = rule;
      updated += 1;
    } else {
      next.push(rule);
      added += 1;
    }
    existingById.set(rule.id, rule);
  });

  return { added, updated, skipped, next };
}

type ValidationOk = { rule: KeywordOverride };
type ValidationFail = { reason: string };

function validateRule(raw: unknown, idx: number): ValidationOk | ValidationFail {
  if (raw === null || typeof raw !== "object") {
    return { reason: `Satır ${idx + 1}: obje değil` };
  }
  const obj = raw as Record<string, unknown>;

  // accountName required + non-empty after trim.
  if (typeof obj.accountName !== "string" || obj.accountName.trim() === "") {
    return { reason: `Satır ${idx + 1}: accountName eksik veya boş` };
  }

  // id: optional. If present, must be non-empty string.
  let id: string;
  if (obj.id === undefined || obj.id === null || obj.id === "") {
    id = ""; // placeholder; caller regenerates
  } else if (typeof obj.id !== "string") {
    return { reason: `Satır ${idx + 1}: id string olmalı` };
  } else {
    id = obj.id;
  }

  // acntEuId: null or string.
  let acntEuId: string | null;
  if (obj.acntEuId === null || obj.acntEuId === undefined) {
    acntEuId = null;
  } else if (typeof obj.acntEuId !== "string") {
    acntEuId = null;
  } else {
    const trimmed = obj.acntEuId.trim();
    acntEuId = trimmed === "" ? null : trimmed;
  }

  // keywords: required, non-empty string array, at least one non-blank.
  if (!Array.isArray(obj.keywords)) {
    return { reason: `Satır ${idx + 1}: keywords array olmalı` };
  }
  const keywords = obj.keywords
    .filter((k): k is string => typeof k === "string")
    .map((k) => k.trim())
    .filter(Boolean);
  if (keywords.length === 0) {
    return { reason: `Satır ${idx + 1}: en az bir keyword gerekli` };
  }

  // matchMode: optional, "contains" | "exact". Default "contains".
  let matchMode: OverrideMatchMode = "contains";
  if (obj.matchMode === "exact") matchMode = "exact";
  else if (obj.matchMode === "contains") matchMode = "contains";
  else if (obj.matchMode !== undefined && obj.matchMode !== null) {
    return { reason: `Satır ${idx + 1}: matchMode "contains" veya "exact" olmalı` };
  }

  // notes: optional string.
  let notes: string | undefined;
  if (typeof obj.notes === "string") notes = obj.notes.trim();
  else if (obj.notes !== undefined && obj.notes !== null) notes = String(obj.notes);

  const rule: KeywordOverride = {
    id,
    accountName: obj.accountName.trim(),
    acntEuId,
    keywords,
    matchMode,
    ...(notes ? { notes } : {}),
  };
  return { rule };
}

/**
 * Stable id generator used by both the editor (when the operator adds
 * a blank row) and the importer (when it regenerates a missing/colliding
 * id). Format mirrors the existing `OverrideEditor.addRule` id so
 * files exported before the refactor still match what the editor
 * produces today.
 */
export function generateId(idx = 0): string {
  return `ov-${Date.now()}-${idx}-${Math.random().toString(36).slice(2, 6)}`;
}

// --- Browser file IO helpers ------------------------------------------------

/**
 * Trigger a download of `envelope` as a JSON file. Uses
 * `URL.createObjectURL` + `<a download>` so we don't need the
 * `chrome.downloads` permission (which the manifest does not declare).
 *
 * Filename: `kurallar-YYYY-MM-DD.json` from the envelope's
 * `exportedAt` (or today if absent — the envelope always carries it).
 */
export function triggerDownload(envelope: OverrideFileEnvelope): void {
  const blob = new Blob([JSON.stringify(envelope, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filenameForEnvelope(envelope);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on next tick so the click has time to register the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function filenameForEnvelope(env: OverrideFileEnvelope): string {
  const date = env.exportedAt ? env.exportedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return `kurallar-${date}.json`;
}

/**
 * Pretty-print a multi-line summary suitable for the import toast:
 *
 *   "12 eklendi · 3 güncellendi · 1 atlandı (hata: …)"
 */
export function formatImportSummary(summary: ImportSummary): string {
  if (summary.rejected) return summary.rejected;
  const parts: string[] = [];
  if (summary.added > 0) parts.push(`${summary.added} eklendi`);
  if (summary.updated > 0) parts.push(`${summary.updated} güncellendi`);
  if (summary.skipped.length > 0) {
    const first = summary.skipped[0].reason;
    parts.push(`${summary.skipped.length} atlandı (${first})`);
  }
  if (parts.length === 0) return "Dosyada yeni kural yok";
  return parts.join(" · ");
}
