/**
 * Brand mark: "Next Step". Three isometric steps, the top one in blue, with a
 * red dot climbing them, step by step: the next move.
 *
 * Used in the intro topbar, the boot screen, the static intro and the
 * dashboard header. It is CSS 3D rather than a second WebGL canvas so the
 * boot screen stays cheap; everything is sized in em from the mark's own
 * font-size, so the same markup works at 42px and 36px. Under reduced motion
 * the dot rests on the top step.
 */
export default function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span className="brand-glow" />
      <span className="brand-iso">
        <span className="brand-step brand-step-1">
          <span className="brand-step-top" />
          <span className="brand-step-front" />
          <span className="brand-step-side" />
        </span>
        <span className="brand-step brand-step-2">
          <span className="brand-step-top" />
          <span className="brand-step-front" />
          <span className="brand-step-side" />
        </span>
        <span className="brand-step brand-step-3">
          <span className="brand-step-top" />
          <span className="brand-step-front" />
          <span className="brand-step-side" />
        </span>
        <span className="brand-dot" />
      </span>
    </span>
  );
}
