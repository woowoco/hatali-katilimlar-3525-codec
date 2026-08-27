# Hatalı Katılımlar Assistant

Chrome extension (Manifest V3) + Node.js AI proxy for the **3525 short-code
"Hatalı Katılımlar"** (unmatched participations) workflow at
<https://admin-panel.codec.com.tr>. The extension is **100% read-only on the
AI side** — it classifies unmatched SMS transactions with AI and shows the
operator a keyword-grouped table. Every charge is triggered manually.

> **Read first:** [`docs/SAFETY-CONTRACT.md`](docs/SAFETY-CONTRACT.md). It is
> the source of truth for what the AI may and may not do.

## What it does

1. **Fetch** the customer list (`GetCustomersToBeCharged`) and the
   unmatched transactions (`GetUnMatchedList`) from the operator's
   session at `admin-panel-api.codec.com.tr`.
2. **Analyze** the unmatched batch against the customer list using an AI
   model on MiniMax (default `MiniMax-M3`; switchable to M-series). The
   AI returns one structured annotation per transaction: which field
   matched, the value, the keyword group, the suggested firm, confidence
   and reasoning. **It does not charge.**
3. **Review** in a keyword-grouped table — one row per `keywordGroup`,
   with a synthetic `__codec_fallback__` row at the bottom for items the
   AI couldn't match. The operator can:
   - change the suggested firm per row (firm override)
   - select a subset of items within a row
   - click **Tümünü ücretlendir** (charge everything in the row) or
     **Seçili** (charge only the selected subset)
4. **Charge** by sending one POST to `/api/Menu3525/Charged` per click.
   The request carries the array of `transactionIdsWithSubscriptionDate`.
   The HAR-confirmed endpoint accepts bulk (call #5 had 26 IDs, call #7
   had 50+) but we keep the operation row-scoped to keep the blast
   radius small.
5. **Audit** every charge attempt in `chrome.storage.local` under
   `audit.v1` so the operator can re-inspect what was sent. The History
   step shows success/error records with full id arrays.

## Architecture

```
┌──────────────────┐  HTTPS  ┌─────────────────────┐  HTTP   ┌──────────────┐
│ admin-panel-api. │◄────────│ extension popup     │         │  AI proxy    │
│ codec.com.tr     │ appid+  │ (chrome extension)  │◄────────►│ :8787        │
│ (production)     │ session │                     │ /categorize              │
└──────────────────┘         └─────────────────────┘         └──────┬───────┘
                                                                  │ HTTPS
                                                                  │  ANTHROPI
                                                                  │  C_API_KEY
                                                                  ▼
                                                          ┌────────────────┐
                                                          │ api.minimax.io │
                                                          │ /anthropic     │
                                                          └────────────────┘
```

- `extension/` — React + TypeScript + Vite + crxjs. Builds to `dist/`
  you load via `chrome://extensions` → "Load unpacked". Storage:
  `chrome.storage.local` (machine-local, not synced). UI: 5 steps in
  `popup/App.tsx` (Settings / Fetch / Analyze / Review / History).
- `ai-proxy/` — Express server. Holds the Anthropic API key (server-side
  only, never shipped to the browser). Exposes `/health`, `/models`,
  `/categorize`. Talks to `api.minimax.io/anthropic` using
  `@anthropic-ai/sdk` with `ANTHROPIC_BASE_URL` env override.
- `ai-proxy/src/mock-server.ts` — in-process simulator of
  `admin-panel-api.codec.com.tr`. Used for tests and manual local
  exercise without touching production. Has debug endpoints
  `/__mock/health` and `/__mock/charged-log`.
- `tests/e2e.test.ts` — full pipeline test. Brings up the mock
  in-process on an ephemeral port; proves that nothing charges unless
  the operator explicitly calls `chargeOnce()`. This is the structural
  guard for the safety contract.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the detailed
component breakdown, request/response shapes, and storage layout.

## Quick start

```bash
npm install                # install across both workspaces
cp ai-proxy/.env.example ai-proxy/.env    # then edit ANTHROPIC_API_KEY
npm run dev:proxy          # → http://localhost:8787
npm run build:ext          # → extension/dist/
# Chrome → chrome://extensions → Developer mode → Load unpacked → extension/dist/
```

Inside the extension popup:

1. **Settings** — paste `sessionid` (DevTools → Network → any
   `/api/Menu3525/*` request → `sessionid` header), confirm the proxy
   URL, pick a model.
2. **Fetch** — pulls customers + unmatched items.
3. **Analyze** — sends batches to the proxy → categorizes with the LLM.
4. **Review** — inspect rows per keyword group; change firm if needed;
   click "Tümünü ücretlendir" or "Seçili" to charge.
5. **History** — see every charge attempt and its status.

For offline/manual exercise against the mock backend:

```bash
npm run mock:backend       # → http://localhost:8788
```

Point the extension's proxyUrl at the mock instead of real
`admin-panel-api.codec.com.tr` (the API base is hardcoded in
`extension/src/lib/api.ts` so for testing you'll use the test hook
`__setBaseUrlForTests`, see `extension/src/__tests__/charger.test.ts`
for an example).

## Common commands

```bash
npm install
npm run build                # both packages into dist/
npm test                     # vitest in both packages + e2e (mock-only)
npm run typecheck            # tsc --noEmit in both packages
npm run mock:backend         # mock backend :8788
npm run dev:proxy            # AI proxy :8787
npm run dev:ext              # vite dev for the extension
```

## Tests — mock-only by design

- `npm test` runs **44 unit + e2e tests** across ai-proxy, extension and
  the e2e directory. **None of them touch the live MiniMax API or the
  live admin-panel backend.**
- `tests/live-guard.ts` (and equivalents in both packages) wrap
  `globalThis.fetch` to throw on any non-localhost URL. `LIVE=1` is the
  only override.

## Distribution

Local-only. Use `chrome://extensions` → "Load unpacked" → point at
`extension/dist/`. CWS submission is intentionally out of scope.
