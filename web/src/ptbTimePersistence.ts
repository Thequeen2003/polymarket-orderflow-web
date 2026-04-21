import type { SpotTick } from './spotVsPtb';

export type PtbDwellSummary = {
  aboveMs: number;
  belowMs: number;
  atMs: number;
  totalMs: number;
  /** Which side accumulated the most clock time (ties → 0). */
  dwellMajoritySign: -1 | 0 | 1;
};

/**
 * Time spent above / below / inside the PTB ±eps band from consecutive tick segments.
 * Uses midpoint of each segment vs the band (stable for irregular RTDS spacing).
 */
export function computePtbDwellMs(pts: SpotTick[], level: number, eps: number): PtbDwellSummary {
  if (pts.length < 2 || !Number.isFinite(level) || !Number.isFinite(eps) || eps <= 0) {
    return { aboveMs: 0, belowMs: 0, atMs: 0, totalMs: 0, dwellMajoritySign: 0 };
  }
  let aboveMs = 0;
  let belowMs = 0;
  let atMs = 0;
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1]!;
    const p1 = pts[i]!;
    const dt = Math.max(0, p1.t - p0.t);
    if (dt <= 0) continue;
    const mid = (p0.v + p1.v) / 2;
    if (mid > level + eps) aboveMs += dt;
    else if (mid < level - eps) belowMs += dt;
    else atMs += dt;
  }
  const totalMs = aboveMs + belowMs + atMs;
  let dwellMajoritySign: -1 | 0 | 1 = 0;
  if (totalMs > 0) {
    if (aboveMs > belowMs && aboveMs > atMs) dwellMajoritySign = 1;
    else if (belowMs > aboveMs && belowMs > atMs) dwellMajoritySign = -1;
    else dwellMajoritySign = 0;
  }
  return { aboveMs, belowMs, atMs, totalMs, dwellMajoritySign };
}
