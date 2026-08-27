/**
 * Subset runner for /categorize. Lets you process just a slice of the
 * unmatched items instead of the full set.
 *
 * Modes:
 *   --head N                first N items (default)
 *   --tail N                last N items
 *   --range START END       items at index [START, END) (0-based, half-open)
 *   --tx A B C              specific transactionIds
 *
 * Usage:
 *   tsx scripts/categorize-subset.ts <sessionId> [--head 600] [--range 0 600]
 */
import { config as loadEnv } from "dotenv";
loadEnv();

const SESSION_ID = process.argv[2];
if (!SESSION_ID) {
  console.error("usage: tsx scripts/categorize-subset.ts <sessionId> [--head N | --tail N | --range A B | --tx id1 id2 ...]");
  process.exit(2);
}

const args = process.argv.slice(3);
const PROXY = process.env.PROXY_URL ?? "http://localhost:8787";
const ADMIN = "https://admin-panel-api.codec.com.tr";
const APP_ID = "9398192ec61d422a8331529989959242";

interface Customer { acntEuId: string; name: string }
interface UnmatchedItem {
  transactionId: number;
  phone: string;
  keyword1: string;
  keyword2: string;
  msgContent: string;
  shortCode?: string;
  msgDate?: string;
  id?: string;
}

type Mode =
  | { kind: "head"; n: number }
  | { kind: "tail"; n: number }
  | { kind: "range"; a: number; b: number }
  | { kind: "tx"; ids: number[] };

function parseArgs(argv: string[]): Mode {
  if (argv.length === 0) return { kind: "head", n: 100 };
  const flag = argv[0];
  switch (flag) {
    case "--head": return { kind: "head", n: Number(argv[1] ?? 100) };
    case "--tail": return { kind: "tail", n: Number(argv[1] ?? 100) };
    case "--range": return { kind: "range", a: Number(argv[1]), b: Number(argv[2]) };
    case "--tx": return { kind: "tx", ids: argv.slice(1).map(Number).filter(Number.isFinite) };
    default:
      // bare number → --head N
      const n = Number(flag);
      if (!Number.isFinite(n)) {
        console.error(`unknown flag: ${flag}`);
        process.exit(2);
      }
      return { kind: "head", n };
  }
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
  const mode = parseArgs(args);
  console.log(`[subset] sessionId=${SESSION_ID} proxy=${PROXY} mode=${JSON.stringify(mode)}`);

  const customersRes = await postJson<{ resultObject: Customer[] }>(
    "/api/Menu3525/GetCustomersToBeCharged",
    undefined,
    true,
  );
  const customers = customersRes.resultObject ?? [];
  console.log(`[subset] customers: ${customers.length}`);

  const itemsRes = await postJson<{ resultObject: UnmatchedItem[] }>(
    "/api/Menu3525/GetUnMatchedList",
    { requestValue: { keyword1: "", keyword2: "", msgcontent: "", useLikeSearch: 1 } },
  );
  const allItems = itemsRes.resultObject ?? [];
  console.log(`[subset] items total: ${allItems.length}`);

  let subset: UnmatchedItem[];
  switch (mode.kind) {
    case "head":
      subset = allItems.slice(0, mode.n);
      break;
    case "tail":
      subset = allItems.slice(-mode.n);
      break;
    case "range":
      subset = allItems.slice(mode.a, mode.b);
      break;
    case "tx": {
      const wanted = new Set(mode.ids);
      subset = allItems.filter((it) => wanted.has(it.transactionId));
      if (subset.length !== mode.ids.length) {
        const found = new Set(subset.map((s) => s.transactionId));
        const missing = mode.ids.filter((id) => !found.has(id));
        console.warn(`[subset] ${missing.length} txId(s) not in current unmatched list: ${missing.join(", ")}`);
      }
      break;
    }
  }

  console.log(`[subset] processing ${subset.length} items (txIds: ${subset[0]?.transactionId}..${subset[subset.length - 1]?.transactionId})`);

  const startMs = Date.now();
  const res = await fetch(`${PROXY}/categorize`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ items: subset, customers, model: process.env.PROXY_DEFAULT_MODEL ?? "MiniMax-M3" }),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error(`[subset] proxy HTTP ${res.status}: ${t.slice(0, 600)}`);
    process.exit(1);
  }
  if (!res.body) {
    console.error("[subset] proxy returned no body");
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
      try { data = JSON.parse(data); } catch { /* keep as string */ }
      if (event === "batch-start") {
        const d = data as { i: number; total: number; size: number };
        console.log(`[subset] +${elapsed}s  batch-start  i=${d.i} total=${d.total} size=${d.size}`);
      } else if (event === "batch-done") {
        const d = data as { i: number; total: number; matches: number; accumulated: number };
        batches++;
        console.log(`[subset] +${elapsed}s  batch-done   i=${d.i} matches=${d.matches} accumulated=${d.accumulated}`);
      } else if (event === "done") {
        const d = data as { model: string; batches: number; matches: unknown[] };
        matches = d.matches.length;
        console.log(`[subset] +${elapsed}s  done         model=${d.model} batches=${d.batches} matches=${matches}`);
      } else if (event === "error") {
        const d = data as { error: string };
        errors.push(d.error);
        console.error(`[subset] +${elapsed}s  ERROR        ${d.error.slice(0, 400)}`);
      } else if (event === "comment") {
        /* heartbeat */
      } else {
        console.log(`[subset] +${elapsed}s  ${event}  ${JSON.stringify(data).slice(0, 200)}`);
      }
    }
  }

  const totalSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`\n[subset] === summary ===`);
  console.log(`[subset] total wall:  ${totalSec}s`);
  console.log(`[subset] batches ok:  ${batches}/${Math.ceil(subset.length / 50)}`);
  console.log(`[subset] matches:     ${matches}/${subset.length}`);
  console.log(`[subset] errors:      ${errors.length}`);
  if (errors.length) {
    for (const e of errors) console.log(`[subset]   • ${e}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[subset] fatal:", err);
  process.exit(1);
});