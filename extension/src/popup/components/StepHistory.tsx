import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  Trash2,
  FileText,
  AlertTriangle,
  ShieldCheck,
  Download,
  FileJson,
} from "lucide-react";
import { clearAudit, loadAudit } from "../../lib/store.js";
import {
  dateStamp,
  downloadBlob,
  recordsToCsv,
  recordsToJson,
} from "../../lib/exportAudit.js";
import type { ChargeRecord } from "../../types.js";
import type { RouteCtx } from "../App.js";
import { useToast } from "./Toast.js";

type Filter = "all" | "success" | "error";

export function StepHistory() {
  const ctx = useOutletContext<RouteCtx>();
  const { settings: _settings } = ctx;
  const toast = useToast();

  const [records, setRecords] = useState<ChargeRecord[]>([]);
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    loadAudit().then(setRecords);
  }, []);

  const filtered = records.filter((r) =>
    filter === "all" ? true : r.status === filter,
  );

  const handleClear = async () => {
    if (!confirm(`${records.length} kayıt silinecek. Emin misin?`)) return;
    await clearAudit();
    setRecords([]);
    toast.push("Audit log temizlendi", "info");
  };

  const refresh = async () => {
    const r = await loadAudit();
    setRecords(r);
    toast.push(`${r.length} kayıt yüklendi`, "info");
  };

  const handleExportJson = () => {
    if (records.length === 0) return;
    const filename = `audit-${dateStamp()}-${records.length}.json`;
    downloadBlob(filename, recordsToJson(records), "application/json");
    toast.push(`${records.length} kayıt JSON olarak indirildi`, "success");
  };

  const handleExportCsv = () => {
    if (records.length === 0) return;
    const filename = `audit-${dateStamp()}-${records.length}.csv`;
    downloadBlob(filename, recordsToCsv(records), "text/csv;charset=utf-8");
    toast.push(`${records.length} kayıt CSV olarak indirildi`, "success");
  };

  const successCount = records.filter((r) => r.status === "success").length;
  const errorCount = records.filter((r) => r.status === "error").length;

  const formatIds = (r: ChargeRecord) =>
    r.transactionIds.length > 1
      ? `${r.transactionIds.length} kayıt`
      : `#${r.transactionIds[0]}`;

  return (
    <div className="section">
      <h2>Geçmiş / Audit Log</h2>
      <p className="muted">
        Tüm ücretlendirme istekleri burada saklanır. <code className="kbd">chrome.storage.local</code>{" "}
        üzerinde tutulur; tarayıcıyı silmediğin sürece kayıtlar kalır. İstersen JSON veya CSV
        olarak dışa aktarabilirsin.
      </p>

      <div className="summary">
        <div>
          <div className="num">{records.length.toLocaleString("tr-TR")}</div>
          <div className="lbl">toplam kayıt</div>
        </div>
        <div>
          <div className="num" style={{ color: "var(--success)" }}>
            {successCount.toLocaleString("tr-TR")}
          </div>
          <div className="lbl">başarılı</div>
        </div>
        <div>
          <div
            className="num"
            style={{
              color: errorCount > 0 ? "var(--danger)" : "var(--text-0)",
            }}
          >
            {errorCount.toLocaleString("tr-TR")}
          </div>
          <div className="lbl">hata</div>
        </div>
      </div>

      <div className="toolbar toolbar--audit" style={{ marginBottom: 12 }}>
        {(["all", "success", "error"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={filter === f ? "primary" : ""}
          >
            {f === "all" ? "Tümü" : f === "success" ? "Başarılı" : "Hata"}
          </button>
        ))}
        <button onClick={refresh} disabled={records.length === 0}>
          <Download size={11} /> Yenile
        </button>
        <div className="export-group">
          <button
            onClick={handleExportJson}
            disabled={records.length === 0}
            title="Tüm kayıtları JSON olarak indir"
          >
            <FileJson size={11} /> JSON
          </button>
          <button
            onClick={handleExportCsv}
            disabled={records.length === 0}
            title="Tüm kayıtları CSV olarak indir"
          >
            <FileText size={11} /> CSV
          </button>
        </div>
        <button
          onClick={handleClear}
          disabled={records.length === 0}
          title="Tüm audit logu sil"
        >
          <Trash2 size={11} /> Temizle
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          <FileText size={32} className="icon" />
          <div className="title">Henüz kayıt yok</div>
          <div className="hint">
            İncele sekmesinden bir satırı ücretlendirince burada görünür.
          </div>
        </div>
      ) : (
        <div style={{ overflowX: "auto", border: "1px solid var(--border)", borderRadius: "var(--radius-lg)" }}>
          <table className="audit-table">
            <thead>
              <tr>
                <th style={{ width: 30 }}></th>
                <th>Kayıt</th>
                <th>Firma</th>
                <th>Tx id</th>
                <th>Sonuç</th>
                <th style={{ width: 150 }}>Tarih</th>
              </tr>
            </thead>
            <tbody>
              {filtered
                .slice()
                .reverse()
                .slice(0, 200)
                .map((r, i) => (
                  <tr key={`${r.sentAt}-${i}`}>
                    <td>
                      {r.status === "success" ? (
                        <ShieldCheck size={14} color="var(--success)" />
                      ) : (
                        <AlertTriangle size={14} color="var(--danger)" />
                      )}
                    </td>
                    <td>{formatIds(r)}</td>
                    <td>{r.accountName || "(?)"}</td>
                    <td className="mono">
                      {r.transactionIds.slice(0, 6).join(", ")}
                      {r.transactionIds.length > 6 &&
                        ` …+${r.transactionIds.length - 6}`}
                    </td>
                    <td className="mono">{r.resultDetails ?? "—"}</td>
                    <td className="mono">
                      {new Date(r.sentAt).toLocaleString("tr-TR")}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}