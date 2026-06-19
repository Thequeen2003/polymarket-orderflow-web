import type { LaneEdges } from './tradeEdgeCalculator';
import type { SpotPoint } from './SpotLevelChart';
import { suggestLevelsForLane, type TradeLevels } from './tradeLevels';
import { computeLiveGuidance, estimateHiddenRanges, type TradeAction } from './tradePlanAssistant';
import {
  evaluateRegimeTpExit,
  type RegimeTpExitVerdict,
  type RegimeTpPlan,
} from './regimeTpEngine';

export type TpPosture = 'hold' | 'bank' | 'take_profit' | 'stop_pushing' | 'greedy';

export type PositionTpOutlook = {
  tpHitProb01: number;
  posture: TpPosture;
  postureLabel: string;
  headline: string;
  detail: string;
  reversalRisk01: number;
  /** 0 at entry, 1 at TP, >1 past TP. */
  progressToTp01: number;
  entryCents: number;
  currentCents: number;
  tpCents: number;
  /** Cents left to TP (negative = past TP). */
  distanceToTpCents: number;
  /** Regime-based live exit call when plan + entry time available. */
  regimeExit?: RegimeTpExitVerdict | null;
  regimePlan?: RegimeTpPlan | null;
  timeStopSec?: number;
  heldSec?: number;
};

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function meanSlope(history: number[]): number {
  if (history.length < 2) return 0;
  const tail = history.slice(-6);
  let sum = 0;
  for (let i = 1; i < tail.length; i++) sum += tail[i]! - tail[i - 1]!;
  return sum / (tail.length - 1);
}

function estimateTpHitProb(args: {
  entry01: number;
  tp01: number;
  current01: number;
  midHistory: number[];
  reversalRisk01: number;
  crossProb: number | null;
  endsInMs: number | null;
}): number {
  const { entry01, tp01, current01, midHistory, reversalRisk01, crossProb, endsInMs } = args;
  const bullish = tp01 >= entry01 - 1e-9;
  const span = Math.abs(tp01 - entry01);
  if (!(span > 0.002)) return 0.5;

  const progress = bullish ? (current01 - entry01) / span : (entry01 - current01) / span;
  let prob = 0.2 + clamp01(progress) * 0.58;
  if (progress >= 0.9) prob = 0.78 + (progress - 0.9) * 1.2;
  if (progress >= 1) prob = Math.min(0.97, 0.9 + (progress - 1) * 0.35);
  if (progress < 0) prob = Math.max(0.06, 0.22 + progress * 0.35);

  const slope = meanSlope(midHistory.length ? midHistory : [current01]);
  const towardTp = bullish ? slope > 0.0004 : slope < -0.0004;
  const awayFromTp = bullish ? slope < -0.0004 : slope > 0.0004;
  if (towardTp) prob += 0.1;
  if (awayFromTp) prob -= 0.14;

  prob -= reversalRisk01 * 0.34;

  if (crossProb != null && Number.isFinite(crossProb)) {
    if (crossProb < 0.36) prob -= 0.11;
    else if (crossProb > 0.62) prob += 0.07;
  }

  if (endsInMs != null && Number.isFinite(endsInMs)) {
    if (endsInMs < 120_000 && progress < 0.82) prob -= 0.18;
    else if (endsInMs < 480_000 && progress < 0.55) prob -= 0.08;
  }

  return clamp01(prob);
}

function postureFromGuidance(args: {
  progress: number;
  reversalRisk01: number;
  guidanceAction: TradeAction;
  momentumWeak: boolean;
  pastTp: boolean;
  inStretch: boolean;
}): TpPosture {
  const { progress, reversalRisk01, guidanceAction, momentumWeak, pastTp, inStretch } = args;

  if (pastTp && (reversalRisk01 > 0.42 || momentumWeak || progress > 1.06)) return 'greedy';
  if (guidanceAction === 'CUT_NOW') return 'stop_pushing';
  if (guidanceAction === 'TAKE_PROFIT' || (progress >= 0.9 && reversalRisk01 > 0.38)) return 'take_profit';
  if (progress >= 0.55 && reversalRisk01 > 0.36 && !pastTp) return 'bank';
  if (progress < 0.4 && reversalRisk01 > 0.52 && momentumWeak) return 'stop_pushing';
  if (inStretch && pastTp && reversalRisk01 > 0.32) return 'greedy';
  return 'hold';
}

