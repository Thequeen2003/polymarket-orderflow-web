import { Fragment, type MouseEvent, type ReactElement, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ApiErr, MyFillRow } from './lib/api';
import {
  apiWsUrl,
  clobBook,
  health,
  lastTradePrice,
  tradeAvgEntry,
  tradeBalanceAllowance,
  tradeCancelOrder,
  tradeCreateOrderWithOpts,
  tradeGetOrder,
  tradeMarketOrderWithOpts,
  tradeMyFills,
  tradeOpenOrders,
  tradeUpdateBalanceAllowance,
} from './lib/api';
import { TradeSegmentedControl } from './tradeUi';
import {
  addPaperOrder,
  cancelPaperOrder,
  getPaperPosition,
  loadPaperAccount,
  loadPaperOrders,
  markToMarket,
  matchPaperOrders,
  paperTrade,
  PAPER_ORDERS_SYNC_EVENT,
  resetPaperAccount,
  resetPaperPositionsForTokens,
  setPaperCashUsd,
} from './paperTrading';
import { pickBookLevels, topOfBook } from './bookLevels';
import {
  appendTradeHistory,
  appendTradeHistoryWithId,
  loadTradeHistory,
  updateTradeHistoryRow,
  TRADE_HISTORY_CHANGED_EVENT,
  type TradeHistoryRow,
} from './tradeHistory';
import { playTradeClick, playTradeError, playTradeFill } from './tradeSounds';
import { buildBracketMomentumUi, buildOutcomeMomentumXs, type OutcomeMomentumXs } from './bracketMomentumReadout';
import { computeBookIntel } from './bookIntel';
import type { SpotPoint } from './SpotLevelChart';
import { buildBracketAutomationExplain, type BracketLegExplain } from './tradeAutomationExplain';
import { PAPER_ACCOUNT_SYNC_EVENT } from './paperAccountSync';
import { paperSettlementCaption } from './paperMarketSettlement';
import { parseRestingOrderSnapshot } from './orderStatusParse';
import { floorShares4, floorSharesWhole, floorUsdWhole, roundPrice01, roundShares4, roundUsd2 } from './tradingRound';
import { computePreBuyTpOutlook, computeHeldLaneTpOutlook, adjustTpOutlookWithMomentum } from './positionTpOutlook';
import { PositionTpOutlookCard } from './PositionTpOutlookCard';
import { computePositionBracketCall } from './positionBracketCall';
import { buildPositionDeskSignal } from './positionDeskSignal';
import { PositionDeskSignalStrip } from './PositionDeskSignalStrip';
import { useDeskMomentumTracker } from './useDeskMomentumTracker';
import { bullpenOutcomeForOrder } from './bullpenOutcome';
import { formatTradeApiError } from './formatTradeApiError';
import { bracketCentsStrTo01 } from './bracketCentsInput';
import {
  bracketAutomationAsk01,
  bracketAutomationBid01,
  bracketTpMark01,
  evaluateStopLossCross,
  evaluateTakeProfitCross,
  evaluateTrailingProfitExit,
  stopLossExecLimit01,
  takeProfitExecLimit01,
} from './bracketTrigger';
import {
  patchFromGetOrderMatch,
  reconcileLiveOrderFromTape,
  rowShowsExchangeFill,
  rowTapeConfirmed,
  type TapeConfirmedFill,
} from './liveTradeTruth';
import { syncSentRowsFromOpenOrders } from './liveOpenOrderSync';
import {
  confirmedExchangeFillFromRow,
  fillPrice01FromRow,
  formatFillCents,
  limitPrice01FromRow,
  mirrorFillPriceOnRow,
} from './tradeFillPrice';
import {
  cancelAllLiveOrders,
  cancelOneLiveOrder,
  liveRowCancelable,
} from './liveOrderCancel';
import { filledSharesFromRow, netMatchedSharesFromHistory, remainingSharesFromRow } from './tradeHistoryDisplay';
import { LiveTradingHud } from './LiveTradingHud';
import { LivePositionStrip } from './LivePositionStrip';
import { marketBuyUsdFromIntent } from './liveAggressiveBuy';
import { submitLiveBracketExit } from './liveBracketExit';
import { resolveLiveLaneShares, resolveLiveOutcomeShares } from './livePositionTruth';
import { resolveLiveSellOutcome } from './liveSellOutcome';
import { loadTradeAccountMode, saveTradeAccountMode } from './tradeAccountMode';
import { extractOrderIdFromClobPayload, unwrapTradeActionData } from './tradeExecutionMeta';
import { reconcileTradeHistoryFromClob } from './reconcileTradeHistoryFromClob';
import {
  BPX_SIGNAL_RISK_LEVELS_EVENT,
  cloneSignalRiskSnapshot,
  formatBracketCentsFrom01,
  formatBracketCentsFromNumber,
  resolveArmRiskCentsAfterBuy,
  resolveArmRiskCentsForEntry,
  spreadBracketFromFillPrice01,
  type SignalRiskLevelsDetail,
  type SignalRiskSnapshot,
} from './armRiskFromSignal';
import {
  BPX_BRACKET_DRAG_EVENT,
  BPX_BRACKET_OVERLAY_EVENT,
  type BpxBracketDragDetail,
  BPX_BRACKET_ARM_REQUEST_EVENT,
  type BpxBracketArmRequestDetail,
  type BpxBracketOverlayDetail,
} from './bpxBracketOverlayEvent';
import {
  PTB_CROSS_IMMINENT_EVENT,
  SECTIONAL_BOOM_EVENT,
  SECTIONAL_DECISION_EVENT,
  type PtbCrossImminentDetail,
  type SectionalBoomDetail,
  type SectionalDecisionDetail,
} from './sectionalDecisionEvent';
import {
  BPX_DESK_TOAST_EVENT,
  BPX_TRADE_SUBMIT_BUY_EVENT,
  BPX_TRADE_SUBMIT_SELL_EVENT,
  BPX_TRADE_SYNC_SIZE_SHARES_EVENT,
} from './takeSignalDesk';
import {
  BPX_RESET_PHANTOM_POSITION_EVENT,
  dispatchSignalsClearHold,
  isOutcomePositionFlat,
  type ResetPhantomPositionDetail,
} from './signalsDeskHold';
import { dispatchOutcomePositions } from './signalsDeskPosition';
import { isExternallyFlatPosition } from './externalPositionFlat';
import { BracketTriggerInput } from './BracketTriggerInput';
import { loadBracketLevelsDraft, saveBracketLevelsDraft } from './bracketLevelDraft';
import {
  buildQuoteAssistTargets,
  EMERGENCY_STOP_BUNDLE_PREFS_KEY,
  loadEmergencyStopBundlePrefs,
  readStagedBuyBundleLevels,
  resolveAutoBundleChaseLevels,
  flushPendingBracketDraft,
  EMPTY_BRACKET_INPUT_DRAFT,
  type BracketInputDraftState,
  resolveStagedBuyBundleLevels,
  shouldChaseAutoBundleLevel,
  shouldPrefillBuyBundleTpOnClick,
  type EmergencyStopBundlePrefs,
} from './buyBundleStaging';
import { loadNowPriceDeskScalpPrefs, NOW_PRICE_DESK_SCALP_PREFS_EVENT, resolveGlobalStopForEntry, deskTpBelowEntry, liveDeskTp01FromBook } from './nowPriceDeskScalp';
import { useTradeFloatChrome } from './TradeFloatChromeContext';
import { readSlideDockTab, writeSlideDockTab, type SlideDockTab } from './tradeSlideDock';
import { resolveBracketRef } from './lib/bracketLevelInput';
import { ShouldBuyCard } from './ShouldBuyCard';
import { pickStrongerBuyAdvisory, shouldBuyWhichSide, type BuySideAdvisory } from './shouldBuyWhichSide';

function isOk<T>(res: { ok: boolean } & Record<string, unknown>): res is { ok: true; data: T } {
  return res.ok === true;
}

type StopLossConfig = {
  enabled: boolean;
  /** Trigger when ref price is <= stop01 (0..1). */
  stop01: number;
  /** Submit limit sell at limit01 (0..1). */
  limit01: number;
  /** Shares to sell (4dp floored at send time). */
  shares: number;
  /** One-field mode: limit tracks stop; shares track position. */
  simple?: boolean;
  /** Also watch best ask + fast REST book poll; trigger if bid or ask crosses down through stop. */
  dualBook?: boolean;
};

type TakeProfitConfig = {
  enabled: boolean;
  /** Trigger when ref price is >= take01 (0..1) — long take-profit. */
  take01: number;
  /** Submit limit sell at limit01 (0..1). */
  limit01: number;
  shares: number;
  simple?: boolean;
  /** Poll book; trigger if bid or ask crosses up through take level. */
  dualBook?: boolean;
};

type BuyBundleLaneDraft = { sl: string; tp: string };

const EMPTY_BUY_BUNDLE_BY_LANE: { up: BuyBundleLaneDraft; down: BuyBundleLaneDraft } = {
  up: { sl: '', tp: '' },
  down: { sl: '', tp: '' },
};

function emergencyStopFillToast(sl: string, tp?: string): string {
  if (sl && tp) return `Emergency stop ${sl}¢ armed on fill · TP ${tp}¢`;
  if (sl) return `Emergency stop armed on fill · ${sl}¢`;
  if (tp) return `Take-profit armed on fill · ${tp}¢`;
  return 'Brackets armed on fill';
}

/** Pre-buy emergency stop (¢) per UP/DOWN — survives refresh; arms on next buy fill for that lane. */
const EMERGENCY_STOP_BY_LANE_KEY = 'pm:emergencyStopByLane:v1';

function loadEmergencyStopByLane(): { up: string; down: string } {
  try {
    const raw = window.localStorage.getItem(EMERGENCY_STOP_BY_LANE_KEY);
    if (!raw) return { up: '', down: '' };
    const j = JSON.parse(raw) as { up?: unknown; down?: unknown };
    return {
      up: typeof j.up === 'string' ? j.up : '',
      down: typeof j.down === 'string' ? j.down : '',
    };
  } catch {
    return { up: '', down: '' };
  }
}

function saveEmergencyStopByLane(draft: { up: string; down: string }): void {
  try {
    window.localStorage.setItem(EMERGENCY_STOP_BY_LANE_KEY, JSON.stringify(draft));
  } catch {
    /* quota / private mode */
  }
}

function saveEmergencyStopForLane(lane: 'up' | 'down', slCents: string): void {
  const prev = loadEmergencyStopByLane();
  prev[lane] = slCents.trim();
  saveEmergencyStopByLane(prev);
}

function stopLossStorageKey(tokenId: string): string {
  return `pm:stoploss:v1:${tokenId.trim()}`;
}

function takeProfitStorageKey(tokenId: string): string {
  return `pm:takeprofit:v1:${tokenId.trim()}`;
}

function loadStopLossConfigFromStorage(tokenId: string): StopLossConfig | null {
  const tok = tokenId.trim();
  if (!tok) return null;
  try {
    const raw = window.localStorage.getItem(stopLossStorageKey(tok));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Partial<StopLossConfig> & Record<string, unknown>;
    if (o.enabled !== true) return null;
    const stop01 = typeof o.stop01 === 'number' && Number.isFinite(o.stop01) ? o.stop01 : null;
    const limit01 = typeof o.limit01 === 'number' && Number.isFinite(o.limit01) ? o.limit01 : null;
    const shares = typeof o.shares === 'number' && Number.isFinite(o.shares) ? o.shares : null;
    if (stop01 == null || limit01 == null || shares == null || shares <= 0) return null;
    return {
      enabled: true,
      stop01,
      limit01,
      shares,
      simple: o.simple !== false,
      dualBook: o.dualBook === true,
    };
  } catch {
    return null;
  }
}

function loadTakeProfitConfigFromStorage(tokenId: string): TakeProfitConfig | null {
  const tok = tokenId.trim();
  if (!tok) return null;
  try {
    const raw = window.localStorage.getItem(takeProfitStorageKey(tok));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Partial<TakeProfitConfig> & Record<string, unknown>;
    if (o.enabled !== true) return null;
    const take01 = typeof o.take01 === 'number' && Number.isFinite(o.take01) ? o.take01 : null;
    const limit01 = typeof o.limit01 === 'number' && Number.isFinite(o.limit01) ? o.limit01 : null;
    const shares = typeof o.shares === 'number' && Number.isFinite(o.shares) ? o.shares : null;
    if (take01 == null || limit01 == null || shares == null || shares <= 0) return null;
    return {
      enabled: true,
      take01,
      limit01,
      shares,
      simple: o.simple !== false,
      dualBook: o.dualBook === true,
    };
  } catch {
    return null;
  }
}

function saveStopLossConfigToStorage(tokenId: string, cfg: StopLossConfig): void {
  const tok = tokenId.trim();
  if (!tok) return;
  try {
    window.localStorage.setItem(stopLossStorageKey(tok), JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

function saveTakeProfitConfigToStorage(tokenId: string, cfg: TakeProfitConfig): void {
  const tok = tokenId.trim();
  if (!tok) return;
  try {
    window.localStorage.setItem(takeProfitStorageKey(tok), JSON.stringify(cfg));
  } catch {
    /* ignore */
  }
}

function resolveArmedStopLoss(args: {
  automationTok: string;
  enabled: boolean;
  stopCents: string;
  limitCents: string;
  sharesStr: string;
  simple: boolean;
  dualBook: boolean;
  laneDraftSl: string;
}): StopLossConfig | null {
  if (!args.enabled) return null;
  let stop01 = bracketCentsStrTo01(args.stopCents.trim());
  let limit01 = bracketCentsStrTo01(args.limitCents.trim());
  if (stop01 == null && args.laneDraftSl.trim()) stop01 = bracketCentsStrTo01(args.laneDraftSl);
  if (limit01 == null && stop01 != null) limit01 = stop01;
  let shares = Number(args.sharesStr);
  const stored = loadStopLossConfigFromStorage(args.automationTok);
  if (stop01 == null && stored?.enabled) stop01 = stored.stop01;
  if (limit01 == null && stored?.enabled) limit01 = stored.limit01;
  if (!(shares > 0) && stored?.enabled) shares = stored.shares;
  if (stop01 == null || limit01 == null || !Number.isFinite(shares) || shares <= 0) return null;
  return {
    enabled: true,
    stop01: clamp01(stop01),
    limit01: clamp01(limit01),
    shares,
    simple: args.simple,
    dualBook: args.dualBook,
  };
}

function resolveArmedTakeProfit(args: {
  automationTok: string;
  enabled: boolean;
  takeCents: string;
  limitCents: string;
  sharesStr: string;
  simple: boolean;
  dualBook: boolean;
  laneDraftTp: string;
}): TakeProfitConfig | null {
  if (!args.enabled) return null;
  let take01 = bracketCentsStrTo01(args.takeCents.trim());
  let limit01 = bracketCentsStrTo01(args.limitCents.trim());
  if (take01 == null && args.laneDraftTp.trim()) take01 = bracketCentsStrTo01(args.laneDraftTp);
  if (limit01 == null && take01 != null) limit01 = take01;
  let shares = Number(args.sharesStr);
  const stored = loadTakeProfitConfigFromStorage(args.automationTok);
  if (take01 == null && stored?.enabled) take01 = stored.take01;
  if (limit01 == null && stored?.enabled) limit01 = stored.limit01;
  if (!(shares > 0) && stored?.enabled) shares = stored.shares;
  if (take01 == null || limit01 == null || !Number.isFinite(shares) || shares <= 0) return null;
  return {
    enabled: true,
    take01: clamp01(take01),
    limit01: clamp01(limit01),
    shares,
    simple: args.simple,
    dualBook: args.dualBook,
  };
}

function bracketAutomationActive(args: {
  bracketPollToken: string | null;
  stopLossEnabled: boolean;
  takeProfitEnabled: boolean;
}): boolean {
  const armedTok = args.bracketPollToken?.trim();
  if (armedTok) {
    const sl = loadStopLossConfigFromStorage(armedTok);
    const tp = loadTakeProfitConfigFromStorage(armedTok);
    return Boolean(sl?.enabled || tp?.enabled);
  }
  return args.stopLossEnabled || args.takeProfitEnabled;
}

/** UP/DOWN outcome label with directional arrow stacked above. */
function OutcomeLaneHeader(props: {
  lane: 'up' | 'down';
  label: string;
  /** Sell flow prefixes “Sell” on the label row. */
  mode?: 'buy' | 'sell';
  momentum?: OutcomeMomentumXs | null;
}): ReactElement {
  const { lane, label, mode = 'buy', momentum } = props;
  const arrowCls = lane === 'up' ? 'text-emerald-400' : 'text-rose-400';
  const labelCls =
    mode === 'sell' ? 'text-[11px] font-black uppercase tracking-wide text-rose-200' : 'text-[11px] font-semibold uppercase tracking-wide text-zinc-500';
  const momCls =
    momentum?.tone === 'up'
      ? 'text-emerald-400/95'
      : momentum?.tone === 'down'
        ? 'text-rose-400/95'
        : 'text-zinc-500';
  return (
    <div className="flex flex-col gap-0.5">
      <span className={`text-xl font-black leading-none ${arrowCls}`} aria-hidden>
        {lane === 'up' ? '↑' : '↓'}
      </span>
      <span className={labelCls}>{mode === 'sell' ? `Sell ${label}` : label}</span>
      {momentum ? (
        <span className={`text-xs font-mono tabular-nums leading-tight ${momCls}`} title="15s prob momentum">
          <span aria-hidden>{momentum.arrow} </span>
          {momentum.deltaLabel}
          {momentum.speedLabel ? <span className="text-zinc-600"> · {momentum.speedLabel}</span> : null}
        </span>
      ) : (
        <span className="text-xs font-mono text-zinc-600">—</span>
      )}
    </div>
  );
}

function parseUsdcBalance(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return roundUsd2(n);
}

function parseOutcomeSharesBalance(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return floorShares4(n);
}

function fmtPaperTradeError(code: string): string {
  if (code === 'insufficient_cash') return 'Insufficient cash — pick a smaller size or tap Max.';
  return code;
}

/** Set buy amount to a fraction of available cash (replaces, never adds on top). */
function buyAmountFromCashPct(args: {
  pct: number;
  unit: 'dollars' | 'shares';
  cashUsd: number;
  price01: number | null;
}): string {
  const { pct, unit, cashUsd, price01 } = args;
  if (!(cashUsd > 0) || !(pct > 0)) return '0';
  const budget = cashUsd * Math.min(1, pct);
  if (unit === 'dollars') {
    const v = floorUsdWhole(budget);
    return v > 0 ? String(v) : '0';
  }
  if (price01 == null || !(price01 > 0)) return '0';
  const sh = floorSharesWhole(budget / price01);
  return sh > 0 ? String(sh) : '0';
}

function clampBuyUsdPreset(usd: number, cashUsd: number): string {
  if (!(cashUsd > 0)) return '0';
  const v = floorUsdWhole(Math.min(usd, cashUsd));
  return v > 0 ? String(v) : '0';
}

/** Shrink buy amount to fit available cash (returns unchanged when already valid). */
function clampBuyAmountWithinCash(args: {
  amountStr: string;
  unit: 'dollars' | 'shares';
  cashUsd: number;
  price01: number | null;
}): string {
  const n = Number(args.amountStr);
  if (!Number.isFinite(n) || n <= 0 || !(args.cashUsd > 0)) return args.amountStr;
  if (args.unit === 'dollars') {
    if (n <= args.cashUsd + 0.01) return args.amountStr;
    return clampBuyUsdPreset(n, args.cashUsd);
  }
  const px = args.price01;
  if (px == null || !(px > 0)) return args.amountStr;
  const cost = n * px;
  if (cost <= args.cashUsd + 0.015) return args.amountStr;
  const maxSh = floorSharesWhole(args.cashUsd / px);
  return maxSh > 0 ? String(maxSh) : '0';
}

/** Worst-case buy price for cash sizing — limit first, then quote, then mid. */
function resolveBuySizingPrice01(args: {
  limit01: number | null | undefined;
  previewPrice01: number | null | undefined;
  mid01: number | null | undefined;
}): number | null {
  for (const p of [args.limit01, args.previewPrice01, args.mid01]) {
    if (p != null && Number.isFinite(p) && p > 0 && p < 1) return p;
  }
  return null;
}

function buyAmountExceedsCash(args: {
  amtNum: number;
  unit: 'dollars' | 'shares';
  cashUsd: number;
  price01: number | null;
}): boolean {
  if (!(args.cashUsd > 0) || !(args.amtNum > 0)) return false;
  if (args.unit === 'dollars') return args.amtNum > args.cashUsd + 0.01;
  if (args.price01 == null || !(args.price01 > 0)) return false;
  return args.amtNum * args.price01 > args.cashUsd + 0.015;
}

function fmtCents(p01: number | null): string {
  if (p01 == null) return '—';
  // Always show whole cents (no ".5").
  return `${Math.round(p01 * 100)}¢`;
}

/** CLOB `last-trade-price` returns a decimal string (0..1) or occasionally cents as a number string. */
function parseClobPriceStringTo01(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 1) return roundPrice01(n);
  if (n <= 100) return roundPrice01(n / 100);
  return null;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function centsStrTo01(raw: string): number | null {
  return bracketCentsStrTo01(raw);
}

/** Re-evaluate armed SL/TP this often (chart mid can move without bid poll changing). */
const BRACKET_EVAL_MS = 250;
/** CLOB top-of-book poll interval while SL/TP armed. */
const BRACKET_POLL_MS = 150;
/** Min gap between live bracket exit attempts when the prior exit did not fill. */
const BRACKET_EXIT_RETRY_MS = 600;

function bracketExitCooldownActive(lastAttemptMs: number): boolean {
  return lastAttemptMs > 0 && Date.now() - lastAttemptMs < BRACKET_EXIT_RETRY_MS;
}

/** After cooldown, allow another exit attempt if the prior bracket sell did not fill. */
function bracketExitReadyToFire(args: {
  tok: string;
  lastFireTokRef: { current: string | null };
  lastAttemptMsRef: { current: number };
}): boolean {
  if (args.lastFireTokRef.current === args.tok) {
    if (bracketExitCooldownActive(args.lastAttemptMsRef.current)) return false;
    args.lastFireTokRef.current = null;
  }
  return true;
}

/** Clear edge memory so the next bid tick can cross (re-arm, tap-to-arm, or level change). */
function resetStopLossBracketMemory(refs: {
  lastCross: { current: number | null };
  prevBid: { current: number | null };
  prevAsk: { current: number | null };
  prevStripMid: { current: number | null };
  lastFireTok: { current: string | null };
  fireLock: { current: boolean };
}): void {
  refs.lastCross.current = null;
  refs.prevBid.current = null;
  refs.prevAsk.current = null;
  refs.prevStripMid.current = null;
  refs.lastFireTok.current = null;
  refs.fireLock.current = false;
}

function resetTakeProfitBracketMemory(refs: {
  lastCross: { current: number | null };
  prevBid: { current: number | null };
  prevAsk: { current: number | null };
  prevStripMid: { current: number | null };
  lastFireTok: { current: string | null };
  fireLock: { current: boolean };
}): void {
  refs.lastCross.current = null;
  refs.prevBid.current = null;
  refs.prevAsk.current = null;
  refs.prevStripMid.current = null;
  refs.lastFireTok.current = null;
  refs.fireLock.current = false;
}

/** Book top for spread; mirrors entry-anchored risk assist (SignalsTradePanel). */
function BracketLegReadout(props: { leg: BracketLegExplain }): ReactElement {
  const { leg } = props;


  return (
    <div className="rounded-lg border border-zinc-800/60 bg-black/20 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full border px-2 py-0.5 text-[9px] font-black ${
            leg.label === 'SL' ? 'border-rose-800/40 bg-rose-950/20 text-rose-100' : 'border-emerald-800/40 bg-emerald-950/20 text-emerald-100'
          }`}
        >
          {leg.label}
        </span>
        <span className="text-[10px] leading-snug text-zinc-400">{leg.modeLine}</span>
      </div>
      <ul className="mt-1.5 list-inside list-disc space-y-0.5 text-[10px] text-zinc-500">
        {leg.watchLines.map((line, i) => (
          <li key={`w-${i}`}>{line}</li>
        ))}
      </ul>
      {leg.distances.length ? (
        <ul className="mt-1 list-inside list-disc space-y-0.5 text-[10px] text-zinc-400">
          {leg.distances.map((line, i) => (
            <li key={`d-${i}`}>{line}</li>
          ))}
        </ul>
      ) : null}
      {leg.blockers.length ? (
        <ul className="mt-1.5 space-y-0.5 rounded-md border border-amber-800/30 bg-amber-950/10 px-2 py-1.5 text-[10px] text-amber-100/90">
          {leg.blockers.map((line, i) => (
            <li key={`b-${i}`} className="leading-snug">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const ARM_RISK_AFTER_BUY_KEY = 'pm:armRiskAfterBuy:v1';

type ArmRiskAfterBuyPrefs = {
  /** Master switch — when off, buys never auto-arm SL/TP. */
  autoArmEnabled: boolean;
  armSl: boolean;
  armTp: boolean;
  useSignalLevels: boolean;
};

function resolveArmFlags(
  base: ArmRiskAfterBuyPrefs,
  override?: Partial<Pick<ArmRiskAfterBuyPrefs, 'armSl' | 'armTp' | 'useSignalLevels'>>,
): Pick<ArmRiskAfterBuyPrefs, 'armSl' | 'armTp' | 'useSignalLevels'> {
  if (override != null) {
    return {
      armSl: override.armSl === true,
      armTp: override.armTp === true,
      useSignalLevels: override.useSignalLevels ?? base.useSignalLevels,
    };
  }
  if (!base.autoArmEnabled) {
    return { armSl: false, armTp: false, useSignalLevels: base.useSignalLevels };
  }
  return { armSl: base.armSl, armTp: base.armTp, useSignalLevels: base.useSignalLevels };
}

function loadArmRiskAfterBuyPrefs(): ArmRiskAfterBuyPrefs {
  try {
    const raw = window.localStorage.getItem(ARM_RISK_AFTER_BUY_KEY);
    if (!raw) return { autoArmEnabled: false, armSl: false, armTp: false, useSignalLevels: true };
    const j = JSON.parse(raw) as {
      autoArmEnabled?: unknown;
      armSl?: unknown;
      armTp?: unknown;
      useSignalLevels?: unknown;
    };
    const armSl = j.armSl === true;
    const armTp = j.armTp === true;
    const autoArmEnabled =
      typeof j.autoArmEnabled === 'boolean' ? j.autoArmEnabled : armSl || armTp;
    return {
      autoArmEnabled,
      armSl,
      armTp,
      useSignalLevels: j.useSignalLevels !== false,
    };
  } catch {
    return { autoArmEnabled: false, armSl: false, armTp: false, useSignalLevels: true };
  }
}

function priceAuditNote(quoted: number | null, submitted: number | null, fill: number | null): string | undefined {
  const tol = 0.0025;
  if (fill != null && quoted != null && Math.abs(quoted - fill) > tol) {
    return `quoted vs fill Δ${(Math.abs(quoted - fill) * 100).toFixed(2)}¢`;
  }
  if (fill != null && submitted != null && Math.abs(submitted - fill) > tol) {
    return `submitted vs fill Δ${(Math.abs(submitted - fill) * 100).toFixed(2)}¢`;
  }
  return undefined;
}

function mergeRoundTripMs(serverMs: number | null | undefined, clientMs: number): number {
  if (serverMs != null && Number.isFinite(serverMs) && serverMs > 0) return Math.round(serverMs);
  return clientMs;
}

function fmtUsdCents(v: number | null): string {
  if (v == null) return '—';
  const dollars = v / 100;
  const sign = dollars < 0 ? '-' : '';
  return `${sign}$${Math.abs(dollars).toFixed(2)}`;
}

function asNum(x: unknown): number | null {
  const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
}

function asStr(x: unknown): string | null {
  return typeof x === 'string' && x.trim() ? x : null;
}

function orderIdFromRow(o: unknown): string | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  // CLOB `OpenOrder` uses `id`; other payloads use orderID / order_id.
  return asStr(r.id ?? r.orderID ?? r.orderId ?? r.order_id);
}

function orderSideFromRow(o: unknown): 'buy' | 'sell' | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const s = String(r.side ?? '').toLowerCase();
  return s === 'buy' || s === 'sell' ? (s as 'buy' | 'sell') : null;
}

/** CLOB prices are usually 0–1; some payloads use 1–100 (¢). */
function clobPriceRawTo01(raw: number | null): number | null {
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
  if (raw <= 1) return raw;
  if (raw <= 100) return raw / 100;
  return null;
}

function orderPrice01FromRow(o: unknown): number | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const n = asNum(r.price ?? r.price01);
  return clobPriceRawTo01(n);
}

function orderSizeFromRow(o: unknown): number | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  return asNum(r.original_size ?? r.originalSize ?? r.size ?? r.total_size ?? r.totalSize);
}

function orderRemainingFromRow(o: unknown): number | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const rem = asNum(r.remaining ?? r.sizeRemaining ?? r.remaining_size ?? r.remainingSize);
  if (rem != null) return rem;
  const size = orderSizeFromRow(o);
  const matched = asNum(r.size_matched ?? r.sizeMatched ?? r.matched_size ?? r.matchedSize);
  if (size != null && matched != null) return Math.max(0, size - matched);
  return null;
}

function orderCreatedAtFromRow(o: unknown): string | number | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const s = asStr(r.createdAt ?? r.created_at ?? r.timestamp);
  if (s) return s;
  const n = asNum(r.created_at);
  if (n == null || n <= 0) return null;
  // CLOB uses unix seconds for `created_at` on open orders; normalize to ms for `fmtWhen`.
  return n < 1e12 ? n * 1000 : n;
}

function orderTokenIdFromRow(o: unknown): string | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const s = asStr(r.asset_id ?? r.assetId ?? r.token_id ?? r.tokenId ?? r.tokenID);
  return s ? s.trim() : null;
}

function fmtWhen(v: string | number | null | undefined): string {
  if (v == null) return '—';
  const ms = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(ms)) {
    const s = String(v);
    return s.length > 28 ? `${s.slice(0, 28)}…` : s;
  }
  const d = new Date(ms);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const SHARES_FMT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const SHARES_FULL_FMT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4, minimumFractionDigits: 0 });
const SHARES_COMPACT_FMT = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 2,
});

function fmtShares(shares: number | null, style: 'full' | 'compact' = 'compact'): string {
  if (shares == null) return '—';
  if (!Number.isFinite(shares)) return '—';
  const abs = Math.abs(shares);
  if (style === 'full') return SHARES_FULL_FMT.format(shares);
  if (style === 'compact' && abs >= 10_000) return SHARES_COMPACT_FMT.format(shares);
  return SHARES_FMT.format(shares);
}

export type SignalsTradePanelProps = {
  marketSlug?: string;
  marketQuestion?: string;
  /** Gamma market row — used for resolved-market paper settlement banner ($1/sh winner). */
  gammaMarket?: unknown | null;
  /** Recent probability mids (same feed as Signals charts) — drives momentum copy next to SL/TP. */
  probMomentumUp?: SpotPoint[] | null;
  probMomentumDown?: SpotPoint[] | null;
  upLabel: string;
  downLabel: string;
  upToken: string;
  downToken: string;
  upMid: number | null;
  downMid: number | null;
  /** CLOB mid when chart / implied series has not warmed up yet — needed for live market sizing. */
  bookMidUp?: number | null;
  bookMidDown?: number | null;
  /** Best bid / ask for executable quote (buy→ask, sell→bid). Optional; falls back to mid. */
  bookTouchUp?: { bestBid: number | null; bestAsk: number | null } | null;
  bookTouchDown?: { bestBid: number | null; bestAsk: number | null } | null;
  /** Full books (depth) for pick-mode liquidity selection. */
  bookUp?: unknown | null;
  bookDown?: unknown | null;
  /** Optional: USD spot vs PTB context to keep trade UI in sync with chart language. */
  ptbContext?: {
    ptbUsd: number;
    bandUsd: number;
    position: 'ABOVE' | 'BELOW' | 'AT';
    structureEvent?: string;
    structureEventLabel?: string;
    controlSignal?: string;
    controlBlurb?: string;
    slopeUsdPerSec: number;
    slopeUsdPerMin?: number;
    readinessState?: 'WAIT' | 'SETUP' | 'ENTER';
    readinessLane?: 'up' | 'down' | null;
    readinessWhy?: string | null;
  } | null;
  /** Optional: tiered entry/exit copy from Signals desk (same playbook as chart tab). */
  executionBrief?: {
    tier: 'A' | 'B' | 'C' | 'AVOID';
    headline: string;
    enter: string[];
    exit: string[];
    composite: string;
    flags: string[];
    spreadCents: number | null;
    footnote: string;
  } | null;
  /** Optional: ms until market end — tightens TP odds near expiry. */
  endsInMs?: number | null;
  /** Optional: PTB cross probability (0..1) from spot machine. */
  crossProb?: number | null;
  lane?: 'up' | 'down';
  onLaneChange?: (lane: 'up' | 'down') => void;
  /** Fused advisory from Signals desk (auto-ask). Falls back to book mids when null. */
  buySideAdvisory?: BuySideAdvisory | null;
  visualStyle?: 'default' | 'sidebar' | 'slide';
};

/**
 * Signals tab: order entry (buy/sell, limit/touch, amounts) against Polymarket CLOB via API.
 */
export function SignalsTradePanel(props: SignalsTradePanelProps): ReactElement {
  const {
    marketSlug,
    marketQuestion,
    gammaMarket = null,
    probMomentumUp = null,
    probMomentumDown = null,
    upLabel,
    downLabel,
    upToken,
    downToken,
    upMid,
    downMid,
    bookMidUp,
    bookMidDown,
    bookTouchUp,
    bookTouchDown,
    bookUp = null,
    bookDown = null,
    ptbContext = null,
    executionBrief = null,
    endsInMs = null,
    crossProb = null,
    lane: controlledLane,
    onLaneChange,
    buySideAdvisory: buySideAdvisoryProp = null,
    visualStyle = 'default',
  } = props;
  const idBase = useId();
  const idAmount = `${idBase}-amount`;
  const idLimitBuy = `${idBase}-limit-buy`;
  const idLimitSell = `${idBase}-limit-sell`;
  const idSellQty = `${idBase}-sell-qty`;

  const [action, setAction] = useState<'buy' | 'sell'>('buy');
  const [laneState, setLaneState] = useState<'up' | 'down'>(controlledLane ?? 'up');
  const lane = controlledLane ?? laneState;
  const label = lane === 'up' ? upLabel : downLabel;
  const token = lane === 'up' ? upToken : downToken;
  const [execMode, setExecMode] = useState<'touch' | 'limit'>('touch');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [unit, setUnit] = useState<'dollars' | 'shares'>('dollars');
  const [accountMode, setAccountMode] = useState<'paper' | 'live'>(() => loadTradeAccountMode());
  const [tradingReady, setTradingReady] = useState<boolean | null>(null);
  const [tradingVia, setTradingVia] = useState<'bullpen' | 'clob' | null>(null);
  const [paperAccount, setPaperAccount] = useState(() => loadPaperAccount());
  const [paperOrders, setPaperOrders] = useState(() => loadPaperOrders());
  const [historyRows, setHistoryRows] = useState<TradeHistoryRow[]>(() => loadTradeHistory());
  const [pendingPos, setPendingPos] = useState<
    | {
        token: string;
        side: 'buy' | 'sell';
        kind: 'shares';
        shares: number;
        price01: number | null;
        status: 'submitting' | 'live' | 'filled' | 'partial' | 'rejected';
        createdAt: number;
      }
    | {
        token: string;
        side: 'buy';
        kind: 'usd';
        usd: number;
        price01: number | null;
        status: 'submitting' | 'live' | 'filled' | 'partial' | 'rejected';
        createdAt: number;
      }
    | null
  >(null);
  const [openOrders, setOpenOrders] = useState<unknown[]>([]);
  const [openOrdersLoading, setOpenOrdersLoading] = useState(false);
  const [openOrdersErr, setOpenOrdersErr] = useState<string | null>(null);
  const [openOrdersScope, setOpenOrdersScope] = useState<'token' | 'all'>('token');
  const [myFills, setMyFills] = useState<MyFillRow[]>([]);
  const [myFillsErr, setMyFillsErr] = useState<string | null>(null);

  const [amount, setAmount] = useState('10');
  const [sellQty, setSellQty] = useState('');
  const [limitPriceCents, setLimitPriceCents] = useState('');
  const [buyEntryMode, setBuyEntryMode] = useState<'single' | 'passive'>('single');
  const [passiveTargetCents, setPassiveTargetCents] = useState('74');
  const [passiveTotalShares, setPassiveTotalShares] = useState('60');
  const [passiveChunks, setPassiveChunks] = useState('8');
  const [passiveLevels, setPassiveLevels] = useState('74,73');
  const [pickSelected, setPickSelected] = useState<Record<string, { price01: number; maxShares: number; takeShares: string }>>({});
  const [pickAutoCancelMs] = useState('1500');
  const [buyNowShares, setBuyNowShares] = useState('5');
  const [buyBidCents, setBuyBidCents] = useState('');

  const [busySubmit, setBusySubmit] = useState(false);
  const [busyRefresh, setBusyRefresh] = useState(false);
  const [maxBuyBusy, setMaxBuyBusy] = useState(false);
  const [submitAbort, setSubmitAbort] = useState<AbortController | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [paperCashEdit, setPaperCashEdit] = useState('75.00');

  const [availUsdc, setAvailUsdc] = useState<number | null>(null);
  const [balUp, setBalUp] = useState<number | null>(null);
  const [balDown, setBalDown] = useState<number | null>(null);
  const [balLoading, setBalLoading] = useState(false);
  const [balError, setBalError] = useState<string | null>(null);
  const [avgEntryUp, setAvgEntryUp] = useState<number | null>(null);
  const [avgEntryDown, setAvgEntryDown] = useState<number | null>(null);
  /** Bullpen / Data API position size (often ahead of CLOB conditional balance). */
  const [posSharesUp, setPosSharesUp] = useState<number | null>(null);
  const [posSharesDown, setPosSharesDown] = useState<number | null>(null);
  const [avgEntryErr, setAvgEntryErr] = useState<string | null>(null);
  const [lastTradeUp01, setLastTradeUp01] = useState<number | null>(null);
  const [lastTradeDown01, setLastTradeDown01] = useState<number | null>(null);
  const [flashToast, setFlashToast] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const toastIdRef = useRef(0);
  const toastTimersRef = useRef<Map<number, number>>(new Map());
  const [toasts, setToasts] = useState<Array<{ id: number; kind: 'ok' | 'err' | 'info'; message: string }>>([]);

  const dismissToast = useCallback((id: number) => {
    setToasts((xs) => xs.filter((t) => t.id !== id));
    const t = toastTimersRef.current.get(id);
    if (t != null) window.clearTimeout(t);
    toastTimersRef.current.delete(id);
  }, []);

  const pushToast = useCallback(
    (kind: 'ok' | 'err' | 'info', message: string, ttlMs = 5200) => {
      const id = (toastIdRef.current += 1);
      setToasts((xs) => [...xs.slice(-2), { id, kind, message }]);
      const timer = window.setTimeout(() => dismissToast(id), ttlMs);
      toastTimersRef.current.set(id, timer);
    },
    [dismissToast],
  );

  const pushFlash = useCallback((msg: string) => {
    setFlashToast(msg);
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      setFlashToast(null);
    }, 3800);
  }, []);

  const forcedAutoBuySharesRef = useRef<number | null>(null);
  const deskBuyLaneRef = useRef<'up' | 'down' | null>(null);
  const bracketOutcomeTokenRef = useRef<string | null>(null);
  const bracketOutcomeLaneRef = useRef<'up' | 'down' | null>(null);
  const deskAutoBuyClickedNonceRef = useRef<number | null>(null);
  const deskAutoBuyIngressRef = useRef<{ key: string; at: number } | null>(null);
  const deskAutoSellClickedNonceRef = useRef<number | null>(null);
  const deskAutoSellIngressRef = useRef<{ key: string; at: number } | null>(null);
  const applyArmRiskNowRef = useRef<(prefs?: ArmRiskAfterBuyPrefs) => void>(() => {});
  const buyRiskArmedRowIdsRef = useRef<Set<string>>(new Set());
  const buyReconcileToastRowIdsRef = useRef<Set<string>>(new Set());
  const bracketArmedPinRef = useRef<{
    token: string;
    lane: 'up' | 'down';
    stopCents: string;
    tpCents: string;
    source: 'signal' | 'spread' | 'desk';
    armedAtMs: number;
  } | null>(null);
  /**
   * Desk bracket ¢ are frozen (Take signal, manual edit, chart drag).
   * Blocks card prefill, applyArmRiskNow, and fill-time spread re-arm from moving TP/SL.
   */
  const operatorSlTpLockedRef = useRef(false);
  /** In-session SL/TP drafts per UP/DOWN tab — survives lane switches before localStorage/arm. */
  const bracketLaneDraftRef = useRef<{ up: { sl: string; tp: string }; down: { sl: string; tp: string } }>({
    up: { sl: '', tp: '' },
    down: { sl: '', tp: '' },
  });
  const prevBracketLaneRef = useRef<'up' | 'down'>(lane);
  const stopLossStopCentsRef = useRef('');
  const takeProfitTakeCentsRef = useRef('');
  /** One-click buy: emergency SL (and optional TP) staged on Buy click, applied on fill reconcile. */
  const buyBundleArmRef = useRef<{
    sl: string;
    tp: string;
    lane: 'up' | 'down';
    token: string;
  } | null>(null);
  /** After buy submit / fill — stop auto TP/SL chase on the buy bundle until next session. */
  const buyBundleChaseFrozenRef = useRef(false);
  const [pendingAutoBuy, setPendingAutoBuy] = useState<{
    lane: 'up' | 'down';
    at: number;
    buyNonce: number;
    armSlTp?: boolean;
    sizeShares?: number;
    fromSignalsDesk?: boolean;
  } | null>(null);
  const [pendingAutoSell, setPendingAutoSell] = useState<{
    lane: 'up' | 'down';
    at: number;
    sellNonce: number;
    fromSignalsDesk?: boolean;
    reason?: string;
  } | null>(null);

  useEffect(() => {
    const onPrefill = (ev: Event) => {
      const ce = ev as CustomEvent<{
        lane?: 'up' | 'down';
        tone?: 'ask' | 'bid';
        price01?: number;
        priceCents?: number;
      }>;
      const d = ce.detail;
      if (!d) return;

      if (d.lane) {
        if (controlledLane == null) setLaneState(d.lane);
        onLaneChange?.(d.lane);
      }
      if (d.tone === 'ask') setAction('buy');
      if (d.tone === 'bid') setAction('sell');
      setExecMode('limit');

      const cents =
        d.priceCents != null && Number.isFinite(d.priceCents)
          ? d.priceCents
          : d.price01 != null && Number.isFinite(d.price01)
            ? Math.round(d.price01 * 1000) / 10
            : null;
      if (cents != null) setLimitPriceCents(String(cents));

      // Nudge the user toward the fast path.
      setShowAdvanced(false);
      setErr(null);
      setOkMsg(null);
    };

    window.addEventListener('bpx-trade-prefill', onPrefill as EventListener);
    return () => window.removeEventListener('bpx-trade-prefill', onPrefill as EventListener);
  }, [controlledLane, onLaneChange]);

  useEffect(() => {
    const onSyncSize = (ev: Event) => {
      const sh = (ev as CustomEvent<{ sizeShares?: number }>).detail?.sizeShares;
      if (sh == null || !Number.isFinite(sh) || sh <= 0) return;
      const rounded = roundShares4(sh);
      setUnit('shares');
      setAmount(String(rounded));
    };
    window.addEventListener(BPX_TRADE_SYNC_SIZE_SHARES_EVENT, onSyncSize as EventListener);
    return () => window.removeEventListener(BPX_TRADE_SYNC_SIZE_SHARES_EVENT, onSyncSize as EventListener);
  }, []);

  useEffect(() => {
    const onRange = (ev: Event) => {
      const ce = ev as CustomEvent<{
        lane?: 'up' | 'down';
        tone?: 'ask' | 'bid';
        loCents?: number;
        hiCents?: number;
      }>;
      const d = ce.detail;
      if (!d) return;
      if (d.lane) {
        if (controlledLane == null) setLaneState(d.lane);
        onLaneChange?.(d.lane);
      }
      // asks = buy range (you buy at asks), bids = sell range (you sell into bids)
      if (d.tone === 'ask') setAction('buy');
      if (d.tone === 'bid') setAction('sell');
      setExecMode('limit');
      const lo = d.loCents != null && Number.isFinite(d.loCents) ? d.loCents : null;
      const hi = d.hiCents != null && Number.isFinite(d.hiCents) ? d.hiCents : null;
      if (lo != null && hi != null) {
        setBuyEntryMode('passive');
        // reuse existing ladder fields (Levels) by generating a level list
        const levels = [];
        const steps = 6;
        const step = steps <= 1 ? 0 : (hi - lo) / (steps - 1);
        for (let i = 0; i < steps; i++) levels.push((hi - step * i).toFixed(1));
        setPassiveLevels(levels.join(','));
        setPassiveTargetCents(String(Math.round(((lo + hi) / 2) * 10) / 10));
      }
      setShowAdvanced(false);
      setErr(null);
      setOkMsg(null);
    };
    window.addEventListener('bpx-trade-range-prefill', onRange as EventListener);
    return () => window.removeEventListener('bpx-trade-range-prefill', onRange as EventListener);
  }, [controlledLane, onLaneChange]);

  const avgEntryCacheKey = useMemo(() => {
    // Cache per outcome token id; survives refresh so "Avg entry" is instant on load.
    // (This is display-only; we still refresh from Polymarket in the background.)
    const up = upToken?.trim() ? `up:${upToken.trim()}` : 'up:';
    const down = downToken?.trim() ? `down:${downToken.trim()}` : 'down:';
    return `pm:avg-entry:v2:${up}|${down}`;
  }, [upToken, downToken]);

  useEffect(() => {
    if (accountMode !== 'live') return;
    if (!upToken || !downToken) return;
    try {
      const raw = localStorage.getItem(avgEntryCacheKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return;
      const o = parsed as Record<string, unknown>;
      const up = typeof o.up === 'number' && Number.isFinite(o.up) ? (o.up as number) : null;
      const down = typeof o.down === 'number' && Number.isFinite(o.down) ? (o.down as number) : null;
      if (up != null) setAvgEntryUp(up);
      if (down != null) setAvgEntryDown(down);
    } catch {
      /* ignore cache */
    }
  }, [accountMode, avgEntryCacheKey, upToken, downToken]);

  useEffect(() => {
    const onDeskToast = (ev: Event) => {
      const d = (ev as CustomEvent<{ kind?: 'ok' | 'err' | 'info'; message?: string; ttlMs?: number }>).detail;
      if (!d?.message) return;
      pushToast(d.kind ?? 'info', d.message, d.ttlMs ?? 6200);
    };
    window.addEventListener(BPX_DESK_TOAST_EVENT, onDeskToast as EventListener);
    return () => window.removeEventListener(BPX_DESK_TOAST_EVENT, onDeskToast as EventListener);
  }, [pushToast]);

  useEffect(() => {
    const onSubmitBuy = (ev: Event) => {
      const ce = ev as CustomEvent<{
        lane?: 'up' | 'down';
        price01?: number;
        stopLoss01?: number | null;
        takeProfit01?: number | null;
        sizeShares?: number;
        sizeUsd?: number;
        armSlTp?: boolean;
      }>;
      const d = ce.detail;
      const submitLane = d?.lane;
      if (submitLane !== 'up' && submitLane !== 'down') return;

      const ingressSh =
        d.sizeShares != null && Number.isFinite(d.sizeShares) ? roundShares4(d.sizeShares) : null;
      const ingressKey = `${submitLane}|${ingressSh ?? ''}|${
        d.price01 != null && Number.isFinite(d.price01) ? d.price01.toFixed(4) : ''
      }`;
      const ingressNow = Date.now();
      const prevIngress = deskAutoBuyIngressRef.current;
      if (prevIngress && prevIngress.key === ingressKey && ingressNow - prevIngress.at < 12_000) return;
      deskAutoBuyIngressRef.current = { key: ingressKey, at: ingressNow };

      const submitToken = submitLane === 'up' ? upToken?.trim() : downToken?.trim();
      const armedPin = bracketArmedPinRef.current;
      const armedTok = armedPin?.token?.trim();
      if (armedPin && armedTok && submitToken && armedTok !== submitToken) {
        pushToast(
          'err',
          `Buy blocked — SL/TP armed on ${(armedPin.lane ?? bracketOutcomeLaneRef.current ?? submitLane).toUpperCase()} token; re-take signal or match tab.`,
          7200,
        );
        return;
      }

      deskBuyLaneRef.current = submitLane;
      bracketOutcomeLaneRef.current = submitLane;
      if (d.armSlTp && submitToken) bracketOutcomeTokenRef.current = submitToken;
      if (
        d.armSlTp &&
        submitToken &&
        d.stopLoss01 != null &&
        d.takeProfit01 != null &&
        Number.isFinite(d.stopLoss01) &&
        Number.isFinite(d.takeProfit01)
      ) {
        bracketArmedPinRef.current = {
          token: submitToken,
          lane: submitLane,
          stopCents: formatBracketCentsFrom01(d.stopLoss01),
          tpCents: formatBracketCentsFrom01(d.takeProfit01),
          source: 'desk',
          armedAtMs: Date.now(),
        };
        operatorSlTpLockedRef.current = true;
      }
      flushSync(() => {
        if (controlledLane == null) setLaneState(submitLane);
      });
      onLaneChange?.(submitLane);
      setAction('buy');
      setExecMode('limit');

      const cents =
        d.price01 != null && Number.isFinite(d.price01) ? Math.round(d.price01 * 1000) / 10 : null;
      if (cents != null) setLimitPriceCents(String(cents));

      if (d.sizeShares != null && Number.isFinite(d.sizeShares) && d.sizeShares > 0) {
        const sh = roundShares4(d.sizeShares);
        forcedAutoBuySharesRef.current = sh;
        flushSync(() => {
          setUnit('shares');
          setAmount(String(sh));
        });
      } else if (d.sizeUsd != null && Number.isFinite(d.sizeUsd) && d.sizeUsd > 0) {
        forcedAutoBuySharesRef.current = null;
        setUnit('dollars');
        setAmount(String(Math.round(d.sizeUsd * 100) / 100));
      }

      if (d.armSlTp) {
        const merged: ArmRiskAfterBuyPrefs = {
          autoArmEnabled: true,
          armSl: true,
          armTp: true,
          useSignalLevels: true,
        };
        setArmRiskAfterBuy((p) => ({ ...p, ...merged }));
        // Levels come from bpx-risk-prefill (Take signal) — do not recompute from a moving card snapshot.
      }

      setShowAdvanced(false);
      setErr(null);
      setOkMsg(null);
      const buyNonce = ingressNow;
      deskAutoBuyClickedNonceRef.current = null;
      setPendingAutoBuy({
        lane: submitLane,
        at: buyNonce,
        buyNonce,
        armSlTp: d.armSlTp === true,
        sizeShares: ingressSh ?? undefined,
        fromSignalsDesk: true,
      });
    };

    window.addEventListener(BPX_TRADE_SUBMIT_BUY_EVENT, onSubmitBuy as EventListener);
    return () => window.removeEventListener(BPX_TRADE_SUBMIT_BUY_EVENT, onSubmitBuy as EventListener);
  }, [controlledLane, downToken, onLaneChange, pushToast, upToken]);

  useEffect(() => {
    const onSubmitSell = (ev: Event) => {
      const ce = ev as CustomEvent<{ lane?: 'up' | 'down'; reason?: string }>;
      const d = ce.detail;
      const submitLane = d?.lane;
      if (submitLane !== 'up' && submitLane !== 'down') return;

      const ingressKey = `${submitLane}|${d.reason ?? ''}`;
      const ingressNow = Date.now();
      const prevIngress = deskAutoSellIngressRef.current;
      if (prevIngress && prevIngress.key === ingressKey && ingressNow - prevIngress.at < 12_000) return;
      deskAutoSellIngressRef.current = { key: ingressKey, at: ingressNow };

      deskBuyLaneRef.current = submitLane;
      bracketOutcomeLaneRef.current = submitLane;
      if (controlledLane == null) setLaneState(submitLane);
      onLaneChange?.(submitLane);
      setAction('sell');
      setShowAdvanced(false);
      setErr(null);
      setOkMsg(null);
      deskAutoSellClickedNonceRef.current = null;
      setPendingAutoSell({
        lane: submitLane,
        at: ingressNow,
        sellNonce: ingressNow,
        fromSignalsDesk: true,
        reason: d.reason,
      });
    };

    window.addEventListener(BPX_TRADE_SUBMIT_SELL_EVENT, onSubmitSell as EventListener);
    return () => window.removeEventListener(BPX_TRADE_SUBMIT_SELL_EVENT, onSubmitSell as EventListener);
  }, [controlledLane, onLaneChange]);

  const [lastExecLatencyMs, setLastExecLatencyMs] = useState<number | null>(null);
  const liveSubmitGenRef = useRef(0);
  const submitLockRef = useRef(false);
  const buyButtonRef = useRef<HTMLButtonElement>(null);
  const [autoBuyRetryTick, setAutoBuyRetryTick] = useState(0);
  const [autoSellRetryTick, setAutoSellRetryTick] = useState(0);
  const [killArmed, setKillArmed] = useState(false);
  const killArmTimerRef = useRef<number | null>(null);

  const tradeHistoryMarketMeta = useMemo(
    () => ({
      ...(marketSlug?.trim() ? { marketSlug: marketSlug.trim() } : {}),
      ...(marketQuestion?.trim() ? { marketTitle: marketQuestion.trim() } : {}),
    }),
    [marketSlug, marketQuestion],
  );

  const isSlide = visualStyle === 'slide';
  const tradeFloatChrome = useTradeFloatChrome();
  /** Slide trade dock: outcome trade vs brackets vs ledger. */
  const [slideDockTab, setSlideDockTabState] = useState<SlideDockTab>(() => readSlideDockTab(marketSlug));
  const setSlideDockTab = useCallback(
    (tab: SlideDockTab) => {
      writeSlideDockTab(tab, marketSlug);
      setSlideDockTabState(tab);
    },
    [marketSlug],
  );
  /** Keep non-Outcome slide tab when UP/DOWN token changes — avoid snapping mid TP/SL or orders view. */
  const preserveSlideDockRef = useRef(false);
  const showOutcomeDock = !isSlide || slideDockTab === 'outcome';
  const showBracketsDock = !isSlide || slideDockTab === 'brackets';
  const showLedgerDock = !isSlide || slideDockTab === 'ledger';

  const estSharesUp = upToken ? netMatchedSharesFromHistory(historyRows, upToken) : 0;
  const estSharesDown = downToken ? netMatchedSharesFromHistory(historyRows, downToken) : 0;
  const lastBuyFillMsByTokenRef = useRef<Record<string, number>>({});
  const msSinceBuyFillForToken = useCallback((tok: string | null | undefined): number | null => {
    const t = tok?.trim();
    if (!t) return null;
    const at = lastBuyFillMsByTokenRef.current[t];
    if (at == null) return null;
    return Date.now() - at;
  }, []);
  const liveLaneShares = useCallback(
    (policy: 'display' | 'sell', L: 'up' | 'down') =>
      resolveLiveLaneShares({
        lane: L,
        balUp,
        balDown,
        posSharesUp,
        posSharesDown,
        estSharesUp,
        estSharesDown,
        policy,
        msSinceBuyFillUp: msSinceBuyFillForToken(upToken),
        msSinceBuyFillDown: msSinceBuyFillForToken(downToken),
      }),
    [
      balDown,
      balUp,
      estSharesDown,
      estSharesUp,
      msSinceBuyFillForToken,
      posSharesDown,
      posSharesUp,
      downToken,
      upToken,
    ],
  );
  const livePositionShares = liveLaneShares('display', lane);
  const liveSellableShares = liveLaneShares('sell', lane);
  const paperPos = useMemo(() => getPaperPosition(paperAccount, token), [paperAccount, token]);
  const positionShares = accountMode === 'paper' ? paperPos.shares : livePositionShares;
  const positionSharesRef = useRef<number | null>(null);
  positionSharesRef.current = positionShares ?? null;

  /** Best-effort max sell for a lane — cache first (sell policy, then display/history). */
  const resolveInstantMaxSellShares = useCallback(
    (L: 'up' | 'down'): number => {
      if (accountMode === 'paper') {
        const tok = L === 'up' ? upToken?.trim() : downToken?.trim();
        const sh = tok ? getPaperPosition(paperAccount, tok).shares : 0;
        return sh > 0 ? floorShares4(sh) : 0;
      }
      const sell = liveLaneShares('sell', L);
      if (sell > 0) return sell;
      const display = liveLaneShares('display', L);
      return display > 0 ? display : 0;
    },
    [accountMode, liveLaneShares, paperAccount, upToken, downToken],
  );

  /** Re-run bracket triggers on a timer while armed (live mids can update without React state churn). */
  /** CLOB poll target while SL/TP armed — tracks bracket token even when the UP/DOWN tab differs. */
  const [bracketPollToken, setBracketPollToken] = useState<string | null>(null);
  /** SL/TP editor + localStorage follow the visible UP/DOWN tab (like limit price). */
  const riskPrefsToken = token?.trim() || '';
  const pinBracketAutomationToken = useCallback(
    (tok: string, laneHint?: 'up' | 'down') => {
      const id = tok.trim();
      if (!id) return;
      const L =
        laneHint ??
        (id === upToken?.trim() ? 'up' : id === downToken?.trim() ? 'down' : bracketOutcomeLaneRef.current ?? lane);
      bracketOutcomeTokenRef.current = id;
      bracketOutcomeLaneRef.current = L;
      bracketHadPositionRef.current = true;
      setBracketPollToken(id);
    },
    [lane, upToken, downToken],
  );
  const armedBracketLane = useMemo((): 'up' | 'down' | null => {
    const pt = bracketPollToken?.trim();
    if (!pt) return null;
    if (upToken?.trim() && pt === upToken.trim()) return 'up';
    if (downToken?.trim() && pt === downToken.trim()) return 'down';
    return bracketOutcomeLaneRef.current;
  }, [bracketPollToken, upToken, downToken]);

  const bracketPositionShares = useMemo((): number | null => {
    const L = armedBracketLane ?? bracketOutcomeLaneRef.current ?? lane;
    const sh = resolveInstantMaxSellShares(L);
    return sh > 0 ? sh : null;
  }, [armedBracketLane, lane, resolveInstantMaxSellShares]);

  const resolvedBullpenOutcome = useMemo(
    () =>
      resolveLiveSellOutcome({
        lane,
        marketSlug,
        label,
        bracketLane: bracketOutcomeLaneRef.current,
        bracketToken: bracketOutcomeTokenRef.current,
        activeToken: token,
        upLabel,
        downLabel,
      }),
    [label, marketSlug, lane, token, upLabel, downLabel, bracketPollToken],
  );

  // Stop-loss (client-side): when ref price crosses down through stop, submit a market/limit sell.
  const stopLossKey = useMemo(() => `pm:stoploss:v1:${riskPrefsToken}`, [riskPrefsToken]);
  const [stopLossEnabled, setStopLossEnabled] = useState(false);
  const [stopLossStopCents, setStopLossStopCents] = useState('');
  const [stopLossLimitCents, setStopLossLimitCents] = useState('');
  const [stopLossShares, setStopLossShares] = useState('');
  const [stopLossStatus, setStopLossStatus] = useState<'OFF' | 'ARMED' | 'TRIGGERED'>('OFF');
  const [stopLossSimple, setStopLossSimple] = useState(true);
  const [stopLossDualBook, setStopLossDualBook] = useState(false);
  const [stopPollBid01, setStopPollBid01] = useState<number | null>(null);
  const [stopPollAsk01, setStopPollAsk01] = useState<number | null>(null);
  const [stopPollAtMs, setStopPollAtMs] = useState<number | null>(null);
  /** Ref-based bracket eval — avoids 10Hz React re-renders from a tick counter. */
  const slBracketEvalRef = useRef<() => void>(() => {});
  const tpBracketEvalRef = useRef<() => void>(() => {});
  const deskScalpPrefsRef = useRef(loadNowPriceDeskScalpPrefs());
  /** Track armed bracket lane had size — detect manual sells when CLOB goes flat. */
  const bracketHadPositionRef = useRef(false);
  const externalFlatNotifiedTokRef = useRef<string | null>(null);
  const stopLossFireLockRef = useRef(false);
  const stopLossLastAttemptMsRef = useRef(0);
  const stopLossLastFireTokRef = useRef<string | null>(null);
  const stopLossLastCrossRef = useRef<number | null>(null);
  const stopLossPrevBidRef = useRef<number | null>(null);
  const stopLossPrevAskRef = useRef<number | null>(null);
  const stopLossPrevStripMidRef = useRef<number | null>(null);

  const takeProfitKey = useMemo(() => `pm:takeprofit:v1:${riskPrefsToken}`, [riskPrefsToken]);
  const [takeProfitEnabled, setTakeProfitEnabled] = useState(false);
  const [takeProfitTakeCents, setTakeProfitTakeCents] = useState('');
  const [takeProfitLimitCents, setTakeProfitLimitCents] = useState('');
  stopLossStopCentsRef.current = stopLossStopCents;
  takeProfitTakeCentsRef.current = takeProfitTakeCents;

  /** Swap bracket editor fields when UP/DOWN tab changes without wiping in-session drafts. */
  useEffect(() => {
    const prev = prevBracketLaneRef.current;
    if (prev === lane) return;
    bracketLaneDraftRef.current[prev] = {
      sl: stopLossStopCentsRef.current,
      tp: takeProfitTakeCentsRef.current,
    };
    prevBracketLaneRef.current = lane;
    const d = bracketLaneDraftRef.current[lane];
    setStopLossStopCents(d.sl);
    setStopLossLimitCents(d.sl);
    setTakeProfitTakeCents(d.tp);
    setTakeProfitLimitCents(d.tp);
  }, [lane]);
  const [takeProfitShares, setTakeProfitShares] = useState('');
  const [takeProfitStatus, setTakeProfitStatus] = useState<'OFF' | 'ARMED' | 'TRIGGERED'>('OFF');

  /** Suggested TP/SL levels (displayed as hints — never auto-filled into the inputs). */
  const [_, setSuggestedSlCents] = useState('');
  const [__, setSuggestedTpCents] = useState('');
  /** Emergency stop (+ optional TP) staged before buy — arms SL on fill; SL persists per lane. */
  const [buyBundleByLane, setBuyBundleByLane] = useState(() => {
    const prefs = loadEmergencyStopBundlePrefs();
    if (!prefs.autoFillSl) return { ...EMPTY_BUY_BUNDLE_BY_LANE };
    const em = loadEmergencyStopByLane();
    return {
      up: { sl: em.up, tp: '' },
      down: { sl: em.down, tp: '' },
    };
  });
  const buyBundleByLaneRef = useRef(buyBundleByLane);
  buyBundleByLaneRef.current = buyBundleByLane;
  const buyBundleSlCents = buyBundleByLane[lane].sl;
  const buyBundleTpCents = buyBundleByLane[lane].tp;
  /** Last auto-applied buy-bundle TP per lane — lets quote assist chase the book until operator overrides. */
  const autoBundleTpLaneRef = useRef<{ lane: 'up' | 'down'; cents: string } | null>(null);
  const autoBundleSlLaneRef = useRef<{ lane: 'up' | 'down'; cents: string } | null>(null);
  const buyBundleSlManualLanesRef = useRef<{ up: boolean; down: boolean }>({ up: false, down: false });
  const buyBundleTpManualLanesRef = useRef<{ up: boolean; down: boolean }>({ up: false, down: false });
  const buyBundleTpDraftRef = useRef<{ up: BracketInputDraftState; down: BracketInputDraftState }>({
    up: EMPTY_BRACKET_INPUT_DRAFT,
    down: EMPTY_BRACKET_INPUT_DRAFT,
  });
  const buyBundleSlDraftRef = useRef<{ up: BracketInputDraftState; down: BracketInputDraftState }>({
    up: EMPTY_BRACKET_INPUT_DRAFT,
    down: EMPTY_BRACKET_INPUT_DRAFT,
  });
  /** Buy submit intent — survives until exchange fill so staged ¢ beats stale Brackets-tab TP. */
  const pendingBuyBundleIntentRef = useRef<{
    lane: 'up' | 'down';
    token: string;
    sl: string;
    tp: string;
  } | null>(null);
  /** Pin buy-bundle entry/size readouts while composing — ignore live quote ticks until amount/limit/lane changes. */
  const buyBracketSizingPinRef = useRef<{
    key: string;
    entry01: number | null;
    shares: number | null;
    notional: number | null;
  } | null>(null);
  const bracketSharesSyncRef = useRef<number | null>(null);
  const [emergencyStopBundlePrefs, setEmergencyStopBundlePrefs] = useState<EmergencyStopBundlePrefs>(() =>
    loadEmergencyStopBundlePrefs(),
  );
  const [takeProfitSimple, setTakeProfitSimple] = useState(true);
  const [takeProfitDualBook, setTakeProfitDualBook] = useState(false);
  const takeProfitFireLockRef = useRef(false);
  const takeProfitLastAttemptMsRef = useRef(0);
  const takeProfitLastFireTokRef = useRef<string | null>(null);
  const takeProfitLastCrossRef = useRef<number | null>(null);
  const takeProfitPrevBidRef = useRef<number | null>(null);
  const takeProfitPrevAskRef = useRef<number | null>(null);
  /** Strip mid (chart line) edge memory when TP dual-book mode is on. */
  const takeProfitPrevStripMidRef = useRef<number | null>(null);
  /** Trailing-profit peak mark per armed token. */
  const trailingTpPeakByTokRef = useRef<Map<string, number>>(new Map());

  const syncBracketPinFromOperatorEdits = useCallback(
    (partial?: { stopCents?: string; tpCents?: string }) => {
      const armTok =
        bracketOutcomeTokenRef.current?.trim() ||
        (lane === 'up' ? upToken?.trim() : downToken?.trim()) ||
        '';
      if (!armTok) return;
      const riskLane = bracketOutcomeLaneRef.current ?? lane;
      const prev = bracketArmedPinRef.current;
      bracketArmedPinRef.current = {
        token: armTok,
        lane: riskLane,
        stopCents: (partial?.stopCents ?? stopLossStopCents).trim() || prev?.stopCents || '',
        tpCents: (partial?.tpCents ?? takeProfitTakeCents).trim() || prev?.tpCents || '',
        source: prev?.source ?? 'desk',
        armedAtMs: Date.now(),
      };
    },
    [lane, stopLossStopCents, takeProfitTakeCents, downToken, upToken],
  );

  /** Keep armed pin aligned with operator edits — never chase live quote after a desk buy lock. */
  useEffect(() => {
    if (operatorSlTpLockedRef.current) return;
    if (!stopLossEnabled && !takeProfitEnabled) return;
    if (!stopLossStopCents.trim() && !takeProfitTakeCents.trim()) return;
    syncBracketPinFromOperatorEdits();
  }, [
    stopLossEnabled,
    takeProfitEnabled,
    stopLossStopCents,
    takeProfitTakeCents,
    syncBracketPinFromOperatorEdits,
  ]);

  /** Sell tab: Polymarket-style +SL / +TP / gear sheets (replaces nested details). */
  const [riskSellSheet, setRiskSellSheet] = useState<null | 'sl' | 'tp' | 'settings'>(null);

  useEffect(() => {
    preserveSlideDockRef.current =
      slideDockTab !== 'outcome' ||
      riskSellSheet === 'sl' ||
      riskSellSheet === 'tp' ||
      riskSellSheet === 'settings';
  }, [slideDockTab, riskSellSheet]);

  const slideDockTabsEl = useMemo(
    () =>
      isSlide ? (
        <TradeSegmentedControl
          value={slideDockTab}
          onChange={(v) => setSlideDockTab(v as SlideDockTab)}
          options={[
            { value: 'outcome', label: 'Outcome', title: 'Pick side, size, buy / sell' },
            { value: 'brackets', label: 'Brackets', title: 'Stop-loss & take-profit automation' },
            { value: 'ledger', label: 'Orders & position', title: 'Open orders, book, balances' },
          ]}
          className="w-full"
          size="md"
        />
      ) : null,
    [isSlide, setSlideDockTab, slideDockTab],
  );

  useEffect(() => {
    if (!tradeFloatChrome || !isSlide) return;
    tradeFloatChrome.setSubHeader(slideDockTabsEl);
    return () => tradeFloatChrome.setSubHeader(null);
  }, [isSlide, slideDockTabsEl, tradeFloatChrome]);

  useEffect(() => {
    const onRisk = (ev: Event) => {
      const ce = ev as CustomEvent<{
        lane?: 'up' | 'down';
        tpCents?: number;
        stopCents?: number;
        tpCentsStr?: string;
        stopCentsStr?: string;
        /** When true (Take signal / desk auto-buy), enable automation — not chart-only prefill. */
        arm?: boolean;
        /** Take signal / explicit re-arm — apply card levels even if operator edited earlier. */
        forceLevels?: boolean;
        sizeShares?: number;
      }>;
      const d = ce.detail;
      if (!d) return;
      if (d.forceLevels === true) operatorSlTpLockedRef.current = true;
      if (d.lane) {
        deskBuyLaneRef.current = d.lane;
        bracketOutcomeLaneRef.current = d.lane;
        const armTok = d.lane === 'up' ? upToken?.trim() : downToken?.trim();
        if (armTok && d.arm) {
          bracketOutcomeTokenRef.current = armTok;
          setBracketPollToken(armTok);
        }
        flushSync(() => {
          if (controlledLane == null) setLaneState(d.lane!);
        });
        onLaneChange?.(d.lane);
      }
      const tp = d.tpCents != null && Number.isFinite(d.tpCents) ? Math.round(d.tpCents) : null;
      const sl = d.stopCents != null && Number.isFinite(d.stopCents) ? Math.round(d.stopCents) : null;
      const sh =
        d.sizeShares != null && Number.isFinite(d.sizeShares) && d.sizeShares > 0
          ? String(floorShares4(d.sizeShares))
          : null;
      const maySetCents = (prev: string) =>
        d.forceLevels === true || (!operatorSlTpLockedRef.current && !prev.trim());
      if (tp != null) {
        const s =
          typeof d.tpCentsStr === 'string' && d.tpCentsStr.trim()
            ? d.tpCentsStr.trim()
            : formatBracketCentsFromNumber(tp);
        setSuggestedTpCents(s);
        if (
          d.arm === true &&
          (d.forceLevels === true || maySetCents(takeProfitTakeCents))
        ) {
          setTakeProfitTakeCents(s);
          setTakeProfitLimitCents(s);
        }
        if (d.arm) {
          resetTakeProfitBracketMemory({
            lastCross: takeProfitLastCrossRef,
            prevBid: takeProfitPrevBidRef,
            prevAsk: takeProfitPrevAskRef,
            prevStripMid: takeProfitPrevStripMidRef,
            lastFireTok: takeProfitLastFireTokRef,
            fireLock: takeProfitFireLockRef,
          });
          setTakeProfitEnabled(true);
          setTakeProfitStatus('ARMED');
          if (sh) setTakeProfitShares(sh);
        }
      }
      if (sl != null) {
        const s =
          typeof d.stopCentsStr === 'string' && d.stopCentsStr.trim()
            ? d.stopCentsStr.trim()
            : formatBracketCentsFromNumber(sl);
        setSuggestedSlCents(s);
        if (
          d.arm === true &&
          (d.forceLevels === true || maySetCents(stopLossStopCents))
        ) {
          setStopLossStopCents(s);
          setStopLossLimitCents(s);
        }
        if (d.arm) {
          resetStopLossBracketMemory({
            lastCross: stopLossLastCrossRef,
            prevBid: stopLossPrevBidRef,
            prevAsk: stopLossPrevAskRef,
            prevStripMid: stopLossPrevStripMidRef,
            lastFireTok: stopLossLastFireTokRef,
            fireLock: stopLossFireLockRef,
          });
          setStopLossEnabled(true);
          setStopLossStatus('ARMED');
          if (sh) setStopLossShares(sh);
        }
      }
      if (d.arm && d.lane) {
        const armTok = d.lane === 'up' ? upToken?.trim() : downToken?.trim();
        if (armTok && sl != null && tp != null) {
          const tpStr =
            typeof d.tpCentsStr === 'string' && d.tpCentsStr.trim()
              ? d.tpCentsStr.trim()
              : formatBracketCentsFromNumber(tp);
          const slStr =
            typeof d.stopCentsStr === 'string' && d.stopCentsStr.trim()
              ? d.stopCentsStr.trim()
              : formatBracketCentsFromNumber(sl);
          bracketArmedPinRef.current = {
            token: armTok,
            lane: d.lane,
            stopCents: slStr,
            tpCents: tpStr,
            source: 'desk',
            armedAtMs: Date.now(),
          };
        }
      }
      // Highlight bracket fields without forcing slide tab / scroll (avoids layout jump).
      if (d.arm) {
        setRiskSellSheet(sl != null ? 'sl' : tp != null ? 'tp' : null);
      }
    };
    window.addEventListener('bpx-risk-prefill', onRisk as EventListener);
    return () => window.removeEventListener('bpx-risk-prefill', onRisk as EventListener);
  }, [controlledLane, downToken, isSlide, onLaneChange, upToken]);

  const [lastAutoSell, setLastAutoSell] = useState<null | {
    kind: 'sl' | 'tp';
    ts: number;
    mode: 'paper' | 'live';
    status: 'sent' | 'filled' | 'failed';
    shares: number;
    /** Armed stop / take level (¢). */
    triggerCents: number;
    /** Best bid (or fused ref) at trigger time (¢). */
    refCents: number | null;
    limitCents: number;
    fillCents: number | null;
    orderId: string | null;
    msg: string | null;
  }>(null);

  const [armRiskAfterBuy, setArmRiskAfterBuy] = useState<ArmRiskAfterBuyPrefs>(() => loadArmRiskAfterBuyPrefs());
  /** Latest trade-card TP/SL from Signals desk (see `dispatchSignalRiskLevels`). */
  const signalRiskRef = useRef<SignalRiskSnapshot | null>(null);
  const [signalRiskSnapshot, setSignalRiskSnapshot] = useState<SignalRiskSnapshot | null>(null);
  /** Planning reference (PTB overlays / drag sync; does not auto-trade). */
  const [planStandardCents, setPlanStandardCents] = useState('');

  const bookFallbackBuyAdvisory = useMemo(() => {
    const lastUp = probMomentumUp?.length ? probMomentumUp[probMomentumUp.length - 1]!.v : null;
    const lastDown = probMomentumDown?.length ? probMomentumDown[probMomentumDown.length - 1]!.v : null;
    const midU = bookMidUp ?? upMid;
    const midD = bookMidDown ?? downMid;
    return shouldBuyWhichSide({
      machine: null,
      book: {
        dual: null,
        wallFlow: null,
        probUp: lastUp != null && Number.isFinite(lastUp) ? lastUp : midU,
        probDown: lastDown != null && Number.isFinite(lastDown) ? lastDown : midD,
        midUp: midU != null && Number.isFinite(midU) ? midU : null,
        midDown: midD != null && Number.isFinite(midD) ? midD : null,
      },
      tape: null,
      tapeLane: null,
      forecast: null,
      directive: null,
      stability: null,
      upLabel,
      downLabel,
    });
  }, [bookMidDown, bookMidUp, downLabel, downMid, probMomentumDown, probMomentumUp, upLabel, upMid]);

  const effectiveBuySideAdvisory = useMemo(
    () => pickStrongerBuyAdvisory(buySideAdvisoryProp, bookFallbackBuyAdvisory),
    [bookFallbackBuyAdvisory, buySideAdvisoryProp],
  );

  useEffect(() => {
    const slugKey = marketSlug?.trim() ?? '';
    const onSignalRisk = (ev: Event) => {
      const d = (ev as CustomEvent<SignalRiskLevelsDetail>).detail;
      if (!d?.lane || d.lane !== 'up' && d.lane !== 'down') return;
      if (d.slug && slugKey && d.slug.trim() !== slugKey) return;
      if (
        !Number.isFinite(d.entry01) ||
        !Number.isFinite(d.takeProfit01) ||
        !Number.isFinite(d.stopLoss01) ||
        d.entry01 <= 0 ||
        d.entry01 >= 1
      ) {
        return;
      }
      const snap: SignalRiskSnapshot = { ...d, updatedAtMs: Date.now() };
      signalRiskRef.current = snap;
      setSignalRiskSnapshot(snap);
    };
    window.addEventListener(BPX_SIGNAL_RISK_LEVELS_EVENT, onSignalRisk as EventListener);
    return () => window.removeEventListener(BPX_SIGNAL_RISK_LEVELS_EVENT, onSignalRisk as EventListener);
  }, [marketSlug]);

  useEffect(() => {
    signalRiskRef.current = null;
    setSignalRiskSnapshot(null);
  }, [marketSlug]);

  const riskCardRef = useRef<HTMLDivElement | null>(null);
  const slBracketRef = useRef<HTMLDivElement | null>(null);
  const tpBracketRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const fn = (ev: Event) => {
      const d = (ev as CustomEvent<BpxBracketDragDetail>).detail;
      if (!d || typeof d !== 'object') return;
      const u = upToken?.trim() ?? '';
      const dn = downToken?.trim() ?? '';
      if (!u || !dn || d.upToken?.trim() !== u || d.downToken?.trim() !== dn) return;
      if (d.tradeLane !== lane) return;
      const c = String(d.centsStr ?? '').trim();
      if (!c) return;
      if (d.kind === 'sl') {
        operatorSlTpLockedRef.current = true;
        setStopLossStopCents(c);
        if (stopLossSimple) setStopLossLimitCents(c);
        syncBracketPinFromOperatorEdits({ stopCents: c });
      } else if (d.kind === 'tp') {
        operatorSlTpLockedRef.current = true;
        setTakeProfitTakeCents(c);
        if (takeProfitSimple) setTakeProfitLimitCents(c);
        syncBracketPinFromOperatorEdits({ tpCents: c });
      } else if (d.kind === 'ref') {
        setPlanStandardCents(c);
      }
    };
    window.addEventListener(BPX_BRACKET_DRAG_EVENT, fn as EventListener);
    return () => window.removeEventListener(BPX_BRACKET_DRAG_EVENT, fn as EventListener);
  }, [lane, upToken, downToken, stopLossSimple, takeProfitSimple, syncBracketPinFromOperatorEdits]);

  useEffect(() => {
    return () => {
      window.dispatchEvent(
        new CustomEvent(BPX_BRACKET_OVERLAY_EVENT, {
          detail: {
            tradeLane: 'up',
            upToken: '',
            downToken: '',
            stopLossEnabled: false,
            takeProfitEnabled: false,
            slStopCents: '',
            tpTakeCents: '',
            refCents: '',
            avgEntry01: null,
          },
        }),
      );
    };
  }, []);

  /** Live: book mid first (matches CLOB); paper: chart first. */
  const mid = useMemo(() => {
    const chart = lane === 'up' ? upMid : downMid;
    const book = lane === 'up' ? (bookMidUp ?? null) : (bookMidDown ?? null);
    const c = chart != null && Number.isFinite(chart) && chart > 0 ? chart : null;
    const b = book != null && Number.isFinite(book) && book > 0 ? book : null;
    if (accountMode === 'live') return b ?? c;
    return c ?? b;
  }, [lane, upMid, downMid, bookMidUp, bookMidDown, accountMode]);

  /** Live: last trade when available; paper: book/chart mid only. Used when book touch is missing. */
  const displayMark01 = useMemo(() => {
    if (accountMode !== 'live') return mid;
    const lt = lane === 'up' ? lastTradeUp01 : lastTradeDown01;
    return lt ?? mid;
  }, [accountMode, lane, lastTradeUp01, lastTradeDown01, mid]);

  /** Mid in display ¢ (one decimal) for SL/TP preset chips — aligned with bracket chart. */
  const bracketMidCentsDisplay = useMemo(() => {
    const m = displayMark01;
    if (m == null || !(m > 0) || !(m < 1)) return null;
    return Math.round(m * 1000) / 10;
  }, [displayMark01]);

  const fetchLastTradesBoth = useCallback(async () => {
    if (accountMode !== 'live' || !upToken || !downToken) return;
    const [u, d] = await Promise.all([lastTradePrice(upToken), lastTradePrice(downToken)]);
    if (isOk(u) && u.data.price) setLastTradeUp01(parseClobPriceStringTo01(u.data.price));
    else setLastTradeUp01(null);
    if (isOk(d) && d.data.price) setLastTradeDown01(parseClobPriceStringTo01(d.data.price));
    else setLastTradeDown01(null);
  }, [accountMode, upToken, downToken]);

  useEffect(() => {
    if (accountMode !== 'live' || !upToken || !downToken) {
      setLastTradeUp01(null);
      setLastTradeDown01(null);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const tick = () => {
      if (cancelled) return;
      if (document.visibilityState === 'hidden') return;
      if (inFlight) return;
      inFlight = true;
      void fetchLastTradesBoth().finally(() => {
        inFlight = false;
      });
    };
    tick();
    const bracketWatch =
      stopLossEnabled || takeProfitEnabled || Boolean(bracketPollToken?.trim());
    const lastTradeMs = bracketWatch ? 600 : 2_500;
    const id = window.setInterval(tick, lastTradeMs);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [accountMode, upToken, downToken, fetchLastTradesBoth, bracketPollToken, stopLossEnabled, takeProfitEnabled]);

  /** Resume CLOB polling for whichever outcome still has armed SL/TP in storage (survives refresh / tab switch). */
  useEffect(() => {
    if (!upToken?.trim() && !downToken?.trim()) return;
    const cur = bracketPollToken?.trim();
    if (cur) {
      const sl = loadStopLossConfigFromStorage(cur);
      const tp = loadTakeProfitConfigFromStorage(cur);
      if (sl?.enabled || tp?.enabled) return;
    }
    for (const entry of [
      { tok: upToken?.trim(), lane: 'up' as const },
      { tok: downToken?.trim(), lane: 'down' as const },
    ]) {
      if (!entry.tok) continue;
      const sl = loadStopLossConfigFromStorage(entry.tok);
      const tp = loadTakeProfitConfigFromStorage(entry.tok);
      if (sl?.enabled || tp?.enabled) {
        pinBracketAutomationToken(entry.tok, entry.lane);
        return;
      }
    }
  }, [bracketPollToken, downToken, pinBracketAutomationToken, upToken]);

  const liveAvgEntry = lane === 'up' ? avgEntryUp : avgEntryDown;
  const paperUpPos = useMemo(() => getPaperPosition(paperAccount, upToken), [paperAccount, upToken]);
  const paperDownPos = useMemo(() => getPaperPosition(paperAccount, downToken), [paperAccount, downToken]);

  useEffect(() => {
    const upId = upToken?.trim() ?? '';
    const downId = downToken?.trim() ?? '';
    if (!upId && !downId) return;
    const estUp = upId ? netMatchedSharesFromHistory(historyRows, upId) : 0;
    const estDown = downId ? netMatchedSharesFromHistory(historyRows, downId) : 0;
    dispatchOutcomePositions({
      slug: marketSlug?.trim() ?? '',
      mode: accountMode,
      up: {
        tokenId: upId,
        shares:
          accountMode === 'paper'
            ? paperUpPos.shares
            : resolveLiveOutcomeShares({
                clobBal: balUp,
                bullpenShares: posSharesUp,
                historyEst: estUp,
                policy: 'display',
                msSinceBuyFill: msSinceBuyFillForToken(upId),
              }),
      },
      down: {
        tokenId: downId,
        shares:
          accountMode === 'paper'
            ? paperDownPos.shares
            : resolveLiveOutcomeShares({
                clobBal: balDown,
                bullpenShares: posSharesDown,
                historyEst: estDown,
                policy: 'display',
                msSinceBuyFill: msSinceBuyFillForToken(downId),
              }),
      },
    });
  }, [
    accountMode,
    marketSlug,
    historyRows,
    upToken,
    downToken,
    paperUpPos.shares,
    paperDownPos.shares,
    balUp,
    balDown,
    posSharesUp,
    posSharesDown,
    msSinceBuyFillForToken,
  ]);

  /** Same lane as SL/TP — used on PTB charts for Δ¢ / % vs entry (TradingView-style). */
  const bracketOverlayAvgEntry01 = useMemo(() => {
    if (accountMode === 'paper') {
      const p = lane === 'up' ? paperUpPos : paperDownPos;
      const c = p.avgCost01;
      if (c == null || !(c > 0) || !(c < 1) || !(p.shares > 1e-6)) return null;
      return c;
    }
    const c = liveAvgEntry;
    return c != null && c > 0 && c < 1 ? c : null;
  }, [accountMode, lane, liveAvgEntry, paperDownPos, paperUpPos]);

  useEffect(() => {
    const detail: BpxBracketOverlayDetail = {
      tradeLane: lane,
      upToken: upToken?.trim() ?? '',
      downToken: downToken?.trim() ?? '',
      stopLossEnabled,
      takeProfitEnabled,
      slStopCents: stopLossStopCents,
      tpTakeCents: takeProfitTakeCents,
      refCents: planStandardCents,
      avgEntry01: bracketOverlayAvgEntry01,
    };
    window.dispatchEvent(new CustomEvent(BPX_BRACKET_OVERLAY_EVENT, { detail }));
  }, [
    lane,
    upToken,
    downToken,
    stopLossEnabled,
    takeProfitEnabled,
    stopLossStopCents,
    takeProfitTakeCents,
    planStandardCents,
    bracketOverlayAvgEntry01,
  ]);

  const paperMtm = useMemo(() => markToMarket({ account: paperAccount, tokenId: token, mid01: mid }), [paperAccount, token, mid]);
  const paperSettlementBanner = useMemo(() => paperSettlementCaption(gammaMarket ?? null), [gammaMarket]);

  const paperRestingForToken = useMemo(() => {
    if (!token) return [];
    return paperOrders
      .filter((o) => o.tokenId === token)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5);
  }, [paperOrders, token]);

  const localLiveOpenOrdersForToken = useMemo(() => {
    if (accountMode !== 'live' || !token) return [];
    const tid = token.trim();
    const now = Date.now();
    return historyRows
      .filter((r) => r.mode === 'live' && r.token.trim() === tid)
      .filter((r) => liveRowCancelable(r))
      .filter((r) => (r.ts ?? 0) > 0 && now - (r.ts ?? 0) <= 5 * 60_000)
      .slice()
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      .slice(0, 8);
  }, [accountMode, historyRows, token]);

  const recentFillsForToken = useMemo(() => {
    const tid = token?.trim() ?? '';
    if (!tid) return [];
    const modeWant = accountMode === 'live' ? 'live' : 'paper';
    const auditIsBracketAuto = (audit: string | undefined) => {
      const a = String(audit ?? '').toLowerCase();
      return a.includes('stop_loss') || a.includes('take_profit');
    };
    type TapeAgg = { sumPxSh: number; sumSh: number; lastMs: number };
    const fillsForTok = accountMode === 'live' ? myFills.filter((f) => f.token_id.trim() === tid) : [];
    const tapeAggByOrderId = new Map<string, TapeAgg>();
    for (const f of fillsForTok) {
      const oid = String(f.order_id ?? '').trim();
      if (!oid) continue;
      const cur = tapeAggByOrderId.get(oid) ?? { sumPxSh: 0, sumSh: 0, lastMs: 0 };
      cur.sumPxSh += f.price_01 * f.shares;
      cur.sumSh += f.shares;
      cur.lastMs = Math.max(cur.lastMs, f.match_time_ms ?? 0);
      tapeAggByOrderId.set(oid, cur);
    }

    const upgradeBracketRowFromTape = (r: TradeHistoryRow): TradeHistoryRow => {
      const oid = String(r.orderId ?? '').trim();
      if (!oid || !auditIsBracketAuto(r.auditNote)) return r;
      const agg = tapeAggByOrderId.get(oid);
      if (!agg || !(agg.sumSh > 1e-8)) return r;
      const px = agg.sumPxSh / agg.sumSh;
      const sh = agg.sumSh;
      const usd = Math.abs(Math.round(px * sh * 100));
      const tgt = r.requestedShares ?? r.shares;
      const wantFull = tgt == null || !Number.isFinite(tgt) || tgt <= 0 || sh + 1e-4 >= tgt;
      const nextStatus = wantFull ? ('filled' as const) : ('partial' as const);
      if (r.status === 'filled' && r.fillAvgPrice01 != null && Math.abs((r.shares ?? 0) - sh) < 1e-3) return r;
      if (r.status === 'partial' && !wantFull && r.shares != null && Math.abs(r.shares - sh) < 1e-3) return r;
      if (
        r.status === 'sent' ||
        r.status === 'pending' ||
        r.status === 'sending' ||
        r.status === 'submitted' ||
        r.status === 'partial'
      ) {
        return {
          ...r,
          status: nextStatus,
          fillAvgPrice01: px,
          price01: px,
          shares: sh,
          remainingShares: wantFull ? 0 : Math.max(0, (typeof tgt === 'number' ? tgt : sh) - sh),
          usdCents: usd,
          ts: Math.max(r.ts ?? 0, agg.lastMs),
        };
      }
      return r;
    };

    // Upgrade local SL/TP rows from tape before filtering for fills. A live TP can still be
    // locally `sent` when the CLOB tape already confirms the sell.
    const local = historyRows
      .filter((r) => r.token.trim() === tid && r.mode === modeWant)
      .map(upgradeBracketRowFromTape)
      .filter((r) => {
        if (r.status !== 'filled' && r.status !== 'partial') return false;
        if (modeWant === 'live' && !rowShowsExchangeFill(r)) return false;
        return true;
      })
      .slice()
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

    if (accountMode !== 'live' || !myFills.length) return local.slice(0, 12);

    const confirmed = fillsForTok
      .slice()
      .sort((a, b) => (b.match_time_ms ?? 0) - (a.match_time_ms ?? 0))
      .slice(0, 24)
      .map((f) => ({
        id: `${f.order_id}-${f.match_time_ms}-${f.shares}`,
        mode: 'live' as const,
        side: f.side,
        token: f.token_id,
        orderId: f.order_id,
        quotedPrice01: null,
        submittedPrice01: null,
        fillAvgPrice01: f.price_01,
        price01: f.price_01,
        shares: f.shares,
        requestedShares: null,
        remainingShares: null,
        usdCents: Math.abs(Math.round(f.price_01 * f.shares * 100)),
        status: 'filled' as const,
        ts: f.match_time_ms,
        role: f.role,
      }));

    const skipClobRow = (orderId: string) => {
      const oid = orderId.trim();
      if (!oid) return false;
      return local.some((r) => {
        if (String(r.orderId ?? '').trim() !== oid) return false;
        if (!auditIsBracketAuto(r.auditNote)) return false;
        return r.status === 'filled' || r.status === 'partial';
      });
    };

    const byKey = new Map<string, (typeof local)[number]>();
    for (const r of local) byKey.set(`local:${r.id}`, r);
    for (const c of confirmed as any[]) {
      const oid = String(c.orderId ?? '');
      if (skipClobRow(oid)) continue;
      byKey.set(`clob:${c.id}`, c);
    }
    return Array.from(byKey.values())
      .slice()
      .sort((a: any, b: any) => (b.ts ?? 0) - (a.ts ?? 0))
      .slice(0, 12);
  }, [accountMode, historyRows, myFills, token]);

  const recentActivityForToken = useMemo(() => {
    const tid = token?.trim() ?? '';
    if (!tid) return [];
    return historyRows
      .filter((r) => r.token.trim() === tid && r.mode === (accountMode === 'live' ? 'live' : 'paper'))
      .filter((r) => r.status !== 'cancelled' && r.status !== 'no_fill')
      .slice()
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
      .slice(0, 10);
  }, [accountMode, historyRows, token]);

  function fmtMs(ms: number | null | undefined): string {
    if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  const midUpChart = upMid != null && Number.isFinite(upMid) && upMid > 0 ? upMid : null;
  const midDownChart = downMid != null && Number.isFinite(downMid) && downMid > 0 ? downMid : null;
  const midUpEff = useMemo(() => {
    const b = bookMidUp != null && bookMidUp > 0 ? bookMidUp : null;
    if (accountMode === 'live') return b ?? midUpChart;
    return midUpChart ?? b;
  }, [accountMode, bookMidUp, midUpChart]);
  const midDownEff = useMemo(() => {
    const b = bookMidDown != null && bookMidDown > 0 ? bookMidDown : null;
    if (accountMode === 'live') return b ?? midDownChart;
    return midDownChart ?? b;
  }, [accountMode, bookMidDown, midDownChart]);

  const liveMtm = useMemo(() => {
    const cash = availUsdc ?? 0;
    let equity = 0;
    let cost = 0;
    const estUp = upToken ? netMatchedSharesFromHistory(historyRows, upToken) : 0;
    const estDown = downToken ? netMatchedSharesFromHistory(historyRows, downToken) : 0;
    const upSh = Math.max(balUp ?? 0, estUp);
    const downSh = Math.max(balDown ?? 0, estDown);
    if (upSh > 0 && midUpEff != null && midUpEff > 0) {
      equity += upSh * midUpEff;
      if (avgEntryUp != null && avgEntryUp > 0) cost += upSh * avgEntryUp;
    }
    if (downSh > 0 && midDownEff != null && midDownEff > 0) {
      equity += downSh * midDownEff;
      if (avgEntryDown != null && avgEntryDown > 0) cost += downSh * avgEntryDown;
    }
    const hasPos = upSh > 0 || downSh > 0;
    return {
      cashUsd: Number.isFinite(cash) ? cash : null,
      equityUsd: hasPos ? equity : null,
      totalUsd: Number.isFinite(cash) ? cash + equity : null,
      unrealizedUsd: hasPos ? equity - cost : null,
    };
  }, [availUsdc, balUp, balDown, downToken, historyRows, midUpEff, midDownEff, avgEntryUp, avgEntryDown, upToken]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const h = await health();
      if (cancelled) return;
      if (isOk(h)) {
        setTradingReady(h.data.trading_ready === true);
        const via = h.data.trading_live_orders_via;
        setTradingVia(via === 'bullpen' || via === 'clob' ? via : null);
      } else {
        setTradingReady(null);
        setTradingVia(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountMode]);

  const bookTouch = lane === 'up' ? bookTouchUp ?? null : bookTouchDown ?? null;
  const riskBookTouch =
    armedBracketLane === 'up'
      ? (bookTouchUp ?? null)
      : armedBracketLane === 'down'
        ? (bookTouchDown ?? null)
        : bookTouch;
  const bracketAutomationArmed = stopLossEnabled || takeProfitEnabled;
  /** Stop-loss UI: polled bid while armed (dual checkbox only adds ask row). */
  const slStopWatchBid01 = useMemo(() => {
    const t = riskBookTouch?.bestBid;
    const tb = t != null && t > 0 && t < 1 ? roundPrice01(t) : null;
    return bracketAutomationArmed || stopLossDualBook ? (stopPollBid01 ?? tb) : tb;
  }, [riskBookTouch?.bestBid, bracketAutomationArmed, stopLossDualBook, stopPollBid01]);
  const slStopWatchAsk01 = useMemo(() => {
    const t = riskBookTouch?.bestAsk;
    const ta = t != null && t > 0 && t < 1 ? roundPrice01(t) : null;
    return bracketAutomationArmed || stopLossDualBook ? (stopPollAsk01 ?? ta) : ta;
  }, [riskBookTouch?.bestAsk, bracketAutomationArmed, stopLossDualBook, stopPollAsk01]);
  /** Take-profit UI: polled bid while armed. */
  const tpTakeWatchBid01 = useMemo(() => {
    const t = riskBookTouch?.bestBid;
    const tb = t != null && t > 0 && t < 1 ? roundPrice01(t) : null;
    return bracketAutomationArmed || takeProfitDualBook ? (stopPollBid01 ?? tb) : tb;
  }, [riskBookTouch?.bestBid, bracketAutomationArmed, takeProfitDualBook, stopPollBid01]);
  const tpTakeWatchAsk01 = useMemo(() => {
    const t = riskBookTouch?.bestAsk;
    const ta = t != null && t > 0 && t < 1 ? roundPrice01(t) : null;
    return bracketAutomationArmed || takeProfitDualBook ? (stopPollAsk01 ?? ta) : ta;
  }, [riskBookTouch?.bestAsk, bracketAutomationArmed, takeProfitDualBook, stopPollAsk01]);
  const book = lane === 'up' ? bookUp ?? null : bookDown ?? null;
  const depth = useMemo(() => pickBookLevels(book), [book]);

  const pickLadder = useMemo(() => {
    const levels = action === 'buy' ? depth.asks : depth.bids;
    return levels.slice(0, 32);
  }, [action, depth.asks, depth.bids]);
  const executableQuote01 = useMemo(() => {
    if (action === 'buy') {
      const ask = bookTouch?.bestAsk;
      if (ask != null && ask > 0 && ask < 1) return roundPrice01(ask);
    } else {
      const bid = bookTouch?.bestBid;
      if (bid != null && bid > 0 && bid < 1) return roundPrice01(bid);
    }
    return displayMark01 != null && displayMark01 > 0 ? roundPrice01(displayMark01) : null;
  }, [action, bookTouch, displayMark01]);

  const spreadCents = useMemo(() => {
    const bid = bookTouch?.bestBid != null && bookTouch.bestBid > 0 ? roundPrice01(bookTouch.bestBid) : null;
    const ask = bookTouch?.bestAsk != null && bookTouch.bestAsk > 0 ? roundPrice01(bookTouch.bestAsk) : null;
    if (bid == null || ask == null) return null;
    return Math.max(0, ask - bid) * 100;
  }, [bookTouch]);

  const [autoSizeSetup, setAutoSizeSetup] = useState(true);

  const entryReadiness = useMemo(() => {
    const s = ptbContext?.readinessState ?? null;
    const ln = ptbContext?.readinessLane ?? null;
    const why = ptbContext?.readinessWhy ?? null;
    return { state: s, lane: ln, why };
  }, [ptbContext?.readinessLane, ptbContext?.readinessState, ptbContext?.readinessWhy]);

  /** Advisory only — desk no longer hard-blocks touch buys on chop (was too strict for active traders). */
  const chopAdvisory = useMemo(() => {
    if (!ptbContext) return false;
    const ctrl = ptbContext.controlSignal;
    const reg = ptbContext.structureEvent;
    return ctrl === 'NO_EDGE' || reg === 'chop';
  }, [ptbContext]);

  const buyGate = useMemo(() => {
    if (action !== 'buy') return { ok: true, reason: null as string | null };
    if (accountMode === 'paper') return { ok: true, reason: null as string | null };
    if (!token?.trim()) return { ok: false, reason: 'Token not ready yet.' };
    if (execMode !== 'touch') return { ok: true, reason: null as string | null };
    if (spreadCents != null) {
      const max = entryReadiness.state === 'ENTER' ? 2.5 : entryReadiness.state === 'SETUP' ? 4.0 : 2.4;
      if (spreadCents > max) return { ok: false, reason: `Spread too wide (${spreadCents.toFixed(1)}¢ > ${max.toFixed(1)}¢).` };
    }
    return { ok: true, reason: null as string | null };
  }, [
    accountMode,
    action,
    entryReadiness.state,
    execMode,
    spreadCents,
    token,
    upLabel,
    downLabel,
  ]);

  const targets = useMemo(() => {
    const sideLabel = action === 'buy' ? 'TP (sell)' : 'TP (buyback)';
    return buildQuoteAssistTargets({
      quote01: executableQuote01,
      bestBid: bookTouch?.bestBid,
      bestAsk: bookTouch?.bestAsk,
      sideLabel,
    });
  }, [action, bookTouch, executableQuote01]);

  /** Seed resting bid (¢) from the book when the outcome changes; do not chase every tick once set for that token. */
  const buyBidAutoSeedRef = useRef<string | null>(null);
  useEffect(() => {
    if (action !== 'buy' || !token) {
      buyBidAutoSeedRef.current = null;
      return;
    }
    const ask = bookTouch?.bestAsk;
    if (ask == null || !Number.isFinite(ask) || ask <= 0 || ask >= 1) {
      if (buyBidAutoSeedRef.current != null && buyBidAutoSeedRef.current !== token) buyBidAutoSeedRef.current = null;
      return;
    }
    const seededFor = buyBidAutoSeedRef.current === token;
    const c = Math.max(1, Math.min(99, Math.round(ask * 100 - 1)));
    const next = String(c);
    if (!seededFor) {
      buyBidAutoSeedRef.current = token;
      setBuyBidCents(next);
      return;
    }
    setBuyBidCents((prev) => (prev.trim() === '' ? next : prev));
  }, [action, token, bookTouch?.bestAsk]);

  useEffect(() => {
    if (!isSlide) return;
    setExecMode('touch');
  }, [isSlide]);

  useEffect(() => {
    if (isSlide) setShowAdvanced(false);
  }, [isSlide]);

  useEffect(() => {
    const onSync = () => {
      setPaperAccount(loadPaperAccount());
      setPaperOrders(loadPaperOrders());
      setHistoryRows(loadTradeHistory());
    };
    window.addEventListener(PAPER_ACCOUNT_SYNC_EVENT, onSync);
    return () => window.removeEventListener(PAPER_ACCOUNT_SYNC_EVENT, onSync);
  }, []);

  useEffect(() => {
    const onOrders = () => setPaperOrders(loadPaperOrders());
    window.addEventListener(PAPER_ORDERS_SYNC_EVENT, onOrders);
    return () => window.removeEventListener(PAPER_ORDERS_SYNC_EVENT, onOrders);
  }, []);

  useEffect(() => {
    let t: ReturnType<typeof window.setTimeout> | null = null;
    const onHist = () => {
      if (t != null) window.clearTimeout(t);
      t = window.setTimeout(() => {
        t = null;
        setHistoryRows(loadTradeHistory());
      }, 120);
    };
    window.addEventListener(TRADE_HISTORY_CHANGED_EVENT, onHist);
    return () => {
      if (t != null) window.clearTimeout(t);
      window.removeEventListener(TRADE_HISTORY_CHANGED_EVENT, onHist);
    };
  }, []);

  /**
   * Subscribe to sectional decision events from `PtbOpportunityModeChart` so the user
   * gets a toast notification when momentum is about to flip on a 1h / 4h market.
   * Status WAIT is ignored; identical (status,lane,confidence) tuples are deduped
   * so we don't spam toasts on every micro tick when the engine stays put.
   */
  const sectionalToastSeenRef = useRef<string>('');
  useEffect(() => {
    const handler = (ev: Event) => {
      const ce = ev as CustomEvent<SectionalDecisionDetail>;
      const d = ce.detail;
      if (!d || !d.status || d.status === 'WAIT') return;
      const panelSlug = marketSlug?.trim();
      const evSlug = (d.slug ?? '').trim();
      if (panelSlug && evSlug && evSlug !== panelSlug) return;
      const dedupe = `${d.slug}|${d.status}|${d.lane ?? '-'}|${d.incomingLane ?? '-'}|${d.confidence}`;
      if (dedupe === sectionalToastSeenRef.current) return;
      sectionalToastSeenRef.current = dedupe;
      const kind: 'ok' | 'err' | 'info' =
        d.status === 'EXIT'
          ? 'err'
          : d.status === 'SWITCH_INCOMING'
            ? 'info'
            : d.status === 'GO_IN' || d.status === 'STAY_IN'
              ? 'ok'
              : 'info';
      const ttl = d.confidence === 'HIGH' ? 8200 : d.confidence === 'MED' ? 6200 : 4800;
      pushToast(kind, `${d.headline} — ${d.reason}`, ttl);
    };
    window.addEventListener(SECTIONAL_DECISION_EVENT, handler as EventListener);
    return () => window.removeEventListener(SECTIONAL_DECISION_EVENT, handler as EventListener);
  }, [pushToast, marketSlug]);

  /**
   * Structural alert event — opposite-momentum / EXIT / triple-confirm entry
   * confirms (HIGH conf + dwell). Always toasts louder (longer TTL) regardless of dedupe
   * since these are rare actionable moments.
   */
  useEffect(() => {
    const handler = (ev: Event) => {
      const ce = ev as CustomEvent<SectionalBoomDetail>;
      const d = ce.detail;
      if (!d) return;
      const panelSlug = marketSlug?.trim();
      const evSlug = (d.slug ?? '').trim();
      if (panelSlug && evSlug && evSlug !== panelSlug) return;
      // When the operator-verdict mirror is present, treat *its* state as the
      // source of truth — verdict.state can downgrade a TRIPLE_CONFIRM_ENTRY to
      // STAND_DOWN if guards (whipsaw / cooldown / discrepancy) are firing, and
      // we want the toast language to match the card so the operator never sees
      // a "GO IN" toast while the card says "DON'T TRADE".
      const verdictState = d.verdict?.state ?? null;
      const isAwaitingDirective =
        verdictState === 'STAND_DOWN' && d.verdict?.bigVerb === 'No signal yet';
      const isStandDown = verdictState === 'STAND_DOWN' && !isAwaitingDirective;
      const isEnter =
        verdictState === 'GO_LONG' ||
        verdictState === 'GO_SHORT' ||
        (isAwaitingDirective && d.kind === 'TRIPLE_CONFIRM_ENTRY');

      const kind: 'ok' | 'err' | 'info' = isStandDown
        ? 'info'
        : isEnter
          ? 'ok'
          : isAwaitingDirective && d.kind === 'OPPOSITE_INCOMING'
            ? 'info'
            : 'err';
      const icon = isStandDown
        ? '⏸'
        : isEnter
          ? '🟢'
          : d.kind === 'EXIT_NOW' || verdictState === 'EXIT_NOW'
            ? '🛑'
            : '⚡';
      // Big verb mirrors the card. When the card has not produced a line yet, don't paste "No signal yet" on an alert.
      const bigVerb = isAwaitingDirective
        ? d.kind === 'TRIPLE_CONFIRM_ENTRY'
          ? 'TRIPLE CONFIRM'
          : d.kind === 'OPPOSITE_INCOMING'
            ? 'OPPOSITE MOMENTUM'
            : 'EXIT NOW'
        : (d.verdict?.bigVerb ??
          (d.kind === 'TRIPLE_CONFIRM_ENTRY'
            ? 'TRIPLE CONFIRM'
            : d.kind === 'EXIT_NOW'
              ? 'EXIT NOW'
              : 'OPPOSITE MOMENTUM'));
      // Prefer the verdict's headline (concrete prices: "@ 0.62 — TP 0.74 / SL 0.55 · R:R 1.71").
      // When absent, fall back to the original alert headline + reason fragment.
      const headline = isAwaitingDirective
        ? `${d.headline} · ${d.reason}`
        : (d.verdict?.headline ?? `${d.headline} · ${d.reason}`);
      const eta = d.etaSec != null ? ` (~${d.etaSec}s)` : '';
      const agree = d.agreementScore != null ? ` · agree ${Math.round(d.agreementScore)}%` : '';
      // When the verdict already encodes prices we don't need to repeat them; only append cross/edge.
      const hasPrices = !!(d.verdict?.headline);
      const cross = d.crossProb != null ? ` · cross ${Math.round(d.crossProb * 100)}%` : '';
      const edgeTxt =
        !hasPrices && d.edgePerShareUsd != null
          ? ` · edge ${d.edgePerShareUsd >= 0 ? '+' : ''}${d.edgePerShareUsd.toFixed(2)}/sh${d.edgeQuality ? ` ${d.edgeQuality}` : ''}`
          : '';
      const tpSl =
        !hasPrices && d.takeProfit != null && d.stopLoss != null
          ? ` · TP ${d.takeProfit.toFixed(2)} / SL ${d.stopLoss.toFixed(2)}${d.rrRatio != null ? ` · R:R ${d.rrRatio.toFixed(2)}` : ''}`
          : !hasPrices && d.levelsCollapsed
            ? ' · TP/SL N/A (settlement window)'
            : '';
      pushToast(
        kind,
        `${icon} Signal · ${bigVerb}${eta} — ${headline}${agree}${cross}${edgeTxt}${tpSl}`,
        9200,
      );
    };
    window.addEventListener(SECTIONAL_BOOM_EVENT, handler as EventListener);
    return () => window.removeEventListener(SECTIONAL_BOOM_EVENT, handler as EventListener);
  }, [pushToast, marketSlug]);

  /**
   * Imminent PTB-cross alert — model says spot is ≥ 70% likely to cross PTB before
   * the bell. Less directional than the full-screen alert (barrier crossing), so we toast it as
   * "info" with a wide TTL — it's a heads-up, not the trade card.
   */
  const crossImminentSeenRef = useRef<string>('');
  useEffect(() => {
    const handler = (ev: Event) => {
      const ce = ev as CustomEvent<PtbCrossImminentDetail>;
      const d = ce.detail;
      if (!d || !Number.isFinite(d.prob)) return;
      const panelSlug = marketSlug?.trim();
      const evSlug = (d.slug ?? '').trim();
      if (panelSlug && evSlug && evSlug !== panelSlug) return;
      const dedupe = `${d.slug}|${d.currentSide}|${Math.round(d.prob * 10)}`;
      if (dedupe === crossImminentSeenRef.current) return;
      crossImminentSeenRef.current = dedupe;
      const flippingTo =
        d.currentSide === 'above'
          ? d.downLabel
          : d.currentSide === 'below'
            ? d.upLabel
            : 'opposite side';
      const pct = Math.round(d.prob * 100);
      pushToast(
        'info',
        `⟂ PTB CROSS IMMINENT (${pct}%) — model: line likely flips toward ${flippingTo} before bell.`,
        7800,
      );
    };
    window.addEventListener(PTB_CROSS_IMMINENT_EVENT, handler as EventListener);
    return () => window.removeEventListener(PTB_CROSS_IMMINENT_EVENT, handler as EventListener);
  }, [pushToast, marketSlug]);

  const tradeActivitySeqRef = useRef(0);
  const [tradeActivityLog, setTradeActivityLog] = useState<{ id: number; ts: number; text: string }[]>([]);
  const pushTradeActivity = useCallback((text: string) => {
    const id = (tradeActivitySeqRef.current += 1);
    setTradeActivityLog((xs) => [{ id, ts: Date.now(), text }, ...xs].slice(0, 12));
  }, []);

  /** After any sell, resize or disarm SL/TP so client automation matches the new position immediately (market / Max / poll). */
  const syncRiskAutomationAfterSellFill = useCallback((estimatedRemainingShares: number) => {
    const rem = floorShares4(estimatedRemainingShares);
    if (isOutcomePositionFlat(rem)) {
      bracketOutcomeTokenRef.current = null;
      bracketOutcomeLaneRef.current = null;
      setBracketPollToken(null);
      trailingTpPeakByTokRef.current.clear();
      dispatchSignalsClearHold({ lane });
      if (!stopLossEnabled && !takeProfitEnabled) return;
      if (stopLossEnabled) {
        stopLossLastFireTokRef.current = null;
        stopLossFireLockRef.current = false;
        setStopLossEnabled(false);
        setStopLossStatus('OFF');
        setStopLossStopCents('');
        setStopLossLimitCents('');
        setStopLossShares('');
      }
      if (takeProfitEnabled) {
        takeProfitLastFireTokRef.current = null;
        takeProfitFireLockRef.current = false;
        setTakeProfitEnabled(false);
        setTakeProfitStatus('OFF');
        setTakeProfitTakeCents('');
        setTakeProfitLimitCents('');
        setTakeProfitShares('');
      }
      return;
    }
    stopLossLastCrossRef.current = null;
    stopLossPrevBidRef.current = null;
    stopLossPrevAskRef.current = null;
    stopLossPrevStripMidRef.current = null;
    takeProfitLastCrossRef.current = null;
    takeProfitPrevBidRef.current = null;
    takeProfitPrevAskRef.current = null;
    takeProfitPrevStripMidRef.current = null;
    if (stopLossEnabled) {
      stopLossLastFireTokRef.current = null;
      stopLossFireLockRef.current = false;
      setStopLossShares(String(rem));
      setStopLossStatus('ARMED');
    }
    if (takeProfitEnabled) {
      takeProfitLastFireTokRef.current = null;
      takeProfitFireLockRef.current = false;
      setTakeProfitShares(String(rem));
      setTakeProfitStatus('ARMED');
    }
  }, [lane, stopLossEnabled, takeProfitEnabled]);

  /** Disarm SL/TP / desk exits when the exchange shows zero shares (sold on Polymarket / Bullpen). */
  const maybeDisarmOnManualFlat = useCallback(() => {
    const deskRisk =
      deskScalpPrefsRef.current.trailingProfit || deskScalpPrefsRef.current.takeLossWhenDeskTpBelowEntry;
    const automationOn =
      stopLossEnabled ||
      takeProfitEnabled ||
      Boolean(bracketPollToken?.trim()) ||
      deskRisk;
    if (!automationOn) {
      bracketHadPositionRef.current = false;
      externalFlatNotifiedTokRef.current = null;
      return;
    }

    const L = armedBracketLane ?? bracketOutcomeLaneRef.current ?? lane;
    const tok =
      bracketPollToken?.trim() ||
      bracketOutcomeTokenRef.current?.trim() ||
      (L === 'up' ? upToken?.trim() : downToken?.trim()) ||
      '';
    const clobBal = L === 'up' ? balUp : balDown;
    const sellSh = liveLaneShares('sell', L);

    if (sellSh > 0) {
      bracketHadPositionRef.current = true;
      externalFlatNotifiedTokRef.current = null;
      return;
    }
    if (!isExternallyFlatPosition({ clobBal, sellShares: sellSh })) return;

    const hadTracked =
      bracketHadPositionRef.current ||
      stopLossEnabled ||
      takeProfitEnabled ||
      Boolean(bracketPollToken?.trim());
    if (!hadTracked) return;

    bracketHadPositionRef.current = false;
    syncRiskAutomationAfterSellFill(0);

    if (externalFlatNotifiedTokRef.current !== tok) {
      externalFlatNotifiedTokRef.current = tok;
      pushTradeActivity('Position flat (sold elsewhere) — automation disarmed');
      pushToast('info', 'Position closed manually — SL/TP and desk exits turned off.', 6500);
      if (tok && accountMode === 'live') {
        void reconcileTradeHistoryFromClob(tok, { force: true }).then(() => setHistoryRows(loadTradeHistory()));
      }
    }
  }, [
    accountMode,
    armedBracketLane,
    balDown,
    balUp,
    bracketPollToken,
    lane,
    liveLaneShares,
    pushToast,
    pushTradeActivity,
    stopLossEnabled,
    syncRiskAutomationAfterSellFill,
    takeProfitEnabled,
    downToken,
    upToken,
  ]);

  const applyInstantMaxSellQty = useCallback(
    (shares: number) => {
      const v = floorSharesWhole(shares);
      if (!(v > 0)) {
        setSellQty('0');
        syncRiskAutomationAfterSellFill(0);
        return;
      }
      setSellQty(String(v));
      syncRiskAutomationAfterSellFill(v);
    },
    [syncRiskAutomationAfterSellFill],
  );

  const applyMaxSellFromCache = useCallback(
    (targetLane?: 'up' | 'down') => {
      const L = targetLane ?? lane;
      const sh = resolveInstantMaxSellShares(L);
      applyInstantMaxSellQty(sh);
      return sh;
    },
    [applyInstantMaxSellQty, lane, resolveInstantMaxSellShares],
  );

  const syncBracketSharesFromPosition = useCallback(
    (shares: number) => {
      const rem = floorShares4(shares);
      if (!(rem > 0)) return;
      const s = String(rem);
      if (stopLossEnabled && (stopLossSimple || !stopLossShares.trim())) {
        setStopLossShares((prev) => (prev === s ? prev : s));
      }
      if (takeProfitEnabled && (takeProfitSimple || !takeProfitShares.trim())) {
        setTakeProfitShares((prev) => (prev === s ? prev : s));
      }
    },
    [stopLossEnabled, stopLossShares, stopLossSimple, takeProfitEnabled, takeProfitShares, takeProfitSimple],
  );

  useEffect(() => {
    if (!okMsg) return;
    if (isSlide) pushFlash(okMsg);
    pushToast('ok', okMsg);
    playTradeFill();
    if (!isSlide) {
      const t = window.setTimeout(() => setOkMsg(null), 8000);
      return () => window.clearTimeout(t);
    }
  }, [okMsg, isSlide, pushFlash, pushToast]);

  useEffect(() => {
    if (!err) return;
    if (isSlide) pushFlash(err);
    pushToast('err', err, 7200);
    playTradeError();
    if (!isSlide) {
      const t = window.setTimeout(() => setErr(null), 12000);
      return () => window.clearTimeout(t);
    }
  }, [err, isSlide, pushFlash, pushToast]);

  const prevErrForActivityRef = useRef<string | null>(null);
  useEffect(() => {
    if (err && err !== prevErrForActivityRef.current) {
      prevErrForActivityRef.current = err;
      pushTradeActivity(`Error · ${err.length > 220 ? `${err.slice(0, 220)}…` : err}`);
    }
    if (!err) prevErrForActivityRef.current = null;
  }, [err, pushTradeActivity]);

  const prevOkForActivityRef = useRef<string | null>(null);
  useEffect(() => {
    if (!okMsg) {
      prevOkForActivityRef.current = null;
      return;
    }
    if (okMsg === prevOkForActivityRef.current) return;
    prevOkForActivityRef.current = okMsg;
    const m = okMsg.toLowerCase();
    if (
      m.includes('bought') ||
      m.includes('sold') ||
      m.includes('buy sent') ||
      m.includes('sell sent') ||
      m.includes('paper filled') ||
      m.includes('paper order resting') ||
      m.includes('bid placed') ||
      m.includes('market sell') ||
      m.includes('sell-all') ||
      m.includes('cancel-all') ||
      m.includes('cancel sent')
    ) {
      pushTradeActivity(okMsg);
    }
  }, [okMsg, pushTradeActivity]);

  const lastAutoSellLogKeyRef = useRef('');
  useEffect(() => {
    if (!lastAutoSell) return;
    const key = `${lastAutoSell.ts}-${lastAutoSell.kind}-${lastAutoSell.status}-${lastAutoSell.orderId ?? ''}-${lastAutoSell.fillCents ?? ''}`;
    if (key === lastAutoSellLogKeyRef.current) return;
    lastAutoSellLogKeyRef.current = key;
    const st = lastAutoSell.status === 'filled' ? 'filled' : lastAutoSell.status === 'sent' ? 'sent' : 'failed';
    const ref =
      lastAutoSell.refCents != null ? ` · bid ${lastAutoSell.refCents.toFixed(1)}¢` : '';
    const avg =
      lastAutoSell.fillCents != null
        ? ` · fill ${formatFillCents(lastAutoSell.fillCents / 100, 1)}`
        : '';
    pushTradeActivity(
      `Auto ${lastAutoSell.kind === 'sl' ? 'SL' : 'TP'} ${st} · stop ${lastAutoSell.triggerCents.toFixed(1)}¢${ref} · limit ${lastAutoSell.limitCents.toFixed(1)}¢ · ${lastAutoSell.shares.toFixed(2)} sh${avg}`,
    );
  }, [lastAutoSell, pushTradeActivity]);

  /** Keep bracket sell banner in sync with reconciled trade history (exchange VWAP). */
  useEffect(() => {
    if (!lastAutoSell) return;
    if (lastAutoSell.mode !== 'live') return;
    const tok = token?.trim();
    if (!tok) return;
    const wantSl = lastAutoSell.kind === 'sl';
    const audMatch = (note: string | undefined) => {
      const a = String(note ?? '').toLowerCase();
      return wantSl ? a.includes('stop_loss') : a.includes('take_profit');
    };
    const oid = lastAutoSell.orderId?.trim();
    let row = oid
      ? historyRows.find(
          (r) =>
            r.mode === 'live' &&
            r.token.trim() === tok &&
            r.orderId?.trim() === oid,
        )
      : undefined;
    if (!row) {
      const winAfter = 180_000;
      row = historyRows
        .filter(
          (r) =>
            r.mode === 'live' &&
            r.token.trim() === tok &&
            r.side === 'sell' &&
            audMatch(r.auditNote) &&
            r.ts >= lastAutoSell.ts - 60_000 &&
            r.ts <= lastAutoSell.ts + winAfter,
        )
        .sort((a, b) => b.ts - a.ts)[0];
    }
    const fill = confirmedExchangeFillFromRow(row);
    if (!fill) return;
    setLastAutoSell((p) => {
      if (!p) return p;
      if (p.kind !== (wantSl ? 'sl' : 'tp')) return p;
      if (
        p.fillCents != null &&
        Math.abs(p.fillCents - fill.fillCents) < 0.05 &&
        Math.abs(p.shares - fill.shares) < 1e-4
      ) {
        return p;
      }
      return {
        ...p,
        status: row!.status === 'filled' ? 'filled' : p.status,
        fillCents: fill.fillCents,
        shares: fill.shares,
        orderId: row!.orderId ?? p.orderId,
      };
    });
  }, [historyRows, lastAutoSell, token]);

  const lastAutoSellAvgCallout = useMemo(() => {
    if (!lastAutoSell) return null;
    if (lastAutoSell.fillCents != null) {
      return (
        <div className="mt-1.5 border-t border-white/10 pt-1.5 font-mono text-[14px] font-black tabular-nums tracking-tight text-zinc-50">
          Avg sell · {formatFillCents(lastAutoSell.fillCents / 100, 1)}
        </div>
      );
    }
    if (lastAutoSell.status === 'sent') {
      return (
        <div className="mt-1.5 border-t border-white/10 pt-1.5 text-[11px] leading-snug text-zinc-400">
          Execution price: waiting for exchange — check the amber <span className="font-semibold text-amber-200/90">Live order status</span> card and{' '}
          <span className="font-semibold text-zinc-300">Recent fills</span> (avg column) below.
        </div>
      );
    }
    return null;
  }, [lastAutoSell]);

  const prevStopLossEnabledActivityRef = useRef(stopLossEnabled);
  useEffect(() => {
    if (prevStopLossEnabledActivityRef.current !== stopLossEnabled) {
      pushTradeActivity(stopLossEnabled ? 'Stop-loss automation enabled' : 'Stop-loss automation disabled');
      prevStopLossEnabledActivityRef.current = stopLossEnabled;
    }
  }, [stopLossEnabled, pushTradeActivity]);

  const prevTakeProfitEnabledActivityRef = useRef(takeProfitEnabled);
  useEffect(() => {
    if (prevTakeProfitEnabledActivityRef.current !== takeProfitEnabled) {
      pushTradeActivity(takeProfitEnabled ? 'Take-profit automation enabled' : 'Take-profit automation disabled');
      prevTakeProfitEnabledActivityRef.current = takeProfitEnabled;
    }
  }, [takeProfitEnabled, pushTradeActivity]);

  const prevStopLossStatusActivityRef = useRef(stopLossStatus);
  useEffect(() => {
    if (prevStopLossStatusActivityRef.current !== stopLossStatus && stopLossStatus === 'TRIGGERED') {
      pushTradeActivity('Stop-loss TRIGGERED — submitting auto-sell…');
    }
    prevStopLossStatusActivityRef.current = stopLossStatus;
  }, [stopLossStatus, pushTradeActivity]);

  const prevTakeProfitStatusActivityRef = useRef(takeProfitStatus);
  useEffect(() => {
    if (prevTakeProfitStatusActivityRef.current !== takeProfitStatus && takeProfitStatus === 'TRIGGERED') {
      pushTradeActivity('Take-profit TRIGGERED — submitting auto-sell…');
    }
    prevTakeProfitStatusActivityRef.current = takeProfitStatus;
  }, [takeProfitStatus, pushTradeActivity]);

  useEffect(() => {
    return () => {
      if (killArmTimerRef.current != null) window.clearTimeout(killArmTimerRef.current);
      for (const t of toastTimersRef.current.values()) window.clearTimeout(t);
      toastTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(ARM_RISK_AFTER_BUY_KEY, JSON.stringify(armRiskAfterBuy));
    } catch {
      /* ignore */
    }
  }, [armRiskAfterBuy]);

  useEffect(() => {
    try {
      window.localStorage.setItem(EMERGENCY_STOP_BUNDLE_PREFS_KEY, JSON.stringify(emergencyStopBundlePrefs));
    } catch {
      /* ignore */
    }
  }, [emergencyStopBundlePrefs]);

  useEffect(() => {
    const keepSlideDock = isSlide && preserveSlideDockRef.current;
    if (!keepSlideDock) {
      setRiskSellSheet(null);
    }
    setPlanStandardCents('');
    buyRiskArmedRowIdsRef.current.clear();
    buyReconcileToastRowIdsRef.current.clear();
    if (!keepSlideDock) {
      bracketArmedPinRef.current = null;
      operatorSlTpLockedRef.current = false;
      buyBundleChaseFrozenRef.current = false;
    }
  }, [token, isSlide]);

  const prevMarketSlugForDockRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const slug = marketSlug?.trim() ?? '';
    const prev = prevMarketSlugForDockRef.current;
    const marketChanged = prev !== undefined && prev !== slug;
    prevMarketSlugForDockRef.current = slug;
    if (marketChanged) {
      preserveSlideDockRef.current = false;
      setSlideDockTab('outcome');
    }
    setRiskSellSheet(null);
    setPlanStandardCents('');
    buyRiskArmedRowIdsRef.current.clear();
    buyReconcileToastRowIdsRef.current.clear();
    if (marketChanged) {
      bracketArmedPinRef.current = null;
      operatorSlTpLockedRef.current = false;
      buyBundleChaseFrozenRef.current = false;
      setBracketPollToken(null);
    }
  }, [marketSlug, setSlideDockTab]);

  const avgEntry = accountMode === 'paper' ? paperPos.avgCost01 : liveAvgEntry;

  /** Live: never inflate position from pending intent — balances come from CLOB after fill. */
  const optimisticPositionShares = positionShares;

  /** TP/SL levels anchored to average entry (when holding) — better than quote-only assists. */
  const riskTargetsFromEntry = useMemo(() => {
    if (avgEntry == null || !(avgEntry > 0) || !(avgEntry < 1)) return null;
    if (optimisticPositionShares == null || !(optimisticPositionShares > 0)) return null;
    const bid = bookTouch?.bestBid != null && bookTouch.bestBid > 0 ? roundPrice01(bookTouch.bestBid) : null;
    const ask = bookTouch?.bestAsk != null && bookTouch.bestAsk > 0 ? roundPrice01(bookTouch.bestAsk) : null;
    const spread01 = bid != null && ask != null ? Math.max(0, ask - bid) : 0;
    const tick01 = 0.001;
    const base = Math.max(tick01 * 3, spread01 || tick01 * 5);
    const tp01 = Math.min(0.99, Math.max(0.01, avgEntry + base * 3));
    const stop01 = Math.max(0.01, Math.min(0.99, avgEntry - base * 2));
    return {
      avgCents: (avgEntry * 100).toFixed(1),
      tpCents: (tp01 * 100).toFixed(1),
      stopCents: (stop01 * 100).toFixed(1),
      tp01,
      stop01,
      spreadCents: (spread01 * 100).toFixed(2),
    };
  }, [avgEntry, bookTouch, optimisticPositionShares]);

  /** Apply TP/SL ¢ + enable automation (buy fill, or when Auto-arm SL/TP is toggled on). */
  const applyArmRiskLevels = useCallback(
    (
      opts: {
        entry01: number;
        shares: number | null;
        fromFill: boolean;
        forceOverwrite?: boolean;
        riskLane?: 'up' | 'down';
        /** Freeze card TP/SL at fill time — do not read a later PTB snapshot. */
        signalSnapshot?: SignalRiskSnapshot | null;
      },
      prefsOverride?: ArmRiskAfterBuyPrefs,
    ): { applied: boolean; source: 'signal' | 'spread'; stopCents: string; tpCents: string } => {
      const { armSl, armTp, useSignalLevels } = resolveArmFlags(armRiskAfterBuy, prefsOverride);
      if (!armSl && !armTp) return { applied: false, source: 'spread', stopCents: '', tpCents: '' };
      const entry = roundPrice01(clamp01(opts.entry01));
      if (!(entry > 0) || entry >= 1) return { applied: false, source: 'spread', stopCents: '', tpCents: '' };
      const riskLane = opts.riskLane ?? deskBuyLaneRef.current ?? lane;
      const signal = opts.signalSnapshot ?? signalRiskRef.current;
      const riskBookTouch = riskLane === 'up' ? (bookTouchUp ?? null) : (bookTouchDown ?? null);
      const { stopCents, tpCents, source } = opts.fromFill
        ? resolveArmRiskCentsAfterBuy({
            fillPrice01: entry,
            lane: riskLane,
            bookTouch: riskBookTouch,
            signal,
            useSignalLevels,
          })
        : resolveArmRiskCentsForEntry({
            entry01: entry,
            lane: riskLane,
            bookTouch: riskBookTouch,
            signal,
            useSignalLevels,
          });
      const sh =
        opts.shares != null && opts.shares > 0
          ? floorShares4(opts.shares)
          : positionShares != null && positionShares > 0
            ? floorShares4(positionShares)
            : 0;
      const shStr = sh > 0 ? String(sh) : null;
      const overwrite = opts.forceOverwrite === true;
      if (overwrite && !operatorSlTpLockedRef.current) {
        operatorSlTpLockedRef.current = false;
        bracketArmedPinRef.current = null;
      }
      const armTok = riskLane === 'up' ? upToken?.trim() : downToken?.trim();
      const pin = bracketArmedPinRef.current;
      const operatorLocked = operatorSlTpLockedRef.current;
      const usePin =
        !overwrite &&
        pin != null &&
        armTok != null &&
        pin.token === armTok &&
        pin.lane === riskLane;
      const stopCentsApplied =
        operatorLocked && stopLossStopCents.trim()
          ? stopLossStopCents.trim()
          : usePin
            ? pin.stopCents
            : stopCents;
      const tpCentsApplied =
        operatorLocked && takeProfitTakeCents.trim()
          ? takeProfitTakeCents.trim()
          : usePin
            ? pin.tpCents
            : tpCents;
      /** Keep frozen / operator ¢ unless this call explicitly overwrites (Auto-arm toggle only). */
      const pickCents = (prev: string, next: string) => {
        if (overwrite) return next;
        if (operatorLocked || usePin) return prev.trim() || next;
        if (opts.fromFill) return prev.trim() || next;
        return prev;
      };
      if (armSl) {
        resetStopLossBracketMemory({
          lastCross: stopLossLastCrossRef,
          prevBid: stopLossPrevBidRef,
          prevAsk: stopLossPrevAskRef,
          prevStripMid: stopLossPrevStripMidRef,
          lastFireTok: stopLossLastFireTokRef,
          fireLock: stopLossFireLockRef,
        });
        setSuggestedSlCents(stopCentsApplied);
        setStopLossStopCents((p) => pickCents(p, stopCentsApplied));
        setStopLossLimitCents((p) => pickCents(p, stopCentsApplied));
        if (shStr) setStopLossShares(shStr);
        setStopLossEnabled(true);
        setStopLossStatus('ARMED');
      }
      if (armTp) {
        resetTakeProfitBracketMemory({
          lastCross: takeProfitLastCrossRef,
          prevBid: takeProfitPrevBidRef,
          prevAsk: takeProfitPrevAskRef,
          prevStripMid: takeProfitPrevStripMidRef,
          lastFireTok: takeProfitLastFireTokRef,
          fireLock: takeProfitFireLockRef,
        });
        setSuggestedTpCents(tpCentsApplied);
        setTakeProfitTakeCents((p) => pickCents(p, tpCentsApplied));
        setTakeProfitLimitCents((p) => pickCents(p, tpCentsApplied));
        if (shStr) setTakeProfitShares(shStr);
        setTakeProfitEnabled(true);
        setTakeProfitStatus('ARMED');
      }
      if (armSl || armTp) {
        bracketOutcomeLaneRef.current = riskLane;
        if (armTok) {
          bracketOutcomeTokenRef.current = armTok;
          setBracketPollToken(armTok);
          if (!usePin) {
            bracketArmedPinRef.current = {
              token: armTok,
              lane: riskLane,
              stopCents: stopCentsApplied,
              tpCents: tpCentsApplied,
              source,
              armedAtMs: Date.now(),
            };
          }
        }
      }
      return { applied: true, source, stopCents: stopCentsApplied, tpCents: tpCentsApplied };
    },
    [
      armRiskAfterBuy,
      bookTouchDown,
      bookTouchUp,
      downToken,
      lane,
      positionShares,
      stopLossStopCents,
      takeProfitTakeCents,
      upToken,
    ],
  );

  const applyArmRiskAfterBuyFill = useCallback(
    (fillPrice01: number, sharesFilled: number, riskLane?: 'up' | 'down') => {
      const sh = floorShares4(sharesFilled);
      if (!(sh > 0)) return;
      const rl = riskLane ?? deskBuyLaneRef.current ?? lane;
      if (operatorSlTpLockedRef.current || buyBundleChaseFrozenRef.current || buyBundleArmRef.current) {
        return;
      }
      const signalSnap = cloneSignalRiskSnapshot(signalRiskRef.current);
      const deskHasLevels =
        (stopLossEnabled && stopLossStopCents.trim()) || (takeProfitEnabled && takeProfitTakeCents.trim());
      const deskFrozen =
        operatorSlTpLockedRef.current ||
        (bracketArmedPinRef.current != null && bracketArmedPinRef.current.lane === rl);
      const { applied, source, stopCents, tpCents } = applyArmRiskLevels({
        entry01: fillPrice01,
        shares: sh,
        fromFill: true,
        forceOverwrite: !deskFrozen && !deskHasLevels,
        riskLane: rl,
        signalSnapshot: signalSnap,
      });
      if (!applied) return;
      const toastMsg =
        source === 'signal'
          ? `SL/TP armed from signal card (TP ${tpCents}¢ · SL ${stopCents}¢).`
          : `SL/TP armed from fill + book spread (TP ${tpCents}¢ · SL ${stopCents}¢).`;
      pushToast('info', toastMsg, 5200);
    },
    [applyArmRiskLevels, pushToast],
  );

  const syncDeskTakeProfitArm = useCallback(
    (tpCents: string, shares: number | null | undefined, storageTok?: string | null) => {
      const t = tpCents.trim();
      if (!t) return;
      setTakeProfitTakeCents(t);
      setTakeProfitLimitCents(t);
      setTakeProfitEnabled(true);
      setTakeProfitStatus('ARMED');
      const sh =
        shares != null && Number.isFinite(shares) && shares > 0 ? floorShares4(shares) : NaN;
      if (Number.isFinite(sh) && sh > 0) setTakeProfitShares(String(sh));
      const tok = (storageTok ?? bracketOutcomeTokenRef.current ?? token)?.trim() ?? '';
      if (tok && Number.isFinite(sh) && sh > 0) {
        const take01 = bracketCentsStrTo01(t);
        if (take01 != null) {
          saveTakeProfitConfigToStorage(tok, {
            enabled: true,
            take01: clamp01(take01),
            limit01: clamp01(take01),
            shares: sh,
            simple: takeProfitSimple,
            dualBook: takeProfitDualBook,
          });
        }
      }
    },
    [takeProfitDualBook, takeProfitSimple, token],
  );

  const applyFilledBuyBundle = useCallback(
    (params: { rowTok: string; riskLane: 'up' | 'down'; shares: number; sl: string; tp: string }) => {
      const shStr = params.shares > 0 ? String(floorShares4(params.shares)) : '';
      const shNum = shStr ? Number(shStr) : NaN;
      const storageTok = params.rowTok.trim();
      operatorSlTpLockedRef.current = true;
      bracketOutcomeLaneRef.current = params.riskLane;
      bracketOutcomeTokenRef.current = params.rowTok;
      bracketLaneDraftRef.current[params.riskLane] = {
        sl: params.sl || bracketLaneDraftRef.current[params.riskLane].sl,
        tp: params.tp || bracketLaneDraftRef.current[params.riskLane].tp,
      };
      if (params.sl) {
        setStopLossStopCents(params.sl);
        setStopLossLimitCents(params.sl);
        setStopLossEnabled(true);
        setStopLossStatus('ARMED');
        if (shStr) setStopLossShares(shStr);
      }
      if (params.tp) {
        syncDeskTakeProfitArm(params.tp, shNum, storageTok);
      }
      bracketArmedPinRef.current = {
        token: params.rowTok,
        lane: params.riskLane,
        stopCents: params.sl,
        tpCents: params.tp,
        source: 'desk',
        armedAtMs: Date.now(),
      };
      setBracketPollToken(params.rowTok);
      if (storageTok) {
        saveBracketLevelsDraft(storageTok, {
          sl: params.sl || bracketLaneDraftRef.current[params.riskLane].sl,
          tp: params.tp || bracketLaneDraftRef.current[params.riskLane].tp,
        });
        if (params.sl && Number.isFinite(shNum) && shNum > 0) {
          const stop01 = bracketCentsStrTo01(params.sl);
          if (stop01 != null) {
            saveStopLossConfigToStorage(storageTok, {
              enabled: true,
              stop01: clamp01(stop01),
              limit01: clamp01(stop01),
              shares: shNum,
              simple: stopLossSimple,
              dualBook: stopLossDualBook,
            });
          }
        }
        if (params.tp && Number.isFinite(shNum) && shNum > 0) {
          const take01 = bracketCentsStrTo01(params.tp);
          if (take01 != null) {
            saveTakeProfitConfigToStorage(storageTok, {
              enabled: true,
              take01: clamp01(take01),
              limit01: clamp01(take01),
              shares: shNum,
              simple: takeProfitSimple,
              dualBook: takeProfitDualBook,
            });
          }
        }
      }
      setBuyBundleByLane((prev) => ({ ...prev, [params.riskLane]: { sl: '', tp: '' } }));
    },
    [stopLossDualBook, stopLossSimple, syncDeskTakeProfitArm, takeProfitDualBook, takeProfitSimple],
  );

  /** When Auto-arm SL/TP is checked — apply card/spread levels immediately (not only after next buy). */
  const applyArmRiskNow = useCallback((prefsOverride?: ArmRiskAfterBuyPrefs) => {
    const prefs = prefsOverride ?? armRiskAfterBuy;
    const { armSl, armTp } = resolveArmFlags(armRiskAfterBuy, prefsOverride);
    if (!armSl && !armTp) return;
    if (operatorSlTpLockedRef.current) return;
    const riskLane = deskBuyLaneRef.current ?? lane;
    const snap = signalRiskRef.current;
    const riskMid =
      riskLane === 'up'
        ? (bookMidUp ?? upMid ?? null)
        : (bookMidDown ?? downMid ?? null);
    const entry01 =
      snap?.lane === riskLane && snap.entry01 > 0 && snap.entry01 < 1
        ? snap.entry01
        : avgEntry != null && avgEntry > 0 && avgEntry < 1
          ? avgEntry
          : riskMid != null && riskMid > 0 && riskMid < 1
            ? riskMid
            : null;
    if (entry01 == null) {
      pushToast('info', 'Auto-arm needs avg entry, signal entry, or mid — open Signals or buy first.', 4800);
      return;
    }
    const { applied, source, stopCents, tpCents } = applyArmRiskLevels(
      {
        entry01,
        shares: positionShares,
        fromFill: false,
        forceOverwrite: true,
        riskLane,
        signalSnapshot: snap,
      },
      prefs,
    );
    if (!applied) return;
    const parts: string[] = [];
    if (armSl) parts.push(`SL ${stopCents}¢`);
    if (armTp) parts.push(`TP ${tpCents}¢`);
    pushToast(
      'info',
      source === 'signal'
        ? `Auto-arm: ${parts.join(' · ')} from signal card.`
        : `Auto-arm: ${parts.join(' · ')} from entry + spread.`,
      5200,
    );
  }, [
    applyArmRiskLevels,
    armRiskAfterBuy,
    avgEntry,
    bookMidDown,
    bookMidUp,
    downMid,
    lane,
    positionShares,
    pushToast,
    upMid,
  ]);

  applyArmRiskNowRef.current = applyArmRiskNow;

  const onAutoArmMasterChange = useCallback(
    (enabled: boolean) => {
      setArmRiskAfterBuy((p) => {
        const merged: ArmRiskAfterBuyPrefs = {
          ...p,
          autoArmEnabled: enabled,
          armSl: enabled ? p.armSl || true : false,
          armTp: enabled ? p.armTp : false,
        };
        if (enabled && !operatorSlTpLockedRef.current) {
          queueMicrotask(() => applyArmRiskNow(merged));
        }
        return merged;
      });
    },
    [applyArmRiskNow],
  );

  const onAutoArmSlChange = useCallback(
    (checked: boolean) => {
      setArmRiskAfterBuy((p) => {
        const merged = { ...p, autoArmEnabled: checked || p.autoArmEnabled, armSl: checked };
        if (checked && !operatorSlTpLockedRef.current) {
          queueMicrotask(() => applyArmRiskNow(merged));
        }
        return merged;
      });
    },
    [applyArmRiskNow],
  );

  const onAutoArmTpChange = useCallback(
    (checked: boolean) => {
      setArmRiskAfterBuy((p) => {
        const merged = { ...p, autoArmEnabled: checked || p.autoArmEnabled, armTp: checked };
        if (checked && !operatorSlTpLockedRef.current) {
          queueMicrotask(() => applyArmRiskNow(merged));
        }
        return merged;
      });
    },
    [applyArmRiskNow],
  );

  const commitTakeProfitArmed = useCallback(
    (opts?: { forceLevels?: boolean; fillLevelsIfEmpty?: boolean }): { applied: boolean; tpCents: string } => {
      const force = opts?.forceLevels === true;
      const fillEmpty = opts?.fillLevelsIfEmpty !== false;
      if (force) {
        operatorSlTpLockedRef.current = false;
        bracketArmedPinRef.current = null;
      }
      const riskLane = bracketOutcomeLaneRef.current ?? deskBuyLaneRef.current ?? lane;
      let tpCentsOut = takeProfitTakeCents.trim();
      const lacksLevels = !tpCentsOut;
      if (fillEmpty && (lacksLevels || force)) {
        const snap = signalRiskRef.current;
        const entry01 =
          avgEntry != null && avgEntry > 0 && avgEntry < 1
            ? avgEntry
            : snap?.lane === riskLane && snap.entry01 > 0 && snap.entry01 < 1
              ? snap.entry01
              : (() => {
                  const riskMid =
                    riskLane === 'up' ? (bookMidUp ?? upMid ?? null) : (bookMidDown ?? downMid ?? null);
                  return riskMid != null && riskMid > 0 && riskMid < 1 ? riskMid : null;
                })();
        if (entry01 != null) {
          const { tpCents } = applyArmRiskLevels(
            {
              entry01,
              shares: positionShares,
              fromFill: false,
              forceOverwrite: force || lacksLevels,
              riskLane,
              signalSnapshot: snap,
            },
            { ...armRiskAfterBuy, armSl: false, armTp: true },
          );
          if (tpCents) {
            tpCentsOut = tpCents;
            setSuggestedTpCents(tpCents);
          }
        } else if (riskTargetsFromEntry?.tpCents) {
          tpCentsOut = riskTargetsFromEntry.tpCents;
          setSuggestedTpCents(tpCentsOut);
        } else if (targets?.tpCents) {
          tpCentsOut = targets.tpCents;
          setSuggestedTpCents(tpCentsOut);
        }
      }
      resetTakeProfitBracketMemory({
        lastCross: takeProfitLastCrossRef,
        prevBid: takeProfitPrevBidRef,
        prevAsk: takeProfitPrevAskRef,
        prevStripMid: takeProfitPrevStripMidRef,
        lastFireTok: takeProfitLastFireTokRef,
        fireLock: takeProfitFireLockRef,
      });
      setTakeProfitEnabled(true);
      setTakeProfitStatus('ARMED');
      const pollTokTp =
        bracketOutcomeTokenRef.current?.trim() ||
        (riskLane === 'up' ? upToken?.trim() : downToken?.trim()) ||
        token?.trim() ||
        null;
      if (pollTokTp) {
        bracketOutcomeTokenRef.current = pollTokTp;
        bracketOutcomeLaneRef.current =
          pollTokTp === upToken?.trim() ? 'up' : pollTokTp === downToken?.trim() ? 'down' : riskLane;
        setBracketPollToken(pollTokTp);
      }
      const takeStr = tpCentsOut || takeProfitTakeCents.trim();
      if (takeStr) {
        setTakeProfitTakeCents(takeStr);
        if (takeProfitSimple) setTakeProfitLimitCents(takeStr);
      }
      const sh =
        Number(takeProfitShares) > 0
          ? floorShares4(Number(takeProfitShares))
          : positionShares != null && positionShares > 0
            ? floorShares4(positionShares)
            : NaN;
      if (!takeProfitShares.trim() && Number.isFinite(sh) && sh > 0) {
        setTakeProfitShares(String(sh));
      }
      if (pollTokTp && takeStr && Number.isFinite(sh) && sh > 0) {
        const take01 = bracketCentsStrTo01(takeStr);
        const limitStr = takeProfitSimple ? takeStr : takeProfitLimitCents.trim() || takeStr;
        const limit01 = bracketCentsStrTo01(limitStr) ?? take01;
        if (take01 != null && limit01 != null) {
          saveTakeProfitConfigToStorage(pollTokTp, {
            enabled: true,
            take01: clamp01(take01),
            limit01: clamp01(limit01),
            shares: sh,
            simple: takeProfitSimple,
            dualBook: takeProfitDualBook,
          });
          saveBracketLevelsDraft(pollTokTp, {
            sl: stopLossStopCentsRef.current,
            tp: takeStr,
          });
        }
      }
      return { applied: Boolean(takeStr), tpCents: takeStr };
    },
    [
      applyArmRiskLevels,
      armRiskAfterBuy.useSignalLevels,
      avgEntry,
      bookMidDown,
      bookMidUp,
      downMid,
      downToken,
      lane,
      positionShares,
      riskTargetsFromEntry,
      takeProfitDualBook,
      takeProfitLimitCents,
      takeProfitSimple,
      takeProfitTakeCents,
      takeProfitShares,
      targets,
      token,
      upMid,
      upToken,
    ],
  );

  const commitStopLossArmed = useCallback(
    (opts?: { forceLevels?: boolean; fillLevelsIfEmpty?: boolean }): { applied: boolean; stopCents: string } => {
      const force = opts?.forceLevels === true;
      const fillEmpty = opts?.fillLevelsIfEmpty !== false;
      if (force) {
        operatorSlTpLockedRef.current = false;
        bracketArmedPinRef.current = null;
      }
      const riskLane = bracketOutcomeLaneRef.current ?? deskBuyLaneRef.current ?? lane;
      let stopCentsOut = stopLossStopCents.trim();
      const lacksLevels = !stopCentsOut;
      if (fillEmpty && (lacksLevels || force)) {
        const snap = signalRiskRef.current;
        const entry01 =
          avgEntry != null && avgEntry > 0 && avgEntry < 1
            ? avgEntry
            : snap?.lane === riskLane && snap.entry01 > 0 && snap.entry01 < 1
              ? snap.entry01
              : (() => {
                  const riskMid =
                    riskLane === 'up' ? (bookMidUp ?? upMid ?? null) : (bookMidDown ?? downMid ?? null);
                  return riskMid != null && riskMid > 0 && riskMid < 1 ? riskMid : null;
                })();
        if (entry01 != null) {
          const { stopCents } = applyArmRiskLevels(
            {
              entry01,
              shares: positionShares,
              fromFill: false,
              forceOverwrite: force || lacksLevels,
              riskLane,
              signalSnapshot: snap,
            },
            { ...armRiskAfterBuy, armSl: true, armTp: false },
          );
          if (stopCents) {
            stopCentsOut = stopCents;
            setSuggestedSlCents(stopCents);
          }
        } else if (riskTargetsFromEntry?.stopCents) {
          stopCentsOut = riskTargetsFromEntry.stopCents;
          setSuggestedSlCents(stopCentsOut);
        } else if (targets?.stopCents) {
          stopCentsOut = targets.stopCents;
          setSuggestedSlCents(stopCentsOut);
        }
      }
      resetStopLossBracketMemory({
        lastCross: stopLossLastCrossRef,
        prevBid: stopLossPrevBidRef,
        prevAsk: stopLossPrevAskRef,
        prevStripMid: stopLossPrevStripMidRef,
        lastFireTok: stopLossLastFireTokRef,
        fireLock: stopLossFireLockRef,
      });
      setStopLossEnabled(true);
      setStopLossStatus('ARMED');
      const pollTokSl =
        bracketOutcomeTokenRef.current?.trim() ||
        (riskLane === 'up' ? upToken?.trim() : downToken?.trim()) ||
        token?.trim() ||
        null;
      if (pollTokSl) {
        bracketOutcomeTokenRef.current = pollTokSl;
        bracketOutcomeLaneRef.current =
          pollTokSl === upToken?.trim() ? 'up' : pollTokSl === downToken?.trim() ? 'down' : riskLane;
        setBracketPollToken(pollTokSl);
      }
      const stopStr = stopCentsOut || stopLossStopCents.trim();
      if (stopStr) {
        setStopLossStopCents(stopStr);
        if (stopLossSimple) setStopLossLimitCents(stopStr);
      }
      const sh =
        Number(stopLossShares) > 0
          ? floorShares4(Number(stopLossShares))
          : positionShares != null && positionShares > 0
            ? floorShares4(positionShares)
            : NaN;
      if (!stopLossShares.trim() && Number.isFinite(sh) && sh > 0) {
        setStopLossShares(String(sh));
      }
      if (pollTokSl && stopStr && Number.isFinite(sh) && sh > 0) {
        const stop01 = bracketCentsStrTo01(stopStr);
        const limitStr = stopLossSimple ? stopStr : stopLossLimitCents.trim() || stopStr;
        const limit01 = bracketCentsStrTo01(limitStr) ?? stop01;
        if (stop01 != null && limit01 != null) {
          saveStopLossConfigToStorage(pollTokSl, {
            enabled: true,
            stop01: clamp01(stop01),
            limit01: clamp01(limit01),
            shares: sh,
            simple: stopLossSimple,
            dualBook: stopLossDualBook,
          });
          saveBracketLevelsDraft(pollTokSl, {
            sl: stopStr,
            tp: takeProfitTakeCentsRef.current,
          });
        }
      }
      return { applied: Boolean(stopStr), stopCents: stopStr };
    },
    [
      applyArmRiskLevels,
      armRiskAfterBuy.useSignalLevels,
      avgEntry,
      bookMidDown,
      bookMidUp,
      downMid,
      downToken,
      lane,
      positionShares,
      riskTargetsFromEntry,
      stopLossDualBook,
      stopLossLimitCents,
      stopLossSimple,
      stopLossStopCents,
      stopLossShares,
      targets,
      token,
      upMid,
      upToken,
    ],
  );

  const openRiskSheet = useCallback(
    (sheet: 'sl' | 'tp' | 'settings') => {
      if (sheet === 'tp') {
        const needsArm = !takeProfitEnabled || !takeProfitTakeCents.trim();
        if (needsArm) {
          const { applied } = commitTakeProfitArmed({
            forceLevels: !takeProfitTakeCents.trim(),
            fillLevelsIfEmpty: true,
          });
          if (!applied) {
            pushToast('info', 'TP armed — set take ¢ in Brackets (need entry, mid, or a position).', 4200);
          } else if (isSlide && slideDockTab !== 'brackets') {
            pushToast('info', 'TP armed — open Brackets tab to edit levels.', 3600);
          }
        }
      } else if (sheet === 'sl') {
        const needsArm = !stopLossEnabled || !stopLossStopCents.trim();
        if (needsArm) {
          const { applied } = commitStopLossArmed({
            forceLevels: !stopLossStopCents.trim(),
            fillLevelsIfEmpty: true,
          });
          if (!applied) {
            pushToast('info', 'SL armed — set stop ¢ in Brackets (need entry, mid, or a position).', 4200);
          } else if (isSlide && slideDockTab !== 'brackets') {
            pushToast('info', 'SL armed — open Brackets tab to edit levels.', 3600);
          }
        }
      }
      setRiskSellSheet(sheet);
    },
    [
      commitStopLossArmed,
      commitTakeProfitArmed,
      isSlide,
      pushToast,
      slideDockTab,
      stopLossEnabled,
      stopLossStopCents,
      takeProfitEnabled,
      takeProfitTakeCents,
    ],
  );

  useEffect(() => {
    const onArmRequest = (ev: Event) => {
      const d = (ev as CustomEvent<BpxBracketArmRequestDetail>).detail;
      if (!d || (d.kind !== 'sl' && d.kind !== 'tp')) return;
      if (d.kind === 'tp') {
        commitTakeProfitArmed({ forceLevels: !takeProfitTakeCents.trim(), fillLevelsIfEmpty: true });
      } else {
        commitStopLossArmed({ forceLevels: !stopLossStopCents.trim(), fillLevelsIfEmpty: true });
      }
    };
    window.addEventListener(BPX_BRACKET_ARM_REQUEST_EVENT, onArmRequest as EventListener);
    return () => window.removeEventListener(BPX_BRACKET_ARM_REQUEST_EVENT, onArmRequest as EventListener);
  }, [commitStopLossArmed, commitTakeProfitArmed, stopLossStopCents, takeProfitTakeCents]);

  /** Both armed with take ≤ stop — brackets overlap or invert; automation order is undefined. */
  const riskBracketInverted = useMemo(() => {
    if (!stopLossEnabled || !takeProfitEnabled) return false;
    const stop01 = centsStrTo01(stopLossStopCents);
    const take01 = centsStrTo01(takeProfitTakeCents);
    if (stop01 == null || take01 == null) return false;
    return take01 <= stop01;
  }, [stopLossEnabled, takeProfitEnabled, stopLossStopCents, takeProfitTakeCents]);

  const applyStopLossTriggerCents = useCallback(
    (v: string) => {
      operatorSlTpLockedRef.current = true;
      bracketLaneDraftRef.current[lane] = { ...bracketLaneDraftRef.current[lane], sl: v };
      setStopLossStopCents(v);
      setStopLossLimitCents(v);
      setBuyBundleByLane((prev) => ({ ...prev, [lane]: { ...prev[lane], sl: v } }));
      syncBracketPinFromOperatorEdits({ stopCents: v });
      const storageTok =
        bracketPollToken?.trim() ||
        bracketOutcomeTokenRef.current?.trim() ||
        riskPrefsToken ||
        '';
      if (riskPrefsToken) {
        saveBracketLevelsDraft(riskPrefsToken, {
          sl: v,
          tp: takeProfitTakeCentsRef.current,
        });
      }
      if (storageTok) {
        saveBracketLevelsDraft(storageTok, { sl: v, tp: takeProfitTakeCentsRef.current });
      }
      if (positionShares != null && positionShares > 0) {
        setStopLossShares(String(floorShares4(positionShares)));
      }
      if (stopLossEnabled && storageTok) {
        const stop01 = bracketCentsStrTo01(v);
        const sh =
          Number(stopLossShares) > 0
            ? Number(stopLossShares)
            : positionShares != null && positionShares > 0
              ? floorShares4(positionShares)
              : NaN;
        if (stop01 != null && Number.isFinite(sh) && sh > 0) {
          saveStopLossConfigToStorage(storageTok, {
            enabled: true,
            stop01: clamp01(stop01),
            limit01: clamp01(stop01),
            shares: sh,
            simple: stopLossSimple,
            dualBook: stopLossDualBook,
          });
        }
      }
    },
    [
      bracketPollToken,
      lane,
      positionShares,
      riskPrefsToken,
      stopLossDualBook,
      stopLossEnabled,
      stopLossShares,
      stopLossSimple,
      syncBracketPinFromOperatorEdits,
    ],
  );

  const applyTakeProfitTriggerCents = useCallback(
    (v: string) => {
      operatorSlTpLockedRef.current = true;
      bracketLaneDraftRef.current[lane] = { ...bracketLaneDraftRef.current[lane], tp: v };
      setTakeProfitTakeCents(v);
      setTakeProfitLimitCents(v);
      setBuyBundleByLane((prev) => ({ ...prev, [lane]: { ...prev[lane], tp: v } }));
      syncBracketPinFromOperatorEdits({ tpCents: v });
      const storageTok =
        bracketPollToken?.trim() ||
        bracketOutcomeTokenRef.current?.trim() ||
        riskPrefsToken ||
        '';
      if (riskPrefsToken) {
        saveBracketLevelsDraft(riskPrefsToken, {
          sl: stopLossStopCentsRef.current,
          tp: v,
        });
      }
      if (storageTok) {
        saveBracketLevelsDraft(storageTok, { sl: stopLossStopCentsRef.current, tp: v });
      }
      if (positionShares != null && positionShares > 0) {
        setTakeProfitShares(String(floorShares4(positionShares)));
      }
      if (takeProfitEnabled && storageTok) {
        const take01 = bracketCentsStrTo01(v);
        const sh =
          Number(takeProfitShares) > 0
            ? Number(takeProfitShares)
            : positionShares != null && positionShares > 0
              ? floorShares4(positionShares)
              : NaN;
        if (take01 != null && Number.isFinite(sh) && sh > 0) {
          saveTakeProfitConfigToStorage(storageTok, {
            enabled: true,
            take01: clamp01(take01),
            limit01: clamp01(take01),
            shares: sh,
            simple: takeProfitSimple,
            dualBook: takeProfitDualBook,
          });
        }
      }
    },
    [
      bracketPollToken,
      lane,
      positionShares,
      riskPrefsToken,
      takeProfitDualBook,
      takeProfitEnabled,
      takeProfitShares,
      takeProfitSimple,
      syncBracketPinFromOperatorEdits,
    ],
  );

  const bidTouch01ForExplain = useMemo(() => {
    const t = bookTouch?.bestBid;
    return t != null && t > 0 && t < 1 ? roundPrice01(t) : null;
  }, [bookTouch]);
  const askTouch01ForExplain = useMemo(() => {
    const t = bookTouch?.bestAsk;
    return t != null && t > 0 && t < 1 ? roundPrice01(t) : null;
  }, [bookTouch]);
  const mark01ForBracketExplain = useMemo(() => {
    const m = displayMark01;
    return m != null && m > 0 && m < 1 ? roundPrice01(m) : null;
  }, [displayMark01]);

  /** Mid for bracket triggers — always the **armed outcome** lane, not the visible UP/DOWN tab. */
  const bracketStripMid01 = useMemo(() => {
    const L = armedBracketLane ?? bracketOutcomeLaneRef.current ?? lane;
    const chart = L === 'up' ? upMid : downMid;
    const book = L === 'up' ? (bookMidUp ?? null) : (bookMidDown ?? null);
    const c = chart != null && Number.isFinite(chart) && chart > 0 ? chart : null;
    const b = book != null && Number.isFinite(book) && book > 0 ? book : null;
    const lt = L === 'up' ? lastTradeUp01 : lastTradeDown01;
    let raw: number | null;
    if (accountMode === 'live') {
      // Chart/book update faster than last-trade poll — don't let stale prints block TP.
      raw = c ?? b ?? lt;
    } else {
      raw = c ?? b;
    }
    return raw != null && raw > 0 && raw < 1 ? roundPrice01(raw) : null;
  }, [
    armedBracketLane,
    lane,
    upMid,
    downMid,
    bookMidUp,
    bookMidDown,
    accountMode,
    lastTradeUp01,
    lastTradeDown01,
  ]);

  const bracketAutomationExplain = useMemo(
    () =>
      buildBracketAutomationExplain({
        stopLossEnabled,
        stopLossDualBook,
        stopLossStopCents,
        stopLossLimitCents,
        stopLossShares,
        takeProfitEnabled,
        takeProfitDualBook,
        takeProfitTakeCents,
        takeProfitLimitCents,
        takeProfitShares,
        bidTouch01: bidTouch01ForExplain,
        askTouch01: askTouch01ForExplain,
        mark01: mark01ForBracketExplain,
        tpStripMid01: bracketStripMid01,
        slStripMid01: bracketStripMid01,
        slStopWatchBid01,
        slStopWatchAsk01,
        tpTakeWatchBid01,
        tpTakeWatchAsk01,
        positionShares: optimisticPositionShares,
      }),
    [
      askTouch01ForExplain,
      bidTouch01ForExplain,
      mark01ForBracketExplain,
      optimisticPositionShares,
      slStopWatchAsk01,
      slStopWatchBid01,
      stopLossDualBook,
      stopLossEnabled,
      stopLossLimitCents,
      stopLossShares,
      stopLossStopCents,
      takeProfitDualBook,
      takeProfitEnabled,
      takeProfitLimitCents,
      takeProfitShares,
      takeProfitTakeCents,
      tpTakeWatchAsk01,
      tpTakeWatchBid01,
      bracketStripMid01,
    ],
  );

  const bracketRiskBookIntel = useMemo(() => computeBookIntel(lane === 'up' ? bookUp : bookDown), [lane, bookUp, bookDown]);

  const bracketMomentumUi = useMemo(
    () =>
      buildBracketMomentumUi({
        probUp: probMomentumUp,
        probDown: probMomentumDown,
        lane,
        upLabel,
        downLabel,
        bookIntel: bracketRiskBookIntel,
      }),
    [bracketRiskBookIntel, probMomentumDown, probMomentumUp, downLabel, lane, upLabel],
  );

  const outcomeMomentumUp = useMemo(() => buildOutcomeMomentumXs(probMomentumUp), [probMomentumUp]);
  const outcomeMomentumDown = useMemo(() => buildOutcomeMomentumXs(probMomentumDown), [probMomentumDown]);

  const midCents = mid != null ? mid * 100 : null;
  const defaultLimitCents = useMemo(() => {
    if (midCents == null) return '';
    if (action === 'buy') {
      const c = Math.min(99, Math.max(1, midCents));
      return String(Math.round(c));
    }
    const c = Math.max(1, Math.min(99, midCents));
    return String(Math.round(c));
  }, [midCents, action]);

  const touchLimitCents = useMemo(() => {
    if (midCents == null) return '';
    const bump = action === 'buy' ? 0.8 : -0.8;
    const c = Math.max(1, Math.min(99, midCents + bump));
    return String(Math.round(c));
  }, [midCents, action]);

  useEffect(() => {
    if (accountMode !== 'live') return;
    if (!upToken || !downToken) return;
    let cancelled = false;
    void (async () => {
      setBalLoading(true);
      setBalError(null);
      try {
        const [rC, rU, rD] = await Promise.all([
          tradeBalanceAllowance({ assetType: 'collateral' }),
          tradeBalanceAllowance({ tokenId: upToken, assetType: 'conditional', marketSlug: marketSlug ?? '', outcome: upLabel }),
          tradeBalanceAllowance({ tokenId: downToken, assetType: 'conditional', marketSlug: marketSlug ?? '', outcome: downLabel }),
        ]);
        if (cancelled) return;
        if (isOk(rC)) setAvailUsdc(parseUsdcBalance(rC.data.balance));
        else setAvailUsdc(null);
        if (isOk(rU)) setBalUp(parseOutcomeSharesBalance(rU.data.balance));
        else setBalUp(null);
        if (isOk(rD)) setBalDown(parseOutcomeSharesBalance(rD.data.balance));
        else setBalDown(null);
        if (!isOk(rU) || !isOk(rD)) {
          const err = !isOk(rU) ? (rU as ApiErr).error : (rD as ApiErr).error;
          setBalError(
            err === 'bullpen_not_logged_in'
              ? 'Live balance unavailable — run `bullpen login` on the API host.'
              : 'Position/balance unavailable — check Bullpen login (`bullpen status`) or API live config.',
          );
        }
      } catch {
        if (!cancelled) setBalError('Could not load balances.');
      } finally {
        if (!cancelled) setBalLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountMode, downLabel, downToken, marketSlug, upLabel, upToken]);

  const refreshAvgEntry = useCallback(() => {
    if (accountMode !== 'live') return;
    if (!upToken || !downToken) return;
    const startedAt = performance.now();
    void (async () => {
      try {
        const [u, d] = await Promise.all([
          tradeAvgEntry({ tokenId: upToken, marketSlug: marketSlug ?? '', outcome: upLabel }),
          tradeAvgEntry({ tokenId: downToken, marketSlug: marketSlug ?? '', outcome: downLabel }),
        ]);
        // Prevent out-of-order flips: ignore very stale responses.
        if (performance.now() - startedAt > 20_000) return;
        if (!isOk(u) || !isOk(d)) {
          const eu = !isOk(u) ? (u as ApiErr) : null;
          const ed = !isOk(d) ? (d as ApiErr) : null;
          setAvgEntryErr(
            `avg_entry_unavailable${eu ? ` · up:${eu.error}` : ''}${ed ? ` · down:${ed.error}` : ''}`,
          );
        } else {
          setAvgEntryErr(null);
        }
        if (isOk(u)) {
          setAvgEntryUp(u.data.avgEntry);
          setPosSharesUp(Number.isFinite(u.data.shares) && u.data.shares > 0 ? u.data.shares : null);
        }
        if (isOk(d)) {
          setAvgEntryDown(d.data.avgEntry);
          setPosSharesDown(Number.isFinite(d.data.shares) && d.data.shares > 0 ? d.data.shares : null);
        }
        // Persist last-known values so the UI is instant on reload.
        try {
          const nextUp = isOk(u) ? u.data.avgEntry : null;
          const nextDown = isOk(d) ? d.data.avgEntry : null;
          localStorage.setItem(
            avgEntryCacheKey,
            JSON.stringify({ at: Date.now(), up: nextUp, down: nextDown }),
          );
        } catch {
          /* ignore */
        }
      } catch {
        // Keep last known avg entry on transient errors (avoids "not saving" feel).
        setAvgEntryErr('avg_entry_fetch_failed');
      }
    })();
  }, [accountMode, avgEntryCacheKey, downToken, marketSlug, upLabel, upToken, downLabel, downToken]);

  // Throttle Bullpen-backed reads so the UI doesn't "flip" between delayed responses.
  const avgEntryThrottleRef = useRef<{ lastMs: number; timer: number | null }>({ lastMs: 0, timer: null });
  const liveBalThrottleRef = useRef<{ lastMs: number; timer: number | null }>({ lastMs: 0, timer: null });

  const refreshAvgEntryThrottled = useCallback(() => {
    const minGapMs = 800;
    const now = Date.now();
    const ref = avgEntryThrottleRef.current;
    if (now - ref.lastMs >= minGapMs) {
      ref.lastMs = now;
      refreshAvgEntry();
      return;
    }
    if (ref.timer != null) return;
    ref.timer = window.setTimeout(() => {
      ref.timer = null;
      ref.lastMs = Date.now();
      refreshAvgEntry();
    }, Math.max(0, minGapMs - (now - ref.lastMs)));
  }, [refreshAvgEntry]);

  const liveBalancesRefreshRef = useRef<{ gen: number; inflight: boolean }>({ gen: 0, inflight: false });

  const readLiveBalancesOnce = useCallback(async (opts?: { keepStaleOnFail?: boolean }) => {
    if (!upToken || !downToken) return;
    const [rC, rU, rD] = await Promise.all([
      tradeBalanceAllowance({ assetType: 'collateral' }),
      tradeBalanceAllowance({ tokenId: upToken, assetType: 'conditional', marketSlug: marketSlug ?? '', outcome: upLabel }),
      tradeBalanceAllowance({ tokenId: downToken, assetType: 'conditional', marketSlug: marketSlug ?? '', outcome: downLabel }),
    ]);
    if (isOk(rC)) setAvailUsdc(parseUsdcBalance(rC.data.balance));
    else if (!opts?.keepStaleOnFail) setAvailUsdc(null);
    if (isOk(rU)) setBalUp(parseOutcomeSharesBalance(rU.data.balance));
    else if (!opts?.keepStaleOnFail) setBalUp(null);
    if (isOk(rD)) setBalDown(parseOutcomeSharesBalance(rD.data.balance));
    else if (!opts?.keepStaleOnFail) setBalDown(null);
    if (!isOk(rU) || !isOk(rD)) {
      const err = !isOk(rU) ? (rU as ApiErr).error : (rD as ApiErr).error;
      setBalError(
        err === 'bullpen_not_logged_in'
          ? 'Live balance unavailable — run `bullpen login` on the API host.'
          : 'Position/balance unavailable — check Bullpen login or API live config.',
      );
    }
  }, [downToken, downLabel, marketSlug, upToken, upLabel]);

  const refreshLiveBalances = useCallback(async (opts?: { silent?: boolean }) => {
    if (accountMode !== 'live') return;
    if (!upToken || !downToken) return;
    const silent = opts?.silent === true;
    if (!silent) setBalError(null);
    if (liveBalancesRefreshRef.current.inflight) return;
    liveBalancesRefreshRef.current.inflight = true;
    if (!silent) setBalLoading(true);
    const gen = (liveBalancesRefreshRef.current.gen += 1);
    try {
      await Promise.all([
        tradeUpdateBalanceAllowance({ assetType: 'collateral' }),
        tradeUpdateBalanceAllowance({ tokenId: upToken, assetType: 'conditional' }),
        tradeUpdateBalanceAllowance({ tokenId: downToken, assetType: 'conditional' }),
      ]);
      if (gen !== liveBalancesRefreshRef.current.gen) return;
      await readLiveBalancesOnce({ keepStaleOnFail: silent });
    } catch {
      if (!silent) setBalError('Could not load balances.');
    } finally {
      liveBalancesRefreshRef.current.inflight = false;
      if (!silent) setBalLoading(false);
    }
  }, [accountMode, downToken, readLiveBalancesOnce, upToken]);

  const refreshLiveBalancesThrottled = useCallback(
    (opts?: { silent?: boolean }) => {
      const minGapMs = 600;
      const now = Date.now();
      const ref = liveBalThrottleRef.current;
      if (now - ref.lastMs >= minGapMs) {
        ref.lastMs = now;
        void refreshLiveBalances(opts);
        return;
      }
      if (ref.timer != null) return;
      ref.timer = window.setTimeout(() => {
        ref.timer = null;
        ref.lastMs = Date.now();
        void refreshLiveBalances(opts);
      }, Math.max(0, minGapMs - (now - ref.lastMs)));
    },
    [refreshLiveBalances],
  );

  useEffect(() => {
    const onResetPhantom = (ev: Event) => {
      const d = ((ev as CustomEvent<ResetPhantomPositionDetail>).detail ?? {}) as ResetPhantomPositionDetail;
      const u = d.upToken?.trim() || upToken?.trim() || '';
      const dn = d.downToken?.trim() || downToken?.trim() || '';
      const tokens = [u, dn].filter(Boolean);
      if (tokens.length) {
        setPaperAccount(resetPaperPositionsForTokens(tokens));
      }
      setBalUp(0);
      setBalDown(0);
      setPosSharesUp(null);
      setPosSharesDown(null);
      setAvgEntryUp(null);
      setAvgEntryDown(null);
      if (accountMode === 'live') void refreshLiveBalances();
      dispatchOutcomePositions({
        slug: marketSlug?.trim() || d.slug?.trim() || undefined,
        mode: accountMode === 'live' ? 'live' : 'paper',
        up: { tokenId: u, shares: 0 },
        down: { tokenId: dn, shares: 0 },
      });
    };
    window.addEventListener(BPX_RESET_PHANTOM_POSITION_EVENT, onResetPhantom as EventListener);
    return () => window.removeEventListener(BPX_RESET_PHANTOM_POSITION_EVENT, onResetPhantom as EventListener);
  }, [accountMode, downToken, marketSlug, refreshLiveBalances, upToken]);

  useEffect(() => {
    refreshAvgEntryThrottled();
  }, [refreshAvgEntryThrottled]);

  const refreshOpenOrders = useCallback(async () => {
    if (accountMode !== 'live') return;
    if (!token && openOrdersScope === 'token') return;
    setOpenOrdersErr(null);
    setOpenOrdersLoading(true);
    try {
      const r = openOrdersScope === 'all' ? await tradeOpenOrders() : await tradeOpenOrders({ tokenId: token });
      if (!isOk(r)) {
        const e = r as ApiErr;
        setOpenOrdersErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
        setOpenOrders([]);
      } else {
        const orders = Array.isArray((r.data as { orders?: unknown }).orders)
          ? ((r.data as { orders?: unknown }).orders as unknown[])
          : [];
        setOpenOrders(orders);
        const synced = syncSentRowsFromOpenOrders(orders);
        if (synced > 0) setHistoryRows(loadTradeHistory());
        if (token) void reconcileTradeHistoryFromClob(token);
      }
    } catch (e) {
      setOpenOrdersErr(`open_orders_failed · ${String(e)}`);
      setOpenOrders([]);
    } finally {
      setOpenOrdersLoading(false);
    }
  }, [accountMode, openOrdersScope, token]);

  const refreshMyFills = useCallback(async (tokenIdOverride?: string | null) => {
    if (accountMode !== 'live') return;
    const tid = (tokenIdOverride ?? token)?.trim();
    if (!tid) return;
    setMyFillsErr(null);
    try {
      const r = await tradeMyFills({ tokenId: tid, limit: 40 }, { timeoutMs: 25_000 });
      if (!isOk(r)) {
        const e = r as ApiErr;
        setMyFillsErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
        setMyFills([]);
        try {
          const n = await reconcileTradeHistoryFromClob(tid);
          if (n > 0) setHistoryRows(loadTradeHistory());
        } catch {
          /* ignore */
        }
      } else {
        setMyFillsErr(null);
        setMyFills(Array.isArray(r.data.fills) ? r.data.fills : []);
        try {
          const n = await reconcileTradeHistoryFromClob(tid);
          if (n > 0) setHistoryRows(loadTradeHistory());
        } catch {
          /* ignore */
        }
      }
    } catch (e) {
      setMyFillsErr(`my_fills_failed · ${String(e)}`);
      setMyFills([]);
    }
  }, [accountMode, token]);

  const refreshPositionAndMaxSell = useCallback(async () => {
    if (!token) return;
    setErr(null);
    applyMaxSellFromCache(lane);
    setBusyRefresh(true);
    try {
      if (accountMode === 'paper') return;
      await tradeUpdateBalanceAllowance({ tokenId: token, assetType: 'conditional' });
      const res = await tradeBalanceAllowance({ tokenId: token, assetType: 'conditional' });
      if (!isOk(res)) {
        setErr('Could not read this outcome position.');
        return;
      }
      const sh = parseOutcomeSharesBalance(res.data.balance);
      if (token === upToken) setBalUp(sh);
      else if (token === downToken) setBalDown(sh);
      const sellable = resolveLiveOutcomeShares({
        clobBal: sh,
        bullpenShares: token === upToken ? posSharesUp : posSharesDown,
        historyEst: token === upToken ? estSharesUp : estSharesDown,
        policy: 'sell',
        msSinceBuyFill: msSinceBuyFillForToken(token),
      });
      applyInstantMaxSellQty(sellable);
    } finally {
      setBusyRefresh(false);
    }
  }, [
    accountMode,
    applyInstantMaxSellQty,
    applyMaxSellFromCache,
    estSharesDown,
    estSharesUp,
    lane,
    msSinceBuyFillForToken,
    posSharesDown,
    posSharesUp,
    token,
    upToken,
    downToken,
  ]);

  /** After tape reconcile: only toast / arm when the buy row has exchange fill avg + shares. */
  const afterLiveBuyRowReconcile = useCallback(
    (rowId: string) => {
      const row = loadTradeHistory().find((r) => r.id === rowId);
      if (!rowShowsExchangeFill(row)) return;
      const px = fillPrice01FromRow(row)!;
      const sh = row.shares;
      const rowTok = row.token?.trim() ?? '';
      if (rowTok) lastBuyFillMsByTokenRef.current[rowTok] = Date.now();
      const riskLane: 'up' | 'down' | undefined =
        rowTok && rowTok === upToken?.trim() ? 'up' : rowTok && rowTok === downToken?.trim() ? 'down' : undefined;
      if (riskLane) applyMaxSellFromCache(riskLane);
      if (sh > 0) syncBracketSharesFromPosition(sh);
      const firstToast = !buyReconcileToastRowIdsRef.current.has(rowId);
      if (firstToast) {
        buyReconcileToastRowIdsRef.current.add(rowId);
        playTradeFill();
        pushToast('ok', `Exchange confirmed: bought ${sh.toFixed(4)} sh @ ${formatFillCents(px)} fill`);
        setOkMsg(`Filled · ${sh.toFixed(4)} sh @ ${formatFillCents(px)}`);
      }
      void refreshLiveBalances().then(() => {
        refreshAvgEntryThrottled();
        void refreshPositionAndMaxSell();
      });
      const shStr = sh > 0 ? String(floorShares4(sh)) : null;
      const bundle = buyBundleArmRef.current;
      const bundleMatch =
        bundle &&
        rowTok &&
        riskLane &&
        bundle.token === rowTok &&
        bundle.lane === riskLane;
      if (bundleMatch) {
        buyBundleArmRef.current = null;
        pendingBuyBundleIntentRef.current = null;
        buyRiskArmedRowIdsRef.current.add(rowId);
        applyFilledBuyBundle({ rowTok, riskLane, shares: sh, sl: bundle.sl, tp: bundle.tp });
        saveEmergencyStopForLane(riskLane, '');
        if (firstToast) {
          pushToast('info', emergencyStopFillToast(bundle.sl, bundle.tp), 5200);
        }
      } else {
        const pending = pendingBuyBundleIntentRef.current;
        const pendingMatch =
          pending &&
          rowTok &&
          riskLane &&
          pending.lane === riskLane &&
          pending.token === rowTok &&
          (pending.sl || pending.tp);
        if (pendingMatch) {
          pendingBuyBundleIntentRef.current = null;
          buyRiskArmedRowIdsRef.current.add(rowId);
          applyFilledBuyBundle({ rowTok, riskLane, shares: sh, sl: pending.sl, tp: pending.tp });
          if (pending.sl) saveEmergencyStopForLane(riskLane, '');
          if (firstToast) {
            pushToast('info', emergencyStopFillToast(pending.sl, pending.tp), 5200);
          }
        } else {
        const staged =
          riskLane != null
            ? readStagedBuyBundleLevels(riskLane, buyBundleByLaneRef.current)
            : { sl: '', tp: '' };
        const preSl = staged.sl;
        const preTp = staged.tp;
        const deskAlreadyArmed =
          (stopLossEnabled && stopLossStopCents.trim()) || (takeProfitEnabled && takeProfitTakeCents.trim());
        if (buyRiskArmedRowIdsRef.current.has(rowId)) {
          if (shStr) {
            if (stopLossEnabled) setStopLossShares(shStr);
            if (takeProfitEnabled) setTakeProfitShares(shStr);
          }
        } else if ((preSl || preTp) && rowTok && riskLane) {
          buyRiskArmedRowIdsRef.current.add(rowId);
          applyFilledBuyBundle({ rowTok, riskLane, shares: sh, sl: preSl, tp: preTp });
          if (preSl) saveEmergencyStopForLane(riskLane, '');
          if (firstToast) {
            pushToast('info', emergencyStopFillToast(preSl, preTp), 5200);
          }
        } else if (deskAlreadyArmed && rowTok && riskLane) {
          buyRiskArmedRowIdsRef.current.add(rowId);
          if (!bracketArmedPinRef.current) {
            bracketArmedPinRef.current = {
              token: rowTok,
              lane: riskLane,
              stopCents: stopLossStopCents.trim(),
              tpCents: takeProfitTakeCents.trim(),
              source: 'desk',
              armedAtMs: Date.now(),
            };
          }
          if (shStr) {
            if (stopLossEnabled) setStopLossShares(shStr);
            if (takeProfitEnabled) setTakeProfitShares(shStr);
          }
        } else {
          buyRiskArmedRowIdsRef.current.add(rowId);
          applyArmRiskAfterBuyFill(px, sh, riskLane);
        }
        }
      }
      if (row.token?.trim() === token?.trim()) {
        setPendingPos((p) => {
          if (!p || p.token !== row.token.trim()) return p;
          return { ...p, status: row.status === 'partial' ? 'partial' : 'filled' };
        });
        if (row.status === 'filled') {
          window.setTimeout(() => setPendingPos(null), 12_000);
        }
      }
    },
    [
      applyArmRiskAfterBuyFill,
      applyFilledBuyBundle,
      downToken,
      pushToast,
      refreshAvgEntryThrottled,
      refreshLiveBalances,
      refreshPositionAndMaxSell,
      stopLossEnabled,
      stopLossStopCents,
      takeProfitEnabled,
      takeProfitTakeCents,
      token,
      upToken,
    ],
  );

  const liveSellNotifiedRowIdsRef = useRef<Set<string>>(new Set());

  /** Returning to the tab: timers skip while hidden — pull fresh mids, position, fills, and avg entry immediately. */
  useEffect(() => {
    const burst = () => {
      if (document.visibilityState !== 'visible') return;
      void fetchLastTradesBoth();
      if (accountMode === 'live') {
        void refreshOpenOrders();
        void refreshMyFills();
        refreshAvgEntry();
        void refreshLiveBalances();
      }
      void refreshPositionAndMaxSell();
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') burst();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [
    accountMode,
    fetchLastTradesBoth,
    refreshAvgEntry,
    refreshLiveBalances,
    refreshMyFills,
    refreshOpenOrders,
    refreshPositionAndMaxSell,
  ]);

  const cancelLiveOrderAndRefresh = useCallback(
    async (orderId: string, opts?: { quiet?: boolean }): Promise<{ ok: true } | { ok: false; message: string }> => {
      const r = await cancelOneLiveOrder(orderId);
      if (!r.ok) {
        if (!opts?.quiet) pushToast('err', r.message);
        setErr(r.message);
        return { ok: false, message: r.message };
      }
      setHistoryRows(loadTradeHistory());
      void refreshOpenOrders();
      void refreshMyFills();
      refreshLiveBalancesThrottled({ silent: true });
      if (token?.trim()) {
        void reconcileTradeHistoryFromClob(token.trim(), { force: true }).then(() => setHistoryRows(loadTradeHistory()));
      }
      const msg = r.idempotent ? 'Order already closed on exchange (cancel ok).' : 'Order cancel sent.';
      if (!opts?.quiet) pushToast('ok', msg);
      setOkMsg(msg);
      return { ok: true };
    },
    [pushToast, refreshLiveBalancesThrottled, refreshMyFills, refreshOpenOrders, token],
  );

  const scheduleTruthRefreshBurst = useCallback(
    (tokenId: string | null, orderId?: string | null, onAfter?: () => void) => {
      if (accountMode !== 'live') return;
      const tid = tokenId?.trim();
      if (!tid) return;

      const doOnce = async () => {
        try {
          await reconcileTradeHistoryFromClob(tid, { force: true });
        } catch {
          /* ignore */
        }
        setHistoryRows(loadTradeHistory());
        await refreshOpenOrders();
        await refreshMyFills(tid);
        refreshAvgEntryThrottled();
        await refreshLiveBalances();
        if (orderId) void tradeGetOrder(orderId).catch(() => undefined);
        onAfter?.();
      };

      void doOnce();
      window.setTimeout(() => void doOnce(), 450);
      window.setTimeout(() => void doOnce(), 1200);
      window.setTimeout(() => void doOnce(), 2800);
    },
    [accountMode, refreshAvgEntry, refreshLiveBalances, refreshMyFills, refreshOpenOrders],
  );

  const syncSellPositionAfterBurst = useCallback(
    async (tok: string) => {
      const t = tok.trim();
      if (!t || accountMode !== 'live') return;
      try {
        await tradeUpdateBalanceAllowance({ tokenId: t, assetType: 'conditional' });
        const res = await tradeBalanceAllowance({ tokenId: t, assetType: 'conditional' });
        if (!isOk(res)) return;
        const sh = parseOutcomeSharesBalance(res.data.balance);
        if (t === upToken?.trim()) setBalUp(sh);
        else if (t === downToken?.trim()) setBalDown(sh);
        const sellable = resolveLiveOutcomeShares({
          clobBal: sh,
          bullpenShares: t === upToken?.trim() ? posSharesUp : posSharesDown,
          historyEst: t === upToken?.trim() ? estSharesUp : estSharesDown,
          policy: 'sell',
          msSinceBuyFill: msSinceBuyFillForToken(t),
        });
        syncRiskAutomationAfterSellFill(sellable);
      } catch {
        /* ignore */
      }
    },
    [
      accountMode,
      downToken,
      estSharesDown,
      estSharesUp,
      msSinceBuyFillForToken,
      posSharesDown,
      posSharesUp,
      syncRiskAutomationAfterSellFill,
      upToken,
    ],
  );

  /** Push confirmed sell fill into balances, history listeners, desk position, and brackets. */
  const syncDeskAfterLiveSellFill = useCallback(
    async (rowTok: string, skipReconcile = false) => {
      const t = rowTok.trim();
      if (!t || accountMode !== 'live') return;
      if (!skipReconcile) {
        try {
          await reconcileTradeHistoryFromClob(t, { force: true });
        } catch {
          /* ignore */
        }
        setHistoryRows(loadTradeHistory());
      }
      try {
        await syncSellPositionAfterBurst(t);
      } catch {
        /* ignore */
      }
      refreshAvgEntryThrottled();
      try {
        await refreshLiveBalances();
      } catch {
        /* ignore */
      }
      void refreshPositionAndMaxSell();
    },
    [
      accountMode,
      refreshAvgEntryThrottled,
      refreshLiveBalances,
      refreshPositionAndMaxSell,
      syncSellPositionAfterBurst,
    ],
  );

  /** Push reconciled sell VWAP + size into every desk surface (history, status pin, brackets). */
  const applyConfirmedSellFillToDesk = useCallback(
    (
      row: TradeHistoryRow,
      rowId: string,
      fill: { shares: number; fill01: number; fillCents: number },
      opts: {
        setOk?: (msg: string) => void;
        sl?: { stop01: number; limit01: number; sizeLive: number; oid: string | null; refCents: number | null };
        tp?: { take01: number; limit01: number; sizeLive: number; oid: string | null; refCents: number | null };
      } | undefined,
      notify: boolean,
    ) => {
      setHistoryRows(loadTradeHistory());
      setPinnedLiveStatusId(rowId);
      setPinnedLiveStatusDismissed(false);
      const fillLabel = formatFillCents(fill.fill01, 1);
      const summary = `Filled · ${fill.shares.toFixed(4)} sh @ ${fillLabel}`;
      opts?.setOk?.(summary);
      if (notify) {
        playTradeFill();
        const fillMsg = `Exchange confirmed: sold ${fill.shares.toFixed(4)} sh @ ${fillLabel} fill`;
        pushToast('ok', fillMsg);
        pushTradeActivity(fillMsg);
      }
      if (opts?.sl) {
        setLastAutoSell({
          kind: 'sl',
          ts: Date.now(),
          mode: 'live',
          status: 'filled',
          shares: fill.shares,
          triggerCents: opts.sl.stop01 * 100,
          refCents: opts.sl.refCents,
          limitCents: opts.sl.limit01 * 100,
          fillCents: fill.fillCents,
          orderId: opts.sl.oid,
          msg: `stop_loss_fak fill ${fillLabel}`,
        });
      } else if (opts?.tp) {
        setLastAutoSell({
          kind: 'tp',
          ts: Date.now(),
          mode: 'live',
          status: 'filled',
          shares: fill.shares,
          triggerCents: opts.tp.take01 * 100,
          refCents: opts.tp.refCents,
          limitCents: opts.tp.limit01 * 100,
          fillCents: fill.fillCents,
          orderId: opts.tp.oid,
          msg: `take_profit_fak fill ${fillLabel}`,
        });
      }
      const rowTokLatch = row.token?.trim();
      if (rowTokLatch) {
        if (opts?.tp || String(row.auditNote ?? '').toLowerCase().includes('take_profit')) {
          takeProfitLastFireTokRef.current = rowTokLatch;
        }
        if (opts?.sl || String(row.auditNote ?? '').toLowerCase().includes('stop_loss')) {
          stopLossLastFireTokRef.current = rowTokLatch;
        }
      }
      if (!opts?.tp && !opts?.sl) {
        const aud = String(row.auditNote ?? '').toLowerCase();
        if (aud.includes('stop_loss') || aud.includes('take_profit')) {
          setLastAutoSell((p) => {
            if (!p) return p;
            const wantSl = aud.includes('stop_loss');
            if ((wantSl && p.kind !== 'sl') || (!wantSl && p.kind !== 'tp')) return p;
            return {
              ...p,
              status: 'filled',
              fillCents: fill.fillCents,
              shares: fill.shares,
              orderId: row.orderId ?? p.orderId,
            };
          });
        }
      }
    },
    [pushToast, pushTradeActivity],
  );

  /** Reconcile CLOB tape first, then mirror exchange VWAP/shares across the desk. */
  const afterLiveSellRowReconcile = useCallback(
    async (
      rowId: string,
      opts?: {
        setOk?: (msg: string) => void;
        sl?: { stop01: number; limit01: number; sizeLive: number; oid: string | null; refCents: number | null };
        tp?: { take01: number; limit01: number; sizeLive: number; oid: string | null; refCents: number | null };
      },
    ) => {
      let row = loadTradeHistory().find((r) => r.id === rowId);
      const rowTok = row?.token?.trim() ?? '';
      if (rowTok && accountMode === 'live') {
        try {
          await reconcileTradeHistoryFromClob(rowTok, { force: true });
        } catch {
          /* ignore */
        }
        setHistoryRows(loadTradeHistory());
        row = loadTradeHistory().find((r) => r.id === rowId);
      }
      const fill = confirmedExchangeFillFromRow(row);
      if (row && fill) {
        const notify = !liveSellNotifiedRowIdsRef.current.has(rowId);
        if (notify) {
          liveSellNotifiedRowIdsRef.current.add(rowId);
          if (liveSellNotifiedRowIdsRef.current.size > 80) {
            const xs = [...liveSellNotifiedRowIdsRef.current];
            liveSellNotifiedRowIdsRef.current = new Set(xs.slice(-40));
          }
        }
        applyConfirmedSellFillToDesk(row, rowId, fill, opts, notify);
      }
      if (rowTok) void syncDeskAfterLiveSellFill(rowTok, true);
    },
    [accountMode, applyConfirmedSellFillToDesk, syncDeskAfterLiveSellFill],
  );

  const applyTapeConfirmedLiveFill = useCallback(
    (
      rowId: string,
      rowTok: string,
      _orderId: string,
      tape: TapeConfirmedFill,
      ctx: {
        started: number;
        quotedPrice01: number | null;
        intendedPrice01: number;
        orig: number;
        limitPrice01?: number | null;
        auditSuffix?: string;
      },
    ) => {
      const rowBefore = loadTradeHistory().find((r) => r.id === rowId);
      const remaining =
        ctx.orig > 0 && tape.status === 'partial' ? Math.max(0, roundShares4(ctx.orig - tape.shares)) : 0;
      const note = priceAuditNote(ctx.quotedPrice01, ctx.intendedPrice01, tape.avg01);
      const auditNote = [note, ctx.auditSuffix, 'clob_tape_confirmed'].filter(Boolean).join(' · ');

      updateTradeHistoryRow(
        rowId,
        {
          status: tape.status,
          submittedPrice01: ctx.limitPrice01 ?? rowBefore?.submittedPrice01 ?? undefined,
          quotedPrice01: ctx.quotedPrice01 ?? undefined,
          requestedShares: ctx.orig,
          remainingShares: remaining,
          roundTripMs: Math.round(performance.now() - ctx.started),
          auditNote: auditNote || 'clob_tape_confirmed',
          ...mirrorFillPriceOnRow({
            fillAvgPrice01: tape.avg01,
            shares: tape.shares,
          }),
        },
      );
      setHistoryRows(loadTradeHistory());

      const rowSnap = loadTradeHistory().find((r) => r.id === rowId);
      if (rowSnap?.side === 'buy' && rowSnap.mode === 'live' && rowSnap.token.trim() === rowTok) {
        setPendingPos((p) => {
          if (!p || p.token !== rowTok) return p;
          return { ...p, status: tape.status === 'filled' ? 'filled' : 'partial' };
        });
        if (tape.status === 'filled') {
          window.setTimeout(() => setPendingPos(null), 12_000);
        }
      }
      if (rowSnap?.side === 'sell' && rowSnap.mode === 'live') {
        void afterLiveSellRowReconcile(rowId);
      }
    },
    [afterLiveSellRowReconcile],
  );

  /** Poll wallet position + avg entry from Bullpen/CLOB — never guess from local optimistic state. */
  useEffect(() => {
    if (accountMode !== 'live') return;
    if (!upToken || !downToken) return;
    const needsPoll =
      stopLossEnabled ||
      takeProfitEnabled ||
      action === 'sell' ||
      (positionShares != null && positionShares > 0) ||
      pendingPos != null;
    if (!needsPoll) return;
    const tick = () => {
      if (document.visibilityState === 'hidden') return;
      refreshLiveBalancesThrottled({ silent: true });
      refreshAvgEntryThrottled();
    };
    tick();
    const id = window.setInterval(tick, 2_500);
    return () => window.clearInterval(id);
  }, [
    accountMode,
    action,
    pendingPos,
    positionShares,
    refreshAvgEntryThrottled,
    refreshLiveBalancesThrottled,
    stopLossEnabled,
    takeProfitEnabled,
    upToken,
    downToken,
  ]);

  useEffect(() => {
    if (accountMode !== 'live') return;
    if (!token && openOrdersScope === 'token') return;
    let cancelled = false;
    void (async () => {
      if (!cancelled) await refreshOpenOrders();
      if (!cancelled) await refreshMyFills();
    })();
    const t = window.setInterval(() => {
      if (cancelled || document.visibilityState === 'hidden') return;
      void refreshOpenOrders();
      void refreshMyFills();
    }, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [accountMode, openOrdersScope, refreshMyFills, refreshOpenOrders, token]);

  const chooseAction = useCallback((a: 'buy' | 'sell') => {
    setAction(a);
    setErr(null);
    setOkMsg(null);
    if (isSlide && a === 'sell') setSlideDockTab('outcome');
    if (a === 'sell') {
      setUnit('shares');
      setSellQty('');
    }
  }, [isSlide]);

  useEffect(() => {
    if (accountMode !== 'paper') return;
    try {
      setPaperCashEdit((paperAccount.cashUsdCents / 100).toFixed(2));
    } catch {
      /* ignore */
    }
  }, [accountMode, paperAccount.cashUsdCents]);

  const chooseLane = useCallback(
    (L: 'up' | 'down') => {
      deskBuyLaneRef.current = L;
      bracketOutcomeLaneRef.current = L;
      const laneTok = L === 'up' ? upToken?.trim() : downToken?.trim();
      if (laneTok && !bracketArmedPinRef.current) bracketOutcomeTokenRef.current = laneTok;
      if (pendingAutoBuy?.lane != null && pendingAutoBuy.lane !== L) setPendingAutoBuy(null);
      if (controlledLane == null) setLaneState(L);
      onLaneChange?.(L);
      setErr(null);
      setOkMsg(null);
      if (action === 'sell') setSellQty('');
    },
    [action, controlledLane, downToken, onLaneChange, pendingAutoBuy, upToken],
  );

  useEffect(() => {
    if (action !== 'sell') return;
    void refreshPositionAndMaxSell();
  }, [lane, action, refreshPositionAndMaxSell]);

  const setUnitBuy = useCallback((u: 'dollars' | 'shares') => {
    setUnit(u);
    setErr(null);
    setOkMsg(null);
  }, []);

  const availableBuyUsd = useMemo(() => {
    if (accountMode === 'paper') {
      const c = paperAccount.cashUsdCents / 100;
      return Number.isFinite(c) && c > 0 ? roundUsd2(Math.floor(c * 100) / 100) : 0;
    }
    return availUsdc != null && availUsdc > 0 ? availUsdc : null;
  }, [accountMode, availUsdc, paperAccount.cashUsdCents]);

  const applyMaxBuy = useCallback(async () => {
    setErr(null);
    const touchAsk = bookTouch?.bestAsk;
    const price =
      execMode === 'touch' && touchAsk != null && touchAsk > 0 && touchAsk < 1
        ? roundPrice01(touchAsk)
        : mid != null && mid > 0
          ? mid
          : null;
    const cachedCash = availableBuyUsd ?? 0;
    if (cachedCash > 0 && (unit === 'dollars' || (price != null && price > 0))) {
      setAmount(buyAmountFromCashPct({ pct: 1, unit, cashUsd: cachedCash, price01: price }));
    }
    setMaxBuyBusy(true);
    try {
      let cashUsd = cachedCash;
      if (accountMode === 'live') {
        await tradeUpdateBalanceAllowance({ assetType: 'collateral' });
        const res = await tradeBalanceAllowance({ assetType: 'collateral' });
        if (!isOk(res)) {
          setErr('Could not read USDC balance.');
          return;
        }
        const usdc = parseUsdcBalance(res.data.balance);
        setAvailUsdc(usdc);
        cashUsd = usdc ?? 0;
      }
      if (cashUsd <= 0) return;
      if (unit === 'shares' && (price == null || price <= 0)) {
        setErr('Need a valid mid to convert USDC to shares for Max');
        return;
      }
      setAmount(buyAmountFromCashPct({ pct: 1, unit, cashUsd, price01: price }));
    } finally {
      setMaxBuyBusy(false);
    }
  }, [accountMode, availableBuyUsd, bookTouch?.bestAsk, execMode, mid, unit]);

  // Load persisted stop-loss config whenever token changes (paper + live).
  useEffect(() => {
    const tok = token?.trim();
    stopLossFireLockRef.current = false;
    stopLossLastFireTokRef.current = null;
    stopLossLastCrossRef.current = null;
    stopLossPrevBidRef.current = null;
    stopLossPrevAskRef.current = null;
    stopLossPrevStripMidRef.current = null;
    if (!tok) {
      setStopLossEnabled(false);
      setStopLossStopCents('');
      setStopLossLimitCents('');
      setStopLossShares('');
      setStopLossStatus('OFF');
      setStopLossSimple(true);
      setStopLossDualBook(false);
      return;
    }
    try {
      const raw = window.localStorage.getItem(stopLossKey);
      const draft = loadBracketLevelsDraft(tok);
      const laneDraft = bracketLaneDraftRef.current[lane];
      if (!raw) {
        const sl = laneDraft.sl || draft?.sl || '';
        setStopLossEnabled(false);
        setStopLossStopCents(sl);
        setStopLossLimitCents(sl);
        setStopLossShares('');
        setStopLossStatus('OFF');
        setStopLossSimple(true);
        setStopLossDualBook(false);
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return;
      const o = parsed as Partial<StopLossConfig> & Record<string, unknown>;
      const enabled = o.enabled === true;
      const stop01 = typeof o.stop01 === 'number' && Number.isFinite(o.stop01) ? o.stop01 : null;
      const limit01 = typeof o.limit01 === 'number' && Number.isFinite(o.limit01) ? o.limit01 : null;
      const shares = typeof o.shares === 'number' && Number.isFinite(o.shares) ? o.shares : null;
      const dualBook = o.dualBook === true;
      let simple = o.simple !== false;
      if (o.simple == null && stop01 != null && limit01 != null && Math.abs(stop01 - limit01) > 1e-5) {
        simple = false;
      }
      setStopLossDualBook(dualBook);
      setStopLossSimple(simple);
      setStopLossEnabled(enabled);
      setStopLossStopCents(
        stop01 != null ? formatBracketCentsFromNumber(Math.round(stop01 * 100)) : laneDraft.sl || draft?.sl || '',
      );
      setStopLossLimitCents(
        limit01 != null ? formatBracketCentsFromNumber(Math.round(limit01 * 100)) : laneDraft.sl || draft?.sl || '',
      );
      setStopLossShares(shares != null ? String(shares) : '');
      setStopLossStatus(enabled ? 'ARMED' : 'OFF');
      if (enabled) pinBracketAutomationToken(tok);
    } catch {
      setStopLossEnabled(false);
      setStopLossStatus('OFF');
      setStopLossSimple(true);
      setStopLossDualBook(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopLossKey]);

  // Load persisted take-profit config whenever token changes (paper + live).
  useEffect(() => {
    const tok = token?.trim();
    takeProfitFireLockRef.current = false;
    takeProfitLastFireTokRef.current = null;
    takeProfitLastCrossRef.current = null;
    takeProfitPrevBidRef.current = null;
    takeProfitPrevAskRef.current = null;
    takeProfitPrevStripMidRef.current = null;
    if (!tok) {
      setTakeProfitEnabled(false);
      setTakeProfitTakeCents('');
      setTakeProfitLimitCents('');
      setTakeProfitShares('');
      setTakeProfitStatus('OFF');
      setTakeProfitSimple(true);
      setTakeProfitDualBook(false);
      return;
    }
    try {
      const raw = window.localStorage.getItem(takeProfitKey);
      const draft = loadBracketLevelsDraft(tok);
      const laneDraft = bracketLaneDraftRef.current[lane];
      if (!raw) {
        const tp = laneDraft.tp || draft?.tp || '';
        setTakeProfitEnabled(false);
        setTakeProfitTakeCents(tp);
        setTakeProfitLimitCents(tp);
        setTakeProfitShares('');
        setTakeProfitStatus('OFF');
        setTakeProfitSimple(true);
        setTakeProfitDualBook(false);
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return;
      const o = parsed as Partial<TakeProfitConfig> & Record<string, unknown>;
      const enabled = o.enabled === true;
      const take01 = typeof o.take01 === 'number' && Number.isFinite(o.take01) ? o.take01 : null;
      const limit01 = typeof o.limit01 === 'number' && Number.isFinite(o.limit01) ? o.limit01 : null;
      const shares = typeof o.shares === 'number' && Number.isFinite(o.shares) ? o.shares : null;
      const dualBook = o.dualBook === true;
      let simple = o.simple !== false;
      if (o.simple == null && take01 != null && limit01 != null && Math.abs(take01 - limit01) > 1e-5) {
        simple = false;
      }
      setTakeProfitDualBook(dualBook);
      setTakeProfitSimple(simple);
      setTakeProfitEnabled(enabled);
      setTakeProfitTakeCents(
        take01 != null ? formatBracketCentsFromNumber(Math.round(take01 * 100)) : laneDraft.tp || draft?.tp || '',
      );
      setTakeProfitLimitCents(
        limit01 != null ? formatBracketCentsFromNumber(Math.round(limit01 * 100)) : laneDraft.tp || draft?.tp || '',
      );
      setTakeProfitShares(shares != null ? String(shares) : '');
      setTakeProfitStatus(enabled ? 'ARMED' : 'OFF');
      if (enabled) pinBracketAutomationToken(tok);
    } catch {
      setTakeProfitEnabled(false);
      setTakeProfitStatus('OFF');
      setTakeProfitSimple(true);
      setTakeProfitDualBook(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeProfitKey]);

  /** Tracking tab (and others) can clear persisted SL/TP for a token; keep React state in sync. */
  useEffect(() => {
    const onClearPrefs = (ev: Event) => {
      const e = ev as CustomEvent<{ tokenId?: string }>;
      const tid = typeof e.detail?.tokenId === 'string' ? e.detail.tokenId.trim() : '';
      if (!tid || tid !== token?.trim()) return;
      try {
        window.localStorage.removeItem(`pm:stoploss:v1:${tid}`);
        window.localStorage.removeItem(`pm:takeprofit:v1:${tid}`);
      } catch {
        /* ignore */
      }
      stopLossLastFireTokRef.current = null;
      stopLossFireLockRef.current = false;
      stopLossLastCrossRef.current = null;
      stopLossPrevBidRef.current = null;
      stopLossPrevAskRef.current = null;
      stopLossPrevStripMidRef.current = null;
      setStopLossEnabled(false);
      setStopLossStopCents('');
      setStopLossLimitCents('');
      setStopLossShares('');
      setStopLossStatus('OFF');
      setStopLossSimple(true);
      setStopLossDualBook(false);
      takeProfitLastFireTokRef.current = null;
      takeProfitFireLockRef.current = false;
      takeProfitLastCrossRef.current = null;
      takeProfitPrevBidRef.current = null;
      takeProfitPrevAskRef.current = null;
      takeProfitPrevStripMidRef.current = null;
      setTakeProfitEnabled(false);
      setTakeProfitTakeCents('');
      setTakeProfitLimitCents('');
      setTakeProfitShares('');
      setTakeProfitStatus('OFF');
      setTakeProfitSimple(true);
      setTakeProfitDualBook(false);
    };
    window.addEventListener('pm-clear-risk-prefs', onClearPrefs as EventListener);
    return () => window.removeEventListener('pm-clear-risk-prefs', onClearPrefs as EventListener);
  }, [token]);

  // Persist stop-loss config (armed outcome token — survives lane tab switches).
  useEffect(() => {
    const storageTok = bracketPollToken?.trim() || token?.trim();
    if (!storageTok) return;
    if (!stopLossEnabled) {
      try {
        window.localStorage.removeItem(stopLossStorageKey(storageTok));
      } catch {
        /* ignore */
      }
      return;
    }
    const cfg = resolveArmedStopLoss({
      automationTok: storageTok,
      enabled: true,
      stopCents: stopLossStopCents,
      limitCents: stopLossLimitCents,
      sharesStr: stopLossShares,
      simple: stopLossSimple,
      dualBook: stopLossDualBook,
      laneDraftSl: bracketLaneDraftRef.current[bracketOutcomeLaneRef.current ?? lane].sl,
    });
    if (!cfg) return;
    saveStopLossConfigToStorage(storageTok, cfg);
  }, [
    bracketPollToken,
    lane,
    stopLossDualBook,
    stopLossEnabled,
    stopLossLimitCents,
    stopLossShares,
    stopLossSimple,
    stopLossStopCents,
    token,
  ]);

  // Persist take-profit config (armed outcome token — survives lane tab switches).
  useEffect(() => {
    const storageTok = bracketPollToken?.trim() || token?.trim();
    if (!storageTok) return;
    if (!takeProfitEnabled) {
      try {
        window.localStorage.removeItem(takeProfitStorageKey(storageTok));
      } catch {
        /* ignore */
      }
      return;
    }
    const cfg = resolveArmedTakeProfit({
      automationTok: storageTok,
      enabled: true,
      takeCents: takeProfitTakeCents,
      limitCents: takeProfitLimitCents,
      sharesStr: takeProfitShares,
      simple: takeProfitSimple,
      dualBook: takeProfitDualBook,
      laneDraftTp: bracketLaneDraftRef.current[bracketOutcomeLaneRef.current ?? lane].tp,
    });
    if (!cfg) return;
    saveTakeProfitConfigToStorage(storageTok, cfg);
  }, [
    bracketPollToken,
    lane,
    takeProfitDualBook,
    takeProfitEnabled,
    takeProfitLimitCents,
    takeProfitShares,
    takeProfitSimple,
    takeProfitTakeCents,
    token,
  ]);

  // Simple mode: one stop price → limit matches it; shares follow live position.
  useEffect(() => {
    if (!stopLossSimple || !stopLossEnabled) return;
    const s = stopLossStopCents.trim();
    if (!s) return;
    setStopLossLimitCents(s);
  }, [stopLossSimple, stopLossEnabled, stopLossStopCents]);

  useEffect(() => {
    if (!stopLossEnabled && !takeProfitEnabled) return;
    if (bracketPositionShares == null) return;
    const rem = floorShares4(bracketPositionShares);
    if (!(rem > 0)) return;
    const prev = bracketSharesSyncRef.current;
    if (prev != null && Math.abs(rem - prev) < 0.25) return;
    bracketSharesSyncRef.current = rem;
    syncBracketSharesFromPosition(bracketPositionShares);
  }, [bracketPositionShares, stopLossEnabled, takeProfitEnabled, syncBracketSharesFromPosition]);

  useEffect(() => {
    if (!takeProfitSimple || !takeProfitEnabled) return;
    const s = takeProfitTakeCents.trim();
    if (!s) return;
    setTakeProfitLimitCents(s);
  }, [takeProfitSimple, takeProfitEnabled, takeProfitTakeCents]);

  // Reset crossing memory when stop level or watch mode changes (avoid stale edges / stuck latch).
  useEffect(() => {
    stopLossLastCrossRef.current = null;
    stopLossPrevBidRef.current = null;
    stopLossPrevAskRef.current = null;
    stopLossPrevStripMidRef.current = null;
    stopLossLastFireTokRef.current = null;
    stopLossFireLockRef.current = false;
  }, [stopLossStopCents, stopLossDualBook, token]);

  useEffect(() => {
    takeProfitLastCrossRef.current = null;
    takeProfitPrevBidRef.current = null;
    takeProfitPrevAskRef.current = null;
    takeProfitPrevStripMidRef.current = null;
    takeProfitLastFireTokRef.current = null;
    takeProfitFireLockRef.current = false;
  }, [takeProfitTakeCents, takeProfitDualBook, token]);

  useEffect(() => {
    const syncDeskScalpPrefs = () => {
      deskScalpPrefsRef.current = loadNowPriceDeskScalpPrefs();
    };
    syncDeskScalpPrefs();
    window.addEventListener(NOW_PRICE_DESK_SCALP_PREFS_EVENT, syncDeskScalpPrefs);
    return () => window.removeEventListener(NOW_PRICE_DESK_SCALP_PREFS_EVENT, syncDeskScalpPrefs);
  }, []);

  // If the user enables SL/TP after we've already observed price, clear memory so "enable" evaluates immediately.
  useEffect(() => {
    if (!stopLossEnabled) return;
    stopLossLastCrossRef.current = null;
    stopLossPrevBidRef.current = null;
    stopLossPrevAskRef.current = null;
    stopLossPrevStripMidRef.current = null;
  }, [stopLossEnabled, token]);

  useEffect(() => {
    if (!takeProfitEnabled) return;
    takeProfitLastCrossRef.current = null;
    takeProfitPrevBidRef.current = null;
    takeProfitPrevAskRef.current = null;
    takeProfitPrevStripMidRef.current = null;
  }, [takeProfitEnabled, token]);

  // Re-run bracket triggers on a timer while armed — ref callbacks, no tick state (avoids render storms).
  useEffect(() => {
    const deskRisk =
      deskScalpPrefsRef.current.trailingProfit || deskScalpPrefsRef.current.takeLossWhenDeskTpBelowEntry;
    const armed =
      (accountMode === 'live' || accountMode === 'paper') &&
      (bracketAutomationActive({ bracketPollToken, stopLossEnabled, takeProfitEnabled }) || deskRisk);
    if (!armed) return;
    const id = window.setInterval(() => {
      slBracketEvalRef.current();
      tpBracketEvalRef.current();
    }, BRACKET_EVAL_MS);
    return () => window.clearInterval(id);
  }, [accountMode, bracketPollToken, stopLossEnabled, takeProfitEnabled]);

  // Fast REST top-of-book while SL/TP armed — bid can move faster than chart-driven props.
  useEffect(() => {
    const deskRisk =
      deskScalpPrefsRef.current.trailingProfit || deskScalpPrefsRef.current.takeLossWhenDeskTpBelowEntry;
    const needPoll =
      (accountMode === 'live' || accountMode === 'paper') &&
      (bracketAutomationActive({ bracketPollToken, stopLossEnabled, takeProfitEnabled }) || deskRisk);
    if (!needPoll) {
      setStopPollBid01(null);
      setStopPollAsk01(null);
      setStopPollAtMs(null);
      return;
    }
    const tok =
      bracketPollToken?.trim() ||
      bracketOutcomeTokenRef.current?.trim() ||
      token?.trim();
    if (!tok) {
      setStopPollBid01(null);
      setStopPollAsk01(null);
      setStopPollAtMs(null);
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const tick = () => {
      if (cancelled) return;
      if (inFlight) return;
      inFlight = true;
      void clobBook(tok)
        .then((res) => {
          if (cancelled) return;
          if (!isOk(res)) return;
          const tob = topOfBook(res.data);
          const b = tob.bestBid != null && tob.bestBid > 0 ? roundPrice01(tob.bestBid) : null;
          const a = tob.bestAsk != null && tob.bestAsk > 0 ? roundPrice01(tob.bestAsk) : null;
          setStopPollBid01((prev) => (prev === b ? prev : b));
          setStopPollAsk01((prev) => (prev === a ? prev : a));
          setStopPollAtMs((prev) => {
            const next = Date.now();
            return prev != null && next - prev < 50 ? prev : next;
          });
        })
        .finally(() => {
          inFlight = false;
        });
    };
    tick();
    const id = window.setInterval(tick, BRACKET_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [accountMode, stopLossEnabled, takeProfitEnabled, bracketPollToken, token]);

  // Stop-loss trigger loop: uses best bid when available, else last-trade/mid mark; paper fills at limit when crossed.
  useEffect(() => {
    const runStopLossEval = () => {
    const tok = bracketOutcomeTokenRef.current?.trim() || token?.trim();
    if (!tok) return;
    const automationTok = bracketPollToken?.trim() || tok;
    if (!stopLossEnabled) {
      const storedSl = loadStopLossConfigFromStorage(automationTok);
      if (!storedSl?.enabled) return;
    }
    const bracketLane: 'up' | 'down' =
      bracketOutcomeLaneRef.current ??
      (tok === upToken?.trim() ? 'up' : tok === downToken?.trim() ? 'down' : lane);
    const pin = bracketArmedPinRef.current;
    const deskLocked = operatorSlTpLockedRef.current;
    const stopCentsEffective =
      deskLocked && pin?.stopCents?.trim() && pin.token === tok && pin.lane === bracketLane
        ? pin.stopCents
        : stopLossStopCents;
    const armedSl = resolveArmedStopLoss({
      automationTok,
      enabled: stopLossEnabled,
      stopCents: stopCentsEffective,
      limitCents: stopCentsEffective,
      sharesStr: stopLossShares,
      simple: stopLossSimple,
      dualBook: stopLossDualBook,
      laneDraftSl: bracketLaneDraftRef.current[bracketLane].sl,
    });
    if (!armedSl) {
      if (stopLossEnabled) setStopLossStatus('ARMED');
      else setStopLossStatus('OFF');
      return;
    }
    const { stop01, limit01, shares: shReq, simple: slSimple, dualBook: slDualBook } = armedSl;
    const heldForSl =
      accountMode === 'paper' ? getPaperPosition(paperAccount, tok).shares : liveLaneShares('display', bracketLane);
    if (!(heldForSl > 0)) {
      if (isExternallyFlatPosition({
        clobBal: bracketLane === 'up' ? balUp : balDown,
        sellShares: liveLaneShares('sell', bracketLane),
      })) {
        maybeDisarmOnManualFlat();
      } else if (stopLossEnabled) {
        setStopLossStatus('ARMED');
      }
      return;
    }
    const positionForSl =
      accountMode === 'paper' ? heldForSl : liveLaneShares('sell', bracketLane);
    const touch = bracketLane === 'up' ? (bookTouchUp ?? null) : (bookTouchDown ?? null);
    const bidTouch = touch?.bestBid != null && touch.bestBid > 0 ? roundPrice01(touch.bestBid) : null;
    const askTouch = touch?.bestAsk != null && touch.bestAsk > 0 ? roundPrice01(touch.bestAsk) : null;
    const stripMid01 = bracketStripMid01;
    const bidForSl = bracketAutomationBid01({
      pollBid01: stopPollBid01,
      touchBid01: bidTouch,
      fallback01: stripMid01 ?? displayMark01,
      forPaper: accountMode === 'paper',
      allowMidFallback: accountMode === 'live',
    });
    const askForSl = bracketAutomationAsk01({
      pollAsk01: stopPollAsk01,
      touchAsk01: askTouch,
      fallback01: stripMid01 ?? displayMark01,
      forPaper: accountMode === 'paper',
      allowMidFallback: accountMode === 'live',
    });
    const slEval = evaluateStopLossCross({
      stop01,
      bid01: bidForSl,
      ask01: askForSl,
      prevBid01: stopLossPrevBidRef.current,
      stripMid01,
      honorChartMid: true,
      watchAsk: slDualBook,
    });
    if (bidForSl != null) stopLossPrevBidRef.current = bidForSl;
    if (stripMid01 != null) stopLossPrevStripMidRef.current = stripMid01;
    const crossed = slEval.crossed;
    const ref01 = slEval.ref01;
    if (ref01 != null) stopLossLastCrossRef.current = ref01;

    if (!crossed) {
      if (!stopLossFireLockRef.current && stopLossEnabled) {
        stopLossLastFireTokRef.current = null;
        stopLossLastAttemptMsRef.current = 0;
        setStopLossStatus('ARMED');
      }
      return;
    }
    const execRef01 =
      ref01 != null && ref01 > 0 && ref01 < 1
        ? ref01
        : stripMid01 != null && stripMid01 > 0 && stripMid01 < 1
          ? stripMid01
          : stop01;
    if (!(execRef01 > 0) || execRef01 >= 1) {
      if (!stopLossFireLockRef.current) {
        stopLossLastFireTokRef.current = null;
        stopLossLastAttemptMsRef.current = 0;
        setStopLossStatus('ARMED');
      }
      return;
    }
    if (stopLossFireLockRef.current) return;
    if (takeProfitFireLockRef.current) return;
    if (
      !bracketExitReadyToFire({
        tok,
        lastFireTokRef: stopLossLastFireTokRef,
        lastAttemptMsRef: stopLossLastAttemptMsRef,
      })
    ) {
      return;
    }

    stopLossFireLockRef.current = true;
    stopLossLastAttemptMsRef.current = Date.now();
    setStopLossStatus('TRIGGERED');

    void (async () => {
      try {
        let sellable = positionForSl;
        const px = stopLossExecLimit01({ stop01, limit01, ref01: execRef01, simple: slSimple });
        const quoted01 = execRef01;

        if (accountMode === 'paper') {
          // Read persisted account so we never miss a just-filled buy (React state can lag localStorage).
          // Do not capture `paperTrade` via `setPaperAccount` updater — Strict Mode / batching can drop the result and skip Recent fills.
          const acc = loadPaperAccount();
          const posSh = getPaperPosition(acc, tok).shares;
          const sz = floorShares4(Math.min(shReq, posSh));
          if (!(sz > 0) || sz < 1e-4) {
            stopLossLastFireTokRef.current = null;
            return;
          }
          const pr = paperTrade({ account: acc, tokenId: tok, side: 'sell', shares: sz, price01: px });
          if (pr.ok) {
            setPaperAccount(pr.account);
            setLastAutoSell({
              kind: 'sl',
              ts: Date.now(),
              mode: 'paper',
              status: 'filled',
              shares: pr.fill.shares,
              triggerCents: stop01 * 100,
              refCents: execRef01 * 100,
              limitCents: px * 100,
              fillCents: pr.fill.price01 * 100,
              orderId: null,
              msg: `paper stop_loss<=${(stop01 * 100).toFixed(1)}¢`,
            });
            setHistoryRows(
              appendTradeHistory({
                ...tradeHistoryMarketMeta,
                mode: 'paper',
                exec: 'limit',
                side: 'sell',
                token: tok,
                label,
                price01: pr.fill.price01,
                quotedPrice01: quoted01,
                intendedPrice01: px,
                fillAvgPrice01: pr.fill.price01,
                markPrice01: execRef01,
                shares: pr.fill.shares,
                requestedShares: pr.fill.shares,
                remainingShares: 0,
                usdCents: Math.abs(pr.fill.usdCents),
                status: 'filled',
                auditNote: `paper stop_loss<=${(stop01 * 100).toFixed(1)}¢${stopLossDualBook ? ' · bid+ask' : ''}`,
              }),
            );
            pushToast('ok', `Paper stop-loss: sold ${pr.fill.shares.toFixed(4)} sh @ ${(pr.fill.price01 * 100).toFixed(1)}¢`);
            playTradeFill();
            stopLossLastFireTokRef.current = tok;
            syncRiskAutomationAfterSellFill(getPaperPosition(pr.account, tok).shares);
          } else {
            stopLossLastFireTokRef.current = null;
            setStopLossStatus('ARMED');
            setLastAutoSell({
              kind: 'sl',
              ts: Date.now(),
              mode: 'paper',
              status: 'failed',
              shares: 0,
              triggerCents: stop01 * 100,
              refCents: execRef01 * 100,
              limitCents: px * 100,
              fillCents: null,
              orderId: null,
              msg: pr.error,
            });
            pushToast('err', `Paper stop-loss: ${pr.error}`);
            playTradeError();
          }
          return;
        }

        const bracketLabel = bracketLane === 'up' ? upLabel : downLabel;
        const bracketOutcome = bullpenOutcomeForOrder({
          lane: bracketLane,
          marketSlug,
          label: bracketLabel,
        });
        if (!marketSlug?.trim() || !bracketOutcome) {
          stopLossLastFireTokRef.current = null;
          pushToast('err', 'Stop-loss: market slug/outcome missing — reload the market and re-arm SL.');
          playTradeError();
          return;
        }

        sellable = liveLaneShares('sell', bracketLane);
        if (!(sellable > 0)) {
          const displaySl = liveLaneShares('display', bracketLane);
          if (displaySl > 0) sellable = displaySl;
        }
        if (!(sellable > 0) && heldForSl > 0) sellable = heldForSl;
        const sizeLive = floorShares4(Math.min(shReq, sellable));
        if (!(sizeLive > 0) || sizeLive < 1e-4) {
          stopLossLastFireTokRef.current = null;
          setStopLossStatus('ARMED');
          pushToast(
            'err',
            heldForSl > 0
              ? 'Stop-loss: CLOB shows 0 sellable shares — refresh balance or sell manually on Polymarket.'
              : 'Stop-loss: no shares to sell.',
            9000,
          );
          playTradeError();
          return;
        }

        // Fire sell immediately — refresh balance in background after.
        void tradeUpdateBalanceAllowance({ tokenId: tok, assetType: 'conditional' }).catch(() => {});

        const slFakFloor01 = stopLossSimple ? stop01 : Math.min(limit01, stop01);
        const refCents = execRef01 * 100;
        const optimistic = appendTradeHistoryWithId({
          ...tradeHistoryMarketMeta,
          mode: 'live',
          exec: 'market',
          side: 'sell',
          token: tok,
          label: bracketLabel,
          price01: px,
          quotedPrice01: quoted01,
          intendedPrice01: px,
          submittedPrice01: null,
          fillAvgPrice01: null,
          markPrice01: execRef01,
          shares: 0,
          requestedShares: sizeLive,
          remainingShares: sizeLive,
          usdCents: Math.abs(Math.round(px * sizeLive * 100)),
          status: 'sending',
          auditNote: `stop_loss_market stop=${(stop01 * 100).toFixed(1)}¢ ref=${refCents.toFixed(1)}¢`,
        });
        setHistoryRows(optimistic.rows);
        const controller = new AbortController();
        const tClient0 = performance.now();
        const exitRes = await submitLiveBracketExit({
          token: tok,
          marketSlug: marketSlug.trim(),
          outcome: bracketOutcome,
          lane: bracketLane,
          price01: px,
          sizeShares: sizeLive,
          floor01: slFakFloor01,
          urgency: 'immediate',
          signal: controller.signal,
        });
        const clientMs = Math.round(performance.now() - tClient0);
        if (!exitRes.ok) {
          const e = exitRes.apiErr ?? ({ error: exitRes.error } as ApiErr);
          stopLossLastFireTokRef.current = null;
          setStopLossStatus('ARMED');
          const errMsg = formatTradeApiError(e);
          setLastAutoSell({
            kind: 'sl',
            ts: Date.now(),
            mode: 'live',
            status: 'failed',
            shares: sizeLive,
            triggerCents: stop01 * 100,
            refCents,
            limitCents: px * 100,
            fillCents: null,
            orderId: null,
            msg: errMsg,
          });
          setHistoryRows(
            updateTradeHistoryRow(optimistic.id, {
              status: 'failed',
              error: errMsg,
            }),
          );
          pushToast('err', `Stop-loss failed: ${errMsg}`);
          playTradeError();
        } else {
          const { result, execution } = unwrapTradeActionData(exitRes.data);
          const oid = execution?.order_id ?? extractOrderIdFromClobPayload(result);
          const rt = mergeRoundTripMs(execution?.round_trip_ms, clientMs);
          setLastExecLatencyMs(rt);
          const slRowId = optimistic.id;
          const exitPath = exitRes.path;
          setLastAutoSell({
            kind: 'sl',
            ts: Date.now(),
            mode: 'live',
            status: 'sent',
            shares: sizeLive,
            triggerCents: stop01 * 100,
            refCents,
            limitCents: px * 100,
            fillCents: null,
            orderId: oid ?? null,
            msg: `stop_loss_${exitPath} stop=${(stop01 * 100).toFixed(1)}¢ lim=${(px * 100).toFixed(1)}¢`,
          });
          setHistoryRows(
            updateTradeHistoryRow(slRowId, {
              status: 'sent',
              shares: 0,
              requestedShares: sizeLive,
              remainingShares: sizeLive,
              submittedPrice01: execution?.submitted_price_01 ?? px,
              orderId: oid ?? undefined,
              roundTripMs: rt,
              price01: px,
              error: undefined,
              auditNote:
                exitPath === 'market'
                  ? `stop_loss_market stop=${(stop01 * 100).toFixed(1)}¢`
                  : `stop_loss_fak stop=${(stop01 * 100).toFixed(1)}¢ bid=${refCents != null ? refCents.toFixed(1) : '?'}¢`,
            }),
          );
          if (oid) pollRestingOrderFill(slRowId, oid, sizeLive, px, quoted01);
          pushToast(
            'ok',
            exitPath === 'market'
              ? `Stop-loss market sell (${sizeLive.toFixed(4)} sh) — confirming…`
              : `Stop-loss FAK @ ${(px * 100).toFixed(1)}¢ (${sizeLive.toFixed(4)} sh)${refCents != null ? ` · bid was ${refCents.toFixed(1)}¢` : ''} — confirming…`,
          );
          stopLossLastFireTokRef.current = tok;
          scheduleTruthRefreshBurst(tok, oid ?? null, () =>
            afterLiveSellRowReconcile(slRowId, {
              sl: { stop01, limit01: px, sizeLive, oid: oid ?? null, refCents },
            }),
          );
        }
      } finally {
        stopLossFireLockRef.current = false;
      }
    })();
    };
    slBracketEvalRef.current = runStopLossEval;
    runStopLossEval();
  }, [
    accountMode,
    balDown,
    balUp,
    bookTouchUp?.bestAsk,
    bookTouchUp?.bestBid,
    bookTouchDown?.bestAsk,
    bookTouchDown?.bestBid,
    bracketStripMid01,
    displayMark01,
    label,
    lane,
    liveLaneShares,
    marketSlug,
    maybeDisarmOnManualFlat,
    positionShares,
    refreshAvgEntry,
    refreshOpenOrders,
    refreshPositionAndMaxSell,
    resolvedBullpenOutcome,
    afterLiveSellRowReconcile,
    bracketPollToken,
    scheduleTruthRefreshBurst,
    stopLossDualBook,
    stopLossEnabled,
    stopLossLimitCents,
    stopLossShares,
    stopLossSimple,
    stopLossStopCents,
    stopPollAsk01,
    stopPollBid01,
    stopPollAtMs,
    syncRiskAutomationAfterSellFill,
    token,
    tradeHistoryMarketMeta,
  ]);

  // Take-profit: bid or chart mid at/through take → FAK at TP/touch first, market fallback.
  useEffect(() => {
    const runTakeProfitEval = () => {
    const tok = bracketOutcomeTokenRef.current?.trim() || token?.trim();
    if (!tok) return;
    const prefs = deskScalpPrefsRef.current;
    const needsDeskRisk = prefs.trailingProfit || prefs.takeLossWhenDeskTpBelowEntry;
    if (!takeProfitEnabled && !needsDeskRisk) {
      const automationTokEarly = bracketPollToken?.trim() || tok;
      const storedTpEarly = loadTakeProfitConfigFromStorage(automationTokEarly);
      if (!storedTpEarly?.enabled) return;
    }
    const automationTok = bracketPollToken?.trim() || tok;
    const bracketLane: 'up' | 'down' =
      bracketOutcomeLaneRef.current ??
      (tok === upToken?.trim() ? 'up' : tok === downToken?.trim() ? 'down' : lane);
    const pin = bracketArmedPinRef.current;
    const deskLocked = operatorSlTpLockedRef.current;
    const touch = bracketLane === 'up' ? (bookTouchUp ?? null) : (bookTouchDown ?? null);
    const bidTouch = touch?.bestBid != null && touch.bestBid > 0 ? roundPrice01(touch.bestBid) : null;
    const askTouch = touch?.bestAsk != null && touch.bestAsk > 0 ? roundPrice01(touch.bestAsk) : null;
    const stripMid01 = bracketStripMid01;
    const heldForTp =
      accountMode === 'paper' ? getPaperPosition(paperAccount, tok).shares : liveLaneShares('display', bracketLane);
    const bidForTp = bracketAutomationBid01({
      pollBid01: stopPollBid01,
      touchBid01: bidTouch,
      fallback01: stripMid01 ?? displayMark01,
      forPaper: accountMode === 'paper',
      allowMidFallback: accountMode === 'live',
    });
    const askForTp = bracketAutomationAsk01({
      pollAsk01: stopPollAsk01,
      touchAsk01: askTouch,
      fallback01: stripMid01 ?? displayMark01,
      forPaper: accountMode === 'paper',
      allowMidFallback: accountMode === 'live',
    });

    const scalpPrefs = prefs;
    const entryForRisk =
      bracketLane === 'up'
        ? accountMode === 'paper'
          ? paperUpPos.avgCost01
          : avgEntryUp
        : accountMode === 'paper'
          ? paperDownPos.avgCost01
          : avgEntryDown;
    const liveDeskTp01 = liveDeskTp01FromBook(touch, stripMid01 ?? displayMark01);
    const deskTpLossCrossed =
      scalpPrefs.takeLossWhenDeskTpBelowEntry &&
      heldForTp > 0 &&
      deskTpBelowEntry(entryForRisk, liveDeskTp01);

    const storedTpCfg = loadTakeProfitConfigFromStorage(automationTok);
    const tpEnabledForAutomation = takeProfitEnabled || storedTpCfg?.enabled === true;
    const tpSharesForAutomation =
      takeProfitShares.trim() ||
      (storedTpCfg != null && storedTpCfg.shares > 0 ? String(storedTpCfg.shares) : '') ||
      (bracketPositionShares != null && bracketPositionShares > 0 ? String(floorShares4(bracketPositionShares)) : '');
    const takeCentsFromStored =
      storedTpCfg?.enabled && storedTpCfg.take01 != null
        ? formatBracketCentsFromNumber(Math.round(storedTpCfg.take01 * 100))
        : '';
    const takeCentsEffective =
      deskLocked && pin?.tpCents?.trim() && pin.token === tok && pin.lane === bracketLane
        ? pin.tpCents
        : takeCentsFromStored || takeProfitTakeCents;
    const armedTp = resolveArmedTakeProfit({
      automationTok,
      enabled: tpEnabledForAutomation,
      takeCents: takeCentsEffective,
      limitCents: takeCentsEffective,
      sharesStr: tpSharesForAutomation,
      simple: takeProfitSimple,
      dualBook: takeProfitDualBook,
      laneDraftTp: bracketLaneDraftRef.current[bracketLane].tp,
    });
    const armedSlForLock = resolveArmedStopLoss({
      automationTok,
      enabled: stopLossEnabled,
      stopCents: stopLossStopCents,
      limitCents: stopLossLimitCents,
      sharesStr: stopLossShares,
      simple: stopLossSimple,
      dualBook: stopLossDualBook,
      laneDraftSl: bracketLaneDraftRef.current[bracketLane].sl,
    });
    if (!armedTp && !deskTpLossCrossed) {
      if (tpEnabledForAutomation) setTakeProfitStatus('ARMED');
      else if (takeProfitEnabled) setTakeProfitStatus('OFF');
      return;
    }
    const tpResolved = armedTp ?? {
      take01: entryForRisk != null && entryForRisk > 0 ? entryForRisk : 0.01,
      limit01: bidForTp ?? entryForRisk ?? 0.01,
      shares: floorShares4(heldForTp),
      simple: true,
      dualBook: false,
      enabled: true,
    };
    const { take01, limit01, shares: shReq, simple: tpSimple, dualBook: tpDualBook } = tpResolved;
    const slEnabledForLock = armedSlForLock?.enabled ?? false;
    if (!(heldForTp > 0)) {
      if (isExternallyFlatPosition({
        clobBal: bracketLane === 'up' ? balUp : balDown,
        sellShares: liveLaneShares('sell', bracketLane),
      })) {
        maybeDisarmOnManualFlat();
      } else if (tpEnabledForAutomation || takeProfitEnabled) {
        setTakeProfitStatus('ARMED');
      }
      return;
    }
    const tpEval = armedTp
      ? evaluateTakeProfitCross({
          take01,
          bid01: bidForTp,
          ask01: askForTp,
          prevBid01: takeProfitPrevBidRef.current,
          stripMid01,
          honorChartMid: true,
          watchAsk: tpDualBook,
        })
      : { crossed: false, ref01: bidForTp };
    if (bidForTp != null) takeProfitPrevBidRef.current = bidForTp;
    if (stripMid01 != null) takeProfitPrevStripMidRef.current = stripMid01;

    let trailingCrossed = false;
    if (scalpPrefs.trailingProfit && entryForRisk != null && entryForRisk > 0 && entryForRisk < 1) {
      const mark01 = bracketTpMark01({
        bid01: bidForTp,
        ask01: askForTp,
        stripMid01,
        honorChartMid: true,
      });
      const peakKey = `${automationTok}|trail`;
      const peakPrev = trailingTpPeakByTokRef.current.get(peakKey) ?? null;
      const trailEval = evaluateTrailingProfitExit({
        entry01: entryForRisk,
        currentMark01: mark01,
        peakMark01: peakPrev,
      });
      if (trailEval.peakMark01 != null) {
        trailingTpPeakByTokRef.current.set(peakKey, trailEval.peakMark01);
      }
      trailingCrossed = trailEval.shouldExit;
    }

    const crossed = deskTpLossCrossed || tpEval.crossed || trailingCrossed;
    const ref01 = tpEval.ref01;
    if (ref01 != null) takeProfitLastCrossRef.current = ref01;

    if (!crossed) {
      if (!takeProfitFireLockRef.current && (tpEnabledForAutomation || takeProfitEnabled)) {
        takeProfitLastFireTokRef.current = null;
        takeProfitLastAttemptMsRef.current = 0;
        setTakeProfitStatus('ARMED');
      }
      return;
    }
    const execRef01 =
      ref01 != null && ref01 > 0 && ref01 < 1
        ? ref01
        : stripMid01 != null && stripMid01 > 0 && stripMid01 < 1
          ? stripMid01
          : take01;
    if (!(execRef01 > 0) || execRef01 >= 1) {
      if (!takeProfitFireLockRef.current && (tpEnabledForAutomation || takeProfitEnabled)) {
        takeProfitLastFireTokRef.current = null;
        takeProfitLastAttemptMsRef.current = 0;
        setTakeProfitStatus('ARMED');
      }
      return;
    }
    if (takeProfitFireLockRef.current) return;
    if (slEnabledForLock && stopLossFireLockRef.current) return;
    if (
      !bracketExitReadyToFire({
        tok,
        lastFireTokRef: takeProfitLastFireTokRef,
        lastAttemptMsRef: takeProfitLastAttemptMsRef,
      })
    ) {
      return;
    }

    takeProfitFireLockRef.current = true;
    takeProfitLastAttemptMsRef.current = Date.now();
    setTakeProfitStatus('TRIGGERED');

    void (async () => {
      try {
        const px = takeProfitExecLimit01({ take01, limit01, ref01: execRef01, simple: tpSimple });
        const quoted01 = execRef01;

        if (accountMode === 'paper') {
          const acc = loadPaperAccount();
          const posSh = getPaperPosition(acc, tok).shares;
          const sz = floorShares4(Math.min(shReq, posSh));
          if (!(sz > 0) || sz < 1e-4) {
            takeProfitLastFireTokRef.current = null;
            return;
          }
          const pr = paperTrade({ account: acc, tokenId: tok, side: 'sell', shares: sz, price01: px });
          if (pr.ok) {
            setPaperAccount(pr.account);
            setLastAutoSell({
              kind: 'tp',
              ts: Date.now(),
              mode: 'paper',
              status: 'filled',
              shares: pr.fill.shares,
              triggerCents: take01 * 100,
              refCents: execRef01 * 100,
              limitCents: px * 100,
              fillCents: pr.fill.price01 * 100,
              orderId: null,
              msg: `paper take_profit>=${(take01 * 100).toFixed(1)}¢`,
            });
            setHistoryRows(
              appendTradeHistory({
                ...tradeHistoryMarketMeta,
                mode: 'paper',
                exec: 'limit',
                side: 'sell',
                token: tok,
                label,
                price01: pr.fill.price01,
                quotedPrice01: quoted01,
                intendedPrice01: px,
                fillAvgPrice01: pr.fill.price01,
                markPrice01: execRef01,
                shares: pr.fill.shares,
                requestedShares: pr.fill.shares,
                remainingShares: 0,
                usdCents: Math.abs(pr.fill.usdCents),
                status: 'filled',
                auditNote: `paper take_profit>=${(take01 * 100).toFixed(1)}¢${takeProfitDualBook ? ' · bid+ask' : ''}`,
              }),
            );
            pushToast('ok', `Paper take-profit: sold ${pr.fill.shares.toFixed(4)} sh @ ${(pr.fill.price01 * 100).toFixed(1)}¢`);
            playTradeFill();
            takeProfitLastFireTokRef.current = tok;
            syncRiskAutomationAfterSellFill(getPaperPosition(pr.account, tok).shares);
          } else {
            takeProfitLastFireTokRef.current = null;
            setTakeProfitStatus('ARMED');
            setLastAutoSell({
              kind: 'tp',
              ts: Date.now(),
              mode: 'paper',
              status: 'failed',
              shares: 0,
              triggerCents: take01 * 100,
              refCents: execRef01 * 100,
              limitCents: px * 100,
              fillCents: null,
              orderId: null,
              msg: pr.error,
            });
            pushToast('err', `Paper take-profit: ${pr.error}`);
            playTradeError();
          }
          return;
        }

        const bracketLabel = bracketLane === 'up' ? upLabel : downLabel;
        const bracketOutcome = bullpenOutcomeForOrder({
          lane: bracketLane,
          marketSlug,
          label: bracketLabel,
        });
        if (!marketSlug?.trim() || !bracketOutcome) {
          takeProfitLastFireTokRef.current = null;
          pushToast('err', 'Take-profit: market slug/outcome missing — reload the market and re-arm TP.');
          playTradeError();
          return;
        }

        let sellableTp = liveLaneShares('sell', bracketLane);
        if (!(sellableTp > 0)) {
          const displayTp = liveLaneShares('display', bracketLane);
          if (displayTp > 0) sellableTp = displayTp;
        }
        if (!(sellableTp > 0) && heldForTp > 0) sellableTp = heldForTp;
        const sizeLive = floorShares4(Math.min(shReq, sellableTp));
        if (!(sizeLive > 0) || sizeLive < 1e-4) {
          takeProfitLastFireTokRef.current = null;
          takeProfitFireLockRef.current = false;
          setTakeProfitStatus('ARMED');
          pushToast(
            'err',
            heldForTp > 0
              ? 'Take-profit: CLOB shows 0 sellable shares — refresh balance or sell manually on Polymarket.'
              : 'Take-profit: no shares to sell.',
            9000,
          );
          playTradeError();
          return;
        }

        // Take profit should first try to realize the armed level. Market sell is only fallback.
        void tradeUpdateBalanceAllowance({ tokenId: tok, assetType: 'conditional' }).catch(() => {});

        const tpFakFloor01 = tpSimple ? take01 : Math.min(limit01, take01);
        const refCents = execRef01 * 100;
        const optimistic = appendTradeHistoryWithId({
          ...tradeHistoryMarketMeta,
          mode: 'live',
          exec: 'market',
          side: 'sell',
          token: tok,
          label: bracketLabel,
          price01: px,
          quotedPrice01: quoted01,
          intendedPrice01: px,
          submittedPrice01: null,
          fillAvgPrice01: null,
          markPrice01: execRef01,
          shares: 0,
          requestedShares: sizeLive,
          remainingShares: sizeLive,
          usdCents: Math.abs(Math.round(px * sizeLive * 100)),
          status: 'sending',
          auditNote: `take_profit_limit_first take=${(take01 * 100).toFixed(1)}¢ ref=${refCents.toFixed(1)}¢ floor=${(tpFakFloor01 * 100).toFixed(1)}¢`,
        });
        setHistoryRows(optimistic.rows);
        const controller = new AbortController();
        const tClient0 = performance.now();
        const exitRes = await submitLiveBracketExit({
          token: tok,
          marketSlug: marketSlug.trim(),
          outcome: bracketOutcome,
          lane: bracketLane,
          price01: px,
          sizeShares: sizeLive,
          floor01: tpFakFloor01,
          urgency: 'limit_first',
          signal: controller.signal,
        });
        const clientMs = Math.round(performance.now() - tClient0);
        if (!exitRes.ok) {
          const e = exitRes.apiErr ?? ({ error: exitRes.error } as ApiErr);
          takeProfitLastFireTokRef.current = null;
          const formattedErr = formatTradeApiError(e);
          const errMsg =
            exitRes.error && exitRes.error !== e.error && !formattedErr.includes(exitRes.error)
              ? `${exitRes.error} · ${formattedErr}`
              : formattedErr;
          setTakeProfitStatus('ARMED');
          setLastAutoSell({
            kind: 'tp',
            ts: Date.now(),
            mode: 'live',
            status: 'failed',
            shares: sizeLive,
            triggerCents: take01 * 100,
            refCents,
            limitCents: px * 100,
            fillCents: null,
            orderId: null,
            msg: errMsg,
          });
          setHistoryRows(
            updateTradeHistoryRow(optimistic.id, {
              status: 'failed',
              error: errMsg,
            }),
          );
          pushToast('err', `Take-profit failed: ${errMsg}`);
          playTradeError();
        } else {
          const { result, execution } = unwrapTradeActionData(exitRes.data);
          const oid = execution?.order_id ?? extractOrderIdFromClobPayload(result);
          const rt = mergeRoundTripMs(execution?.round_trip_ms, clientMs);
          setLastExecLatencyMs(rt);
          const tpRowId = optimistic.id;
          const exitPath = exitRes.path;
          setLastAutoSell({
            kind: 'tp',
            ts: Date.now(),
            mode: 'live',
            status: 'sent',
            shares: sizeLive,
            triggerCents: take01 * 100,
            refCents,
            limitCents: px * 100,
            fillCents: null,
            orderId: oid ?? null,
            msg: `take_profit_${exitPath} take=${(take01 * 100).toFixed(1)}¢ lim=${(px * 100).toFixed(1)}¢`,
          });
          setHistoryRows(
            updateTradeHistoryRow(tpRowId, {
              status: 'sent',
              shares: 0,
              requestedShares: sizeLive,
              remainingShares: sizeLive,
              submittedPrice01: execution?.submitted_price_01 ?? px,
              orderId: oid ?? undefined,
              roundTripMs: rt,
              price01: px,
              error: undefined,
              auditNote:
                exitPath === 'market'
                  ? `take_profit_market take=${(take01 * 100).toFixed(1)}¢`
                  : `take_profit_fak take=${(take01 * 100).toFixed(1)}¢ bid=${refCents != null ? refCents.toFixed(1) : '?'}¢ lim=${(px * 100).toFixed(1)}¢`,
            }),
          );
          if (oid) {
            pollRestingOrderFill(tpRowId, oid, sizeLive, px, quoted01);
          }
          pushToast(
            'ok',
            exitPath === 'market'
              ? `Take-profit market sell (${sizeLive.toFixed(4)} sh) — confirming…`
              : `Take-profit FAK @ ${(px * 100).toFixed(1)}¢ (${sizeLive.toFixed(4)} sh)${refCents != null ? ` · bid was ${refCents.toFixed(1)}¢` : ''} — confirming…`,
          );
          takeProfitLastFireTokRef.current = tok;
          scheduleTruthRefreshBurst(tok, oid ?? null, () =>
            afterLiveSellRowReconcile(tpRowId, {
              tp: { take01, limit01: px, sizeLive, oid: oid ?? null, refCents },
            }),
          );
        }
      } finally {
        takeProfitFireLockRef.current = false;
      }
    })();
    };
    tpBracketEvalRef.current = runTakeProfitEval;
    runTakeProfitEval();
  }, [
    accountMode,
    avgEntryDown,
    avgEntryUp,
    balDown,
    balUp,
    bookTouchUp?.bestAsk,
    bookTouchUp?.bestBid,
    bookTouchDown?.bestAsk,
    bookTouchDown?.bestBid,
    bracketStripMid01,
    displayMark01,
    label,
    lane,
    liveLaneShares,
    marketSlug,
    maybeDisarmOnManualFlat,
    positionShares,
    refreshAvgEntry,
    refreshOpenOrders,
    refreshPositionAndMaxSell,
    resolvedBullpenOutcome,
    afterLiveSellRowReconcile,
    bracketPollToken,
    bracketPositionShares,
    stopLossEnabled,
    stopPollAsk01,
    stopPollBid01,
    stopPollAtMs,
    syncRiskAutomationAfterSellFill,
    takeProfitDualBook,
    takeProfitEnabled,
    takeProfitLimitCents,
    takeProfitShares,
    takeProfitSimple,
    takeProfitTakeCents,
    token,
    tradeHistoryMarketMeta,
    scheduleTruthRefreshBurst,
  ]);

  // Keep sell + bracket sizing instant from cache; reconcile CLOB in background.
  useEffect(() => {
    if (action !== 'sell') return;
    if (!token) return;
    applyMaxSellFromCache(lane);
    if (accountMode === 'live') {
      void refreshPositionAndMaxSell();
      void refreshOpenOrders();
      refreshAvgEntryThrottled();
      refreshLiveBalancesThrottled({ silent: true });
    }
  }, [
    accountMode,
    action,
    applyMaxSellFromCache,
    lane,
    token,
    refreshAvgEntryThrottled,
    refreshLiveBalancesThrottled,
    refreshOpenOrders,
    refreshPositionAndMaxSell,
  ]);

  /** Faster CLOB balance reads while selling or SL/TP armed (no allowance refresh on poll). */
  useEffect(() => {
    if (accountMode !== 'live') return;
    if (!upToken || !downToken) return;
    const deskRiskActive = () =>
      deskScalpPrefsRef.current.trailingProfit || deskScalpPrefsRef.current.takeLossWhenDeskTpBelowEntry;
    const shouldPoll = () =>
      action === 'sell' || stopLossEnabled || takeProfitEnabled || deskRiskActive() || Boolean(bracketPollToken?.trim());
    if (!shouldPoll()) return;
    const tick = () => {
      if (!shouldPoll()) return;
      void readLiveBalancesOnce().then(() => maybeDisarmOnManualFlat());
    };
    tick();
    const id = window.setInterval(tick, 750);
    return () => window.clearInterval(id);
  }, [
    accountMode,
    action,
    bracketPollToken,
    downToken,
    maybeDisarmOnManualFlat,
    readLiveBalancesOnce,
    stopLossEnabled,
    takeProfitEnabled,
    upToken,
  ]);

  /** React to balance drops from manual sells on Polymarket / Bullpen (outside this UI). */
  useEffect(() => {
    maybeDisarmOnManualFlat();
  }, [balUp, balDown, posSharesUp, posSharesDown, maybeDisarmOnManualFlat]);

  useEffect(() => {
    if (action !== 'sell') return;
    const sh = resolveInstantMaxSellShares(lane);
    if (!(sh > 0)) return;
    setSellQty((prev) => {
      const t = prev.trim();
      if (!t || t === '0') return String(sh);
      return prev;
    });
  }, [action, lane, liveSellableShares, livePositionShares, resolveInstantMaxSellShares]);

  useEffect(() => {
    if (accountMode !== 'live') return;
    if (!token) return;
    const ws = new WebSocket(apiWsUrl('/api/trade/user-ws'));
    let alive = true;
    ws.addEventListener('message', (ev) => {
      if (!alive) return;
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const o = msg as Record<string, unknown>;
      const assetId = String(o.asset_id ?? '');
      if (!assetId || (assetId !== upToken && assetId !== downToken)) return;
      const eventType = String(o.event_type ?? o.type ?? '');

      if (/trade/i.test(eventType)) void fetchLastTradesBoth();
      void refreshLiveBalances();
      void refreshOpenOrders();
      refreshAvgEntryThrottled();
      const armedTok = bracketOutcomeTokenRef.current?.trim();
      if (/trade/i.test(eventType) && armedTok && assetId === armedTok) {
        void refreshPositionAndMaxSell();
      }

      if (assetId !== token) return;

      const parseWsNum = (v: unknown): number | null => {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string') {
          const n = parseFloat(v);
          if (Number.isFinite(n)) return n;
        }
        return null;
      };
      const toPrice01 = (raw: number | null): number | null => {
        if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
        if (raw <= 1) return raw;
        if (raw <= 100) return raw / 100;
        return null;
      };

      // Use *exact* trade prints from the user channel to correct displayed fills.
      // This reduces small (~1–2¢) mismatches vs Polymarket in fast books.
      if (/trade/i.test(eventType)) {
        const px01 = toPrice01(parseWsNum(o.my_price01 ?? o.price));
        const sh = parseWsNum(o.my_size ?? o.size);
        const side = String(o.my_side ?? o.side ?? '').toLowerCase() === 'sell' ? 'sell' : 'buy';
        const status = String(o.status ?? '').toUpperCase();
        const orderIds = new Set<string>();
        const taker = String(o.taker_order_id ?? '').trim();
        if (taker) orderIds.add(taker);
        const makerOrders = o.maker_orders;
        if (Array.isArray(makerOrders)) {
          for (const mo of makerOrders) {
            if (!mo || typeof mo !== 'object') continue;
            const id = String((mo as Record<string, unknown>).order_id ?? '').trim();
            if (id) orderIds.add(id);
          }
        }
        if (px01 != null && sh != null && Number.isFinite(sh) && sh > 0 && orderIds.size > 0) {
          const rows = loadTradeHistory();
          const match = rows.find(
            (r) =>
              r.mode === 'live' &&
              r.token === token &&
              r.side === side &&
              r.orderId &&
              orderIds.has(r.orderId) &&
              (r.status === 'sending' || r.status === 'pending' || r.status === 'sent' || r.status === 'partial'),
          );
          if (match) {
            const prevShares = typeof match.shares === 'number' && Number.isFinite(match.shares) ? match.shares : 0;
            const prevPx = typeof match.fillAvgPrice01 === 'number' && Number.isFinite(match.fillAvgPrice01) ? match.fillAvgPrice01 : null;
            const nextShares = roundShares4(prevShares + sh);
            const nextPx =
              prevPx != null && prevShares > 0
                ? roundPrice01((prevPx * prevShares + px01 * sh) / Math.max(1e-9, prevShares + sh))
                : roundPrice01(px01);
            updateTradeHistoryRow(match.id, {
              // Never mark FILLED from websocket trade prints alone (can be partial / out of order).
              // `getOrder()` polling (and confirmed fills tape) is the source of truth for terminal states.
              status: 'partial',
              fillAvgPrice01: nextPx,
              price01: nextPx,
              shares: nextShares,
              usdCents: Math.abs(Math.round(nextPx * nextShares * 100)),
              auditNote: `user_ws_${status || 'trade'}`,
              error: undefined,
            });
            setHistoryRows(loadTradeHistory());
          }
        }
        void reconcileTradeHistoryFromClob(token);
      }

      if (pendingPos && pendingPos.token === token) {
        if (/order/i.test(eventType)) setPendingPos((p) => (p && p.token === token ? { ...p, status: 'live' } : p));
        if (/trade/i.test(eventType)) {
          setPendingPos((p) => (p && p.token === token ? { ...p, status: 'live' } : p));
        }
      }
    });
    ws.addEventListener('error', () => {
      alive = false;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener('close', () => {
      alive = false;
    });
    return () => {
      alive = false;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }, [
    accountMode,
    apiWsUrl,
    downToken,
    fetchLastTradesBoth,
    pendingPos,
    refreshAvgEntryThrottled,
    refreshLiveBalances,
    refreshOpenOrders,
    token,
    upToken,
  ]);

  // Avoid confusing cross-mode UI residue when toggling paper/live.
  useEffect(() => {
    setErr(null);
    setOkMsg(null);
    setSubmitAbort(null);
    submitLockRef.current = false;
    setBusySubmit(false);
    setPendingPos(null);
  }, [accountMode]);

  const pollRestingOrderFill = useCallback(
    (rowId: string, orderId: string, submittedSize: number, intendedPrice01: number, quotedPrice01: number | null) => {
      const myGen = liveSubmitGenRef.current;
      const started = performance.now();
      let lastMatched = 0;
      let acceptedChecked = false;
      const tick = async () => {
        if (myGen !== liveSubmitGenRef.current) return;
        const res = await tradeGetOrder(orderId);
        if (myGen !== liveSubmitGenRef.current) return;
        if (!isOk(res)) {
          if (performance.now() - started < 120_000) window.setTimeout(tick, 350);
          return;
        }
        const rowTok = loadTradeHistory().find((r) => r.id === rowId)?.token?.trim();
        const p = parseRestingOrderSnapshot(res.data, rowTok || undefined);
        const matched = p.matchedShares ?? 0;
        const orig = p.originalShares ?? submittedSize;
        // IMPORTANT: do not declare FILLED based on shares math alone.
        // `getOrder()` payloads are inconsistent and can briefly look "fully matched" while still open/resting.
        // Only transition to FILLED when Polymarket reports a terminal status.
        const fullyFilledByMath = orig > 0 ? matched >= orig - 1e-4 : matched > 0;
        const fullyFilled = Boolean(p.isTerminal && !p.isCancelled && fullyFilledByMath);
        const remaining = orig > 0 ? Math.max(0, orig - matched) : null;

        const rowBeforePoll = loadTradeHistory().find((r) => r.id === rowId);
        if (
          rowBeforePoll &&
          (rowBeforePoll.status === 'sent' || rowBeforePoll.status === 'sending' || rowBeforePoll.status === 'pending') &&
          !rowShowsExchangeFill(rowBeforePoll)
        ) {
          updateTradeHistoryRow(rowId, {
            shares: matched > 1e-6 ? matched : 0,
            requestedShares: orig,
            remainingShares: remaining ?? orig,
            submittedPrice01: p.limitPrice01 ?? rowBeforePoll.submittedPrice01 ?? undefined,
          });
          setHistoryRows(loadTradeHistory());
        }

        // Never trust local "submitted" price. After first successful fetch, mirror Polymarket's accepted limit.
        if (!acceptedChecked) {
          acceptedChecked = true;
          const accepted = p.limitPrice01;
          if (accepted != null && accepted > 0) {
            updateTradeHistoryRow(rowId, {
              submittedPrice01: accepted,
              quotedPrice01: quotedPrice01 ?? undefined,
            });
            setHistoryRows(loadTradeHistory());
            const mismatch = Math.abs(accepted - intendedPrice01) > 5e-6;
            if (mismatch) {
              pushToast(
                'err',
                `PRICE MISMATCH — DO NOT TRUST UI · intended ${(intendedPrice01 * 100).toFixed(1)}¢ · exchange ${(accepted * 100).toFixed(1)}¢`,
                12000,
              );
            }
          }
        }

        const finishTapeConfirmed = (tape: TapeConfirmedFill, auditSuffix?: string) => {
          if (!rowTok) return;
          applyTapeConfirmedLiveFill(rowId, rowTok, orderId, tape, {
            started,
            quotedPrice01,
            intendedPrice01,
            orig,
            limitPrice01: p.limitPrice01,
            auditSuffix,
          });
          const rowSnap = loadTradeHistory().find((r) => r.id === rowId);
          if (rowSnap?.side === 'sell' && rowSnap.mode === 'live') {
            scheduleTruthRefreshBurst(rowTok, orderId, () => {
              afterLiveSellRowReconcile(rowId);
            });
          } else if (rowSnap?.side === 'buy' && rowSnap.mode === 'live') {
            scheduleTruthRefreshBurst(rowTok, orderId, () => afterLiveBuyRowReconcile(rowId));
          } else {
            void refreshAvgEntry();
            void refreshPositionAndMaxSell();
          }
        };

        if (p.isCancelled) {
          const snapBefore = loadTradeHistory().find((r) => r.id === rowId);
          const aud = String(snapBefore?.auditNote ?? '').toLowerCase();
          if (aud.includes('stop_loss')) stopLossLastFireTokRef.current = null;
          if (aud.includes('take_profit')) takeProfitLastFireTokRef.current = null;
          if (matched > 1e-6 && rowTok) {
            const tape = await reconcileLiveOrderFromTape(rowTok, orderId);
            if (tape) {
              finishTapeConfirmed(
                tape,
                fullyFilledByMath ? 'touch_cancel_terminal' : `touch_cancel_partial:${p.statusRaw || 'cancelled'}`,
              );
              return;
            }
            scheduleTruthRefreshBurst(rowTok, orderId);
            return;
          }

          updateTradeHistoryRow(rowId, {
            status: 'cancelled',
            requestedShares: orig,
            remainingShares: remaining,
            auditNote: p.statusRaw ? `cancelled:${p.statusRaw}` : 'cancelled',
          });
          setHistoryRows(loadTradeHistory());
          setPendingPos((p) => (p && p.token === rowTok ? null : p));
          void refreshAvgEntry();
          void refreshPositionAndMaxSell();
          return;
        }

        const rowBeforeMatch = loadTradeHistory().find((r) => r.id === rowId);
        if (matched > 1e-6 && !rowShowsExchangeFill(rowBeforeMatch)) {
          const patch = patchFromGetOrderMatch({
            matched,
            orig,
            avg01: p.avgPrice01,
            limit01: p.limitPrice01 ?? rowBeforeMatch?.submittedPrice01 ?? null,
            isTerminal: p.isTerminal,
            prevAudit: rowBeforeMatch?.auditNote,
          });
          if (patch) {
            updateTradeHistoryRow(rowId, {
              ...patch,
              requestedShares: orig,
            });
            setHistoryRows(loadTradeHistory());
            void refreshLiveBalancesThrottled({ silent: true });
          }
        }

        if (rowTok && (fullyFilled || matched > 1e-6)) {
          const tape = await reconcileLiveOrderFromTape(rowTok, orderId);
          if (tape) {
            finishTapeConfirmed(tape, fullyFilled ? undefined : 'partial_live');
            if (tape.status === 'filled') return;
          }
        }

        const rowNow = loadTradeHistory().find((r) => r.id === rowId);
        if (matched > 1e-6 && matched > lastMatched + 1e-6 && !rowShowsExchangeFill(rowNow)) {
          lastMatched = matched;
          updateTradeHistoryRow(rowId, {
            status: rowNow?.status === 'filled' || rowNow?.status === 'partial' ? rowNow.status : 'sent',
            shares: rowNow?.shares ?? 0,
            requestedShares: orig,
            remainingShares: remaining ?? orig,
            auditNote: rowNow?.auditNote ?? 'poll_match_awaiting_tape',
          });
          setHistoryRows(loadTradeHistory());
          if (rowTok) {
            void reconcileTradeHistoryFromClob(rowTok, { force: true }).then(
              (n) => n > 0 && setHistoryRows(loadTradeHistory()),
            );
          }
          void refreshLiveBalancesThrottled({ silent: true });
        }

        if (performance.now() - started < 120_000) {
          const age = performance.now() - started;
          const delay = age < 2500 ? 180 : age < 12_000 ? 260 : age < 45_000 ? 420 : 700;
          window.setTimeout(tick, delay);
          return;
        }

        if (matched < 1e-6) {
          const snapNoFill = loadTradeHistory().find((r) => r.id === rowId);
          const audNoFill = String(snapNoFill?.auditNote ?? '').toLowerCase();
          const bracketAud = audNoFill.includes('stop_loss') || audNoFill.includes('take_profit');
          if (bracketAud) {
            if (audNoFill.includes('stop_loss')) stopLossLastFireTokRef.current = null;
            if (audNoFill.includes('take_profit')) takeProfitLastFireTokRef.current = null;
            stopLossFireLockRef.current = false;
            takeProfitFireLockRef.current = false;
          } else if (rowTok) {
            void syncSellPositionAfterBurst(rowTok).then(() => {
              const sh =
                rowTok === upToken?.trim()
                  ? balUp
                  : rowTok === downToken?.trim()
                    ? balDown
                    : null;
              if (sh == null || sh <= 0) {
                if (audNoFill.includes('stop_loss')) stopLossLastFireTokRef.current = null;
                if (audNoFill.includes('take_profit')) takeProfitLastFireTokRef.current = null;
              } else {
                pushToast(
                  'info',
                  'Bracket exit timed out with open position — check Polymarket; latch held until flat.',
                  9000,
                );
              }
            });
          }
          updateTradeHistoryRow(rowId, {
            status: 'no_fill',
            requestedShares: orig,
            remainingShares: orig,
            auditNote: 'watch_timeout_no_match',
          });
        } else {
          const snapPartial = loadTradeHistory().find((r) => r.id === rowId);
          const audPartial = String(snapPartial?.auditNote ?? '').toLowerCase();
          const bracketAudP = audPartial.includes('stop_loss') || audPartial.includes('take_profit');
          if (bracketAudP) {
            if (audPartial.includes('stop_loss')) stopLossLastFireTokRef.current = null;
            if (audPartial.includes('take_profit')) takeProfitLastFireTokRef.current = null;
            stopLossFireLockRef.current = false;
            takeProfitFireLockRef.current = false;
          }
          updateTradeHistoryRow(rowId, {
            status: 'partial',
            fillAvgPrice01: p.avgPrice01 ?? undefined,
            shares: matched,
            requestedShares: orig,
            remainingShares: remaining,
            price01: p.avgPrice01 != null && p.avgPrice01 > 0 ? p.avgPrice01 : undefined,
            usdCents:
              p.avgPrice01 != null && p.avgPrice01 > 0 ? Math.abs(Math.round(p.avgPrice01 * matched * 100)) : null,
            auditNote: 'watch_timeout_partial',
          });
        }
        setHistoryRows(loadTradeHistory());
      };
      window.setTimeout(tick, 160);
    },
    [
      afterLiveBuyRowReconcile,
      afterLiveSellRowReconcile,
      applyTapeConfirmedLiveFill,
      refreshAvgEntry,
      refreshLiveBalancesThrottled,
      refreshPositionAndMaxSell,
      scheduleTruthRefreshBurst,
      syncSellPositionAfterBurst,
      pushToast,
    ],
  );

  const applyPct = useCallback(
    (pct: number) => {
      if (positionShares == null || positionShares <= 0) return;
      const v = floorSharesWhole(positionShares * pct);
      setSellQty(v > 0 ? String(v) : '0');
    },
    [positionShares],
  );

  /** Quick mode tracks live bid/ask every book tick — never freeze on a typed ¢ from custom mode. */
  const quickLimit01 = useMemo(() => {
    if (execMode !== 'touch') return null;
    if (executableQuote01 != null && executableQuote01 > 0.01 && executableQuote01 < 0.99) {
      return roundPrice01(executableQuote01);
    }
    const tc = touchLimitCents.trim() !== '' ? Number(touchLimitCents) : NaN;
    if (Number.isFinite(tc) && tc > 0) return Math.min(0.99, Math.max(0.01, tc / 100));
    return null;
  }, [execMode, executableQuote01, touchLimitCents]);

  const quickLimitCentsDisplay = useMemo(() => {
    if (quickLimit01 == null) return touchLimitCents || defaultLimitCents || '';
    const c = quickLimit01 * 100;
    return Math.abs(c - Math.round(c)) < 0.05 ? String(Math.round(c)) : c.toFixed(1);
  }, [quickLimit01, touchLimitCents, defaultLimitCents]);

  const customLimit01 = useMemo(() => {
    const c = limitPriceCents.trim() !== '' ? Number(limitPriceCents) : NaN;
    if (!Number.isFinite(c) || c <= 0) {
      const d = defaultLimitCents.trim() !== '' ? Number(defaultLimitCents) : NaN;
      if (!Number.isFinite(d) || d <= 0) return null;
      return Math.min(0.99, Math.max(0.01, d / 100));
    }
    return Math.min(0.99, Math.max(0.01, c / 100));
  }, [limitPriceCents, defaultLimitCents]);

  const limit01 = execMode === 'touch' ? quickLimit01 : customLimit01;

  const mid01 = mid != null && Number.isFinite(mid) ? mid : null;

  const midIsExtremeLow = mid01 != null && mid01 <= 0.005;
  const midIsExtremeHigh = mid01 != null && mid01 >= 0.995;
  const outcomeLocked = midIsExtremeLow || midIsExtremeHigh;

  const amtNum = Number(amount);
  const amtOk = Number.isFinite(amtNum) && amtNum > 0;
  // Do not preview using 0¢ / 100¢ — it produces “infinite shares” and fake profit.
  // Estimate should reflect executable prices when in quick mode (mid can be misleading with spread).
  const previewPrice01 =
    execMode === 'touch' && action === 'buy' && executableQuote01 != null && executableQuote01 > 0.01 && executableQuote01 < 0.99
      ? executableQuote01
      : mid01 != null && mid01 > 0.01 && mid01 < 0.99
        ? mid01
        : null;

  const buySizingPrice01 = useMemo(
    () => resolveBuySizingPrice01({ limit01, previewPrice01, mid01 }),
    [limit01, mid01, previewPrice01],
  );
  const buySizingPrice01Ref = useRef<number | null>(null);
  buySizingPrice01Ref.current = buySizingPrice01;

  const estShares =
    previewPrice01 != null && amtOk ? (unit === 'dollars' ? amtNum / previewPrice01 : amtNum) : null;

  /** Buy limit for bracket $/% math when not filled yet (sell-tab limit is not entry). */
  const bracketPlannedEntry01 = useMemo(() => {
    if (action !== 'buy') return null;
    if (limit01 != null && Number.isFinite(limit01) && limit01 > 0 && limit01 < 1) return limit01;
    if (previewPrice01 != null && previewPrice01 > 0 && previewPrice01 < 1) return previewPrice01;
    return null;
  }, [action, limit01, previewPrice01]);

  /** Single entry anchor for buy-bundle ¢ / % / $ math — matches submit limit/ask, not chart mid alone. */
  const buyBracketSizingEntry01 = useMemo(() => {
    if (action !== 'buy') return null;
    return buySizingPrice01 ?? bracketPlannedEntry01 ?? previewPrice01;
  }, [action, bracketPlannedEntry01, buySizingPrice01, previewPrice01]);

  /** Entry + size for buy-bundle SL/TP — the order being placed, not prior avg entry or held shares. */
  const buyBundleShares = useMemo(() => {
    if (action !== 'buy' || !amtOk) return null;
    const entry = buyBracketSizingEntry01;
    if (entry == null || !(entry > 0)) return unit === 'shares' ? amtNum : null;
    if (unit === 'shares') return amtNum;
    const sh = amtNum / entry;
    return Number.isFinite(sh) && sh > 0 ? sh : null;
  }, [action, amtOk, amtNum, buyBracketSizingEntry01, unit]);

  const buyBundleNotionalUsd = useMemo(() => {
    if (action !== 'buy' || !amtOk) return null;
    if (unit === 'dollars') return amtNum;
    if (buyBundleShares != null && buyBracketSizingEntry01 != null && buyBracketSizingEntry01 > 0) {
      return buyBundleShares * buyBracketSizingEntry01;
    }
    return null;
  }, [action, amtOk, amtNum, buyBracketSizingEntry01, buyBundleShares, unit]);

  const buyBracketComposeKey = useMemo(() => {
    if (action !== 'buy') return '';
    return `${lane}|${unit}|${amount.trim()}|${limitPriceCents.trim()}|${execMode}`;
  }, [action, amount, execMode, lane, limitPriceCents, unit]);

  const pinnedBuyBracketSizing = useMemo(() => {
    if (action !== 'buy') {
      return {
        entry01: buyBracketSizingEntry01,
        shares: buyBundleShares,
        notional: buyBundleNotionalUsd,
      };
    }
    const key = buyBracketComposeKey;
    const pin = buyBracketSizingPinRef.current;
    if (!pin || pin.key !== key) {
      const next = {
        key,
        entry01: buyBracketSizingEntry01,
        shares: buyBundleShares,
        notional: buyBundleNotionalUsd,
      };
      buyBracketSizingPinRef.current = next;
      return next;
    }
    return pin;
  }, [action, buyBracketComposeKey, buyBracketSizingEntry01, buyBundleNotionalUsd, buyBundleShares]);

  const buyBundleEntry01Display = pinnedBuyBracketSizing.entry01;
  const buyBundleSharesDisplay = pinnedBuyBracketSizing.shares;
  const buyBundleNotionalDisplay = pinnedBuyBracketSizing.notional;
  /** Pin entry/size for bracket readouts — live quote chase updates placeholder only, not sizing props. */
  const buyBundleQuoteChaseActive =
    action === 'buy' && (emergencyStopBundlePrefs.autoFillSl || emergencyStopBundlePrefs.autoTpOnFill);
  const buyBundleBracketEntry01 = buyBundleEntry01Display;
  const buyBundleBracketShares = buyBundleSharesDisplay;
  const buyBundleBracketNotional = buyBundleNotionalDisplay;
  const buyBundleBracketRef01 = useMemo(
    () => resolveBracketRef({ avgEntry01: null, plannedEntry01: buyBundleBracketEntry01, mid01 }).ref01,
    [buyBundleBracketEntry01, mid01],
  );

  /** Live SL/TP hints for the visible UP/DOWN lane — tracks quote/limit as the book moves. */
  const liveSuggestedLevels = useMemo(() => {
    const entry01 =
      action === 'buy'
        ? bracketPlannedEntry01 ??
          executableQuote01 ??
          (mid01 != null && mid01 > 0 && mid01 < 1 ? mid01 : null)
        : avgEntry ??
          executableQuote01 ??
          (mid01 != null && mid01 > 0 && mid01 < 1 ? mid01 : null);
    if (entry01 == null || !(entry01 > 0) || entry01 >= 1) return null;
    const laneTouch = lane === 'up' ? (bookTouchUp ?? null) : (bookTouchDown ?? null);
    const { stopCents, tpCents } = spreadBracketFromFillPrice01(entry01, laneTouch);
    return {
      stopCents,
      tpCents,
      entryCents: (entry01 * 100).toFixed(1),
    };
  }, [
    action,
    avgEntry,
    bookTouchDown,
    bookTouchUp,
    bracketPlannedEntry01,
    executableQuote01,
    lane,
    mid01,
  ]);

  const suggestedSlDisplay =
    liveSuggestedLevels?.stopCents ?? riskTargetsFromEntry?.stopCents ?? targets?.stopCents ?? '';
  const suggestedTpDisplay =
    liveSuggestedLevels?.tpCents ?? riskTargetsFromEntry?.tpCents ?? targets?.tpCents ?? '';

  /** Targets (assist) card — TP/SL from spread bracket on the executable quote (Set TP on fill + auto TP use these). */
  const quoteAssistTpCents = targets?.tpCents?.trim() ?? '';
  const quoteAssistSlCents = targets?.stopCents?.trim() ?? '';
  const bundleSuggestedTpCents = quoteAssistTpCents || suggestedTpDisplay;
  const bundleSuggestedSlCents = quoteAssistSlCents || suggestedSlDisplay;

  const autoBundleChaseLevels = useMemo(() => {
    if (action !== 'buy') return { tpCents: '', slCents: '', source: 'spread' as const };
    const laneTouch = lane === 'up' ? (bookTouchUp ?? null) : (bookTouchDown ?? null);
    const entry01 =
      (buyBundleQuoteChaseActive ? executableQuote01 : null) ??
      bracketPlannedEntry01 ??
      executableQuote01 ??
      (mid01 != null && mid01 > 0 && mid01 < 1 ? mid01 : null);
    return resolveAutoBundleChaseLevels({
      lane,
      useSignalLevels: armRiskAfterBuy.useSignalLevels,
      signal: signalRiskSnapshot,
      quoteAssist: targets,
      entry01,
      bookTouch: laneTouch,
    });
  }, [
    action,
    armRiskAfterBuy.useSignalLevels,
    bookTouchDown,
    bookTouchUp,
    bracketPlannedEntry01,
    buyBundleQuoteChaseActive,
    executableQuote01,
    lane,
    mid01,
    signalRiskSnapshot,
    targets,
  ]);

  const autoBundleChaseTpCents = autoBundleChaseLevels.tpCents.trim();
  const autoBundleChaseSlCents = autoBundleChaseLevels.slCents.trim();

  const buyBundleSuggestTp =
    action === 'buy' && autoBundleChaseTpCents ? autoBundleChaseTpCents : suggestedTpDisplay;
  const buyBundleSuggestSl =
    action === 'buy' && autoBundleChaseSlCents ? autoBundleChaseSlCents : suggestedSlDisplay;

  const applyBuyBundleSlCents = useCallback(
    (v: string, opts?: { auto?: boolean }) => {
      const trimmed = v.trim();
      const curSl = buyBundleByLaneRef.current[lane].sl;
      if (curSl === v) {
        if (opts?.auto === true) {
          buyBundleSlManualLanesRef.current = { ...buyBundleSlManualLanesRef.current, [lane]: false };
        } else if (trimmed) {
          buyBundleSlManualLanesRef.current = { ...buyBundleSlManualLanesRef.current, [lane]: true };
          autoBundleSlLaneRef.current = { lane, cents: trimmed };
        }
        return;
      }
      buyBundleByLaneRef.current = {
        ...buyBundleByLaneRef.current,
        [lane]: { ...buyBundleByLaneRef.current[lane], sl: v },
      };
      bracketLaneDraftRef.current[lane] = { ...bracketLaneDraftRef.current[lane], sl: v };
      setBuyBundleByLane((prev) => ({ ...prev, [lane]: { ...prev[lane], sl: v } }));
      if (opts?.auto === true) {
        buyBundleSlManualLanesRef.current = { ...buyBundleSlManualLanesRef.current, [lane]: false };
      } else {
        buyBundleSlManualLanesRef.current = { ...buyBundleSlManualLanesRef.current, [lane]: Boolean(trimmed) };
        saveEmergencyStopForLane(lane, trimmed);
        if (trimmed) autoBundleSlLaneRef.current = { lane, cents: trimmed };
      }
    },
    [lane],
  );

  const applyBuyBundleTpCents = useCallback(
    (v: string, opts?: { auto?: boolean }) => {
      const trimmed = v.trim();
      const curTp = buyBundleByLaneRef.current[lane].tp;
      if (curTp === v) {
        if (opts?.auto === true) {
          buyBundleTpManualLanesRef.current = { ...buyBundleTpManualLanesRef.current, [lane]: false };
        } else if (trimmed) {
          buyBundleTpManualLanesRef.current = { ...buyBundleTpManualLanesRef.current, [lane]: true };
          autoBundleTpLaneRef.current = { lane, cents: trimmed };
        }
        return;
      }
      buyBundleByLaneRef.current = {
        ...buyBundleByLaneRef.current,
        [lane]: { ...buyBundleByLaneRef.current[lane], tp: v },
      };
      bracketLaneDraftRef.current[lane] = { ...bracketLaneDraftRef.current[lane], tp: v };
      setBuyBundleByLane((prev) => ({ ...prev, [lane]: { ...prev[lane], tp: v } }));
      if (opts?.auto === true) {
        buyBundleTpManualLanesRef.current = { ...buyBundleTpManualLanesRef.current, [lane]: false };
      } else {
        buyBundleTpManualLanesRef.current = { ...buyBundleTpManualLanesRef.current, [lane]: Boolean(trimmed) };
        if (trimmed) autoBundleTpLaneRef.current = { lane, cents: trimmed };
      }
    },
    [lane],
  );

  const flushBuyBundleDraftsForLane = useCallback(() => {
    const bundle = buyBundleByLaneRef.current[lane];
    const slState = buyBundleSlDraftRef.current[lane];
    const slFlush = flushPendingBracketDraft({
      draft: slState.draft,
      mode: slState.mode,
      committed: bundle.sl,
      kind: 'sl',
      ref01: buyBundleBracketRef01,
      shares: buyBundleBracketShares,
    });
    if (slFlush) applyBuyBundleSlCents(slFlush);
    const tpState = buyBundleTpDraftRef.current[lane];
    const tpFlush = flushPendingBracketDraft({
      draft: tpState.draft,
      mode: tpState.mode,
      committed: bundle.tp,
      kind: 'tp',
      ref01: buyBundleBracketRef01,
      shares: buyBundleBracketShares,
    });
    if (tpFlush) applyBuyBundleTpCents(tpFlush);
  }, [
    applyBuyBundleSlCents,
    applyBuyBundleTpCents,
    buyBundleBracketRef01,
    buyBundleBracketShares,
    lane,
  ]);

  /** Same ¢ as Targets assist “Set TP on fill” — `locked` freezes the level; auto mode keeps syncing assist until you edit. */
  const applyTargetsAssistTpOnFill = useCallback(
    (opts?: { locked?: boolean }) => {
      const tp = quoteAssistTpCents;
      if (!tp) return;
      buyBundleChaseFrozenRef.current = Boolean(opts?.locked);
      buyBundleTpDraftRef.current = { ...buyBundleTpDraftRef.current, [lane]: { draft: tp, mode: 'cents' } };
      if (opts?.locked) {
        applyBuyBundleTpCents(tp);
      } else {
        applyBuyBundleTpCents(tp, { auto: true });
      }
    },
    [applyBuyBundleTpCents, lane, quoteAssistTpCents],
  );

  /** Live chase: Targets assist quote TP → Auto TP on fill until operator edits or locks. */
  useEffect(() => {
    if (action !== 'buy' || !emergencyStopBundlePrefs.autoTpOnFill) return;
    const tp = quoteAssistTpCents;
    if (!tp) return;
    const cur = buyBundleByLaneRef.current[lane].tp;
    if (
      !shouldChaseAutoBundleLevel({
        manualLane: buyBundleTpManualLanesRef.current[lane],
        deskLocked: buyBundleChaseFrozenRef.current,
        quoteCents: tp,
        curCents: cur,
      })
    ) {
      return;
    }
    applyBuyBundleTpCents(tp, { auto: true });
    autoBundleTpLaneRef.current = { lane, cents: tp };
    buyBundleTpDraftRef.current = { ...buyBundleTpDraftRef.current, [lane]: EMPTY_BRACKET_INPUT_DRAFT };
  }, [action, applyBuyBundleTpCents, emergencyStopBundlePrefs.autoTpOnFill, lane, quoteAssistTpCents]);

  const globalSlCentsForBuy = useMemo(
    () => resolveGlobalStopForEntry(limit01, loadNowPriceDeskScalpPrefs()),
    [limit01],
  );

  const resolvedEmergencyBundle = useMemo(() => {
    const staged = resolveStagedBuyBundleLevels(lane, buyBundleByLane, {
      prefs: emergencyStopBundlePrefs,
      suggestedSl: emergencyStopBundlePrefs.autoFillSl ? bundleSuggestedSlCents : buyBundleSuggestSl,
      suggestedTp: emergencyStopBundlePrefs.autoTpOnFill ? bundleSuggestedTpCents : buyBundleSuggestTp,
      manualSl: buyBundleSlManualLanesRef.current[lane],
      manualTp: buyBundleTpManualLanesRef.current[lane],
      globalSlCents: globalSlCentsForBuy,
    });
    if (action === 'buy') return staged;
    if (takeProfitEnabled && takeProfitTakeCents.trim()) {
      return {
        sl: stopLossStopCents.trim() || staged.sl,
        tp: takeProfitTakeCents.trim() || staged.tp,
      };
    }
    if (stopLossEnabled && stopLossStopCents.trim()) {
      return { sl: stopLossStopCents.trim(), tp: staged.tp };
    }
    return staged;
  }, [
    action,
    buyBundleByLane,
    buyBundleSuggestSl,
    buyBundleSuggestTp,
    bundleSuggestedSlCents,
    bundleSuggestedTpCents,
    emergencyStopBundlePrefs,
    globalSlCentsForBuy,
    lane,
    stopLossEnabled,
    stopLossStopCents,
    takeProfitEnabled,
    takeProfitTakeCents,
  ]);

  const emergencyStopStaged = Boolean(resolvedEmergencyBundle.sl);
  const buyBundleStaged = emergencyStopStaged || Boolean(resolvedEmergencyBundle.tp);

  const stageBuyBundleForSubmit = useCallback(
    (
      submitLane: 'up' | 'down',
      submitToken: string,
      estSizeShares: number | null,
    ): { ok: true; armed: boolean } | { ok: false; reason: string } => {
      const { sl, tp } = resolveStagedBuyBundleLevels(submitLane, buyBundleByLaneRef.current, {
        prefs: emergencyStopBundlePrefs,
        suggestedSl: emergencyStopBundlePrefs.autoFillSl ? bundleSuggestedSlCents : buyBundleSuggestSl,
        suggestedTp: emergencyStopBundlePrefs.autoTpOnFill ? bundleSuggestedTpCents : buyBundleSuggestTp,
        manualSl: buyBundleSlManualLanesRef.current[submitLane],
        manualTp: buyBundleTpManualLanesRef.current[submitLane],
        globalSlCents: globalSlCentsForBuy,
      });
      if (!sl && !tp) {
        buyBundleArmRef.current = null;
        return { ok: true, armed: false };
      }
      if (sl && tp && parseFloat(tp) <= parseFloat(sl)) {
        return { ok: false, reason: 'TP must be above SL for a long exit.' };
      }
      const entryC = limit01 != null && Number.isFinite(limit01) ? limit01 * 100 : null;
      if (entryC != null) {
        if (sl && parseFloat(sl) >= entryC) {
          return { ok: false, reason: 'SL should be below your buy limit.' };
        }
        if (tp && parseFloat(tp) <= entryC) {
          return { ok: false, reason: 'TP should be above your buy limit.' };
        }
      }
      const tok = submitToken.trim();
      buyBundleArmRef.current = { sl, tp, lane: submitLane, token: tok };
      if (sl || tp) {
        pendingBuyBundleIntentRef.current = { lane: submitLane, token: tok, sl, tp };
      } else {
        pendingBuyBundleIntentRef.current = null;
      }
      buyBundleChaseFrozenRef.current = true;
      deskBuyLaneRef.current = submitLane;
      bracketOutcomeLaneRef.current = submitLane;
      bracketOutcomeTokenRef.current = tok;
      if (estSizeShares != null && estSizeShares > 0) {
        const shStr = String(floorShares4(estSizeShares));
        if (sl) setStopLossShares(shStr);
        if (tp) setTakeProfitShares(shStr);
      }
      if (sl) {
        operatorSlTpLockedRef.current = true;
        setStopLossStopCents(sl);
        setStopLossLimitCents(sl);
        setStopLossEnabled(true);
        setStopLossStatus('ARMED');
      }
      if (tp) {
        operatorSlTpLockedRef.current = true;
        syncDeskTakeProfitArm(
          tp,
          estSizeShares != null && Number.isFinite(estSizeShares) ? estSizeShares : null,
          tok,
        );
      }
      bracketArmedPinRef.current = {
        token: tok,
        lane: submitLane,
        stopCents: sl,
        tpCents: tp,
        source: 'desk',
        armedAtMs: Date.now(),
      };
      setBracketPollToken(tok);
      return { ok: true, armed: true };
    },
    [
      buyBundleSuggestSl,
      buyBundleSuggestTp,
      bundleSuggestedSlCents,
      bundleSuggestedTpCents,
      emergencyStopBundlePrefs,
      limit01,
      syncDeskTakeProfitArm,
    ],
  );

  /** Held shares or estimated buy size — powers total-$ TP/SL (e.g. $50 profit on $1000). */
  const bracketOrderShares = useMemo(() => {
    if (action === 'buy' && buyBundleShares != null && buyBundleShares > 0) return buyBundleShares;
    if (positionShares != null && positionShares > 0) return positionShares;
    if (liveSellableShares != null && liveSellableShares > 0) return liveSellableShares;
    if (action === 'buy' && amtOk && buyBracketSizingEntry01 != null && buyBracketSizingEntry01 > 0) {
      const sh = unit === 'dollars' ? amtNum / buyBracketSizingEntry01 : amtNum;
      return Number.isFinite(sh) && sh > 0 ? sh : null;
    }
    return null;
  }, [
    action,
    amtOk,
    amtNum,
    buyBracketSizingEntry01,
    buyBundleShares,
    liveSellableShares,
    positionShares,
    unit,
  ]);

  const estCost =
    previewPrice01 != null && estShares != null
      ? unit === 'dollars'
        ? amtNum
        : estShares * previewPrice01
      : unit === 'dollars' && amtOk
        ? amtNum
        : null;
  const buyAmountRef = useRef(amount);
  buyAmountRef.current = amount;

  const clampBuyAmountIfNeeded = useCallback(() => {
    if (action !== 'buy') return;
    const cash = availableBuyUsd;
    if (cash == null || !(cash > 0)) return;
    const raw = buyAmountRef.current.trim();
    if (!raw) return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return;
    if (!buyAmountExceedsCash({ amtNum: n, unit, cashUsd: cash, price01: buySizingPrice01 })) return;
    const next = clampBuyAmountWithinCash({ amountStr: raw, unit, cashUsd: cash, price01: buySizingPrice01 });
    if (next !== raw) setAmount(next);
  }, [action, availableBuyUsd, buySizingPrice01, unit]);

  useEffect(() => {
    if (action !== 'buy') return;
    const raw = amount.trim();
    if (!raw) return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return;
    const cash = availableBuyUsd;
    if (cash == null || !(cash > 0)) return;
    if (!buyAmountExceedsCash({ amtNum: n, unit, cashUsd: cash, price01: buySizingPrice01 })) return;
    clampBuyAmountIfNeeded();
  }, [amount, action, availableBuyUsd, buySizingPrice01, unit, clampBuyAmountIfNeeded]);

  const buyMaxAffordableHint = useMemo(() => {
    const cash = availableBuyUsd;
    if (cash == null || !(cash > 0)) return null;
    const px = buySizingPrice01;
    if (unit === 'dollars') return `Max $${floorUsdWhole(cash)}`;
    if (px == null || !(px > 0)) return null;
    const sh = floorSharesWhole(cash / px);
    return sh > 0 ? `Max ${sh} sh @ ${fmtCents(px)}` : null;
  }, [availableBuyUsd, buySizingPrice01, unit]);

  const canSizeBuy =
    !busySubmit &&
    !outcomeLocked &&
    (availableBuyUsd ?? 0) > 0 &&
    (unit === 'dollars' || (mid != null && mid > 0));
  const preventSizeBtnScroll = (e: MouseEvent) => e.preventDefault();
  const applyBuyCashPct = useCallback(
    (pct: number) => {
      setErr(null);
      const cash = availableBuyUsd ?? 0;
      if (cash <= 0) {
        setErr('No cash available.');
        return;
      }
      const price = buySizingPrice01;
      if (unit === 'shares' && (price == null || price <= 0)) {
        setErr('Need a valid price to size in shares.');
        return;
      }
      setAmount(buyAmountFromCashPct({ pct, unit, cashUsd: cash, price01: price }));
    },
    [availableBuyUsd, buySizingPrice01, unit],
  );
  const applyBuyUsdPreset = useCallback(
    (usd: number) => {
      setErr(null);
      const cash = availableBuyUsd ?? 0;
      if (cash <= 0) {
        setErr('No cash available.');
        return;
      }
      if (unit !== 'dollars') setUnit('dollars');
      setAmount(clampBuyUsdPreset(usd, cash));
    },
    [availableBuyUsd, unit],
  );
  const payout = estShares != null ? estShares : null;
  const profit = estCost != null && payout != null ? payout - estCost : null;

  const sellQtyNum = Number(sellQty);
  const sellQtyOk = Number.isFinite(sellQtyNum) && sellQtyNum > 0;
  const maxSellShares = accountMode === 'paper' ? positionShares : liveSellableShares;
  const sellSharesClamped = useMemo(() => {
    if (!sellQtyOk) return null;
    if (maxSellShares != null && maxSellShares > 0) return Math.min(sellQtyNum, maxSellShares);
    if (balLoading) return null;
    return sellQtyNum;
  }, [sellQtyOk, sellQtyNum, maxSellShares, balLoading]);
  const sellEstValue = mid != null && sellSharesClamped != null ? sellSharesClamped * mid : null;

  const executeIntentSummary = useMemo(() => {
    if (action === 'buy') {
      if (outcomeLocked || !amtOk || limit01 == null || !Number.isFinite(limit01) || !buyGate.ok) return null;
      const c = (limit01 * 100).toFixed(1);
      const mode = accountMode === 'paper' ? 'Paper' : 'Live';
      const exec = execMode === 'touch' ? 'Quick limit buy' : 'Custom limit buy';
      const bracketParts: string[] = [];
      const slNote = buyBundleSlCents.trim();
      const tpNote = buyBundleTpCents.trim();
      if (slNote) bracketParts.push(`Emergency stop ${slNote}¢`);
      if (tpNote) bracketParts.push(`TP ${tpNote}¢`);
      const bracketNote = bracketParts.length ? ` · ${bracketParts.join(' · ')} on fill` : '';
      if (unit === 'shares' && estShares != null) {
        return `${mode} · ${exec} · ${c}¢ · ~${estShares.toFixed(2)} sh · ${label}${bracketNote}`;
      }
      if (unit === 'dollars' && amtOk) {
        return `${mode} · ${exec} · ${c}¢ · $${amtNum.toFixed(2)} notional · ${label}${bracketNote}`;
      }
      return null;
    }
    if (action === 'sell') {
      if (sellSharesClamped == null || sellSharesClamped <= 0 || limit01 == null || !Number.isFinite(limit01)) return null;
      if (execMode === 'touch' && executableQuote01 == null && (mid == null || !(mid > 0))) return null;
      const c = (limit01 * 100).toFixed(1);
      const mode = accountMode === 'paper' ? 'Paper' : 'Live';
      const exec = execMode === 'touch' ? 'Quick limit sell' : 'Custom limit sell';
      return `${mode} · GTC ${exec.toLowerCase()} · ${c}¢ · ${sellSharesClamped.toFixed(2)} sh · ${label}`;
    }
    return null;
  }, [
    accountMode,
    action,
    amtNum,
    amtOk,
    buyBundleSlCents,
    buyBundleTpCents,
    buyGate.ok,
    estShares,
    execMode,
    executableQuote01,
    label,
    limit01,
    mid,
    outcomeLocked,
    sellSharesClamped,
    unit,
  ]);

  /** Retry desk auto-buy while prefill / gates catch up — stops after one Buy click. */
  useEffect(() => {
    if (!pendingAutoBuy?.fromSignalsDesk) return;
    if (deskAutoBuyClickedNonceRef.current === pendingAutoBuy.buyNonce) return;
    const id = window.setInterval(() => setAutoBuyRetryTick((t) => t + 1), 400);
    return () => window.clearInterval(id);
  }, [pendingAutoBuy]);

  /** Auto-trade from Signals — exactly one Buy per desk request (N shares from the box, not N orders). */
  useEffect(() => {
    if (!pendingAutoBuy) return;
    if (lane !== pendingAutoBuy.lane) {
      deskBuyLaneRef.current = pendingAutoBuy.lane;
      flushSync(() => {
        if (controlledLane == null) setLaneState(pendingAutoBuy.lane);
      });
      onLaneChange?.(pendingAutoBuy.lane);
      if (!pendingAutoBuy.fromSignalsDesk) return;
    }
    if (action !== 'buy') return;

    const deskAuto = pendingAutoBuy.fromSignalsDesk === true;
    const nonce = pendingAutoBuy.buyNonce;
    if (deskAuto && deskAutoBuyClickedNonceRef.current === nonce) return;

    const ageMs = Date.now() - pendingAutoBuy.at;
    if (ageMs > 45_000) {
      setPendingAutoBuy(null);
      pushToast('err', 'Auto-buy timed out — use Buy on the trade panel or Take signal again.');
      return;
    }

    if (busySubmit) return;
    if (outcomeLocked) return;
    if (!deskAuto && !buyGate.ok) return;
    if (limit01 == null || !Number.isFinite(limit01)) return;

    const wantSh = pendingAutoBuy.sizeShares;
    if (wantSh != null && wantSh > 0) {
      const held =
        lane === 'up'
          ? accountMode === 'paper'
            ? paperUpPos.shares
            : balUp
          : accountMode === 'paper'
            ? paperDownPos.shares
            : balDown;
      if (held != null && Number.isFinite(held) && held >= wantSh - 1e-4) {
        deskAutoBuyClickedNonceRef.current = nonce;
        setPendingAutoBuy(null);
        return;
      }
      forcedAutoBuySharesRef.current = wantSh;
      if (unit !== 'shares' || Math.abs(amtNum - wantSh) > 1e-6) {
        flushSync(() => {
          setUnit('shares');
          setAmount(String(wantSh));
        });
        return;
      }
    }

    const sizeOk = wantSh != null && wantSh > 0 ? true : amtOk;
    if (!sizeOk) return;

    if (deskAuto) deskAutoBuyClickedNonceRef.current = nonce;
    deskBuyLaneRef.current = pendingAutoBuy.lane;
    setPendingAutoBuy(null);
    if (submitLockRef.current) return;
    buyButtonRef.current?.click();
  }, [
    pendingAutoBuy,
    lane,
    controlledLane,
    onLaneChange,
    action,
    busySubmit,
    outcomeLocked,
    amtOk,
    amtNum,
    unit,
    limit01,
    buyGate.ok,
    autoBuyRetryTick,
    pushToast,
    accountMode,
    paperUpPos.shares,
    paperDownPos.shares,
    balUp,
    balDown,
  ]);

  const buySubmitDisabled =
    busySubmit ||
    outcomeLocked ||
    !amtOk ||
    limit01 == null ||
    !Number.isFinite(limit01) ||
    !buyGate.ok;

  const buyButtonLabelText = `Buy ${label}`;

  const triggerBuySubmit = useCallback(() => {
    buyButtonRef.current?.click();
  }, []);

  const buyCtaBusyLabel = isSlide ? 'SENDING…' : 'Submitting…';

  const buyCtaButtonClass = (variant: 'primary' | 'compact' | 'header') => {
    if (variant === 'header') {
      return `max-w-[9.5rem] truncate rounded-lg px-3 py-2 text-[12px] font-black disabled:cursor-not-allowed disabled:opacity-40 ${
        buySubmitDisabled && !busySubmit
          ? 'border border-zinc-700/60 bg-zinc-900/40 text-zinc-500'
          : 'bg-emerald-400 text-black hover:bg-emerald-300'
      } ${busySubmit ? 'inline-flex min-h-[40px] items-center justify-center gap-1.5' : 'min-h-[40px]'}`;
    }
    if (variant === 'compact') {
      return `w-full rounded-xl px-4 py-2.5 text-[13px] font-black text-black disabled:cursor-not-allowed disabled:opacity-40 ${
        isSlide
          ? 'min-h-[44px] bg-emerald-400/70 hover:bg-emerald-300/80'
          : 'min-h-[46px] bg-emerald-400/90 shadow-md shadow-emerald-950/20 hover:bg-emerald-300'
      } ${isSlide ? 'inline-flex items-center justify-center gap-2' : ''}`;
    }
    return `w-full rounded-xl px-4 py-3 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-40 ${
      isSlide
        ? 'min-h-[48px] bg-emerald-400/70 shadow-none hover:bg-emerald-300/80'
        : 'min-h-[52px] bg-emerald-400 shadow-lg shadow-emerald-950/30 hover:bg-emerald-300'
    } ${isSlide ? 'inline-flex items-center justify-center gap-2' : ''}`;
  };

  const renderBuyCtaContent = (variant: 'primary' | 'compact' | 'header' = 'primary') =>
    busySubmit ? (
      <>
        {isSlide || variant === 'header' ? (
          <span className="size-3.5 shrink-0 animate-spin rounded-full border-2 border-black/25 border-t-black" aria-hidden />
        ) : null}
        {buyCtaBusyLabel}
      </>
    ) : (
      <span className="inline-flex items-center justify-center gap-1.5">
        {buyButtonLabelText}
        {buyBundleStaged ? (
          <span className="rounded bg-black/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">
            SL/TP
          </span>
        ) : null}
      </span>
    );

  const renderSecondaryBuyCta = (variant: 'compact' | 'header' = 'compact') => (
    <button
      type="button"
      disabled={buySubmitDisabled}
      aria-busy={busySubmit}
      title={buyGate.ok ? buyButtonLabelText : (buyGate.reason ?? 'Buy unavailable')}
      className={buyCtaButtonClass(variant)}
      onClick={triggerBuySubmit}
    >
      {renderBuyCtaContent(variant)}
    </button>
  );

  const maxSellStr = useMemo(() => {
    const instant = resolveInstantMaxSellShares(lane);
    const whole = instant > 0 ? floorSharesWhole(instant) : 0;
    if (whole > 0) return String(whole);
    if (positionShares != null && positionShares > 0) return String(floorSharesWhole(positionShares));
    return accountMode === 'live' && balLoading ? '…' : '—';
  }, [accountMode, balLoading, lane, positionShares, resolveInstantMaxSellShares]);

  const positionBracketCallTrade = useMemo(() => {
    if (positionShares == null || !(positionShares > 0)) return null;
    const entry01 = avgEntry;
    const touch = lane === 'up' ? bookTouchUp : bookTouchDown;
    const bid01 = touch?.bestBid ?? null;
    const armedTp01 = takeProfitTakeCents.trim() ? centsStrTo01(takeProfitTakeCents) : targets?.tp01 ?? null;
    const armedSl01 = stopLossStopCents.trim() ? centsStrTo01(stopLossStopCents) : targets?.stop01 ?? null;
    const liveDeskTp01 = liveDeskTp01FromBook(touch ?? {}, mid);
    return computePositionBracketCall({
      entry01,
      armedTp01,
      armedSl01,
      liveDeskTp01,
      bid01,
    });
  }, [
    positionShares,
    avgEntry,
    lane,
    bookTouchUp,
    bookTouchDown,
    takeProfitTakeCents,
    stopLossStopCents,
    targets?.tp01,
    targets?.stop01,
    mid,
  ]);

  const holdingShares = positionShares != null && positionShares > 0;
  const deskMomentumTrade = useDeskMomentumTracker({
    focusLane: holdingShares ? lane : null,
    focusMid01: holdingShares ? mid : null,
    liveDeskTp01: holdingShares
      ? liveDeskTp01FromBook(lane === 'up' ? bookTouchUp ?? {} : bookTouchDown ?? {}, mid)
      : null,
    upMid01: holdingShares ? midUpEff : null,
    downMid01: holdingShares ? midDownEff : null,
    upLabel,
    downLabel,
    resetKey: marketSlug?.trim() ?? token?.trim() ?? null,
  });

  const heldTpOutlookRaw = useMemo(() => {
    if (!holdingShares) return null;
    const tp01 =
      (takeProfitTakeCents.trim() ? centsStrTo01(takeProfitTakeCents) : null) ??
      targets?.tp01 ??
      riskTargetsFromEntry?.tp01 ??
      null;
    if (tp01 == null) return null;
    const probSeries = lane === 'up' ? (probMomentumUp ?? []) : (probMomentumDown ?? []);
    return computeHeldLaneTpOutlook({
      heldLane: lane,
      currentMid01: mid,
      entry01: avgEntry,
      tp01,
      probSeries,
      crossProb,
      endsInMs,
      bestAsk: bookTouch?.bestAsk ?? null,
      bestBid: bookTouch?.bestBid ?? null,
    });
  }, [
    holdingShares,
    takeProfitTakeCents,
    targets?.tp01,
    riskTargetsFromEntry?.tp01,
    lane,
    probMomentumUp,
    probMomentumDown,
    mid,
    avgEntry,
    crossProb,
    endsInMs,
    bookTouch?.bestAsk,
    bookTouch?.bestBid,
  ]);

  const heldTpOutlook = useMemo(
    () => (heldTpOutlookRaw ? adjustTpOutlookWithMomentum(heldTpOutlookRaw, deskMomentumTrade) : null),
    [heldTpOutlookRaw, deskMomentumTrade],
  );

  const deskSignalTrade = useMemo(
    () =>
      buildPositionDeskSignal({
        bracket: positionBracketCallTrade,
        momentum: deskMomentumTrade,
        tpHitProb01: heldTpOutlook?.tpHitProb01 ?? null,
      }),
    [positionBracketCallTrade, deskMomentumTrade, heldTpOutlook?.tpHitProb01],
  );

  const preBuyTpOutlook = useMemo(() => {
    if (action !== 'buy') return null;
    const tpCents = resolvedEmergencyBundle.tp;
    if (!tpCents?.trim()) return null;
    const entry01 =
      buyBundleBracketEntry01 ??
      bracketPlannedEntry01 ??
      (mid != null && mid > 0 && mid < 1 ? mid : null);
    const probSeries = lane === 'up' ? (probMomentumUp ?? []) : (probMomentumDown ?? []);
    return computePreBuyTpOutlook({
      entry01,
      tpCents,
      current01: mid,
      probSeries,
      crossProb,
      endsInMs,
    });
  }, [
    action,
    resolvedEmergencyBundle.tp,
    buyBundleBracketEntry01,
    bracketPlannedEntry01,
    mid,
    lane,
    probMomentumUp,
    probMomentumDown,
    crossProb,
    endsInMs,
  ]);

  const [quickSellMode, setQuickSellMode] = useState<'market' | 'touch_limit'>('market');

  const [pinnedLiveStatusId, setPinnedLiveStatusId] = useState<string | null>(null);
  const [pinnedLiveStatusDismissed, setPinnedLiveStatusDismissed] = useState(false);

  const activeLiveOrderRow = useMemo(() => {
    if (accountMode !== 'live') return null;
    const tok = token?.trim();
    if (!tok) return null;
    const now = Date.now();
    const SHOW_FILLED_MS = 12_000;
    for (const r of historyRows) {
      if (r.mode !== 'live') continue;
      if (r.token?.trim() !== tok) continue;
      if (liveRowCancelable(r)) return r;
      if ((r.status === 'partial' || r.status === 'filled') && !rowShowsExchangeFill(r)) return r;
      if (r.status === 'filled' && rowShowsExchangeFill(r) && now - (r.ts ?? 0) <= SHOW_FILLED_MS) return r;
    }
    return null;
  }, [accountMode, historyRows, token]);

  useEffect(() => {
    if (accountMode !== 'live') return;
    const tok = token?.trim();
    if (!tok) return;
    // Pin the most recent (by timestamp) live row for this token.
    let latest: (typeof historyRows)[number] | null = null;
    for (const r of historyRows) {
      if (r.mode !== 'live') continue;
      if (r.token?.trim() !== tok) continue;
      if (!latest || (r.ts ?? 0) > (latest.ts ?? 0)) latest = r;
    }
    if (!latest) return;
    // Pin the latest row so the user can see what happened immediately after click.
    // Clear "dismissed" when a new trade occurs.
    if (latest.id !== pinnedLiveStatusId) {
      setPinnedLiveStatusId(latest.id);
      setPinnedLiveStatusDismissed(false);
    }
  }, [accountMode, historyRows, token, pinnedLiveStatusId]);

  const pinnedLiveStatusRow = useMemo(() => {
    if (pinnedLiveStatusDismissed) return null;
    if (accountMode !== 'live') return null;
    const tok = token?.trim();
    if (!tok || !pinnedLiveStatusId) return null;
    const r = historyRows.find((x) => x.id === pinnedLiveStatusId) ?? null;
    if (!r) return null;
    if (r.mode !== 'live') return null;
    if (r.token?.trim() !== tok) return null;
    return r;
  }, [accountMode, historyRows, pinnedLiveStatusDismissed, pinnedLiveStatusId, token]);

  const liveStatusRow = activeLiveOrderRow ?? pinnedLiveStatusRow;

  const maxBuyDisabledReason =
    unit === 'shares' && (mid == null || mid <= 0)
      ? 'Need a valid mid to convert USDC to shares for Max'
      : undefined;

  const passiveLadder = useMemo(() => {
    const targetC = Number(passiveTargetCents);
    const totalSh = Number(passiveTotalShares);
    const chunks = Math.round(Number(passiveChunks));
    if (!Number.isFinite(targetC) || targetC <= 0 || targetC >= 100) return null;
    if (!Number.isFinite(totalSh) || totalSh <= 0) return null;
    if (!Number.isFinite(chunks) || chunks < 2) return null;
    const parsedLevels = passiveLevels
      .split(',')
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isFinite(n) && n > 0 && n < 100)
      .map((n) => Math.max(1, Math.min(99, Math.round(n))));
    const uniqLevels = [...new Set(parsedLevels)].slice(0, 6);
    if (uniqLevels.length < 1) return null;
    const per = totalSh / chunks;
    if (!(per > 0)) return null;
    const pricesC = uniqLevels;
    const plan: { price01: number; priceCents: number; shares: number }[] = [];
    for (let i = 0; i < chunks; i++) {
      const lvl = i % pricesC.length;
      const pc = pricesC[lvl]!;
      plan.push({ price01: clamp01(pc / 100), priceCents: pc, shares: per });
    }
    return {
      targetCents: targetC,
      totalShares: totalSh,
      chunks,
      levels: pricesC.length,
      levelsCents: pricesC,
      perChunkShares: per,
      plan,
    };
  }, [passiveChunks, passiveLevels, passiveTargetCents, passiveTotalShares]);

  /** Quick max / widget sells: resting limit at best bid (or mid), not a market order. */
  const runMarketSell = async (shares: number) => {
    if (!Number.isFinite(shares) || shares <= 0) return;
    if (!token?.trim()) {
      setErr('Outcome token is not ready yet — wait for this market to finish loading, then retry.');
      return;
    }
    const pxAgg = executableQuote01 ?? (mid != null && mid > 0 ? roundPrice01(mid) : null);
    if (pxAgg == null || !Number.isFinite(pxAgg) || pxAgg <= 0 || pxAgg >= 1) {
      setErr('Need a book bid or mid to price this quick limit sell.');
      return;
    }
    if (accountMode === 'paper') {
      const res = paperTrade({ account: paperAccount, tokenId: token, side: 'sell', shares, price01: pxAgg });
      if (!res.ok) {
        setErr(res.error);
      } else {
        setPaperAccount(res.account);
        setOkMsg(`Paper sold ${shares.toFixed(2)} shares of ${label}`);
        setHistoryRows(
          appendTradeHistory({ ...tradeHistoryMarketMeta,
            mode: 'paper',
            exec: 'touch',
            side: 'sell',
            token,
            label,
            price01: res.fill.price01,
            shares: res.fill.shares,
            usdCents: Math.abs(res.fill.usdCents),
            status: 'filled',
          }),
        );
        setSellQty('');
        syncRiskAutomationAfterSellFill(getPaperPosition(res.account, token).shares);
      }
      return;
    }
    const sellAmt = floorShares4(shares);
    if (sellAmt < 1e-4) {
      setErr('Sell size is too small after rounding to 4 decimal shares.');
      return;
    }
    if (submitLockRef.current) return;
    submitLockRef.current = true;
    setBusySubmit(true);
    try {
      liveSubmitGenRef.current += 1;
      const intendedTouchPx = roundPrice01(pxAgg);
      const quoted01 = intendedTouchPx;
      const mark01 = mid != null && mid > 0 ? roundPrice01(mid) : null;
      const optimistic = appendTradeHistoryWithId({ ...tradeHistoryMarketMeta,
        mode: 'live',
        exec: quickSellMode === 'market' ? 'market' : 'touch',
        side: 'sell',
        token,
        label,
        price01: quoted01,
        quotedPrice01: quoted01,
        intendedPrice01: intendedTouchPx,
        submittedPrice01: null,
        fillAvgPrice01: null,
        markPrice01: mark01,
        shares: 0,
        requestedShares: sellAmt,
        remainingShares: sellAmt,
        usdCents: Math.abs(Math.round(intendedTouchPx * sellAmt * 100)),
        status: 'sending',
      });
      setHistoryRows(optimistic.rows);
      setPinnedLiveStatusId(optimistic.id);
      setPinnedLiveStatusDismissed(false);
      const controller = new AbortController();
      setSubmitAbort(controller);
      const tClient0 = performance.now();
      const res =
        quickSellMode === 'market'
          ? await tradeMarketOrderWithOpts(
              { token, side: 'sell', amount: sellAmt, signatureType: null, marketSlug: marketSlug ?? '', outcome: resolvedBullpenOutcome,
            lane },
              { signal: controller.signal, timeoutMs: 25_000 },
            )
          : await tradeCreateOrderWithOpts(
              // Limit-only: server always posts a true limit (GTC). We simulate "fill-and-kill" by cancelling remainder shortly after submit.
              { token, side: 'sell', price: intendedTouchPx, size: sellAmt, orderType: 'GTC', signatureType: null, marketSlug: marketSlug ?? '', outcome: resolvedBullpenOutcome,
            lane },
              { signal: controller.signal, timeoutMs: 25_000 },
            );
      const clientMs = Math.round(performance.now() - tClient0);
      if (!isOk(res)) {
        const e = res as ApiErr;
        setErr(formatTradeApiError(e));
        setHistoryRows(
          updateTradeHistoryRow(optimistic.id, {
            status: 'failed',
            error: `${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`,
          }),
        );
      } else {
        const { result, execution } = unwrapTradeActionData(res.data);
        const oid = execution?.order_id ?? extractOrderIdFromClobPayload(result);
        const rt = mergeRoundTripMs(execution?.round_trip_ms, clientMs);
        setLastExecLatencyMs(rt);
        if (quickSellMode === 'market') {
          const sellRowId = optimistic.id;
          setHistoryRows(
            updateTradeHistoryRow(sellRowId, {
              status: 'sent',
              shares: 0,
              requestedShares: sellAmt,
              remainingShares: sellAmt,
              submittedPrice01: execution?.submitted_price_01 ?? null,
              orderId: oid ?? undefined,
              roundTripMs: rt,
              error: undefined,
            }),
          );
          setOkMsg(`Market sell submitted · ack ${rt}ms — waiting for exchange confirmation…`);
          scheduleTruthRefreshBurst(token, oid ?? null, () => {
            afterLiveSellRowReconcile(sellRowId, { setOk: setOkMsg });
          });
          setSellQty('');
        } else {
          setHistoryRows(
            updateTradeHistoryRow(optimistic.id, {
              status: 'sent',
              shares: 0,
              requestedShares: sellAmt,
              remainingShares: sellAmt,
              // Don't trust local "submitted price". We will read back the accepted limit from Polymarket via getOrder().
              submittedPrice01: null,
              orderId: oid ?? undefined,
              roundTripMs: rt,
              price01: quoted01,
              error: undefined,
            }),
          );
          if (oid) {
            pollRestingOrderFill(optimistic.id, oid, sellAmt, intendedTouchPx, quoted01);
            window.setTimeout(() => void tradeCancelOrder(oid), 900);
          }
          setOkMsg(`Sell sent · intended ${(intendedTouchPx * 100).toFixed(1)}¢ · ack ${rt}ms — reading exchange state…`);
          scheduleTruthRefreshBurst(token, oid);
          setSellQty('');
        }
      }
    } finally {
      submitLockRef.current = false;
      setBusySubmit(false);
      setSubmitAbort(null);
    }
  };

  /** Retry desk auto-sell while lane / balance catch up — stops after one market sell. */
  useEffect(() => {
    if (!pendingAutoSell?.fromSignalsDesk) return;
    if (deskAutoSellClickedNonceRef.current === pendingAutoSell.sellNonce) return;
    const id = window.setInterval(() => setAutoSellRetryTick((t) => t + 1), 400);
    return () => window.clearInterval(id);
  }, [pendingAutoSell]);

  /** Auto-exit from Signals desk — market-sell full held size on the tagged outcome. */
  useEffect(() => {
    if (!pendingAutoSell) return;
    if (lane !== pendingAutoSell.lane) {
      flushSync(() => {
        if (controlledLane == null) setLaneState(pendingAutoSell.lane);
      });
      onLaneChange?.(pendingAutoSell.lane);
      if (!pendingAutoSell.fromSignalsDesk) return;
    }
    if (action !== 'sell') {
      setAction('sell');
      return;
    }

    const deskAuto = pendingAutoSell.fromSignalsDesk === true;
    const nonce = pendingAutoSell.sellNonce;
    if (deskAuto && deskAutoSellClickedNonceRef.current === nonce) return;

    const ageMs = Date.now() - pendingAutoSell.at;
    if (ageMs > 45_000) {
      setPendingAutoSell(null);
      pushToast('err', 'Auto-sell timed out — use Sell on the trade panel or exit manually.');
      return;
    }

    if (busySubmit) return;
    if (outcomeLocked) return;
    if (!token?.trim()) return;

    const held =
      lane === 'up'
        ? accountMode === 'paper'
          ? paperUpPos.shares
          : balUp
        : accountMode === 'paper'
          ? paperDownPos.shares
          : balDown;
    if (held == null || !Number.isFinite(held) || held <= 1e-4) {
      if (deskAuto) deskAutoSellClickedNonceRef.current = nonce;
      setPendingAutoSell(null);
      return;
    }

    const sellAmt = floorShares4(held);
    if (sellAmt < 1e-4) return;

    if (deskAuto) deskAutoSellClickedNonceRef.current = nonce;
    setPendingAutoSell(null);
    if (submitLockRef.current) return;
    void runMarketSell(sellAmt);
  }, [
    pendingAutoSell,
    lane,
    controlledLane,
    onLaneChange,
    action,
    busySubmit,
    outcomeLocked,
    token,
    autoSellRetryTick,
    pushToast,
    accountMode,
    paperUpPos.shares,
    paperDownPos.shares,
    balUp,
    balDown,
  ]);

  const isSidebarOnly = visualStyle === 'sidebar';

  // Paper mode: auto-fill resting orders when mid crosses.
  useEffect(() => {
    if (accountMode !== 'paper') return;
    if (!token) return;
    if (mid == null) return;
    const res = matchPaperOrders({ account: paperAccount, tokenId: token, mid01: mid });
    if (!res.ok) return;
    if (!res.filled.length) return;
    setPaperAccount(res.account);
    setHistoryRows((prev) => {
      let rows = prev;
      for (const f of res.filled) {
        // Update the optimistic 'submitted' row (id = order id) into a filled row with the actual fill data.
        rows = updateTradeHistoryRow(f.order.id, {
          status: 'filled',
          price01: f.fillPrice01,
          shares: f.order.shares,
          usdCents: Math.abs(f.usdCents),
          error: undefined,
        });
      }
      return rows;
    });
    const buyFills = res.filled.filter((f) => f.order.side === 'buy');
    if (buyFills.length > 0) {
      const totalSh = buyFills.reduce((sum, f) => sum + f.order.shares, 0);
      const last = buyFills[buyFills.length - 1]!;
      const fillTok = last.order.tokenId.trim();
      const fillLane: 'up' | 'down' | undefined =
        fillTok === upToken?.trim() ? 'up' : fillTok === downToken?.trim() ? 'down' : undefined;
      const bundle = buyBundleArmRef.current;
      if (bundle && fillLane && bundle.token === fillTok && bundle.lane === fillLane) {
        buyBundleArmRef.current = null;
        applyFilledBuyBundle({ rowTok: fillTok, riskLane: fillLane, shares: totalSh, sl: bundle.sl, tp: bundle.tp });
      } else if (fillLane) {
        const staged = readStagedBuyBundleLevels(fillLane, buyBundleByLaneRef.current);
        if (staged.sl || staged.tp) {
          applyFilledBuyBundle({ rowTok: fillTok, riskLane: fillLane, shares: totalSh, sl: staged.sl, tp: staged.tp });
        } else {
          applyArmRiskAfterBuyFill(last.fillPrice01, totalSh, fillLane);
        }
      } else {
        applyArmRiskAfterBuyFill(last.fillPrice01, totalSh, fillLane);
      }
    }
    syncRiskAutomationAfterSellFill(getPaperPosition(res.account, token).shares);
  }, [
    accountMode,
    applyArmRiskAfterBuyFill,
    applyFilledBuyBundle,
    downToken,
    mid,
    paperAccount,
    syncRiskAutomationAfterSellFill,
    token,
    upToken,
  ]);

  const bracketsDockPanel =
    !token?.trim() || !showBracketsDock
      ? null
      : (
        <div className="min-w-0 rounded-3xl border border-zinc-700/45 bg-[#0c1018] p-3 sm:p-4 shadow-[0_14px_48px_rgba(0,0,0,0.28)] ring-1 ring-white/[0.05]">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Brackets · SL / TP</div>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Auto limit sells on <span className="font-medium text-zinc-300">{label}</span> — tab must stay visible while armed.
          </p>
          <div className="mt-3">
            <Fragment>
                      {riskBracketInverted ? (
                        <div className="mb-3 rounded-xl border border-amber-800/40 bg-amber-950/20 px-3 py-2 text-[10px] leading-relaxed text-amber-100/90">
                          <span className="font-semibold text-amber-200">Bracket check:</span> take-profit is at or below stop-loss.
                          Fix the cent levels so <span className="font-mono">TP &gt; SL</span> for a long exit; otherwise both automations can fight or fire in an unexpected order.
                        </div>
                      ) : null}
                      <div ref={riskCardRef} className="mb-3 overflow-hidden rounded-xl border border-zinc-800/60 bg-zinc-950/30">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/50 bg-black/15 px-3 py-2.5">
                          <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            <span className="truncate text-[13px] font-semibold tracking-tight text-zinc-100">Take Profit / Stop Loss</span>
                            <button
                              type="button"
                              className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-amber-200/90 hover:bg-amber-950/25"
                              title="Client-side automation on this tab watches price and posts GTC limit sells. Not native exchange brackets — keep the tab open."
                              aria-label="About take profit and stop loss"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-current" aria-hidden>
                                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.5" />
                                <path d="M12 16v-4M12 8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                              </svg>
                            </button>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => openRiskSheet('sl')}
                              className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${
                                riskSellSheet === 'sl' || stopLossEnabled
                                  ? 'border-violet-500/55 bg-violet-950/40 text-violet-50 shadow-[inset_0_0_0_1px_rgba(139,92,246,0.12)]'
                                  : 'border-zinc-600/70 bg-zinc-950/50 text-zinc-300 hover:border-zinc-500/80 hover:bg-zinc-900/70'
                              }`}
                              title={stopLossStatus === 'TRIGGERED' ? 'Stop-loss triggered — tap to configure' : stopLossEnabled ? `Stop-loss ${stopLossStatus}` : 'Add stop-loss'}
                            >
                              + SL
                            </button>
                            <button
                              type="button"
                              onClick={() => openRiskSheet('tp')}
                              className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${
                                riskSellSheet === 'tp' || takeProfitEnabled
                                  ? 'border-violet-500/55 bg-violet-950/40 text-violet-50 shadow-[inset_0_0_0_1px_rgba(139,92,246,0.12)]'
                                  : 'border-zinc-600/70 bg-zinc-950/50 text-zinc-300 hover:border-zinc-500/80 hover:bg-zinc-900/70'
                              }`}
                              title={takeProfitStatus === 'TRIGGERED' ? 'Take-profit triggered — tap to configure' : takeProfitEnabled ? `Take-profit ${takeProfitStatus}` : 'Add take-profit'}
                            >
                              + TP
                            </button>
                            <button
                              type="button"
                              onClick={() => openRiskSheet('settings')}
                              className={`inline-flex size-8 items-center justify-center rounded-full border text-[13px] leading-none transition-colors ${
                                riskSellSheet === 'settings'
                                  ? 'border-violet-500/55 bg-violet-950/35 text-violet-100'
                                  : 'border-zinc-600/70 bg-zinc-950/50 text-zinc-400 hover:border-zinc-500/80 hover:text-zinc-200'
                              }`}
                              aria-label="Stop-loss and take-profit defaults"
                              title="Simple mode defaults"
                            >
                              ⚙
                            </button>
                          </div>
                        </div>

                        <div className="border-b border-zinc-800/50 px-3 py-2.5">
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-[11px] font-semibold text-zinc-200">Auto-arm SL/TP after buy</div>
                              <div className="mt-0.5 text-[10px] leading-snug text-zinc-500">
                                Routine TP/SL from signals — separate from the emergency stop under the buy button.
                              </div>
                            </div>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={armRiskAfterBuy.autoArmEnabled}
                              aria-label="Auto-arm stop-loss and take-profit after buy"
                              onClick={() => onAutoArmMasterChange(!armRiskAfterBuy.autoArmEnabled)}
                              className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 ${
                                armRiskAfterBuy.autoArmEnabled
                                  ? 'border-emerald-600/60 bg-emerald-500'
                                  : 'border-zinc-600/70 bg-zinc-800'
                              }`}
                            >
                              <span
                                className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow-sm transition-transform ${
                                  armRiskAfterBuy.autoArmEnabled ? 'translate-x-[22px]' : 'translate-x-0.5'
                                }`}
                              />
                            </button>
                          </div>

                          {armRiskAfterBuy.autoArmEnabled ? (
                            <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-zinc-800/40 pt-2.5 text-[11px]">
                              <label className="flex cursor-pointer items-center gap-2 text-zinc-300">
                                <input
                                  type="checkbox"
                                  checked={armRiskAfterBuy.armSl}
                                  onChange={(e) => onAutoArmSlChange(e.target.checked)}
                                  className="h-4 w-4 accent-rose-500"
                                />
                                Auto-arm SL
                              </label>
                              <label className="flex cursor-pointer items-center gap-2 text-zinc-300">
                                <input
                                  type="checkbox"
                                  checked={armRiskAfterBuy.armTp}
                                  onChange={(e) => onAutoArmTpChange(e.target.checked)}
                                  className="h-4 w-4 accent-emerald-500"
                                />
                                Auto-arm TP
                              </label>
                              <label
                                className="flex cursor-pointer items-center gap-2 text-zinc-400"
                                title="When fill is within ~4¢ of the trade-card entry, use that card's TP/SL instead of a spread scalp"
                              >
                                <input
                                  type="checkbox"
                                  checked={armRiskAfterBuy.useSignalLevels}
                                  onChange={(e) =>
                                    setArmRiskAfterBuy((p) => ({ ...p, useSignalLevels: e.target.checked }))
                                  }
                                  className="h-4 w-4 accent-violet-500"
                                />
                                Signal TP/SL
                              </label>
                            </div>
                          ) : null}
                        </div>

                        {bracketMomentumUi ? (
                          <details className="border-b border-zinc-800/50 bg-violet-950/10 [&_summary::-webkit-details-marker]:hidden">
                            <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-violet-200/90 hover:text-violet-100">
                              Momentum context · tap to expand
                            </summary>
                            <div className="space-y-1 px-3 pb-2 text-[10px] leading-snug text-zinc-400">
                              {bracketMomentumUi.lines.map((ln, i) => (
                                <p key={`bracket-mom-${i}`} className={i === 0 ? 'text-zinc-300' : ''}>
                                  {ln}
                                </p>
                              ))}
                            </div>
                          </details>
                        ) : null}

                        {stopLossEnabled || takeProfitEnabled ? (
                          <div className="space-y-2 border-b border-zinc-800/50 px-3 py-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Live automation readout</div>
                            {(stopLossDualBook || takeProfitDualBook) && stopPollAtMs != null ? (
                              <div className="text-[10px] font-mono text-zinc-500">
                                Fast book poll (~400ms){' '}
                                <span className="text-zinc-400">
                                  last update {Math.max(0, Math.round((Date.now() - stopPollAtMs) / 100) / 10)}s ago
                                </span>
                              </div>
                            ) : null}
                            <div className={`grid gap-2 ${isSlide ? 'grid-cols-1' : 'sm:grid-cols-2'}`}>
                              {bracketAutomationExplain.sl ? <BracketLegReadout leg={bracketAutomationExplain.sl} /> : null}
                              {bracketAutomationExplain.tp ? <BracketLegReadout leg={bracketAutomationExplain.tp} /> : null}
                            </div>
                            <details className="rounded-lg border border-zinc-800/55 bg-black/15">
                              <summary className="cursor-pointer select-none px-2.5 py-2 text-[10px] font-semibold text-zinc-400 hover:text-zinc-200">
                                What the app actually does
                              </summary>
                              <div className="space-y-2 border-t border-zinc-800/45 px-2.5 pb-2.5 pt-2 text-[10px] leading-relaxed text-zinc-500">
                                <ul className="list-inside list-disc space-y-1 pl-0.5">
                                  <li>
                                    Stop-loss and take-profit here are <span className="font-semibold text-zinc-300">client-side watchers</span> on this tab — not
                                    native Polymarket bracket orders.
                                  </li>
                                  <li>
                                    When a level triggers, the app submits a <span className="font-semibold text-zinc-300">GTC limit sell</span> for this outcome
                                    token at your limit ¢.
                                  </li>
                                  <li>
                                    Keep this <span className="font-semibold text-zinc-300">browser tab open</span> while armed; background tabs may throttle timers and
                                    websocket updates.
                                  </li>
                                </ul>
                                <div className="rounded-md border border-zinc-800/50 bg-black/20 px-2 py-1.5 text-zinc-400">
                                  {bracketAutomationExplain.sl ? <p className="mt-0">{bracketAutomationExplain.sl.ruleLine}</p> : null}
                                  {bracketAutomationExplain.tp ? <p className={bracketAutomationExplain.sl ? 'mt-1.5' : 'mt-0'}>{bracketAutomationExplain.tp.ruleLine}</p> : null}
                                </div>
                              </div>
                            </details>
                          </div>
                        ) : null}

                        {lastAutoSell ? (
                          <div className="border-b border-zinc-800/50 bg-black/10 px-3 py-2">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                              <div className="min-w-0 text-zinc-300">
                                <span
                                  className={`mr-2 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-black ${
                                    lastAutoSell.status === 'filled'
                                      ? 'border-emerald-700/40 bg-emerald-950/20 text-emerald-200'
                                      : lastAutoSell.status === 'sent'
                                        ? 'border-amber-700/35 bg-amber-950/15 text-amber-200'
                                        : 'border-rose-800/35 bg-rose-950/15 text-rose-200'
                                  }`}
                                  title={lastAutoSell.msg ?? undefined}
                                >
                                  {lastAutoSell.status === 'filled' ? 'AUTO-SOLD' : lastAutoSell.status === 'sent' ? 'AUTO-SELL SENT' : 'AUTO-SELL FAILED'}
                                </span>
                                <span className="font-mono text-[10px] text-zinc-500">{new Date(lastAutoSell.ts).toLocaleTimeString()}</span>
                              </div>
                              <div className="flex flex-wrap gap-2 font-mono text-[10px] tabular-nums text-zinc-400">
                                <span className="rounded-lg border border-zinc-800/60 bg-black/15 px-2 py-0.5">
                                  {lastAutoSell.kind === 'sl' ? 'SL' : 'TP'} stop {lastAutoSell.triggerCents.toFixed(1)}¢
                                </span>
                                {lastAutoSell.refCents != null ? (
                                  <span className="rounded-lg border border-sky-800/35 bg-sky-950/20 px-2 py-0.5">
                                    bid {lastAutoSell.refCents.toFixed(1)}¢
                                  </span>
                                ) : null}
                                <span className="rounded-lg border border-zinc-800/60 bg-black/15 px-2 py-0.5">
                                  limit {lastAutoSell.limitCents.toFixed(1)}¢
                                </span>
                                <span className="rounded-lg border border-zinc-800/60 bg-black/15 px-2 py-0.5">
                                  {lastAutoSell.shares.toFixed(4)} sh
                                </span>
                                {lastAutoSell.fillCents != null ? (
                                  <span className="rounded-lg border border-emerald-800/40 bg-emerald-950/25 px-2 py-0.5 font-bold text-emerald-100">
                                    fill {formatFillCents(lastAutoSell.fillCents / 100, 1)}
                                  </span>
                                ) : null}
                                {lastAutoSell.orderId ? (
                                  <span className="rounded-lg border border-zinc-800/60 bg-black/15 px-2 py-0.5">
                                    oid {lastAutoSell.orderId.slice(0, 6)}…{lastAutoSell.orderId.slice(-4)}
                                  </span>
                                ) : null}
                              </div>
                              {lastAutoSellAvgCallout ? (
                                <div className="mt-2 border-t border-zinc-800/50 pt-2">{lastAutoSellAvgCallout}</div>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
          
                        <>
                            <div
                              className={`grid border-t border-zinc-800/50 ${
                                isSlide ? 'grid-cols-1' : 'lg:grid-cols-2 lg:divide-x lg:divide-zinc-800/55'
                              }`}
                            >
                              <div ref={slBracketRef} className="min-w-0">
                                <div className="space-y-2 p-3 sm:p-4">
                          <div className="mb-1 rounded-lg border border-rose-900/30 bg-rose-950/15 px-2 py-1.5 text-center text-[10px] font-black uppercase tracking-[0.12em] text-rose-200/95">
                            Stop loss
                          </div>
                          <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                            <span className="text-[11px] font-semibold text-zinc-300">Enable stop-loss</span>
                            <input
                              type="checkbox"
                              checked={stopLossEnabled}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  commitStopLossArmed({ fillLevelsIfEmpty: true });
                                } else {
                                  setStopLossEnabled(false);
                                  setStopLossStatus('OFF');
                                }
                              }}
                              className="h-4 w-4 accent-emerald-500"
                            />
                          </label>

                          {suggestedSlDisplay && !stopLossStopCents.trim() ? (
                            <div className="flex items-center justify-between rounded-md border border-rose-800/20 bg-rose-950/10 px-2.5 py-1">
                              <span className="text-[10px] text-rose-300/80">
                                Suggested <span className="font-mono font-bold text-rose-200">{suggestedSlDisplay}¢</span>
                                {liveSuggestedLevels ? (
                                  <span className="text-zinc-600"> · ref {liveSuggestedLevels.entryCents}¢</span>
                                ) : null}
                              </span>
                              <button
                                type="button"
                                className="rounded border border-rose-700/40 bg-rose-950/30 px-1.5 py-0.5 text-[9px] font-bold text-rose-100 hover:bg-rose-900/40"
                                onClick={() => {
                                  const v = suggestedSlDisplay;
                                  applyStopLossTriggerCents(v);
                                }}
                              >
                                Use
                              </button>
                            </div>
                          ) : null}

                          {/* Trigger: ¢, % off ref, or $/sh — stored as cents for automation. */}
                          <BracketTriggerInput
                            key={`bracket-sl-${lane}`}
                            kind="sl"
                            centsValue={stopLossStopCents}
                            onCentsChange={applyStopLossTriggerCents}
                            avgEntry01={avgEntry ?? null}
                            plannedEntry01={action === 'buy' ? buyBracketSizingEntry01 : bracketPlannedEntry01}
                            orderShares={bracketOrderShares}
                            orderNotionalUsd={action === 'buy' ? buyBundleNotionalUsd : null}
                            mid01={mid ?? null}
                            placeholderCents={targets?.stopCents}
                            suggestedCents={suggestedSlDisplay || undefined}
                            onApplySuggested={() => {
                              const v = suggestedSlDisplay;
                              if (!v) return;
                              applyStopLossTriggerCents(v);
                            }}
                          />

                          <details className="rounded-lg border border-zinc-800/60 bg-black/15 px-3 py-2">
                            <summary className="cursor-pointer text-[11px] font-semibold text-zinc-300 hover:text-zinc-100">
                              Advanced (optional)
                            </summary>
                            <div className="mt-2 space-y-2">
                              <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                                <span className="text-[11px] font-semibold text-zinc-300">
                                  Fast bid poll <span className="font-normal text-zinc-500">(400ms CLOB bid for trigger — sell-side only)</span>
                                </span>
                                <input
                                  type="checkbox"
                                  checked={stopLossDualBook}
                                  onChange={(e) => setStopLossDualBook(e.target.checked)}
                                  className="h-4 w-4 accent-sky-500"
                                />
                              </label>

                              <div className="rounded-lg border border-zinc-800/50 bg-black/15 px-3 py-2 font-mono text-[10px] tabular-nums text-zinc-400">
                                <span className="text-zinc-500">Watching </span>
                                <span className="text-emerald-200/90">bid {slStopWatchBid01 != null ? `${(slStopWatchBid01 * 100).toFixed(1)}¢` : '—'}</span>
                                <span className="text-zinc-600"> · </span>
                                <span className="text-rose-200/90">ask {slStopWatchAsk01 != null ? `${(slStopWatchAsk01 * 100).toFixed(1)}¢` : '—'}</span>
                                {stopLossDualBook && stopPollAtMs != null ? (
                                  <span className="text-zinc-600"> · poll {Math.max(0, Math.round((Date.now() - stopPollAtMs) / 100) / 10)}s</span>
                                ) : null}
                              </div>

                              <div className={`grid gap-2 ${isSlide ? 'grid-cols-1' : 'sm:grid-cols-2'}`}>
                                <label className="rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Limit (¢)</div>
                                  <input
                                    value={stopLossLimitCents}
                                    onChange={(e) => setStopLossLimitCents(e.target.value)}
                                    inputMode="decimal"
                                    placeholder={limitPriceCents || targets?.stopCents || '—'}
                                    className="mt-1 min-h-[40px] w-full bg-transparent text-right font-mono text-[15px] font-semibold tabular-nums text-zinc-100 outline-none"
                                  />
                                </label>
                                <label className="rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Shares</div>
                                  <input
                                    value={stopLossShares}
                                    onChange={(e) => setStopLossShares(e.target.value)}
                                    inputMode="decimal"
                                    placeholder={positionShares != null ? String(floorShares4(positionShares)) : '—'}
                                    className="mt-1 min-h-[40px] w-full bg-transparent text-right font-mono text-[15px] font-semibold tabular-nums text-zinc-100 outline-none"
                                  />
                                </label>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  disabled={positionShares == null || !(positionShares > 0)}
                                  className="rounded-lg border border-zinc-700/60 bg-black/20 px-2.5 py-1.5 text-[10px] font-bold text-zinc-200 hover:bg-black/30 disabled:opacity-40"
                                  title="Set shares to your full position (floored to 4dp)"
                                  onClick={() => {
                                    const sh = bracketPositionShares ?? positionShares;
                                    if (sh == null || !(sh > 0)) return;
                                    const s = String(floorShares4(sh));
                                    setStopLossShares(s);
                                    syncBracketSharesFromPosition(sh);
                                  }}
                                >
                                  = Max
                                </button>
                                {targets?.stopCents ? (
                                  <button
                                    type="button"
                                    className="rounded-lg border border-rose-800/35 bg-rose-950/20 px-2.5 py-1.5 text-[10px] font-bold text-rose-100 hover:bg-rose-950/35"
                                    title="Use assist stop as trigger"
                                    onClick={() => applyStopLossTriggerCents(targets.stopCents)}
                                  >
                                    Use assist stop
                                  </button>
                                ) : null}
                                <button
                                  type="button"
                                  className="rounded-lg border border-amber-800/35 bg-amber-950/15 px-2.5 py-1.5 text-[10px] font-bold text-amber-100 hover:bg-amber-950/25"
                                  title="Use current sell limit as stop-limit limit price"
                                  onClick={() => setStopLossLimitCents(limitPriceCents || stopLossLimitCents)}
                                >
                                  Limit = current
                                </button>
                              </div>
                            </div>
                          </details>
                                </div>
                              </div>
                              <div ref={tpBracketRef} className="min-w-0">
                                <div className="space-y-2 p-3 sm:p-4">
                          <div className="mb-1 rounded-lg border border-emerald-900/30 bg-emerald-950/15 px-2 py-1.5 text-center text-[10px] font-black uppercase tracking-[0.12em] text-emerald-200/95">
                            Take profit
                          </div>
                          <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                            <span className="text-[11px] font-semibold text-zinc-300">Enable take-profit</span>
                            <input
                              type="checkbox"
                              checked={takeProfitEnabled}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  commitTakeProfitArmed({ fillLevelsIfEmpty: true });
                                } else {
                                  setTakeProfitEnabled(false);
                                  setTakeProfitStatus('OFF');
                                }
                              }}
                              className="h-4 w-4 accent-emerald-500"
                            />
                          </label>

                          {suggestedTpDisplay && !takeProfitTakeCents.trim() ? (
                            <div className="flex items-center justify-between rounded-md border border-emerald-800/20 bg-emerald-950/10 px-2.5 py-1">
                              <span className="text-[10px] text-emerald-300/80">
                                Suggested <span className="font-mono font-bold text-emerald-200">{suggestedTpDisplay}¢</span>
                                {liveSuggestedLevels ? (
                                  <span className="text-zinc-600"> · ref {liveSuggestedLevels.entryCents}¢</span>
                                ) : null}
                              </span>
                              <button
                                type="button"
                                className="rounded border border-emerald-700/40 bg-emerald-950/30 px-1.5 py-0.5 text-[9px] font-bold text-emerald-100 hover:bg-emerald-900/40"
                                onClick={() => {
                                  const v = suggestedTpDisplay;
                                  applyTakeProfitTriggerCents(v);
                                }}
                              >
                                Use
                              </button>
                            </div>
                          ) : null}

                          {/* Trigger: ¢, % off ref, or $/sh — stored as cents for automation. */}
                          <BracketTriggerInput
                            key={`bracket-tp-${lane}`}
                            kind="tp"
                            centsValue={takeProfitTakeCents}
                            onCentsChange={applyTakeProfitTriggerCents}
                            avgEntry01={avgEntry ?? null}
                            plannedEntry01={action === 'buy' ? buyBracketSizingEntry01 : bracketPlannedEntry01}
                            orderShares={bracketOrderShares}
                            orderNotionalUsd={action === 'buy' ? buyBundleNotionalUsd : null}
                            mid01={mid ?? null}
                            placeholderCents={riskTargetsFromEntry?.tpCents ?? targets?.tpCents}
                            suggestedCents={suggestedTpDisplay || undefined}
                            onApplySuggested={() => {
                              const v = suggestedTpDisplay;
                              if (!v) return;
                              applyTakeProfitTriggerCents(v);
                            }}
                          />

                          <details className="rounded-lg border border-zinc-800/60 bg-black/15 px-3 py-2">
                            <summary className="cursor-pointer text-[11px] font-semibold text-zinc-300 hover:text-zinc-100">
                              Advanced (optional)
                            </summary>
                            <div className="mt-2 space-y-2">
                              <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                                <span className="text-[11px] font-semibold text-zinc-300">
                                  Fast bid + ask <span className="font-normal text-zinc-500">(400ms poll · either side can trigger)</span>
                                </span>
                                <input
                                  type="checkbox"
                                  checked={takeProfitDualBook}
                                  onChange={(e) => setTakeProfitDualBook(e.target.checked)}
                                  className="h-4 w-4 accent-sky-500"
                                />
                              </label>

                              <div className="rounded-lg border border-zinc-800/50 bg-black/15 px-3 py-2 font-mono text-[10px] tabular-nums text-zinc-400">
                                <span className="text-zinc-500">Watching </span>
                                <span className="text-emerald-200/90">bid {tpTakeWatchBid01 != null ? `${(tpTakeWatchBid01 * 100).toFixed(1)}¢` : '—'}</span>
                                <span className="text-zinc-600"> · </span>
                                <span className="text-sky-200/90">ask {tpTakeWatchAsk01 != null ? `${(tpTakeWatchAsk01 * 100).toFixed(1)}¢` : '—'}</span>
                                {takeProfitDualBook && stopPollAtMs != null ? (
                                  <span className="text-zinc-600"> · poll {Math.max(0, Math.round((Date.now() - stopPollAtMs) / 100) / 10)}s</span>
                                ) : null}
                              </div>

                              <div className={`grid gap-2 ${isSlide ? 'grid-cols-1' : 'sm:grid-cols-2'}`}>
                                <label className="rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Limit (¢)</div>
                                  <input
                                    value={takeProfitLimitCents}
                                    onChange={(e) => setTakeProfitLimitCents(e.target.value)}
                                    inputMode="decimal"
                                    placeholder={limitPriceCents || riskTargetsFromEntry?.tpCents || targets?.tpCents || '—'}
                                    className="mt-1 min-h-[40px] w-full bg-transparent text-right font-mono text-[15px] font-semibold tabular-nums text-zinc-100 outline-none"
                                  />
                                </label>
                                <label className="rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Shares</div>
                                  <input
                                    value={takeProfitShares}
                                    onChange={(e) => setTakeProfitShares(e.target.value)}
                                    inputMode="decimal"
                                    placeholder={positionShares != null ? String(floorShares4(positionShares)) : '—'}
                                    className="mt-1 min-h-[40px] w-full bg-transparent text-right font-mono text-[15px] font-semibold tabular-nums text-zinc-100 outline-none"
                                  />
                                </label>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  disabled={positionShares == null || !(positionShares > 0)}
                                  className="rounded-lg border border-zinc-700/60 bg-black/20 px-2.5 py-1.5 text-[10px] font-bold text-zinc-200 hover:bg-black/30 disabled:opacity-40"
                                  title="Set shares to your full position (floored to 4dp)"
                                  onClick={() => {
                                    const sh = bracketPositionShares ?? positionShares;
                                    if (sh == null || !(sh > 0)) return;
                                    const s = String(floorShares4(sh));
                                    setTakeProfitShares(s);
                                    syncBracketSharesFromPosition(sh);
                                  }}
                                >
                                  = Max
                                </button>
                                {riskTargetsFromEntry?.tpCents || targets?.tpCents ? (
                                  <button
                                    type="button"
                                    className="rounded-lg border border-emerald-800/35 bg-emerald-950/20 px-2.5 py-1.5 text-[10px] font-bold text-emerald-100 hover:bg-emerald-950/35"
                                    title="Use assist or entry-anchored TP as trigger"
                                    onClick={() => {
                                      const c = riskTargetsFromEntry?.tpCents ?? targets?.tpCents;
                                      if (c) applyTakeProfitTriggerCents(c);
                                    }}
                                  >
                                    Use assist TP
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          </details>
                                </div>
                              </div>
                            </div>
                            {bracketMidCentsDisplay != null ? (
                              <div className="border-t border-zinc-800/50 bg-black/[0.12] px-3 py-3">
                                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                                  Quick assist · mid {bracketMidCentsDisplay.toFixed(1)}¢
                                </div>
                                <p className="mt-1 text-[10px] leading-snug text-zinc-600">
                                  Offsets apply on top of strip mid — fills Stop at / Take at above after you choose.
                                </p>
                                <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
                                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                                    <span className="shrink-0 text-[9px] font-black uppercase tracking-wide text-rose-300/90">SL</span>
                                    {([-1, -2, -5, -10] as const).map((d) => (
                                      <button
                                        key={`sl-pre-${d}`}
                                        type="button"
                                        className="min-h-[34px] min-w-[3rem] rounded-lg border border-rose-800/45 bg-rose-950/25 px-2 text-[11px] font-bold tabular-nums text-rose-100 hover:bg-rose-950/45"
                                        title="Set stop trigger & limit (mid + offset)"
                                        onClick={() => {
                                          const v = Math.min(99.9, Math.max(0.1, Math.round((bracketMidCentsDisplay + d) * 10) / 10));
                                          const s = v % 1 === 0 ? String(Math.round(v)) : String(v);
                                          applyStopLossTriggerCents(s);
                                        }}
                                      >
                                        {d}¢
                                      </button>
                                    ))}
                                    {targets?.stopCents ? (
                                      <button
                                        type="button"
                                        className="min-h-[34px] rounded-lg border border-rose-700/50 bg-rose-950/35 px-2.5 text-[10px] font-bold text-rose-50 hover:bg-rose-950/55"
                                        onClick={() => applyStopLossTriggerCents(targets.stopCents)}
                                      >
                                        Assist
                                      </button>
                                    ) : null}
                                  </div>
                                  <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-zinc-800/40 pt-3 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
                                    <span className="shrink-0 text-[9px] font-black uppercase tracking-wide text-emerald-300/90">TP</span>
                                    {([1, 2, 5] as const).map((d) => (
                                      <button
                                        key={`tp-pre-${d}`}
                                        type="button"
                                        className="min-h-[34px] min-w-[3rem] rounded-lg border border-emerald-800/45 bg-emerald-950/25 px-2 text-[11px] font-bold tabular-nums text-emerald-100 hover:bg-emerald-950/45"
                                        title="Set take trigger & limit (mid + offset)"
                                        onClick={() => {
                                          const v = Math.min(99.9, Math.max(0.1, Math.round((bracketMidCentsDisplay + d) * 10) / 10));
                                          const s = v % 1 === 0 ? String(Math.round(v)) : String(v);
                                          applyTakeProfitTriggerCents(s);
                                        }}
                                      >
                                        +{d}¢
                                      </button>
                                    ))}
                                    <button
                                      type="button"
                                      className="min-h-[34px] min-w-[3rem] rounded-lg border border-emerald-700/50 bg-emerald-950/35 px-2 text-[11px] font-bold text-emerald-50 hover:bg-emerald-950/55"
                                      onClick={() => applyTakeProfitTriggerCents('99')}
                                    >
                                      99¢
                                    </button>
                                    {riskTargetsFromEntry?.tpCents || targets?.tpCents ? (
                                      <button
                                        type="button"
                                        className="min-h-[34px] rounded-lg border border-emerald-700/50 bg-emerald-950/35 px-2.5 text-[10px] font-bold text-emerald-50 hover:bg-emerald-950/55"
                                        onClick={() => {
                                          const c = riskTargetsFromEntry?.tpCents ?? targets?.tpCents;
                                          if (c) applyTakeProfitTriggerCents(c);
                                        }}
                                      >
                                        Assist
                                      </button>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            ) : null}
                          </>
          
                      {riskSellSheet === 'settings' ? (
                        <div className="space-y-2 border-t border-zinc-800/40 p-3 text-[11px] leading-relaxed text-zinc-400">
                          <p className="font-semibold text-zinc-200">Bracket defaults</p>
                          <p>
                            <span className="font-semibold text-zinc-300">+ SL</span> / <span className="font-semibold text-zinc-300">+ TP</span> arm automation; open the Brackets tab to edit levels.
                            Simple mode syncs limit to trigger; Advanced unlocks separate limit & shares.
                          </p>
                        </div>
                      ) : null}
                      </div>
            </Fragment>
          </div>
        </div>
      );

  return (
    <div
      className={`${isSlide ? 'relative' : ''} ${
        isSlide
          ? 'border-0 bg-transparent p-0 shadow-none ring-0'
          : `border ring-1 ring-white/[0.04] ${
              isSidebarOnly
                ? 'rounded-[28px] border-zinc-800/80 bg-[#0d1219] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.35)]'
                : 'rounded-2xl border-zinc-800/60 bg-gradient-to-b from-zinc-950/90 to-zinc-950/50 p-4 sm:p-5'
            }`
      }`}
    >
      {/* Header */}
      <div className="flex flex-col gap-4">
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-3">
            {!isSlide ? (
              <h1 className="text-xl font-semibold tracking-tight text-zinc-100">TRADE</h1>
            ) : (
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Order flow</div>
            )}
            {isSlide ? (
              <div className="flex shrink-0 items-center gap-1.5">
                <div className="flex shrink-0 items-center gap-1 rounded-xl border border-zinc-800/60 bg-black/20 p-1">
                  <button
                    type="button"
                    onClick={() => chooseAction('buy')}
                    className={`min-h-[40px] rounded-lg px-3.5 text-[14px] font-bold transition-colors ${
                      action === 'buy' ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    BUY
                  </button>
                  <button
                    type="button"
                    onClick={() => chooseAction('sell')}
                    className={`min-h-[40px] rounded-lg px-3.5 text-[14px] font-bold transition-colors ${
                      action === 'sell' ? 'bg-rose-500 text-black' : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    SELL
                  </button>
                </div>
                {action === 'buy' ? renderSecondaryBuyCta('header') : null}
              </div>
            ) : null}
          </div>
          {!isSlide ? (
            <p className="mt-1 text-[13px] leading-relaxed text-zinc-500">
              {isSidebarOnly ? 'Practice/live · outcome · size · brackets · submit.' : 'Mode · outcome · size · price · buy/sell.'}
            </p>
          ) : null}
          {accountMode === 'live' ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-zinc-400">
              {lastExecLatencyMs != null ? (
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono tabular-nums ${
                    lastExecLatencyMs < 120
                      ? 'border-emerald-800/40 text-emerald-200/90'
                      : lastExecLatencyMs < 280
                        ? 'border-zinc-700 text-zinc-300'
                        : 'border-amber-800/40 text-amber-200/90'
                  }`}
                  title="Round-trip time for the last completed HTTP trade call (server or client measured)."
                >
                  Last RTT {lastExecLatencyMs}ms
                  {lastExecLatencyMs < 120 ? ' · fast' : lastExecLatencyMs >= 280 ? ' · slow' : ''}
                </span>
              ) : null}
              {executableQuote01 != null ? (
                <span
                  className="rounded-full border border-zinc-800/60 px-2 py-0.5 font-mono text-zinc-400"
                  title="Executable reference: best ask when buying, best bid when selling (falls back to mid)."
                >
                  Exec ref {fmtCents(executableQuote01)}
                </span>
              ) : null}
              {spreadCents != null ? (
                <span
                  className="rounded-full border border-zinc-800/60 px-2 py-0.5 font-mono text-zinc-400"
                  title="Bid/ask spread from top-of-book (affects quick entries)."
                >
                  Spread {spreadCents.toFixed(1)}¢
                </span>
              ) : null}
              <button
                type="button"
                disabled={busySubmit}
                className="rounded-full border border-rose-900/50 bg-rose-950/25 px-2 py-0.5 font-semibold text-rose-100/90 hover:bg-rose-950/40 disabled:opacity-30"
                title="POST /api/trade/cancel-all — cancels every open order for this API wallet on Polymarket."
                onClick={async () => {
                  if (!killArmed) {
                    setKillArmed(true);
                    if (killArmTimerRef.current != null) window.clearTimeout(killArmTimerRef.current);
                    killArmTimerRef.current = window.setTimeout(() => {
                      killArmTimerRef.current = null;
                      setKillArmed(false);
                    }, 3600);
                    pushToast('info', 'Click again to confirm: cancel ALL open orders (3.6s).', 3600);
                    return;
                  }
                  setKillArmed(false);
                  setErr(null);
                  setOkMsg(null);
                  const r = await cancelAllLiveOrders();
                  if (!r.ok) {
                    const msg = r.message;
                    setErr(msg);
                    pushToast('err', msg);
                  } else {
                    setHistoryRows(loadTradeHistory());
                    void refreshOpenOrders();
                    void refreshLiveBalances();
                    if (upToken) void refreshMyFills(upToken);
                    if (downToken && downToken !== upToken) void refreshMyFills(downToken);
                    const n = r.count;
                    const msg =
                      n != null ? `Killed ${n} open order${n === 1 ? '' : 's'} on Polymarket.` : 'Kill sent — open orders cleared.';
                    setOkMsg(msg);
                    pushToast('ok', msg);
                    pushTradeActivity(`Cancel-all · ${msg}`);
                  }
                }}
              >
                {killArmed ? 'Confirm kill' : 'Kill open orders'}
              </button>
            </div>
          ) : null}
          {!isSlide && (marketSlug || marketQuestion) ? (
            <div className="mt-2 space-y-1 rounded-xl border border-zinc-800/55 bg-black/25 px-3 py-2.5 text-[11px] text-zinc-500">
              {marketQuestion ? <div className="line-clamp-2 font-medium text-zinc-200/95">{marketQuestion}</div> : null}
              {marketSlug ? <div className="font-mono text-[10px] text-zinc-500">{marketSlug}</div> : null}
            </div>
          ) : null}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <TradeSegmentedControl
              value={accountMode}
              onChange={(v) => {
                const mode = v as 'paper' | 'live';
                setAccountMode(mode);
                saveTradeAccountMode(mode);
                setErr(null);
                setOkMsg(null);
                if (mode === 'live') {
                  void refreshLiveBalances();
                }
              }}
              options={[
                { value: 'paper', label: 'Practice', title: 'Simulated cash and fills — nothing is sent on-chain' },
                {
                  value: 'live',
                  label: 'Live',
                  title:
                    tradingReady === false
                      ? 'Real orders — API keys not configured yet (see banner)'
                      : 'Real orders via your configured API keys',
                },
              ]}
              size="md"
            />
            {accountMode === 'paper' ? (
              <div className={`flex flex-wrap items-center gap-2 ${isSlide ? 'w-full' : ''}`}>
                <label
                  className={`flex items-center gap-2 rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2 ${
                    isSlide ? 'min-w-0 flex-1 basis-[min(100%,12rem)]' : 'min-w-[180px]'
                  }`}
                >
                  <span className="text-[11px] font-semibold text-zinc-400">Cash $</span>
                  <input
                    value={paperCashEdit}
                    onChange={(e) => setPaperCashEdit(e.target.value)}
                    inputMode="decimal"
                    className="min-w-0 flex-1 bg-transparent text-right font-mono text-[12px] font-bold text-zinc-100 outline-none"
                    placeholder="75.00"
                    title="Set your practice cash balance"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const v = Number(paperCashEdit);
                    if (!Number.isFinite(v) || v < 0) {
                      setErr('Enter a valid cash amount (e.g. 75).');
                      return;
                    }
                    setPaperAccount((a) => setPaperCashUsd({ account: a, cashUsd: v }));
                    setErr(null);
                    setOkMsg(`Practice cash set to $${v.toFixed(2)}.`);
                  }}
                  className="min-h-[44px] shrink-0 rounded-xl border border-emerald-800/40 bg-emerald-950/20 px-3 text-[11px] font-black text-emerald-100 hover:bg-emerald-950/35"
                  title="Apply the cash balance"
                >
                  Set
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPaperAccount(resetPaperAccount());
                    setErr(null);
                    setOkMsg('Practice account reset to $5,000.');
                  }}
                  className="min-h-[44px] shrink-0 rounded-xl border border-zinc-700/60 bg-zinc-950/50 px-3 text-[11px] font-semibold text-zinc-200 hover:border-zinc-600/70 hover:bg-zinc-900/60"
                  title="Clear paper positions and start over with $5,000 play money"
                >
                  Reset demo
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {accountMode === 'live' && (!isSlide || slideDockTab === 'ledger') ? (
          <details className="rounded-xl border border-zinc-800/60 bg-zinc-950/35">
            <summary className="cursor-pointer select-none px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500 hover:text-zinc-400">
              Open orders{' '}
              <span className="font-mono text-zinc-600">
                ({openOrdersLoading ? '…' : openOrders.length + localLiveOpenOrdersForToken.length})
              </span>
            </summary>
            <div className="border-t border-zinc-800/50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[11px] text-zinc-500">
                  Showing {openOrdersScope === 'all' ? 'all resting orders for this wallet.' : 'resting orders for this outcome token.'}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex overflow-hidden rounded-lg border border-zinc-800/70 bg-black/20">
                    <button
                      type="button"
                      onClick={() => setOpenOrdersScope('token')}
                      className={`px-2.5 py-1.5 text-[10px] font-black ${
                        openOrdersScope === 'token' ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                      title="Only this outcome"
                    >
                      This outcome
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpenOrdersScope('all')}
                      className={`px-2.5 py-1.5 text-[10px] font-black ${
                        openOrdersScope === 'all' ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                      title="All outcomes"
                    >
                      All
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => void refreshOpenOrders()}
                    disabled={openOrdersLoading}
                    className="rounded-lg border border-zinc-800/70 bg-black/20 px-2.5 py-1.5 text-[10px] font-bold text-zinc-300 hover:bg-black/30 disabled:opacity-40"
                  >
                    Refresh
                  </button>
                </div>
              </div>

              {openOrdersErr ? (
                <div className="mt-2 rounded-lg border border-rose-800/35 bg-rose-950/15 px-3 py-2 text-[11px] text-rose-100">
                  {openOrdersErr}
                </div>
              ) : null}

              {localLiveOpenOrdersForToken.length ? (
                <div className="mt-3 rounded-xl border border-amber-800/35 bg-amber-950/10 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-200/80">
                    Recently sent (may fill instantly)
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {localLiveOpenOrdersForToken.slice(0, 6).map((r) => (
                      <div
                        key={String(r.id ?? r.orderId ?? `${r.side}-${r.ts}`)}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800/60 bg-black/10 px-2.5 py-2 text-[11px]"
                      >
                        <div className="min-w-0">
                          <span className={`font-bold ${r.side === 'buy' ? 'text-emerald-200' : 'text-rose-200'}`}>
                            {(r.side ?? '—').toUpperCase()}
                          </span>{' '}
                          <span className="font-mono text-zinc-300">{r.price01 != null ? `${(r.price01 * 100).toFixed(1)}¢` : '—'}</span>{' '}
                          <span className="font-mono text-zinc-500">{r.shares != null ? `${Number(r.shares).toFixed(4)} sh` : ''}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-zinc-400">
                          <span className="rounded-full border border-zinc-800/70 bg-black/10 px-2 py-0.5 font-black">
                            {(r.status ?? '—').toUpperCase()}
                          </span>
                          {r.orderId ? (
                            <span className="rounded-full border border-zinc-800/70 bg-black/10 px-2 py-0.5">
                              oid {String(r.orderId).slice(0, 6)}…{String(r.orderId).slice(-4)}
                            </span>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {openOrders.length ? (
                <div className="mt-3 max-h-[260px] overflow-auto rounded-xl border border-zinc-800/60 bg-black/15">
                  <table className="w-full border-collapse text-left text-[11px]">
                    <thead className="sticky top-0 bg-zinc-950/80 backdrop-blur">
                      <tr className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                        <th className="px-2 py-2">Side</th>
                        {openOrdersScope === 'all' ? <th className="px-2 py-2">Outcome</th> : null}
                        <th className="px-2 py-2">Price</th>
                        <th className="px-2 py-2 text-right">Remaining</th>
                        <th className="px-2 py-2 text-right">Size</th>
                        <th className="px-2 py-2">Created</th>
                        <th className="px-2 py-2 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="align-top">
                      {openOrders.slice(0, 80).map((o) => {
                        const id = orderIdFromRow(o);
                        const side = orderSideFromRow(o);
                        const tok = openOrdersScope === 'all' ? orderTokenIdFromRow(o) : null;
                        const px = orderPrice01FromRow(o);
                        const rem = orderRemainingFromRow(o);
                        const size = orderSizeFromRow(o);
                        const created = orderCreatedAtFromRow(o);
                        const outcome =
                          tok && tok === upToken ? upLabel : tok && tok === downToken ? downLabel : tok ? `${tok.slice(0, 6)}…${tok.slice(-4)}` : '—';
                        return (
                          <tr key={id ?? JSON.stringify(o).slice(0, 32)} className="border-t border-zinc-900/70">
                            <td className="px-2 py-2">
                              <span className={`font-bold ${side === 'buy' ? 'text-emerald-200' : side === 'sell' ? 'text-rose-200' : 'text-zinc-400'}`}>
                                {side ?? '—'}
                              </span>
                            </td>
                            {openOrdersScope === 'all' ? (
                              <td className="px-2 py-2">
                                <span className="rounded-md border border-zinc-800/70 bg-black/20 px-2 py-1 text-[10px] font-semibold text-zinc-200">
                                  {outcome}
                                </span>
                              </td>
                            ) : null}
                            <td className="px-2 py-2 font-mono text-zinc-300">{px == null ? '—' : `${(px * 100).toFixed(1)}¢`}</td>
                            <td className="px-2 py-2 text-right font-mono text-zinc-300">{rem == null ? '—' : rem.toFixed(2)}</td>
                            <td className="px-2 py-2 text-right font-mono text-zinc-500">{size == null ? '—' : size.toFixed(2)}</td>
                            <td className="px-2 py-2 font-mono text-[10px] text-zinc-500">{created ?? '—'}</td>
                            <td className="px-2 py-2 text-right">
                              <button
                                type="button"
                                disabled={!id || openOrdersLoading}
                                onClick={async () => {
                                  if (!id) return;
                                  const res = await cancelLiveOrderAndRefresh(id, { quiet: true });
                                  if (!res.ok) setOpenOrdersErr(res.message);
                                  else setOpenOrdersErr(null);
                                }}
                                className="rounded-lg border border-zinc-800/70 bg-black/20 px-2 py-1 text-[10px] font-bold text-zinc-300 hover:bg-black/30 disabled:opacity-40"
                              >
                                Cancel
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="mt-3 rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2 text-[11px] text-zinc-500">
                  No open orders for this token.
                </div>
              )}
            </div>
          </details>
        ) : null}

        {accountMode === 'live' && liveStatusRow && (!isSlide || slideDockTab === 'outcome' || slideDockTab === 'ledger') ? (
          <div className="rounded-xl border border-amber-800/35 bg-amber-950/15 px-3 py-2.5 text-[11px] text-amber-100/90">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-200/80">Live order status</div>
                <div className="mt-1 text-[12px] font-bold text-amber-100">
                  {rowShowsExchangeFill(liveStatusRow) && liveStatusRow.status === 'filled'
                    ? `FILLED @ ${formatFillCents(fillPrice01FromRow(liveStatusRow)!, 1)} fill${
                        rowTapeConfirmed(liveStatusRow) ? '' : ' · wallet syncing'
                      }`
                    : rowShowsExchangeFill(liveStatusRow) && liveStatusRow.status === 'partial'
                      ? `PARTIAL @ ${formatFillCents(fillPrice01FromRow(liveStatusRow)!, 1)} fill · ${filledSharesFromRow(liveStatusRow).toFixed(4)} sh${
                          rowTapeConfirmed(liveStatusRow) ? '' : ' · wallet syncing'
                        }`
                      : liveStatusRow.status === 'filled' || liveStatusRow.status === 'partial'
                        ? 'MATCHED (confirming on exchange tape…)'
                        : liveStatusRow.status === 'no_fill'
                          ? 'CLOSED · no active order on exchange'
                          : liveStatusRow.status === 'cancelled'
                            ? 'CANCELLED'
                            : liveStatusRow.status === 'failed'
                              ? 'FAILED'
                        : liveStatusRow.status === 'sent'
                          ? 'RESTING (OPEN) · 0 filled on exchange'
                          : liveStatusRow.status === 'pending'
                            ? 'PENDING'
                            : 'SENDING'}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 font-mono text-[11px] text-amber-100/85">
                  <span className="rounded-lg border border-amber-800/30 bg-black/15 px-2 py-1">
                    filled {filledSharesFromRow(liveStatusRow).toFixed(4)}
                    {liveStatusRow.requestedShares != null && liveStatusRow.requestedShares > 0
                      ? ` / ${liveStatusRow.requestedShares.toFixed(4)}`
                      : ''}
                    {(() => {
                      const rem = remainingSharesFromRow(liveStatusRow);
                      return rem != null ? ` · rem ${rem.toFixed(4)}` : '';
                    })()}
                  </span>
                  <span
                    className={`rounded-lg border bg-black/15 px-2 py-1 ${
                      liveStatusRow.intendedPrice01 != null &&
                      liveStatusRow.submittedPrice01 != null &&
                      Math.abs(liveStatusRow.intendedPrice01 - liveStatusRow.submittedPrice01) > 5e-6
                        ? 'border-rose-700/40 text-rose-100'
                        : 'border-amber-800/30'
                    }`}
                  >
                    intended {liveStatusRow.intendedPrice01 == null ? '—' : `${(liveStatusRow.intendedPrice01 * 100).toFixed(1)}¢`}
                    {' '}· accepted {liveStatusRow.submittedPrice01 == null ? '—' : `${(liveStatusRow.submittedPrice01 * 100).toFixed(1)}¢`}
                  </span>
                  <span className="rounded-lg border border-amber-800/30 bg-black/15 px-2 py-1">
                    fill avg {formatFillCents(fillPrice01FromRow(liveStatusRow), 1)}
                    {limitPrice01FromRow(liveStatusRow) != null
                      ? ` · limit ${formatFillCents(limitPrice01FromRow(liveStatusRow), 1)}`
                      : ''}
                  </span>
                  {liveStatusRow.orderId ? (
                    <span className="rounded-lg border border-amber-800/30 bg-black/15 px-2 py-1">
                      oid {liveStatusRow.orderId.slice(0, 6)}…{liveStatusRow.orderId.slice(-4)}
                    </span>
                  ) : null}
                  <span className="rounded-lg border border-amber-800/30 bg-black/15 px-2 py-1">ack {fmtMs(liveStatusRow.roundTripMs)}</span>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!liveStatusRow.orderId || !liveRowCancelable(liveStatusRow)}
                  onClick={async () => {
                    const oid = liveStatusRow.orderId;
                    if (!oid) return;
                    await cancelLiveOrderAndRefresh(oid);
                  }}
                  className="min-h-[40px] rounded-xl border border-rose-800/40 bg-rose-950/20 px-3 text-[11px] font-black text-rose-100 hover:bg-rose-950/35 disabled:cursor-not-allowed disabled:opacity-40"
                  title={
                    liveRowCancelable(liveStatusRow)
                      ? 'Cancel the resting order on Polymarket'
                      : 'Nothing left to cancel — order is filled or already closed'
                  }
                >
                  Cancel order
                </button>
                <button
                  type="button"
                  onClick={() => {
                    try {
                      if (liveStatusRow.orderId) void navigator.clipboard.writeText(liveStatusRow.orderId);
                    } catch {
                      /* ignore */
                    }
                  }}
                  disabled={!liveStatusRow.orderId}
                  className="min-h-[40px] rounded-xl border border-zinc-700/60 bg-black/15 px-3 text-[11px] font-semibold text-zinc-100 hover:bg-black/25 disabled:opacity-40"
                  title="Copy order id"
                >
                  Copy oid
                </button>
                <button
                  type="button"
                  onClick={() => setPinnedLiveStatusDismissed(true)}
                  className="min-h-[40px] rounded-xl border border-amber-800/30 bg-black/15 px-3 text-[11px] font-semibold text-amber-100 hover:bg-black/25"
                  title="Hide this status until the next trade"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {!isSlide ? <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => chooseAction('buy')}
            className={`min-h-[48px] rounded-xl px-4 py-3 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
              action === 'buy'
                ? 'bg-emerald-500 text-black shadow-md shadow-emerald-950/25 ring-1 ring-emerald-400/40'
                : 'border border-zinc-700/60 bg-black/25 text-zinc-400 hover:border-zinc-600/70 hover:text-zinc-100'
            }`}
          >
            Buy
          </button>
          <button
            type="button"
            onClick={() => chooseAction('sell')}
            className={`min-h-[48px] rounded-xl px-4 py-3 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
              action === 'sell'
                ? 'bg-rose-500 text-black shadow-md shadow-rose-950/25 ring-1 ring-rose-400/40'
                : 'border border-zinc-700/60 bg-black/25 text-zinc-400 hover:border-zinc-600/70 hover:text-zinc-100'
            }`}
          >
            Sell
          </button>
        </div> : null}
        {!isSlide && action === 'buy' ? <div className="mt-2">{renderSecondaryBuyCta('compact')}</div> : null}
      </div>

      {!isSlide ? (
        <div className="mt-4">
          <ShouldBuyCard
            advisory={effectiveBuySideAdvisory}
            autoAsk
            upLabel={upLabel}
            downLabel={downLabel}
            onAsk={() => {
              /* auto-ask recomputes live; Re-ask is a no-op refresh hook for future use */
            }}
          />
        </div>
      ) : null}

      {accountMode === 'live' ? (
        <div className="mt-4">
          <LiveTradingHud
            compact={isSlide}
            tradingReady={tradingReady}
            tradingVia={tradingVia}
            balLoading={balLoading}
            balError={balError}
            cashUsd={liveMtm.cashUsd}
            equityUsd={liveMtm.equityUsd}
            totalUsd={liveMtm.totalUsd}
            unrealizedUsd={liveMtm.unrealizedUsd}
            openOrdersCount={openOrders.length + localLiveOpenOrdersForToken.length}
            onRefresh={() => {
              void refreshLiveBalances();
              void refreshOpenOrders();
              void refreshMyFills();
              refreshAvgEntry();
            }}
            refreshing={busyRefresh || balLoading}
          />
          {(() => {
            const heldLane = bracketOutcomeLaneRef.current ?? lane;
            const heldLabel = heldLane === 'up' ? upLabel : downLabel;
            const heldShares = liveLaneShares('display', heldLane);
            const heldMaxSell = liveLaneShares('sell', heldLane);
            const activeStopCents = stopLossEnabled && stopLossStopCents.trim() ? stopLossStopCents.trim() : null;
            const activeTpCents = takeProfitEnabled && takeProfitTakeCents.trim() ? takeProfitTakeCents.trim() : null;
            return (
              <LivePositionStrip
                outcomeLabel={heldLabel}
                lane={heldLane}
                shares={heldShares}
                maxSellShares={heldMaxSell}
                avgEntry01={heldLane === 'up' ? avgEntryUp : avgEntryDown}
                pinnedStopCents={activeStopCents}
                pinnedTpCents={activeTpCents}
                stopLossStatus={stopLossStatus}
                takeProfitStatus={takeProfitStatus}
                bracketLane={bracketOutcomeLaneRef.current}
                tabLane={lane}
                compact={isSlide}
              />
            );
          })()}
        </div>
      ) : null}
      {deskSignalTrade ? (
        <div className={isSlide ? 'mt-3' : 'mt-4'}>
          <PositionDeskSignalStrip signal={deskSignalTrade} compact={isSlide} />
        </div>
      ) : null}
      {holdingShares && heldTpOutlook ? (
        <div className={isSlide ? 'mt-2' : 'mt-3'}>
          <PositionTpOutlookCard outlook={heldTpOutlook} compact={isSlide} variant="held" />
        </div>
      ) : null}
      {busySubmit && submitAbort ? (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2 text-[11px] text-zinc-400">
          <span>Submitting…</span>
          <button
            type="button"
            onClick={() => {
              try {
                submitAbort.abort();
              } catch {
                /* ignore */
              } finally {
                setSubmitAbort(null);
              }
            }}
            className="rounded-lg border border-zinc-800/70 bg-black/15 px-2.5 py-1.5 text-[10px] font-bold text-zinc-200 hover:bg-black/25"
          >
            Cancel
          </button>
        </div>
      ) : null}

      {accountMode === 'paper' ? (
        <div className={`mt-4 grid gap-2 ${isSlide ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'}`}>
          <div className="min-w-0 rounded-xl border border-zinc-800/60 bg-black/20 px-2.5 py-2.5 sm:px-3">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500 sm:text-[10px]">Cash</div>
            <div
              className="mt-1 truncate font-mono text-[11px] tabular-nums leading-snug text-zinc-100 sm:text-sm"
              title={fmtUsdCents(paperMtm.cashUsdCents)}
            >
              {fmtUsdCents(paperMtm.cashUsdCents)}
            </div>
          </div>
          <div className="min-w-0 rounded-xl border border-zinc-800/60 bg-black/20 px-2.5 py-2.5 sm:px-3">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500 sm:text-[10px]">Equity</div>
            <div
              className="mt-1 truncate font-mono text-[11px] tabular-nums leading-snug text-zinc-100 sm:text-sm"
              title={fmtUsdCents(paperMtm.equityUsdCents)}
            >
              {fmtUsdCents(paperMtm.equityUsdCents)}
            </div>
          </div>
          <div className="min-w-0 rounded-xl border border-zinc-800/60 bg-black/20 px-2.5 py-2.5 sm:px-3">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500 sm:text-[10px]">Open P/L</div>
            <div
              className="mt-1 truncate font-mono text-[11px] tabular-nums leading-snug text-zinc-100 sm:text-sm"
              title={fmtUsdCents(paperMtm.unrealizedPnlUsdCents)}
            >
              {fmtUsdCents(paperMtm.unrealizedPnlUsdCents)}
            </div>
          </div>
          <div className="min-w-0 rounded-xl border border-zinc-800/60 bg-black/20 px-2.5 py-2.5 sm:px-3">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500 sm:text-[10px]">Realized</div>
            <div
              className="mt-1 truncate font-mono text-[11px] tabular-nums leading-snug text-zinc-100 sm:text-sm"
              title={fmtUsdCents(paperMtm.realizedPnlUsdCents)}
            >
              {fmtUsdCents(paperMtm.realizedPnlUsdCents)}
            </div>
          </div>
        </div>
      ) : null}

      {accountMode === 'paper' && paperSettlementBanner ? (
        <div className="mt-3 rounded-xl border border-sky-800/35 bg-sky-950/15 px-3 py-2 text-[11px] leading-snug text-sky-100/90">
          <div className="font-semibold uppercase tracking-wide text-sky-200/90">Resolved market · practice settlement</div>
          <p className="mt-1 text-sky-50/90">{paperSettlementBanner}</p>
        </div>
      ) : null}

      {isSlide && !tradeFloatChrome ? slideDockTabsEl : null}

      {isSlide && showOutcomeDock ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 rounded-xl border border-zinc-800/60 bg-black/35 px-3 py-2">
            <span
              className={`h-2 w-2 shrink-0 rounded-full ${
                busySubmit ? 'animate-pulse bg-amber-400' : err ? 'bg-rose-500' : okMsg ? 'bg-emerald-400' : 'bg-zinc-600'
              }`}
            />
            <span className="text-[11px] text-zinc-300">
              {busySubmit ? 'SENDING…' : err ? 'FAILED' : okMsg ? 'FILLED / OK' : 'READY'}
            </span>
          </div>
          <div className="min-h-[2.75rem]">
            {flashToast ? (
              <div className="min-w-0 break-words rounded-lg border border-zinc-700/50 bg-zinc-900/80 px-3 py-2 text-left text-[12px] leading-snug text-zinc-100">
                {flashToast}
              </div>
            ) : lastAutoSell && Date.now() - lastAutoSell.ts <= 10 * 60_000 ? (
              <div
                className={`min-w-0 break-words rounded-lg border px-3 py-2 text-left text-[12px] leading-snug ${
                  lastAutoSell.status === 'filled'
                    ? 'border-emerald-800/35 bg-emerald-950/20 text-emerald-100'
                    : lastAutoSell.status === 'sent'
                      ? 'border-amber-800/35 bg-amber-950/15 text-amber-100'
                      : 'border-rose-800/35 bg-rose-950/15 text-rose-100'
                }`}
                title={lastAutoSell.msg ?? undefined}
              >
                <span className="font-black">
                  {lastAutoSell.status === 'filled' ? 'AUTO-SOLD' : lastAutoSell.status === 'sent' ? 'AUTO-SELL SENT' : 'AUTO-SELL FAILED'}
                </span>{' '}
                <span className="font-mono">
                  {lastAutoSell.kind === 'sl' ? 'SL' : 'TP'} stop {lastAutoSell.triggerCents.toFixed(1)}¢
                  {lastAutoSell.refCents != null ? ` · bid ${lastAutoSell.refCents.toFixed(1)}¢` : ''} → limit{' '}
                  {lastAutoSell.limitCents.toFixed(1)}¢ · {lastAutoSell.shares.toFixed(4)} sh
                  {lastAutoSell.orderId ? ` · oid ${lastAutoSell.orderId.slice(0, 6)}…${lastAutoSell.orderId.slice(-4)}` : ''}
                </span>
                {lastAutoSellAvgCallout}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {isSlide && showLedgerDock ? (
        <div className="mt-3 grid min-w-0 grid-cols-2 gap-2">
          <div className="min-w-0 rounded-lg border border-emerald-800/40 bg-emerald-950/20 px-2.5 py-2">
            <div className="truncate text-[9px] font-bold uppercase tracking-wide text-emerald-200/80">{upLabel}</div>
            <div className="mt-0.5 truncate font-mono text-[12px] tabular-nums text-zinc-100 sm:text-[13px]">
              {accountMode === 'paper'
                ? `${paperUpPos.shares.toFixed(1)} sh`
                : balUp != null
                  ? `${balUp.toFixed(1)} sh`
                  : balLoading
                    ? '…'
                    : '—'}
            </div>
            <div
              className="mt-0.5 truncate text-[9px] tabular-nums text-zinc-500 sm:text-[10px]"
              title={`@ ${
                accountMode === 'paper' && paperUpPos.avgCost01 != null && paperUpPos.avgCost01 > 0
                  ? fmtCents(paperUpPos.avgCost01)
                  : avgEntryUp != null
                    ? fmtCents(avgEntryUp)
                    : '—'
              } · mid ${fmtCents(midUpEff)}`}
            >
              @{' '}
              {accountMode === 'paper' && paperUpPos.avgCost01 != null && paperUpPos.avgCost01 > 0
                ? fmtCents(paperUpPos.avgCost01)
                : avgEntryUp != null
                  ? fmtCents(avgEntryUp)
                  : '—'}{' '}
              · mid {fmtCents(midUpEff)}
            </div>
          </div>
          <div className="min-w-0 rounded-lg border border-rose-800/40 bg-rose-950/20 px-2.5 py-2">
            <div className="truncate text-[9px] font-bold uppercase tracking-wide text-rose-200/80">{downLabel}</div>
            <div className="mt-0.5 truncate font-mono text-[12px] tabular-nums text-zinc-100 sm:text-[13px]">
              {accountMode === 'paper'
                ? `${paperDownPos.shares.toFixed(1)} sh`
                : balDown != null
                  ? `${balDown.toFixed(1)} sh`
                  : balLoading
                    ? '…'
                    : '—'}
            </div>
            <div
              className="mt-0.5 truncate text-[9px] tabular-nums text-zinc-500 sm:text-[10px]"
              title={`@ ${
                accountMode === 'paper' && paperDownPos.avgCost01 != null && paperDownPos.avgCost01 > 0
                  ? fmtCents(paperDownPos.avgCost01)
                  : avgEntryDown != null
                    ? fmtCents(avgEntryDown)
                    : '—'
              } · mid ${fmtCents(midDownEff)}`}
            >
              @{' '}
              {accountMode === 'paper' && paperDownPos.avgCost01 != null && paperDownPos.avgCost01 > 0
                ? fmtCents(paperDownPos.avgCost01)
                : avgEntryDown != null
                  ? fmtCents(avgEntryDown)
                  : '—'}{' '}
              · mid {fmtCents(midDownEff)}
            </div>
          </div>
        </div>
      ) : null}

      {!isSlide ? (
        lastAutoSell && Date.now() - lastAutoSell.ts <= 10 * 60_000 ? (
          <div
            className={`mt-3 rounded-xl border px-3 py-2 text-[12px] leading-snug ${
              lastAutoSell.status === 'filled'
                ? 'border-emerald-800/35 bg-emerald-950/20 text-emerald-100'
                : lastAutoSell.status === 'sent'
                  ? 'border-amber-800/35 bg-amber-950/15 text-amber-100'
                  : 'border-rose-800/35 bg-rose-950/15 text-rose-100'
            }`}
            title={lastAutoSell.msg ?? undefined}
          >
            <span className="font-black">
              {lastAutoSell.status === 'filled' ? 'AUTO-SOLD' : lastAutoSell.status === 'sent' ? 'AUTO-SELL SENT' : 'AUTO-SELL FAILED'}
            </span>{' '}
            <span className="font-mono">
              {lastAutoSell.kind === 'sl' ? 'SL' : 'TP'} stop {lastAutoSell.triggerCents.toFixed(1)}¢
              {lastAutoSell.refCents != null ? ` · bid ${lastAutoSell.refCents.toFixed(1)}¢` : ''} → limit{' '}
              {lastAutoSell.limitCents.toFixed(1)}¢ · {lastAutoSell.shares.toFixed(4)} sh
              {lastAutoSell.orderId ? ` · oid ${lastAutoSell.orderId.slice(0, 6)}…${lastAutoSell.orderId.slice(-4)}` : ''}
            </span>
            {lastAutoSellAvgCallout}
          </div>
        ) : null
      ) : null}

      {showOutcomeDock ? (
      <>
      {/* Outcome first, then brackets — slide dock matches Polymarket-style flow */}
      <div
        className={
          isSlide
            ? 'mt-4 flex w-full min-w-0 flex-col gap-4'
            : 'mt-6 flex w-full min-w-0 flex-col gap-6'
        }
      >
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Outcome</div>
        {!isSlide ? (
          <p className="mt-1 text-[11px] text-zinc-600">Pick side — mid follows the book.</p>
        ) : (
          <p className="mt-1 text-[11px] text-zinc-600">
            {action === 'sell' ? 'Tap outcome to sell, size, Execute.' : 'Tap side, size, Enter.'}
          </p>
        )}
        {isSlide && action === 'sell' ? (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => chooseLane('up')}
            className={`flex min-h-[92px] flex-col justify-between rounded-xl border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
              lane === 'up'
                ? 'border-emerald-500/90 bg-emerald-950/40 ring-2 ring-emerald-500/35'
                : 'border-zinc-800/70 bg-black/25 hover:bg-black/35'
            }`}
          >
            <OutcomeLaneHeader lane="up" label={upLabel} mode="sell" momentum={outcomeMomentumUp} />
            <span className="font-mono text-2xl font-black tabular-nums text-emerald-100">{fmtCents(midUpEff)}</span>
            <span className="text-[10px] text-zinc-500">
              Hold{' '}
              <span className="font-mono text-zinc-300">
                {accountMode === 'paper'
                  ? `${paperUpPos.shares.toFixed(2)} sh`
                  : balUp != null
                    ? `${balUp.toFixed(2)} sh`
                    : balLoading
                      ? '…'
                      : '—'}
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => chooseLane('down')}
            className={`flex min-h-[92px] flex-col justify-between rounded-xl border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
              lane === 'down'
                ? 'border-rose-500/85 bg-rose-950/35 ring-2 ring-rose-500/30'
                : 'border-zinc-800/70 bg-black/25 hover:bg-black/35'
            }`}
          >
            <OutcomeLaneHeader lane="down" label={downLabel} mode="sell" momentum={outcomeMomentumDown} />
            <span className="font-mono text-2xl font-black tabular-nums text-zinc-100">{fmtCents(midDownEff)}</span>
            <span className="text-[10px] text-zinc-500">
              Hold{' '}
              <span className="font-mono text-zinc-300">
                {accountMode === 'paper'
                  ? `${paperDownPos.shares.toFixed(2)} sh`
                  : balDown != null
                    ? `${balDown.toFixed(2)} sh`
                    : balLoading
                      ? '…'
                      : '—'}
              </span>
            </span>
          </button>
        </div>
        ) : (
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => chooseLane('up')}
            className={`rounded-xl border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
              isSlide ? 'min-h-[86px] px-3 py-3.5' : 'px-4 py-3.5'
            } flex flex-col justify-between ${
              lane === 'up'
                ? 'border-emerald-500/80 bg-emerald-950/35 ring-2 ring-emerald-500/30'
                : 'border-zinc-800/70 bg-black/20 hover:bg-black/30'
            }`}
          >
            <OutcomeLaneHeader lane="up" label={upLabel} momentum={outcomeMomentumUp} />
            <div className={`mt-1 font-black tabular-nums text-emerald-100 ${isSlide ? 'text-3xl' : 'text-2xl'}`}>{fmtCents(midUpEff)}</div>
            <div className="mt-0.5 text-[10px] font-mono text-zinc-500">{upToken ? `${upToken.slice(0, 6)}…${upToken.slice(-4)}` : '—'}</div>
            <div className="mt-1 text-[11px] text-zinc-500">
              You hold{' '}
              <span className="font-mono text-zinc-300">
                {accountMode === 'paper'
                  ? `${paperUpPos.shares.toFixed(2)} sh`
                  : balUp != null
                    ? `${balUp.toFixed(2)} sh`
                    : balLoading
                      ? '…'
                      : '—'}
              </span>
            </div>
          </button>
          <button
            type="button"
            onClick={() => chooseLane('down')}
            className={`rounded-xl border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
              isSlide ? 'min-h-[86px] px-3 py-3.5' : 'px-4 py-3.5'
            } flex flex-col justify-between ${
              lane === 'down'
                ? 'border-rose-500/75 bg-rose-950/25 ring-2 ring-rose-500/25'
                : 'border-zinc-800/70 bg-black/20 hover:bg-black/30'
            }`}
          >
            <OutcomeLaneHeader lane="down" label={downLabel} momentum={outcomeMomentumDown} />
            <div className={`mt-1 font-black tabular-nums text-zinc-100 ${isSlide ? 'text-3xl' : 'text-2xl'}`}>{fmtCents(midDownEff)}</div>
            <div className="mt-0.5 text-[10px] font-mono text-zinc-500">{downToken ? `${downToken.slice(0, 6)}…${downToken.slice(-4)}` : '—'}</div>
            <div className="mt-1 text-[11px] text-zinc-500">
              You hold{' '}
              <span className="font-mono text-zinc-300">
                {accountMode === 'paper'
                  ? `${paperDownPos.shares.toFixed(2)} sh`
                  : balDown != null
                    ? `${balDown.toFixed(2)} sh`
                    : balLoading
                      ? '…'
                      : '—'}
              </span>
            </div>
          </button>
        </div>
        )}
        {action === 'buy' ? (
          <div className={isSlide ? 'mt-3' : 'mt-4'}>{renderSecondaryBuyCta('compact')}</div>
        ) : null}
      </div>

      {!isSlide && bracketsDockPanel}

      </div>

      {action === 'buy' ? (
        <>
          {!isSlide ? (
            <div className="mt-6 rounded-3xl border border-zinc-700/40 bg-[#0b0f16] p-4 shadow-inner shadow-black/20 ring-1 ring-white/[0.04]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Order · limit mode</div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="min-h-[36px] rounded-lg border border-zinc-700/60 bg-black/20 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-black/30"
                >
                  {showAdvanced ? 'Hide advanced' : 'Advanced'}
                </button>
              </div>
              <div className="mt-2 rounded-2xl border border-zinc-800/55 bg-black/25 px-3 py-3">
                <p className="mb-2 text-[10px] leading-snug text-zinc-500">Quick ≈ touch quote · Custom = your ¢.</p>
                <TradeSegmentedControl
                  value={execMode}
                  onChange={(v) => {
                    const next = v as 'touch' | 'limit';
                    setExecMode(next);
                    setErr(null);
                    setOkMsg(null);
                    if (next === 'touch' && touchLimitCents) setLimitPriceCents(touchLimitCents);
                    else if (next === 'limit' && defaultLimitCents) setLimitPriceCents(defaultLimitCents);
                  }}
                  options={[
                    { value: 'touch', label: 'Quick', title: 'Resting limit priced tight to the quote' },
                    { value: 'limit', label: 'Custom', title: 'You set the limit price in cents' },
                  ]}
                />
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Order type</div>
              <div className="mt-2 rounded-xl border border-zinc-800/60 bg-zinc-950/30 px-3 py-3">
                <p className="mb-2 text-[10px] leading-snug text-zinc-500">Limit-only — quick vs custom ¢.</p>
                <TradeSegmentedControl
                  value={execMode}
                  onChange={(v) => {
                    const next = v as 'touch' | 'limit';
                    setExecMode(next);
                    setErr(null);
                    setOkMsg(null);
                    if (next === 'touch' && touchLimitCents) setLimitPriceCents(touchLimitCents);
                    else if (next === 'limit' && defaultLimitCents) setLimitPriceCents(defaultLimitCents);
                  }}
                  options={[
                    { value: 'touch', label: 'Quick', title: 'Resting limit priced tight to the quote' },
                    { value: 'limit', label: 'Custom', title: 'You set the limit price in cents' },
                  ]}
                  className="w-full"
                  size="md"
                />
              </div>
            </div>
          )}

          {!isSlide && showAdvanced ? (
            <details className="mt-4 rounded-xl border border-zinc-800/60 bg-zinc-950/30" open>
              <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-zinc-400 hover:text-zinc-300">
                Advanced entry tools · order book + ladder
              </summary>
              <div className="border-t border-zinc-800/50 px-3 py-3">
                <div className="mt-4 space-y-2">
            <div className="mt-0 rounded-xl border border-zinc-800/70 bg-zinc-950/25 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">From the book</div>
                <div className="flex flex-wrap gap-1.5 text-[10px] font-mono text-zinc-400">
                  <span className="rounded border border-zinc-800/60 bg-black/20 px-1.5 py-0.5" title="Best bid (info)">
                    Bid {bookTouch?.bestBid != null ? `${(bookTouch.bestBid * 100).toFixed(1)}¢` : '—'}
                  </span>
                  <span className="rounded border border-zinc-800/60 bg-black/20 px-1.5 py-0.5" title="Best ask (info)">
                    Ask {bookTouch?.bestAsk != null ? `${(bookTouch.bestAsk * 100).toFixed(1)}¢` : '—'}
                  </span>
                  <span className="rounded border border-zinc-800/60 bg-black/20 px-1.5 py-0.5" title="Spread">
                    Spr{' '}
                    {bookTouch?.bestBid != null && bookTouch?.bestAsk != null
                      ? `${Math.max(0, Math.round((bookTouch.bestAsk - bookTouch.bestBid) * 1000) / 10).toFixed(1)}¢`
                      : '—'}
                  </span>
                </div>
              </div>
              <p className="mt-1.5 text-[11px] leading-snug text-zinc-500">
                Hit the ask or post a bid. Optional level ladder below.
              </p>

              <div className="mt-3 rounded-xl border border-zinc-800/60 bg-black/20 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Quick size</div>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-800/70 bg-black/25 px-3 py-2">
                    <span className="text-[11px] font-semibold text-zinc-400">Shares</span>
                    <input
                      value={buyNowShares}
                      onChange={(e) => setBuyNowShares(e.target.value)}
                      inputMode="decimal"
                      className="min-w-0 flex-1 bg-transparent text-right font-mono text-[13px] font-semibold text-zinc-100 outline-none"
                      placeholder="5"
                    />
                  </label>
                  <div className="flex flex-wrap gap-1">
                    {([5, 10, 25, 50] as const).map((n) => (
                      <button
                        key={`book-sh-${n}`}
                        type="button"
                        onClick={() => setBuyNowShares(String(n))}
                        className="rounded-lg border border-zinc-700/60 bg-zinc-900/40 px-2 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-800/60"
                      >
                        {n}
                      </button>
                    ))}
                    <button
                      type="button"
                      disabled={estShares == null || !Number.isFinite(estShares) || estShares <= 0}
                      title="Copy estimated shares from your main order size above"
                      onClick={() => {
                        if (estShares == null || !Number.isFinite(estShares) || estShares <= 0) return;
                        setBuyNowShares(String(Math.max(0.01, floorShares4(estShares))));
                      }}
                      className="rounded-lg border border-emerald-800/45 bg-emerald-950/25 px-2 py-1.5 text-[11px] font-bold text-emerald-100 hover:bg-emerald-950/40 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      = order
                    </button>
                  </div>
                  <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-800/70 bg-black/25 px-3 py-2">
                    <span className="text-[11px] font-semibold text-zinc-400">Bid (¢)</span>
                    <input
                      value={buyBidCents}
                      onChange={(e) => setBuyBidCents(e.target.value)}
                      inputMode="decimal"
                      className="min-w-0 flex-1 bg-transparent text-right font-mono text-[13px] font-semibold text-zinc-100 outline-none"
                      placeholder="74.0"
                    />
                  </label>
                  <div className="flex w-full flex-wrap gap-1.5 sm:w-auto">
                    <button
                      type="button"
                      className="rounded-lg border border-zinc-700/60 bg-black/20 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-black/30"
                      disabled={bookTouch?.bestAsk == null}
                      title="Set bid to best ask - 1¢"
                      onClick={() => {
                        if (bookTouch?.bestAsk == null) return;
                        setBuyBidCents(Math.max(1, Math.min(99, Math.round(bookTouch.bestAsk * 100 - 1))).toFixed(0));
                      }}
                    >
                      Ask−1¢
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-zinc-700/60 bg-black/20 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-black/30"
                      disabled={bookTouch?.bestAsk == null}
                      title="Set bid to best ask - 2¢"
                      onClick={() => {
                        if (bookTouch?.bestAsk == null) return;
                        setBuyBidCents(Math.max(1, Math.min(99, Math.round(bookTouch.bestAsk * 100 - 2))).toFixed(0));
                      }}
                    >
                      Ask−2¢
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-zinc-700/60 bg-black/20 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-black/30"
                      disabled={bookTouch?.bestAsk == null}
                      title="Set bid to best ask - 5¢"
                      onClick={() => {
                        if (bookTouch?.bestAsk == null) return;
                        setBuyBidCents(Math.max(1, Math.min(99, Math.round(bookTouch.bestAsk * 100 - 5))).toFixed(0));
                      }}
                    >
                      Ask−5¢
                    </button>
                  </div>
                  <button
                    type="button"
                    disabled={busySubmit || !token?.trim() || action !== 'buy' || bookTouch?.bestAsk == null || !Number.isFinite(Number(buyNowShares)) || Number(buyNowShares) <= 0}
                    className="min-h-[44px] rounded-xl bg-emerald-400 px-4 text-[12px] font-bold text-black hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
                    title="Buys at the current best ask level (exact price), then auto-cancels if not filled quickly."
                    onClick={async () => {
                      if (submitLockRef.current) return;
                      submitLockRef.current = true;
                      setErr(null);
                      setOkMsg(null);
                      if (!token?.trim()) {
                        submitLockRef.current = false;
                        return;
                      }
                      const bestAsk = bookTouch?.bestAsk;
                      const sharesReq = Number(buyNowShares);
                      if (bestAsk == null || !Number.isFinite(bestAsk) || !Number.isFinite(sharesReq) || sharesReq <= 0) {
                        submitLockRef.current = false;
                        return;
                      }
                      setBusySubmit(true);
                      try {
                        if (accountMode === 'paper') {
                          const r = paperTrade({ account: paperAccount, tokenId: token, side: 'buy', shares: sharesReq, price01: bestAsk });
                          if (!r.ok) setErr(r.error);
                          else {
                            setPaperAccount(r.account);
                            setHistoryRows(
                              appendTradeHistory({
                                ...tradeHistoryMarketMeta,
                                mode: 'paper',
                                exec: 'limit',
                                side: 'buy',
                                token,
                                label,
                                price01: r.fill.price01,
                                shares: r.fill.shares,
                                usdCents: Math.abs(r.fill.usdCents),
                                status: 'filled',
                              }),
                            );
                            setOkMsg(`Bought ${r.fill.shares.toFixed(2)} ${label} @ ${(r.fill.price01 * 100).toFixed(1)}¢`);
                            applyArmRiskAfterBuyFill(r.fill.price01, r.fill.shares);
                          }
                          return;
                        }

                        liveSubmitGenRef.current += 1;
                        const quoted01 = roundPrice01(bestAsk);
                        const mark01 = mid != null && mid > 0 ? roundPrice01(mid) : null;
                        const optimistic = appendTradeHistoryWithId({
                          ...tradeHistoryMarketMeta,
                          mode: 'live',
                          exec: 'limit',
                          side: 'buy',
                          token,
                          label,
                          price01: quoted01,
                          quotedPrice01: quoted01,
                          intendedPrice01: bestAsk,
                          submittedPrice01: null,
                          fillAvgPrice01: null,
                          markPrice01: mark01,
                          shares: sharesReq,
                          requestedShares: sharesReq,
                          remainingShares: sharesReq,
                          usdCents: Math.abs(Math.round(bestAsk * sharesReq * 100)),
                          status: 'sending',
                        });
                        setHistoryRows(optimistic.rows);
                        const tClient0 = performance.now();
                        const marketUsd = marketBuyUsdFromIntent({
                          unit: 'shares',
                          dollars: 0,
                          shares: sharesReq,
                          refAsk01: bestAsk,
                        });
                        if (!(marketUsd >= 1)) {
                          setErr('Market buy notional must be at least $1 pUSD.');
                          setHistoryRows(
                            updateTradeHistoryRow(optimistic.id, {
                              status: 'failed',
                              error: 'bad_amount · min $1',
                            }),
                          );
                          return;
                        }
                        const res = await tradeMarketOrderWithOpts(
                          {
                            token,
                            side: 'buy',
                            amount: marketUsd,
                            signatureType: null,
                            marketSlug: marketSlug ?? '',
                            outcome: resolvedBullpenOutcome,
                            lane,
                          },
                          { timeoutMs: 25_000 },
                        );
                        const clientMs = Math.round(performance.now() - tClient0);
                        if (!isOk(res)) {
                          const e = res as ApiErr;
                          setErr(formatTradeApiError(e));
                          setHistoryRows(
                            updateTradeHistoryRow(optimistic.id, {
                              status: 'failed',
                              error: `${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`,
                            }),
                          );
                          return;
                        }
                        const { result, execution } = unwrapTradeActionData(res.data);
                        const oid = execution?.order_id ?? extractOrderIdFromClobPayload(result);
                        const rt = mergeRoundTripMs(execution?.round_trip_ms, clientMs);
                        setLastExecLatencyMs(rt);
                        setHistoryRows(
                          updateTradeHistoryRow(optimistic.id, {
                            status: 'sent',
                            shares: 0,
                            requestedShares: sharesReq,
                            remainingShares: sharesReq,
                            submittedPrice01: execution?.submitted_price_01 ?? null,
                            orderId: oid ?? undefined,
                            roundTripMs: rt,
                            price01: quoted01,
                            error: undefined,
                          }),
                        );
                        setOkMsg(`Market buy submitted · best available (ref ${(bestAsk * 100).toFixed(1)}¢) — confirming…`);
                        scheduleTruthRefreshBurst(token, oid ?? null, () => afterLiveBuyRowReconcile(optimistic.id));
                      } finally {
                        setBusySubmit(false);
                        submitLockRef.current = false;
                      }
                    }}
                  >
                    Buy best ask
                  </button>
                  <button
                    type="button"
                    disabled={
                      busySubmit ||
                      !token?.trim() ||
                      action !== 'buy' ||
                      !Number.isFinite(Number(buyNowShares)) ||
                      Number(buyNowShares) <= 0 ||
                      buyBidCents.trim() === '' ||
                      !Number.isFinite(Number(buyBidCents)) ||
                      Number(buyBidCents) <= 0
                    }
                    className="min-h-[44px] rounded-xl border border-zinc-700/60 bg-black/20 px-4 text-[12px] font-bold text-zinc-100 hover:bg-black/30 disabled:cursor-not-allowed disabled:opacity-40"
                    title="Places a resting limit bid at your price (fills only if sellers hit you)."
                    onClick={async () => {
                      if (submitLockRef.current) return;
                      submitLockRef.current = true;
                      setErr(null);
                      setOkMsg(null);
                      if (!token?.trim()) {
                        submitLockRef.current = false;
                        return;
                      }
                      const sharesReq = Number(buyNowShares);
                      const pxC = Number(buyBidCents);
                      const px01 = clamp01(pxC / 100);
                      if (!Number.isFinite(sharesReq) || sharesReq <= 0 || !Number.isFinite(px01) || px01 <= 0 || px01 >= 1) {
                        submitLockRef.current = false;
                        return;
                      }
                      setBusySubmit(true);
                      try {
                        if (accountMode === 'paper') {
                          const o = addPaperOrder({ tokenId: token, side: 'buy', limit01: px01, shares: sharesReq });
                          setHistoryRows(
                            appendTradeHistory({
                              ...tradeHistoryMarketMeta,
                              id: o.id,
                              ts: o.createdAt,
                              mode: 'paper',
                              exec: 'limit',
                              side: 'buy',
                              token,
                              label,
                              price01: px01,
                              shares: sharesReq,
                              usdCents: Math.abs(Math.round(px01 * sharesReq * 100)),
                              status: 'sent',
                            }),
                          );
                          setOkMsg(`Bid placed: buy ${sharesReq.toFixed(2)} ${label} @ ${(px01 * 100).toFixed(1)}¢ (waiting)`);
                          return;
                        }

                        liveSubmitGenRef.current += 1;
                        const quoted01 = roundPrice01(px01);
                        const mark01 = mid != null && mid > 0 ? roundPrice01(mid) : null;
                        const optimistic = appendTradeHistoryWithId({
                          ...tradeHistoryMarketMeta,
                          mode: 'live',
                          exec: 'limit',
                          side: 'buy',
                          token,
                          label,
                          price01: quoted01,
                          quotedPrice01: quoted01,
                          intendedPrice01: px01,
                          submittedPrice01: null,
                          fillAvgPrice01: null,
                          markPrice01: mark01,
                          shares: sharesReq,
                          requestedShares: sharesReq,
                          remainingShares: sharesReq,
                          usdCents: Math.abs(Math.round(px01 * sharesReq * 100)),
                          status: 'sending',
                        });
                        setHistoryRows(optimistic.rows);
                        const tClient0 = performance.now();
                        const res = await tradeCreateOrderWithOpts(
                          { token, side: 'buy', price: px01, size: sharesReq, signatureType: null, marketSlug: marketSlug ?? '', outcome: resolvedBullpenOutcome,
            lane },
                          { timeoutMs: 25_000 },
                        );
                        const clientMs = Math.round(performance.now() - tClient0);
                        if (!isOk(res)) {
                          const e = res as ApiErr;
                          setErr(formatTradeApiError(e));
                          setHistoryRows(
                            updateTradeHistoryRow(optimistic.id, {
                              status: 'failed',
                              error: `${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`,
                            }),
                          );
                          return;
                        }
                        const { result, execution } = unwrapTradeActionData(res.data);
                        const oid = execution?.order_id ?? extractOrderIdFromClobPayload(result);
                        const rt = mergeRoundTripMs(execution?.round_trip_ms, clientMs);
                        setLastExecLatencyMs(rt);
                        setHistoryRows(
                          updateTradeHistoryRow(optimistic.id, {
                            status: 'sent',
                            submittedPrice01: null,
                            orderId: oid ?? undefined,
                            roundTripMs: rt,
                            price01: quoted01,
                            error: undefined,
                          }),
                        );
                        if (oid) pollRestingOrderFill(optimistic.id, oid, sharesReq, px01, quoted01);
                        setOkMsg(`Bid placed · intended ${(px01 * 100).toFixed(1)}¢ — reading exchange state…`);
                        scheduleTruthRefreshBurst(token, oid ?? null, () => afterLiveBuyRowReconcile(optimistic.id));
                      } finally {
                        setBusySubmit(false);
                        submitLockRef.current = false;
                      }
                    }}
                  >
                    Place bid
                  </button>
                </div>
              </div>

              <details className="mt-3 rounded-xl border border-zinc-800/60 bg-black/20">
                <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-zinc-300 hover:text-zinc-100">
                  Show price levels (optional)
                </summary>
                <div className="border-t border-zinc-800/50">
                <div className="grid grid-cols-[88px_1fr_92px_96px_112px] gap-2 border-b border-zinc-800/50 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  <span>Price</span>
                  <span>Avail</span>
                  <span className="text-right">Cum</span>
                  <span className="text-right">Take</span>
                  <span className="text-right">Action</span>
                </div>
                <div className="max-h-64 overflow-auto divide-y divide-zinc-800/25">
                  {pickLadder.map((l, i) => {
                    const key = `${action}-${l.price.toFixed(6)}`;
                    const selected = pickSelected[key] ?? { price01: l.price, maxShares: l.size, takeShares: '' };
                    const takeNumRaw = Number(selected.takeShares);
                    const takeNum =
                      Number.isFinite(takeNumRaw) && takeNumRaw > 0 ? Math.min(takeNumRaw, l.size) : Math.min(5, Math.max(0, l.size));
                    const cancelMs = Math.max(250, Math.min(5000, Math.floor(Number(pickAutoCancelMs) || 1500)));
                    const cumShares = pickLadder.slice(0, i + 1).reduce((acc, x) => acc + (Number.isFinite(x.size) ? x.size : 0), 0);
                    const deltaFromTopCents =
                      action === 'buy'
                        ? bookTouch?.bestAsk != null
                          ? (l.price - bookTouch.bestAsk) * 100
                          : null
                        : bookTouch?.bestBid != null
                          ? (bookTouch.bestBid - l.price) * 100
                          : null;
                    return (
                      <div key={`${key}-${i}`} className="grid grid-cols-[88px_1fr_92px_96px_112px] items-center gap-2 px-3 py-2">
                        <div className="font-mono text-[12px] tabular-nums text-zinc-200" title={deltaFromTopCents != null ? `Δ vs top: ${deltaFromTopCents >= 0 ? '+' : ''}${deltaFromTopCents.toFixed(1)}¢` : undefined}>
                          {(l.price * 100).toFixed(1)}¢
                        </div>
                        <div className="font-mono text-[12px] tabular-nums text-zinc-300">{fmtShares(l.size, 'full')} sh</div>
                        <div className="text-right font-mono text-[11px] tabular-nums text-zinc-500">{fmtShares(cumShares, 'full')}</div>
                        <input
                          value={selected.takeShares}
                          onChange={(e) => {
                            const v = e.target.value;
                            setPickSelected((prev) => ({ ...prev, [key]: { price01: l.price, maxShares: l.size, takeShares: v } }));
                          }}
                          inputMode="decimal"
                          className="w-full rounded-md border border-zinc-800/70 bg-black/25 px-2 py-1 text-right font-mono text-[12px] text-zinc-100 outline-none"
                          placeholder={`${Math.min(5, Math.max(0, l.size)).toFixed(2)}`}
                        />
                        <button
                          type="button"
                          disabled={busySubmit || !token?.trim() || takeNum <= 0}
                          className="justify-self-end rounded-lg border border-emerald-700/45 bg-emerald-950/25 px-3 py-1.5 text-[11px] font-bold text-emerald-100 hover:bg-emerald-950/35 disabled:cursor-not-allowed disabled:opacity-40"
                          title={`Take up to ${takeNum.toFixed(2)} sh @ ${(l.price * 100).toFixed(1)}¢ (auto-cancel ~${cancelMs}ms)`}
                          onClick={async () => {
                            if (submitLockRef.current) return;
                            submitLockRef.current = true;
                            setErr(null);
                            setOkMsg(null);
                            if (!token?.trim()) {
                              submitLockRef.current = false;
                              return;
                            }
                            setBusySubmit(true);
                            try {
                              if (accountMode === 'paper') {
                                const r = paperTrade({ account: paperAccount, tokenId: token, side: 'buy', shares: takeNum, price01: l.price });
                                if (!r.ok) setErr(r.error);
                                else {
                                  setPaperAccount(r.account);
                                  setHistoryRows(
                                    appendTradeHistory({
                                      ...tradeHistoryMarketMeta,
                                      mode: 'paper',
                                      exec: 'limit',
                                      side: 'buy',
                                      token,
                                      label,
                                      price01: r.fill.price01,
                                      shares: r.fill.shares,
                                      usdCents: Math.abs(r.fill.usdCents),
                                      status: 'filled',
                                    }),
                                  );
                                  setOkMsg(`Bought ${r.fill.shares.toFixed(2)} ${label} @ ${(r.fill.price01 * 100).toFixed(1)}¢`);
                                  applyArmRiskAfterBuyFill(r.fill.price01, r.fill.shares);
                                }
                                return;
                              }

                              const res = await tradeCreateOrderWithOpts(
                                { token, side: 'buy', price: l.price, size: takeNum, signatureType: null, marketSlug: marketSlug ?? '', outcome: resolvedBullpenOutcome,
            lane },
                                { timeoutMs: 25_000 },
                              );
                              if (!isOk(res)) {
                                const e = res as ApiErr;
                                setErr(formatTradeApiError(e));
                                return;
                              }
                              const { result, execution } = unwrapTradeActionData(res.data);
                              const oid = execution?.order_id ?? extractOrderIdFromClobPayload(result);
                              setHistoryRows(
                                appendTradeHistory({
                                  ...tradeHistoryMarketMeta,
                                  mode: 'live',
                                  exec: 'limit',
                                  side: 'buy',
                                  token,
                                  label,
                                  price01: l.price,
                                  shares: takeNum,
                                  usdCents: Math.abs(Math.round(l.price * takeNum * 100)),
                                  status: 'sent',
                                  orderId: oid ?? null,
                                }),
                              );
                              if (oid) {
                                window.setTimeout(() => {
                                  void tradeCancelOrder(oid);
                                }, cancelMs);
                              }
                              setOkMsg(`Buy now sent ${takeNum.toFixed(2)} ${label} @ ${(l.price * 100).toFixed(1)}¢`);
                            } finally {
                              setBusySubmit(false);
                              submitLockRef.current = false;
                            }
                          }}
                        >
                          Buy now
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
              </details>

            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Size mode</span>
              <TradeSegmentedControl
                value={buyEntryMode}
                onChange={(v) => {
                  setBuyEntryMode(v as 'single' | 'passive');
                  setErr(null);
                  setOkMsg(null);
                }}
                options={[
                  { value: 'single', label: 'One order', title: 'Main buy button below' },
                  { value: 'passive', label: 'Ladder', title: 'Split into several resting bids' },
                ]}
              />
            </div>
            {buyEntryMode === 'passive' ? (
              <div className="rounded-xl border border-zinc-800/70 bg-zinc-950/25 p-3">
                <div className="grid gap-2 sm:grid-cols-4">
                  <label className="text-[11px] font-semibold text-zinc-400">
                    Target (¢)
                    <input
                      value={passiveTargetCents}
                      onChange={(e) => setPassiveTargetCents(e.target.value)}
                      inputMode="numeric"
                      className="mt-1 w-full rounded-lg border border-zinc-800/70 bg-black/25 px-2 py-2 font-mono text-[13px] text-zinc-100 outline-none focus:border-zinc-600/70"
                      placeholder="74"
                    />
                  </label>
                  <label className="text-[11px] font-semibold text-zinc-400">
                    Total shares
                    <input
                      value={passiveTotalShares}
                      onChange={(e) => setPassiveTotalShares(e.target.value)}
                      inputMode="decimal"
                      className="mt-1 w-full rounded-lg border border-zinc-800/70 bg-black/25 px-2 py-2 font-mono text-[13px] text-zinc-100 outline-none focus:border-zinc-600/70"
                      placeholder="60"
                    />
                  </label>
                  <label className="text-[11px] font-semibold text-zinc-400">
                    Chunks
                    <input
                      value={passiveChunks}
                      onChange={(e) => setPassiveChunks(e.target.value)}
                      inputMode="numeric"
                      className="mt-1 w-full rounded-lg border border-zinc-800/70 bg-black/25 px-2 py-2 font-mono text-[13px] text-zinc-100 outline-none focus:border-zinc-600/70"
                      placeholder="8"
                    />
                  </label>
                  <label className="text-[11px] font-semibold text-zinc-400">
                    Levels
                    <input
                      value={passiveLevels}
                      onChange={(e) => setPassiveLevels(e.target.value)}
                      inputMode="text"
                      className="mt-1 w-full rounded-lg border border-zinc-800/70 bg-black/25 px-2 py-2 font-mono text-[13px] text-zinc-100 outline-none focus:border-zinc-600/70"
                      placeholder="74,73,72"
                    />
                  </label>
                </div>

                <p className="mt-2 text-[11px] leading-snug text-zinc-500">
                  Splits size into small resting bids (not for Market mode on live).
                </p>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[11px] text-zinc-400">
                    {passiveLadder
                      ? `~${passiveLadder.perChunkShares.toFixed(2)} sh × ${passiveLadder.chunks} orders`
                      : 'Enter valid ladder params'}
                  </div>
                  <button
                    type="button"
                    disabled={busySubmit || passiveLadder == null || !token?.trim()}
                    className={`rounded-xl border px-4 py-2 text-[12px] font-bold disabled:cursor-not-allowed disabled:opacity-40 ${
                      action === 'buy'
                        ? 'border-emerald-800/45 bg-emerald-950/25 text-emerald-100 hover:bg-emerald-950/35'
                        : 'border-rose-800/40 bg-rose-950/20 text-rose-100 hover:bg-rose-950/30'
                    }`}
                    title={action === 'buy' ? 'Place multiple small limit bids.' : 'Place multiple small limit asks.'}
                    onClick={async () => {
                      if (submitLockRef.current) return;
                      submitLockRef.current = true;
                      setErr(null);
                      setOkMsg(null);
                      if (!passiveLadder || !token?.trim()) {
                        submitLockRef.current = false;
                        return;
                      }
                      setBusySubmit(true);
                      try {
                        // Passive ladder always uses limit style (resting orders).
                        setExecMode('limit');
                        const created: { price01: number; shares: number; id?: string }[] = [];
                        if (accountMode === 'paper') {
                          for (const leg of passiveLadder.plan) {
                            const o = addPaperOrder({ tokenId: token, side: action, limit01: leg.price01, shares: leg.shares });
                            created.push({ price01: leg.price01, shares: leg.shares, id: o.id });
                            setHistoryRows(
                              appendTradeHistory({
                                ...tradeHistoryMarketMeta,
                                id: o.id,
                                ts: o.createdAt,
                                mode: 'paper',
                                exec: 'limit',
                                side: action,
                                token,
                                label,
                                price01: leg.price01,
                                shares: leg.shares,
                                usdCents: Math.abs(Math.round(leg.price01 * leg.shares * 100)),
                                status: 'sent',
                              }),
                            );
                          }
                          setOkMsg(`Paper ladder placed: ${created.length} ${action === 'buy' ? 'bids' : 'asks'} around ${passiveLadder.targetCents}¢`);
                          return;
                        }

                        // Live: place multiple small GTC limit orders (resting).
                        for (const leg of passiveLadder.plan) {
                          const res = await tradeCreateOrderWithOpts(
                            { token, side: action, price: leg.price01, size: leg.shares, signatureType: null, marketSlug: marketSlug ?? '', outcome: resolvedBullpenOutcome,
            lane },
                            { timeoutMs: 25_000 },
                          );
                          if (!isOk(res)) {
                            const e = res as ApiErr;
                            setErr(formatTradeApiError(e));
                            break;
                          }
                          created.push({ price01: leg.price01, shares: leg.shares });
                          // Record an optimistic row; fill reconciliation uses order polling on the regular flow.
                          setHistoryRows(
                            appendTradeHistory({
                              ...tradeHistoryMarketMeta,
                              mode: 'live',
                              exec: 'limit',
                              side: action,
                              token,
                              label,
                              price01: leg.price01,
                              shares: leg.shares,
                              usdCents: Math.abs(Math.round(leg.price01 * leg.shares * 100)),
                              status: 'sent',
                            }),
                          );
                        }
                        if (created.length > 0) {
                          setOkMsg(
                            `Ladder placed: ${created.length} resting ${action === 'buy' ? 'bids' : 'asks'} around ${passiveLadder.targetCents}¢`,
                          );
                        }
                      } finally {
                        setBusySubmit(false);
                        submitLockRef.current = false;
                      }
                    }}
                  >
                    Place ladder {action === 'buy' ? 'bids' : 'asks'}
                  </button>
                </div>
              </div>
            ) : null}
              </div>
            </div>
            </details>
          ) : null}

          <div className="mt-2 flex flex-wrap items-end justify-between gap-2 text-xs text-zinc-400">
            <span className="font-semibold text-zinc-300">Amount</span>
            <span className="min-w-[5.5rem] text-right font-mono tabular-nums text-zinc-500" title="USDC available for buys">
              {accountMode === 'paper'
                ? `Cash ${fmtUsdCents(paperAccount.cashUsdCents)}`
                : availUsdc != null
                  ? `Cash $${availUsdc.toFixed(2)}`
                  : balLoading
                    ? 'Loading…'
                    : 'Cash —'}
            </span>
          </div>

          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-stretch">
            <div className="flex min-h-[52px] min-w-0 flex-1 items-center rounded-xl border border-zinc-800/70 bg-black/25 pl-3 pr-2 ring-1 ring-white/[0.02] focus-within:border-zinc-600/70 focus-within:ring-amber-500/20">
              <span className="shrink-0 text-lg font-bold text-zinc-500" aria-hidden>
                {unit === 'dollars' ? '$' : ''}
              </span>
              <input
                id={idAmount}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                aria-label={unit === 'dollars' ? 'Buy amount in dollars' : 'Buy size in shares'}
                className="min-h-[48px] min-w-0 flex-1 bg-transparent px-2 text-lg font-semibold tabular-nums text-zinc-100 outline-none"
                placeholder={unit === 'dollars' ? '10' : '10'}
              />
              <div className="flex shrink-0 gap-0.5 rounded-lg border border-zinc-800/60 bg-zinc-950/80 p-0.5">
                <button
                  type="button"
                  onClick={() => setUnitBuy('dollars')}
                  className={`rounded-md px-2.5 py-1.5 text-[11px] font-bold ${
                    unit === 'dollars' ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  $
                </button>
                <button
                  type="button"
                  onClick={() => setUnitBuy('shares')}
                  className={`rounded-md px-2.5 py-1.5 text-[11px] font-bold ${
                    unit === 'shares' ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  sh
                </button>
              </div>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            {(
              [
                { label: '5%', pct: 0.05 },
                { label: '15%', pct: 0.15 },
                { label: '25%', pct: 0.25 },
                { label: '50%', pct: 0.5 },
                { label: '100%', pct: 1 },
              ] as const
            ).map(({ label, pct }) => (
              <button
                key={label}
                type="button"
                disabled={!canSizeBuy}
                onMouseDown={preventSizeBtnScroll}
                onClick={() => applyBuyCashPct(pct)}
                className="min-h-[40px] rounded-lg border border-zinc-800/70 bg-black/25 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-black/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/35 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void applyMaxBuy()}
              disabled={!canSizeBuy || maxBuyBusy}
              aria-busy={maxBuyBusy}
              title={
                outcomeLocked
                  ? `Disabled: market looks locked at ${midIsExtremeLow ? '0¢' : midIsExtremeHigh ? '100¢' : '—'}`
                  : maxBuyDisabledReason ?? 'Use all available cash'
              }
              className="min-h-[40px] rounded-lg border border-zinc-600/80 bg-zinc-900/60 px-4 py-2 text-xs font-semibold text-zinc-100 hover:bg-zinc-800/80 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Max
            </button>
          </div>

          <div
            className={`mt-2 flex flex-wrap gap-2 ${unit === 'dollars' ? '' : 'pointer-events-none invisible'}`}
            aria-hidden={unit !== 'dollars'}
          >
            {[100, 200, 300, 400, 500, 750, 1000].map((n) => {
              const cash = availableBuyUsd ?? 0;
              const capped = cash > 0 && n > cash;
              return (
                <button
                  key={`usd-${n}`}
                  type="button"
                  disabled={!canSizeBuy}
                  onMouseDown={preventSizeBtnScroll}
                  onClick={() => applyBuyUsdPreset(n)}
                  title={capped ? `Clamped to available $${cash.toFixed(2)}` : undefined}
                  className={`min-h-[40px] rounded-lg border px-3 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/35 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${
                    isSlide
                      ? 'border-emerald-800/50 bg-emerald-950/25 text-emerald-100 hover:bg-emerald-950/40'
                      : 'border-zinc-800/70 bg-black/25 text-zinc-200 hover:bg-black/40'
                  }`}
                >
                  ${n}
                </button>
              );
            })}
          </div>

          <div className="mt-1.5 min-h-[1.25rem]" aria-live="polite">
            {buyMaxAffordableHint ? (
              <p className="text-[11px] font-mono tabular-nums text-zinc-500">{buyMaxAffordableHint} · auto-sized to cash</p>
            ) : null}
          </div>

          <div className="mt-3">{renderSecondaryBuyCta('compact')}</div>

          {executionBrief && !isSlide ? (
            <div
              className={`mt-3 rounded-xl border px-3 py-2 text-[11px] leading-relaxed ${
                executionBrief.tier === 'A'
                  ? 'border-emerald-800/45 bg-emerald-950/15 text-emerald-100/95'
                  : executionBrief.tier === 'B'
                    ? 'border-amber-800/40 bg-amber-950/12 text-amber-100/90'
                    : executionBrief.tier === 'C'
                      ? 'border-zinc-800/60 bg-black/20 text-zinc-400'
                      : 'border-rose-800/45 bg-rose-950/15 text-rose-100/90'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-bold tracking-wide">Setup tier {executionBrief.tier}</span>
                <span className="font-mono text-[10px] text-zinc-500">{executionBrief.composite}</span>
              </div>
              <p className="mt-1 font-semibold text-zinc-100">{executionBrief.headline}</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div>
                  <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">When to add</div>
                  <ul className="mt-0.5 list-inside list-disc space-y-0.5 text-[10px] text-zinc-400">
                    {executionBrief.enter.slice(0, 3).map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">When to cut</div>
                  <ul className="mt-0.5 list-inside list-disc space-y-0.5 text-[10px] text-zinc-400">
                    {executionBrief.exit.slice(0, 3).map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
              </div>
              <p className="mt-1.5 text-[9px] text-zinc-600">{executionBrief.footnote}</p>
            </div>
          ) : null}

          {action === 'buy' && ptbContext && !isSlide ? (
            <div className="mt-3 rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2 text-[11px] text-zinc-400">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold text-zinc-300">
                  Desk tape: {ptbContext.readinessState ?? 'WAIT'}
                  {ptbContext.readinessLane ? ` · ${ptbContext.readinessLane === 'up' ? upLabel : downLabel}` : ''}
                </div>
                <label className="inline-flex items-center gap-2 text-[10px] font-semibold text-zinc-400">
                  <input
                    type="checkbox"
                    checked={autoSizeSetup}
                    onChange={(e) => setAutoSizeSetup(e.target.checked)}
                  />
                  Quarter size while in SETUP
                </label>
              </div>
              <div className="mt-1 min-h-[1.25rem]">
                {chopAdvisory ? (
                  <div className="text-amber-200/85">
                    Chop / NO_EDGE on tape — desk suggests smaller size or wider limits; touch buys are not blocked.
                  </div>
                ) : buyGate.ok ? null : (
                  <div className="text-amber-200/90">{buyGate.reason}</div>
                )}
              </div>
              {ptbContext.readinessWhy ? <div className="mt-1 text-zinc-500">{ptbContext.readinessWhy}</div> : null}
            </div>
          ) : null}

          <div className="mt-4">
            <label htmlFor={idLimitBuy} className="text-xs font-semibold text-zinc-400">
              Price (¢)
            </label>
            <div className="mt-1 rounded-xl border border-zinc-800/70 bg-black/25 px-3 py-3 focus-within:border-zinc-600/70">
              <input
                id={idLimitBuy}
                value={execMode === 'touch' ? quickLimitCentsDisplay : limitPriceCents}
                onChange={(e) => {
                  if (execMode === 'touch') return;
                  setLimitPriceCents(e.target.value);
                }}
                readOnly={execMode === 'touch'}
                inputMode="numeric"
                aria-describedby={`${idLimitBuy}-hint`}
                className={`min-h-[44px] w-full bg-transparent text-lg font-semibold tabular-nums text-zinc-100 outline-none ${
                  execMode === 'touch' ? 'text-emerald-100/95' : ''
                }`}
                placeholder={execMode === 'touch' ? touchLimitCents || defaultLimitCents || '50' : defaultLimitCents || '50'}
              />
            </div>
            <p id={`${idLimitBuy}-hint`} className="mt-1 text-[11px] text-zinc-500">
              {execMode === 'touch'
                ? `Quick tracks live ${action === 'buy' ? 'ask' : 'bid'} (now ${quickLimitCentsDisplay || '—'}¢) — updates every book tick.`
                : `Your buy fills when the market trades at or below ${limitPriceCents || defaultLimitCents || '—'}¢.`}
            </p>
            <div className="mt-2">{renderSecondaryBuyCta('compact')}</div>
          </div>

          <details
            open={!isSlide}
            className="group mt-4 rounded-xl border border-zinc-800/70 bg-black/20 text-sm text-zinc-300 open:pb-0"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 marker:content-none [&::-webkit-details-marker]:hidden">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Order estimate</span>
              <span className="shrink-0 font-mono text-[12px] tabular-nums text-zinc-200">
                {estCost != null ? `$${estCost.toFixed(2)}` : '—'} · {estShares != null ? `${estShares.toFixed(2)} sh` : '—'}
              </span>
            </summary>
            <div className="border-t border-zinc-800/50 px-3 pb-3 pt-2">
              {outcomeLocked ? (
                <p className="rounded-lg border border-amber-800/30 bg-amber-950/15 px-2 py-1.5 text-[11px] leading-relaxed text-amber-100/90">
                  Locked price detected ({midIsExtremeLow ? '≈0¢' : midIsExtremeHigh ? '≈100¢' : 'extreme'}). Preview + buying are disabled to avoid invalid
                  “infinite shares” math.
                </p>
              ) : null}
              <div className="flex items-center justify-between">
                <div className="text-zinc-500">Price / share</div>
                <div className="font-mono tabular-nums">
                  {outcomeLocked ? (midIsExtremeLow ? '0¢ (locked)' : midIsExtremeHigh ? '100¢ (locked)' : fmtCents(mid)) : fmtCents(mid)}
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <div className="text-zinc-500">Est. shares</div>
                <div className="font-mono tabular-nums">{estShares == null ? '—' : estShares.toFixed(2)}</div>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <div className="text-zinc-500">Cost</div>
                <div className="font-mono tabular-nums">{estCost == null ? '—' : `$${estCost.toFixed(2)}`}</div>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <div className="text-zinc-500">Potential payout</div>
                <div className="font-mono tabular-nums text-emerald-200">{payout == null ? '—' : `$${payout.toFixed(2)}`}</div>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <div className="text-zinc-500">Potential profit</div>
                <div className="font-mono tabular-nums text-emerald-200">{profit == null ? '—' : `$${profit.toFixed(2)}`}</div>
              </div>
              {isSlide && mid != null && execMode === 'touch' ? (
                <p className="mt-2 border-t border-zinc-800/50 pt-2 text-[10px] leading-relaxed text-zinc-500">
                  Preview: +5¢ / −2¢ vs mid — reference only (not a bracket order on the CLOB yet).
                </p>
              ) : null}
            </div>
          </details>

          {targets ? (
            <div className="mt-3 rounded-xl border border-zinc-800/70 bg-zinc-950/25 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Targets (assist)</div>
                  <div className="mt-1 text-[11px] leading-snug text-zinc-400">
                    Based on current quote{targets.spreadCents !== '0.00' ? ` (spread ~${targets.spreadCents}¢)` : ''}. Not a guarantee.
                  </div>
                </div>
                {ptbContext && !isSlide ? (
                  <div
                    className="rounded-lg border border-zinc-700/60 bg-black/25 px-2 py-1 text-[10px] font-mono text-zinc-400"
                    title={`Spot vs PTB context\nPTB ${ptbContext.ptbUsd.toFixed(2)}\nBand ±$${ptbContext.bandUsd.toFixed(
                      2,
                    )}\nPosition ${ptbContext.position}${ptbContext.structureEventLabel ? `\nRegime ${ptbContext.structureEventLabel}` : ''}${
                      ptbContext.controlSignal ? `\nControl ${ptbContext.controlSignal}` : ''
                    }\nSlope ${ptbContext.slopeUsdPerSec >= 0 ? '+' : ''}${ptbContext.slopeUsdPerSec.toFixed(5)}/s`}
                  >
                    PTB {ptbContext.position}
                  </div>
                ) : null}
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-emerald-800/45 bg-emerald-950/20 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-200/80">{targets.sideLabel}</div>
                  {targets.quoteCents ? (
                    <div className="mt-0.5 font-mono text-[10px] tabular-nums text-zinc-500">Quote {targets.quoteCents}¢</div>
                  ) : null}
                  <div className="mt-1 font-mono text-lg font-black tabular-nums text-emerald-100">TP {targets.tpCents}¢</div>
                  <div className="mt-1 text-[10px] text-emerald-200/70">
                    {targets.quoteCents ? (
                      <>Δ {Number(targets.tpCents) >= Number(targets.quoteCents) ? '+' : ''}{(Number(targets.tpCents) - Number(targets.quoteCents)).toFixed(1)}¢ vs quote</>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="mt-2 w-full rounded-lg border border-emerald-700/40 bg-emerald-500/15 px-3 py-2 text-[11px] font-bold text-emerald-100 hover:bg-emerald-500/20"
                    onClick={() => {
                      setExecMode('limit');
                      setLimitPriceCents(targets.tpCents);
                      setErr(null);
                      setOkMsg(null);
                    }}
                  >
                    Use as limit price
                  </button>
                  <button
                    type="button"
                    className="mt-2 w-full rounded-lg border border-emerald-700/30 bg-emerald-950/20 px-3 py-2 text-[11px] font-bold text-emerald-100 hover:bg-emerald-950/35"
                    onClick={() => {
                      applyTargetsAssistTpOnFill({ locked: true });
                      setErr(null);
                      setOkMsg(null);
                    }}
                  >
                    Set TP on fill
                  </button>
                  {positionShares != null && positionShares > 0 ? (
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      {[0.25, 0.5, 1].map((pct) => (
                        <button
                          key={`tp-${pct}`}
                          type="button"
                          className="rounded-lg border border-emerald-700/30 bg-black/20 px-2 py-1.5 text-[10px] font-bold text-emerald-100 hover:bg-black/30"
                          title="Switch to Sell, set limit, set size"
                          onClick={() => {
                            chooseAction('sell');
                            setExecMode('limit');
                            setLimitPriceCents(targets.tpCents);
                            const sh = floorSharesWhole(positionShares * pct);
                            setSellQty(sh > 0 ? String(sh) : '0');
                            setErr(null);
                            setOkMsg(null);
                          }}
                        >
                          Sell {Math.round(pct * 100)}%
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="rounded-lg border border-rose-800/40 bg-rose-950/15 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-rose-200/80">Stop / invalidation</div>
                  <div className="mt-1 font-mono text-lg font-black tabular-nums text-rose-100">{targets.stopCents}¢</div>
                  <div className="mt-1 text-[10px] text-rose-200/70">
                    {targets.quoteCents ? (
                      <>Δ {Number(targets.stopCents) >= Number(targets.quoteCents) ? '+' : ''}{(Number(targets.stopCents) - Number(targets.quoteCents)).toFixed(1)}¢ vs quote</>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="mt-2 w-full rounded-lg border border-rose-700/40 bg-rose-500/10 px-3 py-2 text-[11px] font-bold text-rose-100 hover:bg-rose-500/15"
                    onClick={() => {
                      setExecMode('limit');
                      setLimitPriceCents(targets.stopCents);
                      setErr(null);
                      setOkMsg(null);
                    }}
                  >
                    Use as limit price
                  </button>
                  <button
                    type="button"
                    className="mt-2 w-full rounded-lg border border-rose-700/30 bg-rose-950/20 px-3 py-2 text-[11px] font-bold text-rose-100 hover:bg-rose-950/35"
                    onClick={() => {
                      applyBuyBundleSlCents(targets.stopCents);
                      setErr(null);
                      setOkMsg(null);
                    }}
                  >
                    Set emergency stop
                  </button>
                  {positionShares != null && positionShares > 0 ? (
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      {[0.25, 0.5, 1].map((pct) => (
                        <button
                          key={`stop-${pct}`}
                          type="button"
                          className="rounded-lg border border-rose-700/30 bg-black/20 px-2 py-1.5 text-[10px] font-bold text-rose-100 hover:bg-black/30"
                          title="Switch to Sell, set limit, set size"
                          onClick={() => {
                            chooseAction('sell');
                            setExecMode('limit');
                            setLimitPriceCents(targets.stopCents);
                            const sh = floorSharesWhole(positionShares * pct);
                            setSellQty(sh > 0 ? String(sh) : '0');
                            setErr(null);
                            setOkMsg(null);
                          }}
                        >
                          Sell {Math.round(pct * 100)}%
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
              {riskTargetsFromEntry ? (
                <div className="mt-3 rounded-lg border border-amber-700/35 bg-amber-950/12 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-200/90">
                    From avg entry · {riskTargetsFromEntry.avgCents}¢
                    <span className="ml-2 font-normal normal-case text-zinc-500">
                      TP {riskTargetsFromEntry.tpCents}¢ · SL {riskTargetsFromEntry.stopCents}¢ · spread ~{riskTargetsFromEntry.spreadCents}¢
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded-lg border border-rose-800/35 bg-rose-950/15 px-2.5 py-1.5 text-[10px] font-bold text-rose-100 hover:bg-rose-950/25"
                      title="Fill stop-loss trigger/limit fields (live: open Sell → Stop-loss)"
                      onClick={() => {
                        applyStopLossTriggerCents(riskTargetsFromEntry.stopCents);
                      }}
                    >
                      Apply to SL fields
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-emerald-800/35 bg-emerald-950/15 px-2.5 py-1.5 text-[10px] font-bold text-emerald-100 hover:bg-emerald-950/25"
                      title="Fill take-profit trigger/limit fields (live: open Sell → Take-profit)"
                      onClick={() => {
                        applyTakeProfitTriggerCents(riskTargetsFromEntry.tpCents);
                      }}
                    >
                      Apply to TP fields
                    </button>
                  </div>
                  <p className="mt-1.5 text-[9px] leading-snug text-zinc-600">
                    <span className="text-zinc-400">Brackets</span> tab · <span className="text-zinc-400">Take profit / Stop loss</span> — values persist per outcome.
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="mt-2 rounded-lg border border-rose-900/45 bg-rose-950/20 px-2.5 py-2 ring-1 ring-rose-500/10">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-[10px] font-black uppercase tracking-[0.14em] text-rose-200/95">
                    Emergency stop
                  </div>
                </div>
                <p className="mt-0.5 text-[10px] leading-snug text-rose-200/65">
                  Optional backup stop on fill — turn on Auto SL to track Targets assist, or type a level manually.
                </p>
              </div>
              <div className="flex min-h-[1.375rem] shrink-0 items-center">
                {suggestedSlDisplay && !buyBundleSlCents.trim() && !emergencyStopBundlePrefs.autoFillSl ? (
                  <button
                    type="button"
                    className="rounded border border-rose-700/45 bg-rose-950/35 px-2 py-0.5 text-[9px] font-bold text-rose-100 hover:bg-rose-900/45"
                    onClick={() => {
                      const v = suggestedSlDisplay;
                      if (!v) return;
                      applyBuyBundleSlCents(v);
                    }}
                  >
                    Use suggested
                  </button>
                ) : null}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800/50 bg-black/20 px-2 py-1.5">
              <div className="min-w-0">
                <div className="text-[9px] font-semibold text-zinc-300">Auto SL on fill</div>
                <p className="mt-0.5 min-h-[2.125rem] text-[9px] leading-snug text-zinc-500 line-clamp-2">
                  {emergencyStopBundlePrefs.autoFillSl
                    ? 'Prefill from Targets assist before buy — locks at Buy click.'
                    : 'Off — enable auto or type a level manually.'}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={emergencyStopBundlePrefs.autoFillSl}
                aria-label="Auto stop-loss on fill"
                onClick={() => {
                  const nextOn = !emergencyStopBundlePrefs.autoFillSl;
                  if (nextOn) {
                    buyBundleSlManualLanesRef.current = { ...buyBundleSlManualLanesRef.current, [lane]: false };
                    const sl = autoBundleChaseSlCents;
                    if (sl) {
                      applyBuyBundleSlCents(sl, { auto: true });
                      autoBundleSlLaneRef.current = { lane, cents: sl };
                    }
                  } else if (!buyBundleSlManualLanesRef.current[lane]) {
                    applyBuyBundleSlCents('', { auto: true });
                    autoBundleSlLaneRef.current = null;
                  }
                  setEmergencyStopBundlePrefs((p) => ({ ...p, autoFillSl: nextOn }));
                }}
                className={`relative h-6 w-10 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 ${
                  emergencyStopBundlePrefs.autoFillSl
                    ? 'border-rose-600/60 bg-rose-500'
                    : 'border-zinc-600/70 bg-zinc-800'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                    emergencyStopBundlePrefs.autoFillSl ? 'translate-x-[18px]' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
            <div className="mt-2">
              <BracketTriggerInput
                key={`buy-emergency-sl-${lane}`}
                compact
                kind="sl"
                centsValue={buyBundleSlCents}
                onCentsChange={applyBuyBundleSlCents}
                onDraftSync={(state) => {
                  buyBundleSlDraftRef.current = { ...buyBundleSlDraftRef.current, [lane]: state };
                }}
                avgEntry01={null}
                plannedEntry01={buyBundleBracketEntry01}
                orderShares={buyBundleBracketShares}
                orderNotionalUsd={buyBundleBracketNotional}
                mid01={mid ?? null}
                placeholderCents={autoBundleChaseSlCents || quoteAssistSlCents || targets?.stopCents}
                suggestedCents={buyBundleSuggestSl || undefined}
                onApplySuggested={() => {
                  const v = buyBundleSuggestSl;
                  if (!v) return;
                  applyBuyBundleSlCents(v);
                  autoBundleSlLaneRef.current = { lane, cents: v.trim() };
                }}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800/50 bg-black/20 px-2 py-1.5">
              <div className="min-w-0">
                <div className="text-[9px] font-semibold text-zinc-300">Auto TP on fill</div>
                <p className="mt-0.5 min-h-[2.125rem] text-[9px] leading-snug text-zinc-500 line-clamp-2">
                  {emergencyStopBundlePrefs.autoTpOnFill
                    ? 'Tracks Targets quote TP live — updates until you type your own level.'
                    : 'Optional — turn on to mirror quote TP, or tap Set TP on fill in Targets.'}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={emergencyStopBundlePrefs.autoTpOnFill}
                aria-label="Auto take-profit on fill"
                onClick={() => {
                  const nextOn = !emergencyStopBundlePrefs.autoTpOnFill;
                  if (nextOn) {
                    buyBundleTpManualLanesRef.current = { ...buyBundleTpManualLanesRef.current, [lane]: false };
                    buyBundleChaseFrozenRef.current = false;
                    applyTargetsAssistTpOnFill();
                  } else if (!buyBundleTpManualLanesRef.current[lane]) {
                    applyBuyBundleTpCents('', { auto: true });
                    buyBundleTpDraftRef.current = {
                      ...buyBundleTpDraftRef.current,
                      [lane]: EMPTY_BRACKET_INPUT_DRAFT,
                    };
                    autoBundleTpLaneRef.current = null;
                  }
                  setEmergencyStopBundlePrefs((p) => ({ ...p, autoTpOnFill: nextOn }));
                }}
                className={`relative h-6 w-10 shrink-0 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 ${
                  emergencyStopBundlePrefs.autoTpOnFill
                    ? 'border-emerald-600/60 bg-emerald-500'
                    : 'border-zinc-600/70 bg-zinc-800'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                    emergencyStopBundlePrefs.autoTpOnFill ? 'translate-x-[18px]' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
            <div className="mt-2">
              {!emergencyStopBundlePrefs.autoTpOnFill ? (
                <p className="mb-1 text-[9px] font-semibold text-zinc-500">
                  Optional take-profit on fill — leave empty to buy without TP
                </p>
              ) : null}
              <BracketTriggerInput
                key={`buy-tp-${lane}`}
                compact
                kind="tp"
                centsValue={buyBundleTpCents}
                onCentsChange={applyBuyBundleTpCents}
                onDraftSync={(state) => {
                  buyBundleTpDraftRef.current = { ...buyBundleTpDraftRef.current, [lane]: state };
                }}
                avgEntry01={null}
                plannedEntry01={buyBundleBracketEntry01}
                orderShares={buyBundleBracketShares}
                orderNotionalUsd={buyBundleBracketNotional}
                mid01={mid ?? null}
                placeholderCents={bundleSuggestedTpCents || riskTargetsFromEntry?.tpCents}
                suggestedCents={
                  emergencyStopBundlePrefs.autoTpOnFill ? bundleSuggestedTpCents || undefined : buyBundleSuggestTp || undefined
                }
                onApplySuggested={() => {
                  const v = bundleSuggestedTpCents;
                  if (!v) return;
                  applyBuyBundleTpCents(v);
                  autoBundleTpLaneRef.current = { lane, cents: v.trim() };
                }}
              />
            </div>
            {preBuyTpOutlook ? (
              <div className="mt-2">
                <PositionTpOutlookCard outlook={preBuyTpOutlook} compact={isSlide} variant="pre_buy" />
              </div>
            ) : null}
          </div>

          {action === 'buy' ? (
            <div
              className={`mt-3 min-h-[3rem] rounded-xl border px-3 py-2 text-[11px] leading-snug ${
                executeIntentSummary
                  ? 'border-zinc-700/50 bg-zinc-900/30 text-zinc-300'
                  : 'pointer-events-none border-transparent bg-transparent'
              }`}
              aria-hidden={!executeIntentSummary}
            >
              <span className={`font-semibold ${executeIntentSummary ? 'text-zinc-200' : 'text-transparent'}`}>
                You&apos;re about to:{' '}
              </span>
              <span className={executeIntentSummary ? undefined : 'text-transparent'}>
                {executeIntentSummary ?? '—'}
              </span>
            </div>
          ) : null}

          <div
            className={`mt-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-stretch ${
              isSlide
                ? 'sticky bottom-0 z-10 -mx-3 border-t border-zinc-800/80 bg-zinc-950/95 px-3 py-3 backdrop-blur-sm'
                : ''
            }`}
          >
            <button
              ref={buyButtonRef}
              type="button"
              disabled={buySubmitDisabled}
              aria-busy={busySubmit}
              className={buyCtaButtonClass('primary')}
              onClick={async () => {
              if (submitLockRef.current) return;
              submitLockRef.current = true;
              const deskForcedShares = forcedAutoBuySharesRef.current;
              playTradeClick();
              setErr(null);
              setOkMsg(null);
              flushBuyBundleDraftsForLane();
              if (
                emergencyStopBundlePrefs.autoTpOnFill ||
                emergencyStopBundlePrefs.autoFillSl ||
                buyBundleTpCents.trim() ||
                buyBundleSlCents.trim()
              ) {
                operatorSlTpLockedRef.current = true;
                buyBundleChaseFrozenRef.current = true;
              }
              setBusySubmit(true);
              try {
                if (outcomeLocked) {
                  setErr(`Trade disabled: price looks locked at ${midIsExtremeLow ? '0¢' : midIsExtremeHigh ? '100¢' : 'an extreme'} right now.`);
                  return;
                }
                if (!buyGate.ok) {
                  setErr(buyGate.reason ?? 'Buy blocked by gate.');
                  return;
                }
                const cashForBuy = availableBuyUsd ?? 0;
                const clampedAmountStr =
                  cashForBuy > 0 && amtOk
                    ? clampBuyAmountWithinCash({
                        amountStr: amount,
                        unit,
                        cashUsd: cashForBuy,
                        price01: buySizingPrice01,
                      })
                    : amount;
                if (clampedAmountStr !== amount) setAmount(clampedAmountStr);
                const submitAmtNum = Number(clampedAmountStr);
                const submitAmtOk = Number.isFinite(submitAmtNum) && submitAmtNum > 0;
                if (!submitAmtOk) {
                  setErr('Buy amount too small for available cash.');
                  return;
                }
                let submitForcedShares = deskForcedShares;
                if (
                  submitForcedShares != null &&
                  submitForcedShares > 0 &&
                  cashForBuy > 0 &&
                  buySizingPrice01 != null &&
                  buySizingPrice01 > 0
                ) {
                  const maxSh = floorSharesWhole(cashForBuy / buySizingPrice01);
                  if (maxSh <= 0) {
                    setErr('Buy amount too small for available cash.');
                    return;
                  }
                  if (submitForcedShares > maxSh) {
                    submitForcedShares = maxSh;
                    forcedAutoBuySharesRef.current = maxSh;
                    setUnit('shares');
                    setAmount(String(maxSh));
                  }
                }
                const submitLane = lane;
                const submitToken = submitLane === 'up' ? upToken : downToken;
                const submitLabel = submitLane === 'up' ? upLabel : downLabel;
                const setupScaleEarly =
                  autoSizeSetup && ptbContext?.readinessState === 'SETUP' && ptbContext?.readinessLane === submitLane
                    ? 0.25
                    : 1;
                const effAmtEarly =
                  submitForcedShares != null && submitForcedShares > 0
                    ? submitForcedShares
                    : unit === 'dollars'
                      ? submitAmtNum * setupScaleEarly
                      : submitAmtNum;
                const pxEarly = limit01;
                const estSizeForBundle =
                  submitForcedShares != null && submitForcedShares > 0
                    ? submitForcedShares
                    : unit === 'shares'
                      ? effAmtEarly
                      : pxEarly != null && pxEarly > 0
                        ? effAmtEarly / pxEarly
                        : null;
                if (
                  shouldPrefillBuyBundleTpOnClick({
                    autoTpOnFill: emergencyStopBundlePrefs.autoTpOnFill,
                    chaseTpCents: quoteAssistTpCents,
                    stagedTp: buyBundleByLaneRef.current[submitLane].tp,
                    manualLane: buyBundleTpManualLanesRef.current[submitLane],
                  })
                ) {
                  applyBuyBundleTpCents(quoteAssistTpCents, { auto: true });
                }
                const bundleStage = stageBuyBundleForSubmit(
                  submitLane,
                  submitToken?.trim() ?? '',
                  estSizeForBundle != null && Number.isFinite(estSizeForBundle) ? estSizeForBundle : null,
                );
                if (!bundleStage.ok) {
                  setErr(bundleStage.reason);
                  return;
                }
                const submitOutcome = bullpenOutcomeForOrder({
                  lane: submitLane,
                  marketSlug,
                  label: submitLabel,
                });
                const submitMid =
                  submitLane === lane
                    ? mid
                    : (() => {
                        const chart = submitLane === 'up' ? upMid : downMid;
                        const book = submitLane === 'up' ? (bookMidUp ?? null) : (bookMidDown ?? null);
                        const c = chart != null && Number.isFinite(chart) && chart > 0 ? chart : null;
                        const b = book != null && Number.isFinite(book) && book > 0 ? book : null;
                        if (accountMode === 'live') return b ?? c;
                        return c ?? b;
                      })();
                if (accountMode === 'paper') {
                  const px = limit01;
                  const setupScale =
                    autoSizeSetup && ptbContext?.readinessState === 'SETUP' && ptbContext?.readinessLane === submitLane
                      ? 0.25
                      : 1;
                  const scaledAmt = unit === 'dollars' ? submitAmtNum * setupScale : submitAmtNum;
                  const shares =
                    submitForcedShares != null && submitForcedShares > 0
                      ? submitForcedShares
                      : unit === 'shares'
                        ? scaledAmt
                        : px != null && px > 0
                          ? scaledAmt / px
                          : NaN;
                  // Limit/touch in paper mode: rest if not marketable, auto-fill later when mid crosses.
                  if (submitMid == null || limit01 == null) {
                    setErr('Need a valid mid and limit price.');
                  } else {
                    const limit = limit01;
                    const marketable = submitMid <= limit;
                    if (marketable) {
                      const r = paperTrade({
                        account: paperAccount,
                        tokenId: submitToken,
                        side: 'buy',
                        shares,
                        price01: Math.min(submitMid, limit),
                      });
                      if (!r.ok) setErr(fmtPaperTradeError(r.error));
                      else {
                        setPaperAccount(r.account);
                        setOkMsg(`Paper filled buy ${shares.toFixed(2)} sh of ${submitLabel}`);
                        setHistoryRows(
                          appendTradeHistory({ ...tradeHistoryMarketMeta,
                            mode: 'paper',
                            exec: execMode,
                            side: 'buy',
                            token: submitToken,
                            label: submitLabel,
                            price01: r.fill.price01,
                            shares: r.fill.shares,
                            usdCents: Math.abs(r.fill.usdCents),
                            status: 'filled',
                          }),
                        );
                        if (bundleStage.armed) {
                          const bundle = buyBundleArmRef.current;
                          const staged = readStagedBuyBundleLevels(submitLane, buyBundleByLaneRef.current);
                          applyFilledBuyBundle({
                            rowTok: submitToken.trim(),
                            riskLane: submitLane,
                            shares: r.fill.shares,
                            sl: bundle?.sl ?? staged.sl,
                            tp: bundle?.tp ?? staged.tp,
                          });
                          buyBundleArmRef.current = null;
                        } else {
                          applyArmRiskAfterBuyFill(r.fill.price01, r.fill.shares, submitLane);
                        }
                        if (submitForcedShares != null) forcedAutoBuySharesRef.current = null;
                      }
                    } else {
                      const o = addPaperOrder({ tokenId: submitToken, side: 'buy', limit01: limit, shares });
                      setOkMsg(`Paper order resting: buy ${shares.toFixed(2)} sh ≤ ${(limit * 100).toFixed(1)}¢`);
                      setHistoryRows(
                        appendTradeHistory({ ...tradeHistoryMarketMeta,
                          id: o.id,
                          ts: o.createdAt,
                          mode: 'paper',
                          exec: execMode,
                          side: 'buy',
                          token: submitToken,
                          label: submitLabel,
                          price01: limit,
                          shares,
                          usdCents: Math.abs(Math.round(limit * shares * 100)),
                          status: 'sent',
                        }),
                      );
                    }
                  }
                  return;
                }
                // Instant local position preview for LIVE submits.
                // This is corrected by user-channel events + background balance refresh.
                if (submitToken?.trim()) {
                  const setupScale =
                    autoSizeSetup && ptbContext?.readinessState === 'SETUP' && ptbContext?.readinessLane === submitLane
                      ? 0.25
                      : 1;
                  const effAmtNum = unit === 'dollars' ? submitAmtNum * setupScale : submitAmtNum;
                  const pxPreview = limit01;
                  const px =
                    pxPreview != null && Number.isFinite(pxPreview) && pxPreview > 0 && pxPreview < 1 ? pxPreview : null;
                  if (unit === 'dollars') {
                    // For $-based market buys, shares are not knowable until fill; do not guess.
                    const usd = Number.isFinite(effAmtNum) && effAmtNum > 0 ? roundUsd2(effAmtNum) : 0;
                    if (usd > 0) {
                      setPendingPos({
                        token: submitToken,
                        side: 'buy',
                        kind: 'usd',
                        usd,
                        price01: px,
                        status: 'submitting',
                        createdAt: Date.now(),
                      });
                    }
                  } else {
                    const shPreview = roundShares4(effAmtNum);
                    if (Number.isFinite(shPreview) && shPreview > 0) {
                      setPendingPos({
                        token: submitToken,
                        side: 'buy',
                        kind: 'shares',
                        shares: shPreview,
                        price01: px,
                        status: 'submitting',
                        createdAt: Date.now(),
                      });
                    }
                  }
                }
                  if (!submitToken?.trim()) {
                    setErr('Outcome token is not ready yet — wait for this market to finish loading, then retry.');
                    return;
                  }
                  const price = limit01 ?? NaN;
                  const setupScale =
                    autoSizeSetup && ptbContext?.readinessState === 'SETUP' && ptbContext?.readinessLane === submitLane
                      ? 0.25
                      : 1;
                  const effAmtNum =
                    submitForcedShares != null && submitForcedShares > 0
                      ? submitForcedShares
                      : unit === 'dollars'
                        ? submitAmtNum * setupScale
                        : submitAmtNum;
                  const sizeSharesRaw =
                    unit === 'shares' || submitForcedShares != null ? effAmtNum : price > 0 ? effAmtNum / price : NaN;
                  const sizeShares = Number.isFinite(sizeSharesRaw) ? floorShares4(sizeSharesRaw) : NaN;
                  if (!Number.isFinite(sizeShares) || sizeShares < 1e-4) {
                    setErr('Buy size is too small after rounding to 4 decimal shares.');
                    return;
                  }
                  if (submitForcedShares != null) forcedAutoBuySharesRef.current = null;
                  liveSubmitGenRef.current += 1;
                  const quoted01 = Number.isFinite(price) ? roundPrice01(price) : null;
                  const mark01 = mid != null && mid > 0 ? roundPrice01(mid) : null;
                  const useMarketBuy = execMode === 'touch';
                  const refAsk01 =
                    executableQuote01 != null && executableQuote01 > 0 && executableQuote01 < 1
                      ? executableQuote01
                      : quoted01;
                  if (useMarketBuy) {
                    const marketUsd = marketBuyUsdFromIntent({
                      unit,
                      dollars: effAmtNum,
                      shares: sizeShares,
                      refAsk01: refAsk01 ?? price,
                    });
                    if (!(marketUsd >= 1)) {
                      setErr('Market buy notional must be at least $1 pUSD.');
                      return;
                    }
                  }
                  const optimistic = appendTradeHistoryWithId({ ...tradeHistoryMarketMeta,
                    mode: 'live',
                    exec: useMarketBuy ? 'market' : execMode,
                    side: 'buy',
                    token: submitToken,
                    label: submitLabel,
                    price01: quoted01,
                    quotedPrice01: quoted01,
                    intendedPrice01: useMarketBuy ? (refAsk01 ?? price) : price,
                    submittedPrice01: null,
                    fillAvgPrice01: null,
                    markPrice01: mark01,
                    shares: useMarketBuy ? 0 : sizeShares,
                    requestedShares: sizeShares,
                    remainingShares: sizeShares,
                    usdCents:
                      unit === 'dollars' && Number.isFinite(effAmtNum)
                        ? Math.abs(Math.round(effAmtNum * 100))
                        : Number.isFinite(price)
                          ? Math.abs(Math.round(price * sizeShares * 100))
                          : null,
                    status: 'sending',
                  });
                  setHistoryRows(optimistic.rows);
                  setPinnedLiveStatusId(optimistic.id);
                  setPinnedLiveStatusDismissed(false);
                  const controller = new AbortController();
                  setSubmitAbort(controller);
                  const tClient0 = performance.now();
                  const res = useMarketBuy
                    ? await tradeMarketOrderWithOpts(
                        {
                          token: submitToken,
                          side: 'buy',
                          amount: marketBuyUsdFromIntent({
                            unit,
                            dollars: effAmtNum,
                            shares: sizeShares,
                            refAsk01: refAsk01 ?? price,
                          }),
                          signatureType: null,
                          marketSlug: marketSlug ?? '',
                          outcome: submitOutcome,
                          lane: submitLane,
                        },
                        { signal: controller.signal, timeoutMs: 25_000 },
                      )
                    : await tradeCreateOrderWithOpts(
                        {
                          token: submitToken,
                          side: 'buy',
                          price,
                          size: sizeShares,
                          signatureType: null,
                          marketSlug: marketSlug ?? '',
                          outcome: submitOutcome,
                          lane: submitLane,
                        },
                        { signal: controller.signal, timeoutMs: 25_000 },
                      );
                  const clientMs = Math.round(performance.now() - tClient0);
                  if (!isOk(res)) {
                    const e = res as ApiErr;
                    setErr(formatTradeApiError(e));
                    setHistoryRows(
                      updateTradeHistoryRow(optimistic.id, {
                        status: 'failed',
                        error: `${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`,
                      }),
                    );
                  } else {
                    const { result, execution } = unwrapTradeActionData(res.data);
                    const oid = execution?.order_id ?? extractOrderIdFromClobPayload(result);
                    const rt = mergeRoundTripMs(execution?.round_trip_ms, clientMs);
                    setLastExecLatencyMs(rt);
                    setHistoryRows(
                      updateTradeHistoryRow(optimistic.id, {
                        status: 'sent',
                        shares: 0,
                        requestedShares: sizeShares,
                        remainingShares: sizeShares,
                        submittedPrice01: execution?.submitted_price_01 ?? null,
                        orderId: oid ?? undefined,
                        roundTripMs: rt,
                        price01: quoted01,
                        error: undefined,
                      }),
                    );
                    if (!useMarketBuy && oid) pollRestingOrderFill(optimistic.id, oid, sizeShares, price, quoted01);
                    setOkMsg(
                      useMarketBuy
                        ? `Market buy submitted · ack ${rt}ms — filling at best available price…`
                        : `Limit buy sent · intended ${(price * 100).toFixed(1)}¢ · ack ${rt}ms — reading exchange state…`,
                    );
                    scheduleTruthRefreshBurst(submitToken, oid ?? null, () => afterLiveBuyRowReconcile(optimistic.id));
                  }
              } finally {
                deskBuyLaneRef.current = null;
                forcedAutoBuySharesRef.current = null;
                setBusySubmit(false);
                setSubmitAbort(null);
                submitLockRef.current = false;
              }
              }}
            >
              {renderBuyCtaContent('primary')}
            </button>
            {accountMode === 'live' && activeLiveOrderRow?.orderId && liveRowCancelable(activeLiveOrderRow) ? (
              <button
                type="button"
                disabled={busySubmit}
                className="min-h-[48px] rounded-xl border border-rose-800/40 bg-rose-950/20 px-4 text-[12px] font-black text-rose-100 hover:bg-rose-950/35 disabled:cursor-not-allowed disabled:opacity-40"
                title="Cancel the active resting order for this outcome"
                onClick={async () => {
                  const oid = activeLiveOrderRow.orderId;
                  if (!oid) return;
                  await cancelLiveOrderAndRefresh(oid);
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <>
          {isSlide ? (
            <div className="mt-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Order type</div>
              <div className="mt-2 rounded-xl border border-zinc-800/60 bg-zinc-950/30 px-3 py-3">
                <p className="mb-2 text-[10px] leading-snug text-zinc-500">Limit-only — quick vs custom ¢.</p>
                <TradeSegmentedControl
                  value={execMode}
                  onChange={(v) => {
                    const next = v as 'touch' | 'limit';
                    setExecMode(next);
                    setErr(null);
                    setOkMsg(null);
                    if (next === 'touch' && touchLimitCents) setLimitPriceCents(touchLimitCents);
                    else if (next === 'limit' && defaultLimitCents) setLimitPriceCents(defaultLimitCents);
                  }}
                  options={[
                    { value: 'touch', label: 'Quick', title: 'Resting limit priced tight to the quote' },
                    { value: 'limit', label: 'Custom', title: 'You set the limit price in cents' },
                  ]}
                  className="w-full"
                  size="md"
                />
              </div>
            </div>
          ) : (
            <div className="mt-6 space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">How to execute</div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <TradeSegmentedControl
                  value={execMode}
                  onChange={(v) => {
                    setExecMode(v as 'touch' | 'limit');
                    setErr(null);
                    setOkMsg(null);
                    if (v === 'touch' && touchLimitCents) setLimitPriceCents(touchLimitCents);
                    else if (v === 'limit' && defaultLimitCents) setLimitPriceCents(defaultLimitCents);
                  }}
                  options={[
                    {
                      value: 'touch',
                      label: 'Quick',
                      title: 'Places a limit very close to the current price — best for fast exits',
                    },
                    { value: 'limit', label: 'Custom', title: 'You set the minimum price you are willing to accept' },
                  ]}
                />
                <p className="max-w-md text-[11px] leading-relaxed text-zinc-500">
                  {execMode === 'touch'
                    ? 'Quick: a tight limit around the quote for a fast, controlled exit.'
                    : 'Custom: wait for the market to reach your limit price.'}
                </p>
              </div>
            </div>
          )}

          <div className="mt-4 rounded-xl border border-zinc-800/70 bg-black/20 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Your position</div>
            {accountMode === 'live' ? (
              <p className="mt-1 text-[10px] leading-snug text-zinc-500">
                {balError
                  ? balError
                  : balLoading
                    ? 'Refreshing wallet from Bullpen/CLOB…'
                    : 'Shares and avg entry come from the exchange wallet — fills stay “sent” until confirmed.'}
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-sm text-zinc-200">
                {optimisticPositionShares != null ? (
                  <span
                    className="inline-flex max-w-full flex-wrap items-baseline gap-x-1.5 gap-y-0.5"
                    title={`${fmtShares(optimisticPositionShares, 'full')} shares`}
                  >
                    <span className="font-mono text-lg font-bold tabular-nums">{fmtShares(optimisticPositionShares, 'compact')}</span>
                    <span className="text-xs font-semibold text-zinc-500">shares</span>
                    <span className="text-zinc-600">·</span>
                    <span className={`font-medium ${lane === 'up' ? 'text-emerald-300' : 'text-rose-300'}`}>{lane === 'up' ? upLabel : downLabel}</span>
                  </span>
                ) : (
                  <span className="text-zinc-500">—</span>
                )}
                {accountMode === 'live' && pendingPos && pendingPos.token === token ? (
                  <div className="mt-1 text-[11px] text-amber-200/90">
                    {pendingPos.kind === 'usd' ? (
                      <>
                        Pending buy ${pendingPos.usd.toFixed(2)} {pendingPos.price01 != null ? `@ ~${(pendingPos.price01 * 100).toFixed(1)}¢` : ''} ·{' '}
                        {pendingPos.status}
                      </>
                    ) : (
                      <>
                        Pending {pendingPos.side} {pendingPos.shares.toFixed(2)} sh{' '}
                        {pendingPos.price01 != null ? `@ ${(pendingPos.price01 * 100).toFixed(1)}¢` : ''} · {pendingPos.status}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
              <div className="font-mono text-sm tabular-nums text-zinc-400">
                Value{' '}
                {optimisticPositionShares != null && mid != null ? `$${(optimisticPositionShares * mid).toFixed(2)}` : '—'} · Mid {fmtCents(mid)}
              </div>
            </div>

            <details className="group mt-3 rounded-lg border border-zinc-800/50 bg-black/20 p-2">
              <summary className="cursor-pointer list-none text-[11px] font-medium text-zinc-500 outline-none marker:content-none [&::-webkit-details-marker]:hidden hover:text-zinc-400">
                <span className="font-mono text-zinc-600">▸</span> Full breakdown
              </summary>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded-lg border border-zinc-800/60 bg-black/25 px-2 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Holding</div>
                  <div className="mt-0.5 text-sm font-semibold text-zinc-100">
                    {positionShares != null ? (
                      <span className="font-mono">{fmtShares(positionShares, 'full')} sh</span>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </div>
                </div>
                <div className="rounded-lg border border-zinc-800/60 bg-black/25 px-2 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Avg entry</div>
                  <div
                    className={`mt-0.5 font-mono text-sm ${avgEntry != null ? 'text-zinc-100' : avgEntryErr ? 'text-amber-200/90' : 'text-zinc-500'}`}
                    title={avgEntryErr ? `Live avg entry unavailable: ${avgEntryErr}` : ''}
                  >
                    {fmtCents(avgEntry)}
                  </div>
                  {accountMode === 'live' && avgEntryErr ? (
                    <button
                      type="button"
                      className="mt-1 rounded-md border border-zinc-800/70 bg-black/20 px-2 py-1 text-[10px] font-bold text-zinc-200 hover:bg-black/30"
                      onClick={() => refreshAvgEntryThrottled()}
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
                <div className="rounded-lg border border-zinc-800/60 bg-black/25 px-2 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Mid</div>
                  <div className="mt-0.5 font-mono text-sm text-zinc-100">{fmtCents(mid)}</div>
                </div>
                <div className="rounded-lg border border-zinc-800/60 bg-black/25 px-2 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Value</div>
                  <div className="mt-0.5 font-mono text-sm text-zinc-100">
                    {positionShares != null && mid != null ? `$${(positionShares * mid).toFixed(2)}` : '—'}
                  </div>
                </div>
              </div>
            </details>

              <label htmlFor={idLimitSell} className="text-xs font-semibold text-zinc-400">
                Price (¢)
              </label>
              <div className="mt-1 rounded-lg border border-zinc-800/70 bg-black/20 px-3 py-2.5">
                <input
                  id={idLimitSell}
                  value={execMode === 'touch' ? quickLimitCentsDisplay : limitPriceCents}
                  onChange={(e) => {
                    if (execMode === 'touch') return;
                    setLimitPriceCents(e.target.value);
                  }}
                  readOnly={execMode === 'touch'}
                  inputMode="numeric"
                  className={`min-h-[40px] w-full bg-transparent text-base font-semibold tabular-nums text-zinc-100 outline-none ${
                    execMode === 'touch' ? 'text-emerald-100/95' : ''
                  }`}
                  placeholder={execMode === 'touch' ? touchLimitCents || defaultLimitCents || '50' : defaultLimitCents || '50'}
                />
              </div>
              <p className="mt-2 text-[10px] text-zinc-500">Use <span className="text-zinc-400">Max</span> for size, then the main sell button.</p>
            </div>

            {executeIntentSummary && action === 'sell' ? (
              <div className="mt-3 rounded-xl border border-zinc-700/50 bg-zinc-900/30 px-3 py-2 text-[11px] leading-snug text-zinc-300">
                <span className="font-semibold text-zinc-200">You&apos;re about to: </span>
                {executeIntentSummary}
              </div>
            ) : null}

            <div className="mt-4">
              <div className="flex items-end justify-between gap-2">
                <label htmlFor={idSellQty} className="text-xs font-semibold text-zinc-400">
                  {isSlide ? 'Sell Amount' : 'Sell quantity (shares)'}
                </label>
                {isSlide ? (
                  <span className="text-[11px] font-mono text-emerald-300/90">
                    Available: {positionShares != null ? `${fmtShares(positionShares, 'full')} shares` : '—'}
                  </span>
                ) : null}
              </div>
              <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-stretch">
                <div className="min-w-0 flex-1 rounded-xl border border-zinc-800/70 bg-black/30 px-3 py-2 focus-within:border-zinc-600/70">
                  <input
                    id={idSellQty}
                    value={sellQty}
                    onChange={(e) => setSellQty(e.target.value)}
                    inputMode="decimal"
                    placeholder={`Max ${maxSellStr}`}
                    aria-describedby={`${idSellQty}-hint`}
                    className="min-h-[44px] w-full bg-transparent text-base font-semibold tabular-nums text-zinc-100 outline-none placeholder:text-zinc-600"
                  />
                </div>
                <div className="flex gap-2 sm:shrink-0">
                  <button
                    type="button"
                    onClick={() => void refreshPositionAndMaxSell()}
                    disabled={busySubmit || busyRefresh}
                    aria-busy={busySubmit || busyRefresh}
                    className="min-h-[48px] min-w-[4.5rem] rounded-xl border border-zinc-600/80 bg-zinc-900/70 px-4 text-sm font-semibold text-zinc-100 hover:bg-zinc-800 disabled:opacity-40"
                  >
                    Max
                  </button>
                  <button
                    type="button"
                    disabled={busySubmit || sellSharesClamped == null || sellSharesClamped <= 0 || limit01 == null || !Number.isFinite(limit01)}
                    aria-busy={busySubmit}
                    className={`min-h-[48px] min-w-[6rem] rounded-xl bg-rose-500 px-4 text-sm font-bold text-black shadow-md shadow-rose-950/40 hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-40 ${
                      isSlide ? 'inline-flex items-center justify-center gap-2' : ''
                    }`}
                    onClick={async () => {
                      if (submitLockRef.current) return;
                      if (sellSharesClamped == null || sellSharesClamped <= 0) return;
                      submitLockRef.current = true;
                      playTradeClick();
                      setErr(null);
                      setOkMsg(null);
                      setBusySubmit(true);
                      try {
                        if (accountMode === 'paper') {
                          // Limit/touch in paper mode: rest if not marketable, auto-fill later when mid crosses.
                          if (mid == null || limit01 == null) {
                            setErr('Need a valid mid and limit price.');
                            return;
                          }
                          const limit = limit01;
                          const marketable = mid >= limit;
                          if (marketable) {
                            const r = paperTrade({ account: paperAccount, tokenId: token, side: 'sell', shares: sellSharesClamped, price01: Math.max(mid, limit) });
                            if (!r.ok) setErr(r.error);
                            else {
                              setPaperAccount(r.account);
                              setOkMsg(`Paper filled sell ${sellSharesClamped.toFixed(2)} sh of ${label}`);
                              setHistoryRows(
                                appendTradeHistory({ ...tradeHistoryMarketMeta,
                                  mode: 'paper',
                                  exec: execMode,
                                  side: 'sell',
                                  token,
                                  label,
                                  price01: r.fill.price01,
                                  shares: r.fill.shares,
                                  usdCents: Math.abs(r.fill.usdCents),
                                  status: 'filled',
                                }),
                              );
                              setSellQty('');
                              syncRiskAutomationAfterSellFill(getPaperPosition(r.account, token).shares);
                            }
                          } else {
                            const o = addPaperOrder({ tokenId: token, side: 'sell', limit01: limit, shares: sellSharesClamped });
                            setOkMsg(`Paper order resting: sell ${sellSharesClamped.toFixed(2)} sh ≥ ${(limit * 100).toFixed(1)}¢`);
                            setHistoryRows(
                              appendTradeHistory({
                                ...tradeHistoryMarketMeta,
                                id: o.id,
                                ts: o.createdAt,
                                mode: 'paper',
                                exec: 'limit',
                                side: 'sell',
                                token,
                                label,
                                price01: limit,
                                shares: sellSharesClamped,
                                usdCents: Math.abs(Math.round(limit * sellSharesClamped * 100)),
                                status: 'sent',
                              }),
                            );
                          }
                          return;
                        }
                        if (!token?.trim()) {
                          setErr('Outcome token is not ready yet — wait for this market to finish loading, then retry.');
                          return;
                        }
                        {
                          const price = limit01 ?? NaN;
                          const sizeLive = floorShares4(sellSharesClamped);
                          if (sizeLive < 1e-4) {
                            setErr('Sell size is too small after rounding to 4 decimal shares.');
                            return;
                          }
                          liveSubmitGenRef.current += 1;
                          const quoted01 = Number.isFinite(price) ? roundPrice01(price) : null;
                          const mark01 = mid != null && mid > 0 ? roundPrice01(mid) : null;
                          const optimistic = appendTradeHistoryWithId({ ...tradeHistoryMarketMeta,
                            mode: 'live',
                            exec: execMode,
                            side: 'sell',
                            token,
                            label,
                            price01: quoted01,
                            quotedPrice01: quoted01,
                            intendedPrice01: price,
                            submittedPrice01: null,
                            fillAvgPrice01: null,
                            markPrice01: mark01,
                            shares: sizeLive,
                            requestedShares: sizeLive,
                            remainingShares: sizeLive,
                            usdCents: Number.isFinite(price) ? Math.abs(Math.round(price * sizeLive * 100)) : null,
                            status: 'sending',
                          });
                          setHistoryRows(optimistic.rows);
                          const controller = new AbortController();
                          setSubmitAbort(controller);
                          const tClient0 = performance.now();
                          const res = await tradeCreateOrderWithOpts(
                            {
                              token,
                              side: 'sell',
                              price,
                              size: sizeLive,
                              orderType: 'GTC',
                              signatureType: null,
                              marketSlug: marketSlug ?? '',
                              outcome: resolvedBullpenOutcome,
            lane,
                            },
                            { signal: controller.signal, timeoutMs: 25_000 },
                          );
                          const clientMs = Math.round(performance.now() - tClient0);
                          if (!isOk(res)) {
                            const e = res as ApiErr;
                            setErr(formatTradeApiError(e));
                            setHistoryRows(
                              updateTradeHistoryRow(optimistic.id, {
                                status: 'failed',
                                error: `${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`,
                              }),
                            );
                          } else {
                            const { result, execution } = unwrapTradeActionData(res.data);
                            const oid = execution?.order_id ?? extractOrderIdFromClobPayload(result);
                            const rt = mergeRoundTripMs(execution?.round_trip_ms, clientMs);
                            setLastExecLatencyMs(rt);
                            setHistoryRows(
                              updateTradeHistoryRow(optimistic.id, {
                                status: 'sent',
                                submittedPrice01: null,
                                orderId: oid ?? undefined,
                                roundTripMs: rt,
                                price01: quoted01,
                                error: undefined,
                              }),
                            );
                            if (oid) pollRestingOrderFill(optimistic.id, oid, sizeLive, price, quoted01);
                            setOkMsg(
                              `${execMode === 'touch' ? 'Quick' : 'Limit'} sell sent · intended ${(price * 100).toFixed(1)}¢ · ack ${rt}ms — reading exchange state…`,
                            );
                            scheduleTruthRefreshBurst(token, oid ?? null, () => {
                              syncRiskAutomationAfterSellFill(positionSharesRef.current ?? 0);
                            });
                          }
                        }
                      } finally {
                        setBusySubmit(false);
                        setSubmitAbort(null);
                        submitLockRef.current = false;
                      }
                    }}
                  >
                    {busySubmit ? (
                      <>
                        {isSlide ? (
                          <span
                            className="size-4 shrink-0 animate-spin rounded-full border-2 border-black/25 border-t-black"
                            aria-hidden
                          />
                        ) : null}
                        {isSlide ? 'SENDING…' : '…'}
                      </>
                    ) : isSlide ? (
                      `Sell ${label}`
                    ) : (
                      'Execute Trade'
                    )}
                  </button>
                </div>
              </div>
              <p id={`${idSellQty}-hint`} className="mt-1 text-[11px] text-zinc-500">
                {sellQtyOk && sellSharesClamped != null && sellQtyNum > sellSharesClamped ? (
                  <span className="text-amber-200/90">Capped to your balance ({fmtShares(positionShares, 'full')} sh).</span>
                ) : (
                  <span>
                    Est. proceeds {sellEstValue == null ? '—' : `$${sellEstValue.toFixed(2)}`} at mid {fmtCents(mid)}.
                  </span>
                )}
              </p>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {(['25%', '50%', '75%'] as const).map((t, i) => {
                const pct = i === 0 ? 0.25 : i === 1 ? 0.5 : 0.75;
                const can = positionShares != null && positionShares > 0;
                return (
                  <button
                    key={t}
                    type="button"
                    disabled={!can || busySubmit || busyRefresh}
                    onClick={() => applyPct(pct)}
                    className={`min-h-[36px] rounded-lg border px-3 py-1.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/35 ${
                      can ? 'border-zinc-700/70 bg-zinc-900/50 text-zinc-200 hover:bg-zinc-800/70' : 'border-zinc-800/70 text-zinc-600'
                    } disabled:opacity-40`}
                  >
                    {t}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              disabled={
                busySubmit ||
                positionShares == null ||
                positionShares <= 0 ||
                (execMode === 'limit' && (limit01 == null || !Number.isFinite(limit01))) ||
                (execMode === 'touch' && executableQuote01 == null && (mid == null || !(mid > 0)))
              }
              aria-busy={busySubmit}
              className={`mt-4 min-h-[48px] w-full rounded-xl border-2 border-rose-600/50 bg-transparent px-4 py-3 text-sm font-bold text-rose-200 hover:bg-rose-950/35 disabled:cursor-not-allowed disabled:opacity-40 ${
                isSlide ? 'inline-flex items-center justify-center gap-2' : ''
              }`}
              onClick={async () => {
                if (submitLockRef.current) return;
                if (positionShares == null || positionShares <= 0) return;
                submitLockRef.current = true;
                playTradeClick();
                setErr(null);
                setOkMsg(null);
                setBusySubmit(true);
                try {
                  if (accountMode === 'paper') {
                    const px =
                      execMode === 'touch' ? (executableQuote01 ?? mid ?? limit01) : limit01;
                    if (px == null || !Number.isFinite(px) || !(px > 0) || px >= 1) {
                      setErr('Need a valid limit price (or quote) to close.');
                      return;
                    }
                    const r = paperTrade({ account: paperAccount, tokenId: token, side: 'sell', shares: positionShares, price01: px });
                    if (!r.ok) {
                      setErr(r.error);
                      setHistoryRows(
                        appendTradeHistory({ ...tradeHistoryMarketMeta,
                          mode: 'paper',
                          exec: execMode,
                          side: 'sell',
                          token,
                          label,
                          price01: px ?? null,
                          shares: positionShares,
                          usdCents: null,
                          status: 'error',
                          error: r.error,
                        }),
                      );
                    } else {
                      setPaperAccount(r.account);
                      setOkMsg(`Paper sold all ${label} ${positionShares.toFixed(2)} sh @ ${(px! * 100).toFixed(1)}¢`);
                      setHistoryRows(
                        appendTradeHistory({ ...tradeHistoryMarketMeta,
                          mode: 'paper',
                          exec: execMode,
                          side: 'sell',
                          token,
                          label,
                          price01: r.fill.price01,
                          shares: r.fill.shares,
                          usdCents: Math.abs(r.fill.usdCents),
                          status: 'filled',
                        }),
                      );
                      setSellQty('');
                      syncRiskAutomationAfterSellFill(getPaperPosition(r.account, token).shares);
                    }
                    return;
                  }
                  if (!token?.trim()) {
                    setErr('Outcome token is not ready yet — wait for this market to finish loading, then retry.');
                    return;
                  }
                  // IMPORTANT: if the user has explicitly set a limit price, always respect it
                  // (never silently swap to best-bid execution pricing).
                  const explicit = limit01;
                  const price =
                    explicit != null && Number.isFinite(explicit) && explicit > 0
                      ? explicit
                      : execMode === 'touch'
                        ? // Quick sell = aggressive limit at executable reference (best bid; falls back to mid)
                          (executableQuote01 ?? mid ?? NaN)
                        : (limit01 ?? NaN);
                  if (!Number.isFinite(price) || !(price > 0) || price >= 1) {
                    setErr('Need a valid limit price (or quote) to close.');
                    return;
                  }
                  const sizeLive = floorShares4(positionShares);
                  if (sizeLive < 1e-4) {
                    setErr('Sell size is too small after rounding to 4 decimal shares.');
                    return;
                  }
                  liveSubmitGenRef.current += 1;
                  const useMarket = execMode === 'touch' && quickSellMode === 'market' && (explicit == null || !Number.isFinite(explicit));
                  const quoted01 = Number.isFinite(price) ? roundPrice01(price) : null;
                  const mark01 = mid != null && mid > 0 ? roundPrice01(mid) : null;
                  const optimistic = appendTradeHistoryWithId({ ...tradeHistoryMarketMeta,
                    mode: 'live',
                    exec: useMarket ? 'market' : execMode,
                    side: 'sell',
                    token,
                    label,
                    price01: useMarket ? (quoted01 ?? null) : quoted01,
                    quotedPrice01: quoted01,
                    intendedPrice01: useMarket ? null : price,
                    submittedPrice01: null,
                    fillAvgPrice01: null,
                    markPrice01: mark01,
                    shares: sizeLive,
                    requestedShares: sizeLive,
                    remainingShares: sizeLive,
                    usdCents: Number.isFinite(price) ? Math.abs(Math.round(price * sizeLive * 100)) : null,
                    status: 'sending',
                  });
                  setHistoryRows(optimistic.rows);
                  const controller = new AbortController();
                  setSubmitAbort(controller);
                  const tClient0 = performance.now();
                  const res = useMarket
                    ? await tradeMarketOrderWithOpts(
                        { token, side: 'sell', amount: sizeLive, signatureType: null, marketSlug: marketSlug ?? '', outcome: resolvedBullpenOutcome,
            lane },
                        { signal: controller.signal, timeoutMs: 25_000 },
                      )
                    : await tradeCreateOrderWithOpts(
                        {
                          token,
                          side: 'sell',
                          price,
                          size: sizeLive,
                          orderType: 'GTC',
                          signatureType: null,
                          marketSlug: marketSlug ?? '',
                          outcome: resolvedBullpenOutcome,
            lane,
                        },
                        { signal: controller.signal, timeoutMs: 25_000 },
                      );
                  const clientMs = Math.round(performance.now() - tClient0);
                  if (!isOk(res)) {
                    const e = res as ApiErr;
                    setErr(formatTradeApiError(e));
                    setHistoryRows(
                      updateTradeHistoryRow(optimistic.id, {
                        status: 'failed',
                        error: `${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`,
                      }),
                    );
                  } else {
                    const { result, execution } = unwrapTradeActionData(res.data);
                    const oid = execution?.order_id ?? extractOrderIdFromClobPayload(result);
                    const rt = mergeRoundTripMs(execution?.round_trip_ms, clientMs);
                    setLastExecLatencyMs(rt);
                    if (useMarket) {
                      const sellAllRowId = optimistic.id;
                      setHistoryRows(
                        updateTradeHistoryRow(sellAllRowId, {
                          status: 'sent',
                          submittedPrice01: execution?.submitted_price_01 ?? null,
                          orderId: oid ?? undefined,
                          roundTripMs: rt,
                          error: undefined,
                        }),
                      );
                      setOkMsg(`Market sell-all submitted · ack ${rt}ms — waiting for exchange confirmation…`);
                      scheduleTruthRefreshBurst(token, oid ?? null, () =>
                        afterLiveSellRowReconcile(sellAllRowId, { setOk: setOkMsg }),
                      );
                    } else {
                      setHistoryRows(
                        updateTradeHistoryRow(optimistic.id, {
                          status: 'sent',
                          submittedPrice01: null,
                          orderId: oid ?? undefined,
                          roundTripMs: rt,
                          price01: quoted01,
                          error: undefined,
                        }),
                      );
                      if (oid) pollRestingOrderFill(optimistic.id, oid, sizeLive, price, quoted01);
                      setOkMsg(
                        `${execMode === 'touch' ? 'Quick' : 'Limit'} sell-all sent · intended ${(price * 100).toFixed(1)}¢ · ack ${rt}ms — reading exchange state…`,
                      );
                      void refreshAvgEntry();
                    }
                  }
                } finally {
                  setBusySubmit(false);
                  setSubmitAbort(null);
                  submitLockRef.current = false;
                }
              }}
            >
              {busySubmit ? (
                <>
                  {isSlide ? (
                    <span
                      className="size-4 shrink-0 animate-spin rounded-full border-2 border-rose-200/40 border-t-rose-100"
                      aria-hidden
                    />
                  ) : null}
                  {isSlide ? 'SENDING…' : 'Submitting…'}
                </>
              ) : (
                'Execute Trade'
              )}
            </button>
        </>
      )}
      </>
      ) : null}

      {isSlide && bracketsDockPanel}

      {toasts.length ? (
        <div className="mt-4 space-y-2" aria-live="polite">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start justify-between gap-2 rounded-xl border px-3 py-2.5 text-[11px] leading-snug ${
                t.kind === 'err'
                  ? 'border-rose-800/35 bg-rose-950/15 text-rose-100'
                  : t.kind === 'ok'
                    ? 'border-emerald-800/30 bg-emerald-950/15 text-emerald-100'
                    : 'border-zinc-800/60 bg-black/25 text-zinc-200'
              }`}
            >
              <span className="min-w-0 flex-1 break-words">{t.message}</span>
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                className="shrink-0 rounded px-1.5 text-zinc-500 hover:bg-black/20 hover:text-zinc-300"
                aria-label="Dismiss notification"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {/* Polymarket-style cards — slide dock: Orders & position tab */}
      {showLedgerDock ? (
      <div className="mt-4 space-y-3">
        {/* Your Orders */}
        <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35">
          <div className="flex items-center justify-between gap-2 px-4 py-3">
            <div className="text-[14px] font-semibold text-zinc-100">Your Orders</div>
            <div className="flex items-center gap-2 text-[11px] font-semibold text-zinc-500">
              <span className="rounded-full border border-zinc-800/70 bg-black/20 px-2 py-0.5 text-[10px] font-semibold text-zinc-400">
                {accountMode === 'live' ? 'Live' : 'Paper'}
              </span>
              <span className="font-mono text-zinc-400">
                {accountMode === 'live' ? openOrders.length + localLiveOpenOrdersForToken.length : paperRestingForToken.length} open
              </span>
            </div>
          </div>
          <div className="border-t border-zinc-800/50 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Active book</div>
              <div className="flex flex-wrap gap-2 font-mono text-[11px] text-zinc-400">
                <span className="rounded-lg border border-zinc-800/60 bg-black/15 px-2 py-1">
                  bid {bookTouch?.bestBid != null ? `${(bookTouch.bestBid * 100).toFixed(1)}¢` : '—'}
                </span>
                <span className="rounded-lg border border-zinc-800/60 bg-black/15 px-2 py-1">
                  ask {bookTouch?.bestAsk != null ? `${(bookTouch.bestAsk * 100).toFixed(1)}¢` : '—'}
                </span>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
              <div className="rounded-xl border border-zinc-800/60 bg-black/10 p-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Asks</div>
                <div className="mt-1 space-y-1 font-mono text-zinc-300">
                  {(depth.asks ?? []).slice(0, 5).map((l, i) => (
                    <div key={`ask-${i}`} className="flex items-center justify-between">
                      <span>{(Number(l.price) * 100).toFixed(1)}¢</span>
                      <span className="text-zinc-500">{Number(l.size).toFixed(2)}</span>
                    </div>
                  ))}
                  {(depth.asks ?? []).length === 0 ? <div className="text-zinc-600">—</div> : null}
                </div>
              </div>
              <div className="rounded-xl border border-zinc-800/60 bg-black/10 p-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Bids</div>
                <div className="mt-1 space-y-1 font-mono text-zinc-300">
                  {(depth.bids ?? []).slice(0, 5).map((l, i) => (
                    <div key={`bid-${i}`} className="flex items-center justify-between">
                      <span>{(Number(l.price) * 100).toFixed(1)}¢</span>
                      <span className="text-zinc-500">{Number(l.size).toFixed(2)}</span>
                    </div>
                  ))}
                  {(depth.bids ?? []).length === 0 ? <div className="text-zinc-600">—</div> : null}
                </div>
              </div>
            </div>
          </div>
          <details className="border-t border-zinc-800/50" open>
            <summary className="flex cursor-pointer select-none items-center justify-between gap-3 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500 hover:text-zinc-400">
              <span>Open orders</span>
              <span className="rounded-full border border-zinc-800/70 bg-black/20 px-2 py-0.5 font-mono text-[10px] text-zinc-400">
                {accountMode === 'live' ? openOrders.length + localLiveOpenOrdersForToken.length : paperRestingForToken.length}
              </span>
            </summary>
            <div className="px-4 pb-4">
              {(stopLossEnabled || takeProfitEnabled) ? (
                <div className="mb-3 rounded-xl border border-violet-800/30 bg-violet-950/10 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-violet-200/80">
                    Bracket automation (client-side)
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {stopLossEnabled ? (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800/60 bg-black/10 px-2.5 py-2 text-[11px]">
                        <div className="min-w-0">
                          <span className="mr-2 rounded-full border border-rose-800/35 bg-rose-950/15 px-2 py-0.5 text-[9px] font-black text-rose-100/90">
                            SL {stopLossStatus}
                          </span>
                          <span className="font-mono text-zinc-300">
                            stop {stopLossStopCents?.trim() ? `${stopLossStopCents}¢` : '—'} · limit {stopLossLimitCents?.trim() ? `${stopLossLimitCents}¢` : '—'} ·{' '}
                            {stopLossShares?.trim() ? `${Number(stopLossShares).toFixed(4)} sh` : '—'}
                          </span>
                        </div>
                      </div>
                    ) : null}
                    {takeProfitEnabled ? (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800/60 bg-black/10 px-2.5 py-2 text-[11px]">
                        <div className="min-w-0">
                          <span className="mr-2 rounded-full border border-emerald-800/35 bg-emerald-950/15 px-2 py-0.5 text-[9px] font-black text-emerald-100/90">
                            TP {takeProfitStatus}
                          </span>
                          <span className="font-mono text-zinc-300">
                            take {takeProfitTakeCents?.trim() ? `${takeProfitTakeCents}¢` : '—'} · limit {takeProfitLimitCents?.trim() ? `${takeProfitLimitCents}¢` : '—'} ·{' '}
                            {takeProfitShares?.trim() ? `${Number(takeProfitShares).toFixed(4)} sh` : '—'}
                          </span>
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-2 text-[10px] leading-relaxed text-zinc-500">
                    These are not exchange-native bracket orders. This tab watches price and submits sells when triggered.
                  </div>
                </div>
              ) : null}

              <details className="mb-3 rounded-xl border border-zinc-800/55 bg-black/15">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500 hover:text-zinc-400 marker:content-none [&::-webkit-details-marker]:hidden">
                  <span>Recent actions (session)</span>
                  <span className="rounded-full border border-zinc-800/70 bg-black/20 px-2 py-0.5 font-mono text-[10px] text-zinc-400">
                    {tradeActivityLog.length}
                  </span>
                </summary>
                <div className="border-t border-zinc-800/50 px-3 pb-3 pt-2">
                  {tradeActivityLog.length === 0 ? (
                    <p className="text-[10px] leading-relaxed text-zinc-600">Manual fills, live/paper sends, errors, and SL/TP events append here (last 12).</p>
                  ) : (
                    <ul className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
                      {tradeActivityLog.map((e) => (
                        <li key={e.id} className="text-[10px] leading-snug text-zinc-400">
                          <span className="font-mono tabular-nums text-zinc-600">{new Date(e.ts).toLocaleTimeString()}</span> · {e.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </details>

              {accountMode === 'live' ? (() => {
                const counts = new Map<string, number>();
                for (const o of openOrders) {
                  const side = orderSideFromRow(o) ?? '—';
                  const tok = openOrdersScope === 'all' ? orderTokenIdFromRow(o) ?? '' : token ?? '';
                  const key = `${side}:${tok}`;
                  counts.set(key, (counts.get(key) ?? 0) + 1);
                }
                const anyDup = [...counts.values()].some((n) => n > 1);
                if (!anyDup) return null;
                return (
                  <div className="mb-3 rounded-xl border border-amber-800/35 bg-amber-950/15 px-3 py-2 text-[11px] text-amber-100/90">
                    Multiple open orders detected (duplicates). Double-check before submitting again.
                  </div>
                );
              })() : null}
              {accountMode === 'live' ? (
                localLiveOpenOrdersForToken.length ? (
                  <div className="mb-3 rounded-xl border border-amber-800/35 bg-amber-950/10 px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-200/80">
                      Recently sent (may fill instantly)
                    </div>
                    <div className="mt-2 space-y-1.5">
                      {localLiveOpenOrdersForToken.slice(0, 6).map((r) => (
                        <div
                          key={String(r.id ?? r.orderId ?? `${r.side}-${r.ts}`)}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800/60 bg-black/10 px-2.5 py-2 text-[11px]"
                        >
                          <div className="min-w-0">
                            <span className={`font-bold ${r.side === 'buy' ? 'text-emerald-200' : 'text-rose-200'}`}>
                              {(r.side ?? '—').toUpperCase()}
                            </span>{' '}
                            <span className="font-mono text-zinc-300">{r.price01 != null ? `${(r.price01 * 100).toFixed(1)}¢` : '—'}</span>{' '}
                            <span className="font-mono text-zinc-500">{r.shares != null ? `${Number(r.shares).toFixed(4)} sh` : ''}</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] text-zinc-400">
                            <span className="rounded-full border border-zinc-800/70 bg-black/10 px-2 py-0.5 font-black">
                              {(r.status ?? '—').toUpperCase()}
                            </span>
                            {r.orderId ? (
                              <span className="rounded-full border border-zinc-800/70 bg-black/10 px-2 py-0.5">
                                oid {String(r.orderId).slice(0, 6)}…{String(r.orderId).slice(-4)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null
              ) : null}

              {accountMode === 'live' ? (
                openOrders.length ? (
                  <div className="space-y-2">
                    {openOrders.slice(0, 5).map((o) => {
                      const id = orderIdFromRow(o);
                      const side = orderSideFromRow(o);
                      const px = orderPrice01FromRow(o);
                      const rem = orderRemainingFromRow(o) ?? orderSizeFromRow(o);
                      const size = orderSizeFromRow(o);
                      const filled = size != null && rem != null ? Math.max(0, size - rem) : null;
                      const when = orderCreatedAtFromRow(o);
                      const notionalCents =
                        rem != null && px != null ? Math.abs(Math.round(rem * px * 100)) : null;
                      return (
                        <div
                          key={id ?? JSON.stringify(o).slice(0, 32)}
                          className="rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-[11px] font-bold text-zinc-100">
                                <span className={side === 'buy' ? 'text-emerald-200' : side === 'sell' ? 'text-rose-200' : 'text-zinc-300'}>
                                  {(side ?? '—').toUpperCase()}
                                </span>{' '}
                                {label}
                              </div>
                              <div className="mt-0.5 font-mono text-[11px] text-zinc-400">
                                rem {fmtShares(rem, 'full')} / sz {fmtShares(size, 'full')}{filled != null ? ` · filled ${fmtShares(filled, 'full')}` : ''} @{' '}
                                {px == null ? '—' : `${(px * 100).toFixed(1)}¢`}
                              </div>
                            </div>
                            <button
                              type="button"
                              disabled={!id}
                              onClick={async () => {
                                if (!id) return;
                                await cancelLiveOrderAndRefresh(id);
                              }}
                              className="rounded-lg border border-zinc-800/70 bg-black/20 px-2.5 py-1.5 text-[10px] font-bold text-zinc-300 hover:bg-black/30 disabled:opacity-40"
                            >
                              Cancel
                            </button>
                          </div>
                          <div className="mt-1.5 flex items-center justify-between gap-3 text-[10px] text-zinc-500">
                            <div className="font-mono">{fmtWhen(when)}</div>
                            <div className="font-mono text-zinc-300">{notionalCents == null ? '—' : fmtUsdCents(notionalCents)}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2 text-[11px] text-zinc-500">None</div>
                )
              ) : paperRestingForToken.length ? (
                <div className="space-y-2">
                  {paperRestingForToken.slice(0, 5).map((o) => {
                    const notionalCents = Math.abs(Math.round(o.shares * o.limit01 * 100));
                    return (
                      <div key={o.id} className="rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-[11px] font-bold text-zinc-100">
                              <span className={o.side === 'buy' ? 'text-emerald-200' : 'text-rose-200'}>{o.side.toUpperCase()}</span> {label}
                            </div>
                            <div className="mt-0.5 font-mono text-[11px] text-zinc-400">
                              {fmtShares(o.shares, 'full')} shares @ {(o.limit01 * 100).toFixed(1)}¢
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              cancelPaperOrder(o.id);
                              pushToast('ok', 'Paper order canceled.');
                            }}
                            className="rounded-lg border border-zinc-800/70 bg-black/20 px-2.5 py-1.5 text-[10px] font-bold text-zinc-300 hover:bg-black/30"
                          >
                            Cancel
                          </button>
                        </div>
                        <div className="mt-1.5 flex items-center justify-between gap-3 text-[10px] text-zinc-500">
                          <div className="font-mono">{fmtWhen(o.createdAt)}</div>
                          <div className="font-mono text-zinc-300">{fmtUsdCents(notionalCents)}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2 text-[11px] text-zinc-500">None</div>
              )}
            </div>
          </details>

          <div className="border-t border-zinc-800/50 px-4 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Recent fills</div>
            {accountMode === 'live' && myFillsErr ? (
              <div className="mt-2 rounded-xl border border-rose-900/35 bg-rose-950/15 px-3 py-2 text-[11px] text-rose-100">
                Confirmed fills unavailable: {myFillsErr}
              </div>
            ) : null}
            {recentFillsForToken.length ? (
              <div className="mt-2 space-y-2">
                {recentFillsForToken.map((r) => {
                  const badge =
                    r.status === 'partial'
                      ? { text: 'PARTIAL', cls: 'border-violet-700/35 bg-violet-950/15 text-violet-200/90' }
                      : r.status === 'filled'
                        ? { text: 'FILLED', cls: 'border-emerald-800/30 bg-emerald-950/15 text-emerald-200/90' }
                        : { text: 'PENDING', cls: 'border-amber-800/35 bg-amber-950/15 text-amber-200/90' };
                  const audit = String((r as any).auditNote ?? '').toLowerCase();
                  const isAutoSl = audit.includes('stop_loss');
                  const isAutoTp = audit.includes('take_profit');
                  const autoBadge =
                    isAutoSl || isAutoTp
                      ? {
                          text: isAutoSl ? 'AUTO SL' : 'AUTO TP',
                          cls: isAutoSl
                            ? 'border-rose-800/35 bg-rose-950/15 text-rose-100/90'
                            : 'border-emerald-800/35 bg-emerald-950/15 text-emerald-100/90',
                        }
                      : null;
                  const px = fillPrice01FromRow(r);
                  const lim = limitPrice01FromRow(r);
                  const filled = filledSharesFromRow(r);
                  const req = r.requestedShares ?? null;
                  const rem = remainingSharesFromRow(r);
                  return (
                    <div key={r.id} className="rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold text-zinc-100">
                            <span className={r.side === 'buy' ? 'text-emerald-200' : 'text-rose-200'}>{r.side.toUpperCase()}</span>
                            <span className="text-zinc-300">{label}</span>
                            <span className={`rounded-full border px-2 py-0.5 text-[9px] font-black ${badge.cls}`}>{badge.text}</span>
                            {r.mode === 'live' ? (
                              <span className="rounded-full border border-sky-800/35 bg-sky-950/15 px-2 py-0.5 text-[9px] font-black text-sky-100/90">LIVE</span>
                            ) : (
                              <span className="rounded-full border border-amber-800/35 bg-amber-950/15 px-2 py-0.5 text-[9px] font-black text-amber-100/90">PAPER</span>
                            )}
                            {autoBadge ? (
                              <span
                                className={`rounded-full border px-2 py-0.5 text-[9px] font-black ${autoBadge.cls}`}
                                title={String((r as any).auditNote ?? '') || undefined}
                              >
                                {autoBadge.text}
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-1 font-mono text-[15px] font-black tabular-nums tracking-tight text-zinc-50">
                            {px != null ? (
                              <>
                                {formatFillCents(px)}{' '}
                                <span className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">fill avg</span>
                              </>
                            ) : (
                              <span className="text-[11px] font-normal text-zinc-500">Fill avg pending (tape reconcile)</span>
                            )}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-zinc-300">
                            <span>
                              {filled.toFixed(4)}
                              {req != null ? ` / ${Number(req).toFixed(4)}` : ''}
                              {rem != null ? ` · rem ${Number(rem).toFixed(4)}` : ''} sh
                            </span>
                            {r.orderId ? (
                              <span className="text-zinc-500">
                                oid {r.orderId.slice(0, 6)}…{r.orderId.slice(-4)}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="text-right font-mono text-[11px] text-zinc-200">{r.usdCents == null ? '—' : fmtUsdCents(Math.abs(r.usdCents))}</div>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-3 text-[10px] text-zinc-500">
                        <div className="font-mono">{fmtWhen(r.ts)}</div>
                        <div className="font-mono">
                          {lim != null ? `limit ${formatFillCents(lim, 1)}` : 'limit —'}
                          {px != null && lim != null && Math.abs(px - lim) > 0.002
                            ? ` · Δ${(Math.abs(px - lim) * 100).toFixed(1)}¢`
                            : ''}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="mt-2 rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2 text-[11px] text-zinc-500">No fills yet.</div>
            )}
          </div>
        </div>

        {/* Your Positions */}
        {(() => {
          const upSh =
            accountMode === 'paper'
              ? paperUpPos.shares
              : liveLaneShares('display', 'up') > 0
                ? liveLaneShares('display', 'up')
                : balUp != null
                  ? balUp
                  : null;
          const downSh =
            accountMode === 'paper'
              ? paperDownPos.shares
              : liveLaneShares('display', 'down') > 0
                ? liveLaneShares('display', 'down')
                : balDown != null
                  ? balDown
                  : null;
          const upSellSh = accountMode === 'paper' ? paperUpPos.shares : liveLaneShares('sell', 'up');
          const downSellSh = accountMode === 'paper' ? paperDownPos.shares : liveLaneShares('sell', 'down');
          const upAvg = accountMode === 'paper' ? paperUpPos.avgCost01 : avgEntryUp;
          const downAvg = accountMode === 'paper' ? paperDownPos.avgCost01 : avgEntryDown;
          const upPx = midUpEff;
          const downPx = midDownEff;

          const upVal = upSh != null && upPx != null ? Math.round(upSh * upPx * 100) : null;
          const downVal = downSh != null && downPx != null ? Math.round(downSh * downPx * 100) : null;
          const upCost = upSh != null && upAvg != null ? Math.round(upSh * upAvg * 100) : null;
          const downCost = downSh != null && downAvg != null ? Math.round(downSh * downAvg * 100) : null;
          const upPnl = upVal != null && upCost != null ? upVal - upCost : null;
          const downPnl = downVal != null && downCost != null ? downVal - downCost : null;
          const pnlTotal =
            upPnl != null || downPnl != null ? (upPnl ?? 0) + (downPnl ?? 0) : null;

          const tabLane = lane === 'down' ? 'down' : 'up';
          const selSh = tabLane === 'up' ? upSh : downSh;
          const selSellSh = tabLane === 'up' ? upSellSh : downSellSh;
          const selAvg = tabLane === 'up' ? upAvg : downAvg;
          const selPx = tabLane === 'up' ? upPx : downPx;
          const selVal = selSh != null && selPx != null ? Math.round(selSh * selPx * 100) : null;
          const selMax =
            selSellSh > 0 ? floorSharesWhole(selSellSh) : selSh != null && selSh > 0 ? floorSharesWhole(selSh) : 0;

          const pnlBadge = (p: number | null) => {
            if (p == null) return '—';
            const cls = p > 0 ? 'text-emerald-200' : p < 0 ? 'text-rose-200' : 'text-zinc-300';
            return <span className={cls}>{fmtUsdCents(p)}</span>;
          };

          return (
            <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35">
              <div className="flex items-center justify-between gap-2 px-4 py-3">
                <div className="text-[14px] font-semibold text-zinc-100">Your Positions</div>
                <div className="text-[11px] font-semibold text-zinc-500">
                  P&amp;L: {pnlTotal == null ? '—' : pnlBadge(pnlTotal)}
                </div>
              </div>
              <div className="border-t border-zinc-800/50 px-4 py-3">
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => chooseLane('up')}
                    className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                      tabLane === 'up' ? 'border-emerald-500/70 bg-emerald-950/25 ring-2 ring-emerald-500/20' : 'border-zinc-800/60 bg-black/15 hover:bg-black/20'
                    }`}
                  >
                    <OutcomeLaneHeader lane="up" label={upLabel} momentum={outcomeMomentumUp} />
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <div className="font-mono text-[12px] font-bold text-zinc-100">{upSh == null ? '—' : upSh.toFixed(2)} sh</div>
                      <div className="text-[11px] font-semibold">{pnlBadge(upPnl)}</div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => chooseLane('down')}
                    className={`rounded-xl border px-3 py-2 text-left transition-colors ${
                      tabLane === 'down' ? 'border-rose-500/70 bg-rose-950/20 ring-2 ring-rose-500/20' : 'border-zinc-800/60 bg-black/15 hover:bg-black/20'
                    }`}
                  >
                    <OutcomeLaneHeader lane="down" label={downLabel} momentum={outcomeMomentumDown} />
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <div className="font-mono text-[12px] font-bold text-zinc-100">{downSh == null ? '—' : downSh.toFixed(2)} sh</div>
                      <div className="text-[11px] font-semibold">{pnlBadge(downPnl)}</div>
                    </div>
                  </button>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2">
                  <div className="rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Holding</div>
                    <div className="mt-0.5 font-mono text-[14px] font-bold text-zinc-100">
                      {selSh == null ? '—' : selSh.toFixed(2)} <span className="text-zinc-500">{tabLane === 'up' ? upLabel : downLabel}</span>
                    </div>
                  </div>
                  <div className="rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Avg entry</div>
                    <div className="mt-0.5 font-mono text-[14px] font-bold text-zinc-100">{selAvg == null ? '—' : `${(selAvg * 100).toFixed(1)}¢`}</div>
                  </div>
                  <div className="rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Current price</div>
                    <div className="mt-0.5 font-mono text-[14px] font-bold text-zinc-100">{tabLane === 'up' ? fmtCents(upPx) : fmtCents(downPx)}</div>
                  </div>
                  <div className="rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Current value</div>
                    <div className="mt-0.5 font-mono text-[14px] font-bold text-zinc-100">{selVal == null ? '—' : fmtUsdCents(selVal)}</div>
                  </div>
                </div>

                <div className="mt-3 rounded-xl border border-zinc-800/60 bg-black/10 px-3 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Sell input</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setQuickSellMode('market')}
                      className={`rounded-full border px-2.5 py-1 text-[10px] font-black ${
                        quickSellMode === 'market'
                          ? 'border-emerald-600/40 bg-emerald-950/25 text-emerald-200'
                          : 'border-zinc-800/70 bg-black/20 text-zinc-400 hover:text-zinc-200'
                      }`}
                      title="Market (FAK): crosses the book and fills immediately (best for not missing by a few cents)."
                    >
                      Market (FAK)
                    </button>
                    <button
                      type="button"
                      onClick={() => setQuickSellMode('touch_limit')}
                      className={`rounded-full border px-2.5 py-1 text-[10px] font-black ${
                        quickSellMode === 'touch_limit'
                          ? 'border-rose-600/40 bg-rose-950/25 text-rose-200'
                          : 'border-zinc-800/70 bg-black/20 text-zinc-400 hover:text-zinc-200'
                      }`}
                      title="Touch limit: posts at best bid then cancels quickly; can miss if the bid moves down."
                    >
                      Touch limit
                    </button>
                    <span className="text-[10px] font-semibold text-zinc-500">
                      {quickSellMode === 'market' ? 'Fills faster, can slip a bit.' : 'Less slip, can miss.'}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input
                      value={sellQty}
                      onChange={(e) => setSellQty(e.target.value)}
                      inputMode="decimal"
                      placeholder={`Qty (max ${selMax})`}
                      className="min-h-[42px] flex-1 rounded-xl border border-zinc-800/70 bg-black/20 px-3 font-mono text-[13px] text-zinc-100 outline-none focus:border-zinc-600/70"
                    />
                    <button
                      type="button"
                      disabled={!Number.isFinite(selMax) || selMax <= 0 || busySubmit || busyRefresh}
                      onClick={() => setSellQty(selMax > 0 ? String(selMax) : '0')}
                      className="min-h-[42px] rounded-xl border border-zinc-800/70 bg-black/20 px-3 text-[11px] font-bold text-zinc-200 hover:bg-black/30 disabled:opacity-40"
                    >
                      Max
                    </button>
                    <button
                      type="button"
                      disabled={busySubmit || busyRefresh || !sellQtyOk || sellSharesClamped == null || sellSharesClamped <= 0}
                      onClick={async () => {
                        chooseAction('sell');
                        await runMarketSell(sellSharesClamped ?? 0);
                      }}
                      className="min-h-[42px] rounded-xl bg-rose-500 px-4 text-[11px] font-black text-black hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Sell
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={busySubmit || busyRefresh || !(selMax > 0)}
                  onClick={async () => {
                    chooseLane(tabLane);
                    chooseAction('sell');
                    await runMarketSell(selMax);
                  }}
                  className="mt-3 min-h-[46px] w-full rounded-xl bg-zinc-100 px-4 text-sm font-black text-black hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Close Position (Sell All {selMax > 0 ? `${selMax.toFixed(2)} sh` : ''})
                </button>

                <details className="mt-3 rounded-xl border border-zinc-800/60 bg-zinc-950/30">
                  <summary className="cursor-pointer select-none px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500 hover:text-zinc-400">
                    Trade history
                  </summary>
                  <div className="border-t border-zinc-800/50 px-3 py-3">
                    {recentActivityForToken.length ? (
                      <>
                        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Recent activity</div>
                        <div className="mt-2 space-y-2">
                          {recentActivityForToken.slice(0, 8).map((r) => (
                            <div key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2">
                              <div className="min-w-0">
                                <div className="text-[11px] font-bold text-zinc-100">
                                  <span className={r.side === 'buy' ? 'text-emerald-200' : 'text-rose-200'}>{r.side.toUpperCase()}</span>{' '}
                                  {tabLane === 'up' ? upLabel : downLabel}
                                  <span
                                    className={`ml-2 rounded-full border px-2 py-0.5 text-[9px] font-black ${
                                      r.status === 'filled'
                                        ? 'border-emerald-800/30 bg-emerald-950/15 text-emerald-200/90'
                                        : r.status === 'partial'
                                          ? 'border-violet-700/35 bg-violet-950/15 text-violet-200/90'
                                          : r.status === 'failed'
                                            ? 'border-rose-800/35 bg-rose-950/15 text-rose-200/90'
                                            : 'border-amber-800/35 bg-amber-950/15 text-amber-200/90'
                                    }`}
                                  >
                                    {String(r.status).toUpperCase()}
                                  </span>
                                </div>
                                <div className="mt-0.5 font-mono text-[11px] text-zinc-400">
                                  {(r.shares ?? 0).toFixed(4)}
                                  {r.requestedShares != null ? ` / ${Number(r.requestedShares).toFixed(4)}` : ''} @{' '}
                                  {fillPrice01FromRow(r) == null
                                    ? limitPrice01FromRow(r) != null
                                      ? `limit ${formatFillCents(limitPrice01FromRow(r), 1)} (fill pending)`
                                      : '—'
                                    : formatFillCents(fillPrice01FromRow(r)!)}
                                  {r.orderId ? ` · oid ${r.orderId.slice(0, 6)}…${r.orderId.slice(-4)}` : ''}
                                </div>
                                <div className="mt-0.5 font-mono text-[10px] text-zinc-500">
                                  ack {fmtMs(r.roundTripMs)}
                                  {r.intendedPrice01 != null ? ` · intended ${(r.intendedPrice01 * 100).toFixed(1)}¢` : ''}
                                  {r.submittedPrice01 != null ? ` · accepted ${(r.submittedPrice01 * 100).toFixed(1)}¢` : ''}
                                  {r.fillAvgPrice01 != null ? ` · avg ${(r.fillAvgPrice01 * 100).toFixed(2)}¢` : ''}
                                </div>
                              </div>
                              <div className="font-mono text-[11px] text-zinc-300">{r.usdCents == null ? '—' : fmtUsdCents(Math.abs(r.usdCents))}</div>
                            </div>
                          ))}
                        </div>
                        <div className="mt-3 h-px bg-zinc-800/50" />
                        <div className="mt-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Confirmed fills</div>
                      </>
                    ) : (
                      <div className="rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2 text-[11px] text-zinc-500">
                        No activity yet.
                      </div>
                    )}
                    {recentFillsForToken.length ? (
                      <div className="space-y-2">
                        {recentFillsForToken.slice(0, 10).map((r) => (
                          <div key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2">
                            <div className="min-w-0">
                              <div className="text-[11px] font-bold text-zinc-100">
                                <span className={r.side === 'buy' ? 'text-emerald-200' : 'text-rose-200'}>{r.side.toUpperCase()}</span>{' '}
                                {tabLane === 'up' ? upLabel : downLabel}
                                {r.status === 'partial' ? (
                                  <span className="ml-2 rounded-full border border-violet-700/35 bg-violet-950/15 px-2 py-0.5 text-[9px] font-black text-violet-200/90">
                                    PARTIAL
                                  </span>
                                ) : r.status === 'filled' ? (
                                  <span className="ml-2 rounded-full border border-emerald-800/30 bg-emerald-950/15 px-2 py-0.5 text-[9px] font-black text-emerald-200/90">
                                    FILLED
                                  </span>
                                ) : (
                                  <span className="ml-2 rounded-full border border-amber-800/35 bg-amber-950/15 px-2 py-0.5 text-[9px] font-black text-amber-200/90">
                                    PENDING
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 font-mono text-[11px] text-zinc-400">
                                {(r.shares ?? 0).toFixed(4)}
                                {(r as any).requestedShares != null ? ` / ${Number((r as any).requestedShares).toFixed(4)}` : ''}{' '}
                                @{' '}
                                {fillPrice01FromRow(r) == null
                                  ? 'fill pending'
                                  : formatFillCents(fillPrice01FromRow(r)!)}
                              </div>
                            </div>
                            <div className="font-mono text-[11px] text-zinc-300">{r.usdCents == null ? '—' : fmtUsdCents(Math.abs(r.usdCents))}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2 text-[11px] text-zinc-500">No fills yet.</div>
                    )}
                  </div>
                </details>
              </div>
            </div>
          );
        })()}
      </div>
      ) : null}

      <details className="mt-4 rounded-xl border border-zinc-800/60 bg-zinc-950/40 text-[10px] text-zinc-500">
        <summary className="cursor-pointer select-none px-3 py-2 font-medium text-zinc-500 hover:text-zinc-400">
          Server trading setup
        </summary>
        <div className="border-t border-zinc-800/50 px-3 pb-3 pt-2 leading-relaxed">
          Orders use the Polymarket CLOB API via this app. Set <span className="font-mono text-zinc-400">POLYMARKET_PRIVATE_KEY</span> and{' '}
          <span className="font-mono text-zinc-400">POLYMARKET_FUNDER</span> in <span className="font-mono text-zinc-400">api/.env</span>, then
          restart the API.
        </div>
      </details>
    </div>
  );
}
