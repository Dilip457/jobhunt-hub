"use client";

import type { RunState } from "@/lib/types";
import { formatDuration } from "@/lib/utils";
import { CheckIcon, CloseIcon, ExternalIcon, RefreshIcon } from "./Icons";

interface Props {
  open: boolean;
  state: RunState;
  roleLabel: string;
  elapsed: number;
  runUrl?: string;
  runConfigured: boolean;
  onClose: () => void;
}

const STEPS = [
  "Queued in GitHub Actions",
  "Scraping job portals across India",
  "Validating links and scoring",
  "Publishing results to the site",
];

function activeStep(state: RunState, elapsed: number): number {
  if (state === "success") return STEPS.length;
  if (state === "failed" || state === "cancelled" || state === "idle") return -1;
  if (state === "queued") return 0;
  if (elapsed < 420) return 1;
  if (elapsed < 780) return 2;
  return 3;
}

export default function RefreshPanel({
  open,
  state,
  roleLabel,
  elapsed,
  runUrl,
  runConfigured,
  onClose,
}: Props) {
  if (!open) return null;

  const step = activeStep(state, elapsed);
  const running = state === "queued" || state === "running";

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Refresh jobs">
      <div className="modal">
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
          <CloseIcon width={18} height={18} />
        </button>

        <div className="modal-head">
          <span className={`modal-icon ${running ? "is-spinning" : state === "failed" ? "is-error" : "is-done"}`}>
            {state === "failed" ? <CloseIcon width={20} height={20} /> : <RefreshIcon width={20} height={20} />}
          </span>
          <div>
            <h2 className="modal-title">
              {state === "success"
                ? "Fresh jobs are live"
                : state === "failed"
                ? "Scrape failed"
                : state === "cancelled"
                ? "Scrape cancelled"
                : `Refreshing ${roleLabel}`}
            </h2>
            <p className="modal-sub">
              {!runConfigured
                ? "This deployment is not connected to GitHub yet."
                : state === "success"
                ? "Results have been published and loaded."
                : state === "failed"
                ? "Check the GitHub Actions log for details."
                : state === "cancelled"
                ? "The run was cancelled before it finished. You can try again."
                : `Live scraping takes about 10–15 minutes · ${formatDuration(elapsed)} elapsed`}
            </p>
          </div>
        </div>

        <ul className="steps">
          {STEPS.map((label, index) => {
            const done = step > index || state === "success";
            const active = step === index && running;
            return (
              <li key={label} className={`step ${done ? "is-done" : ""} ${active ? "is-active" : ""}`}>
                <span className="step-marker">{done ? <CheckIcon width={13} height={13} /> : index + 1}</span>
                <span>{label}</span>
                {active ? <span className="step-dots" aria-hidden /> : null}
              </li>
            );
          })}
        </ul>

        <p className="modal-note">
          You can close this window. The portal keeps scraping in the background and the results
          will appear here when they are ready.
        </p>

        <div className="modal-actions">
          {runUrl ? (
            <a className="ghost-btn" href={runUrl} target="_blank" rel="noopener noreferrer">
              View run log
              <ExternalIcon width={14} height={14} />
            </a>
          ) : null}
          <button type="button" className="primary-btn" onClick={onClose}>
            {running ? "Continue browsing" : "Close"}
          </button>
        </div>
      </div>
    </div>
  );
}
