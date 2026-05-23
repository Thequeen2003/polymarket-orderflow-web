/**
 * Take-signal strategy filters — stack named rules on top of `buildTakeSignalPlan`.
 * Pass active strategy ids; take / auto-trade only fires when every active rule passes.
 */

import type { DeskSingleAction } from './deskSingleAction';
import type { DualOutcomeWallFlow } from './dualOutcomeWalls';
import { evaluateFivePctGainStrategy } from './fivePctGainStrategy';
import type { NoTradeScore } from './noTradeScore';
import type { OperatorVerdict } from './operatorVerdict';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { TapeVelocity } from './tapeVelocity';
import type { TradeDirective } from './tradeDirective';
import { parseDeskEnterLane, type TakeSignalPlan } from './takeSignalDesk';

export const TAKE_SIGNAL_STRATEGY_IDS = [
  'five-pct-gain',
  'high-confidence',
  'no-red-no-trade',
  'machine-agreement',
  'cross-aligned',
  'trend-regime',
  'desk-enter-sync',
  'initiate-only',
  'tape-not-fighting',
] as const;

export type TakeSignalStrategyId = (typeof TAKE_SIGNAL_STRATEGY_IDS)[number];

export type TakeSignalStrategyDef = {
  id: TakeSignalStrategyId;
  label: string;
  /** One line shown in the strategy picker. */
  hint: string;
  evaluate: (ctx: TakeSignalStrategyContext) => TakeSignalStrategyResult;
};

export type TakeSignalStrategyContext = {
  plan: TakeSignalPlan;
  verdict: OperatorVerdict | null;
  directive: TradeDirective | null;
  machine: SpotPtbMachineReadout | null;
  noTradeScore: NoTradeScore | null;
  crossEngineLaneConflict: boolean;
  deskAction: DeskSingleAction | null;
  tape: TapeVelocity | null;
  slug?: string | null;
  upLabel?: string;
  downLabel?: string;
  wallFlow?: DualOutcomeWallFlow | null;
};

export type TakeSignalStrategyResult = {
  pass: boolean;
  reason: string | null;
};

const STRATEGY_SET = new Set<string>(TAKE_SIGNAL_STRATEGY_IDS);

export function isTakeSignalStrategyId(x: string): x is TakeSignalStrategyId {
  return STRATEGY_SET.has(x);
}

/** Drop unknown ids; preserve registry order for stable UI. */
export function normalizeTakeSignalStrategyIds(ids: readonly string[]): TakeSignalStrategyId[] {
  const want = new Set(ids.filter(isTakeSignalStrategyId));
  return TAKE_SIGNAL_STRATEGY_IDS.filter((id) => want.has(id));
}

function tapeFightsLane(lane: 'up' | 'down', tape: TapeVelocity): boolean {
  if (!tape.reliable) return false;
  return (
    (lane === 'up' && tape.dominance === 'sell' && tape.netPressure < -18) ||
    (lane === 'down' && tape.dominance === 'buy' && tape.netPressure > 18)
  );
}

