import type {
  ChargedResponse,
  Customer,
  UnmatchedItem,
} from "../types.js";

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
}

async function call<TPath>(path: string, opts: FetchOpts): Promise<TPath> {
  if (!opts.sessionId) {
    throw new Error("sessionId boş — Ayarlar sekmesinden gir.");
  }
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

  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers,
    body,
  });

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
): Promise<Customer[]> {
  const r = await call<CustomerListResponse>(
    "/api/Menu3525/GetCustomersToBeCharged",
    { sessionId, emptyBody: true },
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
): Promise<ChargedResponse> {
  return call<ChargedResponse>("/api/Menu3525/Charged", {
    sessionId,
    body: {
      requestValue: {
        accountEuId,
        transactionIdsWithSubscriptionDate: transactionIds,
      },
    },
  });
}

export { ApiError };