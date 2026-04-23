import type { BookSnapshot } from './orderflowMetrics';
import type { PtbControlSignal } from './ptbControlSignal';
import type { PtbStructureEvent } from './ptbCoreEngine';
import type { PtbReactionKind, SpotCandle, SpotTick } from './spotVsPtb';
import { flowStatsBetween } from './spotVsPtb';

/**
 * Additive normal model + Monte Carlo for barrier “cross soon”.
 * Explanatory only — not a trading guarantee.
 */

export type PtbProjectionConfidence = 'high' | 'med' | 'low';

export type PtbSettlementCrossProjection = {
  pAboveAtEnd: number;
  pBelowAtEnd: number;
  expectedEndPrice: number;
  band50Low: number;
  band50High: number;
  band80Low: number;
  band80High: number;
  pCrossIn30s: number;
  pCrossIn60s: number;
  pCrossIn120s: number;
  tCrossMedianSec: number | null;
  blurb: string;
  confidence: PtbProjectionConfidence;
  muUsdPerSec: number;
  sigmaPerSqrtSec: number;
};

const INV_SQRT2 = 1 / Math.sqrt(2);

/** Abramowitz & Stegun approximation for erf, then normal CDF. */
export function erf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1.0 / (1.0 + p * Math.abs(x));
  const y = 1.0 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
  return sign * y;
}

export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x * INV_SQRT2));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** xorshift32 — deterministic when seed is fixed (for tests + stable MC). */
function rngFromSeed(seed: number): () => number {
  let a = Math.floor(seed) >>> 0;
  return () => {
    a ^= a << 13;
    a ^= a >>> 17;
    a ^= a << 5;
    return (a >>> 0) / 4294967296;
  };
}

function boxMullerPair(rng: () => number): { z0: number; z1: number } {
  const u1 = Math.max(1e-12, rng());
  const u2 = rng();
  const r = Math.sqrt(-2.0 * Math.log(u1));
  const t = 2 * Math.PI * u2;
  return { z0: r * Math.cos(t), z1: r * Math.sin(t) };
}

/**
 * Quadratic variation rate from irregular ticks: E[(dS)² / dt] → σ per √s.
 */
export function estimateDiffusionFromTicks(pts: SpotTick[]): { sigmaPerSqrtSec: number; n: number } {
  if (pts.length < 3) {
    return { sigmaPerSqrtSec: 0, n: 0 };
  }
  let acc = 0;
  let k = 0;
  for (let i = 1; i < pts.length; i++) {
    const dS = pts[i]!.v - pts[i - 1]!.v;
    const dt = (pts[i]!.t - pts[i - 1]!.t) / 1000;
    if (dt > 0 && dt < 3600) {
      acc += (dS * dS) / dt;
      k++;
    }
  }
  if (k === 0) return { sigmaPerSqrtSec: 0, n: 0 };
  const rate = acc / k;
  const sigma = Math.sqrt(Math.max(rate, 0));
  const floor = 1e-6;
  return { sigmaPerSqrtSec: Math.max(floor, sigma), n: k };
}

/**
 * First time step in [0, horizon] where path crosses K (straddle).
 */
export function mcCrossProbRefined(params: {
  s0: number;
  k: number;
  mu: number;
  sigma: number;
  horizonSec: number;
  paths: number;
  /** Deterministic when set */
  randomSeed?: number;
}): number {
  const { s0, k, mu, sigma, horizonSec, paths, randomSeed } = params;
  if (horizonSec <= 0) return 0;
  if (sigma <= 0 && mu === 0) return 0;
  const dt = Math.min(0.4, Math.max(0.08, horizonSec / 180));
  const nSteps = Math.max(3, Math.ceil(horizonSec / dt));
  let hit = 0;
  for (let p = 0; p < paths; p++) {
    let sPrev = s0;
    const pathRng =
      randomSeed != null ? rngFromSeed((randomSeed + p * 0x9e37_79b9) >>> 0) : () => Math.random();
    let crossed = false;
    for (let st = 0; st < nSteps; st++) {
      const dW = boxMullerPair(pathRng).z0;
      const s = sPrev + mu * dt + sigma * Math.sqrt(dt) * dW;
      if ((sPrev - k) * (s - k) <= 0) {
        crossed = true;
        break;
      }
      sPrev = s;
    }
    if (crossed) hit++;
  }
  return hit / paths;
}

