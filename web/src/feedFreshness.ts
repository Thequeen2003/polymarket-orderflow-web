import type { SpotPoint } from './SpotLevelChart';

/** Normalize epoch seconds vs ms for feed-freshness clocks. */
export function normalizeEpochMs(t: number | null | undefined): number | null {
  if (t == null || !Number.isFinite(t) || t <= 0) return null;
  return t > 50_000_000_000 ? t : t * 1000;
}

export function maxFeedMs(...values: (number | null | undefined)[]): number | null {
  let max: number | null = null;
  for (const v of values) {
    const n = normalizeEpochMs(v);
    if (n == null) continue;
    if (max == null || n > max) max = n;
  }
  return max;
}

export function lastPointMs(points: readonly { t: number }[]): number | null {
  if (!points.length) return null;
  return normalizeEpochMs(points[points.length - 1]!.t);
}

/** Seed a flat line when the ring buffer is cold; keeps charts + mids aligned. */
export function seedProbSeriesFromLiveMid(series: SpotPoint[], liveMid: number | null, anchorMs: number): SpotPoint[] {
  if (series.length >= 2) return series;
  if (liveMid == null || !Number.isFinite(liveMid) || liveMid <= 0 || liveMid >= 1) return series;
  const t = anchorMs > 0 ? anchorMs : Date.now();
  if (series.length === 1) {
    const p = series[0]!;
    return [
      { t: Math.min(p.t, t - 2000), v: p.v },
      { t: Math.max(p.t, t - 1000), v: p.v },
      { t, v: liveMid },
    ];
  }
  return [
    { t: t - 2000, v: liveMid },
    { t: t - 1000, v: liveMid },
    { t, v: liveMid },
  ];
}

/** Pin the latest CLOB mid onto the prob series when the book moved but no new ring point arrived. */
export function appendLiveMidSeries(series: SpotPoint[], liveMid: number | null, anchorMs: number): SpotPoint[] {
  const base = seedProbSeriesFromLiveMid(series, liveMid, anchorMs);
  if (liveMid == null || !Number.isFinite(liveMid) || liveMid <= 0 || liveMid >= 1) return base;
  if (!base.length) {
    return seedProbSeriesFromLiveMid([], liveMid, anchorMs);
  }
  const t = anchorMs > 0 ? anchorMs : Date.now();
  const last = base[base.length - 1]!;
  const lastT = normalizeEpochMs(last.t) ?? last.t;
  if (t <= lastT + 400 && Math.abs((last.v ?? 0) - liveMid) < 0.0002) return base;
  return [...base.slice(-479), { t, v: liveMid }];
}
