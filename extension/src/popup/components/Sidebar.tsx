import { NavLink } from "react-router-dom";
import {
  CheckSquare,
  FileText,
  Settings as SettingsIcon,
  Sparkles,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { ProxyStatus } from "./ProxyStatus.js";
import type { Settings } from "../../types.js";
import type { Step } from "../App.js";

interface Props {
  reachable: Set<Step>;
  settings: Settings;
  version: string;
}

interface NavItem {
  step: Step;
  path: string;
  label: string;
  hint: string;
  icon: ReactNode;
}

const ITEMS: NavItem[] = [
  {
    step: "settings",
    path: "/settings",
    label: "Ayarlar",
    hint: "Session, model, audit",
    icon: <SettingsIcon size={16} />,
  },
  {
    step: "fetch",
    path: "/fetch",
    label: "Verileri Çek",
    hint: "Müşteriler + 3525 listesi",
    icon: <Zap size={16} />,
  },
  {
    step: "analyze",
    path: "/analyze",
    label: "AI ile Eşleştir",
    hint: "Batch'ler halinde öneri",
    icon: <Sparkles size={16} />,
  },
  {
    step: "review",
    path: "/review",
    label: "İncele & Ücretlendir",
    hint: "Manuel onay, satır başına",
    icon: <CheckSquare size={16} />,
  },
  {
    step: "history",
    path: "/history",
    label: "Geçmiş / Audit",
    hint: "Tüm gönderilenler",
    icon: <FileText size={16} />,
  },
];

export function Sidebar({ reachable, settings, version }: Props) {
  return (
    <aside className="app-sidebar">
      <div className="app-sidebar__inner">
        <ul className="nav">
          {ITEMS.map((item) => {
            const isReachable = reachable.has(item.step);
            return (
              <li key={item.step}>
                <NavLink
                  to={item.path}
                  className={({ isActive }) =>
                    [
                      "nav__item",
                      isActive ? "nav__item--active" : "",
                      !isReachable ? "nav__item--disabled" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")
                  }
                  aria-disabled={!isReachable}
                  onClick={(e) => {
                    if (!isReachable) e.preventDefault();
                  }}
                  title={item.hint}
                >
                  <span className="nav__icon">{item.icon}</span>
                  <span className="nav__text">
                    <span className="nav__label">{item.label}</span>
                    <span className="nav__hint">{item.hint}</span>
                  </span>
                  <span className="nav__chev" aria-hidden>
                    ›
                  </span>
                </NavLink>
              </li>
            );
          })}
        </ul>

        <div className="app-sidebar__footer">
          <ProxyStatus proxyUrl={settings.proxyUrl} demoMode={settings.demoMode} />
          <div className="app-sidebar__version">v{version}</div>
        </div>
      </div>
    </aside>
  );
}
