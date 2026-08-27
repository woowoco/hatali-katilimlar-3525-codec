# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working on
`hatali-katilimlar-assistant`.

## TL;DR

This is a Chrome MV3 extension + Node.js AI proxy for the Turkish
premium-SMS **3525 short-code "Hatalı Katılımlar"** workflow.

> **The hard rule** is in [`docs/SAFETY-CONTRACT.md`](docs/SAFETY-CONTRACT.md).
> AI is **read-only**. No code may auto-charge anything; every
> `chargeOnce()` invocation must originate from a manual click in the UI.

Read that file before touching anything that calls the AI, that calls
`chargeOnce`, or that schedules work.

## Project layout

```
ai-proxy/                  Node.js + Express (TypeScript). :8787.
                           Holds ANTHROPIC_API_KEY.
  src/server.ts            Express app + /health /models /categorize
  src/categorize.ts        Batch LLM caller; retry on 429/5xx
  src/prompts.ts           System prompt + tool schema + validator (read-only)
  src/mock-server.ts       In-process simulator of admin-panel-api
                           (createApp, startOnRandomPort for tests)
  src/__tests__/           Unit tests against the proxy
  src/types.ts             Shared types; CODEC_ACCOUNT_EU_ID exported here

extension/                 Chrome MV3 (Vite + React 18 + TS). Loads unpacked.
  src/popup/App.tsx        5-step wizard
  src/popup/components/    StepIndicator / Settings / Fetch / Analyze / Review / History
  src/lib/api.ts           Admin-panel-api client (appid + sessionid)
  src/lib/ai.ts            Proxy client + buildKeywordRows (Codec fallback synthesis)
  src/lib/charger.ts       chargeOnce() — the ONLY write primitive
  src/lib/store.ts         chrome.storage.local wrappers
  src/__tests__/           live-guard, chrome-mock, store/ai/charger tests

tests/                     Root-level e2e
  e2e.test.ts              Full pipeline test against in-proc mock backend
  live-guard.ts            Blocks non-localhost fetches

docs/                      Architecture / Operations / Safety contract
```

## Common commands

Run from the repository root (`E:\P\hatali-katilimlar-assistant`):

```bash
npm install                  # install both workspaces
npm run build                # build ai-proxy + extension
npm run build:proxy          # build only the AI proxy
npm run build:ext            # build only the extension → extension/dist/
npm run typecheck            # tsc --noEmit in both packages
npm test                     # vitest: 19 ai-proxy + 23 extension + 2 e2e
npm run mock:backend         # start the in-process mock on :8788
npm run dev:proxy            # AI proxy on :8787
npm run dev:ext              # vite dev for the extension
```

There is no test runner wired up other than `vitest`. Do not introduce
jest or mocha without being asked.

## Request/authentication contracts

- **Admin-panel-api** (`admin-panel-api.codec.com.tr`) uses static
  `appid: 9398192ec61d422a8331529989959242` + per-session `sessionid`
  header. The session id is operator-supplied; never hard-code or auto-
  login.
- **AI proxy** is local-only (`http://localhost:8787`) and never sees
  the session id. It uses `ANTHROPIC_BASE_URL` (default
  `https://api.minimax.io/anthropic`) and `ANTHROPIC_API_KEY` server-side.
  The extension **never** holds the Anthropic API key.
- **CORS**: configure `PROXY_ALLOWED_ORIGINS` for the extension's
  chrome-extension:// origin (or `chrome-extension://*` in dev).

Wire shape for `/api/Menu3525/Charged` (HAR-confirmed):

```json
{ "requestValue": { "accountEuId": "<uuid>", "transactionIdsWithSubscriptionDate": [11, 22, 33] } }
```

## Adding or changing features

1. State the intent against [`docs/SAFETY-CONTRACT.md`](docs/SAFETY-CONTRACT.md):
   - Is the new code path read-only? Proceed.
   - Is it writing? It must be triggered **only** from a `button.onClick`
     in `extension/src/popup/`. If you'd put it anywhere else
     (`useEffect`, debounced typing, `setInterval`, etc.), stop and
     ask first.
2. UI lives under `extension/src/popup/components/`. Reuse
   `StepIndicator` and primitives from `extension/src/components/ui/`
   before introducing new components.
3. Backend / business logic stays under `extension/src/lib/` or
   `ai-proxy/src/`. Put response-shape normalization here, **not** in
   JSX.
4. Add a vitest test. Tests MUST NOT touch live URLs — see
   `tests/live-guard.ts`, `extension/src/__tests__/live-guard.ts`,
   `ai-proxy/src/__tests__/live-guard.ts`. Set `LIVE=1` only with
   explicit operator approval, and never in CI.
5. Run `npm run typecheck && npm test && npm run build:ext`.

## Style

- Match the existing comment density — most files carry short JSDoc on
  exports. Don't strip headers explaining *why*, only headers saying
  *what*.
- Prefer clear, named helpers (`chargeOnce`, `buildKeywordRows`) over
  inline lambdas in components.
- Use the kebab-case ASCII `keywordGroup` produced by the AI; downstream
  code expects ASCII.

## What NOT to do

- Don't add `setTimeout`, `setInterval`, or scheduling logic that calls
  `chargeOnce` automatically.
- Don't broaden `PROXY_ALLOWED_ORIGINS` to `*` in the default `.env`
  shipped to the operator.
- Don't move the Anthropic SDK into the extension bundle.
- Don't add live integration tests against the production backend.
- Don't change `CODEC_ACCOUNT_EU_ID` — it is HAR-derived and the
  operator's manual Codec-charging workflow depends on that exact id.
