/**
 * Direction Engine — tiered decision stack → single ENTER UP / ENTER DOWN / NO TRADE.
 *
 * Tier 1 (decides the trade): spot vs PTB, model edge, momentum, repricing/lag.
 * Tier 2 (confirmation only): order book, sensor votes, MTF, wall flow.
 *
 * Hard rules override sensor noise when all Tier-1 gates align.
 * Conflict > 50% → NO TRADE unless a hard rule fired.
 */

import type { DeskSpeedSnapshot } from './deskSpeedLayers';
import type { MtfConsensus } from './multiTimeframeConsensus';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { NowPriceBandDistances } from './nowPriceSignals';
import type { ContractLagReadout } from './contractLag';

export const DIRECTION_CONFLICT_BLOCK_PCT = 50;
export const HARD_RULE_MIN_EDGE_PP = 10;
export const HARD_RULE_MIN_MODEL_PROB = 0.6;

export type DirectionVerdict = 'ENTER_UP' | 'ENTER_DOWN' | 'NO_TRADE';

export type DirectionTierSignal = {
  id: string;
  label: string;
  tier: 1 | 2;
  lane: 'up' | 'down' | null;
  detail: string;
};

export type DirectionEngineSignal = {
  verdict: DirectionVerdict;
  emoji: string;
  headline: string;
  confidencePct: number;
  conflictPct: number;
  conflictTone: 'low' | 'mid' | 'high';
  conflictEmoji: string;
  edgeCents: string | null;
  momentumLabel: string;
  ptbLabel: string;
  repricingLabel: string;
  hardRule: boolean;
  reasons: string[];
  tier1: DirectionTierSignal[];
  tier2: DirectionTierSignal[];
  proposedLane: 'up' | 'down' | null;
};

export type DirectionEngineInput = {
  geo: NowPriceBandDistances['geo'] | null;
  modelPUp: number | null;
  pMktUp: number | null;
  pMktDown?: number | null;
  deskSpeed: DeskSpeedSnapshot | null;
  machine: SpotPtbMachineReadout | null;
  mtf: MtfConsensus | null;
  /** Model − market on UP mid, percentage points. */
  edgePp: number | null;
  contractLag?: ContractLagReadout | null;
  repricingIntoEdge?: boolean | null;
  upLabel?: string;
  downLabel?: string;
};

type Lane = 'up' | 'down';

function bookLane(machine: SpotPtbMachineReadout | null): Lane | null {
  if (!machine) return null;
  if (machine.flowWinningLane) return machine.flowWinningLane;
  if (machine.sensors.bookControl) return machine.sensors.bookControl;
  return null;
}

function wallLane(machine: SpotPtbMachineReadout | null): Lane | null {
  if (!machine?.wallFlow?.flowLane) return null;
  return machine.wallFlow.flowLane;
}

function sensorVoteLane(machine: SpotPtbMachineReadout | null): Lane | null {
  if (!machine) return null;
  if (machine.focusLane) return machine.focusLane;
  const { up, down } = machine.laneVotes;
  if (up > down + 0.5) return 'up';
  if (down > up + 0.5) return 'down';
  return null;
}

function spotMomentumLane(deskSpeed: DeskSpeedSnapshot | null): Lane | null {
  const dir = deskSpeed?.spot?.direction;
  if (dir === 'UP') return 'up';
  if (dir === 'DOWN') return 'down';
  return null;
}

function contractMomentumLane(deskSpeed: DeskSpeedSnapshot | null, lane: Lane): boolean {
  const prob = deskSpeed?.lanes[lane]?.prob?.direction;
  return prob === 'UP';
}

function momentumLane(deskSpeed: DeskSpeedSnapshot | null): Lane | null {
  const spot = spotMomentumLane(deskSpeed);
  const upProb = deskSpeed?.lanes.up.prob?.direction === 'UP';
  const downProb = deskSpeed?.lanes.down.prob?.direction === 'UP';
  if (spot === 'up' && upProb) return 'up';
  if (spot === 'down' && downProb) return 'down';
  if (upProb && !downProb) return 'up';
  if (downProb && !upProb) return 'down';
  return spot;
}

