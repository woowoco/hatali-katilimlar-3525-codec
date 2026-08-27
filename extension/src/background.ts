// Background service worker.
//
// 1. Opens the UI in a new full-page tab when the toolbar icon is clicked
//    (instead of the default MV3 popup). The manifest drops the
//    `default_popup` field, which is what makes this event fire instead.
// 2. Hosts cross-cutting helpers the popup can't call directly: cookie
//    discovery for the admin-panel session id.
//
// Reserved for future routing/header signing if we ever want to
// centralize backend calls in the service worker. Today all fetches
// happen from the page; the background only owns session discovery
// and tab management.

const APP_URL = chrome.runtime.getURL("index.html");

chrome.action.onClicked.addListener(async () => {
  // Reuse the existing tab if it's open; otherwise create one.
  const existing = await chrome.tabs.query({ url: APP_URL });
  if (existing[0]?.id) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId) {
      await chrome.windows.update(existing[0].windowId, { focused: true });
    }
    return;
  }
  await chrome.tabs.create({ url: APP_URL });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "discover-session") {
    discoverSession(msg.backendOrigin)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({ ok: false, error: String(err?.message ?? err) }),
      );
    return true; // keep the message channel open for async response
  }
  return false;
});

export interface DiscoverSessionResult {
  ok: boolean;
  sessionId?: string;
  source?: "cookie-validated" | "cookie-name" | "manual-required";
  cookieName?: string;
  error?: string;
}

/**
 * Look up the operator's session id from admin-panel.codec.com.tr. Two
 * sources are tried, in order:
 *
 *   1. Cookies visible to admin-panel.codec.com.tr (via the `url` filter
 *      which is more permissive than `domain` and matches parent-domain
 *      cookies too). We try every cookie, not just ones named like a
 *      session token, because private apps sometimes use obscure names.
 *   2. `localStorage` / `sessionStorage` on any open admin-panel tab,
 *      via a content script (see src/content/discover-session.ts).
 *
 * Each candidate is validated by hitting GetCustomersToBeCharged with it
 * as a `sessionid` header. The first one that returns 2xx is the answer.
 */
async function discoverSession(
  backendOrigin = "https://admin-panel-api.codec.com.tr",
): Promise<DiscoverSessionResult> {
  // --- 1. Cookies --------------------------------------------------------
  // Use `url` (not `domain`) — that returns every cookie the browser would
  // attach to admin-panel.codec.com.tr, regardless of how the cookie's
  // own domain attribute is set.
  let cookies: chrome.cookies.Cookie[] = [];
  try {
    cookies = await chrome.cookies.getAll({
      url: "https://admin-panel.codec.com.tr/",
    });
  } catch {
    cookies = [];
  }

  // Filter out obvious noise that couldn't possibly be a session token.
  // (`_ga`, `__cf_bm`, `cf_clearance`, advertising pixels, etc.)
  const NON_SESSION_NAMES =
    /^(_ga|_gid|_gat|__ga|__gid|fbp|_fbp|fr|IDE|MUID|_uet|_dc_gtm|amplitude|mixpanel|segment\.io|__qca|mp_|_hj|hotjar|_pk_|_cfuvid|__cf_bm|cf_clearance|__cfruid|optimizelyEndUserId|_ok|li_at|analytics_sync)$/i;
  const cookieCandidates = cookies.filter(
    (c) => !NON_SESSION_NAMES.test(c.name),
  );

  for (const c of cookieCandidates) {
    try {
      const ok = await validateSession(backendOrigin, c.value);
      if (ok) {
        return {
          ok: true,
          sessionId: c.value,
          cookieName: c.name,
          source: "cookie-validated",
        };
      }
    } catch {
      // try next
    }
  }

  if (cookieCandidates.length > 0) {
    // Cookies existed but none validated against the backend. Surface the
    // first so the user can confirm manually.
    const first = cookieCandidates[0];
    return {
      ok: true,
      sessionId: first.value,
      cookieName: first.name,
      source: "cookie-name",
    };
  }

  // --- 2. localStorage / sessionStorage via content script -------------
  // Cookies are empty (or none validated). Ask any open admin-panel tab
  // for its in-page storage.
  try {
    const storage = await scanContentScriptStorage();
    for (const entry of storage.entries) {
      try {
        const ok = await validateSession(backendOrigin, entry.value);
        if (ok) {
          return {
            ok: true,
            sessionId: entry.value,
            cookieName: `${entry.store}.${entry.key}`,
            source: "cookie-validated",
          };
        }
      } catch {
        // try next
      }
    }
    if (storage.entries.length > 0) {
      const first = storage.entries[0];
      return {
        ok: true,
        sessionId: first.value,
        cookieName: `${first.store}.${first.key}`,
        source: "cookie-name",
      };
    }
    return {
      ok: false,
      source: "manual-required",
      error: storage.error
        ? `${storage.error} (cookies: ${cookies.length}, aday çerez: ${cookieCandidates.length}; localStorage/sessionStorage: 0)`
        : `session bulunamadı (cookies: ${cookies.length}, aday çerez: ${cookieCandidates.length}; localStorage/sessionStorage: 0)`,
    };
  } catch (err) {
    return {
      ok: false,
      source: "manual-required",
      error: `cookies: ${cookies.length}, aday: ${cookieCandidates.length}; content script hatası: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

interface StorageScanResult {
  entries: Array<{ store: "local" | "session"; key: string; value: string }>;
  error?: string;
}

async function scanContentScriptStorage(): Promise<StorageScanResult> {
  // Find any open tab on admin-panel.codec.com.tr.
  const tabs = await chrome.tabs.query({
    url: "https://admin-panel.codec.com.tr/*",
  });
  const tab = tabs[0];
  if (!tab?.id) {
    return {
      entries: [],
      error:
        "admin-panel.codec.com.tr'de açık sekme yok (content script çalışmıyor olabilir)",
    };
  }
  // The content script echoes storage entries. It may need a moment to
  // attach if the tab was opened very recently.
  return chrome.tabs
    .sendMessage(tab.id, { type: "hatali:scan-storage" })
    .then((res) => res as StorageScanResult)
    .catch((err) => ({
      entries: [],
      error: `tab cevap vermedi: ${err instanceof Error ? err.message : String(err)}`,
    }));
}

async function validateSession(
  backendOrigin: string,
  sessionId: string,
): Promise<boolean> {
  const res = await fetch(`${backendOrigin}/api/Menu3525/GetCustomersToBeCharged`, {
    method: "POST",
    headers: {
      appid: "9398192ec61d422a8331529989959242",
      sessionid: sessionId,
      accept: "application/json, text/plain, */*",
      origin: "https://admin-panel.codec.com.tr",
      referer: "https://admin-panel.codec.com.tr/",
      "content-length": "0",
    },
  });
  return res.ok;
}

export {};
