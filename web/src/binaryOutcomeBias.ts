/**
 * Binary contract: Y = 1 iff settlement spot finishes above PTB at expiry.
 * Model estimates P(Y=1) = σ(w₁Δ_PTB + w₂m_norm + w₃S + w₄r), not raw price.
 */

export type SpotTick = { t: number; v: number };

export type BinaryBiasWeights = {
  ptbDistance: number;
  momentumNorm: number;
  impliedSkew: number;
  stabilityPressure: number;
};

export const DEFAULT_BINARY_BIAS_WEIGHTS: BinaryBiasWeights = {
  ptbDistance: 3.0,
  momentumNorm: 1.2,
  impliedSkew: 1.5,
  stabilityPressure: 0.9,
};

export type BinaryBiasSignalId = 'ptbDistance' | 'momentumNorm' | 'impliedSkew' | 'stabilityPressure';

export type BinaryBiasSignal = {
  id: BinaryBiasSignalId;
  label: string;
  /** Raw formula value (before tanh). */
  raw: number;
  /** Bounded contribution input (−1..1). */
  bounded: number;
  weight: number;
  /** weight × bounded — drives score. */
  contribution: number;
  formula: string;
  interpretation: string;
};

export type BinaryOutcomeEstimate = {
  /** P(spot > PTB at bell). */
  probUp: number;
  probDown: number;
  score: number;
  weights: BinaryBiasWeights;
  horizonSec: number;
  signals: BinaryBiasSignal[];
  /** Book-implied UP mid when available (compare to model). */
  marketImpliedUp: number | null;
  marketSkewS: number | null;
  missing: string[];
};

export type SettlementBiasWarningLevel = 'none' | 'watch' | 'alert' | 'critical';

export type SettlementBiasWarning = {
  level: SettlementBiasWarningLevel;
  favoredLane: 'up' | 'down';
  favoredLabel: string;
  favoredProbPct: number;
  edgePp: number | null;
  headline: string;
  detail: string;
  action: string;
};

export type SettlementBiasMomentumTier = 'flat' | 'weak' | 'moderate' | 'strong';

export type SettlementBiasSideMomentum = {
  scorePct: number;
  tier: SettlementBiasMomentumTier;
  /** Side tape is moving (gaining or losing). */
  active: boolean;
  /** True when this side's mid is rising on the window. */
  gaining: boolean;
};

export type SettlementBiasDualReadout = {
  finish: {
    lane: 'up' | 'down';
    label: string;
    probPct: number;
    upProbPct: number;
    downProbPct: number;
    headline: string;
    subline: string;
  };
  momentum: {
    upLabel: string;
    downLabel: string;
    up: SettlementBiasSideMomentum;
    down: SettlementBiasSideMomentum;
    favoredLane: 'up' | 'down' | 'flat';
    favoredLabel: string;
    subline: string;
    /** True when spot or contract tape shows a directional push worth surfacing. */
    active: boolean;
    source: 'spot' | 'tape' | 'none';
  };
  /** Finish lane matches live momentum leader. */
  aligned: boolean;
  splitNote: string | null;
};

function sideMomentumTier(scorePct: number): SettlementBiasMomentumTier {
  const edge = Math.abs(scorePct - 50);
  if (edge < 4) return 'flat';
  if (scorePct >= 78 || scorePct <= 22) return 'strong';
  if (scorePct >= 62 || scorePct <= 38) return 'moderate';
  return 'weak';
}

function momentumFavoredLane(upScorePct: number, downScorePct: number): 'up' | 'down' | 'flat' {
  const d = upScorePct - downScorePct;
  if (d > 4) return 'up';
  if (d < -4) return 'down';
  return 'flat';
}

const MOMENTUM_ACTIVE_BOUNDED = 0.08;
const MOMENTUM_WEAK_BOUNDED = 0.04;
const TAPE_DELTA_NOISE = 0.00025;

