import { scoreTier } from "@/lib/utils";

interface Props {
  score: number;
  size?: number;
}

export default function ScoreRing({ score, size = 46 }: Props) {
  const tier = scoreTier(score);
  const angle = Math.max(0, Math.min(100, score)) * 3.6;

  return (
    <div
      className="score-ring"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(${tier.color} ${angle}deg, rgba(148, 163, 184, 0.14) ${angle}deg)`,
      }}
      title={`${Math.round(score)}% — ${tier.label}`}
      aria-label={`Match score ${Math.round(score)} percent`}
    >
      <span className="score-ring-inner">{Math.round(score)}</span>
    </div>
  );
}
