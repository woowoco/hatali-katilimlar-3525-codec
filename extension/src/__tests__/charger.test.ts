import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetBaseUrlForTests,
  __setBaseUrlForTests,
} from "../lib/api.js";
import { chargeOnce, logRowNote } from "../lib/charger.js";
import { loadAudit } from "../lib/store.js";
import { installChromeMock } from "./chrome-mock.js";

/**
 * charger.ts does its network via src/lib/api.ts's `charged()` helper.
 * We mock globalThis.fetch so we never hit the real backend. The mock
 * responds to ANY /Charged POST with a body we control per-test.
 *
 * We also pin the base URL to localhost via __setBaseUrlForTests(); the
 * live-guard then happily allows the requests.
 */

interface FetchRoute {
  pattern: RegExp;
  status: number;
  body: unknown;
}

function installFetchMock(routes: FetchRoute[]) {
  globalThis.fetch = vi.fn(async (input: Request | URL | string) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const matched = routes.find((r) => r.pattern.test(url));
    if (!matched) {
      return new Response(JSON.stringify({ error: "no mock" }), {
        status: 599,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(matched.body), {
      status: matched.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

const TEST_BASE = "http://localhost:8788";
const CHARGED_URL = /\/api\/Menu3525\/Charged$/i;

beforeEach(() => {
  installChromeMock().__clear();
  __setBaseUrlForTests(TEST_BASE);
});
afterEach(() => {
  __resetBaseUrlForTests();
});

beforeEach(() => {
  installChromeMock().__clear();
});
afterEach(() => {
  // restore original fetch (live-guard re-wraps it on next test)
});

describe("chargeOnce", () => {
  it("sends ONE POST with the full transactionIds array", async () => {
    const captured: Array<{ url: string; body: unknown }> = [];
    installFetchMock([
      {
        pattern: CHARGED_URL,
        status: 200,
        body: { resultObject: true, isSuccess: true, resultCode: 0, resultDetails: "OK", exceptionInformation: null },
      },
    ]);
    // Re-wrap to also capture the body
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      const body =
        init?.body && typeof init.body === "string" ? JSON.parse(init.body) : init?.body;
      captured.push({ url, body });
      return new Response(
        JSON.stringify({
          resultObject: true,
          isSuccess: true,
          resultCode: 0,
          resultDetails: "OK",
          exceptionInformation: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await chargeOnce("sess-1", "firm-uuid-0000-0000-0000-000000000001", "Firm A", [11, 12, 13], "iptal");
    expect(res.ok).toBe(true);
    expect(res.record.status).toBe("success");
    expect(res.record.transactionIds).toEqual([11, 12, 13]);
    expect(captured).toHaveLength(1);
    const sent = captured[0];
    // Wire shape mirrors the HAR: nested under requestValue.
    expect(sent.body).toMatchObject({
      requestValue: {
        accountEuId: "firm-uuid-0000-0000-0000-000000000001",
        transactionIdsWithSubscriptionDate: [11, 12, 13],
      },
    });
  });

  it("records an error result when server returns isSuccess=false", async () => {
    installFetchMock([
      {
        pattern: CHARGED_URL,
        status: 200,
        body: { resultObject: false, isSuccess: false, resultCode: 42, resultDetails: "BUGÜN DEĞİL", exceptionInformation: null },
      },
    ]);
    const res = await chargeOnce("sess-1", "firm-uuid-0000-0000-0000-000000000001", null, [99], "iptal");
    expect(res.ok).toBe(false);
    expect(res.record.status).toBe("error");
    expect(res.record.resultCode).toBe(42);
    expect(res.record.resultDetails).toBe("BUGÜN DEĞİL");
  });

  it("records an error result when fetch throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const res = await chargeOnce("sess-1", "firm-uuid-0000-0000-0000-000000000001", null, [5], "iptal");
    expect(res.ok).toBe(false);
    expect(res.record.status).toBe("error");
    expect(res.record.resultDetails).toMatch(/network down/);
    expect(res.record.resultCode).toBeNull();
  });

  it("deduplicates and filters non-integer ids before sending", async () => {
    const captured: Array<{ body: unknown }> = [];
    globalThis.fetch = vi.fn(async (_input, init) => {
      const body =
        init?.body && typeof init.body === "string" ? JSON.parse(init.body) : init?.body;
      captured.push({ body });
      return new Response(
        JSON.stringify({
          resultObject: true,
          isSuccess: true,
          resultCode: 0,
          resultDetails: "OK",
          exceptionInformation: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const res = await chargeOnce(
      "sess-1",
      "firm-uuid-0000-0000-0000-000000000001",
      null,
      [1, 1, 1, 2, 3, NaN as unknown as number],
      "iptal",
    );
    expect(res.ok).toBe(true);
    expect(captured[0].body).toMatchObject({
      requestValue: { transactionIdsWithSubscriptionDate: [1, 2, 3] },
    });
    expect(res.record.transactionIds).toEqual([1, 2, 3]);
  });

  it("refuses to call when no valid ids are provided", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(chargeOnce("sess-1", "firm-uuid-0000-0000-0000-000000000001", null, [])).rejects.toThrow(
      /no transactionIds/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------
  // Regression: `accountEuId` "null" (the LLM emits the 4-char string)
  // used to slip all the way to the network and the server rejected it
  // with a GUID validation error. `chargeOnce` is the LAST guard before
  // talking to the wire — it must refuse to POST a malformed value.
  // ---------------------------------------------------------------------

  it('refuses to POST when accountEuId is the literal string "null"', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(
      chargeOnce("sess-1", "null", "Firm A", [1]),
    ).rejects.toThrow(/literal "null" string/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses to POST when accountEuId is empty string", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(
      chargeOnce("sess-1", "", "Firm A", [1]),
    ).rejects.toThrow(/boş string/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses to POST when accountEuId is whitespace-only", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(
      chargeOnce("sess-1", "   ", "Firm A", [1]),
    ).rejects.toThrow(/boş string/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses to POST when accountEuId is shorter than a UUID", async () => {
    // Anything below 32 chars can't be a UUID — refuse it so we don't
    // round-trip a value the server can only reject with a GUID error.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(
      chargeOnce("sess-1", "short", "Firm A", [1]),
    ).rejects.toThrow(/UUID kadar uzun değil/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a normal UUID-shaped accountEuId and POSTs it through", async () => {
    installFetchMock([
      {
        pattern: CHARGED_URL,
        status: 200,
        body: { resultObject: true, isSuccess: true, resultCode: 0, resultDetails: "OK", exceptionInformation: null },
      },
    ]);
    const ok = "00000000-0000-0000-0000-000000000000";
    const res = await chargeOnce("sess-1", ok, "Codec", [1, 2]);
    expect(res.ok).toBe(true);
  });

  it("appends an audit record for every call (success or error)", async () => {
    installFetchMock([
      {
        pattern: CHARGED_URL,
        status: 200,
        body: { resultObject: true, isSuccess: true, resultCode: 0, resultDetails: "OK", exceptionInformation: null },
      },
    ]);
    await chargeOnce("sess-1", "firm-uuid-0000-0000-0000-000000000001", null, [1]);
    let log = await loadAudit();
    expect(log).toHaveLength(1);
    expect(log[0].transactionIds).toEqual([1]);
    expect(log[0].status).toBe("success");

    globalThis.fetch = vi.fn(async () => {
      throw new Error("nope");
    }) as typeof fetch;
    await chargeOnce("sess-1", "firm-uuid-0000-0000-0000-000000000001", null, [2]);
    log = await loadAudit();
    expect(log).toHaveLength(2);
    expect(log[1].status).toBe("error");
  });
});

describe("logRowNote", () => {
  it("writes a no-op audit entry tagged with the row label", async () => {
    await logRowNote("iptal-cancel", "manual rerun after delay");
    const log = await loadAudit();
    expect(log).toHaveLength(1);
    expect(log[0].accountName).toBe("iptal-cancel");
    expect(log[0].transactionIds).toEqual([]);
    expect(log[0].status).toBe("success");
    expect(log[0].resultDetails).toBe("manual rerun after delay");
    // No fetch happened (note-only).
  });
});
