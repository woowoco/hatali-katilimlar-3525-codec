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
    "- You will be given the full customer list as numbered entries (1., 2., 3., …). Each entry has a firm name; the index number is the identifier you emit as `suggestedAccountEuId`. The proxy will translate the index back to the real account id before charging, so you MUST use the integer index from the list — do NOT invent or repeat UUIDs.",
    "- If NO customer in the list is a good match for a transaction, set `suggestedAccountEuId` to JSON null (not the string \"null\", not 0). The UI will list those under 'Codec'e ücretlendir' so a human can charge them manually to the system Codec account.",
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
    "- DO NOT invent accountEuIds. Emit the INTEGER INDEX from the customer list above (1-based) as `suggestedAccountEuId`. Never invent UUIDs — the proxy translates your integer back to the real account id, and only valid indices are accepted.",
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
  // Customer lines use 1-based integer indices instead of the 36-char
  // UUID. The LLM echoes the index as `suggestedAccountEuId`; the proxy
  // translates it back to the real UUID via `withResolvedCustomerIds`
  // before returning the match to the extension. Saves ~13 tokens per
  // customer per call — at 627 customers × 15 batches that's ~120k
  // input tokens per run.
  const customerLines = customers.map(
    (c, i) => `${i + 1}. name=${c.name}`,
  );

  const itemLines = items.map(
    (it) =>
      `tx=${it.transactionId} | phone=${it.phone} | kw1="${truncate(it.keyword1, 40)}" | kw2="${truncate(it.keyword2, 40)}" | body="${truncate(it.msgContent, 80)}"`,
  );

  const sections: string[] = [
    `=== CUSTOMERS (${customers.length}) — emit the index number (1..${customers.length}) as suggestedAccountEuId ===`,
    customerLines.join("\n"),
    "",
  ];

  // Filter out rules with no keywords here so the header count matches
  // the rules actually rendered in the fenced block. Empty-keyword rules
  // are bare firm names with no signals for the AI; including them in
  // the header (without rendering) confuses the operator reviewing the
  // prompt in the dev console.
  const usableOverrides = overrides.filter((o) =>
    o.keywords.some((k) => k.trim()),
  );
  if (usableOverrides.length > 0) {
    sections.push(
      `=== OVERRIDES (${usableOverrides.length}) — operator-maintained routing rules ===`,
      buildOverrideFragment(usableOverrides, customers),
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
 * Render the override list as a fenced JSON block the AI can follow.
 * Empty list (or list whose every rule has empty keywords) → "" so the
 * caller can skip injection entirely — matching the previous contract
 * at `prompts.ts` `if (overrides.length > 0)` upstream.
 *
 * Wire format (see `docs/OVERRIDES-JSON-FORMAT.md` for rationale):
 *
 *   ```json
 *   { "rules": [ { accountName, acntEuId, keywords, matchMode, notes,
 *                  resolvedFromCustomerList, warning? }, … ] }
 *   ```
 *
 *   - `acntEuId` is emitted as the INTEGER INDEX from the customer
 *     list passed to `buildUserPrompt` (1-based), or `null` when the
 *     rule's UUID does not resolve. This mirrors the existing pattern
 *     for `suggestedAccountEuId`: the LLM emits an integer index, the
 *     proxy translates it back via `resolveCustomerIndexToEuId`. Rules
 *     with `acntEuId === null` become suggestions with `null` and
 *     land in the Codec fallback bucket in the extension UI.
 *   - `warning` is set ONLY when the firm is missing from the customer
 *     list. We do NOT bake the warning into `accountName` (the previous
 *     " (müşteri listesinde yok)" suffix made the value dirty for
 *     downstream prompt-output comparison).
 *   - `resolvedFromCustomerList` is a flat boolean the LLM and our
 *     regression tests can use without parsing prose.
 *   - Rules whose `keywords` array is entirely empty are dropped
 *     outright — matches the previous behaviour and prevents the AI
 *     from seeing bare firm names as "always-route" rows.
 *
 * CRITICAL CONTRACT (preserved verbatim from the previous text-format
 * fragment): the AI NEVER auto-charges. It only emits
 * `suggestedAccountEuId` / `suggestedAccountName` suggestions; the
 * operator manually reviews and clicks "Ücretlendir". Override rules
 * steer suggestions; they never trigger a charge by themselves. See
 * `docs/SAFETY-CONTRACT.md` §1 — "AI is read-only".
 */
function buildOverrideFragment(
  overrides: KeywordOverride[],
  customers: Customer[],
): string {
  // Drop rules with no keywords at all — they would just be a "FİRMA"
  // row with no signals for the AI.
  const usable = overrides.filter((o) =>
    o.keywords.some((k) => k.trim()),
  );
  if (usable.length === 0) return "";

  // Build the 1-based index → UUID lookup once. We use a case-
  // insensitive name match because the operator-typed accountName may
  // differ from the canonical customer name in whitespace/casing.
  const norm = (s: string) => s.trim().toLowerCase();
  const customerIndexByName = new Map<string, number>();
  customers.forEach((c, i) => {
    if (c.name) customerIndexByName.set(norm(c.name), i + 1);
  });

  const rules: Record<string, unknown>[] = usable.map((ov) => {
    const idx = customerIndexByName.get(norm(ov.accountName));
    const resolved = idx !== undefined;
    // Resolve UUID → integer index only when the rule's stored UUID
    // matches the canonical UUID we have on file for that customer.
    // A null UUID on the rule side is fine (operator may have added
    // the firm by name only); we still try the name match above.
    let emittedEuId: number | null = null;
    if (resolved && idx !== undefined) {
      const canonical = customers[idx - 1]?.acntEuId;
      if (ov.acntEuId == null || ov.acntEuId === "" || ov.acntEuId === canonical) {
        emittedEuId = idx;
      } else {
        // UUID in storage doesn't match the customer's current UUID.
        // Treat as "not in list" so the AI doesn't suggest a stale id.
        emittedEuId = null;
      }
    }
    const entry: Record<string, unknown> = {
      accountName: ov.accountName,
      acntEuId: emittedEuId,
      keywords: ov.keywords.map((k) => k.trim()).filter(Boolean),
      matchMode: ov.matchMode === "exact" ? "exact" : "contains",
      notes: (ov.notes ?? "").trim(),
      resolvedFromCustomerList: resolved && emittedEuId !== null,
    };
    if (!resolved || emittedEuId === null) {
      entry.warning =
        "müşteri listesinde yok — yine de öner, chargeOnce throw eder";
    }
    return entry;
  });

  // Hand-roll the JSON output: stable key ordering, no `undefined`
  // values, and 2-space indentation that matches the rest of the
  // prompt's readability. `JSON.stringify` with a replacer handles
  // the trailing-comma issue for omitted keys naturally.
  const ruleJson = rules
    .map((r) => JSON.stringify(r, null, 2).split("\n").map((l, i) => (i === 0 ? l : "  " + l)).join("\n"))
    .join(",\n");

  const header =
    "These are SUGGESTIONS the operator reviews manually — the AI NEVER auto-charges.\n" +
    "A rule's `keywords` are matched (per `matchMode`) against the LITERAL contents " +
    "of an item's keyword1, keyword2, or msgContent fields. If matched, the AI must " +
    "emit `suggestedAccountName` equal to the rule's `accountName` and " +
    "`suggestedAccountEuId` equal to the integer INDEX of that firm in the customer " +
    "list above (or `null` if `acntEuId === null`).\n";

  const footer =
    "\n`matchMode` semantics:\n" +
    "  - \"contains\" — case-insensitive substring match against keyword1/keyword2/msgContent\n" +
    "  - \"exact\"    — case-insensitive whole-field equality after trim (the entire\n" +
    "                 value of the matched field must equal one of `keywords`)\n" +
    "\n" +
    "`acntEuId` field: the INTEGER INDEX from the customer list above (1-based),\n" +
    "or `null` if the firm is not in the customer list. The proxy translates the\n" +
    "integer back to the real UUID before charging.";

  return header + "\n```json\n{\n  \"rules\": [\n" + ruleJson + "\n  ]\n}\n```\n" + footer;
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
              type: ["integer", "null"],
              description:
                "Best-matching customer's INDEX from the customer list above (1-based, integer). The proxy translates this back to the real account id before charging. JSON null if no customer fits — not 0 and not the string \"null\".",
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
 * Result of validating the LLM's tool-call payload against the input items.
 *
 * The function is intentionally PARTIAL-tolerant (since 2026-08-28) — one
 * malformed row no longer nukes the whole batch. The previous all-or-nothing
 * behaviour silently discarded 50 records when a single non-integer txId
 * arrived, which the operator flagged as a top complaint. The caller decides
 * what to do with `missing` and `invalid` — `runOneBatch` issues a cheap
 * repair call for ≤5 missing items and synthesises Codec-fallback
 * placeholders for >5 (so the operator still sees the records).
 */
export interface ValidateResult {
  /** Successfully normalised matches, one per input transactionId. */
  cleaned: ItemMatch[];
  /** Input transactionIds that the LLM did not cover (length 0..items.length). */
  missing: number[];
  /** Raw records dropped for non-integer / unknown / duplicate transactionId. */
  invalid: unknown[];
}

/**
 * Validate the LLM's tool-call payload against the input items. Returns
 * `{cleaned, missing, invalid}`; never throws on a single bad row.
 *
 * - For each input record, drop into `invalid[]` on non-integer / unknown /
 *   duplicate txId (logged to console.warn so the operator can see the drop).
 * - After the loop, `missing` is the set of input txIds absent from `cleaned`.
 * - Auto-promotes 'no firm' cases (`suggestedAccountEuId === null`) so the
 *   UI renders them under "Codec'e ücretlendir".
 */
export function validateMatches(
  raw: readonly unknown[],
  items: UnmatchedItem[],
  customers: Customer[] = [],
): ValidateResult {
  const itemIds = new Set(items.map((i) => i.transactionId));
  const seen = new Set<number>();
  const cleaned: ItemMatch[] = [];
  const invalid: unknown[] = [];

  for (const candidate of raw) {
    const m = candidate as Partial<ItemMatch>;
    const tx = m?.transactionId;

    if (!Number.isInteger(tx)) {
      console.warn(
        `[validateMatches] dropping match with non-integer transactionId (${JSON.stringify(tx)})`,
      );
      invalid.push(candidate);
      continue;
    }
    if (!itemIds.has(tx as number)) {
      console.warn(
        `[validateMatches] dropping match referencing unknown transactionId ${tx}`,
      );
      invalid.push(candidate);
      continue;
    }
    if (seen.has(tx as number)) {
      console.warn(
        `[validateMatches] dropping duplicate match for transactionId ${tx}`,
      );
      invalid.push(candidate);
      continue;
    }
    seen.add(tx as number);

    const matchedField: MatchField = VALID_MATCH_FIELDS.has(m.matchedField as MatchField)
      ? (m.matchedField as MatchField)
      : "keyword1";

    // The LLM emits the integer INDEX from the customer list (1-based),
    // not a UUID. Resolve it back to the real account id here so the
    // extension sees the wire shape (`string | null`) it expects.
    const resolvedEuId = resolveCustomerIndexToEuId(
      m.suggestedAccountEuId,
      customers,
    );

    cleaned.push({
      transactionId: tx as number,
      matchedField,
      matchedValue: m.matchedValue ?? "",
      keywordGroup: normalizeGroup(m.keywordGroup),
      suggestedAccountEuId: resolvedEuId,
      suggestedAccountName: sanitizeAccountName(m.suggestedAccountName),
      confidence: m.confidence ?? "low",
      reasoning: m.reasoning ?? "",
    });
  }

  const missing = items
    .filter((i) => !seen.has(i.transactionId))
    .map((i) => i.transactionId);

  if (missing.length > 0) {
    console.warn(
      `[validateMatches] ${missing.length} transactionIds were not covered ` +
        `(e.g. ${missing.slice(0, 5).join(", ")})`,
    );
  }

  return { cleaned, missing, invalid };
}

/**
 * Translate the LLM's integer customer index back to the real UUID.
 * Tolerates literal-string `"null"`, whitespace strings, and out-of-
 * range / non-integer values — anything we can't translate becomes
 * null, which lands the record in the Codec fallback bucket in the
 * extension (per `docs/SAFETY-CONTRACT.md`).
 */
function resolveCustomerIndexToEuId(
  raw: unknown,
  customers: Customer[],
): string | null {
  if (raw == null) return null;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) return null;
    return lookupCustomer(raw, customers);
  }
  if (typeof raw === "string") {
    // Reuse the existing schema-tolerance helper to coerce literal
    // "null" / whitespace / empty strings — anything left after that is
    // either a bare numeric index ("3") or garbage. Garbage → null.
    const cleaned = sanitizeAccountEuId(raw);
    if (cleaned == null) return null;
    const n = Number(cleaned);
    if (!Number.isInteger(n)) return null;
    return lookupCustomer(n, customers);
  }
  return null;
}

function lookupCustomer(idx: number, customers: Customer[]): string | null {
  if (idx < 1 || idx > customers.length) {
    console.warn(
      `[validateMatches] dropping customer index ${idx} (out of range 1..${customers.length}); routing to Codec`,
    );
    return null;
  }
  return customers[idx - 1].acntEuId ?? null;
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