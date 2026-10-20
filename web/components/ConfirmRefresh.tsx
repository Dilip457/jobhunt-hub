"use client";

import { useEffect } from "react";
import { CloseIcon, RefreshIcon } from "./Icons";

interface Props {
  open: boolean;
  roleLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ConfirmRefresh({ open, roleLabel, onCancel, onConfirm }: Props) {
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-refresh-title"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="modal">
        <button type="button" className="modal-close" onClick={onCancel} aria-label="Cancel refresh">
          <CloseIcon width={18} height={18} />
        </button>

        <div className="modal-head">
          <span className="modal-icon">
            <RefreshIcon width={20} height={20} />
          </span>
          <div>
            <h2 id="confirm-refresh-title" className="modal-title">
              Refresh {roleLabel} jobs?
            </h2>
            <p className="modal-sub">
              This starts a live GitHub Actions scrape for the selected role.
            </p>
          </div>
        </div>

        <ul className="confirm-list">
          <li>Runs for about 10–15 minutes in the background.</li>
          <li>Uses one workflow run and is limited to once every 25 minutes.</li>
          <li>New results appear automatically when publishing finishes.</li>
        </ul>

        <div className="modal-actions">
          <button type="button" className="ghost-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary-btn" onClick={onConfirm}>
            Confirm refresh
          </button>
        </div>
      </div>
    </div>
  );
}
