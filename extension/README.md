# extension

Chrome MV3 extension (Vite + React 18 + TypeScript) for the 3525
short-code Hatalı Katılımlar workflow.

The AI categorizes. **The browser only charges when the operator
clicks.** Read [`../docs/SAFETY-CONTRACT.md`](../docs/SAFETY-CONTRACT.md)
before touching charge or scheduler code.

## Layout

```
src/
├── popup/
│   ├── App.tsx               5-step wizard (Settings / Fetch / Analyze / Review / History)
│   ├── main.tsx              React mount + global stylesheet
│   ├── styles.css
│   └── components/
│       ├── StepIndicator.tsx
│       ├── StepSettings.tsx
│       ├── StepFetch.tsx
│       ├── StepAnalyze.tsx
│       ├── StepReview.tsx    ← only place that calls chargeOnce(...)
│       └── StepHistory.tsx
├── lib/
│   ├── api.ts                admin-panel-api client (appid + sessionid)
│   ├── ai.ts                 /categorize client + buildKeywordRows
│   ├── charger.ts            chargeOnce() — the ONLY write primitive
│   └── store.ts              chrome.storage.local wrappers
├── background.ts             (reserved for future MV3 service worker)
├── types.ts                  mirrors ai-proxy/src/types.ts
└── __tests__/
    ├── ai.test.ts
    ├── charger.test.ts
    ├── chrome-mock.ts
    ├── live-guard.ts
    └── store.test.ts
```

## Run / build

```bash
npm --workspace extension run dev              # vite dev
npm --workspace extension run build            # tsc --noEmit && vite build → dist/
# Chrome → chrome://extensions → Developer mode → "Load unpacked" → extension/dist/
```

## Storage layout

| Key            | Shape                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| `settings.v1`  | `{ sessionId, proxyUrl, model, throttleMs }`                           |
| `session.v1`   | `SessionState` (customers, items, matches, model, fetchedAt, chargedIds, firmOverrides) |
| `audit.v1`     | `ChargeRecord[]` (capped at 5000, FIFO)                                |

Keys are namespace-prefixed so the same browser can host multiple
versions of this extension without colliding.

## Tests

```bash
npm --workspace extension run test
```

23 unit tests. None hit the live backend; see
`src/__tests__/live-guard.ts`.

The full pipeline test (`tests/e2e.test.ts` at the repo root) brings up
a mock backend in-process and exercises `chargeOnce` against it.

## Local-dev test hook

The admin-panel-api base URL (`https://admin-panel-api.codec.com.tr`)
is hardcoded in `src/lib/api.ts`. For tests and manual exercise against
the in-process mock backend, the test setup imports `__setBaseUrlForTests`
and points it at `http://127.0.0.1:<random>`.