function momentumLabel(deskSpeed: DeskSpeedSnapshot | null): string {
  const lane = momentumLane(deskSpeed);
  if (lane === 'up') return 'UP';
  if (lane === 'down') return 'DOWN';
  return 'FLAT';
}

function ptbLabel(geo: NowPriceBandDistances['geo'] | null): string {
  if (geo === 'ABOVE') return 'ABOVE';
  if (geo === 'BELOW') return 'BELOW';
  if (geo === 'IN_BAND') return 'IN BAND';
  return '—';
}

function repricingLabel(
  repricingIntoEdge: boolean | null | undefined,
  contractLag: ContractLagReadout | null | undefined,
): string {
  if (contractLag?.phase === 'aligned') return 'ALIGNED';
  if (repricingIntoEdge === true || contractLag?.phase === 'catching_up') return 'CATCHING UP';
  if (repricingIntoEdge === false) return 'NOT STARTED';
  return '—';
}

function repricingLane(
  contractLag: ContractLagReadout | null | undefined,
  repricingIntoEdge: boolean | null | undefined,
): Lane | null {
  if (!contractLag || contractLag.favoredSide === 'even') return null;
  const side = contractLag.favoredSide;
  if (contractLag.lagCents >= 5 && (contractLag.phase === 'lagging' || repricingIntoEdge === false)) {
    return side;
  }
  if (repricingIntoEdge === true && contractLag.phase === 'catching_up') return side;
  return null;
}

function edgeCentsForLane(
  lane: Lane,
  edgePp: number | null,
  contractLag: ContractLagReadout | null | undefined,
): string | null {
  if (contractLag) {
    const lag = lane === 'up' ? contractLag.lagUpCents : contractLag.lagDownCents;
    if (lag > 0.5) return `+${lag.toFixed(1)}¢`;
  }
  if (edgePp != null && Number.isFinite(edgePp)) {
    if (lane === 'up' && edgePp > 0.5) return `+${edgePp.toFixed(1)}pp`;
    if (lane === 'down' && edgePp < -0.5) return `+${Math.abs(edgePp).toFixed(1)}pp`;
  }
  return null;
}

function conflictTone(pct: number): 'low' | 'mid' | 'high' {
  if (pct > DIRECTION_CONFLICT_BLOCK_PCT) return 'high';
  if (pct >= 30) return 'mid';
  return 'low';
}

function conflictEmoji(pct: number): string {
  if (pct > DIRECTION_CONFLICT_BLOCK_PCT) return '🔴';
  if (pct >= 30) return '🟡';
  return '🟢';
}

function computeConflictPct(tier1: DirectionTierSignal[], tier2: DirectionTierSignal[], dir: Lane): number {
  const t1 = tier1.filter((s) => s.lane != null);
  const t2 = tier2.filter((s) => s.lane != null);
  const t1Agree = t1.filter((s) => s.lane === dir).length;
  const t1Disagree = t1.filter((s) => s.lane !== dir).length;
  const t2Disagree = t2.filter((s) => s.lane !== dir).length;

  const t1Internal = t1.length > 0 ? (t1Disagree / t1.length) * 100 : 0;
  const t2External = t2.length > 0 ? (t2Disagree / t2.length) * 100 : 0;
  const t1Agreement = t1.length > 0 ? (t1Agree / t1.length) * 100 : 50;

  return Math.min(100, Math.round(t1Internal * 0.45 + t2External * 0.55 + (100 - t1Agreement) * 0.15));
}

function confidenceFromTiers(
  tier1: DirectionTierSignal[],
  tier2: DirectionTierSignal[],
  dir: Lane,
  conflictPct: number,
  hardRule: boolean,
): number {
  const t1 = tier1.filter((s) => s.lane != null);
  const t2 = tier2.filter((s) => s.lane != null);
  const t1Hit = t1.filter((s) => s.lane === dir).length;
  const t2Hit = t2.filter((s) => s.lane === dir).length;

  const t1Share = t1.length > 0 ? t1Hit / t1.length : 0;
  const t2Share = t2.length > 0 ? t2Hit / t2.length : 0.5;

  let pct = Math.round(42 + t1Share * 38 + t2Share * 12 - conflictPct * 0.38);
  if (hardRule) pct = Math.max(pct, 75);
  return Math.min(100, Math.max(0, pct));
}

