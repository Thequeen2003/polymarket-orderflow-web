import type { BookSnapshot } from './orderflowMetrics';

/** Same shape as `SpotPoint` — kept here to avoid circular imports with `SpotLevelChart`. */
export type SpotTick = { t: number; v: number };

export type SpotCandle = {
  t0: number;
  t1: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** |close-open| / (high-low), 0–1; high = solid body vs wicks */
  bodyFrac: number;
  /** high-low in $ */
  rangeUsd: number;
};

/** Time-bucket OHLC from irregular spot ticks (Chainlink / RTDS). */
export function buildSpotCandles(pts: SpotTick[], bucketCount: number): SpotCandle[] {
  if (pts.length < 2 || bucketCount < 2) return [];
  const t0 = pts[0]!.t;
  const t1 = pts[pts.length - 1]!.t;
  const span = Math.max(1, t1 - t0);
  const out: SpotCandle[] = [];
  for (let b = 0; b < bucketCount; b++) {
    const a = t0 + (span * b) / bucketCount;
    const z = t0 + (span * (b + 1)) / bucketCount;
    const lastBucket = b === bucketCount - 1;
    const slice = pts.filter((p) => p.t >= a && (lastBucket ? p.t <= z : p.t < z));
    if (slice.length === 0) continue;
    const o = slice[0]!.v;
    const c = slice[slice.length - 1]!.v;
    let h = -Infinity;
    let l = Infinity;
    for (const p of slice) {
      if (p.v > h) h = p.v;
      if (p.v < l) l = p.v;
    }
    const rangeUsd = h - l;
    const body = Math.abs(c - o);
    const bodyFrac = rangeUsd > 1e-12 ? Math.min(1, body / rangeUsd) : 1;
    out.push({ t0: a, t1: z, o, h, l, c, bodyFrac, rangeUsd });
  }
  return out;
}

/** Same as `buildSpotCandles` but uses a fixed `[t0, t1]` window so two series share identical buckets. */
export function buildSpotCandlesInRange(pts: SpotTick[], t0: number, t1: number, bucketCount: number): SpotCandle[] {
  if (pts.length < 2 || bucketCount < 2 || !(t1 > t0)) return [];
  const span = t1 - t0;
  const out: SpotCandle[] = [];
  for (let b = 0; b < bucketCount; b++) {
    const a = t0 + (span * b) / bucketCount;
    const z = t0 + (span * (b + 1)) / bucketCount;
    const lastBucket = b === bucketCount - 1;
    const slice = pts.filter((p) => p.t >= a && (lastBucket ? p.t <= z : p.t < z));
    if (slice.length === 0) continue;
    const o = slice[0]!.v;
    const c = slice[slice.length - 1]!.v;
    let h = -Infinity;
    let l = Infinity;
    for (const p of slice) {
      if (p.v > h) h = p.v;
      if (p.v < l) l = p.v;
    }
    const rangeUsd = h - l;
    const body = Math.abs(c - o);
    const bodyFrac = rangeUsd > 1e-12 ? Math.min(1, body / rangeUsd) : 1;
    out.push({ t0: a, t1: z, o, h, l, c, bodyFrac, rangeUsd });
  }
  return out;
}

/**
 * Places `level` at a fixed vertical fraction of the plot so extensions above/below read symmetrically
 * around the price-to-beat anchor (not squeezed to chart edges).
 */
export function anchorPriceScale(params: {
  level: number;
  spotMin: number;
  spotMax: number;
  /** 0 = top of plot, 1 = bottom — line is drawn here */
  anchorFrac: number;
}): { plotMin: number; plotMax: number } {
  const { level, spotMin, spotMax, anchorFrac } = params;
  const a = Math.min(0.92, Math.max(0.08, anchorFrac));
  const needBelow = Math.max(0, level - spotMin);
  const needAbove = Math.max(0, spotMax - level);
  const minR = Math.max(level * 1e-7, 1e-9);
  const r = Math.max(needBelow / (1 - a), needAbove / a, minR);
  return { plotMin: level - (1 - a) * r, plotMax: level + a * r };
}

export type FlowWindowStats = {
  midFirst: number | null;
  midLast: number | null;
  avgImbalance: number | null;
  avgChurn: number | null;
  avgSpread: number | null;
};

