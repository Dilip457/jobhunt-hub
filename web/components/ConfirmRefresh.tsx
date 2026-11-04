"use client";

import { useEffect, useRef, useState } from "react";
import { CloseIcon, RefreshIcon } from "./Icons";

/**
 * Fixed account name for the hidden username field. Password managers save a
 * password against a username, so this lets the browser offer to save the
 * refresh password and sync it to the owner's other devices.
 */
const PASSWORD_ACCOUNT = "jobhunt-refresh";

interface Props {
  open: boolean;
  roleLabel: string;
  /** Ask for the refresh password (the deployment sets REFRESH_TOKEN). */
  needsKey?: boolean;
  initialKey?: string;
  initialRemember?: boolean;
  /** Inline error for the password field, e.g. "Wrong password". */
  error?: string | null;
  /** The server is checking the password; the dialog stays open meanwhile. */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (key: string, remember: boolean) => void;
}

export default function ConfirmRefresh({
  open,
  roleLabel,
  needsKey = false,
  initialKey = "",
  initialRemember = false,
  error = null,
  busy = false,
  onCancel,
  onConfirm,
}: Props) {
  const [key, setKey] = useState(initialKey);
  const [remember, setRemember] = useState(initialRemember);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setKey(initialKey);
      setRemember(initialRemember);
    }
  }, [open, initialKey, initialRemember]);

  // A rejected password leaves the dialog open: empty the field and put the
  // cursor back in it.
  useEffect(() => {
    if (!open || !error) return;
    setKey("");
    inputRef.current?.focus();
  }, [open, error]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  const canConfirm = !busy && (!needsKey || Boolean(key.trim()));

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
          <li>Usually runs for 5–25 minutes in the background.</li>
          <li>Uses one workflow run and is limited to once every 25 minutes.</li>
          <li>New results appear automatically when publishing finishes.</li>
        </ul>

        {/* A real form, so Enter submits and password managers recognise it. */}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (canConfirm) onConfirm(key.trim(), remember);
          }}
        >
          {needsKey ? (
            <>
              <input
                className="sr-only"
                type="text"
                name="username"
                autoComplete="username"
                value={PASSWORD_ACCOUNT}
                readOnly
                tabIndex={-1}
                aria-hidden="true"
              />
              <label className="refresh-key">
                <span>Password</span>
                <input
                  ref={inputRef}
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  aria-invalid={error ? true : undefined}
                  aria-describedby="refresh-key-error"
                  autoFocus
                />
              </label>
              {/* Always rendered, so a new error is announced as it appears. */}
              <p id="refresh-key-error" className="refresh-key-error" aria-live="assertive">
                {error}
              </p>
              <label className="refresh-remember">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                <span>Remember on this device</span>
              </label>
            </>
          ) : null}

          <div className="modal-actions">
            <button type="button" className="ghost-btn" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="primary-btn" disabled={!canConfirm}>
              {busy ? "Checking…" : "Confirm refresh"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
