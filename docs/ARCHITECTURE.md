# Architecture

Two-package monorepo under `E:\P\hatali-katilimlar-assistant`:

```
.
├── ai-proxy/                    # Node.js + Express (TypeScript)
│   ├── src/
│   │   ├── server.ts            # Express app, listening on :8787
│   │   ├── categorize.ts        # Batch LLM caller with retry
│   │   ├── prompts.ts           # System prompt + tool schema + validator
│   │   ├── mock-server.ts       # In-process simulator of admin-panel-api
│   │   ├── types.ts             # Shared types incl. CODEC_ACCOUNT_EU_ID
│   │   └── __tests__/
│   └── package.json
├── extension/                   # Chrome MV3 extension (Vite + React 18 + TS)
│   ├── src/
│   │   ├── popup/App.tsx        # 5-step wizard
│   │   ├── lib/
│   │   │   ├── api.ts           # Admin-panel-api client (appid+sessionid)
│   │   │   ├── ai.ts            # Proxy client + buildKeywordRows
│   │   │   ├── charger.ts       # chargeOnce() — the only write op
│   │   │   └── store.ts         # chrome.storage.local wrappers
│   │   └── __tests__/
│   └── manifest.json
├── tests/
│   ├── e2e.test.ts              # Full pipeline test against in-proc mock
│   └── live-guard.ts            # Blocks non-localhost fetches
├── docs/                        # This folder
├── package.json                 # Workspaces + convenience scripts
└── vitest.config.ts             # Root config for tests/e2e.test.ts
```

## Data flow

```
[operator's browser]
   │
   ├─ chrome.storage.local  (settings, session, audit log — machine-local)
   │
   └─ popup / React UI      ── button clicks only
        │
        │ ① fetch phase (popup → admin-panel-api.codec.com.tr)
        ▼
   /api/Menu3525/GetCustomersToBeCharged  → Customer[]
   /api/Menu3525/GetUnMatchedList         → UnmatchedItem[]
        │
        │ ② analyze phase (popup → AI proxy :8787)
        ▼
   POST /categorize  { items, customers, model }  →  CategorizeResponse
        │                                                  ▲
        │                                                  │
        │ ③ ai-proxy → MiniMax                            │
        │  POST /v1/messages  (200/batch, retry) ──────────┘
        │
        │ ④ review phase — UI aggregates matches into KeywordRow[]
        │
        │ ⑤ charge phase (popup → admin-panel-api.codec.com.tr)
        ▼
   POST /api/Menu3525/Charged  { requestValue: { accountEuId, transactionIdsWithSubscriptionDate } }
        │
        └─► audit record appended to chrome.storage.local "audit.v1"
```

The AI proxy never sends a Charged request and never holds the user's
session id. The extension never holds the Anthropic API key.

## Key contracts

### `/api/Menu3525/GetCustomersToBeCharged`

```http
POST /api/Menu3525/GetCustomersToBeCharged HTTP/1.1
appid: 9398192ec61d422a8331529989959242
sessionid: <operator's sessionid>
content-length: 0
```

Response:

```json
{
  "resultObject": [{ "name": "ACME-MOBILE ---- Acme Mobile Inc.", "acntEuId": "…" }, …]
}
```

### `/api/Menu3525/GetUnMatchedList`

```http
POST /api/Menu3525/GetUnMatchedList HTTP/1.1
appid: 9398192ec61d422a8331529989959242
sessionid: <…>
content-type: application/json

{ "requestValue": { "keyword1": "", "keyword2": "", "msgcontent": "", "useLikeSearch": 1 } }
```

### `/api/Menu3525/Charged`

```http
POST /api/Menu3525/Charged HTTP/1.1
appid: 9398192ec61d422a8331529989959242
sessionid: <…>
content-type: application/json

{ "requestValue": { "accountEuId": "<firm-uuid>", "transactionIdsWithSubscriptionDate": [11, 22, 33] } }
```

Response (success):

```json
{
  "resultObject": true,
  "isSuccess": true,
  "resultCode": 0,
  "resultDetails": "OK",
  "exceptionInformation": null
}
```

### AI proxy `/categorize`

```http
POST /categorize HTTP/1.1
host: localhost:8787
content-type: application/json

{
  "items":     [{ transactionId, keyword1, keyword2, msgContent, phone, … }, …],
  "customers": [{ name, acntEuId }, …],
  "model":     "MiniMax-M3"
}
```

Response:

```json
{
  "model": "MiniMax-M3",
  "batches": 19,
  "matches": [
    {
      "transactionId": 12345,
      "matchedField": "keyword1",
      "matchedValue": "IPTAL",
      "keywordGroup": "iptal",
      "suggestedAccountEuId": "<uuid>",
      "suggestedAccountName": "ACME-MOBILE ---- Acme Mobile Inc.",
      "confidence": "high",
      "reasoning": "…"
    },
    …
  ]
}
```

For items the AI can't match, `suggestedAccountEuId` is `null`. The
extension's `buildKeywordRows()` puts those into a synthetic
`__codec_fallback__` row pre-pointed at
`CODEC_ACCOUNT_EU_ID = "00000000-0000-0000-0000-000000000000"` (HAR
derived).

### Local storage

| Key                | Shape                                                              |
| ------------------ | ------------------------------------------------------------------ |
| `settings.v1`      | `{ sessionId, proxyUrl, model, throttleMs }`                       |
| `session.v1`       | `SessionState` (customers, items, matches, model, fetchedAt, chargedIds, firmOverrides) |
| `audit.v1`         | `ChargeRecord[]` (max 5000, trimmed FIFO)                         |

## Retries and backoff

`categorize()` retries on HTTP `429`, `500`, `502`, `503`, `504` with
exponential backoff (`400ms × 2^attempt`). 3 attempts max per batch, then
the entire `/categorize` call fails — the user sees the error in the UI
and can retry manually. We **never auto-retry** a batch without user
action; this is part of the read-only contract.

## What is NOT in the codebase (and why)

- **No automated charge scheduler.** Search the repo, there are no
  timers attached to `chargeOnce`.
- **No AI client inside the extension.** The Anthropic SDK only lives in
  `ai-proxy/`. The browser bundle would have leaked the API key.
- **No CORS wildcard.** `PROXY_ALLOWED_ORIGINS` is required to be set in
  production (defaults to whatever the operator configures).
- **No HMAC.** This backend doesn't use it (we observed the simpler
  `appid` + `sessionid` model in the HAR).
