/**
 * Desk-level execution signal — shared by Now Price Signals and Take Signal gate.
 */

import { useEffect, useMemo, useState } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import type { SpotBandGaugeSnapshot } from './spotBandDeskAction';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import { estimateBinaryOutcomeBias } from './binaryOutcomeBias';
import { recentProbDelta01 } from './contractLag';
import {
  computeDeskSpeedSnapshot,
  type DeskSpeedSnapshot,
} from './deskSpeedLayers';
import { computeContractEntryJump } from './deskSpeedGainPct';
import { buildMtfConsensus } from './multiTimeframeConsensus';
import { buildNowPriceBandDistances } from './nowPriceSignals';
import {
  computePressureBuildup,
  PRESSURE_CONFIRM_HORIZON_SEC,
  PRESSURE_EARLY_HORIZON_SEC,
} from './pressureBuildupScore';
import { computeBilateralEdge, pickEdgeLaneHint, pickStrongerEdgeSide } from './bilateralEdge';
import {
  computeExecutionSignal,
  type ExecutionPhase,
  type ExecutionSignal,
  type ExecutionSignalInput,
} from './executionSignal';
import { updateExecutionConfirm, type ExecutionConfirmState } from './executionConfirmTracker';

function normalizeBinaryFlexible(
  up01: number | null,
  down01: number | null,
): { up: number | null; down: number | null } {
  const uOk = up01 != null && Number.isFinite(up01);
  const dOk = down01 != null && Number.isFinite(down01);
  if (!uOk && !dOk) return { up: null, down: null };
  if (uOk && !dOk) {
    const u = Math.max(0, Math.min(1, up01!));
    return { up: u, down: 1 - u };
  }
  if (!uOk && dOk) {
    const d = Math.max(0, Math.min(1, down01!));
    return { up: 1 - d, down: d };
  }
  const s = up01! + down01!;
  if (!Number.isFinite(s) || s <= 1e-9) return { up: null, down: null };
  const u = Math.max(0, Math.min(1, up01! / s));
  return { up: u, down: 1 - u };
}

export type DeskExecutionSignalArgs = {
  spot: SpotPoint[];
  priceToBeat: number | null;
  probUp: SpotPoint[];
  probDown: SpotPoint[];
  machine: SpotPtbMachineReadout | null;
  upLabel: string;
  downLabel: string;
  bandGauge?: SpotBandGaugeSnapshot | null;
  ptbContext?: { bandUsd?: number | null; slopeUsdPerSec?: number | null } | null;
  enabled?: boolean;
};

