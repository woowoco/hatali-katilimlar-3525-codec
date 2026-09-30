import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  AlertTriangle,
  ListChecks,
  Square,
  CheckSquare,
  Loader2,
  Copy,
  X,
  Search,
  MessageSquare,
  Zap,
  ArrowRight,
  BookPlus,
} from "lucide-react";
import {
  buildKeywordRows,
  BULK_COPY_FORMATS,
  bulkCopyLabel,
  formatTxIdsForCopy,
  groupByFirm,
  resolveFirmForTx,
  type BulkCopyFormat,
  type KeywordRow,
} from "../../lib/ai.js";
import { chargeOnce } from "../../lib/charger.js";
import { saveSession, type Firm, type SessionState } from "../../lib/store.js";
import type { Customer, UnmatchedItem } from "../../types.js";
import { CODEC_ACCOUNT_EU_ID, CODEC_ACCOUNT_NAME } from "../../types.js";
import type { RouteCtx } from "../App.js";
import { FirmOverrideMini } from "./FirmOverrideMini.js";
import { AddRuleInlinePopover } from "./AddRuleInlinePopover.js";
import { useToast } from "./Toast.js";

type RowFilter = "all" | "high" | "medium" | "low" | "codec";

/**
 * Per-section pagination: how many txIds each `FirmSectionView` renders
 * before the operator has to explicitly expand. Why this exists:
 *
 * A 1500-item categorize run with clustering replicates to ~3300 matches.
 * When those happen to land in one or two heavy firms, mounting ALL the
 * `<tr>` + per-row `<select>` nodes in a single React commit freezes the
 * popup window for tens of seconds — the user sees the skeleton phase
 * forever, the page never reaches `phase === "ready"`, and the data that
 * IS on disk looks unreachable.
 *
 * Capping the initial render at `SECTION_PAGE_SIZE` items per section
 * keeps the first paint under ~2500 DOM nodes even for the worst-case
 * 50-firm split, well inside what Chromium can commit without jank.
 * Operators click "Tümünü göster" on the section(s) they need to act on.
 *
 * The selection set (`Set<number>`) is independent of visibility — the
 * section header still shows the correct "N tx seçili" count, and the
 * "Tümünü seç" / "Tümünü seçimi kaldır" checkbox covers any hidden items.
 */
const SECTION_PAGE_SIZE = 50;

// Inline style for the in-text "show more" / "show all" links next to
// the section header. Used instead of a `ghost`/`link` class because
// neither is currently defined in styles.css — the codebase uses bare
// `ghost sm` for unrelated button affordances, so we keep pagination
// affordances visually distinct (no border, accent underline).
const linkButtonStyle: React.CSSProperties = {
  padding: 0,
  margin: 0,
  background: "transparent",
  border: "none",
  color: "var(--accent)",
  textDecoration: "underline",
  cursor: "pointer",
  fontSize: "inherit",
  fontFamily: "inherit",
};

// Stable empty Set used in place of `chargedSet` when calling
// `buildKeywordRows`. We deliberately want buildKeywordRows to keep ALL
// matches (including just-charged ones) in the underlying rows, and
// filter charged items at the `visibleRows` layer instead. Why:
//
//   1. The heavy stage-1 effect that runs buildKeywordRows must stay
//      stable when `session.chargedIds` changes — otherwise a single
//      successful charge would re-run the deferred 2-RAF pipeline and
//      flash the skeleton.
//   2. buildKeywordRows already drops charged txIds entirely; if we
//      passed the real `chargedSet`, rows would shrink on every charge
//      and downstream caches would invalidate.
//   3. visibleRows already runs on every render, so adding a charged
//      filter there is free (it's a single Set.has lookup per row).
const EMPTY_CHARGED: ReadonlySet<number> = new Set<number>();

/**
 * İncele & Ücretlendir ekranı.
 *
 * MİMARİ (bkz. `docs/SAFETY-CONTRACT.md` ve plan §B–§D):
 * - AI keyword row'ları `KeywordRow` olarak gelir (`buildKeywordRows`).
 * - Her txId `resolveFirmForTx` ile GEÇERLİK ANINDAKİ firmasına çözülür.
 * - `groupByFirm` bunları firma-bazlı düz tablolara dizer; her section =
 *   tek firma, içinde tüm txId'leri (farklı keyword row'larından gelen).
 * - Selection DÜZ `Set<number>` — rowKey değil txId tutarız, böylece
 *   reassign sonrası bile txId kaybolmaz.
 * - `chargeFirm` section başına tetiklenir, charge anında HER txId'i
 *   yeniden çözer; Set<accountEuId>.size > 1 ise POST'a hiç geçmez
 *   (cross-firm bulaşma savunması — `chargeOnce`'daki UUID guard ile
 *   birlikte 2. katman).
 */
