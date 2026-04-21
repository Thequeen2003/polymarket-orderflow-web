import type { BookSnapshot } from './orderflowMetrics';
import { classifyPtbControlSignal, type PtbControlSignal } from './ptbControlSignal';
import { computePtbDwellMs } from './ptbTimePersistence';
import {
  analyzePtbReaction,
  type PtbReactionAnalysis,
  type PtbReactionKind,
  type SpotCandle,
  type SpotTick,
} from './spotVsPtb';

export type { PtbControlSignal } from './ptbControlSignal';

/** Where the last print sits vs PTB ± interaction band. */
export type PtbSideLabel = 'ABOVE' | 'BELOW' | 'AT';

/** Bucket-close streak direction (OHLC). */
export type CandleMomentumLabel = 'UP' | 'DOWN' | 'NEUTRAL';

/**
 * Coarse **structure** at / vs PTB (engine-native).
 * Maps from the richer `PtbReactionKind` into the four user-facing buckets + probes/extensions/hover.
 */
export type PtbStructureEvent = 'reject' | 'break_and_hold' | 'probe' | 'extension' | 'hover' | 'drift' | 'chop';

/** Legacy strip tag (UI); kept for charts that still show “interaction”. */
export type PtbInteractionSummary = 'rejection' | 'hold' | 'break' | 'hover' | 'drift';

export type PtbCoreEngineInput = {
  /** Live prints `{ t ms, v USD }` — irregular spacing. */
  ticks: SpotTick[];
  /** Bucketed OHLC for the same window as `ticks` (caller chooses bucket count). */
  candles: SpotCandle[];
  /** Fixed price-to-beat for this market round (USD). */
  ptbUsd: number;
  bookFlow?: BookSnapshot[];
};

export type PtbDerivedMetrics = {
  lastPriceUsd: number;
  distanceUsd: number;
  distancePct: number;
  position: PtbSideLabel;
  /** OLS on last tick window: $/s (then ×60 for $/min). */
  slopeUsdPerSec: number;
  slopeUsdPerMin: number;
  slopeSampleCount: number;
  slopeWindowMs: number;
  timeAboveMs: number;
  timeBelowMs: number;
  timeAtMs: number;
  dwellMajoritySign: -1 | 0 | 1;
  dwellAboveRatio: number;
  momentum: CandleMomentumLabel;
  momentumStreak: number;
};

export type PtbCoreEngineSnapshot = {
  ptbUsd: number;
  bandEpsUsd: number;
  derived: PtbDerivedMetrics;
  reaction: PtbReactionAnalysis;
  structureEvent: PtbStructureEvent;
  structureEventLabel: string;
  interaction: PtbInteractionSummary;
  interactionLabel: string;
  signal: { control: PtbControlSignal; blurb: string };
};

const EVENT_LABELS: Record<PtbStructureEvent, string> = {
  reject: 'Reject — failed hold through PTB',
  break_and_hold: 'Break and hold — cleared band, staying on side',
  probe: 'Probe — early separation; confirm vs reclaim',
  extension: 'Extension — follow-through after PTB contact',
  hover: 'Hover — on / negotiating the line',
  drift: 'Drift — no decisive PTB story in this window',
  chop: 'Chop — repeated crosses, no clean control',
};

function positionFromDistance(dist: number, eps: number): PtbSideLabel {
  if (Math.abs(dist) <= eps) return 'AT';
  return dist > 0 ? 'ABOVE' : 'BELOW';
}

function ohlcMomentum(candles: SpotCandle[], minStreak = 2): { momentum: CandleMomentumLabel; streak: number } {
  if (candles.length === 0) return { momentum: 'NEUTRAL', streak: 0 };
  const last = candles[candles.length - 1]!;
  const lastBull = last.c >= last.o;
  let streak = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i]!;
    const bull = c.c >= c.o;
    if (bull === lastBull) streak++;
    else break;
  }
  if (streak < minStreak) return { momentum: 'NEUTRAL', streak };
  return { momentum: lastBull ? 'UP' : 'DOWN', streak };
}

/**
 * Least-squares slope dv/dt on the trailing tick window (`$` per second).
 * Robust to irregular RTDS spacing; returns 0 when time variance is negligible.
 */
