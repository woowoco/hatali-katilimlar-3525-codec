import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts"],
    environment: "node",
    // Hard-block any test from accidentally hitting a live URL.
    // Override with LIVE=1 only when you intentionally want to test against
    // the real MiniMax endpoint.
    env: {
      ANTHROPIC_API_KEY: "test-key-not-real",
      ANTHROPIC_BASE_URL: "http://localhost:0/mock-anthropic",
    },
    setupFiles: ["src/__tests__/live-guard.ts"],
  },
});