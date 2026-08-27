// Shared types between AI proxy and the extension.
// These mirror the contract observed in the HAR capture from admin-panel-api.codec.com.tr.

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
  msgDate: string; // ISO 8601
  id: string;
}

// --- AI output (per-item annotations, keyword-centric) ----------------------

export type MatchField = "keyword1" | "keyword2" | "msgContent";

/** One per transactionId — produced by the AI for every input item. */
export interface ItemMatch {
  transactionId: number;
  matchedField: MatchField;
  matchedValue: string; // literal substring/value that matched
  keywordGroup: string; // canonical group name e.g. "iptal-cancel", "wat-prefix"
  /** Null = no firm match — UI puts these under the "Codec'e ücretlendir" section. */
  suggestedAccountEuId: string | null;
  suggestedAccountName: string | null;
  confidence: "high" | "medium" | "low";
  reasoning: string; // short Turkish explanation
}

/** Hard-coded fallback UUID observed in the HAR for "charge to Codec". */
export const CODEC_ACCOUNT_EU_ID = "00000000-0000-0000-0000-000000000000";
export const CODEC_ACCOUNT_NAME = "Codec";

/**
 * Operator-maintained routing rule. If any `keywords` matches an item's
 * keyword1/keyword2/msgContent according to `matchMode`, the AI MUST charge
 * the item to `accountName`. These rules always win over the model's
 * free-form reasoning.
 *
 * - `contains` (default): trigger if any keyword appears as a
 *   case-insensitive substring of keyword1/keyword2/msgContent.
 * - `exact`: trigger only if keyword1 OR keyword2 OR msgContent is
 *   character-for-character equal (after trim, case-insensitive) to one
 *   of the keywords. Use this when a single short keyword like "EVET"
 *   or "iptal" should route only when the field IS exactly that value —
 *   not when it's embedded in a longer string.
 */
export type OverrideMatchMode = "contains" | "exact";

export interface KeywordOverride {
  id: string;
  accountName: string;
  /** Resolved against the customer list before sending; may be null. */
  acntEuId: string | null;
  keywords: string[];
  /** Defaults to "contains" if omitted. */
  matchMode?: OverrideMatchMode;
}

export interface CategorizeRequest {
  items: UnmatchedItem[];
  customers: Customer[];
  /** Override the proxy default model. Optional. */
  model?: string;
  /** Operator-maintained keyword → firm rules. Optional. */
  overrides?: KeywordOverride[];
}

export interface CategorizeResponse {
  model: string;
  batches: number;
  matches: ItemMatch[];
  /**
   * True when at least one batch was dropped (timeout, repeated 5xx, etc.)
   * but other batches already completed. The `matches` array still contains
   * everything that DID succeed — slots for dropped batches stay `undefined`
   * and the UI surfaces them under the unmatched items section.
   *
   * When `partial === false` (or omitted) the run was clean: every input
   * item has a corresponding match.
   */
  partial?: boolean;
  /** Per-batch failure summaries. Only populated when `partial` is true. */
  failedBatches?: Array<{ batchIndex: number; error: string }>;
}

// --- Charged API -------------------------------------------------------------

export interface ChargedRequest {
  accountEuId: string;
  transactionIdsWithSubscriptionDate: number[];
}

export interface ChargedResponse {
  resultObject: boolean;
  isSuccess: boolean;
  resultCode: number;
  resultDetails: string;
  exceptionInformation: unknown | null;
}