export function computeTickSlopeUsdPerSec(ticks: SpotTick[], maxSamples = 72): {
  slopeUsdPerSec: number;
  slopeUsdPerMin: number;
  windowMs: number;
  n: number;
} {
  if (ticks.length < 2) return { slopeUsdPerSec: 0, slopeUsdPerMin: 0, windowMs: 0, n: 0 };
  const slice = ticks.length > maxSamples ? ticks.slice(-maxSamples) : ticks;
  const n = slice.length;
  if (n < 2) return { slopeUsdPerSec: 0, slopeUsdPerMin: 0, windowMs: 0, n };
  const t0 = slice[0]!.t;
  let sumT = 0;
  let sumV = 0;
  let sumTT = 0;
  let sumTV = 0;
  for (const p of slice) {
    const t = (p.t - t0) / 1000;
    sumT += t;
    sumV += p.v;
    sumTT += t * t;
    sumTV += t * p.v;
  }
  const denom = n * sumTT - sumT * sumT;
  if (Math.abs(denom) < 1e-18) return { slopeUsdPerSec: 0, slopeUsdPerMin: 0, windowMs: slice[n - 1]!.t - t0, n };
  const slopeUsdPerSec = (n * sumTV - sumT * sumV) / denom;
  return {
    slopeUsdPerSec,
    slopeUsdPerMin: slopeUsdPerSec * 60,
    windowMs: slice[n - 1]!.t - t0,
    n,
  };
}

export function structureEventFromReactionKind(kind: PtbReactionKind): PtbStructureEvent {
  switch (kind) {
    case 'choppy_at_line':
      return 'chop';
    case 'rejecting_off_line':
      return 'reject';
    case 'break_hold':
      return 'break_and_hold';
    case 'break_probe':
      return 'probe';
    case 'extension_confirming':
      return 'extension';
    case 'touching':
    case 'holding_at_line':
      return 'hover';
    case 'approaching_touch':
      return 'drift';
    case 'drifting_no_interaction':
    default:
      return 'drift';
  }
}

function legacyInteractionFromKind(kind: PtbReactionKind): { interaction: PtbInteractionSummary; label: string } {
  switch (kind) {
    case 'rejecting_off_line':
      return { interaction: 'rejection', label: 'Rejection — tested PTB, failed to hold through' };
    case 'break_hold':
      return { interaction: 'hold', label: 'Hold — cleared PTB band and staying on side' };
    case 'break_probe':
      return { interaction: 'break', label: 'Break / probe — separation forming, confirm extension' };
    case 'extension_confirming':
      return { interaction: 'break', label: 'Extension — follow-through after PTB contact' };
    case 'touching':
    case 'holding_at_line':
    case 'choppy_at_line':
      return { interaction: 'hover', label: 'At line — negotiate / chop; no clean edge yet' };
    case 'approaching_touch':
      return { interaction: 'hover', label: 'Approaching PTB — not at interaction yet' };
    case 'drifting_no_interaction':
    default:
      return { interaction: 'drift', label: 'Drift — no decisive PTB story in this window' };
  }
}

/**
 * Single entry: live ticks + bucketed candles + fixed PTB → derived metrics, structure event, control signal.
 */
export function runPtbCoreEngine(input: PtbCoreEngineInput): PtbCoreEngineSnapshot {
  const { ticks, candles, ptbUsd, bookFlow } = input;
  const reaction = analyzePtbReaction({ pts: ticks, candles, level: ptbUsd, bookFlow });
  const eps = reaction.eps;
  const lastPriceUsd = ticks.length ? ticks[ticks.length - 1]!.v : ptbUsd;
  const distanceUsd = lastPriceUsd - ptbUsd;
  const distancePct = Math.abs(ptbUsd) > 1e-12 ? (distanceUsd / ptbUsd) * 100 : 0;
  const position = positionFromDistance(distanceUsd, eps);
  const { momentum, streak } = ohlcMomentum(candles);
  const dwell = computePtbDwellMs(ticks, ptbUsd, eps);
  const totalDwell = dwell.totalMs;
  const dwellAboveRatio = totalDwell > 0 ? dwell.aboveMs / totalDwell : 0;
  const slope = computeTickSlopeUsdPerSec(ticks);
  const structureEvent = structureEventFromReactionKind(reaction.kind);
  const { interaction, label: interactionLabel } = legacyInteractionFromKind(reaction.kind);
  const { signal: control, blurb } = classifyPtbControlSignal({
    position,
    momentum,
    interaction,
    reaction,
    dwellAboveMs: dwell.aboveMs,
    dwellBelowMs: dwell.belowMs,
    dwellAtMs: dwell.atMs,
    distanceUsd,
    slopeUsdPerSec: slope.slopeUsdPerSec,
  });

  return {
    ptbUsd,
    bandEpsUsd: eps,
    derived: {
      lastPriceUsd,
      distanceUsd,
      distancePct,
      position,
      slopeUsdPerSec: slope.slopeUsdPerSec,
      slopeUsdPerMin: slope.slopeUsdPerMin,
      slopeSampleCount: slope.n,
      slopeWindowMs: slope.windowMs,
      timeAboveMs: dwell.aboveMs,
      timeBelowMs: dwell.belowMs,
      timeAtMs: dwell.atMs,
      dwellMajoritySign: dwell.dwellMajoritySign,
      dwellAboveRatio,
      momentum,
      momentumStreak: streak,
    },
    reaction,
    structureEvent,
    structureEventLabel: EVENT_LABELS[structureEvent],
    interaction,
    interactionLabel,
    signal: { control, blurb },
  };
}
