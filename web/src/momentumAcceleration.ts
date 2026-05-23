/**
 * Detect whether spot momentum is accelerating, decelerating, or steady, plus a
 * "thrust" score that quantifies how much the late-window slope dominates the
 * early-window slope. Pure functions — used by the machine readout.
 *
 * Output is intentionally narrow:
 *   - state:  'accel-up' | 'accel-down' | 'decel' | 'steady' | 'reversing'
 *   - thrust: 0..100  (how much the recent move dominates the prior tape)
 *   - slopeLateUsdPerSec, slopeEarlyUsdPerSec
 *
 * `accel-*` means the *recent* slope is significantly larger in magnitude than
 * the prior slope and they share a sign. `reversing` means the signs differ.
 * `decel` means recent slope is meaningfully smaller in magnitude.
 */

export type AccelTick = { t: number; v: number };

export type MomentumAcceleration = {
  state: 'accel-up' | 'accel-down' | 'decel' | 'steady' | 'reversing' | 'idle';
  thrust: number;
  slopeLateUsdPerSec: number;
  slopeEarlyUsdPerSec: number;
  /** Convenience: late slope direction. */
  direction: 'up' | 'down' | 'flat';
  /** Short, user-facing line. */
  summary: string;
};

const IDLE: MomentumAcceleration = {
  state: 'idle',
  thrust: 0,
  slopeLateUsdPerSec: 0,
  slopeEarlyUsdPerSec: 0,
  direction: 'flat',
  summary: 'Not enough ticks to read acceleration.',
};

function olsSlope(slice: AccelTick[]): number {
  if (slice.length < 2) return 0;
  const t0 = slice[0]!.t;
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  let n = 0;
  for (const p of slice) {
    const x = (p.t - t0) / 1000;
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

function sliceFromEnd(pts: AccelTick[], windowMs: number): AccelTick[] {
  if (pts.length === 0) return [];
  const tEnd = pts[pts.length - 1]!.t;
  const start = tEnd - windowMs;
  const out: AccelTick[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i]!.t < start) break;
    out.push(pts[i]!);
  }
  out.reverse();
  return out;
}

function sliceWindow(pts: AccelTick[], fromMsAgo: number, toMsAgo: number): AccelTick[] {
  if (pts.length === 0) return [];
  const tEnd = pts[pts.length - 1]!.t;
  const a = tEnd - fromMsAgo;
  const b = tEnd - toMsAgo;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const out: AccelTick[] = [];
  for (const p of pts) if (p.t >= lo && p.t <= hi) out.push(p);
  return out;
}

/**
 * @param pts          Spot ticks (oldest → newest).
 * @param lateMs       Late-window length (default 60s).
 * @param earlyMs      Early-window length immediately preceding late (default 120s).
 * @param minTickCount Minimum ticks per window to consider (default 4).
 */
export function detectMomentumAcceleration(
  pts: AccelTick[],
  opts?: { lateMs?: number; earlyMs?: number; minTickCount?: number },
): MomentumAcceleration {
  const lateMs = Math.max(5_000, opts?.lateMs ?? 60_000);
  const earlyMs = Math.max(5_000, opts?.earlyMs ?? 120_000);
  const minTicks = Math.max(2, opts?.minTickCount ?? 4);
  if (pts.length < minTicks * 2) return IDLE;

  const lateSlice = sliceFromEnd(pts, lateMs);
  const earlySlice = sliceWindow(pts, lateMs + earlyMs, lateMs);

  if (lateSlice.length < minTicks || earlySlice.length < minTicks) return IDLE;

  const slopeLate = olsSlope(lateSlice);
  const slopeEarly = olsSlope(earlySlice);

  const absLate = Math.abs(slopeLate);
  const absEarly = Math.abs(slopeEarly);

  // Thrust = magnitude of the late slope normalized by the larger of the two,
  // amplified when signs agree, dampened when signs differ.
  const denom = Math.max(absLate, absEarly, 1e-6);
  let thrust = (absLate / denom) * 100;
  const signsMatch = Math.sign(slopeLate) === Math.sign(slopeEarly) && slopeLate !== 0;
  if (!signsMatch) thrust *= 0.6;
  thrust = Math.max(0, Math.min(100, thrust));

  const direction: MomentumAcceleration['direction'] =
    slopeLate > 0 ? 'up' : slopeLate < 0 ? 'down' : 'flat';

  const accelRatio = absLate / Math.max(absEarly, 1e-6);
  let state: MomentumAcceleration['state'];

  if (absLate < 0.01 && absEarly < 0.01) {
    state = 'steady';
  } else if (Math.sign(slopeLate) !== 0 && Math.sign(slopeEarly) !== 0 && Math.sign(slopeLate) !== Math.sign(slopeEarly)) {
    state = 'reversing';
  } else if (accelRatio >= 1.5 && absLate >= 0.05) {
    state = slopeLate > 0 ? 'accel-up' : 'accel-down';
  } else if (accelRatio <= 0.5 && absEarly >= 0.05) {
    state = 'decel';
  } else {
    state = 'steady';
  }

  let summary: string;
  switch (state) {
    case 'accel-up':
      summary = `Accelerating UP — late slope ${slopeLate.toFixed(2)}/s vs prior ${slopeEarly.toFixed(2)}/s.`;
      break;
    case 'accel-down':
      summary = `Accelerating DOWN — late slope ${slopeLate.toFixed(2)}/s vs prior ${slopeEarly.toFixed(2)}/s.`;
      break;
    case 'decel':
      summary = `Decelerating — late ${slopeLate.toFixed(2)}/s, prior ${slopeEarly.toFixed(2)}/s.`;
      break;
    case 'reversing':
      summary = `Reversing — late ${slopeLate.toFixed(2)}/s, prior ${slopeEarly.toFixed(2)}/s.`;
      break;
    case 'steady':
      summary = `Steady — slope around ${slopeLate.toFixed(2)}/s.`;
      break;
    default:
      summary = 'Not enough ticks to read acceleration.';
  }

  return {
    state,
    thrust,
    slopeLateUsdPerSec: slopeLate,
    slopeEarlyUsdPerSec: slopeEarly,
    direction,
    summary,
  };
}
