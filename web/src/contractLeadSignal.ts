/**
 * Actionable contract entry lead — spot-led or pressure-aligned, never 30s-chase noise.
 */

import { formatCentsFrom01, formatCentsDelta, type ContractEntryJump } from './deskSpeedGainPct';
import type { PressureTiming, PressureTimingReadout } from './pressureTiming';
import {
  PRESSURE_EXTENDED_GAIN_CENTS,
  PRESSURE_CHASING_GAIN_CENTS,
} from './pressureTiming';
import type { PressureRow, PressureSideKind, PressureVerdict } from './pressureBuildupScore';

export type ContractLeadPhase = 'ENTER' | 'WATCH' | 'SKIP' | 'HIDDEN';

export type ContractLeadSignal = {
  phase: ContractLeadPhase;
  sideLabel: string;
  title: string;
  actionLine: string;
  reasonLine: string;
  nowCents: string;
  entry10sCents: string | null;
  earlyGainCents: number;
  confirmGainCents: number;
  earlyHorizonSec: number;
  confirmHorizonSec: number;
};

export type ContractLeadInput = {
  bias: 'BUY' | 'SELL' | 'NEUTRAL';
  timing: PressureTiming;
  timingReadout: PressureTimingReadout;
  earlyScore: number;
  verdict: PressureVerdict;
  leadNote: string | null;
  earlyHorizonSec: number;
  confirmHorizonSec: number;
  earlyEntryJump: ContractEntryJump | null;
  entryJump: ContractEntryJump | null;
  active: { kind: PressureSideKind; rows: PressureRow[] };
};

function spotRowHit(snap: ContractLeadInput): boolean {
  return snap.active.rows.find((r) => r.id === 'spot')?.point === 1;
}

function probRowHit(snap: ContractLeadInput): boolean {
  const id = snap.bias === 'BUY' ? 'upProb' : 'downProb';
  return snap.active.rows.find((r) => r.id === id)?.point === 1;
}

export function computeContractLeadSignal(snap: ContractLeadInput): ContractLeadSignal | null {
  const { bias, timing, earlyScore, verdict, leadNote, earlyHorizonSec, confirmHorizonSec } = snap;

  const earlyJump = snap.earlyEntryJump;
  const confirmJump = snap.entryJump;
  const earlyGain = Math.abs(earlyJump?.gainCents ?? 0);
  const confirmGain = Math.abs(confirmJump?.gainCents ?? 0);
  const sideLabel = earlyJump?.outcomeLabel ?? (bias === 'BUY' ? 'UP' : bias === 'SELL' ? 'DOWN' : '—');
  const now01 = earlyJump?.now01 ?? confirmJump?.now01;
  const nowCents = now01 != null ? formatCentsFrom01(now01) : '—';
  const entry10sCents = earlyJump ? formatCentsFrom01(earlyJump.entry01) : null;

  const base = {
    sideLabel,
    nowCents,
    entry10sCents,
    earlyGainCents: earlyGain,
    confirmGainCents: confirmGain,
    earlyHorizonSec,
    confirmHorizonSec,
  };

  if (timing === 'CHASING' || timing === 'EXTENDED') {
    if (bias === 'NEUTRAL') return null;
    const gainStr = confirmJump ? formatCentsDelta(confirmJump.gain01) : `${confirmGain.toFixed(1)}¢`;
    return {
      ...base,
      phase: 'SKIP',
      title: 'Do not chase',
      actionLine: `${sideLabel} already repriced ${gainStr} on ${confirmHorizonSec}s confirm`,
      reasonLine: snap.timingReadout.note,
    };
  }

  if (bias === 'NEUTRAL' || earlyScore < 3) {
    return null;
  }

  const spotLed = leadNote != null;
  const spotOk = spotRowHit(snap);
  const probOk = probRowHit(snap);

  if (!spotLed && earlyGain < 2 && confirmGain < 2.5 && timing !== 'BUILDING') {
    return null;
  }

  if (
    spotLed &&
    (timing === 'EARLY' || timing === 'BUILDING') &&
    earlyScore >= 3 &&
    confirmGain < PRESSURE_EXTENDED_GAIN_CENTS &&
    confirmGain < PRESSURE_CHASING_GAIN_CENTS
  ) {
    const contractNote =
      earlyGain >= 1
        ? `${formatCentsDelta(earlyJump?.gain01 ?? 0)} on ${earlyHorizonSec}s contract`
        : `contract flat on ${earlyHorizonSec}s`;
    return {
      ...base,
      phase: 'ENTER',
      title: `Enter ${sideLabel} · ${nowCents}`,
      actionLine: `Spot leading — ${contractNote} · score ${earlyScore}/5`,
      reasonLine: leadNote!,
    };
  }

  if (
    earlyScore >= 4 &&
    (timing === 'EARLY' || timing === 'BUILDING') &&
    spotOk &&
    probOk &&
    earlyGain >= 1.5 &&
    confirmGain < PRESSURE_EXTENDED_GAIN_CENTS
  ) {
    const openStr = entry10sCents ?? '—';
    return {
      ...base,
      phase: 'ENTER',
      title: `Enter ${sideLabel} · ${nowCents}`,
      actionLine: `${earlyHorizonSec}s: ${openStr} → ${nowCents} (${formatCentsDelta(earlyJump?.gain01 ?? 0)}) · ${confirmHorizonSec}s confirm only ${formatCentsDelta(confirmJump?.gain01 ?? 0)}`,
      reasonLine: `${verdict.replace('_', ' ')} — act on ${earlyHorizonSec}s lead, not ${confirmHorizonSec}s confirm.`,
    };
  }

  if (
    timing === 'BUILDING' &&
    earlyScore >= 3 &&
    (spotOk || probOk) &&
    confirmGain < PRESSURE_EXTENDED_GAIN_CENTS &&
    earlyGain >= 0.5
  ) {
    return {
      ...base,
      phase: 'ENTER',
      title: `Enter ${sideLabel} inside momentum · ${nowCents}`,
      actionLine: `${earlyHorizonSec}s +${earlyGain.toFixed(1)}¢ underway · ${confirmHorizonSec}s confirm only +${confirmGain.toFixed(1)}¢ — buy the move`,
      reasonLine: 'Momentum building — enter inside the 10s lead before 30s confirm finishes.',
    };
  }

  if (
    (timing === 'EARLY' || timing === 'BUILDING') &&
    earlyScore >= 3 &&
    probOk &&
    earlyGain >= 0.8 &&
    confirmGain < PRESSURE_EXTENDED_GAIN_CENTS
  ) {
    return {
      ...base,
      phase: 'ENTER',
      title: `Enter ${sideLabel} · ${nowCents}`,
      actionLine: `Contract momentum +${earlyGain.toFixed(1)}¢ on ${earlyHorizonSec}s · score ${earlyScore}/5`,
      reasonLine: `${verdict.replace('_', ' ')} — tape repricing inside momentum.`,
    };
  }

  if (earlyScore === 3 && timing === 'EARLY' && (spotOk || probOk)) {
    return {
      ...base,
      phase: 'WATCH',
      title: `Watch ${sideLabel}`,
      actionLine: `${earlyHorizonSec}s building (+${earlyGain.toFixed(1)}¢) · need score 4/5 to enter`,
      reasonLine: spotLed ? leadNote! : 'Layers aligning — wait for one more check.',
    };
  }

  return null;
}
