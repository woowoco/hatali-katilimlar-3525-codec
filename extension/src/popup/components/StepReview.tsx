import { useLayoutEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  ChevronDown,
  ChevronUp,
  Zap,
  AlertTriangle,
  ListChecks,
  Square,
  CheckSquare,
  Loader2,
  Copy,
  X,
  Search,
} from "lucide-react";
import {
  buildKeywordRows,
  flattenSelection,
  groupSelectionByRow,
  type KeywordRow,
} from "../../lib/ai.js";
import { chargeOnce } from "../../lib/charger.js";
import { saveSession, type SessionState } from "../../lib/store.js";
import type { Customer, UnmatchedItem } from "../../types.js";
import type { RouteCtx } from "../App.js";
import { useToast } from "./Toast.js";

type RowFilter = "all" | "high" | "medium" | "low" | "codec";
type CopyFormat = "comma" | "json" | "newline" | "sql";

interface ItemProgress {
  id: number;
  state: "pending" | "running" | "ok" | "fail";
  error?: string;
}

/**
 * Format the given txIds according to the user's chosen format.
 * - comma  → "123, 456, 789"
 * - json   → "[123, 456, 789]"
 * - newline→ "123\n456\n789"
 * - sql    → "(123, 456, 789)"
 */
function formatTxIds(ids: number[], format: CopyFormat): string {
  switch (format) {
    case "comma": return ids.join(", ");
    case "newline": return ids.join("\n");
    case "json": return JSON.stringify(ids);
    case "sql": return `(${ids.join(", ")})`;
  }
}

const COPY_FORMAT_LABEL: Record<CopyFormat, string> = {
  comma: "Virgülle (123, 456)",
  newline: "Satır başına",
  json: "JSON dizi",
  sql: "SQL IN (123, 456)",
};

