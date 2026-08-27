import { useEffect, useRef, useState } from "react";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { fetchModels } from "../../lib/ai.js";

type Status = "checking" | "ok" | "error";

interface Props {
  proxyUrl: string;
  demoMode?: boolean;
}

/**
 * Live AI proxy health pill. Calls `fetchModels()` (already used by the
 * Settings page) on mount, then re-runs every 30 s and on window focus.
 * Three states render with green/red/muted styling — the same `.pill`
 * tokens already defined in styles.css.
 */
export function ProxyStatus({ proxyUrl, demoMode = false }: Props) {
  const [status, setStatus] = useState<Status>("checking");
  const [reason, setReason] = useState<string>("");
  // Avoid running the first probe twice in StrictMode dev.
  const ranOnce = useRef(false);

  const probe = async () => {
    setStatus("checking");
    try {
      const res = await fetchModels(proxyUrl, demoMode);
      if (res?.models?.length > 0) {
        setStatus("ok");
        setReason("");
      } else {
        setStatus("error");
        setReason("model listesi boş");
      }
    } catch (err) {
      setStatus("error");
      setReason(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (ranOnce.current) return;
    ranOnce.current = true;
    void probe();
    const id = window.setInterval(() => void probe(), 30_000);
    const onFocus = () => void probe();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proxyUrl]);

  if (status === "ok") {
    return (
      <span
        className="pill success proxy-status"
        title={`AI proxy erişilebilir (${proxyUrl})`}
      >
        <CheckCircle2 size={11} /> AI proxy: erişilebilir
      </span>
    );
  }
  if (status === "error") {
    return (
      <span
        className="pill danger proxy-status"
        title={`AI proxy erişilemedi (${proxyUrl})\n${reason}`}
      >
        <XCircle size={11} /> AI proxy: erişilemedi
      </span>
    );
  }
  return (
    <span className="pill proxy-status" title={`AI proxy: ${proxyUrl}`}>
      <Loader2 size={11} className="spin" /> kontrol ediliyor…
    </span>
  );
}
