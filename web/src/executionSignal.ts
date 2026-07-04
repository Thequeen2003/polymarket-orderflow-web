/**
 * Execution Signal v2 — delay entry until edge + continuation confirm after the alert stabilizes.
 *
 * Two-stage flow:
 *   1. ALERT — base edge (model prob + edge + spot trend) fires
 *   2. ENTER  — all gates hold through the confirmation window (no spike, momentum, PTB, no chop)
 *
 * Prevents buying the prediction peak: enter on continuation, not the impulse top.
 */

import type { DeskSpeedSnapshot, SpeedAlignment } from './deskSpeedLayers';
import type { MtfConsensus } from './multiTimeframeConsensus';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { NowPriceBandDistances } from './nowPriceSignals';
import type { PressureTiming } from './pressureTiming';
import type { SpotTick } from './deskSpeedLayers';
import { spotAtOrBefore } from './deskSpeedLayers';
import {
  regimePlanToTpBand,
  resolveRegimeTpPlan,
  type RegimeTpPlan,
  type TpMarketRegime,
} from './regimeTpEngine';
import {
  buildEntryEligibility,
  computeMarketBias,
  sideCheckToLite,
  type EntryEligibility,
  type MarketBias,
} from './executionLayers';
import {
  computeBilateralEdge,
  pickLeadingSideByScore,
  pickStrongerEdgeSide,
  type BilateralEdgeSnapshot,
} from './bilateralEdge';

/** Minimum model P(Up) for UP entry (and P(Down) for DOWN). */
export const EXEC_MIN_MODEL_PROB = 0.75;
/** Minimum model − market edge in percentage points. */
export const EXEC_MIN_EDGE_PP = 20;
/** Spot must drift at least this % over the momentum window to count as follow-through. */
export const EXEC_SPOT_MOMENTUM_MIN_PCT = 0.02;
/** How long all gates must hold before ENTER (ms). */
export const EXEC_CONFIRM_HOLD_MS = 7_000;
/** Contract ¢ move on early window that counts as “impulse already happened”. */
export const EXEC_SPIKE_PROB_CENTS = 2.5;
/** Spot % move on early window that blocks chasing. */
export const EXEC_SPIKE_SPOT_PCT = 0.04;

export type ExecutionVerdict = 'ENTER_UP' | 'ENTER_DOWN' | 'WAIT' | 'NO_TRADE';
export type ExecutionPhase = 'ALERT' | 'ENTER' | 'WAIT' | 'NO_TRADE';

export type ExecutionGateId =
  | 'baseEdge'
  | 'momentum10s'
  | 'noSpike'
  | 'ptbAlignment'
  | 'noChop'
  | 'probStable'
  | 'confirmHold';

export type ExecutionGate = {
  id: ExecutionGateId;
  label: string;
  pass: boolean;
  detail: string;
};

export type DynamicTpBand = {
  minCents: number;
  maxCents: number;
  regimeLabel: string;
  regime: TpMarketRegime;
  tp1Cents: number | null;
  tp2Range: string | null;
  timeStopSec: number;
};

export type ExecutionGatesSnapshot = {
  proposedLane: 'up' | 'down' | null;
  baseAlert: boolean;
  allGatesPass: boolean;
  gates: ExecutionGate[];
  blockReasons: string[];
  dynamicTp: DynamicTpBand;
  regimePlan: RegimeTpPlan;
};

export type ExecutionSignal = ExecutionGatesSnapshot & {
  phase: ExecutionPhase;
  verdict: ExecutionVerdict;
  emoji: string;
  headline: string;
  summaryLine: string;
  confirmHeldMs: number;
  confirmRequiredMs: number;
  /** Why base edge failed — deprecated; use `entry` dual gates. */
  baseEdgeDiag?: BaseEdgeDiagnostic | null;
  /** Layer 1 — always-on directional lean. */
  bias: MarketBias;
  /** Layer 2 — both-side entry gate rows. */
  entry: EntryEligibility;
};

