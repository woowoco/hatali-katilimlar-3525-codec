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
const OVERRIDES_KEY = "overrides.v1"; // operator-maintained keyword → firm rules

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

export async function loadOverrides(): Promise<KeywordOverride[]> {
  const raw = await chrome.storage.local.get(OVERRIDES_KEY);
  return Array.isArray(raw[OVERRIDES_KEY]) ? raw[OVERRIDES_KEY] : [];
}

export async function saveOverrides(list: KeywordOverride[]): Promise<void> {
  await chrome.storage.local.set({ [OVERRIDES_KEY]: list });
}

// Re-export so consumers can import the type alongside the loader.
type Customer = import("../types.js").Customer;
type Item = import("../types.js").UnmatchedItem;