export function flowStatsBetween(flow: BookSnapshot[], t0: number, t1: number): FlowWindowStats {
  const slice = flow.filter((p) => p.t >= t0 && p.t <= t1 && p.mid != null);
  if (slice.length === 0) {
    return { midFirst: null, midLast: null, avgImbalance: null, avgChurn: null, avgSpread: null };
  }
  const mids = slice.map((p) => p.mid!);
  let imbSum = 0;
  let imbN = 0;
  let chSum = 0;
  let chN = 0;
  let spSum = 0;
  let spN = 0;
  for (const p of slice) {
    if (p.imbalance != null) {
      imbSum += p.imbalance;
      imbN++;
    }
    if (p.churn != null) {
      chSum += p.churn;
      chN++;
    }
    if (p.spread != null) {
      spSum += p.spread;
      spN++;
    }
  }
  return {
    midFirst: mids[0] ?? null,
    midLast: mids[mids.length - 1] ?? null,
    avgImbalance: imbN ? imbSum / imbN : null,
    avgChurn: chN ? chSum / chN : null,
    avgSpread: spN ? spSum / spN : null,
  };
}

/** Heuristic: outcome mid + churn vs slow mid move → “lift” vs “drift” for the Polymarket leg. */
export function classifyFlowLiftVsDrift(s: FlowWindowStats): 'lift' | 'drift' | 'fade' | 'neutral' {
  const { midFirst, midLast, avgChurn, avgSpread } = s;
  if (midFirst == null || midLast == null) return 'neutral';
  const dMid = midLast - midFirst;
  if (Math.abs(dMid) < 0.0008) return 'neutral';
  const churn = avgChurn ?? 0;
  const spread = avgSpread ?? 0;
  const up = dMid > 0;
  if (up) {
    if (churn > 0 && spread < 0.012) return 'lift';
    return 'drift';
  }
  if (churn > 0) return 'fade';
  return 'drift';
}

/** Dynamic “at the line” band from tick noise (not directional). */
export function ptbTouchEpsilonUsd(pts: SpotTick[], level: number): number {
  if (pts.length < 2 || !Number.isFinite(level) || level <= 0) return Math.max(0.5, level * 1e-4);
  const deltas: number[] = [];
  for (let i = 1; i < pts.length; i++) deltas.push(Math.abs(pts[i]!.v - pts[i - 1]!.v));
  deltas.sort((a, b) => a - b);
  const p75 = deltas[Math.floor(deltas.length * 0.75)] ?? 0;
  return Math.max(level * 8e-5, p75 * 2.8, 0.35);
}

export function candleStraddlesPtb(c: SpotCandle, level: number, eps: number): boolean {
  const lo = level - eps;
  const hi = level + eps;
  return c.l <= hi && c.h >= lo;
}

/** Mean body strength for buckets whose range intersects the PTB band (interaction quality). */
export function atPtbCandleStats(candles: SpotCandle[], level: number, eps: number): {
  n: number;
  avgBodyFrac: number | null;
  wickyShare: number | null;
} {
  const hit = candles.filter((c) => candleStraddlesPtb(c, level, eps));
  if (hit.length === 0) return { n: 0, avgBodyFrac: null, wickyShare: null };
  const avgBodyFrac = hit.reduce((s, c) => s + c.bodyFrac, 0) / hit.length;
  const wickyShare = hit.filter((c) => c.bodyFrac < 0.24).length / hit.length;
  return { n: hit.length, avgBodyFrac, wickyShare };
}

