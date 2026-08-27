# Local operations

This document covers everything you need to run the project by hand and
to verify nothing has been broken.

## One-time setup

```bash
# Clone or pull, then:
npm install                              # install both workspaces
cp ai-proxy/.env.example ai-proxy/.env  # then edit ANTHROPIC_API_KEY
```

The `.env.example` ships with these keys:

| Variable                    | Purpose                                              |
| --------------------------- | ---------------------------------------------------- |
| `ANTHROPIC_API_KEY`         | MiniMax Anthropic API key                            |
| `ANTHROPIC_BASE_URL`        | Defaults to `https://api.minimax.io/anthropic`       |
| `PROXY_DEFAULT_MODEL`       | Defaults to `MiniMax-M3`                             |
| `PROXY_ALLOWED_ORIGINS`     | CORS origin allowlist (e.g. `chrome-extension://*`)  |
| `PORT`                      | Proxy port, defaults to `8787`                       |

## Running everything locally

```bash
# Terminal 1 — AI proxy on :8787
npm run dev:proxy

# Terminal 2 — mock backend on :8788 (only if you want to exercise the
# extension UI without touching production)
npm run mock:backend

# Terminal 3 — extension dev server (HMR)
npm run dev:ext
# Load `extension/dist/` (or the dev URL) via chrome://extensions → "Load unpacked"
```

In the extension popup:

1. Settings → paste the session id (from DevTools → Network → any
   `/api/Menu3525/*` request → `sessionid` header).
2. Fetch → pulls customers + ~3.6k unmatched items.
3. Analyze → categorizes via the proxy.
4. Review → keyword-grouped table. **Click only the rows you intend to
   charge.** Each click sends exactly one `Charged` POST.
5. History → audit log.

## Building for local "install"

```bash
npm run build:ext          # → extension/dist/
# chrome://extensions → Developer mode → "Load unpacked" → extension/dist/
```

`extension/dist/` is fully self-contained and can be zipped and shared
within the operator's team.

## Verifying tests are mock-only

```bash
npm test
```

Output should show `44 passed` across ai-proxy, extension and the root
e2e suite. None of them should print `LIVE=1`. If you ever see a test
running with `LIVE=1` in CI, **stop the build** — the live-guard
should be firing.

You can prove the guard works:

```bash
LIVE=0 vitest run --config vitest.config.ts   # expected: PASS
LIVE=1 vitest run --config vitest.config.ts   # expected: guard logs a warning
                                              # but tests still PASS (guard is opt-out not opt-in)
```

The guard is enforced via a `beforeEach` hook in `tests/live-guard.ts`
(mirrored in `ai-proxy/src/__tests__/live-guard.ts` and
`extension/src/__tests__/live-guard.ts`). Any stray fetch to a
non-localhost URL throws immediately.

## When something goes wrong

| Symptom                                  | Likely cause                              | Fix                                                                                 |
| ---------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `/categorize` returns 502                 | MiniMax rejected the request              | Read `[express] error:` and `[categorize] failed:` lines in the proxy logs          |
| Extension popup says "sessionId boş"     | Settings → sessionId field empty          | Re-paste the session id; the field is required by every API call                    |
| All charges return `resultCode: 42`      | Operator's sessionid expired              | Re-login to admin-panel.codec.com.tr, grab the new sessionid                        |
| `chargeOnce` writes "error" to audit log | Network blip or stale session             | The audit row stays; re-click once the underlying issue is resolved                  |
| Extension says "blocked by CORS"        | `PROXY_ALLOWED_ORIGINS` missing extension | Add `chrome-extension://<id>` (or `chrome-extension://*` in dev) to the proxy `.env` |

## Cleaning storage

If you ever need to wipe local state for testing:

```bash
# In the popup, History tab → "Geçmişi temizle" — clears audit.v1 only.
# Settings tab → "Mevcut oturumu sıfırla" — clears session.v1.
# chrome.storage.local.clear() removes everything; do it via DevTools only when developing.
```

## Telemetry / logs

- The extension does not send telemetry anywhere.
- The proxy logs each `/categorize` failure to `stderr`. Adjust verbosity
  by overriding the [server.ts](../ai-proxy/src/server.ts) `console.error`.
- The mock backend logs `[mock] <event>` lines; `MOCK_QUIET=1` silences
  the HAR-fallback warning if you're running tests.
