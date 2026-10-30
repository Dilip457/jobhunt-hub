"use client";

import { useEffect, useState } from "react";
import type { RoleSlug } from "@/lib/types";
import BrandMark from "./BrandMark";
import { MailIcon, RouteIcon } from "./Icons";
import RoleDestinations from "./RoleDestinations";

interface Props {
  onSelect: (role: RoleSlug) => void;
  reduced?: boolean;
}

const STATIC_GREETING_MS = 4000;

export default function StaticIntro({ onSelect, reduced = false }: Props) {
  // The static fallback keeps the same beat as the cinematic: the greeting
  // owns the screen first, then the destinations appear. Role cards are not
  // rendered while “HI.” is visible.
  const [showRoles, setShowRoles] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowRoles(true), STATIC_GREETING_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className={`static-intro ${reduced ? "is-reduced" : ""}`}>
      <div className="static-intro-scene" aria-hidden>
        <div className="static-orb static-orb-red" />
        <div className="static-orb static-orb-blue" />
        <div className="static-floor" />
        <div className="static-path" />
        <div className="static-grain" />
      </div>

      <header className="intro-topbar">
        <span className="brand-lockup">
          <BrandMark />
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

      {showRoles ? (
        <section
          className="intro-roles intro-roles-cinematic static-roles"
          aria-labelledby="static-role-title"
        >
          <div className="intro-roles-head">
            <p className="intro-kicker">WHERE DO WE GO?</p>
            <h2 id="static-role-title">Choose your target role.</h2>
            <p className="intro-roles-sub">I&apos;ll take you there.</p>
          </div>

          <RoleDestinations onSelect={onSelect} />

          <p className="intro-footnote">
            <MailIcon width={13} height={13} />
            <span>
              Real listings from Naukri, Foundit, Indeed, Shine &amp; LinkedIn. Need a new track or
              found an issue? <a href="mailto:heyjarvis.03@gmail.com">heyjarvis.03@gmail.com</a>
            </span>
          </p>
        </section>
      ) : (
        <section className="static-intro-copy" aria-live="polite">
          <p className="intro-eyebrow">
            <RouteIcon width={14} height={14} />
            A guided job discovery
          </p>
          <h1 className="intro-hi">
            HI<span>.</span>
          </h1>
          <h2>LET&apos;S FIND YOUR NEXT MOVE.</h2>
          <p className="intro-lede">
            Four destinations. Real openings across India. Choose the direction that fits
            what you want to build next.
          </p>
        </section>
      )}
    </main>
  );
}
