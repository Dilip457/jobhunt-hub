/**
 * Trades render resolution for frame rate.
 *
 * A WebGL scene is drawn at `ratio` × CSS pixels. The governor is fed every
 * frame's duration; once a window of frames is in, it decides from two
 * readings: the mean frame time and the share of frames that ran long (a
 * scene at the edge of its budget alternates 16 ms and 33 ms frames, which
 * barely moves the mean but is what a viewer notices as stutter).
 *
 * - Over `slowMs`, or more than `slowShare` long frames: step down at once.
 * - Under `fastMs` with no long frame at all: step up, but only after
 *   `cooldownMs` without a change. A step up that has to be reverted within
 *   `holdMs` doubles the cool-down (up to `maxCooldownMs`), so a scene that
 *   cannot sustain the higher ratio stops flapping between the two.
 *
 * Display refresh paces frames to its interval (16.7 ms at 60 Hz), so a
 * comfortable scene reads as mean ≈ interval with no long frames; the
 * thresholds are set around that, not around zero.
 */
export interface QualityOptions {
  /** Starting ratio; also the ceiling the governor never exceeds. */
  start: number;
  min: number;
  /** Frames per decision. */
  window?: number;
  /** Mean frame time above which resolution drops (ms). */
  slowMs?: number;
  /** A frame longer than this counts as long (ms). */
  longFrameMs?: number;
  /** Share of long frames in a window above which resolution drops. */
  slowShare?: number;
  /** Mean frame time below which resolution may recover (ms). */
  fastMs?: number;
  stepDown?: number;
  stepUp?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
  /** A step up reverted sooner than this doubles the cool-down. */
  holdMs?: number;
  /** A frame longer than this is a stall (tab switch, GC), not render cost. */
  ignoreOverMs?: number;
}

export interface QualityGovernor {
  readonly ratio: number;
  /** Record one frame; returns the new ratio when it changed, else null. */
  sample(frameMs: number): number | null;
}

export function createQualityGovernor(options: QualityOptions): QualityGovernor {
  const {
    start,
    min,
    window = 30,
    slowMs = 21,
    longFrameMs = 28,
    slowShare = 0.15,
    fastMs = 18,
    stepDown = 0.15,
    stepUp = 0.1,
    cooldownMs = 3000,
    maxCooldownMs = 60000,
    holdMs = 10000,
    ignoreOverMs = 500,
  } = options;
  const max = start;
  const clamp = (value: number) => Math.min(max, Math.max(min, Math.round(value * 100) / 100));

  let ratio = clamp(start);
  let sum = 0;
  let count = 0;
  let longFrames = 0;
  let cooldown = cooldownMs;
  let sinceChangeMs = cooldown;
  let lastWasUp = false;

  return {
    get ratio() {
      return ratio;
    },
    sample(frameMs) {
      if (!(frameMs > 0) || frameMs > ignoreOverMs) return null;
      sum += frameMs;
      count += 1;
      sinceChangeMs += frameMs;
      if (frameMs > longFrameMs) longFrames += 1;
      if (count < window) return null;
      const mean = sum / count;
      const share = longFrames / count;
      sum = 0;
      count = 0;
      longFrames = 0;

      let next = ratio;
      let up = false;
      if ((mean > slowMs || share > slowShare) && ratio > min) {
        next = clamp(ratio - stepDown);
        // Reverting a recent step up: the higher ratio does not hold here.
        if (lastWasUp && sinceChangeMs < holdMs) cooldown = Math.min(maxCooldownMs, cooldown * 2);
      } else if (mean < fastMs && share === 0 && ratio < max && sinceChangeMs >= cooldown) {
        next = clamp(ratio + stepUp);
        up = true;
      }
      if (next === ratio) return null;
      ratio = next;
      lastWasUp = up;
      sinceChangeMs = 0;
      return ratio;
    },
  };
}
