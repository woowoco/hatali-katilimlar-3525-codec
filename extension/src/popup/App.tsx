import { useEffect, useMemo, useState } from "react";
import {
  HashRouter,
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
  useOutletContext,
} from "react-router-dom";
import { AppShell } from "./components/AppShell.js";
import { ToastProvider } from "./components/Toast.js";
import { StepEmpty } from "./components/StepEmpty.js";
import { StepSettings } from "./components/StepSettings.js";
import { StepFetch } from "./components/StepFetch.js";
import { StepAnalyze } from "./components/StepAnalyze.js";
import { StepReview } from "./components/StepReview.js";
import { StepHistory } from "./components/StepHistory.js";
import {
  EMPTY_SESSION,
  loadSession,
  loadSettings,
  type SessionState,
} from "../lib/store.js";
import type { Settings } from "../types.js";

export type Step = "settings" | "fetch" | "analyze" | "review" | "history";

export const STEP_ORDER: Step[] = [
  "settings",
  "fetch",
  "analyze",
  "review",
  "history",
];

// Mirrors manifest.json's `version`. Embedded here so the sidebar can
// show it without bundling the manifest JSON.
const EXTENSION_VERSION = "0.1.0";

/** Shape passed to routed step components via Outlet context. */
export interface RouteCtx {
  settings: Settings;
  setSettings: (s: Settings) => void;
  session: SessionState;
  setSession: (s: SessionState) => void;
  reachable: Set<Step>;
}

/**
 * Routes the operator to the deepest step they qualify for based on
 * what was loaded from chrome.storage. Called once after hydration.
 */
function pickInitialStep(
  settings: Settings | null,
  session: SessionState,
): string {
  if (session.matches) return "/review";
  if (session.items.length > 0) return "/analyze";
  if (session.customers.length > 0 || settings?.sessionId) return "/fetch";
  return "/settings";
}

/**
 * Renders the step for the current URL. Wraps each step in a
 * `<StepEmpty>` block when its prerequisite data isn't present, so the
 * sidebar can show the step as "unlocked but empty" rather than 404.
 */
function RoutedStep({ path }: { path: Step }) {
  const ctx = useOutletContext<RouteCtx>();
  const { reachable } = ctx;
  // Step components read the rest of the context themselves via useOutletContext.
  void ctx;

  // Settings is always reachable; the others need prereqs.
  if (!reachable.has(path)) {
    switch (path) {
      case "fetch":
        return (
          <StepEmpty
            fromStep="settings"
            ctaPath="/settings"
            ctaLabel="Ayarlar"
            title="Session bulunamadı"
            hint="AI proxy'ye istek gönderebilmek için önce admin-panel session'ını bağlamalısın. Ayarlar sekmesinden otomatik bul veya HAR'dan al ile yükleyebilirsin."
          />
        );
      case "analyze":
        return (
          <StepEmpty
            fromStep="fetch"
            ctaPath="/fetch"
            ctaLabel="Verileri Çek"
            title="Önce müşteri listesini çek"
            hint="AI'ın eşleştirme yapabilmesi için admin-panel'den müşteri ve 3525 short-code listesini çekmiş olmalısın."
          />
        );
      case "review":
        return (
          <StepEmpty
            fromStep="analyze"
            ctaPath="/analyze"
            ctaLabel="AI ile Eşleştir"
            title="Henüz AI önerisi yok"
            hint="İncele sekmesi sadece AI'ın ürettiği eşleşmeleri gösterir. Önce Analiz sekmesinden bir çalışma tetikle."
          />
        );
      case "history":
        // History always reachable (settings reachable) — no empty state.
        return <StepHistory />;
      case "settings":
        return <StepSettings />;
    }
  }

  switch (path) {
    case "settings":
      return <StepSettings />;
    case "fetch":
      return <StepFetch />;
    case "analyze":
      return <StepAnalyze />;
    case "review":
      return <StepReview />;
    case "history":
      return <StepHistory />;
  }
}

/** Inside the HashRouter — does the post-load redirect to the right step. */
function PostLoadRedirect({
  settings,
  session,
}: {
  settings: Settings | null;
  session: SessionState;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || !settings) return;
    const target = pickInitialStep(settings, session);
    // Only redirect when the URL is still the bare root or the
    // operator landed on an out-of-bounds step (eg. switched accounts).
    if (
      location.pathname === "/" ||
      location.pathname === "" ||
      !STEP_ORDER.includes(location.pathname.slice(1) as Step)
    ) {
      navigate(target, { replace: true });
    }
  }, [hydrated, settings, session, location.pathname, navigate]);

  return null;
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [session, setSession] = useState<SessionState>(EMPTY_SESSION);

  useEffect(() => {
    (async () => {
      const [s, sess] = await Promise.all([loadSettings(), loadSession()]);
      setSettings(s);
      setSession(sess);
    })();
  }, []);

  const reachable = useMemo<Set<Step>>(() => {
    const s = new Set<Step>(["settings", "history"]);
    if (!settings) return s;
    if (settings.sessionId) s.add("fetch");
    if (session.items.length > 0) s.add("analyze");
    if (session.matches) s.add("review");
    return s;
  }, [settings, session]);

  if (!settings) {
    return (
      <div className="app-shell app-shell--loading">
        <div className="empty">Yükleniyor…</div>
      </div>
    );
  }

  return (
    <HashRouter>
      <ToastProvider>
        <PostLoadRedirect settings={settings} session={session} />
        <Routes>
          <Route
            element={
              <AppShell
                reachable={reachable}
                settings={settings}
                setSettings={setSettings}
                session={session}
                setSession={setSession}
                version={EXTENSION_VERSION}
              />
            }
          >
            <Route path="/" element={<Navigate to="/settings" replace />} />
            <Route path="/settings" element={<RoutedStep path="settings" />} />
            <Route path="/fetch" element={<RoutedStep path="fetch" />} />
            <Route path="/analyze" element={<RoutedStep path="analyze" />} />
            <Route path="/review" element={<RoutedStep path="review" />} />
            <Route path="/history" element={<RoutedStep path="history" />} />
            <Route path="*" element={<Navigate to="/settings" replace />} />
          </Route>
        </Routes>
      </ToastProvider>
    </HashRouter>
  );
}