"use client";

import { PlayIcon, SparkIcon } from "./Icons";

/**
 * The first paint before the cinematic bundle and model are ready.
 *
 * This must never show the role cards. The former loading fallback reused the
 * full static intro, so the “HI.” headline could be replaced by the selector
 * after a second on a slower connection. The boot screen is deliberately just
 * the scene chrome and a loader; the greeting starts only inside the cinematic
 * scene and always gets its full hold.
 */
export default function IntroBoot() {
  return (
    <main className="intro-boot" aria-busy="true">
      <div className="intro-boot-glow intro-boot-glow-red" aria-hidden />
      <div className="intro-boot-glow intro-boot-glow-blue" aria-hidden />
      <div className="intro-boot-floor" aria-hidden />

      <header className="intro-topbar">
        <span className="brand-lockup">
          <span className="brand-mark">
            <SparkIcon width={17} height={17} />
          </span>
          <span className="brand-copy">
            <strong>JOBHUNT</strong>
            <span>INDIA / 2026</span>
          </span>
        </span>
        <span className="intro-status">
          <span className="status-dot" />
          Live job data
        </span>
      </header>

      <div className="intro-boot-center" role="status" aria-live="polite">
        <span className="loader-mark">
          <PlayIcon width={18} height={18} />
        </span>
        <p>Preparing your guide…</p>
        <span className="loader-line" aria-hidden />
      </div>
    </main>
  );
}
