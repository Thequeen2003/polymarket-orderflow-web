/**
 * Detect when the recent move is unusually large versus the normal range — the
 * "anti-chase" guard. Goal: stop the system from flashing INITIATE on the third
 * leg of a vertical move where mean reversion is most likely.
 *
 * Method:
 *   1. Take the last `windowMs` of ticks and measure absolute net move.
 *   2. Slide back through prior windows of the same length to build a baseline
 *      of typical moves; take the median.
 *   3. Ratio = recent / median. If ratio > `flagAt` (default 2.5) flag as
 *      OVEREXTENDED. Severity scales 0..100.
 *
 * Pure module, no React.
 */

export type OverTick = { t: number; v: number };

export type OverextensionState = 'normal' | 'stretched' | 'overextended' | 'idle';

export type Overextension = {
  state: OverextensionState;
  /** Recent absolute net $ move over the active window. */
  recentMoveUsd: number;
  /** Median absolute net $ move across the baseline windows. */
  baselineMedianUsd: number;
  /** Ratio recent/baseline (capped to 0..50 for sanity). */
  ratio: number;
  /** Severity 0..100; >=70 = overextended. */
  severity: number;
  /** Direction of the recent move ('up' | 'down' | 'flat'). */
  direction: 'up' | 'down' | 'flat';
  /** Short, user-facing summary. */
  summary: string;
};

const IDLE: Overextension = {
  state: 'idle',
  recentMoveUsd: 0,
  baselineMedianUsd: 0,
  ratio: 0,
  severity: 0,
  direction: 'flat',
  summary: 'Not enough ticks to gauge overextension.',
};

function netMove(slice: OverTick[]): number {
  if (slice.length < 2) return 0;
  return slice[slice.length - 1]!.v - slice[0]!.v;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/**
 * @param windowMs        Length of the "recent" window (default 60s).
 * @param baselineCount   How many prior windows to use for the baseline (default 8 → 8 minutes baseline at 60s windows).
 * @param flagAt          Ratio that triggers OVEREXTENDED (default 2.5).
 * @param stretchedAt     Ratio that triggers STRETCHED (default 1.6).
 * @param minBandUsd      Minimum baseline floor in $ (so a flat tape doesn't divide-by-zero into infinity).
 */
export function detectOverextension(
  pts: OverTick[],
  opts?: {
    windowMs?: number;
    baselineCount?: number;
    flagAt?: number;
    stretchedAt?: number;
    minBandUsd?: number;
  },
): Overextension {
  const windowMs = Math.max(15_000, opts?.windowMs ?? 60_000);
  const baselineCount = Math.max(3, opts?.baselineCount ?? 8);
  const flagAt = opts?.flagAt ?? 2.5;
  const stretchedAt = opts?.stretchedAt ?? 1.6;
  const minBand = Math.max(0.05, opts?.minBandUsd ?? 0.5);

  if (pts.length < 6) return IDLE;
  const tEnd = pts[pts.length - 1]!.t;
  const tStart = pts[0]!.t;
  if (tEnd - tStart < windowMs * 2) return IDLE;

  function sliceRange(loT: number, hiT: number): OverTick[] {
    const out: OverTick[] = [];
    for (const p of pts) if (p.t >= loT && p.t <= hiT) out.push(p);
    return out;
  }

  const recentSlice = sliceRange(tEnd - windowMs, tEnd);
  if (recentSlice.length < 2) return IDLE;
  const recentNet = netMove(recentSlice);
  const recentAbs = Math.abs(recentNet);
  const direction: Overextension['direction'] =
    recentAbs < minBand / 4 ? 'flat' : recentNet > 0 ? 'up' : 'down';

  const baselineMoves: number[] = [];
  for (let k = 1; k <= baselineCount; k++) {
    const lo = tEnd - windowMs * (k + 1);
    const hi = tEnd - windowMs * k;
    if (lo < tStart - 1) break;
    const sub = sliceRange(lo, hi);
    if (sub.length >= 2) baselineMoves.push(Math.abs(netMove(sub)));
  }
  if (baselineMoves.length < 3) return IDLE;
  const baseline = Math.max(minBand, median(baselineMoves));
  const ratio = Math.min(50, recentAbs / baseline);

  let state: OverextensionState;
  if (ratio >= flagAt) state = 'overextended';
  else if (ratio >= stretchedAt) state = 'stretched';
  else state = 'normal';

  // Severity scales 0..100; ratio of `flagAt` = 70, ratio of `flagAt + 1.5` ≈ 100.
  const severity = Math.max(
    0,
    Math.min(100, Math.round(((ratio - 1) / Math.max(0.1, flagAt - 1 + 1.5)) * 70 + (ratio >= flagAt ? 30 : 0))),
  );

  let summary: string;
  if (state === 'overextended') {
    summary = `OVEREXTENDED ${direction.toUpperCase()} — last ${Math.round(windowMs / 1000)}s moved ${recentAbs.toFixed(2)}$ vs baseline ${baseline.toFixed(2)}$ (×${ratio.toFixed(1)}).`;
  } else if (state === 'stretched') {
    summary = `Stretched ${direction.toUpperCase()} — recent move ×${ratio.toFixed(1)} baseline; mean-reversion risk rising.`;
  } else {
    summary = `Move size normal — last ${Math.round(windowMs / 1000)}s ×${ratio.toFixed(1)} baseline.`;
  }

  return {
    state,
    recentMoveUsd: recentNet,
    baselineMedianUsd: baseline,
    ratio,
    severity,
    direction,
    summary,
  };
}
