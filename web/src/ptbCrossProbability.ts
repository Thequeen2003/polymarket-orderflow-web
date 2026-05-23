/**
 * Estimate the probability that spot will *cross* the fixed PTB line at least once
 * between now and round end. Pure functions only, no React, easy to unit-test.
 *
 * Model: arithmetic Brownian motion with drift `μ` ($/sec) and volatility `σ` ($/√sec).
 * For a barrier crossing of a continuous GBM-like path, the closed form is:
 *
 *   If S0 > K (spot above PTB, asking P(min ≤ K)):
 *     P = Φ((K − S0 − μT)/(σ√T)) + exp(2 μ (K − S0) / σ²) · Φ((K − S0 + μT)/(σ√T))
 *
 *   If S0 < K (spot below PTB, asking P(max ≥ K)):
 *     symmetric — flip the sign of (S0 − K) and the drift.
 *
 * We use this as an approximation for short windows (≤ 4h) to give the user a single
 * number — “there’s a 70% chance we cross PTB before the bell” — that is far more
 * actionable than “drift is UP” alone.
 */

export type Tick = { t: number; v: number };

export type PtbCrossEstimate = {
  /** P(cross at least once before round end), in 0..1. */
  prob: number;
  /** "stay above" / "stay below" / "uncertain" for the user-facing label. */
  bias: 'stay-above' | 'stay-below' | 'uncertain';
  /** $/sec drift used in the model (signed). */
  driftUsdPerSec: number;
  /** $/√sec volatility used in the model. */
  volUsdPerSqrtSec: number;
  /** Time remaining (sec) used in the model. */
  horizonSec: number;
  /** Distance to PTB at the start ($). Negative when spot below PTB. */
  distanceUsd: number;
  /** Confidence in the estimate: low if vol/drift sample size is tiny. */
  confidence: 'high' | 'med' | 'low';
  /** Short human-readable summary. */
  summary: string;
};

const NULL_ESTIMATE: PtbCrossEstimate = {
  prob: 0,
  bias: 'uncertain',
  driftUsdPerSec: 0,
  volUsdPerSqrtSec: 0,
  horizonSec: 0,
  distanceUsd: 0,
  confidence: 'low',
  summary: 'Need spot ticks + remaining round time to estimate PTB crossing.',
};

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 — accurate to ~1.5e-7). */
function normalCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y =
    1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

/**
 * Estimate volatility ($/√sec) from a tick window using log-spaced returns.
 * Falls back to a fraction of the noise band if too few samples.
 */
export function estimateSpotVolatility(pts: Tick[], windowMs: number, fallbackBandUsd: number): number {
  if (pts.length < 4) return Math.max(fallbackBandUsd / 4, 0.05);
  const tEnd = pts[pts.length - 1]!.t;
  const start = tEnd - windowMs;
  const slice: Tick[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i]!.t < start) break;
    slice.push(pts[i]!);
  }
  slice.reverse();
  if (slice.length < 4) return Math.max(fallbackBandUsd / 4, 0.05);

  const dts: number[] = [];
  const dvs: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    const dt = (slice[i]!.t - slice[i - 1]!.t) / 1000; // sec
    if (dt <= 0) continue;
    const dv = slice[i]!.v - slice[i - 1]!.v;
    dts.push(dt);
    dvs.push(dv);
  }
  if (dts.length < 3) return Math.max(fallbackBandUsd / 4, 0.05);

  // σ_i = |Δv| / √Δt; aggregate via RMS.
  let sumSq = 0;
  for (let i = 0; i < dts.length; i++) {
    const dt = dts[i]!;
    const dv = dvs[i]!;
    const s = dv / Math.sqrt(Math.max(1e-6, dt));
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / dts.length);
  // Floor at a fraction of the noise band so a quiet tape doesn't return σ=0.
  return Math.max(rms, fallbackBandUsd / 6, 0.02);
}

/** Estimate drift ($/sec) from the last `windowMs` of ticks via OLS slope. */
export function estimateSpotDrift(pts: Tick[], windowMs: number): number {
  if (pts.length < 2) return 0;
  const tEnd = pts[pts.length - 1]!.t;
  const start = tEnd - windowMs;
  const slice: Tick[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i]!.t < start) break;
    slice.push(pts[i]!);
  }
  slice.reverse();
  if (slice.length < 2) return 0;
  const t0 = slice[0]!.t;
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  let n = 0;
  for (const p of slice) {
    const x = (p.t - t0) / 1000; // sec
    const y = p.v;
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
    n++;
  }
  if (n < 2) return 0;
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-9) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

