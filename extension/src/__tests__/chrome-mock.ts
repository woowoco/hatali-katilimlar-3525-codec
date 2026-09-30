/**
 * In-memory mock of chrome.storage.local. Other tests use this via
 * `installChromeMock()` to avoid touching the real extension storage.
 */

type ChangeListener = (
  changes: Record<string, chrome.storage.StorageChange>,
  area: chrome.storage.AreaName,
) => void;

interface ChromeStorage {
  storage: {
    local: {
      get: (keys: string | string[]) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      remove: (keys: string | string[]) => Promise<void>;
      __fireChange: (key: string, newValue: unknown) => void;
    };
    onChanged: {
      addListener: (cb: ChangeListener) => void;
      removeListener: (cb: ChangeListener) => void;
    };
  };
}

export function createChromeStorage() {
  const data = new Map<string, unknown>();
  const listeners = new Set<ChangeListener>();
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
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [k, v] of Object.entries(items)) {
        const oldValue = data.get(k);
        if (oldValue !== v) {
          changes[k] = { oldValue, newValue: v };
        }
        data.set(k, v);
      }
      // Auto-fire onChanged after set completes — mirrors real Chrome
      // behaviour where set() resolves and then listeners run. Tests can
      // also fire manually via `__fireChange`.
      if (Object.keys(changes).length > 0) {
        for (const fn of listeners) fn(changes, "local");
      }
    },
    remove: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const k of list) {
        if (data.has(k)) {
          changes[k] = { oldValue: data.get(k), newValue: undefined };
          data.delete(k);
        }
      }
      if (Object.keys(changes).length > 0) {
        for (const fn of listeners) fn(changes, "local");
      }
    },
    /**
     * Manually trigger an `onChanged` event for one key. Used by tests
     * that simulate a write from another extension surface (e.g.
     * background script) without going through this mock's `set()`.
     */
    __fireChange: (key: string, newValue: unknown) => {
      const oldValue = data.get(key);
      const changes: Record<string, chrome.storage.StorageChange> = {
        [key]: { oldValue, newValue },
      };
      if (newValue === undefined) data.delete(key);
      else data.set(key, newValue);
      for (const fn of listeners) fn(changes, "local");
    },
    __dump: () => [...data.entries()],
    __clear: () => data.clear(),
    // exposed for subscribeStorageKey-style tests; not part of the
    // real chrome API surface.
    __listeners: listeners,
  };
}

export function installChromeMock() {
  const s = createChromeStorage();
  (globalThis as unknown as { chrome: ChromeStorage }).chrome = {
    storage: {
      local: s,
      onChanged: {
        addListener: (cb: ChangeListener) => {
          s.__listeners.add(cb);
        },
        removeListener: (cb: ChangeListener) => {
          s.__listeners.delete(cb);
        },
      },
    },
  };
  return s;
}

export type ChromeStorageMock = ReturnType<typeof createChromeStorage>;
