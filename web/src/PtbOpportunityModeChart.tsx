import { memo, useId, useMemo, useState, type ReactElement } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import { computePtbChartDerivatives, type PtbControlSignal } from './ptbChartDerivatives';
import { PTB_REACTION_DIMENSIONS, PTB_REACTION_ONE_LINER } from './ptbReactionFramework';
import { STREAM_ATTRIBUTION_LINE } from './streamAttribution';
import { buildSpotCandles, candleStraddlesPtb, ptbTouchEpsilonUsd } from './spotVsPtb';
import { computeTickSlopeUsdPerSec } from './ptbCoreEngine';

type Mode = 'up' | 'down';
type DominanceStatus = 'UP BIAS' | 'DOWN BIAS' | 'AT PTB';

type MomentumBuildup = {
  score: number;
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  label: string;
  tier: 'LOADING' | 'BUILDING' | 'READY' | 'FIRING' | 'NONE';
  signals: string[];
};

type BiasShift = {
  bias: 'STRONG UP' | 'UP' | 'NEUTRAL' | 'DOWN' | 'STRONG DOWN';
  biasScore: number;
  shifting: boolean;
  shiftDir: 'TO UP' | 'TO DOWN' | null;
  shiftUrgency: 'IMMINENT' | 'FORMING' | null;
  reasons: string[];
};

