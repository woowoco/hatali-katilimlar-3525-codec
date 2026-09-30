import type {
  CategorizeBatchSummary,
  Settings,
  ChargeRecord,
  ItemMatch,
  KeywordOverride,
} from "../types.js";
import { DEFAULT_SETTINGS } from "../types.js";

// chrome.storage.local is the only persistence we use: machine-local,
// not synced, and survives popup close + browser restart until cleared.

const SETTINGS_KEY = "settings.v1";
const SESSION_KEY = "session.v1"; // session-scoped state: customers, items, matches
const AUDIT_KEY = "audit.v1"; // history of every Charged POST sent
// v1 stores a bare KeywordOverride[] array. v2 stores an envelope
// `{ version: 2, rules: KeywordOverride[] }`. See
// `docs/OVERRIDES-JSON-FORMAT.md`. `loadOverrides`/`saveOverrides` keep
// both shapes working transparently; new writes go to v2.
const OVERRIDES_KEY_V1 = "overrides.v1";
const OVERRIDES_KEY_V2 = "overrides.v2";

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(raw[SETTINGS_KEY] ?? {}) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

// --- Session-scoped data ---------------------------------------------------

/**
 * Resolved firm identity for a txId or row. `accountEuId` is always a
 * UUID-shaped string (validated by the helpers in `lib/ai.ts`); `accountName`
 * is a display string only — the server keys by UUID. The `null` name
 * case happens when a row resolves to the HAR-confirmed Codec fallback
 * without a real customer behind it; UI substitutes "Codec".
 */
export type Firm = {
  accountEuId: string;
  accountName: string | null;
};

export interface SessionState {
  customers: Customer[];
  items: Item[];
  matches: ItemMatch[] | null;
  model: string | null;
  fetchedAt: string | null;
  /** Set of transactionIds already charged successfully (greyed out in the UI). */
  chargedIds: number[];
  /**
   * transactionIds the operator has explicitly removed from the table via
   * the per-row ✕ button. Filtered out of `buildKeywordRows` like
   * `chargedIds`, but never sent to the backend (no audit record). The
   * operator can re-run `/categorize` to get fresh suggestions; ids in
   * this list are still re-suggested by the AI if they appear in the
   * source data again.
   */
  ignoredIds: number[];
  /** Per-row firm overrides the operator has applied: keywordGroup → firm. */
  firmOverrides: Record<string, Firm>;
  /**
   * Per-transactionId firm reassignment. Set by the operator from the
   * per-row firm picker in the review table. Takes precedence over
   * `firmOverrides` and the AI suggestion. Lets the operator move
   * wrongly-suggested txIds to the correct firm without touching the
   * rest of the row.
   *
   * Map shape: `{ [transactionId]: { accountEuId, accountName } }`. Empty
   * object `{}` means "no per-tx reassignment yet"; each txId falls back
   * to the row-level override or the AI suggestion.
   */
  txFirmOverrides: Record<number, Firm>;
  /** Last /categorize run's per-batch summaries; survives a re-open of /analyze. */
  lastBatches?: CategorizeBatchSummary[];
  /** Total items in the last categorize run; used for the batch table header. */
  lastItemsCount?: number;
  /** Subset of items the user wants the AI to process. null = process all. */
  subset?: ItemSubset | null;
}

/**
 * User-chosen slice of session.items to feed the AI. Persisted so the
 * selection survives popup close / re-open. Stored as a half-open range
 * over the current unmatched-items list (which is sorted by the API).
 */
export type ItemSubset =
  | { mode: "all" }
  | { mode: "head"; count: number }
  | { mode: "tail"; count: number }
  | { mode: "range"; start: number; end: number };

export const EMPTY_SESSION: SessionState = {
  customers: [],
  items: [],
  matches: null,
  model: null,
  fetchedAt: null,
  chargedIds: [],
  ignoredIds: [],
  firmOverrides: {},
  txFirmOverrides: {},
};

export async function loadSession(): Promise<SessionState> {
  const raw = await chrome.storage.local.get(SESSION_KEY);
  return { ...EMPTY_SESSION, ...(raw[SESSION_KEY] ?? {}) };
}

