"use client";

import type { CityCount, ExperienceBucket } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { CloseIcon, FilterIcon, SearchIcon } from "./Icons";

interface Props {
  query: string;
  setQuery: (value: string) => void;
  city: string;
  setCity: (value: string) => void;
  cities: CityCount[];
  source: string;
  setSource: (value: string) => void;
  sources: string[];
  score: string;
  setScore: (value: string) => void;
  experience: ExperienceBucket;
  setExperience: (value: ExperienceBucket) => void;
  dateRange: string;
  setDateRange: (value: string) => void;
  sort: string;
  setSort: (value: string) => void;
  showScores: boolean;
  setShowScores: (value: boolean) => void;
  onReset: () => void;
  shown: number;
  total: number;
}

export default function Filters({
  query,
  setQuery,
  city,
  setCity,
  cities,
  source,
  setSource,
  sources,
  score,
  setScore,
  experience,
  setExperience,
  dateRange,
  setDateRange,
  sort,
  setSort,
  showScores,
  setShowScores,
  onReset,
  shown,
  total,
}: Props) {
  return (
    <section className="filters" aria-label="Job filters">
      <div className="filters-top">
        <div className="search-box">
          <SearchIcon width={17} height={17} className="search-icon" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search role, company, skill or location…"
            aria-label="Search jobs"
          />
          {query ? (
            <button type="button" className="search-clear" onClick={() => setQuery("")} aria-label="Clear search">
              <CloseIcon width={14} height={14} />
            </button>
          ) : null}
        </div>

        <div className="filter-result" aria-live="polite">
          <strong>{shown}</strong>
          <span>of {total} jobs</span>
        </div>
      </div>

      <div className="filter-row">
        <label className="select-wrap">
          <span className="select-label">City</span>
          <select value={city} onChange={(event) => setCity(event.target.value)}>
            <option value="all">All cities</option>
            {cities.map((item) => (
              <option key={item.city} value={item.city}>
                {item.city} ({item.count})
              </option>
            ))}
          </select>
        </label>

        <label className="select-wrap">
          <span className="select-label">Experience</span>
          <select
            value={experience}
            onChange={(event) => setExperience(event.target.value as ExperienceBucket)}
          >
            <option value="all">Any level</option>
            <option value="fresher">Fresher (0–1 yr)</option>
            <option value="mid">Mid (2–5 yrs)</option>
            <option value="senior">Senior (3–8 yrs)</option>
            <option value="lead">Lead / Principal</option>
          </select>
        </label>

        <label className="select-wrap">
          <span className="select-label">Source</span>
          <select value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="all">All sources</option>
            {sources.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>

        <label className="select-wrap">
          <span className="select-label">Match</span>
          <select value={score} onChange={(event) => setScore(event.target.value)}>
            <option value="all">Any score</option>
            <option value="60">60%+</option>
            <option value="70">70%+</option>
            <option value="80">80%+</option>
            <option value="90">90%+</option>
          </select>
        </label>

        <label className="select-wrap">
          <span className="select-label">Posted</span>
          <select value={dateRange} onChange={(event) => setDateRange(event.target.value)}>
            <option value="all">Any time</option>
            <option value="1">Today</option>
            <option value="3">Last 3 days</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
          </select>
        </label>

        <label className="select-wrap">
          <span className="select-label">Sort</span>
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            <option value="score">Best match</option>
            <option value="date">Newest first</option>
            <option value="company">Company A–Z</option>
          </select>
        </label>

        <button
          type="button"
          className={cn("score-toggle", showScores && "is-on")}
          onClick={() => setShowScores(!showScores)}
          aria-pressed={showScores}
        >
          <FilterIcon width={15} height={15} />
          Match score {showScores ? "on" : "off"}
        </button>

        <button type="button" className="reset-btn" onClick={onReset}>
          Reset filters
        </button>
      </div>
    </section>
  );
}
