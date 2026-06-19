/**
 * Net entry score — transparent UP vs DOWN checklist with a single final call.
 *
 * Net = UP Score − DOWN Score
 *   > +20  → ENTER UP
 *   < −20  → ENTER DOWN
 *   else   → NO TRADE
 *
 * Confidence (when entering): 60–70 weak · 70–85 strong · 85–100 extreme
 */

import type { DeskSpeedSnapshot } from './deskSpeedLayers';
import type { MtfConsensus } from './multiTimeframeConsensus';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { NowPriceBandDistances } from './nowPriceSignals';

export const NET_ENTRY_THRESHOLD = 20;

export const NET_ENTRY_WEIGHTS = {
  spotGeometry: 14,
  modelVsMarket: 14,
  ownMomentum: 14,
  oppMomentumFade: 14,
  orderBook: 14,
  mtf: 16,
  edge: 14,
} as const;

export type NetEntryFactorId =
  | 'spotGeometry'
  | 'modelVsMarket'
  | 'ownMomentum'
  | 'oppMomentumFade'
  | 'orderBook'
  | 'mtf'
  | 'edge';

export type NetEntryFactor = {
  id: NetEntryFactorId;
  label: string;
  upHit: boolean;
  downHit: boolean;
  upPoints: number;
  downPoints: number;
};

export type NetEntryVerdict = 'ENTER_UP' | 'ENTER_DOWN' | 'NO_TRADE';

export type NetEntryConfidenceLabel = 'Weak' | 'Strong' | 'Extreme';

export type NetEntrySignal = {
  upScore: number;
  downScore: number;
  netScore: number;
  verdict: NetEntryVerdict;
  emoji: string;
  headline: string;
  confidencePct: number | null;
  confidenceLabel: NetEntryConfidenceLabel | null;
  factors: NetEntryFactor[];
  summaryLine: string;
};

export type NetEntryScoreInput = {
  geo: NowPriceBandDistances['geo'] | null;
  modelPUp: number | null;
  pMktUp: number | null;
  deskSpeed: DeskSpeedSnapshot | null;
  machine: SpotPtbMachineReadout | null;
  mtf: MtfConsensus | null;
  /** Model − market on UP mid, percentage points. */
  edgePp: number | null;
  upLabel?: string;
  downLabel?: string;
};

function bookFavors(machine: SpotPtbMachineReadout | null): 'up' | 'down' | null {
  if (!machine) return null;
  if (machine.flowWinningLane) return machine.flowWinningLane;
  if (machine.sensors.bookControl) return machine.sensors.bookControl;
  if (machine.wallFlow?.flowLane) return machine.wallFlow.flowLane;
  return null;
}

function mtfPoints(mtf: MtfConsensus | null, lane: 'up' | 'down'): number {
  if (!mtf || mtf.dominantLane !== lane || mtf.totalActionable <= 0) return 0;
  const share = mtf.alignedCount / Math.max(mtf.totalActionable, 4);
  return Math.round(NET_ENTRY_WEIGHTS.mtf * Math.min(1, share));
}

function edgePoints(edgePp: number | null, lane: 'up' | 'down'): number {
  if (edgePp == null || !Number.isFinite(edgePp)) return 0;
  if (lane === 'up' && edgePp >= 2) return NET_ENTRY_WEIGHTS.edge;
  if (lane === 'down' && edgePp <= -2) return NET_ENTRY_WEIGHTS.edge;
  return 0;
}

function confidenceFromNet(net: number): { pct: number; label: NetEntryConfidenceLabel } {
  const abs = Math.abs(net);
  const pct = Math.min(100, Math.max(60, Math.round(60 + abs * 0.65)));
  const label: NetEntryConfidenceLabel = pct >= 85 ? 'Extreme' : pct >= 70 ? 'Strong' : 'Weak';
  return { pct, label };
}