/** Tick-density shells around PTB — low occupancy = “air” / fast-move risk on that side. */
export function thinShellsAroundPtb(
  pts: SpotTick[],
  level: number,
  shellWidthUsd: number,
  shellCount = 5,
): {
  thinnestAboveIdx: number | null;
  thinnestBelowIdx: number | null;
  countsAbove: number[];
  countsBelow: number[];
} {
  const w = Math.max(shellWidthUsd, level * 5e-6, 0.15);
  const countsAbove: number[] = Array.from({ length: shellCount }, () => 0);
  const countsBelow: number[] = Array.from({ length: shellCount }, () => 0);
  for (const p of pts) {
    const d = p.v - level;
    if (d > 0) {
      const i = Math.min(shellCount - 1, Math.floor(d / w));
      if (i >= 0 && i < shellCount) countsAbove[i]!++;
    } else if (d < 0) {
      const i = Math.min(shellCount - 1, Math.floor(Math.abs(d) / w));
      if (i >= 0 && i < shellCount) countsBelow[i]!++;
    }
  }
  const minIdx = (arr: number[]) => {
    const s = arr.reduce((a, b) => a + b, 0);
    if (s === 0) return null;
    let m = Infinity;
    let ix: number | null = null;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i]! < m) {
        m = arr[i]!;
        ix = i;
      }
    }
    return ix;
  };
  return {
    thinnestAboveIdx: minIdx(countsAbove),
    thinnestBelowIdx: minIdx(countsBelow),
    countsAbove,
    countsBelow,
  };
}

export type PtbReactionKind =
  | 'approaching_touch'
  | 'touching'
  | 'holding_at_line'
  | 'choppy_at_line'
  | 'rejecting_off_line'
  | 'break_probe'
  | 'break_hold'
  | 'extension_confirming'
  | 'drifting_no_interaction';

export type PtbReactionStrengthTier = 'strong' | 'hesitant' | 'weak' | 'rejection';

/** Shape of the auction at PTB (direction-agnostic). */
export type PtbReactionShape = 'clean_push' | 'hesitation' | 'rejection' | 'unclear';

export type PtbExtensionFollowThrough = 'follow_through' | 'stall' | 'mixed' | 'not_applicable';

export type PtbReactionStrength = {
  tier: PtbReactionStrengthTier;
  shape: PtbReactionShape;
  /** PRIMARY narrative: bodies vs wicks, push vs hesitate vs reject */
  primary: string;
  avgBodyAtPtbPct: number | null;
  wickyBucketPct: number | null;
};

export type PtbReactionAnalysis = {
  kind: PtbReactionKind;
  /** Half-width of the PTB interaction band ($) */
  eps: number;
  /** First read: how spot is meeting PTB right now */
  headline: string;
  /** PRIMARY — quality of reaction at PTB */
  reactionStrength: PtbReactionStrength;
  /** PTB interaction (approach / touch / hold / reject / break) */
  interaction: string;
  /** Technical detail on overlapping buckets */
  candleAtPtb: string;
  /** true = active repricing at PTB; false = drift / low participation; null = no CLOB overlap */
  orderFlowAggressive: boolean | null;
  /** Order flow at PTB (CLOB mids + churn) */
  flowAtLine: string;
  /** follow-through vs giveback after PTB contact */
  extensionFollowThrough: PtbExtensionFollowThrough;
  /** Extension after interaction + stall / follow-through read */
  extensionAfterPtb: string;
  /** Legacy numeric extension line (kept for tools) */
  extension: string;
  /** Thin tick shells — gap / air risk symmetrically */
  gaps: string;
  /** Single trade-framing answer */
  tradeAnswer: string;
  /** Thinnest tick-density shell (for optional chart guides) */
  shellMarkAbove: { lo: number; hi: number } | null;
  shellMarkBelow: { lo: number; hi: number } | null;
};

function fuzzySide(v: number, level: number, eps: number): 1 | -1 | 0 {
  if (v > level + eps) return 1;
  if (v < level - eps) return -1;
  return 0;
}

function crossingCount(pts: SpotTick[], level: number, eps: number): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = fuzzySide(pts[i - 1]!.v, level, eps);
    const b = fuzzySide(pts[i]!.v, level, eps);
    if (a !== 0 && b !== 0 && a !== b) n++;
    if (a === 0 && b !== 0) {
      const j = i - 2;
      if (j >= 0) {
        const p = fuzzySide(pts[j]!.v, level, eps);
        if (p !== 0 && p !== b) n++;
      }
    }
  }
  return n;
}

function lastTouchEndIndex(pts: SpotTick[], level: number, eps: number): number {
  for (let i = pts.length - 1; i >= 0; i--) {
    if (Math.abs(pts[i]!.v - level) <= eps) return i;
  }
  return -1;
}

function maxAbsExtensionSince(pts: SpotTick[], level: number, fromIdx: number): number {
  let m = 0;
  for (let i = fromIdx; i < pts.length; i++) m = Math.max(m, Math.abs(pts[i]!.v - level));
  return m;
}

