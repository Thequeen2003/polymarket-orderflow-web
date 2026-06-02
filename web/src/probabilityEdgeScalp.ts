/**
 * Statistical-arb scalp layer: trade mispricing P_model − P_mkt, filtered by momentum + PTB.
 */

import type { BinaryOutcomeEstimate } from './binaryOutcomeBias';
import { normalizedSpotMomentum, ptbDistanceRatio } from './binaryOutcomeBias';

export const EDGE_TRADE_THRESHOLD = 0.03;

export type ScalpWeights = {
  edge: number;
  momentumNorm: number;
  ptbDistance: number;
};

export const DEFAULT_SCALP_WEIGHTS: ScalpWeights = {
  edge: 12,
  momentumNorm: 0.22,
  ptbDistance: 4500,
};

export const DEFAULT_SCALP_THETA = 0.38;

/** Large |Δ_PTB| (fractional) — market stretched vs anchor. */
export const PTB_STRETCH_RATIO = 0.00085;

export type EdgeTradeSide = 'LONG_UP' | 'LONG_DOWN' | 'NO_TRADE';

export type PtbStretchSetup =
  | 'TREND_LONG'
  | 'MEAN_REVERT_SHORT'
  | 'TREND_SHORT'
  | 'MEAN_REVERT_LONG'
  | 'NEUTRAL';

export type ScalpQuality = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export type ProbabilityEdgeScalp = {
  pMkt: number;
  pModel: number;
  edge: number;
  edgeTrade: EdgeTradeSide;
  edgeTradeLabel: string;
  mNorm: number | null;
  deltaPtb: number | null;
  momentumOk: boolean;
  momentumNote: string;
  ptbSetup: PtbStretchSetup;
  ptbSetupNote: string;
  filteredTrade: EdgeTradeSide;
  filteredLabel: string;
  scalpScore: number;
  scalpTheta: number;
  /** Score > ±θ before execution gates. */
  scoreSignal: EdgeTradeSide;
  scalpSignal: EdgeTradeSide;
  repricingIntoEdge: boolean;
  repricingNote: string;
  quality: ScalpQuality;
  /** Compact desk badges (siglas). */
  siglas: string[];
};

function edgeTradeFromEdge(edge: number, threshold = EDGE_TRADE_THRESHOLD): EdgeTradeSide {
  if (edge > threshold) return 'LONG_UP';
  if (edge < -threshold) return 'LONG_DOWN';
  return 'NO_TRADE';
}

function edgeTradeLabel(side: EdgeTradeSide, upLabel: string, downLabel: string): string {
  if (side === 'LONG_UP') return `BUY ${upLabel} (scalp long)`;
  if (side === 'LONG_DOWN') return `BUY ${downLabel} (scalp short)`;
  return 'NO TRADE — edge inside noise band';
}

export function momentumAlignsWithEdge(edge: number, mNorm: number | null, minAbs = 0.12): {
  ok: boolean;
  note: string;
} {
  if (mNorm == null || !Number.isFinite(mNorm)) {
    return { ok: false, note: 'Need 30s spot history for m_norm filter' };
  }
  if (Math.abs(edge) <= EDGE_TRADE_THRESHOLD) {
    return { ok: true, note: 'No edge trade — momentum filter N/A' };
  }
  if (edge > EDGE_TRADE_THRESHOLD) {
    if (mNorm >= minAbs) return { ok: true, note: 'Edge long + momentum up — high-quality alignment' };
    if (mNorm <= -minAbs) return { ok: false, note: 'Edge long but momentum down — skip (mean-revert trap)' };
    return { ok: false, note: 'Edge long but flat momentum — wait' };
  }
  if (edge < -EDGE_TRADE_THRESHOLD) {
    if (mNorm <= -minAbs) return { ok: true, note: 'Edge short + momentum down — high-quality alignment' };
    if (mNorm >= minAbs) return { ok: false, note: 'Edge short but momentum up — skip (fake fade)' };
    return { ok: false, note: 'Edge short but flat momentum — wait' };
  }
  return { ok: true, note: 'Flat edge' };
}

