/**
 * Regime-based TP engine v2 — dynamic targets keyed to market state, not fixed brackets.
 *
 * Regimes: TREND_GRIND · ACCELERATION · CHOP · NEUTRAL (in-band / flat)
 * Also ships time-stop, split TP (accel), and trailing rules for open positions.
 */

import type { DeskSpeedSnapshot, SpeedAlignment, SpeedMode } from './deskSpeedLayers';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { NowPriceBandDistances } from './nowPriceSignals';

export type TpMarketRegime = 'TREND_GRIND' | 'ACCELERATION' | 'CHOP' | 'NEUTRAL';

/** Default time stop when TP not hit — exit stale trades. */
export const REGIME_TIME_STOP_MS = 25_000;
/** Chop: hard max hold before forced exit. */
export const REGIME_CHOP_MAX_HOLD_MS = 12_000;
/** Chop: exit if price stalls this long near entry. */
export const REGIME_CHOP_STALE_MS = 6_000;
/** Neutral in-band: prefer skip or micro scalp only. */
export const REGIME_NEUTRAL_MAX_HOLD_MS = 15_000;

export type TrailingTpConfig = {
  /** Activate trailing once this many ¢ in favor. */
  activateAtCents: number;
  /** Lock at least this profit once activated. */
  lockProfitCents: number;
  /** Start trailing after reaching this ¢ gain. */
  trailAtCents: number;
  /** Trail distance below peak (¢). */
  trailByCents: number;
};

export type RegimeTpPlan = {
  regime: TpMarketRegime;
  regimeLabel: string;
  tpMinCents: number;
  tpMaxCents: number;
  /** Primary TP target (mid of band unless split). */
  tpTargetCents: number;
  /** Split-exit first target (ACCELERATION only). */
  tp1Cents: number | null;
  tp2MinCents: number | null;
  tp2MaxCents: number | null;
  trailing: TrailingTpConfig | null;
  timeStopMs: number;
  maxHoldMs: number | null;
  staleExitMs: number | null;
  /** When true, entry layer should prefer WAIT over trade. */
  preferSkipTrade: boolean;
  exitNotes: string[];
};

export type RegimeTpClassifyInput = {
  geo?: NowPriceBandDistances['geo'] | null;
  lane?: 'up' | 'down' | null;
  deskSpeed?: DeskSpeedSnapshot | null;
  machineRegime?: SpotPtbMachineReadout['regime'] | null;
  speedAlignment?: SpeedAlignment | null;
  speedMode?: SpeedMode | null;
  /** Pressure timing — BUILDING/EARLY can indicate acceleration. */
  pressureTiming?: 'EARLY' | 'BUILDING' | 'EXTENDED' | 'CHASING' | null;
};

export type RegimeTpExitInput = {
  plan: RegimeTpPlan;
  entry01: number;
  current01: number;
  tp01: number;
  entryMs: number;
  nowMs: number;
  /** Last time mid moved ≥0.3¢ from entry-side stall zone. */
  lastMeaningfulMoveMs?: number | null;
  /** Model P for the held side (Up or Down). */
  modelPHeld?: number | null;
  momentumFlip?: boolean;
  spreadStalled?: boolean;
  peakGainCents?: number | null;
};

export type RegimeTpExitAction =
  | 'hold'
  | 'exit_market'
  | 'take_tp1'
  | 'take_tp2'
  | 'trail_exit'
  | 'time_stop';

export type RegimeTpExitVerdict = {
  action: RegimeTpExitAction;
  reason: string;
  /** Suggested trailing floor in ¢ above entry (long token). */
  trailFloorCents?: number;
};

const REGIME_LABEL: Record<TpMarketRegime, string> = {
  TREND_GRIND: 'TREND GRIND — hold for extension',
  ACCELERATION: 'ACCELERATION — split TP, exit on slowdown',
  CHOP: 'CHOP — micro scalp only',
  NEUTRAL: 'NEUTRAL / IN BAND — don’t hold',
};

function laneAlignment(deskSpeed: DeskSpeedSnapshot | null | undefined, lane: 'up' | 'down'): SpeedAlignment | null {
  return deskSpeed?.lanes[lane]?.alignment ?? null;
}

function laneMode(deskSpeed: DeskSpeedSnapshot | null | undefined, lane: 'up' | 'down'): SpeedMode | null {
  return deskSpeed?.lanes[lane]?.mode ?? null;
}

function spotVelocityHigh(deskSpeed: DeskSpeedSnapshot | null | undefined): boolean {
  const v = deskSpeed?.spot?.velocityPerSec;
  return v != null && Math.abs(v) > 0.025;
}

/**
 * Classify TP regime from desk speed + geo + machine readout.
 */