function inferExtensionFollowThrough(
  pts: SpotTick[],
  level: number,
  touchIdx: number,
  eps: number,
  lastAbs: number,
): PtbExtensionFollowThrough {
  if (touchIdx < 0 || pts.length < touchIdx + 3) return 'not_applicable';
  const slice = pts.slice(touchIdx);
  const M = Math.max(...slice.map((p) => Math.abs(p.v - level)));
  if (M < eps * 2) return 'mixed';
  const ratio = lastAbs / M;
  if (ratio >= 0.68) return 'follow_through';
  if (ratio < 0.36) return 'stall';
  return 'mixed';
}

function inferReactionStrength(params: {
  kind: PtbReactionKind;
  crosses: number;
  atStats: { n: number; avgBodyFrac: number | null; wickyShare: number | null };
  flowHint: ReturnType<typeof classifyFlowLiftVsDrift> | null;
}): PtbReactionStrength {
  const { kind, crosses, atStats, flowHint } = params;
  const bodyPct = atStats.avgBodyFrac != null ? Math.round(atStats.avgBodyFrac * 100) : null;
  const wickyPct = atStats.wickyShare != null ? Math.round(atStats.wickyShare * 100) : null;

  if (crosses >= 4 || kind === 'choppy_at_line') {
    return {
      tier: 'weak',
      shape: 'unclear',
      primary: `WEAK / unreadable: price keeps re-crossing PTB — no single clean reaction. Where buckets overlap PTB, avg body vs range is ${bodyPct != null ? `${bodyPct}%` : 'n/a'} (chop eats conviction).`,
      avgBodyAtPtbPct: bodyPct,
      wickyBucketPct: wickyPct,
    };
  }

  if (kind === 'rejecting_off_line' || (atStats.n >= 2 && atStats.avgBodyFrac != null && atStats.avgBodyFrac < 0.2)) {
    return {
      tier: 'rejection',
      shape: 'rejection',
      primary: `REJECTION: wicks dominate vs small real bodies at PTB (${bodyPct != null ? `${bodyPct}%` : '—'} avg body${wickyPct != null ? `; ${wickyPct}% of PTB-touch buckets are wicky` : ''}) — the line is pushing price away, not accepting a trend.`,
      avgBodyAtPtbPct: bodyPct,
      wickyBucketPct: wickyPct,
    };
  }

  const strongBody = atStats.avgBodyFrac != null && atStats.avgBodyFrac >= 0.36 && (atStats.wickyShare ?? 1) < 0.45;

  if (kind === 'break_hold' || kind === 'extension_confirming') {
    if (strongBody || flowHint === 'lift') {
      return {
        tier: 'strong',
        shape: 'clean_push',
        primary: `STRONG / clean push: real bodies through the PTB window (${bodyPct ?? '—'}% avg body)${flowHint === 'lift' ? ' and CLOB mids moving with churn — active repricing, not sleepy drift' : flowHint === 'drift' ? '; books are quiet — lean on spot extension as the conviction signal' : ''}.`,
        avgBodyAtPtbPct: bodyPct,
        wickyBucketPct: wickyPct,
      };
    }
    return {
      tier: 'hesitant',
      shape: 'hesitation',
      primary: `MIXED: extension exists but bodies at PTB are only moderate (${bodyPct ?? '—'}% avg body) — confirm with hold vs immediate reclaim.`,
      avgBodyAtPtbPct: bodyPct,
      wickyBucketPct: wickyPct,
    };
  }

  if (kind === 'touching' || kind === 'holding_at_line' || kind === 'approaching_touch') {
    const thin = atStats.avgBodyFrac != null && atStats.avgBodyFrac < 0.26;
    return {
      tier: thin && atStats.n >= 1 ? 'weak' : 'hesitant',
      shape: 'hesitation',
      primary: `HESITATION: ${kind === 'holding_at_line' ? 'spot is parked on PTB' : kind === 'approaching_touch' ? 'spot is closing on PTB' : 'spot is brushing PTB'} with ${thin ? 'weak bodies vs long wicks' : 'mixed bodies vs wicks'} (${bodyPct ?? '—'}% avg body on PTB-overlap buckets) — waiting for a clean push or a clean reject.`,
      avgBodyAtPtbPct: bodyPct,
      wickyBucketPct: wickyPct,
    };
  }

  if (kind === 'break_probe') {
    return {
      tier: strongBody ? 'hesitant' : 'weak',
      shape: strongBody ? 'clean_push' : 'hesitation',
      primary: `EARLY break: first separation from PTB; ${strongBody ? 'bodies at the line are decent' : 'wicks still dominate'} (${bodyPct ?? '—'}% avg body) — needs extension without instant reclaim to upgrade to a valid move.`,
      avgBodyAtPtbPct: bodyPct,
      wickyBucketPct: wickyPct,
    };
  }

  return {
    tier: 'weak',
    shape: 'unclear',
    primary: `NO DECISIVE TEST vs PTB in this window (${bodyPct != null ? `${bodyPct}%` : '—'} avg body where overlap exists) — reaction quality is undefined until price commits to the line.`,
    avgBodyAtPtbPct: bodyPct,
    wickyBucketPct: wickyPct,
  };
}

