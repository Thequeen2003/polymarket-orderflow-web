/**
 * Auto-suggest take-profit and stop-loss levels for a directive — so the user
 * sees concrete prices to manage the trade, not just "INITIATE UP".
 *
 * For binary outcome contracts (Polymarket UP/DOWN tournament markets) the
 * worst-case loss is the entry price (full stake). We can't go more negative
 * than `entry` in $/share. The model:
 *
 *   - **Take-profit / stop-loss (symmetric)**: same dollar distance above and below
 *     entry (long the token → profit when mid rises). Bracket width scales with edge
 *     and a 4¢ floor so tiny edges are still actionable. No wider TP than SL by default
 *     so the strip is not psychologically biased toward “let winners run / cut quick”.
 *
 *   - **Cross-prob acceleration**: if the model gives high cross-prob (≥ 70%) the
 *     round is volatile — tighten **both** legs with the same factor.
 *
 *   - **Settlement / bell**: In the last **~60s** we progressively **tighten** the symmetric
 *     bracket so TP/SL stay executable on Polymarket (scalps into the bell). Inside the
 *     final **~15s** we **pin** TP/SL to mid (`collapsed`) — there is no room for fresh
 *     limit ladders; use market-style exits / brackets.
 *
 * Pure module — no React, easy to unit-test.
 */

import type { LaneEdges } from './tradeEdgeCalculator';
import type { TradeDirective } from './tradeDirective';

export type TradeLevels = {
  lane: 'up' | 'down';
  /** Entry price (typically the current implied mid you'd buy at). 0..1. */
  entry: number;
  /** Take-profit price target (0..1). */
  takeProfit: number;
  /** Stop-loss price (0..1). */
  stopLoss: number;
  /** Take-profit gain in $/share (positive). */
  takeProfitGain: number;
  /** Stop-loss loss in $/share (positive — abs value of risk). */
  stopLossLoss: number;
  /** Risk:Reward ratio (TP gain / SL loss). Larger is better. */
  rrRatio: number;
  /** Time horizon used for the calc (sec). */
  horizonSec: number;
  /** Concise human-readable summary. */
  summary: string;
  /** True when TP/SL are pinned to mid (final seconds — no actionable bracket). */
  collapsed: boolean;
  /** True when the symmetric band was tightened for the last ~60s (still actionable). */
  toBellBand?: boolean;
};

/** Seconds left at which TP/SL pin to mid (no new limit risk on the ladder). */
const SETTLEMENT_PIN_BELOW_SEC = 15;
/** Below this (but above pin), symmetric leg is capped so targets stay realistic into the bell. */
const SETTLEMENT_TIGHTEN_BELOW_SEC = 60;

function collapsedPin(lane: 'up' | 'down', entry: number, horizonSec: number): TradeLevels {
  const s = Math.max(1, Math.round(horizonSec));
  return {
    lane,
    entry,
    takeProfit: entry,
    stopLoss: entry,
    takeProfitGain: 0,
    stopLossLoss: 0,
    rrRatio: 0,
    horizonSec,
    collapsed: true,
    summary: `Bell in ~${s}s — TP/SL pinned to mid. Prefer market-style sells / existing brackets; skip new wide limits.`,
  };
}

function clamp01(x: number): number {
  return Math.max(0.01, Math.min(0.99, x));
}

/**
 * @param input.lane         The lane the directive is recommending entry on.
 * @param input.entry        Mid price to enter at (0..1).
 * @param input.edgeUsd      Per-share edge in $ from the model. When ≤ 0, bracket width
 *     still uses the **4¢ structural floor** so operators have exit anchors.
 * @param input.crossProb    Optional cross probability (0..1) — tightens levels when high.
 * @param input.endsInMs     Optional round time remaining; final ~15s pins TP/SL; 15–60s tightens band.
 * @param input.bestAsk      Optional best ask for entry lane (actual price you'd buy at).
 * @param input.bestBid      Optional best bid for entry lane (actual price you'd sell at / SL floor).
 * @param input.pWin         Optional model win probability — drives asymmetric TP when +EV.
 */
