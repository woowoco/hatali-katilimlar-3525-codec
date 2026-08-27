# ai-proxy

Node.js + Express proxy that talks to **MiniMax** (Anthropic-compatible)
and exposes a single `/categorize` endpoint to the browser extension.

Its job is to keep `ANTHROPIC_API_KEY` out of the extension bundle and to
validate the AI's structured output before the browser ever sees it. The
AI is **read-only** — see [`../docs/SAFETY-CONTRACT.md`](../docs/SAFETY-CONTRACT.md).

## Endpoints

| Method | Path          | Purpose                                                |
| ------ | ------------- | ------------------------------------------------------ |
| GET    | `/health`     | Liveness; returns `{ ok: true, models: N }`            |
| GET    | `/models`     | Lists M-series models (default + alternates)           |
| POST   | `/categorize` | Per-item annotation; body shape below                  |

### `POST /categorize`

Request:

```json
{
  "items":     [{ "transactionId": 12345, "keyword1": "IPTAL", "keyword2": "", "msgContent": "", "phone": "555…", "shortCode": "3525", "msgDate": "2026-…", "id": "12345|…" }],
  "customers": [{ "name": "ACME-MOBILE ---- Acme Mobile Inc.", "acntEuId": "<uuid>" }],
  "model":     "MiniMax-M3"
}
```

Response:

```json
{
  "model":   "MiniMax-M3",
  "batches": 19,
  "matches": [
    {
      "transactionId": 12345,
      "matchedField": "keyword1",
      "matchedValue": "IPTAL",
      "keywordGroup": "iptal",
      "suggestedAccountEuId": "<uuid-or-null>",
      "suggestedAccountName": "<name-or-null>",
      "confidence": "high|medium|low",
      "reasoning": "kısa bir Türkçe cümle"
    }
  ]
}
```

## Files

| File                          | Purpose                                            |
| ----------------------------- | -------------------------------------------------- |
| `src/server.ts`               | Express app; reads env, registers routes          |
| `src/categorize.ts`           | Batches (≤200/items) + retries 429/500/502/503/504 |
| `src/prompts.ts`              | System prompt, tool schema, validator              |
| `src/mock-server.ts`          | In-proc simulator of admin-panel-api (used by tests) |
| `src/types.ts`                | Shared types + the HAR-derived `CODEC_ACCOUNT_EU_ID`|
| `src/__tests__/prompts.test.ts`        | chunkItems, prompts, validateMatches        |
| `src/__tests__/categorize.test.ts`     | batch split + retry behaviour (mocked SDK)  |

## Run locally

```bash
cp .env.example .env       # set ANTHROPIC_API_KEY at minimum
npm run dev                # → http://localhost:8787
curl -s localhost:8787/health
```

## Environment variables

| Name                    | Default                          | Notes                                       |
| ----------------------- | -------------------------------- | ------------------------------------------- |
| `ANTHROPIC_API_KEY`     | (required)                       | Server-side only; never bundled             |
| `ANTHROPIC_BASE_URL`    | `https://api.minimax.io/anthropic` | Anthropic-compatible base                  |
| `PROXY_DEFAULT_MODEL`   | `MiniMax-M3`                     | Surfaced in `/models` as `default`           |
| `PROXY_ALLOWED_ORIGINS` | (none → allow all without `Origin`) | Comma-separated; supports `*` glob       |
| `PORT`                  | `8787`                           |                                             |

## Test

```bash
npm --workspace ai-proxy run test
```

19 unit tests cover prompts, validator, batching, retries. None touch
the live MiniMax API; see `src/__tests__/live-guard.ts`.
