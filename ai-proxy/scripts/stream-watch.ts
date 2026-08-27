/**
 * Stream-read live /categorize with per-event logging and 15s liveness pings.
 *
 *   tsx scripts/stream-watch.ts <sessionId> [n=25] [batches=2]
 */
import { config as loadEnv } from "dotenv";
loadEnv();

const SESSION_ID = process.argv[2];
const N = Number(process.argv[3] ?? 25);
const BATCHES = Number(process.argv[4] ?? 2);
const APP_ID = "9398192ec61d422a8331529989959242";

if (!SESSION_ID) { console.error("usage: tsx scripts/stream-watch.ts <sessionId> [n] [batches]"); process.exit(2); }

async function postJson<T>(path: string, body?: unknown, emptyBody = false): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
    appid: APP_ID,
    sessionid: SESSION_ID!,
    origin: "https://admin-panel.codec.com.tr",
    referer: "https://admin-panel.codec.com.tr/",
  };
  let payload: BodyInit | undefined;
  if (!emptyBody) { headers["content-type"] = "application/json"; payload = JSON.stringify(body ?? {}); } else { headers["content-length"] = "0"; }
  const res = await fetch(`https://admin-panel-api.codec.com.tr${path}`, { method: "POST", headers, body: payload });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function main() {
  const c = ((await postJson<{ resultObject: unknown[] }>("/api/Menu3525/GetCustomersToBeCharged", undefined, true)).resultObject ?? []);
  const it = ((await postJson<{ resultObject: unknown[] }>("/api/Menu3525/GetUnMatchedList", { requestValue: { keyword1: "", keyword2: "", msgcontent: "", useLikeSearch: 1 } })).resultObject ?? []);
  const slice = it.slice(0, N * BATCHES);
  console.log(`[watch] customers=${c.length} items=${it.length} slice=${slice.length} (target ${N}/batch × ${BATCHES} batches)`);

  const start = Date.now();
  const res = await fetch("http://localhost:8787/categorize", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ items: slice, customers: c, model: "MiniMax-M3" }),
  });
  console.log(`[watch] HTTP ${res.status} ct=${res.headers.get("content-type")}`);

  if (!res.body) { console.error("[watch] no body"); return; }
  const r = res.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  let last = Date.now();
  process.stdout.write(`[watch] t=0.0s connected\n`);
  while (true) {
    const { value, done } = await r.read();
    if (done) { process.stdout.write(`[watch] t=${((Date.now()-start)/1000).toFixed(1)}s stream-done\n`); break; }
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      process.stdout.write(`[watch] t=${((Date.now()-start)/1000).toFixed(1)}s ${raw.replace(/\n/g,"|").slice(0,260)}\n`);
      last = Date.now();
    }
    if (Date.now() - last > 15_000) {
      process.stdout.write(`[watch] t=${((Date.now()-start)/1000).toFixed(1)}s ...alive, buf=${buf.length}b\n`);
      last = Date.now();
    }
  }
  process.stdout.write(`[watch] === END ===\n`);
}

main().catch(e => { process.stderr.write(`[watch] fatal: ${(e as Error).message}\n`); process.exit(1); });
