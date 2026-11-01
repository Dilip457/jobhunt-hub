"use client";

import { DATE_OPTIONS, EXPERIENCE_OPTIONS, SCORE_OPTIONS, SORT_OPTIONS, type FilterOption } from "@/lib/filters";
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

function renderOptions(options: FilterOption[]) {
  return options.map((option) => (
    <option key={option.value} value={option.value}>
      {option.label}
    </option>
  ));
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
            {renderOptions(EXPERIENCE_OPTIONS)}
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
            {renderOptions(SCORE_OPTIONS)}
          </select>
        </label>

        <label className="select-wrap">
          <span className="select-label">Posted</span>
          <select value={dateRange} onChange={(event) => setDateRange(event.target.value)}>
            {renderOptions(DATE_OPTIONS)}
          </select>
        </label>

        <label className="select-wrap">
          <span className="select-label">Sort</span>
          <select value={sort} onChange={(event) => setSort(event.target.value)}>
            {renderOptions(SORT_OPTIONS)}
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
