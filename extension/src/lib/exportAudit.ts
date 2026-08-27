import type { ChargeRecord } from "../types.js";

/**
 * Trigger a browser download of `content` as `filename`. Uses an
 * anchor with a blob URL; works in a Chrome extension page (the
 * blob: scheme is permitted for downloads in MV3).
 */
export function downloadBlob(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so the click has time to dispatch.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function recordsToJson(records: ChargeRecord[]): string {
  return JSON.stringify(records, null, 2);
}

/**
 * Serialize records as RFC-4180-ish CSV. Quotes any field that
 * contains comma, newline, or double-quote; doubles internal quotes.
 */
export function recordsToCsv(records: ChargeRecord[]): string {
  const header = [
    "sentAt",
    "status",
    "accountName",
    "accountEuId",
    "transactionIds",
    "resultCode",
    "resultDetails",
  ];
  const lines: string[] = [header.join(",")];
  for (const r of records) {
    lines.push(
      [
        r.sentAt,
        r.status,
        r.accountName ?? "",
        r.accountEuId,
        r.transactionIds.join("|"),
        r.resultCode == null ? "" : String(r.resultCode),
        r.resultDetails ?? "",
      ].map(csvEscape).join(","),
    );
  }
  return lines.join("\r\n");
}

function csvEscape(value: string): string {
  if (value === "") return "";
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Pick a short, sortable file prefix like `audit-2026-08-27`.
 */
export function dateStamp(d: Date = new Date()): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}