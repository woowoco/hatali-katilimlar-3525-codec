/**
 * E2E live-network guard. Only localhost (mock backend + mock AI target) is
 * allowed; anything else must throw. Override with LIVE=1 if you really mean
 * it — but the e2e test should never need to.
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
