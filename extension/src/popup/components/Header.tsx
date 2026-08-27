import { Link } from "react-router-dom";
import { Activity, Database, FileSpreadsheet, ShieldCheck, Wallet } from "lucide-react";
import type { ReactNode } from "react";
import type { SessionState } from "../../lib/store.js";
import type { Settings } from "../../types.js";

interface Props {
  session: SessionState;
  settings: Settings;
}

interface Chip {
  to: string;
  icon: ReactNode;
  label: string;
  value: string;
  tone?: "default" | "success";
}

/**
 * Top bar of the web shell. Title + a row of summary chips that mirror
 * the live session state. Clicking a chip navigates to the matching
 * step's route. The right-hand "safe-mode" badge is always visible —
 * it restates the no-auto-charge rule so it stays in peripheral vision.
 */
export function Header({ session, settings }: Props) {
  const items = session.items.length;
  const matches = session.matches?.length ?? 0;
  const charged = session.chargedIds.length;

  const chips: Chip[] = [
    {
      to: "/fetch",
      icon: <Database size={12} />,
      label: "kayıt",
      value: items.toLocaleString("tr-TR"),
    },
    {
      to: "/analyze",
      icon: <FileSpreadsheet size={12} />,
      label: "eşleşti",
      value: matches.toLocaleString("tr-TR"),
      tone: matches > 0 ? "success" : "default",
    },
    {
      to: "/history",
      icon: <Wallet size={12} />,
      label: "gönderildi",
      value: charged.toLocaleString("tr-TR"),
      tone: charged > 0 ? "success" : "default",
    },
  ];

  return (
    <header className="app-header">
      <div className="app-header__brand">
        <div className="app-header__title">
          <Activity size={18} color="var(--accent)" />
          <div>
            <h1>Hatalı Katılımlar Assistant</h1>
            <div className="subtitle">
              3525 short-code · AI öneri + manuel tetikleme
            </div>
          </div>
        </div>
      </div>

      <div className="app-header__chips">
        {chips.map((c) => (
          <Link
            key={c.to}
            to={c.to}
            className={`chip${c.tone === "success" ? " chip--success" : ""}`}
            title={`${c.label}: ${c.value}`}
          >
            <span className="chip__icon">{c.icon}</span>
            <span className="chip__value">{c.value}</span>
            <span className="chip__label">{c.label}</span>
          </Link>
        ))}
        <span className="app-header__model" title={`Model: ${settings.model}`}>
          {settings.model}
        </span>
        <span
          className="app-header__safety"
          title="AI asla otomatik ücretlendirme yapmaz. Tüm POST'lar sen tetiklersin."
        >
          <ShieldCheck size={12} /> AI sadece önerir · Ücretlendirme manuel
        </span>
      </div>
    </header>
  );
}
