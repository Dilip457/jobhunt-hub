import test from "node:test";
import assert from "node:assert/strict";
import type { Job } from "../lib/types";
import { matchBands, newJobs, rankJobs, scoreAxes, topMatch } from "../lib/rank";

let counter = 0;
function job(overrides: Partial<Job>): Job {
  counter += 1;
  return {
    id: String(counter),
    title: "Software Engineer",
    company: `Company ${counter}`,
    location: "Pune",
    url: `https://example.test/${counter}`,
    source: "Naukri",
    posted_date: "2026-10-28",
    score: 70,
    experience_source: "text",
    ...overrides,
  };
}

test("SDE keeps the 3–8 year band ahead of a higher-scored senior listing", () => {
  const inBand = job({ score: 80, experience_min: 4, experience_max: 7 });
  const senior = job({ score: 92, experience_min: 12, experience_max: 15 });
  const ranked = rankJobs([senior, inBand], "sde");
  assert.equal(ranked[0], inBand);
  assert.equal(topMatch([senior, inBand], "sde"), inBand);
});

test("roles without an experience rule rank by score alone", () => {
  const low = job({ score: 61 });
  const high = job({ score: 88 });
  assert.deepEqual(rankJobs([low, high], "data"), [high, low]);
});

test("newJobs keeps only is_new, best first", () => {
  const a = job({ score: 70, is_new: true });
  const b = job({ score: 90, is_new: true });
  const c = job({ score: 95, is_new: false });
  assert.deepEqual(newJobs([a, b, c], "genai"), [b, a]);
  assert.equal(topMatch([], "genai"), null);
});

test("scoreAxes reads the published parts in display order and drops placeholders", () => {
  assert.deepEqual(scoreAxes({}), []);
  assert.deepEqual(scoreAxes({ score_parts: { role: 0, skill: 0, experience: 0, tool: 0, domain: 0 } }), []);
  const axes = scoreAxes({ score_parts: { experience: 100, skill: 33.3, role: 50 } });
  assert.deepEqual(
    axes.map((axis) => [axis.key, axis.value]),
    [
      ["role", 50],
      ["skill", 33.3],
      ["experience", 100],
    ],
  );
  assert.equal(axes[0].label, "Role fit");
  assert.deepEqual(
    scoreAxes({ score_parts: { role: 140, skill: -5 } }).map((axis) => axis.value),
    [100, 0],
  );
});

test("matchBands counts every job exactly once", () => {
  const jobs = [95, 90, 89.5, 80, 72, 60, 59, 12].map((score) => ({ score }));
  const bands = matchBands(jobs);
  assert.deepEqual(
    bands.map((band) => [band.label, band.count]),
    [
      ["90+", 2],
      ["80–89", 2],
      ["70–79", 1],
      ["60–69", 1],
      ["Under 60", 2],
    ],
  );
  assert.equal(
    bands.reduce((sum, band) => sum + band.count, 0),
    jobs.length,
  );
});
