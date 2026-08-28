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
  Layers,
} from "lucide-react";
import { categorize, type CategorizeProgressInfo, applySubset, selectNewBatchMatches } from "../../lib/ai.js";
import {
  clusterByFingerprint,
  expandClusterMatches,
} from "../../lib/clustering.js";
import { saveSession, loadOverrides, type SessionState, type ItemSubset } from "../../lib/store.js";
import type { CategorizeBatchSummary, ItemMatch, KeywordOverride, UnmatchedItem } from "../../types.js";
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

  // Running accumulator for incremental persistence. Each batch-done
  // appends its (expanded) matches here, and a debounced saveSession
  // writes the partial result so a mid-run timeout/error never wipes
  // out already-classified records. See `docs/SAFETY-CONTRACT.md` §3.
  const runningMatchesRef = useRef<ItemMatch[]>([]);
  // Track which batch indices we've already appended to the accumulator.
  // The progress callback fires on EVERY SSE event (batch-start,
  // batch-done, batch-timeout, …), not just batch-done — so without this
  // set we'd re-append `info.finishedBatches[length-1]` once per event
  // and the same batch's matches would land in `runningMatchesRef` many
  // times (production saw #13083146 fourteen times in one row from a
  // single batch). Set is keyed by batchIndex — completion order can
  // differ from submission order with parallel workers, so a "last
  // index" guard would miss out-of-order appends.
  const appendedBatchIndicesRef = useRef<Set<number>>(new Set());
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    // Hoisted so the catch-block partial-recovery path can reference
    // the size when persisting the salvaged matches. Throwing inside
    // the try block (empty subset, cluster guard, etc.) short-circuits
    // before this assignment, but the catch branch only fires after
    // the cluster guard ran, so by then itemsToSend is defined.
    let itemsToSend: UnmatchedItem[] = [];

    try {
      // Apply the user's subset choice right before sending. Persist
      // the draft so re-opens remember the selection.
      const chosen = buildSubset();
      await applyDraft(chosen);
      itemsToSend = applySubset(session.items, chosen);
      if (itemsToSend.length === 0) {
        throw new Error("Subset boş — aralığı kontrol et (örn. 'İlk 600')");
      }

      // Opt-in fingerprint clustering: when `clusteringEnabled` is on,
      // collapse identical (kw1, kw2, msgContent) items into one
      // representative before sending. The LLM verdict is replicated
      // back to every cluster member via `expandClusterMatches`. Off
      // (default) keeps the legacy per-item path verbatim.
      const clusteringOn = settings.clusteringEnabled === true;
      let llmItems: UnmatchedItem[];
      let expand: (matches: ItemMatch[]) => ItemMatch[];
      let clusterMapForGuard: Map<number, number[]> | null = null;
      if (clusteringOn) {
        const { representatives, clusterMap } = clusterByFingerprint(itemsToSend);
        llmItems = representatives;
        clusterMapForGuard = clusterMap;
        expand = (matches) => expandClusterMatches(matches, clusterMap);
      } else {
        llmItems = itemsToSend;
        expand = (matches) => matches;
      }

      // Incremental persistence: every batch-done appends its expanded
      // matches to `runningMatchesRef` and triggers a debounced
      // saveSession. If categorize() later throws mid-run, the partial
      // matches are already in chrome.storage.local and the operator
      // can navigate to /review without losing anything.
      runningMatchesRef.current = [];
      appendedBatchIndicesRef.current = new Set();
      if (saveDebounceRef.current) {
        clearTimeout(saveDebounceRef.current);
        saveDebounceRef.current = null;
      }
      const savePartial = async () => {
        if (saveDebounceRef.current) {
          clearTimeout(saveDebounceRef.current);
          saveDebounceRef.current = null;
        }
        const matches = runningMatchesRef.current;
        try {
          await saveSession({
            ...session,
            matches,
            model: settings.model,
            lastBatches: progress
              ? Object.values(progress.batchSummaries).sort((a, b) => a.i - b.i)
              : [],
            lastItemsCount: itemsToSend.length,
          });
        } catch (err) {
          console.error("[analyze] incremental saveSession failed:", err);
        }
      };
      const debouncedSave = () => {
        if (saveDebounceRef.current) clearTimeout(saveDebounceRef.current);
        saveDebounceRef.current = setTimeout(() => {
          savePartial().catch(console.error);
        }, 250);
      };

      const result = await categorize(
        settings.proxyUrl,
        settings.model,
        llmItems,
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
          // The proxy's batch-done now ships the FULL matches array
          // (was just a count). Append expanded matches to the running
          // accumulator and trigger a debounced save so a mid-run
          // timeout/error doesn't wipe out already-classified records.
          //
          // Walk every index in `finishedBatches` via the dedup helper
          // — the callback fires multiple times per batch (once per SSE
          // event after the batch-done) so a "last index" pick would
          // re-append the same batch on every subsequent event.
          const { matches: newMatches, newIndices } = selectNewBatchMatches(
            info,
            appendedBatchIndicesRef.current,
          );
          if (newIndices.length > 0) {
            const expanded = expand(newMatches);
            runningMatchesRef.current =
              runningMatchesRef.current.concat(expanded);
            for (const idx of newIndices) {
              appendedBatchIndicesRef.current.add(idx);
            }
            debouncedSave();
          }
        },
        { signal: controller.signal, demoMode: settings.demoMode },
      );

      const finalMatches = expand(result.matches);

      // Defense-in-depth: if clustering is on, every original txId in
      // `itemsToSend` must appear exactly once in `finalMatches`. The
      // LLM already returns one match per representative and expansion
      // is lossless by construction — this catches any future drift.
      if (clusteringOn && clusterMapForGuard) {
        const originalIds = new Set(itemsToSend.map((it) => it.transactionId));
        const missing = [...originalIds].filter(
          (id) => !finalMatches.some((m) => m.transactionId === id),
        );
        if (missing.length > 0) {
          throw new Error(
            `cluster expansion missed ${missing.length} txIds (örn. ${missing.slice(0, 5).join(", ")})`,
          );
        }
      }

      const batchList = progress
        ? Object.values(progress.batchSummaries).sort((a, b) => a.i - b.i)
        : [];
      // The streaming accumulator may have drifted from the canonical
      // finalMatches if the proxy re-emitted a batch via repair. Sync
      // the ref to the authoritative result and flush the pending save.
      runningMatchesRef.current = finalMatches;
      const next: SessionState = {
        ...session,
        matches: finalMatches,
        model: result.model,
        lastBatches: batchList,
        lastItemsCount: result.items ?? itemsToSend.length,
      };
      await saveSession(next);
      setSession(next);
      if (saveDebounceRef.current) {
        clearTimeout(saveDebounceRef.current);
        saveDebounceRef.current = null;
      }
      if (result.partial) {
        // Partial recovery: the run didn't reach `done`, but the proxy
        // salvaged whatever batches completed. We still navigate to
        // /review so the operator can act on the matches we have; the
        // failedBatches list surfaces what they didn't get.
        const failed = result.failedBatches?.length ?? 0;
        toast.push(
          `Kısmi sonuç: ${finalMatches.length} eşleşme alındı${
            failed > 0 ? `, ${failed} batch başarısız oldu` : ""
          }. Devam edebilirsin.`,
          "info",
        );
      } else {
        toast.push(
          `${finalMatches.length} eşleşme bulundu (${result.batches} batch${
            clusteringOn ? `, clustering açık: ${llmItems.length} temsilci` : ""
          })`,
          "success",
        );
      }
      navigate("/review");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const aborted =
        (err as { name?: string })?.name === "AbortError" ||
        msg.toLowerCase().includes("aborted");

      // Partial-recovery: even on error/timeout/abort, if the per-batch
      // accumulator has matches we MUST flush them to disk and navigate
      // to /review. The previous behaviour swallowed all of batch N's
      // work when categorize() threw at t=180s on a legitimate run —
      // the user saw "all 16 batches green" in the live UI but never
      // reached the review screen. This path is the safety net that
      // catches every reason categorize() can throw.
      const partialMatches = runningMatchesRef.current;
      if (partialMatches.length > 0) {
        // Cancel any pending debounced save — we're about to write the
        // canonical state directly, no point letting the timer race us.
        if (saveDebounceRef.current) {
          clearTimeout(saveDebounceRef.current);
          saveDebounceRef.current = null;
        }
        const batchList = progress
          ? Object.values(progress.batchSummaries).sort((a, b) => a.i - b.i)
          : [];
        const next: SessionState = {
          ...session,
          matches: partialMatches,
          model: settings.model,
          lastBatches: batchList,
          lastItemsCount: itemsToSend.length,
        };
        try {
          await saveSession(next);
        } catch (saveErr) {
          console.error("[analyze] partial saveSession failed:", saveErr);
        }
        setSession(next);
        if (aborted) {
          toast.push(
            `İptal edildi ama ${partialMatches.length} eşleşme kurtarıldı.`,
            "info",
          );
        } else {
          toast.push(
            `Hata: ${msg} — ama ${partialMatches.length} eşleşme kurtarıldı.`,
            "info",
          );
        }
        // Show the underlying error in the error pane so the operator
        // knows WHY the run didn't complete — but DON'T keep them
        // trapped on the analyze screen with no data.
        if (!aborted) setError(msg);
        // Reset running accumulator so a re-run starts clean.
        runningMatchesRef.current = [];
        navigate("/review");
        return;
      }

      // No matches salvaged: this is a true before-first-batch failure
      // (network refused, no batches even started, etc.). Stay on the
      // analyze screen and surface the error normally.
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

  /**
   * Subset → cluster result. Holds the actual subset items (what the
   * operator selected) and, when clustering is ON, the representative
   * items that the LLM would see (the subset collapsed by fingerprint).
   *
   * Single source of truth: the preview counts AND the preview tables
   * all read from this memo, so `clusterByFingerprint` runs once per
   * subset/toggle change instead of twice.
   */
  const subsetItems = useMemo(() => {
    if (busy) return [];
    return applySubset(session.items, buildSubset());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, session.items, draftMode, draftN, draftStart, draftEnd]);

  /**
   * Items that would actually reach the LLM. Equal to `subsetItems`
   * when clustering is OFF; the fingerprint representatives when ON.
   */
  const llmItems = useMemo(() => {
    if (!settings.clusteringEnabled) return subsetItems;
    return clusterByFingerprint(subsetItems).representatives;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subsetItems, settings.clusteringEnabled]);

  const representativeCount = llmItems.length;

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
            <div>
              <strong>Seçili:</strong>{" "}
              <strong>{previewCount.toLocaleString("tr-TR")}</strong> kayıt
            </div>
            <div style={{ marginTop: 2, display: "flex", alignItems: "center", gap: 6 }}>
              <strong>LLM'e gönderilecek:</strong>{" "}
              <strong>{representativeCount.toLocaleString("tr-TR")}</strong>{" "}
              {settings.clusteringEnabled ? "temsilci" : "kayıt"}
              {settings.clusteringEnabled && (
                <span
                  className="pill"
                  style={{
                    background: "var(--accent-bg, rgba(99,102,241,0.15))",
                    color: "var(--accent)",
                    fontSize: 10,
                    padding: "1px 6px",
                    marginLeft: 2,
                  }}
                  title="Clustering modu: benzer (kw1, kw2, msgContent) kayıtlar tek temsilci olarak gönderilir"
                >
                  <Layers size={10} style={{ verticalAlign: "middle", marginRight: 3 }} />
                  clustering
                </span>
              )}
              {settings.clusteringEnabled && previewCount > 0 && (
                <span style={{ opacity: 0.7 }}>
                  · ×{(previewCount / Math.max(representativeCount, 1)).toFixed(1)} kazanç
                </span>
              )}
            </div>
            {previewCount > 0 && (
              <span style={{ marginLeft: 0, marginTop: 4, opacity: 0.7, display: "block" }}>
                ~{Math.ceil(representativeCount / 50)} batch · ~{Math.ceil(representativeCount / 10)}s tahmini
              </span>
            )}
          </div>
        </div>
      )}

      {!busy && previewCount > 0 && (
        <>
          <PreviewTable
            title={
              settings.clusteringEnabled
                ? "Seçili kayıtlar (subset)"
                : "AI'ya gönderilecek kayıtlar (önizleme)"
            }
            items={subsetItems}
          />
          {settings.clusteringEnabled && (
            <PreviewTable
              title="LLM'e gönderilecek temsilciler (clustering sonrası)"
              items={llmItems}
              accent="clustering"
            />
          )}
        </>
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
 * Read-only preview of items. Renders ALL rows (no truncation) — the
 * operator asked to see the complete payload before clicking "AI'ı
 * çalıştır", especially in clustering mode where the LLM-side
 * representatives differ from the original subset. The scroll container
 * is `max-height: 220px` in CSS so the table doesn't push other UI
 * off-screen on a 2700-item HAR.
 *
 * `title`  — header label. Pass a different label per table when two
 *             are shown (subset vs. representatives).
 * `accent` — when "clustering", the header gets an accent tint so the
 *             operator can visually tell "this is the LLM-side list".
 */
function PreviewTable({
  items,
  title = "AI'ya gönderilecek kayıtlar (önizleme)",
  accent,
}: {
  items: import("../../types.js").UnmatchedItem[];
  title?: string;
  accent?: "clustering";
}) {
  return (
    <div
      className="preview-table"
      style={
        accent === "clustering"
          ? { borderColor: "var(--accent)" }
          : undefined
      }
    >
      <div className="preview-table__head">
        <span>
          {accent === "clustering" ? (
            <Layers size={10} style={{ verticalAlign: "middle", marginRight: 3 }} />
          ) : (
            <ListChecks size={10} style={{ verticalAlign: "middle" }} />
          )}{" "}
          {title}
        </span>
        <span>{items.length.toLocaleString("tr-TR")} satır</span>
      </div>
      <div className="preview-table__scroll">
        {items.map((it) => (
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
    </div>
  );
}