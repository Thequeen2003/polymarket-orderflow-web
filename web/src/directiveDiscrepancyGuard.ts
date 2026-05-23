/**
 * Detect discrepancies between the **trade card** (actionable lane) and the underlying sensor
 * stack. Even when the agreement score is high enough to trigger an action,
 * a *single strong* contrary sensor (overextension on the same lane, MTF stack
 * voting the opposite direction, big cross-prob against the lane, etc.) often
 * means the trade is risky.
 *
 * This module returns 0..N "warnings" the UI surfaces as a yellow/red stripe
 * on the trade card so the user pauses before clicking buy.
 *
 * Pure module — no React, no side effects.
 */

import type { TradeDirective } from './tradeDirective';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';

export type DiscrepancyKind =
  | 'MTF_OPPOSITE'
  | 'OVEREXTENDED_CHASE'
  | 'CROSS_PROB_AGAINST'
  | 'NEGATIVE_EDGE'
  | 'CHOP_REGIME'
  | 'CONFLICT_SIDE';

export type DiscrepancyWarning = {
  kind: DiscrepancyKind;
  severity: 'high' | 'med' | 'low';
  message: string;
};

export type DirectiveDiscrepancy = {
  /** All warnings, sorted highest severity first. */
  warnings: DiscrepancyWarning[];
  /** Aggregate score 0..100 — higher = more discrepancies. */
  score: number;
  /** True when there's at least one HIGH severity warning. */
  shouldBlock: boolean;
  /** True when there's any warning. */
  any: boolean;
};

const ACTIONABLE: TradeDirective['action'][] = ['INITIATE', 'ADD', 'FLIP'];

const SEVERITY_WEIGHT: Record<DiscrepancyWarning['severity'], number> = {
  high: 35,
  med: 18,
  low: 8,
};

export function detectDirectiveDiscrepancy(
  directive: TradeDirective | null,
  readout: SpotPtbMachineReadout | null,
): DirectiveDiscrepancy {
  const warnings: DiscrepancyWarning[] = [];
  if (!directive || !readout || !directive.lane) {
    return { warnings: [], score: 0, shouldBlock: false, any: false };
  }
  // We only flag "should we click buy?" warnings when an actionable trade line is on the table.
  if (!ACTIONABLE.includes(directive.action)) {
    return { warnings: [], score: 0, shouldBlock: false, any: false };
  }

  const lane = directive.lane;
  const opposite = lane === 'up' ? 'down' : 'up';

  // 1) MTF stack votes opposite of the trade card lane.
  const mtf = readout.mtf;
  if (mtf && mtf.dominantLane === opposite && mtf.totalActionable >= 2) {
    warnings.push({
      kind: 'MTF_OPPOSITE',
      severity: mtf.fullAgreement ? 'high' : mtf.alignedCount >= 3 ? 'high' : 'med',
      message: `MTF stack leans ${opposite.toUpperCase()} (${mtf.alignedCount}/${mtf.totalActionable}) but trade card says ${directive.action} ${lane.toUpperCase()}.`,
    });
  } else if (mtf && mtf.hasConflict && mtf.alignedCount < 3) {
    warnings.push({
      kind: 'MTF_OPPOSITE',
      severity: 'low',
      message: `MTF stack split — only ${mtf.alignedCount}/${mtf.votes.length} timeframes confirm.`,
    });
  }

  // 2) Overextended chase: card wants entry same direction as outsized recent move.
  const overext = readout.overextension;
  if (overext && overext.state === 'overextended' && overext.direction === lane) {
    warnings.push({
      kind: 'OVEREXTENDED_CHASE',
      severity: overext.severity >= 80 ? 'high' : 'med',
      message: `Last move ${lane.toUpperCase()} is ×${overext.ratio.toFixed(1)} baseline — chasing risks reversion.`,
    });
  }

  // 3) Cross prob says PTB will flip — bad for fresh adds, fine for FLIP/EXIT.
  const cross = readout.crossProb;
  if (cross != null && cross >= 0.65) {
    if (directive.action === 'INITIATE' || directive.action === 'ADD') {
      // Entering a side while the line is likely to flip is risky.
      warnings.push({
        kind: 'CROSS_PROB_AGAINST',
        severity: cross >= 0.82 ? 'high' : 'med',
        message: `Cross prob ${Math.round(cross * 100)}% — PTB likely flips before the bell, eroding this entry.`,
      });
    }
  }

  // 4) Negative edge despite actionable directive (shouldn't happen with new gate, but belt+suspenders).
  if (directive.edgePerShareUsd != null && directive.edgePerShareUsd < 0) {
    warnings.push({
      kind: 'NEGATIVE_EDGE',
      severity: 'high',
      message: `Edge is ${directive.edgePerShareUsd.toFixed(2)}/share — market is already pricing past the model.`,
    });
  }

  // 5) Chop regime + fresh INITIATE: system says enter, but chop = high failure rate.
  if (readout.regime === 'chop' && directive.action === 'INITIATE') {
    warnings.push({
      kind: 'CHOP_REGIME',
      severity: 'low',
      message: 'Choppy regime — frequent PTB crosses; consider smaller size or limits.',
    });
  }

  // 6) prob ↔ spot conflict surfaced even though agreement was enough to fire.
  if (readout.probVsSpot === 'conflict') {
    warnings.push({
      kind: 'CONFLICT_SIDE',
      severity: 'low',
      message: 'Implied probability and spot vs PTB disagree — fundamental ambiguity.',
    });
  }

  // Sort by severity, then by kind for stability.
  const order: Record<DiscrepancyWarning['severity'], number> = { high: 0, med: 1, low: 2 };
  warnings.sort((a, b) => order[a.severity] - order[b.severity]);

  const score = Math.min(100, warnings.reduce((s, w) => s + SEVERITY_WEIGHT[w.severity], 0));
  const highCount = warnings.filter((w) => w.severity === 'high').length;
  const shouldBlock = highCount >= 2 || (highCount >= 1 && score >= 88);

  return {
    warnings,
    score,
    shouldBlock,
    any: warnings.length > 0,
  };
}
