import type { CSSProperties } from "react";
import { newJobs } from "@/lib/rank";
import type { Job, RoleSlug } from "@/lib/types";
import { formatNumber, timeAgo } from "@/lib/utils";

interface Props {
  jobs: Job[];
  role: RoleSlug;
  /** When the data was last published; shown when nothing is new. */
  updatedAt: string | null;
}

/** How many of the new jobs ride the strip; the count names them all. */
const SHOWN = 12;

/**
 * The strip under the header: what arrived since the last scrape, best match
 * first. It scrolls on its own, pauses under the pointer, and stands still
 * (scrollable) when motion is reduced. The lane is repeated once so the loop
 * has no seam; the copy is hidden from assistive technology.
 */
export default function UpdatesTicker({ jobs, role, updatedAt }: Props) {
  const fresh = newJobs(jobs, role);
  if (fresh.length === 0) {
    return (
      <div className="ticker ticker-quiet" aria-label="Updates">
        <span className="ticker-lead">Nothing new since the last scrape</span>
        <span className="ticker-item">updated {timeAgo(updatedAt)}</span>
      </div>
    );
  }

  const shown = fresh.slice(0, SHOWN);
  const lane = (hidden: boolean) => (
    <div className="ticker-lane" aria-hidden={hidden || undefined}>
      <span className="ticker-lead">
        {formatNumber(fresh.length)} new since the last scrape
      </span>
      {shown.map((job) => (
        <a
          key={`${job.source}-${job.id}`}
          className="ticker-item"
          href={job.apply_url || job.url}
          target="_blank"
          rel="noopener noreferrer"
          tabIndex={hidden ? -1 : undefined}
        >
          {job.company} · {job.title} · <b>{Math.round(job.score)}</b>
        </a>
      ))}
    </div>
  );

  return (
    <div
      className="ticker"
      aria-label="New since the last scrape"
      style={{ "--ticker-duration": `${Math.max(28, shown.length * 5)}s` } as CSSProperties}
    >
      <div className="ticker-track">
        {lane(false)}
        {lane(true)}
      </div>
    </div>
  );
}
