import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Save, FileText, AlertCircle, Download, Upload, FlaskConical, Search } from "lucide-react";
import { loadOverrides, saveOverrides, subscribeStorageKey, OVERRIDES_KEY_V2 } from "../../lib/store.js";
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
import { computeRuleUsage, type RuleUsageStat } from "../../lib/overrideMatcher.js";
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
 * Bulk entry formats (both still supported):
 *   1. JSON envelope (preferred) — file picker or paste. See
 *      `docs/OVERRIDES-JSON-FORMAT.md`.
 *   2. Legacy pipe / TSV / Excel paste (still works for operators
 *      who already have sheets). New rules should go through JSON.
 *
 * Cross-component sync: a `subscribeStorageKey(OVERRIDES_KEY_V2, …)`
 * listener replaces the previous one-shot load. Now /review and
 * /analyze see rule edits immediately.
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

  // ----- Search / filter (F2) ---------------------------------------------
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => {
      if (r.accountName.toLowerCase().includes(q)) return true;
      if (r.keywords.some((k) => k.toLowerCase().includes(q))) return true;
      if ((r.notes ?? "").toLowerCase().includes(q)) return true;
      return false;
    });
  }, [list, search]);

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
  const usage: RuleUsageStat[] = useMemo(() => {
    if (!items || items.length === 0) return [];
    return computeRuleUsage(list, items, 5);
  }, [list, items]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const persist = async (next: KeywordOverride[]) => {
    setList(next);
    setDirty(false);
    await saveOverrides(next);
  };

  const addRule = () => {
    setList((cur) => [
      ...cur,
      {
        id: `ov-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        accountName: "",
        acntEuId: null,
        keywords: [],
        notes: "",
        matchMode: "contains",
      },
    ]);
    setDirty(true);
  };

  const removeRule = (id: string) => {
    setList((cur) => cur.filter((o) => o.id !== id));
    setDirty(true);
  };

  const updateRule = (id: string, patch: Partial<KeywordOverride>) => {
    setList((cur) =>
      cur.map((o) => {
        if (o.id !== id) return o;
        const next = { ...o, ...patch };
        // Re-resolve acntEuId against the current customer list whenever
        // accountName changes (best-effort case-insensitive match).
        if (patch.accountName !== undefined) {
          const norm = (s: string) => s.trim().toLowerCase();
          const hit = customers.find((c) => norm(c.name) === norm(next.accountName));
          next.acntEuId = hit?.acntEuId ?? null;
        }
        return next;
      }),
    );
    setDirty(true);
  };

  const updateKeywordsText = (id: string, text: string) => {
    const keywords = text
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    updateRule(id, { keywords });
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
          {list.length} kural · {totalKeywords} anahtar kelime
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
        Model bu kurallara <em>her zaman</em> uyar. Özel anahtar kelimeler
        (örn. "PTT", "aktifbank") için firma ataması yapmak istediğinde buraya
        ekle.
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
            {filtered.length} / {list.length} kural
          </span>
        )}
      </div>

      {dupWarnings.length > 0 && (
        <div className="override-editor__dupwarn">
          <AlertCircle size={11} style={{ verticalAlign: "middle" }} />{" "}
          {dupWarnings.length} çakışma var — aşağıdaki vurgulanan satırları kontrol et.
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
        {list.length === 0 && (
          <div className="muted" style={{ fontSize: 11, padding: 12 }}>
            Henüz kural yok. Aşağıdaki "Kural ekle" butonuyla başla.
          </div>
        )}
        {filtered.map((o) => {
          const norm = (s: string) => s.trim().toLowerCase();
          const firmKnown = !!customers.find((c) => norm(c.name) === norm(o.accountName));
          const dups = dupByRuleId.get(o.id) ?? [];
          const hasDup = dups.length > 0;
          const stat = usage.find((s) => s.ruleId === o.id);
          return (
            <div
              key={o.id}
              className={`override-row${o.matchMode === "exact" ? " override-row--exact" : ""}${hasDup ? " override-row--dup" : ""}`}
              data-rule-id={o.id}
            >
              <div className="override-row__top">
                <input
                  type="text"
                  placeholder="Firma adı (örn. Aktif Bank)"
                  value={o.accountName}
                  onChange={(e) => updateRule(o.id, { accountName: e.target.value })}
                  className="override-row__firm"
                  list="customer-list"
                />
                <datalist id="customer-list">
                  {customers.map((c) => (
                    <option key={c.acntEuId} value={c.name} />
                  ))}
                </datalist>
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
                {/* F4: usage stats next to each rule */}
                {stat && stat.matchCount > 0 && (
                  <span
                    className="pill"
                    title={`Bu kural, mevcut ${items?.length ?? 0} öğeden ${stat.matchCount} tanesinde eşleşiyor. Örnek txId'ler: ${stat.sampleTransactionIds.join(", ")}`}
                  >
                    {stat.matchCount}× eşleşme
                  </span>
                )}
                <button
                  className="ghost"
                  onClick={() => removeRule(o.id)}
                  title="Kuralı sil"
                >
                  <Trash2 size={11} />
                </button>
              </div>
              <input
                type="text"
                placeholder="keyword1, keyword2, … (virgülle ayrılmış)"
                value={o.keywords.join(", ")}
                onChange={(e) => updateKeywordsText(o.id, e.target.value)}
                className="override-row__kw"
                spellCheck={false}
              />
              <div className="override-row__meta">
                <select
                  value={o.matchMode ?? "contains"}
                  onChange={(e) =>
                    updateRule(o.id, { matchMode: e.target.value as OverrideMatchMode })
                  }
                  className="override-row__mode"
                  title="Eşleşme modu"
                >
                  <option value="contains">İçerir (substring)</option>
                  <option value="exact">Tam eşleşme (==)</option>
                </select>
                <input
                  type="text"
                  placeholder="Not (opsiyonel)"
                  value={o.notes ?? ""}
                  onChange={(e) => updateRule(o.id, { notes: e.target.value })}
                  className="override-row__notes"
                />
              </div>
              {hasDup && (
                <div className="override-row__warn">
                  <AlertCircle size={10} style={{ verticalAlign: "middle" }} />{" "}
                  {dups.map((d) => d.reason).join(" · ")}
                </div>
              )}
              {!firmKnown && o.accountName.trim() && (
                <div className="override-row__warn">
                  <AlertCircle size={10} style={{ verticalAlign: "middle" }} />{" "}
                  "<b>{o.accountName}</b>" müşteri listesinde yok. Bu kural
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
        })}
      </div>

      <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
        <button onClick={addRule}>
          <Plus size={11} /> Kural ekle
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
          {usage.length === 0 || usage.every((u) => u.matchCount === 0) ? (
            <div className="muted" style={{ fontSize: 11, padding: 8 }}>
              Hiçbir kural mevcut öğelerde eşleşmiyor.
            </div>
          ) : (
            <ul style={{ margin: 0, padding: "0 0 0 16px", fontSize: 11 }}>
              {usage
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
