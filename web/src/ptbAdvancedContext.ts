import type { SpotCandle } from './spotVsPtb';

export type GapLite = {
  lo: number;
  hi: number;
  strength10: number;
  active: boolean;
  exitWall: number | null;
} | null;

/**
 * Short-horizon probability path: jumps, opposing-leg threat, and chase risk.
 * Used to downgrade naive ENTER signals when the book is whipsawing or the other side is taking over.
 */
export type ProbMicrostructure = {
  jumpRisk01: number;
  maxBucketJumpCents: number;
  takeoverRisk: 'low' | 'med' | 'high';
  spreadNarrowing: boolean;
  bothLegsChaotic: boolean;
  whipsawLeader: boolean;
  leaderLane: 'up' | 'down' | 'tie';
  /** Cents per bucket (~last 4 buckets), positive = toward 100% for that outcome */
  slopeCentsUp: number;
  slopeCentsDown: number;
  summaryLines: string[];
};

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Largest single bucket-to-bucket close move in the tail (¢). */
function largestBucketJumpCents(candles: SpotCandle[], tail = 6): number {
  if (candles.length < 2) return 0;
  const slice = candles.slice(-tail);
  let max = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = Math.abs(slice[i]!.c - slice[i - 1]!.c) * 100;
    if (d > max) max = d;
  }
  return max;
}

/** Count direction flips in bucket deltas (whipsaw proxy). */
function countSignFlipsDeltas(closes: number[]): number {
  if (closes.length < 3) return 0;
  const d: number[] = [];
  for (let i = 1; i < closes.length; i++) d.push(closes[i]! - closes[i - 1]!);
  let flips = 0;
  for (let i = 1; i < d.length; i++) {
    if (d[i - 1]! * d[i]! < 0) flips += 1;
  }
  return flips;
}

function slopeCentsPerBucket(candles: SpotCandle[], n = 4): number {
  const tail = candles.slice(-n);
  if (tail.length < 2) return 0;
  const a = tail[0]!.c;
  const b = tail[tail.length - 1]!.c;
  return ((b - a) * 100) / Math.max(1, tail.length - 1);
}

export function computeProbMicrostructure(params: {
  candlesUp: SpotCandle[];
  candlesDn: SpotCandle[];
  lastU: number;
  lastD: number;
  upRising: boolean;
  dnRising: boolean;
  gapU: GapLite;
  gapD: GapLite;
}): ProbMicrostructure {
  const { candlesUp: cu, candlesDn: cd, lastU, lastD, upRising, dnRising, gapU, gapD } = params;

  const ju = largestBucketJumpCents(cu);
  const jd = largestBucketJumpCents(cd);
  const maxBucketJumpCents = Math.max(ju, jd);
  /** ~8¢+ in one bucket is already huge in prob space */
  const jumpRisk01 = clamp01(maxBucketJumpCents / 14);

  const closesU = cu.slice(-6).map((c) => c.c);
  const closesD = cd.slice(-6).map((c) => c.c);
  const leaderLane: 'up' | 'down' | 'tie' =
    Math.abs(lastU - lastD) < 0.012 ? 'tie' : lastU >= lastD ? 'up' : 'down';

  const leaderCloses = leaderLane === 'up' ? closesU : leaderLane === 'down' ? closesD : closesU;
  const whipsawLeader = leaderCloses.length >= 4 && countSignFlipsDeltas(leaderCloses) >= 2;

  const slopeU = slopeCentsPerBucket(cu);
  const slopeD = slopeCentsPerBucket(cd);

  let takeoverRisk: 'low' | 'med' | 'high' = 'low';
  const oppStronger =
    leaderLane === 'up'
      ? slopeD > slopeU + 0.45
      : leaderLane === 'down'
        ? slopeU > slopeD + 0.45
        : Math.abs(slopeU - slopeD) > 0.55;

  const oppRising = leaderLane === 'up' ? dnRising : leaderLane === 'down' ? upRising : false;
  const leaderRising = leaderLane === 'up' ? upRising : leaderLane === 'down' ? dnRising : upRising || dnRising;

  const oppGap = leaderLane === 'up' ? gapD : leaderLane === 'down' ? gapU : null;
  const myGap = leaderLane === 'up' ? gapU : leaderLane === 'down' ? gapD : null;

  if (leaderLane !== 'tie') {
    if (oppStronger && oppRising && !leaderRising) takeoverRisk = 'high';
    else if (oppStronger && (oppGap?.active || oppRising)) takeoverRisk = 'med';
    else if (!leaderRising && oppRising && (myGap == null || !myGap.active) && (oppGap?.active ?? false)) {
      takeoverRisk = 'high';
    } else if (oppStronger) takeoverRisk = 'med';
  }

  const spreadNow = Math.abs(lastU - lastD);
  let spreadNarrowing = false;
  if (cu.length >= 3 && cd.length >= 3) {
    const uPrev = cu[cu.length - 3]!.c;
    const dPrev = cd[cd.length - 3]!.c;
    const spreadPrev = Math.abs(uPrev - dPrev);
    spreadNarrowing = spreadPrev - spreadNow > 0.018;
  }
  if (spreadNarrowing && takeoverRisk === 'low') takeoverRisk = 'med';

  const bothLegsChaotic = ju >= 4.5 && jd >= 4.5 && maxBucketJumpCents >= 6;

  const summaryLines: string[] = [];
  if (jumpRisk01 >= 0.55) {
    summaryLines.push(`Large bucket-to-bucket jump (≈${maxBucketJumpCents.toFixed(1)}¢) — easy to get run over if you chase.`);
  }
  if (takeoverRisk === 'high') {
    summaryLines.push(
      leaderLane === 'tie'
        ? 'Both legs fighting — wait for one lane to win slope + structure before sizing.'
        : `Opposing ${leaderLane === 'up' ? 'DOWN' : 'UP'} leg is gaining slope / structure — early entry window may already be closing.`,
    );
  } else if (takeoverRisk === 'med') {
    summaryLines.push('Other side is catching up on short-window slope — confirm with break + tape before adding.');
  }
  if (bothLegsChaotic) {
    summaryLines.push('Both legs just moved hard — often liquidity event / noise; shrink size or wait one bucket.');
  }
  if (whipsawLeader && jumpRisk01 >= 0.35) {
    summaryLines.push('Leader path is choppy (whipsaw) — prefer limits or wait for a clean continuation close.');
  }
  if (spreadNarrowing && leaderLane !== 'tie') {
    summaryLines.push('Up/Down spread is compressing — conviction is contested; tight invalidation if you enter.');
  }

  return {
    jumpRisk01,
    maxBucketJumpCents,
    takeoverRisk,
    spreadNarrowing,
    bothLegsChaotic,
    whipsawLeader,
    leaderLane,
    slopeCentsUp: slopeU,
    slopeCentsDown: slopeD,
    summaryLines,
  };
}
