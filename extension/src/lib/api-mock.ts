/**
 * In-process mock for admin-panel-api.codec.com.tr. Only used when the
 * operator toggles `Settings.demoMode = true` (manual UI verification —
 * never set in production).
 *
 * The mock is wire-identical to the live backend: `mockHandleRequest`
 * returns a real `Response` object (status, content-type, JSON body)
 * that flows through the SAME `call()` pipeline in api.ts as a real
 * fetch result. The only difference is `fetch()` itself is not invoked
 * — the Response is constructed in-process. Status checks, JSON.parse,
 * error throwing, and the .text() / .ok branches in call() are all
 * exercised identically.
 *
 * Fixture shape modeled on HAR observations of admin-panel.codec.com.tr
 * (2,698 items, 492 distinct keyword1 values). Top keywords: RET, İPTAL,
 * SMS, IPTAL, LWC, RED, PTT. Distribution here is approximate (~80
 * items split across 5 firms). Charges recorded here live in an
 * in-memory `chargeLog` array (no real money moves — see CLAUDE.md hard
 * rule that chargeOnce must originate from a manual click).
 */
import type {
  ChargedResponse,
  Customer,
  ItemMatch,
  UnmatchedItem,
} from "../types.js";

export interface MockFixture {
  customers: Customer[];
  items: UnmatchedItem[];
  matches: ItemMatch[];
}

// --- Fixture ----------------------------------------------------------------

const FIRM_AKTIF = "aaaaaaaa-0000-0000-0000-000000000001";
const FIRM_GARANTI = "bbbbbbbb-0000-0000-0000-000000000002";
const FIRM_YAPIKREDI = "cccccccc-0000-0000-0000-000000000003";
const FIRM_HALKBANK = "dddddddd-0000-0000-0000-000000000004";
const FIRM_FINANSBANK = "eeeeeeee-0000-0000-0000-000000000005";

const CUSTOMERS: Customer[] = [
  { name: "AKTIF-BANK ---- Aktif Bank", acntEuId: FIRM_AKTIF },
  { name: "GARANTI ---- Garanti Bankasi", acntEuId: FIRM_GARANTI },
  { name: "YAPIKREDI ---- Yapi Kredi", acntEuId: FIRM_YAPIKREDI },
  { name: "HALKBANK ---- Halkbank", acntEuId: FIRM_HALKBANK },
  { name: "FINANSBANK ---- Finansbank", acntEuId: FIRM_FINANSBANK },
];

// HAR-style phone prefixes (5xx GSM). Spreads the digit distribution a
// realistic operator would see — most Turkish mobile numbers cluster
// around the 530-539 range, not a single prefix.
const PHONE_PREFIXES = ["530", "532", "533", "535", "536", "537", "538", "539"];
function phoneFor(txId: number): string {
  const prefix = PHONE_PREFIXES[txId % PHONE_PREFIXES.length];
  // 7-digit suffix; deterministic so reruns reproduce the same numbers.
  const suffix = (txId * 1234 + 567).toString().padStart(7, "0").slice(-7);
  return `${prefix}${suffix}`;
}

function dateFor(txId: number): string {
  // Spread across 18..24 Aug 2026 (HAR covers ~7 days of traffic).
  const day = 18 + (txId % 7);
  const hour = (txId * 3) % 24;
  const minute = (txId * 7) % 60;
  const second = (txId * 11) % 60;
  const dd = String(day).padStart(2, "0");
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  return `2026-08-${dd}T${hh}:${mm}:${ss}`;
}

function item(
  id: number,
  keyword1: string,
  msgContent = "",
  keyword2 = "",
): UnmatchedItem {
  const msgDate = dateFor(id);
  // Live backend's `id` is a composite: "<txId>|<formatted date>" —
  // the operator uses it for diffing. We mimic the format.
  const prettyDate = msgDate.replace("T", " ").replace(/-\d{2}-/, ".");
  return {
    transactionId: id,
    phone: phoneFor(id),
    keyword1,
    keyword2,
    msgContent,
    shortCode: "3525",
    msgDate,
    id: `${id}|${prettyDate}`,
  };
}

