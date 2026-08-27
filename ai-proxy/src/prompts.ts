import type {
  Customer,
  ItemMatch,
  KeywordOverride,
  MatchField,
  UnmatchedItem,
} from "./types.js";
import { CODEC_ACCOUNT_EU_ID, CODEC_ACCOUNT_NAME } from "./types.js";

/**
 * Per-call batch size. Tuned empirically against MiniMax-M3 with the
 * current customer-list + item-row schema:
 *   n=1   →  ~3s
 *   n=5   →  ~7s
 *   n=10  → ~16s
 *   n=25  → ~21s
 *   n=50  → ~25-45s (parallel: ~30-50s with 16 workers)
 *   n=100 → 60-90s with 16 workers; max_tokens=16000 starts cutting off
 * 50 is the sweet spot: it keeps each batch comfortably inside the 90s
 * per-call timeout, has plenty of headroom under the 16k max_tokens cap,
 * and at 16-way concurrency puts a full 3000-item run through the API
 * in roughly 5-7 minutes (instead of the 50+ minutes the 25-batch path
 * used to take).
 */
const BATCH_SIZE = 50;

/** Split items into ≤50-sized batches. */
export function chunkItems<T>(items: T[], size = BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Build the system prompt. Same across batches — only the user-prompt (items)
 * changes per call.
 *
 * Role: keyword-table builder. The AI's output is consumed by a UI that
 * shows one row per unique keyword cluster, so the AI MUST emit
 * `keywordGroup` values that cluster together, and a `suggestedAccountEuId`
 * that the user can override per row.
 */
export function buildSystemPrompt(): string {
  return [
    "You are a routing assistant for a Turkish premium-SMS short-code service (short code 3525).",
    "",
    "Context:",
    "- Subscribers send SMS messages to short code 3525 with two keyword fields (keyword1, keyword2) plus optional body text (msgContent).",
    "- The system already matched most messages to a paying customer (firm). The ones that DID NOT match are listed below — they need to be charged manually to the correct firm.",
    "- You will be given the full customer list with names. Each 'firm' has an account id (acntEuId).",
    "- If NO customer in the list is a good match for a transaction, leave suggestedAccountEuId as null. The UI will list those under 'Codec'e ücretlendir' so a human can charge them manually to the system Codec account.",
    "- READ-ONLY: you are only classifying transactions. You must NEVER trigger charging, NEVER suggest bulk auto-charges, NEVER decide that any group should be auto-billed. The human operator opens each row manually and clicks 'Tümünü ücretlendir' or 'Seçili' to charge — your job ends at producing the keyword-table suggestions.",
    "",
    "Your task — for EACH item, emit exactly ONE annotation:",
    "1. matchedField: which of the three fields (keyword1 | keyword2 | msgContent) carries the dominant signal. See the 'Three-field weighing' rule below — do NOT default to keyword1.",
    "2. matchedValue: the literal substring/value you saw (echo the keyword text from the field you identified in matchedField).",
    "3. keywordGroup: a short, stable cluster slug in kebab-case ASCII, e.g. 'iptal-cancel', 'odeme-payment', 'wat-prefix', 'unknown'. Items that share the same keywordGroup will appear in the same row in the operator's table. Be CONSISTENT — items with the same intent MUST share the same keywordGroup.",
    "4. suggestedAccountEuId: best-matching customer's acntEuId, OR null if none fits well.",
    "5. suggestedAccountName: best-matching customer name (copy exact from list) OR null.",
    "6. confidence: 'high' (clear keyword/firm overlap), 'medium' (plausible), 'low' (guess).",
    "7. reasoning: one short Turkish sentence explaining which field carried the signal and why this firm.",
    "",
    "Three-field weighing (CRITICAL — this is the most common mistake):",
    "Each item has up to THREE independent text fields: keyword1, keyword2, msgContent.",
    "The DISTINGUISHING keyword — the one that actually picks the firm — may live in ANY of the three.",
    "Do NOT default to keyword1 just because it's first. A naive 'keyword1 wins' rule causes wrong-firm",
    "routings when keyword1 is a generic Turkish verb that appears across many intents.",
    "",
    "Examples of the failure mode:",
    "  - keyword1='IPTAL', keyword2='AKTIFBANK'    → 'AKTIFBANK' is the firm marker. 'IPTAL' is generic.",
    "  - keyword1='IPTAL', keyword2='GARANTI'       → 'GARANTI' is the firm marker. 'IPTAL' is generic.",
    "  - keyword1='EVET',   keyword2='IPTAL'        → if a row already exists for 'EVET', the SECOND",
    "                                               keyword (here 'IPTAL') may carry the actual intent",
    "                                               (e.g. cancel flow for a specific firm).",
    "  - keyword1='IPTAL', msgContent='AKTIFBANK IPTAL ONAY' → 'AKTIFBANK' in msgContent dominates.",
    "  - keyword1='IPTAL', keyword2='IPTAL', msgContent='AKTIFBANK' → 'AKTIFBANK' in msgContent dominates.",
    "",
    "Decision rule: pick the field whose value NARROWS DOWN the firm the most. If keyword1 looks",
    "generic (a common verb like IPTAL/EVET/ODEME/HAYIR, a single-character or punctuation value),",
    "the distinguishing signal is probably in keyword2 or msgContent. Read all three before deciding.",
    "Use matchedValue to echo the LITERAL text from the chosen field (so the operator can see what",
    "the AI latched onto when reviewing).",
    "",
    "Strict rules:",
    "- Cover EVERY input item exactly once. Missing items = a hard error.",
    "- DO NOT invent transactionIds — only echo ones from the input list.",
    "- DO NOT invent accountEuIds — only use ones from the customer list (or null).",
    "- keywordGroup must be ASCII kebab-case (a-z, 0-9, '-'). NO Turkish characters, NO spaces.",
    "- Be conservative with 'high' confidence. An operator must agree.",
    "- For garbage/system messages (e.g. keyword1 = '.', random punctuation), still emit a record but use keywordGroup='unknown' and suggestedAccountEuId=null.",
    "- matchedField must reflect the field that ACTUALLY carried the distinguishing signal — not the",
    "  first non-empty one. The operator relies on this column to spot wrong routings.",
  ].join("\n");
}

/** Build the user message: customer list + this batch's items. */
export function buildUserPrompt(
  customers: Customer[],
  items: UnmatchedItem[],
  overrides: KeywordOverride[] = [],
): string {
  const customerLines = customers.map(
    (c, i) => `${i + 1}. acntEuId=${c.acntEuId} | name=${c.name}`,
  );

  const itemLines = items.map(
    (it) =>
      `tx=${it.transactionId} | phone=${it.phone} | kw1="${truncate(it.keyword1, 40)}" | kw2="${truncate(it.keyword2, 40)}" | body="${truncate(it.msgContent, 80)}"`,
  );

  const sections: string[] = [
    `=== CUSTOMERS (${customers.length}) ===`,
    customerLines.join("\n"),
    "",
  ];

  if (overrides.length > 0) {
    sections.push(
      `=== OVERRIDES (${overrides.length}) — operator-maintained routing rules ===`,
      buildOverrideFragment(overrides),
      "",
    );
  }

  sections.push(
    `=== ITEMS (${items.length}) ===`,
    itemLines.join("\n"),
    "",
    "Now call the item_annotations tool. Cover every transactionId exactly once. Do not skip any.",
  );

  return sections.join("\n");
}

/**
 * Render an override list as a prompt fragment the AI can follow.
 * Empty list → "". Caller skips injection when empty.
 *
 * Format chosen to mirror the operator's own Excel/TSV paste:
 *
 *     FİRMA        KEYWORD1   KEYWORD2   KEYWORD3   NOT                              MOD
 *     AKTIFBANK    EVET       ptt        kredi     Customer listesindeki AKTIFBANK   İçerir
 *     YKB          —          evet       —         Onay SMS'leri                     İçerir
 *
 * Rendering rules (driven by the operator's feedback):
 *
 *   - Empty KEYWORD columns (Keyword1/2/3) are OMITTED from the prompt
 *     entirely — we do NOT send `—` placeholders. The model is told
 *     "only the listed keywords are signals for this firm". This
 *     prevents a rule like "Firma=KW1 only" from confusing the AI
 *     into thinking KEYWORD2/3 are also triggers.
 *   - Empty MOD falls back to `İçerir` (default match mode).
 *   - Empty NOT is also omitted from the row, but the column header
 *     stays in place so the AI knows the column exists.
 *   - Firm column always carries the operator-typed accountName
 *     verbatim — this is the literal routing target.
 *   - If accountName didn't resolve to a customer (acntEuId === null)
 *     we annotate "(müşteri listesinde yok)" but still emit the row;
 *     the model will still suggest that name and the operator will
 *     see the firm-unknown warning in the UI.
 *   - Rules whose keywords array is entirely empty are dropped
 *     outright — they would just be a bare firm name.
 *
 * Each emitted rule carries `matchMode`:
 *   - "contains" (default): case-insensitive substring match against
 *     keyword1/keyword2/msgContent.
 *   - "exact": case-insensitive, character-for-character equality
 *     against the full value of keyword1 OR keyword2 OR msgContent
 *     (after trim). Use when the operator wants "keyword1 === 'EVET'"
 *     to route, not "EVET" appearing inside a longer string.
 *
 * CRITICAL CONTRACT: the AI does NOT charge anything. It only suggests
 * (suggestedAccountEuId / suggestedAccountName). The operator manually
 * reviews and clicks "Ücretlendir" in the extension UI. Override rules
 * only steer the suggestion; they never trigger a charge by themselves.
 */
function buildOverrideFragment(overrides: KeywordOverride[]): string {
  // Drop rules with no keywords at all — they would just be a "FİRMA"
  // row with no signals for the AI.
  const usable = overrides.filter((o) =>
    o.keywords.some((k) => k.trim()),
  );
  if (usable.length === 0) return "";

  const lines: string[] = [
    "OVERRIDE RULES — operator-maintained routing table.",
    "Each row = FİRMA → KEYWORD1 → KEYWORD2 → KEYWORD3 → NOT → MOD.",
    "A row's KEYWORD columns are the ONLY signals for that FİRMA. If an item's keyword1/keyword2/msgContent contains any KEYWORD (per MOD semantics), suggest that FİRMA — even if your own customer-list reasoning would route it elsewhere.",
    "Empty KEYWORD columns are intentionally NOT emitted — treat the row as having only the listed keywords. Do not invent matches in unlisted columns.",
    "These are SUGGESTIONS the operator reviews manually — you NEVER auto-charge.",
    "",
  ];

  for (const ov of usable) {
    const kws = ov.keywords.map((k) => k.trim()).filter(Boolean);
    const mode = ov.matchMode === "exact" ? "Tam" : "İçerir"; // empty → fallback
    const acntSuffix = ov.acntEuId
      ? ""
      : " (müşteri listesinde yok — yine de öner, chargeOnce throw eder)";
    const not = (ov.notes ?? "").trim();

    // Build the row parts in order. Empty keyword columns are omitted
    // (no "—" placeholder) so the AI doesn't get false-positive signals.
    const parts: string[] = [`FİRMA: ${ov.accountName}${acntSuffix}`];
    parts.push(`KEYWORD1: ${kws[0]}`);
    if (kws[1]) parts.push(`KEYWORD2: ${kws[1]}`);
    if (kws[2]) parts.push(`KEYWORD3: ${kws[2]}`);
    if (kws.length > 3) {
      // Edge case: operator pasted >3 keywords. Append the rest so
      // nothing is lost — they go under KEYWORD3 with a separator.
      parts.push(
        `KEYWORD3+: ${kws.slice(2).join(" / ")}`,
      );
    }
    if (not) parts.push(`NOT: ${not}`);
    parts.push(`MOD: ${mode}`);

    lines.push(parts.join(" | "));
  }

  // Tail note about the mode semantics — needed once, not per row.
  lines.push("");
  lines.push(
    "MOD semantics: 'İçerir' = case-insensitive substring match against keyword1/keyword2/msgContent; 'Tam' = whole-field equality after trim (case-insensitive).",
  );

  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// --- Tool schema for structured output ----------------------------------------

export const ITEM_ANNOTATIONS_TOOL = {
  name: "item_annotations",
  description:
    "Emit per-item annotations: which keyword field matched, what value, the keyword group, and the suggested firm.",
  input_schema: {
    type: "object",
    properties: {
      matches: {
        type: "array",
        description: "One annotation per input item. Order does not matter.",
        items: {
          type: "object",
          properties: {
            transactionId: { type: "integer" },
            matchedField: {
              type: "string",
              enum: ["keyword1", "keyword2", "msgContent"],
            },
            matchedValue: { type: "string" },
            keywordGroup: {
              type: "string",
              description:
                "ASCII kebab-case cluster name. Same intent = same name across the whole batch.",
            },
            suggestedAccountEuId: {
              type: ["string", "null"],
              description:
                "Best-matching acntEuId (UUID string), or JSON null if no customer in the list is a good fit. MUST be JSON null — not the 4-character string \"null\".",
            },
            suggestedAccountName: {
              type: "string",
              description: "Best-matching customer name, or null.",
            },
            confidence: {
              type: "string",
              enum: ["high", "medium", "low"],
            },
            reasoning: { type: "string", description: "Short Turkish sentence." },
          },
          required: [
            "transactionId",
            "matchedField",
            "matchedValue",
            "keywordGroup",
            "suggestedAccountEuId",
            "suggestedAccountName",
            "confidence",
            "reasoning",
          ],
        },
      },
    },
    required: ["matches"],
  },
} as const;

const VALID_MATCH_FIELDS: ReadonlySet<MatchField> = new Set([
  "keyword1",
  "keyword2",
  "msgContent",
]);

/**
 * Validate the LLM's tool-call payload against the input items.
 * Returns cleaned matches; throws if a transactionId is missing/unknown.
 * Also auto-promotes 'no firm' cases to the Codec fallback so the UI can render
 * them under "Codec'e ücretlendir".
 */
export function validateMatches(
  raw: ItemMatch[],
  items: UnmatchedItem[],
): ItemMatch[] {
  const itemIds = new Set(items.map((i) => i.transactionId));
  const seen = new Set<number>();
  const cleaned: ItemMatch[] = [];

  for (const m of raw) {
    if (!Number.isInteger(m.transactionId)) {
      throw new Error(`match has non-integer transactionId`);
    }
    if (!itemIds.has(m.transactionId)) {
      throw new Error(
        `match references unknown transactionId ${m.transactionId}`,
      );
    }
    if (seen.has(m.transactionId)) {
      throw new Error(
        `transactionId ${m.transactionId} appears in multiple matches`,
      );
    }
    seen.add(m.transactionId);

    const matchedField: MatchField = VALID_MATCH_FIELDS.has(m.matchedField)
      ? m.matchedField
      : "keyword1";

    cleaned.push({
      transactionId: m.transactionId,
      matchedField,
      matchedValue: m.matchedValue ?? "",
      keywordGroup: normalizeGroup(m.keywordGroup),
      suggestedAccountEuId: sanitizeAccountEuId(m.suggestedAccountEuId),
      suggestedAccountName: sanitizeAccountName(m.suggestedAccountName),
      confidence: m.confidence ?? "low",
      reasoning: m.reasoning ?? "",
    });
  }

  const missing = items.filter((i) => !seen.has(i.transactionId));
  if (missing.length > 0) {
    throw new Error(
      `${missing.length} transactionIds were not covered by any match (e.g. ${missing
        .slice(0, 5)
        .map((m) => m.transactionId)
        .join(", ")})`,
    );
  }

  return cleaned;
}

function normalizeGroup(g: string | undefined): string {
  // NFKD splits accented characters so we can drop combining marks
  // (handles İ→i, ç→c, ü→u, ö→o, ş→s, ğ→g, etc.). Dotless 'ı' has no
  // NFKD decomposition so we replace it explicitly afterwards.
  const stripped = (g ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const lower = stripped.toLowerCase().replace(/ı/g, "i");
  return lower
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "unknown";
}

/**
 * Coerce an `accountEuId`-shaped LLM response to either a clean UUID
 * string or JS null. The LLM has been seen to emit:
 *   - the JSON null literal            → keep as null (good)
 *   - the STRING "null"                → coerce to null (LLM misread the schema)
 *   - empty string / whitespace-only   → coerce to null
 *   - a string with surrounding spaces → trim
 *   - anything else                    → keep as-is (operator-side resolveFirm
 *                                       still re-validates with a stricter
 *                                       `sanitizeAccountEuId`)
 */
function sanitizeAccountEuId(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed === "" || trimmed === "null") return null;
  return trimmed;
}

/**
 * Same shape as `sanitizeAccountEuId` but for the human-readable firm
 * name. Empty strings / whitespace / literal "null" become null. The
 * downstream UI uses `?? "Codec"` as a fallback for display only.
 */
function sanitizeAccountName(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed === "" || trimmed === "null") return null;
  return trimmed;
}

// Re-export the fallback constants so callers can use them without diving into types.
export { CODEC_ACCOUNT_EU_ID, CODEC_ACCOUNT_NAME };