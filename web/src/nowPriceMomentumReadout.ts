/**
 * Momentum-first readout for Now Price Signals — catch the move on 10s tape,
 * with settlement bias / machine / advisory as confirmation chips (not the headline).
 */

import type { ContractLeadSignal } from './contractLeadSignal';
import type { PressureBuildupSnapshot } from './pressureBuildupScore';
import type { PressureTiming } from './pressureTiming';
import type { BuySideAdvisory } from './shouldBuyWhichSide';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';

export type MomentumPhase = 'early' | 'building' | 'live' | 'extended' | 'chasing' | 'flat';

export type MomentumConfirmation = {
  label: string;
  ok: boolean;
};

export type NowPriceMomentumReadout = {
  phase: MomentumPhase;
  lane: 'up' | 'down' | null;
  laneLabel: string | null;
  headline: string;
  tapeLine: string;
  actionHint: string;
  earlyScore: number;
  confirmScore: number;
  timing: PressureTiming | null;
  contractDeltaCents: number | null;
  confirmations: MomentumConfirmation[];
  biasAligned: boolean;
  canCatch: boolean;
  emoji: string;
};

function laneLabel(lane: 'up' | 'down', upLabel: string, downLabel: string): string {
  return lane === 'up' ? upLabel : downLabel;
}

function contractLeadLane(
  lead: ContractLeadSignal,
  upLabel: string,
  downLabel: string,
): 'up' | 'down' | null {
  const label = lead.sideLabel.trim().toUpperCase();
  if (label === upLabel.toUpperCase() || label === 'UP') return 'up';
  if (label === downLabel.toUpperCase() || label === 'DOWN') return 'down';
  return null;
}

function advisoryLane(advisory: BuySideAdvisory | null): 'up' | 'down' | null {
  if (advisory?.verdict === 'BUY_UP') return 'up';
  if (advisory?.verdict === 'BUY_DOWN') return 'down';
  return null;
}

function biasLane(modelPUp: number | null): 'up' | 'down' | null {
  if (modelPUp == null || !Number.isFinite(modelPUp)) return null;
  if (modelPUp >= 0.52) return 'up';
  if (modelPUp <= 0.48) return 'down';
  return null;
}

function tapeLane(
  probDeltaUp01: number | null,
  probDeltaDown01: number | null,
): { lane: 'up' | 'down' | null; deltaCents: number | null } {
  const up = probDeltaUp01 != null && Number.isFinite(probDeltaUp01) ? probDeltaUp01 * 100 : null;
  const dn = probDeltaDown01 != null && Number.isFinite(probDeltaDown01) ? probDeltaDown01 * 100 : null;
  if (up == null && dn == null) return { lane: null, deltaCents: null };

  const noise = 0.12;
  const upRising = up != null && up >= noise;
  const dnRising = dn != null && dn >= noise;
  const upFalling = up != null && up <= -noise;
  const dnFalling = dn != null && dn <= -noise;

  // Prefer the outcome mid that is actually being bid up.
  if (upRising && !dnRising) return { lane: 'up', deltaCents: up };
  if (dnRising && !upRising) return { lane: 'down', deltaCents: dn };
  if (upRising && dnRising) {
    return up! >= dn! ? { lane: 'up', deltaCents: up } : { lane: 'down', deltaCents: dn };
  }

  // Complement falling → other side implied (require meaningful move on both).
  if (upFalling && dnRising) return { lane: 'down', deltaCents: dn };
  if (dnFalling && upRising) return { lane: 'up', deltaCents: up };

  // UP falling alone with flat DOWN is often spread noise — don't infer DOWN chase.
  return { lane: null, deltaCents: null };
}

function phaseFromTiming(timing: PressureTiming | null, earlyScore: number): MomentumPhase {
  if (timing === 'EARLY') return 'early';
  if (timing === 'BUILDING') return 'building';
  if (timing === 'CHASING') return 'chasing';
  if (timing === 'EXTENDED') return 'extended';
  if (earlyScore >= 3) return 'live';
  return 'flat';
}

function fmtDeltaCents(c: number | null): string {
  if (c == null || !Number.isFinite(c)) return '—';
  if (Math.abs(c) < 0.08) return 'flat';
  return `${c >= 0 ? '+' : ''}${Math.abs(c) >= 10 ? c.toFixed(1) : c.toFixed(2)}¢`;
}

