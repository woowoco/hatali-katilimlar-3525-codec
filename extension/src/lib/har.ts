// Extract the operator's `sessionid` from a Chrome DevTools HAR capture.
//
// Why: the admin-panel SPA keeps its session id in JavaScript memory, not
// in any cookie or localStorage / sessionStorage entry. The only durable
// copy we can read from outside the page is the `sessionid` request
// header that the SPA stamps on every backend call. That header is
// preserved verbatim in HAR exports (`request.headers[]`).
//
// Spec: http://www.softwareishard.com/blog/har-12-spec/

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse HAR JSON text and return the first `sessionid` request header
 * value found that looks like a UUID. Returns `undefined` if the file is
 * not a valid HAR or has no such header.
 *
 * The session id is read but never persisted; the caller decides where
 * it lands (here it goes into `chrome.storage.local` via `saveSettings`).
 */
export function extractSessionFromHar(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const entries = (parsed as { log?: { entries?: unknown[] } })?.log?.entries;
  if (!Array.isArray(entries)) return undefined;

  for (const entry of entries) {
    const headers =
      (entry as { request?: { headers?: { name: string; value: string }[] } })
        ?.request?.headers;
    if (!Array.isArray(headers)) continue;
    for (const h of headers) {
      if (!h || typeof h.name !== "string") continue;
      if (!/^sessionid$/i.test(h.name)) continue;
      if (typeof h.value !== "string") continue;
      const trimmed = h.value.trim();
      if (UUID_RE.test(trimmed)) return trimmed;
    }
  }
  return undefined;
}
