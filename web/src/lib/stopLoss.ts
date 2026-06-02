export type StopCrossDirection = 'down' | 'up';

/**
 * Returns true if price crosses the stop boundary between samples.
 *
 * - `down`: triggers when prev > stop and curr <= stop (typical long stop-loss: sell when price falls)
 * - `up`:   triggers when prev < stop and curr >= stop (typical short stop-loss: buy when price rises)
 */
export function didCrossStop(params: {
  prev: number | null;
  curr: number | null;
  stop: number;
  dir: StopCrossDirection;
}): boolean {
  const { prev, curr, stop, dir } = params;
  if (prev == null || curr == null) return false;
  if (!Number.isFinite(prev) || !Number.isFinite(curr) || !Number.isFinite(stop)) return false;
  if (!(stop > 0 && stop < 1)) return false;
  if (!(prev > 0 && prev < 1 && curr > 0 && curr < 1)) return false;

  if (dir === 'down') return prev > stop && curr <= stop;
  return prev < stop && curr >= stop;
}