// --- Items: 80 txIds, HAR-style distribution -------------------------------
//
// Firm composition:
//   AKTIF-BANK:    IPTAL(6) + BILGI(7) + HATA(2)         = 15
//   GARANTI:       İPTAL(10) + ODEME(8)                  = 18
//   YAPIKREDI:     RET(13) + SMS(5) + BILGI(1)           = 19
//   HALKBANK:      LWC(6) + PTT(3) + RED(1)              = 10
//   FINANSBANK:    SMS(3) + RED(2) + HATA(4) + garbage(8)= 17
//
// One item per section is intentionally misattributed by the AI (low/
// medium confidence) so the operator can verify per-txId reassign works
// without touching real money.

const ITEMS: UnmatchedItem[] = [
  // --- AKTIF-BANK (15 items: 1001-1015) -------------------------------------
  // IPTAL — Aktif Bank's signature cancel keyword.
  item(1001, "IPTAL", "Abonelik iptal"),
  item(1002, "IPTAL"),
  item(1003, "IPTAL", "Iptal etmek istiyorum"),
  item(1004, "IPTAL"),
  item(1005, "IPTAL", "Lutfen iptal edin"),
  item(1006, "IPTAL", "Abonelikten cikmak istiyorum"),
  // BILGI — info requests.
  item(1007, "BILGI"),
  item(1008, "BILGI", "Hesap bilgisi"),
  item(1009, "BILGI"),
  item(1010, "BILGI", "Detay verin"),
  item(1011, "BILGI"),
  item(1012, "BILGI", "Bilgi almak istiyorum"),
  item(1013, "BILGI"),
  // HATA — error reports; item 1014 is the misattribution test (should be YAPIKREDI).
  item(1014, "HATA", "Aktif kredi karti iade sorunu"), // intentionally generic
  item(1015, "HATA", "Aktif uygulama hatasi"),

  // --- GARANTI (18 items: 2001-2018) ----------------------------------------
  // İPTAL — Garanti cancel flow.
  item(2001, "İPTAL"),
  item(2002, "İPTAL", "Iptal"),
  item(2003, "İPTAL"),
  item(2004, "İPTAL", "Lutfen iptal"),
  item(2005, "İPTAL"),
  item(2006, "İPTAL", "Abonelik iptal"),
  item(2007, "İPTAL"),
  item(2008, "İPTAL", "Iptal talebi"),
  // item 2009 is misattributed: AI says GARANTI but it's a utility cancel.
  item(2009, "İPTAL", "Elektrik faturasini iptal edin"),
  item(2010, "İPTAL"),
  // ODEME — payment/refund flow.
  item(2011, "ODEME", "Odeme geri al"),
  item(2012, "ODEME"),
  item(2013, "ODEME", "Para iadesi"),
  item(2014, "ODEME"),
  item(2015, "ODEME", "Geri odeme talebi"),
  item(2016, "ODEME"),
  item(2017, "ODEME", "Ucret iadesi"),
  item(2018, "ODEME", "Iade istiyorum"),

  // --- YAPIKREDI (19 items: 3001-3019) --------------------------------------
  // RET — retail returns (Yapi Kredi's strongest signature).
  item(3001, "RET"),
  item(3002, "RET", "Urun iade"),
  item(3003, "RET"),
  item(3004, "RET", "Siparis iptal"),
  item(3005, "RET"),
  item(3006, "RET", "Magaza iade"),
  item(3007, "RET"),
  item(3008, "RET", "Kargo iade"),
  item(3009, "RET"),
  item(3010, "RET", "Urun degisim"),
  item(3011, "RET"),
  item(3012, "RET", "Iade kodu"),
  item(3013, "RET"),
  // SMS — short-code content.
  item(3014, "SMS"),
  item(3015, "SMS", "Yapi kampanya"),
  item(3016, "SMS"),
  item(3017, "SMS", "Yapi sadakat"),
  item(3018, "SMS"),
  // BILGI — secondary info requests (small share).
  item(3019, "BILGI", "Yapi Kredi kart bilgisi"),

  // --- HALKBANK (10 items: 4001-4010) ---------------------------------------
  // LWC — utility/cable cancel keyword (Halkbank handles these).
  item(4001, "LWC"),
  item(4002, "LWC", "LWC iptal"),
  item(4003, "LWC"),
  item(4004, "LWC", "LWC abonelik"),
  item(4005, "LWC"),
  item(4006, "LWC", "LWC fatura"),
  // PTT — postal barcode matches (14-digit keyword2 in real data).
  item(4007, "PTT", "", "71234567890123"),
  item(4008, "PTT", "", "81234567890123"),
  item(4009, "PTT", "", "91234567890123"),
  // RED — minority; item 4010 is the misattribution (should be GARANTI, not HALKBANK).
  item(4010, "RED", "Kredi karti iade"),

  // --- FINANSBANK (17 items: 5001-5017) -------------------------------------
  // SMS — leftover short-code items.
  item(5001, "SMS"),
  item(5002, "SMS", "Finans kampanya"),
  item(5003, "SMS"),
  // RED — credit-card reversal signature.
  item(5004, "RED"),
  item(5005, "RED", "Finans kart iade"),
  // HATA — error reports.
  item(5006, "HATA"),
  item(5007, "HATA", "Finans uygulama hatasi"),
  item(5008, "HATA"),
  item(5009, "HATA", "Finans islem hatasi"),
  // Garbage / low-confidence items — keyword1 or msgContent is noise.
  // These are the cases the operator must manually route to a firm.
  item(5010, ".", "", ""),                          // literal dot
  item(5011, "", "???", ""),                        // empty keyword, junk msg
  item(5012, "x", "", ""),                          // single-char garbage
  item(5013, "", "", "asdf"),                       // empty fields
  item(5014, "111", "", ""),                        // numeric junk
  item(5015, "ZZZ", "", ""),                        // all-caps junk
  item(5016, "", "iade"),                           // short msg, no keyword
  // item 5017 — keyword is "iptal" but msgContent says "kredi" → banker wants AKTIF-BANK.
  item(5017, "iptal", "Aktif kredi hesabimi iptal"),
];