function checkHardRuleDown(input: DirectionEngineInput): boolean {
  const { geo, modelPUp, edgePp, deskSpeed } = input;
  if (geo !== 'BELOW') return false;
  if (modelPUp == null || modelPUp > 1 - HARD_RULE_MIN_MODEL_PROB) return false;
  if (edgePp == null || edgePp > -HARD_RULE_MIN_EDGE_PP) return false;
  return contractMomentumLane(deskSpeed, 'down') || spotMomentumLane(deskSpeed) === 'down';
}

function checkHardRuleUp(input: DirectionEngineInput): boolean {
  const { geo, modelPUp, edgePp, deskSpeed } = input;
  if (geo !== 'ABOVE') return false;
  if (modelPUp == null || modelPUp < HARD_RULE_MIN_MODEL_PROB) return false;
  if (edgePp == null || edgePp < HARD_RULE_MIN_EDGE_PP) return false;
  return contractMomentumLane(deskSpeed, 'up') || spotMomentumLane(deskSpeed) === 'up';
}

function buildReasons(
  dir: Lane,
  tier1: DirectionTierSignal[],
  upLabel: string,
  downLabel: string,
  repricing: string,
): string[] {
  const label = dir === 'up' ? upLabel : downLabel;
  const reasons: string[] = [];
  for (const s of tier1) {
    if (s.lane !== dir) continue;
    reasons.push(`${s.label} ✅`);
  }
  if (repricing === 'NOT STARTED') reasons.push('Repricing not started yet ✅');
  else if (repricing === 'CATCHING UP') reasons.push('Repricing into edge ✅');
  if (reasons.length === 0) reasons.push(`${label} tier-1 stack lean ✅`);
  return reasons.slice(0, 6);
}

