"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { Job, RoleSlug } from "@/lib/types";
import { matchAxes } from "@/lib/rank";
import { dateAgo, experienceLabel, initials, scoreTier, sourceColor } from "@/lib/utils";
import { ExternalIcon } from "./Icons";

interface Props {
  job: Job;
  role: RoleSlug;
  showScore: boolean;
  /** The role's colour: the score figure, the hover light and the bars on the back. */
  accent: string;
  index?: number;
}

/** How long the pointer rests on a card before it turns over; the role's light shows meanwhile. */
export const FLIP_MS = 1200;

/**
 * One job as a two-sided card. The front carries the monogram, score, title,
 * company line, source and Apply. On a pointer that can hover, with motion not
 * reduced, the role's light falls where the pointer lands and after FLIP_MS the
 * card turns over to its back: the listing's own words, how the score breaks
 * down (role fit, skills, tools, experience, domain) and Apply again. It turns
 * back when the pointer leaves. Touch and reduced motion get a "turn over"
 * button instead, so the back is reachable everywhere.
 */
export default function JobCard({ job, role, showScore, accent, index = 0 }: Props) {
  const tier = scoreTier(job.score);
  // "4 days ago" from the posting date, else "first seen 4 days ago".
  const when = job.posted_date ? dateAgo(job.posted_date) : job.first_seen ? `first seen ${dateAgo(job.first_seen)}` : null;
  const ref = useRef<HTMLElement>(null);
  const flipTimer = useRef<number | null>(null);
  const [motion, setMotion] = useState(false);
  const [lit, setLit] = useState(false);
  const [hoverFlip, setHoverFlip] = useState(false);
  const [pinned, setPinned] = useState(false);
  const flipped = hoverFlip || pinned;
  const { axes } = matchAxes(job, role);

  useEffect(() => {
    const query = window.matchMedia("(hover: hover) and (prefers-reduced-motion: no-preference)");
    const update = () => setMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
      if (flipTimer.current !== null) window.clearTimeout(flipTimer.current);
    };
  }, []);

  function aim(event: PointerEvent<HTMLElement>) {
    const card = ref.current;
    if (!card || !motion) return;
    const box = card.getBoundingClientRect();
    card.style.setProperty("--mx", `${(((event.clientX - box.left) / box.width) * 100).toFixed(1)}%`);
    card.style.setProperty("--my", `${(((event.clientY - box.top) / box.height) * 100).toFixed(1)}%`);
  }

  function enter(event: PointerEvent<HTMLElement>) {
    if (!motion) return;
    aim(event);
    setLit(true);
    if (flipTimer.current !== null) window.clearTimeout(flipTimer.current);
    flipTimer.current = window.setTimeout(() => {
      setLit(false);
      setHoverFlip(true);
    }, FLIP_MS);
  }

  function leave() {
    if (flipTimer.current !== null) window.clearTimeout(flipTimer.current);
    flipTimer.current = null;
    setLit(false);
    setHoverFlip(false);
  }

  const applyHref = job.apply_url || job.url;

  return (
    <article
      ref={ref}
      className={`job-card${lit ? " is-lit" : ""}${flipped ? " is-flipped" : ""}`}
      style={
        {
          "--card-delay": `${Math.min(index, 10) * 45}ms`,
          "--accent": accent,
          "--source-color": sourceColor(job.source),
        } as CSSProperties
      }
      onPointerEnter={enter}
      onPointerMove={aim}
      onPointerLeave={leave}
    >
      <div className="job-card-inner">
        <div className="job-face job-front" inert={flipped}>
          <span className="job-card-light" aria-hidden />

          <div className="job-card-head">
            <div className="job-card-id">
              <span className="job-mono" aria-hidden>
                {initials(job.company)}
              </span>
              {job.is_new ? <span className="new-badge">New</span> : null}
            </div>
            {showScore ? (
              <div className="job-score" aria-label={`Match ${Math.round(job.score)} out of 100, ${tier.label}`}>
                <b>{Math.round(job.score)}</b>
                <small>{tier.label.replace(/ match$/, "")}</small>
              </div>
            ) : null}
          </div>

          <h3 className="job-title">{job.title}</h3>
          <p className="job-line">
            <b>{job.company}</b> · {job.location} · {experienceLabel(job)}
          </p>
          {job.snippet ? <p className="job-snippet">{job.snippet}</p> : null}

          <div className="job-footer">
            <span className="job-meta">
              <span className="source-dot" aria-hidden />
              {job.source}
              {when ? <span className="job-seen"> · {when}</span> : null}
            </span>
            {motion ? null : (
              <button
                type="button"
                className="flip-btn"
                aria-pressed={pinned}
                aria-label={`Turn over: how ${job.title} at ${job.company} scores`}
                onClick={() => setPinned(true)}
              >
                <FlipIcon />
              </button>
            )}
            <a
              className="apply-btn"
              href={applyHref}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Apply: ${job.title} at ${job.company}`}
            >
              Apply
              <ExternalIcon width={13} height={13} />
            </a>
          </div>
        </div>

        <div className="job-face job-back" inert={!flipped}>
          <p className="job-back-text">{job.snippet || `${job.title} at ${job.company}, ${job.location}.`}</p>
          {showScore && axes.length ? (
            <dl className="job-parts" aria-label="How the score breaks down">
              {axes.map((axis) => (
                <div key={axis.key}>
                  <dt>{axis.label}</dt>
                  <dd>
                    <i style={{ "--w": `${axis.value}%` } as CSSProperties} aria-hidden />
                    <b>{Math.round(axis.value)}</b>
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          <div className="job-footer">
            <span className="job-meta">
              {job.company} · {job.location}
            </span>
            {motion ? null : (
              <button
                type="button"
                className="flip-btn"
                aria-pressed={pinned}
                aria-label="Turn back"
                onClick={() => setPinned(false)}
              >
                <FlipIcon />
              </button>
            )}
            <a
              className="apply-btn"
              href={applyHref}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Apply: ${job.title} at ${job.company}`}
            >
              Apply
              <ExternalIcon width={13} height={13} />
            </a>
          </div>
        </div>
      </div>
    </article>
  );
}

function FlipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
      <path d="M4 12a8 8 0 0 1 14-5l2 2M20 4v5h-5" />
    </svg>
  );
}