// --- Matches: AI suggestions per item -------------------------------------
//
// `m()` builds the ItemMatch for a txId. The `confidence` and the
// suggested firm depend on which signals matched. Misattributed items
// (one per firm section, see ITEMS comments) are marked medium/low so
// the UI badge surfaces them — the operator then uses the per-txId
// dropdown to reassign.

function m(
  id: number,
  group: string,
  accountId: string | null,
  accountName: string | null,
  conf: "high" | "medium" | "low",
  field: "keyword1" | "keyword2" | "msgContent",
  value: string,
  reasoning = "",
): ItemMatch {
  return {
    transactionId: id,
    matchedField: field,
    matchedValue: value,
    keywordGroup: group,
    suggestedAccountEuId: accountId,
    suggestedAccountName: accountName,
    confidence: conf,
    reasoning,
  };
}

const MATCHES: ItemMatch[] = [
  // --- AKTIF-BANK matches (15) ----------------------------------------------
  m(1001, "iptal", FIRM_AKTIF, "AKTIF-BANK", "high", "keyword1", "IPTAL"),
  m(1002, "iptal", FIRM_AKTIF, "AKTIF-BANK", "high", "keyword1", "IPTAL"),
  m(1003, "iptal", FIRM_AKTIF, "AKTIF-BANK", "medium", "msgContent", "Iptal etmek istiyorum"),
  m(1004, "iptal", FIRM_AKTIF, "AKTIF-BANK", "high", "keyword1", "IPTAL"),
  m(1005, "iptal", FIRM_AKTIF, "AKTIF-BANK", "medium", "msgContent", "Lutfen iptal edin"),
  m(1006, "iptal", FIRM_AKTIF, "AKTIF-BANK", "medium", "msgContent", "Abonelikten cikmak istiyorum"),
  m(1007, "bilgi", FIRM_AKTIF, "AKTIF-BANK", "high", "keyword1", "BILGI"),
  m(1008, "bilgi", FIRM_AKTIF, "AKTIF-BANK", "medium", "msgContent", "Hesap bilgisi"),
  m(1009, "bilgi", FIRM_AKTIF, "AKTIF-BANK", "high", "keyword1", "BILGI"),
  m(1010, "bilgi", FIRM_AKTIF, "AKTIF-BANK", "medium", "msgContent", "Detay verin"),
  m(1011, "bilgi", FIRM_AKTIF, "AKTIF-BANK", "high", "keyword1", "BILGI"),
  m(1012, "bilgi", FIRM_AKTIF, "AKTIF-BANK", "medium", "msgContent", "Bilgi almak istiyorum"),
  m(1013, "bilgi", FIRM_AKTIF, "AKTIF-BANK", "high", "keyword1", "BILGI"),
  // 1014 misattribution: AI is guessing; operator should reassign to YAPIKREDI.
  m(1014, "hata", FIRM_AKTIF, "AKTIF-BANK", "low", "msgContent", "Aktif kredi karti iade sorunu",
    "guessed AKTIF-BANK because 'Aktif' appears in msgContent"),
  m(1015, "hata", FIRM_AKTIF, "AKTIF-BANK", "medium", "msgContent", "Aktif uygulama hatasi"),

  // --- GARANTI matches (18) -------------------------------------------------
  m(2001, "iptal", FIRM_GARANTI, "GARANTI", "high", "keyword1", "İPTAL"),
  m(2002, "iptal", FIRM_GARANTI, "GARANTI", "medium", "msgContent", "Iptal"),
  m(2003, "iptal", FIRM_GARANTI, "GARANTI", "high", "keyword1", "İPTAL"),
  m(2004, "iptal", FIRM_GARANTI, "GARANTI", "medium", "msgContent", "Lutfen iptal"),
  m(2005, "iptal", FIRM_GARANTI, "GARANTI", "high", "keyword1", "İPTAL"),
  m(2006, "iptal", FIRM_GARANTI, "GARANTI", "medium", "msgContent", "Abonelik iptal"),
  m(2007, "iptal", FIRM_GARANTI, "GARANTI", "high", "keyword1", "İPTAL"),
  m(2008, "iptal", FIRM_GARANTI, "GARANTI", "medium", "msgContent", "Iptal talebi"),
  // 2009 misattribution: msgContent hints "Elektrik" → HALKBANK, not GARANTI.
  m(2009, "iptal", FIRM_GARANTI, "GARANTI", "low", "msgContent", "Elektrik faturasini iptal edin",
    "guessed GARANTI because keyword1=İPTAL; HALKBANK also plausible"),
  m(2010, "iptal", FIRM_GARANTI, "GARANTI", "high", "keyword1", "İPTAL"),
  m(2011, "odeme", FIRM_GARANTI, "GARANTI", "high", "msgContent", "Odeme geri al"),
  m(2012, "odeme", FIRM_GARANTI, "GARANTI", "high", "keyword1", "ODEME"),
  m(2013, "odeme", FIRM_GARANTI, "GARANTI", "high", "msgContent", "Para iadesi"),
  m(2014, "odeme", FIRM_GARANTI, "GARANTI", "high", "keyword1", "ODEME"),
  m(2015, "odeme", FIRM_GARANTI, "GARANTI", "medium", "msgContent", "Geri odeme talebi"),
  m(2016, "odeme", FIRM_GARANTI, "GARANTI", "high", "keyword1", "ODEME"),
  m(2017, "odeme", FIRM_GARANTI, "GARANTI", "medium", "msgContent", "Ucret iadesi"),
  m(2018, "odeme", FIRM_GARANTI, "GARANTI", "low", "msgContent", "Iade istiyorum"),

  // --- YAPIKREDI matches (19) -----------------------------------------------
  m(3001, "ret", FIRM_YAPIKREDI, "YAPIKREDI", "high", "keyword1", "RET"),
  m(3002, "ret", FIRM_YAPIKREDI, "YAPIKREDI", "high", "msgContent", "Urun iade"),
  m(3003, "ret", FIRM_YAPIKREDI, "YAPIKREDI", "high", "keyword1", "RET"),
  m(3004, "ret", FIRM_YAPIKREDI, "YAPIKREDI", "high", "msgContent", "Siparis iptal"),
  m(3005, "ret", FIRM_YAPIKREDI, "YAPIKREDI", "high", "keyword1", "RET"),
  m(3006, "ret", FIRM_YAPIKREDI, "YAPIKREDI", "high", "msgContent", "Magaza iade"),
  m(3007, "ret", FIRM_YAPIKREDI, "YAPIKREDI", "high", "keyword1", "RET"),
  m(3008, "ret", FIRM_YAPIKREDI, "YAPIKREDI", "high", "msgContent", "Kargo iade"),
  m(3009, "ret", FIRM_YAPIKREDI, "YAPIKREDI", "high", "keyword1", "RET"),
  m(3010, "ret", FIRM_YAPIKREDI, "YAPIKREDI", "high", "msgContent", "Urun degisim"),
  m(3011, "ret", FIRM_YAPIKREDI, "YAPIKREDI", "high", "keyword1", "RET"),
  m(3012, "ret", FIRM_YAPIKREDI, "YAPIKREDI", "medium", "msgContent", "Iade kodu"),
  m(3013, "ret", FIRM_YAPIKREDI, "YAPIKREDI", "high", "keyword1", "RET"),
  m(3014, "sms", FIRM_YAPIKREDI, "YAPIKREDI", "high", "keyword1", "SMS"),
  m(3015, "sms", FIRM_YAPIKREDI, "YAPIKREDI", "high", "msgContent", "Yapi kampanya"),
  m(3016, "sms", FIRM_YAPIKREDI, "YAPIKREDI", "high", "keyword1", "SMS"),
  m(3017, "sms", FIRM_YAPIKREDI, "YAPIKREDI", "medium", "msgContent", "Yapi sadakat"),
  m(3018, "sms", FIRM_YAPIKREDI, "YAPIKREDI", "high", "keyword1", "SMS"),
  m(3019, "bilgi", FIRM_YAPIKREDI, "YAPIKREDI", "medium", "msgContent", "Yapi Kredi kart bilgisi"),

  // --- HALKBANK matches (10) ------------------------------------------------
  m(4001, "lwc", FIRM_HALKBANK, "HALKBANK", "high", "keyword1", "LWC"),
  m(4002, "lwc", FIRM_HALKBANK, "HALKBANK", "high", "msgContent", "LWC iptal"),
  m(4003, "lwc", FIRM_HALKBANK, "HALKBANK", "high", "keyword1", "LWC"),
  m(4004, "lwc", FIRM_HALKBANK, "HALKBANK", "high", "msgContent", "LWC abonelik"),
  m(4005, "lwc", FIRM_HALKBANK, "HALKBANK", "high", "keyword1", "LWC"),
  m(4006, "lwc", FIRM_HALKBANK, "HALKBANK", "high", "msgContent", "LWC fatura"),
  m(4007, "ptt", FIRM_HALKBANK, "HALKBANK", "high", "keyword1", "PTT"),
  m(4008, "ptt", FIRM_HALKBANK, "HALKBANK", "high", "keyword1", "PTT"),
  m(4009, "ptt", FIRM_HALKBANK, "HALKBANK", "high", "keyword1", "PTT"),
  // 4010 misattribution: AI says HALKBANK because keyword1=RED. Actually GARANTI (kredi karti).
  m(4010, "red", FIRM_HALKBANK, "HALKBANK", "low", "keyword1", "RED",
    "guessed HALKBANK on RED keyword; GARANTI also plausible"),

  // --- FINANSBANK matches (17) ----------------------------------------------
  m(5001, "sms", FIRM_FINANSBANK, "FINANSBANK", "high", "keyword1", "SMS"),
  m(5002, "sms", FIRM_FINANSBANK, "FINANSBANK", "high", "msgContent", "Finans kampanya"),
  m(5003, "sms", FIRM_FINANSBANK, "FINANSBANK", "high", "keyword1", "SMS"),
  m(5004, "red", FIRM_FINANSBANK, "FINANSBANK", "high", "keyword1", "RED"),
  m(5005, "red", FIRM_FINANSBANK, "FINANSBANK", "high", "msgContent", "Finans kart iade"),
  m(5006, "hata", FIRM_FINANSBANK, "FINANSBANK", "medium", "keyword1", "HATA"),
  m(5007, "hata", FIRM_FINANSBANK, "FINANSBANK", "high", "msgContent", "Finans uygulama hatasi"),
  m(5008, "hata", FIRM_FINANSBANK, "FINANSBANK", "medium", "keyword1", "HATA"),
  m(5009, "hata", FIRM_FINANSBANK, "FINANSBANK", "high", "msgContent", "Finans islem hatasi"),
  // Garbage cluster: no firm clearly fits → falls to Codec fallback.
  m(5010, "unknown", null, null, "low", "keyword1", "."),
  m(5011, "unknown", null, null, "low", "msgContent", "???"),
  m(5012, "unknown", null, null, "low", "keyword1", "x"),
  m(5013, "unknown", null, null, "low", "msgContent", "asdf"),
  m(5014, "unknown", null, null, "low", "keyword1", "111"),
  m(5015, "unknown", null, null, "low", "keyword1", "ZZZ"),
  m(5016, "unknown", null, null, "low", "msgContent", "iade"),
  // 5017 misattribution: msgContent says "Aktif" → should be AKTIF-BANK, not Codec fallback.
  m(5017, "iptal", null, null, "low", "msgContent", "Aktif kredi hesabimi iptal",
    "keyword1=iptal (no firm tag) and msgContent has 'Aktif' but matched too weakly"),
];

