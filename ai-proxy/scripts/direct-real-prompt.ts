/**
 * Bypass the proxy. Build the *real* prompt that the proxy sends to
 * MiniMax, then POST it directly. Measures how long the upstream takes
 * to respond with the actual workload.
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
const N = Number(process.argv[3] ?? 5);
const API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE = process.env.ANTHROPIC_BASE_URL;
const MODEL = process.env.PROXY_DEFAULT_MODEL ?? "MiniMax-M3";
const APP_ID = "9398192ec61d422a8331529989959242";

if (!API_KEY) { console.error("ANTHROPIC_API_KEY not set"); process.exit(2); }
if (!SESSION_ID) { console.error("usage: tsx scripts/direct-real-prompt.ts <sessionId> [n=5]"); process.exit(2); }

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

  console.log(`[real] customers=${customers.length} items=${items.length}`);

  const slice = items.slice(0, N);
  const sys = buildSystemPrompt();
  const usr = buildUserPrompt(customers, slice);
  console.log(`[real] prompt sizes:  system=${sys.length}b  user=${usr.length}b  customers-list=${customers.length*40}b (est)`);

  const client = new Anthropic({ apiKey: API_KEY, baseURL: BASE });

  const start = Date.now();
  console.log(`[real] sending direct to MiniMax, model=${MODEL}, n=${N}`);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    temperature: 0.2,
    system: sys,
    tools: [ITEM_ANNOTATIONS_TOOL],
    tool_choice: { type: "tool", name: "item_annotations" },
    messages: [{ role: "user", content: [{ type: "text", text: usr }] }],
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[real] done in ${elapsed}s`);
  console.log(`[real] stop_reason=${response.stop_reason}  usage=${JSON.stringify(response.usage)}`);
  const blockTypes = response.content.map((b) => b.type).join(",");
  console.log(`[real] content blocks: ${blockTypes}`);
  const tool = response.content.find((b) => b.type === "tool_use");
  if (tool && tool.type === "tool_use") {
    const input = tool.input as { matches?: unknown[] };
    console.log(`[real] tool_use matches length: ${input.matches?.length ?? 0}`);
    console.log(`[real] first match: ${JSON.stringify(input.matches?.[0] ?? null).slice(0, 240)}`);
  }
}

main().catch((e) => { console.error("[real] fatal:", e); process.exit(1); });
