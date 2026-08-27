/**
 * Bypass the proxy. Send N items in ONE call to MiniMax-M3 with
 * max_tokens=32000. Times out via AbortController after `TIMEOUT_MS`.
 *
 * Usage: tsx scripts/probe-single-call.ts <sessionId> [n=3462] [maxTokens=32000] [timeoutMs=180000]
 */
import { config as loadEnv } from "dotenv";
loadEnv();
import Anthropic from "@anthropic-ai/sdk";
import {
  buildSystemPrompt,
  buildUserPrompt,
  ITEM_ANNOTATIONS_TOOL,
} from "../src/prompts.js";
import type { Customer, UnmatchedItem } from "../src/types.js";

const SESSION_ID = process.argv[2] ?? process.env.SESSION_ID;
const N = Number(process.argv[3] ?? 3462);
const MAX_TOKENS = Number(process.argv[4] ?? 32000);
const TIMEOUT_MS = Number(process.argv[5] ?? 180_000);
const API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE = process.env.ANTHROPIC_BASE_URL;
const MODEL = process.env.PROXY_DEFAULT_MODEL ?? "MiniMax-M3";
const APP_ID = "9398192ec61d422a8331529989959242";

if (!API_KEY) { console.error("ANTHROPIC_API_KEY not set"); process.exit(2); }
if (!SESSION_ID) { console.error("usage: tsx scripts/probe-single-call.ts <sessionId> [n] [maxTokens] [timeoutMs]"); process.exit(2); }

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
  const res = await fetch(`https://admin-panel-api.codec.com.tr${path}`, {
    method: "POST", headers, body: payload,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${text.slice(0, 240)}`);
  return JSON.parse(text) as T;
}

async function main() {
  const customers = (await postJson<{ resultObject: Customer[] }>(
    "/api/Menu3525/GetCustomersToBeCharged", undefined, true,
  )).resultObject ?? [];
  const items = (await postJson<{ resultObject: UnmatchedItem[] }>(
    "/api/Menu3525/GetUnMatchedList",
    { requestValue: { keyword1: "", keyword2: "", msgcontent: "", useLikeSearch: 1 } },
  )).resultObject ?? [];

  const slice = items.slice(0, N);
  console.log(`[probe] customers=${customers.length} items_total=${items.length} items_used=${slice.length}`);
  console.log(`[probe] model=${MODEL} max_tokens=${MAX_TOKENS} timeout=${TIMEOUT_MS}ms`);

  const sys = buildSystemPrompt();
  const usr = buildUserPrompt(customers, slice);
  console.log(`[probe] prompt sizes:  system=${sys.length}b  user=${usr.length}b`);

  const client = new Anthropic({ apiKey: API_KEY, baseURL: BASE });

  const start = Date.now();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(new Error(`probe timeout ${TIMEOUT_MS}ms`)), TIMEOUT_MS);

  // liveness ping every 5s while we wait
  const ping = setInterval(() => {
    console.log(`[probe+${((Date.now() - start) / 1000).toFixed(1)}s] still waiting...`);
  }, 5_000);

  try {
    console.log(`[probe] sending single call...`);
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0.2,
        system: sys,
        tools: [ITEM_ANNOTATIONS_TOOL],
        tool_choice: { type: "tool", name: "item_annotations" },
        messages: [{ role: "user", content: [{ type: "text", text: usr }] }],
      },
      { signal: ac.signal },
    );
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[probe+${elapsed}s] done`);
    console.log(`[probe] stop_reason=${response.stop_reason}  usage=${JSON.stringify(response.usage)}`);
    const tool = response.content.find((b) => b.type === "tool_use");
    if (tool && tool.type === "tool_use") {
      const input = tool.input as { matches?: unknown[] };
      console.log(`[probe] tool_use matches length: ${input.matches?.length ?? 0}`);
      if (Array.isArray(input.matches)) {
        const ids = new Set<number>();
        const dupes: number[] = [];
        for (const m of input.matches) {
          const id = (m as { transactionId?: number }).transactionId;
          if (typeof id !== "number") continue;
          if (ids.has(id)) dupes.push(id);
          ids.add(id);
        }
        console.log(`[probe] coverage: ${ids.size}/${slice.length} unique; dupes=${dupes.length}`);
      }
    }
  } catch (e) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (ac.signal.aborted) {
      console.error(`[probe+${elapsed}s] aborted after ${TIMEOUT_MS}ms — single call did not finish`);
    } else {
      console.error(`[probe+${elapsed}s] error:`, e);
    }
    process.exitCode = 1;
  } finally {
    clearTimeout(t);
    clearInterval(ping);
  }
}

main().catch((e) => { console.error("[probe] fatal:", e); process.exit(1); });