/** Per-side tape push: rising mid → score above 50, falling → below 50. */
export function sideMomentumFromDelta(
  delta01: number | null | undefined,
  spotAssist: number,
): { scorePct: number; active: boolean; gaining: boolean; source: 'tape' | 'spot' | 'none' } {
  if (delta01 != null && Number.isFinite(delta01) && Math.abs(delta01) >= TAPE_DELTA_NOISE) {
    const b = tanhBounded(delta01, 0.01);
    const active = Math.abs(b) >= MOMENTUM_WEAK_BOUNDED;
    const scorePct = 50 + b * 50;
    return { scorePct, active, gaining: b > 0, source: 'tape' };
  }
  if (Math.abs(spotAssist) >= MOMENTUM_ACTIVE_BOUNDED) {
    const scorePct = 50 + spotAssist * 50;
    return { scorePct, active: true, gaining: spotAssist > 0, source: 'spot' };
  }
  return { scorePct: 50, active: false, gaining: false, source: 'none' };
}

/** @deprecated Use sideMomentumFromDelta per outcome lane. */
export function contractTapeMomentumBounded(
  probDeltaUp01: number | null | undefined,
  probDeltaDown01: number | null | undefined,
): number | null {
  const up = sideMomentumFromDelta(probDeltaUp01, 0);
  if (up.source === 'tape') return tanhBounded(probDeltaUp01!, 0.01);
  const dn = sideMomentumFromDelta(probDeltaDown01, 0);
  if (dn.source === 'tape') return tanhBounded(probDeltaDown01!, 0.01);
  return probDeltaUp01 == null && probDeltaDown01 == null ? null : 0;
}

/** Finish probability + complementary up/down momentum scores (spot B) or contract tape when spot is quiet. */
export function buildSettlementBiasDualReadout(args: {
  estimate: BinaryOutcomeEstimate;
  upLabel?: string;
  downLabel?: string;
  probDeltaUp01?: number | null;
  probDeltaDown01?: number | null;
}): SettlementBiasDualReadout {
  const upLabel = (args.upLabel ?? 'UP').trim() || 'UP';
  const downLabel = (args.downLabel ?? 'DOWN').trim() || 'DOWN';
  const finishLane: 'up' | 'down' = args.estimate.probUp >= 0.5 ? 'up' : 'down';
  const finishLabel = finishLane === 'up' ? upLabel : downLabel;
  const finishProb = finishLane === 'up' ? args.estimate.probUp : args.estimate.probDown;

  const momSig = args.estimate.signals.find((s) => s.id === 'momentumNorm');
  const spotBounded = momSig?.bounded ?? 0;

  const upLive = sideMomentumFromDelta(args.probDeltaUp01, spotBounded);
  const downLive = sideMomentumFromDelta(args.probDeltaDown01, -spotBounded);

  const upScorePct = upLive.scorePct;
  const downScorePct = downLive.scorePct;

  const upMom: SettlementBiasSideMomentum = {
    scorePct: upScorePct,
    tier: upLive.active ? sideMomentumTier(upScorePct) : 'flat',
    active: upLive.active,
    gaining: upLive.gaining,
  };
  const downMom: SettlementBiasSideMomentum = {
    scorePct: downScorePct,
    tier: downLive.active ? sideMomentumTier(downScorePct) : 'flat',
    active: downLive.active,
    gaining: downLive.gaining,
  };

  const momentumActive = upLive.active || downLive.active;
  const momentumSource: 'spot' | 'tape' | 'none' =
    upLive.source === 'tape' || downLive.source === 'tape'
      ? 'tape'
      : upLive.source === 'spot' || downLive.source === 'spot'
        ? 'spot'
        : 'none';

  const momentumFavored = momentumActive ? momentumFavoredLane(upScorePct, downScorePct) : 'flat';
  const momentumFavoredLabel =
    momentumFavored === 'up' ? upLabel : momentumFavored === 'down' ? downLabel : 'Flat';

  const aligned = momentumFavored !== 'flat' && finishLane === momentumFavored;

  const finishHeadline = `${finishLabel} wins at bell`;
  const finishSubline = `${(finishProb * 100).toFixed(1)}% finish score — best side to hold through expiry`;

  const horizonSec = args.estimate.horizonSec;
  const pushWord = momentumSource === 'tape' ? 'contract tape' : 'spot drift';
  const momentumSubline = !momentumActive
    ? `Quiet ${horizonSec}s window — finish score drives the read`
    : momentumFavored === 'up'
      ? `${upLabel} gaining on ${pushWord} · ${downLabel} fading`
      : momentumFavored === 'down'
        ? `${downLabel} gaining on ${pushWord} · ${upLabel} fading`
        : `Mixed ${pushWord} — finish score drives the read`;

  let splitNote: string | null = null;
  if (momentumFavored !== 'flat' && !aligned) {
    const momWord = momentumFavored === 'up' ? 'lifting' : 'sliding';
    splitNote = `Split: finish favors ${finishLabel} (${(finishProb * 100).toFixed(0)}%) but tape is ${momWord} ${momentumFavoredLabel} — don't confuse bell odds with the live push.`;
  }

  return {
    finish: {
      lane: finishLane,
      label: finishLabel,
      probPct: finishProb * 100,
      upProbPct: args.estimate.probUp * 100,
      downProbPct: args.estimate.probDown * 100,
      headline: finishHeadline,
      subline: finishSubline,
    },
    momentum: {
      upLabel,
      downLabel,
      up: upMom,
      down: downMom,
      favoredLane: momentumFavored,
      favoredLabel: momentumFavoredLabel,
      subline: momentumSubline,
      active: momentumActive,
      source: momentumSource,
    },
    aligned,
    splitNote,
  };
}

