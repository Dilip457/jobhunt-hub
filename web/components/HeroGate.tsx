import type { CSSProperties } from "react";

interface Props {
  /** The role's colour: the gate he walked through on the way here. */
  accent: string;
}

/**
 * The destination gate from the intro, drawn in CSS beside the title: two
 * posts, the arch, the turning ring and the floor ring, in the role's colour.
 * It turns slowly on its own; nothing here is interactive.
 */
export default function HeroGate({ accent }: Props) {
  return (
    <div className="hero-gate" aria-hidden style={{ "--gate": accent } as CSSProperties}>
      <div className="gate">
        <span className="gate-arch" />
        <span className="gate-ring" />
        <span className="gate-post gate-post-l" />
        <span className="gate-post gate-post-r" />
        <span className="gate-floor" />
      </div>
    </div>
  );
}
