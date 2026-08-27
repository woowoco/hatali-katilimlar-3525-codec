/**
 * Read-only smoke test against the live MiniMax proxy.
 *
 *   1. Fetches customers + unmatched items from the production admin-panel API
 *      using a real session id (no charging, just GET-equivalents).
 *   2. Streams /categorize from the local proxy and prints per-batch progress
 *      + total wall-clock time + match count.
 *
 *   tsx scripts/live-categorize-test.ts <sessionId> [batchSize] [maxBatches]
 *
 *   Defaults: batchSize=25, maxBatches=2 (i.e. only the first ~50 items) so
 *   the script completes in well under a minute and we can see whether the
 *   upstream is slow per-call or has other issues.
 */
import { config as loadEnv } from "dotenv";
loadEnv();

const SESSION_ID = process.argv[2];
const BATCH_SIZE = Number(process.argv[3] ?? 25);
const MAX_BATCHES = Number(process.argv[4] ?? 2);
const PROXY = process.env.PROXY_URL ?? "http://localhost:8787";
const ADMIN = "https://admin-panel-api.codec.com.tr";

if (!SESSION_ID) {
  console.error("usage: tsx scripts/live-categorize-test.ts <sessionId> [batchSize] [maxBatches]");
  process.exit(2);
}

const APP_ID = "9398192ec61d422a8331529989959242";

interface Customer { acntEuId: string; name: string }
interface UnmatchedItem {
  transactionId: number;
  phone: string;
  keyword1: string;
  keyword2: string;
  msgContent: string;
}

async function postJson<T>(path: string, body?: unknown, emptyBody = false): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    appid: APP_ID,
    sessionid: SESSION_ID!,
    origin: "https://admin-panel.codec.com.tr",
    referer: "https://admin-panel.codec.com.tr/",
  };
  let payload: BodyInit | undefined;
  if (!emptyBody) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body ?? {});
  } else {
    headers["content-length"] = "0";
  }
  const res = await fetch(`${ADMIN}${path}`, { method: "POST", headers, body: payload });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${text.slice(0, 240)}`);
  return JSON.parse(text) as T;
}

async function main() {
  console.log(`[test] sessionId=${SESSION_ID} proxy=${PROXY} batchSize=${BATCH_SIZE} maxBatches=${MAX_BATCHES}`);

  const t0 = Date.now();
  const customersRes = await postJson<{ resultObject: Customer[] }>(
    "/api/Menu3525/GetCustomersToBeCharged",
    undefined,
    true,
  );
  const customers = customersRes.resultObject ?? [];
  console.log(`[test] customers: ${customers.length} (${Date.now() - t0}ms)`);

  const t1 = Date.now();
  const itemsRes = await postJson<{ resultObject: UnmatchedItem[] }>(
    "/api/Menu3525/GetUnMatchedList",
    { requestValue: { keyword1: "", keyword2: "", msgcontent: "", useLikeSearch: 1 } },
  );
  const allItems = itemsRes.resultObject ?? [];
  console.log(`[test] unmatched items total: ${allItems.length} (${Date.now() - t1}ms)`);

  const limited = allItems.slice(0, BATCH_SIZE * MAX_BATCHES);
  console.log(`[test] will process ${limited.length} items across ${Math.ceil(limited.length / BATCH_SIZE)} batches`);

  // Stream /categorize from local proxy.
  const startMs = Date.now();
  const res = await fetch(`${PROXY}/categorize`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ items: limited, customers, model: process.env.PROXY_DEFAULT_MODEL ?? "MiniMax-M3" }),
  });

  if (!res.ok) {
    const t = await res.text();
    console.error(`[test] proxy HTTP ${res.status}: ${t.slice(0, 600)}`);
    process.exit(1);
  }
  if (!res.body) {
    console.error("[test] proxy returned no body");
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let matches = 0;
  let batches = 0;
  const errors: string[] = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const field = line.slice(0, colon);
        let val = line.slice(colon + 1);
        if (val.startsWith(" ")) val = val.slice(1);
        if (field === "event") event = val;
        else if (field === "data") data += (data ? "\n" : "") + val;
      }
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      try { data = JSON.parse(data); } catch { /* leave as string */ }
      if (event === "batch-start") {
        const d = data as { i: number; total: number; size: number };
        console.log(`[test] +${elapsed}s  batch-start  i=${d.i} total=${d.total} size=${d.size}`);
      } else if (event === "batch-done") {
        const d = data as { i: number; total: number; matches: number; accumulated: number };
        batches++;
        console.log(`[test] +${elapsed}s  batch-done   i=${d.i} matches=${d.matches} accumulated=${d.accumulated}`);
      } else if (event === "done") {
        const d = data as { model: string; batches: number; matches: unknown[] };
        matches = d.matches.length;
        console.log(`[test] +${elapsed}s  done         model=${d.model} batches=${d.batches} matches=${matches}`);
      } else if (event === "error") {
        const d = data as { error: string };
        errors.push(d.error);
        console.error(`[test] +${elapsed}s  ERROR        ${d.error.slice(0, 400)}`);
      } else if (event === "comment") {
        /* heartbeat */
      } else {
        console.log(`[test] +${elapsed}s  ${event}  ${JSON.stringify(data).slice(0, 200)}`);
      }
    }
  }

  const totalSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`\n[test] === summary ===`);
  console.log(`[test] total wall:  ${totalSec}s`);
  console.log(`[test] batches ok:  ${batches}`);
  console.log(`[test] matches:     ${matches}`);
  console.log(`[test] errors:      ${errors.length}`);
  if (errors.length) {
    for (const e of errors) console.log(`[test]   • ${e}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[test] fatal:", err);
  process.exit(1);
});
