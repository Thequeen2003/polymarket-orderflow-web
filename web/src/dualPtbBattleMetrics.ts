/**
 * Decision-first metrics for Dual PTB — battle meter, trade scores, spread, consensus.
 */

import type { PtbTargetEngineCard } from './ptbTargetEngine';
import type { PtbSystemDecision } from './ptbDecisionEngine';

export type DualPtbSpreadLabel = 'Noise' | 'Lean' | 'Strong' | 'Dominant';

export type DualPtbBattleInput = {
  lastU: number;
  lastD: number;
  upRising: boolean;
  dnRising: boolean;
  upSpeedCentsPerMin: number;
  downSpeedCentsPerMin: number;
  pathUpActive: boolean;
  pathDnActive: boolean;
  gapUpActive: boolean;
  gapDownActive: boolean;
  upReady: boolean;
  downReady: boolean;
  displayVerdict: 'ENTER' | 'SCALP' | 'WAIT';
  gateArmed: boolean;
  goNoGo: boolean;
  laneLockLane: 'up' | 'down' | null;
  laneLockConfidence: 'HIGH' | 'MED' | 'LOW';
  primaryLane: 'up' | 'down';
  edgeScore: number;
  ptbTarget: PtbTargetEngineCard;
  upLabel?: string;
  downLabel?: string;
};

export type DualPtbAgreementBadge = {
  label: string;
  ok: boolean;
  lane: 'up' | 'down' | null;
};

export type DualPtbBattleDesk = {
  upPct: number;
  downPct: number;
  strengthDiff: number;
  bias: 'up' | 'down' | 'neutral';
  confidence: 'HIGH' | 'MED' | 'LOW';
  spreadUpCents: number;
  spreadDownCents: number;
  spreadCents: number;
  spreadLabel: DualPtbSpreadLabel;
  upSpeedCentsPerMin: number;
  downSpeedCentsPerMin: number;
  upMomentumLabel: string;
  downMomentumLabel: string;
  tradeScoreUp: number;
  tradeScoreDown: number;
  minTradeScore: number;
  winningLane: 'up' | 'down' | null;
  action: 'ENTER_UP' | 'ENTER_DOWN' | 'LEAN_UP' | 'LEAN_DOWN' | 'WAIT';
  actionConfidencePct: number;
  consensusCount: number;
  consensusTotal: number;
  consensusQuality: 'HIGH' | 'LOW';
  agreementBadges: DualPtbAgreementBadge[];
  expectedMoveCents: number | null;
  targetCents: string | null;
  stopCents: string | null;
};

const MIN_TRADE_SCORE = 70;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function fmtCents(p: number): string {
  return `${(p * 100).toFixed(1)}¢`;
}

export function spreadLabelFromCents(spread: number): DualPtbSpreadLabel {
  if (spread < 3) return 'Noise';
  if (spread < 7) return 'Lean';
  if (spread < 12) return 'Strong';
  return 'Dominant';
}

function momentumLabel(speedCentsPerMin: number, rising: boolean): string {
  if (speedCentsPerMin >= 2.5 && rising) return '↗ Accelerating';
  if (speedCentsPerMin >= 0.8 && rising) return '↗ Building';
  if (speedCentsPerMin <= -2.5) return '↘ Weakening';
  if (speedCentsPerMin <= -0.8) return '↘ Fading';
  if (rising) return '→ Steady';
  return '→ Flat';
}

function laneScore(args: {
  mid: number;
  rising: boolean;
  pathActive: boolean;
  gapActive: boolean;
  ready: boolean;
  speedCentsPerMin: number;
  favored: boolean;
  edgeScore: number;
  gateArmed: boolean;
  displayVerdict: 'ENTER' | 'SCALP' | 'WAIT';
}): number {
  let s = args.mid * 42;
  if (args.rising) s += 12;
  if (args.pathActive) s += 14;
  if (args.gapActive) s += 10;
  if (args.ready) s += 16;
  s += clamp(args.speedCentsPerMin * 4, -8, 14);
  if (args.favored) s += 8;
  s += args.edgeScore * 2.2;
  if (args.displayVerdict === 'ENTER' && args.favored) s += 12;
  else if (args.displayVerdict === 'SCALP' && args.favored) s += 6;
  if (args.gateArmed && args.favored) s += 10;
  return Math.round(clamp(s, 0, 100));
}