export function classifyTpRegime(input: RegimeTpClassifyInput): TpMarketRegime {
  const lane = input.lane ?? 'up';
  const alignment =
    input.speedAlignment ?? laneAlignment(input.deskSpeed, lane) ?? null;
  const mode = input.speedMode ?? laneMode(input.deskSpeed, lane) ?? null;
  const machine = input.machineRegime ?? null;
  const geo = input.geo ?? null;

  if (alignment === 'CHOP' || machine === 'chop') return 'CHOP';

  if (geo === 'IN_BAND' && alignment !== 'TREND_GRIND' && mode !== 'ACCELERATION_IMBALANCE') {
    return 'NEUTRAL';
  }

  if (
    mode === 'ACCELERATION_IMBALANCE' ||
    input.pressureTiming === 'BUILDING' ||
    (spotVelocityHigh(input.deskSpeed) && alignment !== 'CHOP')
  ) {
    if (alignment === 'TREND_GRIND' || machine === 'trend') return 'TREND_GRIND';
    return 'ACCELERATION';
  }

  if (alignment === 'TREND_GRIND' || machine === 'trend') return 'TREND_GRIND';

  if (alignment === 'MIXED' || alignment === 'CONVERGING' || machine === 'grind') return 'NEUTRAL';

  return 'NEUTRAL';
}

function midBand(min: number, max: number): number {
  return (min + max) / 2;
}

/**
 * Build full TP plan for a regime — entry bracket + live management rules.
 */
export function buildRegimeTpPlan(regime: TpMarketRegime): RegimeTpPlan {
  switch (regime) {
    case 'TREND_GRIND':
      return {
        regime,
        regimeLabel: REGIME_LABEL[regime],
        tpMinCents: 3.5,
        tpMaxCents: 6.5,
        tpTargetCents: midBand(3.5, 6.5),
        tp1Cents: null,
        tp2MinCents: null,
        tp2MaxCents: null,
        trailing: {
          activateAtCents: 2,
          lockProfitCents: 1,
          trailAtCents: 4,
          trailByCents: 1.25,
        },
        timeStopMs: REGIME_TIME_STOP_MS,
        maxHoldMs: null,
        staleExitMs: null,
        preferSkipTrade: false,
        exitNotes: [
          'Exit on momentum flip or P(held) < 60%',
          'Trail after +2¢ — lock +1¢; trail 1–1.5¢ after +4¢',
        ],
      };
    case 'ACCELERATION':
      return {
        regime,
        regimeLabel: REGIME_LABEL[regime],
        tpMinCents: 2,
        tpMaxCents: 5,
        tpTargetCents: 2,
        tp1Cents: 2,
        tp2MinCents: 4,
        tp2MaxCents: 5,
        trailing: null,
        timeStopMs: REGIME_TIME_STOP_MS,
        maxHoldMs: 20_000,
        staleExitMs: 8_000,
        preferSkipTrade: false,
        exitNotes: [
          'TP1 = +2¢ — secure partial',
          'TP2 = +4–5¢ if momentum holds',
          'Exit on first slowdown',
        ],
      };
    case 'CHOP':
      return {
        regime,
        regimeLabel: REGIME_LABEL[regime],
        tpMinCents: 1,
        tpMaxCents: 2,
        tpTargetCents: midBand(1, 2),
        tp1Cents: null,
        tp2MinCents: null,
        tp2MaxCents: null,
        trailing: null,
        timeStopMs: REGIME_CHOP_MAX_HOLD_MS,
        maxHoldMs: REGIME_CHOP_MAX_HOLD_MS,
        staleExitMs: REGIME_CHOP_STALE_MS,
        preferSkipTrade: false,
        exitNotes: [
          'Micro TP only — exit ≤12s',
          'Hard exit if no movement in 5–8s or bid/ask stalls',
        ],
      };
    default:
      return {
        regime: 'NEUTRAL',
        regimeLabel: REGIME_LABEL.NEUTRAL,
        tpMinCents: 0.8,
        tpMaxCents: 1.5,
        tpTargetCents: midBand(0.8, 1.5),
        tp1Cents: null,
        tp2MinCents: null,
        tp2MaxCents: null,
        trailing: null,
        timeStopMs: REGIME_NEUTRAL_MAX_HOLD_MS,
        maxHoldMs: REGIME_NEUTRAL_MAX_HOLD_MS,
        staleExitMs: 5_000,
        preferSkipTrade: true,
        exitNotes: ['Do not hold — micro TP or skip trade', 'Exit if momentum stalls'],
      };
  }
}

/**
 * One-shot: classify regime + build plan from live inputs.
 */
export function resolveRegimeTpPlan(input: RegimeTpClassifyInput): RegimeTpPlan {
  return buildRegimeTpPlan(classifyTpRegime(input));
}