function structureIsChop(structureEventLabel: string, reactionKind: PtbReactionKind): boolean {
  const s = structureEventLabel.toLowerCase();
  return s.includes('chop') || reactionKind === 'choppy_at_line';
}

function impliedAgreesDrift(
  probUp: number | null,
  probDown: number | null,
  mu: number,
): { agree: boolean; weight: number } {
  if (probUp == null || probDown == null || !Number.isFinite(probUp) || !Number.isFinite(probDown)) {
    return { agree: true, weight: 0 };
  }
  const net = probUp - probDown;
  if (Math.abs(net) < 0.04) return { agree: true, weight: 0 };
  const impliedUp = net > 0;
  const driftUp = mu > 1e-9;
  const driftDown = mu < -1e-9;
  if (Math.abs(mu) < 1e-9) return { agree: true, weight: 0.05 };
  const agree = (impliedUp && driftUp) || (!impliedUp && driftDown);
  return { agree, weight: agree ? 0.08 : -0.12 };
}

function bookFlowAgreesDrift(
  flow: BookSnapshot[] | null | undefined,
  t0: number,
  t1: number,
  mu: number,
): { agree: boolean; weight: number } {
  if (!flow || flow.length < 2) return { agree: true, weight: 0 };
  const st = flowStatsBetween(flow, t0, t1);
  const imb = st.avgImbalance;
  if (imb == null || !Number.isFinite(imb)) return { agree: true, weight: 0 };
  if (Math.abs(mu) < 1e-9) return { agree: true, weight: 0.03 };
  const orderLeanUp = imb > 0.06;
  const orderLeanDown = imb < -0.06;
  const driftUp = mu > 0;
  if (!orderLeanUp && !orderLeanDown) return { agree: true, weight: 0 };
  const agree = (orderLeanUp && driftUp) || (orderLeanDown && !driftUp);
  return { agree, weight: agree ? 0.05 : -0.08 };
}

function inChopRegime(
  controlSignal: PtbControlSignal,
  structureEvent: PtbStructureEvent,
  reactionKind: PtbReactionKind,
  structureEventLabel: string,
): boolean {
  return (
    controlSignal === 'NO_EDGE' ||
    structureEvent === 'chop' ||
    structureIsChop(structureEventLabel, reactionKind)
  );
}

/**
 * @param mcRandomSeed - optional, fixes Monte Carlo for tests
 */
