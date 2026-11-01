import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterSearch, knownOrAll, parseFilterParams } from "../lib/filters";
import { compareNewest, jobDateLabels, postedWithinDays } from "../lib/utils";

const parse = (query: string) => parseFilterParams(new URLSearchParams(query));

describe("parseFilterParams", () => {
  it("falls back to the default for values the menus cannot show", () => {
    const filters = parse("?exp=junk&days=abc&score=55&sort=random&page=-2");
    assert.equal(filters.experience, "all");
    assert.equal(filters.dateRange, "all");
    assert.equal(filters.score, "all");
    assert.equal(filters.sort, "score");
    assert.equal(filters.page, 1);
  });

  it("keeps every value the menus offer", () => {
    const filters = parse("q=react&city=Pune&source=Naukri&score=80&exp=fresher&days=7&sort=date&page=3");
    assert.deepEqual(filters, {
      query: "react",
      city: "Pune",
      source: "Naukri",
      score: "80",
      experience: "fresher",
      dateRange: "7",
      sort: "date",
      page: 3,
    });
  });

  it("round-trips through filterSearch and leaves defaults out", () => {
    const query = "q=react&city=Pune&exp=mid&days=30&sort=company&page=2";
    assert.equal(filterSearch(parse(query)), query);
    assert.equal(filterSearch(parse("exp=junk&city=")), "");
  });
});

describe("knownOrAll", () => {
  it("drops a city or source no loaded job has", () => {
    assert.equal(knownOrAll("Nowhere", ["Pune", "Bengaluru"]), "all");
    assert.equal(knownOrAll("Pune", ["Pune", "Bengaluru"]), "Pune");
    assert.equal(knownOrAll("all", []), "all");
  });
});

describe("dates fall back to first_seen", () => {
  const now = new Date(2026, 10, 10, 12).getTime(); // 10 Nov 2026, local noon
  const undated = { posted_date: null, first_seen: "2026-11-09" };
  const posted = { posted_date: "2026-10-01", first_seen: "2026-11-09" };

  it("filters a job with no posted date by when it was first seen", () => {
    assert.equal(postedWithinDays(undated, 3, now), true);
    assert.equal(postedWithinDays(undated, 1, now), false);
    assert.equal(postedWithinDays(posted, 30, now), false, "a real posted date still wins");
    assert.equal(postedWithinDays({ posted_date: null, first_seen: null }, 30, now), false);
  });

  it("sorts newest first on the same date", () => {
    const jobs = [
      { id: "old", posted_date: "2026-10-01", first_seen: "2026-11-09" },
      { id: "none", posted_date: null, first_seen: null },
      { id: "seen", posted_date: null, first_seen: "2026-11-08" },
      { id: "new", posted_date: "2026-11-10", first_seen: "2026-11-10" },
    ];
    assert.deepEqual(
      jobs.sort(compareNewest).map((job) => job.id),
      ["new", "seen", "old", "none"],
    );
  });

  it("labels the card with first seen when the board gave no date", () => {
    assert.equal(jobDateLabels(undated).posted, null);
    assert.match(jobDateLabels(undated).seen ?? "", /^First seen /);
    assert.match(jobDateLabels(posted).posted ?? "", /^Posted /);
  });
});
