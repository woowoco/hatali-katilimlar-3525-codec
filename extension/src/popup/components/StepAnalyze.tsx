import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  Sparkles,
  AlertTriangle,
  Cpu,
  ListChecks,
  Loader2,
  X,
  Wifi,
  Filter,
} from "lucide-react";
import { categorize, type CategorizeProgressInfo, applySubset } from "../../lib/ai.js";
import { saveSession, loadOverrides, type SessionState, type ItemSubset } from "../../lib/store.js";
import type { CategorizeBatchSummary, KeywordOverride } from "../../types.js";
import type { RouteCtx } from "../App.js";
import { useToast } from "./Toast.js";

/** Re-render every `tickMs` so the per-batch elapsed time keeps ticking. */
function useTick(intervalMs = 1000): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setN((x) => x + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return n;
}

function fmtElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}d ${s}s`;
}

export function StepAnalyze() {
  const ctx = useOutletContext<RouteCtx>();
  const { settings, session, setSession } = ctx;
  const navigate = useNavigate();
  const toast = useToast();
  // Re-render every second so elapsed times stay fresh while running.
  useTick(1000);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<CategorizeProgressInfo | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [batchStartedAt, setBatchStartedAt] = useState<number | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [stallWarning, setStallWarning] = useState(false);

  // Local subset editor state. `subset` is the persisted preference
  // (session.subset), `draft` is what the user is currently typing.
  const subset: ItemSubset = session.subset ?? { mode: "all" };
  const [draftMode, setDraftMode] = useState<ItemSubset["mode"]>(subset.mode);
  const [draftN, setDraftN] = useState<string>(
    subset.mode === "head" || subset.mode === "tail" ? String(subset.count) : "600",
  );
  const [draftStart, setDraftStart] = useState<string>(
    subset.mode === "range" ? String(subset.start) : "0",
  );
  const [draftEnd, setDraftEnd] = useState<string>(
    subset.mode === "range" ? String(subset.end) : "600",
  );

  const abortRef = useRef<AbortController | null>(null);

  const cancel = () => {
    abortRef.current?.abort();
  };

  /** Build an ItemSubset from the current draft inputs. */
  const buildSubset = (): ItemSubset => {
    if (draftMode === "all") return { mode: "all" };
    if (draftMode === "head" || draftMode === "tail") {
      const n = Math.max(1, Math.floor(Number(draftN) || 0));
      return { mode: draftMode, count: n };
    }
    // range
    const a = Math.max(0, Math.floor(Number(draftStart) || 0));
    const b = Math.max(a + 1, Math.floor(Number(draftEnd) || 0));
    return { mode: "range", start: a, end: b };
  };

  /** Apply current draft to the session (persists the user's choice). */
  const applyDraft = async (next: ItemSubset) => {
    const updated: SessionState = { ...session, subset: next };
    setSession(updated);
    await saveSession(updated);
  };

  // Load operator overrides once on mount and refresh when the customer
  // list changes (so the resolved acntEuId in the override table reflects
  // the current session's firms).
  const [overrides, setOverrides] = useState<KeywordOverride[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await loadOverrides();
      if (cancelled) return;
      // Resolve accountName → acntEuId against the current customer list.
      const norm = (s: string) => s.trim().toLowerCase();
      const byName = new Map(session.customers.map((c) => [norm(c.name), c.acntEuId]));
      const resolved = list.map((o) => ({
        ...o,
        acntEuId: byName.get(norm(o.accountName)) ?? o.acntEuId ?? null,
      }));
      setOverrides(resolved);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.customers.length]);

  /** Override rules that actually have a keyword list (skip empty rows). */
  const activeOverrides = useMemo(
    () => overrides.filter((o) => o.keywords.length > 0 && o.accountName.trim()),
    [overrides],
  );

  const run = async () => {
    setError(null);
    setBusy(true);
    setStartedAt(Date.now());
    setBatchStartedAt(Date.now());
    setLastEventAt(Date.now());
    setStallWarning(false);
    setProgress({
      batchesTotal: null,
      accumulatedMatches: 0,
      batchSummaries: {},
      finishedBatches: [],
      timedOutBatches: [],
      currentTimeoutMs: 90_000,
      consecutiveTimeouts: 0,
    });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Apply the user's subset choice right before sending. Persist
      // the draft so re-opens remember the selection.
      const chosen = buildSubset();
      await applyDraft(chosen);
      const itemsToSend = applySubset(session.items, chosen);
      if (itemsToSend.length === 0) {
        throw new Error("Subset boş — aralığı kontrol et (örn. 'İlk 600')");
      }

      const result = await categorize(
        settings.proxyUrl,
        settings.model,
        itemsToSend,
        session.customers,
        activeOverrides,
        (info) => {
          setProgress(info);
          setLastEventAt(Date.now());
          setStallWarning(false);
          // Reset the batch timer every time a new batch starts.
          if (
            info.batchIndex !== undefined &&
            info.batchIndex !== progress?.batchIndex
          ) {
            setBatchStartedAt(Date.now());
          }
        },
        { signal: controller.signal },
      );

      const batchList = progress
        ? Object.values(progress.batchSummaries).sort((a, b) => a.i - b.i)
        : [];
      const next: SessionState = {
        ...session,
        matches: result.matches,
        model: result.model,
        lastBatches: batchList,
        lastItemsCount: result.items ?? session.items.length,
      };
      await saveSession(next);
      setSession(next);
      toast.push(
        `${result.matches.length} eşleşme bulundu (${result.batches} batch)`,
        "success",
      );
      navigate("/review");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const aborted =
        (err as { name?: string })?.name === "AbortError" ||
        msg.toLowerCase().includes("aborted");
      if (aborted) {
        toast.push("AI çalıştırma iptal edildi", "info");
        setError(null);
      } else {
        setError(msg);
        toast.push(`AI çalıştırma başarısız: ${msg}`, "error");
      }
    } finally {
      setBusy(false);
      setStartedAt(null);
      setBatchStartedAt(null);
      abortRef.current = null;
    }
  };

  // Detect an in-progress stall: > 120s since last event. Lower than
  // the AI client's stallTimeoutMs (180s) so the warning surfaces
  // before the request actually errors out.
  useEffect(() => {
    if (!busy || !lastEventAt) return;
    const check = () => {
      if (Date.now() - lastEventAt > 120_000) setStallWarning(true);
    };
    const id = window.setInterval(check, 5_000);
    return () => window.clearInterval(id);
  }, [busy, lastEventAt]);

  // Live preview: how many items would the current draft send?
  const previewCount = useMemo(() => {
    if (busy) return 0;
    if (draftMode === "all") return session.items.length;
    if (draftMode === "head" || draftMode === "tail") {
      const n = Math.max(1, Math.floor(Number(draftN) || 0));
      return Math.min(n, session.items.length);
    }
    const a = Math.max(0, Math.floor(Number(draftStart) || 0));
    const b = Math.max(a + 1, Math.floor(Number(draftEnd) || 0));
    return Math.max(0, Math.min(b, session.items.length) - Math.min(a, session.items.length));
  }, [busy, draftMode, draftN, draftStart, draftEnd, session.items.length]);

  const progressLabel = progress
    ? progress.batchesTotal
      ? `Batch ${(progress.batchIndex ?? -0) + 2}/${progress.batchesTotal}`
      : "AI proxy'ye bağlanılıyor…"
    : "";

  const elapsedSec = startedAt
    ? Math.floor((Date.now() - startedAt) / 1000)
    : 0;
  const batchElapsedSec = batchStartedAt
    ? Math.floor((Date.now() - batchStartedAt) / 1000)
    : 0;
  const fillPct =
    progress?.batchesTotal && progress.batchesTotal > 0
      ? Math.min(
          100,
          Math.round(
            (((progress.batchIndex ?? -1) + 1) / progress.batchesTotal) * 100,
          ),
        )
      : 4;

  // What to render in the breakdown list: live progress while running,
  // otherwise the persisted lastBatches.
  const liveRows: CategorizeBatchSummary[] = progress
    ? Object.values(progress.batchSummaries).sort((a, b) => a.i - b.i)
    : (session.lastBatches ?? []);

  const totalBatches =
    progress?.batchesTotal ??
    (session.lastBatches && session.lastBatches.length > 0
      ? session.lastBatches.length
      : null);
  const runningBatch = progress?.batchIndex;

  return (
    <div className="section">
      <h2>AI ile Eşleştir</h2>

      <div className="summary">
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <div className="num">{session.items.length.toLocaleString("tr-TR")}</div>
            <div className="lbl">kayıt</div>
          </div>
          <div>
            <div className="num">{session.customers.length.toLocaleString("tr-TR")}</div>
            <div className="lbl">firma</div>
          </div>
          <div>
            <div className="num" style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <Cpu size={14} />
            </div>
            <div className="lbl">{settings.model}</div>
          </div>
        </div>
      </div>

      {error && (
        <div className="errors" style={{ marginTop: 0, marginBottom: 10 }}>
          <div className="err">
            <AlertTriangle size={11} style={{ verticalAlign: "middle" }} /> {error}
          </div>
        </div>
      )}

      {busy && progress && (
        <div className="progress">
          <div className="progress-bar">
            <div
              className="fill"
              style={{
                width: `${fillPct}%`,
                background:
                  fillPct < 100 ? "var(--accent)" : "var(--success)",
              }}
            />
          </div>
          <div className="progress-info">
            <span>{progressLabel}</span>
            <span>
              {progress.accumulatedMatches.toLocaleString("tr-TR")} eşleşti
              {elapsedSec > 0 && ` · ${fmtElapsed(elapsedSec)}`}
            </span>
          </div>
        </div>
      )}

      {busy && (
        <div className="batch-running">
          <div className="batch-running__row">
            <Loader2 size={14} className="spin" />
            <span>
              {progress?.batchesTotal
                ? `Batch ${(progress.batchIndex ?? -1) + 2}/${progress.batchesTotal}`
                : "AI proxy'ye bağlanılıyor…"}
              {progress?.currentBatchSize
                ? ` · ${progress.currentBatchSize} kayıt işleniyor`
                : ""}
              {batchStartedAt && ` · ${fmtElapsed(batchElapsedSec)} geçti`}
            </span>
          </div>
          {stallWarning && (
            <div className="batch-running__warn">
              <Wifi size={12} />
              <span>
                60 saniyedir proxy'den veri gelmiyor. MiniMax API yavaş veya
                takılı olabilir; istersen iptal edebilirsin.
              </span>
            </div>
          )}
          <button
            className="batch-running__cancel"
            onClick={cancel}
            title="Kategorizasyonu iptal et (henüz gönderilmemiş batch'ler atlanır)"
          >
            <X size={11} /> İptal
          </button>
        </div>
      )}

      <div className="muted" style={{ marginTop: 10, fontSize: 11, marginBottom: 8 }}>
        <Sparkles size={11} style={{ verticalAlign: "middle" }} /> AI her kayıt için{" "}
        <em>okumayacağı</em> sadece <strong>öneri</strong> üretir. Hiçbir otomatik
        ücretlendirme yapmaz — sonraki adımda sen her satırı kendin tetiklersin.
      </div>

      {!busy && session.items.length > 0 && (
        <div className="subset-picker">
          <div className="subset-picker__head">
            <Filter size={11} style={{ verticalAlign: "middle" }} />
            <span>Hangi kayıtlar işlensin?</span>
          </div>
          <div className="subset-picker__radios">
            <label>
              <input
                type="radio"
                name="subset-mode"
                checked={draftMode === "all"}
                onChange={() => setDraftMode("all")}
              />
              <span>Hepsi ({session.items.length.toLocaleString("tr-TR")})</span>
            </label>
            <label>
              <input
                type="radio"
                name="subset-mode"
                checked={draftMode === "head"}
                onChange={() => setDraftMode("head")}
              />
              <span>İlk</span>
              <input
                type="number"
                min={1}
                max={session.items.length}
                value={draftN}
                onChange={(e) => setDraftN(e.target.value)}
                disabled={draftMode !== "head"}
                style={{ width: 80 }}
              />
              <span>kayıt</span>
            </label>
            <label>
              <input
                type="radio"
                name="subset-mode"
                checked={draftMode === "tail"}
                onChange={() => setDraftMode("tail")}
              />
              <span>Son</span>
              <input
                type="number"
                min={1}
                max={session.items.length}
                value={draftN}
                onChange={(e) => setDraftN(e.target.value)}
                disabled={draftMode !== "tail"}
                style={{ width: 80 }}
              />
              <span>kayıt</span>
            </label>
            <label>
              <input
                type="radio"
                name="subset-mode"
                checked={draftMode === "range"}
                onChange={() => setDraftMode("range")}
              />
              <span>Aralık [</span>
              <input
                type="number"
                min={0}
                max={session.items.length}
                value={draftStart}
                onChange={(e) => setDraftStart(e.target.value)}
                disabled={draftMode !== "range"}
                style={{ width: 70 }}
              />
              <span>,</span>
              <input
                type="number"
                min={0}
                max={session.items.length}
                value={draftEnd}
                onChange={(e) => setDraftEnd(e.target.value)}
                disabled={draftMode !== "range"}
                style={{ width: 70 }}
              />
              <span>)</span>
            </label>
          </div>
          <div className="subset-picker__preview">
            <strong>{previewCount.toLocaleString("tr-TR")}</strong>{" "}
            kayıt gönderilecek
            {previewCount > 0 && (
              <span style={{ marginLeft: 8, opacity: 0.7 }}>
                · ~{Math.ceil(previewCount / 50)} batch · ~{Math.ceil(previewCount / 10)}s tahmini
              </span>
            )}
          </div>
        </div>
      )}

      {!busy && previewCount > 0 && (
        <PreviewTable items={applySubset(session.items, buildSubset())} />
      )}

      {!busy && activeOverrides.length > 0 && (
        <div className="override-summary">
          <strong>{activeOverrides.length}</strong> override kuralı
          yüklü — model bunlara <em>her zaman</em> uyacak:
          <ul>
            {activeOverrides.slice(0, 5).map((o) => (
              <li key={o.id}>
                <code>{o.accountName}</code> ←{" "}
                <span className="override-summary__kw">
                  {o.keywords.slice(0, 4).join(", ")}
                  {o.keywords.length > 4 ? ` …+${o.keywords.length - 4}` : ""}
                </span>
                {!o.acntEuId && (
                  <span className="override-summary__warn">
                    (firm listede yok)
                  </span>
                )}
              </li>
            ))}
            {activeOverrides.length > 5 && (
              <li className="override-summary__more">
                …ve {activeOverrides.length - 5} kural daha
              </li>
            )}
          </ul>
        </div>
      )}

      <div className="row">
        <button
          className="primary"
          onClick={run}
          disabled={busy || session.items.length === 0}
        >
          <Sparkles size={12} />
          {session.matches ? "Yeniden eşleştir" : "AI'ı çalıştır"}
        </button>
      </div>

      {liveRows.length > 0 && (
        <div className="batch-list">
          <div className="batch-list__head">
            <span>
              <ListChecks size={11} style={{ verticalAlign: "middle" }} />{" "}
              Batch breakdown
            </span>
            <span>
              {liveRows.length}
              {totalBatches ? `/${totalBatches}` : ""} batch ·{" "}
              {liveRows.reduce((s, b) => s + b.matches, 0)} eşleşme
              {session.lastItemsCount
                ? ` · ${session.lastItemsCount} kayıt`
                : ""}
            </span>
          </div>
          <div className="batch-list__rows">
            {liveRows.map((b) => {
              const pct =
                b.size > 0
                  ? Math.min(100, Math.round((b.matches / b.size) * 100))
                  : 0;
              const isRunning =
                busy &&
                runningBatch !== undefined &&
                b.i === runningBatch &&
                !progress?.finishedBatches.includes(b.i);
              const isPending =
                busy &&
                runningBatch !== undefined &&
                b.i > runningBatch;
              return (
                <div
                  key={b.i}
                  className={`batch-list__row${isRunning ? " batch-list__row--running" : ""}${isPending ? " batch-list__row--pending" : ""}`}
                >
                  <span className="batch-list__idx">#{b.i + 1}</span>
                  <div className="batch-list__bar">
                    <span style={{ width: `${pct}%` }} />
                  </div>
                  <span className="batch-list__pct">{pct}%</span>
                  <span className="batch-list__matches">
                    {b.matches}/{b.size}
                  </span>
                  <span className="batch-list__pct">
                    {b.accumulated.toLocaleString("tr-TR")}↗
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {session.matches && !busy && (
        <div className="muted" style={{ marginTop: 10, fontSize: 11 }}>
          {session.matches.length} kayıt eşleştirildi. <strong>İncele</strong>{" "}
          sekmesinden tabloya bakabilirsin.
        </div>
      )}
    </div>
  );
}

/**
 * Read-only preview of the items that will be sent to /categorize.
 * Renders the first 20 rows + a "…and N more" footer. Lets the user
 * sanity-check the payload before clicking "AI'ı çalıştır".
 */
function PreviewTable({ items }: { items: import("../../types.js").UnmatchedItem[] }) {
  const shown = items.slice(0, 20);
  const more = items.length - shown.length;
  return (
    <div className="preview-table">
      <div className="preview-table__head">
        <span>
          <ListChecks size={10} style={{ verticalAlign: "middle" }} /> AI'ya
          gönderilecek kayıtlar (önizleme)
        </span>
        <span>{items.length.toLocaleString("tr-TR")} satır</span>
      </div>
      <div className="preview-table__scroll">
        {shown.map((it) => (
          <div key={it.transactionId} className="preview-table__row">
            <span className="preview-table__cell preview-table__cell--meta">
              #{it.transactionId}
            </span>
            <span className="preview-table__cell preview-table__cell--meta">
              {it.phone}
            </span>
            <span className="preview-table__cell preview-table__cell--kw">
              {it.keyword1 || "·"}
            </span>
            <span className="preview-table__cell preview-table__cell--kw">
              {it.keyword2 || "·"}
            </span>
            <span className="preview-table__cell">{it.msgContent || "·"}</span>
          </div>
        ))}
      </div>
      {more > 0 && (
        <div className="preview-table__more">
          …ve {more.toLocaleString("tr-TR")} satır daha (gönderilecek ama
          burada gösterilmiyor)
        </div>
      )}
    </div>
  );
}