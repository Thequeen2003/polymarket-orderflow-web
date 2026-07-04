/**
 * Fair value gap: expected probability (desk model) vs actual market odds,
 * demeaned over recent samples, then averaged back with the market for tradeable fair value.
 *
 *   rawGap     = P_expected − P_actual
 *   meanGap    = mean(recent rawGap)
 *   gapFromMean = rawGap − meanGap
 *   fairUp     = (P_actual + P_expected − meanGap) / 2   // average vs odds, mean-adjusted
 *   fairEdge   = fairUp − P_actual = gapFromMean / 2
 */

import type { BinaryOutcomeEstimate } from './binaryOutcomeBias';
import { estimateBinaryOutcomeBias } from './binaryOutcomeBias';

export const FVG_MIN_SAMPLES_FOR_MEAN = 6;
export const FVG_MAX_SAMPLES = 240;

export type FairValueGapSample = {
  t: number;
  /** Desk expected P(Up) — settlement bias model. */
  pExpected: number;
  /** Market implied P(Up) — contract mid. */
  pActual: number;
  rawGap: number;
};

export type FairValueGapReadout = {
  pExpected: number;
  pActual: number;
  rawGap: number;
  rawGapPp: number;
  meanGap: number | null;
  meanGapPp: number | null;
  gapFromMean: number;
  gapFromMeanPp: number;
  fairValueUp: number;
  fairEdge: number;
  fairEdgePp: number;
  sampleCount: number;
  meanReady: boolean;
  summary: string;
};

function clampProb01(p: number): number {
  return Math.max(0.01, Math.min(0.99, p));
}

function fmtPp(pp: number): string {
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}

