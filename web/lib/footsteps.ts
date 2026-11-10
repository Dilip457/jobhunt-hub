/**
 * Footstep timing read from the character's own feet.
 *
 * The walk clip is sampled once at load to learn how high each foot swings;
 * from then on every frame feeds a foot's height to its detector, which
 * reports a step the moment the foot comes back down after a swing. Reading
 * the skeleton rather than the clip's time means the steps stay in sync when
 * the clip is retimed to the travel speed, and nothing has to know which
 * frame of the clip is a heel strike.
 */
export interface StepThresholds {
  /** Above this height the foot counts as swinging. */
  lift: number;
  /** Back below this height after a swing is a step. */
  contact: number;
}

/**
 * Thresholds from a foot's heights across one walk cycle, or null when the
 * foot barely moves (an idle pose), so no steps are reported.
 */
export function stepThresholds(heights: number[], minSwing = 0.01): StepThresholds | null {
  if (heights.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const height of heights) {
    if (height < min) min = height;
    if (height > max) max = height;
  }
  const range = max - min;
  if (!(range >= minSwing)) return null;
  return { lift: min + range * 0.45, contact: min + range * 0.12 };
}

export interface StepDetector {
  /** Feed the foot's current height; true on the frame it lands. */
  update(height: number): boolean;
  /** Forget a swing in progress, e.g. when the character is repositioned. */
  reset(): void;
}

export function createStepDetector({ lift, contact }: StepThresholds): StepDetector {
  let swinging = false;
  return {
    update(height) {
      if (!swinging) {
        if (height > lift) swinging = true;
        return false;
      }
      if (height < contact) {
        swinging = false;
        return true;
      }
      return false;
    },
    reset() {
      swinging = false;
    },
  };
}
