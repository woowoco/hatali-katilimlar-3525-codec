import { useEffect, useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  FileSearch,
  KeyRound,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { fetchModels } from "../../lib/ai.js";
import { extractSessionFromHar } from "../../lib/har.js";
import { discoverSession } from "../../lib/session.js";
import { clearAudit, loadAudit, loadSession, saveSettings } from "../../lib/store.js";
import type { ModelInfo } from "../../types.js";
import type { RouteCtx } from "../App.js";
import { useToast } from "./Toast.js";
import { OverrideEditor } from "./OverrideEditor.js";

export function StepSettings() {
  const ctx = useOutletContext<RouteCtx>();
  const { settings, setSettings } = ctx;
  const navigate = useNavigate();
  const toast = useToast();

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [proxyOk, setProxyOk] = useState<boolean | null>(null);
  const [auditCount, setAuditCount] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [customers, setCustomers] = useState<{ name: string; acntEuId: string }[]>([]);
  const [discoverStatus, setDiscoverStatus] = useState<{
    state: "idle" | "running" | "ok" | "fail";
    message?: string;
  }>({ state: "idle" });
  const harInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadAudit().then((a) => setAuditCount(a.length));
    loadSession().then((s) => setCustomers(s.customers));
  }, []);

  const refreshModels = async () => {
    setBusy(true);
    try {
      const r = await fetchModels(settings.proxyUrl);
      setModels(r.models);
      setProxyOk(true);
      if (!settings.model) {
        setSettings({ ...settings, model: r.default });
      }
    } catch (err) {
      console.error(err);
      setProxyOk(false);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    // Auto-probe on mount with the loaded proxyUrl.
    void refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      await saveSettings(settings);
      toast.push("Ayarlar kaydedildi", "success");
      // After saving session + proxy, jump straight to the next step
      // if we have enough to proceed; otherwise stay put.
      if (settings.sessionId) {
        navigate("/fetch");
      }
    } catch (err) {
      toast.push(
        `Kaydetme başarısız: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleAutoDiscover = async () => {
    setDiscoverStatus({ state: "running" });
    const result = await discoverSession();
    if (result.ok && result.sessionId) {
      setSettings({ ...settings, sessionId: result.sessionId });
      const msg =
        result.source === "cookie-validated"
          ? `bulundu ve doğrulandı (${result.cookieName})`
          : `bulundu (${result.cookieName}) — backend doğrulaması başarısız, elle kontrol et`;
      setDiscoverStatus({ state: "ok", message: msg });
      toast.push("Session otomatik bulundu", "success");
    } else {
      setDiscoverStatus({
        state: "fail",
        message: result.error ?? "session bulunamadı",
      });
      toast.push("Session bulunamadı", "error");
    }
  };

  const handleHarPick = () => {
    harInputRef.current?.click();
  };

  const handleHarFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Always clear the input so picking the same file twice still fires
    // onChange.
    e.target.value = "";
    if (!file) return;
    setDiscoverStatus({ state: "running", message: "HAR dosyası okunuyor…" });
    try {
      const text = await file.text();
      const candidate = extractSessionFromHar(text);
      if (!candidate) {
        setDiscoverStatus({
          state: "fail",
          message:
            "HAR içinde sessionid başlığı bulunamadı. Dosya admin-panel trafiğini içermiyor olabilir.",
        });
        toast.push("HAR içinde sessionid yok", "error");
        return;
      }
      setSettings({ ...settings, sessionId: candidate });
      setDiscoverStatus({
        state: "ok",
        message: `HAR'dan alındı (${candidate.slice(0, 8)}…)`,
      });
      toast.push("Session HAR'dan alındı", "success");
    } catch (err) {
      setDiscoverStatus({
        state: "fail",
        message: `HAR okunamadı: ${err instanceof Error ? err.message : String(err)}`,
      });
      toast.push("HAR okunamadı", "error");
    }
  };

  const handleClearAudit = async () => {
    if (!confirm(`${auditCount} audit kaydı silinecek. Emin misin?`)) return;
    await clearAudit();
    setAuditCount(0);
    toast.push("Audit log temizlendi", "info");
  };

  return (
    <div className="section">
      <h2>Bağlantı Ayarları</h2>
      <p className="muted" style={{ marginTop: 0, fontSize: 11 }}>
        Admin-panel'de oturumun açıkken <b>Oturumu otomatik bul</b> butonu
        çerezi okuyup backend'e doğrular. Alternatif olarak manuel
        yapıştırabilirsin:{" "}
        <code className="kbd">sessionid</code> değerini tarayıcının DevTools
        → Network sekmesinden bir <code className="kbd">/api/Menu3525/*</code>{" "}
        isteğinin <code className="kbd">sessionid</code> başlığından kopyala.
      </p>

      <label>AI Proxy URL</label>
      <div className="row">
        <input
          type="text"
          value={settings.proxyUrl}
          onChange={(e) =>
            setSettings({ ...settings, proxyUrl: e.target.value })
          }
          spellCheck={false}
        />
        <button onClick={refreshModels} disabled={busy} title="Modelleri çek">
          <RefreshCw size={12} className={busy ? "spin" : ""} />
        </button>
        {proxyOk === true && <span className="pill success">erişilebilir</span>}
        {proxyOk === false && <span className="pill danger">erişilemedi</span>}
      </div>

      <label style={{ marginTop: 10 }}>Model</label>
      <select
        value={settings.model}
        onChange={(e) => setSettings({ ...settings, model: e.target.value })}
      >
        {models.length === 0 && <option value={settings.model}>(yüklenmedi)</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>

      <label style={{ marginTop: 10 }}>Session ID</label>
      <div className="row">
        <textarea
          value={settings.sessionId}
          onChange={(e) =>
            setSettings({ ...settings, sessionId: e.target.value.trim() })
          }
          placeholder="UUID (örn. 7bf829b4-d757-4e4b-9912-7dfcbc5c7c58)"
          rows={2}
          style={{ flex: 1 }}
        />
        <button
          onClick={handleAutoDiscover}
          disabled={discoverStatus.state === "running"}
          title="admin-panel.codec.com.tr çerezinden otomatik bul"
        >
          <KeyRound size={12} /> Oturumu otomatik bul
        </button>
        <button
          onClick={handleHarPick}
          disabled={discoverStatus.state === "running"}
          title="DevTools'tan dışa aktarılan HAR dosyasından session'ı oku"
        >
          <FileSearch size={12} /> HAR'dan al
        </button>
        <input
          ref={harInputRef}
          type="file"
          accept=".har,application/json,text/plain"
          onChange={handleHarFile}
          style={{ display: "none" }}
        />
      </div>
      {discoverStatus.state !== "idle" && discoverStatus.message && (
        <p
          className={
            discoverStatus.state === "ok"
              ? "muted"
              : discoverStatus.state === "fail"
                ? "danger"
                : "muted"
          }
          style={{ fontSize: 11, marginTop: 4, marginBottom: 0 }}
        >
          {discoverStatus.state === "running"
            ? "Aranıyor…"
            : discoverStatus.message}
        </p>
      )}

      <label style={{ marginTop: 10 }}>İstekler arası bekleme (ms)</label>
      <input
        type="number"
        min={0}
        max={5000}
        step={50}
        value={settings.throttleMs}
        onChange={(e) =>
          setSettings({
            ...settings,
            throttleMs: Math.max(0, Number(e.target.value) || 0),
          })
        }
      />

      <div className="row" style={{ marginTop: 14 }}>
        <button className="primary" onClick={save} disabled={busy}>
          <Save size={12} /> Kaydet ve devam et
        </button>
      </div>

      <div
        className="row"
        style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border)" }}
      >
        <span className="muted" style={{ fontSize: 11 }}>
          Audit log: <strong>{auditCount}</strong> kayıt
        </span>
        <button
          onClick={handleClearAudit}
          disabled={auditCount === 0}
          title="Audit logu temizle"
        >
          <Trash2 size={12} /> Temizle
        </button>
      </div>

      <div
        style={{
          marginTop: 16,
          paddingTop: 12,
          borderTop: "1px solid var(--border)",
        }}
      >
        <OverrideEditor customers={customers} />
      </div>
    </div>
  );
}