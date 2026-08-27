/**
 * Show what /categorize actually emits at the wire level.
 *
 *   tsx scripts/debug-stream.ts <sessionId> [n=25]
 */
import { config as loadEnv } from "dotenv";
loadEnv();

const SESSION_ID = process.argv[2];
const N = Number(process.argv[3] ?? 25);
const APP_ID = "9398192ec61d422a8331529989959242";

if (!SESSION_ID) { console.error("usage: tsx scripts/debug-stream.ts <sessionId> [n]"); process.exit(2); }

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
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function main() {
  const c = ((await postJson<{ resultObject: unknown[] }>("/api/Menu3525/GetCustomersToBeCharged", undefined, true)).resultObject ?? []);
  const it = ((await postJson<{ resultObject: unknown[] }>("/api/Menu3525/GetUnMatchedList", { requestValue: { keyword1: "", keyword2: "", msgcontent: "", useLikeSearch: 1 } })).resultObject ?? []);
  const slice = it.slice(0, N);
  process.stdout.write(`[dbg] sending ${slice.length} items\n`);

  const start = Date.now();
  // Use the lower-level node http to see connection close details.
  const res = await fetch("http://localhost:8787/categorize", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ items: slice, customers: c, model: "MiniMax-M3" }),
  });
  process.stdout.write(`[dbg] HTTP ${res.status}\n`);

  if (!res.body) { console.error("[dbg] no body"); return; }
  const r = res.body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  let last = Date.now();
  let totalBytes = 0;
  while (true) {
    const { value, done } = await r.read();
    if (done) {
      process.stdout.write(`[dbg] t=${((Date.now()-start)/1000).toFixed(1)}s STREAM_DONE total=${totalBytes}b buf=${buf.length}b\n`);
      // Dump any partial buffer so we can see if there's a half-written event.
      if (buf.length > 0) process.stdout.write(`[dbg] partial buf: ${JSON.stringify(buf).slice(0, 400)}\n`);
      break;
    }
    totalBytes += value.byteLength;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      process.stdout.write(`[dbg] t=${((Date.now()-start)/1000).toFixed(1)}s ${raw.replace(/\n/g,"|").slice(0,260)}\n`);
      last = Date.now();
    }
    if (Date.now() - last > 10_000) {
      process.stdout.write(`[dbg] t=${((Date.now()-start)/1000).toFixed(1)}s ...alive, recv=${totalBytes}b buf=${buf.length}b\n`);
      last = Date.now();
    }
  }
}

main().catch(e => { process.stderr.write(`[dbg] fatal: ${(e as Error).message}\n`); process.exit(1); });