export function StepReview() {
  const ctx = useOutletContext<RouteCtx>();
  const { settings, session, setSession } = ctx;
  const toast = useToast();

  // Cross-firm bulaşma riski: global ActionBar'ı KALDIRDIK. Her section'ın
  // kendi footer'ında "Seçili (N) Ücretlendir" butonu var; UI yalnızca
  // section.accountEuId'ye yönlendirir.
  const [busyFirm, setBusyFirm] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<RowFilter>("all");

  // Düz seçim — Set<number>. reassign sonrası bile txId kaybolmaz,
  // sadece section'ı değişir (groupByFirm yeni section'a dizer).
  const [selected, setSelected] = useState<Set<number>>(new Set());

  // Filtre toolbar'ı
  const [search, setSearch] = useState("");

  // Tablo hücrelerinde msgContent kolonu göster/gizle (popup-scoped).
  const [showMsgContent, setShowMsgContent] = useState(true);

  // Bulk reassign için hedef firma seçimi. "" = henüz seçilmedi. Apply
  // butonu bu değer boşken disabled. Selection temizlenince reset edilir.
  const [bulkFirmChoice, setBulkFirmChoice] = useState<string>("");

  const itemsById = useMemo(() => {
    const m = new Map<number, UnmatchedItem>();
    for (const it of session.items) m.set(it.transactionId, it);
    return m;
  }, [session.items]);

  const chargedSet = useMemo(
    () => new Set(session.chargedIds),
    [session.chargedIds],
  );

  const ignoredSet = useMemo(
    () => new Set(session.ignoredIds ?? []),
    [session.ignoredIds],
  );

  /**
   * Render pipeline.
   *
   * Why this is two-stage (not a single `useMemo`):
   * -----------------------------------------------
   * A 700-item run needs ~50ms of `buildKeywordRows` + ~50ms of
   * `groupByFirm` + ~300–600ms of DOM mount (per-row `<select>` ×
   * customer `<option>`). Doing all of that in one render freezes the
   * popup for the whole block. Splitting it across one paint keeps the
   * skeleton visible during the heavy compute, and lets React commit
   * the DOM-mount step after the user has visual confirmation that
   * something is happening.
   *
   * Each effect owns its OWN cancel handle. Earlier we tried sharing a
   * `cancelRafRef` across three effects, but Effect B's RAF-for-
   * groupByFirm would cancel Effect C's reveal-tick RAFs (or vice
   * versa), which manifested as "data doesn't load on entry" / "flash
   * on every checkbox click". Local cancellation per effect is simpler
   * and removes that race.
   *
   * Stage 1 (heavy):  defer `buildKeywordRows` over 2 RAFs so the
   *                  skeleton has a frame to paint first.
   * Stage 2 (light): `groupByFirm` runs as a `useMemo` — ~50ms is
   *                  fast enough to be synchronous and avoids the
   *                  stage race entirely.
   *
   * No progressive reveal: we render all sections at once when ready.
   * The remaining freeze is the DOM mount cost. Reducing that would
   * need virtualization, which is out of scope.
   *
   * Threshold: ≤30 matches runs synchronously (one frame, no flash).
   */
  type RenderPhase = "skeleton" | "ready";
  const matches = session.matches ?? [];
  const matchesLen = matches.length;
  const isHeavy = matchesLen > 30;

  const [phase, setPhase] = useState<RenderPhase>(
    matchesLen === 0 || !isHeavy ? "ready" : "skeleton",
  );
  const [rows, setRows] = useState<KeywordRow[]>([]);

  // --- Stage 1: buildKeywordRows, deferred -----------------------------
  // Owns its own cancel handle — no sharing with stage 2. Cleanups
  // cancel the in-flight RAF chain for this effect only.
  //
  // CRITICAL: `chargedSet` is INTENTIONALLY not a dep. Charging txIds
  // updates `session.chargedIds` → new Set ref → if we listed it here
  // the effect would re-run, the skeleton would flash, and the table
  // would re-mount on every successful charge. We filter charged txIds
  // at the `visibleRows` layer instead (see below), so this stage stays
  // stable across charges.
  useEffect(() => {
    let cancelled = false;
    let innerRafId = 0;
    let outerRafId = 0;

    if (matchesLen === 0) {
      setRows([]);
      setPhase("ready");
      return () => {
        cancelled = true;
        cancelAnimationFrame(innerRafId);
        cancelAnimationFrame(outerRafId);
      };
    }

    // Pass a STABLE EMPTY set to buildKeywordRows — charged filtering
    // happens downstream at visibleRows level. See comment above.
    const emptyCharged: ReadonlySet<number> = EMPTY_CHARGED;

    // Light path: synchronous. No skeleton flash, no RAF cost.
    if (!isHeavy) {
      const r = buildKeywordRows(matches, emptyCharged, {
        firmOverrides: session.firmOverrides,
        ignoredIds: ignoredSet,
      });
      if (cancelled) return () => {
        cancelled = true;
        cancelAnimationFrame(innerRafId);
        cancelAnimationFrame(outerRafId);
      };
      setRows(r);
      setPhase("ready");
      return () => {
        cancelled = true;
        cancelAnimationFrame(innerRafId);
        cancelAnimationFrame(outerRafId);
      };
    }

    // Heavy path: skeleton → ready across 2 RAFs.
    setRows([]);
    setPhase("skeleton");

    outerRafId = requestAnimationFrame(() => {
      if (cancelled) return;
      innerRafId = requestAnimationFrame(() => {
        if (cancelled) return;
        const r = buildKeywordRows(matches, emptyCharged, {
          firmOverrides: session.firmOverrides,
          ignoredIds: ignoredSet,
        });
        if (cancelled) return;
        setRows(r);
        setPhase("ready");
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(outerRafId);
      cancelAnimationFrame(innerRafId);
    };
  }, [matches, session.firmOverrides, ignoredSet, matchesLen, isHeavy]);

  const customersById = useMemo(() => {
    const m = new Map<string, Customer>();
    for (const c of session.customers) m.set(c.acntEuId, c);
    return m;
  }, [session.customers]);

  /**
   * visibleRows is a pure derivation from `rows` + filter + search +
   * chargedSet. It runs synchronously and is cheap (≤O(N) filter pass
   * on already-grouped KeywordRow objects), so it stays a `useMemo`.
   *
   * Charged-txId filtering happens HERE, not in `buildKeywordRows`.
   * Reasoning: charging updates `session.chargedIds` every time, which
   * would re-trigger the heavy stage-1 effect if it were a dep. Keeping
   * the filter at this layer means the table re-derives "without these
   * N rows" instantly on each charge, with no skeleton flash.
   */
  const visibleRows = useMemo(() => {
    if (phase === "skeleton") return [];
    let r = rows;

    // Drop fully-charged rows: if every ItemMatch in a KeywordRow has
    // already been charged, the whole row is empty — no point showing
    // it. We keep partially-charged rows and let the per-row renderer
    // skip the already-charged cells.
    if (chargedSet.size > 0) {
      r = r
        .map((row) => {
          const remaining = row.matches.filter(
            (m) => !chargedSet.has(m.transactionId),
          );
          return remaining.length === row.matches.length
            ? row
            : { ...row, matches: remaining };
        })
        .filter((row) => row.matches.length > 0);
    }

    if (filter === "codec") {
      r = r.filter((x) => x.group === "__codec_fallback__");
    } else if (filter !== "all") {
      r = r.filter(
        (x) => x.worstConfidence === filter && x.group !== "__codec_fallback__",
      );
    }

    const q = search.trim().toLowerCase();
    if (q) {
      r = r.filter((x) => {
        if (x.label.toLowerCase().includes(q)) return true;
        if (x.group.toLowerCase().includes(q)) return true;
        if (q.startsWith("#") || /^\d+$/.test(q)) {
          const needle = q.replace(/^#/, "");
          return x.matches.some((m) => String(m.transactionId).includes(needle));
        }
        return false;
      });
    }
    return r;
  }, [rows, filter, search, phase, chargedSet]);

  // --- Stage 2: groupByFirm as a useMemo ----------------------------------
  // Synchronous. ~50ms for 700 rows is fast enough to take as a single
  // hit, and it eliminates the Effect-B-vs-Effect-C race we hit when
  // groupByFirm itself was deferred. Selection/filter/reassign all
  // funnel through here and produce a stable result for the renderer.
  const firmSections = useMemo(() => {
    if (phase !== "ready") return [];
    return groupByFirm(
      visibleRows,
      session.firmOverrides,
      session.txFirmOverrides,
      selected,
    );
  }, [visibleRows, session.firmOverrides, session.txFirmOverrides, selected, phase]);

  // --- Seçim yardımcıları -------------------------------------------------

  /**
   * Shift+click range selection için son plain-click txId'sini tutar.
   * Anchor shift+click'lerde SABİT kalır — operatör zincirleme range
   * seçebilir (A → shift+B → shift+C). Sadece plain click (modifier'sız)
   * anchor'ı hareket ettirir.
   */
  const [anchor, setAnchor] = useState<number | null>(null);

  /**
   * Range selection için global sıra haritası: ekranda görünen tüm
   * txId'ler section sırasına göre düzleştirilmiş bir listede. Section
   * sınırlarını aşan range'ler (A bir section'ta, B başka section'ta)
   * doğru çalışsın diye bu map gerekli.
   *
   * firmSections değiştikçe yeniden hesaplanır (yeni filtre / bulk
   * reassign sonrası). Charged/reassign edilmiş txId'ler bu listeye
   * girmez — sadece ekranda görünen txId'ler.
   */
  const txIdIndex = useMemo(() => {
    const toIndex = new Map<number, number>();
    const toTxId = new Map<number, number>();
    let i = 0;
    for (const section of firmSections) {
      for (const item of section.items) {
        toIndex.set(item.transactionId, i);
        toTxId.set(i, item.transactionId);
        i++;
      }
    }
    return { toIndex, toTxId, size: i };
  }, [firmSections]);

  /**
   * Tek txId toggle + range selection. Event modifier'ları:
   *
   *   plain click      → tek toggle, anchor = txId
   *   shift+click      → [anchor, txId] aralığındaki TÜM txId'leri SEÇ
   *                      (anchor değişmez; zincirleme range için)
   *   ctrl+shift+click → [anchor, txId] aralığındaki TÜM txId'leri
   *                      SEÇİMDEN ÇIKAR (seçili bloğu temizle)
   *
   * Hard rule: sadece onClick'ten çağrılır — scheduler / useEffect yok.
   */
  const toggleTx = (
    txId: number,
    event?: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => {
    const shift = event?.shiftKey ?? false;
    const ctrl = event?.ctrlKey || event?.metaKey || false;

    // Plain click: toggle + anchor güncelle.
    if (!shift) {
      setSelected((cur) => {
        const next = new Set(cur);
        if (next.has(txId)) next.delete(txId);
        else next.add(txId);
        return next;
      });
      setAnchor(txId);
      return;
    }

    // Shift var → range modu. Anchor yoksa hedefin kendisini anchor
    // olarak kullan (range = tek txId).
    const anchorId = anchor ?? txId;
    const aIdx = txIdIndex.toIndex.get(anchorId);
    const bIdx = txIdIndex.toIndex.get(txId);
    if (aIdx == null || bIdx == null) {
      // Anchor ekranda yok (charged/reassign edilmiş). Plain toggle'a
      // düş ki operatör kilitlenmesin.
      setSelected((cur) => {
        const next = new Set(cur);
        if (next.has(txId)) next.delete(txId);
        else next.add(txId);
        return next;
      });
      setAnchor(txId);
      return;
    }
    const [lo, hi] = aIdx <= bIdx ? [aIdx, bIdx] : [bIdx, aIdx];

    setSelected((cur) => {
      const next = new Set(cur);
      for (let i = lo; i <= hi; i++) {
        const id = txIdIndex.toTxId.get(i);
        if (id == null) continue;
        if (ctrl) next.delete(id);   // ctrl+shift → range UNSELECT
        else next.add(id);            // shift       → range SELECT
      }
      return next;
    });
    // Anchor shift'te değişmez — zincirleme range için sabit kalsın.
  };

  const toggleSectionAll = (rowGroupIds: number[]) => {
    setSelected((cur) => {
      const next = new Set(cur);
      const allSelected = rowGroupIds.every((id) => next.has(id));
      if (allSelected) {
        for (const id of rowGroupIds) next.delete(id);
      } else {
        for (const id of rowGroupIds) next.add(id);
      }
      return next;
    });
  };

  const clearSelection = () => {
    setSelected(new Set());
    // Anchor da sıfırlansın — sonraki shift+click eski anchor'dan yanlış
    // range seçmesin.
    setAnchor(null);
    // Reset the bulk-reassign target so the picker doesn't carry over a
    // stale firm into the next selection.
    setBulkFirmChoice("");
  };

  // --- Reassign + charge ----------------------------------------------------

  /**
   * Per-tx reassign. Yeni session.txFirmOverrides kaydı yaratır/siler.
   * "Codec" seçilirse reassign KALDIRILIR (varsayılan Codec fallback'e
   * düşsün). Section'ın kendisi de reassign sonrası otomatik olarak
   * `groupByFirm`'in bir sonraki render'ında yeni section'a taşınır.
   */
  const setTxFirm = async (txId: number, accountEuId: string) => {
    const customer = customersById.get(accountEuId);
    // Codec fallback is a fixed HAR-derived UUID — there's no customer
    // record for it. The override must SET CODEC_ACCOUNT_EU_ID, not
    // delete the entry (deleting would fall back to the AI's original
    // suggestion, defeating the reassign).
    const accountName =
      accountEuId === CODEC_ACCOUNT_EU_ID
        ? CODEC_ACCOUNT_NAME
        : (customer?.name ?? null);
    const nextOverrides = { ...session.txFirmOverrides };
    nextOverrides[txId] = { accountEuId, accountName };
    const next: SessionState = { ...session, txFirmOverrides: nextOverrides };
    // Reassign tamamlandığında txId farklı section'a taşınır; selection
    // artık eski section'a ait olduğu için operatör için anlamsız.
    // Hemen temizle ki toolbar sayaç güncellensin ve eski section'da
    // "seçili" rozeti kalmasın.
    setSelected((cur) => {
      if (!cur.has(txId)) return cur;
      const next = new Set(cur);
      next.delete(txId);
      return next;
    });
    setSession(next);
    try {
      await saveSession(next);
    } catch (err) {
      // Persist başarısızsa UI'ı geri al; operatör reassign uygulandı sanıp
      // charge ederse yanlış firmaya gidebilir.
      setSession(session);
      toast.push(
        `txId reassign kaydedilemedi: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  };

  /**
   * Toplu reassign: seçili tüm txId'leri tek firmaya yönlendir.
   * Per-tx `setTxFirm` mantığının batched versiyonu — tek `setSession` +
   * tek `saveSession` çağrısı, N kez yerine. Selection korunur (charge
   * için), kullanıcı isterse "Temizle" ile sıfırlar.
   *
   * Hard rule: bu fonksiyon YALNIZCA toolbar'daki "Uygula" butonunun
   * onClick'inden çağrılır. `chargeOnce` çağırmaz, sadece
   * `txFirmOverrides` map'ini günceller — yani seçili txId'lerin
   * POST'a gönderilmesi için ayrıca bir section "Ücretlendir" tıklaması
   * gerekir (mevcut güvenlik akışı bozulmaz).
   *
   * Edge cases:
   * - Hedef firma seçilmemişse no-op (buton zaten disabled ama defense).
   * - Selection boşsa no-op.
   * - Hedef zaten tüm seçili txId'lerin firmasıysa no-op (gereksiz
   *   storage write'tan kaçınır).
   */
  const applyBulkReassign = async () => {
    if (!bulkFirmChoice || selected.size === 0) return;
    const customer = customersById.get(bulkFirmChoice);
    const accountName =
      bulkFirmChoice === CODEC_ACCOUNT_EU_ID
        ? CODEC_ACCOUNT_NAME
        : (customer?.name ?? null);

    // Hızlı no-op kontrolü: seçili txId'lerin hepsi zaten hedef
    // firmadaysa gereksiz yere session/storage yazma.
    const allAlreadyTarget = Array.from(selected).every((txId) => {
      const cur = session.txFirmOverrides[txId];
      if (cur) return cur.accountEuId === bulkFirmChoice;
      // txFirmOverride yoksa resolveFirmForTx çağrısı yapmadan
      // basitleştirme: "any" — burada edge case ama büyük runlarda
      // pratik olarak sık karşılaşılmaz (operator zaten seçip tıklıyor).
      return false;
    });
    if (allAlreadyTarget) {
      toast.push(
        `Seçili ${selected.size} txId zaten "${accountName ?? "?"}" firmasında — değişiklik yok`,
        "info",
      );
      setBulkFirmChoice("");
      return;
    }

    // Snapshot selected count for the toast (clearSelection wipes the
    // Set, so we need the count BEFORE we touch state).
    const count = selected.size;

    // Tek immutable güncelleme: önceki txFirmOverrides kopyala, seçili
    // txId'lerin üstüne yeni {accountEuId, accountName} yaz.
    const nextOverrides = { ...session.txFirmOverrides };
    for (const txId of selected) {
      nextOverrides[txId] = { accountEuId: bulkFirmChoice, accountName };
    }
    const next: SessionState = { ...session, txFirmOverrides: nextOverrides };
    // Persist başarısız olursa selection'ı geri alabilmek için snapshot.
    const prevSelected = selected;
    // Reassign tamamlandığında txId'ler yeni section'a taşınır; eski
    // section'daki selection anlamsız kalır. Hemen temizle ki:
    //  - toolbar sayaç düşsün
    //  - eski section'larda "seçili" rozeti kalmasın
    //  - operatör yanlışlıkla eski selection üzerinden charge etmesin
    setSelected(new Set());
    setAnchor(null);
    setSession(next);
    // Toolbar'ı da kapat ki operatör ikinci kez reassign tetiklemesin.
    setBulkFirmChoice("");

    try {
      await saveSession(next);
      toast.push(
        `${count} txId "${accountName ?? "?"}" firmasına yönlendirildi`,
        "success",
      );
    } catch (err) {
      // Persist başarısızsa UI'ı TAMAMEN geri al — selection dahil.
      // Yoksa operatör reassign uygulandı sanıp eski selection üzerinden
      // charge ederse yanlış firmaya gidebilir.
      setSession(session);
      setSelected(prevSelected);
      toast.push(
        `Toplu reassign kaydedilemedi: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  };

  /**
   * Section'ın footer'ındaki "Ücretlendir" butonu. Cross-firm bulaşma
   * savunmasının 2. katmanı burada:
   *
   *   1. POST'a gönderilecek HER txId'i `resolveFirmForTx` ile yeniden
   *      çöz. Section başlığındaki accountEuId'ye GÜVENME — render arasında
   *      yapılmış reassign'ı kaçırırsın.
   *   2. Çözünlenen firmaların `Set<accountEuId>.size > 1` ise POST'a
   *      HİÇ GEÇME; toast ile operator'ı uyar.
   *   3. Çözünlenen firmaların hepsi aynıysa, tek firmaya charge et.
   *   4. TxId hâlâ section'daysa ama artık section.accountEuId'ye
   *      çözünmüyorsa (reassign olmuş), sessizce DROPPED listesine ekle.
   *      Plan'daki "geçersiz txId'i otomatik dropped" davranışı.
   *
   * `chargeOnce`'daki `validateAccountEuId` (null/"null"/<32 char guard)
   * 3. katman — handler burada onu zaten geçerli bir UUID ile çağırır,
   * ama defense-in-depth olarak orada da kontrol var.
   */
  const chargeFirm = async (
    section: { firmKey: string; accountEuId: string; accountName: string | null; items: { transactionId: number; row: KeywordRow }[] },
    requestedIds: number[],
  ): Promise<void> => {
    if (requestedIds.length === 0) return;

    // (1) HER txId'i yeniden çöz.
    type Resolved = { txId: number; firm: Firm };
    const resolved: Resolved[] = [];
    const dropped: number[] = [];
    for (const id of requestedIds) {
      const item = section.items.find((it) => it.transactionId === id);
      if (!item) {
        // Section artık bu txId'i içermiyor — render arası reassign.
        dropped.push(id);
        continue;
      }
      const firm = resolveFirmForTx(
        id,
        item.row,
        session.firmOverrides,
        session.txFirmOverrides,
      );
      if (firm.accountEuId !== section.accountEuId) {
        // Bu txId artık başka bir firmaya ait (örn. reassign edildi).
        dropped.push(id);
        continue;
      }
      resolved.push({ txId: id, firm });
    }

    if (resolved.length === 0) {
      toast.push(
        `${section.accountName ?? "?"}: seçili txId'lerin hepsi reassign edildi, charge iptal`,
        "error",
      );
      return;
    }

    // (2) Çözünlenen firmaların hepsi AYNI olmalı. resolveFirmForTx zaten
    // her txId için section.accountEuId döndürüyor (filter yukarıda), ama
    // burada bir kez daha doğrulayalım — Pure helper invariant'ı.
    const firmIds = new Set(resolved.map((r) => r.firm.accountEuId));
    if (firmIds.size > 1) {
      // Asla olmamalı (filter step garanti ediyor), ama defense-in-depth.
      toast.push(
        `${section.accountName ?? "?"}: ${firmIds.size} farklı firma tespit edildi — POST iptal (cross-firm bulaşma guard)`,
        "error",
      );
      return;
    }

    const ids = resolved.map((r) => r.txId);
    const firm = resolved[0].firm;

    // (3) Optimistic update: chargedIds'e ekle, UI anında güncellensin.
    const optimistic: SessionState = {
      ...session,
      chargedIds: [...session.chargedIds, ...ids],
    };
    const prevSession = session;
    const prevSelected = selected;
    // IDs to clear from selection: the ones we just charged, plus any
    // we silently dropped because they were reassigned mid-flight.
    // Clear them NOW so the toolbar's "X tx seçili" counter drops the
    // moment the user clicks Ücretlendir — don't wait for the network.
    const idsToClear = [...ids, ...dropped];
    setSelected((cur) => {
      const next = new Set(cur);
      for (const id of idsToClear) next.delete(id);
      return next;
    });
    setSession(optimistic);
    setBusyFirm(section.firmKey);
    setError(null);

    try {
      const result = await chargeOnce(
        settings.sessionId,
        firm.accountEuId,
        firm.accountName,
        ids,
        section.firmKey,
        settings.demoMode,
      );
      if (result.ok) {
        await saveSession(optimistic);
        const dropMsg =
          dropped.length > 0
            ? ` (${dropped.length} txId reassign edildiği için dropped)`
            : "";
        toast.push(
          `${firm.accountName ?? "?"}: ${ids.length} txId tek istekte gönderildi${dropMsg}`,
          "success",
        );
      } else {
        // Server-side reject: rollback both session AND selection so the
        // operator can retry. The just-charged ids need to come back
        // into the selection set — they were never actually charged.
        setSession(prevSession);
        setSelected(prevSelected);
        toast.push(
          `${firm.accountName ?? "?"}: ${result.record.resultDetails ?? "hata"}`,
          "error",
        );
        setError(result.record.resultDetails ?? null);
      }
    } catch (err) {
      // Network / client-side error: same rollback as above.
      setSession(prevSession);
      setSelected(prevSelected);
      const msg = err instanceof Error ? err.message : String(err);
      toast.push(`${firm.accountName ?? "?"}: charge başarısız — ${msg}`, "error");
      setError(msg);
    } finally {
      setBusyFirm(null);
    }
  };

  /**
   * Tek txId'i tablodan kaldır (charge etmeden). `session.ignoredIds`'e
   * eklenir, `buildKeywordRows` filtreler.
   */
  const removeTxId = async (txId: number) => {
    const currentIgnored = session.ignoredIds ?? [];
    if (currentIgnored.includes(txId)) return;
    const next = { ...session, ignoredIds: [...currentIgnored, txId] };
    setSession(next);
    try {
      await saveSession(next);
    } catch (err) {
      setSession(session);
      toast.push(
        `txId kaldırılamadı: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  };

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

  /**
   * Seçili txId'leri istenen formatta clipboard'a kopyala. Caller her
   * section'ın kendi footer'ındaki buton grubundan tetikler; formatTxIdsForCopy
   * pure helper, UI sadece sonucu panoya yazar.
   *
   * Hard rule: bu fonksiyon YALNIZCA button.onClick'ten çağrılır
   * (useEffect / scheduler YOK). Şu an mock ortamda bile olsa production'da
   * clipboard API'si ancak user-gesture içinde çalışır.
   */
  const copySelection = async (
    ids: number[],
    format: BulkCopyFormat,
    sectionLabel: string,
  ) => {
    if (ids.length === 0) {
      toast.push("Kopyalanacak seçili txId yok", "error");
      return;
    }
    const text = formatTxIdsForCopy(ids, format);
    if (text === null) {
      toast.push("Kopyalanacak seçili txId yok", "error");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.push(
        `${sectionLabel}: ${ids.length} txId ${bulkCopyLabel(format)} formatında kopyalandı`,
        "success",
      );
    } catch (err) {
      toast.push(
        `Kopyalama başarısız: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  };

  // --- Özet sayaçları ------------------------------------------------------

  const totalItems = rows.reduce((sum, r) => sum + r.matches.length, 0);
  const chargedTotal = session.chargedIds.length;
  const selectedTotal = selected.size;

  return (
    <div className="section review-page">
      <h2>İncele & Ücretlendir</h2>
      <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
        AI'ın önerileri firma düzeyinde gruplanır — her firmanın tüm txId'leri
        tek tabloda görünür. Satır başındaki dropdown ile bir txId'i başka bir
        firmaya yönlendirebilirsin. <strong>Sarı butonlara basmadıkça hiçbir
        istek gitmez.</strong>
      </p>

      <div className="summary">
        <div>
          <div className="num">{firmSections.length.toLocaleString("tr-TR")}</div>
          <div className="lbl">firma</div>
        </div>
        <div>
          <div className="num">{totalItems.toLocaleString("tr-TR")}</div>
          <div className="lbl">bekleyen kayıt</div>
        </div>
        <div>
          <div className="num" style={{ color: "var(--success)" }}>
            {chargedTotal.toLocaleString("tr-TR")}
          </div>
          <div className="lbl">gönderildi</div>
        </div>
        {selectedTotal > 0 && (
          <div>
            <div className="num" style={{ color: "var(--accent)" }}>
              {selectedTotal.toLocaleString("tr-TR")}
            </div>
            <div className="lbl">seçili</div>
            <button
              className="ghost sm"
              onClick={clearSelection}
              title="Seçimi temizle"
              style={{ marginTop: 2 }}
            >
              <X size={10} /> temizle
            </button>
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
              {f === "all"
                ? "Tümü"
                : f === "high"
                  ? "Yüksek"
                  : f === "medium"
                    ? "Orta"
                    : f === "low"
                      ? "Düşük"
                      : "Codec"}
            </button>
          ))}
          <button
            onClick={() => setShowMsgContent((v) => !v)}
            className={showMsgContent ? "primary" : ""}
            title={
              showMsgContent ? "msgContent sütununu gizle" : "msgContent sütununu göster"
            }
          >
            <MessageSquare size={11} />
            Msg içeriği
          </button>
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
        {selectedTotal > 0 && (
          <div
            className="toolbar-row toolbar-bulk"
            role="region"
            aria-label="Toplu firm yönlendirme"
          >
            <span className="toolbar-bulk__count">
              <CheckSquare size={11} color="var(--accent)" />
              <strong>{selectedTotal}</strong> tx seçili
            </span>
            <select
              className="toolbar-bulk__firm"
              value={bulkFirmChoice}
              onChange={(e) => setBulkFirmChoice(e.target.value)}
              title="Seçili txId'leri yönlendirmek istediğin firma"
              aria-label="Hedef firma"
            >
              <option value="">Hedef firma seç…</option>
              <option value={CODEC_ACCOUNT_EU_ID}>Codec (fallback)</option>
              {session.customers.map((c) => (
                <option key={c.acntEuId} value={c.acntEuId}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              className="primary sm"
              disabled={!bulkFirmChoice}
              onClick={applyBulkReassign}
              title={`Seçili ${selectedTotal} txId'i seçili firmaya yönlendir (charge etmez)`}
            >
              <ArrowRight size={11} />
              Yönlendir
            </button>
            <button
              className="ghost sm"
              onClick={() => {
                clearSelection();
                setBulkFirmChoice("");
              }}
              title="Seçimi temizle"
            >
              <X size={10} />
              Temizle
            </button>
          </div>
        )}
      </div>

      {phase === "skeleton" ? (
        <ReviewSkeleton matchesHint={matchesLen} />
      ) : firmSections.length === 0 ? (
        <div className="empty">
          <ListChecks size={32} className="icon" />
          <div className="title">Bu filtreyle eşleşen firma yok</div>
          <div className="hint">
            Filtreyi değiştir veya Analiz sekmesinden yeni bir çalışma tetikle.
          </div>
        </div>
      ) : (
        <div className="review-table">
          {firmSections.map((section) => (
            <FirmSectionView
              key={section.firmKey}
              section={section}
              customers={session.customers}
              itemsById={itemsById}
              selected={selected}
              busy={busyFirm === section.firmKey}
              showMsgContent={showMsgContent}
              onToggle={toggleTx}
              onToggleSectionAll={toggleSectionAll}
              onCharge={(ids) => chargeFirm(section, ids)}
              onSetTxFirm={setTxFirm}
              onCopy={copySingle}
              onBulkCopy={(ids, fmt) =>
                copySelection(ids, fmt, section.accountName ?? "?")
              }
              onRemove={removeTxId}
            />
          ))}
        </div>
      )}

      <div className="muted" style={{ marginTop: 16, fontSize: 11 }}>
        🛡️ <strong>Güvenlik:</strong> AI hiçbir zaman otomatik POST atmaz.
        Ücretlendir butonu <em>sen tıklayana kadar</em> hiçbir şey göndermez.
        Charge anında her txId yeniden çözümlenir — reassign edilmiş txId'ler
        "dropped" sayılır, asla yanlış firmaya gönderilmez. Gönderilen her
        istek Geçmiş sekmesinde audit log'a yazılır.
      </div>
    </div>
  );
}

// --- Sub-components --------------------------------------------------------

interface FirmSectionViewProps {
  section: import("../../lib/ai.js").FirmSection;
  customers: Customer[];
  itemsById: Map<number, UnmatchedItem>;
  selected: Set<number>;
  busy: boolean;
  showMsgContent: boolean;
  /**
   * Toggle a single txId. Optional event param drives shift+click
   * range selection at the parent (see StepReview.toggleTx).
   */
  onToggle: (
    txId: number,
    event?: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => void;
  onToggleSectionAll: (ids: number[]) => void;
  onCharge: (ids: number[]) => void | Promise<void>;
  onSetTxFirm: (txId: number, accountEuId: string) => void | Promise<void>;
  onCopy: (txId: number) => void | Promise<void>;
  onBulkCopy: (ids: number[], format: BulkCopyFormat) => void | Promise<void>;
  onRemove: (txId: number) => void | Promise<void>;
}

/**
 * Bir firma = bir section. İçinde tüm txId'ler düz tabloda, satır başına
 * inline reassign dropdown'ı, footer'da "Seçili (N) Ücretlendir" butonu.
 *
 * ÖNEMLİ: Footer butonu SADECE bu section'ın txId'lerini charge eder.
 * Cross-firm bulaşma riski YOK — UI hiçbir zaman birden fazla firmayı
 * tek tıklamayla POST'lamaz (eski global ActionBar kaldırıldı).
 */
function FirmSectionView({
  section,
  customers,
  itemsById,
  selected,
  busy,
  showMsgContent,
  onToggle,
  onToggleSectionAll,
  onCharge,
  onSetTxFirm,
  onCopy,
  onBulkCopy,
  onRemove,
}: FirmSectionViewProps) {
  const toast = useToast();
  const totalIds = section.items.length;
  const allIds = useMemo(
    () => section.items.map((it) => it.transactionId),
    [section.items],
  );
  const allSelected =
    allIds.length > 0 && allIds.every((id) => selected.has(id));
  const someSelected =
    !allSelected && allIds.some((id) => selected.has(id));
  const isCodec = section.accountEuId === CODEC_ACCOUNT_EU_ID;
  const txOverridesCount = section.items.filter(
    (it) => it.source === "tx-override",
  ).length;

  // Which row's "save as permanent rule" popover is currently open.
  // Section-local state so only one row at a time can have a popover,
  // and navigating between sections naturally closes them all.
  const [popoverTxId, setPopoverTxId] = useState<number | null>(null);

  // --- Per-section pagination ---------------------------------------------
  // Why: see `SECTION_PAGE_SIZE` docstring. We render only the first N
  // txIds of the section and expose "Daha fazla göster" / "Tümünü göster"
  // / "Daralt" affordances at the section footer. Selection, filter, and
  // section-level charge all operate on `section.items` (not the sliced
  // `visibleItems`), so operators can still "Tümünü seç" and charge an
  // entire firm without expanding every row.
  const [expandedSize, setExpandedSize] = useState<number>(() =>
    Math.min(SECTION_PAGE_SIZE, totalIds),
  );
  // Reset the page window if the section's item list itself changes
  // (filter, reassign, new run). Without this the section could end up
  // holding a stale `expandedSize > totalIds` from a previous dataset.
  useEffect(() => {
    setExpandedSize((cur) => Math.min(cur, totalIds));
  }, [totalIds]);
  const visibleItems = useMemo(
    () => section.items.slice(0, expandedSize),
    [section.items, expandedSize],
  );
  const hiddenCount = totalIds - visibleItems.length;
  const showMore = () => setExpandedSize((c) => Math.min(c + SECTION_PAGE_SIZE, totalIds));
  const showAll = () => setExpandedSize(totalIds);
  const collapse = () => setExpandedSize(SECTION_PAGE_SIZE);

  return (
    <section
      className={`review-firm-section ${isCodec ? "codec" : ""}`}
      data-firm-key={section.firmKey}
    >
      <div className="review-firm-section__head">
        <span className={`pill sm ${isCodec ? "warn" : "accent"}`}>
          {section.accountName ?? "Bilinmeyen firma"}
        </span>
        <span className="muted" style={{ fontSize: 10.5 }}>
          {totalIds} tx · {section.selectedCount} seçili
          {hiddenCount > 0 && (
            <>
              {" "}
              · <strong>{visibleItems.length}</strong> görünüyor
            </>
          )}
          {txOverridesCount > 0 && (
            <>
              {" "}
              · <strong>{txOverridesCount}</strong> reassign
            </>
          )}
        </span>
      </div>

      {!isCodec && section.accountEuId && (
        <FirmOverrideMini
          accountEuId={section.accountEuId}
          accountName={section.accountName ?? "Bilinmeyen firma"}
        />
      )}

      {hiddenCount > 0 && (
        <div className="muted" style={{ fontSize: 10.5, padding: "2px 0 4px" }}>
          İlk {visibleItems.length} txId gösteriliyor —{" "}
          <button
            onClick={showMore}
            title={`Sonraki ${Math.min(SECTION_PAGE_SIZE, hiddenCount)} txId'i göster`}
            style={linkButtonStyle}
          >
            {Math.min(SECTION_PAGE_SIZE, hiddenCount)} daha göster
          </button>
          {" · "}
          <button onClick={showAll} title={`Section'daki tüm ${totalIds} txId'i göster`} style={linkButtonStyle}>
            tümünü göster ({hiddenCount} gizli)
          </button>
        </div>
      )}

      <table className="review-tx-table">
        <thead>
          <tr>
            <th className="tx-check">
              <button
                className="tx-row__check ghost"
                onClick={() => onToggleSectionAll(allIds)}
                title={allSelected ? "Tümünü seçimi kaldır" : "Tümünü seç"}
                aria-label="Tümünü seç"
              >
                {allSelected ? (
                  <CheckSquare size={12} color="var(--accent)" />
                ) : someSelected ? (
                  <CheckSquare size={12} color="var(--accent)" style={{ opacity: 0.5 }} />
                ) : (
                  <Square size={12} color="var(--text-2)" />
                )}
              </button>
            </th>
            <th className="tx-id">txId</th>
            <th className="tx-kw">keyword1</th>
            <th className="tx-kw">keyword2</th>
            {showMsgContent && <th className="tx-msg">msgContent</th>}
            <th className="tx-conf">Güven</th>
            <th className="tx-firm-picker">Firma</th>
            <th className="tx-actions">İşlem</th>
          </tr>
        </thead>
        <tbody>
          {visibleItems.map((item) => {
            const it = itemsById.get(item.transactionId);
            const isSelected = selected.has(item.transactionId);
            const isTxOverridden = item.source === "tx-override";
            const firmOfRow = resolveFirmForTx(
              item.transactionId,
              item.row,
              undefined, // tx reassign zaten uygulandı; bu sadece görsel ipucu
              { [item.transactionId]: item.effectiveFirm },
            );
            return (
              <tr
                key={item.transactionId}
                className={`${isSelected ? "selected" : ""} ${isTxOverridden ? "tx-overridden" : ""} cp-${item.match.confidence}`}
              >
                <td className="tx-check">
                  <button
                    className="tx-row__check ghost"
                    onClick={(e) => onToggle(item.transactionId, e)}
                    title={
                      isSelected
                        ? "Seçimi kaldır (Shift+click: range seç, Ctrl+Shift: range kaldır)"
                        : "Seç (Shift+click: range seç, Ctrl+Shift: range kaldır)"
                    }
                    aria-label={isSelected ? "Seçimi kaldır" : "Seç"}
                  >
                    {isSelected ? (
                      <CheckSquare size={11} color="var(--accent)" />
                    ) : (
                      <Square size={11} color="var(--text-2)" />
                    )}
                  </button>
                </td>
                <td className="tx-id" title={`Phone: ${it?.phone ?? "?"}`}>
                  #{item.transactionId}
                </td>
                <td className="tx-kw" title={it?.keyword1 ?? ""}>
                  {it?.keyword1?.slice(0, 24) ?? "—"}
                </td>
                <td className="tx-kw" title={it?.keyword2 ?? ""}>
                  {it?.keyword2?.slice(0, 24) ?? "—"}
                </td>
                {showMsgContent && (
                  <td className="tx-msg" title={it?.msgContent ?? ""}>
                    {it?.msgContent?.slice(0, 80) ?? "—"}
                  </td>
                )}
                <td className="tx-conf">
                  <span className={`pill sm ${item.match.confidence}`}>
                    {item.match.confidence}
                  </span>
                </td>
                <td className="tx-firm-picker">
                  <select
                    value={firmOfRow.accountEuId}
                    onChange={(e) => onSetTxFirm(item.transactionId, e.target.value)}
                    title={
                      isTxOverridden
                        ? "Bu txId reassign edildi (önceki AI önerisi geçersiz)"
                        : firmOfRow.accountName ?? ""
                    }
                    className={isTxOverridden ? "tx-override" : ""}
                  >
                    <option value={CODEC_ACCOUNT_EU_ID}>Codec (fallback)</option>
                    {customers.map((c) => (
                      <option key={c.acntEuId} value={c.acntEuId}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="tx-actions" style={{ position: "relative" }}>
                  <button
                    className="ghost sm"
                    onClick={() => onCopy(item.transactionId)}
                    title="txId'i kopyala"
                  >
                    <Copy size={10} />
                  </button>
                  <button
                    className="ghost sm"
                    onClick={() => onRemove(item.transactionId)}
                    disabled={busy}
                    title="Bu txId'yi tablodan kaldır (charge etmez)"
                    aria-label="Kaldır"
                  >
                    <X size={10} />
                  </button>
                  <button
                    className="ghost sm"
                    onClick={() =>
                      setPopoverTxId(
                        popoverTxId === item.transactionId
                          ? null
                          : item.transactionId,
                      )
                    }
                    title={
                      item.match.confidence === "low"
                        ? "Sabit kural yap — bu keyword için kalıcı yönlendirme kuralı oluştur"
                        : "Bu tx için kalıcı keyword→firma kuralı oluştur"
                    }
                    aria-label="Kural ekle"
                    style={
                      item.match.confidence === "low"
                        ? { color: "var(--accent)" }
                        : undefined
                    }
                  >
                    <BookPlus size={10} />
                    {item.match.confidence === "low" && (
                      <span
                        style={{
                          marginLeft: 4,
                          fontSize: 10,
                          fontWeight: 500,
                        }}
                      >
                        Sabit kural yap
                      </span>
                    )}
                  </button>
                  {popoverTxId === item.transactionId && (
                    <AddRuleInlinePopover
                      transactionId={item.transactionId}
                      matchedField={item.match.matchedField}
                      matchedValue={item.match.matchedValue}
                      suggestedAccountName={item.match.suggestedAccountName}
                      suggestedAccountEuId={item.match.suggestedAccountEuId}
                      customers={customers}
                      onSaved={(r) =>
                        toast.push(
                          `Kural eklendi: "${r.keywords.join(", ")}" → ${r.accountName}`,
                          "success",
                        )
                      }
                      onClose={() => setPopoverTxId(null)}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {hiddenCount > 0 && totalIds > SECTION_PAGE_SIZE && (
        <div
          className="muted"
          style={{
            fontSize: 10.5,
            padding: "6px 0 2px",
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
          }}
        >
          <button className="ghost sm" onClick={showMore}>
            +{Math.min(SECTION_PAGE_SIZE, hiddenCount)} daha
          </button>
          <button className="ghost sm" onClick={showAll}>
            Tümünü göster
          </button>
        </div>
      )}
      {hiddenCount > 0 && totalIds <= SECTION_PAGE_SIZE && (
        // shouldn't happen given the math but kept for safety
        <div className="muted" style={{ fontSize: 10.5, padding: "4px 0" }}>
          {hiddenCount} txId gizli
        </div>
      )}
      {hiddenCount === 0 && totalIds > SECTION_PAGE_SIZE && (
        <div
          className="muted"
          style={{
            fontSize: 10.5,
            padding: "4px 0",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button className="ghost sm" onClick={collapse} title="İlk 50 satıra dön">
            Daralt
          </button>
        </div>
      )}

      <div className="review-firm-section__footer">
        <span className="muted" style={{ fontSize: 11 }}>
          {section.selectedCount > 0
            ? `${section.selectedCount} txId seçili`
            : "Seçim yok — tek tek checkbox'lardan işaretleyebilirsin"}
        </span>
        <div className="footer-actions">
          <div
            className="footer-actions__copy"
            role="group"
            aria-label="Toplu kopyala"
          >
            <span
              className="footer-actions__label muted"
              title="Seçili txId'leri farklı formatlarda panoya kopyala"
            >
              <Copy size={10} /> Kopyala:
            </span>
            {BULK_COPY_FORMATS.map((fmt) => {
              const sample = formatTxIdsForCopy([1001, 1002], fmt);
              return (
                <button
                  key={fmt}
                  className="ghost sm"
                  disabled={busy || section.selectedCount === 0}
                  onClick={() => {
                    const ids = section.items
                      .filter((it) => selected.has(it.transactionId))
                      .map((it) => it.transactionId);
                    onBulkCopy(ids, fmt);
                  }}
                  title={`Seçili txId'leri ${bulkCopyLabel(fmt)} formatında kopyala — örn. ${sample}`}
                >
                  {bulkCopyLabel(fmt)}
                </button>
              );
            })}
          </div>
          <button
            className="primary sm"
            onClick={() => {
              const ids = section.items
                .filter((it) => selected.has(it.transactionId))
                .map((it) => it.transactionId);
              onCharge(ids);
            }}
            disabled={busy || section.selectedCount === 0}
            title={`${section.accountName ?? "?"} firmasına tek istekle gönder`}
          >
            {busy ? (
              <Loader2 size={11} className="spin" />
            ) : (
              <Zap size={11} />
            )}
            Seçili ({section.selectedCount}) Ücretlendir
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Skeleton placeholder rendered while `buildKeywordRows` is deferred
 * across RAFs. Visual contract: matches the look of `.review-table`
 * border/radius so the layout doesn't jump when real rows replace the
 * bars. Pure presentational — receives only a hint for the human-
 * readable count (skeleton bars themselves are static, so render cost
 * is O(1) regardless of `matchesHint`).
 */
function ReviewSkeleton({
  matchesHint,
}: {
  matchesHint: number;
}) {
  // Static layout — 6 placeholder "section" headers + rows. Skeletons
  // are CSS-only shimmer bars, no JSX nodes scale with `matchesHint`,
  // so we intentionally don't enumerate per-row.
  const sectionCount = 6;
  const hintText = `Veriler hazırlanıyor (${matchesHint.toLocaleString("tr-TR")} kayıt)…`;
  return (
    <>
      <div
        className="review-skeleton"
        role="status"
        aria-live="polite"
        aria-label={hintText.replace("…", "")}
      >
        {Array.from({ length: sectionCount }).map((_, i) => (
          <div key={i} style={{ borderBottom: i < sectionCount - 1 ? "1px solid var(--border)" : "none" }}>
            <div className="review-skeleton__bar review-skeleton__bar--title" />
            <div className="review-skeleton__bar review-skeleton__bar--row" />
            <div className="review-skeleton__bar review-skeleton__bar--row is-mid" />
            <div className="review-skeleton__bar review-skeleton__bar--row is-short" />
          </div>
        ))}
      </div>
      <div className="review-skeleton__hint">
        <span className="spin" aria-hidden="true" />
        {hintText}
      </div>
    </>
  );
}