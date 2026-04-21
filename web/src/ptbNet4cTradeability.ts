import type { BookLevel } from './bookLevels';
import { pickBookLevels } from './bookLevels';
import { estimateNet4cLong, type Net4cEstimate } from './executionEstimator';

export type PtbNet4cRoomLabel = 'YES' | 'MARGINAL' | 'NO';

export type PtbNet4cTradeability = {
  room: PtbNet4cRoomLabel;
  detail: string;
  net4c: Net4cEstimate;
  /** Cents (probability space) from current mid to first wall in the trade direction; null if no wall. */
  wallClearanceCents: number | null;
};

const PROB_4C = 0.04;

/**
 * +4¢ scalp room before first wall: combines book-based net+4¢ estimate with structural clearance
 * (current mid + 4¢ vs wall in probability space).
 */
export function computePtbNet4cRoom(params: {
  book: unknown;
  refShares?: number;
  nowProb: number;
  wallProb: number | null;
  /** Upper end of target band — cap for “needs room to here + 4¢” (optional). */
  targetHiProb?: number | null;
  maxRequiredGrossCents?: number;
}): PtbNet4cTradeability {
  const refShares = params.refShares ?? 100;
  const maxGross = params.maxRequiredGrossCents ?? 14;

  let bids: BookLevel[] = [];
  let asks: BookLevel[] = [];
  try {
    const p = pickBookLevels(params.book);
    bids = p.bids;
    asks = p.asks;
  } catch {
    return {
      room: 'NO',
      detail: 'No usable book for depth estimate.',
      net4c: emptyFailNet(refShares),
      wallClearanceCents: null,
    };
  }

  const net4c = estimateNet4cLong({ asks, bids, shares: refShares, maxLevels: 18 });

  const p0 = Math.max(0.01, Math.min(0.99, params.nowProb));
  const wall = params.wallProb != null ? Math.max(0.01, Math.min(0.99, params.wallProb)) : null;

  let wallClearanceCents: number | null = null;
  let structuralBlock = false;
  if (wall != null) {
    // Primary lane is “pushing higher” in implied space toward wall above mid.
    wallClearanceCents = (wall - p0) * 100;
    if (p0 + PROB_4C > wall - 0.002) structuralBlock = true;
  }

  const hiCap = params.targetHiProb != null ? Math.min(params.targetHiProb, wall ?? 0.99) : null;
  if (hiCap != null && wall != null && hiCap + PROB_4C > wall - 0.002) {
    structuralBlock = true;
  }

  let room: PtbNet4cRoomLabel = 'YES';
  let detail = 'Net +4¢ feasible at ref size with room before wall.';

  if (!net4c.ok || structuralBlock) {
    room = 'NO';
    detail = structuralBlock
      ? 'Not enough structural room: mid + 4¢ would reach/clip first wall before net target.'
      : net4c.flags[0]
        ? `Net +4¢ fails (${net4c.flags.slice(0, 2).join(', ') || 'model'}).`
        : 'Net +4¢ not feasible at ref size.';
  } else {
    const gross = net4c.net.requiredGrossCents;
    const heavyFlags = net4c.flags.some((f) => f === 'WideSpread' || f === 'NoLiquidityAtTP' || f === 'PartialAtTP');
    if (gross != null && gross > maxGross) {
      room = 'MARGINAL';
      detail = `Required gross ~${gross.toFixed(1)}¢ (cap ${maxGross}¢) — edge is thin.`;
    } else if (wallClearanceCents != null && wallClearanceCents < 5.5) {
      room = 'MARGINAL';
      detail = `Tight wall clearance (~${wallClearanceCents.toFixed(1)}¢) — size down or wait.`;
    } else if (heavyFlags || net4c.flags.length >= 2) {
      room = 'MARGINAL';
      detail = `Executable but noisy (${net4c.flags.slice(0, 2).join(', ')}).`;
    }
  }

  return { room, detail, net4c, wallClearanceCents };
}

function emptyFailNet(shares: number): Net4cEstimate {
  return {
    ok: false,
    reason: 'no_book',
    entry: {
      ok: false,
      side: 'buy',
      sizeShares: shares,
      avgPrice: null,
      worstPrice: null,
      filledShares: 0,
      unfilledShares: shares,
      notional: null,
      steps: [],
      reason: 'empty_book',
    },
    tpExit: { targetPrice: null, fill: { ok: false, side: 'sell', sizeShares: 0, avgPrice: null, worstPrice: null, filledShares: 0, unfilledShares: 0, notional: null, steps: [], reason: 'empty_book' } },
    net: {
      profit01: null,
      profitCents: null,
      profitUsd: null,
      requiredGrossCents: null,
      spreadCents: null,
      entrySlippageCents: null,
      exitSlippageCents: null,
    },
    flags: [],
  };
}
