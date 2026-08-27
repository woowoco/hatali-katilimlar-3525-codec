/**
 * 3 batches in parallel against the live MiniMax endpoint. Measures
 * whether concurrent requests reduce wall-clock for the same workload.
 *
 * Usage: tsx scripts/probe-parallel.ts <sessionId> [nPerBatch=100] [workers=3] [maxTokens=16000]
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
const N_PER_BATCH = Number(process.argv[3] ?? 100);
const WORKERS = Number(process.argv[4] ?? 3);
const MAX_TOKENS = Number(process.argv[5] ?? 16000);
const API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE = process.env.ANTHROPIC_BASE_URL;
const MODEL = process.argv[6] ?? process.env.PROXY_DEFAULT_MODEL ?? "MiniMax-M3";
const APP_ID = "9398192ec61d422a8331529989959242";

if (!API_KEY) { console.error("ANTHROPIC_API_KEY not set"); process.exit(2); }
if (!SESSION_ID) { console.error("usage: tsx scripts/probe-parallel.ts <sessionId> [n] [workers] [maxTokens] [model]"); process.exit(2); }

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

async function runOne(client: Anthropic, label: string, customers: Customer[], slice: UnmatchedItem[]) {
  const sys = buildSystemPrompt();
  const usr = buildUserPrompt(customers, slice);
  const start = Date.now();
  console.log(`[${label}+0.0s] start (${slice.length} items)`);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 0.2,
    system: sys,
    tools: [ITEM_ANNOTATIONS_TOOL],
    tool_choice: { type: "tool", name: "item_annotations" },
    messages: [{ role: "user", content: [{ type: "text", text: usr }] }],
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const tool = response.content.find((b) => b.type === "tool_use");
  const matches = tool && tool.type === "tool_use" ? ((tool.input as { matches?: unknown[] }).matches?.length ?? 0) : 0;
  console.log(`[${label}+${elapsed}s] stop_reason=${response.stop_reason} matches=${matches} usage=${JSON.stringify(response.usage)}`);
  return { label, elapsed: Number(elapsed), matches, usage: response.usage, stop_reason: response.stop_reason };
}

async function main() {
  const customers = (await postJson<{ resultObject: Customer[] }>(
    "/api/Menu3525/GetCustomersToBeCharged", undefined, true,
  )).resultObject ?? [];
  const items = (await postJson<{ resultObject: UnmatchedItem[] }>(
    "/api/Menu3525/GetUnMatchedList",
    { requestValue: { keyword1: "", keyword2: "", msgcontent: "", useLikeSearch: 1 } },
  )).resultObject ?? [];

  const total = WORKERS * N_PER_BATCH;
  const slice = items.slice(0, total);
  console.log(`[probe] customers=${customers.length} items_total=${items.length} items_used=${slice.length}`);
  console.log(`[probe] model=${MODEL} workers=${WORKERS} n_per_batch=${N_PER_BATCH} max_tokens=${MAX_TOKENS}`);

  const client = new Anthropic({ apiKey: API_KEY, baseURL: BASE });
  const wallStart = Date.now();

  const tasks: Promise<ReturnType<typeof runOne>>[] = [];
  for (let w = 0; w < WORKERS; w++) {
    const start = w * N_PER_BATCH;
    const sub = slice.slice(start, start + N_PER_BATCH);
    tasks.push(runOne(client, `W${w + 1}`, customers, sub));
  }

  const results = await Promise.allSettled(tasks);
  const wallElapsed = ((Date.now() - wallStart) / 1000).toFixed(1);

  console.log(`\n[probe] wall-clock: ${wallElapsed}s for ${total} items across ${WORKERS} workers`);
  for (const r of results) {
    if (r.status === "fulfilled") {
      const v = r.value;
      console.log(`  ${v.label}: ${v.elapsed}s · ${v.matches} matches · stop_reason=${v.stop_reason}`);
    } else {
      console.log(`  FAILED: ${r.reason}`);
    }
  }
}

main().catch((e) => { console.error("[probe] fatal:", e); process.exit(1); });