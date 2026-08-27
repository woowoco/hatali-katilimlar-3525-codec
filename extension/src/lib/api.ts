import type {
  ChargedResponse,
  Customer,
  UnmatchedItem,
} from "../types.js";
import { mockHandleRequest } from "./api-mock.js";

const APP_ID = "9398192ec61d422a8331529989959242";
const DEFAULT_BASE = "https://admin-panel-api.codec.com.tr";

// BASE is module-level so we can swap it for tests without re-architecting
// every caller. Production code never touches this — only test setup does,
// via __setBaseUrlForTests().
let BASE = DEFAULT_BASE;

/** Test-only hook. Do not call from production code. */
export function __setBaseUrlForTests(url: string) {
  BASE = url;
}

export function __resetBaseUrlForTests() {
  BASE = DEFAULT_BASE;
}

class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`HTTP ${status}: ${body.slice(0, 240)}`);
    this.status = status;
    this.body = body;
  }
}

interface FetchOpts {
  sessionId: string;
  body?: unknown;
  /** When true, sets Content-Length: 0 and skips body — for endpoints with no payload. */
  emptyBody?: boolean;
  /**
   * Demo mode: route through api-mock.ts instead of fetch(). Wire shape
   * is identical (real Response object, status, content-type, JSON body
   * all match production) — only the network call is skipped. Defaults
   * to false; the wrappers always pass it explicitly.
   */
  demoMode?: boolean;
}

/**
 * Single pipeline for both real and demo-mode calls. Builds the same
 * headers / body shape, then either issues a real `fetch()` or asks the
 * in-process mock for a `Response`. The downstream `res.text()`,
 * `res.ok`, `JSON.parse`, and error throwing run identically for both
 * paths — that's the whole point of routing through here even in mock
 * mode (so any wire-shape change here is reflected in mock responses
 * too).
 */
async function call<TPath>(path: string, opts: FetchOpts): Promise<TPath> {
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    appid: APP_ID,
    sessionid: opts.sessionId,
    origin: "https://admin-panel.codec.com.tr",
    referer: "https://admin-panel.codec.com.tr/",
  };

  let body: BodyInit | undefined;
  if (!opts.emptyBody) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body ?? {});
  } else {
    headers["content-length"] = "0";
  }

  let res: Response;
  if (opts.demoMode) {
    // Mock ignores the auth headers but we still build them so the call
    // site exercises the same header-construction code path.
    res = await mockHandleRequest(path, { body: opts.body });
  } else {
    if (!opts.sessionId) {
      throw new Error("sessionId boş — Ayarlar sekmesinden gir.");
    }
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers,
      body,
    });
  }

  const text = await res.text();
  if (!res.ok) {
    throw new ApiError(res.status, text);
  }
  try {
    return JSON.parse(text) as TPath;
  } catch {
    throw new ApiError(res.status, `non-JSON response: ${text.slice(0, 200)}`);
  }
}

// --- Wrappers --------------------------------------------------------------

interface CustomerListResponse {
  resultObject: Customer[];
}
interface UnmatchedListResponse {
  resultObject: UnmatchedItem[];
}

export async function getCustomersToBeCharged(
  sessionId: string,
  demoMode = false,
): Promise<Customer[]> {
  const r = await call<CustomerListResponse>(
    "/api/Menu3525/GetCustomersToBeCharged",
    { sessionId, emptyBody: true, demoMode },
  );
  return r.resultObject ?? [];
}

export async function getUnmatchedList(
  sessionId: string,
  filter?: {
    keyword1?: string;
    keyword2?: string;
    msgContent?: string;
  },
  demoMode = false,
): Promise<UnmatchedItem[]> {
  const r = await call<UnmatchedListResponse>(
    "/api/Menu3525/GetUnMatchedList",
    {
      sessionId,
      body: {
        requestValue: {
          keyword1: filter?.keyword1 ?? "",
          keyword2: filter?.keyword2 ?? "",
          msgcontent: filter?.msgContent ?? "",
          useLikeSearch: 1,
        },
      },
      demoMode,
    },
  );
  return r.resultObject ?? [];
}

/**
 * Charge one or more transactions to a firm. The backend accepts an array —
 * observed in the HAR (call #5 had 26 IDs, call #7 had 50+). We still keep
 * the operation manual: this function is only ever called when the operator
 * clicks "Charge" on a specific row in the table. No automatic / scheduled
 * triggers exist.
 */
export async function charged(
  sessionId: string,
  accountEuId: string,
  transactionIds: number[],
  demoMode = false,
): Promise<ChargedResponse> {
  return call<ChargedResponse>("/api/Menu3525/Charged", {
    sessionId,
    body: {
      requestValue: {
        accountEuId,
        transactionIdsWithSubscriptionDate: transactionIds,
      },
    },
    demoMode,
  });
}

export { ApiError };