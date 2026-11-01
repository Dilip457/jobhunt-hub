"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { Job } from "@/lib/types";
import { dateAgo, experienceLabel, initials, scoreTier, sourceColor } from "@/lib/utils";
import { ExternalIcon } from "./Icons";

interface Props {
  job: Job;
  showScore: boolean;
  /** The role's colour: the score figure and the hover light. */
  accent: string;
  index?: number;
}

/** How long the role's light stays on a card after the pointer arrives. */
const LIGHT_MS = 1200;
/** Largest tilt toward the pointer, in degrees. */
const TILT_DEG = 10;

/**
 * One job. On a pointer that can hover, and when motion is not reduced, the
 * card tilts toward the pointer at once and the role's light falls where the
 * pointer is, fading out after LIGHT_MS; the tilt stays while the pointer is
 * over the card. Touch and keyboard get the same card without the motion.
 */
export default function JobCard({ job, showScore, accent, index = 0 }: Props) {
  const tier = scoreTier(job.score);
  // "4 days ago" from the posting date, else "first seen 4 days ago".
  const when = job.posted_date ? dateAgo(job.posted_date) : job.first_seen ? `first seen ${dateAgo(job.first_seen)}` : null;
  const ref = useRef<HTMLElement>(null);
  const lightTimer = useRef<number | null>(null);
  const [motion, setMotion] = useState(false);
  const [lit, setLit] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(hover: hover) and (prefers-reduced-motion: no-preference)");
    const update = () => setMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => {
      query.removeEventListener("change", update);
      if (lightTimer.current !== null) window.clearTimeout(lightTimer.current);
    };
  }, []);

  function aim(event: PointerEvent<HTMLElement>) {
    const card = ref.current;
    if (!card || !motion) return;
    const box = card.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    card.style.setProperty("--ry", `${((x - 0.5) * TILT_DEG).toFixed(2)}deg`);
    card.style.setProperty("--rx", `${((0.5 - y) * TILT_DEG).toFixed(2)}deg`);
    card.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
    card.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
  }

  function enter(event: PointerEvent<HTMLElement>) {
    if (!motion) return;
    aim(event);
    setLit(true);
    if (lightTimer.current !== null) window.clearTimeout(lightTimer.current);
    lightTimer.current = window.setTimeout(() => setLit(false), LIGHT_MS);
  }

  function leave() {
    const card = ref.current;
    if (!card) return;
    card.style.setProperty("--rx", "0deg");
    card.style.setProperty("--ry", "0deg");
    setLit(false);
  }

  return (
    <article
      ref={ref}
      className={`job-card${lit ? " is-lit" : ""}`}
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
          href={job.apply_url || job.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Apply: ${job.title} at ${job.company}`}
        >
          Apply
          <ExternalIcon width={13} height={13} />
        </a>
      </div>
    </article>
  );
}