/** Legacy band shape for execution signal card. */
export function regimePlanToTpBand(plan: RegimeTpPlan): {
  minCents: number;
  maxCents: number;
  regimeLabel: string;
  regime: TpMarketRegime;
  tp1Cents: number | null;
  tp2Range: string | null;
  timeStopSec: number;
} {
  const tp2Range =
    plan.tp2MinCents != null && plan.tp2MaxCents != null
      ? `${plan.tp2MinCents.toFixed(1)}–${plan.tp2MaxCents.toFixed(1)}¢`
      : null;
  return {
    minCents: plan.tpMinCents,
    maxCents: plan.tpMaxCents,
    regimeLabel: plan.regimeLabel,
    regime: plan.regime,
    tp1Cents: plan.tp1Cents,
    tp2Range,
    timeStopSec: Math.round(plan.timeStopMs / 1000),
  };
}

function gainCents(entry01: number, current01: number, bullish: boolean): number {
  const g = bullish ? current01 - entry01 : entry01 - current01;
  return g * 100;
}

/**
 * Live exit verdict for an open position under regime TP rules.
 */
export function evaluateRegimeTpExit(input: RegimeTpExitInput): RegimeTpExitVerdict {
  const {
    plan,
    entry01,
    current01,
    tp01,
    entryMs,
    nowMs,
    lastMeaningfulMoveMs,
    modelPHeld,
    momentumFlip,
    spreadStalled,
    peakGainCents,
  } = input;

  const bullish = tp01 >= entry01 - 1e-9;
  const heldMs = Math.max(0, nowMs - entryMs);
  const gain = gainCents(entry01, current01, bullish);
  const peak = peakGainCents ?? gain;
  const span = Math.abs(tp01 - entry01);
  const atTp = span > 0.002 && gain >= span * 100 - 0.15;
  const atTp1 = plan.tp1Cents != null && gain >= plan.tp1Cents - 0.1;
  const atTp2 =
    plan.tp2MinCents != null && gain >= plan.tp2MinCents - 0.1;

  if (momentumFlip) {
    return { action: 'exit_market', reason: 'Momentum flipped — exit before giveback' };
  }

  if (plan.regime === 'TREND_GRIND' && modelPHeld != null && modelPHeld < 0.6) {
    return { action: 'exit_market', reason: `P(held) ${(modelPHeld * 100).toFixed(0)}% < 60% — trend invalidating` };
  }

  if (plan.staleExitMs != null && lastMeaningfulMoveMs != null) {
    const staleMs = nowMs - lastMeaningfulMoveMs;
    if (staleMs >= plan.staleExitMs && gain < plan.tpMinCents * 0.85) {
      return { action: 'exit_market', reason: `No movement ${Math.round(staleMs / 1000)}s — stale ${plan.regime} trade` };
    }
  }

  if (spreadStalled && gain < plan.tpMinCents) {
    return { action: 'exit_market', reason: 'Bid/ask stalled near entry — chop exit' };
  }

  if (heldMs >= plan.timeStopMs && !atTp && gain < plan.tpMinCents * 0.9) {
    return { action: 'time_stop', reason: `Time stop ${Math.round(plan.timeStopMs / 1000)}s — TP not hit, exit market` };
  }

  if (plan.maxHoldMs != null && heldMs >= plan.maxHoldMs && !atTp) {
    return { action: 'time_stop', reason: `Max hold ${Math.round(plan.maxHoldMs / 1000)}s in ${plan.regime} — exit` };
  }

  if (plan.regime === 'ACCELERATION' && atTp2) {
    return { action: 'take_tp2', reason: `TP2 +${gain.toFixed(1)}¢ — bank extension` };
  }

  if (plan.regime === 'ACCELERATION' && atTp1 && !atTp2) {
    return { action: 'take_tp1', reason: `TP1 +${plan.tp1Cents!.toFixed(1)}¢ secured — hold runner to TP2 or exit on stall` };
  }

  if (plan.trailing && peak >= plan.trailing.activateAtCents) {
    const trailFloor =
      peak >= plan.trailing.trailAtCents
        ? peak - plan.trailing.trailByCents
        : plan.trailing.lockProfitCents;
    if (gain <= trailFloor + 0.05 && gain >= plan.trailing.lockProfitCents) {
      return {
        action: 'trail_exit',
        reason: `Trailing stop — peaked +${peak.toFixed(1)}¢, exit +${gain.toFixed(1)}¢`,
        trailFloorCents: trailFloor,
      };
    }
    if (gain < plan.trailing.lockProfitCents) {
      return {
        action: 'trail_exit',
        reason: `Trail lock breached — exit above +${plan.trailing.lockProfitCents.toFixed(1)}¢`,
        trailFloorCents: plan.trailing.lockProfitCents,
      };
    }
  }

  if (atTp) {
    return { action: 'take_tp2', reason: `Primary TP +${gain.toFixed(1)}¢ tagged` };
  }

  return { action: 'hold', reason: `${plan.regime} — hold for +${plan.tpTargetCents.toFixed(1)}¢ target` };
}

/**
 * Apply regime TP band to a computed leg size (0..1 scale).
 */
export function clampTpLegToRegime(tpLeg: number, plan: RegimeTpPlan): number {
  const min = plan.tpMinCents / 100;
  const max = plan.tpMaxCents / 100;
  return Math.max(min, Math.min(tpLeg, max));
}
