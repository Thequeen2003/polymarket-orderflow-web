/**
 * Now Price desk scalp — one-tap take on Should-I-buy advisory + global SL / trailing prefs.
 */

import {
  formatBracketCentsFrom01,
  spreadBracketFromFillPrice01,
  type BookTouchForArmRisk,
} from './armRiskFromSignal';
import { buildQuoteAssistTargets, loadEmergencyStopBundlePrefs } from './buyBundleStaging';
import { loadAutoTradeSizeShares } from './signalsPagePersist';
import type { BuySideAdvisory } from './shouldBuyWhichSide';
import type { EntryMoment } from './entryMoment';
import { entryMomentDeskScalpBlockReason } from './entryMoment';
import type { ContractLeadSignal } from './contractLeadSignal';
import type { PressureTiming } from './pressureTiming';
import {
  executeTakeSignal,
  roundTimerExecuteBlockReason,
  roundTimerAllowsExecute,
  type TakeSignalPlan,
} from './takeSignalDesk';
import { loadTradeAccountMode } from './tradeAccountMode';

export type NowPriceDeskScalpPrefs = {
  /** Stop trigger ¢ below fill — applied when global SL is enabled. */
  globalStopLossCents: string;
  /** When true, global SL fills on every buy (buy bundle + desk scalp). */
  useGlobalStopOnEveryBuy: boolean;
  /** Trail open winners instead of fixed TP only. */
  trailingProfit: boolean;
  /** Exit when live desk Targets TP falls below fill (cut loss). */
  takeLossWhenDeskTpBelowEntry: boolean;
  /** Auto-fire desk pick scalp when advisory is ready. */
  autoDeskScalp: boolean;
  /** Submit limit buy on take (live + shares); off = prefill trade panel only. */
  submitBuyOnTake: boolean;
  /** Auto-trade checklist (checkboxes + shares/SL) expanded in desk scalp panel. */
  checklistVisible: boolean;
};

export const NOW_PRICE_DESK_SCALP_PREFS_KEY = 'pm:nowPriceDeskScalpPrefs:v1';
export const NOW_PRICE_DESK_SCALP_PREFS_EVENT = 'bpx-now-price-desk-scalp-prefs';

export const DEFAULT_NOW_PRICE_DESK_SCALP_PREFS: NowPriceDeskScalpPrefs = {
  globalStopLossCents: '',
  useGlobalStopOnEveryBuy: true,
  trailingProfit: false,
  takeLossWhenDeskTpBelowEntry: false,
  autoDeskScalp: false,
  submitBuyOnTake: false,
  checklistVisible: true,
};

export function loadNowPriceDeskScalpPrefs(): NowPriceDeskScalpPrefs {
  if (typeof localStorage === 'undefined') return DEFAULT_NOW_PRICE_DESK_SCALP_PREFS;
  try {
    const raw = localStorage.getItem(NOW_PRICE_DESK_SCALP_PREFS_KEY);
    if (!raw) return DEFAULT_NOW_PRICE_DESK_SCALP_PREFS;
    const j = JSON.parse(raw) as Partial<NowPriceDeskScalpPrefs>;
    return {
      globalStopLossCents: typeof j.globalStopLossCents === 'string' ? j.globalStopLossCents : '',
      useGlobalStopOnEveryBuy: j.useGlobalStopOnEveryBuy !== false,
      trailingProfit: j.trailingProfit === true,
      takeLossWhenDeskTpBelowEntry: j.takeLossWhenDeskTpBelowEntry === true,
      autoDeskScalp: j.autoDeskScalp === true,
      submitBuyOnTake: j.submitBuyOnTake === true,
      checklistVisible: j.checklistVisible !== false,
    };
  } catch {
    return DEFAULT_NOW_PRICE_DESK_SCALP_PREFS;
  }
}

export function saveNowPriceDeskScalpPrefs(prefs: NowPriceDeskScalpPrefs): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(NOW_PRICE_DESK_SCALP_PREFS_KEY, JSON.stringify(prefs));
    window.dispatchEvent(new CustomEvent(NOW_PRICE_DESK_SCALP_PREFS_EVENT));
  } catch {
    // ignore
  }
}

export function parseGlobalStopOffsetCents(raw: string): number | null {
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(98, n);
}

/** Stop trigger price (whole ¢ string) from fill and offset below entry. */
export function globalStopCentsFromEntry(entry01: number, offsetCentsStr: string): string | null {
  const offset = parseGlobalStopOffsetCents(offsetCentsStr);
  if (offset == null || !(entry01 > 0) || entry01 >= 1) return null;
  const stop01 = Math.max(0.01, Math.min(0.99, entry01 - offset / 100));
  if (stop01 >= entry01 - 1e-9) return null;
  return formatBracketCentsFrom01(stop01);
}

export function resolveGlobalStopForEntry(
  entry01: number | null | undefined,
  prefs: NowPriceDeskScalpPrefs,
): string | null {
  if (!prefs.useGlobalStopOnEveryBuy) return null;
  const offset = prefs.globalStopLossCents.trim();
  if (!offset || entry01 == null || !(entry01 > 0) || entry01 >= 1) return null;
  return globalStopCentsFromEntry(entry01, offset);
}