export function computeNetEntryScore(input: NetEntryScoreInput): NetEntrySignal {
  const upLabel = input.upLabel ?? 'UP';
  const downLabel = input.downLabel ?? 'DOWN';
  const { geo, modelPUp, pMktUp, deskSpeed, machine, mtf, edgePp } = input;

  const probUp = deskSpeed?.lanes.up.prob;
  const probDown = deskSpeed?.lanes.down.prob;
  const book = bookFavors(machine);

  const spotAbove = geo === 'ABOVE';
  const spotBelow = geo === 'BELOW';
  const modelFavorsUp = modelPUp != null && pMktUp != null && modelPUp > pMktUp + 0.005;
  const modelFavorsDown = modelPUp != null && pMktUp != null && modelPUp < pMktUp - 0.005;
  const upMom = probUp?.direction === 'UP';
  const downMom = probDown?.direction === 'UP';
  const upMomFade = probUp?.direction === 'DOWN';
  const downMomFade = probDown?.direction === 'DOWN';

  const factors: NetEntryFactor[] = [
    {
      id: 'spotGeometry',
      label: 'Spot vs PTB',
      upHit: spotAbove,
      downHit: spotBelow,
      upPoints: spotAbove ? NET_ENTRY_WEIGHTS.spotGeometry : 0,
      downPoints: spotBelow ? NET_ENTRY_WEIGHTS.spotGeometry : 0,
    },
    {
      id: 'modelVsMarket',
      label: 'Model vs market',
      upHit: modelFavorsUp,
      downHit: modelFavorsDown,
      upPoints: modelFavorsUp ? NET_ENTRY_WEIGHTS.modelVsMarket : 0,
      downPoints: modelFavorsDown ? NET_ENTRY_WEIGHTS.modelVsMarket : 0,
    },
    {
      id: 'ownMomentum',
      label: 'Own-side momentum',
      upHit: upMom,
      downHit: downMom,
      upPoints: upMom ? NET_ENTRY_WEIGHTS.ownMomentum : 0,
      downPoints: downMom ? NET_ENTRY_WEIGHTS.ownMomentum : 0,
    },
    {
      id: 'oppMomentumFade',
      label: 'Opposite side fading',
      upHit: downMomFade,
      downHit: upMomFade,
      upPoints: downMomFade ? NET_ENTRY_WEIGHTS.oppMomentumFade : 0,
      downPoints: upMomFade ? NET_ENTRY_WEIGHTS.oppMomentumFade : 0,
    },
    {
      id: 'orderBook',
      label: 'Order book flow',
      upHit: book === 'up',
      downHit: book === 'down',
      upPoints: book === 'up' ? NET_ENTRY_WEIGHTS.orderBook : 0,
      downPoints: book === 'down' ? NET_ENTRY_WEIGHTS.orderBook : 0,
    },
    {
      id: 'mtf',
      label: 'Multi-timeframe trend',
      upHit: mtf?.dominantLane === 'up' && (mtf.alignedCount >= 3 || mtf.fullAgreement),
      downHit: mtf?.dominantLane === 'down' && (mtf.alignedCount >= 3 || mtf.fullAgreement),
      upPoints: mtfPoints(mtf, 'up'),
      downPoints: mtfPoints(mtf, 'down'),
    },
    {
      id: 'edge',
      label: 'Model edge',
      upHit: edgePp != null && edgePp >= 2,
      downHit: edgePp != null && edgePp <= -2,
      upPoints: edgePoints(edgePp, 'up'),
      downPoints: edgePoints(edgePp, 'down'),
    },
  ];

  const upScore = factors.reduce((s, f) => s + f.upPoints, 0);
  const downScore = factors.reduce((s, f) => s + f.downPoints, 0);
  const netScore = upScore - downScore;

  let verdict: NetEntryVerdict = 'NO_TRADE';
  let emoji = '⚪';
  let headline = 'NO TRADE';
  let confidencePct: number | null = null;
  let confidenceLabel: NetEntryConfidenceLabel | null = null;

  if (netScore > NET_ENTRY_THRESHOLD) {
    verdict = 'ENTER_UP';
    emoji = '🟢';
    headline = `ENTER ${upLabel}`;
    const c = confidenceFromNet(netScore);
    confidencePct = c.pct;
    confidenceLabel = c.label;
  } else if (netScore < -NET_ENTRY_THRESHOLD) {
    verdict = 'ENTER_DOWN';
    emoji = '🔴';
    headline = `ENTER ${downLabel}`;
    const c = confidenceFromNet(netScore);
    confidencePct = c.pct;
    confidenceLabel = c.label;
  }

  const regimeNote =
    machine?.regime === 'trend' && machine.focusLane
      ? ` · ${machine.regime} regime`
      : machine?.regime === 'chop'
        ? ' · chop regime'
        : '';

  const summaryLine =
    verdict === 'NO_TRADE'
      ? `Net ${netScore >= 0 ? '+' : ''}${netScore} (need ±${NET_ENTRY_THRESHOLD}) · UP ${upScore} vs DOWN ${downScore}${regimeNote}`
      : `Net ${netScore >= 0 ? '+' : ''}${netScore} · UP ${upScore} vs DOWN ${downScore}${regimeNote}`;

  return {
    upScore,
    downScore,
    netScore,
    verdict,
    emoji,
    headline,
    confidencePct,
    confidenceLabel,
    factors,
    summaryLine,
  };
}
