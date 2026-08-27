import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { Download, AlertTriangle, CheckCircle2, Inbox } from "lucide-react";
import {
  getCustomersToBeCharged,
  getUnmatchedList,
} from "../../lib/api.js";
import {
  EMPTY_SESSION,
  saveSession,
  type SessionState,
} from "../../lib/store.js";
import type { RouteCtx } from "../App.js";
import { useToast } from "./Toast.js";

export function StepFetch() {
  const ctx = useOutletContext<RouteCtx>();
  const { settings, session, setSession } = ctx;
  const navigate = useNavigate();
  const toast = useToast();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customersProgress, setCustomersProgress] = useState<
    "idle" | "done" | "running"
  >(session.customers.length > 0 ? "done" : "idle");

  const fetchedAt = session.fetchedAt ? new Date(session.fetchedAt) : null;

  const fetchAll = async () => {
    if (!settings.sessionId) {
      setError("Önce Ayarlar sekmesinden sessionId gir.");
      toast.push("Session bağlı değil", "error");
      return;
    }
    setError(null);
    setBusy(true);
    setCustomersProgress("running");

    try {
      const customers = await getCustomersToBeCharged(settings.sessionId);
      setSession({ ...session, customers });
      setCustomersProgress("done");

      const items = await getUnmatchedList(settings.sessionId);

      const next: SessionState = {
        ...EMPTY_SESSION,
        customers,
        items,
        fetchedAt: new Date().toISOString(),
      };
      await saveSession(next);
      setSession(next);
      toast.push(
        `${items.length} kayıt · ${customers.length} firma çekildi`,
        "success",
      );
      navigate("/analyze");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.push(`Çekme başarısız: ${msg}`, "error");
      setCustomersProgress("idle");
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    await saveSession(EMPTY_SESSION);
    setSession(EMPTY_SESSION);
    setError(null);
    setCustomersProgress("idle");
    toast.push("Session verileri sıfırlandı", "info");
  };

  return (
    <div className="section">
      <h2>Verileri Çek</h2>

      {error && (
        <div className="errors" style={{ marginTop: 0, marginBottom: 10 }}>
          <div className="err">
            <AlertTriangle size={11} style={{ verticalAlign: "middle" }} /> {error}
          </div>
        </div>
      )}

      {fetchedAt && (
        <div className="summary">
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <div>
              <div className="num">{session.items.length.toLocaleString("tr-TR")}</div>
              <div className="lbl">Eşleşmemiş kayıt</div>
            </div>
            <div>
              <div className="num">{session.customers.length.toLocaleString("tr-TR")}</div>
              <div className="lbl">Firma</div>
            </div>
          </div>
          <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>
            <Inbox size={11} style={{ verticalAlign: "middle" }} /> Son çekim:{" "}
            {fetchedAt.toLocaleString("tr-TR")}
          </div>
        </div>
      )}

      <div className="row">
        <button className="primary" onClick={fetchAll} disabled={busy}>
          <Download size={12} />{" "}
          {fetchedAt ? "Yeniden çek" : "Müşterileri ve listeyi çek"}
        </button>
        {customersProgress === "done" && !busy && (
          <span className="pill success">
            <CheckCircle2 size={11} /> hazır
          </span>
        )}
        {busy && <span className="pill">çalışıyor…</span>}
      </div>

      {fetchedAt && (
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={reset} disabled={busy}>
            Sıfırla
          </button>
        </div>
      )}
    </div>
  );
}