function laneEntry01(touch: BookTouchForArmRisk, mid01: number | null): number | null {
  const ask = touch?.bestAsk;
  if (ask != null && ask > 0 && ask < 1) return ask;
  if (mid01 != null && mid01 > 0 && mid01 < 1) return mid01;
  return null;
}

function resolveLaneTpCents(entry01: number, touch: BookTouchForArmRisk): string {
  const prefs = loadEmergencyStopBundlePrefs();
  if (prefs.autoTpOnFill) {
    const q = buildQuoteAssistTargets({
      quote01: entry01,
      bestBid: touch?.bestBid ?? null,
      bestAsk: touch?.bestAsk ?? null,
    });
    if (q?.tpCents?.trim()) return q.tpCents.trim();
  }
  return spreadBracketFromFillPrice01(entry01, touch ?? {}).tpCents;
}

export type DeskScalpPlan = {
  canTake: boolean;
  disabledReason: string | null;
  lane: 'up' | 'down' | null;
  entry01: number | null;
  takeProfit01: number | null;
  stopLoss01: number | null;
  tpCentsStr: string | null;
  stopCentsStr: string | null;
  buttonLabel: string;
};

export function buildNowPriceDeskScalpPlan(args: {
  advisory: BuySideAdvisory | null;
  bookTouchUp: BookTouchForArmRisk;
  bookTouchDown: BookTouchForArmRisk;
  midUp01: number | null;
  midDown01: number | null;
  endsInMs?: number | null;
  slug?: string | null;
  scalpPrefs?: NowPriceDeskScalpPrefs;
  entryMoment?: EntryMoment | null;
  contractLead?: ContractLeadSignal | null;
  pressureTiming?: PressureTiming | null;
}): DeskScalpPlan {
  const fail = (reason: string, label = 'Take desk scalp'): DeskScalpPlan => ({
    canTake: false,
    disabledReason: reason,
    lane: null,
    entry01: null,
    takeProfit01: null,
    stopLoss01: null,
    tpCentsStr: null,
    stopCentsStr: null,
    buttonLabel: label,
  });

  const prefs = args.scalpPrefs ?? loadNowPriceDeskScalpPrefs();
  const lane: 'up' | 'down' | null =
    args.advisory?.verdict === 'BUY_UP' ? 'up' : args.advisory?.verdict === 'BUY_DOWN' ? 'down' : null;

  if (!lane) {
    return fail(
      args.advisory?.verdict === 'NEITHER'
        ? args.advisory.recommendation
        : 'No desk pick — wait for BUY UP or BUY DOWN.',
      'Desk scalp — wait',
    );
  }

  const touch = lane === 'up' ? args.bookTouchUp : args.bookTouchDown;
  const mid01 = lane === 'up' ? args.midUp01 : args.midDown01;
  const entry01 = laneEntry01(touch, mid01);
  if (entry01 == null) {
    return fail('No ask or mid on the desk pick lane yet.', 'Desk scalp — no quote');
  }

  const timerBlock = roundTimerExecuteBlockReason(args.endsInMs, args.slug);
  if (timerBlock) {
    return fail(timerBlock, 'Desk scalp — wait for bell');
  }

  const momentBlock = entryMomentDeskScalpBlockReason(args.entryMoment, {
    contractLead: args.contractLead ?? null,
    pressureTiming: args.pressureTiming ?? null,
  });
  if (momentBlock) {
    return fail(momentBlock, 'Desk scalp — wait for entry');
  }

  const tpCentsStr = resolveLaneTpCents(entry01, touch);
  const tp01 = Number(tpCentsStr) / 100;
  const takeProfit01 = Number.isFinite(tp01) && tp01 > entry01 ? tp01 : null;

  const globalStop = resolveGlobalStopForEntry(entry01, prefs);
  const spreadStop = spreadBracketFromFillPrice01(entry01, touch ?? {}).stopCents;
  const stopCentsStr = globalStop ?? spreadStop;
  const stop01 = Number(stopCentsStr) / 100;
  const stopLoss01 = Number.isFinite(stop01) && stop01 > 0 && stop01 < entry01 ? stop01 : null;

  if (stopLoss01 == null) {
    return fail('Set global SL (¢ below fill) or enable auto SL in buy prefs.', 'Desk scalp — no SL');
  }

  const laneLabel = lane === 'up' ? 'UP' : 'DOWN';
  const entryCents = (entry01 * 100).toFixed(1);
  return {
    canTake: true,
    disabledReason: null,
    lane,
    entry01,
    takeProfit01,
    stopLoss01,
    tpCentsStr: takeProfit01 != null ? tpCentsStr : null,
    stopCentsStr,
    buttonLabel: `Take desk scalp · BUY ${laneLabel} @ ${entryCents}¢`,
  };
}

export function deskScalpPlanToTakeSignal(plan: DeskScalpPlan): TakeSignalPlan {
  return {
    canTake: plan.canTake,
    disabledReason: plan.disabledReason,
    lane: plan.lane,
    entry01: plan.entry01,
    takeProfit01: plan.takeProfit01,
    stopLoss01: plan.stopLoss01,
    buttonLabel: plan.buttonLabel,
  };
}