export function buildNowPriceMomentumReadout(args: {
  pressure: PressureBuildupSnapshot | null;
  pressureTiming: PressureTiming | null;
  advisory: BuySideAdvisory | null;
  contractLead: ContractLeadSignal | null;
  binaryBiasPUp: number | null;
  machineReadout: SpotPtbMachineReadout | null;
  probDeltaUp01: number | null;
  probDeltaDown01: number | null;
  upLabel: string;
  downLabel: string;
}): NowPriceMomentumReadout | null {
  const {
    pressure,
    pressureTiming,
    advisory,
    contractLead,
    binaryBiasPUp,
    machineReadout,
    probDeltaUp01,
    probDeltaDown01,
    upLabel,
    downLabel,
  } = args;

  const earlyScore = pressure?.earlyScore ?? 0;
  const confirmScore = pressure?.confirmScore ?? 0;
  const timing = pressureTiming ?? pressure?.timing ?? null;
  const phase = phaseFromTiming(timing, earlyScore);

  const tape = tapeLane(probDeltaUp01, probDeltaDown01);
  const pressureLane =
    pressure?.bias === 'BUY' ? 'up' : pressure?.bias === 'SELL' ? 'down' : null;
  const leadLane = contractLead ? contractLeadLane(contractLead, upLabel, downLabel) : null;
  const advLane = advisoryLane(advisory);
  const settleLane = biasLane(binaryBiasPUp);

  // Momentum lane comes from contract tape / lead / desk — not spot geometry alone.
  let lane: 'up' | 'down' | null = leadLane ?? tape.lane ?? advLane;
  if (lane == null) return null;

  const pressureTapeSplit =
    tape.lane != null && pressureLane != null && tape.lane !== pressureLane && leadLane == null;

  const contractDeltaCents =
    lane === 'up'
      ? (probDeltaUp01 != null ? probDeltaUp01 * 100 : tape.deltaCents)
      : lane === 'down'
        ? (probDeltaDown01 != null ? probDeltaDown01 * 100 : tape.deltaCents)
        : tape.deltaCents;

  const label = lane != null ? laneLabel(lane, upLabel, downLabel) : null;
  const biasAligned =
    lane != null &&
    ((settleLane === lane && advLane === lane) ||
      (settleLane === lane && advLane == null) ||
      (advLane === lane && settleLane == null));

  const machineAligned =
    lane != null &&
    machineReadout?.focusLane != null &&
    machineReadout.focusLane === lane &&
    (machineReadout.agreementScore ?? 0) >= 55;

  const confirmations: MomentumConfirmation[] = [
    {
      label: '10s pressure',
      ok: earlyScore >= 3,
    },
    {
      label: 'Contract tape',
      ok: contractDeltaCents != null && Math.abs(contractDeltaCents) >= 0.35,
    },
    {
      label: 'Settlement bias',
      ok: lane != null && settleLane === lane,
    },
    {
      label: 'Desk pick',
      ok: lane != null && advLane === lane && (advisory?.confidencePct ?? 0) >= 55,
    },
    {
      label: 'Machine',
      ok: machineAligned,
    },
    ...(pressureTapeSplit
      ? [{ label: 'Spot vs tape', ok: false } satisfies MomentumConfirmation]
      : []),
  ];

  const passCount = confirmations.filter((c) => c.ok).length;
  const canCatch =
    phase !== 'flat' &&
    phase !== 'chasing' &&
    phase !== 'extended' &&
    earlyScore >= 3 &&
    lane != null &&
    (contractLead?.phase === 'ENTER' ||
      contractLead?.phase === 'WATCH' ||
      (contractDeltaCents != null && Math.abs(contractDeltaCents) >= 0.35));

  let headline: string;
  let emoji: string;
  const arrow = lane === 'up' ? '↑' : lane === 'down' ? '↓' : '→';

  if (phase === 'chasing' || phase === 'extended') {
    headline = label ? `${arrow} ${label} extended — late, don't chase ask` : 'Move extended — wait for pullback';
    emoji = '🟠';
  } else if (phase === 'early' && label) {
    headline = `${arrow} ${label} · early 10s momentum — catch before 30s confirm`;
    emoji = lane === 'up' ? '🟢' : '🔴';
  } else if (phase === 'building' && label) {
    headline = pressureTapeSplit
      ? `${arrow} ${label} on tape · spot pressure still ${pressureLane === 'up' ? upLabel : downLabel} (${passCount}/5 confirm)`
      : biasAligned
        ? `${arrow} ${label} building · tape + bias agree (${passCount}/5)`
        : `${arrow} ${label} building · tape live, confirm bias (${passCount}/5)`;
    emoji = '⚡';
  } else if (phase === 'live' && label) {
    headline = `${arrow} ${label} pressure live · ${earlyScore}/5 on 10s window`;
    emoji = '⚡';
  } else if (label && contractDeltaCents != null && Math.abs(contractDeltaCents) >= 0.35) {
    headline = `${arrow} ${label} tape ${fmtDeltaCents(contractDeltaCents)}/30s · watch for pressure build`;
    emoji = '🔵';
  } else {
    return null;
  }

  const tapeParts: string[] = [];
  if (contractDeltaCents != null) tapeParts.push(`contract ${fmtDeltaCents(contractDeltaCents)}/30s`);
  if (pressure) tapeParts.push(`${pressure.earlyHorizonSec}s ${earlyScore}/5 vs ${confirmScore}/5 confirm`);
  if (contractLead?.phase === 'ENTER') tapeParts.push('lead ENTER');
  else if (contractLead?.phase === 'WATCH') tapeParts.push('lead building');
  const tapeLine = tapeParts.length ? tapeParts.join(' · ') : 'Quiet tape';

  let actionHint: string;
  if (phase === 'chasing' || phase === 'extended') {
    actionHint = label
      ? `Wait for 10s pressure to turn EARLY on ${label} — join on bid, not ask.`
      : 'Stand aside until pressure resets EARLY.';
  } else if (contractLead?.phase === 'ENTER' && label) {
    actionHint = `${contractLead.actionLine} Ride inside momentum — limit on bid if ask widened.`;
  } else if (canCatch && label) {
    actionHint = biasAligned
      ? `Catch ${label} on next 10s tick — bias + tape aligned; don't wait for 30s chase.`
      : `Tape pushing ${label} — arm limit on bid; need bias confirm before full size.`;
  } else if (label) {
    actionHint = `Watch ${label} for +1¢ on 10s tape before entry.`;
  } else {
    actionHint = 'Wait for directional pressure on 10s window.';
  }

  return {
    phase,
    lane,
    laneLabel: label,
    headline,
    tapeLine,
    actionHint,
    earlyScore,
    confirmScore,
    timing,
    contractDeltaCents,
    confirmations,
    biasAligned,
    canCatch,
    emoji,
  };
}
