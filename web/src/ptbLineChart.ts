export type PtbLinePoint = { t: number; v: number };

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Normalize implied-mid history to epoch-ms timestamps in [0,1]. */
export function normalizeProbSeries(pts: PtbLinePoint[]): PtbLinePoint[] {
  const out = pts
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .map((p) => ({ t: p.t, v: clamp01(p.v) }))
    .sort((a, b) => a.t - b.t);
  if (out.length < 2) return out;
  const tMax = out[out.length - 1]!.t;
  const isEpochMs = tMax > 50_000_000_000;
  if (!isEpochMs) return out.map((p) => ({ t: p.t * 1000, v: p.v }));
  return out;
}

/** Pad sparse series so candle windows have a positive span. */
export function padProbSeries(pts: PtbLinePoint[]): PtbLinePoint[] {
  if (pts.length === 0) return [];
  if (pts.length === 1) {
    const p = pts[0]!;
    return [p, { t: p.t + 1, v: p.v }];
  }
  const out = pts.map((p) => ({ t: p.t, v: p.v }));
  const t0 = out[0]!.t;
  const t1 = out[out.length - 1]!.t;
  if (!(t1 > t0)) {
    const last = out[out.length - 1]!;
    out[out.length - 1] = { t: t0 + 1, v: last.v };
  }
  return out;
}

/** Symmetric [0,1] window around 0.5 for dual PTB overlay strips. */
export function extentSymProb(minV: number, maxV: number): { min: number; max: number } {
  const lo = clamp01(minV);
  const hi = clamp01(maxV);
  const R = Math.max(0.06, Math.abs(lo - 0.5), Math.abs(hi - 0.5)) * 1.14;
  return { min: clamp01(0.5 - R), max: clamp01(0.5 + R) };
}

export function downsampleLinePoints(pts: PtbLinePoint[], maxN: number): PtbLinePoint[] {
  if (pts.length <= maxN) return pts;
  const step = Math.ceil(pts.length / maxN);
  const out: PtbLinePoint[] = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[i]!);
  const last = pts[pts.length - 1]!;
  if (out[out.length - 1]!.t !== last.t) out.push(last);
  return out;
}

/** Per-segment stroke: green up / yellow slowing / red down / zinc flat. */
export function segmentMomentumStyle(
  vPrev: number | null,
  v0: number,
  v1: number,
  t0: number,
  t1: number,
  speedScore01: number,
): { stroke: string; strokeWidth: number } {
  const dv = v1 - v0;
  const dt = Math.max(1e-9, t1 - t0);
  const rate = dv / dt;
  const prevLeg = vPrev != null ? v0 - vPrev : 0;
  const accel = dv - prevLeg;

  const flat = Math.abs(rate) * dt < 2e-7 || Math.abs(dv) < 1e-6;
  if (flat) {
    return { stroke: 'rgb(161 161 170)', strokeWidth: 2.4 };
  }

  if (dv < -0.00008) {
    return { stroke: 'rgb(248 113 113)', strokeWidth: 3.4 };
  }

  if (dv > 0.00008) {
    const slowing = accel < -0.00004 || rate < prevLeg / Math.max(1e-9, t1 - t0) * 0.85;
    if (slowing) {
      return { stroke: 'rgb(250 204 21)', strokeWidth: 3.1 };
    }
    return { stroke: 'rgb(52 235 120)', strokeWidth: 3.8 + speedScore01 * 1.6 };
  }

  return { stroke: 'rgb(234 179 8)', strokeWidth: 2.9 };
}

/** Fixed palette per contract: UP = emerald family, DOWN = rose family; width scales with tape + |Δv|/Δt. */
export function segmentDualLaneStyle(
  lane: 'up' | 'down',
  vPrev: number | null,
  v0: number,
  v1: number,
  t0: number,
  t1: number,
  speedScore01: number,
): { stroke: string; strokeWidth: number } {
  void vPrev;
  const dv = v1 - v0;
  const dt = Math.max(1e-9, t1 - t0);
  const rate = Math.abs(dv) / dt;
  const w = Math.max(2, Math.min(8.6, 2.05 + speedScore01 * 3.65 + Math.min(3.5, rate * 2.15e6)));

  const flat = Math.abs(dv) < 1e-6;
  if (lane === 'up') {
    if (flat) return { stroke: 'rgb(113 113 122)', strokeWidth: Math.max(1.85, w * 0.88) };
    if (dv > 0.00006) return { stroke: 'rgb(52 211 153)', strokeWidth: w };
    if (dv < -0.00006) return { stroke: 'rgb(20 184 166)', strokeWidth: w * 0.94 };
    return { stroke: 'rgb(163 230 53)', strokeWidth: w * 0.9 };
  }
  if (flat) return { stroke: 'rgb(113 113 122)', strokeWidth: Math.max(1.85, w * 0.88) };
  if (dv > 0.00006) return { stroke: 'rgb(251 113 133)', strokeWidth: w };
  if (dv < -0.00006) return { stroke: 'rgb(244 63 94)', strokeWidth: w * 0.94 };
  return { stroke: 'rgb(251 146 60)', strokeWidth: w * 0.9 };
}
