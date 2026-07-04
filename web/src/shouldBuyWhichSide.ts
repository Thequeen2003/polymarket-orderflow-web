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
import type { DualOutcomeWallFlow } from './dualOutcomeWalls';
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
  /** 0–100 agreement-weighted conviction on the pick (numeric). */
  confidencePct: number;
  /** 0–100 directional momentum on the favored side (margin + tape/forecast). */
  momentumScore: number;
  /** True when the advisory is stale (stability shows whipsaw or freshly flipped). */
  cautionFresh: boolean;
};

export type ShouldBuyBookDualCall = {
  lane: 'up' | 'down';
  verdict: 'ENTER' | 'SCALP' | 'WATCH' | 'WAIT';
  gate: 'ARMED' | 'PARTIAL' | 'NOT_ARMED';
  go: boolean;
  enterOnlyIf: string;
  laneLock: {
    lane: 'up' | 'down' | null;
    status: 'LOCKED' | 'FORMING' | 'WAIT';
    confidence: 'HIGH' | 'MED' | 'LOW';
    reason: string;
  };
};

export type ShouldBuyBookContext = {
  dual: ShouldBuyBookDualCall | null;
  wallFlow: DualOutcomeWallFlow | null;
  probUp: number | null;
  probDown: number | null;
  midUp: number | null;
  midDown: number | null;
};

export type ShouldBuyInput = {
  machine: SpotPtbMachineReadout | null;
  /** Sports / book-only desk when spot+PTB machine is unavailable. */
  book?: ShouldBuyBookContext | null;
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
  confidencePct: 0,
  momentumScore: 0,
  cautionFresh: false,
};

function label(lane: 'up' | 'down', upLabel?: string, downLabel?: string): string {
  return lane === 'up' ? (upLabel ?? 'UP').toUpperCase() : (downLabel ?? 'DOWN').toUpperCase();
}

