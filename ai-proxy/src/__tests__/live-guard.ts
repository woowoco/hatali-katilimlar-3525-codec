/**
 * Live-network guard. Any test that tries to talk to a non-localhost address
 * will throw, so we can never accidentally hit the production MiniMax API or
 * the live admin-panel-api.codec.com.tr backend.
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
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!/^(https?:)?\)?\/?\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])/.test(url)) {
      throw new Error(
        `[live-guard] REFUSED non-localhost fetch to ${url}. ` +
          `Set LIVE=1 only if you really mean to hit a live API.`,
      );
    }
    return originalFetch(input as never, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});