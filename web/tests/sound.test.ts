import test from "node:test";
import assert from "node:assert/strict";
import { createStepDetector, stepThresholds } from "../lib/footsteps";
import { parseSoundSetting } from "../lib/sound";

/** One walk cycle of foot heights: planted, a swing up to `peak`, planted again. */
function cycle(peak: number, frames = 24): number[] {
  return Array.from({ length: frames }, (_, i) => {
    const t = i / frames;
    return t < 0.5 ? 0 : peak * Math.sin((t - 0.5) * 2 * Math.PI);
  });
}

test("thresholds come from the foot's own swing height", () => {
  const thresholds = stepThresholds(cycle(0.1));
  assert.ok(thresholds);
  assert.ok(thresholds.contact > 0 && thresholds.contact < thresholds.lift);
  assert.ok(thresholds.lift < 0.1);
});

test("a foot that barely moves gives no thresholds, so no steps", () => {
  assert.equal(stepThresholds(cycle(0.004)), null);
  assert.equal(stepThresholds([]), null);
  assert.equal(stepThresholds([0.02, 0.02, 0.02]), null);
});

test("a step is reported once, when the foot comes back down", () => {
  const detector = createStepDetector(stepThresholds(cycle(0.1))!);
  const landings: number[] = [];
  // Three cycles, then the foot planted: the last landing is the frame after the swing.
  const heights = [...cycle(0.1), ...cycle(0.1), ...cycle(0.1), 0];
  heights.forEach((height, frame) => {
    if (detector.update(height)) landings.push(frame);
  });
  assert.equal(landings.length, 3);
  // Each landing is at the end of its cycle's swing, not at lift-off.
  landings.forEach((frame, i) => {
    assert.ok(frame > i * 24 + 12 && frame <= (i + 1) * 24, String(frame));
  });
});

test("a planted foot that jitters below the lift height never steps", () => {
  const detector = createStepDetector({ lift: 0.05, contact: 0.015 });
  for (let i = 0; i < 100; i += 1) {
    assert.equal(detector.update(0.01 + (i % 3) * 0.01), false);
  }
});

test("reset forgets a swing in progress", () => {
  const detector = createStepDetector({ lift: 0.05, contact: 0.015 });
  detector.update(0.08);
  detector.reset();
  assert.equal(detector.update(0), false);
  detector.update(0.08);
  assert.equal(detector.update(0), true);
});

test("sound is on unless the visitor turned it off", () => {
  assert.equal(parseSoundSetting(null), true);
  assert.equal(parseSoundSetting(undefined), true);
  assert.equal(parseSoundSetting("on"), true);
  assert.equal(parseSoundSetting("garbage"), true);
  assert.equal(parseSoundSetting("off"), false);
});