export function computePtbSettlementCrossProjections(params: {
  pts: SpotTick[];
  candles: SpotCandle[];
  ptb: number;
  s0: number;
  /** seconds to window end */
  Tsec: number;
  slopeUsdPerSec: number;
  slopeSampleCount: number;
  controlSignal: PtbControlSignal;
  structureEvent: PtbStructureEvent;
  structureEventLabel: string;
  reactionKind: PtbReactionKind;
  lastProbUp: number | null;
  lastProbDown: number | null;
  bookFlow: BookSnapshot[] | null | undefined;
  mcRandomSeed?: number;
}): PtbSettlementCrossProjection | null {
  const {
    pts,
    candles: _candles,
    ptb,
    s0,
    Tsec,
    slopeUsdPerSec,
    slopeSampleCount,
    controlSignal,
    structureEvent,
    structureEventLabel,
    reactionKind,
    lastProbUp,
    lastProbDown,
    bookFlow,
    mcRandomSeed,
  } = params;
  void _candles;
  if (!Number.isFinite(ptb) || !Number.isFinite(s0) || Tsec <= 0 || pts.length < 2) return null;

  const { sigmaPerSqrtSec, n: volN } = estimateDiffusionFromTicks(pts);
  const sigma0 = volN > 0 ? sigmaPerSqrtSec : 0.15;

  let mu = Number.isFinite(slopeUsdPerSec) ? slopeUsdPerSec : 0;
  if (controlSignal === 'NO_EDGE' || structureEvent === 'chop' || reactionKind === 'choppy_at_line') {
    mu *= 0.25;
  }
  if (slopeSampleCount < 6) mu *= 0.7;

  const chop = inChopRegime(controlSignal, structureEvent, reactionKind, structureEventLabel);
  if (chop) mu *= 0.35;

  const t0t = pts[0]!.t;
  const t1t = pts[pts.length - 1]!.t;
  const { agree: impOk, weight: wImp } = impliedAgreesDrift(lastProbUp, lastProbDown, mu);
  const { agree: bookOk, weight: wBook } = bookFlowAgreesDrift(bookFlow, t0t, t1t, mu);

  let confScore = 0.5;
  if (chop) confScore -= 0.25;
  if (controlSignal === 'NO_EDGE') confScore -= 0.1;
  if (!impOk) confScore += wImp;
  else if (wImp > 0) confScore += wImp * 0.5;
  if (!bookOk) confScore += wBook;
  else if (wBook > 0) confScore += wBook * 0.5;
  if (slopeSampleCount >= 10) confScore += 0.1;
  confScore = clamp01(confScore);

  const mT = s0 + mu * Tsec;
  const stdev = Math.max(1e-6, sigma0 * Math.sqrt(Tsec));
  const z = (ptb - mT) / stdev;
  let pBelow = normalCdf(z);
  let pAbove = 1 - pBelow;

  if (chop) {
    pAbove = 0.5 + (pAbove - 0.5) * 0.45;
    pBelow = 1 - pAbove;
  }

  pAbove = clamp01(pAbove);
  pBelow = clamp01(1 - pAbove);

  const z50a = 0.6745;
  const band50Low = mT - z50a * stdev;
  const band50High = mT + z50a * stdev;
  const z80 = 1.28155;
  const band80Low = mT - z80 * stdev;
  const band80High = mT + z80 * stdev;

  let tMed: number | null = null;
  const dist = s0 - ptb;
  if (Math.abs(dist) > 1e-9 && Math.abs(mu) > 1e-12) {
    const toward = (dist > 0 && mu < 0) || (dist < 0 && mu > 0);
    if (toward) {
      tMed = Math.max(0, Math.abs(dist) / Math.abs(mu));
      if (tMed > 1e6) tMed = null;
    }
  }

  const mcBase = { s0, k: ptb, mu, sigma: sigma0 } as const;
  const s = (o: { horizonSec: number; paths: number; seedOff: number }) =>
    mcCrossProbRefined({
      ...mcBase,
      horizonSec: o.horizonSec,
      paths: o.paths,
      ...(mcRandomSeed != null ? { randomSeed: (mcRandomSeed + o.seedOff) >>> 0 } : {}),
    });
  const p30 = s({ horizonSec: 30, paths: 180, seedOff: 0 });
  const p60 = s({ horizonSec: 60, paths: 180, seedOff: 0x1_0000 });
  const p120 = s({ horizonSec: 120, paths: 160, seedOff: 0x2_0000 });

  const crossScale = chop ? 0.4 : 1;
  const c30 = clamp01(p30 * crossScale);
  const c60 = clamp01(p60 * crossScale);
  const c120 = clamp01(p120 * crossScale);

  const confidence: PtbProjectionConfidence = confScore >= 0.65 ? 'high' : confScore >= 0.4 ? 'med' : 'low';

  const blurb = [
    `Model: drift ${(mu * 1000).toFixed(3)} m$/s, σ≈${sigma0.toFixed(4)}/√s`,
    chop ? 'Chop: probabilities compressed toward 50/50' : null,
    !impOk || !bookOk ? 'Some inputs disagree with drift — lower confidence' : null,
  ]
    .filter((x): x is string => x != null && x.length > 0)
    .join(' · ');

  return {
    pAboveAtEnd: pAbove,
    pBelowAtEnd: pBelow,
    expectedEndPrice: mT,
    band50Low,
    band50High,
    band80Low,
    band80High,
    pCrossIn30s: c30,
    pCrossIn60s: c60,
    pCrossIn120s: c120,
    tCrossMedianSec: tMed,
    blurb,
    confidence,
    muUsdPerSec: mu,
    sigmaPerSqrtSec: sigma0,
  };
}
