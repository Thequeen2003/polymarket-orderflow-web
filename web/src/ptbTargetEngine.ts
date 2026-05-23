/**
 * PTB Target: where the controlling implied leg is likely to move next,
 * from tape speed, gaps, parsed walls, candle breaks, and top-of-book pressure.
 */

import { pickBookLevels } from './bookLevels';

export type PtbTargetGap = {
  lo: number;
  hi: number;
  strength10: number;
  active: boolean;
  exitWall: number | null;
} | null;

export type PtbTargetMomentum = 'Strong' | 'Medium' | 'Weak';

export type PtbTargetReversalRisk = 'Low' | 'Medium' | 'High';

export type PtbTargetEngineCard = {
  side: 'UP' | 'DOWN';
  nowLabel: string;
  momentum: PtbTargetMomentum;
  nextTargetLabel: string;
  targetRangeLabel: string;
  firstWallLabel: string;
  reversalRisk: PtbTargetReversalRisk;
  summaryLine: string;
  /** Target engine lane (same as `side` mapped to chart). */
  engineLane: 'up' | 'down';
  /** Projection endpoints in that lane’s probability (0–1). */
  next01: number;
  lo01: number;
  hi01: number;
  wall01: number | null;
};

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function fmtCentsLabel(c: number): string {
  const r = Math.round(c * 10) / 10;
  return Math.abs(r - Math.round(r)) < 1e-6 ? `${Math.round(r)}¢` : `${r.toFixed(1)}¢`;
}

function fmtProb01(p: number): string {
  return fmtCentsLabel(clamp01(p) * 100);
}

/** Bid-heavy → positive; ask-heavy → negative. */
export function topBookBias01(book: unknown): number | null {
  try {
    const { bids, asks } = pickBookLevels(book);
    const sum = (arr: { size: number }[], n: number) =>
      arr.slice(0, n).reduce((s, l) => s + Math.max(0, l.size), 0);
    const b = sum(bids, 5);
    const a = sum(asks, 5);
    if (b + a < 1e-6) return null;
    const x = (b - a) / (b + a);
    return Math.max(-1, Math.min(1, x)); // bid-heavy → positive
  } catch {
    return null;
  }
}

function slopeCloses(closes: number[]): number {
  if (closes.length < 2) return 0;
  const a = closes[0]!;
  const b = closes[closes.length - 1]!;
  return (b - a) / Math.max(1, closes.length - 1);
}

function laneReversingToward50(p: number, closes: number[]): boolean {
  const tail = closes.map(clamp01).slice(-8);
  if (tail.length < 4) return false;
  const s = slopeCloses(tail);
  const stall = 0.0011;
  if (p >= 0.5) return s < -stall;
  return s > stall;
}

/** Leading implied leg (farther from 50¢; ties → gap strength / tape). Use for chart anchor. */
export function pickWinningChartLane(params: {
  lastU: number;
  lastD: number;
  gapU: PtbTargetGap;
  gapD: PtbTargetGap;
  upRising: boolean;
  dnRising: boolean;
}): 'up' | 'down' {
  const { lastU, lastD, gapU, gapD, upRising, dnRising } = params;
  const du = Math.abs(lastU - 0.5);
  const dd = Math.abs(lastD - 0.5);
  if (Math.abs(du - dd) < 0.018) {
    const su = (gapU?.strength10 ?? 0) + (gapU?.active ? 2 : 0) + (upRising ? 1.2 : 0);
    const sd = (gapD?.strength10 ?? 0) + (gapD?.active ? 2 : 0) + (dnRising ? 1.2 : 0);
    if (Math.abs(su - sd) >= 0.12) return su > sd ? 'up' : 'down';
    if (lastU > lastD + 1e-6) return 'up';
    if (lastD > lastU + 1e-6) return 'down';
    if (gapU?.active && !gapD?.active) return 'up';
    if (gapD?.active && !gapU?.active) return 'down';
    return du > dd ? 'up' : du < dd ? 'down' : 'up';
  }
  return du > dd ? 'up' : du < dd ? 'down' : lastU >= lastD ? 'up' : 'down';
}

function momentumTier(params: {
  speedLabel: 'SLOW' | 'MED' | 'FAST';
  speedScore01: number;
  rising: boolean;
  gap: PtbTargetGap;
  pressure: boolean;
  bias: number | null;
  lane: 'up' | 'down';
}): PtbTargetMomentum {
  const { speedLabel, speedScore01, rising, gap, pressure, bias, lane } = params;
  let s = 0;
  if (speedLabel === 'FAST') s += 2.4;
  else if (speedLabel === 'MED') s += 1.3;
  else s += 0.35;
  s += speedScore01 * 1.35;
  if (rising) s += 1.5;
  if (gap?.active) s += 1.35;
  else if (gap) s += 0.45;
  s += (gap?.strength10 ?? 0) * 0.09;
  if (pressure) s += 0.85;
  if (bias != null) {
    const aligns = lane === 'up' ? bias > 0.08 : bias < -0.08;
    if (aligns && rising) s += 0.55;
    if (!aligns && bias != null && Math.abs(bias) > 0.18) s -= 0.45;
  }
  if (s >= 4.2) return 'Strong';
  if (s >= 2.5) return 'Medium';
  return 'Weak';
}

/**
 * Live dual-leg PTB target: projects the controlling outcome’s implied mid forward.
 */
