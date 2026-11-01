import type { CSSProperties } from "react";
import { matchBands, scoreAxes } from "@/lib/rank";
import type { Job } from "@/lib/types";
import { formatNumber } from "@/lib/utils";

interface Props {
  /** The best match; its score is the one taken apart. */
  job: Job | null;
  /** Every job of the role, for the match bands. */
  jobs: Job[];
  accent: string;
}

const CENTRE = 120;
const RADIUS = 100;

function point(index: number, count: number, radius: number): [number, number] {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
  return [CENTRE + Math.cos(angle) * radius, CENTRE + Math.sin(angle) * radius];
}

function ring(count: number, radius: number): string {
  return Array.from({ length: count }, (_, index) => point(index, count, radius).join(",")).join(" ");
}

/**
 * How the top match earns its score, as the scraper publishes it: role fit,
 * skills and, for roles with an experience rule, the fit of its years. Three
 * or more parts are drawn as a tilted radar that turns slowly; fewer are
 * bars only. Under it, how the role's jobs fall into match bands.
 */
export default function MatchSignal({ job, jobs, accent }: Props) {
  const axes = job ? scoreAxes(job) : [];
  const bands = matchBands(jobs);
  const most = Math.max(1, ...bands.map((band) => band.count));
  const style = { "--signal": accent } as CSSProperties;

  return (
    <div className="match-signal" style={style}>
      <h2 className="match-signal-head">How the top match scores</h2>
      {axes.length >= 3 ? (
        <div className="radar" aria-hidden>
          <svg viewBox="0 0 240 240">
            <g className="radar-spin">
              {[RADIUS, RADIUS * 0.66, RADIUS * 0.33].map((radius) => (
                <polygon key={radius} className="radar-grid" points={ring(axes.length, radius)} />
              ))}
              {axes.map((axis, index) => {
                const [x, y] = point(index, axes.length, RADIUS);
                return <line key={axis.key} className="radar-axis" x1={CENTRE} y1={CENTRE} x2={x} y2={y} />;
              })}
              <polygon
                className="radar-shape"
                points={axes.map((axis, index) => point(index, axes.length, (RADIUS * axis.value) / 100).join(",")).join(" ")}
              />
              {axes.map((axis, index) => {
                const [x, y] = point(index, axes.length, (RADIUS * axis.value) / 100);
                return <circle key={axis.key} className="radar-dot" cx={x} cy={y} r={3.5} />;
              })}
            </g>
          </svg>
        </div>
      ) : null}

      {axes.length > 0 ? (
        <dl className="signal-parts">
          {axes.map((axis) => (
            <div key={axis.key}>
              <dt>{axis.label}</dt>
              <dd>
                <i style={{ "--w": `${axis.value}%` } as CSSProperties} />
                <b>{Math.round(axis.value)}</b>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="signal-note">
          {job
            ? "The parts of each score arrive with the next scrape."
            : "Nothing to take apart until this role has jobs."}
        </p>
      )}

      <h3 className="match-signal-sub">
        {formatNumber(jobs.length)} jobs by match band
      </h3>
      <dl className="signal-bands">
        {bands.map((band, index) => (
          <div key={band.label} className={index === 0 ? "is-top" : undefined}>
            <dt>{band.label}</dt>
            <dd>
              <i style={{ "--w": `${(band.count / most) * 100}%` } as CSSProperties} />
              <b>{formatNumber(band.count)}</b>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