export type BaseEdgeSideCheck = {
  side: 'up' | 'down';
  sideLabel: string;
  probPct: number | null;
  probOk: boolean;
  edgePp: number | null;
  edgeOk: boolean;
  spotOk: boolean;
  spotNote: string;
  passCount: number;
  missNotes: string[];
};

export type BaseEdgeDiagnostic = {
  leading: BaseEdgeSideCheck;
  up: BaseEdgeSideCheck;
  down: BaseEdgeSideCheck;
  summary: string;
};

export type ExecutionSignalInput = {
  geo: NowPriceBandDistances['geo'] | null;
  modelPUp: number | null;
  pMktUp: number | null;
  pMktDown?: number | null;
  modelPDown?: number | null;
  /** Legacy UP edge override — ignored when modelPUp + pMktUp are both set. */
  edgePp?: number | null;
  deskSpeedEarly: DeskSpeedSnapshot | null;
  deskSpeedConfirm: DeskSpeedSnapshot | null;
  machine: SpotPtbMachineReadout | null;
  mtf: MtfConsensus | null;
  /** Recent UP mid delta (0..1 scale). */
  probUpDelta01?: number | null;
  /** Recent DOWN mid delta. */
  probDownDelta01?: number | null;
  spotPts?: SpotTick[];
  nowSpotUsd?: number | null;
  pressureTiming?: PressureTiming | null;
  /** Early-window contract gain in ¢ on the proposed side. */
  earlyProbGainCents?: number | null;
  upLabel?: string;
  downLabel?: string;
  /** Ms all gates have been continuously true (from confirm tracker). */
  confirmHeldMs?: number;
};

export function resolveBilateralEdges(input: ExecutionSignalInput): BilateralEdgeSnapshot {
  const computed = computeBilateralEdge({
    modelPUp: input.modelPUp,
    modelPDown: input.modelPDown,
    pMktUp: input.pMktUp,
    pMktDown: input.pMktDown,
  });
  if (computed.edgeUpPp != null) return computed;
  if (input.edgePp != null && Number.isFinite(input.edgePp)) {
    return { ...computed, edgeUpPp: input.edgePp, edgeDownPp: computed.edgeDownPp };
  }
  return computed;
}

function buildSideChecks(input: ExecutionSignalInput): {
  edges: BilateralEdgeSnapshot;
  up: BaseEdgeSideCheck;
  down: BaseEdgeSideCheck;
} {
  const upLabel = input.upLabel ?? 'UP';
  const downLabel = input.downLabel ?? 'DOWN';
  const edges = resolveBilateralEdges(input);
  const up = buildSideCheck(
    'up',
    upLabel,
    edges.modelPUp,
    edges.edgeUpPp,
    input.geo,
    input.deskSpeedEarly,
  );
  const down = buildSideCheck(
    'down',
    downLabel,
    edges.modelPDown,
    edges.edgeDownPp,
    input.geo,
    input.deskSpeedEarly,
  );
  return { edges, up, down };
}

function laneSpeedAlignment(
  deskSpeed: DeskSpeedSnapshot | null,
  lane: 'up' | 'down',
): SpeedAlignment | null {
  return deskSpeed?.lanes[lane]?.alignment ?? null;
}

/** @deprecated use resolveRegimeTpPlan — kept for tradeLevels backward compat */
export function suggestDynamicTpBand(
  alignment: SpeedAlignment | null | undefined,
  machineRegime: SpotPtbMachineReadout['regime'] | null | undefined,
): DynamicTpBand {
  const plan = resolveRegimeTpPlan({ speedAlignment: alignment, machineRegime: machineRegime ?? null });
  return regimePlanToTpBand(plan);
}

function spotPctChangeOverWindow(spotPts: SpotTick[], nowMs: number, nowSpot: number, windowSec: number): number | null {
  if (!Number.isFinite(nowSpot) || nowSpot <= 0) return null;
  const past = spotAtOrBefore(spotPts, nowMs - windowSec * 1000);
  if (past == null) return null;
  return ((nowSpot - past) / nowSpot) * 100;
}