export function computePtbTargetEngine(params: {
  lastU: number;
  lastD: number;
  upRising: boolean;
  dnRising: boolean;
  gapU: PtbTargetGap;
  gapD: PtbTargetGap;
  speedLabel: 'SLOW' | 'MED' | 'FAST';
  speedScore01: number;
  closesUp: number[];
  closesDown: number[];
  breakUp: number | null;
  breakDown: number | null;
  pressureUp: boolean;
  pressureDown: boolean;
  bookUp: unknown;
  bookDown: unknown;
  /** From `computeProbMicrostructure` — damps targets when jumps / opposing takeover dominate. */
  probMicro?: { takeoverRisk: 'low' | 'med' | 'high'; jumpRisk01: number } | null;
}): PtbTargetEngineCard {
  const lane = pickWinningChartLane(params);
  const p = lane === 'up' ? clamp01(params.lastU) : clamp01(params.lastD);
  const gap = lane === 'up' ? params.gapU : params.gapD;
  const rising = lane === 'up' ? params.upRising : params.dnRising;
  const br = lane === 'up' ? params.breakUp : params.breakDown;
  const pressure = lane === 'up' ? params.pressureUp : params.pressureDown;
  const book = lane === 'up' ? params.bookUp : params.bookDown;
  const closes = lane === 'up' ? params.closesUp : params.closesDown;

  const bias = topBookBias01(book);
  const momentum = momentumTier({
    speedLabel: params.speedLabel,
    speedScore01: clamp01(params.speedScore01),
    rising,
    gap,
    pressure,
    bias,
    lane,
  });

  const wall = gap?.exitWall != null ? clamp01(gap.exitWall) : null;
  const gapHi = gap != null ? clamp01(gap.hi) : null;

  const reversing = laneReversingToward50(p, closes);

  let stepProb =
    momentum === 'Strong' ? 0.042 + params.speedScore01 * 0.028 : momentum === 'Medium' ? 0.028 + params.speedScore01 * 0.018 : 0.016 + params.speedScore01 * 0.01;

  if (!rising) stepProb *= 0.55;
  if (reversing) stepProb *= 0.45;
  if (gap?.active && gapHi != null && gapHi > p) stepProb += 0.012;

  const pm = params.probMicro;
  if (pm && pm.jumpRisk01 > 0.45) {
    stepProb *= Math.max(0.42, 1 - pm.jumpRisk01 * 0.62);
  }

  let nextProb = p + stepProb;
  if (br != null && br > p + 0.004) nextProb = Math.max(nextProb, Math.min(br + 0.008, p + 0.09));
  if (gapHi != null && gapHi > p) nextProb = Math.max(nextProb, p + (gapHi - p) * (momentum === 'Weak' ? 0.35 : 0.55));

  const wallCap = wall != null ? wall - 0.004 : 0.97;
  nextProb = Math.min(nextProb, wallCap);
  if (gapHi != null) nextProb = Math.min(nextProb, gapHi + (momentum === 'Strong' ? 0.015 : 0.008));
  nextProb = clamp01(Math.max(nextProb, p + 0.004));

  const band =
    momentum === 'Strong' ? 0.024 : momentum === 'Medium' ? 0.017 : 0.011;
  let lo = clamp01(nextProb - band * 0.55);
  let hi = clamp01(nextProb + band * 0.45);
  lo = Math.min(lo, nextProb);
  hi = Math.max(hi, nextProb);
  lo = Math.max(lo, p);
  if (wall != null) hi = Math.min(hi, wall - 0.002);
  if (!(hi > lo + 0.003)) {
    lo = clamp01(p + 0.003);
    hi = clamp01(Math.min(lo + band, wallCap));
  }

  const oppGap = lane === 'up' ? params.gapD : params.gapU;
  const near50 = Math.abs(p - 0.5) < 0.035;

  let reversalRisk: PtbTargetReversalRisk = 'Medium';
  if (reversing || (momentum === 'Weak' && !rising) || near50) reversalRisk = 'High';
  else if (momentum === 'Weak') reversalRisk = 'Medium';
  else if (momentum === 'Strong' && params.speedLabel === 'FAST' && rising && !near50) reversalRisk = 'Low';
  else if (momentum === 'Strong' && rising) reversalRisk = 'Low';
  else if (oppGap?.active && (gap == null || !gap.active)) reversalRisk = 'High';
  else reversalRisk = params.speedLabel === 'SLOW' ? 'Medium' : 'Low';

  if (pm?.takeoverRisk === 'high') {
    if (reversalRisk === 'Low') reversalRisk = 'Medium';
    else if (reversalRisk === 'Medium') reversalRisk = 'High';
  } else if (pm?.takeoverRisk === 'med' && reversalRisk === 'Low') {
    reversalRisk = 'Medium';
  }

  const wallLabel = wall != null ? fmtProb01(wall) : '—';

  const side: 'UP' | 'DOWN' = lane === 'up' ? 'UP' : 'DOWN';
  const summaryLine = `PTB target (${side}): now ${fmtProb01(p)} → ${fmtProb01(nextProb)} · ${momentum} · wall ${wallLabel} · rev ${reversalRisk}`;

  const engineLane: 'up' | 'down' = lane;

  return {
    side,
    nowLabel: fmtProb01(p),
    momentum,
    nextTargetLabel: fmtProb01(nextProb),
    targetRangeLabel: `${fmtProb01(lo)}–${fmtProb01(hi)}`,
    firstWallLabel: wallLabel,
    reversalRisk,
    summaryLine,
    engineLane,
    next01: nextProb,
    lo01: lo,
    hi01: hi,
    wall01: wall,
  };
}