export function appendFairValueGapSample(
  samples: FairValueGapSample[],
  sample: FairValueGapSample,
  max = FVG_MAX_SAMPLES,
): FairValueGapSample[] {
  const next = [...samples, sample];
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

export function rollingMeanRawGap(samples: FairValueGapSample[]): number | null {
  if (samples.length < FVG_MIN_SAMPLES_FOR_MEAN) return null;
  const sum = samples.reduce((a, s) => a + s.rawGap, 0);
  return sum / samples.length;
}

/**
 * Fair value = average of market odds with mean-adjusted expected probability.
 * When mean is not ready, uses simple (odds + expected) / 2.
 */
export function computeFairValueGap(params: {
  pExpected: number;
  pActual: number;
  samples?: FairValueGapSample[];
}): FairValueGapReadout {
  const pExpected = clampProb01(params.pExpected);
  const pActual = clampProb01(params.pActual);
  const rawGap = pExpected - pActual;
  const meanGap = params.samples ? rollingMeanRawGap(params.samples) : null;
  const meanReady = meanGap != null && Number.isFinite(meanGap);
  const gapFromMean = meanReady ? rawGap - meanGap! : rawGap;

  const fairValueUp = clampProb01(
    meanReady ? (pActual + pExpected - meanGap!) / 2 : (pActual + pExpected) / 2,
  );
  const fairEdge = fairValueUp - pActual;

  const rawGapPp = rawGap * 100;
  const gapFromMeanPp = gapFromMean * 100;
  const fairEdgePp = fairEdge * 100;

  let summary: string;
  if (!meanReady) {
    summary = `Raw ${fmtPp(rawGapPp)} (expected − market) · collecting mean (${params.samples?.length ?? 0}/${FVG_MIN_SAMPLES_FOR_MEAN})`;
  } else {
    summary = `Gap ${fmtPp(rawGapPp)} vs mean ${fmtPp(meanGap! * 100)} → ${fmtPp(gapFromMeanPp)} · fair ${fmtPp(fairEdgePp)} vs odds`;
  }

  return {
    pExpected,
    pActual,
    rawGap,
    rawGapPp,
    meanGap,
    meanGapPp: meanGap != null ? meanGap * 100 : null,
    gapFromMean,
    gapFromMeanPp,
    fairValueUp,
    fairEdge,
    fairEdgePp,
    sampleCount: params.samples?.length ?? 0,
    meanReady,
    summary,
  };
}

export function buildFairValueGapSampleInput(params: {
  now: number;
  ptb: number;
  spotPts: { t: number; v: number }[];
  pMkt: number;
  probUp01?: number | null;
  probDown01?: number | null;
  atMs?: number;
}): FairValueGapSample | null {
  const est = estimateBinaryOutcomeBias({
    now: params.now,
    ptb: params.ptb,
    spotPts: params.spotPts,
    pUp01: params.probUp01 ?? (params.probDown01 != null ? 1 - params.probDown01 : null),
  });
  if (!est) return null;
  const pExpected = est.probUp;
  const pActual = clampProb01(params.pMkt);
  return {
    t: params.atMs ?? Date.now(),
    pExpected,
    pActual,
    rawGap: pExpected - pActual,
  };
}

/** Edge for scalp layer: mean-adjusted fair value minus market when mean is ready. */
export function tradeEdgeFromFairValueGap(fvg: FairValueGapReadout): number {
  return fvg.meanReady ? fvg.gapFromMean / 2 : fvg.rawGap;
}

/** Rolling σ of raw FVG samples (probability units). */
export function rollingStdRawGap(samples: FairValueGapSample[]): number | null {
  const mean = rollingMeanRawGap(samples);
  if (mean == null || samples.length < FVG_MIN_SAMPLES_FOR_MEAN) return null;
  const variance = samples.reduce((acc, s) => acc + (s.rawGap - mean) ** 2, 0) / samples.length;
  if (!Number.isFinite(variance) || variance < 1e-14) return null;
  return Math.sqrt(variance);
}

/** Z = (FVG − mean) / σ using demeaned gap when mean is ready. */
export function computeGapZScore(gapFromMean: number, stdGap: number | null): number | null {
  if (stdGap == null || !Number.isFinite(stdGap) || stdGap < 1e-8) return null;
  return gapFromMean / stdGap;
}

export const FVG_SIGNAL_STRONG_THRESHOLD = 5;
export const FVG_SIGNAL_WEAK_THRESHOLD = 2;

export type FvgSignalTier = 'STRONG_YES' | 'WEAK_YES' | 'NEUTRAL' | 'WEAK_NO' | 'STRONG_NO';

export type FvgSignalTrade = 'BUY_YES' | 'SMALL_YES' | 'NO_TRADE' | 'SMALL_NO' | 'BUY_NO';

export type FairValueGapSignalReadout = {
  /** Expected − market (probability). */
  fvg: number;
  fvgPp: number;
  fvgCents: number;
  meanGapPp: number | null;
  stdGapPp: number | null;
  zScore: number | null;
  zReady: boolean;
  /** P_model − P_market. */
  edge: number;
  edgePp: number;
  /** Z × edge (pp) when σ is ready; otherwise null. */
  signal: number | null;
  signalReady: boolean;
  tier: FvgSignalTier;
  trade: FvgSignalTrade;
  label: string;
  detail: string;
};

export function classifyFairValueGapSignal(signal: number): Pick<
  FairValueGapSignalReadout,
  'tier' | 'trade' | 'label' | 'detail'
> {
  if (signal > FVG_SIGNAL_STRONG_THRESHOLD) {
    return {
      tier: 'STRONG_YES',
      trade: 'BUY_YES',
      label: 'Buy YES',
      detail: `Signal ${signal.toFixed(1)} > +${FVG_SIGNAL_STRONG_THRESHOLD} · model cheap vs market`,
    };
  }
  if (signal > FVG_SIGNAL_WEAK_THRESHOLD) {
    return {
      tier: 'WEAK_YES',
      trade: 'SMALL_YES',
      label: 'Small YES',
      detail: `Signal +${FVG_SIGNAL_WEAK_THRESHOLD}…+${FVG_SIGNAL_STRONG_THRESHOLD} · lean long`,
    };
  }
  if (signal >= -FVG_SIGNAL_WEAK_THRESHOLD) {
    return {
      tier: 'NEUTRAL',
      trade: 'NO_TRADE',
      label: 'No trade',
      detail: `Signal inside ±${FVG_SIGNAL_WEAK_THRESHOLD} band`,
    };
  }
  if (signal >= -FVG_SIGNAL_STRONG_THRESHOLD) {
    return {
      tier: 'WEAK_NO',
      trade: 'SMALL_NO',
      label: 'Small NO',
      detail: `Signal −${FVG_SIGNAL_STRONG_THRESHOLD}…−${FVG_SIGNAL_WEAK_THRESHOLD} · lean short`,
    };
  }
  return {
    tier: 'STRONG_NO',
    trade: 'BUY_NO',
    label: 'Buy NO',
    detail: `Signal ${signal.toFixed(1)} < −${FVG_SIGNAL_STRONG_THRESHOLD} · model rich vs market`,
  };
}

/**
 * Single tradeable FVG signal: Z-score of demeaned gap × probability edge (pp).
 * Signal = Z × Edge_pp  (e.g. Z=+2, Edge=+6pp → +12 → strong YES).
 */
export function computeFairValueGapSignal(params: {
  fvg: FairValueGapReadout;
  samples?: FairValueGapSample[];
  pModel?: number;
}): FairValueGapSignalReadout {
  const { fvg, samples } = params;
  const pModel = params.pModel ?? fvg.pExpected;
  const edge = pModel - fvg.pActual;
  const edgePp = edge * 100;
  const fvgCents = fvg.rawGap * 100;
  const stdGap = samples ? rollingStdRawGap(samples) : null;
  const stdGapPp = stdGap != null ? stdGap * 100 : null;
  const zScore = fvg.meanReady ? computeGapZScore(fvg.gapFromMean, stdGap) : null;
  const zReady = zScore != null && Number.isFinite(zScore);
  const signal = zReady ? zScore! * edgePp : null;
  const signalReady = signal != null && Number.isFinite(signal);

  const classified = signalReady
    ? classifyFairValueGapSignal(signal!)
    : {
        tier: 'NEUTRAL' as const,
        trade: 'NO_TRADE' as const,
        label: zReady ? 'No trade' : 'Warming up',
        detail: zReady
          ? 'Edge × Z near zero'
          : `Collecting gap σ (${fvg.sampleCount}/${FVG_MIN_SAMPLES_FOR_MEAN} samples)`,
      };

  return {
    fvg: fvg.rawGap,
    fvgPp: fvg.rawGapPp,
    fvgCents,
    meanGapPp: fvg.meanGapPp,
    stdGapPp,
    zScore,
    zReady,
    edge,
    edgePp,
    signal,
    signalReady,
    ...classified,
  };
}

export function fairValueGapFromEstimate(
  estimate: BinaryOutcomeEstimate,
  pMkt: number,
  samples?: FairValueGapSample[],
): FairValueGapReadout {
  return computeFairValueGap({
    pExpected: estimate.probUp,
    pActual: pMkt,
    samples,
  });
}

export type FairValueEdgeSide = 'yes' | 'no' | 'even';

export type FairValueSimpleReadout = {
  marketUp: number;
  /** Desk fair estimate (model P(Up)) — shown as “PTB fair”. */
  fairUp: number;
  gapPp: number;
  yesEdgePp: number;
  noEdgePp: number;
  favored: FairValueEdgeSide;
  favoredLabel: string;
  favoredDetail: string;
};

/** YES/NO edge from fair − market; larger positive edge wins. */
export function computeFairValueEdgeSides(params: {
  fairUp: number;
  marketUp: number;
  yesLabel?: string;
  noLabel?: string;
}): FairValueSimpleReadout {
  const fairUp = clampProb01(params.fairUp);
  const marketUp = clampProb01(params.marketUp);
  const gapPp = (fairUp - marketUp) * 100;
  const yesEdgePp = gapPp;
  const noEdgePp = -gapPp;
  const yesName = params.yesLabel ?? 'YES';
  const noName = params.noLabel ?? 'NO';

  const yesMag = Math.abs(yesEdgePp);
  const noMag = Math.abs(noEdgePp);

  let favored: FairValueEdgeSide = 'even';
  let favoredLabel = 'Even — no clear edge';
  let favoredDetail = 'Fair ≈ market on both sides';

  if (yesMag < 0.35 && noMag < 0.35) {
    favored = 'even';
  } else if (yesEdgePp > 0 && yesEdgePp >= noEdgePp) {
    favored = 'yes';
    favoredLabel = `${yesName} has the larger edge`;
    favoredDetail = `${yesName} underpriced vs desk fair · buy ${yesName}`;
  } else if (noEdgePp > 0 && noEdgePp > yesEdgePp) {
    favored = 'no';
    favoredLabel = `${noName} has the larger edge`;
    favoredDetail = `${noName} underpriced vs desk fair · buy ${noName}`;
  } else if (yesEdgePp > noEdgePp) {
    favored = 'yes';
    favoredLabel = `${yesName} less overpriced`;
    favoredDetail = `Lean ${yesName} vs ${noName}`;
  } else if (noEdgePp > yesEdgePp) {
    favored = 'no';
    favoredLabel = `${noName} less overpriced`;
    favoredDetail = `Lean ${noName} vs ${yesName}`;
  }

  return {
    marketUp,
    fairUp,
    gapPp,
    yesEdgePp,
    noEdgePp,
    favored,
    favoredLabel,
    favoredDetail,
  };
}
