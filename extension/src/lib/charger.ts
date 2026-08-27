import { charged } from "./api.js";
import { appendAudit } from "./store.js";
import type { ChargedResponse, ChargeRecord } from "../types.js";

export interface ChargeOneResult {
  ok: boolean;
  record: ChargeRecord;
}

/**
 * Last-resort guard before talking to the network. The caller is supposed
 * to resolve the firm via `resolveFirm` (which sanitizes AI-returned
 * values), but if any code path skips that — or the AI ever returns a
 * brand-new shape we didn't anticipate — refuse to POST a payload the
 * server will reject with a GUID validation error.
 *
 * Returns null when the value is acceptable; returns an error string
 * describing the mis-shape otherwise.
 */
function validateAccountEuId(v: unknown): string | null {
  if (v == null) return "accountEuId boş (null/undefined)";
  if (typeof v !== "string") return `accountEuId string değil (${typeof v})`;
  const trimmed = v.trim();
  if (trimmed === "") return "accountEuId boş string";
  if (trimmed === "null") return 'accountEuId literal "null" string';
  if (trimmed.length < 32) {
    return `accountEuId UUID kadar uzun değil (${trimmed.length} karakter)`;
  }
  return null;
}

/**
* Send a single Charged POST with the given transactionIds to the given firm.
* Always one call, never retried automatically — the operator reviews each
* click and can re-trigger if a call fails. This is the lowest-level write
* primitive in the extension; the UI never sends anything else to the server.
*/
export async function chargeOnce(
  sessionId: string,
  accountEuId: string,
  accountName: string | null,
  transactionIds: number[],
  _rowLabel: string | null = null,
  demoMode = false,
): Promise<ChargeOneResult> {
  const ids = [...new Set(transactionIds)].filter(Number.isInteger);
  if (ids.length === 0) {
    throw new Error("chargeOnce: no transactionIds");
  }
  const accountProblem = validateAccountEuId(accountEuId);
  if (accountProblem) {
    throw new Error(
      `chargeOnce: ${accountProblem} — bu isteği göndermiyorum. ` +
        `(Bu bir veri bütünlüğü hatası; lütfen session'ı temizleyip yeniden fetch edin.)`,
    );
  }

  const sentAt = new Date().toISOString();
  let resp: ChargedResponse | null = null;
  let ok = false;
  let errorMessage = "";

  try {
    resp = await charged(sessionId, accountEuId, ids, demoMode);
    ok = resp.isSuccess === true && resp.resultCode === 0;
    if (!ok) errorMessage = resp.resultDetails ?? `resultCode=${resp.resultCode}`;
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  const record: ChargeRecord = {
    transactionId: ids[0],
    accountEuId,
    accountName,
    transactionIds: ids,
    status: ok ? "success" : "error",
    resultCode: resp?.resultCode ?? null,
    resultDetails: ok ? resp!.resultDetails : errorMessage,
    sentAt,
  };

  await appendAudit(record);

  return { ok, record };
}

/** Append a "row finished" message to the audit log without sending any POST. */
export async function logRowNote(rowLabel: string, note: string): Promise<void> {
  await appendAudit({
    transactionId: 0,
    accountEuId: "",
    accountName: rowLabel,
    transactionIds: [],
    status: "success",
    resultCode: 0,
    resultDetails: note,
    sentAt: new Date().toISOString(),
  });
}