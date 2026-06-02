/**
 * Momentum-weighted price projection for outcome tokens (0–1 scale, displayed as ¢).
 *
 * Blends:
 *   1. OLS slope on the prob-mid series (drift per second)
 *   2. Acceleration (late-vs-early slope ratio)
 *   3. Tape pressure bias (net aggressor flow nudges drift)
 *   4. Confidence decay with horizon
 *
 * All prices are in 0–1 (probability) internally; the component displays ×100 as cents.
 */

export type ProjectionTick = { t: number; v: number };

export type MomentumProjectionPoint = {
  label: string;
  horizonSec: number;
  /** Projected price (0–1 scale). */
  price01: number;
  /** Change from current (0–1 scale). */
  delta01: number;
  /** Upper confidence bound (0–1 clamped). */
  hi01: number;
  /** Lower confidence bound (0–1 clamped). */
  lo01: number;
  /** 0–1: how much we trust this projection (decays with horizon). */
  confidence: number;
};

export type MomentumProjectionResult = {
  /** Current mid (0–1). */
  now01: number;
  /** Effective drift (01/sec) after adjustments. */
  effectiveSlope01PerSec: number;
  /** Raw OLS slope before adjustments. */
  rawSlope01PerSec: number;
  regime: 'accelerating' | 'decelerating' | 'reversing' | 'steady';
  points: MomentumProjectionPoint[];
};

const DEFAULT_HORIZONS: { label: string; sec: number }[] = [
  { label: '30s', sec: 30 },
  { label: '1m', sec: 60 },
  { label: '2m', sec: 120 },
  { label: '5m', sec: 300 },
];

function olsSlope(pts: ProjectionTick[]): number {
  if (pts.length < 2) return 0;
  const t0 = pts[0]!.t;
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) {
    const x = (p.t - t0) / 1000;
    const y = p.v;
    sx += x; sy += y; sxx += x * x; sxy += x * y; n++;
  }
  const d = n * sxx - sx * sx;
  if (Math.abs(d) < 1e-12) return 0;
  return (n * sxy - sx * sy) / d;
}

function rmsResidual(pts: ProjectionTick[]): number {
  if (pts.length < 3) return 0;
  const t0 = pts[0]!.t;
  const slope = olsSlope(pts);
  const intercept = pts[0]!.v;
  let sumSq = 0;
  for (const p of pts) {
    const pred = intercept + slope * ((p.t - t0) / 1000);
    sumSq += (p.v - pred) ** 2;
  }
  return Math.sqrt(sumSq / pts.length);
}

function sliceFromEnd(pts: ProjectionTick[], ms: number): ProjectionTick[] {
  if (!pts.length) return [];
  const cutoff = pts[pts.length - 1]!.t - ms;
  const out: ProjectionTick[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i]!.t < cutoff) break;
    out.push(pts[i]!);
  }
  out.reverse();
  return out;
}

const clamp01 = (v: number) => Math.max(0.01, Math.min(0.99, v));

export function computeMomentumProjection(params: {
  /** Outcome token mid history (v in 0–1). */
  pts: ProjectionTick[];
  /** Tape net pressure -100..100 (buy-heavy > 0). */
  tapeNetPressure?: number | null;
  /** Custom horizons. */
  horizons?: { label: string; sec: number }[];
}): MomentumProjectionResult | null {
  const { pts, tapeNetPressure } = params;
  if (pts.length < 3) return null;

  const now01 = pts[pts.length - 1]!.v;
  if (!Number.isFinite(now01) || now01 <= 0 || now01 >= 1) return null;

  const horizons = params.horizons ?? DEFAULT_HORIZONS;

  const rawSlope = olsSlope(pts);

  // Late (60s) vs early (prior 120s) slope for acceleration detection
  const late = sliceFromEnd(pts, 60_000);
  const earlySlice: ProjectionTick[] = [];
  const cutoffEarly = pts[pts.length - 1]!.t - 60_000;
  const cutoffEarlyStart = cutoffEarly - 120_000;
  for (const p of pts) {
    if (p.t >= cutoffEarlyStart && p.t < cutoffEarly) earlySlice.push(p);
  }

  const slopeLate = late.length >= 3 ? olsSlope(late) : rawSlope;
  const slopeEarly = earlySlice.length >= 3 ? olsSlope(earlySlice) : rawSlope;

  let accelMultiplier = 1.0;
  let regime: MomentumProjectionResult['regime'] = 'steady';

  const absLate = Math.abs(slopeLate);
  const absEarly = Math.max(Math.abs(slopeEarly), 1e-12);
  const sameSign = slopeLate * slopeEarly > 0;

  if (sameSign && absLate > absEarly * 1.3) {
    accelMultiplier = 1.0 + Math.min(0.4, (absLate / absEarly - 1) * 0.3);
    regime = 'accelerating';
  } else if (sameSign && absLate < absEarly * 0.6) {
    accelMultiplier = 0.6 + (absLate / absEarly) * 0.4;
    regime = 'decelerating';
  } else if (!sameSign && absLate > absEarly * 0.3) {
    accelMultiplier = 0.3;
    regime = 'reversing';
  }

  // Tape pressure nudge
  let tapeBias = 0;
  if (tapeNetPressure != null && Number.isFinite(tapeNetPressure) && Math.abs(tapeNetPressure) > 20) {
    const maxBias = Math.max(Math.abs(rawSlope) * 0.15, 0.00002);
    tapeBias = (tapeNetPressure / 100) * maxBias;
  }

  const effectiveSlope = rawSlope * accelMultiplier + tapeBias;

  // Volatility for bands
  const recent = sliceFromEnd(pts, 120_000);
  const vol = recent.length >= 5 ? rmsResidual(recent) : Math.abs(rawSlope) * 5;
  const spanSec = recent.length > 1
    ? (recent[recent.length - 1]!.t - recent[0]!.t) / 1000
    : 60;
  const volPerSqrtSec = vol / Math.sqrt(Math.max(1, spanSec));

  const points: MomentumProjectionPoint[] = horizons.map(({ label, sec }) => {
    const raw = now01 + effectiveSlope * sec;
    const price01 = clamp01(raw);
    const sigma = volPerSqrtSec * Math.sqrt(sec);
    const confidence = Math.max(0.1, Math.min(1, 1 - sec / 600));
    return {
      label,
      horizonSec: sec,
      price01,
      delta01: price01 - now01,
      hi01: clamp01(raw + sigma),
      lo01: clamp01(raw - sigma),
      confidence,
    };
  });

  return {
    now01,
    effectiveSlope01PerSec: effectiveSlope,
    rawSlope01PerSec: rawSlope,
    regime,
    points,
  };
}
