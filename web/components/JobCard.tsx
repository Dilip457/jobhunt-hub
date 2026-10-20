import type { Job } from "@/lib/types";
import { dateAgo, experienceLabel, formatDate, initials, scoreTier, sourceColor } from "@/lib/utils";
import { BuildingIcon, CalendarIcon, ExternalIcon, MapPinIcon } from "./Icons";
import ScoreRing from "./ScoreRing";

interface Props {
  job: Job;
  showScore: boolean;
}

function avatarHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) % 360;
  return hash;
}

export default function JobCard({ job, showScore }: Props) {
  const tier = scoreTier(job.score);
  const hue = avatarHue(job.company || job.title);

  return (
    <article className="job-card">
      <div className="job-card-top">
        <span
          className="job-avatar"
          style={{
            background: `linear-gradient(135deg, hsl(${hue} 60% 42%), hsl(${(hue + 40) % 360} 55% 30%))`,
          }}
          aria-hidden
        >
          {initials(job.company)}
        </span>

        <div className="job-heading">
          <h3 className="job-title">{job.title}</h3>
          <p className="job-company">
            <BuildingIcon width={14} height={14} />
            <span>{job.company}</span>
          </p>
        </div>

        {showScore ? <ScoreRing score={job.score} /> : null}
      </div>

      <div className="job-meta">
        <span>
          <MapPinIcon width={14} height={14} />
          {job.location}
        </span>
        <span>{experienceLabel(job)}</span>
        {job.posted_date ? (
          <span>
            <CalendarIcon width={14} height={14} />
            {formatDate(job.posted_date)}
          </span>
        ) : null}
      </div>

      {job.snippet ? <p className="job-snippet">{job.snippet}</p> : null}

      <div className="job-footer">
        <div className="job-tags">
          <span className="source-badge" style={{ borderColor: sourceColor(job.source) }}>
            <span className="source-dot" style={{ background: sourceColor(job.source) }} />
            {job.source}
          </span>
          {job.is_new ? <span className="new-badge">NEW</span> : null}
          {showScore ? (
            <span className="tier-badge" style={{ color: tier.color }}>
              {tier.label}
            </span>
          ) : null}
        </div>

        <a className="apply-btn" href={job.apply_url || job.url} target="_blank" rel="noopener noreferrer">
          Apply
          <ExternalIcon width={14} height={14} />
        </a>
      </div>

      <span className="job-seen">
        {job.posted_date ? <span>Posted {dateAgo(job.posted_date)}</span> : null}
        {job.posted_date && job.first_seen ? <span aria-hidden> · </span> : null}
        {job.first_seen ? <span>First seen {dateAgo(job.first_seen)}</span> : null}
      </span>
    </article>
  );
}
