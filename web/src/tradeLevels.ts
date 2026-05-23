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
 *     still uses the **4¢ structural floor** (symmetric TP/SL) so operators have exit
 *     anchors even when the EV model disagrees with the tape.
 * @param input.crossProb    Optional cross probability (0..1) — tightens levels when high.
 * @param input.endsInMs     Optional round time remaining; final ~15s pins TP/SL; 15–60s tightens band.
 */
export function suggestTradeLevels(input: {
  lane: 'up' | 'down';
  entry: number;
  edgeUsd: number;
  crossProb?: number | null;
  endsInMs?: number | null;
}): TradeLevels | null {
  const { lane, entry, edgeUsd, crossProb, endsInMs } = input;

  if (!Number.isFinite(entry) || entry <= 0 || entry >= 1 || !Number.isFinite(edgeUsd)) {
    return null;
  }

  const horizonSec = endsInMs != null && Number.isFinite(endsInMs) ? Math.max(0, endsInMs / 1000) : Infinity;

  // Final seconds — pin to mid (collapsed). Card + sell flow carry the decision.
  if (horizonSec > 0 && horizonSec < SETTLEMENT_PIN_BELOW_SEC) {
    return collapsedPin(lane, entry, horizonSec);
  }

  // One bracket width for both legs (symmetric R:R ≈ 1 before boundary shrink).
  const edgeShare = crossProb != null && crossProb >= 0.7 ? 0.42 : 0.55;
  const positiveEdgeUsd = Math.max(0, edgeUsd);
  let leg = Math.max(0.04, positiveEdgeUsd * edgeShare);

  // Shrink both legs equally near 0.01 / 0.99 so cheap tokens do not get a tighter SL only.
  const roomUp = 0.99 - entry;
  const roomDn = entry - 0.01;
  const k = Math.min(1, roomUp / Math.max(leg, 1e-9), roomDn / Math.max(leg, 1e-9));
  leg *= k;

  let toBellBand = false;
  // Last minute to bell: compress symmetric leg so TP/SL stay scalp-realistic (not full 8¢ swings).
  if (
    horizonSec >= SETTLEMENT_PIN_BELOW_SEC &&
    horizonSec < SETTLEMENT_TIGHTEN_BELOW_SEC &&
    Number.isFinite(horizonSec)
  ) {
    const span = SETTLEMENT_TIGHTEN_BELOW_SEC - SETTLEMENT_PIN_BELOW_SEC;
    const t = (SETTLEMENT_TIGHTEN_BELOW_SEC - horizonSec) / span; // 0 @ 60s → 1 @ 15s
    const maxLeg = 0.05 - t * (0.05 - 0.028); // 5.0¢ down to 2.8¢ approaching the pin
    leg = Math.max(0.014, Math.min(leg, maxLeg));
    toBellBand = true;
  }

  const takeProfit = clamp01(entry + leg);
  const stopLoss = clamp01(entry - leg);

  const takeProfitGain = takeProfit - entry;
  const stopLossLoss = entry - stopLoss;
  const rrRatio = stopLossLoss > 1e-6 ? takeProfitGain / stopLossLoss : 0;

  const laneWord = lane === 'up' ? 'UP' : 'DOWN';
  const bellHint =
    toBellBand && Number.isFinite(horizonSec)
      ? ` · ~${Math.max(1, Math.round(horizonSec))}s to bell (tight band)`
      : '';
  const summary =
    `${laneWord} token @ ${entry.toFixed(2)} → ` +
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
}): TradeLevels | null {
  const edge = input.lane === 'up' ? input.laneEdges?.up : input.laneEdges?.down;
  if (!edge) return null;
  return suggestTradeLevels({
    lane: input.lane,
    entry: edge.mid,
    edgeUsd: edge.edgePerShareUsd,
    crossProb: input.crossProb ?? null,
    endsInMs: input.endsInMs ?? null,
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
}): TradeLevels | null {
  const { directive, laneEdges, crossProb, endsInMs } = args;
  if (!laneEdges) return null;

  const pick = (lane: 'up' | 'down') =>
    suggestLevelsForLane({ lane, laneEdges, crossProb, endsInMs });

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
    return suggestTradeLevels({
      lane,
      entry: laneMid,
      edgeUsd,
      crossProb,
      endsInMs,
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
