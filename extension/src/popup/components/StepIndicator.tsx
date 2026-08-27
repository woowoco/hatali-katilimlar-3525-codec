import { Check } from "lucide-react";
import type { Step } from "../App.js";

interface Props {
  current: Step;
  reachable: Set<Step>;
  onJump: (s: Step) => void;
}

const ORDER: Step[] = ["settings", "fetch", "analyze", "review", "history"];

const LABELS: Record<Step, string> = {
  settings: "Ayarlar",
  fetch: "Çek",
  analyze: "Analiz",
  review: "İncele",
  history: "Geçmiş",
};

export function StepIndicator({ current, reachable, onJump }: Props) {
  const currentIdx = ORDER.indexOf(current);
  return (
    <div className="steps">
      {ORDER.map((s, i) => {
        const isCurrent = i === currentIdx;
        const isDone = i < currentIdx;
        const isReachable = reachable.has(s);
        return (
          <div
            key={s}
            className={[
              "step",
              isCurrent ? "active" : "",
              isDone ? "done" : "",
              !isReachable && !isCurrent ? "disabled" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={() => isReachable && onJump(s)}
            title={LABELS[s]}
          >
            {isDone ? <Check size={11} style={{ verticalAlign: "middle" }} /> : null}{" "}
            {LABELS[s]}
          </div>
        );
      })}
    </div>
  );
}