/** Desk settlement lean vs book — surfaces early warning when model diverges from CLOB. */
export function buildSettlementBiasWarning(args: {
  estimate: BinaryOutcomeEstimate;
  marketUp01: number | null;
  upLabel?: string;
  downLabel?: string;
  probDeltaUp01?: number | null;
  probDeltaDown01?: number | null;
}): SettlementBiasWarning {
  const upLabel = (args.upLabel ?? 'UP').trim() || 'UP';
  const downLabel = (args.downLabel ?? 'DOWN').trim() || 'DOWN';
  const favoredLane: 'up' | 'down' = args.estimate.probUp >= 0.5 ? 'up' : 'down';
  const favoredProb = favoredLane === 'up' ? args.estimate.probUp : args.estimate.probDown;
  const favoredLabel = favoredLane === 'up' ? upLabel : downLabel;
  const edgePp =
    args.marketUp01 != null && Number.isFinite(args.marketUp01)
      ? (args.estimate.probUp - args.marketUp01) * 100
      : null;
  const strength = Math.max(args.estimate.probUp, args.estimate.probDown);
  const absEdge = edgePp != null ? Math.abs(edgePp) : 0;

  let level: SettlementBiasWarningLevel = 'none';
  if (absEdge >= 12 || (strength >= 0.8 && absEdge >= 8)) level = 'critical';
  else if (absEdge >= 8 || strength >= 0.72) level = 'alert';
  else if (absEdge >= 5 || strength >= 0.65) level = 'watch';

  const pct = (favoredProb * 100).toFixed(1);
  const dual = buildSettlementBiasDualReadout({
    estimate: args.estimate,
    upLabel,
    downLabel,
    probDeltaUp01: args.probDeltaUp01,
    probDeltaDown01: args.probDeltaDown01,
  });
  const headline =
    level === 'none'
      ? dual.splitNote != null
        ? `Finish ${dual.finish.label} ${pct}% · momentum ${dual.momentum.favoredLabel}`
        : `${dual.finish.label} finish ${pct}%`
      : dual.splitNote != null
        ? `EARLY WARNING — finish ${dual.finish.label} ${pct}% vs ${dual.momentum.favoredLabel} push`
        : `EARLY WARNING — ${favoredLabel} finish ${pct}%`;

  const detail =
    edgePp != null
      ? `Model vs book: ${edgePp >= 0 ? '+' : ''}${edgePp.toFixed(1)}pp on ${upLabel} · score ${args.estimate.score >= 0 ? '+' : ''}${args.estimate.score.toFixed(2)}`
      : `Model score ${args.estimate.score >= 0 ? '+' : ''}${args.estimate.score.toFixed(2)}`;

  const cheapLane = edgePp != null && edgePp > 4 ? upLabel : edgePp != null && edgePp < -4 ? downLabel : null;
  const action =
    level === 'none'
      ? 'Tape aligned with desk model — no urgent settlement mismatch.'
      : cheapLane
        ? `${cheapLane} looks cheap vs settlement model — watch for catch-up repricing before the jump.`
        : `${favoredLabel} path dominates — don't chase wide ask; time entry on lag or bid.`;

  return {
    level,
    favoredLane,
    favoredLabel,
    favoredProbPct: favoredProb * 100,
    edgePp,
    headline,
    detail,
    action,
  };
}

