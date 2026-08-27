/**
 * Mock server simulating admin-panel-api.codec.com.tr.
 *
 * Used by extension tests and for local manual testing. NEVER accidentally
 * points at the live backend — it binds to localhost only and reads no
 * credentials.
 *
 * Start:      npm run mock:backend
 * Test (e2e): see ai-proxy/src/__tests__/e2e.test.ts which imports createApp()
 *             and runs the full mock flow against an in-process listener.
 */
import "dotenv/config";
import cors from "cors";
import express, { type Express } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";

interface MockFixture {
  customers: Array<{ name: string; acntEuId: string }>;
  items: Array<{
    transactionId: number;
    phone: string;
    keyword1: string;
    keyword2: string;
    msgContent: string;
    shortCode: string;
    msgDate: string;
    id: string;
  }>;
}

const DEFAULT_HAR_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "Users",
  "TGA",
  "Desktop",
  "admin-panel.codec.com.tr.har",
);

export function loadFixtures(harPath?: string): MockFixture {
  let customers: MockFixture["customers"] = [];
  let items: MockFixture["items"] = [];

  const path = harPath ?? process.env.MOCK_HAR_PATH ?? DEFAULT_HAR_PATH;

  try {
    const har = JSON.parse(readFileSync(path, "utf-8")) as {
      log: {
        entries: Array<{
          request: { url: string; method: string };
          response: { content: { text: string } };
        }>;
      };
    };
    for (const e of har.log.entries) {
      if (!e.request.url.includes("admin-panel-api")) continue;
      if (e.request.method === "OPTIONS") continue;
      const text = e.response?.content?.text ?? "";
      try {
        const parsed = JSON.parse(text);
        if (parsed.resultObject && Array.isArray(parsed.resultObject)) {
          if (e.request.url.endsWith("/GetCustomersToBeCharged")) {
            customers = parsed.resultObject;
          } else if (e.request.url.endsWith("/GetUnMatchedList")) {
            const seen = new Set<number>();
            for (const it of parsed.resultObject as Array<{ transactionId: number }>) {
              if (!seen.has(it.transactionId)) {
                seen.add(it.transactionId);
                items.push(it as MockFixture["items"][number]);
              }
            }
          }
        }
      } catch {
        // not JSON, skip
      }
    }
  } catch (err) {
    if (!process.env.MOCK_QUIET) {
      console.warn(`[mock] could not load HAR at ${path}: ${err}`);
      console.warn("[mock] falling back to inline tiny fixture");
    }
    customers = [
      { name: "TEST-FIRM-A ---- Test Firm A", acntEuId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
      { name: "TEST-FIRM-B ---- Test Firm B", acntEuId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" },
    ];
    items = [
      {
        transactionId: 900001,
        phone: "5550000001",
        keyword1: "IPTAL",
        keyword2: "",
        msgContent: "",
        shortCode: "3525",
        msgDate: "2026-08-20T10:00:00",
        id: "900001|20.08.2026 10:00:00",
      },
    ];
  }

  return { customers, items };
}

const APP_ID = "9398192ec61d422a8331529989959242";

export interface MockState {
  customers: MockFixture["customers"];
  items: MockFixture["items"];
  chargedLog: Array<{ accountEuId: string; transactionIds: number[]; at: string }>;
}

export function createApp(fixtures: MockFixture): { app: Express; state: MockState } {
  const state: MockState = {
    customers: fixtures.customers,
    items: fixtures.items,
    chargedLog: [],
  };

  const app = express();
  app.use(cors({ origin: "*" }));
  app.use(express.json({ limit: "8mb" }));

  app.post("/api/Menu3525/GetCustomersToBeCharged", (req, res) => {
    if (rejectIfMissingAuth(req, res)) return;
    res.json({ resultObject: state.customers });
  });

  app.post("/api/Menu3525/GetUnMatchedList", (req, res) => {
    if (rejectIfMissingAuth(req, res)) return;
    const filter = (req.body?.requestValue ?? {}) as {
      keyword1?: string;
      keyword2?: string;
      msgContent?: string;
      useLikeSearch?: number;
    };
    const useLike = filter.useLikeSearch === 1;
    const matches = state.items.filter((it) => {
      if (filter.keyword1 && !contains(it.keyword1, filter.keyword1, useLike)) return false;
      if (filter.keyword2 && !contains(it.keyword2, filter.keyword2, useLike)) return false;
      if (filter.msgContent && !contains(it.msgContent, filter.msgContent, useLike))
        return false;
      return true;
    });
    res.json({ resultObject: matches });
  });

  app.post("/api/Menu3525/Charged", (req, res) => {
    if (rejectIfMissingAuth(req, res)) return;
    const rv = req.body?.requestValue ?? {};
    const ids = Array.isArray(rv.transactionIdsWithSubscriptionDate)
      ? rv.transactionIdsWithSubscriptionDate
      : [];
    const accountEuId = rv.accountEuId ?? "";
    state.chargedLog.push({
      accountEuId,
      transactionIds: ids,
      at: new Date().toISOString(),
    });
    res.json({
      resultObject: true,
      isSuccess: true,
      resultCode: 0,
      resultDetails: "OK",
      exceptionInformation: null,
    });
  });

  // --- Debug endpoints (mock-only) ------------------------------------------

  app.get("/__mock/charged-log", (_req, res) => {
    res.json(state.chargedLog);
  });

  app.get("/__mock/health", (_req, res) => {
    res.json({
      ok: true,
      customers: state.customers.length,
      items: state.items.length,
      charged: state.chargedLog.length,
    });
  });

  return { app, state };
}

function contains(haystack: string, needle: string, like: boolean): boolean {
  if (!needle) return true;
  if (like) return haystack.toLowerCase().includes(needle.toLowerCase());
  return haystack === needle;
}

function rejectIfMissingAuth(
  req: express.Request,
  res: express.Response,
): boolean {
  if (req.headers.appid !== APP_ID) {
    res.status(401).json({ error: "missing appid" });
    return true;
  }
  if (!req.headers.sessionid) {
    res.status(401).json({ error: "missing sessionid" });
    return true;
  }
  return false;
}

// --- CLI entry: `npm run mock:backend` -------------------------------------
const isCLI = (() => {
  if (!process.argv[1]) return false;
  return process.argv[1].endsWith("mock-server.ts");
})();

if (isCLI) {
  const PORT = Number(process.env.MOCK_PORT ?? 8788);
  const { app } = createApp(loadFixtures());
  app.listen(PORT, () => {
    console.log(`[mock] http://localhost:${PORT}`);
    console.log(`[mock]   POST /api/Menu3525/GetCustomersToBeCharged`);
    console.log(`[mock]   POST /api/Menu3525/GetUnMatchedList`);
    console.log(`[mock]   POST /api/Menu3525/Charged`);
    console.log(`[mock]   GET  /__mock/health`);
    console.log(`[mock]   GET  /__mock/charged-log`);
  });
}

/** Helper for tests: start a server on an ephemeral port and resolve to its URL. */
export function startOnRandomPort(app: Express): Promise<{
  url: string;
  server: Server;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("could not bind ephemeral port");
      }
      const url = `http://127.0.0.1:${addr.port}`;
      resolve({
        url,
        server,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