function spotTicksFlatOrReversing(spotPts: SpotTick[], lane: 'up' | 'down', count = 3): boolean {
  if (spotPts.length < count + 1) return false;
  const tail = spotPts.slice(-count - 1);
  const deltas = tail.slice(1).map((p, i) => p.v - tail[i]!.v);
  if (lane === 'up') {
    const downTicks = deltas.filter((d) => d < -0.001).length;
    return downTicks >= 2;
  }
  const upTicks = deltas.filter((d) => d > 0.001).length;
  return upTicks >= 2;
}

function ptbRejecting(lane: 'up' | 'down', geo: NowPriceBandDistances['geo'] | null, deskSpeed: DeskSpeedSnapshot | null): boolean {
  if (lane === 'up') {
    if (geo === 'BELOW') return true;
    const gap = deskSpeed?.ptbGap;
    if (geo === 'ABOVE' && gap?.ptbGapMotion === 'TOWARD_PTB' && gap.direction === 'DOWN') return true;
    if (deskSpeed?.spot?.direction === 'DOWN') return true;
    return false;
  }
  if (geo === 'ABOVE') return true;
  const gap = deskSpeed?.ptbGap;
  if (geo === 'BELOW' && gap?.ptbGapMotion === 'TOWARD_PTB' && gap.direction === 'UP') return true;
  if (deskSpeed?.spot?.direction === 'UP') return true;
  return false;
}

function spikeBlocked(
  lane: 'up' | 'down',
  deskSpeedEarly: DeskSpeedSnapshot | null,
  spotPts: SpotTick[],
  nowSpotUsd: number | null | undefined,
  nowMs: number,
  earlyProbGainCents: number | null | undefined,
  pressureTiming: PressureTiming | null | undefined,
): { blocked: boolean; detail: string } {
  if (pressureTiming === 'CHASING' || pressureTiming === 'EXTENDED') {
    return { blocked: true, detail: `Pressure ${pressureTiming.toLowerCase()} — impulse already priced in` };
  }

  const gain = earlyProbGainCents ?? 0;
  if (Math.abs(gain) >= EXEC_SPIKE_PROB_CENTS) {
    return {
      blocked: true,
      detail: `Contract +${Math.abs(gain).toFixed(1)}¢ on 10s — wait for pullback, don't chase`,
    };
  }

  if (nowSpotUsd != null && spotPts.length >= 2) {
    const pct = spotPctChangeOverWindow(spotPts, nowMs, nowSpotUsd, 10);
    if (pct != null) {
      const aligned = lane === 'up' ? pct : -pct;
      if (aligned >= EXEC_SPIKE_SPOT_PCT) {
        return {
          blocked: true,
          detail: `Spot +${Math.abs(pct).toFixed(3)}% in 10s — spike exhaustion zone`,
        };
      }
    }
  }

  const prob = lane === 'up' ? deskSpeedEarly?.lanes.up.prob : deskSpeedEarly?.lanes.down.prob;
  if (prob && Math.abs(prob.delta30) * 100 >= 6) {
    return { blocked: true, detail: `Prob +${(Math.abs(prob.delta30) * 100).toFixed(0)}pp on 10s — late for fresh entry` };
  }

  return { blocked: false, detail: 'No recent impulse spike' };
}

export function evaluateSideMomentum(
  lane: 'up' | 'down',
  input: ExecutionSignalInput,
  nowMs = Date.now(),
): { pass: boolean; detail: string } {
  return momentumConfirmed(
    lane,
    input.deskSpeedEarly,
    input.spotPts ?? [],
    input.nowSpotUsd,
    nowMs,
  );
}

