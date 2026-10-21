"use client";

import type { CSSProperties } from "react";
import type { Job } from "@/lib/types";
import { dateAgo, experienceLabel, initials, scoreTier, sourceColor } from "@/lib/utils";
import { BuildingIcon, ExternalIcon, MapPinIcon } from "./Icons";
import ScoreRing from "./ScoreRing";

interface Props {
  job: Job;
  showScore: boolean;
  index?: number;
}

function avatarHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) % 360;
  return hash;
}

export default function JobCard({ job, showScore, index = 0 }: Props) {
  const tier = scoreTier(job.score);
  const hue = avatarHue(job.company || job.title);
  const sourceTone = sourceColor(job.source);
  const posted = job.posted_date ? `Posted ${dateAgo(job.posted_date)}` : null;
  const seen = job.first_seen ? `First seen ${dateAgo(job.first_seen)}` : null;

  return (
    <article
      className="job-card"
      style={
        {
          "--card-delay": `${Math.min(index, 10) * 38}ms`,
          "--source-color": sourceTone,
          "--avatar-a": `hsl(${hue} 58% 38%)`,
          "--avatar-b": `hsl(${(hue + 38) % 360} 50% 24%)`,
        } as CSSProperties
      }
    >
      <div className="job-card-top">
        <span className="job-avatar" aria-hidden>
          {initials(job.company)}
        </span>

        <div className="job-heading">
          <div className="job-card-kicker">
            <span className="source-badge">
              <span className="source-dot" />
              {job.source}
            </span>
            {job.is_new ? <span className="new-badge">NEW</span> : null}
          </div>
          <h3 className="job-title">{job.title}</h3>
          <p className="job-company">
            <BuildingIcon width={13} height={13} />
            <span>{job.company}</span>
          </p>
        </div>

        {showScore ? <ScoreRing score={job.score} /> : null}
      </div>

      <div className="job-meta">
        <span>
          <MapPinIcon width={13} height={13} />
          {job.location}
        </span>
        <span>{experienceLabel(job)}</span>
      </div>

      {job.snippet ? <p className="job-snippet">{job.snippet}</p> : null}

      <div className="job-footer">
        <div className="job-footer-meta">
          {showScore ? (
            <span className="tier-badge" style={{ color: tier.color }}>
              {tier.label}
            </span>
          ) : null}
          <span className="job-seen">
            {posted}
            {posted && seen ? <span aria-hidden> · </span> : null}
            {seen}
          </span>
        </div>

        <a
          className="apply-btn"
          href={job.apply_url || job.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`View ${job.title} at ${job.company}`}
        >
          View job
          <ExternalIcon width={14} height={14} />
        </a>
      </div>
    </article>
  );
}
