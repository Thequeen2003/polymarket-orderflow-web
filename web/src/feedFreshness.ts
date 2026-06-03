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
  const tRaw = anchorMs > 0 ? anchorMs : Date.now();
  const t = normalizeEpochMs(tRaw) ?? tRaw;
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
  const tRaw = anchorMs > 0 ? anchorMs : Date.now();
  const t = normalizeEpochMs(tRaw) ?? tRaw;
  const last = base[base.length - 1]!;
  const lastT = normalizeEpochMs(last.t) ?? last.t;
  const midDelta = Math.abs((last.v ?? 0) - liveMid);
  if (t <= lastT + 400) {
    if (midDelta < 0.0002) {
      // Mid flat but poll is fresh — bump timestamp so stale badges stay live.
      if (t > lastT) return [...base.slice(0, -1), { t, v: last.v ?? liveMid }];
      return base;
    }
    // Same poll window but mid moved — refresh last point so lag/delta readouts tick live.
    return [...base.slice(0, -1), { t: Math.max(lastT, t), v: liveMid }];
  }
  return [...base.slice(-479), { t, v: liveMid }];
}

/** Pin latest RTDS spot onto slug series so the PTB chart line ticks with live spot. */
export function appendLiveSpotSeries(series: SpotPoint[], liveSpot: number | null, anchorMs: number): SpotPoint[] {
  if (liveSpot == null || !Number.isFinite(liveSpot)) return series;
  const tRaw = anchorMs > 0 ? anchorMs : Date.now();
  const t = normalizeEpochMs(tRaw) ?? tRaw;
  if (!series.length) {
    return [
      { t: t - 2000, v: liveSpot },
      { t: t - 1000, v: liveSpot },
      { t, v: liveSpot },
    ];
  }
  const last = series[series.length - 1]!;
  const lastT = normalizeEpochMs(last.t) ?? last.t;
  const delta = Math.abs(last.v - liveSpot);
  if (t <= lastT + 400) {
    if (delta < 1e-9) {
      // Spot flat but poll is fresh — bump timestamp so stale badges stay live.
      if (t > lastT) return [...series.slice(0, -1), { t, v: last.v }];
      return series;
    }
    // Same poll window — refresh last point so the chart line tracks live spot.
    return [...series.slice(0, -1), { t: Math.max(lastT, t), v: liveSpot }];
  }
  return [...series.slice(-479), { t, v: liveSpot }];
}
