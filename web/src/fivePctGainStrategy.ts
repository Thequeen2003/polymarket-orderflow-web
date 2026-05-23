/**
 * $1,000 → $10,000 — 5% Gain Strategy
 *
 * High-precision prediction-market entries: 48–93¢ only, ~+5% target, protected stop,
 * momentum + flow + book alignment. Pure module — no React.
 */

import type { DualOutcomeWallFlow } from './dualOutcomeWalls';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { TapeVelocity } from './tapeVelocity';
import type { TradeDirective } from './tradeDirective';
import { formatCentsLabelFrom01, price01ToWholeCents, roundPrice01ToCent } from './displayCents';
import { parseUpdownSlug } from './sixPackUpdownSlugs';

export const FIVE_PCT_STRATEGY_NAME = '1000 to 10K — 5% Gain Strategy';

export const ENTRY_MIN_01 = 0.48;
export const ENTRY_MAX_01 = 0.93;
export const GAIN_TARGET_PCT = 0.05;
/** Max stop distance below entry (~6–10¢ on typical mids). */
export const STOP_MAX_FRACTION = 0.1;
export const STOP_MAX_ABSOLUTE_01 = 0.06;

export type FivePctEntryZone = 'value' | 'momentum' | 'late' | 'out_of_band';

export type FivePctConfidence = 'High' | 'Med' | 'Low';

export type FivePctMomentumState =
  | 'Strong continuation'
  | 'Value absorption'
  | 'Late momentum (high risk)'
  | 'Weak / wait';

export type FivePctGainSignal = {
  strategyName: string;
  market: string;
  direction: 'UP' | 'DOWN';
  lane: 'up' | 'down';
  entry01: number;
  entryCents: number;
  entryZone: FivePctEntryZone;
  targetExit01: number;
  targetExitCents: number;
  stopLoss01: number;
  stopLossCents: number;
  confidence: FivePctConfidence;
  reasoning: string;
  riskReward: number;
  momentumState: FivePctMomentumState;
};

export type FivePctGainInput = {
  lane: 'up' | 'down' | null;
  entry01: number | null;
  directive: TradeDirective | null;
  machine: SpotPtbMachineReadout | null;
  tape: TapeVelocity | null;
  wallFlow: DualOutcomeWallFlow | null;
  slug?: string | null;
  upLabel?: string;
  downLabel?: string;
};

export type FivePctGainEval = {
  ok: boolean;
  signal: FivePctGainSignal | null;
  reason: string | null;
};

export function classifyEntryZone01(entry01: number): FivePctEntryZone {
  const c = entry01 * 100;
  if (c < 48 || c > 93) return 'out_of_band';
  if (c <= 65) return 'value';
  if (c <= 80) return 'momentum';
  return 'late';
}

export function formatFivePctCents(entry01: number): number {
  return price01ToWholeCents(entry01);
}

/** ~+5% take-profit and downside stop from entry (binary-safe clamp). */
export function computeFivePctBracketLevels(entry01: number): {
  targetExit01: number;
  stopLoss01: number;
  gain01: number;
  risk01: number;
  riskReward: number;
} {
  const entry = roundPrice01ToCent(Math.max(ENTRY_MIN_01, Math.min(ENTRY_MAX_01, entry01)));
  const rawTp = entry * (1 + GAIN_TARGET_PCT);
  const targetExit01 = roundPrice01ToCent(Math.min(0.99, Math.max(entry + 0.01, rawTp)));
  const stopDist = Math.min(STOP_MAX_ABSOLUTE_01, entry * STOP_MAX_FRACTION);
  const stopLoss01 = roundPrice01ToCent(Math.max(0.01, entry - stopDist));
  const gain01 = targetExit01 - entry;
  const risk01 = entry - stopLoss01;
  const riskReward = risk01 > 1e-6 ? gain01 / risk01 : 0;
  return { targetExit01, stopLoss01, gain01, risk01, riskReward };
}

export function formatFivePctMarket(slug: string | null | undefined, fallbackLabel?: string): string {
  const p = slug?.trim() ? parseUpdownSlug(slug.trim()) : null;
  if (p) {
    const asset = p.asset.toUpperCase();
    return `${asset} ${p.interval}`;
  }
  const fb = fallbackLabel?.trim();
  if (fb) {
    const parts = fb.split(/\s+/);
    return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : fb;
  }
  return 'Market';
}

function tapeSupportsLane(lane: 'up' | 'down', tape: TapeVelocity | null): boolean {
  if (!tape?.reliable) return false;
  if (tape.dominance === 'idle' || tape.dominance === 'mixed') return false;
  if (lane === 'up') return tape.dominance === 'buy' && tape.netPressure > 8;
  return tape.dominance === 'sell' && tape.netPressure < -8;
}