const MODE_META: Record<Mode, { label: string; accent: string; soft: string; strongText: string; zoneLabel: string }> = {
  up: {
    label: 'UP VIEW',
    accent: 'rgb(52 211 153)',
    soft: 'rgba(16, 185, 129, 0.16)',
    strongText: 'text-emerald-300',
    zoneLabel: 'PTB DECISION LINE',
  },
  down: {
    label: 'DOWN VIEW',
    accent: 'rgb(248 113 113)',
    soft: 'rgba(239, 68, 68, 0.16)',
    strongText: 'text-rose-300',
    zoneLabel: 'PTB DECISION LINE',
  },
};

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function fmtUsd(n: number | null): string {
  return n == null || !Number.isFinite(n) ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtUsdSigned(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtPctSigned(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtAxisPrice(p: number): string {
  const a = Math.abs(p);
  if (a >= 1_000_000) return `$${(p / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `$${(p / 1_000).toFixed(2)}k`;
  return `$${p.toFixed(2)}`;
}

/** `m:ss` countdown from remaining ms (market round). */
function fmtTimeRemaining(endsInMs: number | null | undefined): string {
  if (endsInMs == null || !Number.isFinite(endsInMs)) return '—';
  const totalSec = Math.max(0, Math.floor(endsInMs / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function pctOfTotal(part: number, total: number): string {
  if (!(total > 0)) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

function statusSubtitle(params: {
  control: PtbControlSignal | undefined;
  momentum: 'UP' | 'DOWN' | 'NEUTRAL' | undefined;
}): string | null {
  const { control, momentum } = params;
  if (!control) return null;
  if (control === 'TRANSITION') return 'weakening or rotation';
  if (control === 'REJECTION') return 'line test failed';
  if (control === 'NO_EDGE') return 'near PTB band — low edge';
  if (control === 'UP_CONTROL' && momentum === 'DOWN') return 'weakening';
  if (control === 'DOWN_CONTROL' && momentum === 'UP') return 'weakening';
  return null;
}


function statusFor(params: { price: number; level: number; band: number; recentMove: number }): DominanceStatus {
  const { price, level, band, recentMove } = params;
  if (price > level + band && recentMove >= 0) return 'UP BIAS';
  if (price < level - band && recentMove <= 0) return 'DOWN BIAS';
  if (price > level + band * 1.35) return 'UP BIAS';
  if (price < level - band * 1.35) return 'DOWN BIAS';
  return 'AT PTB';
}

const W = 920;
const H = 560;

/**
 * OHLC bucket count: scales with tick count but stays below ~1 bucket / 2 ticks
 * so `buildSpotCandles` does not drop most buckets as empty (which looks like “no candles”).
 */
function candleBucketCount(ptsLen: number): number {
  if (ptsLen < 4) return Math.max(2, ptsLen - 1);
  const n = Math.floor(ptsLen * 0.22);
  return Math.min(20, Math.max(8, n));
}

/** Evenly spaced time ticks (short windows get more labels, like Polymarket’s intraday strip). */
function buildEvenXTicks(tMin: number, tMax: number): number[] {
  const span = Math.max(1, tMax - tMin);
  const n = span < 120_000 ? 8 : span < 3_600_000 ? 7 : 6;
  const step = span / (n - 1);
  return Array.from({ length: n }, (_, i) => tMin + i * step);
}
const PAD_L = 18;
const PAD_R = 64;
const PAD_Y = 18;

export const PtbOpportunityModeChart = memo(function PtbOpportunityModeChart(props: {
  mode: Mode;
  spot: SpotPoint[];
  priceToBeat: number | null;
  lastUpdateMs: number | null;
  /** Milliseconds until market / round end (from parent); drives “Time remaining”. */
  endsInMs?: number | null;
  chartTitle?: string;
  upLabel?: string;
  downLabel?: string;
}): ReactElement {
  const { mode, spot, priceToBeat, lastUpdateMs, endsInMs = null, chartTitle = 'Spot (USD)', upLabel = 'UP', downLabel = 'DOWN' } = props;
  const gradId = useId().replace(/:/g, '');
  const [displayMode, setDisplayMode] = useState<'line' | 'ohlc'>('line');
  const [zoomWindow, setZoomWindow] = useState<60 | 120 | 300>(300);

  const pts = useMemo(() => {
    const all = spot.filter((p) => isFiniteNumber(p.t) && isFiniteNumber(p.v));
    if (all.length < 2) return all;
    const cutoff = all[all.length - 1]!.t - zoomWindow * 1000;
    const windowed = all.filter((p) => p.t >= cutoff);
    return windowed.length >= 2 ? windowed.slice(-160) : all.slice(-160);
  }, [spot, zoomWindow]);
  const meta = MODE_META[mode];
  const stale = lastUpdateMs == null || Date.now() - lastUpdateMs > 12_000;

  const model = useMemo(() => {
    if (priceToBeat == null || !Number.isFinite(priceToBeat) || pts.length < 2) return null;
    const candles = buildSpotCandles(pts, candleBucketCount(pts.length));
    let spotMin = Infinity;
    let spotMax = -Infinity;
    let maxAbs = 0;
    for (let i = 0; i < pts.length; i++) {
      const v = pts[i]!.v;
      if (!Number.isFinite(v)) continue;
      if (v < spotMin) spotMin = v;
      if (v > spotMax) spotMax = v;
      const d = Math.abs(v - priceToBeat);
      if (d > maxAbs) maxAbs = d;
    }
    if (!Number.isFinite(spotMin)) return null;
    const last = pts[pts.length - 1]!.v;
    const first = pts[0]!.v;
    const recentBase = pts[Math.max(0, pts.length - 7)]?.v ?? first;
    const recentMove = last - recentBase;
    const pctChange = Math.abs(first) > 1e-12 ? ((last - first) / first) * 100 : 0;
    const distancePct = ((last - priceToBeat) / priceToBeat) * 100;
    const needAbove = Math.max(0, spotMax - priceToBeat);
    const needBelow = Math.max(0, priceToBeat - spotMin);
    const halfSpan = Math.max(needAbove, needBelow, Math.abs(priceToBeat) * 3e-5, 1);
    const plotMin = priceToBeat - halfSpan * 1.08;
    const plotMax = priceToBeat + halfSpan * 1.08;
    if (!(plotMax > plotMin)) return null;
    const band = ptbTouchEpsilonUsd(pts, priceToBeat);
    if (!Number.isFinite(band)) return null;
    if (maxAbs < band * 1.5) maxAbs = band * 1.5;
    const status = statusFor({ price: last, level: priceToBeat, band, recentMove });
    const favorableNow = mode === 'up' ? last > priceToBeat + band : last < priceToBeat - band;
    const selectedLabel = mode === 'up' ? upLabel : downLabel;
    const oppositeLabel = mode === 'up' ? downLabel : upLabel;
    const absDistance = Math.abs(last - priceToBeat);
    const conviction =
      absDistance >= band * 3 ? 'STRONG SEPARATION' : absDistance >= band * 1.75 ? 'CLEAR SEPARATION' : 'WEAK SEPARATION';
    const hint =
      status === 'AT PTB'
        ? 'Price is reacting at the line — no edge until it separates.'
        : favorableNow
          ? `Price is on the ${selectedLabel} side of PTB, so ${selectedLabel} has the bias.`
          : `Price is on the ${oppositeLabel} side of PTB, so this view is weak.`;
    return {
      candles, last, first, recentMove, pctChange, distancePct,
      plotMin, plotMax, band, maxAbs, status, conviction, hint,
      tMin: pts[0]!.t, tMax: pts[pts.length - 1]!.t,
    };
  }, [mode, priceToBeat, pts, upLabel, downLabel]);

  const derivedStrip = useMemo(() => {
    if (!model || priceToBeat == null || !Number.isFinite(priceToBeat)) return null;
    return computePtbChartDerivatives({ pts, candles: model.candles, ptb: priceToBeat });
  }, [model, priceToBeat, pts]);

  /** Key price levels — swing highs/lows from candles for S/R. */
  const priceLevels = useMemo(() => {
    if (!model || model.candles.length < 5) return [];
    const candles = model.candles;
    const levels: { price: number; kind: 'high' | 'low' }[] = [];
    for (let i = 2; i < candles.length - 2; i++) {
      const c = candles[i]!;
      const prevH = Math.max(candles[i - 1]!.h, candles[i - 2]!.h);
      const nextH = Math.max(candles[i + 1]!.h, candles[i + 2]!.h);
      if (c.h > prevH && c.h > nextH) levels.push({ price: c.h, kind: 'high' });
      const prevL = Math.min(candles[i - 1]!.l, candles[i - 2]!.l);
      const nextL = Math.min(candles[i + 1]!.l, candles[i + 2]!.l);
      if (c.l < prevL && c.l < nextL) levels.push({ price: c.l, kind: 'low' });
    }
    const eps = (model.plotMax - model.plotMin) * 0.02;
    const deduped: typeof levels = [];
    for (const lv of levels) {
      if (!deduped.some((d) => Math.abs(d.price - lv.price) < eps)) deduped.push(lv);
    }
    return deduped.slice(0, 6);
  }, [model]);

  const buildup: MomentumBuildup | null = useMemo(() => {
    if (!model || !derivedStrip || model.candles.length < 4) return null;
    const candles = model.candles;
    const n = candles.length;
    let score = 0;
    const signals: string[] = [];

    // 1. Consecutive closes in same direction (streak)
    const streak = derivedStrip.momentumStreak;
    const mom = derivedStrip.momentum;
    if (streak >= 4) { score += 30; signals.push(`${streak}-candle streak`); }
    else if (streak >= 3) { score += 20; signals.push(`${streak}-candle streak`); }
    else if (streak >= 2) { score += 8; }

    // 2. Body expansion — are recent bodies getting bigger? (momentum loading)
    const recentBodies: number[] = [];
    const olderBodies: number[] = [];
    const half = Math.floor(n / 2);
    for (let i = 0; i < n; i++) {
      const body = Math.abs(candles[i]!.c - candles[i]!.o);
      if (i >= half) recentBodies.push(body); else olderBodies.push(body);
    }
    const avgRecent = recentBodies.length > 0 ? recentBodies.reduce((a, b) => a + b, 0) / recentBodies.length : 0;
    const avgOlder = olderBodies.length > 0 ? olderBodies.reduce((a, b) => a + b, 0) / olderBodies.length : 0;
    if (avgOlder > 0 && avgRecent > avgOlder * 1.8) { score += 20; signals.push('bodies expanding'); }
    else if (avgOlder > 0 && avgRecent > avgOlder * 1.3) { score += 10; signals.push('bodies growing'); }

    // 3. Squeeze detection — tight range then expansion
    const lastThree = candles.slice(-3);
    const priorFive = candles.slice(Math.max(0, n - 8), Math.max(0, n - 3));
    if (priorFive.length >= 2 && lastThree.length >= 2) {
      const priorAvgRange = priorFive.reduce((s, c) => s + (c.h - c.l), 0) / priorFive.length;
      const lastRange = lastThree[lastThree.length - 1]!.h - lastThree[lastThree.length - 1]!.l;
      const priorMinRange = Math.min(...priorFive.map(c => c.h - c.l));
      if (priorMinRange < priorAvgRange * 0.5 && lastRange > priorAvgRange * 1.4) {
        score += 25; signals.push('squeeze breakout');
      } else if (priorMinRange < priorAvgRange * 0.65 && lastRange > priorAvgRange * 1.1) {
        score += 12; signals.push('range expanding');
      }
    }

    // 4. Slope acceleration — current slope faster than earlier slope
    if (pts.length >= 8) {
      const halfPts = Math.floor(pts.length / 2);
      const earlySlope = computeTickSlopeUsdPerSec(pts.slice(0, halfPts));
      const lateSlope = computeTickSlopeUsdPerSec(pts.slice(halfPts));
      const accel = Math.abs(lateSlope.slopeUsdPerSec) - Math.abs(earlySlope.slopeUsdPerSec);
      if (accel > 0 && Math.abs(lateSlope.slopeUsdPerSec) > Math.abs(earlySlope.slopeUsdPerSec) * 1.8) {
        score += 20; signals.push('accelerating');
      } else if (accel > 0 && Math.abs(lateSlope.slopeUsdPerSec) > Math.abs(earlySlope.slopeUsdPerSec) * 1.3) {
        score += 10; signals.push('slope rising');
      }
      if (accel < 0 && Math.abs(lateSlope.slopeUsdPerSec) < Math.abs(earlySlope.slopeUsdPerSec) * 0.4) {
        score -= 15; signals.push('decelerating');
      }
    }

    // 5. Stacking closes further from PTB (accumulating separation)
    if (priceToBeat != null && n >= 4) {
      const lastFour = candles.slice(-4);
      const dists = lastFour.map(c => c.c - priceToBeat!);
      const allSameSign = dists.every(d => d > 0) || dists.every(d => d < 0);
      const increasing = allSameSign && Math.abs(dists[3]!) > Math.abs(dists[0]!) * 1.15;
      if (increasing) { score += 15; signals.push('separating from PTB'); }
    }

    score = Math.max(0, Math.min(100, score));
    const direction = mom === 'UP' || mom === 'DOWN' ? mom : (score >= 20 ? (derivedStrip.slopeUsdPerSec > 0 ? 'UP' : 'DOWN') : 'NEUTRAL');
    let tier: MomentumBuildup['tier'];
    let label: string;
    if (score >= 70) { tier = 'FIRING'; label = 'Momentum firing — strong directional move underway'; }
    else if (score >= 45) { tier = 'READY'; label = 'Momentum ready — breakout conditions met'; }
    else if (score >= 25) { tier = 'BUILDING'; label = 'Momentum building — watch for continuation'; }
    else if (score >= 10) { tier = 'LOADING'; label = 'Momentum loading — early signs of buildup'; }
    else { tier = 'NONE'; label = 'No momentum buildup detected'; }

    return { score, direction, label, tier, signals };
  }, [model, derivedStrip, pts, priceToBeat]);

  const biasShift: BiasShift | null = useMemo(() => {
    if (!model || !derivedStrip || model.candles.length < 5 || priceToBeat == null) return null;
    const candles = model.candles;
    const n = candles.length;
    const reasons: string[] = [];

    // --- Bias score: -100 (strong down) to +100 (strong up) ---
    let raw = 0;

    // Candle streak direction
    const streak = derivedStrip.momentumStreak;
    const mom = derivedStrip.momentum;
    if (mom === 'UP') raw += Math.min(35, streak * 10);
    else if (mom === 'DOWN') raw -= Math.min(35, streak * 10);

    // Slope direction and magnitude
    const slope = derivedStrip.slopeUsdPerSec;
    const slopeContrib = Math.min(25, Math.abs(slope) * 800);
    raw += slope > 0 ? slopeContrib : -slopeContrib;

    // Position vs PTB
    const dist = model.last - priceToBeat;
    const distNorm = Math.min(20, (Math.abs(dist) / Math.max(model.band, 0.01)) * 5);
    raw += dist > 0 ? distNorm : -distNorm;

    // Last 3 candles: net direction
    const last3 = candles.slice(-3);
    const net3 = last3.reduce((s, c) => s + (c.c >= c.o ? 1 : -1), 0);
    raw += net3 * 7;

    const biasScore = Math.max(-100, Math.min(100, Math.round(raw)));
    const bias: BiasShift['bias'] = biasScore >= 50 ? 'STRONG UP' : biasScore >= 15 ? 'UP' : biasScore <= -50 ? 'STRONG DOWN' : biasScore <= -15 ? 'DOWN' : 'NEUTRAL';

    // --- Shift detection: is momentum about to reverse? ---
    let shifting = false;
    let shiftDir: BiasShift['shiftDir'] = null;
    let shiftUrgency: BiasShift['shiftUrgency'] = null;
    let shiftScore = 0;

    // 1. Opposing candle after streak (first sign of reversal)
    if (streak >= 2 && n >= 2) {
      const prev = candles[n - 2]!;
      const last = candles[n - 1]!;
      const prevBull = prev.c >= prev.o;
      const lastBull = last.c >= last.o;
      if (prevBull !== lastBull) {
        shiftScore += 25;
        reasons.push(lastBull ? 'first green after red streak' : 'first red after green streak');
      }
    }

    // 2. Wick rejection — long wick in opposite direction of trend
    if (n >= 1) {
      const last = candles[n - 1]!;
      const body = Math.abs(last.c - last.o);
      const range = last.h - last.l;
      if (range > 0) {
        const upperWick = last.h - Math.max(last.o, last.c);
        const lowerWick = Math.min(last.o, last.c) - last.l;
        if (mom === 'UP' && upperWick > body * 1.5 && upperWick > range * 0.45) {
          shiftScore += 30; reasons.push('rejection wick at top');
        }
        if (mom === 'DOWN' && lowerWick > body * 1.5 && lowerWick > range * 0.45) {
          shiftScore += 30; reasons.push('rejection wick at bottom');
        }
      }
    }

    // 3. Slope deceleration — was fast, now slowing
    if (pts.length >= 10) {
      const third = Math.floor(pts.length / 3);
      const earlySlope = computeTickSlopeUsdPerSec(pts.slice(0, third));
      const lateSlope = computeTickSlopeUsdPerSec(pts.slice(-third));
      const earlyAbs = Math.abs(earlySlope.slopeUsdPerSec);
      const lateAbs = Math.abs(lateSlope.slopeUsdPerSec);
      if (earlyAbs > 1e-9 && lateAbs < earlyAbs * 0.35) {
        shiftScore += 25; reasons.push('momentum fading');
      } else if (earlyAbs > 1e-9 && lateAbs < earlyAbs * 0.6) {
        shiftScore += 12; reasons.push('momentum slowing');
      }
      // Slope sign flip
      if (earlySlope.slopeUsdPerSec > 1e-9 && lateSlope.slopeUsdPerSec < -1e-9) {
        shiftScore += 30; reasons.push('slope flipped to sell');
      } else if (earlySlope.slopeUsdPerSec < -1e-9 && lateSlope.slopeUsdPerSec > 1e-9) {
        shiftScore += 30; reasons.push('slope flipped to buy');
      }
    }

    // 4. Body exhaustion — bodies shrinking in trend direction
    if (n >= 4 && (mom === 'UP' || mom === 'DOWN')) {
      const recent = candles.slice(-3);
      const prior = candles.slice(-6, -3);
      if (prior.length >= 2) {
        const avgRecentBody = recent.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / recent.length;
        const avgPriorBody = prior.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / prior.length;
        if (avgPriorBody > 0 && avgRecentBody < avgPriorBody * 0.45) {
          shiftScore += 20; reasons.push('bodies exhausting');
        }
      }
    }

    // 5. Failed new high/low — tried to extend but closed back
    if (n >= 3) {
      const c1 = candles[n - 3]!;
      const c2 = candles[n - 2]!;
      const c3 = candles[n - 1]!;
      if (mom === 'UP' && c2.h > c1.h && c3.c < c2.c && c3.c < c2.o) {
        shiftScore += 20; reasons.push('failed new high');
      }
      if (mom === 'DOWN' && c2.l < c1.l && c3.c > c2.c && c3.c > c2.o) {
        shiftScore += 20; reasons.push('failed new low');
      }
    }

    if (shiftScore >= 35) {
      shifting = true;
      shiftDir = biasScore > 0 ? 'TO DOWN' : biasScore < 0 ? 'TO UP' : (slope < 0 ? 'TO DOWN' : 'TO UP');
      shiftUrgency = shiftScore >= 60 ? 'IMMINENT' : 'FORMING';
    }

    return { bias, biasScore, shifting, shiftDir, shiftUrgency, reasons };
  }, [model, derivedStrip, pts, priceToBeat]);

  const trailPointsStr = useMemo(() => {
    if (!model || model.candles.length < 3) return null;
    const iw = W - PAD_L - PAD_R;
    const ih = H - PAD_Y * 2;
    const span = Math.max(1e-9, model.plotMax - model.plotMin);
    const tSpan = Math.max(1, model.tMax - model.tMin);
    const xTime = (t: number) => PAD_L + ((t - model.tMin) / tSpan) * iw;
    const yPrice = (v: number) => PAD_Y + (1 - (v - model.plotMin) / span) * ih;
    const take = model.candles.slice(-6);
    if (take.length < 3) return null;
    return take.map((c) => `${xTime((c.t0 + c.t1) / 2).toFixed(1)},${yPrice(c.c).toFixed(1)}`).join(' ');
  }, [model]);

  const ptbMarkers = useMemo(() => {
    if (!model || priceToBeat == null || !derivedStrip)
      return {
        rejection: null as null | { xc: number; yc: number },
        breakBox: null as null | { xc: number; y: number; w: number; h: number },
      };
    const iw = W - PAD_L - PAD_R;
    const ih = H - PAD_Y * 2;
    const span = Math.max(1e-9, model.plotMax - model.plotMin);
    const tSpan = Math.max(1, model.tMax - model.tMin);
    const xOf = (t: number) => PAD_L + ((t - model.tMin) / tSpan) * iw;
    const yOf = (v: number) => PAD_Y + (1 - (v - model.plotMin) / span) * ih;
    const eps = derivedStrip.reaction.eps;
    const candles = model.candles;
    let rejection: { xc: number; yc: number } | null = null;
    if (derivedStrip.interaction === 'rejection' || derivedStrip.reaction.kind === 'rejecting_off_line') {
      for (let i = candles.length - 1; i >= 0; i--) {
        const c = candles[i]!;
        if (!candleStraddlesPtb(c, priceToBeat, eps)) continue;
        const x0 = xOf(c.t0);
        const x1 = xOf(c.t1);
        const xc = (x0 + x1) / 2;
        const yc = (yOf(c.h) + yOf(c.l)) / 2;
        rejection = { xc, yc };
        break;
      }
    }
    let breakBox: { xc: number; y: number; w: number; h: number } | null = null;
    const k = derivedStrip.reaction.kind;
    if (k === 'break_hold' || k === 'extension_confirming') {
      for (let i = candles.length - 1; i >= 1; i--) {
        const cur = candles[i]!;
        const prev = candles[i - 1]!;
        if (!candleStraddlesPtb(prev, priceToBeat, eps) || candleStraddlesPtb(cur, priceToBeat, eps)) continue;
        const x0 = xOf(cur.t0);
        const x1 = xOf(cur.t1);
        const xc = (x0 + x1) / 2;
        const slotW = x1 - x0;
        const bodyW = Math.max(14, Math.min(slotW * 0.88, iw * 0.05));
        const yO = yOf(cur.o);
        const yC = yOf(cur.c);
        const bodyH = Math.max(6, Math.abs(yC - yO) * 1.12);
        const yBody = yC < yO ? yC : yO;
        breakBox = { xc, y: yBody - (bodyH - Math.abs(yC - yO)) / 2, w: bodyW, h: bodyH };
        break;
      }
    }
    return { rejection, breakBox };
  }, [model, derivedStrip, priceToBeat]);

  const width = W;
  const height = H;
  const padL = PAD_L;
  const padR = PAD_R;
  const padY = PAD_Y;
  const innerW = width - padL - padR;
  const innerH = height - padY * 2;

  /** Visual frame when PTB exists but we cannot plot candles yet (or no PTB at all). */
  const skeleton = useMemo(() => {
    if (priceToBeat != null && Number.isFinite(priceToBeat)) {
      let spotMin = priceToBeat;
      let spotMax = priceToBeat;
      for (let i = 0; i < pts.length; i++) {
        const v = pts[i]!.v;
        if (!Number.isFinite(v)) continue;
        if (v < spotMin) spotMin = v;
        if (v > spotMax) spotMax = v;
      }
      const needAbove = Math.max(0, spotMax - priceToBeat);
      const needBelow = Math.max(0, priceToBeat - spotMin);
      const halfSpan = Math.max(needAbove, needBelow, Math.abs(priceToBeat) * 3e-5, 1);
      let plotMin = priceToBeat - halfSpan * 1.08;
      let plotMax = priceToBeat + halfSpan * 1.08;
      if (!Number.isFinite(plotMin) || !Number.isFinite(plotMax) || !(plotMax > plotMin)) {
        plotMin = priceToBeat - Math.max(Math.abs(priceToBeat) * 5e-5, 2);
        plotMax = priceToBeat + Math.max(Math.abs(priceToBeat) * 5e-5, 2);
      }
      const band =
        pts.length >= 2 ? ptbTouchEpsilonUsd(pts, priceToBeat) : Math.max(Math.abs(priceToBeat) * 1.2e-4, 0.65, priceToBeat * 8e-5);
      const tEnd = pts.length >= 1 ? pts[pts.length - 1]!.t : lastUpdateMs ?? Date.now();
      let tMin = tEnd - 180_000;
      let tMax = tEnd;
      if (pts.length >= 1) {
        tMin = pts[0]!.t;
        tMax = pts.length >= 2 ? pts[pts.length - 1]!.t : pts[0]!.t + 90_000;
      }
      if (!(tMax > tMin)) tMax = tMin + 60_000;
      return { plotMin, plotMax, band, tMin, tMax, level: priceToBeat };
    }
    const plotMin = 0;
    const plotMax = 1;
    const tEnd = lastUpdateMs ?? Date.now();
    return { plotMin, plotMax, band: 0.05, tMin: tEnd - 180_000, tMax: tEnd, level: null as number | null };
  }, [priceToBeat, pts, lastUpdateMs]);

  if (!model) {
    const sk = skeleton;
    const sspan = Math.max(1e-9, sk.plotMax - sk.plotMin);
    const stSpan = Math.max(1, sk.tMax - sk.tMin);
    const skY = (v: number) => padY + (1 - (v - sk.plotMin) / sspan) * innerH;
    const skX = (t: number) => padL + ((t - sk.tMin) / stSpan) * innerW;
    const skYBeat = sk.level != null ? skY(sk.level) : padY + innerH * 0.5;
    const skBandTop = sk.level != null ? skY(sk.level + sk.band) : skYBeat - 40;
    const skBandBottom = sk.level != null ? skY(sk.level - sk.band) : skYBeat + 40;
    const tickPricesSk = Array.from({ length: 5 }, (_, i) => sk.plotMin + ((sk.plotMax - sk.plotMin) * i) / 4);
    const xTickTsSk = buildEvenXTicks(sk.tMin, sk.tMax);
    const skeletonMsg =
      sk.level == null
        ? 'Load SSR price-to-beat — the yellow line will lock here.'
        : pts.length === 0
          ? 'Waiting for first Chainlink spot tick…'
          : 'Waiting for a second tick to draw candles…';
    return (
      <div className="flex min-h-0 flex-col rounded-[30px] border border-zinc-800/90 bg-[#0b1018] shadow-[0_28px_80px_rgba(0,0,0,0.35)] ring-1 ring-zinc-700/40">
        <header className="shrink-0 border-b border-zinc-800/80 px-4 py-3 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-lg font-semibold tracking-tight text-zinc-100 sm:text-xl">{chartTitle}</span>
                <span
                  className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    mode === 'up' ? 'border-emerald-700/50 bg-emerald-950/40 text-emerald-200' : 'border-rose-700/50 bg-rose-950/40 text-rose-200'
                  }`}
                >
                  {meta.label}
                </span>
              </div>
              <p className="mt-2 max-w-xl text-sm text-zinc-400">{skeletonMsg}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {endsInMs != null ? (
                <div className="rounded-xl border border-amber-900/45 bg-amber-950/35 px-3 py-2 text-center">
                  <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-amber-200/85">Time remaining</div>
                  <div className="font-mono text-lg font-bold tabular-nums text-amber-50">{fmtTimeRemaining(endsInMs)}</div>
                </div>
              ) : null}
              <div
                className={`flex items-center gap-2 rounded-2xl border px-3 py-2 text-[11px] font-bold uppercase tracking-wide ${
                  stale ? 'border-zinc-700 bg-zinc-900 text-zinc-500' : 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${stale ? 'bg-zinc-600' : 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.65)]'}`} />
                Live
              </div>
            </div>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden px-3 pt-2 sm:px-4">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="block h-full min-h-[min(44vh,480px)] max-h-[min(62vh,560px)] w-full rounded-[24px] bg-[#0a0f16] [contain:paint]"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Spot versus price to beat chart frame"
          >
            <defs>
              <linearGradient id={`ptbSkBand-${gradId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(161, 161, 170, 0.14)" />
                <stop offset="100%" stopColor="rgba(161, 161, 170, 0.05)" />
              </linearGradient>
            </defs>
            <rect x="0" y="0" width={width} height={height} fill="#0a0f16" />
            {sk.level != null ? (
              <>
                <rect
                  x={padL}
                  y={Math.min(skBandTop, skBandBottom)}
                  width={innerW}
                  height={Math.max(14, Math.abs(skBandBottom - skBandTop))}
                  fill={`url(#ptbSkBand-${gradId})`}
                />
                <text
                  x={padL + 8}
                  y={Math.min(skBandTop, skBandBottom) - 6}
                  fill="rgb(161 161 170)"
                  fontSize="10"
                  fontWeight="700"
                >
                  [ NO EDGE ZONE ]
                </text>
              </>
            ) : null}
            {tickPricesSk.map((tp, i) => (
              <g key={`skg-${i}`}>
                <line x1={padL} x2={padL + innerW} y1={skY(tp)} y2={skY(tp)} stroke="rgba(39,39,42,0.85)" strokeWidth="1" />
                <text x={width - padR + 6} y={skY(tp) + 4} fill="rgb(161 161 170)" fontSize="10" fontFamily="ui-monospace, monospace">
                  {fmtAxisPrice(tp)}
                </text>
              </g>
            ))}
            <line x1={padL} x2={padL + innerW} y1={skYBeat} y2={skYBeat} stroke="rgb(250 204 21)" strokeWidth="9" strokeLinecap="round" opacity={0.2} />
            <line
              x1={padL}
              x2={padL + innerW}
              y1={skYBeat}
              y2={skYBeat}
              stroke={sk.level != null ? 'rgb(250 204 21)' : 'rgba(161,161,170,0.45)'}
              strokeWidth={sk.level != null ? 2.8 : 1.5}
              strokeDasharray={sk.level != null ? undefined : '8 6'}
              strokeLinecap="round"
            />
            <text x={padL + 8} y={skYBeat - 10} fill={sk.level != null ? 'rgb(250 204 21)' : 'rgb(161 161 170)'} fontSize="11" fontWeight="800">
              {sk.level != null ? 'PTB' : 'PTB (not loaded)'}
            </text>
            {sk.level != null ? (
              <>
                <rect x={width - padR - 136} y={Math.max(padY + 8, skYBeat - 14)} width="128" height="24" rx="12" fill="rgb(250 204 21)" />
                <text
                  x={width - padR - 72}
                  y={Math.max(padY + 24, skYBeat + 4)}
                  textAnchor="middle"
                  fill="#0a0a0a"
                  fontSize="11"
                  fontWeight="800"
                >
                  PTB {fmtUsd(sk.level)}
                </text>
              </>
            ) : null}
            {pts.length === 1 && sk.level != null ? (
              <circle cx={skX(pts[0]!.t)} cy={skY(pts[0]!.v)} r={7} fill="white" stroke={meta.accent} strokeWidth="2.2" opacity={0.95} />
            ) : null}
            <text x={padL + innerW / 2} y={padY + innerH * 0.42} textAnchor="middle" fill="rgb(113 113 122)" fontSize="13" fontWeight="600">
              {skeletonMsg}
            </text>
            <text x={padL + innerW / 2} y={padY + innerH * 0.52} textAnchor="middle" fill="rgb(82 82 91)" fontSize="11">
              Time →
            </text>
            {xTickTsSk.map((ts, i) => (
              <text
                key={`skxt-${i}`}
                x={skX(ts)}
                y={height - 4}
                textAnchor="middle"
                fill="rgb(113 113 122)"
                fontSize="9"
                fontFamily="ui-monospace, monospace"
              >
                {new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </text>
            ))}
          </svg>
        </div>
        <details className="mx-4 mb-3 mt-1 rounded-xl border border-zinc-800/50 bg-zinc-900/20 px-3 py-2 text-[11px] text-zinc-500">
          <summary className="cursor-pointer select-none font-semibold text-zinc-400">Attribution · framework</summary>
          <p className="mt-2 text-[10px] leading-snug text-zinc-600">{STREAM_ATTRIBUTION_LINE}</p>
          <p className="mt-2 text-zinc-500">{PTB_REACTION_ONE_LINER}</p>
        </details>
      </div>
    );
  }

  const span = Math.max(1e-9, model.plotMax - model.plotMin);
  const tSpan = Math.max(1, model.tMax - model.tMin);
  const yPrice = (v: number) => padY + (1 - (v - model.plotMin) / span) * innerH;
  const xTime = (t: number) => padL + ((t - model.tMin) / tSpan) * innerW;
  const yBeat = yPrice(priceToBeat!);
  const yBandTop = yPrice(priceToBeat! + model.band);
  const yBandBottom = yPrice(priceToBeat! - model.band);
  const tickPrices = Array.from({ length: 5 }, (_, i) => model.plotMin + ((model.plotMax - model.plotMin) * i) / 4);
  const xTickTs = buildEvenXTicks(model.tMin, model.tMax);
  const closeSeries =
    model.candles.length >= 2
      ? model.candles.map((c) => ({ x: xTime((c.t0 + c.t1) / 2), y: yPrice(c.c), v: c.c }))
      : pts.map((p) => ({ x: xTime(p.t), y: yPrice(p.v), v: p.v }));

  /** Raw ticks for LINE mode — smoother path on short timeframes than bucket mids. */
  const lineSeries = pts.map((p) => ({ x: xTime(p.t), y: yPrice(p.v), v: p.v }));
  const lineStroke = model.recentMove >= 0 ? 'rgb(74 222 128)' : 'rgb(251 113 133)';
  const lineFill = model.recentMove >= 0 ? 'rgba(74,222,128,0.14)' : 'rgba(251,113,133,0.14)';
  const linePathSeries = lineSeries.length >= 2 ? lineSeries : closeSeries;
  const lastPt = pts[pts.length - 1]!;
  const heatIntensity = clamp01(Math.abs(model.last - priceToBeat!) / Math.max(model.maxAbs, model.band * 1.5));
  const controlSig = derivedStrip?.controlSignal;
  const statusBarBorder =
    controlSig === 'UP_CONTROL'
      ? 'border-t-emerald-500/55'
      : controlSig === 'DOWN_CONTROL'
        ? 'border-t-rose-500/55'
        : controlSig === 'TRANSITION'
          ? 'border-t-amber-500/50'
          : controlSig === 'REJECTION'
            ? 'border-t-fuchsia-500/45'
            : 'border-t-zinc-600/60';

  const dwellTotal =
    derivedStrip != null ? derivedStrip.dwellAboveMs + derivedStrip.dwellBelowMs + derivedStrip.dwellAtMs : 0;
  const statusLine2 = statusSubtitle({ control: controlSig, momentum: derivedStrip?.momentum });
  const momArrow =
    derivedStrip?.momentum === 'UP' ? '↑' : derivedStrip?.momentum === 'DOWN' ? '↓' : '→';

  const positionVsPtbLabel = (() => {
    if (derivedStrip == null) return { title: '—', sub: 'Load data', className: 'border-zinc-600 bg-zinc-900/50 text-zinc-400' };
    const p = derivedStrip.position;
    if (p === 'ABOVE') {
      return {
        title: 'ABOVE PTB',
        sub: 'Spot is above the level (favors the "above PTB" side while price stays there)',
        className: 'border-emerald-500/50 bg-emerald-950/50 text-emerald-100',
      };
    }
    if (p === 'BELOW') {
      return {
        title: 'BELOW PTB',
        sub: 'Spot is under the level (favors the "below PTB" side while price stays there)',
        className: 'border-rose-500/50 bg-rose-950/50 text-rose-100',
      };
    }
    return {
      title: 'AT / CHOP',
      sub: 'Inside the touch band — edge vs settlement still unclear',
      className: 'border-amber-500/50 bg-amber-950/45 text-amber-100',
    };
  })();

  const pathNowLabel = (() => {
    if (derivedStrip == null) return { title: '—', sub: 'Candles in the visible window only', className: 'border-zinc-600 bg-zinc-900/50 text-zinc-400' };
    const m = derivedStrip.momentum;
    if (m === 'UP') {
      return {
        title: '↑ Pushing (short run)',
        sub: 'Recent buckets + slope: upward pressure — can still be below PTB on a bounce',
        className: 'border-sky-500/45 bg-sky-950/40 text-sky-100',
      };
    }
    if (m === 'DOWN') {
      return {
        title: '↓ Pressing (short run)',
        sub: 'Recent buckets + slope: downward pressure — can still be above PTB on a pullback',
        className: 'border-violet-500/40 bg-violet-950/35 text-violet-100',
      };
    }
    return {
      title: '→ Flat / mixed',
      sub: 'No clear candle push in this zoom — check Distance for side of line',
      className: 'border-zinc-500/50 bg-zinc-900/55 text-zinc-200',
    };
  })();

  const playbook = (() => {
    if (derivedStrip == null) {
      return {
        entry: '—',
        exit: '—',
        tp: '—',
        stop: '—',
        entryTone: 'border-zinc-700/60 bg-zinc-950/30 text-zinc-400',
        exitTone: 'border-zinc-700/60 bg-zinc-950/30 text-zinc-400',
      };
    }
    const bandHi = priceToBeat! + model.band;
    const bandLo = priceToBeat! - model.band;
    const hiTxt = fmtUsd(bandHi);
    const loTxt = fmtUsd(bandLo);
    const ptbTxt = fmtUsd(priceToBeat!);

    const inBand = derivedStrip.position === 'AT';
    const favorSide = mode === 'up' ? derivedStrip.position === 'ABOVE' : derivedStrip.position === 'BELOW';
    const againstSide = mode === 'up' ? derivedStrip.position === 'BELOW' : derivedStrip.position === 'ABOVE';
    const momAgree =
      mode === 'up' ? derivedStrip.momentum === 'UP' : derivedStrip.momentum === 'DOWN';
    const momAgainst =
      mode === 'up' ? derivedStrip.momentum === 'DOWN' : derivedStrip.momentum === 'UP';

    const entryBase = inBand
      ? `WAIT: let it separate outside the band (>${mode === 'up' ? hiTxt : loTxt}) and hold.`
      : favorSide
        ? `ENTER on pullback that stays outside the band (holds ${mode === 'up' ? hiTxt : loTxt}).`
        : `SKIP / FADE: you’re on the wrong side until reclaim (${mode === 'up' ? hiTxt : loTxt}).`;

    const exitBase = inBand
      ? `NO EDGE: exit if it can’t leave the band (around ${ptbTxt} ± ε).`
      : favorSide
        ? `EXIT if it re-enters the band (${loTxt}–${hiTxt}) or flips slope.`
        : `EXIT / don’t add until it reclaims the band edge (${mode === 'up' ? hiTxt : loTxt}).`;

    const entryAdd =
      derivedStrip.controlSignal === 'REJECTION'
        ? ' Rejection: wait for next clean hold.'
        : derivedStrip.controlSignal === 'TRANSITION'
          ? ' Transition: size down; confirm hold.'
          : momAgainst
            ? ' Momentum disagrees: avoid chasing.'
            : momAgree
              ? ' Momentum agrees: ok to press on confirmation.'
              : '';

    const exitAdd =
      derivedStrip.controlSignal === 'REJECTION'
        ? ' Treat as invalidation until reclaimed.'
        : derivedStrip.controlSignal === 'TRANSITION'
          ? ' Tighten risk; watch for rotation.'
          : '';

    const slope = derivedStrip.slopeUsdPerSec;
    const canProject = slope != null && Number.isFinite(slope) && !inBand && favorSide;
    const tpSec = 30;
    const projTp = canProject ? model.last + slope * tpSec : null;
    const tp =
      canProject && projTp != null
        ? `TP (proj ${tpSec}s): ${fmtUsd(projTp)}`
        : inBand
          ? `TP: — (in band)`
          : favorSide
            ? 'TP: — (need slope)'
            : 'TP: — (wrong side)';

    const stop =
      inBand
        ? `Stop: ${loTxt}–${hiTxt} (band)`
        : favorSide
          ? `Stop: back into band (${loTxt}–${hiTxt})`
          : `Stop: reclaim ${mode === 'up' ? hiTxt : loTxt}`;

    const entryTone = againstSide
      ? 'border-rose-700/50 bg-rose-950/20 text-rose-100'
      : inBand
        ? 'border-amber-700/50 bg-amber-950/15 text-amber-100'
        : 'border-emerald-700/50 bg-emerald-950/15 text-emerald-100';

    const exitTone = inBand
      ? 'border-amber-700/50 bg-amber-950/15 text-amber-100'
      : favorSide
        ? 'border-sky-700/45 bg-sky-950/15 text-sky-100'
        : 'border-zinc-700/60 bg-zinc-950/25 text-zinc-200';

    return {
      entry: `${entryBase}${entryAdd}`,
      exit: `${exitBase}${exitAdd}`,
      tp,
      stop,
      entryTone,
      exitTone,
    };
  })();

  const projection = (() => {
    if (derivedStrip == null) return null;
    const slope = derivedStrip.slopeUsdPerSec;
    if (slope == null || !Number.isFinite(slope)) return null;
    const t1 = 30;
    const t2 = 60;
    const p1 = model.last + slope * t1;
    const p2 = model.last + slope * t2;
    const hasStreak = derivedStrip.momentumStreak >= 3;
    return {
      p1,
      p2,
      t1,
      t2,
      label: `Proj ${t1}s`,
      sub: hasStreak ? `${derivedStrip.momentum} ×${derivedStrip.momentumStreak}` : null,
    };
  })();

  return (
    <div className="flex min-h-0 flex-col rounded-[30px] border border-zinc-800/90 bg-[#0b1018] shadow-[0_28px_80px_rgba(0,0,0,0.35)] ring-1 ring-zinc-700/40">
      <header className="shrink-0 border-b border-zinc-800/80 bg-[#0b1018] px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="truncate text-lg font-semibold tracking-tight text-zinc-100 sm:text-xl">{chartTitle}</span>
            <span
              className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                mode === 'up' ? 'border-emerald-700/50 bg-emerald-950/40 text-emerald-200' : 'border-rose-700/50 bg-rose-950/40 text-rose-200'
              }`}
            >
              {meta.label}
            </span>
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-zinc-50 sm:text-3xl">{fmtUsd(model.last)}</span>
            <span className={`text-sm font-semibold tabular-nums ${model.recentMove >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {fmtUsdSigned(model.recentMove)} <span className="font-normal text-zinc-500">({fmtPctSigned(model.pctChange)})</span>
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {endsInMs != null ? (
              <div className="rounded-xl border border-amber-900/45 bg-amber-950/35 px-3 py-2 text-center shadow-sm shadow-black/20">
                <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-amber-200/85">Time remaining</div>
                <div className="font-mono text-lg font-bold tabular-nums leading-tight text-amber-50">{fmtTimeRemaining(endsInMs)}</div>
              </div>
            ) : null}
            <div className="inline-flex rounded-2xl border border-zinc-800/80 bg-black/25 p-1 shadow-inner shadow-black/30">
              <button
                type="button"
                onClick={() => setDisplayMode('line')}
                className={`rounded-xl px-3 py-2 text-[11px] font-semibold sm:px-4 sm:text-[12px] ${
                  displayMode === 'line' ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                LINE
              </button>
              <button
                type="button"
                onClick={() => setDisplayMode('ohlc')}
                className={`rounded-xl px-3 py-2 text-[11px] font-semibold sm:px-4 sm:text-[12px] ${
                  displayMode === 'ohlc' ? 'bg-zinc-600 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                OHLC
              </button>
            </div>
            <div className="inline-flex rounded-2xl border border-zinc-800/80 bg-black/25 p-1 shadow-inner shadow-black/30">
              {([60, 120, 300] as const).map((sec) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => setZoomWindow(sec)}
                  className={`rounded-xl px-2.5 py-2 text-[11px] font-semibold ${
                    zoomWindow === sec ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {sec < 120 ? '1m' : sec < 300 ? '2m' : '5m'}
                </button>
              ))}
            </div>
            <div className={`rounded-2xl border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide ${
              model.status === 'UP BIAS'
                ? 'border-emerald-800/50 bg-emerald-950/30 text-emerald-200'
                : model.status === 'DOWN BIAS'
                  ? 'border-rose-800/50 bg-rose-950/30 text-rose-200'
                  : 'border-zinc-700/60 bg-zinc-900/40 text-zinc-200'
            }`}>
              {model.status}
            </div>
            <div
              className={`flex items-center gap-2 rounded-2xl border px-3 py-2 text-[11px] font-bold uppercase tracking-wide ${
                stale ? 'border-zinc-700 bg-zinc-900 text-zinc-500' : 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300'
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${stale ? 'bg-zinc-600' : 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.65)]'}`} />
              Live
            </div>
          </div>
        </div>
        <div className="mt-3 flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-3">
          <div
            className={`min-w-0 flex-1 rounded-xl border-2 px-3 py-2.5 shadow-md shadow-black/30 ${positionVsPtbLabel.className}`}
            title="Where spot is vs the fixed PTB: which side of the level is ahead right now, not the tick path."
          >
            <div className="text-[9px] font-extrabold uppercase tracking-[0.18em] text-inherit/90">1 · Level (vs PTB)</div>
            <div className="mt-0.5 text-lg font-black leading-tight tracking-tight sm:text-xl">{positionVsPtbLabel.title}</div>
            <div className="mt-1 text-[10px] leading-snug text-inherit/95">{positionVsPtbLabel.sub}</div>
          </div>
          <div
            className={`min-w-0 flex-1 rounded-xl border-2 px-3 py-2.5 shadow-md shadow-black/30 ${pathNowLabel.className}`}
            title="Candles + slope in the visible 1m–5m window only — can disagree with the level (pullback, bounce)."
          >
            <div className="text-[9px] font-extrabold uppercase tracking-[0.18em] text-inherit/90">2 · Path (this window)</div>
            <div className="mt-0.5 text-lg font-black leading-tight tracking-tight sm:text-xl">{pathNowLabel.title}</div>
            <div className="mt-1 text-[10px] leading-snug text-inherit/95">{pathNowLabel.sub}</div>
          </div>
        </div>
        <p className="mt-2 text-[10px] leading-snug text-zinc-600">
          <span className="font-semibold text-zinc-500">Read</span> — how spot behaves vs the fixed PTB line ·{' '}
          <span className="text-amber-200/80">Yellow</span> = PTB · LINE = ticks · OHLC = buckets
        </p>
        <details className="mt-2 rounded-lg border border-zinc-800/70 bg-black/25 px-3 py-2 text-[10px] leading-relaxed text-zinc-500 open:bg-black/35">
          <summary className="cursor-pointer select-none font-semibold text-zinc-400 marker:text-zinc-600">
            Chart read — axis, tints, time window, momentum (tap)
          </summary>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-zinc-500">
            <li>
              <span className="text-zinc-400">USD axis is not inverted:</span> higher underlying = toward the{' '}
              <strong className="text-zinc-300">top</strong> of the chart; PTB is the yellow line.
            </li>
            <li>
              <span className="text-zinc-400">Green / red wash:</span> area <strong className="text-zinc-300">above</strong> PTB = spot
              <strong className="text-zinc-300"> above</strong> the level; <strong className="text-zinc-300">below</strong> PTB = spot{' '}
              <strong className="text-zinc-300">below</strong> — not “price good/bad”, only side of the line.
            </li>
            <li>
              <span className="text-zinc-400">Time scope:</span> only the last <strong className="text-zinc-300">{zoomWindow}s</strong> of ticks are
              plotted; wider swings happened earlier are off-screen.
            </li>
            <li>
              <span className="text-zinc-400">↑ MOM / ↓ MOM badge:</span> recent <strong className="text-zinc-300">bucket candle direction</strong>{' '}
              (plus slope) — a <strong className="text-zinc-300">↓</strong> pullback can print while spot is still above PTB.
            </li>
            <li>
              <span className="text-zinc-400">{meta.label}:</span> tints the <strong className="text-zinc-300">hint card</strong> for your
              selected outcome; it does <strong className="text-zinc-300">not</strong> flip the price scale.
            </li>
          </ul>
        </details>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden px-3 pt-2 sm:px-4 [contain:paint]">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="block h-full min-h-[min(44vh,480px)] max-h-[min(62vh,560px)] w-full rounded-[24px] bg-[#0a0f16] [contain:strict]"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Spot price versus PTB"
        >
          <defs>
            <linearGradient id={`ptbFocusBand-${gradId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(161, 161, 170, 0.18)" />
              <stop offset="100%" stopColor="rgba(161, 161, 170, 0.06)" />
            </linearGradient>
            <linearGradient id={`heatAbove-${gradId}`} gradientUnits="userSpaceOnUse" x1={0} y1={yBeat} x2={0} y2={padY}>
              <stop offset="0%" stopColor="rgb(34 197 94)" stopOpacity={0} />
              <stop offset="100%" stopColor="rgb(21 128 61)" stopOpacity={0.06 + 0.22 * heatIntensity} />
            </linearGradient>
            <linearGradient id={`heatBelow-${gradId}`} gradientUnits="userSpaceOnUse" x1={0} y1={yBeat} x2={0} y2={padY + innerH}>
              <stop offset="0%" stopColor="rgb(248 113 113)" stopOpacity={0} />
              <stop offset="100%" stopColor="rgb(185 28 28)" stopOpacity={0.06 + 0.22 * heatIntensity} />
            </linearGradient>
            <marker id={`trailArr-${gradId}`} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="strokeWidth">
              <polygon points="0 1, 10 5, 0 9" fill="rgb(226 232 240)" fillOpacity={0.85} />
            </marker>
          </defs>

          <rect x="0" y="0" width={width} height={height} fill="#0a0f16" />

          <rect x={padL} y={Math.min(yBandTop, yBandBottom)} width={innerW} height={Math.max(12, Math.abs(yBandBottom - yBandTop))} fill={`url(#ptbFocusBand-${gradId})`} />
          <g>
            <title>
              Narrow ±ε band around PTB (touch / chop). Wider separation from the line is outside this band — do not
              confuse band height with how far spot is from PTB in dollars; use the right-hand price labels.
            </title>
            <text
              x={padL + 8}
              y={Math.min(yBandTop, yBandBottom) - 6}
              fill="rgb(161 161 170)"
              fontSize="10"
              fontWeight="700"
            >
              [ NO EDGE ZONE ]
            </text>
          </g>

          <rect x={padL} y={padY} width={innerW} height={Math.max(0, yBeat - padY)} fill={`url(#heatAbove-${gradId})`} className="pointer-events-none">
            <title>{`USD above PTB (spot > ${fmtUsd(priceToBeat!)}) — green tint`}</title>
          </rect>
          <rect x={padL} y={yBeat} width={innerW} height={Math.max(0, padY + innerH - yBeat)} fill={`url(#heatBelow-${gradId})`} className="pointer-events-none">
            <title>{`USD below PTB (spot < ${fmtUsd(priceToBeat!)}) — red tint`}</title>
          </rect>

          {closeSeries.length >= 2 ? (
            <path
              d={`M ${closeSeries[0]!.x.toFixed(1)} ${yBeat.toFixed(1)} ${closeSeries.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')} L ${closeSeries[closeSeries.length - 1]!.x.toFixed(1)} ${yBeat.toFixed(1)} Z`}
              fill={meta.soft}
              className="pointer-events-none"
            />
          ) : null}

          {tickPrices.map((tp, i) => (
            <g key={`grid-${i}`}>
              <line x1={padL} x2={padL + innerW} y1={yPrice(tp)} y2={yPrice(tp)} stroke="rgba(39,39,42,0.8)" strokeWidth="1" />
              <text
                x={width - padR + 6}
                y={yPrice(tp) + 4}
                fill="rgb(212 212 216)"
                fontSize="11"
                fontFamily="ui-monospace, monospace"
                stroke="rgb(10 15 22)"
                strokeWidth="0.6"
                paintOrder="stroke"
              >
                {fmtAxisPrice(tp)}
              </text>
            </g>
          ))}
          <g>
            <text
              x={padL + 6}
              y={padY + 16}
              textAnchor="start"
              fontSize="12"
              fontWeight="800"
              fontFamily="ui-sans-serif, system-ui, sans-serif"
              fill="rgb(212 212 216)"
              stroke="rgb(10 15 22)"
              strokeWidth="2.2"
              strokeLinejoin="round"
              paintOrder="stroke fill"
            >
              HIGHER $
            </text>
            <text
              x={padL + 6}
              y={padY + innerH - 3}
              textAnchor="start"
              fontSize="12"
              fontWeight="800"
              fontFamily="ui-sans-serif, system-ui, sans-serif"
              fill="rgb(212 212 216)"
              stroke="rgb(10 15 22)"
              strokeWidth="2.2"
              strokeLinejoin="round"
              paintOrder="stroke fill"
            >
              LOWER $
            </text>
          </g>

          {/* Price levels (S/R) */}
          {priceLevels.map((lv, i) => {
            const y = yPrice(lv.price);
            const isHigh = lv.kind === 'high';
            const color = isHigh ? 'rgb(251 146 60)' : 'rgb(96 165 250)';
            return (
              <g key={`lvl-${i}`} className="pointer-events-none">
                <line x1={padL} x2={padL + innerW} y1={y} y2={y} stroke={color} strokeWidth="1.2" strokeDasharray="6 3" opacity={0.6} />
                <rect x={padL + 2} y={y - 8} width={isHigh ? 12 : 10} height={14} rx="3" fill={color} fillOpacity={0.15} />
                <text x={padL + 5} y={y + 3} fill={color} fontSize="8" fontWeight="700" opacity={0.85}>
                  {isHigh ? 'R' : 'S'}
                </text>
                <text x={padL + 18} y={y - 2} fill={color} fontSize="9" fontFamily="ui-monospace, monospace" opacity={0.7}>
                  {fmtAxisPrice(lv.price)}
                </text>
              </g>
            );
          })}

          {displayMode === 'line' ? (() => {
              const fill_d = `M ${linePathSeries[0]!.x.toFixed(1)} ${(padY + innerH).toFixed(1)} ${linePathSeries.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')} L ${linePathSeries[linePathSeries.length - 1]!.x.toFixed(1)} ${(padY + innerH).toFixed(1)} Z`;
              let upD = '';
              let dnD = '';
              for (let i = 1; i < linePathSeries.length; i++) {
                const prev = linePathSeries[i - 1]!;
                const cur = linePathSeries[i]!;
                const seg = `M${prev.x.toFixed(1)} ${prev.y.toFixed(1)}L${cur.x.toFixed(1)} ${cur.y.toFixed(1)}`;
                if (cur.v >= prev.v) upD += seg; else dnD += seg;
              }
              return (
                <>
                  <path d={fill_d} fill={lineFill} className="pointer-events-none" />
                  {upD && <path d={upD} fill="none" stroke="rgb(74 222 128)" strokeWidth={2.75} strokeLinecap="round" />}
                  {dnD && <path d={dnD} fill="none" stroke="rgb(248 113 113)" strokeWidth={2.75} strokeLinecap="round" />}
                </>
              );
            })() : (
            model.candles.map((c, i) => {
              const x0 = xTime(c.t0);
              const x1 = xTime(c.t1);
              const xc = (x0 + x1) / 2;
              const slotW = x1 - x0;
              const bodyW = Math.max(18, Math.min(slotW * 0.82, innerW * 0.07));
              const yO = yPrice(c.o);
              const yC = yPrice(c.c);
              const yH = yPrice(c.h);
              const yL = yPrice(c.l);
              const bullish = c.c >= c.o;
              const bodyTop = Math.min(yO, yC);
              const bodyBot = Math.max(yO, yC);
              const rawBodyH = bodyBot - bodyTop;
              const bodyH = Math.max(4, rawBodyH);
              const bodyY = bodyTop - (bodyH - rawBodyH) / 2;
              const wickColor = bullish ? 'rgb(34 197 94)' : 'rgb(239 68 68)';
              const bodyFill = bullish ? 'rgb(22 163 74)' : 'rgb(220 38 38)';
              const bodyStroke = bullish ? 'rgb(74 222 128)' : 'rgb(248 113 113)';
              return (
                <g key={`candle-${i}`}>
                  <line x1={xc} x2={xc} y1={yH} y2={bodyY} stroke={wickColor} strokeWidth={1.6} />
                  <line x1={xc} x2={xc} y1={bodyY + bodyH} y2={yL} stroke={wickColor} strokeWidth={1.6} />
                  <rect
                    x={xc - bodyW / 2}
                    y={bodyY}
                    width={bodyW}
                    height={bodyH}
                    fill={bodyFill}
                    stroke={bodyStroke}
                    strokeWidth={1.2}
                  />
                </g>
              );
            })
          )}

          {trailPointsStr ? (
            <polyline
              points={trailPointsStr}
              fill="none"
              stroke="rgb(226 232 240)"
              strokeWidth="2.2"
              strokeOpacity={0.7}
              strokeLinecap="round"
              strokeLinejoin="round"
              markerEnd={`url(#trailArr-${gradId})`}
              className="pointer-events-none"
            />
          ) : null}

          <line x1={padL} x2={padL + innerW} y1={yBeat} y2={yBeat} stroke="rgb(253 224 71)" strokeWidth={9} strokeLinecap="round" opacity={0.18} />
          <line
            x1={padL}
            x2={padL + innerW}
            y1={yBeat}
            y2={yBeat}
            stroke="rgb(250 234 80)"
            strokeWidth={3}
            strokeLinecap="round"
            opacity={1}
          />
          <text x={padL + 8} y={yBeat - 10} fill="rgb(253 224 71)" fontSize="11" fontWeight="800">
            PTB
          </text>
          <rect x={width - padR - 136} y={Math.max(padY + 8, yBeat - 14)} width="128" height="24" rx="12" fill="rgb(250 234 80)" />
          <text x={width - padR - 72} y={Math.max(padY + 24, yBeat + 4)} textAnchor="middle" fill="#0a0a0a" fontSize="11" fontWeight="800">
            PTB {fmtUsd(priceToBeat)}
          </text>

          {ptbMarkers.breakBox ? (
            <rect
              x={ptbMarkers.breakBox.xc - ptbMarkers.breakBox.w / 2 - 3}
              y={ptbMarkers.breakBox.y - 3}
              width={ptbMarkers.breakBox.w + 6}
              height={ptbMarkers.breakBox.h + 6}
              rx="4"
              fill="none"
              stroke="rgb(250 234 80)"
              strokeWidth="2.2"
              opacity={0.95}
            />
          ) : null}
          {ptbMarkers.rejection ? (
            <g transform={`translate(${ptbMarkers.rejection.xc},${ptbMarkers.rejection.yc})`} opacity={0.92}>
              <line x1={-7} y1={-7} x2={7} y2={7} stroke="rgb(251 113 133)" strokeWidth="2.4" strokeLinecap="round" />
              <line x1={-7} y1={7} x2={7} y2={-7} stroke="rgb(251 113 133)" strokeWidth="2.4" strokeLinecap="round" />
            </g>
          ) : null}

          <circle cx={xTime(lastPt.t)} cy={yPrice(lastPt.v)} r={7} fill="white" stroke={lineStroke} strokeWidth={2.5} />

          {/* Momentum badge on chart */}
          {derivedStrip ? (() => {
            const momLabel = derivedStrip.momentum === 'UP' ? '↑ MOM' : derivedStrip.momentum === 'DOWN' ? '↓ MOM' : '→ FLAT';
            const momColor = derivedStrip.momentum === 'UP' ? 'rgb(52 211 153)' : derivedStrip.momentum === 'DOWN' ? 'rgb(251 113 133)' : 'rgb(161 161 170)';
            const momBg = derivedStrip.momentum === 'UP' ? 'rgba(16,185,129,0.2)' : derivedStrip.momentum === 'DOWN' ? 'rgba(248,113,113,0.2)' : 'rgba(113,113,122,0.15)';
            const badgeX = xTime(lastPt.t) + 14;
            const badgeY = yPrice(lastPt.v) - 16;
            const streak = derivedStrip.momentumStreak;
            return (
              <g className="pointer-events-none">
                <title>
                  Recent OHLC bucket direction (and streak). Not the same as “spot above PTB”: e.g. ↓ MOM can show
                  during a small pullback while spot is still above the yellow line.
                </title>
                <rect x={badgeX - 2} y={badgeY - 10} width={streak >= 2 ? 72 : 56} height={18} rx="9" fill={momBg} stroke={momColor} strokeWidth="1.2" strokeOpacity={0.7} />
                <text x={badgeX + 4} y={badgeY + 2} fill={momColor} fontSize="10" fontWeight="800" fontFamily="ui-monospace, monospace">
                  {momLabel}{streak >= 2 ? ` x${streak}` : ''}
                </text>
              </g>
            );
          })() : null}

          {/* Momentum buildup gauge — top-right of chart */}
          {buildup && buildup.tier !== 'NONE' ? (() => {
            const gx = width - padR - 160;
            const gy = padY + 6;
            const barW = 100;
            const barH = 8;
            const fill01 = buildup.score / 100;
            const tierColor = buildup.tier === 'FIRING' ? 'rgb(250 204 21)' :
              buildup.tier === 'READY' ? 'rgb(52 211 153)' :
              buildup.tier === 'BUILDING' ? 'rgb(96 165 250)' : 'rgb(161 161 170)';
            const tierBg = buildup.tier === 'FIRING' ? 'rgba(250,204,21,0.15)' :
              buildup.tier === 'READY' ? 'rgba(52,211,153,0.12)' :
              buildup.tier === 'BUILDING' ? 'rgba(96,165,250,0.1)' : 'rgba(161,161,170,0.08)';
            const arrow = buildup.direction === 'UP' ? '▲' : buildup.direction === 'DOWN' ? '▼' : '◆';
            return (
              <g className="pointer-events-none">
                <rect x={gx - 6} y={gy - 2} width={barW + 68} height={34} rx="8" fill={tierBg} stroke={tierColor} strokeWidth="0.8" strokeOpacity={0.5} />
                <text x={gx} y={gy + 10} fill={tierColor} fontSize="9" fontWeight="800" fontFamily="ui-monospace, monospace">
                  {arrow} {buildup.tier}
                </text>
                <rect x={gx} y={gy + 16} width={barW} height={barH} rx={barH / 2} fill="rgba(39,39,42,0.8)" />
                <rect x={gx} y={gy + 16} width={barW * fill01} height={barH} rx={barH / 2} fill={tierColor} />
                <text x={gx + barW + 6} y={gy + 24} fill={tierColor} fontSize="10" fontWeight="700" fontFamily="ui-monospace, monospace">
                  {buildup.score}
                </text>
              </g>
            );
          })() : null}

          {/* Bias meter — left side vertical bar */}
          {biasShift ? (() => {
            const bx = padL + 4;
            const by = padY + 8;
            const bH = Math.min(innerH - 20, 160);
            const mid = by + bH / 2;
            const fill01 = (biasShift.biasScore + 100) / 200;
            const needleY = by + bH * (1 - fill01);
            const biasColor = biasShift.biasScore >= 30 ? 'rgb(52 211 153)' : biasShift.biasScore <= -30 ? 'rgb(248 113 113)' : 'rgb(161 161 170)';
            return (
              <g className="pointer-events-none">
                <rect x={bx} y={by} width={6} height={bH} rx={3} fill="rgba(39,39,42,0.7)" />
                <rect x={bx} y={mid} width={6} height={1} fill="rgba(161,161,170,0.5)" />
                <rect x={bx - 1} y={Math.min(needleY, mid)} width={8} height={Math.max(2, Math.abs(needleY - mid))} rx={2}
                  fill={biasColor} opacity={0.85} />
                <circle cx={bx + 3} cy={needleY} r={5} fill={biasColor} stroke="#0a0f16" strokeWidth={2} />
                <text x={bx + 14} y={by + 3} fill="rgb(113 113 122)" fontSize="7" fontWeight="700">
                  {(upLabel ?? 'UP').slice(0, 6).toUpperCase()}
                </text>
                <text x={bx + 14} y={by + bH + 1} fill="rgb(113 113 122)" fontSize="7" fontWeight="700">
                  {(downLabel ?? 'DOWN').slice(0, 6).toUpperCase()}
                </text>
                <text x={bx + 14} y={needleY + 3} fill={biasColor} fontSize="9" fontWeight="800" fontFamily="ui-monospace, monospace">
                  {biasShift.bias}
                </text>
                {biasShift.shifting ? (
                  <g>
                    <rect x={bx + 14} y={needleY + 8} width={biasShift.shiftUrgency === 'IMMINENT' ? 80 : 66} height={16} rx={4}
                      fill={biasShift.shiftUrgency === 'IMMINENT' ? 'rgba(250,204,21,0.2)' : 'rgba(250,204,21,0.1)'}
                      stroke="rgb(250 204 21)" strokeWidth={biasShift.shiftUrgency === 'IMMINENT' ? 1.2 : 0.8} />
                    <text x={bx + 18} y={needleY + 20} fill="rgb(250 204 21)" fontSize="8" fontWeight="800" fontFamily="ui-monospace, monospace">
                      ⚡ {biasShift.shiftUrgency} {biasShift.shiftDir}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })() : null}

          {xTickTs.map((ts, i) => (
            <text
              key={`xt-${i}`}
              x={xTime(ts)}
              y={height - 4}
              textAnchor="middle"
              fill="rgb(113 113 122)"
              fontSize="9"
              fontFamily="ui-monospace, monospace"
            >
              {new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </text>
          ))}
        </svg>
      </div>

      <section
        className={`shrink-0 border-t-2 bg-zinc-950/85 px-4 py-4 text-zinc-100 sm:px-5 ${statusBarBorder}`}
        title={derivedStrip?.controlBlurb ?? undefined}
      >
        <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Status</div>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-2xl font-black uppercase leading-none tracking-tight sm:text-3xl">
              {controlSig ? controlSig.replaceAll('_', ' ') : '…'}
            </div>
            {statusLine2 ? <div className="mt-1.5 text-sm font-medium text-zinc-500">({statusLine2})</div> : null}
            <p className="mt-2 max-w-prose text-[11px] leading-snug text-zinc-600">{model.hint}</p>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Distance</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-zinc-100">{fmtPctSigned(model.distancePct)}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Time below</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-zinc-100">
                {derivedStrip ? pctOfTotal(derivedStrip.dwellBelowMs, dwellTotal) : '—'}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Time above</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-zinc-100">
                {derivedStrip ? pctOfTotal(derivedStrip.dwellAboveMs, dwellTotal) : '—'}
              </div>
            </div>
            <div title="Share of visible-window time inside the ±ε PTB touch band (chop / no edge).">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Time at band</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-zinc-100">
                {derivedStrip ? pctOfTotal(derivedStrip.dwellAtMs, dwellTotal) : '—'}
              </div>
            </div>
            <div className="col-span-2 sm:col-span-3 lg:col-span-1" title="Bucket candle direction + slope over the visible window — can disagree with spot still above/below PTB on a pullback.">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Candle momentum</div>
              <div className="mt-0.5 font-mono text-lg font-bold text-zinc-100">
                {momArrow}{' '}
                <span className="text-sm font-semibold text-zinc-400">
                  {derivedStrip?.momentum ?? '—'}
                  {derivedStrip && derivedStrip.momentumStreak >= 2 ? ` ×${derivedStrip.momentumStreak}` : ''}
                </span>
              </div>
              <div className="mt-0.5 text-[9px] leading-snug text-zinc-600">Short-horizon OHLC trend, not “vs PTB” by itself</div>
            </div>
          </div>
        </div>
        <div className="mt-3 grid gap-2 lg:grid-cols-2">
          <div className={`rounded-xl border px-3 py-2 ${playbook.entryTone}`} title="Entry trigger is framed as: outside band + hold; not a prediction.">
            <div className="text-[9px] font-extrabold uppercase tracking-[0.18em] text-inherit/90">Entry</div>
            <div className="mt-1 text-[11px] leading-snug text-inherit/95">{playbook.entry}</div>
            <div className="mt-1 text-[10px] font-semibold text-inherit/80">{playbook.stop}</div>
          </div>
          <div className={`rounded-xl border px-3 py-2 ${playbook.exitTone}`} title="Exit/invalidation is framed as: back into band or rotation; keep it mechanical.">
            <div className="text-[9px] font-extrabold uppercase tracking-[0.18em] text-inherit/90">Exit</div>
            <div className="mt-1 text-[11px] leading-snug text-inherit/95">{playbook.exit}</div>
            <div className="mt-1 text-[10px] font-semibold text-inherit/85">{playbook.tp}</div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-zinc-400">
          <span
            className="rounded border border-zinc-600/70 bg-zinc-950/80 px-2 py-1 font-mono text-zinc-200"
            title={derivedStrip?.structureEventLabel ?? undefined}
          >
            {derivedStrip?.structureEvent?.replaceAll('_', ' ') ?? '—'} · Δ {derivedStrip ? fmtUsdSigned(derivedStrip.distanceUsd) : '—'}
          </span>
          <span
            className="rounded border border-zinc-600/70 bg-zinc-950/80 px-2 py-1 font-mono text-zinc-200"
            title={derivedStrip != null ? `Tick slope window ~${Math.round(derivedStrip.slopeWindowMs / 1000)}s, n=${derivedStrip.slopeSampleCount}` : undefined}
          >
            Slope {derivedStrip ? `${derivedStrip.slopeUsdPerMin >= 0 ? '+' : ''}${derivedStrip.slopeUsdPerMin.toFixed(3)}/m` : '—'}
          </span>
          {projection ? (
            <span
              className="rounded border border-indigo-600/40 bg-indigo-950/25 px-2 py-1 font-mono text-indigo-100"
              title={`Linear extrapolation: current tick slope × time. Not a prediction.\n${projection.t1}s → ${fmtUsd(projection.p1)}\n${projection.t2}s → ${fmtUsd(projection.p2)}${projection.sub ? `\n(${projection.sub})` : ''}`}
            >
              {projection.label} → {fmtUsd(projection.p1)}
            </span>
          ) : null}
          <span className="rounded border border-zinc-700/60 bg-black/30 px-2 py-1 text-zinc-500">
            {model.conviction}
          </span>
        </div>

        {buildup && buildup.tier !== 'NONE' ? (() => {
          const tierColor = buildup.tier === 'FIRING' ? 'border-yellow-500/60 bg-yellow-950/30'
            : buildup.tier === 'READY' ? 'border-emerald-500/50 bg-emerald-950/25'
            : buildup.tier === 'BUILDING' ? 'border-blue-500/40 bg-blue-950/20'
            : 'border-zinc-700/50 bg-zinc-900/30';
          const textColor = buildup.tier === 'FIRING' ? 'text-yellow-200'
            : buildup.tier === 'READY' ? 'text-emerald-200'
            : buildup.tier === 'BUILDING' ? 'text-blue-200'
            : 'text-zinc-400';
          const barColor = buildup.tier === 'FIRING' ? 'bg-yellow-400'
            : buildup.tier === 'READY' ? 'bg-emerald-400'
            : buildup.tier === 'BUILDING' ? 'bg-blue-400'
            : 'bg-zinc-500';
          const arrow = buildup.direction === 'UP' ? '▲' : buildup.direction === 'DOWN' ? '▼' : '◆';
          return (
            <div className={`mt-3 rounded-xl border px-3 py-2.5 ${tierColor}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className={`font-mono text-base font-black ${textColor}`}>{arrow} {buildup.tier}</span>
                  <span className={`font-mono text-xs font-bold tabular-nums ${textColor}`}>{buildup.score}/100</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {buildup.signals.map((s, i) => (
                    <span key={i} className={`rounded-md border border-current/20 px-1.5 py-0.5 text-[10px] font-semibold ${textColor}`}>{s}</span>
                  ))}
                </div>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800/80">
                <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${buildup.score}%` }} />
              </div>
              <p className={`mt-1.5 text-[10px] leading-snug ${textColor} opacity-80`}>{buildup.label}</p>
            </div>
          );
        })() : null}

        {biasShift ? (() => {
          const isUp = biasShift.biasScore > 0;
          const strength = Math.abs(biasShift.biasScore);
          const biasBarColor = isUp ? 'bg-emerald-400' : biasShift.biasScore < 0 ? 'bg-rose-400' : 'bg-zinc-500';
          const biasTextColor = isUp ? 'text-emerald-200' : biasShift.biasScore < 0 ? 'text-rose-200' : 'text-zinc-400';
          const biasBorder = biasShift.shifting
            ? (biasShift.shiftUrgency === 'IMMINENT' ? 'border-yellow-500/70 bg-yellow-950/20' : 'border-yellow-600/40 bg-yellow-950/10')
            : (isUp ? 'border-emerald-700/40 bg-emerald-950/15' : biasShift.biasScore < 0 ? 'border-rose-700/40 bg-rose-950/15' : 'border-zinc-700/40 bg-zinc-900/20');
          return (
            <div className={`mt-3 rounded-xl border px-3 py-2.5 ${biasBorder}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div>
                    <div className="text-[9px] font-bold uppercase tracking-wide text-zinc-500">Bias</div>
                    <div className={`font-mono text-lg font-black leading-tight ${biasTextColor}`}>
                      {isUp ? '▲' : biasShift.biasScore < 0 ? '▼' : '◆'} {biasShift.bias}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <div className="h-2 w-28 overflow-hidden rounded-full bg-zinc-800/80">
                      <div className={`h-full rounded-full ${biasBarColor}`} style={{ width: `${strength}%`, marginLeft: isUp ? '50%' : `${50 - strength}%` }} />
                    </div>
                    <div className="flex justify-between text-[7px] font-bold text-zinc-600">
                      <span>SELL</span><span>NEUTRAL</span><span>BUY</span>
                    </div>
                  </div>
                </div>
                {biasShift.shifting ? (
                  <div className={`rounded-lg border px-2.5 py-1.5 ${biasShift.shiftUrgency === 'IMMINENT' ? 'border-yellow-400/60 bg-yellow-400/10' : 'border-yellow-500/30 bg-yellow-500/5'}`}>
                    <div className={`font-mono text-xs font-black ${biasShift.shiftUrgency === 'IMMINENT' ? 'text-yellow-200' : 'text-yellow-300/80'}`}>
                      ⚡ SHIFT {biasShift.shiftUrgency} {biasShift.shiftDir}
                    </div>
                  </div>
                ) : null}
              </div>
              {biasShift.reasons.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {biasShift.reasons.map((r, i) => (
                    <span key={i} className="rounded-md border border-yellow-600/30 bg-yellow-950/15 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-200/80">{r}</span>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })() : null}
      </section>

      <details className="mx-4 mb-3 mt-1 rounded-xl border border-zinc-800/50 bg-zinc-900/20 px-3 py-2 text-[11px] text-zinc-500 ring-1 ring-white/[0.02]">
        <summary className="cursor-pointer select-none font-semibold text-zinc-400">Chart details · engine · attribution</summary>
        <p className="mt-2 text-[10px] leading-snug text-zinc-600">{STREAM_ATTRIBUTION_LINE}</p>
        <p className="mt-2 leading-relaxed text-zinc-500">{PTB_REACTION_ONE_LINER}</p>
        <ul className="mt-2 list-inside list-disc space-y-1 text-zinc-500">
          {PTB_REACTION_DIMENSIONS.map((d) => (
            <li key={d.title}>
              <span className="font-semibold text-zinc-400">{d.title}</span> — {d.body}
            </li>
          ))}
        </ul>
        <div className="mt-3 rounded-lg border border-zinc-800/60 bg-black/25 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-amber-100/90">
          <span className="font-semibold text-amber-200/90">PTB read</span> — {derivedStrip?.interactionLabel ?? 'Scoring…'}
        </div>
      </details>
    </div>
  );
});
