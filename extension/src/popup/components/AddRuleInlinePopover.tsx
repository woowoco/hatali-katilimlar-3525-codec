import { useEffect, useRef, useState } from "react";
import { BookPlus, X, Save } from "lucide-react";
import { loadOverrides, saveOverrides } from "../../lib/store.js";
import type {
  Customer,
  KeywordOverride,
  MatchField,
  OverrideMatchMode,
} from "../../types.js";
import { CODEC_ACCOUNT_NAME } from "../../types.js";

interface AddRuleInlinePopoverProps {
  /**
   * The transactionId this popover was opened from. Embedded in the
   * default `notes` so the operator can audit which tx triggered the
   * rule ("tx=1001, AI suggested Garanti").
   */
  transactionId: number;
  /** Field the AI matched on (for the tooltip + default keyword). */
  matchedField: MatchField;
  /**
   * The literal value the AI matched against. Pre-fills the keyword
   * input — operators usually open the popover because AI routed this
   * wrong, so the offending value is exactly what they want to bind.
   */
  matchedValue: string;
  /** Account name the AI originally suggested (or null). */
  suggestedAccountName: string | null;
  /** Account UUID the AI originally suggested (or null). */
  suggestedAccountEuId: string | null;
  /** Firm picker source. The popover exposes the full customer list. */
  customers: Customer[];
  /** Optional callback after the rule was successfully saved. */
  onSaved?: (rule: KeywordOverride) => void;
  /** Optional callback to close the popover from the parent. */
  onClose?: () => void;
  /**
   * Render position hint. The default "inline" anchors the popover
   * below the trigger button. "modal" centers it (used rarely — only
   * when the row was deleted mid-edit and there's no anchor).
   */
  variant?: "inline" | "modal";
}

/**
 * Per-txId "save this as a permanent rule" popover. Opens from the
 * `/review` `tx-actions` cell. Pre-fills the keyword with whatever
 * value the AI matched, and the firm with the AI's original
 * suggestion — so the operator can mostly just confirm and save.
 *
 * Persistence: `saveOverrides` → `chrome.storage.local["overrides.v2"]`.
 * Every other surface (`OverrideEditor` in /fetch, `FirmOverrideMini`
 * in /review) subscribes to that key, so the new rule shows up
 * everywhere immediately.
 *
 * Safety contract: this component NEVER calls `chargeOnce`. It only
 * persists operator-typed rules. Charging is still gated to the
 * `Seçili (N) Ücretlendir` button onClick in `FirmSectionView`.
 */