export async function saveSession(session: SessionState): Promise<void> {
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

export async function clearSession(): Promise<void> {
  await chrome.storage.local.remove(SESSION_KEY);
}

// --- Audit log -------------------------------------------------------------

export async function appendAudit(rec: ChargeRecord): Promise<void> {
  const raw = await chrome.storage.local.get(AUDIT_KEY);
  const list: ChargeRecord[] = raw[AUDIT_KEY] ?? [];
  list.push(rec);
  const trimmed = list.length > 5000 ? list.slice(-5000) : list;
  await chrome.storage.local.set({ [AUDIT_KEY]: trimmed });
}

export async function loadAudit(): Promise<ChargeRecord[]> {
  const raw = await chrome.storage.local.get(AUDIT_KEY);
  return raw[AUDIT_KEY] ?? [];
}

export async function clearAudit(): Promise<void> {
  await chrome.storage.local.remove(AUDIT_KEY);
}

// --- Keyword overrides ------------------------------------------------------

/**
 * Load the operator's keyword → firm override rules.
 *
 * Tries `overrides.v2` first (envelope `{ version: 2, rules }`). If
 * missing, falls back to `overrides.v1` (bare `KeywordOverride[]`) and
 * returns those values verbatim — the on-disk shape never changed for
 * the rules themselves, only the wrapping. The next `saveOverrides`
 * call will promote the data to v2.
 *
 * Returned list is always `KeywordOverride[]` regardless of which key
 * was read; callers never need to know about the envelope.
 */
export async function loadOverrides(): Promise<KeywordOverride[]> {
  const raw = await chrome.storage.local.get([OVERRIDES_KEY_V2, OVERRIDES_KEY_V1]);
  const v2 = raw[OVERRIDES_KEY_V2] as
    | { version?: number; rules?: unknown }
    | undefined;
  if (v2 && Array.isArray(v2.rules)) {
    return v2.rules as KeywordOverride[];
  }
  const v1 = raw[OVERRIDES_KEY_V1];
  return Array.isArray(v1) ? (v1 as KeywordOverride[]) : [];
}

/**
 * Persist the operator's keyword → firm override rules under the
 * current schema (`overrides.v2`, envelope `{ version: 2, rules }`).
 * The legacy `overrides.v1` key is not touched — it remains in storage
 * as orphan until Chrome's storage quota reclaim removes it.
 */
export async function saveOverrides(list: KeywordOverride[]): Promise<void> {
  await chrome.storage.local.set({
    [OVERRIDES_KEY_V2]: { version: 2, rules: list },
  });
}

// --- Cross-component storage subscriptions ---------------------------------

/**
 * Subscribe to changes on a single `chrome.storage.local` key.
 *
 * The override rules list can be mutated from several UI surfaces
 * (OverrideEditor in /fetch, FirmOverrideMini in /review, the new
 * per-tx popover in /review). Without a shared listener, a rule added
 * in /review would not show up in StepAnalyze until the operator
 * navigated away and back. Wrapping `chrome.storage.onChanged` here
 * gives every consumer a single, consistent hook to re-read after any
 * write, regardless of which surface performed it.
 *
 * `cb` receives the new value typed as `T`, or `undefined` when the
 * key was removed. The listener filters to `area === "local"` so it
 * does not collide with `chrome.storage.sync` / `chrome.storage.session`
 * if a future feature introduces them.
 *
 * Returns an unsubscribe function — callers should invoke it from a
 * `useEffect` cleanup to avoid stale listeners on hot-reload.
 */
export function subscribeStorageKey<T>(
  key: string,
  cb: (newValue: T | undefined) => void,
): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: chrome.storage.AreaName,
  ) => {
    if (area !== "local") return;
    const ch = changes[key];
    if (!ch) return;
    cb(ch.newValue as T | undefined);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// Re-export the v2 key so consumers (and `subscribeStorageKey` callers)
// subscribe to the same key the writer targets.
export { OVERRIDES_KEY_V2 };

// Re-export so consumers can import the type alongside the loader.
type Customer = import("../types.js").Customer;
type Item = import("../types.js").UnmatchedItem;