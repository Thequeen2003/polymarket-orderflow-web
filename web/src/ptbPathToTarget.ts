import type { ProbMicrostructure } from './ptbAdvancedContext';
import type { PtbTargetGap } from './ptbTargetEngine';

export type PtbReachTier = 'High' | 'Med' | 'Low';

export type PtbPathToTarget = {
  reach: PtbReachTier;
  /** One-line for UI */
  line: string;
  /** Approximate waypoints in implied space (labels only, not a promise). */
  pathSketch: string[];
  desiredLabel: string;
};

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/**
 * Probability-style “odds of reaching target band before invalidation,” not certainty.
 */
export function computePtbPathToTarget(params: {
  lane: 'up' | 'down';
  nowProb: number;
  /** From target engine */
  next01: number;
  lo01: number;
  hi01: number;
  wall01: number | null;
  gap: PtbTargetGap | null;
  speedLabel: 'SLOW' | 'MED' | 'FAST';
  speedScore01: number;
  micro: ProbMicrostructure | null;
  /** Cents of clearance to wall (probability space). */
  wallClearanceCents: number | null;
}): PtbPathToTarget {
  const { lane, nowProb, next01, lo01, hi01, wall01, speedLabel, speedScore01, micro, wallClearanceCents } = params;
  const gap = params.gap;

  const desired = clamp01((hi01 + next01) / 2);
  const desiredLabel = `${(desired * 100).toFixed(1)}¢`;

  let score = 50;
  if (speedLabel === 'FAST') score += 18;
  else if (speedLabel === 'MED') score += 8;
  else score -= 6;
  score += speedScore01 * 22;
  if (gap?.active) score += 12 + (gap.strength10 ?? 0) * 0.8;
  else if (gap) score += 3;
  if (wall01 != null) {
    const room = (wall01 - nowProb) * 100;
    if (room >= 8) score += 8;
    else if (room >= 4) score += 2;
    else score -= 14;
  }
  if (wallClearanceCents != null && wallClearanceCents < 4) score -= 12;

  if (micro) {
    score -= micro.jumpRisk01 * 38;
    if (micro.takeoverRisk === 'high') score -= 22;
    else if (micro.takeoverRisk === 'med') score -= 10;
    if (micro.bothLegsChaotic) score -= 18;
  }

  const reach: PtbReachTier = score >= 62 ? 'High' : score >= 38 ? 'Med' : 'Low';

  const mid1 = clamp01(nowProb + (next01 - nowProb) * 0.45);
  const mid2 = clamp01(next01 + (desired - next01) * 0.55);
  const pathSketch = [
    fmt(mid1),
    fmt(mid2),
    fmt(Math.min(desired, wall01 != null ? wall01 - 0.003 : desired)),
  ];

  const line = `Reach ${reach} — tape/gap ${speedLabel} · room vs wall ${wallClearanceCents != null ? `~${wallClearanceCents.toFixed(1)}¢` : '—'}`;

  void lane;
  void lo01;

  return { reach, line, pathSketch, desiredLabel };
}

function fmt(p: number): string {
  return `${(clamp01(p) * 100).toFixed(1)}¢`;
}
