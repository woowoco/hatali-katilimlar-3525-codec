import type { KeywordOverride, MatchField, OverrideMatchMode, UnmatchedItem } from "../types.js";

/**
 * Result of matching a single item against the override list.
 * Returned by `matchItem` for every rule that fires on the item.
 *
 * The shape mirrors what `ai-proxy/src/prompts.ts::buildOverrideFragment`
 * tells the LLM to do, so we can render the same dry-run report the
 * LLM would produce, plus a per-rule usage counter for the editor.
 */
export interface OverrideMatch {
  /** The rule whose keyword matched. */
  ruleId: string;
  /** Which keyword in the rule's array matched first. */
  matchedKeyword: string;
  /** Which field of the item carried the match. */
  matchedField: MatchField;
}

/**
 * Try to match every rule's keywords against one item's three text
 * fields. Returns the matches in rule order; for rules with multiple
 * keywords, only the first matching keyword is reported per rule.
 *
 * Match semantics (mirrors the prose contract in
 * `ai-proxy/src/prompts.ts::buildOverrideFragment`):
 *
 *   - `matchMode: "contains"` (default) — case-insensitive substring
 *     match against the literal contents of `keyword1`, `keyword2`,
 *     or `msgContent`. Empty-keyword rules never match.
 *   - `matchMode: "exact"` — case-insensitive whole-field equality
 *     AFTER TRIM. The field's full value (whitespace stripped) must
 *     equal one of the rule's keywords.
 *
 * Returns an empty array when nothing matches — `null` is reserved
 * for a missing item in higher-level helpers. Empty keyword lists
 * never match (mirrors the prompt fragment's drop-empty rule).
 */
export function matchItem(
  item: UnmatchedItem,
  rules: KeywordOverride[],
): OverrideMatch[] {
  const out: OverrideMatch[] = [];
  for (const rule of rules) {
    const kws = rule.keywords.map((k) => k.trim()).filter(Boolean);
    if (kws.length === 0) continue;
    const mode = rule.matchMode === "exact" ? "exact" : "contains";

    const hit = tryMatchRule(item, kws, mode);
    if (hit) {
      out.push({ ruleId: rule.id, ...hit });
    }
  }
  return out;
}

function tryMatchRule(
  item: UnmatchedItem,
  kws: string[],
  mode: "contains" | "exact",
): { matchedKeyword: string; matchedField: MatchField } | null {
  const fields: Array<[MatchField, string]> = [
    ["keyword1", item.keyword1],
    ["keyword2", item.keyword2],
    ["msgContent", item.msgContent],
  ];
  for (const [fieldName, raw] of fields) {
    if (!raw) continue;
    const fieldNorm = mode === "exact" ? raw.trim().toLowerCase() : raw.toLowerCase();
    for (const kw of kws) {
      const kwNorm = kw.toLowerCase();
      if (mode === "exact") {
        if (fieldNorm === kwNorm) return { matchedKeyword: kw, matchedField: fieldName };
      } else {
        if (fieldNorm.includes(kwNorm)) return { matchedKeyword: kw, matchedField: fieldName };
      }
    }
  }
  return null;
}

/**
 * Pick the single highest-priority match for an item. Ties broken by
 * rule order in the input list (caller decides priority). Returns
 * `null` if no rule matches.
 *
 * Used by `AddRuleInlinePopover`'s "AI suggested this firm" pre-fill
 * and by `OverrideEditor`'s dry-run report (one match per row keeps
 * the table compact).
 */
export function firstMatch(
  item: UnmatchedItem,
  rules: KeywordOverride[],
): OverrideMatch | null {
  const all = matchItem(item, rules);
  return all.length > 0 ? all[0] : null;
}

/**
 * Walk a rule list against an item list and produce per-rule usage
 * counts plus a few example transactionIds per rule.
 *
 * Used by OverrideEditor (F1 dry-run report + F4 stats). Pure — no
 * IO, no side effects. The transactionIds list is capped at `cap`
 * to keep the rendered report short even when a keyword hits 3,000
 * items.
 */