function cap(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function computeMomentumScore(args: {
  scores: LaneScores;
  winner: 'up' | 'down' | null;
  tape: TapeVelocity | null;
  tapeLane: 'up' | 'down' | null;
  forecast: SwitchForecast | null;
}): number {
  const { scores, winner, tape, tapeLane, forecast } = args;
  const total = scores.up + scores.down;
  const absMargin = Math.abs(scores.up - scores.down);
  let mom = total > 0 ? cap((absMargin / total) * 72, 0, 72) : 0;
  mom += cap(absMargin * 3.5, 0, 18);
  if (winner && tape?.reliable && tapeLane) {
    const tl = tapeLaneVote(tapeLane, tape.dominance);
    if (tl === winner) {
      mom += tape.burst === 'extreme' ? 12 : tape.burst === 'aggressive' ? 8 : 4;
      if (tape.acceleration === 'surging') mom += 6;
      else if (tape.acceleration === 'building') mom += 3;
    } else if (tl) {
      mom -= 10;
    }
  }
  if (
    winner &&
    forecast &&
    forecast.lane === winner &&
    (forecast.status === 'GO_IN' || forecast.status === 'SWITCH_INCOMING')
  ) {
    mom += forecast.confidence === 'HIGH' ? 10 : forecast.confidence === 'MED' ? 6 : 3;
  }
  return Math.round(cap(mom, 0, 100));
}

function confidencePctFromAgreement(
  agreementScore: number,
  confidence: BuySideConfidence,
  verdict: BuySideVerdict,
): number {
  if (verdict === 'NEITHER') return Math.round(cap(agreementScore * 0.55, 0, 45));
  if (confidence === 'HIGH') return Math.round(cap(agreementScore, 72, 100));
  if (confidence === 'MED') return Math.round(cap(agreementScore * 0.92, 48, 88));
  return Math.round(cap(agreementScore * 0.78, 18, 62));
}

type LaneScores = { up: number; down: number };

function accumulateBookStructureVotes(scores: LaneScores, book: ShouldBuyBookContext): void {
  const { dual, wallFlow, probUp, probDown } = book;
  const addVote = (lane: 'up' | 'down' | null, weight: number) => {
    if (lane === 'up') scores.up += weight;
    else if (lane === 'down') scores.down += weight;
  };

  if (dual?.go) {
    const base = dual.verdict === 'ENTER' ? 3.2 : dual.verdict === 'SCALP' ? 2.2 : 1.4;
    addVote(dual.lane, base);
    if (dual.laneLock.status === 'LOCKED') {
      addVote(dual.lane, dual.laneLock.confidence === 'HIGH' ? 1.8 : dual.laneLock.confidence === 'MED' ? 1.0 : 0.4);
    }
  } else if (dual?.lane) {
    addVote(dual.lane, 0.6);
  }

  if (wallFlow?.flowLane) {
    addVote(wallFlow.flowLane, 1.4 + cap(wallFlow.pressure / 100, 0, 0.8));
  }

  if (probUp != null && probDown != null && Number.isFinite(probUp) && Number.isFinite(probDown)) {
    const spread = probUp - probDown;
    if (Math.abs(spread) >= 0.012) {
      addVote(spread > 0 ? 'up' : 'down', 0.8 + Math.min(2, Math.abs(spread) * 12));
    }
  }
}

function accumulateBookVotes(
  scores: LaneScores,
  book: ShouldBuyBookContext,
  tape: TapeVelocity | null,
  tapeLane: 'up' | 'down' | null,
  directive: TradeDirective | null,
): void {
  accumulateBookStructureVotes(scores, book);
  const addVote = (lane: 'up' | 'down' | null, weight: number) => {
    if (lane === 'up') scores.up += weight;
    else if (lane === 'down') scores.down += weight;
  };

  if (tape && tape.reliable && tapeLane) {
    const tl = tapeLaneVote(tapeLane, tape.dominance);
    if (tl) {
      let w = 1.4;
      if (tape.burst === 'aggressive') w += 0.35;
      if (tape.burst === 'extreme') w += 0.6;
      addVote(tl, w);
    }
  }

  if (directive && (directive.action === 'INITIATE' || directive.action === 'ADD') && directive.lane) {
    const w =
      directive.action === 'INITIATE' && directive.confidence === 'HIGH'
        ? 2.4
        : directive.action === 'INITIATE'
          ? 1.8
          : 1.2;
    addVote(directive.lane, w);
  }
}

/** Prefer a directional call over a stale NEITHER when both sources are available. */
export function pickStrongerBuyAdvisory(
  desk: BuySideAdvisory | null | undefined,
  fallback: BuySideAdvisory,
): BuySideAdvisory {
  if (!desk) return fallback;
  if (desk.verdict !== 'NEITHER' && fallback.verdict === 'NEITHER') return desk;
  if (desk.verdict === 'NEITHER' && fallback.verdict !== 'NEITHER') return fallback;
  if (desk.verdict === 'NEITHER' && fallback.verdict === 'NEITHER') {
    const deskMargin = Math.abs(desk.scores.up - desk.scores.down);
    const fbMargin = Math.abs(fallback.scores.up - fallback.scores.down);
    return fbMargin > deskMargin ? fallback : desk;
  }
  const rank = { HIGH: 3, MED: 2, LOW: 1 };
  if (rank[fallback.confidence] > rank[desk.confidence]) return fallback;
  return desk;
}

function resolveMachineWinner(args: {
  scores: LaneScores;
  machine: SpotPtbMachineReadout;
  directive: TradeDirective | null;
}): 'up' | 'down' | null {
  const { scores, machine, directive } = args;
  const margin = scores.up - scores.down;
  const absMargin = Math.abs(margin);
  if (absMargin >= MIN_SCORE_MARGIN) {
    return margin > 0 ? 'up' : 'down';
  }
  if (machine.agreementScore < MIN_AGREEMENT) return null;
  if (directive?.action === 'INITIATE' && directive.lane) return directive.lane;
  if (machine.focusLane) return machine.focusLane;
  if (machine.flowWinningLane) return machine.flowWinningLane;
  return null;
}

function shouldBuyWhichSideFromBook(input: ShouldBuyInput): BuySideAdvisory {
  const { book, tape, tapeLane, directive, stability, upLabel, downLabel } = input;
  if (!book) {
    return {
      ...NEITHER_ADVISORY,
      recommendation: 'Waiting for order-book data — open the Book tab briefly.',
    };
  }

  const { dual, wallFlow, probUp, probDown, midUp, midDown } = book;
  const scores = { up: 0, down: 0 };
  accumulateBookVotes(scores, book, tape, tapeLane, directive);

  const margin = scores.up - scores.down;
  const absMargin = Math.abs(margin);
  const winner: 'up' | 'down' | null = absMargin >= MIN_SCORE_MARGIN ? (margin > 0 ? 'up' : 'down') : null;

  let agreementScore = 42;
  if (dual?.go) {
    agreementScore =
      dual.laneLock.confidence === 'HIGH' ? 78 : dual.laneLock.confidence === 'MED' ? 64 : 52;
    if (dual.gate === 'ARMED') agreementScore += 4;
  }
  if (wallFlow?.flowLane && wallFlow.flowLane === winner) agreementScore += 6;
  if (tape?.reliable && tape.dominance !== 'idle' && tape.dominance !== 'mixed') agreementScore += 4;

  if (!winner || agreementScore < MIN_AGREEMENT) {
    const reasons: string[] = [];
    if (!winner) reasons.push(`Book scores too close: ${scores.up.toFixed(1)} vs ${scores.down.toFixed(1)}.`);
    else reasons.push(`Conviction ${agreementScore}% — below ${MIN_AGREEMENT}% threshold.`);
    if (dual && !dual.go) reasons.push(`Dual belief ${dual.verdict} · gate ${dual.gate.replace('_', ' ')} — not GO yet.`);
    return {
      ...NEITHER_ADVISORY,
      scores,
      confidencePct: confidencePctFromAgreement(agreementScore, 'LOW', 'NEITHER'),
      momentumScore: computeMomentumScore({ scores, winner: null, tape, tapeLane, forecast: input.forecast ?? null }),
      reasons,
      recommendation: reasons[0] ?? 'No clear side from the book yet.',
      cautionFresh: stability?.warnFresh === true || stability?.whipsaw === true,
    };
  }

  const winLabel = label(winner, upLabel, downLabel);
  const winMid = winner === 'up' ? midUp : midDown;
  const winProb = winner === 'up' ? probUp : probDown;

  const confidence: BuySideConfidence =
    agreementScore >= HIGH_CONF_AGREEMENT && absMargin >= 2.8 && dual?.go
      ? 'HIGH'
      : agreementScore >= MED_CONF_AGREEMENT && absMargin >= 1.8
        ? 'MED'
        : 'LOW';

  let size = cap((agreementScore - 35) / 55, 0.1, 1);
  if (confidence === 'LOW') size *= 0.55;
  if (!dual?.go) size *= 0.65;

  const reasons: string[] = [];
  if (dual?.go) {
    reasons.push(`Dual belief GO on ${winLabel} (${dual.verdict}, gate ${dual.gate.replace('_', ' ')}).`);
  }
  if (wallFlow?.flowLane === winner && wallFlow.headline.trim()) {
    reasons.push(wallFlow.headline.trim());
  }
  if (winProb != null && winMid != null) {
    reasons.push(`Implied ${winLabel} ${(winProb * 100).toFixed(1)}% · mid ${(winMid * 100).toFixed(1)}¢.`);
  }
  if (dual?.enterOnlyIf.trim()) reasons.push(dual.enterOnlyIf.trim());
  if (reasons.length > 4) reasons.splice(4);

  const risks: string[] = [];
  if (dual && !dual.go) risks.push('Dual chart has not armed GO — confirm on Dual belief tab.');
  if (wallFlow?.flowLane && wallFlow.flowLane !== winner) {
    risks.push(`Wall flow favors ${label(wallFlow.flowLane, upLabel, downLabel)} — may oppose this lean.`);
  }
  if (risks.length > 2) risks.splice(2);

  const recommendation =
    confidence === 'HIGH'
      ? `BUY ${winLabel} — dual belief + book flow align.`
      : confidence === 'MED'
        ? `Lean ${winLabel} — book momentum favors this side; confirm tape.`
        : `Slight lean ${winLabel} — probe size only until dual GO.`;

  return {
    verdict: winner === 'up' ? 'BUY_UP' : 'BUY_DOWN',
    confidence,
    recommendation,
    reasons,
    risks,
    suggestedSize: size,
    edgePerShareUsd: null,
    winProb: winProb ?? null,
    mid: winMid ?? null,
    scores,
    confidencePct: confidencePctFromAgreement(agreementScore, confidence, winner === 'up' ? 'BUY_UP' : 'BUY_DOWN'),
    momentumScore: computeMomentumScore({
      scores,
      winner,
      tape,
      tapeLane,
      forecast: input.forecast ?? null,
    }),
    cautionFresh: stability?.warnFresh === true || stability?.whipsaw === true,
  };
}

/**
 * Ask the machine: should I buy UP or DOWN right now?
 */
export function shouldBuyWhichSide(input: ShouldBuyInput): BuySideAdvisory {
  const { machine, book, tape, tapeLane, forecast, directive, stability, upLabel, downLabel } = input;

  if (!machine && book) {
    return shouldBuyWhichSideFromBook(input);
  }

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

  // 5. Directive alignment — trade card INITIATE/ADD should move the needle.
  if (directive && (directive.action === 'INITIATE' || directive.action === 'ADD') && directive.lane) {
    const w =
      directive.action === 'INITIATE' && directive.confidence === 'HIGH'
        ? 2.5
        : directive.action === 'INITIATE'
          ? 1.8
          : 1.0;
    addVote(directive.lane, w);
  }

  // 6. Book / dual belief — merge structure only (tape + directive already scored above).
  if (book) {
    accumulateBookStructureVotes(scores, book);
  }

  const winner = resolveMachineWinner({ scores, machine, directive });
  const margin = scores.up - scores.down;
  const absMargin = Math.abs(margin);

  // Check minimum agreement threshold.
  if (!winner || machine.agreementScore < MIN_AGREEMENT) {
    const reasons: string[] = [];
    if (!winner) reasons.push(`Score margin too thin: UP ${scores.up.toFixed(1)} vs DOWN ${scores.down.toFixed(1)}.`);
    if (machine.agreementScore < MIN_AGREEMENT) reasons.push(`Agreement only ${machine.agreementScore}% — below ${MIN_AGREEMENT}% threshold.`);
    if (machine.regime === 'chop') reasons.push('Choppy regime — no clean directional edge.');
    return {
      ...NEITHER_ADVISORY,
      scores,
      confidencePct: confidencePctFromAgreement(machine.agreementScore, 'LOW', 'NEITHER'),
      momentumScore: computeMomentumScore({ scores, winner: null, tape, tapeLane, forecast }),
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
    confidencePct: confidencePctFromAgreement(
      machine.agreementScore,
      confidence,
      winner === 'up' ? 'BUY_UP' : 'BUY_DOWN',
    ),
    momentumScore: computeMomentumScore({ scores, winner, tape, tapeLane, forecast }),
    cautionFresh,
  };
}