/** Build execution input from desk feeds (no React). */
export function buildExecutionInputFromDesk(args: DeskExecutionSignalArgs): ExecutionSignalInput | null {
  const spotLast = args.spot.length ? args.spot[args.spot.length - 1]!.v : null;
  const lastProbUp = args.probUp.length ? (args.probUp[args.probUp.length - 1]!.v ?? null) : null;
  const lastProbDown = args.probDown.length ? (args.probDown[args.probDown.length - 1]!.v ?? null) : null;

  const bandUsd =
    args.bandGauge != null
      ? (args.bandGauge.bandHi - args.bandGauge.bandLo) / 2
      : args.ptbContext?.bandUsd ?? null;

  if (spotLast == null || args.priceToBeat == null || bandUsd == null) return null;

  const bandDistances = buildNowPriceBandDistances({ now: spotLast, ptb: args.priceToBeat, bandUsd });
  if (!bandDistances) return null;

  const slopeUsdPerMin =
    args.bandGauge?.slopeUsdPerMin != null && Number.isFinite(args.bandGauge.slopeUsdPerMin)
      ? args.bandGauge.slopeUsdPerMin
      : null;
  const slopeUsdPerSec =
    args.ptbContext?.slopeUsdPerSec ??
    (slopeUsdPerMin != null && Number.isFinite(slopeUsdPerMin) ? slopeUsdPerMin / 60 : 0);

  const normLive = normalizeBinaryFlexible(lastProbUp, lastProbDown);
  const pMktUp = normLive.up ?? lastProbUp;
  const pMktDown = normLive.down ?? lastProbDown;

  const probTicksUp = args.probUp
    .filter((p) => p.v != null && Number.isFinite(p.v))
    .map((p) => ({ t: p.t, v: p.v! }));
  const probTicksDown = args.probDown
    .filter((p) => p.v != null && Number.isFinite(p.v))
    .map((p) => ({ t: p.t, v: p.v! }));
  const recentDeltaUp01 = recentProbDelta01(probTicksUp, 30_000);
  const recentDeltaDown01 = recentProbDelta01(probTicksDown, 30_000);

  const binaryBias = estimateBinaryOutcomeBias({
    now: spotLast,
    ptb: args.priceToBeat,
    spotPts: args.spot,
    pUp01: normLive.up ?? lastProbUp,
    slopeUsdPerSec,
    bandUsd,
    horizonSec: 30,
  });

  const modelPUp = binaryBias?.probUp ?? null;

  const deskSpeedConfirm: DeskSpeedSnapshot | null = computeDeskSpeedSnapshot({
    spotPts: args.spot,
    nowSpot: spotLast,
    ptb: args.priceToBeat,
    probUpPts: args.probUp.map((p) => ({ t: p.t, v: p.v ?? null })),
    probDownPts: args.probDown.map((p) => ({ t: p.t, v: p.v ?? null })),
    pMktUp,
    pMktDown,
    upLabel: args.upLabel,
    downLabel: args.downLabel,
    horizonSec: PRESSURE_CONFIRM_HORIZON_SEC,
  });

  const deskSpeedEarly: DeskSpeedSnapshot | null = computeDeskSpeedSnapshot({
    spotPts: args.spot,
    nowSpot: spotLast,
    ptb: args.priceToBeat,
    probUpPts: args.probUp.map((p) => ({ t: p.t, v: p.v ?? null })),
    probDownPts: args.probDown.map((p) => ({ t: p.t, v: p.v ?? null })),
    pMktUp,
    pMktDown,
    upLabel: args.upLabel,
    downLabel: args.downLabel,
    horizonSec: PRESSURE_EARLY_HORIZON_SEC,
  });

  const mtfConsensus = args.spot.length >= 4 ? buildMtfConsensus(args.spot, bandUsd) : null;

  const pressureBuildup =
    deskSpeedEarly && deskSpeedConfirm
      ? computePressureBuildup(deskSpeedEarly, deskSpeedConfirm, {
          mtf: mtfConsensus,
          upLabel: args.upLabel,
          downLabel: args.downLabel,
          nowSpot: spotLast,
          pMktUp,
          pMktDown,
        })
      : null;

  const bilateral = computeBilateralEdge({ modelPUp, pMktUp, pMktDown });
  const earlyJumpUp = deskSpeedEarly
    ? computeContractEntryJump({
        prob: deskSpeedEarly.lanes.up.prob,
        now01: pMktUp,
        horizonSec: PRESSURE_EARLY_HORIZON_SEC,
        outcomeLabel: args.upLabel,
      })
    : null;
  const earlyJumpDown = deskSpeedEarly
    ? computeContractEntryJump({
        prob: deskSpeedEarly.lanes.down.prob,
        now01: pMktDown,
        horizonSec: PRESSURE_EARLY_HORIZON_SEC,
        outcomeLabel: args.downLabel,
      })
    : null;
  const laneHint = pickEdgeLaneHint(bilateral.edgeUpPp, bilateral.edgeDownPp, 20);
  const strongerSide = pickStrongerEdgeSide(bilateral.edgeUpPp, bilateral.edgeDownPp);
  const earlyGain =
    laneHint === 'down' || (laneHint == null && strongerSide === 'down')
      ? earlyJumpDown?.gainCents ?? null
      : earlyJumpUp?.gainCents ?? null;

  return {
    geo: bandDistances.geo,
    modelPUp,
    pMktUp,
    pMktDown,
    edgePp: bilateral.edgeUpPp,
    deskSpeedEarly,
    deskSpeedConfirm,
    machine: args.machine,
    mtf: mtfConsensus,
    probUpDelta01: recentDeltaUp01,
    probDownDelta01: recentDeltaDown01,
    spotPts: args.spot.map((p) => ({ t: p.t, v: p.v })),
    nowSpotUsd: spotLast,
    earlyProbGainCents: earlyGain,
    pressureTiming: pressureBuildup?.timing ?? null,
    upLabel: args.upLabel,
    downLabel: args.downLabel,
  };
}