export interface RuleUsageStat {
  ruleId: string;
  matchCount: number;
  sampleTransactionIds: number[];
}

export function computeRuleUsage(
  rules: KeywordOverride[],
  items: UnmatchedItem[],
  cap = 5,
): RuleUsageStat[] {
  const stats: RuleUsageStat[] = [];
  for (const rule of rules) {
    const samples: number[] = [];
    let count = 0;
    for (const item of items) {
      const hit = matchItem(item, [rule])[0];
      if (hit) {
        count += 1;
        if (samples.length < cap) samples.push(item.transactionId);
      }
    }
    stats.push({ ruleId: rule.id, matchCount: count, sampleTransactionIds: samples });
  }
  return stats;
}

/**
 * One "firm card" in the editor — a single firm + matchMode pair, with
 * every rule that targets that combination. Used by OverrideEditor to
 * render one card per firm instead of one row per rule (the operator's
 * main complaint: creating N keywords meant opening N separate rules).
 *
 * The data model is unchanged — this is a view layer helper. When the
 * operator adds a keyword inside a card, it's appended to the first
 * rule of that group (or a new rule is spawned if the group is empty);
 * deleting a chip removes it from its parent rule, and an emptied rule
 * drops out of the group.
 */
export interface FirmGroup {
  /** Trimmed lower-cased firm name, or "boş" when accountName is blank. */
  firmKey: string;
  /** Display name taken from the first rule that joined the group. */
  displayName: string;
  matchMode: OverrideMatchMode;
  /** All KeywordOverrides that target this firmKey + matchMode pair. */
  rules: KeywordOverride[];
}

/**
 * Bucket rules by `(firmKey, matchMode)`. The first rule to join a
 * bucket wins the canonical `displayName`; later rules with the same
 * firmKey but a slightly different casing get folded into the same
 * bucket so the operator sees one card, not three. Returned in a
 * stable order (Turkish locale, alphabetical firmKey + matchMode).
 */
export function groupRulesByFirmAndMode(
  rules: KeywordOverride[],
): FirmGroup[] {
  const map = new Map<string, FirmGroup>();
  for (const r of rules) {
    const firmKey = (r.accountName ?? "").trim().toLowerCase() || "(boş)";
    const mode: OverrideMatchMode = r.matchMode ?? "contains";
    const key = `${firmKey}::${mode}`;
    const g = map.get(key);
    if (g) {
      g.rules.push(r);
    } else {
      map.set(key, {
        firmKey,
        displayName: r.accountName || "",
        matchMode: mode,
        rules: [r],
      });
    }
  }
  return [...map.values()].sort((a, b) => {
    if (a.firmKey !== b.firmKey) {
      return a.firmKey.localeCompare(b.firmKey, "tr");
    }
    return a.matchMode === b.matchMode
      ? 0
      : a.matchMode.localeCompare(b.matchMode, "tr");
  });
}

/**
 * Aggregate per-group match counts by joining `computeRuleUsage` over
 * every rule in the group. Used to render the "N × eşleşme" pill on a
 * firm card when items are loaded. Cheap: each rule is matched against
 * each item exactly once (no quadratic grouping).
 */
export interface FirmGroupUsage {
  groupFirmKey: string;
  groupMatchMode: OverrideMatchMode;
  totalMatchCount: number;
  sampleTransactionIds: number[];
}

export function computeFirmGroupUsage(
  groups: FirmGroup[],
  items: UnmatchedItem[],
  cap = 5,
): FirmGroupUsage[] {
  const out: FirmGroupUsage[] = [];
  for (const g of groups) {
    const stats = computeRuleUsage(g.rules, items, cap);
    let total = 0;
    const samples: number[] = [];
    for (const s of stats) {
      total += s.matchCount;
      for (const tx of s.sampleTransactionIds) {
        if (samples.length < cap) samples.push(tx);
      }
    }
    out.push({
      groupFirmKey: g.firmKey,
      groupMatchMode: g.matchMode,
      totalMatchCount: total,
      sampleTransactionIds: samples,
    });
  }
  return out;
}