export function AddRuleInlinePopover({
  transactionId,
  matchedField,
  matchedValue,
  suggestedAccountName,
  suggestedAccountEuId,
  customers,
  onSaved,
  onClose,
  variant = "inline",
}: AddRuleInlinePopoverProps) {
  // Default firm = AI's suggestion. Fall back to the first customer
  // when the AI returned null (Codec fallback or no confident match).
  const initialFirmIdx = (() => {
    if (suggestedAccountEuId) {
      const i = customers.findIndex((c) => c.acntEuId === suggestedAccountEuId);
      if (i >= 0) return i;
    }
    if (suggestedAccountName) {
      const norm = (s: string) => s.trim().toLowerCase();
      const i = customers.findIndex(
        (c) => norm(c.name) === norm(suggestedAccountName),
      );
      if (i >= 0) return i;
    }
    return customers.length > 0 ? 0 : -1;
  })();

  const [firmIdx, setFirmIdx] = useState<number>(initialFirmIdx);
  const [keyword, setKeyword] = useState<string>(matchedValue);
  const [matchMode, setMatchMode] = useState<OverrideMatchMode>("contains");
  const [notes, setNotes] = useState<string>(
    `tx=${transactionId}, AI suggested ${
      suggestedAccountName ?? CODEC_ACCOUNT_NAME
    } (${matchedField}=${matchedValue})`,
  );
  const [saving, setSaving] = useState(false);

  const popoverRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);

  // Auto-focus the firm dropdown when the popover opens. Escape closes
  // it without saving.
  useEffect(() => {
    firstFieldRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (saving) return;
    // Accept comma/semicolon/newline-separated keyword paste — operators
    // sometimes type "EVET, kredi, onay" rather than three separate rules.
    const kws = keyword
      .split(/[,;\n\r]+/)
      .map((k) => k.trim())
      .filter(Boolean);
    if (kws.length === 0) return;
    const firm = firmIdx >= 0 ? customers[firmIdx] : null;
    if (!firm) return;
    setSaving(true);
    try {
      const all = await loadOverrides();
      // Fold into an existing rule for the same firm + same matchMode so
      // "tek tek kayıt açmak yorucu" doesn't apply here either. If a
      // same-firm rule already exists we extend its keywords; otherwise
      // we create a new rule carrying every keyword.
      const existingIdx = all.findIndex(
        (r) =>
          (r.acntEuId ?? null) === firm.acntEuId &&
          (r.matchMode ?? "contains") === matchMode,
      );
      let rule: KeywordOverride;
      if (existingIdx >= 0) {
        const existing = all[existingIdx];
        const seen = new Set(existing.keywords.map((k) => k.toLowerCase()));
        const additions = kws.filter((k) => !seen.has(k.toLowerCase()));
        if (additions.length === 0) {
          // Nothing new to add — just close (idempotent).
          onSaved?.(existing);
          onClose?.();
          return;
        }
        rule = { ...existing, keywords: [...existing.keywords, ...additions] };
        all[existingIdx] = rule;
      } else {
        rule = {
          id: `ov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          accountName: firm.name,
          acntEuId: firm.acntEuId,
          keywords: kws,
          matchMode,
          notes: notes.trim() || undefined,
        };
        all.push(rule);
      }
      await saveOverrides(all);
      onSaved?.(rule);
      onClose?.();
    } finally {
      setSaving(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void save();
    }
  };

  const containerStyle: React.CSSProperties =
    variant === "modal"
      ? {
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.45)",
          display: "grid",
          placeItems: "center",
          zIndex: 1000,
        }
      : {
          position: "absolute",
          right: 0,
          top: "calc(100% + 4px)",
          width: 320,
          zIndex: 50,
        };

  return (
    <div style={containerStyle} onMouseDown={(e) => {
      // Click-outside closes (variant=modal). For inline, the parent's
      // button click toggles open/close, so we don't auto-close here.
      if (variant === "modal" && e.target === e.currentTarget) onClose?.();
    }}>
      <div
        ref={popoverRef}
        className="add-rule-popover"
        role="dialog"
        aria-label="Sabit kural oluştur"
        style={
          variant === "modal"
            ? {
                width: 340,
                background: "var(--bg-1, #1a1a1a)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 12,
                boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
              }
            : {
                background: "var(--bg-1, #1a1a1a)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 10,
                boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
              }
        }
      >
        <div
          className="add-rule-popover__head"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 8,
          }}
        >
          <BookPlus size={11} />
          <strong style={{ fontSize: 11 }}>Sabit kural oluştur</strong>
          <span style={{ flex: 1 }} />
          <button
            className="ghost"
            onClick={onClose}
            title="Kapat (Esc)"
            aria-label="Kapat"
          >
            <X size={10} />
          </button>
        </div>
        <p
          className="muted"
          style={{ fontSize: 10, marginTop: 0, marginBottom: 6 }}
        >
          AI'ın <code>{matchedField}</code> alanında{" "}
          <code>"{matchedValue}"</code> ile eşleştirdiği tx
          <b> #{transactionId}</b>. Bu keyword için kalıcı yönlendirme
          kuralı oluştur.
        </p>

        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            fontSize: 10,
            color: "var(--muted, #888)",
            marginBottom: 6,
          }}
        >
          Firma
          <select
            ref={firstFieldRef}
            value={firmIdx >= 0 ? String(firmIdx) : ""}
            onChange={(e) => setFirmIdx(Number(e.target.value))}
            style={{ fontSize: 12 }}
          >
            {customers.length === 0 && <option value="">(müşteri yok)</option>}
            {customers.map((c, i) => (
              <option key={c.acntEuId} value={String(i)}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            fontSize: 10,
            color: "var(--muted, #888)",
            marginBottom: 6,
          }}
        >
          Keyword (virgülle ayrılmış birden fazla olabilir)
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={handleKey}
            spellCheck={false}
            style={{ fontSize: 12 }}
            placeholder="EVET, kredi, onay"
          />
        </label>

        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            fontSize: 10,
            color: "var(--muted, #888)",
            marginBottom: 6,
          }}
        >
          Eşleşme modu
          <select
            value={matchMode}
            onChange={(e) =>
              setMatchMode(e.target.value as OverrideMatchMode)
            }
            style={{ fontSize: 12 }}
          >
            <option value="contains">İçerir (substring)</option>
            <option value="exact">Tam eşleşme</option>
          </select>
        </label>

        <label
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
            fontSize: 10,
            color: "var(--muted, #888)",
            marginBottom: 8,
          }}
        >
          Not (opsiyonel)
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            style={{ fontSize: 11 }}
          />
        </label>

        <div
          className="row"
          style={{ marginTop: 4, justifyContent: "flex-end", gap: 6 }}
        >
          <button className="ghost sm" onClick={onClose}>
            İptal
          </button>
          <button
            className="primary sm"
            onClick={() => void save()}
            disabled={saving || !keyword.trim() || firmIdx < 0}
            title="Kuralı kaydet"
          >
            <Save size={10} /> Kaydet
          </button>
        </div>
      </div>
    </div>
  );
}
