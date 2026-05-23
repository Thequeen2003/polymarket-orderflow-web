/**
 * Multi-timeframe consensus — score the directional drift across 1m, 5m, 15m,
 * 30m windows and report whether all timeframes agree.
 *
 * Pure functions, easy to unit-test. The UI renders the result as a small "LED
 * stack" so the user gets an instant conviction read: 4 greens = ride;
 * 3 greens / 1 red = trend with weakness; 2/2 = chop; 4 reds = ride down.
 */

export type MtfTick = { t: number; v: number };

export type MtfWindowKey = '1m' | '5m' | '15m' | '30m';

export type MtfVote = {
  key: MtfWindowKey;
  windowMs: number;
  vote: 'up' | 'down' | 'flat';
  /** OLS slope $/sec across the window. */
  slopeUsdPerSec: number;
  /** Sample size used. */
  ticks: number;
  /** Net $ change across the window. */
  netUsd: number;
  /** True when the window has too few ticks to be meaningful. */
  thin: boolean;
};

export type MtfConsensus = {
  votes: MtfVote[];
  /** Number of "actionable" (non-flat, non-thin) votes that agree on the dominant lane. */
  alignedCount: number;
  /** Total number of "actionable" votes across all windows. */
  totalActionable: number;
  /** Lane the majority of actionable votes point to. null if split or no actionable votes. */
  dominantLane: 'up' | 'down' | null;
  /** Score in -1..+1; magnitude is conviction, sign is direction. */
  score: number;
  /** Convenience: aligned >= 3 with no opposing votes. */
  fullAgreement: boolean;
  /** Convenience: any opposing votes among non-flat windows? */
  hasConflict: boolean;
  /** Short user-facing summary. */
  summary: string;
};

const WINDOWS: { key: MtfWindowKey; ms: number }[] = [
  { key: '1m', ms: 60_000 },
  { key: '5m', ms: 5 * 60_000 },
  { key: '15m', ms: 15 * 60_000 },
  { key: '30m', ms: 30 * 60_000 },
];

function olsSlopeUsdPerSec(slice: MtfTick[]): number {
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

function tail(pts: MtfTick[], windowMs: number): MtfTick[] {
  if (pts.length === 0) return [];
  const tEnd = pts[pts.length - 1]!.t;
  const start = tEnd - windowMs;
  const out: MtfTick[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i]!.t < start) break;
    out.push(pts[i]!);
  }
  out.reverse();
  return out;
}

/**
 * Build a vote per timeframe. `bandUsd` is used as the "flat" threshold so a
 * tiny slope on a quiet tape doesn't get counted as directional.
 *
 * @param minTicks minimum ticks per window to issue a non-flat vote (default 4).
 */
export function buildMtfConsensus(
  pts: MtfTick[],
  bandUsd: number,
  opts?: { minTicks?: number },
): MtfConsensus {
  const minTicks = Math.max(2, opts?.minTicks ?? 4);
  const flatThreshold = Math.max(bandUsd / 60, 0.01); // $/sec — slope below this is "flat"
  const votes: MtfVote[] = [];

  for (const w of WINDOWS) {
    const slice = tail(pts, w.ms);
    const ticks = slice.length;
    const thin = ticks < minTicks;
    const slope = thin ? 0 : olsSlopeUsdPerSec(slice);
    const netUsd = ticks >= 2 ? slice[ticks - 1]!.v - slice[0]!.v : 0;

    let vote: MtfVote['vote'];
    if (thin) vote = 'flat';
    else if (slope > flatThreshold) vote = 'up';
    else if (slope < -flatThreshold) vote = 'down';
    else vote = 'flat';

    votes.push({
      key: w.key,
      windowMs: w.ms,
      vote,
      slopeUsdPerSec: slope,
      ticks,
      netUsd,
      thin,
    });
  }

  const upVotes = votes.filter((v) => v.vote === 'up' && !v.thin).length;
  const downVotes = votes.filter((v) => v.vote === 'down' && !v.thin).length;
  const totalActionable = upVotes + downVotes;
  const dominantLane: 'up' | 'down' | null =
    upVotes > downVotes ? 'up' : downVotes > upVotes ? 'down' : null;

  const alignedCount = dominantLane === 'up' ? upVotes : dominantLane === 'down' ? downVotes : 0;
  const score = (upVotes - downVotes) / Math.max(1, votes.length); // -1..+1
  const hasConflict = upVotes > 0 && downVotes > 0;
  const fullAgreement = !hasConflict && alignedCount >= 3;

  let summary: string;
  if (fullAgreement && dominantLane) {
    summary = `All timeframes ${dominantLane.toUpperCase()} (${alignedCount}/${votes.length}) — full conviction.`;
  } else if (dominantLane && !hasConflict) {
    summary = `${alignedCount}/${votes.length} timeframes ${dominantLane.toUpperCase()} — aligned but partial.`;
  } else if (hasConflict) {
    summary = `Mixed: ${upVotes} UP / ${downVotes} DOWN across timeframes — conflicting tape.`;
  } else {
    summary = `No directional consensus — tape too quiet across timeframes.`;
  }

  return {
    votes,
    alignedCount,
    totalActionable,
    dominantLane,
    score,
    fullAgreement,
    hasConflict,
    summary,
  };
}