export function classifyPtbStretchSetup(
  deltaPtb: number | null,
  edge: number,
  stretch = PTB_STRETCH_RATIO,
): { setup: PtbStretchSetup; note: string } {
  if (deltaPtb == null || !Number.isFinite(deltaPtb)) {
    return { setup: 'NEUTRAL', note: 'PTB anchor unavailable' };
  }
  const stretchedUp = deltaPtb >= stretch;
  const stretchedDown = deltaPtb <= -stretch;

  if (stretchedUp && edge > EDGE_TRADE_THRESHOLD) {
    return { setup: 'TREND_LONG', note: 'Large +Δ_PTB + edge long → trend-continuation scalp' };
  }
  if (stretchedUp && edge < -EDGE_TRADE_THRESHOLD) {
    return {
      setup: 'MEAN_REVERT_SHORT',
      note: 'Stretched above PTB + edge short → mean-reversion fade only',
    };
  }
  if (stretchedDown && edge < -EDGE_TRADE_THRESHOLD) {
    return { setup: 'TREND_SHORT', note: 'Large −Δ_PTB + edge short → trend-continuation scalp' };
  }
  if (stretchedDown && edge > EDGE_TRADE_THRESHOLD) {
    return {
      setup: 'MEAN_REVERT_LONG',
      note: 'Stretched below PTB + edge long → mean-reversion bounce only',
    };
  }
  return { setup: 'NEUTRAL', note: 'PTB not stretched vs edge — standard mispricing scalp' };
}

/** Token mid moving toward model (catch repricing, not reversal). */
export function marketRepricingIntoEdge(
  edge: number,
  probUpDelta01: number | null,
): { intoEdge: boolean; note: string } {
  if (probUpDelta01 == null || !Number.isFinite(probUpDelta01)) {
    return { intoEdge: false, note: 'Need projected UP Δ to confirm repricing' };
  }
  if (Math.abs(edge) <= EDGE_TRADE_THRESHOLD) {
    return { intoEdge: false, note: 'No edge — repricing rule idle' };
  }
  if (edge > EDGE_TRADE_THRESHOLD) {
    const into = probUpDelta01 > 0.002;
    return {
      intoEdge: into,
      note: into
        ? 'UP mid rising toward model — repricing into edge'
        : 'UP mid flat/falling — do not lean into reversal',
    };
  }
  const into = probUpDelta01 < -0.002;
  return {
    intoEdge: into,
    note: into
      ? 'UP mid falling toward model — repricing into edge'
      : 'UP mid rising away — wait for catch-up',
  };
}

export function computeScalpScore(
  edge: number,
  mNorm: number | null,
  deltaPtb: number | null,
  weights: ScalpWeights = DEFAULT_SCALP_WEIGHTS,
): number {
  const m = mNorm != null && Number.isFinite(mNorm) ? mNorm : 0;
  const d = deltaPtb != null && Number.isFinite(deltaPtb) ? deltaPtb : 0;
  return weights.edge * edge + weights.momentumNorm * m + weights.ptbDistance * d;
}

export function scalpSignalFromScore(score: number, theta = DEFAULT_SCALP_THETA): EdgeTradeSide {
  if (score > theta) return 'LONG_UP';
  if (score < -theta) return 'LONG_DOWN';
  return 'NO_TRADE';
}

export function buildSiglas(params: {
  edge: number;
  edgeTrade: EdgeTradeSide;
  filteredTrade: EdgeTradeSide;
  scoreSignal: EdgeTradeSide;
  scalpSignal: EdgeTradeSide;
  momentumOk: boolean;
  ptbSetup: PtbStretchSetup;
  repricingIntoEdge: boolean;
  quality: ScalpQuality;
}): string[] {
  const s: string[] = [];
  if (params.edge > EDGE_TRADE_THRESHOLD) s.push('EDGE+');
  else if (params.edge < -EDGE_TRADE_THRESHOLD) s.push('EDGE−');
  else s.push('EDGE≈0');

  if (params.edgeTrade === 'LONG_UP') s.push('RAW↑');
  else if (params.edgeTrade === 'LONG_DOWN') s.push('RAW↓');

  s.push(params.momentumOk ? 'MOM✓' : 'MOM✗');
  s.push(params.repricingIntoEdge ? 'REP+' : 'REP−');

  const ptbSigla: Record<PtbStretchSetup, string> = {
    TREND_LONG: 'PTB↗TR',
    MEAN_REVERT_SHORT: 'PTB↗MR',
    TREND_SHORT: 'PTB↘TR',
    MEAN_REVERT_LONG: 'PTB↘MR',
    NEUTRAL: 'PTB≈',
  };
  s.push(ptbSigla[params.ptbSetup]);

  if (params.filteredTrade === 'LONG_UP') s.push('FIL↑');
  else if (params.filteredTrade === 'LONG_DOWN') s.push('FIL↓');
  else s.push('FIL—');

  if (params.scoreSignal === 'LONG_UP') s.push('SCR↑');
  else if (params.scoreSignal === 'LONG_DOWN') s.push('SCR↓');
  else s.push('SCR—');

  if (params.scalpSignal === 'LONG_UP') s.push('SIG↑');
  else if (params.scalpSignal === 'LONG_DOWN') s.push('SIG↓');
  else s.push('SIG—');

  if (params.quality === 'HIGH') s.push('Q:HI');
  else if (params.quality === 'MEDIUM') s.push('Q:MED');
  else if (params.quality === 'LOW') s.push('Q:LO');

  return s;
}

