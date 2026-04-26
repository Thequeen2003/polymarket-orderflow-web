import type { PtbCoreEngineSnapshot } from '../ptbCoreEngine';

export type StrategyState = {
  /** For simple cooldown / hysteresis. */
  lastActionAtMs: number | null;
};

export type StrategyParams = {
  /** Minimum |spot-ptb| to consider entries (USD). */
  minDistUsd: number;
  /** Minimum |slope| to consider entries ($/min). */
  minSlopeUsdPerMin: number;
  /** Profit target for a lane (absolute probability points; 0.03 = +3¢). */
  takeProfit01: number;
  /** Stop for a lane (absolute probability points). */
  stopLoss01: number;
  /** Trade size per entry (shares). */
  clipShares: number;
  /** Cooldown between actions (ms). */
  cooldownMs: number;
};

export type StrategyContext = {
  now: number;
  snap: PtbCoreEngineSnapshot;
  upMid01: number | null;
  downMid01: number | null;
  upTokenId: string;
  downTokenId: string;
  /** Current position shares (paper) */
  upShares: number;
  downShares: number;
  /** Avg entry (paper) */
  upAvg01: number | null;
  downAvg01: number | null;
};

export type StrategyAction =
  | { kind: 'buy'; tokenId: string; price01: number; shares: number; note: string }
  | { kind: 'sell'; tokenId: string; price01: number; shares: number; note: string }
  | { kind: 'noop' };

/**
 * A minimal “both lanes” PTB strategy:
 * - When ABOVE + positive slope → bias UP entries.
 * - When BELOW + negative slope → bias DOWN entries.
 * - Always allow exits (TP/SL) independently per lane.
 */
export function decideBothLanes(ctx: StrategyContext, state: StrategyState, p: StrategyParams): StrategyAction[] {
  const out: StrategyAction[] = [];

  const canAct = state.lastActionAtMs == null || ctx.now - state.lastActionAtMs >= p.cooldownMs;
  const pos = ctx.snap.derived.position; // ABOVE/BELOW/AT (spot vs PTB)
  const slope = ctx.snap.derived.slopeUsdPerMin;
  const distAbs = Math.abs(ctx.snap.derived.distanceUsd);

  // Exits (independent per lane).
  if (ctx.upShares > 0 && ctx.upMid01 != null && ctx.upAvg01 != null) {
    const d = ctx.upMid01 - ctx.upAvg01;
    if (d >= p.takeProfit01) {
      out.push({ kind: 'sell', tokenId: ctx.upTokenId, price01: ctx.upMid01, shares: ctx.upShares, note: `up_tp +${(d * 100).toFixed(1)}¢` });
    } else if (d <= -p.stopLoss01) {
      out.push({ kind: 'sell', tokenId: ctx.upTokenId, price01: ctx.upMid01, shares: ctx.upShares, note: `up_sl ${(d * 100).toFixed(1)}¢` });
    }
  }
  if (ctx.downShares > 0 && ctx.downMid01 != null && ctx.downAvg01 != null) {
    const d = ctx.downMid01 - ctx.downAvg01;
    if (d >= p.takeProfit01) {
      out.push({
        kind: 'sell',
        tokenId: ctx.downTokenId,
        price01: ctx.downMid01,
        shares: ctx.downShares,
        note: `down_tp +${(d * 100).toFixed(1)}¢`,
      });
    } else if (d <= -p.stopLoss01) {
      out.push({
        kind: 'sell',
        tokenId: ctx.downTokenId,
        price01: ctx.downMid01,
        shares: ctx.downShares,
        note: `down_sl ${(d * 100).toFixed(1)}¢`,
      });
    }
  }

  // Entries (also independent; trade both is allowed).
  if (!canAct) return out;
  if (distAbs < p.minDistUsd) return out;
  if (Math.abs(slope) < p.minSlopeUsdPerMin) return out;

  if (pos === 'ABOVE' && slope > 0 && ctx.upMid01 != null) {
    out.push({ kind: 'buy', tokenId: ctx.upTokenId, price01: ctx.upMid01, shares: p.clipShares, note: 'enter_up_above_slope' });
  }
  if (pos === 'BELOW' && slope < 0 && ctx.downMid01 != null) {
    out.push({ kind: 'buy', tokenId: ctx.downTokenId, price01: ctx.downMid01, shares: p.clipShares, note: 'enter_down_below_slope' });
  }

  return out;
}