export function suggestTradeLevels(input: {
  lane: 'up' | 'down';
  entry: number;
  edgeUsd: number;
  crossProb?: number | null;
  endsInMs?: number | null;
  bestAsk?: number | null;
  bestBid?: number | null;
  pWin?: number | null;
}): TradeLevels | null {
  const { lane, edgeUsd, crossProb, endsInMs, bestAsk, bestBid, pWin } = input;

  // Use the best ask as actual entry price (what you'd pay) when available, else fall back to mid.
  let entry = input.entry;
  if (bestAsk != null && Number.isFinite(bestAsk) && bestAsk > 0 && bestAsk < 1) {
    entry = bestAsk;
  }

  if (!Number.isFinite(entry) || entry <= 0 || entry >= 1 || !Number.isFinite(edgeUsd)) {
    return null;
  }

  const horizonSec = endsInMs != null && Number.isFinite(endsInMs) ? Math.max(0, endsInMs / 1000) : Infinity;

  if (horizonSec > 0 && horizonSec < SETTLEMENT_PIN_BELOW_SEC) {
    return collapsedPin(lane, entry, horizonSec);
  }

  // Asymmetric TP/SL: when edge is positive, TP should be wider than SL (let winners run).
  // The ratio is based on pWin: higher probability → more room for TP.
  const positiveEdgeUsd = Math.max(0, edgeUsd);
  const edgeShare = crossProb != null && crossProb >= 0.7 ? 0.42 : 0.55;

  // TP leg: wider when edge is positive (reward the +EV math).
  let tpLeg: number;
  let slLeg: number;

  if (positiveEdgeUsd >= 0.04 && pWin != null && Number.isFinite(pWin) && pWin > entry) {
    // Use the model fair value as TP ceiling: token should converge toward pWin.
    // TP = halfway between entry and fair value (realistic target before settlement).
    const fairTarget = Math.min(0.98, pWin);
    tpLeg = Math.max(0.04, (fairTarget - entry) * 0.65);
    // SL: tighter — risk less than the expected reward. Floor at 3¢ so tiny edges aren't stop-hunted.
    slLeg = Math.max(0.03, positiveEdgeUsd * 0.5, tpLeg * 0.55);
  } else {
    // Neutral/negative edge: use symmetric with 4¢ floor.
    const leg = Math.max(0.04, positiveEdgeUsd * edgeShare);
    tpLeg = leg;
    slLeg = leg;
  }

  // Use best bid as SL floor — don't set SL below where you can actually sell.
  if (bestBid != null && Number.isFinite(bestBid) && bestBid > 0.01) {
    const bidFloor = entry - bestBid;
    if (bidFloor > 0 && bidFloor < slLeg) {
      slLeg = Math.max(0.02, bidFloor + 0.005);
    }
  }

  // Boundary clamp near 0/1.
  const roomUp = 0.99 - entry;
  const roomDn = entry - 0.01;
  tpLeg = Math.min(tpLeg, roomUp);
  slLeg = Math.min(slLeg, roomDn);

  let toBellBand = false;
  if (
    horizonSec >= SETTLEMENT_PIN_BELOW_SEC &&
    horizonSec < SETTLEMENT_TIGHTEN_BELOW_SEC &&
    Number.isFinite(horizonSec)
  ) {
    const span = SETTLEMENT_TIGHTEN_BELOW_SEC - SETTLEMENT_PIN_BELOW_SEC;
    const t = (SETTLEMENT_TIGHTEN_BELOW_SEC - horizonSec) / span;
    const maxLeg = 0.05 - t * (0.05 - 0.028);
    tpLeg = Math.max(0.014, Math.min(tpLeg, maxLeg));
    slLeg = Math.max(0.014, Math.min(slLeg, maxLeg));
    toBellBand = true;
  }

  const takeProfit = clamp01(entry + tpLeg);
  const stopLoss = clamp01(entry - slLeg);

  const takeProfitGain = takeProfit - entry;
  const stopLossLoss = entry - stopLoss;
  const rrRatio = stopLossLoss > 1e-6 ? takeProfitGain / stopLossLoss : 0;

  const laneWord = lane === 'up' ? 'UP' : 'DOWN';
  const bellHint =
    toBellBand && Number.isFinite(horizonSec)
      ? ` · ~${Math.max(1, Math.round(horizonSec))}s to bell (tight band)`
      : '';
  const entryNote = bestAsk != null && Number.isFinite(bestAsk) ? ' (ask)' : '';
  const summary =
    `${laneWord} token @ ${entry.toFixed(2)}${entryNote} → ` +
    `TP ${takeProfit.toFixed(2)} (+${takeProfitGain.toFixed(2)}/sh) · ` +
    `SL ${stopLoss.toFixed(2)} (−${stopLossLoss.toFixed(2)}/sh) · ` +
    `R:R ${rrRatio.toFixed(2)}${bellHint}`;

  return {
    lane,
    entry,
    takeProfit,
    stopLoss,
    takeProfitGain,
    stopLossLoss,
    rrRatio,
    horizonSec: Number.isFinite(horizonSec) ? horizonSec : 0,
    summary,
    collapsed: false,
    toBellBand: toBellBand || undefined,
  };
}

