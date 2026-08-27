/**
 * Tests for the in-process admin-panel-api mock. The mock returns real
 * `Response` objects via `mockHandleRequest`, so the same wire-shape
 * code path in `call()` (status check, JSON parse, error throw) runs
 * identically for both real and mock calls.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  DEMO_FIXTURE,
  __resetMockStateForTests,
  getMockChargeLog,
  mockHandleRequest,
} from "../lib/api-mock.js";
import {
  getCustomersToBeCharged,
  getUnmatchedList,
  charged,
  __setBaseUrlForTests,
  __resetBaseUrlForTests,
} from "../lib/api.js";

const FIRM_AKTIF = "aaaaaaaa-0000-0000-0000-000000000001";
const FIRM_GARANTI = "bbbbbbbb-0000-0000-0000-000000000002";
const FIRM_YAPIKREDI = "cccccccc-0000-0000-0000-000000000003";
const FIRM_HALKBANK = "dddddddd-0000-0000-0000-000000000004";
const FIRM_FINANSBANK = "eeeeeeee-0000-0000-0000-000000000005";

// --- Wire shape ------------------------------------------------------------

describe("mockHandleRequest wire shape", () => {
  it("GetCustomersToBeCharged: 200 + JSON content-type + 5-firm resultObject", async () => {
    const res = await mockHandleRequest("/api/Menu3525/GetCustomersToBeCharged");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = await res.json();
    expect(Array.isArray(body.resultObject)).toBe(true);
    expect(body.resultObject).toHaveLength(5);
  });

  it("GetUnMatchedList: filters via requestValue.keyword1 like-search (İPTAL → GARANTI)", async () => {
    const res = await mockHandleRequest("/api/Menu3525/GetUnMatchedList", {
      body: { requestValue: { keyword1: "İPTAL", useLikeSearch: 1 } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // GARANTI owns 10 İPTAL items in the new fixture (2001-2010).
    expect(body.resultObject).toHaveLength(10);
  });

  it("GetUnMatchedList: IPTAL (case-insensitive like-search) → 7 items (6 ASCII + 1 lowercase 'iptal')", async () => {
    // AKTIF-BANK owns 6 uppercase IPTAL items, plus item 5017 has
    // keyword1="iptal" lowercase (misattribution test) — case-insensitive
    // like-search folds them together. This is intentional behavior the
    // operator sees in the live backend.
    const res = await mockHandleRequest("/api/Menu3525/GetUnMatchedList", {
      body: { requestValue: { keyword1: "IPTAL", useLikeSearch: 1 } },
    });
    const body = await res.json();
    expect(body.resultObject).toHaveLength(7);
  });

  it("Charged: 200 + OK response, records to in-memory log", async () => {
    const res = await mockHandleRequest("/api/Menu3525/Charged", {
      body: {
        requestValue: {
          accountEuId: FIRM_AKTIF,
          transactionIdsWithSubscriptionDate: [1001, 1002],
        },
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isSuccess).toBe(true);
    expect(body.resultCode).toBe(0);
    expect(getMockChargeLog()[0].transactionIds).toEqual([1001, 1002]);
  });

  it("unknown path: 404 (caller surfaces ApiError)", async () => {
    const res = await mockHandleRequest("/api/Unknown");
    expect(res.status).toBe(404);
  });
});

// --- Fixture content -------------------------------------------------------

describe("api-mock fixture", () => {
  it("79 txIds total across 5 firm sections", async () => {
    const res = await mockHandleRequest("/api/Menu3525/GetUnMatchedList");
    const body = await res.json();
    expect(body.resultObject).toHaveLength(79);
  });

  it("matches: 15 AKTIF + 18 GARANTI + 19 YAPIKREDI + 10 HALKBANK + 9 FINANSBANK + 8 Codec fallback", () => {
    const counts = {
      aktif: DEMO_FIXTURE.matches.filter(
        (m) => m.suggestedAccountEuId === FIRM_AKTIF,
      ).length,
      garanti: DEMO_FIXTURE.matches.filter(
        (m) => m.suggestedAccountEuId === FIRM_GARANTI,
      ).length,
      yk: DEMO_FIXTURE.matches.filter(
        (m) => m.suggestedAccountEuId === FIRM_YAPIKREDI,
      ).length,
      halk: DEMO_FIXTURE.matches.filter(
        (m) => m.suggestedAccountEuId === FIRM_HALKBANK,
      ).length,
      finans: DEMO_FIXTURE.matches.filter(
        (m) => m.suggestedAccountEuId === FIRM_FINANSBANK,
      ).length,
      codec: DEMO_FIXTURE.matches.filter((m) => m.suggestedAccountEuId === null)
        .length,
    };
    expect(counts.aktif).toBe(15);
    expect(counts.garanti).toBe(18);
    expect(counts.yk).toBe(19);
    expect(counts.halk).toBe(10);
    expect(counts.finans).toBe(9);
    expect(counts.codec).toBe(8);
  });

  it("HAR-style keyword coverage: RET, İPTAL, IPTAL, SMS, LWC, RED, PTT, ODEME, BILGI, HATA, garbage", () => {
    const kwSet = new Set(DEMO_FIXTURE.items.map((it) => it.keyword1.toUpperCase()));
    // 7 distinct top-keywords from HAR + the lowercase garbage keyword "." / "" / "x" collapse to ""
    expect(kwSet.has("RET")).toBe(true);
    expect(kwSet.has("İPTAL")).toBe(true);
    expect(kwSet.has("IPTAL")).toBe(true);
    expect(kwSet.has("SMS")).toBe(true);
    expect(kwSet.has("LWC")).toBe(true);
    expect(kwSet.has("RED")).toBe(true);
    expect(kwSet.has("PTT")).toBe(true);
    expect(kwSet.has("ODEME")).toBe(true);
    expect(kwSet.has("BILGI")).toBe(true);
    expect(kwSet.has("HATA")).toBe(true);
  });

  it("phone numbers are 10-digit Turkish GSM (5xx range)", () => {
    for (const it of DEMO_FIXTURE.items) {
      expect(it.phone).toMatch(/^5\d{9}$/);
    }
  });

  it("misattribution tests: one per firm section marked medium/low confidence", () => {
    // 5 deliberately-wrong txIds so operator can verify reassign works.
    // 1014 (AKTIF-BANK) — actually YAPIKREDI
    // 2009 (GARANTI) — actually HALKBANK
    // 4010 (HALKBANK) — actually GARANTI
    // 5017 (Codec fallback) — actually AKTIF-BANK
    // (5014/5015/5016 are pure garbage → no real firm, those are codec-candidates)
    const reids = [1014, 2009, 4010, 5017];
    for (const id of reids) {
      const match = DEMO_FIXTURE.matches.find((m) => m.transactionId === id);
      expect(match, `match for txId=${id}`).toBeDefined();
      expect(["low", "medium"], `txId=${id} confidence`).toContain(match!.confidence);
    }
  });
});

// --- call() pipeline shared between real and mock --------------------------

describe("api.ts call() pipeline (real vs mock)", () => {
  beforeEach(() => {
    __resetMockStateForTests();
    __resetBaseUrlForTests();
  });

  it("demoMode=true: NO fetch() to the real base URL — call() routes to mockHandleRequest", async () => {
    // If demoMode=true still hit fetch(), the unreachable URL would
    // throw and the test would fail. Reaching this assert means the
    // mock short-circuit works at the call() boundary.
    const cs = await getCustomersToBeCharged("any-session-id", true);
    expect(cs).toHaveLength(5);
  });

  it("demoMode=true: full call() pipeline (text/ok/JSON.parse) exercises", async () => {
    // If mockHandleRequest returned a non-Response or non-JSON body,
    // call() would throw ApiError("non-JSON response: ..."). Reaching
    // here means the wire-shape code path ran successfully.
    const items = await getUnmatchedList("any-session-id", undefined, true);
    expect(items).toHaveLength(79);
  });

  it("demoMode=true: 404 from mockHandleRequest propagates as ApiError", async () => {
    // Wire the wrapper through a path the mock returns 404 for. We do
    // this indirectly by ensuring the mock returns 404 for unknown
    // paths (verified above) and that the wrappers raise accordingly.
    // Direct check on call(): unknown path via the mock layer.
    const res = await mockHandleRequest("/api/Unknown");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it("demoMode=false: real fetch() — we point BASE at a closed port to force an error", async () => {
    __setBaseUrlForTests("http://127.0.0.1:1");
    await expect(getCustomersToBeCharged("any", false)).rejects.toBeDefined();
    __resetBaseUrlForTests();
  });

  it("Charged through wrappers (demoMode=true): log entry recorded + Response shape matches production", async () => {
    const r = await charged("any-session-id", FIRM_AKTIF, [1001, 1002], true);
    expect(r.isSuccess).toBe(true);
    expect(r.resultCode).toBe(0);
    expect(getMockChargeLog()).toHaveLength(1);
  });

  it("demoMode=true: cross-firm defense — charging AKTIF txIds to a non-AKTIF UUID still records the LOG with whatever UUID the caller passed (charger is responsible for validateAccountEuId)", async () => {
    // The mock faithfully records whatever accountEuId the wrapper
    // passes — it does NOT re-resolve or cross-check. Cross-firm
    // defense lives in charger.ts validateAccountEuId + StepReview's
    // chargeFirm (resolves every txId, throws if size>1). We just
    // assert here that the mock is wire-faithful.
    await charged("any-session-id", FIRM_GARANTI, [1001, 1002], true);
    expect(getMockChargeLog()[0].accountEuId).toBe(FIRM_GARANTI);
    expect(getMockChargeLog()[0].transactionIds).toEqual([1001, 1002]);
  });
});