export const DEMO_FIXTURE: MockFixture = {
  customers: CUSTOMERS,
  items: ITEMS,
  matches: MATCHES,
};

// --- In-memory state -------------------------------------------------------

interface ChargeLogEntry {
  accountEuId: string;
  transactionIds: number[];
  at: string;
}

let chargeLog: ChargeLogEntry[] = [];

/** Read the mock's in-memory charge log. Used by tests; harmless in UI. */
export function getMockChargeLog(): readonly ChargeLogEntry[] {
  return chargeLog;
}

/** Test-only: reset the mock's in-memory state between runs. */
export function __resetMockStateForTests(): void {
  chargeLog = [];
}

// --- Wire-shape mock handler -----------------------------------------------

interface MockRequestOpts {
  /** Parsed JSON body the caller would have sent. */
  body?: unknown;
}

/**
 * Returns a real `Response` object for the given admin-panel-api path,
 * mirroring the live backend's wire shape (status, content-type, JSON
 * body). Callers plug this into the same `call()` pipeline that handles
 * real fetch() results — status check, body parsing, error throwing
 * are all exercised identically.
 *
 * Unknown paths return 404 so the caller surfaces a useful ApiError.
 */
export async function mockHandleRequest(
  path: string,
  opts: MockRequestOpts = {},
): Promise<Response> {
  if (path === "/api/Menu3525/GetCustomersToBeCharged") {
    return jsonOk({ resultObject: CUSTOMERS });
  }

  if (path === "/api/Menu3525/GetUnMatchedList") {
    const body = (opts.body ?? {}) as { requestValue?: { keyword1?: string; keyword2?: string; msgcontent?: string; useLikeSearch?: number } };
    const rv = body.requestValue ?? {};
    const useLike = rv.useLikeSearch === 1;
    const k1 = (rv.keyword1 ?? "").trim();
    const k2 = (rv.keyword2 ?? "").trim();
    const mc = (rv.msgcontent ?? "").trim();
    const filtered = ITEMS.filter((it) => {
      if (k1 && !contains(it.keyword1, k1, useLike)) return false;
      if (k2 && !contains(it.keyword2, k2, useLike)) return false;
      if (mc && !contains(it.msgContent, mc, useLike)) return false;
      return true;
    });
    return jsonOk({ resultObject: filtered });
  }

  if (path === "/api/Menu3525/Charged") {
    const body = (opts.body ?? {}) as {
      requestValue?: { accountEuId?: string; transactionIdsWithSubscriptionDate?: number[] };
    };
    const rv = body.requestValue ?? {};
    const accountEuId = rv.accountEuId ?? "";
    const ids = Array.isArray(rv.transactionIdsWithSubscriptionDate)
      ? rv.transactionIdsWithSubscriptionDate
      : [];
    chargeLog.push({
      accountEuId,
      transactionIds: [...ids],
      at: new Date().toISOString(),
    });
    const ok: ChargedResponse = {
      resultObject: true,
      isSuccess: true,
      resultCode: 0,
      resultDetails: "OK (mock)",
      exceptionInformation: null,
    };
    return jsonOk(ok);
  }

  return new Response(`Mock: unknown path ${path}`, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function jsonOk(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function contains(haystack: string, needle: string, like: boolean): boolean {
  if (!needle) return true;
  if (like) return haystack.toLowerCase().includes(needle.toLowerCase());
  return haystack === needle;
}

/** Canned /categorize response payload — used by ai-mock. */
export const DEMO_CATEGORIZE_RESPONSE = {
  model: "demo-mock",
  batches: 1,
  items: MATCHES.length,
  matches: MATCHES,
};