export function StepReview() {
  const ctx = useOutletContext<RouteCtx>();
  const { settings, session, setSession } = ctx;
  const toast = useToast();

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RowFilter>("all");
  const [chargeProgress, setChargeProgress] = useState<Map<string, ItemProgress> | null>(null);

  // Per-row txId selection — keyed by `rowGroup:txId` so each row has its own set.
  const [selected, setSelected] = useState<Map<string, Set<number>>>(new Map());

  // Copy bar state
  const [copyFormat, setCopyFormat] = useState<CopyFormat>("comma");

  // Search box — filters rows whose label matches, or whose any txId matches.
  const [search, setSearch] = useState("");

  const itemsById = useMemo(() => {
    const m = new Map<number, UnmatchedItem>();
    for (const it of session.items) m.set(it.transactionId, it);
    return m;
  }, [session.items]);

  const chargedSet = useMemo(
    () => new Set(session.chargedIds),
    [session.chargedIds],
  );

  const rows = useMemo(
    () =>
      buildKeywordRows(session.matches ?? [], chargedSet, {
        firmOverrides: session.firmOverrides,
      }),
    [session.matches, chargedSet, session.firmOverrides],
  );

  /**
   * Sticky-offset probe: the table header sits at `top: var(--toolbar-h)`
   * and we measure the toolbar's rendered height with a ResizeObserver so
   * the offset stays correct across viewport widths and locale changes
   * (the search box / filter buttons have no fixed height).
   */
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const tb = document.querySelector(".review-toolbar");
    const root = document.documentElement;
    if (!tb || !root) return;
    const update = () => {
      const h = tb.getBoundingClientRect().height;
      root.style.setProperty("--toolbar-h", `${Math.round(h) + 8}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(tb);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  const customersById = useMemo(() => {
    const m = new Map<string, Customer>();
    for (const c of session.customers) m.set(c.acntEuId, c);
    return m;
  }, [session.customers]);

  const visibleRows = useMemo(() => {
    let r = rows;
    if (filter === "codec") r = r.filter((x) => x.group === "__codec_fallback__");
    else if (filter !== "all")
      r = r.filter((x) => x.worstConfidence === filter && x.group !== "__codec_fallback__");

    const q = search.trim().toLowerCase();
    if (q) {
      r = r.filter((x) => {
        if (x.label.toLowerCase().includes(q)) return true;
        if (x.group.toLowerCase().includes(q)) return true;
        // match by txId substring
        if (q.startsWith("#") || /^\d+$/.test(q)) {
          const needle = q.replace(/^#/, "");
          return x.matches.some((m) => String(m.transactionId).includes(needle));
        }
        return false;
      });
    }
    return r;
  }, [rows, filter, search]);

  /**
   * Group visibleRows by their effective firm so the operator can see at a
   * glance which keyword clusters route to the same firm (e.g. multiple
   * keywords all pointing at Aktif Bank). Each group is rendered as its
   * own <section> — rows inside are still independently chargeable.
   *
   * Pure visual grouping: a per-row firm override still affects only that
   * row (same behavior as before). The grouping key is the row's
   * `firmGroupKey`, which already factors in overrides.
   */
  const firmGroupedRows = useMemo(() => {
    const groups = new Map<
      string,
      { firmName: string; firmKey: string; rows: KeywordRow[] }
    >();
    for (const row of visibleRows) {
      const firm = resolveFirm(row);
      const key = row.firmGroupKey || row.group;
      const label = firm.accountName ?? "Bilinmeyen firma";
      const existing = groups.get(key);
      if (existing) {
        existing.rows.push(row);
      } else {
        groups.set(key, { firmName: label, firmKey: key, rows: [row] });
      }
    }
    return [...groups.values()];
    // resolveFirm reads session.firmOverrides; include it + customers in deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRows, session.firmOverrides, session.customers]);

  // Flatten all selected txIds (across rows) for the copy / charge action bar.
  const allSelectedIds = useMemo(
    () => flattenSelection(rows, selected),
    [rows, selected],
  );

  // Group selected ids by row so we can charge them as ONE POST per row
  // (the row's firm is fixed). Pure helper — `groupSelectionByRow` only
  // returns ids that intersect with the row's actual matches, so stale
  // selection state can never leak through.
  const selectedByRow = useMemo(
    () => groupSelectionByRow(rows, selected),
    [rows, selected],
  );

  const toggleExpanded = (id: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleTxSelected = (rowGroup: string, txId: number) => {
    setSelected((cur) => {
      const next = new Map(cur);
      const inner = new Set(next.get(rowGroup) ?? []);
      if (inner.has(txId)) inner.delete(txId);
      else inner.add(txId);
      if (inner.size === 0) next.delete(rowGroup);
      else next.set(rowGroup, inner);
      return next;
    });
  };

  const toggleRowAll = (row: KeywordRow) => {
    setSelected((cur) => {
      const next = new Map(cur);
      const curSet = next.get(row.group);
      const allIds = new Set(row.matches.map((m) => m.transactionId));
      // If everything is already selected, deselect all.
      const fullySelected = curSet && [...allIds].every((id) => curSet.has(id));
      if (fullySelected) next.delete(row.group);
      else next.set(row.group, allIds);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Map());

  const setRowFirm = async (row: KeywordRow, accountEuId: string) => {
    const customer = customersById.get(accountEuId);
    const accountName = customer?.name ?? row.suggestedAccountName ?? null;
    const next = {
      ...session,
      firmOverrides: {
        ...session.firmOverrides,
        [row.group]: { accountEuId, accountName },
      },
    };
    setSession(next);
    await saveSession(next);
  };

  const resolveFirm = (row: KeywordRow) => {
    const override = session.firmOverrides[row.group];
    if (override) return override;
    return {
      accountEuId: row.suggestedAccountEuId ?? "00000000-0000-0000-0000-000000000000",
      accountName: row.suggestedAccountName ?? "Codec",
    };
  };

  /**
   * Charge the given transactionIds to `firm` with ONE POST.
   *
   * The backend's `/Charged` endpoint accepts an array of ids in a single
   * call, so we don't loop over them in the extension. This is the only
   * way the UI ever talks to the charge endpoint; the loop here exists
   * only to update the UI map and persist the audit record.
   *
   * Whatever the backend says (success or error) is logged to the audit
   * log. On success the ids are appended to `session.chargedIds` and
   * cleared from the current selection so the action bar doesn't offer
   * them again.
   */
  const chargeIdsSingleCall = async (
    row: KeywordRow,
    ids: number[],
    firm: { accountEuId: string; accountName: string | null },
  ): Promise<{ succeeded: number; failed: number; lastError: string | null }> => {
    if (ids.length === 0) return { succeeded: 0, failed: 0, lastError: null };

    // Per-row UX: show every id as "running" → ok/fail atomically.
    const initial = new Map<string, ItemProgress>();
    for (const id of ids) initial.set(`${row.group}:${id}`, { id, state: "running" });
    setChargeProgress(initial);

    let succeeded = 0;
    let failed = 0;
    let lastError: string | null = null;

    try {
      const result = await chargeOnce(
        settings.sessionId,
        firm.accountEuId,
        firm.accountName,
        ids,
        row.label,
      );
      if (result.ok) {
        succeeded = ids.length;
        const finalMap = new Map<string, ItemProgress>();
        for (const id of ids) finalMap.set(`${row.group}:${id}`, { id, state: "ok" });
        setChargeProgress(finalMap);
      } else {
        // Backend said "no" — count the whole batch as failed (we can't
        // tell which ids succeeded if the API rejected the array).
        failed = ids.length;
        lastError = result.record.resultDetails;
        const finalMap = new Map<string, ItemProgress>();
        for (const id of ids) {
          finalMap.set(`${row.group}:${id}`, {
            id,
            state: "fail",
            error: result.record.resultDetails,
          });
        }
        setChargeProgress(finalMap);
      }
    } catch (err) {
      failed = ids.length;
      lastError = err instanceof Error ? err.message : String(err);
      const finalMap = new Map<string, ItemProgress>();
      for (const id of ids) {
        finalMap.set(`${row.group}:${id}`, {
          id,
          state: "fail",
          error: lastError,
        });
      }
      setChargeProgress(finalMap);
    }

    if (succeeded > 0) {
      const next = {
        ...session,
        chargedIds: [...session.chargedIds, ...ids],
      };
      setSession(next);
      await saveSession(next);
      setSelected((cur) => {
        const inner = cur.get(row.group);
        if (!inner) return cur;
        const chargedSet = new Set(ids);
        const remaining = new Set([...inner].filter((id) => !chargedSet.has(id)));
        const nextMap = new Map(cur);
        if (remaining.size === 0) nextMap.delete(row.group);
        else nextMap.set(row.group, remaining);
        return nextMap;
      });
    }

    return { succeeded, failed, lastError };
  };

  const chargeRow = async (row: KeywordRow, ids?: number[]) => {
    const firm = resolveFirm(row);
    if (!firm.accountEuId) return;
    const targets = ids ?? row.matches.map((m) => m.transactionId);
    if (targets.length === 0) return;
    setBusyRow(row.group);
    setError(null);

    // --- Optimistic update ---------------------------------------------
    // Drop the txIds from the UI immediately so the operator sees the row
    // shrink / disappear without waiting for the network round-trip. If
    // the POST fails, we roll back to the previous session below.
    const optimistic: SessionState = {
      ...session,
      chargedIds: [...session.chargedIds, ...targets],
    };
    const prevSession = session;
    setSession(optimistic);

    try {
      const { succeeded, failed, lastError } = await chargeIdsSingleCall(row, targets, firm);
      if (failed === 0) {
        // Persist the optimistic update — the optimistic session already
        // has the ids appended, so saveSession will write the new set.
        await saveSession(optimistic);
        toast.push(
          `${row.label}: ${succeeded} kayıt tek istekte ${firm.accountName ?? "?"} firmasına gönderildi`,
          "success",
        );
      } else {
        // Rollback the optimistic append; keep `selected` as-is so the
        // operator can fix and retry without re-selecting the rows.
        setSession(prevSession);
        toast.push(
          `${row.label}: ${succeeded} başarılı, ${failed} hata — ${lastError ?? ""}`,
          "error",
        );
        setError(lastError);
      }
    } catch (err) {
      // Network / thrown error → rollback so the txIds remain in the row.
      setSession(prevSession);
      const msg = err instanceof Error ? err.message : String(err);
      toast.push(`${row.label}: charge başarısız — ${msg}`, "error");
      setError(msg);
    } finally {
      setBusyRow(null);
      setTimeout(() => setChargeProgress(null), 1500);
    }
  };

  const chargeAllSelected = async () => {
    if (selectedByRow.length === 0) return;
    // Each selected row is charged as ONE POST per row (the row's firm
    // is fixed). We process rows sequentially so audit log entries are
    // ordered and throttle settings still apply between rows.
    for (const { row, ids } of selectedByRow) {
      if (ids.length === 0) continue;
      await chargeRow(row, ids);
      if (settings.throttleMs > 0) {
        await new Promise((r) => setTimeout(r, settings.throttleMs));
      }
    }
  };

  const copySelected = async () => {
    if (allSelectedIds.length === 0) return;
    const ids = allSelectedIds.map((x) => x.txId);
    try {
      await navigator.clipboard.writeText(formatTxIds(ids, copyFormat));
      toast.push(
        `${ids.length} txId ${COPY_FORMAT_LABEL[copyFormat]} olarak kopyalandı`,
        "success",
      );
    } catch (err) {
      toast.push(
        `Kopyalama başarısız: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  };

  // Copy a single txId from the row's expanded list.
  const copySingle = async (txId: number) => {
    try {
      await navigator.clipboard.writeText(String(txId));
      toast.push(`#${txId} kopyalandı`, "info");
    } catch (err) {
      toast.push(
        `Kopyalama başarısız: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  };

  const totalItems = rows.reduce((sum, r) => sum + r.matches.length, 0);
  const chargedTotal = session.chargedIds.length;
  const remaining = totalItems - chargedTotal;

  return (
    <div className="section review-page">
      <h2>İncele & Ücretlendir</h2>
      <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
        AI'ın grupladığı öneriler. Her satırda firmayı değiştirebilir, tek tek
        veya toplu halde işaretleyebilirsin. <strong>Sarı butonlara basmadıkça
        hiçbir istek gitmez.</strong>
      </p>

      <div className="summary">
        <div>
          <div className="num">{rows.length.toLocaleString("tr-TR")}</div>
          <div className="lbl">satır</div>
        </div>
        <div>
          <div className="num">{remaining.toLocaleString("tr-TR")}</div>
          <div className="lbl">bekleyen kayıt</div>
        </div>
        <div>
          <div className="num" style={{ color: "var(--success)" }}>
            {chargedTotal.toLocaleString("tr-TR")}
          </div>
          <div className="lbl">gönderildi</div>
        </div>
        {allSelectedIds.length > 0 && (
          <div>
            <div className="num" style={{ color: "var(--accent)" }}>
              {allSelectedIds.length.toLocaleString("tr-TR")}
            </div>
            <div className="lbl">seçili</div>
          </div>
        )}
      </div>

      {error && (
        <div className="errors" style={{ marginTop: 0, marginBottom: 10 }}>
          <div className="err">
            <AlertTriangle size={11} style={{ verticalAlign: "middle" }} /> {error}
          </div>
        </div>
      )}

      <div className="review-toolbar">
        <div className="toolbar-row toolbar-filters">
          {(["all", "high", "medium", "low", "codec"] as RowFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={filter === f ? "primary" : ""}
            >
              {f === "all" ? "Tümü" :
               f === "high" ? "Yüksek" :
               f === "medium" ? "Orta" :
               f === "low" ? "Düşük" : "Codec"}
            </button>
          ))}
        </div>
        <div className="toolbar-row toolbar-search">
          <Search size={11} style={{ verticalAlign: "middle" }} />
          <input
            type="text"
            placeholder="Ara: keyword, #txId, …"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            spellCheck={false}
          />
          {search && (
            <button onClick={() => setSearch("")} className="ghost" title="Temizle">
              <X size={10} />
            </button>
          )}
        </div>
      </div>

      {visibleRows.length === 0 ? (
        <div className="empty">
          <ListChecks size={32} className="icon" />
          <div className="title">Bu filtreyle eşleşen satır yok</div>
          <div className="hint">
            Filtreyi değiştir veya Analiz sekmesinden yeni bir çalışma tetikle.
          </div>
        </div>
      ) : (
        <div className="review-table">
          <div className="review-table__head">
            <div className="col col-check">
              <span title="Tümünü seç" aria-hidden>
                {/* header checkbox placeholder */}
              </span>
            </div>
            <div className="col col-label">Keyword / Satır</div>
            <div className="col col-firm">Firma</div>
            <div className="col col-count">#</div>
            <div className="col col-conf">Güven</div>
            <div className="col col-actions">İşlem</div>
          </div>

          {firmGroupedRows.flatMap((group) => {
            // Each firm-group renders a header banner + its child rows
            // (rows inside stay independently chargeable; this is
            // visual grouping only — same as Plan §B.3).
            const header = (
              <div
                key={`firm-${group.firmKey}`}
                className="review-firm-section__head"
              >
                <span className="pill sm accent">{group.firmName}</span>
                <span className="muted" style={{ fontSize: 10.5 }}>
                  {group.rows.length} keyword grubu ·{" "}
                  {group.rows.reduce((s, r) => s + r.matches.length, 0)} tx
                </span>
              </div>
            );
            const rowEls = group.rows.map((row) => {
              const isExpanded = expanded.has(row.group);
              const isBusy = busyRow === row.group;
              const isCodec = row.group === "__codec_fallback__";
              const selectedIds = selected.get(row.group) ?? new Set<number>();
              const firm = resolveFirm(row);
              const overrideKey = session.firmOverrides[row.group];
              const fullySelected =
                selectedIds.size > 0 &&
                selectedIds.size === row.matches.length;
              const someSelected =
                selectedIds.size > 0 && selectedIds.size < row.matches.length;

              return (
                <div
                  key={row.group}
                  className={`review-row ${isCodec ? "codec" : row.worstConfidence}${overrideKey ? " overridden" : ""}${isExpanded ? " expanded" : ""}`}
                >
                  <div
                    className="review-row__head"
                    onClick={() => toggleExpanded(row.group)}
                  >
                    <div
                      className="col col-check"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleRowAll(row);
                      }}
                    >
                      {fullySelected ? (
                        <CheckSquare size={14} color="var(--accent)" />
                      ) : someSelected ? (
                        <CheckSquare size={14} color="var(--accent)" style={{ opacity: 0.5 }} />
                      ) : (
                        <Square size={14} color="var(--text-2)" />
                      )}
                    </div>
                    <div className="col col-label">
                      <div className="row-label">{row.label}</div>
                      <div className="row-meta">
                        <span className="pill sm">{row.dominantField}</span>
                        {overrideKey && <span className="pill sm warn">override</span>}
                        {selectedIds.size > 0 && (
                          <span className="pill sm accent">
                            {selectedIds.size} seçili
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="col col-firm" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={firm.accountEuId}
                        onChange={(e) => setRowFirm(row, e.target.value)}
                        title={firm.accountName ?? ""}
                      >
                        <option value="00000000-0000-0000-0000-000000000000">
                          Codec (fallback)
                        </option>
                        {session.customers.map((c) => (
                          <option key={c.acntEuId} value={c.acntEuId}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="col col-count">
                      {row.matches.length}
                    </div>
                    <div className="col col-conf">
                      <span className={`pill ${row.worstConfidence}`}>
                        {row.worstConfidence}
                      </span>
                    </div>
                    <div className="col-actions col-actions-extra">
                      <button
                        className="primary sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          chargeRow(row);
                        }}
                        disabled={isBusy || row.matches.length === 0}
                        title={`Tüm ${row.matches.length} txId'i tek istekle ${firm.accountName ?? "?"} firmasına gönder`}
                      >
                        {isBusy ? (
                          <Loader2 size={11} className="spin" />
                        ) : (
                          <Zap size={11} />
                        )}
                        Tümü ({row.matches.length})
                      </button>
                      <button
                        className="ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpanded(row.group);
                        }}
                        title={isExpanded ? "Listeyi gizle" : "txId listesini göster"}
                      >
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <TxIdList
                      row={row}
                      selectedIds={selectedIds}
                      itemsById={itemsById}
                      isBusy={isBusy}
                      chargeProgress={chargeProgress}
                      onToggle={(tx) => toggleTxSelected(row.group, tx)}
                      onCopy={(tx) => copySingle(tx)}
                      onChargeOne={(tx) => chargeRow(row, [tx])}
                      firmName={firm.accountName ?? "?"}
                    />
                  )}

                  {isBusy && chargeProgress && chargeProgress.size > 0 && (
                    <ChargeProgressStrip
                      row={row}
                      progress={Array.from(chargeProgress.values())}
                    />
                  )}
                </div>
              );
            });
            return [header, ...rowEls];
          })}
        </div>
      )}

      {/* Sticky action bar — appears whenever ≥1 txId is selected. */}
      {allSelectedIds.length > 0 && (
        <ActionBar
          count={allSelectedIds.length}
          rowCount={selectedByRow.length}
          format={copyFormat}
          onFormatChange={setCopyFormat}
          onCopy={copySelected}
          onCharge={chargeAllSelected}
          onClear={clearSelection}
        />
      )}

      <div className="muted" style={{ marginTop: 16, fontSize: 11 }}>
        🛡️ <strong>Güvenlik:</strong> AI hiçbir zaman otomatik POST atmaz.
        Seçili txId'leri ücretlendir butonu <em>sen tıklayana kadar</em>{" "}
        hiçbir şey göndermez. Gönderilen her istek Geçmiş sekmesinde audit
        log'a yazılır.
      </div>
    </div>
  );
}

