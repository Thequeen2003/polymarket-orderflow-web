/**
 * Bracket trigger math — SL/TP on a long outcome position.
 * Triggers and FAK limits use the CLOB bid only (executable sell price), never ask or chart mid.
 */

import { roundPrice01, roundPriceCentTick } from './tradingRound';

export type BracketCrossResult = {
  crossed: boolean;
  /** Best bid used for the cross decision. */
  ref01: number | null;
};

function clamp01(x: number): number {
  return Math.max(0.01, Math.min(0.99, x));
}

/** SL: best bid at or through stop (not edge-only — avoids missing fast gaps between polls). */
function stopBreached(stop01: number, ref01: number | null): boolean {
  if (ref01 == null || !(ref01 > 0) || ref01 >= 1) return false;
  return ref01 <= stop01 + 1e-9;
}

/** TP: price at or through take. */
function takeBreached(take01: number, ref01: number | null): boolean {
  if (ref01 == null || !(ref01 > 0) || ref01 >= 1) return false;
  return ref01 >= take01 - 1e-9;
}

/**
 * Highest live quote for TP breach — bid, ask, and chart mid can diverge on thin books.
 * If the chart/ask shows 93¢ but the polled bid lags at 88¢, we still trigger.
 */
export function bracketTpMark01(input: {
  bid01: number | null;
  ask01?: number | null;
  stripMid01?: number | null;
  honorChartMid?: boolean;
}): number | null {
  const vals: number[] = [];
  const bid = bracketBidRef01(input.bid01);
  const ask = bracketBidRef01(input.ask01 ?? null);
  if (bid != null) vals.push(bid);
  if (ask != null) vals.push(ask);
  if (input.honorChartMid !== false) {
    const mid = bracketBidRef01(input.stripMid01 ?? null);
    if (mid != null) vals.push(mid);
  }
  if (vals.length === 0) return null;
  return Math.max(...vals);
}

export function bracketBidRef01(bid01: number | null): number | null {
  return bid01 != null && bid01 > 0 && bid01 < 1 ? roundPrice01(bid01) : null;
}

/** @deprecated Use bracketBidRef01 — strip no longer affects triggers. */
export function stopLossRef01(bid01: number | null, _stripMid01?: number | null): number | null {
  return bracketBidRef01(bid01);
}

/** @deprecated Use bracketBidRef01 — strip no longer affects triggers. */
export function takeProfitRef01(bid01: number | null, _stripMid01?: number | null): number | null {
  return bracketBidRef01(bid01);
}

/**
 * FAK sell limit after an SL cross: never above the armed stop (simple) or limit field,
 * and never above the bid at trigger (so the order can actually match).
 */
export function stopLossExecLimit01(input: {
  stop01: number;
  limit01: number;
  ref01: number | null;
  simple?: boolean;
}): number {
  const ceiling = input.simple ? input.stop01 : input.limit01;
  const raw =
    input.ref01 != null && input.ref01 > 0 && input.ref01 < 1
      ? Math.min(ceiling, input.ref01)
      : ceiling;
  return roundPriceCentTick(roundPrice01(clamp01(raw)));
}

/**
 * FAK sell limit after a TP cross: match at the bid that triggered (minus one tick slip),
 * never below the armed take / limit floor.
 */
export function takeProfitExecLimit01(input: {
  take01: number;
  limit01: number;
  ref01: number | null;
  simple?: boolean;
}): number {
  const floor01 = input.simple ? input.take01 : Math.min(input.take01, input.limit01);
  if (input.ref01 != null && input.ref01 > 0 && input.ref01 < 1 && input.ref01 >= floor01 - 1e-9) {
    return slipSellFakLimit01(input.ref01, floor01);
  }
  return roundPriceCentTick(roundPrice01(clamp01(floor01)));
}

/** GTC/FAK limit at the armed take — never lifts to the live bid on trigger. */
export function takeProfitRestingLimit01(input: {
  take01: number;
  limit01: number;
  simple?: boolean;
}): number {
  const px = input.simple ? input.take01 : Math.min(input.take01, input.limit01);
  return roundPriceCentTick(roundPrice01(clamp01(px)));
}

/** One tick under best bid so Bullpen FAK can match resting bids (same idea as API market-sell slip). */
export function slipSellFakLimit01(bestBid01: number, floor01: number): number {
  const tick = 0.01;
  const minP = 0.01;
  let px = roundPriceCentTick(roundPrice01(clamp01(bestBid01)));
  if (px - tick >= minP - 1e-12) px = roundPriceCentTick(px - tick);
  return roundPriceCentTick(roundPrice01(clamp01(Math.max(floor01, px))));
}

/** Best bid for bracket triggers: fast poll, then book touch; optional chart mid when book is empty. */
export function bracketAutomationBid01(input: {
  pollBid01: number | null;
  touchBid01: number | null;
  fallback01?: number | null;
  forPaper?: boolean;
  /** Live: use chart mid only when poll + touch bid are both missing (never overrides a real bid). */
  allowMidFallback?: boolean;
}): number | null {
  const fromBook = bracketBidRef01(input.pollBid01) ?? bracketBidRef01(input.touchBid01);
  if (fromBook != null) return fromBook;
  if (input.forPaper || input.allowMidFallback) return bracketBidRef01(input.fallback01 ?? null);
  return null;
}