function momentumConfirmed(
  lane: 'up' | 'down',
  deskSpeedEarly: DeskSpeedSnapshot | null,
  spotPts: SpotTick[],
  nowSpotUsd: number | null | undefined,
  nowMs: number,
): { pass: boolean; detail: string } {
  const spot = deskSpeedEarly?.spot;
  const prob = lane === 'up' ? deskSpeedEarly?.lanes.up.prob : deskSpeedEarly?.lanes.down.prob;

  let spotOk = false;
  if (nowSpotUsd != null && spotPts.length >= 2) {
    const pct = spotPctChangeOverWindow(spotPts, nowMs, nowSpotUsd, 10);
    if (pct != null) {
      const aligned = lane === 'up' ? pct : -pct;
      spotOk = aligned >= EXEC_SPOT_MOMENTUM_MIN_PCT;
    }
  }
  if (!spotOk && spot) {
    const dirOk = lane === 'up' ? spot.direction === 'UP' : spot.direction === 'DOWN';
    spotOk = dirOk && Math.abs(spot.velocityPerSec) > 0.0001;
  }

  const probOk = prob ? (lane === 'up' ? prob.direction === 'UP' : prob.direction === 'DOWN') : false;
  const flatReverse = spotTicksFlatOrReversing(spotPts, lane);

  if (flatReverse) {
    return { pass: false, detail: 'Spot flattening / reversal ticks on last window' };
  }
  if (spotOk || probOk) {
    const pctStr =
      nowSpotUsd != null && spotPts.length >= 2
        ? (() => {
            const p = spotPctChangeOverWindow(spotPts, nowMs, nowSpotUsd, 10);
            return p != null ? `${p >= 0 ? '+' : ''}${p.toFixed(3)}% / 10s` : 'rising';
          })()
        : spot?.direction ?? 'aligned';
    return { pass: true, detail: `Follow-through ${pctStr}` };
  }
  return { pass: false, detail: 'Need +0.02% spot drift or rising 10s momentum' };
}

function probStable(lane: 'up' | 'down', probUpDelta01: number | null | undefined, probDownDelta01: number | null | undefined): { pass: boolean; detail: string } {
  const delta = lane === 'up' ? probUpDelta01 : probDownDelta01;
  if (delta == null || !Number.isFinite(delta)) return { pass: true, detail: 'Prob stable (no tick delta)' };
  if (delta < -0.005) return { pass: false, detail: `Implied mid fading (${(delta * 100).toFixed(1)}¢)` };
  return { pass: true, detail: delta >= 0.002 ? `Implied mid rising (+${(delta * 100).toFixed(1)}¢)` : 'Implied mid holding' };
}

function spotStateNote(
  lane: 'up' | 'down',
  geo: NowPriceBandDistances['geo'] | null,
  deskSpeed: DeskSpeedSnapshot | null,
): { ok: boolean; note: string } {
  const dir = deskSpeed?.spot?.direction ?? 'FLAT';
  if (lane === 'up') {
    if (geo === 'BELOW') return { ok: false, note: 'Spot below PTB — rejecting UP' };
    if (dir === 'DOWN') return { ok: false, note: 'Spot drifting down' };
    if (dir === 'FLAT') return { ok: true, note: 'Spot flat — not moving yet (need 10s drift)' };
    return { ok: true, note: 'Spot drifting up' };
  }
  if (geo === 'ABOVE') return { ok: false, note: 'Spot above PTB — rejecting DOWN' };
  if (dir === 'UP') return { ok: false, note: 'Spot drifting up' };
  if (dir === 'FLAT') return { ok: true, note: 'Spot flat — not moving yet (need 10s drift)' };
  return { ok: true, note: 'Spot drifting down' };
}