/**
 * TP/SL for a specific lane using current implied mids + edge from `laneEdges`
 * (terminal-probability EV engine). Used by the alert overlay so levels stay in
 * sync with the trade card even when the top-level trade line hasn't fired yet.
 */
export function suggestLevelsForLane(input: {
  lane: 'up' | 'down';
  laneEdges: LaneEdges | null;
  crossProb?: number | null;
  endsInMs?: number | null;
  /** Actual book top-of-book for realistic entry/SL. */
  bestAsk?: number | null;
  bestBid?: number | null;
}): TradeLevels | null {
  const edge = input.lane === 'up' ? input.laneEdges?.up : input.laneEdges?.down;
  if (!edge) return null;
  return suggestTradeLevels({
    lane: input.lane,
    entry: edge.mid,
    edgeUsd: edge.edgePerShareUsd,
    crossProb: input.crossProb ?? null,
    endsInMs: input.endsInMs ?? null,
    bestAsk: input.bestAsk ?? null,
    bestBid: input.bestBid ?? null,
    pWin: edge.pWin,
  });
}

/**
 * Primary TP/SL for the Answer card: directive mid/edge first, then book for the
 * directive lane, then book for **best +EV lane** when the directive lane is flat.
 * Without this, a Down-only card line can hide full TP/SL on Up when Up is the
 * only +EV side on the book.
 */
export function resolveTradeLevelsForDirective(args: {
  directive: TradeDirective | null;
  laneEdges: LaneEdges | null;
  crossProb: number | null;
  endsInMs: number | null;
  /** Actual top-of-book for the entry lane — so TP/SL use real prices. */
  bestAsk?: number | null;
  bestBid?: number | null;
}): TradeLevels | null {
  const { directive, laneEdges, crossProb, endsInMs, bestAsk, bestBid } = args;
  if (!laneEdges) return null;

  const pick = (lane: 'up' | 'down') =>
    suggestLevelsForLane({ lane, laneEdges, crossProb, endsInMs, bestAsk, bestBid });

  if (!directive?.lane) {
    const best = laneEdges.bestLane;
    return best ? pick(best) : null;
  }

  const lane = directive.lane;
  const laneMid = directive.laneMid != null && Number.isFinite(directive.laneMid) ? directive.laneMid : null;
  if (laneMid != null) {
    const dirEdge =
      directive.edgePerShareUsd != null && Number.isFinite(directive.edgePerShareUsd)
        ? directive.edgePerShareUsd
        : null;
    const bookEdge = lane === 'up' ? laneEdges.up?.edgePerShareUsd : laneEdges.down?.edgePerShareUsd;
    const edgeUsd =
      dirEdge !== null && Number.isFinite(dirEdge)
        ? dirEdge
        : bookEdge != null && Number.isFinite(bookEdge)
          ? bookEdge
          : 0;
    const pWin = directive.laneWinProb ?? (lane === 'up' ? laneEdges.up?.pWin : laneEdges.down?.pWin) ?? null;
    return suggestTradeLevels({
      lane,
      entry: laneMid,
      edgeUsd,
      crossProb,
      endsInMs,
      bestAsk,
      bestBid,
      pWin,
    });
  }

  const dirPick = pick(lane);
  if (dirPick) return dirPick;

  const best = laneEdges.bestLane;
  if (best) {
    const bestPick = pick(best);
    if (bestPick) return bestPick;
  }
  return null;
}