const POSTURE_LABEL: Record<TpPosture, string> = {
  hold: 'Hold for TP',
  bank: 'Bank strength',
  take_profit: 'Take profit',
  stop_pushing: 'Stop pushing',
  greedy: 'Greedy stretch',
};

function headlineFor(posture: TpPosture, tpHitProb01: number, distanceCents: number): string {
  const pct = Math.round(tpHitProb01 * 100);
  switch (posture) {
    case 'greedy':
      return distanceCents <= 0
        ? `Past TP — ${pct}% to hold the full target; don’t insist on the last tick`
        : `Near TP but stretching — ${pct}% odds; greed risk rising`;
    case 'take_profit':
      return `TP in play — ${pct}% to tag it; favor banking over hoping`;
    case 'bank':
      return `Partial window — ${pct}% on full TP; peel on strength`;
    case 'stop_pushing':
      return `Low odds (${pct}%) — stop adding; defend exit`;
    default:
      return `TP reachable — ~${pct}% if tape holds`;
  }
}

function detailFor(posture: TpPosture, guidanceDetail: string, distanceCents: number): string {
  if (posture === 'greedy') {
    return distanceCents <= 0
      ? 'You are at or through the profit target with fading continuation — take profit on bids instead of waiting for a perfect print.'
      : 'Price is in the stretch band with weakening momentum — the last few cents are usually hope, not edge.';
  }
  if (posture === 'stop_pushing') {
    return 'Flow is leaning away and reversal risk is elevated — your TP is still possible but not worth pressing size into.';
  }
  if (posture === 'take_profit') {
    return guidanceDetail || 'Target zone reached or giveback started — pay yourself before the book reverses.';
  }
  if (posture === 'bank') {
    return 'Most of the move is done — trail or sell clips into strength; let a runner only with a hard worst-case exit.';
  }
  return guidanceDetail || 'Structure still supports the bracket — invalidation is your stop and time, not every dip.';
}

/**
 * When holding shares with a TP anchor, estimate hit odds and whether to hold, bank, exit, or stop pressing.
 */
