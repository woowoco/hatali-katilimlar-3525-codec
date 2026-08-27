/**
 * In-memory mock of chrome.storage.local. Other tests use this via
 * `installChromeMock()` to avoid touching the real extension storage.
 */

interface ChromeStorage {
  storage: {
    local: {
      get: (keys: string | string[]) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (keys: string | string[]) => Promise<void>;
    };
  };
}

export function createChromeStorage() {
  const data = new Map<string, unknown>();
  return {
    get: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of list) {
        if (data.has(k)) out[k] = data.get(k);
      }
      return out;
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) {
        data.set(k, v);
      }
    },
    remove: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) data.delete(k);
    },
    __dump: () => [...data.entries()],
    __clear: () => data.clear(),
  };
}

export function installChromeMock() {
  const s = createChromeStorage();
  (globalThis as unknown as { chrome: ChromeStorage }).chrome = {
    storage: { local: s },
  };
  return s;
}
