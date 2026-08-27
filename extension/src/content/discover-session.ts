// Content script running in admin-panel.codec.com.tr pages.
//
// The MV3 cookies API only sees browser-set cookies. Many SPAs (this
// admin panel is one of them) keep the operator's session id in
// `localStorage` or `sessionStorage` instead, and stamp it onto outgoing
// requests as a custom header. We can't read those from the background,
// so we ask the page itself when the popup requests it.
//
// The content script runs in an isolated world but shares the page's
// origin, so `localStorage` / `sessionStorage` are accessible.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Keys we explicitly know to be session-token carriers. Listed here as a
// hint for the heuristic but the scan is permissive — we accept any
// string-shaped value that looks like a UUID.
const SESSION_KEY_HINTS =
  /^session(id)?$|^session_?id$|^asp\.net_sessionid$|^phpsessid$|^jsessionid$|^connect\.sid$/i;

interface StorageEntry {
  store: "local" | "session";
  key: string;
  value: string;
}

function scanStore(store: Storage, storeName: "local" | "session"): StorageEntry[] {
  const out: StorageEntry[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key) continue;
    const raw = store.getItem(key);
    if (!raw) continue;
    const value = raw.trim();
    // Accept: keys that look session-shaped, or values that look like a
    // UUID. Both are strong signals that this is the operator's session.
    const isUuid = UUID_RE.test(value);
    const keyHint = SESSION_KEY_HINTS.test(key);
    if (isUuid || keyHint) {
      out.push({ store: storeName, key, value });
    }
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "hatali:scan-storage") return false;
  try {
    const entries: StorageEntry[] = [
      ...scanStore(localStorage, "local"),
      ...scanStore(sessionStorage, "session"),
    ];
    sendResponse({ entries });
  } catch (err) {
    sendResponse({
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Returning true keeps the channel open for the async sendResponse
  // above. In practice we respond synchronously but we keep the
  // signature stable for future async work.
  return true;
});

export {};