function deriveQuality(
  edgeTrade: EdgeTradeSide,
  momentumOk: boolean,
  repricingIntoEdge: boolean,
  scalpSignal: EdgeTradeSide,
): ScalpQuality {
  if (scalpSignal === 'NO_TRADE' || edgeTrade === 'NO_TRADE') return 'NONE';
  if (scalpSignal !== edgeTrade && scalpSignal !== 'NO_TRADE') {
    // score disagrees with raw edge — medium at best
    return momentumOk && repricingIntoEdge ? 'MEDIUM' : 'LOW';
  }
  if (momentumOk && repricingIntoEdge && scalpSignal !== 'NO_TRADE') return 'HIGH';
  if (momentumOk || repricingIntoEdge) return 'MEDIUM';
  return 'LOW';
}

export function evaluateProbabilityEdgeScalp(params: {
  estimate: BinaryOutcomeEstimate;
  pMkt: number;
  spotPts: { t: number; v: number }[];
  now: number;
  ptb: number;
  probUpDelta01?: number | null;
  upLabel?: string;
  downLabel?: string;
  edgeThreshold?: number;
  scalpTheta?: number;
  scalpWeights?: ScalpWeights;
}): ProbabilityEdgeScalp | null {
  const pMkt = Math.max(0.01, Math.min(0.99, params.pMkt));
  const pModel = params.estimate.probUp;
  const edge = pModel - pMkt;
  const edgeThreshold = params.edgeThreshold ?? EDGE_TRADE_THRESHOLD;
  const scalpTheta = params.scalpTheta ?? DEFAULT_SCALP_THETA;
  const weights = params.scalpWeights ?? DEFAULT_SCALP_WEIGHTS;
  const upLabel = params.upLabel ?? 'UP';
  const downLabel = params.downLabel ?? 'DOWN';

  const edgeTrade =
    edge > edgeThreshold ? 'LONG_UP' : edge < -edgeThreshold ? 'LONG_DOWN' : 'NO_TRADE';

  const horizonSec = params.estimate.horizonSec;
  const mom = normalizedSpotMomentum(params.spotPts, params.now, horizonSec);
  const deltaPtb = ptbDistanceRatio(params.now, params.ptb);

  const momFilter = momentumAlignsWithEdge(edge, mom.mNorm);
  const ptbClass = classifyPtbStretchSetup(deltaPtb, edge);
  const repricing = marketRepricingIntoEdge(edge, params.probUpDelta01 ?? null);

  let filteredTrade: EdgeTradeSide = edgeTrade;
  if (edgeTrade !== 'NO_TRADE' && !momFilter.ok) filteredTrade = 'NO_TRADE';

  const scalpScore = computeScalpScore(edge, mom.mNorm, deltaPtb, weights);
  const scoreSignal = scalpSignalFromScore(scalpScore, scalpTheta);

  // Execution: score threshold + momentum filter + repricing into edge
  let finalSignal = scoreSignal;
  if (finalSignal !== 'NO_TRADE' && filteredTrade === 'NO_TRADE') finalSignal = 'NO_TRADE';
  if (finalSignal !== 'NO_TRADE' && !repricing.intoEdge) finalSignal = 'NO_TRADE';

  const quality = deriveQuality(edgeTrade, momFilter.ok, repricing.intoEdge, finalSignal);

  let filteredLabel = edgeTradeLabel(filteredTrade, upLabel, downLabel);
  if (edgeTrade !== 'NO_TRADE' && !momFilter.ok) {
    filteredLabel = `BLOCKED — ${momFilter.note}`;
  }

  const siglas = buildSiglas({
    edge,
    edgeTrade,
    filteredTrade,
    scoreSignal,
    scalpSignal: finalSignal,
    momentumOk: momFilter.ok,
    ptbSetup: ptbClass.setup,
    repricingIntoEdge: repricing.intoEdge,
    quality,
  });

  return {
    pMkt,
    pModel,
    edge,
    edgeTrade,
    edgeTradeLabel: edgeTradeLabel(edgeTrade, upLabel, downLabel),
    mNorm: mom.mNorm,
    deltaPtb,
    momentumOk: momFilter.ok,
    momentumNote: momFilter.note,
    ptbSetup: ptbClass.setup,
    ptbSetupNote: ptbClass.note,
    filteredTrade,
    filteredLabel,
    scalpScore,
    scalpTheta,
    scoreSignal,
    scalpSignal: finalSignal,
    repricingIntoEdge: repricing.intoEdge,
    repricingNote: repricing.note,
    quality,
    siglas,
  };
}
