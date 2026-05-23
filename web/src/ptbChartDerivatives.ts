import type { BookSnapshot } from './orderflowMetrics';
import {
  runPtbCoreEngine,
  type CandleMomentumLabel,
  type PtbControlSignal,
  type PtbInteractionSummary,
  type PtbSideLabel,
  type PtbStructureEvent,
} from './ptbCoreEngine';
import type { PtbReactionAnalysis, SpotCandle, SpotTick } from './spotVsPtb';

export type { PtbControlSignal, CandleMomentumLabel, PtbInteractionSummary, PtbSideLabel, PtbStructureEvent } from './ptbCoreEngine';

/**
 * Chart-facing snapshot: same as `runPtbCoreEngine` flattened for deferred UI strips.
 *
 * Pipeline: **ticks + OHLC + fixed PTB** → `runPtbCoreEngine` → derived (distance, slope, dwell, momentum) →
 * structure event (reject / break_and_hold / …) → control signal.
 */

export type PtbChartDerivatives = {
  distanceUsd: number;
  distancePct: number;
  position: PtbSideLabel;
  momentum: CandleMomentumLabel;
  momentumStreak: number;
  interaction: PtbInteractionSummary;
  interactionLabel: string;
  reaction: PtbReactionAnalysis;
  dwellAboveMs: number;
  dwellBelowMs: number;
  dwellAtMs: number;
  dwellMajoritySign: -1 | 0 | 1;
  dwellAboveRatio: number;
  controlSignal: PtbControlSignal;
  controlBlurb: string;
  slopeUsdPerSec: number;
  slopeUsdPerMin: number;
  slopeSampleCount: number;
  slopeWindowMs: number;
  structureEvent: PtbStructureEvent;
  structureEventLabel: string;
};

export function computePtbChartDerivatives(params: {
  pts: SpotTick[];
  candles: SpotCandle[];
  ptb: number;
  bookFlow?: BookSnapshot[];
  lastProbUp?: number | null;
  lastProbDown?: number | null;
}): PtbChartDerivatives {
  const snap = runPtbCoreEngine({
    ticks: params.pts,
    candles: params.candles,
    ptbUsd: params.ptb,
    bookFlow: params.bookFlow,
    lastProbUp: params.lastProbUp,
    lastProbDown: params.lastProbDown,
  });
  const d = snap.derived;
  return {
    distanceUsd: d.distanceUsd,
    distancePct: d.distancePct,
    position: d.position,
    momentum: d.momentum,
    momentumStreak: d.momentumStreak,
    interaction: snap.interaction,
    interactionLabel: snap.interactionLabel,
    reaction: snap.reaction,
    dwellAboveMs: d.timeAboveMs,
    dwellBelowMs: d.timeBelowMs,
    dwellAtMs: d.timeAtMs,
    dwellMajoritySign: d.dwellMajoritySign,
    dwellAboveRatio: d.dwellAboveRatio,
    controlSignal: snap.signal.control,
    controlBlurb: snap.signal.blurb,
    slopeUsdPerSec: d.slopeUsdPerSec,
    slopeUsdPerMin: d.slopeUsdPerMin,
    slopeSampleCount: d.slopeSampleCount,
    slopeWindowMs: d.slopeWindowMs,
    structureEvent: snap.structureEvent,
    structureEventLabel: snap.structureEventLabel,
  };
}
