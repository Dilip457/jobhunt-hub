import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { checkRefreshKey, refreshMode } from "../lib/refreshAuth";
import { createKeyedLock, createTtlCache } from "../lib/ttlCache";

describe("refresh key", () => {
  it("requires the exact key when REFRESH_TOKEN is set", () => {
    const env = { REFRESH_TOKEN: "s3cret", NODE_ENV: "production" };
    assert.equal(refreshMode(env), "token");
    assert.equal(checkRefreshKey("s3cret", env), "ok");
    assert.equal(checkRefreshKey("s3cre", env), "invalid");
    assert.equal(checkRefreshKey("s3cretX", env), "invalid");
    assert.equal(checkRefreshKey("", env), "invalid");
    assert.equal(checkRefreshKey(null, env), "invalid");
  });

  it("fails closed in production when REFRESH_TOKEN is unset", () => {
    for (const token of [undefined, ""]) {
      const env = { REFRESH_TOKEN: token, NODE_ENV: "production" };
      assert.equal(refreshMode(env), "disabled");
      assert.equal(checkRefreshKey(null, env), "disabled");
      assert.equal(checkRefreshKey("anything", env), "disabled");
    }
  });

  it("stays open for local development without a token", () => {
    assert.equal(refreshMode({ NODE_ENV: "development" }), "open");
    assert.equal(checkRefreshKey(null, { NODE_ENV: "development" }), "ok");
  });
});

describe("createTtlCache", () => {
  function clock(start = 0) {
    let time = start;
    return { now: () => time, advance: (ms: number) => (time += ms) };
  }

  it("serves the cached value until the TTL passes", async () => {
    const time = clock();
    const cache = createTtlCache<string, number>(1000, time.now);
    let loads = 0;
    const load = async () => ++loads;

    assert.equal(await cache.get("a", load), 1);
    time.advance(999);
    assert.equal(await cache.get("a", load), 1);
    time.advance(1);
    assert.equal(await cache.get("a", load), 2);
    assert.equal(await cache.get("b", load), 3, "keys are cached separately");
  });

  it("shares one pending load between concurrent callers", async () => {
    const cache = createTtlCache<string, number>(1000);
    let loads = 0;
    const load = () => new Promise<number>((resolve) => setTimeout(() => resolve(++loads), 5));
    const [a, b] = await Promise.all([cache.get("k", load), cache.get("k", load)]);
    assert.deepEqual([a, b, loads], [1, 1, 1]);
  });

  it("lets a fresh load replace the cached value for everyone", async () => {
    const cache = createTtlCache<string, number>(60_000);
    let loads = 0;
    const load = async () => ++loads;
    assert.equal(await cache.get("k", load), 1);
    assert.equal(await cache.get("k", load, { fresh: true }), 2);
    assert.equal(await cache.get("k", load), 2);
  });

  it("does not keep a failed load", async () => {
    const cache = createTtlCache<string, number>(60_000);
    await assert.rejects(cache.get("k", async () => Promise.reject(new Error("boom"))));
    assert.equal(await cache.get("k", async () => 7), 7);
  });

  it("can pick the TTL from the value", async () => {
    const time = clock();
    const cache = createTtlCache<string, { demo: boolean; n: number }>(
      (value) => (value.demo ? 100 : 1000),
      time.now,
    );
    let n = 0;
    await cache.get("k", async () => ({ demo: true, n: ++n }));
    time.advance(101);
    const next = await cache.get("k", async () => ({ demo: false, n: ++n }));
    assert.equal(next.n, 2, "a short-lived (fallback) value expires sooner");
  });
});

describe("createKeyedLock", () => {
  it("lets one caller in per key until released or expired", () => {
    let time = 0;
    const lock = createKeyedLock(60_000, () => time);
    assert.equal(lock.tryAcquire("genai"), true);
    assert.equal(lock.tryAcquire("genai"), false);
    assert.equal(lock.tryAcquire("ba"), true, "other roles are not blocked");
    lock.release("genai");
    assert.equal(lock.tryAcquire("genai"), true);
    time += 60_000;
    assert.equal(lock.tryAcquire("genai"), true, "the lock frees itself");
  });
});

// lib/github.ts reads its configuration when it loads, so set it first.
process.env.GITHUB_REPO = "owner/repo";
process.env.GITHUB_TOKEN = "test-token";
const github = await import("../lib/github");

interface FakeRun {
  id: number;
  status: string;
  conclusion: string | null;
  display_title: string;
  created_at: string;
  updated_at: string;
  html_url: string;
}

function run(id: number, createdAt: string, extra: Partial<FakeRun> = {}): FakeRun {
  return {
    id,
    status: "completed",
    conclusion: "success",
    display_title: "Scrape genai",
    created_at: createdAt,
    updated_at: createdAt,
    html_url: `https://github.com/owner/repo/actions/runs/${id}`,
    ...extra,
  };
}

const realFetch = globalThis.fetch;
let fetchCalls = 0;
function serveRuns(runs: FakeRun[]) {
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ workflow_runs: runs }), { status: 200 });
  }) as typeof fetch;
}

describe("run status since a dispatch", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("treats runs from before the dispatch as not started yet", () => {
    const since = Date.parse("2026-11-01T10:00:00.800Z");
    assert.equal(github.createdSince({ created_at: "2026-11-01T10:00:01Z" }, since), true);
    // GitHub truncates to the second; allow for that and a little clock skew.
    assert.equal(github.createdSince({ created_at: "2026-11-01T10:00:00Z" }, since), true);
    assert.equal(github.createdSince({ created_at: "2026-11-01T09:59:52Z" }, since), true);
    assert.equal(github.createdSince({ created_at: "2026-11-01T09:59:40Z" }, since), false);
    assert.equal(github.createdSince({ created_at: "not a date" }, since), false);
  });

  it("reports queued, not the previous run's result, until the new run is listed", async () => {
    const previous = run(1, "2026-11-01T08:00:00Z", { conclusion: "failure" });
    serveRuns([previous]);
    const since = Date.parse("2026-11-01T10:00:00Z");

    const waiting = await github.getRunStatus("genai", { since, fresh: true });
    assert.equal(waiting.state, "queued");
    assert.equal(waiting.awaitingRun, true);
    assert.equal(waiting.runUrl, undefined, "no link to the old run");

    const without = await github.getRunStatus("genai", { fresh: true });
    assert.equal(without.state, "failed", "without since, the latest run is reported as before");

    serveRuns([run(2, "2026-11-01T10:00:03Z", { status: "in_progress", conclusion: null }), previous]);
    const started = await github.getRunStatus("genai", { since, fresh: true });
    assert.equal(started.state, "running");
    assert.equal(started.awaitingRun, undefined);
    assert.match(started.runUrl ?? "", /runs\/2$/);
  });

  it("answers status polls from one cached runs listing for a few seconds", async () => {
    serveRuns([run(3, "2026-11-01T09:00:00Z")]);
    await github.getRunStatus("genai", { fresh: true });
    await github.getRunStatus("genai");
    await github.getRunStatus("ba");
    await github.getRunStatus(null);
    assert.equal(fetchCalls, 1);
    await github.getRunStatus("genai", { fresh: true });
    assert.equal(fetchCalls, 2, "fresh bypasses the cache");
  });
});