/** Best ask for dual-book TP/SL — fast poll, then book touch. */
export function bracketAutomationAsk01(input: {
  pollAsk01: number | null;
  touchAsk01: number | null;
  fallback01?: number | null;
  forPaper?: boolean;
  allowMidFallback?: boolean;
}): number | null {
  const fromBook = bracketBidRef01(input.pollAsk01) ?? bracketBidRef01(input.touchAsk01);
  if (fromBook != null) return fromBook;
  if (input.forPaper || input.allowMidFallback) return bracketBidRef01(input.fallback01 ?? null);
  return null;
}

export function evaluateStopLossCross(input: {
  stop01: number;
  bid01: number | null;
  prevBid01: number | null;
  ask01?: number | null;
  stripMid01?: number | null;
  prevStripMid01?: number | null;
  /** Chart mid through stop also triggers (sell still uses bid when present). */
  honorChartMid?: boolean;
  /** Fast bid+ask poll: ask through stop also triggers. */
  watchAsk?: boolean;
}): BracketCrossResult {
  void input.prevBid01;
  void input.prevStripMid01;
  const bidRef = bracketBidRef01(input.bid01);
  let crossed = stopBreached(input.stop01, bidRef);
  let ref01 = bidRef;
  if (!crossed && input.watchAsk) {
    const askRef = bracketBidRef01(input.ask01 ?? null);
    if (stopBreached(input.stop01, askRef)) {
      crossed = true;
      ref01 = bidRef ?? askRef;
    }
  }
  if (!crossed && input.honorChartMid) {
    const midRef = bracketBidRef01(input.stripMid01 ?? null);
    if (stopBreached(input.stop01, midRef)) {
      crossed = true;
      ref01 = bidRef ?? midRef;
    }
  }
  if (crossed && ref01 == null && input.honorChartMid) {
    ref01 = bracketBidRef01(input.stripMid01 ?? null);
  }
  return { crossed, ref01 };
}

export const DEFAULT_TRAILING_PROFIT_CONFIG = {
  /** Start trailing after this many ¢ gain from entry. */
  activateGainCents: 2,
  /** Exit when mark drops this many ¢ from session peak. */
  trailByCents: 2,
  /** Minimum locked profit once trailing is active. */
  lockProfitCents: 0.5,
} as const;

export type TrailingProfitConfig = typeof DEFAULT_TRAILING_PROFIT_CONFIG;

export function evaluateTrailingProfitExit(input: {
  entry01: number;
  currentMark01: number | null;
  peakMark01: number | null;
  config?: Partial<TrailingProfitConfig>;
}): { shouldExit: boolean; peakMark01: number | null; reason: string | null } {
  const cfg = { ...DEFAULT_TRAILING_PROFIT_CONFIG, ...input.config };
  const entry = input.entry01;
  if (!(entry > 0) || entry >= 1) {
    return { shouldExit: false, peakMark01: input.peakMark01, reason: null };
  }
  const mark = input.currentMark01;
  if (mark == null || !(mark > 0) || mark >= 1) {
    return { shouldExit: false, peakMark01: input.peakMark01, reason: null };
  }
  const prevPeak = input.peakMark01 ?? entry;
  const peak = Math.max(prevPeak, mark);
  const gainCents = (mark - entry) * 100;
  const peakGainCents = (peak - entry) * 100;
  if (peakGainCents + 0.05 < cfg.activateGainCents) {
    return { shouldExit: false, peakMark01: peak, reason: null };
  }
  const trailFloorGain =
    peakGainCents >= cfg.activateGainCents + cfg.trailByCents
      ? peakGainCents - cfg.trailByCents
      : cfg.lockProfitCents;
  if (gainCents <= trailFloorGain + 0.05 && peakGainCents >= cfg.activateGainCents) {
    return {
      shouldExit: true,
      peakMark01: peak,
      reason: `Trail exit — peaked +${peakGainCents.toFixed(1)}¢, now +${gainCents.toFixed(1)}¢`,
    };
  }
  return { shouldExit: false, peakMark01: peak, reason: null };
}

export function evaluateTakeProfitCross(input: {
  take01: number;
  bid01: number | null;
  prevBid01: number | null;
  ask01?: number | null;
  stripMid01?: number | null;
  prevStripMid01?: number | null;
  /** Include chart mid in the high-water mark (default on). */
  honorChartMid?: boolean;
  /** @deprecated Ask is always included in the TP high-water mark. */
  watchAsk?: boolean;
}): BracketCrossResult {
  void input.prevBid01;
  void input.prevStripMid01;
  void input.watchAsk;
  const mark01 = bracketTpMark01({
    bid01: input.bid01,
    ask01: input.ask01,
    stripMid01: input.stripMid01,
    honorChartMid: input.honorChartMid,
  });
  const bidRef = bracketBidRef01(input.bid01);
  const crossed = takeBreached(input.take01, mark01);
  const ref01 = bidRef ?? mark01;
  return { crossed, ref01 };
}
