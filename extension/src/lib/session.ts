import type { DiscoverSessionResult } from "../background.js";

export type { DiscoverSessionResult } from "../background.js";

/**
 * Ask the background service worker to discover the operator's
 * `sessionid` from admin-panel.codec.com.tr cookies, validate it against
 * the backend, and return it. Fails with a user-readable `error` on the
 * result if no cookie is found or none validates.
 */
export async function discoverSession(
  backendOrigin = "https://admin-panel-api.codec.com.tr",
): Promise<DiscoverSessionResult> {
  return chrome.runtime.sendMessage({
    type: "discover-session",
    backendOrigin,
  });
}
