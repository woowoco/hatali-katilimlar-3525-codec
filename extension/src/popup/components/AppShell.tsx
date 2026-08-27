import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar.js";
import { Header } from "./Header.js";
import type { Step, RouteCtx } from "../App.js";
import type { Settings } from "../../types.js";
import type { SessionState } from "../../lib/store.js";

interface Props {
  reachable: Set<Step>;
  settings: Settings;
  setSettings: (s: Settings) => void;
  session: SessionState;
  setSession: (s: SessionState) => void;
  version: string;
}

/**
 * Persistent shell. Sidebar nav + top header + the routed page in main.
 * Routing lives in App.tsx; AppShell just provides the chrome around
 * the current route via <Outlet />. Shared state for the routed page
 * flows through Outlet context.
 */
export function AppShell(props: Props) {
  const { reachable, settings, setSettings, session, setSession, version } = props;
  const ctx: RouteCtx = { settings, setSettings, session, setSession, reachable };
  return (
    <div className="app-shell">
      <Header session={session} settings={settings} />
      <Sidebar reachable={reachable} settings={settings} version={version} />

      <main className="app-main">
        <div className="step-page">
          <Outlet context={ctx} />
        </div>
      </main>
    </div>
  );
}