export function computePositionTpOutlook(input: {
  entry01: number | null;
  tp01: number | null;
  current01: number | null;
  midHistory?: number[];
  crossProb?: number | null;
  endsInMs?: number | null;
  regimePlan?: RegimeTpPlan | null;
  entryMs?: number | null;
  nowMs?: number;
  modelPHeld?: number | null;
  spreadStalled?: boolean;
}): PositionTpOutlook | null {
  const entry01 = input.entry01;
  const tp01 = input.tp01;
  const current01 = input.current01;
  if (
    entry01 == null ||
    tp01 == null ||
    current01 == null ||
    !(entry01 > 0 && entry01 < 1) ||
    !(tp01 > 0 && tp01 < 1) ||
    !(current01 > 0 && current01 < 1)
  ) {
    return null;
  }

  const bullish = tp01 >= entry01 - 1e-9;
  const span = Math.abs(tp01 - entry01);
  if (!(span > 0.002)) return null;

  const midHistory = (input.midHistory ?? []).filter((v) => Number.isFinite(v) && v > 0 && v < 1);
  const hist = midHistory.length ? midHistory : [current01];
  const sessionPeak = Math.max(...hist, current01);
  const sessionTrough = Math.min(...hist, current01);

  const ranges = estimateHiddenRanges({ entry: entry01, desiredExit: tp01, gap: null });
  const guidance = computeLiveGuidance({
    bullish,
    entry: entry01,
    desiredExit: tp01,
    current: current01,
    ranges,
    sessionPeak,
    sessionTrough,
    midHistory: hist,
  });

  const progress = bullish ? (current01 - entry01) / span : (entry01 - current01) / span;
  const pastTp = progress >= 0.98;
  const distanceToTpCents = bullish ? (tp01 - current01) * 100 : (current01 - tp01) * 100;

  const slopes = hist.length >= 2 ? hist.slice(-4).map((v, i, a) => (i === 0 ? 0 : v - a[i - 1]!)) : [0];
  const momNow = slopes.length ? slopes.reduce((s, x) => s + Math.abs(x), 0) / slopes.length : 0.02;
  const momentumWeak = momNow < 0.0035;

  const inStretch =
    bullish && current01 >= ranges.stretchLo && current01 <= ranges.stretchHi
      ? true
      : !bullish && current01 <= ranges.stretchHi && current01 >= ranges.stretchLo;

  const posture = postureFromGuidance({
    progress,
    reversalRisk01: guidance.reversalRisk01,
    guidanceAction: guidance.action,
    momentumWeak,
    pastTp,
    inStretch,
  });

  const tpHitProb01 = estimateTpHitProb({
    entry01,
    tp01,
    current01,
    midHistory: hist,
    reversalRisk01: guidance.reversalRisk01,
    crossProb: input.crossProb ?? null,
    endsInMs: input.endsInMs ?? null,
  });

  const regimePlan = input.regimePlan ?? null;
  const entryMs = input.entryMs ?? null;
  const nowMs = input.nowMs ?? Date.now();
  let regimeExit: RegimeTpExitVerdict | null = null;
  let heldSec: number | undefined;

  if (regimePlan && entryMs != null) {
    heldSec = Math.max(0, Math.round((nowMs - entryMs) / 1000));
    const peakGainCents = bullish
      ? (Math.max(...hist, current01) - entry01) * 100
      : (entry01 - Math.min(...hist, current01)) * 100;
    regimeExit = evaluateRegimeTpExit({
      plan: regimePlan,
      entry01,
      current01,
      tp01,
      entryMs,
      nowMs,
      modelPHeld: input.modelPHeld ?? null,
      momentumFlip: momentumWeak && guidance.reversalRisk01 > 0.45,
      spreadStalled: input.spreadStalled ?? false,
      peakGainCents,
    });
  }

  const exitAction = regimeExit?.action;
  const postureOverride =
    exitAction === 'time_stop' || exitAction === 'exit_market' || exitAction === 'trail_exit'
      ? 'stop_pushing'
      : exitAction === 'take_tp1' || exitAction === 'take_tp2'
        ? 'take_profit'
        : posture;

  return {
    tpHitProb01,
    posture: postureOverride,
    postureLabel: POSTURE_LABEL[postureOverride],
    headline:
      regimeExit && regimeExit.action !== 'hold'
        ? regimeExit.reason
        : headlineFor(postureOverride, tpHitProb01, distanceToTpCents),
    detail: regimeExit?.reason ?? detailFor(postureOverride, guidance.detail, distanceToTpCents),
    reversalRisk01: guidance.reversalRisk01,
    progressToTp01: progress,
    entryCents: entry01 * 100,
    currentCents: current01 * 100,
    tpCents: tp01 * 100,
    distanceToTpCents,
    regimeExit,
    regimePlan,
    timeStopSec: regimePlan ? Math.round(regimePlan.timeStopMs / 1000) : undefined,
    heldSec,
  };
}

function midHistoryFromSeries(series: SpotPoint[] | undefined): number[] {
  if (!series?.length) return [];
  return series
    .slice(-24)
    .map((p) => p.v)
    .filter((v): v is number => Number.isFinite(v) && v > 0 && v < 1);
}

/**
 * TP outlook for a held outcome — uses your tag/avg entry, armed or model TP, and live mid path.
 */
