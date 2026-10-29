import { SparkIcon } from "./Icons";

/**
 * Brand mark used in the intro topbar, boot screen and dashboard header.
 *
 * The cube is CSS 3D rather than a second WebGL canvas so the boot screen
 * stays cheap. The spark sits on the front and back faces, and the gentle
 * ±28° rock keeps the front spark visible throughout the loop.
 */
export default function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span className="brand-mark-glow" />
      <span className="brand-3d">
        <span className="brand-cube">
          <span className="brand-face brand-face-front">
            <SparkIcon width={11} height={11} />
          </span>
          <span className="brand-face brand-face-back">
            <SparkIcon width={11} height={11} />
          </span>
          <span className="brand-face brand-face-right" />
          <span className="brand-face brand-face-left" />
          <span className="brand-face brand-face-top" />
          <span className="brand-face brand-face-bottom" />
        </span>
      </span>
    </span>
  );
}