/** Lane when execution desk is in ENTER (or proposed lane while confirming). */
export function executionEnterLane(signal: ExecutionSignal | null | undefined): 'up' | 'down' | null {
  if (!signal) return null;
  if (signal.verdict === 'ENTER_UP') return 'up';
  if (signal.verdict === 'ENTER_DOWN') return 'down';
  return signal.proposedLane;
}

/** Human-readable block reason when take must wait on execution desk. */
export function executionTakeBlockReason(signal: ExecutionSignal | null | undefined): string | null {
  if (!signal) return 'Execution desk loading — wait for PTB + spot ticks.';
  if (signal.phase === 'ENTER') return null;
  if (signal.phase === 'ALERT') {
    const remainSec = Math.max(0, Math.ceil((signal.confirmRequiredMs - signal.confirmHeldMs) / 1000));
    const hold =
      remainSec > 0
        ? `${remainSec}s confirmation hold remaining`
        : 'confirmation hold building';
    return `Execution desk ALERT — ${hold} (${signal.headline}).`;
  }
  const detail = signal.summaryLine?.trim() || signal.headline?.trim();
  return detail
    ? `Execution desk ${signal.phase} — ${detail}`
    : `Execution desk ${signal.phase} — not ready to take.`;
}

export function executionTakeButtonSuffix(phase: ExecutionPhase | null | undefined): string {
  if (phase === 'ALERT') return ' — ALERT';
  if (phase === 'WAIT') return ' — WAIT';
  if (phase === 'NO_TRADE') return ' — skip';
  return '';
}

/** Stable key for take-signal deps — avoids re-planning on every ExecutionSignal object identity. */
export function executionTakeMeaningKey(signal: ExecutionSignal | null | undefined): string {
  if (!signal) return 'none';
  return [
    signal.phase,
    signal.verdict,
    signal.proposedLane ?? '-',
    Math.floor((signal.confirmHeldMs ?? 0) / 1000),
  ].join('|');
}

function confirmStateEqual(
  a: ExecutionConfirmState | null | undefined,
  b: ExecutionConfirmState | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.proposedLane === b.proposedLane &&
    a.passSinceMs === b.passSinceMs &&
    a.confirmHeldMs === b.confirmHeldMs
  );
}

function advanceConfirmState(
  prev: ExecutionConfirmState | null,
  input: ExecutionSignalInput,
  nowMs: number,
): ExecutionConfirmState {
  const next = updateExecutionConfirm(prev, input, nowMs);
  return confirmStateEqual(prev, next) && prev ? prev : next;
}

/** Live execution signal with confirmation hold tracking. */
export function useDeskExecutionSignal(args: DeskExecutionSignalArgs): ExecutionSignal | null {
  const enabled = args.enabled !== false;
  const bandUsdFromGauge =
    args.bandGauge != null ? (args.bandGauge.bandHi - args.bandGauge.bandLo) / 2 : null;
  const bandGaugeSlope = args.bandGauge?.slopeUsdPerMin ?? null;
  const ptbBandUsd = args.ptbContext?.bandUsd ?? null;
  const ptbSlopeSec = args.ptbContext?.slopeUsdPerSec ?? null;

  const inputBase = useMemo(
    () => (enabled ? buildExecutionInputFromDesk(args) : null),
    [
      enabled,
      args.spot,
      args.priceToBeat,
      args.probUp,
      args.probDown,
      args.machine,
      args.upLabel,
      args.downLabel,
      bandUsdFromGauge,
      bandGaugeSlope,
      ptbBandUsd,
      ptbSlopeSec,
    ],
  );

  const [execConfirm, setExecConfirm] = useState<ExecutionConfirmState | null>(null);

  useEffect(() => {
    if (!inputBase) {
      setExecConfirm((prev) => (prev == null ? prev : null));
      return;
    }
    setExecConfirm((prev) => advanceConfirmState(prev, inputBase, Date.now()));
  }, [inputBase]);

  useEffect(() => {
    if (!inputBase) return;
    const id = window.setInterval(() => {
      setExecConfirm((prev) => advanceConfirmState(prev, inputBase, Date.now()));
    }, 1000);
    return () => window.clearInterval(id);
  }, [inputBase]);

  return useMemo(() => {
    if (!inputBase) return null;
    return computeExecutionSignal({
      ...inputBase,
      confirmHeldMs: execConfirm?.confirmHeldMs ?? 0,
    });
  }, [inputBase, execConfirm?.confirmHeldMs]);
}
