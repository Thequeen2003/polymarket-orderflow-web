import type { SeriesPoint } from './MomentumChart';
import type { SpotPoint } from './SpotLevelChart';

function windowSlice<T extends { t: number }>(pts: T[], windowMs: number): T[] {
  if (pts.length === 0) return [];
  const end = pts[pts.length - 1]!.t;
  const start = end - windowMs;
  return pts.filter((p) => p.t >= start);
}

function finite(vals: Array<number | null | undefined>): number[] {
  return vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
}

function slopePerSec(pts: { t: number; v: number | null }[]): number | null {
  const xs = pts.filter((p) => typeof p.v === 'number' && Number.isFinite(p.v as number));
  if (xs.length < 2) return null;
  const a = xs[xs.length - 1]!;
  const b = xs[0]!;
  const dt = Math.max(1, (a.t - b.t) / 1000);
  return ((a.v as number) - (b.v as number)) / dt;
}

function stdev(vals: number[]): number | null {
  if (vals.length < 2) return null;
  const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
  const v = vals.reduce((s, x) => s + (x - mean) ** 2, 0) / (vals.length - 1);
  return Math.sqrt(v);
}

function maxAbsDelta(vals: number[]): number | null {
  if (vals.length < 2) return null;
  let m = 0;
  for (let i = 1; i < vals.length; i++) m = Math.max(m, Math.abs(vals[i]! - vals[i - 1]!));
  return m;
}

export type MomentumLiveContext = {
  aLast: number | null;
  bLast: number | null;
  aSlope15s: number | null;
  bSlope15s: number | null;
  spreadNow: number | null;
  spikePp15s: number | null;
  read: string;
};

export function describeMomentum(params: {
  a: SeriesPoint[];
  b: SeriesPoint[];
}): MomentumLiveContext {
  const aLast = params.a.slice().reverse().find((p) => p.v != null)?.v ?? null;
  const bLast = params.b.slice().reverse().find((p) => p.v != null)?.v ?? null;
  const a15 = windowSlice(params.a, 15_000);
  const b15 = windowSlice(params.b, 15_000);
  const aSlope15s = slopePerSec(a15);
  const bSlope15s = slopePerSec(b15);
  const spreadNow = aLast != null && bLast != null ? aLast + bLast - 1 : null; // in two-outcome markets, sum~1
  const aVals15 = finite(a15.map((p) => p.v));
  const bVals15 = finite(b15.map((p) => p.v));
  const spike = Math.max(maxAbsDelta(aVals15) ?? 0, maxAbsDelta(bVals15) ?? 0) || null;
  const spikePp15s = spike != null ? spike * 100 : null;

  const parts: string[] = [];
  if (aSlope15s != null && bSlope15s != null) {
    if (aSlope15s > 0 && bSlope15s < 0) parts.push('Up odds rising; Down falling (directional push).');
    else if (aSlope15s < 0 && bSlope15s > 0) parts.push('Down odds rising; Up falling (directional push).');
    else parts.push('Both sides moving together (often spread/noise, not direction).');
  } else {
    parts.push('Not enough recent points for a clean read.');
  }
  if (spikePp15s != null && spikePp15s >= 1.5) parts.push('Spike detected: a fast jump in mid (likely a sweep or liquidity pull).');
  if (spreadNow != null && Math.abs(spreadNow) > 0.08) parts.push('Sum of mids deviates from 1 → book is thin/wide; interpret cautiously.');

  return {
    aLast,
    bLast,
    aSlope15s,
    bSlope15s,
    spreadNow,
    spikePp15s,
    read: parts.join(' '),
  };
}

export type SpotLiveContext = {
  spotNow: number | null;
  dist: number | null;
  slope15s: number | null;
  slope1m: number | null;
  vol15s: number | null;
  spikeUsd15s: number | null;
  read: string;
};

export function describeSpot(params: { spot: SpotPoint[]; priceToBeat: number | null }): SpotLiveContext {
  const pts = params.spot.slice(-240);
  const spotNow = pts.length ? pts[pts.length - 1]!.v : null;
  const dist = spotNow != null && params.priceToBeat != null ? spotNow - params.priceToBeat : null;

  const w15 = windowSlice(pts, 15_000);
  const w1m = windowSlice(pts, 60_000);
  const slope15s = slopePerSec(w15.map((p) => ({ t: p.t, v: p.v })));
  const slope1m = slopePerSec(w1m.map((p) => ({ t: p.t, v: p.v })));
  const v15 = finite(w15.map((p) => p.v));
  const vol15s = stdev(v15);
  const spikeUsd15s = maxAbsDelta(v15);

  const parts: string[] = [];
  if (dist != null) parts.push(dist >= 0 ? 'Above the level now.' : 'Below the level now.');
  if (slope15s != null) parts.push(slope15s > 0 ? 'Short-term drift up.' : slope15s < 0 ? 'Short-term drift down.' : 'Flat in the last ~15s.');
  if (spikeUsd15s != null && vol15s != null && spikeUsd15s > Math.max(0.1, vol15s * 2.5))
    parts.push('Spike detected (fast print / feed jump).');

  return { spotNow, dist, slope15s, slope1m, vol15s, spikeUsd15s, read: parts.join(' ') };
}

