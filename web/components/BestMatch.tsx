import type { CSSProperties } from "react";
import type { Job } from "@/lib/types";
import { experienceLabel, jobHref } from "@/lib/utils";
import { ExternalIcon } from "./Icons";

interface Props {
  job: Job | null;
  accent: string;
}

/**
 * The one solid tile on the page: the job the role's list opens with, in the
 * role's colour, its score as the largest figure on the screen. The whole
 * tile is the link to the posting.
 */
export default function BestMatch({ job, accent }: Props) {
  const style = { "--tile": accent } as CSSProperties;
  if (!job) {
    return (
      <div className="best-match is-empty" style={style}>
        <span className="best-match-head">Best match right now</span>
        <span className="best-match-title">No jobs published for this role yet.</span>
      </div>
    );
  }

  return (
    <a
      className="best-match"
      style={style}
      href={jobHref(job)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Best match right now: ${job.title} at ${job.company}, ${Math.round(job.score)} out of 100. Opens the posting.`}
    >
      <span className="best-match-head">Best match right now</span>
      <span className="best-match-go">
        <ExternalIcon width={18} height={18} />
      </span>
      <span className="best-match-score">
        {Math.round(job.score)}
        <small>/100</small>
      </span>
      <span className="best-match-title">{job.title}</span>
      <span className="best-match-sub">
        {job.company} · {job.location} · {experienceLabel(job)}
      </span>
    </a>
  );
}
