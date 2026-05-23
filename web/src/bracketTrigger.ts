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

/** TP: best bid at or through take. */
function takeBreached(take01: number, ref01: number | null): boolean {
  if (ref01 == null || !(ref01 > 0) || ref01 >= 1) return false;
  return ref01 >= take01 - 1e-9;
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

export function evaluateStopLossCross(input: {
  stop01: number;
  bid01: number | null;
  prevBid01: number | null;
  stripMid01?: number | null;
  prevStripMid01?: number | null;
  /** Chart mid through stop also triggers (sell still uses bid when present). */
  honorChartMid?: boolean;
}): BracketCrossResult {
  void input.prevBid01;
  void input.prevStripMid01;
  const bidRef = bracketBidRef01(input.bid01);
  let crossed = stopBreached(input.stop01, bidRef);
  let ref01 = bidRef;
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

export function evaluateTakeProfitCross(input: {
  take01: number;
  bid01: number | null;
  prevBid01: number | null;
  stripMid01?: number | null;
  prevStripMid01?: number | null;
  /** Chart mid at/above take also triggers (matches what you see on the chart). */
  honorChartMid?: boolean;
}): BracketCrossResult {
  void input.prevBid01;
  void input.prevStripMid01;
  const bidRef = bracketBidRef01(input.bid01);
  let crossed = takeBreached(input.take01, bidRef);
  let ref01 = bidRef;
  if (!crossed && input.honorChartMid) {
    const midRef = bracketBidRef01(input.stripMid01 ?? null);
    if (takeBreached(input.take01, midRef)) {
      crossed = true;
      ref01 = bidRef ?? midRef;
    }
  }
  if (crossed && ref01 == null && input.honorChartMid) {
    ref01 = bracketBidRef01(input.stripMid01 ?? null);
  }
  return { crossed, ref01 };
}