export function computeHeldLaneTpOutlook(input: {
  heldLane: 'up' | 'down';
  heldAtMid01?: number | null;
  currentMid01: number | null;
  levels?: TradeLevels | null;
  laneEdges?: LaneEdges | null;
  probSeries?: SpotPoint[];
  crossProb?: number | null;
  endsInMs?: number | null;
  bestAsk?: number | null;
  bestBid?: number | null;
  /** User bracket or wallet avg — overrides model entry when set. */
  entry01?: number | null;
  /** User armed TP — overrides model TP when set. */
  tp01?: number | null;
  entryMs?: number | null;
  nowMs?: number;
  regimePlan?: RegimeTpPlan | null;
  modelPHeld?: number | null;
}): PositionTpOutlook | null {
  const current01 = input.currentMid01;
  if (current01 == null || !(current01 > 0 && current01 < 1)) return null;

  let tp01 = input.tp01 ?? null;
  let entry01 = input.entry01 ?? null;

  let levels = input.levels;
  if (levels?.lane !== input.heldLane || levels?.collapsed) levels = null;

  if (tp01 == null || !(tp01 > 0 && tp01 < 1)) {
    if (levels && !levels.collapsed) {
      tp01 = levels.takeProfit;
    } else {
      const suggested = suggestLevelsForLane({
        lane: input.heldLane,
        laneEdges: input.laneEdges ?? null,
        crossProb: input.crossProb ?? null,
        endsInMs: input.endsInMs ?? null,
        bestAsk: input.bestAsk ?? null,
        bestBid: input.bestBid ?? null,
      });
      if (!suggested || suggested.collapsed) return null;
      tp01 = suggested.takeProfit;
      if (entry01 == null) entry01 = suggested.entry;
    }
  }

  if (entry01 == null || !(entry01 > 0 && entry01 < 1)) {
    const tag = input.heldAtMid01;
    if (tag != null && tag > 0 && tag < 1) entry01 = tag;
    else if (levels && !levels.collapsed) entry01 = levels.entry;
    else return null;
  }

  if (tp01 == null || !(tp01 > 0 && tp01 < 1)) return null;

  return computePositionTpOutlook({
    entry01,
    tp01,
    current01,
    midHistory: midHistoryFromSeries(input.probSeries),
    crossProb: input.crossProb ?? null,
    endsInMs: input.endsInMs ?? null,
    regimePlan: input.regimePlan ?? levels?.regimePlan ?? null,
    entryMs: input.entryMs ?? null,
    nowMs: input.nowMs,
    modelPHeld: input.modelPHeld ?? null,
  });
}

function tp01FromCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cents = parseFloat(trimmed);
  if (!Number.isFinite(cents)) return null;
  const tp01 = cents / 100;
  if (!(tp01 > 0 && tp01 < 1)) return null;
  return tp01;
}

/**
 * Before fill — estimate odds the staged buy-bundle TP tags if you enter at the planned limit.
 */
export function computePreBuyTpOutlook(input: {
  entry01: number | null;
  tpCents: string;
  current01: number | null;
  probSeries?: SpotPoint[];
  crossProb?: number | null;
  endsInMs?: number | null;
}): PositionTpOutlook | null {
  const tp01 = tp01FromCents(input.tpCents);
  if (tp01 == null) return null;

  const outlook = computePositionTpOutlook({
    entry01: input.entry01,
    tp01,
    current01: input.current01,
    midHistory: midHistoryFromSeries(input.probSeries),
    crossProb: input.crossProb ?? null,
    endsInMs: input.endsInMs ?? null,
  });
  if (!outlook) return null;

  const pct = Math.round(outlook.tpHitProb01 * 100);
  const dist = outlook.distanceToTpCents;
  return {
    ...outlook,
    headline:
      dist > 0
        ? `Before fill — ~${pct}% chance TP at ${outlook.tpCents.toFixed(1)}¢ tags`
        : `Before fill — tape already at/through TP (${pct}% to hold full target)`,
    detail:
      dist > 0
        ? `${dist.toFixed(1)}¢ to TP from current tape; assumes fill near ${outlook.entryCents.toFixed(1)}¢. ${outlook.detail}`
        : outlook.detail,
  };
}
