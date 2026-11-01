import type { CSSProperties } from "react";
import { newJobs, topMatch } from "@/lib/rank";
import type { Job, RoleSlug } from "@/lib/types";
import { formatNumber, timeAgo, uniqueCompanies } from "@/lib/utils";

interface Props {
  jobs: Job[];
  role: RoleSlug;
  /** When the data was last published; shown when nothing is new. */
  updatedAt: string | null;
}

/** How many of the new jobs ride the strip; the count names them all. */
const SHOWN = 12;

/**
 * The strip under the header: the role's signals (when the data was
 * published, how many companies are hiring, the top match), then what
 * arrived since the last scrape, best match first. It scrolls on its own,
 * pauses under the pointer, and stands still (scrollable) when motion is
 * reduced. The lane is repeated once so the loop has no seam; the copy is
 * hidden from assistive technology.
 */
export default function UpdatesTicker({ jobs, role, updatedAt }: Props) {
  const fresh = newJobs(jobs, role);
  const best = topMatch(jobs, role);
  const facts = (
    <>
      <span className="ticker-fact">updated {timeAgo(updatedAt)}</span>
      {jobs.length > 0 ? (
        <span className="ticker-fact">
          <b>{formatNumber(jobs.length)}</b> jobs · <b>{formatNumber(uniqueCompanies(jobs))}</b> companies
        </span>
      ) : null}
      {best ? (
        <span className="ticker-fact">
          top match <b>{Math.round(best.score)}</b> · {best.company}
        </span>
      ) : null}
    </>
  );

  if (fresh.length === 0) {
    return (
      <div className="ticker ticker-quiet" aria-label="Updates">
        <span className="ticker-lead">Nothing new since the last scrape</span>
        {facts}
      </div>
    );
  }

  const shown = fresh.slice(0, SHOWN);
  const lane = (hidden: boolean) => (
    <div className="ticker-lane" aria-hidden={hidden || undefined}>
      <span className="ticker-lead">
        {formatNumber(fresh.length)} new since the last scrape
      </span>
      {facts}
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
      style={{ "--ticker-duration": `${Math.max(28, (shown.length + 3) * 5)}s` } as CSSProperties}
    >
      <div className="ticker-track">
        {lane(false)}
        {lane(true)}
      </div>
    </div>
  );
}