function buildSideCheck(
  side: 'up' | 'down',
  sideLabel: string,
  modelP: number | null,
  edgeSidePp: number | null,
  geo: NowPriceBandDistances['geo'] | null,
  deskSpeed: DeskSpeedSnapshot | null,
): BaseEdgeSideCheck {
  const probOk = modelP != null && modelP >= EXEC_MIN_MODEL_PROB;
  const edgeOk = edgeSidePp != null && edgeSidePp >= EXEC_MIN_EDGE_PP;
  const spot = spotStateNote(side, geo, deskSpeed);
  const missNotes: string[] = [];
  if (!probOk) {
    missNotes.push(
      modelP != null
        ? `P ${(modelP * 100).toFixed(0)}% < ${EXEC_MIN_MODEL_PROB * 100}%`
        : 'Model prob unavailable',
    );
  }
  if (!edgeOk) {
    missNotes.push(
      edgeSidePp != null
        ? `Edge +${edgeSidePp.toFixed(0)}pp < +${EXEC_MIN_EDGE_PP}pp`
        : 'Edge unavailable',
    );
  }
  if (!spot.ok) missNotes.push(spot.note);

  return {
    side,
    sideLabel,
    probPct: modelP != null ? modelP * 100 : null,
    probOk,
    edgePp: edgeSidePp,
    edgeOk,
    spotOk: spot.ok,
    spotNote: spot.note,
    passCount: (probOk ? 1 : 0) + (edgeOk ? 1 : 0) + (spot.ok ? 1 : 0),
    missNotes,
  };
}

/** Explain which base-edge checks fail for UP vs DOWN. */
export function diagnoseBaseEdge(input: ExecutionSignalInput): BaseEdgeDiagnostic {
  const { up, down } = buildSideChecks(input);
  const leading = pickLeadingSideByScore(up, down);

  const summary =
    leading.passCount === 3
      ? `${leading.sideLabel} base edge ready`
      : leading.passCount === 0
        ? `No edge — ${leading.missNotes.slice(0, 2).join(' · ')}`
        : `${leading.sideLabel} building (${leading.passCount}/3) — ${leading.missNotes.join(' · ')}`;

  return { leading, up, down, summary };
}

function baseEdgeLane(input: ExecutionSignalInput): 'up' | 'down' | null {
  const { up, down } = buildSideChecks(input);
  const upReady = up.passCount === 3;
  const downReady = down.passCount === 3;
  if (upReady && downReady) {
    return pickStrongerEdgeSide(up.edgePp, down.edgePp) ?? 'up';
  }
  if (upReady) return 'up';
  if (downReady) return 'down';
  return null;
}

/**
 * Evaluate all execution gates (pure — no confirmation timer).
 */
