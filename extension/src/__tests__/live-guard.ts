/**
 * Live-network guard for extension tests.
 *
 * The extension talks to two endpoints:
 *  - /api/Menu3525/* on the user's admin-panel-api.codec.com.tr backend
 *  - the AI proxy at /categorize /models
 *
 * Tests use a mocked fetch (see src/__tests__/mocks.ts) which already pins
 * responses. This guard catches any stray real fetch call and refuses it, so
 * a test never accidentally hits production.
 *
 * Override with LIVE=1 env var ONLY if you really mean it.
 */
import { afterEach, beforeEach } from "vitest";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  if (process.env.LIVE === "1") {
    console.warn("[live-guard] LIVE=1 — live network calls allowed");
    return;
  }
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const raw =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    // Anything addressed to localhost / 127.0.0.1 is fine: that's where the
    // mock-server, the AI proxy and the extension's local fixtures live.
    if (/^(https?:)?\/*\/?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])/.test(raw)) {
      return originalFetch(input as never, init);
    }
    throw new Error(
      `[live-guard] REFUSED non-localhost fetch to ${raw}. ` +
        `Set LIVE=1 only if you really mean to hit a live API.`,
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});