export type ExecuteDeskScalpOpts = {
  sizeShares?: number;
  submitBuy?: boolean;
  endsInMs?: number | null;
};

export function executeNowPriceDeskScalp(
  plan: DeskScalpPlan,
  slug: string,
  opts?: ExecuteDeskScalpOpts,
): { buySubmitted: boolean; buySkippedReason?: string | null } {
  if (!plan.canTake || !plan.lane || plan.entry01 == null) {
    return { buySubmitted: false, buySkippedReason: plan.disabledReason ?? 'Plan not ready.' };
  }
  const live = loadTradeAccountMode() === 'live';
  const sizeShares =
    opts?.sizeShares != null && Number.isFinite(opts.sizeShares) && opts.sizeShares > 0
      ? opts.sizeShares
      : loadAutoTradeSizeShares();
  const wantsBuy = opts?.submitBuy ?? (live && sizeShares > 0);
  const armSlTp = plan.stopLoss01 != null && plan.takeProfit01 != null;

  if (
    plan.stopLoss01 != null &&
    plan.takeProfit01 == null &&
    plan.lane &&
    typeof window !== 'undefined'
  ) {
    window.dispatchEvent(
      new CustomEvent('bpx-risk-prefill', {
        detail: {
          lane: plan.lane,
          stopCents: Number(formatBracketCentsFrom01(plan.stopLoss01)),
          stopCentsStr: formatBracketCentsFrom01(plan.stopLoss01),
          arm: true,
          forceLevels: true,
          sizeShares: wantsBuy ? sizeShares : undefined,
        },
      }),
    );
  }

  const result = executeTakeSignal(deskScalpPlanToTakeSignal(plan), slug, {
    submitBuy: wantsBuy,
    sizeShares: wantsBuy ? sizeShares : undefined,
    armSlTp,
    endsInMs: opts?.endsInMs,
  });

  return {
    buySubmitted: result.buySubmitted,
    buySkippedReason: result.buySkippedReason,
  };
}

export function deskScalpAutoBlockReason(args: {
  plan: DeskScalpPlan;
  autoEnabled: boolean;
  submitBuyOnTake: boolean;
  sizeShares: number | null;
  endsInMs?: number | null;
  slug?: string | null;
}): string | null {
  if (!args.autoEnabled) return null;
  if (args.submitBuyOnTake && (args.sizeShares == null || !(args.sizeShares > 0))) {
    return 'Enter share size for auto buy.';
  }
  if (!roundTimerAllowsExecute(args.endsInMs, args.slug)) {
    return roundTimerExecuteBlockReason(args.endsInMs, args.slug);
  }
  if (!args.plan.canTake) return args.plan.disabledReason ?? 'Desk pick not ready.';
  return null;
}

export const AUTO_DESK_SCALP_COOLDOWN_MS = 45_000;

export function deskScalpMeaningKey(plan: DeskScalpPlan): string {
  const entryKey =
    plan.entry01 != null ? String(Math.round(plan.entry01 * 1000) / 10) : '';
  return [plan.lane ?? '', entryKey, plan.stopCentsStr ?? '', plan.tpCentsStr ?? ''].join('|');
}

export function shouldSubmitDeskScalpBuy(
  prefs: Pick<NowPriceDeskScalpPrefs, 'submitBuyOnTake'>,
  sizeShares: number | null | undefined,
): boolean {
  if (!prefs.submitBuyOnTake) return false;
  if (loadTradeAccountMode() !== 'live') return false;
  return sizeShares != null && Number.isFinite(sizeShares) && sizeShares > 0;
}

/** Live Targets (assist) TP from current book quote — same row the buy strip uses. */
export function liveDeskTp01FromBook(
  touch: BookTouchForArmRisk,
  fallbackMid01?: number | null,
): number | null {
  const bid = touch?.bestBid;
  const ask = touch?.bestAsk;
  const quote01 =
    ask != null && ask > 0 && ask < 1
      ? ask
      : bid != null && bid > 0 && bid < 1
        ? bid
        : fallbackMid01 != null && fallbackMid01 > 0 && fallbackMid01 < 1
          ? fallbackMid01
          : null;
  if (quote01 == null) return null;
  const targets = buildQuoteAssistTargets({
    quote01,
    bestBid: bid ?? null,
    bestAsk: ask ?? null,
  });
  const tp01 = targets?.tp01;
  return tp01 != null && Number.isFinite(tp01) && tp01 > 0 && tp01 < 1 ? tp01 : null;
}

/** True when desk TP has collapsed under entry — time to cut the loss. */
export function deskTpBelowEntry(entry01: number | null | undefined, deskTp01: number | null | undefined): boolean {
  if (entry01 == null || !(entry01 > 0) || entry01 >= 1) return false;
  if (deskTp01 == null || !(deskTp01 > 0) || deskTp01 >= 1) return false;
  return deskTp01 < entry01 - 1e-9;
}
