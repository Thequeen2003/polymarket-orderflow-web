import type { ProbMicrostructure } from './ptbAdvancedContext';
import type { EnterBlockReason } from './ptbDecisionEngine';
import type { PtbNet4cRoomLabel } from './ptbNet4cTradeability';

export type ScalpCompressionState = 'WAIT' | 'ARMED' | 'ENTER';

export type ScalpCompressionCheck = {
  id: 'trigger' | 'tape' | 'room' | 'follow' | 'risk';
  label: string;
  pass: boolean;
};

export type ScalpCompressionVeto = { id: string; label: string };

export type ScalpCompressionResult = {
  state: ScalpCompressionState;
  checks: ScalpCompressionCheck[];
  vetoes: ScalpCompressionVeto[];
  /** Single line for hero UI */
  reasonLine: string;
  passCount: number;
};

/**
 * Single decision for “4¢ up scalp — ready right now?”
 * Rules: any hard veto → WAIT; &lt;4 checks → WAIT; 4/5 → ARMED; 5/5 → ENTER.
 *
 * Check “trigger” matches PTB dual: price **through** the break (`throughLine`) with a valid line.
 * Hard vetoes and tape/risk gates are intentionally strict to cut false positives on +4¢ scalps.
 */
export function computeScalpCompression4cUp(params: {
  /** Primary trading lane (preMove / target lane). */
  primaryLane: 'up' | 'down';
  /** Price at/through the break (execution trigger). */
  throughLine: boolean;
  /** Lane chosen + break level available (from preMove); must hold for a real setup. */
  setupReady: boolean;
  /** Break price for primary lane, if any. */
  line: number | null;
  speedLabel: 'SLOW' | 'MED' | 'FAST';
  speedScore01: number;
  net4cRoom: PtbNet4cRoomLabel;
  /** preMove lane confirm (bias / ask eat / 2-bucket) for the active lane. */
  followThroughConfirm: boolean;
  enterBlockReason: EnterBlockReason;
  microstructure: ProbMicrostructure | null;
}): ScalpCompressionResult {
  const {
    primaryLane,
    throughLine,
    setupReady,
    line,
    speedLabel,
    speedScore01,
    net4cRoom,
    followThroughConfirm,
    enterBlockReason,
    microstructure: micro,
  } = params;

  const vetoes: ScalpCompressionVeto[] = [];
  if (net4cRoom === 'NO') {
    vetoes.push({ id: 'net4c', label: 'No +4¢ room before wall / bad fill at ref size' });
  }
  if (net4cRoom === 'MARGINAL') {
    vetoes.push({ id: 'net4c_marginal', label: '+4¢ room marginal — need clean YES room' });
  }
  if (enterBlockReason === 'dual_lane_tight') {
    vetoes.push({ id: 'dual_lane', label: 'Both lanes competitive — wait for break' });
  }
  if (micro?.bothLegsChaotic) {
    vetoes.push({ id: 'chaos', label: 'Both legs chaotic' });
  }
  if (micro && micro.jumpRisk01 >= 0.62) {
    vetoes.push({ id: 'jump', label: 'Jump risk too high for tight scalp' });
  }
  if (micro?.whipsawLeader && speedLabel !== 'FAST') {
    vetoes.push({ id: 'whipsaw', label: 'Whipsaw leader + tape not FAST' });
  }

  const triggerThrough = line != null && setupReady && throughLine;
  const checkTrigger: ScalpCompressionCheck = {
    id: 'trigger',
    label: 'Trigger (through break line)',
    pass: triggerThrough,
  };
  const checkTape: ScalpCompressionCheck = {
    id: 'tape',
    label: 'Tape (strong enough)',
    pass: speedLabel === 'FAST' || (speedLabel === 'MED' && speedScore01 >= 0.68),
  };
  const checkRoom: ScalpCompressionCheck = {
    id: 'room',
    label: 'Room (+4¢ vs wall / net path)',
    pass: net4cRoom === 'YES',
  };
  const checkFollow: ScalpCompressionCheck = {
    id: 'follow',
    label: `Follow-through (${primaryLane === 'up' ? 'Up' : 'Down'} lane)`,
    pass: followThroughConfirm,
  };
  const takeover = micro?.takeoverRisk ?? 'low';
  const checkRisk: ScalpCompressionCheck = {
    id: 'risk',
    label: 'Failure risk (takeover / stall)',
    pass:
      speedLabel !== 'SLOW' &&
      (takeover === 'low' || (takeover === 'med' && speedLabel === 'FAST' && speedScore01 >= 0.74)),
  };

  const checks = [checkTrigger, checkTape, checkRoom, checkFollow, checkRisk];
  const passCount = checks.filter((c) => c.pass).length;

  let state: ScalpCompressionState = 'WAIT';
  let reasonLine = '';

  if (vetoes.length > 0) {
    state = 'WAIT';
    reasonLine = `Veto: ${vetoes[0]!.label}.`;
  } else if (passCount < 4) {
    state = 'WAIT';
    reasonLine = `${passCount}/5 checks — need 4+ to arm.`;
  } else if (passCount === 4) {
    state = 'ARMED';
    reasonLine = '4/5 — one check short; do not treat as full ENTER.';
  } else {
    state = 'ENTER';
    reasonLine = '5/5 hard gates — compressed ENTER (size down if book jumps).';
  }

  return { state, checks, vetoes, reasonLine, passCount };
}
