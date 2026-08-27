/**
 * End-to-end mock-only flow.
 *
 * Brings up the mock backend in-process on a random localhost port, then
 * exercises the real extension + categorize pipeline against it. NO live
 * calls — both the proxy SDK and the charge API are pinned to localhost.
 *
 * The point of this test is twofold:
 *  1. Prove the full mock flow works (fetch → analyze → review → charge).
 *  2. Assert that nothing charges itself — the only POST to /Charged comes
 *     from an explicit `chargeOnce()` call. This is the structural guard
 *     for the "no automatic charging" requirement.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, loadFixtures, startOnRandomPort } from "../ai-proxy/src/mock-server.js";
import { categorize } from "../ai-proxy/src/categorize.js";
import { buildKeywordRows } from "../extension/src/lib/ai.js";
import { chargeOnce } from "../extension/src/lib/charger.js";
import { installChromeMock } from "../extension/src/__tests__/chrome-mock.js";
import {
  __resetBaseUrlForTests,
  __setBaseUrlForTests,
} from "../extension/src/lib/api.js";
import type {
  Customer,
  ItemMatch,
  UnmatchedItem,
} from "../ai-proxy/src/types.js";
import { CODEC_ACCOUNT_EU_ID } from "../ai-proxy/src/types.js";

const APP_ID = "9398192ec61d422a8331529989959242";
const SESSION_ID = "test-sess-e2e";

function makeItem(id: number, kw1: string, kw2: string): UnmatchedItem {
  return {
    transactionId: id,
    phone: "555",
    keyword1: kw1,
    keyword2: kw2,
    msgContent: "",
    shortCode: "3525",
    msgDate: "2026-08-20T10:00:00",
    id: `${id}|20.08.2026 10:00:00`,
  };
}

function fakeAnthropic(
  plan: (items: UnmatchedItem[]) => ItemMatch[],
  itemsByCall: { current: UnmatchedItem[] },
): unknown {
  return {
    messages: {
      create: async (_req: unknown) => {
        const matches = plan(itemsByCall.current);
        return {
          model: "MiniMax-M3",
          content: [
            {
              type: "tool_use",
              id: "tool-1",
              name: "item_annotations",
              input: { matches },
            },
          ],
        };
      },
    },
  };
}

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

let mockUrl = "";
let closeMock: () => Promise<void>;
let state: {
  chargedLog: Array<{ accountEuId: string; transactionIds: number[]; at: string }>;
};

beforeAll(async () => {
  process.env.MOCK_QUIET = "1"; // silence HAR fallback noise during tests
  const fixtures = loadFixtures();
  fixtures.customers = [
    {
      name: "ACME-MOBILE ---- Acme Mobile Inc.",
      acntEuId: "11111111-1111-1111-1111-111111111111",
    },
    {
      name: "FOO-BAR ---- Foo Bar Co.",
      acntEuId: "22222222-2222-2222-2222-222222222222",
    },
  ];
  fixtures.items = [
    makeItem(1, "IPTAL", ""),
    makeItem(2, "IPTAL", ""),
    makeItem(3, "ODEME", ""),
    makeItem(4, "ODEME", ""),
    makeItem(5, "?", ""),
  ];

  const built = createApp(fixtures);
  state = built.state;
  const started = await startOnRandomPort(built.app);
  mockUrl = started.url;
  closeMock = started.close;
  installChromeMock().__clear();
});

afterAll(async () => {
  await closeMock();
  __resetBaseUrlForTests();
});

describe("end-to-end mock flow", () => {
  it("fetches → analyzes → builds rows → charges (only when explicitly told)", async () => {
    __setBaseUrlForTests(mockUrl);

    // 1. Fetch from the mock backend.
    const customers = (await fetchJson(`${mockUrl}/api/Menu3525/GetCustomersToBeCharged`, {
      method: "POST",
      headers: { appid: APP_ID, sessionid: SESSION_ID, "content-length": "0" },
    })).resultObject as Customer[];
    expect(customers).toHaveLength(2);

    const items = (await fetchJson(`${mockUrl}/api/Menu3525/GetUnMatchedList`, {
      method: "POST",
      headers: {
        appid: APP_ID,
        sessionid: SESSION_ID,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestValue: {
          keyword1: "",
          keyword2: "",
          msgcontent: "",
          useLikeSearch: 1,
        },
      }),
    })).resultObject as UnmatchedItem[];
    expect(items).toHaveLength(5);

    // 2. AI categorization with a fake (read-only) planner.
    const firmAcme = customers[0].acntEuId;
    const firmFoo = customers[1].acntEuId;
    const plan = (its: UnmatchedItem[]): ItemMatch[] =>
      its.map((it) => {
        if (it.keyword1 === "IPTAL")
          return {
            transactionId: it.transactionId,
            matchedField: "keyword1",
            matchedValue: "IPTAL",
            keywordGroup: "iptal",
            suggestedAccountEuId: firmAcme,
            suggestedAccountName: customers[0].name,
            confidence: "high",
            reasoning: "kelime iptal",
          };
        if (it.keyword1 === "ODEME")
          return {
            transactionId: it.transactionId,
            matchedField: "keyword1",
            matchedValue: "ODEME",
            keywordGroup: "odeme",
            suggestedAccountEuId: firmFoo,
            suggestedAccountName: customers[1].name,
            confidence: "high",
            reasoning: "kelime odeme",
          };
        return {
          transactionId: it.transactionId,
          matchedField: "keyword1",
          matchedValue: ".",
          keywordGroup: "unknown",
          suggestedAccountEuId: null,
          suggestedAccountName: null,
          confidence: "low",
          reasoning: "anlamsiz",
        };
      });

    const aiResult = await categorize(
      fakeAnthropic(plan, { current: items }) as never,
      { items, customers, model: "MiniMax-M3" },
    );
    expect(aiResult.matches).toHaveLength(5);

    // 3. Build keyword rows.
    const rows = buildKeywordRows(aiResult.matches, new Set());
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.group === "iptal")!.matches).toHaveLength(2);
    expect(rows.find((r) => r.group === "odeme")!.matches).toHaveLength(2);
    const codec = rows.find((r) => r.group === "__codec_fallback__");
    expect(codec).toBeDefined();
    expect(codec!.matches).toHaveLength(1);
    expect(codec!.suggestedAccountEuId).toBe(CODEC_ACCOUNT_EU_ID);

    // 4. Critical safety assertion: NOTHING has been charged yet.
    const logBefore = await fetchJson(`${mockUrl}/__mock/charged-log`);
    expect(logBefore).toEqual([]);
    expect(state.chargedLog).toEqual([]);

    // 5. Operator explicitly clicks "Tümünü ücretlendir" on the IPTAL row.
    const iptalRow = rows.find((r) => r.group === "iptal")!;
    const iptalIds = iptalRow.matches.map((m) => m.transactionId);
    const acmeCharge = await chargeOnce(
      SESSION_ID,
      iptalRow.suggestedAccountEuId!,
      iptalRow.suggestedAccountName,
      iptalIds,
      "iptal",
    );
    expect(acmeCharge.ok).toBe(true);

    // 6. Operator also chooses to charge the Codec fallback row.
    const codecRow = rows.find((r) => r.group === "__codec_fallback__")!;
    const codecIds = codecRow.matches.map((m) => m.transactionId);
    const codecCharge = await chargeOnce(
      SESSION_ID,
      codecRow.suggestedAccountEuId!,
      codecRow.suggestedAccountName,
      codecIds,
      "codec-fallback",
    );
    expect(codecCharge.ok).toBe(true);

    // 7. ODEME row is intentionally NOT charged.
    const logAfter = await fetchJson(`${mockUrl}/__mock/charged-log`);
    expect(logAfter).toHaveLength(2);

    const toFirm = logAfter.find(
      (l: { accountEuId: string }) => l.accountEuId === firmAcme,
    );
    expect(toFirm).toBeDefined();
    expect(toFirm.transactionIds).toEqual([1, 2]);

    const toCodec = logAfter.find(
      (l: { accountEuId: string }) => l.accountEuId === CODEC_ACCOUNT_EU_ID,
    );
    expect(toCodec).toBeDefined();
    expect(toCodec.transactionIds).toEqual([5]);

    // ODEME row's firm must NOT appear in the log: operator didn't click it.
    const toFoo = logAfter.find(
      (l: { accountEuId: string }) => l.accountEuId === firmFoo,
    );
    expect(toFoo).toBeUndefined();
  });

  it("rejects requests without the appid header", async () => {
    const res = await fetch(`${mockUrl}/api/Menu3525/GetCustomersToBeCharged`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });
});