/**
 * Compute P(spot crosses PTB at least once before round end).
 *
 * Inputs are loose so callers can pass nullable fields without ceremony.
 */
export function estimatePtbCrossProbability(input: {
  pts: Tick[];
  spot: number | null;
  ptb: number | null;
  endsInMs: number | null;
  /** Spot noise band ($) — used as a floor for σ when ticks are too quiet. */
  bandUsd: number;
  /** Window (ms) used to estimate σ and μ (default: 5 min). */
  estWindowMs?: number;
}): PtbCrossEstimate {
  const { pts, spot, ptb, endsInMs, bandUsd } = input;
  const estWindowMs = input.estWindowMs ?? 5 * 60_000;

  if (
    spot == null ||
    ptb == null ||
    !Number.isFinite(spot) ||
    !Number.isFinite(ptb) ||
    endsInMs == null ||
    !Number.isFinite(endsInMs) ||
    endsInMs <= 0
  ) {
    return NULL_ESTIMATE;
  }

  const T = Math.max(1, endsInMs / 1000);
  const distance = spot - ptb; // signed
  const distanceAbs = Math.abs(distance);

  // Already crossed (within band) — call it imminent.
  const halfBand = Math.max(bandUsd * 0.45, 0.25);
  if (distanceAbs <= halfBand) {
    return {
      prob: 0.95,
      bias: 'uncertain',
      driftUsdPerSec: 0,
      volUsdPerSqrtSec: 0,
      horizonSec: T,
      distanceUsd: distance,
      confidence: 'med',
      summary: `Spot is sitting on PTB (±${halfBand.toFixed(2)}$) — every tick is effectively a cross.`,
    };
  }

  const drift = estimateSpotDrift(pts, estWindowMs);
  const sigma = estimateSpotVolatility(pts, estWindowMs, Math.max(bandUsd, 0.05));

  // Closed-form barrier-hit prob for Brownian motion with drift.
  // S(0) = spot, barrier K = ptb.
  // P(min S_t ≤ K) when S0 > K  (or P(max ≥ K) when S0 < K via symmetry).
  const S0 = spot;
  const K = ptb;
  const sqrtT = Math.sqrt(T);
  const sigT = sigma * sqrtT;

  let prob: number;
  if (sigT < 1e-9) {
    // Deterministic ride — endpoint test only.
    const endPx = S0 + drift * T;
    if (S0 > K) prob = endPx <= K ? 1 : 0;
    else prob = endPx >= K ? 1 : 0;
  } else if (S0 > K) {
    // P(min ≤ K) = Φ((K - S0 - μT)/(σ√T)) + exp(2μ(K-S0)/σ²) · Φ((K - S0 + μT)/(σ√T))
    const d2 = (K - S0 - drift * T) / sigT;
    const d1 = (K - S0 + drift * T) / sigT;
    const expArg = (2 * drift * (K - S0)) / Math.max(sigma * sigma, 1e-12);
    // Cap exp to avoid overflow when drift is small but (K-S0) is large.
    const expTerm = expArg > 50 ? Math.exp(50) : Math.exp(expArg);
    prob = normalCdf(d2) + expTerm * normalCdf(d1);
  } else {
    // S0 < K: P(max ≥ K) — mirror image.
    const dist = S0 - K; // negative
    const d2 = (-dist + drift * T) / sigT;
    const d1 = (-dist - drift * T) / sigT;
    const expArg = (-2 * drift * dist) / Math.max(sigma * sigma, 1e-12); // dist<0
    const expTerm = expArg > 50 ? Math.exp(50) : Math.exp(expArg);
    prob = normalCdf(-d2) + expTerm * normalCdf(-d1);
  }
  prob = Math.max(0, Math.min(1, prob));

  const bias: PtbCrossEstimate['bias'] =
    prob <= 0.25 ? (S0 > K ? 'stay-above' : 'stay-below') : prob >= 0.75 ? 'uncertain' : 'uncertain';

  // Confidence: shrink when sample size is tiny or vol is at the floor.
  const confidence: PtbCrossEstimate['confidence'] =
    pts.length >= 30 && T >= 60 ? 'high' : pts.length >= 10 ? 'med' : 'low';

  const dirWord = drift > 0 ? 'up' : drift < 0 ? 'down' : 'flat';
  const sideWord = S0 > K ? 'above' : 'below';
  const pctTxt = `${Math.round(prob * 100)}%`;

  let summary: string;
  if (prob >= 0.7) {
    summary = `${pctTxt} chance of crossing PTB before the bell — drift ${dirWord}, distance ${distanceAbs.toFixed(2)}$.`;
  } else if (prob >= 0.4) {
    summary = `${pctTxt} crossing chance — coin-flip-ish; drift ${dirWord}, σ ${sigma.toFixed(2)}/√s.`;
  } else if (prob >= 0.15) {
    summary = `${pctTxt} crossing chance — likely stays ${sideWord}; drift ${dirWord}.`;
  } else {
    summary = `Likely stays ${sideWord} (${pctTxt} crossing chance) — drift ${dirWord}, low vol.`;
  }

  return {
    prob,
    bias,
    driftUsdPerSec: drift,
    volUsdPerSqrtSec: sigma,
    horizonSec: T,
    distanceUsd: distance,
    confidence,
    summary,
  };
}