export function evaluateExecutionGates(input: ExecutionSignalInput, nowMs = Date.now()): ExecutionGatesSnapshot {
  const upLabel = input.upLabel ?? 'UP';
  const downLabel = input.downLabel ?? 'DOWN';
  const lane = baseEdgeLane(input);
  const baseDiag = diagnoseBaseEdge(input);

  const alignment =
    lane != null
      ? laneSpeedAlignment(input.deskSpeedEarly, lane) ??
        laneSpeedAlignment(input.deskSpeedConfirm, lane)
      : null;
  const regimePlan = resolveRegimeTpPlan({
    geo: input.geo,
    lane: lane ?? undefined,
    deskSpeed: input.deskSpeedEarly ?? input.deskSpeedConfirm,
    machineRegime: input.machine?.regime ?? null,
    speedAlignment: alignment,
    speedMode:
      lane != null
        ? input.deskSpeedEarly?.lanes[lane]?.mode ?? input.deskSpeedConfirm?.lanes[lane]?.mode ?? null
        : null,
    pressureTiming: input.pressureTiming ?? null,
  });
  const dynamicTp = regimePlanToTpBand(regimePlan);

  const gates: ExecutionGate[] = [];
  const blockReasons: string[] = [];

  const basePass = lane != null;
  gates.push({
    id: 'baseEdge',
    label: 'Base edge',
    pass: basePass,
    detail: basePass
      ? `${lane === 'up' ? upLabel : downLabel} P≥${EXEC_MIN_MODEL_PROB * 100}% · edge≥+${EXEC_MIN_EDGE_PP}pp`
      : baseDiag.leading.missNotes.length
        ? baseDiag.leading.missNotes.join(' · ')
        : `Need P≥${EXEC_MIN_MODEL_PROB * 100}% and edge≥±${EXEC_MIN_EDGE_PP}pp`,
  });
  if (!basePass) blockReasons.push(baseDiag.summary);

  if (!lane) {
    return {
      proposedLane: null,
      baseAlert: false,
      allGatesPass: false,
      gates,
      blockReasons,
      dynamicTp: regimePlanToTpBand(resolveRegimeTpPlan({ geo: input.geo, machineRegime: input.machine?.regime ?? null })),
      regimePlan: resolveRegimeTpPlan({ geo: input.geo, machineRegime: input.machine?.regime ?? null }),
    };
  }

  const mom = momentumConfirmed(lane, input.deskSpeedEarly, input.spotPts ?? [], input.nowSpotUsd, nowMs);
  gates.push({ id: 'momentum10s', label: '10s momentum', pass: mom.pass, detail: mom.detail });
  if (!mom.pass) blockReasons.push(mom.detail);

  const spike = spikeBlocked(
    lane,
    input.deskSpeedEarly,
    input.spotPts ?? [],
    input.nowSpotUsd,
    nowMs,
    input.earlyProbGainCents,
    input.pressureTiming ?? null,
  );
  gates.push({ id: 'noSpike', label: 'No spike chase', pass: !spike.blocked, detail: spike.detail });
  if (spike.blocked) blockReasons.push(spike.detail);

  const ptbOk = !ptbRejecting(lane, input.geo, input.deskSpeedEarly ?? input.deskSpeedConfirm);
  gates.push({
    id: 'ptbAlignment',
    label: 'PTB alignment',
    pass: ptbOk,
    detail: ptbOk
      ? lane === 'up'
        ? 'Spot above or holding PTB — not rejecting'
        : 'Spot below or holding PTB — not rejecting'
      : 'PTB rejecting the move',
  });
  if (!ptbOk) blockReasons.push('PTB rejecting move');

  const chop =
    input.machine?.regime === 'chop' ||
    alignment === 'CHOP' ||
    (input.mtf?.hasConflict && (input.mtf.alignedCount ?? 0) < 2);
  gates.push({
    id: 'noChop',
    label: 'No chop',
    pass: !chop,
    detail: chop ? 'CHOP / conflicting MTF — stand down' : 'Regime clear enough to execute',
  });
  if (chop) blockReasons.push('Chop or MTF conflict');

  const prob = probStable(lane, input.probUpDelta01, input.probDownDelta01);
  gates.push({ id: 'probStable', label: 'Prob stable', pass: prob.pass, detail: prob.detail });
  if (!prob.pass) blockReasons.push(prob.detail);

  const allGatesPass = gates.every((g) => g.pass);

  return {
    proposedLane: lane,
    baseAlert: basePass,
    allGatesPass,
    gates,
    blockReasons,
    dynamicTp,
    regimePlan,
  };
}

/**
 * Combine gate evaluation + confirmation hold → final execution signal.
 */
