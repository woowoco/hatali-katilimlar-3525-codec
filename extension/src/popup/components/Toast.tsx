import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

type ToastKind = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  kind: ToastKind;
}

interface ToastApi {
  push: (msg: string, kind?: ToastKind) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

const DEFAULT_TTL_MS = 4500;

/**
 * Minimal toast system. Mount once at the app root (App.tsx) and call
 * `useToast().push(...)` from anywhere. Toasts auto-dismiss after a few
 * seconds, are stacked at the top-right of the viewport, and never
 * block the main UI.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((message: string, kind: ToastKind = "info") => {
    const id = nextId.current++;
    setToasts((cur) => [...cur, { id, message, kind }]);
    setTimeout(() => {
      setToasts((cur) => cur.filter((t) => t.id !== id));
    }, DEFAULT_TTL_MS);
  }, []);

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <ToastView key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  // Trigger the slide-in animation on mount.
  const [in_, setIn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setIn(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const Icon =
    toast.kind === "success"
      ? CheckCircle2
      : toast.kind === "error"
        ? AlertTriangle
        : Info;

  return (
    <div
      className={`toast toast--${toast.kind}${in_ ? " toast--in" : ""}`}
      onClick={onDismiss}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onDismiss();
        }
      }}
    >
      <Icon size={14} />
      <span className="toast__msg">{toast.message}</span>
      <X size={11} className="toast__close" />
    </div>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) {
    // Allow use outside the provider for tests / SSR; fall back to a no-op.
    return { push: () => {} };
  }
  return ctx;
}