import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Save, FileText, AlertCircle } from "lucide-react";
import { loadOverrides, saveOverrides } from "../../lib/store.js";
import { parseOverrideBulk } from "../../lib/overrideParser.js";
import type { Customer, KeywordOverride, OverrideMatchMode } from "../../types.js";

/**
 * Editor for the operator-maintained keyword → firm override list.
 * Each rule: "if any of these substrings shows up in keyword1/2/body,
 * charge to this firm." Persisted in chrome.storage.local under
 * "overrides.v1".
 *
 * Bulk entry format (one rule per line):
 *   Firm Name | kw1, kw2, kw3 | optional notes
 * Empty lines and `#`-prefixed lines are ignored.
 */
export function OverrideEditor({ customers }: { customers: Customer[] }) {
  const [list, setList] = useState<KeywordOverride[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkNotice, setBulkNotice] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadOverrides().then((l) => {
      if (cancelled) return;
      setList(l);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const handleBulkImport = () => {
    setBulkError(null);
    setBulkNotice(null);
    const { ok, errors, format } = parseOverrideBulk(bulkText, customers);
    if (errors.length > 0) {
      setBulkError(`${errors.length} satır atlandı:\n${errors.slice(0, 5).join("\n")}${errors.length > 5 ? `\n…+${errors.length - 5} hata daha` : ""}`);
      // Still import what was OK so a few bad rows don't lose the rest.
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

  const totalKeywords = useMemo(
    () => list.reduce((s, o) => s + o.keywords.length, 0),
    [list],
  );

  if (!loaded) return null;

  return (
    <div className="override-editor">
      <div className="override-editor__head">
        <h3 style={{ margin: 0 }}>Özel Yönlendirme Kuralları</h3>
        <span className="muted" style={{ fontSize: 11 }}>
          {list.length} kural · {totalKeywords} anahtar kelime
        </span>
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
        Model bu kurallara <em>her zaman</em> uyar. Özel anahtar kelimeler
        (örn. "PTT", "aktifbank") için firma ataması yapmak istediğinde buraya
        ekle.
      </p>

      <details className="override-editor__bulk">
        <summary>
          <FileText size={11} style={{ verticalAlign: "middle" }} /> Toplu
          içe aktar (pipe / Excel)
        </summary>
        <textarea
          value={bulkText}
          onChange={(e) => setBulkText(e.target.value)}
          rows={6}
          placeholder={`# Pipe formatı: Firma | kw1, kw2, kw3 | not | mod\nAktif Bank | aktif, aktifbank | Kargo/EFT | içerir\nAktif Bank | EVET | Kredi onayı | tam\n\n# Excel'den kopyala-yapıştır (CSV/TSV otomatik tespit):\nFirma\tKeyword1\tKeyword2\tNot\tMod\nAktif Bank\tPTT\tEVET\tKargo bildirimleri\ttam\nAktif Bank\taktifbank\tHAYIR\tKredi geri ödemesi\ticerir`}
          spellCheck={false}
        />
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
        {list.map((o) => {
          const norm = (s: string) => s.trim().toLowerCase();
          const firmKnown = !!customers.find((c) => norm(c.name) === norm(o.accountName));
          return (
            <div
              key={o.id}
              className={`override-row${o.matchMode === "exact" ? " override-row--exact" : ""}`}
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
                      ? "Firma müşteri listesinde bulundu"
                      : "Firma müşteri listesinde yok — model yine de adı kullanabilir"
                  }
                >
                  {firmKnown ? "✓ listede" : "⚠ listede yok"}
                </span>
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
              {!firmKnown && o.accountName.trim() && (
                <div className="override-row__warn">
                  <AlertCircle size={10} style={{ verticalAlign: "middle" }} />{" "}
                  "{o.accountName}" müşteri listesinde yok. Model yine de bu ada
                  sahip eşleşmeleri üretebilir, ama fiili ücretlendirme yapamaz.
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="row" style={{ marginTop: 10 }}>
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
      </div>
    </div>
  );
}