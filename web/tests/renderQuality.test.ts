import test from "node:test";
import assert from "node:assert/strict";
import { createQualityGovernor } from "../lib/renderQuality";

type Governor = ReturnType<typeof createQualityGovernor>;

function feed(governor: Governor, frameMs: number | number[], frames: number) {
  const changes: number[] = [];
  const pattern = Array.isArray(frameMs) ? frameMs : [frameMs];
  for (let i = 0; i < frames; i += 1) {
    const next = governor.sample(pattern[i % pattern.length]);
    if (next !== null) changes.push(next);
  }
  return changes;
}

test("slow frames lower the ratio one step per window, down to the floor", () => {
  const governor = createQualityGovernor({ start: 1.5, min: 0.7, window: 30 });
  assert.deepEqual(feed(governor, 40, 29), []);
  assert.deepEqual(feed(governor, 40, 1), [1.35]);
  assert.deepEqual(feed(governor, 40, 30), [1.2]);
  feed(governor, 40, 30 * 10);
  assert.equal(governor.ratio, 0.7);
  assert.deepEqual(feed(governor, 40, 30), []);
});

test("a stuttering scene steps down even when its mean looks fine", () => {
  const governor = createQualityGovernor({ start: 1.0, min: 0.7, window: 30 });
  // One doubled frame in five: mean 20 ms, which is under the 21 ms line.
  assert.deepEqual(feed(governor, [16.7, 16.7, 16.7, 16.7, 33.4], 30), [0.85]);
});

test("a vsync-paced scene with no long frames recovers after the cool-down", () => {
  const governor = createQualityGovernor({ start: 1.5, min: 0.7, window: 30, cooldownMs: 3000 });
  feed(governor, 40, 30);
  assert.equal(governor.ratio, 1.35);
  // 16.7 ms frames are what 60 Hz looks like when the scene is comfortable.
  assert.deepEqual(feed(governor, 16.7, 30), []);
  feed(governor, 16.7, 180);
  assert.equal(governor.ratio, 1.45);
  feed(governor, 16.7, 30 * 40);
  assert.equal(governor.ratio, 1.5);
});

test("one long frame in a window blocks the step up", () => {
  const governor = createQualityGovernor({ start: 1.5, min: 0.7, window: 30, cooldownMs: 0 });
  feed(governor, 40, 30);
  assert.equal(governor.ratio, 1.35);
  const frames = Array(29).fill(16.7).concat([30]);
  assert.deepEqual(feed(governor, frames, 30), []);
  assert.equal(governor.ratio, 1.35);
});

test("a step up that does not hold doubles the cool-down", () => {
  const governor = createQualityGovernor({ start: 1.0, min: 0.7, window: 30, cooldownMs: 1000 });
  feed(governor, 40, 30);
  assert.equal(governor.ratio, 0.85);
  // Comfortable at 0.85: one step up per second (60 frames) back to 1.0 ...
  feed(governor, 16.7, 120);
  assert.equal(governor.ratio, 1.0);
  // ... which stutters, so it drops again and the cool-down becomes 2 s.
  feed(governor, [16.7, 16.7, 16.7, 16.7, 33.4], 30);
  assert.equal(governor.ratio, 0.85);
  feed(governor, 16.7, 90);
  assert.equal(governor.ratio, 0.85, "1.5 s of good frames is no longer enough");
  feed(governor, 16.7, 30);
  assert.equal(governor.ratio, 0.95);
});

test("frames in the comfortable band change nothing", () => {
  const governor = createQualityGovernor({ start: 1.5, min: 0.7, window: 30 });
  assert.deepEqual(feed(governor, 18, 300), []);
  assert.equal(governor.ratio, 1.5);
});

test("stalls and bad samples are ignored", () => {
  const governor = createQualityGovernor({ start: 1.5, min: 0.7, window: 30 });
  for (let i = 0; i < 29; i += 1) governor.sample(10);
  // A 900 ms tab switch does not count as a slow frame or complete the window.
  assert.equal(governor.sample(900), null);
  assert.equal(governor.sample(Number.NaN), null);
  assert.equal(governor.sample(0), null);
  assert.equal(governor.sample(10), null);
  assert.equal(governor.ratio, 1.5);
});