/**
 * Direction-agnostic read: how spot behaves **relative to PTB**, then context (candles, flow, extension, gaps).
 * Answers: is the reaction at the line strong enough to trust for a trade?
 */
export function analyzePtbReaction(params: {
  pts: SpotTick[];
  candles: SpotCandle[];
  level: number;
  bookFlow: BookSnapshot[] | undefined;
}): PtbReactionAnalysis {
  const { pts, candles, level, bookFlow } = params;
  const eps = ptbTouchEpsilonUsd(pts, level);
  const last = pts[pts.length - 1]?.v ?? level;
  const dist = last - level;
  const absDist = Math.abs(dist);
  const crosses = crossingCount(pts, level, eps);
  const touchIdx = lastTouchEndIndex(pts, level, eps);
  const atStats = atPtbCandleStats(candles, level, eps);
  const shellW = Math.max(eps * 1.6, level * 6e-5);
  const shells = thinShellsAroundPtb(pts, level, shellW, 5);

  const atLineCandleIndices = candles
    .map((c, i) => (candleStraddlesPtb(c, level, eps) ? i : -1))
    .filter((i) => i >= 0);
  let flowAtLineStats: FlowWindowStats | null = null;
  if (bookFlow?.length && atLineCandleIndices.length) {
    const touched = atLineCandleIndices.map((i) => candles[i]!);
    const t0 = Math.min(...touched.map((c) => c.t0));
    const t1 = Math.max(...touched.map((c) => c.t1));
    flowAtLineStats = flowStatsBetween(bookFlow, t0, t1);
  }
  const flowHint = flowAtLineStats ? classifyFlowLiftVsDrift(flowAtLineStats) : null;

  const tail = pts.slice(Math.max(0, pts.length - 12));
  const tailSpread = tail.length >= 2 ? Math.max(...tail.map((p) => p.v)) - Math.min(...tail.map((p) => p.v)) : 0;

  let kind: PtbReactionKind = 'drifting_no_interaction';
  let headline = '';

  if (absDist <= eps) {
    if (tailSpread < eps * 1.1 && tail.length >= 6) {
      kind = 'holding_at_line';
      headline = 'Holding at PTB — spot is clamping on the line in a tight band.';
    } else {
      kind = 'touching';
      headline = 'Touching PTB — spot is interacting with the level right now.';
    }
  } else if (touchIdx >= 0 && touchIdx >= pts.length - 4) {
    const after = maxAbsExtensionSince(pts, level, touchIdx);
    const lastC = candles[candles.length - 1];
    const wickyExit = lastC != null && lastC.bodyFrac < 0.26 && candleStraddlesPtb(lastC, level, eps * 1.2);
    if (wickyExit && after < eps * 4) {
      kind = 'rejecting_off_line';
      headline = 'Rejection off PTB — wicky interaction, not yet committing away with size.';
    } else if (after > eps * 3.5 && crosses <= 2) {
      kind = absDist > eps * 2 && lastC != null && !candleStraddlesPtb(lastC, level, eps) ? 'break_hold' : 'extension_confirming';
      headline =
        kind === 'break_hold'
          ? 'Break + hold — spot cleared the band and is holding away from PTB.'
          : 'Extension after a PTB test — follow-through distance is opening up.';
    } else {
      kind = 'break_probe';
      headline = 'Probe away from PTB — early separation; watch for hold vs snap-back.';
    }
  } else if (touchIdx < 0) {
    const minD = Math.min(...pts.map((p) => Math.abs(p.v - level)));
    const third = Math.max(3, Math.floor(pts.length / 3));
    const early = pts.slice(0, third);
    const late = pts.slice(-third);
    const dEarly = Math.min(...early.map((p) => Math.abs(p.v - level)));
    const dLate = Math.min(...late.map((p) => Math.abs(p.v - level)));
    const closingIn = dLate < dEarly - eps * 0.35 && minD > eps * 1.2;
    if (minD > eps * 2 && closingIn) {
      kind = 'approaching_touch';
      headline = 'Approaching PTB — recent prints are closer to the line than earlier in this window.';
    } else {
      kind = 'drifting_no_interaction';
      headline = 'Drifting without a clean PTB touch in this window — no center-of-story yet.';
    }
  } else {
    const ext = maxAbsExtensionSince(pts, level, touchIdx);
    if (ext > eps * 4 && crosses <= 2) kind = 'extension_confirming';
    else kind = 'drifting_no_interaction';
    headline =
      kind === 'extension_confirming'
        ? 'Extension after PTB contact earlier in the window — check whether it held.'
        : 'Mixed / late-window action vs PTB — read candles + flow for nuance.';
  }

  if (crosses >= 4) {
    kind = 'choppy_at_line';
    headline = 'Choppy at PTB — multiple crosses through the band; treat as no clean reaction.';
  }

  const extUp = pts.length ? Math.max(0, Math.max(...pts.map((p) => p.v)) - level) : 0;
  const extDn = pts.length ? Math.max(0, level - Math.min(...pts.map((p) => p.v))) : 0;
  const extSinceTouch = touchIdx >= 0 ? maxAbsExtensionSince(pts, level, touchIdx) : Math.max(extUp, extDn);

  const fmt = (x: number) => x.toFixed(2);
  const interaction =
    absDist <= eps
      ? `Distance to PTB now ≈ ${fmt(absDist)} (inside the ~±${fmt(eps)} interaction band).`
      : `Distance to PTB now ≈ ${fmt(absDist)} (${dist > 0 ? 'above' : 'below'} the line). ${crosses} sign flip(s) through the band in this view.`;

  const candleAtPtb =
    atStats.n === 0
      ? 'Bucket detail: no synthetic OHLC bucket overlaps the PTB band in this view — watch the path and the last print vs ±band.'
      : `Bucket detail: ${atStats.n} bucket(s) overlap PTB; avg body vs range ${atStats.avgBodyFrac != null ? `${(atStats.avgBodyFrac * 100).toFixed(0)}%` : '—'} (${atStats.wickyShare != null && atStats.wickyShare > 0.45 ? 'many wicky buckets' : 'cleaner bodies'}).`;

  let orderFlowAggressive: boolean | null = null;
  if (flowAtLineStats && flowHint != null && flowHint !== 'neutral') {
    if (flowHint === 'lift' || flowHint === 'fade') orderFlowAggressive = true;
    else if (flowHint === 'drift') orderFlowAggressive = false;
  }

  const flowAtLine =
    !bookFlow?.length || !flowAtLineStats
      ? 'Order flow at PTB (CLOB): no book samples overlapped PTB-touch buckets (~5s poll) — cannot score aggressive repricing vs passive drift here.'
      : orderFlowAggressive === true
        ? `Order flow at PTB: active — mids moved with elevated churn while the line was in play (proxy for aggressive repricing on the Polymarket outcome book, not literal on-chain market orders vs Chainlink).`
        : orderFlowAggressive === false
          ? `Order flow at PTB: passive / drift — mids barely moved with low churn — low participation at the line.`
          : `Order flow at PTB: flat — little directional conviction in mids through the PTB window.`;

  const extension = `Max |spot−PTB| after the latest in-band print ≈ $${fmt(extSinceTouch)} (session wings: +${fmt(extUp)} / −${fmt(extDn)} from PTB).`;

  const extensionFollowThrough = inferExtensionFollowThrough(pts, level, touchIdx, eps, absDist);
  const extFtLine =
    extensionFollowThrough === 'follow_through'
      ? 'Follow-through: spot is still near the post-touch extension peak — not an immediate stall back into the band.'
      : extensionFollowThrough === 'stall'
        ? 'Stall / giveback: peak |spot−PTB| after the touch exceeds where spot sits now — extension faded quickly vs the best print.'
        : extensionFollowThrough === 'mixed'
          ? 'Follow-through: mixed — some extension after PTB but spot is mid-range vs its post-touch best.'
          : 'Follow-through: not scored (no clean in-band touch or too few prints after contact).';

  const extensionAfterPtb = `${extension} ${extFtLine}`;

  const reactionStrength = inferReactionStrength({ kind, crosses, atStats, flowHint });

  const describeShell = (side: 'above' | 'below', idx: number | null, counts: number[]) => {
    if (idx == null) return `${side} PTB: no thin shell (not enough ticks or density is even).`;
    const lo = side === 'above' ? level + idx * shellW : level - (idx + 1) * shellW;
    const hi = side === 'above' ? level + (idx + 1) * shellW : level - idx * shellW;
    const c = counts[idx] ?? 0;
    return `${side} PTB: fewest RTDS prints in ~$${fmt(hi - lo)} shell [${fmt(lo)} – ${fmt(hi)}] (${c} ticks) → more “air” / fast-move risk if price re-enters that strip.`;
  };
  const gaps = `${describeShell('above', shells.thinnestAboveIdx, shells.countsAbove)} ${describeShell('below', shells.thinnestBelowIdx, shells.countsBelow)}`;

  let shellMarkAbove: { lo: number; hi: number } | null = null;
  let shellMarkBelow: { lo: number; hi: number } | null = null;
  if (shells.thinnestAboveIdx != null) {
    const i = shells.thinnestAboveIdx;
    shellMarkAbove = { lo: level + i * shellW, hi: level + (i + 1) * shellW };
  }
  if (shells.thinnestBelowIdx != null) {
    const i = shells.thinnestBelowIdx;
    shellMarkBelow = { lo: level - (i + 1) * shellW, hi: level - i * shellW };
  }

  let tradeAnswer = '';
  if (crosses >= 4) {
    tradeAnswer =
      '👉 Not strong enough to trust: chop through PTB — wait for one clean test (touch → resolve with body + extension, or a clear rejection) before trading the line.';
  } else if (kind === 'rejecting_off_line' || (atStats.avgBodyFrac != null && atStats.avgBodyFrac < 0.22 && atStats.n >= 2)) {
    tradeAnswer =
      '👉 Rejection: reaction at PTB is weak / disputing — opposite-side continuation is more plausible than trusting a breakout on the first poke.';
  } else if (kind === 'break_hold' || (kind === 'extension_confirming' && extSinceTouch > eps * 4 && (flowHint === 'lift' || flowHint === 'fade'))) {
    tradeAnswer =
      '👉 Strong enough to trust as a working hypothesis: break + extension (with CLOB activity when present) — treat as continuation from the break side until PTB is reclaimed.';
  } else if (kind === 'touching' || kind === 'holding_at_line') {
    tradeAnswer =
      '👉 Not yet strong enough to trust: still negotiating PTB — need a clean push or reject with extension before a trade story is fair.';
  } else if (kind === 'break_probe') {
    tradeAnswer =
      '👉 Early — trust only if extension builds and PTB stops reclaiming; otherwise the reaction is still too thin to treat as validated.';
  } else if (kind === 'approaching_touch') {
    tradeAnswer =
      '👉 Pending — no trust yet: PTB is approaching; wait for the first full interaction (touch → hold vs reject) before sizing.';
  } else {
    tradeAnswer =
      '👉 Unclear — do not trust yet: no decisive PTB reaction in this window; do not force a trade read off the line.';
  }

  return {
    kind,
    eps,
    headline,
    reactionStrength,
    interaction,
    candleAtPtb,
    orderFlowAggressive,
    flowAtLine,
    extensionFollowThrough,
    extensionAfterPtb,
    extension,
    gaps,
    tradeAnswer,
    shellMarkAbove,
    shellMarkBelow,
  };
}