// --- Sub-components --------------------------------------------------------

function TxIdList({
  row,
  selectedIds,
  itemsById,
  isBusy,
  chargeProgress,
  onToggle,
  onCopy,
  onChargeOne,
  firmName,
}: {
  row: KeywordRow;
  selectedIds: Set<number>;
  itemsById: Map<number, UnmatchedItem>;
  isBusy: boolean;
  chargeProgress: Map<string, ItemProgress> | null;
  onToggle: (txId: number) => void;
  onCopy: (txId: number) => void;
  onChargeOne: (txId: number) => void;
  firmName: string;
}) {
  return (
    <div className="txid-list">
      {row.matches.slice(0, 200).map((m) => {
        const it = itemsById.get(m.transactionId);
        const isSelected = selectedIds.has(m.transactionId);
        const cp = chargeProgress?.get(`${row.group}:${m.transactionId}`);
        const cpState = cp?.state;
        return (
          <div
            key={m.transactionId}
            className={`txid-row${isSelected ? " selected" : ""}${cpState ? ` cp-${cpState}` : ""}`}
          >
            <button
              className="txid-row__check"
              onClick={() => onToggle(m.transactionId)}
              disabled={isBusy}
              title={isSelected ? "Seçimi kaldır" : "Seç"}
            >
              {isSelected ? (
                <CheckSquare size={11} color="var(--accent)" />
              ) : (
                <Square size={11} color="var(--text-2)" />
              )}
            </button>
            <span className="txid-row__id">#{m.transactionId}</span>
            <span className="txid-row__field">[{m.matchedField}]</span>
            <span className="txid-row__kw" title={m.matchedValue}>
              {m.matchedValue.slice(0, 40)}
            </span>
            {it && <span className="txid-row__phone">{it.phone}</span>}
            <button
              className="txid-row__copy ghost"
              onClick={() => onCopy(m.transactionId)}
              title="txId'i kopyala"
            >
              <Copy size={10} />
            </button>
            <button
              className="txid-row__charge"
              onClick={() => onChargeOne(m.transactionId)}
              disabled={isBusy}
              title={`Sadece bu txId'i ${firmName} firmasına gönder`}
              aria-label="Ücretlendir"
            >
              <Zap size={10} />
            </button>
            {cpState && (
              <span className={`txid-row__status cp-${cpState}`}>
                {cpState === "ok" ? "✓" : cpState === "fail" ? "✗" : "…"}
              </span>
            )}
          </div>
        );
      })}
      {row.matches.length > 200 && (
        <div className="muted txid-list__more">
          … ve {row.matches.length - 200} satır daha
        </div>
      )}
    </div>
  );
}