export type EndingProbability = {
  /** P(spot_T > PTB) — UP outcome wins. */
  endAboveProb: number;
  /** P(spot_T < PTB) — DOWN outcome wins. */
  endBelowProb: number;
  /** Same drift/vol/horizon used for the calc, so callers can reuse them. */
  driftUsdPerSec: number;
  volUsdPerSqrtSec: number;
  horizonSec: number;
  /** Confidence in the model: shrinks with sample size and short horizon. */
  confidence: 'high' | 'med' | 'low';
};

/**
 * Estimate P(spot ends above / below PTB at round end). Distinct from
 * `estimatePtbCrossProbability` (which is "crosses *at least once*"); this is
 * the *terminal* probability, which is what matters for outcome settlement.
 *
 * Arithmetic Brownian: spot_T ~ N(S_0 + μT, σ²T)
 *   P(spot_T > K) = 1 − Φ((K − S_0 − μT) / (σ√T))
 */
export function estimateEndingProbability(input: {
  pts: Tick[];
  spot: number | null;
  ptb: number | null;
  endsInMs: number | null;
  bandUsd: number;
  estWindowMs?: number;
}): EndingProbability {
  const { pts, spot, ptb, endsInMs, bandUsd } = input;
  const estWindowMs = input.estWindowMs ?? 5 * 60_000;

  const NULL: EndingProbability = {
    endAboveProb: 0.5,
    endBelowProb: 0.5,
    driftUsdPerSec: 0,
    volUsdPerSqrtSec: 0,
    horizonSec: 0,
    confidence: 'low',
  };

  if (
    spot == null ||
    ptb == null ||
    !Number.isFinite(spot) ||
    !Number.isFinite(ptb) ||
    endsInMs == null ||
    !Number.isFinite(endsInMs) ||
    endsInMs <= 0
  ) {
    return NULL;
  }

  const T = Math.max(1, endsInMs / 1000);
  const drift = estimateSpotDrift(pts, estWindowMs);
  const sigma = estimateSpotVolatility(pts, estWindowMs, Math.max(bandUsd, 0.05));
  const sqrtT = Math.sqrt(T);
  const sigT = sigma * sqrtT;

  let endAboveProb: number;
  if (sigT < 1e-9) {
    const endPx = spot + drift * T;
    endAboveProb = endPx > ptb ? 1 : endPx < ptb ? 0 : 0.5;
  } else {
    // 1 − Φ((K − S0 − μT)/(σ√T))
    const z = (ptb - spot - drift * T) / sigT;
    endAboveProb = 1 - normalCdf(z);
  }
  endAboveProb = Math.max(0, Math.min(1, endAboveProb));
  const endBelowProb = 1 - endAboveProb;

  const confidence: EndingProbability['confidence'] =
    pts.length >= 30 && T >= 60 ? 'high' : pts.length >= 10 ? 'med' : 'low';

  return {
    endAboveProb,
    endBelowProb,
    driftUsdPerSec: drift,
    volUsdPerSqrtSec: sigma,
    horizonSec: T,
    confidence,
  };
}
