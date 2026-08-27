/**
 * Scale-test: measure MiniMax latency at 1, 5, 10, 25 items. No batching,
 * no SSE, just direct SDK calls. Helps us pick a BATCH_SIZE that fits
 * inside a reasonable per-call timeout.
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

const SESSION_ID = process.argv[2];
const API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE = process.env.ANTHROPIC_BASE_URL;
const MODEL = process.env.PROXY_DEFAULT_MODEL ?? "MiniMax-M3";
const APP_ID = "9398192ec61d422a8331529989959242";

if (!API_KEY || !SESSION_ID) {
  console.error("usage: tsx scripts/scale-test.ts <sessionId>");
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
  const res = await fetch(`https://admin-panel-api.codec.com.tr${path}`, {
    method: "POST", headers, body: payload,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${text.slice(0, 240)}`);
  return JSON.parse(text) as T;
}

async function timeOne(n: number, customers: Customer[], items: UnmatchedItem[]) {
  const sys = buildSystemPrompt();
  const usr = buildUserPrompt(customers, items.slice(0, n));
  const client = new Anthropic({ apiKey: API_KEY!, baseURL: BASE });
  const start = Date.now();
  try {
    const resp = await client.messages.create({
      model: MODEL!,
      max_tokens: 16000,
      temperature: 0.2,
      system: sys,
      tools: [ITEM_ANNOTATIONS_TOOL],
      tool_choice: { type: "tool", name: "item_annotations" },
      messages: [{ role: "user", content: [{ type: "text", text: usr }] }],
    });
    const dt = (Date.now() - start) / 1000;
    const tool = resp.content.find((b) => b.type === "tool_use");
    const matches = tool && tool.type === "tool_use"
      ? ((tool.input as { matches?: unknown[] }).matches?.length ?? 0)
      : 0;
    console.log(`[scale] n=${n.toString().padStart(2)}  ${dt.toFixed(1).padStart(5)}s  stop=${resp.stop_reason}  out=${resp.usage.output_tokens}t  matches=${matches}`);
  } catch (e) {
    const dt = (Date.now() - start) / 1000;
    console.log(`[scale] n=${n.toString().padStart(2)}  ${dt.toFixed(1).padStart(5)}s  ERROR  ${(e as Error).message.slice(0, 240)}`);
  }
}

async function main() {
  const customers = (await postJson<{ resultObject: Customer[] }>(
    "/api/Menu3525/GetCustomersToBeCharged", undefined, true,
  )).resultObject ?? [];
  const items = (await postJson<{ resultObject: UnmatchedItem[] }>(
    "/api/Menu3525/GetUnMatchedList",
    { requestValue: { keyword1: "", keyword2: "", msgcontent: "", useLikeSearch: 1 } },
  )).resultObject ?? [];
  console.log(`[scale] customers=${customers.length} items=${items.length} model=${MODEL}`);

  for (const n of [1, 5, 10, 25]) {
    if (n > items.length) break;
    await timeOne(n, customers, items);
  }
}

main().catch((e) => { console.error("[scale] fatal:", e); process.exit(1); });