function ChargeProgressStrip({
  row,
  progress,
}: {
  row: KeywordRow;
  progress: ItemProgress[];
}) {
  const total = progress.length;
  // All ids enter "running" together, then flip atomically to ok/fail —
  // because the row's charge is exactly ONE POST. The bar is therefore a
  // simple indeterminate indicator: in-flight or done.
  const allDone = progress.every((p) => p.state === "ok" || p.state === "fail");
  const okCount = progress.filter((p) => p.state === "ok").length;
  const failCount = progress.filter((p) => p.state === "fail").length;
  return (
    <div className="charge-progress">
      <div className="charge-progress__head">
        {allDone ? (
          <span>
            {failCount === 0 ? "✓" : "⚠"} {row.label}: tek istekte {okCount}/{total} başarılı
          </span>
        ) : (
          <span>
            <Loader2 size={12} className="spin" /> {row.label}: tek istekle
            {" "}{total} txId gönderiliyor…
          </span>
        )}
        <span>
          {okCount}✓ / {failCount}✗ · {total}
        </span>
      </div>
      <div className="charge-progress__bar">
        <span style={{ width: `${allDone ? 100 : 60}%` }} />
      </div>
    </div>
  );
}

function ActionBar({
  count,
  rowCount,
  format,
  onFormatChange,
  onCopy,
  onCharge,
  onClear,
}: {
  count: number;
  rowCount: number;
  format: CopyFormat;
  onFormatChange: (f: CopyFormat) => void;
  onCopy: () => void;
  onCharge: () => void;
  onClear: () => void;
}) {
  return (
    <div className="action-bar">
      <div className="action-bar__count">
        <strong>{count}</strong> txId seçili ({rowCount} satır)
      </div>
      <div className="action-bar__group">
        <label>Format:</label>
        <select value={format} onChange={(e) => onFormatChange(e.target.value as CopyFormat)}>
          <option value="comma">{COPY_FORMAT_LABEL.comma}</option>
          <option value="newline">{COPY_FORMAT_LABEL.newline}</option>
          <option value="json">{COPY_FORMAT_LABEL.json}</option>
          <option value="sql">{COPY_FORMAT_LABEL.sql}</option>
        </select>
        <button onClick={onCopy} title="Seçili txId'leri panoya kopyala">
          <Copy size={11} /> Kopyala
        </button>
      </div>
      <div className="action-bar__group">
        <button className="primary" onClick={onCharge} title="Seçili txId'leri ilgili firmalara gönder">
          <Zap size={11} /> Ücretlendir
        </button>
        <button className="ghost" onClick={onClear} title="Seçimi temizle">
          <X size={11} /> Temizle
        </button>
      </div>
    </div>
  );
}