function sigmoid(x: number): number {
  if (x >= 20) return 1;
  if (x <= -20) return 0;
  return 1 / (1 + Math.exp(-x));
}

function tanhBounded(x: number, scale: number): number {
  if (!Number.isFinite(x) || scale <= 0) return 0;
  return Math.tanh(x / scale);
}

/** Δ_PTB = (P_now − P_PTB) / P_PTB */
export function ptbDistanceRatio(now: number, ptb: number): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(ptb) || ptb <= 0) return null;
  return (now - ptb) / ptb;
}

function spotAtOrBefore(pts: SpotTick[], targetMs: number): number | null {
  if (!pts.length) return null;
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    if (p.t <= targetMs && Number.isFinite(p.v)) return p.v;
  }
  return Number.isFinite(pts[0]!.v) ? pts[0]!.v : null;
}

/** Robust σ from close-to-close moves in the last `windowMs`. */
export function spotSigmaWindow(pts: SpotTick[], windowMs = 30_000): number | null {
  const clean = pts.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
  if (clean.length < 3) return null;
  const tEnd = clean[clean.length - 1]!.t;
  const tStart = tEnd - windowMs;
  const window = clean.filter((p) => p.t >= tStart);
  if (window.length < 2) return null;

  const diffs: number[] = [];
  for (let i = 1; i < window.length; i++) {
    diffs.push(window[i]!.v - window[i - 1]!.v);
  }
  if (!diffs.length) return null;

  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const variance = diffs.reduce((a, d) => a + (d - mean) ** 2, 0) / diffs.length;
  const sigma = Math.sqrt(variance);
  const ptbScale = Math.abs(window[window.length - 1]!.v) * 1e-5;
  return Math.max(sigma, ptbScale, 0.05);
}

/** m_norm = (P_t − P_{t−Δ}) / σ_Δ */
export function normalizedSpotMomentum(
  pts: SpotTick[],
  now: number,
  horizonSec = 30,
): { mNorm: number | null; mRaw: number | null; sigma: number | null } {
  if (!Number.isFinite(now) || !pts.length) return { mNorm: null, mRaw: null, sigma: null };
  const tNow = pts[pts.length - 1]!.t;
  const pPast = spotAtOrBefore(pts, tNow - horizonSec * 1000);
  if (pPast == null) return { mNorm: null, mRaw: null, sigma: null };
  const mRaw = now - pPast;
  const sigma = spotSigmaWindow(pts, horizonSec * 1000);
  if (sigma == null || sigma <= 0) return { mNorm: null, mRaw, sigma: null };
  return { mNorm: mRaw / sigma, mRaw, sigma };
}

/** S = 2·p_up − 1 (UP token mid as probability). */
export function impliedSkewS(pUp01: number | null): number | null {
  if (pUp01 == null || !Number.isFinite(pUp01)) return null;
  const p = Math.max(0.01, Math.min(0.99, pUp01));
  return 2 * p - 1;
}

/**
 * r = (P_t − P_PTB) / (P_{t+Δ} − P_t)
 * r < 0 → mean-revert toward PTB; r > 0 → continuation away from PTB on that move.
 */
export function stabilityPressureR(
  now: number,
  ptb: number,
  forwardDeltaUsd: number,
  bandUsd?: number | null,
): number | null {
  if (!Number.isFinite(now) || !Number.isFinite(ptb) || !Number.isFinite(forwardDeltaUsd)) return null;
  const num = now - ptb;
  const floor = Math.max(Math.abs(bandUsd ?? 0) * 0.08, Math.abs(ptb) * 2e-5, 0.25);
  const denom =
    Math.abs(forwardDeltaUsd) >= floor
      ? forwardDeltaUsd
      : forwardDeltaUsd >= 0
        ? floor
        : -floor;
  if (Math.abs(denom) < 1e-9) return null;
  return num / denom;
}

