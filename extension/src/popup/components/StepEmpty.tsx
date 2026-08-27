import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Lock } from "lucide-react";
import type { Step } from "../App.js";

interface Props {
  /** Where to send the operator when they hit the CTA. */
  ctaPath: string;
  /** Display label for the prerequisite (e.g. "Ayarlar"). */
  ctaLabel: string;
  /** Headline shown beneath the icon. */
  title: string;
  /** Longer explanation; one or two short sentences. */
  hint: string;
  /** Optional icon override. Defaults to <Lock />. */
  icon?: ReactNode;
  /** Which step is currently the prereq (used for the badge label). */
  fromStep: Step;
}

/**
 * Shown in place of a step's real content when its prerequisites
 * haven't been met yet (no session, no items, no matches). Replaces
 * the previous bare `<div className="empty">` with a structured
 * explanation, a clear CTA back to the prerequisite, and a status
 * badge so the operator never wonders "why is this blank?"
 */
export function StepEmpty({ ctaPath, ctaLabel, title, hint, icon, fromStep }: Props) {
  const navigate = useNavigate();
  return (
    <div className="empty empty--locked">
      <div className="empty__icon">
        {icon ?? <Lock size={32} />}
      </div>
      <div className="title">{title}</div>
      <div className="hint">{hint}</div>
      <button className="primary" onClick={() => navigate(ctaPath)}>
        {ctaLabel}’e git <ArrowRight size={12} />
      </button>
      <span className="empty__prereq">
        <span className="empty__prereq-dot" aria-hidden />
        bu adım için önce <strong>{ctaLabel}</strong> tamamlanmalı
        <span className="empty__prereq-step">({fromStep})</span>
      </span>
    </div>
  );
}