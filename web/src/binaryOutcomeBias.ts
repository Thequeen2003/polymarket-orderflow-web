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