export function computeDirectionEngine(input: DirectionEngineInput): DirectionEngineSignal {
  const upLabel = input.upLabel ?? 'UP';
  const downLabel = input.downLabel ?? 'DOWN';
  const { geo, modelPUp, pMktUp, deskSpeed, machine, mtf, edgePp, contractLag, repricingIntoEdge } = input;

  const spotAbove = geo === 'ABOVE';
  const spotBelow = geo === 'BELOW';
  const modelFavorsUp = modelPUp != null && pMktUp != null && modelPUp > pMktUp + 0.005;
  const modelFavorsDown = modelPUp != null && pMktUp != null && modelPUp < pMktUp - 0.005;
  const momLane = momentumLane(deskSpeed);
  const lagLane = repricingLane(contractLag, repricingIntoEdge);

  const tier1: DirectionTierSignal[] = [
    {
      id: 'spot',
      label: 'Spot vs PTB',
      tier: 1,
      lane: spotAbove ? 'up' : spotBelow ? 'down' : null,
      detail: spotAbove ? 'Spot above PTB' : spotBelow ? 'Spot below PTB' : 'In band',
    },
    {
      id: 'model',
      label: 'Model vs market',
      tier: 1,
      lane: modelFavorsUp ? 'up' : modelFavorsDown ? 'down' : null,
      detail:
        modelPUp != null
          ? `Model ${(modelPUp * 100).toFixed(1)}% ${upLabel}`
          : 'Model unavailable',
    },
    {
      id: 'momentum',
      label: 'Momentum',
      tier: 1,
      lane: momLane,
      detail: `Momentum ${momentumLabel(deskSpeed)}`,
    },
    {
      id: 'repricing',
      label: 'Repricing / lag',
      tier: 1,
      lane: lagLane,
      detail: repricingLabel(repricingIntoEdge, contractLag),
    },
  ];

  const book = bookLane(machine);
  const sensors = sensorVoteLane(machine);
  const walls = wallLane(machine);
  const mtfLane =
    mtf?.dominantLane && (mtf.alignedCount >= 2 || mtf.fullAgreement) ? mtf.dominantLane : null;

  const tier2: DirectionTierSignal[] = [
    {
      id: 'book',
      label: 'Order book',
      tier: 2,
      lane: book,
      detail: book ? `Flow ${book.toUpperCase()}` : 'No book lean',
    },
    {
      id: 'sensors',
      label: 'Sensor votes',
      tier: 2,
      lane: sensors,
      detail: sensors ? `Sensors ${sensors.toUpperCase()}` : 'Sensors split',
    },
    {
      id: 'mtf',
      label: 'Multi-timeframe',
      tier: 2,
      lane: mtfLane,
      detail: mtf?.summary ?? 'MTF neutral',
    },
    {
      id: 'walls',
      label: 'Wall flow',
      tier: 2,
      lane: walls,
      detail: walls ? `Walls ${walls.toUpperCase()}` : 'No wall edge',
    },
  ];

  const hardDown = checkHardRuleDown(input);
  const hardUp = checkHardRuleUp(input);

  let proposedLane: Lane | null = null;
  let hardRule = false;

  if (hardDown) {
    proposedLane = 'down';
    hardRule = true;
  } else if (hardUp) {
    proposedLane = 'up';
    hardRule = true;
  } else {
    const t1Votes = tier1.filter((s) => s.lane != null);
    const upVotes = t1Votes.filter((s) => s.lane === 'up').length;
    const downVotes = t1Votes.filter((s) => s.lane === 'down').length;
    if (upVotes > downVotes) proposedLane = 'up';
    else if (downVotes > upVotes) proposedLane = 'down';
    else if (upVotes === downVotes && upVotes > 0) proposedLane = null;
  }

  let verdict: DirectionVerdict = 'NO_TRADE';
  let emoji = '⚪';
  let headline = 'NO TRADE';
  let confidencePct = 0;
  let conflictPct = 100;
  let reasons: string[] = [];

  if (proposedLane) {
    conflictPct = computeConflictPct(tier1, tier2, proposedLane);
    confidencePct = confidenceFromTiers(tier1, tier2, proposedLane, conflictPct, hardRule);
    const repricing = repricingLabel(repricingIntoEdge, contractLag);

    if (hardRule || conflictPct <= DIRECTION_CONFLICT_BLOCK_PCT) {
      verdict = proposedLane === 'up' ? 'ENTER_UP' : 'ENTER_DOWN';
      emoji = proposedLane === 'up' ? '🟢' : '🔴';
      headline = `ENTER ${proposedLane === 'up' ? upLabel : downLabel}`;
      reasons = buildReasons(proposedLane, tier1, upLabel, downLabel, repricing);
      if (hardRule) reasons.unshift('Hard rule — tier-1 stack aligned ✅');
    } else {
      verdict = 'NO_TRADE';
      emoji = '⚪';
      headline = 'NO TRADE';
      reasons = [
        `Conflict ${conflictPct}% — tier-2 disagrees with tier-1`,
        ...tier2.filter((s) => s.lane && s.lane !== proposedLane).map((s) => `${s.label} favors ${s.lane === 'up' ? upLabel : downLabel}`),
      ];
    }
  } else {
    conflictPct = Math.min(100, Math.round(50 + (tier1.filter((s) => s.lane).length > 0 ? 25 : 0)));
    reasons = ['Tier-1 signals split — wait for alignment'];
  }

  const edgeLane = proposedLane ?? (edgePp != null && edgePp < 0 ? 'down' : edgePp != null && edgePp > 0 ? 'up' : null);

  return {
    verdict,
    emoji,
    headline,
    confidencePct,
    conflictPct,
    conflictTone: conflictTone(conflictPct),
    conflictEmoji: conflictEmoji(conflictPct),
    edgeCents: edgeLane ? edgeCentsForLane(edgeLane, edgePp, contractLag) : null,
    momentumLabel: momentumLabel(deskSpeed),
    ptbLabel: ptbLabel(geo),
    repricingLabel: repricingLabel(repricingIntoEdge, contractLag),
    hardRule,
    reasons,
    tier1,
    tier2,
    proposedLane,
  };
}
