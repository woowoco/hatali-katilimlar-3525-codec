// Static pre-analysis for the LLM: group items by fingerprint before sending,
// replicate the LLM's per-representative verdict to all cluster members on
// the way back. Read-only — never charges anything. See `docs/SAFETY-CONTRACT.md`.

import type { ItemMatch, UnmatchedItem } from "../types.js";

/**
 * Turkish-fold + trim. Mirrors the approach used by `normalizeGroup` in
 * `ai-proxy/src/prompts.ts` so the extension and the proxy agree on what
 * "same fingerprint" means. Sharing this function across the workspace
 * boundary would require a new cross-build util module — out of scope;
 * if the rules diverge in the future, run regression tests in BOTH.
 *
 *   "İPTAL"      → "iptal"
 *   "IPTAL"      → "iptal"   (matches İPTAL — handles mojibake)
 *   "  Evet  "   → "evet"
 *   "ODEME ÖDEME"→ "odeme odeme"  (whitespace preserved inside; trim at edges)
 *   undefined    → ""
 */
function norm(s: string | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ı/g, "i")
    .trim();
}

/**
 * Stable fingerprint from the three text fields the operator wants evaluated
 * for grouping. Only items whose normalized (kw1, kw2, msgContent) triple is
 * character-identical collapse into the same cluster.
 *
 * msgContent is included because the operator explicitly required (2026-08-27)
 * that "kw + msgContent" fields both be evaluated — different bodies MUST
 * NOT be grouped together even if kw1/kw2 match. The trade-off: items with
 * non-empty msgContent are usually unique and stay singleton (no LLM win),
 * but the grouping is provably safe.
 *
 * Returns the literal string used as the Map key — `||` for three empty
 * fields, never undefined.
 */
export function fingerprint(item: UnmatchedItem): string {
  return `${norm(item.keyword1)}|${norm(item.keyword2)}|${norm(item.msgContent)}`;
}

export interface ClusterResult {
  /** One representative per unique fingerprint. Each is a real input item — never fabricated. */
  representatives: UnmatchedItem[];
  /**
   * representativeTxId → all original txIds sharing that fingerprint, with
   * the representative's txId listed FIRST. Used by `expandClusterMatches`
   * to replicate the LLM's verdict to every cluster member.
   */
  clusterMap: Map<number, number[]>;
}

/**
 * Group items by fingerprint. One representative per group + a map of which
 * original txIds each representative stands for.
 *
 * INVARIANTS — verified by tests in `__tests__/clustering.test.ts`:
 *   1. Sum of all `clusterMap` values (flattened) === input `items.length`.
 *   2. No txId appears in more than one cluster list (partition).
 *   3. `representatives.length` === number of unique fingerprints.
 *   4. `representatives` ⊆ `items` (we never fabricate items).
 *   5. Each cluster's items all share the same normalized (kw1, kw2, msgContent).
 *
 * Representative choice: lowest transactionId. msgContent is part of the
 * fingerprint so items within a cluster are guaranteed identical — no
 * meaningful tie-break to do; lowest-id gives a deterministic, test-
 * reproducible choice.
 */
export function clusterByFingerprint(items: UnmatchedItem[]): ClusterResult {
  const groups = new Map<string, UnmatchedItem[]>();
  for (const it of items) {
    const fp = fingerprint(it);
    const arr = groups.get(fp);
    if (arr) arr.push(it);
    else groups.set(fp, [it]);
  }
  const representatives: UnmatchedItem[] = [];
  const clusterMap = new Map<number, number[]>();
  for (const group of groups.values()) {
    const rep = group.reduce((best, it) =>
      it.transactionId < best.transactionId ? it : best,
    );
    representatives.push(rep);
    clusterMap.set(
      rep.transactionId,
      group.map((g) => g.transactionId),
    );
  }
  return { representatives, clusterMap };
}

/**
 * Replicate each representative's match to all cluster members.
 *
 * CRITICAL CONTRACT — what the operator relies on:
 *   1. txIds in the output ARE the original cluster txIds (verbatim, no remap).
 *   2. Every original cluster txId appears EXACTLY ONCE in the output.
 *   3. Match metadata (matchedField, matchedValue, keywordGroup,
 *      suggestedAccountEuId, suggestedAccountName, confidence, reasoning)
 *      is the LLM's verdict for the representative, applied uniformly to
 *      all cluster members (which by fingerprint equivalence share intent).
 *
 * Throws if `matches` contains a transactionId that isn't in `clusterMap` —
 * the LLM produced something for an unknown representative. This is a
 * programmer error upstream (validateMatches in the proxy already rejects
 * unknown ids, but this is defense-in-depth at the extension seam).
 */
export function expandClusterMatches(
  matches: ItemMatch[],
  clusterMap: Map<number, number[]>,
): ItemMatch[] {
  const expanded: ItemMatch[] = [];
  const seen = new Set<number>();
  for (const m of matches) {
    const clusterIds = clusterMap.get(m.transactionId);
    if (!clusterIds) {
      throw new Error(
        `expandClusterMatches: representative txId ${m.transactionId} not in clusterMap`,
      );
    }
    for (const id of clusterIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      // transactionId is the ONLY field that differs from the LLM's
      // response. Everything else is the LLM's verdict, applied uniformly.
      expanded.push({ ...m, transactionId: id });
    }
  }
  return expanded;
}
