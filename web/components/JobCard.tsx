"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
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
 * back when the pointer leaves. A click or tap anywhere on the card except
 * Apply turns it over or back, as does Enter or Space when the card has focus,
 * so touch, keyboard and reduced motion reach the back too.
 */
export default function JobCard({ job, role, showScore, accent, index = 0 }: Props) {
  const tier = scoreTier(job.score);
  // "4 days ago" from the posting date, else "first seen 4 days ago".
  const when = job.posted_date ? dateAgo(job.posted_date) : job.first_seen ? `first seen ${dateAgo(job.first_seen)}` : null;
  const ref = useRef<HTMLElement>(null);
  const flipTimer = useRef<number | null>(null);
  const [motion, setMotion] = useState(false);
  const [lit, setLit] = useState(false);
  const [flipped, setFlipped] = useState(false);
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

  function stopTimer() {
    if (flipTimer.current !== null) window.clearTimeout(flipTimer.current);
    flipTimer.current = null;
  }

  function enter(event: PointerEvent<HTMLElement>) {
    if (!motion) return;
    aim(event);
    setLit(true);
    stopTimer();
    flipTimer.current = window.setTimeout(() => {
      flipTimer.current = null;
      setLit(false);
      setFlipped(true);
    }, FLIP_MS);
  }

  function leave() {
    if (!motion) return;
    stopTimer();
    setLit(false);
    setFlipped(false);
  }

  /** Turn the card by hand; a pending hover turn is cancelled so it doesn't undo the click. */
  function toggle() {
    stopTimer();
    setLit(false);
    setFlipped((value) => !value);
  }

  function click(event: MouseEvent<HTMLElement>) {
    // Apply opens the posting; selecting text is not a click on the card.
    if ((event.target as HTMLElement).closest("a, button")) return;
    if (window.getSelection()?.toString()) return;
    toggle();
  }

  function key(event: KeyboardEvent<HTMLElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
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
      tabIndex={0}
      aria-label={`${job.title} at ${job.company}. ${flipped ? "Showing how it scores" : "Showing the job"}; press Enter to turn the card.`}
      onPointerEnter={enter}
      onPointerMove={aim}
      onPointerLeave={leave}
      onClick={click}
      onKeyDown={key}
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
