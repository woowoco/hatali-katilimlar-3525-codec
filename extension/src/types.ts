// Shared types — kept in sync with ai-proxy/src/types.ts.
// (Duplicated to avoid a workspace cross-build dep on the proxy package.)

export interface Customer {
  name: string;
  acntEuId: string;
}

export interface UnmatchedItem {
  transactionId: number;
  phone: string;
  keyword1: string;
  keyword2: string;
  msgContent: string;
  shortCode: string;
  msgDate: string;
  id: string;
}

export type MatchField = "keyword1" | "keyword2" | "msgContent";

export interface ItemMatch {
  transactionId: number;
  matchedField: MatchField;
  matchedValue: string;
  keywordGroup: string;
  suggestedAccountEuId: string | null;
  suggestedAccountName: string | null;
  confidence: "high" | "medium" | "low";
  reasoning: string;
}

export interface CategorizeResponse {
  model: string;
  batches: number;
  items: number;
  matches: ItemMatch[];
  /**
   * True when the proxy returned a partial result because at least one
   * batch timed out or hit repeated 5xx. `matches` still contains
   * everything that DID succeed; slots for dropped batches are
   * `undefined` and the UI surfaces them as unmatched.
   */
  partial?: boolean;
  /** Per-batch failure reasons. Only populated when `partial` is true. */
  failedBatches?: Array<{ batchIndex: number; error: string }>;
}

/** Per-batch summary the extension remembers so /analyze can be reopened. */
export interface CategorizeBatchSummary {
  /** 0-based index of the batch. */
  i: number;
  /** Number of items the batch contained. */
  size: number;
  /** Number of matches produced by this batch. */
  matches: number;
  /** Cumulative match count after this batch completed. */
  accumulated: number;
  /**
   * Full ItemMatch[] produced by THIS batch. Populated since 2026-08-28
   * so the extension can persist each completed batch into the session
   * incrementally (per `docs/SAFETY-CONTRACT.md` §3 — the operator
   * never loses matched data on a mid-run timeout/error). Optional
   * for back-compat with older proxy versions that ship only a count.
   */
  matchesList?: ItemMatch[];
}

export interface ModelInfo {
  id: string;
  label: string;
  recommended?: boolean;
}

// --- Keyword override list --------------------------------------------------

/**
 * One operator-maintained rule: whenever any of `keywords` shows up in an
 * item's keyword1/keyword2/msgContent, charge it to `accountName`
 * (resolved to `acntEuId` against the customer list at runtime).
 *
 * `matchMode` controls how `keywords` are matched:
 *   - "contains" (default): case-insensitive substring match.
 *   - "exact": case-insensitive character-for-character equality
 *     (after trim). Use this when a short keyword like "EVET" should
 *     route only when the field IS exactly "EVET".
 */
export type OverrideMatchMode = "contains" | "exact";

export interface KeywordOverride {
  id: string;
  /** Display name of the firm (e.g. "Aktif Bank"). Used in the UI. */
  accountName: string;
  /**
   * Optional cached acntEuId. Filled in by the extension when the
   * customer list is loaded; falls back to null if not found.
   */
  acntEuId: string | null;
  /** Substrings that trigger this rule. */
  keywords: string[];
  /** Defaults to "contains" if omitted. */
  matchMode?: OverrideMatchMode;
  /** Operator notes — shown in the UI, ignored by the AI. */
  notes?: string;
}

// --- Charged API ------------------------------------------------------------

export interface ChargedResponse {
  resultObject: boolean;
  isSuccess: boolean;
  resultCode: number;
  resultDetails: string;
  exceptionInformation: unknown | null;
}

/** HAR-confirmed fallback account UUID for "charge to Codec". */
export const CODEC_ACCOUNT_EU_ID = "00000000-0000-0000-0000-000000000000";
export const CODEC_ACCOUNT_NAME = "Codec";

// --- Settings ---------------------------------------------------------------

export interface Settings {
  sessionId: string;
  proxyUrl: string;
  model: string;
  throttleMs: number;
  /**
   * When true, admin-panel-api calls and /categorize calls are short-
   * circuited to the in-process mock fixture (`lib/api-mock.ts`,
   * `lib/ai-mock.ts`). Off by default. Intended for manual UI
   * verification only — no production workflow should ever enable it.
   */
  demoMode: boolean;
  /**
   * Opt-in fingerprint clustering. When true, /analyze groups items by
   * normalized (kw1, kw2, msgContent) before sending, sending ONE
   * representative per cluster to the LLM and replicating the LLM's
   * verdict to all cluster members on the way back. Off by default —
   * the existing per-row LLM path is the safe baseline for production.
   *
   * Safety contract: this only changes how many LLM calls happen, not
   * who triggers them. `chargeOnce` still requires a manual UI click.
   * Cluster expansion preserves every original transactionId verbatim —
   * no txId is ever lost, duplicated, or remapped.
   */
  clusteringEnabled?: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sessionId: "",
  proxyUrl: "http://localhost:8787",
  model: "MiniMax-M3",
  throttleMs: 200,
  demoMode: false,
  clusteringEnabled: false,
};

// --- Charge flow ------------------------------------------------------------

export type ChargeStatus =
  | "idle"
  | "running"
  | "paused"
  | "done"
  | "cancelled"
  | "error";

export interface ChargeRecord {
  transactionId: number;
  accountEuId: string;
  accountName: string | null;
  /** Comma-separated list when this was a bulk charge, single id otherwise. */
  transactionIds: number[];
  status: "success" | "error";
  resultCode: number | null;
  resultDetails: string;
  sentAt: string; // ISO
}

export interface ChargeProgress {
  status: ChargeStatus;
  /** Display label of the row currently being processed, e.g. "iptal-cancel". */
  rowLabel: string | null;
  total: number;
  done: number;
  failed: number;
  current: { transactionId: number; accountName: string | null } | null;
  errors: Array<{ transactionId: number; error: string }>;
}