function tapeFightsLane(lane: 'up' | 'down', tape: TapeVelocity | null): boolean {
  if (!tape?.reliable) return false;
  return (
    (lane === 'up' && tape.dominance === 'sell' && tape.netPressure < -18) ||
    (lane === 'down' && tape.dominance === 'buy' && tape.netPressure > 18)
  );
}

function momentumSupportsLane(lane: 'up' | 'down', machine: SpotPtbMachineReadout | null): boolean {
  const acc = machine?.acceleration;
  if (!acc) return false;
  if (lane === 'up') {
    return acc.state === 'accel-up' || (acc.direction === 'up' && acc.thrust >= 42);
  }
  return acc.state === 'accel-down' || (acc.direction === 'down' && acc.thrust >= 42);
}

function isExhaustedChase(lane: 'up' | 'down', machine: SpotPtbMachineReadout | null): boolean {
  const o = machine?.overextension;
  if (!o || o.state !== 'overextended') return false;
  const against =
    (lane === 'up' && o.direction === 'up') || (lane === 'down' && o.direction === 'down');
  if (!against) return false;
  return !momentumSupportsLane(lane, machine);
}

function bookSupportsLane(lane: 'up' | 'down', wallFlow: DualOutcomeWallFlow | null): boolean {
  if (!wallFlow) return false;
  const snap = lane === 'up' ? wallFlow.up : wallFlow.down;
  if (!snap) return false;
  const thinAsks = !snap.askWall || snap.askRatio < 1.45;
  const flowOk = wallFlow.flowLane === lane || wallFlow.pressure >= 12;
  return thinAsks && flowOk;
}

function probabilityAligns(lane: 'up' | 'down', machine: SpotPtbMachineReadout | null, directive: TradeDirective | null): boolean {
  if (directive?.confidence === 'LOW') return false;
  const focus = machine?.focusLane;
  const flow = machine?.flowWinningLane;
  if (focus === lane || flow === lane) return true;
  const implied = machine?.sensors.impliedLeader;
  if (implied === lane) return true;
  if (directive?.lane === lane && (directive.confidence === 'HIGH' || directive.confidence === 'MED')) return true;
  return false;
}

function buildMomentumState(zone: FivePctEntryZone, tapeOk: boolean, accelOk: boolean): FivePctMomentumState {
  if (zone === 'late') return 'Late momentum (high risk)';
  if (zone === 'value' && tapeOk) return 'Value absorption';
  if (accelOk && tapeOk) return 'Strong continuation';
  if (zone === 'value') return 'Value absorption';
  return 'Weak / wait';
}

function buildReasoning(args: {
  lane: 'up' | 'down';
  zone: FivePctEntryZone;
  tapeOk: boolean;
  bookOk: boolean;
  accelOk: boolean;
  upLabel: string;
  downLabel: string;
  wallFlow: DualOutcomeWallFlow | null;
}): string {
  const token = args.lane === 'up' ? args.upLabel : args.downLabel;
  const parts: string[] = [];
  if (args.tapeOk) parts.push(`aggressor tape favors ${token}`);
  if (args.bookOk) {
    const snap = args.lane === 'up' ? args.wallFlow?.up : args.wallFlow?.down;
    const resist =
      snap?.wallAsk != null ? formatCentsLabelFrom01(snap.wallAsk.price) : 'above entry';
    parts.push(`thin ask resistance (${resist}) with flow on ${token}`);
  }
  if (args.accelOk) parts.push('momentum accelerating into the move');
  if (args.zone === 'value') parts.push('entry in strong value zone (48–65¢)');
  else if (args.zone === 'momentum') parts.push('momentum continuation zone (66–80¢)');
  else if (args.zone === 'late') parts.push('late momentum zone (81–93¢) — size down');
  if (parts.length === 0) return `Probability, flow, and momentum aligned on ${token}.`;
  return `${parts.join('; ')}.`;
}

function resolveConfidence(
  zone: FivePctEntryZone,
  directive: TradeDirective | null,
  tapeOk: boolean,
  bookOk: boolean,
  accelOk: boolean,
): FivePctConfidence {
  if (zone === 'late') return 'Med';
  const highDirective = directive?.confidence === 'HIGH';
  if (zone === 'value' && highDirective && tapeOk && (bookOk || accelOk)) return 'High';
  if (zone === 'momentum' && highDirective && accelOk && tapeOk) return 'High';
  if (tapeOk && accelOk && (bookOk || highDirective)) return 'High';
  return 'Med';
}

/**
 * Evaluate the 5% gain playbook. Returns a full signal only when every rule passes.
 */
