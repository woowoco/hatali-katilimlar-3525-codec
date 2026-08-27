/**
 * Probe what batch size the upstream MiniMax API actually accepts.
 * Same read-only data fetch, but processes a single batch of `n` items and
 * reports wall-clock time + whether it completed.
 *
 *   tsx scripts/probe-batch-latency.ts <sessionId> <n>
 */
import { config as loadEnv } from "dotenv";
loadEnv();

const SESSION_ID = process.argv[2];
const N = Number(process.argv[3] ?? 10);
const PROXY = process.env.PROXY_URL ?? "http://localhost:8787";
const ADMIN = "https://admin-panel-api.codec.com.tr";
const APP_ID = "9398192ec61d422a8331529989959242";

if (!SESSION_ID) {
  console.error("usage: tsx scripts/probe-batch-latency.ts <sessionId> <n>");
  process.exit(2);
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
  console.log(`[probe] n=${N}`);
  const customers = ((await postJson<{ resultObject: unknown[] }>(
    "/api/Menu3525/GetCustomersToBeCharged", undefined, true,
  )).resultObject ?? []) as unknown[];
  const items = ((await postJson<{ resultObject: unknown[] }>(
    "/api/Menu3525/GetUnMatchedList",
    { requestValue: { keyword1: "", keyword2: "", msgcontent: "", useLikeSearch: 1 } },
  )).resultObject ?? []) as unknown[];
  console.log(`[probe] customers=${customers.length} items=${items.length}`);

  const slice = items.slice(0, N);
  console.log(`[probe] sending ${slice.length} items to ${PROXY}/categorize (streaming SSE reader)`);

  const start = Date.now();
  // Use streaming read so we can show each event as it arrives.
  const res = await fetch(`${PROXY}/categorize`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ items: slice, customers, model: process.env.PROXY_DEFAULT_MODEL ?? "MiniMax-M3" }),
  });
  console.log(`[probe] HTTP ${res.status} after ${Date.now() - start}ms; Content-Type=${res.headers.get("content-type")}`);

  if (!res.body) { console.error("[probe] no body"); return; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let lastLog = Date.now();
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      console.log(`[probe] stream ended at ${((Date.now() - start) / 1000).toFixed(1)}s`);
      break;
    }
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const t = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`[probe] +${t}s  ${raw.replace(/\n/g, " | ").slice(0, 240)}`);
      lastLog = Date.now();
    }
    // Liveness ping every 15s so we can see the stream is still alive.
    if (Date.now() - lastLog > 15_000) {
      console.log(`[probe] +${((Date.now() - start) / 1000).toFixed(1)}s  …still waiting, buf=${buf.length}b`);
      lastLog = Date.now();
    }
  }
}

main().catch((e) => { console.error("[probe] fatal:", e); process.exit(1); });
