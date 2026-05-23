/**
 * "No-Trade" composite — collapses many bad-condition signals into a single
 * 0..100 score + tier so the user gets one clear "pause / size down" read instead
 * of trying to read the whole sensor stack.
 *
 * Reasons (each adds a contribution):
 *   - WHIPSAW            +35  — trade card flipped 4+ times in a minute
 *   - FRESH_DIRECTIVE    +10  — trade card only just changed (<10s)
 *   - HIGH_DISCREPANCY   +25  — trade card disagrees w/ a strong sensor
 *   - MED_DISCREPANCY    +12
 *   - THIN_EDGE          +18  — best lane edge < ~1.5¢
 *   - NEGATIVE_EDGE      +30  — model says trade is −EV
 *   - OVEREXTENDED_CHASE +20  — chasing an outsized recent move
 *   - CHOP_REGIME        +15  — choppy regime (trending fail rate ↑)
 *   - SETTLEMENT_NO_EDGE +25  — <60s left and no clear lane edge
 *   - COOLDOWN_ACTIVE    +15  — re-entry cooldown active on the dominant lane
 *   - TAPE_QUIET         +10  — desk tape idle when momentum-trade is implied
 *   - TAPE_FIGHTS        +18  — desk tape aggressive opposite the lane
 *
 * Tiers (after summing & clamping):
 *   GREEN  0..29   trade normally
 *   YELLOW 30..69  proceed cautiously, smaller size
 *   RED    78..100 pause — do not add risk
 *
 * Pure module — no React, easy to unit-test.
 */

import type { DirectiveStability } from './directiveStability';
import type { DirectiveDiscrepancy } from './directiveDiscrepancyGuard';
import type { LaneEdges } from './tradeEdgeCalculator';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { Overextension } from './overextensionDetector';
import type { ReEntryGuardCheck } from './reEntryGuard';
import type { TapeVelocity } from './tapeVelocity';

export type NoTradeReason =
  | 'WHIPSAW'
  | 'FRESH_DIRECTIVE'
  | 'HIGH_DISCREPANCY'
  | 'MED_DISCREPANCY'
  | 'THIN_EDGE'
  | 'NEGATIVE_EDGE'
  | 'OVEREXTENDED_CHASE'
  | 'CHOP_REGIME'
  | 'SETTLEMENT_NO_EDGE'
  | 'COOLDOWN_ACTIVE'
  | 'TAPE_QUIET'
  | 'TAPE_FIGHTS';

export type NoTradeContribution = {
  reason: NoTradeReason;
  weight: number;
  message: string;
};

export type NoTradeTier = 'GREEN' | 'YELLOW' | 'RED';

export type NoTradeScore = {
  /** 0..100, clamped. Higher = more reasons to pause or size down. */
  score: number;
  tier: NoTradeTier;
  contributions: NoTradeContribution[];
  /** Concise plain-English summary for banner/tooltip. */
  summary: string;
};

const REASON_WEIGHTS: Record<NoTradeReason, number> = {
  WHIPSAW: 35,
  FRESH_DIRECTIVE: 10,
  HIGH_DISCREPANCY: 25,
  MED_DISCREPANCY: 12,
  THIN_EDGE: 18,
  NEGATIVE_EDGE: 30,
  OVEREXTENDED_CHASE: 20,
  CHOP_REGIME: 15,
  SETTLEMENT_NO_EDGE: 25,
  COOLDOWN_ACTIVE: 15,
  TAPE_QUIET: 10,
  TAPE_FIGHTS: 18,
};

const REASON_MESSAGES: Record<NoTradeReason, string> = {
  WHIPSAW: 'Trade card is flipping fast — wait for the call to settle.',
  FRESH_DIRECTIVE: 'Trade card just changed — give it a few ticks to confirm.',
  HIGH_DISCREPANCY: 'Strong sensor disagrees with the trade card — pause.',
  MED_DISCREPANCY: 'Sensors partly disagree with the trade card — proceed cautiously.',
  THIN_EDGE: 'Best lane edge is razor-thin — friction will eat it.',
  NEGATIVE_EDGE: 'Model says this trade is currently −EV.',
  OVEREXTENDED_CHASE: 'Move already stretched vs baseline — chasing risks reversion.',
  CHOP_REGIME: 'Choppy regime — frequent fakes and PTB crosses.',
  SETTLEMENT_NO_EDGE: 'Settlement window with no clear lane edge — too late.',
  COOLDOWN_ACTIVE: 'Re-entry cool-down active — we just left this lane.',
  TAPE_QUIET: 'Desk tape is quiet — directional adds rarely work without prints.',
  TAPE_FIGHTS: 'Desk tape is pushing against this lane.',
};

