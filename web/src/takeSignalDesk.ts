/**
 * “Take signal” — one-shot desk action: ack the card lane, prefill the trade panel
 * at signal entry, push TP/SL, and open the trade slide.
 */

import { dispatchSignalRiskLevels, formatBracketCentsFrom01 } from './armRiskFromSignal';
import { formatCentsLabelFrom01, price01ToWholeCents } from './displayCents';
import type { DeskSingleAction } from './deskSingleAction';
import type { OperatorVerdict } from './operatorVerdict';
import { orderFlowConflictsLane, type SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { TradeDirective } from './tradeDirective';
import type { TradeLevels } from './tradeLevels';
import { parseUpdownSlug } from './sixPackUpdownSlugs';
import type { ExecutionSignal } from './executionSignal';
import {
  executionEnterLane,
  executionTakeBlockReason,
  executionTakeButtonSuffix,
} from './executionSignalDesk';

export const BPX_TRADE_PANEL_OPEN_EVENT = 'bpx-trade-panel-open';
export const BPX_TRADE_SUBMIT_BUY_EVENT = 'bpx-trade-submit-buy';
/** Keep trade-panel amount in sync with Signals “Auto-trade size” (shares). */
export const BPX_TRADE_SYNC_SIZE_SHARES_EVENT = 'bpx-trade-sync-size-shares';
/** Desk toast from Signals page (trade panel listens and shows via pushToast). */
export const BPX_DESK_TOAST_EVENT = 'bpx-desk-toast';
/** Chart trade-card lane → slide-panel UP/DOWN toggle (same slug only). */
export const BPX_SIGNALS_LANE_SYNC_EVENT = 'bpx-signals-lane-sync';

export type BpxSignalsLaneSyncDetail = {
  slug: string;
  lane: 'up' | 'down';
  /** Bypass operator trade-panel lane lock (Take signal / explicit desk ack). */
  force?: boolean;
};

/** 5m up/down only: no take-signal / auto-trade buy until the bell is strictly under 5:00. */
export const MIN_MS_REMAINING_TO_EXECUTE = 5 * 60_000;

/**
 * 5:00 execute gate applies only to 5m rounds.
 * Uses slug when parseable; otherwise bell time (15m shows e.g. 9:40 left, never >5:00 on a 5m).
 */
export function marketUsesFiveMinuteExecuteGate(
  slug: string | null | undefined,
  endsInMs?: number | null,
): boolean {
  const bellMs = endsInMs != null && Number.isFinite(endsInMs) ? endsInMs : null;
  const p = slug?.trim() ? parseUpdownSlug(slug.trim()) : null;

  if (p?.interval && p.interval !== '5m') return false;

  if (bellMs != null && bellMs > MIN_MS_REMAINING_TO_EXECUTE) {
    return false;
  }

  if (p?.interval === '5m') return true;

  return bellMs != null && bellMs <= MIN_MS_REMAINING_TO_EXECUTE;
}

/** `m:ss` from remaining ms (same convention as chart bell). */
export function formatRoundClock(endsInMs: number | null | undefined): string {
  if (endsInMs == null || !Number.isFinite(endsInMs)) return '—';
  const totalSec = Math.max(0, Math.floor(endsInMs / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function roundTimerAllowsExecute(
  endsInMs: number | null | undefined,
  slug?: string | null,
): boolean {
  if (endsInMs == null || !Number.isFinite(endsInMs)) return true;
  if (!marketUsesFiveMinuteExecuteGate(slug, endsInMs)) return true;
  return endsInMs < MIN_MS_REMAINING_TO_EXECUTE;
}

export function roundTimerExecuteBlockReason(
  endsInMs: number | null | undefined,
  slug?: string | null,
): string | null {
  if (!marketUsesFiveMinuteExecuteGate(slug, endsInMs)) return null;
  if (endsInMs == null || !Number.isFinite(endsInMs)) return null;
  if (roundTimerAllowsExecute(endsInMs, slug)) return null;
  return `Wait for bell under 5:00 (now ${formatRoundClock(endsInMs)}) — no buy until then.`;
}

/** Prefer the live ENTER strip — debounced/fall-held copy can lag the trade card by several seconds. */
export function pickDeskActionForTake(
  spot: DeskSingleAction | null | undefined,
  live: DeskSingleAction | null | undefined,
): DeskSingleAction | null {
  void spot;
  if (live) {
    const lane = parseDeskEnterLane(live.primary);
    if (lane != null && (live.tone === 'green' || live.tone === 'emerald')) return live;
  }
  return live ?? null;
}

/** Lane when the “Do this now” primary line is `ENTER UP` / `ENTER DOWN`. */
export function parseDeskEnterLane(primary: string | null | undefined): 'up' | 'down' | null {
  if (!primary) return null;
  const t = primary.trim();
  if (/^ENTER\s+UP\b/i.test(t)) return 'up';
  if (/^ENTER\s+DOWN\b/i.test(t)) return 'down';
  return null;
}

export type TakeSignalPlan = {
  canTake: boolean;
  disabledReason: string | null;
  lane: 'up' | 'down' | null;
  entry01: number | null;
  takeProfit01: number | null;
  stopLoss01: number | null;
  /** Big CTA label, e.g. `Take signal · ENTER UP @ 62.0¢`. */
  buttonLabel: string;
};

function laneFromVerdict(verdict: OperatorVerdict): 'up' | 'down' | null {
  if (verdict.state === 'GO_LONG') return 'up';
  if (verdict.state === 'GO_SHORT') return 'down';
  return null;
}

function entryAction(directive: TradeDirective | null): boolean {
  if (!directive) return false;
  return directive.action === 'INITIATE' || directive.action === 'ADD' || directive.action === 'FLIP';
}

/** Match operator verdict — only thin LOW INITIATE is blocked on Spot/Dual mismatch. */
function crossBlocksTake(directive: TradeDirective | null, crossEngineLaneConflict: boolean): boolean {
  return !!(
    crossEngineLaneConflict &&
    directive?.action === 'INITIATE' &&
    directive.confidence === 'LOW'
  );
}

/** Whether the desk should offer a one-tap “take this signal” action. */
export function buildTakeSignalPlan(args: {
  verdict: OperatorVerdict | null;
  directive: TradeDirective | null;
  levels: TradeLevels | null;
  crossEngineLaneConflict: boolean;
  deskAction?: DeskSingleAction | null;
  machine?: SpotPtbMachineReadout | null;
  /** Round time remaining (ms); 5m markets only — buys blocked until strictly under 5:00. */
  endsInMs?: number | null;
  /** Market slug — `*-updown-15m-*` skips the 5:00 gate. */
  slug?: string | null;
  upLabel: string;
  downLabel: string;
  /** When true, take only fires when execution desk phase is ENTER on the same lane. */
  requireExecutionEnter?: boolean;
  execution?: ExecutionSignal | null;
}): TakeSignalPlan {
  const {
    verdict,
    directive,
    levels,
    crossEngineLaneConflict,
    deskAction,
    machine,
    endsInMs,
    slug,
    upLabel,
    downLabel,
    requireExecutionEnter,
    execution,
  } = args;
  const deskLane = parseDeskEnterLane(deskAction?.primary ?? null);
  const deskShowsEnter =
    deskLane != null && (deskAction?.tone === 'green' || deskAction?.tone === 'emerald');
  const fail = (reason: string, label = 'Take signal'): TakeSignalPlan => ({
    canTake: false,
    disabledReason: reason,
    lane: null,
    entry01: null,
    takeProfit01: null,
    stopLoss01: null,
    buttonLabel: label,
  });

  if (!verdict || !directive) {
    return fail('Trade card still loading — wait for ENTER / TP / SL.', 'Take signal — loading');
  }

  const deskAlignedEnter =
    deskShowsEnter && deskLane != null && directive.lane === deskLane && entryAction(directive);

  const directiveOverridesStandDown =
    directive != null &&
    entryAction(directive) &&
    directive.lane != null &&
    (directive.confidence === 'HIGH' || directive.confidence === 'MED');

  if (verdict.isStandDown && !deskAlignedEnter && !directiveOverridesStandDown) {
    return fail(verdict.reason || "Card says don't trade right now.", "Don't trade");
  }

  if (crossBlocksTake(directive, crossEngineLaneConflict)) {
    return fail(
      'Cross-check CONFLICT — Spot and Dual disagree on a thin LOW initiate. Wait or size down manually.',
      'Take signal — blocked',
    );
  }

  // Directive lane is the trade intent; desk ENTER + verdict refine it.
  let lane: 'up' | 'down' | null = null;
  if (entryAction(directive) && directive.lane) {
    lane = directive.lane;
  }
  if (deskAlignedEnter && deskLane) {
    lane = deskLane;
  }
  if (!lane) {
    lane = laneFromVerdict(verdict);
  }
  if (!lane && directiveOverridesStandDown && directive.lane) {
    lane = directive.lane;
  }
  if (!lane) {
    return fail('No fresh ENTER on a single lane — card is HOLD / EXIT / flat.', 'Take signal — wait');
  }
  if (directive.lane && directive.lane !== lane) {
    lane = directive.lane;
  }

  if (!entryAction(directive)) {
    return fail(`Card is ${directive.action} — take is for INITIATE / ADD / FLIP only.`, 'Take signal — wait');
  }

  if (
    machine &&
    lane &&
    orderFlowConflictsLane(lane, machine) &&
    !(directive.confidence === 'HIGH' && entryAction(directive))
  ) {
    const flow = machine.flowWinningLane!;
    const flowLabel = flow === 'up' ? upLabel : downLabel;
    const laneLabel = lane === 'up' ? upLabel : downLabel;
    return fail(
      `Order flow favors ${flowLabel} — don't buy ${laneLabel} until tape/book match the card.`,
      'Take signal — flow',
    );
  }

  if (levels?.collapsed) {
    return fail('Bell pin — no new bracket. Use market exit or skip.', 'Take signal — bell');
  }

  const entry01 =
    levels?.lane === lane && Number.isFinite(levels.entry)
      ? levels.entry
      : directive.laneMid != null && Number.isFinite(directive.laneMid)
        ? directive.laneMid
        : null;

  if (entry01 == null || entry01 <= 0 || entry01 >= 1) {
    return fail('No stable entry mid yet — wait for TP/SL row on the card.', 'Take signal — no mid');
  }

  const timerBlock = roundTimerExecuteBlockReason(endsInMs, slug);
  if (timerBlock) {
    return fail(timerBlock, 'Take signal — wait for bell');
  }

  if (requireExecutionEnter) {
    const execBlock = executionTakeBlockReason(execution);
    if (execBlock) {
      return fail(execBlock, `Take signal${executionTakeButtonSuffix(execution?.phase)}`);
    }
    const execLane = executionEnterLane(execution);
    if (execLane && execLane !== lane) {
      const execLabel = execLane === 'up' ? upLabel : downLabel;
      const cardLabel = lane === 'up' ? upLabel : downLabel;
      return fail(
        `Execution desk ENTER ${execLabel} — trade card is ${cardLabel}. Wait for lanes to match.`,
        'Take signal — lane mismatch',
      );
    }
  }

  const takeProfit01 =
    levels?.lane === lane && !levels.collapsed ? levels.takeProfit : null;
  const stopLoss01 = levels?.lane === lane && !levels.collapsed ? levels.stopLoss : null;

  const verb = lane === 'up' ? 'ENTER UP' : 'ENTER DOWN';
  const enterLine = `${verb} @ ${formatCentsLabelFrom01(entry01)}`;
  const buttonLabel = `Take signal · ${enterLine}`;

  return {
    canTake: true,
    disabledReason: null,
    lane,
    entry01,
    takeProfit01,
    stopLoss01,
    buttonLabel,
  };
}

export type ExecuteTakeSignalResult = {
  prefilled: boolean;
  buySubmitted: boolean;
  buySkippedReason?: string | null;
};

export type ExecuteTakeSignalOpts = {
  /** After prefill, queue a limit buy at card entry when the trade panel is ready. */
  submitBuy?: boolean;
  /** Outcome shares for the buy (preferred over sizeUsd). */
  sizeShares?: number;
  sizeUsd?: number;
  /** Turn on Auto-arm SL/TP + apply card levels before/after buy. */
  armSlTp?: boolean;
  /** Round bell remaining (ms); required for submitBuy — must be under 5:00. */
  endsInMs?: number | null;
};

/** Prefill trade panel + risk brackets + open slide (optional auto-buy). */
export function executeTakeSignal(
  plan: TakeSignalPlan,
  slug?: string | null,
  opts?: ExecuteTakeSignalOpts,
): ExecuteTakeSignalResult {
  const fail = (reason?: string | null): ExecuteTakeSignalResult => ({
    prefilled: false,
    buySubmitted: false,
    buySkippedReason: reason ?? null,
  });
  if (!plan.canTake || !plan.lane || plan.entry01 == null) return fail();
  if (typeof window === 'undefined') return fail();

  const lane = plan.lane;
  const entry01 = plan.entry01;
  const priceCents = price01ToWholeCents(entry01);

  if (opts?.armSlTp === true && plan.takeProfit01 != null && plan.stopLoss01 != null) {
    dispatchSignalRiskLevels({
      slug: slug?.trim() || undefined,
      lane,
      entry01,
      takeProfit01: plan.takeProfit01,
      stopLoss01: plan.stopLoss01,
      collapsed: false,
    });
    const tpCents = parseFloat(formatBracketCentsFrom01(plan.takeProfit01));
    const stopCents = parseFloat(formatBracketCentsFrom01(plan.stopLoss01));
    window.dispatchEvent(
      new CustomEvent('bpx-risk-prefill', {
        detail: {
          lane,
          tpCents,
          stopCents,
          tpCentsStr: formatBracketCentsFrom01(plan.takeProfit01),
          stopCentsStr: formatBracketCentsFrom01(plan.stopLoss01),
          arm: true,
          forceLevels: true,
          sizeShares: opts?.sizeShares,
        },
      }),
    );
  }

  window.dispatchEvent(
    new CustomEvent('bpx-trade-prefill', {
      detail: { lane, tone: 'ask' as const, price01: entry01, priceCents },
    }),
  );

  const slugTrim = slug?.trim() || '';
  if (slugTrim) {
    window.dispatchEvent(
      new CustomEvent(BPX_SIGNALS_LANE_SYNC_EVENT, {
        detail: { slug: slugTrim, lane, force: true },
      }),
    );
  }

  window.dispatchEvent(
    new CustomEvent(BPX_TRADE_PANEL_OPEN_EVENT, {
      detail: { lane, slug: slugTrim || undefined },
    }),
  );

  if (opts?.sizeShares != null && Number.isFinite(opts.sizeShares) && opts.sizeShares > 0) {
    window.dispatchEvent(
      new CustomEvent(BPX_TRADE_SYNC_SIZE_SHARES_EVENT, {
        detail: { sizeShares: opts.sizeShares },
      }),
    );
  }

  let buySubmitted = false;
  let buySkippedReason: string | null = null;
  if (opts?.submitBuy) {
    if (!roundTimerAllowsExecute(opts.endsInMs, slug)) {
      buySkippedReason = roundTimerExecuteBlockReason(opts.endsInMs, slug) ?? 'Wait for bell under 5:00.';
    } else {
      const sizeShares =
        opts.sizeShares != null && Number.isFinite(opts.sizeShares) && opts.sizeShares > 0
          ? opts.sizeShares
          : undefined;
      const sizeUsd =
        opts.sizeUsd != null && Number.isFinite(opts.sizeUsd) && opts.sizeUsd > 0 ? opts.sizeUsd : undefined;
      if (sizeShares == null && sizeUsd == null) {
        buySkippedReason = 'Enter a valid share size in the trade panel.';
      } else {
        dispatchDeskSubmitBuyOnce({
          slug: slug?.trim() || '',
          lane,
          price01: entry01,
          stopLoss01: opts?.armSlTp === true ? plan.stopLoss01 : null,
          takeProfit01: opts?.armSlTp === true ? plan.takeProfit01 : null,
          sizeShares,
          sizeUsd,
          armSlTp: opts?.armSlTp === true,
        });
        buySubmitted = true;
      }
    }
  }
  return { prefilled: true, buySubmitted, buySkippedReason };
}

let deskSubmitBuyTimer: ReturnType<typeof setTimeout> | null = null;
let lastDeskSubmitBuyKey = '';
let lastDeskSubmitBuyAt = 0;

/** One auto-buy request per lane+size+entry — prevents 6× buy from duplicate events / retries. */
export function dispatchDeskSubmitBuyOnce(detail: {
  slug: string;
  lane: 'up' | 'down';
  price01: number;
  stopLoss01?: number | null;
  takeProfit01?: number | null;
  sizeShares?: number;
  sizeUsd?: number;
  armSlTp?: boolean;
}): void {
  if (typeof window === 'undefined') return;
  const pxKey = Number.isFinite(detail.price01) ? detail.price01.toFixed(4) : '';
  const shKey =
    detail.sizeShares != null && Number.isFinite(detail.sizeShares) ? String(detail.sizeShares) : '';
  const key = `${detail.slug}|${detail.lane}|${shKey}|${pxKey}`;
  const now = Date.now();
  if (key === lastDeskSubmitBuyKey && now - lastDeskSubmitBuyAt < 12_000) return;
  lastDeskSubmitBuyKey = key;
  lastDeskSubmitBuyAt = now;
  if (deskSubmitBuyTimer != null) window.clearTimeout(deskSubmitBuyTimer);
  deskSubmitBuyTimer = window.setTimeout(() => {
    deskSubmitBuyTimer = null;
    window.dispatchEvent(
      new CustomEvent(BPX_TRADE_SUBMIT_BUY_EVENT, {
        detail: {
          lane: detail.lane,
          price01: detail.price01,
          stopLoss01: detail.stopLoss01,
          takeProfit01: detail.takeProfit01,
          sizeShares: detail.sizeShares,
          sizeUsd: detail.sizeUsd,
          armSlTp: detail.armSlTp === true,
        },
      }),
    );
  }, 100);
}
