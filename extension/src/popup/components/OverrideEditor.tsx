import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Trash2,
  Save,
  FileText,
  AlertCircle,
  Download,
  Upload,
  FlaskConical,
  Search,
  X as XIcon,
} from "lucide-react";
import {
  loadOverrides,
  saveOverrides,
  subscribeStorageKey,
  OVERRIDES_KEY_V2,
} from "../../lib/store.js";
import {
  parseOverrideBulk,
  previewOverrideBulk,
  type PreviewRow,
  type PreviewStatus,
} from "../../lib/overrideParser.js";
import {
  exportOverridesToJson,
  importOverridesFromJson,
  formatImportSummary,
  triggerDownload,
} from "../../lib/overrideExport.js";
import {
  computeRuleUsage,
  groupRulesByFirmAndMode,
  computeFirmGroupUsage,
  type FirmGroup,
  type RuleUsageStat,
  type FirmGroupUsage,
} from "../../lib/overrideMatcher.js";
import { useToast } from "./Toast.js";
import type {
  Customer,
  KeywordOverride,
  OverrideMatchMode,
  UnmatchedItem,
} from "../../types.js";

/**
 * Editor for the operator-maintained keyword → firm override list.
 * Each rule: "if any of these substrings shows up in keyword1/2/body,
 * charge to this firm." Persisted in chrome.storage.local under
 * "overrides.v2" (envelope `{ version: 2, rules: [...] }`).
 *
 * **Bulk entry formats (both still supported):**
 *   1. JSON envelope (preferred) — file picker or paste. See
 *      `docs/OVERRIDES-JSON-FORMAT.md`.
 *   2. Legacy pipe / TSV / Excel paste (still works for operators
 *      who already have sheets).
 *
 * **View: firm-grouped cards.** Rules are bucketed by
 * `(accountName, matchMode)` so one firm = one card, regardless of how
 * many keyword entries live in that rule's `keywords` array. Operators
 * add keywords as chips inside the card instead of opening a fresh rule
 * per keyword — the operator-facing fix for the "tek tek kayıt açmak
 * yorucu" complaint. The underlying data model is still a flat
 * `KeywordOverride[]` (unchanged from the JSON refactor).
 *
 * **Cross-component sync:** a `subscribeStorageKey(OVERRIDES_KEY_V2, …)`
 * listener replaces the previous one-shot load. Now /review and
 * /analyze see rule edits immediately.
 *
 * Safety: this component NEVER calls `chargeOnce`. It only persists
 * operator-typed rules.
 */