function tierFor(score: number): NoTradeTier {
  if (score >= 78) return 'RED';
  if (score >= 32) return 'YELLOW';
  return 'GREEN';
}

function summarize(score: number, tier: NoTradeTier, top: NoTradeContribution[]): string {
  if (tier === 'GREEN') return `Conditions OK — score ${score}.`;
  const lead = tier === 'RED' ? 'PAUSE' : 'CAUTION';
  if (top.length === 0) return `${lead} — score ${score}.`;
  return `${lead} (score ${score}) — ${top
    .slice(0, 2)
    .map((c) => c.reason.replace(/_/g, ' ').toLowerCase())
    .join(', ')}.`;
}

export type NoTradeInput = {
  stability?: DirectiveStability | null;
  discrepancy?: DirectiveDiscrepancy | null;
  edges?: LaneEdges | null;
  /** Lane the trade card is targeting; used for tape-fights / overextension match. */
  lane?: 'up' | 'down' | null;
  machine?: SpotPtbMachineReadout | null;
  overextension?: Overextension | null;
  reEntry?: ReEntryGuardCheck | null;
  tape?: TapeVelocity | null;
  /** True when the trade engine flags us as inside a settlement window. */
  inSettlement?: boolean;
};

function pushContribution(out: NoTradeContribution[], reason: NoTradeReason, override?: string): void {
  out.push({
    reason,
    weight: REASON_WEIGHTS[reason],
    message: override ?? REASON_MESSAGES[reason],
  });
}

export function computeNoTradeScore(input: NoTradeInput): NoTradeScore {
  const c: NoTradeContribution[] = [];

  // 1) Stability
  if (input.stability) {
    if (input.stability.tier === 'whipsaw') pushContribution(c, 'WHIPSAW');
    else if (input.stability.tier === 'forming') pushContribution(c, 'FRESH_DIRECTIVE');
  }

  // 2) Discrepancy
  if (input.discrepancy?.shouldBlock) pushContribution(c, 'HIGH_DISCREPANCY');
  else if (input.discrepancy?.warnings.some((w) => w.severity === 'med')) {
    pushContribution(c, 'MED_DISCREPANCY');
  }

  // 3) Edge quality on the focused lane (if known) else best lane
  const lane = input.lane ?? input.edges?.bestLane ?? null;
  const laneEdge = lane && input.edges ? (lane === 'up' ? input.edges.up : input.edges.down) : null;
  if (laneEdge) {
    if (laneEdge.quality === 'NEGATIVE') pushContribution(c, 'NEGATIVE_EDGE');
    else if (laneEdge.quality === 'THIN') pushContribution(c, 'THIN_EDGE');
  } else if (input.edges && input.edges.bestEdgeUsd <= 0.015 && (input.edges.up || input.edges.down)) {
    pushContribution(c, 'THIN_EDGE');
  }

  // 4) Overextension on the same lane (chase guard)
  if (input.overextension?.state === 'overextended' && lane && input.overextension.direction === lane) {
    pushContribution(c, 'OVEREXTENDED_CHASE');
  }

  // 5) Regime
  if (input.machine?.regime === 'chop') pushContribution(c, 'CHOP_REGIME');

  // 6) Settlement with no edge
  if (input.inSettlement && (input.edges?.bestEdgeUsd ?? 0) < 0.03) {
    pushContribution(c, 'SETTLEMENT_NO_EDGE');
  }

  // 7) Cool-down active
  if (input.reEntry?.onCooldown) pushContribution(c, 'COOLDOWN_ACTIVE');

  // 8) Tape conditions
  if (input.tape && input.tape.reliable) {
    if (lane) {
      const fightsLane = (lane === 'up' && input.tape.dominance === 'sell') || (lane === 'down' && input.tape.dominance === 'buy');
      if (fightsLane && (input.tape.burst === 'aggressive' || input.tape.burst === 'extreme')) {
        pushContribution(c, 'TAPE_FIGHTS');
      }
    }
  } else if (input.tape && input.tape.burst === 'idle' && lane != null) {
    pushContribution(c, 'TAPE_QUIET');
  }

  // Sort heaviest contribution first.
  c.sort((a, b) => b.weight - a.weight);
  const score = Math.min(100, c.reduce((s, x) => s + x.weight, 0));
  const tier = tierFor(score);
  return {
    score,
    tier,
    contributions: c,
    summary: summarize(score, tier, c),
  };
}