export function computeExecutionSignal(
  input: ExecutionSignalInput,
  nowMs = Date.now(),
): ExecutionSignal {
  const upLabel = input.upLabel ?? 'UP';
  const downLabel = input.downLabel ?? 'DOWN';
  const confirmHeldMs = Math.max(0, input.confirmHeldMs ?? 0);
  const confirmRequiredMs = EXEC_CONFIRM_HOLD_MS;

  const snap = evaluateExecutionGates(input, nowMs);
  const { proposedLane, baseAlert, allGatesPass, gates, blockReasons } = snap;
  const baseEdgeDiag = baseAlert ? null : diagnoseBaseEdge(input);

  const confirmPass = allGatesPass && confirmHeldMs >= confirmRequiredMs;
  const gatesWithConfirm: ExecutionGate[] = baseAlert
    ? [
        ...gates,
        {
          id: 'confirmHold',
          label: 'Confirmation hold',
          pass: confirmPass,
          detail: confirmPass
            ? `Held ${Math.round(confirmHeldMs / 1000)}s — continuation confirmed`
            : allGatesPass
              ? `Building… ${Math.round(confirmHeldMs / 1000)}s / ${Math.round(confirmRequiredMs / 1000)}s`
              : 'Waiting for remaining gates',
        },
      ]
    : gates;

  let phase: ExecutionPhase = 'WAIT';
  let verdict: ExecutionVerdict = 'WAIT';
  let emoji = '🔵';
  let headline = 'WAIT';

  if (!baseAlert) {
    const inBandSkip =
      input.geo === 'IN_BAND' &&
      (baseEdgeDiag?.leading.passCount ?? 0) <= 1 &&
      (baseEdgeDiag?.leading.spotNote.includes('not moving') ||
        baseEdgeDiag?.leading.missNotes.some((m) => m.includes('Edge')));
    phase = blockReasons.some((r) => r.includes('Chop')) || inBandSkip ? 'NO_TRADE' : 'WAIT';
    verdict = phase === 'NO_TRADE' ? 'NO_TRADE' : 'WAIT';
    emoji = phase === 'NO_TRADE' ? '⚪' : '🔵';
    headline =
      phase === 'NO_TRADE'
        ? inBandSkip
          ? 'NO TRADE — in band, flat'
          : 'NO TRADE'
        : 'WAIT';
  } else if (confirmPass && proposedLane) {
    phase = 'ENTER';
    verdict = proposedLane === 'up' ? 'ENTER_UP' : 'ENTER_DOWN';
    emoji = proposedLane === 'up' ? '🟢' : '🔴';
    headline = `ENTER ${proposedLane === 'up' ? upLabel : downLabel}`;
  } else {
    phase = 'ALERT';
    verdict = 'WAIT';
    emoji = '🟡';
    headline = `ALERT ${proposedLane === 'up' ? upLabel : downLabel} — confirm continuation`;
  }

  const bias = computeMarketBias({
    modelPUp: input.modelPUp,
    pMktUp: input.pMktUp,
    pMktDown: input.pMktDown,
    modelPDown: input.modelPDown,
    spotDirection: input.deskSpeedEarly?.spot?.direction ?? null,
    upLabel: input.upLabel,
    downLabel: input.downLabel,
  });
  const edgeDiag = diagnoseBaseEdge(input);
  const entry = buildEntryEligibility({
    up: sideCheckToLite(edgeDiag.up),
    down: sideCheckToLite(edgeDiag.down),
    momUp: evaluateSideMomentum('up', input, nowMs),
    momDown: evaluateSideMomentum('down', input, nowMs),
    phase,
  });

  const tpStr =
    snap.regimePlan.tp1Cents != null
      ? `TP1 +${snap.regimePlan.tp1Cents.toFixed(1)}¢ · TP2 ${snap.dynamicTp.tp2Range ?? '—'}`
      : `${snap.dynamicTp.minCents.toFixed(1)}–${snap.dynamicTp.maxCents.toFixed(1)}¢`;
  const summaryLine =
    phase === 'ENTER'
      ? `Continuation confirmed · ${tpStr} (${snap.dynamicTp.regimeLabel}) · time stop ${snap.dynamicTp.timeStopSec}s`
      : phase === 'ALERT'
        ? `Edge live — hold gates ${Math.round(confirmRequiredMs / 1000)}s before enter`
        : entry.footer;

  return {
    ...snap,
    gates: gatesWithConfirm,
    phase,
    verdict,
    emoji,
    headline,
    summaryLine,
    confirmHeldMs,
    confirmRequiredMs,
    baseEdgeDiag: baseAlert ? null : edgeDiag,
    bias,
    entry,
  };
}
