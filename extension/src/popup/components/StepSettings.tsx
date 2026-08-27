import { useEffect, useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  FlaskConical,
  FileSearch,
  KeyRound,
  ListChecks,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { fetchModels } from "../../lib/ai.js";
import { DEMO_FIXTURE } from "../../lib/api-mock.js";
import { extractSessionFromHar } from "../../lib/har.js";
import { discoverSession } from "../../lib/session.js";
import {
  clearAudit,
  clearSession,
  EMPTY_SESSION,
  loadAudit,
  saveSession,
  saveSettings,
  type SessionState,
} from "../../lib/store.js";
import type { ModelInfo } from "../../types.js";
import type { RouteCtx } from "../App.js";
import { useToast } from "./Toast.js";

export function StepSettings() {
  const ctx = useOutletContext<RouteCtx>();
  const { settings, setSettings, session, setSession } = ctx;
  const navigate = useNavigate();
  const toast = useToast();

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [proxyOk, setProxyOk] = useState<boolean | null>(null);
  const [auditCount, setAuditCount] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [discoverStatus, setDiscoverStatus] = useState<{
    state: "idle" | "running" | "ok" | "fail";
    message?: string;
  }>({ state: "idle" });
  const harInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadAudit().then((a) => setAuditCount(a.length));
  }, []);

  const refreshModels = async () => {
    setBusy(true);
    try {
      const r = await fetchModels(settings.proxyUrl, settings.demoMode);
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

  /**
   * Pre-populate `chrome.storage.local` with the 24-item multi-firm demo
   * fixture so the operator lands directly on /review with the firm-flat
   * layout visible (12 + 6 + 6 = 24 txIds across 3 firm sections). No
   * backend or proxy required when Settings.demoMode is also on.
   */
  const handleLoadDemoData = async () => {
    const next: SessionState = {
      customers: DEMO_FIXTURE.customers,
      items: DEMO_FIXTURE.items,
      matches: DEMO_FIXTURE.matches,
      model: "demo-mock",
      fetchedAt: new Date().toISOString(),
      chargedIds: [],
      ignoredIds: [],
      firmOverrides: {},
      txFirmOverrides: {},
    };
    await saveSession(next);
    setSession(next);
    if (!settings.demoMode) {
      const next = { ...settings, demoMode: true };
      setSettings(next);
      try { await saveSettings(next); }
      catch { /* non-fatal: in-memory toggle still works for this session */ }
    }
    toast.push(
      "Demo verisi yüklendi — İncele sekmesine geçebilirsin.",
      "success",
    );
    navigate("/review");
  };

  /**
   * Wipe the in-memory and persisted session so the UI reverts to the
   * empty pre-fetch state. Use case: operator finished experimenting
   * with the demo fixture and wants a clean slate before connecting to
   * a real backend, OR wants to re-load the demo with a fresh
   * generated timestamp without restarting the popup.
   *
   * What's removed:
   *   - customers / items / matches (the actual fetched/synthesized data)
   *   - chargedIds / ignoredIds / firmOverrides / txFirmOverrides (per-row UI state)
   *   - lastBatches / lastItemsCount / subset / model / fetchedAt (analyze metadata)
   *   - chrome.storage.local `session.v1` (handled by clearSession)
   *
   * What survives:
   *   - settings (proxyUrl, model selection, throttleMs, demoMode flag)
   *   - audit log (history of Charged POSTs actually sent)
   *   - keyword override rules (`overrides.v1`, not session-scoped)
   *
   * settings.demoMode is intentionally NOT turned off — flipping it
   * back on for the next "Demo verisini yükle" should be one click.
   * The toggle's text already says "(mock veri)" so it's not silently
   * dangerous: StepFetch / StepAnalyze clearly route through the mock.
   */
  const handleClearDemoData = async () => {
    const hasData =
      session.items.length > 0 ||
      session.matches !== null ||
      session.customers.length > 0;
    if (!hasData) return;
    const ok = confirm(
      "Demo verisi (müşteri listesi, kayıtlar, AI eşleşmeleri, ücretlendirme ve override'lar) silinecek.\n\n" +
        "Ayarların, audit log ve kalıcı keyword kuralların korunacak.\n\n" +
        "Devam edilsin mi?",
    );
    if (!ok) return;
    try {
      await clearSession();
      setSession(EMPTY_SESSION);
      toast.push("Demo verisi silindi — tüm UI sıfırlandı.", "info");
      // Force-navigate to /settings so any stale /review state (cached
      // memo'd firmSections, selection Set<number>, etc.) is unmounted.
      // The reachable Set computed in App.tsx already reflects the empty
      // session, but navigating is belt-and-suspenders.
      navigate("/settings");
    } catch (err) {
      toast.push(
        `Silme başarısız: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  };

  // True when any demo data is currently resident in the session —
  // used to decide whether the "Demo verisini sil" button is meaningful.
  const demoDataLoaded =
    session.items.length > 0 ||
    session.matches !== null ||
    session.customers.length > 0;

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
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontWeight: 500,
            margin: 0,
          }}
        >
          <ListChecks size={12} /> Özel Yönlendirme Kuralları
        </label>
        <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          Kurallar artık <b>Verileri Çek</b> sekmesinde — müşteri listesi
          çekildikten sonra firma adları doğrudan eşleşir ve AI
          tarafından otomatik tespit edilemeyen keyword'ler için hızlı
          kural ekleme paneli görünür.
        </p>
        <div className="row" style={{ marginTop: 8 }}>
          <button
            disabled={session.items.length === 0 && session.customers.length === 0}
            onClick={() => navigate("/fetch")}
            title={
              session.items.length === 0 && session.customers.length === 0
                ? "Önce Verileri Çek sekmesinden veri çek"
                : "Verileri Çek sekmesine git"
            }
          >
            <ListChecks size={12} /> Kuralları yönet →
          </button>
        </div>
      </div>

      <div
        style={{
          marginTop: 16,
          paddingTop: 12,
          borderTop: "1px solid var(--border)",
        }}
      >
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          <input
            type="checkbox"
            checked={settings.demoMode}
            onChange={async (e) => {
              const next = { ...settings, demoMode: e.target.checked };
              setSettings(next);
              // Persist immediately — the operator expects the toggle to
              // survive a popup reload (otherwise they forget they turned
              // it on and StepFetch / StepAnalyze will hit the live API).
              try { await saveSettings(next); }
              catch (err) {
                toast.push(
                  `Demo modu kaydedilemedi: ${err instanceof Error ? err.message : String(err)}`,
                  "error",
                );
              }
            }}
          />
          <FlaskConical size={12} /> Demo modu (mock veri)
        </label>
        <p className="muted" style={{ fontSize: 11, marginTop: 4 }}>
          Admin-panel-api ve AI proxy çağrıları extension'ın içindeki fixture
          ile cevaplanır — gerçek backend'e <b>hiçbir istek gitmez</b>. Sadece
          arayüz doğrulaması içindir; production'da kapalı kalmalı.
        </p>
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={handleLoadDemoData}>
            <FlaskConical size={12} /> Demo verisini yükle
          </button>
          {demoDataLoaded && (
            <button
              className="danger"
              onClick={handleClearDemoData}
              title="Demo verisini sil — tüm UI sıfırlanır, settings + audit log + override kuralları korunur"
            >
              <Trash2 size={12} /> Demo verisini sil
            </button>
          )}
        </div>
      </div>
    </div>
  );
}