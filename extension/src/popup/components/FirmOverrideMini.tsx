import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  loadOverrides,
  saveOverrides,
  subscribeStorageKey,
  OVERRIDES_KEY_V2,
} from "../../lib/store.js";
import type { KeywordOverride } from "../../types.js";

interface FirmOverrideMiniProps {
  /**
   * The accountEuId this mini-editor is bound to. Pre-existing rules
   * for this accountEuId are shown so the operator can see what's
   * already wired. New rules created here will target the same
   * accountEuId — that's the whole point of placing the editor
   * directly under the firm heading.
   */
  accountEuId: string;
  /**
   * Display name for the firm (only used in confirmations + titles;
   * the rule itself uses accountEuId as the resolved ID).
   */
  accountName: string;
}

/**
 * Compact, single-firm-scoped override editor rendered directly under
 * each firm heading in StepReview. Differs from the full OverrideEditor
 * in StepFetch in two important ways:
 *
 *   1. accountName + acntEuId are FIXED — the operator doesn't pick
 *      a firm, the surrounding firm section already tells us who we
 *      are editing for. This rules out the "wrong-firm selection"
 *      hazard entirely.
 *
 *   2. Only the keyword input is interactive. The match mode + notes
 *      fields are omitted for now; if needed, the operator can still
 *      edit those in StepFetch's full OverrideEditor. This keeps the
 *      inline UI small (one input + Ekle button) so it doesn't
 *      balloon the firm section visually.
 *
 * Persistence: chrome.storage.local["overrides.v2"] (envelope). The
 * full OverrideEditor (StepFetch) and AddRuleInlinePopover
 * (also /review) write to the same key — a rule added anywhere shows
 * up here via `subscribeStorageKey` and vice versa. No more `rev`
 * counter hack to remount on save.
 *
 * Hard rule: this component NEVER calls `chargeOnce`. It only
 * persists operator-typed rules; charge is gated to the
 * `Seçili (N) Ücretlendir` button onClick in FirmSectionView.
 */
export function FirmOverrideMini({
  accountEuId,
  accountName,
}: FirmOverrideMiniProps) {
  const [rules, setRules] = useState<KeywordOverride[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draftKw, setDraftKw] = useState("");

  // One-shot load + reactive subscription on the v2 key. We never
  // depend on `accountEuId` for refetch — a different firm selection
  // means the parent mounted a different instance, and the subscription
  // scope (the global overrides.v2 key) is the same regardless.
  useEffect(() => {
    let cancelled = false;
    const apply = (list: KeywordOverride[]) => {
      if (cancelled) return;
      setRules(list.filter((r) => (r.acntEuId ?? null) === accountEuId));
      setLoaded(true);
    };
    loadOverrides().then(apply).catch(() => setLoaded(true));
    const off = subscribeStorageKey<unknown>(OVERRIDES_KEY_V2, (next) => {
      const list = unwrap(next);
      apply(list);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [accountEuId]);

  const handleAdd = async () => {
    const kw = draftKw.trim();
    if (!kw) return;
    const next: KeywordOverride = {
      id: `ov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      accountName,
      acntEuId: accountEuId,
      keywords: [kw],
      matchMode: "contains",
    };
    const all = await loadOverrides();
    all.push(next);
    await saveOverrides(all);
    setDraftKw("");
    // No setRev here — the subscription fires on storage write and
    // re-applies the filtered list.
  };

  const handleRemove = async (id: string) => {
    const all = await loadOverrides();
    await saveOverrides(all.filter((r) => r.id !== id));
  };

  if (!loaded) return null;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && draftKw.trim()) {
      e.preventDefault();
      void handleAdd();
    } else if (e.key === "Escape") {
      setDraftKw("");
    }
  };

  return (
    <div className="firm-override-mini">
      <div className="firm-override-mini__head">
        <span className="muted" style={{ fontSize: 10.5 }}>
          <strong>Özel eşleştirme:</strong> bu firmaya özel keyword
          ekle — AI bunları otomatik tespit edemezse bu kurallara uyar
        </span>
      </div>

      {rules.length > 0 && (
        <ul className="firm-override-mini__list">
          {rules.map((r) =>
            r.keywords.map((kw, i) => (
              <li key={`${r.id}-${i}`}>
                <span className="firm-override-mini__kw">{kw}</span>
                <span className="firm-override-mini__mode">
                  {r.matchMode === "exact" ? "tam" : "içerir"}
                </span>
                <button
                  className="ghost sm"
                  onClick={() => handleRemove(r.id)}
                  title="Bu kuralı sil"
                  aria-label="Kuralı sil"
                >
                  <X size={10} />
                </button>
              </li>
            )),
          )}
        </ul>
      )}

      <div className="firm-override-mini__add">
        <input
          type="text"
          value={draftKw}
          onChange={(e) => setDraftKw(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`keyword ekle (örn. ${accountName.slice(0, 12).toLowerCase()})`}
          spellCheck={false}
        />
        <button
          className="ghost sm"
          onClick={handleAdd}
          disabled={!draftKw.trim()}
          title={`Bu firmaya özel yeni keyword kuralı ekle`}
        >
          <Plus size={10} /> Ekle
        </button>
      </div>
    </div>
  );
}

// --- helpers ---------------------------------------------------------------

/**
 * The v2 envelope is `{ version: 2, rules: KeywordOverride[] }`. Older
 * code paths and tests can still write a bare array (no envelope) —
 * unwrap defensively so a v1 write doesn't break the mini editor.
 */
function unwrap(raw: unknown): KeywordOverride[] {
  if (raw && typeof raw === "object" && "rules" in raw) {
    const r = (raw as { rules: unknown }).rules;
    if (Array.isArray(r)) return r as KeywordOverride[];
  }
  if (Array.isArray(raw)) return raw as KeywordOverride[];
  return [];
}
