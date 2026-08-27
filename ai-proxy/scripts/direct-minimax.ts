/**
 * Bypass the proxy entirely. POST directly to MiniMax with a tiny prompt
 * and print how long the connection lives.
 *
 *   tsx scripts/direct-minimax.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv();

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error("ANTHROPIC_API_KEY not set"); process.exit(2); }
const BASE = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
const MODEL = process.env.PROXY_DEFAULT_MODEL ?? "MiniMax-M3";

async function main() {
  const start = Date.now();
  console.log(`[direct] → ${BASE}/v1/messages  model=${MODEL}`);

  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      temperature: 0.2,
      tools: [
        {
          name: "noop",
          description: "no-op",
          input_schema: { type: "object", properties: { ok: { type: "boolean" } }, required: [] },
        },
      ],
      tool_choice: { type: "tool", name: "noop" },
      messages: [
        {
          role: "user",
          content: 'Call the noop tool with {"ok":true}. Respond only with the tool call.',
        },
      ],
    }),
    signal: ctrl.signal,
  });
  console.log(`[direct] HTTP ${res.status} after ${Date.now() - start}ms`);

  if (!res.ok) {
    console.error(`[direct] body: ${(await res.text()).slice(0, 400)}`);
    process.exit(1);
  }
  const data = await res.json();
  console.log(`[direct] done in ${((Date.now() - start)/1000).toFixed(1)}s`);
  console.log(`[direct] stop_reason=${data.stop_reason}`);
  console.log(`[direct] content types=${data.content.map((b: {type:string})=>b.type).join(",")}`);
}

main().catch((e) => { console.error("[direct] fatal:", e); process.exit(1); });