export function OverrideEditor({
  customers,
  items,
}: {
  customers: Customer[];
  items?: UnmatchedItem[];
}) {
  const toast = useToast();

  // ----- Load + reactive subscription -------------------------------------
  const [list, setList] = useState<KeywordOverride[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadOverrides().then((l) => {
      if (cancelled) return;
      setList(l);
      setLoaded(true);
    });
    // Subscribe to OTHER surfaces (per-tx popover in /review, etc.)
    // editing the same key. Auto-refreshes the local list.
    const off = subscribeStorageKey<unknown>(OVERRIDES_KEY_V2, (newValue) => {
      if (cancelled) return;
      const next = unwrapV2(newValue);
      setList(next);
      // External writes are authoritative — clear our dirty flag so
      // we don't pop "Kaydedilmemiş değişiklikler" after someone else
      // saved.
      setDirty(false);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // ----- Bulk-paste (legacy) ---------------------------------------------
  const [bulkText, setBulkText] = useState("");
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);

  const preview = useMemo(
    () => previewOverrideBulk(bulkText, customers),
    [bulkText, customers],
  );
  const previewActive = bulkText.trim().length > 0;

  // ----- Group rules by (firm, mode) for card rendering -------------------
  const allGroups = useMemo(() => groupRulesByFirmAndMode(list), [list]);

  // ----- Search / filter (F2) ---------------------------------------------
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allGroups;
    return allGroups.filter((g) => {
      if (g.displayName.toLowerCase().includes(q)) return true;
      if (g.rules.some((r) => r.keywords.some((k) => k.toLowerCase().includes(q)))) return true;
      if (g.rules.some((r) => (r.notes ?? "").toLowerCase().includes(q))) return true;
      return false;
    });
  }, [allGroups, search]);

  // ----- Duplicate detection (F3) — debounced ----------------------------
  const [dupWarnings, setDupWarnings] = useState<
    Array<{ ruleId: string; reason: string; partnerRuleId?: string }>
  >([]);
  useEffect(() => {
    const handle = setTimeout(() => {
      setDupWarnings(detectDuplicates(list));
    }, 250);
    return () => clearTimeout(handle);
  }, [list]);
  const dupByRuleId = useMemo(() => {
    const m = new Map<string, typeof dupWarnings>();
    for (const w of dupWarnings) {
      const arr = m.get(w.ruleId) ?? [];
      arr.push(w);
      m.set(w.ruleId, arr);
    }
    return m;
  }, [dupWarnings]);

  // ----- Dry-run (F1) -----------------------------------------------------
  const [showDryRun, setShowDryRun] = useState(false);
  const usageByGroup = useMemo<FirmGroupUsage[]>(() => {
    if (!items || items.length === 0) return [];
    return computeFirmGroupUsage(allGroups, items, 5);
  }, [allGroups, items]);
  const ruleUsage: RuleUsageStat[] = useMemo(() => {
    if (!items || items.length === 0) return [];
    return computeRuleUsage(list, items, 5);
  }, [list, items]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const persist = async (next: KeywordOverride[]) => {
    setList(next);
    setDirty(false);
    await saveOverrides(next);
  };

  // ----- Firm-card mutations --------------------------------------------

  /** Add a new empty rule. Lands in its own group card. */
  const addEmptyRule = () => {
    setList((cur) => [
      ...cur,
      {
        id: makeRuleId(),
        accountName: "",
        acntEuId: null,
        keywords: [],
        notes: "",
        matchMode: "contains",
      },
    ]);
    setDirty(true);
  };

  /** Remove every rule that targets the group's firm+mode pair. */
  const removeGroup = (group: FirmGroup) => {
    const ids = new Set(group.rules.map((r) => r.id));
    setList((cur) => cur.filter((r) => !ids.has(r.id)));
    setDirty(true);
  };

  /** Append a keyword (or several, comma-/semicolon-/newline-split) to
   * the group's first rule. If the group is empty (just-created card),
   * spawn a new rule with the keyword so the operator doesn't have to
   * press "+ keyword ekle" twice. */
  const addKeywordsToGroup = (group: FirmGroup, raw: string) => {
    const keywords = splitKeywords(raw);
    if (keywords.length === 0) return;
    setList((cur) => {
      // Locate the group's rules inside the latest list (cur may have
      // evolved since the group was computed via useMemo).
      const ids = new Set(group.rules.map((r) => r.id));
      const fresh = cur.filter((r) => ids.has(r.id));
      if (fresh.length === 0) {
        // Group was empty (no rules yet) — spawn one with the keyword(s).
        const seed = group.rules[0];
        const newRule: KeywordOverride = {
          id: makeRuleId(),
          accountName: seed?.accountName ?? "",
          acntEuId: seed?.acntEuId ?? null,
          keywords,
          matchMode: group.matchMode,
          notes: seed?.notes ?? "",
        };
        return [...cur, newRule];
      }
      // Append every keyword to the first rule in the group; ignore
      // intra-rule duplicates (case-insensitive).
      const target = fresh[0];
      const existing = new Set(
        target.keywords.map((k) => k.trim().toLowerCase()),
      );
      const additions = keywords.filter(
        (k) => !existing.has(k.trim().toLowerCase()),
      );
      if (additions.length === 0) return cur;
      return cur.map((r) =>
        r.id === target.id
          ? { ...r, keywords: [...r.keywords, ...additions] }
          : r,
      );
    });
    setDirty(true);
  };

  /** Remove a single keyword chip from a rule. If the rule becomes
   * empty, drop the rule entirely so it doesn't linger as a "no
   * keywords" zombie. */
  const removeKeyword = (ruleId: string, keyword: string) => {
    setList((cur) =>
      cur
        .map((r) =>
          r.id === ruleId
            ? {
                ...r,
                keywords: r.keywords.filter(
                  (k) => k.trim().toLowerCase() !== keyword.trim().toLowerCase(),
                ),
              }
            : r,
        )
        .filter((r) => r.keywords.length > 0),
    );
    setDirty(true);
  };

  /** Rename the firm on every rule in the group + re-resolve acntEuId
   * against the customer list. */
  const renameGroup = (group: FirmGroup, newName: string) => {
    const norm = (s: string) => s.trim().toLowerCase();
    const hit = customers.find((c) => norm(c.name) === norm(newName));
    setList((cur) =>
      cur.map((r) =>
        group.rules.some((g) => g.id === r.id)
          ? { ...r, accountName: newName, acntEuId: hit?.acntEuId ?? null }
          : r,
      ),
    );
    setDirty(true);
  };

  /** Switch the matchMode on every rule in the group. */
  const setGroupMode = (group: FirmGroup, newMode: OverrideMatchMode) => {
    setList((cur) =>
      cur.map((r) =>
        group.rules.some((g) => g.id === r.id) ? { ...r, matchMode: newMode } : r,
      ),
    );
    setDirty(true);
  };

  /** Sync notes across every rule in the group (kept equal so the card
   * only shows one notes input). */
  const setGroupNotes = (group: FirmGroup, newNotes: string) => {
    setList((cur) =>
      cur.map((r) =>
        group.rules.some((g) => g.id === r.id) ? { ...r, notes: newNotes } : r,
      ),
    );
    setDirty(true);
  };

  // ----- Bulk-paste handler (legacy) -------------------------------------
  const handleBulkImport = () => {
    setBulkError(null);
    setBulkNotice(null);
    const { ok, errors, format } = parseOverrideBulk(bulkText, customers);
    if (errors.length > 0) {
      setBulkError(`${errors.length} satır atlandı:\n${errors.slice(0, 5).join("\n")}${errors.length > 5 ? `\n…+${errors.length - 5} hata daha` : ""}`);
      if (ok.length > 0) {
        setList((cur) => [...cur, ...ok]);
        setDirty(true);
      }
      return;
    }
    setList((cur) => [...cur, ...ok]);
    setBulkText("");
    setDirty(true);
    setBulkNotice(
      `${ok.length} kural eklendi (format: ${format.toUpperCase()})`,
    );
  };

  // ----- JSON IO ----------------------------------------------------------
  const handleExport = () => {
    if (list.length === 0) {
      toast.push("Dışa aktarılacak kural yok", "info");
      return;
    }
    const envelope = exportOverridesToJson(list);
    triggerDownload(envelope);
    toast.push(`${list.length} kural dışa aktarıldı`, "success");
  };

  const handleImportClick = () => fileInputRef.current?.click();

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    try {
      const text = await file.text();
      const summary = importOverridesFromJson(text, list);
      if (summary.rejected) {
        toast.push(summary.rejected, "error");
        return;
      }
      await persist(summary.next);
      toast.push(formatImportSummary(summary), "success");
    } catch (err) {
      toast.push(
        `İçe aktarma hatası: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  };

  const totalKeywords = useMemo(
    () => list.reduce((s, o) => s + o.keywords.length, 0),
    [list],
  );

  // ----- Render helpers ---------------------------------------------------
  const statusBadge = (row: PreviewRow) => {
    const meta: Record<PreviewStatus, { label: string; cls: string }> = {
      ok: { label: "✓ İçe aktarılacak", cls: "ok" },
      "firm-unknown": { label: "⚠ firma listede yok", cls: "warn" },
      "no-firm": { label: "✗ firma yok", cls: "err" },
      "no-keywords": { label: "✗ keyword yok", cls: "err" },
      error: { label: "✗ parse hatası", cls: "err" },
    };
    const m = meta[row.status] ?? meta.error;
    return (
      <span className={`override-preview__badge override-preview__badge--${m.cls}`} title={row.statusMessage}>
        {m.label}
      </span>
    );
  };

  const renderKeywordCell = (cells: string[], idx: number) => {
    const v = cells[idx];
    if (v === undefined || v === null || v === "") {
      return <td className="muted" style={{ textAlign: "center" }}>—</td>;
    }
    return <td>{v}</td>;
  };

  if (!loaded) return null;

  return (
    <div className="override-editor">
      <div className="override-editor__head">
        <h3 style={{ margin: 0 }}>Özel Yönlendirme Kuralları</h3>
        <span className="muted" style={{ fontSize: 11 }}>
          {allGroups.length} firma · {list.length} kural · {totalKeywords} anahtar kelime
        </span>
        <span style={{ flex: 1 }} />
        <button
          className="ghost sm"
          onClick={handleExport}
          title="Tüm kuralları JSON dosyası olarak indir"
        >
          <Download size={11} /> JSON dışa aktar
        </button>
        <button
          className="ghost sm"
          onClick={handleImportClick}
          title="JSON dosyasından kuralları içe aktar"
        >
          <Upload size={11} /> JSON içe aktar
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          style={{ display: "none" }}
          onChange={handleImportFile}
        />
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        Model bu kurallara <em>her zaman</em> uyar. Her firma tek bir
        karttır; aynı firmaya birden fazla keyword eklemek için kartın
        içindeki input'a virgülle ayrılmış şekilde yazıp{" "}
        <kbd>Enter</kbd>'a bas.
      </p>

      {/* F2: search filter + F3: dup detection */}
      <div className="row" style={{ marginTop: 6, gap: 8 }}>
        <div style={{ position: "relative", flex: 1 }}>
          <Search
            size={11}
            style={{
              position: "absolute",
              left: 8,
              top: "50%",
              transform: "translateY(-50%)",
              color: "var(--muted, #888)",
            }}
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Firma, keyword veya nota göre ara…"
            className="override-editor__search"
            style={{ paddingLeft: 24, width: "100%" }}
            spellCheck={false}
          />
        </div>
        {search && (
          <span className="muted" style={{ fontSize: 11, alignSelf: "center" }}>
            {filtered.length} / {allGroups.length} firma
          </span>
        )}
      </div>

      {dupWarnings.length > 0 && (
        <div className="override-editor__dupwarn">
          <AlertCircle size={11} style={{ verticalAlign: "middle" }} />{" "}
          {dupWarnings.length} çakışma var — aşağıdaki vurgulanan kartları kontrol et.
        </div>
      )}

      <details className="override-editor__bulk">
        <summary>
          <FileText size={11} style={{ verticalAlign: "middle" }} /> Toplu
          içe aktar (Eski format — pipe / TSV / CSV)
        </summary>
        <p className="muted" style={{ fontSize: 10, marginTop: 4 }}>
          Yeni kurallar için JSON içe aktar kullanın — eski format hâlâ desteklenir.
        </p>
        <textarea
          value={bulkText}
          onChange={(e) => setBulkText(e.target.value)}
          rows={6}
          placeholder={`# Pipe formatı: Firma | kw1, kw2, kw3 | not | mod\nAktif Bank | aktif, aktifbank | Kargo/EFT | içerir\nAktif Bank | EVET | Kredi onayı | tam\n\n# Excel'den kopyala-yapıştır (CSV/TSV otomatik tespit):\nFirma\tKeyword1\tKeyword2\tNot\tMod\nAktif Bank\tPTT\tEVET\tKargo bildirimleri\ttam\nAktif Bank\taktifbank\tHAYIR\tKredi geri ödemesi\ticerir`}
          spellCheck={false}
        />

        {previewActive && (
          <div className="override-preview">
            <div className="override-preview__head">
              <span className="muted" style={{ fontSize: 10 }}>
                Önizleme · format: {preview.format.toUpperCase()}
              </span>
              <span className="override-preview__counts">
                <span className="ok">{preview.okCount} ✓</span>
                <span className="warn">{preview.warnCount} ⚠</span>
                <span className="err">{preview.errorCount} ✗</span>
              </span>
            </div>
            {preview.rows.length > 0 && (
              <table className="override-preview__table">
                <thead>
                  <tr>
                    <th style={{ width: 28 }}>#</th>
                    <th>Durum</th>
                    <th>Firma</th>
                    <th>Keyword1</th>
                    <th>Keyword2</th>
                    <th>Keyword3</th>
                    <th>Not</th>
                    <th>Mod</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r, i) =>
                    r.kind === "header" ? (
                      <tr key={`row-${i}`} className="override-preview__row--header">
                        <td>{r.sourceLine}</td>
                        <td colSpan={7} className="muted">
                          başlık satırı — atlanır
                        </td>
                      </tr>
                    ) : (
                      <tr
                        key={`row-${i}`}
                        className={`override-preview__row override-preview__row--${r.status}`}
                      >
                        <td>{r.sourceLine}</td>
                        <td>{statusBadge(r)}</td>
                        <td>{r.accountName || <em className="muted">(boş)</em>}</td>
                        {renderKeywordCell(r.keywordCells, 0)}
                        {renderKeywordCell(r.keywordCells, 1)}
                        {renderKeywordCell(r.keywordCells, 2)}
                        <td>{r.notes || <em className="muted">—</em>}</td>
                        <td>
                          {r.matchMode === "exact"
                            ? "tam"
                            : r.matchMode === "contains"
                              ? "içerir"
                              : <em className="muted">—</em>}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            )}
          </div>
        )}

        <div className="row" style={{ marginTop: 6 }}>
          <button onClick={handleBulkImport} disabled={!bulkText.trim()}>
            <Plus size={11} /> Ekle
          </button>
          <span className="muted" style={{ fontSize: 11 }}>
            Mevcut listeye eklenir, silmez · ilk satır başlıksa otomatik atlanır
          </span>
        </div>
        {bulkError && (
          <pre className="override-editor__err">{bulkError}</pre>
        )}
        {bulkNotice && !bulkError && (
          <div className="override-editor__notice">{bulkNotice}</div>
        )}
      </details>

      <div className="override-editor__rows">
        {allGroups.length === 0 && (
          <div className="muted" style={{ fontSize: 11, padding: 12 }}>
            Henüz kural yok. Aşağıdaki "Yeni kural" butonuyla başla.
          </div>
        )}
        {filtered.map((g) => (
          <FirmRuleCard
            key={`${g.firmKey}::${g.matchMode}`}
            group={g}
            customers={customers}
            dupByRuleId={dupByRuleId}
            groupUsage={usageByGroup.find(
              (u) => u.groupFirmKey === g.firmKey && u.groupMatchMode === g.matchMode,
            )}
            itemCount={items?.length ?? 0}
            onAddKeywords={(raw) => addKeywordsToGroup(g, raw)}
            onRemoveKeyword={removeKeyword}
            onRename={(name) => renameGroup(g, name)}
            onSetMode={(mode) => setGroupMode(g, mode)}
            onSetNotes={(notes) => setGroupNotes(g, notes)}
            onRemoveGroup={() => removeGroup(g)}
          />
        ))}
      </div>

      <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
        <button onClick={addEmptyRule}>
          <Plus size={11} /> Yeni kural
        </button>
        <button
          className="primary"
          onClick={() => persist(list)}
          disabled={!dirty}
        >
          <Save size={11} /> Kaydet
        </button>
        {dirty && (
          <span className="muted" style={{ fontSize: 11 }}>
            Kaydedilmemiş değişiklikler
          </span>
        )}
        <span style={{ flex: 1 }} />
        {/* F1: dry-run against loaded items */}
        <button
          className="ghost sm"
          onClick={() => setShowDryRun((s) => !s)}
          disabled={!items || items.length === 0}
          title={
            !items || items.length === 0
              ? "Dry-run için önce /fetch'ten öğeleri çek"
              : "Her kuralı mevcut öğelerde test et"
          }
        >
          <FlaskConical size={11} />{" "}
          {showDryRun ? "Raporu gizle" : "Mevcut öğelerde test et"}
        </button>
      </div>

      {showDryRun && items && items.length > 0 && (
        <div className="override-editor__dryrun">
          <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>
            Her kural, yüklü <b>{items.length}</b> öğede kaç kez eşleşiyor:
          </div>
          {ruleUsage.length === 0 || ruleUsage.every((u) => u.matchCount === 0) ? (
            <div className="muted" style={{ fontSize: 11, padding: 8 }}>
              Hiçbir kural mevcut öğelerde eşleşmiyor.
            </div>
          ) : (
            <ul style={{ margin: 0, padding: "0 0 0 16px", fontSize: 11 }}>
              {ruleUsage
                .filter((u) => u.matchCount > 0)
                .map((u) => {
                  const r = list.find((x) => x.id === u.ruleId);
                  return (
                    <li key={u.ruleId}>
                      <b>{r?.accountName ?? "(silinmiş)"}</b> ←{" "}
                      <code>"{r?.keywords.join(", ")}"</code> →{" "}
                      {u.matchCount} eşleşme
                      {u.sampleTransactionIds.length > 0 && (
                        <span className="muted">
                          {" "}
                          (örn. tx {u.sampleTransactionIds.join(", ")}
                          {u.matchCount > u.sampleTransactionIds.length
                            ? ` + ${u.matchCount - u.sampleTransactionIds.length} daha`
                            : ""})
                        </span>
                      )}
                    </li>
                  );
                })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// --- Firm card ----------------------------------------------------------

interface FirmRuleCardProps {
  group: FirmGroup;
  customers: Customer[];
  /** Per-rule duplicate warnings, keyed by ruleId. */
  dupByRuleId: Map<
    string,
    Array<{ ruleId: string; reason: string; partnerRuleId?: string }>
  >;
  /** Optional per-group aggregate match stats (only when items loaded). */
  groupUsage?: FirmGroupUsage;
  /** Items count for the tooltip on the usage pill. */
  itemCount: number;
  onAddKeywords: (raw: string) => void;
  onRemoveKeyword: (ruleId: string, keyword: string) => void;
  onRename: (newName: string) => void;
  onSetMode: (mode: OverrideMatchMode) => void;
  onSetNotes: (notes: string) => void;
  onRemoveGroup: () => void;
}

/**
 * One firm = one card. Header exposes the firm picker (with customer-
 * list datalist), match mode, notes, and the delete button. The body
 * lists every keyword from every rule in the group as removable chips;
 * the input at the bottom appends new chips to the first rule in the
 * group (or spawns a fresh rule if the card is brand-new and empty).
 *
 * The whole card is intentionally a single visual unit so the
 * operator's mental model is "one firm = one rule, with many
 * keywords" — fixing the previous "tek tek kayıt açmak yorucu"
 * complaint.
 */
function FirmRuleCard({
  group,
  customers,
  dupByRuleId,
  groupUsage,
  itemCount,
  onAddKeywords,
  onRemoveKeyword,
  onRename,
  onSetMode,
  onSetNotes,
  onRemoveGroup,
}: FirmRuleCardProps) {
  const norm = (s: string) => s.trim().toLowerCase();
  const firmName = group.displayName;
  const firmKnown = !!customers.find((c) => norm(c.name) === norm(firmName));
  // Surface duplicate warnings for any rule in this group (most
  // operators see a dup once per chip — we don't drown them).
  const groupDups = group.rules.flatMap((r) => dupByRuleId.get(r.id) ?? []);
  const hasDup = groupDups.length > 0;

  // Stable input ref so Enter-to-save works without re-rendering.
  const draftRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");

  const handleAdd = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onAddKeywords(trimmed);
    setDraft("");
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAdd();
    } else if (e.key === "Escape") {
      setDraft("");
    }
  };

  // Aggregate every chip across all rules in this group so the
  // operator sees one chip list per firm. We track (ruleId, keyword)
  // so removal targets the right rule when a firm ever has multiple
  // rules in the group (rare but possible after bulk imports).
  const chips: Array<{ ruleId: string; keyword: string }> = [];
  const seen = new Set<string>();
  for (const r of group.rules) {
    for (const kw of r.keywords) {
      const key = `${r.id}::${kw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chips.push({ ruleId: r.id, keyword: kw });
    }
  }

  return (
    <div
      className={`firm-rule-card${group.matchMode === "exact" ? " firm-rule-card--exact" : ""}${hasDup ? " firm-rule-card--dup" : ""}`}
      data-firm-key={group.firmKey}
      data-match-mode={group.matchMode}
    >
      <div className="firm-rule-card__top">
        <input
          type="text"
          placeholder="Firma adı (örn. Aktif Bank)"
          value={firmName}
          onChange={(e) => onRename(e.target.value)}
          className="firm-rule-card__firm"
          list="customer-list"
        />
        <datalist id="customer-list">
          {customers.map((c) => (
            <option key={c.acntEuId} value={c.name} />
          ))}
        </datalist>
        <select
          value={group.matchMode}
          onChange={(e) => onSetMode(e.target.value as OverrideMatchMode)}
          className="firm-rule-card__mode"
          title="Eşleşme modu"
        >
          <option value="contains">İçerir (substring)</option>
          <option value="exact">Tam eşleşme (==)</option>
        </select>
        <span
          className={`pill ${firmKnown ? "success" : "warn"}`}
          title={
            firmKnown
              ? "Firma müşteri listesinde bulundu — kural ücretlendirilebilir"
              : "Firma müşteri listesinde yok — kural modele gider ama chargeOnce throw eder (acntEuId boş)"
          }
        >
          {firmKnown ? "✓ listede" : "⚠ listede yok"}
        </span>
        {groupUsage && groupUsage.totalMatchCount > 0 && (
          <span
            className="pill"
            title={`Bu karttaki kurallar, mevcut ${itemCount} öğeden ${groupUsage.totalMatchCount} tanesinde eşleşiyor. Örnek txId'ler: ${groupUsage.sampleTransactionIds.join(", ")}`}
          >
            {groupUsage.totalMatchCount}× eşleşme
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          className="ghost"
          onClick={onRemoveGroup}
          title="Bu firmanın tüm kurallarını sil"
          aria-label="Firmanın tüm kurallarını sil"
        >
          <Trash2 size={11} />
        </button>
      </div>

      <div className="firm-rule-card__chips">
        {chips.length === 0 && (
          <span className="muted" style={{ fontSize: 11 }}>
            (henüz anahtar kelime yok — aşağıdan ekle)
          </span>
        )}
        {chips.map(({ ruleId, keyword }) => (
          <span key={`${ruleId}::${keyword}`} className="chip">
            <span className="chip__label">{keyword}</span>
            <button
              className="chip__x"
              onClick={() => onRemoveKeyword(ruleId, keyword)}
              title="Bu anahtar kelimeyi kaldır"
              aria-label="Anahtar kelimeyi kaldır"
            >
              <XIcon size={9} />
            </button>
          </span>
        ))}
      </div>

      <div className="firm-rule-card__add">
        <input
          ref={draftRef}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKey}
          placeholder={`keyword ekle — birden fazlaysa virgülle ayır (örn. EVET, iptal, kredi)`}
          spellCheck={false}
        />
        <button
          className="ghost sm"
          onClick={handleAdd}
          disabled={!draft.trim()}
          title="Bu firmaya yeni anahtar kelime ekle"
        >
          <Plus size={10} /> Ekle
        </button>
      </div>

      <div className="firm-rule-card__meta">
        <input
          type="text"
          placeholder="Not (opsiyonel)"
          value={group.rules[0]?.notes ?? ""}
          onChange={(e) => onSetNotes(e.target.value)}
          className="firm-rule-card__notes"
        />
      </div>

      {hasDup && (
        <div className="firm-rule-card__warn">
          <AlertCircle size={10} style={{ verticalAlign: "middle" }} />{" "}
          {groupDups.map((d) => d.reason).join(" · ")}
        </div>
      )}
      {!firmKnown && firmName.trim() && (
        <div className="firm-rule-card__warn">
          <AlertCircle size={10} style={{ verticalAlign: "middle" }} />{" "}
          "<b>{firmName}</b>" müşteri listesinde yok. Bu kural
          <b> yine de modele gider</b> — AI, eşleşen keyword'leri
          bu adı kullanarak etiketler; fakat fiili ücretlendirme
          için <code>acntEuId</code> çözümlenemediğinden
          <b> <code>chargeOnce</code> throw eder</b> ve İncele
          ekranında bu satır <em>seçilemez</em>. Adı, listedeki bir
          firmayla birebir eşleşecek şekilde düzeltin (büyük-küçük
          harf ve boşluklar göz ardı edilir).
        </div>
      )}
    </div>
  );
}

// --- helpers ---------------------------------------------------------------

function unwrapV2(raw: unknown): KeywordOverride[] {
  if (raw && typeof raw === "object" && "rules" in raw) {
    const r = (raw as { rules: unknown }).rules;
    if (Array.isArray(r)) return r as KeywordOverride[];
  }
  // Subscriber may have raced past the v1 → v2 migration window; fall
  // back gracefully.
  if (Array.isArray(raw)) return raw as KeywordOverride[];
  return [];
}

/**
 * Generate a stable-enough rule id. Time prefix + random suffix is
 * collision-resistant for human-scale rule lists.
 */
function makeRuleId(): string {
  return `ov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Accept a free-form keyword blob and split it into individual
 * keywords. Operators paste things like "EVET, iptal, kredi" or "EVET;
 * iptal\nkredi" — we treat comma, semicolon, and newline as
 * equivalent separators.
 */
function splitKeywords(raw: string): string[] {
  return raw
    .split(/[,;\n\r]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/**
 * Walk the rule list and emit per-rule warnings for:
 *
 *   - duplicate rules: same firm + same keyword + same matchMode
 *     (the operator can delete one — they route identically).
 *   - cross-firm overlap: same keyword (after trim) under two
 *     different firm names. The AI will pick whichever rule fires
 *     first; operators usually want to consolidate these.
 */
function detectDuplicates(
  list: KeywordOverride[],
): Array<{ ruleId: string; partnerRuleId?: string; reason: string }> {
  const out: Array<{ ruleId: string; partnerRuleId?: string; reason: string }> = [];
  const norm = (s: string) => s.trim().toLowerCase();
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      const sameFirm = norm(a.accountName) === norm(b.accountName);
      const sameMode = (a.matchMode ?? "contains") === (b.matchMode ?? "contains");
      const sharedKw = a.keywords
        .map((k) => norm(k))
        .filter(Boolean)
        .filter((k) => b.keywords.map((kk) => norm(kk)).includes(k));
      if (sharedKw.length === 0) continue;
      if (sameFirm && sameMode) {
        const reason = `aynı firma + aynı keyword (${sharedKw.join(", ")}) — biri fazla`;
        out.push({ ruleId: a.id, partnerRuleId: b.id, reason });
        out.push({ ruleId: b.id, partnerRuleId: a.id, reason });
      } else if (!sameFirm) {
        const reason = `"${sharedKw[0]}" keyword'ü hem "${a.accountName}" hem "${b.accountName}" için tanımlı`;
        out.push({ ruleId: a.id, partnerRuleId: b.id, reason });
        out.push({ ruleId: b.id, partnerRuleId: a.id, reason });
      }
    }
  }
  return out;
}