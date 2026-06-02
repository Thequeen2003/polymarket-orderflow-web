/**
 * Pre-entry advisory: "Should I buy UP or should I buy DOWN?"
 *
 * Synthesizes the fused machine readout (agreement, focus lane, flow, edges,
 * tape, acceleration, MTF, overextension) into a single, clear recommendation
 * the operator can ask *right before* pulling the trigger.
 *
 * Returns one of three verdicts:
 *   BUY_UP   — the system favors buying the UP outcome
 *   BUY_DOWN — the system favors buying the DOWN outcome
 *   NEITHER  — no clear side; stay flat
 *
 * Pure function — no React, no side effects. Easy to test.
 */

import { tapeLaneVote, type SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { TapeVelocity } from './tapeVelocity';
import type { SwitchForecast } from './sectionalMomentum';
import type { TradeDirective } from './tradeDirective';
import type { DirectiveStability } from './directiveStability';

export type BuySideVerdict = 'BUY_UP' | 'BUY_DOWN' | 'NEITHER';

export type BuySideConfidence = 'HIGH' | 'MED' | 'LOW';

export type BuySideAdvisory = {
  verdict: BuySideVerdict;
  confidence: BuySideConfidence;
  /** Human-readable recommendation (1 sentence). */
  recommendation: string;
  /** Why the machine picks this side (≤4 bullets). */
  reasons: string[];
  /** What could go wrong / what would invalidate (≤2 bullets). */
  risks: string[];
  /** Suggested sizing fraction 0..1 (0 = don't trade). */
  suggestedSize: number;
  /** $ edge per share on the recommended side (null when NEITHER). */
  edgePerShareUsd: number | null;
  /** Model win probability for the recommended side (null when NEITHER). */
  winProb: number | null;
  /** Mid price you'd buy at (null when NEITHER). */
  mid: number | null;
  /** Score breakdown for transparency. */
  scores: { up: number; down: number };
  /** True when the advisory is stale (stability shows whipsaw or freshly flipped). */
  cautionFresh: boolean;
};

export type ShouldBuyInput = {
  machine: SpotPtbMachineReadout | null;
  tape: TapeVelocity | null;
  tapeLane: 'up' | 'down' | null;
  forecast: SwitchForecast | null;
  directive: TradeDirective | null;
  stability: DirectiveStability | null;
  upLabel?: string;
  downLabel?: string;
};

/** Minimum agreement for a non-NEITHER call. */
const MIN_AGREEMENT = 40;
/** Minimum score margin between UP and DOWN to pick a side. */
const MIN_SCORE_MARGIN = 1.2;
/** Agreement threshold for HIGH confidence. */
const HIGH_CONF_AGREEMENT = 72;
/** Agreement threshold for MED confidence. */
const MED_CONF_AGREEMENT = 55;

const NEITHER_ADVISORY: BuySideAdvisory = {
  verdict: 'NEITHER',
  confidence: 'LOW',
  recommendation: 'No clear side — stay flat until the tape commits.',
  reasons: ['Sensors split or too weak to act on.'],
  risks: [],
  suggestedSize: 0,
  edgePerShareUsd: null,
  winProb: null,
  mid: null,
  scores: { up: 0, down: 0 },
  cautionFresh: false,
};

function label(lane: 'up' | 'down', upLabel?: string, downLabel?: string): string {
  return lane === 'up' ? (upLabel ?? 'UP').toUpperCase() : (downLabel ?? 'DOWN').toUpperCase();
}

function cap(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Ask the machine: should I buy UP or DOWN right now?
 */
export function shouldBuyWhichSide(input: ShouldBuyInput): BuySideAdvisory {
  const { machine, tape, tapeLane, forecast, directive, stability, upLabel, downLabel } = input;

  if (!machine) {
    return {
      ...NEITHER_ADVISORY,
      recommendation: 'Waiting for machine readout — no data to advise on.',
    };
  }

  // Build per-lane scores from all available signals.
  const scores = { up: 0, down: 0 };
  const addVote = (lane: 'up' | 'down' | null, weight: number) => {
    if (lane === 'up') scores.up += weight;
    else if (lane === 'down') scores.down += weight;
  };

  // 1. Lane votes from machine readout (already weighted internally).
  scores.up = machine.laneVotes.up;
  scores.down = machine.laneVotes.down;

  // 2. Edge math — the most objective signal.
  const edges = machine.edges;
  if (edges) {
    if (edges.up && edges.up.edgePerShareUsd > 0) {
      const w = edges.up.edgePerShareUsd >= 0.12 ? 2.0 : edges.up.edgePerShareUsd >= 0.05 ? 1.4 : 0.7;
      addVote('up', w);
    }
    if (edges.down && edges.down.edgePerShareUsd > 0) {
      const w = edges.down.edgePerShareUsd >= 0.12 ? 2.0 : edges.down.edgePerShareUsd >= 0.05 ? 1.4 : 0.7;
      addVote('down', w);
    }
  }

  // 3. Tape velocity — aggressive flow is the strongest live confirmation.
  if (tape && tape.reliable && tapeLane) {
    const tl = tapeLaneVote(tapeLane, tape.dominance);
    if (tl) {
      let w = 1.5;
      if (tape.burst === 'aggressive') w += 0.4;
      if (tape.burst === 'extreme') w += 0.7;
      if (Math.abs(tape.netPressure) >= 50) w += 0.3;
      addVote(tl, w);
    }
    // Micro acceleration — early directional read.
    if (tape.microReliable) {
      const microLane = tapeLaneVote(tapeLane, tape.microDominance);
      if (microLane && tape.acceleration === 'surging') addVote(microLane, 1.2);
      else if (microLane && tape.acceleration === 'building') addVote(microLane, 0.6);
    }
  }

  // 4. Forecast / sectional momentum.
  if (forecast && forecast.status !== 'WAIT' && forecast.lane) {
    const fW = forecast.confidence === 'HIGH' ? 1.3 : forecast.confidence === 'MED' ? 0.8 : 0.4;
    if (forecast.status === 'GO_IN' || forecast.status === 'SWITCH_INCOMING') {
      addVote(forecast.lane, fW);
    } else if (forecast.status === 'EXIT') {
      // EXIT penalizes the exiting lane.
      const penaltyLane = forecast.lane === 'up' ? 'down' : 'up';
      addVote(penaltyLane, fW * 0.5);
    }
  }

  // 5. Directive alignment bonus — if buildTradeDirective already says INITIATE on a side.
  if (directive && (directive.action === 'INITIATE' || directive.action === 'ADD') && directive.lane) {
    addVote(directive.lane, 1.0);
  }

  // Determine winner.
  const margin = scores.up - scores.down;
  const absMargin = Math.abs(margin);
  const winner: 'up' | 'down' | null =
    absMargin >= MIN_SCORE_MARGIN
      ? margin > 0 ? 'up' : 'down'
      : null;

  // Check minimum agreement threshold.
  if (!winner || machine.agreementScore < MIN_AGREEMENT) {
    const reasons: string[] = [];
    if (!winner) reasons.push(`Score margin too thin: UP ${scores.up.toFixed(1)} vs DOWN ${scores.down.toFixed(1)}.`);
    if (machine.agreementScore < MIN_AGREEMENT) reasons.push(`Agreement only ${machine.agreementScore}% — below ${MIN_AGREEMENT}% threshold.`);
    if (machine.regime === 'chop') reasons.push('Choppy regime — no clean directional edge.');
    return {
      ...NEITHER_ADVISORY,
      scores,
      reasons,
      recommendation: reasons[0] ?? 'No clear edge on either side.',
      cautionFresh: stability?.warnFresh === true || stability?.whipsaw === true,
    };
  }

  // Build the advisory for the winning side.
  const loser: 'up' | 'down' = winner === 'up' ? 'down' : 'up';
  const winLabel = label(winner, upLabel, downLabel);

  // Confidence from agreement + margin + edge quality.
  const edgeInfo = winner === 'up' ? edges?.up : edges?.down;
  const edgeUsd = edgeInfo?.edgePerShareUsd ?? null;
  const hasStrongEdge = edgeUsd != null && edgeUsd >= 0.05;
  const confidence: BuySideConfidence =
    machine.agreementScore >= HIGH_CONF_AGREEMENT && absMargin >= 3.0 && hasStrongEdge
      ? 'HIGH'
      : machine.agreementScore >= MED_CONF_AGREEMENT && absMargin >= 1.8
        ? 'MED'
        : 'LOW';

  // Sizing: scale from agreement + confidence + edge.
  let size = cap((machine.agreementScore - 35) / 55, 0.1, 1);
  if (confidence === 'LOW') size *= 0.5;
  if (machine.regime === 'chop') size *= 0.6;
  if (machine.overextension?.state === 'overextended' && machine.overextension.direction === winner) {
    size *= 0.5;
  }
  if (edgeUsd != null && edgeUsd <= 0) size = 0;
  size = cap(size, 0, 1);

  // Reasons.
  const reasons: string[] = [];
  reasons.push(`Machine consensus ${machine.agreementScore}% on ${winLabel} (score ${scores[winner].toFixed(1)} vs ${scores[loser].toFixed(1)}).`);
  if (edgeInfo) {
    reasons.push(`Edge ${edgeInfo.edgePerShareUsd >= 0 ? '+' : ''}${edgeInfo.edgePerShareUsd.toFixed(3)}/share — model ${Math.round(edgeInfo.pWin * 100)}% vs market ${edgeInfo.mid.toFixed(2)}.`);
  }
  if (machine.flowWinningLane === winner) {
    reasons.push(`Order flow (tape + book + walls) confirms ${winLabel}.`);
  }
  if (tape?.reliable && tape.dominance !== 'idle' && tape.dominance !== 'mixed') {
    reasons.push(`Tape ${tape.burst} · net pressure ${tape.netPressure >= 0 ? '+' : ''}${Math.round(tape.netPressure)}.`);
  }
  if (reasons.length > 4) reasons.splice(4);

  // Risks.
  const risks: string[] = [];
  if (machine.overextension?.state === 'overextended' && machine.overextension.direction === winner) {
    risks.push(`Move already overextended (×${machine.overextension.ratio.toFixed(1)}) — pullback risk.`);
  }
  if (machine.regime === 'chop') {
    risks.push('Choppy regime — frequent reversals; keep size small.');
  }
  if (machine.acceleration?.state === 'reversing') {
    risks.push('Acceleration reversing — late slope flipped against prior momentum.');
  }
  if (edgeUsd != null && edgeUsd < 0.015 && edgeUsd >= 0) {
    risks.push('Edge is thin — noise range; the math barely confirms the trade.');
  }
  const flowConflict = machine.flowWinningLane && machine.flowWinningLane !== winner;
  if (flowConflict) {
    risks.push(`Flow winning lane (${label(machine.flowWinningLane!, upLabel, downLabel)}) opposes the call — confirm before entry.`);
  }
  if (risks.length > 2) risks.splice(2);

  const cautionFresh = stability?.warnFresh === true || stability?.whipsaw === true;

  const recommendation =
    confidence === 'HIGH'
      ? `BUY ${winLabel} — strong consensus, confirmed by flow and edge math.`
      : confidence === 'MED'
        ? `Lean ${winLabel} — solid sensor agreement; confirm tape before sizing up.`
        : `Slight lean toward ${winLabel} — thin conviction; probe size only.`;

  return {
    verdict: winner === 'up' ? 'BUY_UP' : 'BUY_DOWN',
    confidence,
    recommendation,
    reasons,
    risks,
    suggestedSize: size,
    edgePerShareUsd: edgeUsd,
    winProb: edgeInfo?.pWin ?? null,
    mid: edgeInfo?.mid ?? null,
    scores,
    cautionFresh,
  };
}