export function computeDualPtbBattleDesk(input: DualPtbBattleInput): DualPtbBattleDesk {
  const {
    lastU,
    lastD,
    upRising,
    dnRising,
    upSpeedCentsPerMin,
    downSpeedCentsPerMin,
    pathUpActive,
    pathDnActive,
    gapUpActive,
    gapDownActive,
    upReady,
    downReady,
    displayVerdict,
    gateArmed,
    goNoGo,
    laneLockLane,
    laneLockConfidence,
    primaryLane,
    edgeScore,
    ptbTarget,
  } = input;

  const total = Math.max(0.01, lastU + lastD);
  const upPct = Math.round((lastU / total) * 100);
  const downPct = Math.round((lastD / total) * 100);
  const strengthDiff = downPct - upPct;
  const bias: 'up' | 'down' | 'neutral' =
    Math.abs(strengthDiff) < 4 ? 'neutral' : strengthDiff > 0 ? 'down' : 'up';

  const spreadUpCents = lastU * 100;
  const spreadDownCents = lastD * 100;
  const spreadCents = Math.abs(spreadUpCents - spreadDownCents);
  const spreadLabel = spreadLabelFromCents(spreadCents);

  const tradeScoreUp = laneScore({
    mid: lastU,
    rising: upRising,
    pathActive: pathUpActive,
    gapActive: gapUpActive,
    ready: upReady,
    speedCentsPerMin: upSpeedCentsPerMin,
    favored: primaryLane === 'up',
    edgeScore,
    gateArmed,
    displayVerdict,
  });
  const tradeScoreDown = laneScore({
    mid: lastD,
    rising: dnRising,
    pathActive: pathDnActive,
    gapActive: gapDownActive,
    ready: downReady,
    speedCentsPerMin: downSpeedCentsPerMin,
    favored: primaryLane === 'down',
    edgeScore,
    gateArmed,
    displayVerdict,
  });

  const winningLane: 'up' | 'down' | null =
    tradeScoreUp === tradeScoreDown
      ? bias === 'neutral'
        ? null
        : bias
      : tradeScoreUp > tradeScoreDown
        ? 'up'
        : 'down';

  const topScore = winningLane === 'up' ? tradeScoreUp : winningLane === 'down' ? tradeScoreDown : 0;

  let action: DualPtbBattleDesk['action'] = 'WAIT';
  if (winningLane === 'up') {
    action = topScore >= MIN_TRADE_SCORE && displayVerdict !== 'WAIT' ? 'ENTER_UP' : 'LEAN_UP';
  } else if (winningLane === 'down') {
    action = topScore >= MIN_TRADE_SCORE && displayVerdict !== 'WAIT' ? 'ENTER_DOWN' : 'LEAN_DOWN';
  }

  const confidence: 'HIGH' | 'MED' | 'LOW' =
    laneLockConfidence === 'HIGH' && topScore >= 78 && spreadLabel !== 'Noise'
      ? 'HIGH'
      : laneLockConfidence !== 'LOW' && topScore >= 58
        ? 'MED'
        : 'LOW';

  const actionConfidencePct = Math.round(
    clamp(topScore * 0.55 + (laneLockConfidence === 'HIGH' ? 28 : laneLockConfidence === 'MED' ? 16 : 6), 18, 96),
  );

  const anchorBias: 'up' | 'down' = lastU >= lastD ? 'up' : 'down';
  const dualLane: 'up' | 'down' = primaryLane;
  const flowLane: 'up' | 'down' = upSpeedCentsPerMin >= downSpeedCentsPerMin ? 'up' : 'down';
  const lockLane = laneLockLane;

  const agreementBadges: DualPtbAgreementBadge[] = [
    { label: 'PTB anchor lean', ok: anchorBias === winningLane, lane: anchorBias },
    { label: 'Dual PTB', ok: dualLane === winningLane, lane: dualLane },
    { label: 'Lane lock', ok: lockLane != null && lockLane === winningLane, lane: lockLane },
    { label: 'Flow / tape', ok: flowLane === winningLane, lane: flowLane },
  ];
  const consensusCount = agreementBadges.filter((b) => b.ok).length;
  const consensusTotal = agreementBadges.length;
  const consensusQuality: 'HIGH' | 'LOW' = consensusCount >= 3 && goNoGo ? 'HIGH' : 'LOW';

  const nowProb = ptbTarget.engineLane === 'up' ? lastU : lastD;
  const expectedMoveCents =
    ptbTarget.next01 != null && Number.isFinite(ptbTarget.next01)
      ? Math.round((ptbTarget.next01 - nowProb) * 1000) / 10
      : null;
  const targetCents = ptbTarget.nextTargetLabel.includes('¢') ? ptbTarget.nextTargetLabel : fmtCents(ptbTarget.next01);
  const stopCents =
    ptbTarget.wall01 != null && Number.isFinite(ptbTarget.wall01) ? fmtCents(ptbTarget.wall01) : null;

  return {
    upPct,
    downPct,
    strengthDiff,
    bias,
    confidence,
    spreadUpCents,
    spreadDownCents,
    spreadCents,
    spreadLabel,
    upSpeedCentsPerMin,
    downSpeedCentsPerMin,
    upMomentumLabel: momentumLabel(upSpeedCentsPerMin, upRising),
    downMomentumLabel: momentumLabel(downSpeedCentsPerMin, dnRising),
    tradeScoreUp,
    tradeScoreDown,
    minTradeScore: MIN_TRADE_SCORE,
    winningLane,
    action,
    actionConfidencePct,
    consensusCount,
    consensusTotal,
    consensusQuality,
    agreementBadges,
    expectedMoveCents,
    targetCents,
    stopCents,
  };
}

export function dualPtbBattleFromEngine(engine: PtbSystemDecision): Pick<DualPtbBattleInput, 'edgeScore' | 'displayVerdict'> {
  return {
    edgeScore: engine.edgeScore,
    displayVerdict: engine.verdict === 'ENTER' ? 'ENTER' : engine.verdict === 'SCALP' ? 'SCALP' : 'WAIT',
  };
}