export function evaluateFivePctGainStrategy(input: FivePctGainInput): FivePctGainEval {
  const lane = input.lane;
  const entry01 = input.entry01;
  const upLabel = input.upLabel?.trim() || 'UP';
  const downLabel = input.downLabel?.trim() || 'DOWN';

  if (!lane) return { ok: false, signal: null, reason: 'No trade lane — wait for ENTER.' };
  if (entry01 == null || !Number.isFinite(entry01) || entry01 <= 0 || entry01 >= 1) {
    return { ok: false, signal: null, reason: 'No valid entry mid.' };
  }

  const zone = classifyEntryZone01(entry01);
  if (zone === 'out_of_band') {
    const c = formatFivePctCents(entry01);
    return {
      ok: false,
      signal: null,
      reason: `Entry ${c}¢ outside 48–93¢ band — ignore per strategy.`,
    };
  }

  const machine = input.machine;
  const tape = input.tape;
  const wallFlow = input.wallFlow;

  if (machine?.regime === 'chop') {
    return { ok: false, signal: null, reason: 'Chop regime — avoid weak sideways chop.' };
  }

  if (machine?.regime === 'grind' && !momentumSupportsLane(lane, machine)) {
    return { ok: false, signal: null, reason: 'Grind without acceleration — wait for momentum.' };
  }

  if (tape?.reliable && (tape.dominance === 'idle' || tape.recent.count < 2)) {
    return { ok: false, signal: null, reason: 'Tape quiet / low volume — no signal.' };
  }

  if (tapeFightsLane(lane, tape)) {
    return { ok: false, signal: null, reason: `Flow fights ${lane.toUpperCase()} — wait for buyer/seller alignment.` };
  }

  if (!tapeSupportsLane(lane, tape) && !momentumSupportsLane(lane, machine)) {
    return { ok: false, signal: null, reason: 'Need tape pressure or accelerating momentum on this lane.' };
  }

  if (isExhaustedChase(lane, machine)) {
    return { ok: false, signal: null, reason: 'Overextended move — no chase unless momentum re-accelerates.' };
  }

  if (!momentumSupportsLane(lane, machine)) {
    return { ok: false, signal: null, reason: 'Momentum not in continuation — need accel or thrust ≥ 42.' };
  }

  const bookOk = bookSupportsLane(lane, wallFlow);
  const tapeOk = tapeSupportsLane(lane, tape);
  if (!bookOk && !tapeOk) {
    return { ok: false, signal: null, reason: 'Book structure weak — need thin asks + flow or strong tape.' };
  }

  if (!probabilityAligns(lane, machine, input.directive)) {
    return { ok: false, signal: null, reason: 'Probability / focus lane not aligned with entry.' };
  }

  if (machine?.probVsSpot === 'conflict' && input.directive?.confidence !== 'HIGH') {
    return { ok: false, signal: null, reason: 'Prob vs spot conflict — wait for HIGH confidence alignment.' };
  }

  const bracket = computeFivePctBracketLevels(entry01);
  const accelOk = momentumSupportsLane(lane, machine);
  const momentumState = buildMomentumState(zone, tapeOk, accelOk);
  const confidence = resolveConfidence(zone, input.directive, tapeOk, bookOk, accelOk);
  const reasoning = buildReasoning({
    lane,
    zone,
    tapeOk,
    bookOk,
    accelOk,
    upLabel,
    downLabel,
    wallFlow,
  });

  const signal: FivePctGainSignal = {
    strategyName: FIVE_PCT_STRATEGY_NAME,
    market: formatFivePctMarket(input.slug, lane === 'up' ? upLabel : downLabel),
    direction: lane === 'up' ? 'UP' : 'DOWN',
    lane,
    entry01,
    entryCents: formatFivePctCents(entry01),
    entryZone: zone,
    targetExit01: bracket.targetExit01,
    targetExitCents: formatFivePctCents(bracket.targetExit01),
    stopLoss01: bracket.stopLoss01,
    stopLossCents: formatFivePctCents(bracket.stopLoss01),
    confidence,
    reasoning,
    riskReward: Math.round(bracket.riskReward * 100) / 100,
    momentumState,
  };

  return { ok: true, signal, reason: null };
}

/** Render the operator signal block (plain text lines). */
export function formatFivePctGainSignalLines(sig: FivePctGainSignal): string[] {
  return [
    `Strategy: ${sig.strategyName}`,
    `Market: ${sig.market}`,
    `Direction: ${sig.direction}`,
    `Entry: ${sig.entryCents}¢`,
    `Target Exit: ${sig.targetExitCents}¢`,
    `Stop Loss: ${sig.stopLossCents}¢`,
    `Confidence: ${sig.confidence}`,
    `Momentum: ${sig.momentumState}`,
    `Reasoning: ${sig.reasoning}`,
    `Risk/Reward: ${sig.riskReward.toFixed(2)}`,
  ];
}