export const TAKE_SIGNAL_STRATEGY_REGISTRY: Record<TakeSignalStrategyId, TakeSignalStrategyDef> = {
  'five-pct-gain': {
    id: 'five-pct-gain',
    label: '5% gain (1K→10K)',
    hint: '48–93¢ entries only · ~+5% TP · momentum + flow + book must align.',
    evaluate(ctx) {
      const r = evaluateFivePctGainStrategy({
        lane: ctx.plan.lane,
        entry01: ctx.plan.entry01,
        directive: ctx.directive,
        machine: ctx.machine,
        tape: ctx.tape,
        wallFlow: ctx.wallFlow ?? ctx.machine?.wallFlow ?? null,
        slug: ctx.slug,
        upLabel: ctx.upLabel,
        downLabel: ctx.downLabel,
      });
      if (r.ok) return { pass: true, reason: null };
      return { pass: false, reason: r.reason ?? '5% gain rules not satisfied.' };
    },
  },
  'high-confidence': {
    id: 'high-confidence',
    label: 'High confidence',
    hint: 'Trade card confidence must be HIGH.',
    evaluate(ctx) {
      const c = ctx.directive?.confidence;
      if (c === 'HIGH') return { pass: true, reason: null };
      return { pass: false, reason: `Need HIGH confidence (card is ${c ?? '—'}).` };
    },
  },
  'no-red-no-trade': {
    id: 'no-red-no-trade',
    label: 'No RED no-trade',
    hint: 'Pause when the no-trade composite is RED.',
    evaluate(ctx) {
      const tier = ctx.noTradeScore?.tier;
      if (tier !== 'RED') return { pass: true, reason: null };
      const score = ctx.noTradeScore?.score;
      return {
        pass: false,
        reason: `No-trade RED (${score != null ? Math.round(score) : '—'}/100) — wait for GREEN/YELLOW.`,
      };
    },
  },
  'machine-agreement': {
    id: 'machine-agreement',
    label: 'Machine agreement',
    hint: 'Spot PTB agreement score ≥ 55.',
    evaluate(ctx) {
      const a = ctx.machine?.agreementScore;
      if (a != null && Number.isFinite(a) && a >= 55) return { pass: true, reason: null };
      return {
        pass: false,
        reason: `Agreement ${a != null && Number.isFinite(a) ? Math.round(a) : '—'} — need ≥ 55.`,
      };
    },
  },
  'cross-aligned': {
    id: 'cross-aligned',
    label: 'Cross aligned',
    hint: 'Spot vs Dual lane must not be in CONFLICT.',
    evaluate(ctx) {
      if (!ctx.crossEngineLaneConflict) return { pass: true, reason: null };
      return { pass: false, reason: 'Cross-check CONFLICT — Spot and Dual disagree on lane.' };
    },
  },
  'trend-regime': {
    id: 'trend-regime',
    label: 'Trend regime',
    hint: 'Machine regime must be trend (not chop/grind).',
    evaluate(ctx) {
      const r = ctx.machine?.regime;
      if (r === 'trend') return { pass: true, reason: null };
      return { pass: false, reason: `Regime is ${r ?? '—'} — need trend.` };
    },
  },
  'desk-enter-sync': {
    id: 'desk-enter-sync',
    label: 'Desk ENTER sync',
    hint: '“Do this now” strip must show ENTER on the same lane as take.',
    evaluate(ctx) {
      const lane = ctx.plan.lane;
      if (!lane) return { pass: false, reason: 'No take lane yet.' };
      const deskLane = parseDeskEnterLane(ctx.deskAction?.primary);
      const tone = ctx.deskAction?.tone;
      const enterTone = tone === 'green' || tone === 'emerald';
      if (deskLane === lane && enterTone) return { pass: true, reason: null };
      return {
        pass: false,
        reason: `Desk strip must be green ENTER ${lane.toUpperCase()} (now ${ctx.deskAction?.primary ?? '—'}).`,
      };
    },
  },
  'initiate-only': {
    id: 'initiate-only',
    label: 'Initiate / ADD only',
    hint: 'Blocks FLIP and other non-entry card verbs.',
    evaluate(ctx) {
      const a = ctx.directive?.action;
      if (a === 'INITIATE' || a === 'ADD') return { pass: true, reason: null };
      return { pass: false, reason: `Card is ${a ?? '—'} — strategy allows INITIATE / ADD only.` };
    },
  },
  'tape-not-fighting': {
    id: 'tape-not-fighting',
    label: 'Tape not fighting',
    hint: 'Desk tape must not be aggressively against the take lane.',
    evaluate(ctx) {
      const lane = ctx.plan.lane;
      if (!lane) return { pass: false, reason: 'No take lane yet.' };
      const tape = ctx.tape;
      if (!tape?.reliable) return { pass: true, reason: null };
      if (!tapeFightsLane(lane, tape)) return { pass: true, reason: null };
      return {
        pass: false,
        reason: `Tape fights ${lane.toUpperCase()} (${tape.summary}) — wait for flow to align.`,
      };
    },
  },
};

export function listTakeSignalStrategies(): TakeSignalStrategyDef[] {
  return TAKE_SIGNAL_STRATEGY_IDS.map((id) => TAKE_SIGNAL_STRATEGY_REGISTRY[id]);
}

/** Evaluate one strategy by id (unknown id → pass). */
export function evaluateTakeSignalStrategy(
  id: TakeSignalStrategyId,
  ctx: TakeSignalStrategyContext,
): TakeSignalStrategyResult {
  return TAKE_SIGNAL_STRATEGY_REGISTRY[id].evaluate(ctx);
}

/**
 * Apply active strategies to a base take plan.
 * Empty `activeIds` → unchanged plan. Strategies never unblock a failed base plan.
 */
export function applyTakeSignalStrategies(
  basePlan: TakeSignalPlan,
  ctx: Omit<TakeSignalStrategyContext, 'plan'>,
  activeIds: readonly TakeSignalStrategyId[],
): TakeSignalPlan {
  const ids = normalizeTakeSignalStrategyIds(activeIds);
  if (ids.length === 0) return basePlan;
  if (!basePlan.canTake) return basePlan;

  const fullCtx: TakeSignalStrategyContext = { ...ctx, plan: basePlan };
  let out = basePlan;
  for (const id of ids) {
    const r = evaluateTakeSignalStrategy(id, { ...fullCtx, plan: out });
    if (r.pass) continue;
    const def = TAKE_SIGNAL_STRATEGY_REGISTRY[id];
    const reason = r.reason ?? `${def.label} blocked take.`;
    return {
      ...out,
      canTake: false,
      disabledReason: `Strategy · ${def.label}: ${reason}`,
      buttonLabel: `Take signal — ${def.label}`,
    };
  }

  return out;
}