export function estimateBinaryOutcomeBias(params: {
  now: number;
  ptb: number;
  spotPts: SpotTick[];
  pUp01?: number | null;
  slopeUsdPerSec?: number | null;
  bandUsd?: number | null;
  horizonSec?: number;
  weights?: BinaryBiasWeights;
}): BinaryOutcomeEstimate | null {
  const { now, ptb, spotPts } = params;
  if (!Number.isFinite(now) || !Number.isFinite(ptb) || ptb <= 0) return null;

  const horizonSec = params.horizonSec ?? 30;
  const weights = params.weights ?? DEFAULT_BINARY_BIAS_WEIGHTS;
  const missing: string[] = [];

  const deltaPtb = ptbDistanceRatio(now, ptb);
  const mom = normalizedSpotMomentum(spotPts, now, horizonSec);
  const pUp =
    params.pUp01 != null && Number.isFinite(params.pUp01)
      ? Math.max(0.01, Math.min(0.99, params.pUp01))
      : null;
  const skewS = impliedSkewS(pUp);

  const slope = params.slopeUsdPerSec ?? null;
  let forwardDelta =
    slope != null && Number.isFinite(slope) ? slope * horizonSec : mom.mRaw ?? null;
  if (forwardDelta == null && mom.mRaw != null) forwardDelta = mom.mRaw;
  const r = stabilityPressureR(now, ptb, forwardDelta ?? 0, params.bandUsd ?? null);

  const signals: BinaryBiasSignal[] = [];

  if (deltaPtb != null) {
    const bounded = tanhBounded(deltaPtb, 0.0015);
    signals.push({
      id: 'ptbDistance',
      label: 'A) PTB distance Δ_PTB',
      raw: deltaPtb,
      bounded,
      weight: weights.ptbDistance,
      contribution: weights.ptbDistance * bounded,
      formula: '(P_now − P_PTB) / P_PTB',
      interpretation:
        bounded > 0.15
          ? 'Above equilibrium → UP settlement bias'
          : bounded < -0.15
            ? 'Below equilibrium → DOWN settlement bias'
            : 'Near PTB — weak anchor',
    });
  } else missing.push('PTB distance');

  if (mom.mNorm != null) {
    const bounded = tanhBounded(mom.mNorm, 1.25);
    signals.push({
      id: 'momentumNorm',
      label: 'B) Micro momentum m_norm',
      raw: mom.mNorm,
      bounded,
      weight: weights.momentumNorm,
      contribution: weights.momentumNorm * bounded,
      formula: `(P_t − P_{t−${horizonSec}s}) / σ_${horizonSec}s`,
      interpretation:
        bounded > 0.2
          ? 'Normalized drift up — move is real vs noise'
          : bounded < -0.2
            ? 'Normalized drift down'
            : 'Flat / noisy drift',
    });
  } else missing.push('Momentum');

  if (skewS != null) {
    const bounded = skewS;
    signals.push({
      id: 'impliedSkew',
      label: 'C) Implied skew S',
      raw: skewS,
      bounded,
      weight: weights.impliedSkew,
      contribution: weights.impliedSkew * bounded,
      formula: '2·p_up − 1',
      interpretation:
        bounded > 0.1
          ? 'UP token dominates the book'
          : bounded < -0.1
            ? 'DOWN token dominates the book'
            : 'Balanced mids',
    });
  } else missing.push('Implied skew');

  if (r != null && Number.isFinite(r)) {
    const bounded = tanhBounded(r, 1.5);
    signals.push({
      id: 'stabilityPressure',
      label: 'D) Stability pressure r',
      raw: r,
      bounded,
      weight: weights.stabilityPressure,
      contribution: weights.stabilityPressure * bounded,
      formula: `(P_t − P_PTB) / (P_{t+Δ} − P_t)`,
      interpretation:
        bounded > 0.2
          ? 'Continuation pressure (trend)'
          : bounded < -0.2
            ? 'Mean-revert pressure (fade)'
            : 'Mixed / chop',
    });
  } else missing.push('Stability r');

  if (!signals.length) return null;

  const score = signals.reduce((s, x) => s + x.contribution, 0);
  const probUp = sigmoid(score);

  return {
    probUp,
    probDown: 1 - probUp,
    score,
    weights,
    horizonSec,
    signals,
    marketImpliedUp: pUp,
    marketSkewS: skewS,
    missing,
  };
}
