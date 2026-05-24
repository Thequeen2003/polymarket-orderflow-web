import { Fragment, type ReactElement, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
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
import { buildBracketMomentumUi } from './bracketMomentumReadout';
import { computeBookIntel } from './bookIntel';
import type { SpotPoint } from './SpotLevelChart';
import { buildBracketAutomationExplain, type BracketLegExplain } from './tradeAutomationExplain';
import { PAPER_ACCOUNT_SYNC_EVENT } from './paperAccountSync';
import { paperSettlementCaption } from './paperMarketSettlement';
import { parseRestingOrderSnapshot } from './orderStatusParse';
import { floorShares4, roundPrice01, roundShares4, roundUsd2 } from './tradingRound';
import { bullpenOutcomeForOrder } from './bullpenOutcome';
import { formatTradeApiError } from './formatTradeApiError';
import {
  bracketAutomationBid01,
  evaluateStopLossCross,
  evaluateTakeProfitCross,
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
import { submitLiveBracketFakSell } from './liveBracketExit';
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
  BPX_TRADE_SYNC_SIZE_SHARES_EVENT,
} from './takeSignalDesk';
import {
  BPX_RESET_PHANTOM_POSITION_EVENT,
  dispatchSignalsClearHold,
  isOutcomePositionFlat,
  type ResetPhantomPositionDetail,
} from './signalsDeskHold';
import { dispatchOutcomePositions } from './signalsDeskPosition';

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
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (!(n > 0) || n >= 100) return null;
  return clamp01(n / 100);
}

/** Min gap between live bracket exit attempts when the prior FAK did not fill. */
const BRACKET_EXIT_RETRY_MS = 2800;

function bracketExitCooldownActive(lastAttemptMs: number): boolean {
  return lastAttemptMs > 0 && Date.now() - lastAttemptMs < BRACKET_EXIT_RETRY_MS;
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

type ArmRiskAfterBuyPrefs = { armSl: boolean; armTp: boolean; useSignalLevels: boolean };

function loadArmRiskAfterBuyPrefs(): ArmRiskAfterBuyPrefs {
  try {
    const raw = window.localStorage.getItem(ARM_RISK_AFTER_BUY_KEY);
    if (!raw) return { armSl: true, armTp: true, useSignalLevels: true };
    const j = JSON.parse(raw) as { armSl?: unknown; armTp?: unknown; useSignalLevels?: unknown };
    return {
      armSl: j.armSl !== false,
      armTp: j.armTp !== false,
      useSignalLevels: j.useSignalLevels !== false,
    };
  } catch {
    return { armSl: false, armTp: false, useSignalLevels: true };
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
  lane?: 'up' | 'down';
  onLaneChange?: (lane: 'up' | 'down') => void;
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
    lane: controlledLane,
    onLaneChange,
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
  const [pendingAutoBuy, setPendingAutoBuy] = useState<{
    lane: 'up' | 'down';
    at: number;
    buyNonce: number;
    armSlTp?: boolean;
    sizeShares?: number;
    fromSignalsDesk?: boolean;
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

  const [armRiskAfterBuy, setArmRiskAfterBuy] = useState<ArmRiskAfterBuyPrefs>(() => loadArmRiskAfterBuyPrefs());

  useEffect(() => {
    const onSubmitBuy = (ev: Event) => {
      const ce = ev as CustomEvent<{
        slug?: string;
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
      const submitSlug = d?.slug?.trim();
      const panelSlug = marketSlug?.trim();
      if (submitSlug && panelSlug && submitSlug !== panelSlug) {
        pushToast('err', 'Buy blocked — signal belongs to a different market. Re-open the matching Signals market.', 7200);
        return;
      }

      const ingressSh =
        d.sizeShares != null && Number.isFinite(d.sizeShares) ? roundShares4(d.sizeShares) : null;
      const ingressKey = `${submitSlug ?? panelSlug ?? ''}|${submitLane}|${ingressSh ?? ''}|${
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
  }, [controlledLane, downToken, marketSlug, onLaneChange, pushToast, setArmRiskAfterBuy, upToken]);

  const [lastExecLatencyMs, setLastExecLatencyMs] = useState<number | null>(null);
  const liveSubmitGenRef = useRef(0);
  const submitLockRef = useRef(false);
  const buyButtonRef = useRef<HTMLButtonElement>(null);
  const [autoBuyRetryTick, setAutoBuyRetryTick] = useState(0);
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
  /** Slide trade dock: outcome trade vs brackets vs ledger. */
  const [slideDockTab, setSlideDockTab] = useState<'outcome' | 'brackets' | 'ledger'>('outcome');
  /** Keep Brackets tab when UP/DOWN token changes — avoid snapping to Outcome mid TP/SL edit. */
  const preserveBracketsDockRef = useRef(false);
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

  /** Re-run bracket triggers on a timer while armed (live mids can update without React state churn). */
  /** CLOB poll target while SL/TP armed — tracks bracket token even when the UP/DOWN tab differs. */
  const [bracketPollToken, setBracketPollToken] = useState<string | null>(null);
  /** SL/TP localStorage + poll follow the armed position token, not the visible UP/DOWN tab. */
  const riskPrefsToken = bracketPollToken?.trim() || token?.trim() || '';
  const armedBracketLane = useMemo((): 'up' | 'down' | null => {
    const pt = bracketPollToken?.trim();
    if (!pt) return null;
    if (upToken?.trim() && pt === upToken.trim()) return 'up';
    if (downToken?.trim() && pt === downToken.trim()) return 'down';
    return bracketOutcomeLaneRef.current;
  }, [bracketPollToken, upToken, downToken]);

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
  const [takeProfitShares, setTakeProfitShares] = useState('');
  const [takeProfitStatus, setTakeProfitStatus] = useState<'OFF' | 'ARMED' | 'TRIGGERED'>('OFF');
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

  /** Keep armed pin aligned with the ¢ fields automation actually watches (localStorage load, edits, etc.). */
  useEffect(() => {
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
    preserveBracketsDockRef.current =
      slideDockTab === 'brackets' ||
      riskSellSheet === 'sl' ||
      riskSellSheet === 'tp' ||
      riskSellSheet === 'settings';
  }, [slideDockTab, riskSellSheet]);

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
        if (maySetCents(takeProfitTakeCents)) {
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
        if (maySetCents(stopLossStopCents)) {
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

  /** Latest trade-card TP/SL from Signals desk (see `dispatchSignalRiskLevels`). */
  const signalRiskRef = useRef<SignalRiskSnapshot | null>(null);
  /** Planning reference (PTB overlays / drag sync; does not auto-trade). */
  const [planStandardCents, setPlanStandardCents] = useState('');

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
      signalRiskRef.current = { ...d, updatedAtMs: Date.now() };
    };
    window.addEventListener(BPX_SIGNAL_RISK_LEVELS_EVENT, onSignalRisk as EventListener);
    return () => window.removeEventListener(BPX_SIGNAL_RISK_LEVELS_EVENT, onSignalRisk as EventListener);
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
    // Fallback polling while tab is visible (WS / REST books are primary; this keeps mark/TP honest).
    const id = window.setInterval(tick, 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [accountMode, upToken, downToken, fetchLastTradesBoth]);

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
      .filter((r) => r.status === 'sending' || r.status === 'pending' || r.status === 'sent' || r.status === 'partial')
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
    // Always show local fills immediately; merge in confirmed CLOB fills when available.
    const localBase = historyRows
      .filter((r) => {
        if (r.token.trim() !== tid || r.mode !== modeWant) return false;
        if (r.status === 'filled' || r.status === 'partial') {
          if (modeWant === 'live' && !rowShowsExchangeFill(r)) return false;
          return true;
        }
        return false;
      })
      .slice()
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

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

    const local = localBase.map(upgradeBracketRowFromTape);

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

  const bestBidCents = useMemo(() => {
    const bid = bookTouch?.bestBid;
    if (bid == null || !Number.isFinite(bid) || bid <= 0 || bid >= 1) return null;
    return Math.round(bid * 1000) / 10;
  }, [bookTouch]);

  const bestAskCents = useMemo(() => {
    const ask = bookTouch?.bestAsk;
    if (ask == null || !Number.isFinite(ask) || ask <= 0 || ask >= 1) return null;
    return Math.round(ask * 1000) / 10;
  }, [bookTouch]);

  const scalp = useMemo(() => {
    const bid = bestBidCents;
    const ask = bestAskCents;
    const midPx = mid != null && Number.isFinite(mid) ? Math.round(mid * 1000) / 10 : null;
    const spread = spreadCents != null && Number.isFinite(spreadCents) ? spreadCents : null;
    const minMove = spread != null ? Math.max(2, Math.ceil(spread + 1)) : 3; // cents; needs to beat spread + fees + noise
    const tp = (entry: number) => Math.max(1, Math.min(99, Math.round((entry + minMove) * 10) / 10));
    const st = (entry: number) => Math.max(1, Math.min(99, Math.round((entry - Math.max(2, Math.ceil(minMove / 2))) * 10) / 10));

    const joinBid = bid != null ? Math.max(1, Math.min(99, Math.round(bid))) : null;
    const takeAsk = ask != null ? Math.max(1, Math.min(99, Math.round(ask))) : null;
    const microImproveBuy = bid != null ? Math.max(1, Math.min(99, Math.round(bid + 1))) : null;
    const microImproveSell = ask != null ? Math.max(1, Math.min(99, Math.round(ask - 1))) : null;
    const midRound = midPx != null ? Math.max(1, Math.min(99, Math.round(midPx))) : null;

    const readiness = ptbContext?.readinessState ?? null;
    const laneOk = ptbContext?.readinessLane == null || ptbContext.readinessLane === lane;

    return {
      bid,
      ask,
      mid: midPx,
      spread,
      minMove,
      tp,
      st,
      joinBid,
      takeAsk,
      microImproveBuy,
      microImproveSell,
      midRound,
      readiness,
      laneOk,
    } as const;
  }, [bestAskCents, bestBidCents, lane, mid, ptbContext, spreadCents]);

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
    const quote = executableQuote01;
    if (quote == null || !Number.isFinite(quote) || quote <= 0) return null;
    const bid = bookTouch?.bestBid != null && bookTouch.bestBid > 0 ? roundPrice01(bookTouch.bestBid) : null;
    const ask = bookTouch?.bestAsk != null && bookTouch.bestAsk > 0 ? roundPrice01(bookTouch.bestAsk) : null;
    const spread01 = bid != null && ask != null ? Math.max(0, ask - bid) : 0;
    const tick01 = 0.001; // 0.1¢
    const base = Math.max(tick01 * 3, spread01 || tick01 * 5);
    const tp01 = Math.min(0.99, Math.max(0.01, quote + base * 3));
    const stop01 = Math.min(0.99, Math.max(0.01, quote - base * 2));
    const tpCents = (tp01 * 100).toFixed(1);
    const stopCents = (stop01 * 100).toFixed(1);
    const sideLabel = action === 'buy' ? 'TP (sell)' : 'TP (buyback)';
    return {
      tp01,
      stop01,
      tpCents,
      stopCents,
      sideLabel,
      quoteCents: (quote * 100).toFixed(1),
      spreadCents: (spread01 * 100).toFixed(2),
    };
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
    const keepBracketsDock = isSlide && preserveBracketsDockRef.current;
    if (!keepBracketsDock) {
      setRiskSellSheet(null);
      setSlideDockTab('outcome');
    }
    setPlanStandardCents('');
    buyRiskArmedRowIdsRef.current.clear();
    buyReconcileToastRowIdsRef.current.clear();
    if (!keepBracketsDock) {
      bracketArmedPinRef.current = null;
      operatorSlTpLockedRef.current = false;
    }
  }, [token, isSlide]);

  useEffect(() => {
    preserveBracketsDockRef.current = false;
    setRiskSellSheet(null);
    setPlanStandardCents('');
    setSlideDockTab('outcome');
    buyRiskArmedRowIdsRef.current.clear();
    buyReconcileToastRowIdsRef.current.clear();
    bracketArmedPinRef.current = null;
    operatorSlTpLockedRef.current = false;
    setBracketPollToken(null);
  }, [marketSlug]);

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
      const { armSl, armTp, useSignalLevels } = prefsOverride ?? armRiskAfterBuy;
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
      if (overwrite) {
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
      const pickCents = (prev: string, next: string) =>
        overwrite ? next : operatorLocked || usePin ? (prev.trim() || next) : prev.trim() ? prev : next;
      if (armSl) {
        resetStopLossBracketMemory({
          lastCross: stopLossLastCrossRef,
          prevBid: stopLossPrevBidRef,
          prevAsk: stopLossPrevAskRef,
          prevStripMid: stopLossPrevStripMidRef,
          lastFireTok: stopLossLastFireTokRef,
          fireLock: stopLossFireLockRef,
        });
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

  /** When Auto-arm SL/TP is checked — apply card/spread levels immediately (not only after next buy). */
  const applyArmRiskNow = useCallback((prefsOverride?: ArmRiskAfterBuyPrefs) => {
    const prefs = prefsOverride ?? armRiskAfterBuy;
    const { armSl, armTp } = prefs;
    if (!armSl && !armTp) return;
    if (operatorSlTpLockedRef.current && bracketArmedPinRef.current) {
      return;
    }
    operatorSlTpLockedRef.current = false;
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

  const onAutoArmSlChange = useCallback(
    (checked: boolean) => {
      setArmRiskAfterBuy((p) => {
        const merged = { ...p, armSl: checked };
        if (checked) {
          operatorSlTpLockedRef.current = false;
          bracketArmedPinRef.current = null;
          queueMicrotask(() => applyArmRiskNow(merged));
        }
        return merged;
      });
    },
    [applyArmRiskNow, setArmRiskAfterBuy],
  );

  const onAutoArmTpChange = useCallback(
    (checked: boolean) => {
      setArmRiskAfterBuy((p) => {
        const merged = { ...p, armTp: checked };
        if (checked) {
          operatorSlTpLockedRef.current = false;
          bracketArmedPinRef.current = null;
          queueMicrotask(() => applyArmRiskNow(merged));
        }
        return merged;
      });
    },
    [applyArmRiskNow, setArmRiskAfterBuy],
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
            { armSl: false, armTp: true, useSignalLevels: armRiskAfterBuy.useSignalLevels },
          );
          if (tpCents) tpCentsOut = tpCents;
        } else if (riskTargetsFromEntry?.tpCents) {
          tpCentsOut = riskTargetsFromEntry.tpCents;
          setTakeProfitTakeCents(tpCentsOut);
          setTakeProfitLimitCents(tpCentsOut);
        } else if (targets?.tpCents) {
          tpCentsOut = targets.tpCents;
          setTakeProfitTakeCents(tpCentsOut);
          setTakeProfitLimitCents(tpCentsOut);
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
      if (takeProfitSimple && takeStr) setTakeProfitLimitCents(takeStr);
      if (!takeProfitShares.trim() && positionShares != null && positionShares > 0) {
        setTakeProfitShares(String(floorShares4(positionShares)));
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
            { armSl: true, armTp: false, useSignalLevels: armRiskAfterBuy.useSignalLevels },
          );
          if (stopCents) stopCentsOut = stopCents;
        } else if (riskTargetsFromEntry?.stopCents) {
          stopCentsOut = riskTargetsFromEntry.stopCents;
          setStopLossStopCents(stopCentsOut);
          setStopLossLimitCents(stopCentsOut);
        } else if (targets?.stopCents) {
          stopCentsOut = targets.stopCents;
          setStopLossStopCents(stopCentsOut);
          setStopLossLimitCents(stopCentsOut);
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
      if (stopLossSimple && stopStr) setStopLossLimitCents(stopStr);
      if (!stopLossShares.trim() && positionShares != null && positionShares > 0) {
        setStopLossShares(String(floorShares4(positionShares)));
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

  /** Trigger move vs avg entry when known, else vs mid — relative to probability price (not nominal dollar %). */
  const stopVersusRefPctLabel = useMemo(() => {
    const stop01 = centsStrTo01(stopLossStopCents);
    if (stop01 == null) return null;
    const ref01 =
      avgEntry != null && avgEntry > 0 && avgEntry < 1 ? avgEntry : mid != null && mid > 0 && mid < 1 ? mid : null;
    if (ref01 == null) return null;
    const p = ((stop01 - ref01) / ref01) * 100;
    if (!Number.isFinite(p)) return null;
    const suffix = avgEntry != null && avgEntry > 0 && avgEntry < 1 ? 'avg entry' : 'mid';
    return `${p >= 0 ? '+' : ''}${p.toFixed(1)}% vs ${suffix}`;
  }, [stopLossStopCents, avgEntry, mid]);

  const takeVersusRefPctLabel = useMemo(() => {
    const take01 = centsStrTo01(takeProfitTakeCents);
    if (take01 == null) return null;
    const ref01 =
      avgEntry != null && avgEntry > 0 && avgEntry < 1 ? avgEntry : mid != null && mid > 0 && mid < 1 ? mid : null;
    if (ref01 == null) return null;
    const p = ((take01 - ref01) / ref01) * 100;
    if (!Number.isFinite(p)) return null;
    const suffix = avgEntry != null && avgEntry > 0 && avgEntry < 1 ? 'avg entry' : 'mid';
    return `${p >= 0 ? '+' : ''}${p.toFixed(1)}% vs ${suffix}`;
  }, [takeProfitTakeCents, avgEntry, mid]);

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
    let raw: number | null;
    if (accountMode === 'live') {
      const lt = L === 'up' ? lastTradeUp01 : lastTradeDown01;
      raw = lt ?? b ?? c;
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

  const quickLimitBuyPresets = useMemo(() => {
    const out: { key: string; label: string; cents: number }[] = [];
    const push = (key: string, label: string, cents: number) => {
      const c = Math.max(1, Math.min(99, Math.round(cents)));
      if (!out.some((x) => x.key === key)) out.push({ key, label, cents: c });
    };
    const ask = bookTouch?.bestAsk;
    if (ask != null && ask > 0 && ask < 1) {
      const ac = Math.round(ask * 100);
      push('ask', `Ask ${ac}¢`, ac);
      push('ask-1', 'Ask−1', ac - 1);
      push('ask-2', 'Ask−2', ac - 2);
    }
    if (midCents != null) {
      const m = Math.round(midCents);
      push('mid', `Mid ${m}¢`, m);
      for (const d of [1, 2, 3]) push(`m+${d}`, `Mid+${d}`, m + d);
    }
    return out.slice(0, 8);
  }, [bookTouch?.bestAsk, midCents]);

  const quickLimitSellPresets = useMemo(() => {
    const out: { key: string; label: string; cents: number }[] = [];
    const push = (key: string, label: string, cents: number) => {
      const c = Math.max(1, Math.min(99, Math.round(cents)));
      if (!out.some((x) => x.key === key)) out.push({ key, label, cents: c });
    };
    const bid = bookTouch?.bestBid;
    if (bid != null && bid > 0 && bid < 1) {
      const bc = Math.round(bid * 100);
      push('bid', `Bid ${bc}¢`, bc);
      push('bid+1', 'Bid+1', bc + 1);
      push('bid+2', 'Bid+2', bc + 2);
    }
    if (midCents != null) {
      const m = Math.round(midCents);
      push('mid', `Mid ${m}¢`, m);
      for (const d of [1, 2, 3]) push(`m-${d}`, `Mid−${d}`, m - d);
    }
    return out.slice(0, 8);
  }, [bookTouch?.bestBid, midCents]);

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

  const readLiveBalancesOnce = useCallback(async () => {
    if (!upToken || !downToken) return;
    const [rC, rU, rD] = await Promise.all([
      tradeBalanceAllowance({ assetType: 'collateral' }),
      tradeBalanceAllowance({ tokenId: upToken, assetType: 'conditional', marketSlug: marketSlug ?? '', outcome: upLabel }),
      tradeBalanceAllowance({ tokenId: downToken, assetType: 'conditional', marketSlug: marketSlug ?? '', outcome: downLabel }),
    ]);
    if (isOk(rC)) setAvailUsdc(parseUsdcBalance(rC.data.balance));
    if (isOk(rU)) setBalUp(parseOutcomeSharesBalance(rU.data.balance));
    if (isOk(rD)) setBalDown(parseOutcomeSharesBalance(rD.data.balance));
    if (!isOk(rU) || !isOk(rD)) {
      const err = !isOk(rU) ? (rU as ApiErr).error : (rD as ApiErr).error;
      setBalError(
        err === 'bullpen_not_logged_in'
          ? 'Live balance unavailable — run `bullpen login` on the API host.'
          : 'Position/balance unavailable — check Bullpen login or API live config.',
      );
    }
  }, [downToken, downLabel, marketSlug, upToken, upLabel]);

  const refreshLiveBalances = useCallback(async () => {
    if (accountMode !== 'live') return;
    if (!upToken || !downToken) return;
    setBalError(null);
    if (liveBalancesRefreshRef.current.inflight) return;
    liveBalancesRefreshRef.current.inflight = true;
    setBalLoading(true);
    const gen = (liveBalancesRefreshRef.current.gen += 1);
    try {
      await Promise.all([
        tradeUpdateBalanceAllowance({ assetType: 'collateral' }),
        tradeUpdateBalanceAllowance({ tokenId: upToken, assetType: 'conditional' }),
        tradeUpdateBalanceAllowance({ tokenId: downToken, assetType: 'conditional' }),
      ]);
      if (gen !== liveBalancesRefreshRef.current.gen) return;
      await readLiveBalancesOnce();
    } catch {
      setBalError('Could not load balances.');
    } finally {
      liveBalancesRefreshRef.current.inflight = false;
      setBalLoading(false);
    }
  }, [accountMode, downToken, readLiveBalancesOnce, upToken]);

  const refreshLiveBalancesThrottled = useCallback(() => {
    const minGapMs = 600;
    const now = Date.now();
    const ref = liveBalThrottleRef.current;
    if (now - ref.lastMs >= minGapMs) {
      ref.lastMs = now;
      void refreshLiveBalances();
      return;
    }
    if (ref.timer != null) return;
    ref.timer = window.setTimeout(() => {
      ref.timer = null;
      ref.lastMs = Date.now();
      void refreshLiveBalances();
    }, Math.max(0, minGapMs - (now - ref.lastMs)));
  }, [refreshLiveBalances]);

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
    setBusyRefresh(true);
    try {
      if (accountMode === 'paper') {
        const sh = paperPos.shares;
        if (sh <= 0) {
          setSellQty('0');
          syncRiskAutomationAfterSellFill(0);
          return;
        }
        const v = floorShares4(sh);
        setSellQty(v > 0 ? String(v) : '0');
        if (stopLossEnabled || takeProfitEnabled) syncRiskAutomationAfterSellFill(v);
        return;
      }
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
      if (!(sellable > 0)) {
        setSellQty('0');
        syncRiskAutomationAfterSellFill(0);
        return;
      }
      const v = sellable;
      setSellQty(v > 0 ? String(v) : '0');
      if (stopLossEnabled || takeProfitEnabled) syncRiskAutomationAfterSellFill(floorShares4(v));
    } finally {
      setBusyRefresh(false);
    }
  }, [
    accountMode,
    estSharesDown,
    estSharesUp,
    msSinceBuyFillForToken,
    paperPos.shares,
    posSharesDown,
    posSharesUp,
    stopLossEnabled,
    syncRiskAutomationAfterSellFill,
    takeProfitEnabled,
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
      const deskAlreadyArmed =
        (stopLossEnabled && stopLossStopCents.trim()) || (takeProfitEnabled && takeProfitTakeCents.trim());
      if (buyRiskArmedRowIdsRef.current.has(rowId)) {
        if (shStr) {
          if (stopLossEnabled) setStopLossShares(shStr);
          if (takeProfitEnabled) setTakeProfitShares(shStr);
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
      refreshLiveBalancesThrottled();
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

  const [pinnedLiveStatusId, setPinnedLiveStatusId] = useState<string | null>(null);
  const [pinnedLiveStatusDismissed, setPinnedLiveStatusDismissed] = useState(false);

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
    [pushToast, pushTradeActivity, setPinnedLiveStatusDismissed, setPinnedLiveStatusId],
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
      refreshLiveBalancesThrottled();
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

  const applyMaxBuy = useCallback(async () => {
    setErr(null);
    setBusyRefresh(true);
    try {
      if (accountMode === 'paper') {
        if (unit === 'dollars') {
          const v = Math.floor((paperAccount.cashUsdCents / 100) * 100) / 100;
          setAmount(v > 0 ? String(v) : '0');
        } else if (mid != null && mid > 0) {
          const usdc = paperAccount.cashUsdCents / 100;
          const sh = usdc / mid;
          const v = floorShares4(sh);
          setAmount(v > 0 ? String(v) : '0');
        }
        return;
      }
      await tradeUpdateBalanceAllowance({ assetType: 'collateral' });
      const res = await tradeBalanceAllowance({ assetType: 'collateral' });
      if (!isOk(res)) {
        setErr('Could not read USDC balance.');
        return;
      }
      const usdc = parseUsdcBalance(res.data.balance);
      setAvailUsdc(usdc);
      if (usdc == null) return;
      if (unit === 'dollars') {
        const v = roundUsd2(Math.floor(usdc * 100) / 100);
        setAmount(v > 0 ? String(v) : '0');
      } else if (mid != null && mid > 0) {
        const sh = usdc / mid;
        const v = floorShares4(sh);
        setAmount(v > 0 ? String(v) : '0');
      }
    } finally {
      setBusyRefresh(false);
    }
  }, [accountMode, mid, paperAccount.cashUsdCents, unit]);

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
      if (!raw) {
        setStopLossEnabled(false);
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
      setStopLossStopCents(stop01 != null ? (stop01 * 100).toFixed(1) : '');
      setStopLossLimitCents(limit01 != null ? (limit01 * 100).toFixed(1) : '');
      setStopLossShares(shares != null ? String(shares) : '');
      setStopLossStatus(enabled ? 'ARMED' : 'OFF');
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
      if (!raw) {
        setTakeProfitEnabled(false);
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
      setTakeProfitTakeCents(take01 != null ? (take01 * 100).toFixed(1) : '');
      setTakeProfitLimitCents(limit01 != null ? (limit01 * 100).toFixed(1) : '');
      setTakeProfitShares(shares != null ? String(shares) : '');
      setTakeProfitStatus(enabled ? 'ARMED' : 'OFF');
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

  // Persist stop-loss config.
  useEffect(() => {
    const tok = token?.trim();
    if (!tok) return;
    if (!stopLossEnabled) {
      try {
        window.localStorage.removeItem(stopLossKey);
      } catch {
        /* ignore */
      }
      return;
    }
    const stop01 = centsStrTo01(stopLossStopCents);
    const limit01 = centsStrTo01(stopLossLimitCents);
    const sh = Number(stopLossShares);
    if (stop01 == null || limit01 == null || !Number.isFinite(sh) || sh <= 0) return;
    const cfg: StopLossConfig = {
      enabled: true,
      stop01: clamp01(stop01),
      limit01: clamp01(limit01),
      shares: sh,
      simple: stopLossSimple,
      dualBook: stopLossDualBook,
    };
    try {
      window.localStorage.setItem(stopLossKey, JSON.stringify(cfg));
    } catch {
      /* ignore */
    }
  }, [
    stopLossDualBook,
    stopLossEnabled,
    stopLossLimitCents,
    stopLossShares,
    stopLossSimple,
    stopLossStopCents,
    stopLossKey,
    token,
  ]);

  // Persist take-profit config.
  useEffect(() => {
    const tok = token?.trim();
    if (!tok) return;
    if (!takeProfitEnabled) {
      try {
        window.localStorage.removeItem(takeProfitKey);
      } catch {
        /* ignore */
      }
      return;
    }
    const take01 = centsStrTo01(takeProfitTakeCents);
    const limit01 = centsStrTo01(takeProfitLimitCents);
    const sh = Number(takeProfitShares);
    if (take01 == null || limit01 == null || !Number.isFinite(sh) || sh <= 0) return;
    const cfg: TakeProfitConfig = {
      enabled: true,
      take01: clamp01(take01),
      limit01: clamp01(limit01),
      shares: sh,
      simple: takeProfitSimple,
      dualBook: takeProfitDualBook,
    };
    try {
      window.localStorage.setItem(takeProfitKey, JSON.stringify(cfg));
    } catch {
      /* ignore */
    }
  }, [
    takeProfitDualBook,
    takeProfitEnabled,
    takeProfitKey,
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
    if (!stopLossSimple || !stopLossEnabled) return;
    if (operatorSlTpLockedRef.current) return;
    if (positionShares == null || !(positionShares > 0)) return;
    setStopLossShares(String(floorShares4(positionShares)));
  }, [stopLossSimple, stopLossEnabled, positionShares, token]);

  // If you pre-set SL before owning shares, auto-size when a position appears.
  useEffect(() => {
    if (!stopLossEnabled) return;
    if (positionShares == null || !(positionShares > 0)) return;
    if (stopLossShares.trim()) return;
    setStopLossShares(String(floorShares4(positionShares)));
  }, [stopLossEnabled, positionShares, stopLossShares, token]);

  useEffect(() => {
    if (!takeProfitSimple || !takeProfitEnabled) return;
    const s = takeProfitTakeCents.trim();
    if (!s) return;
    setTakeProfitLimitCents(s);
  }, [takeProfitSimple, takeProfitEnabled, takeProfitTakeCents]);

  useEffect(() => {
    if (!takeProfitSimple || !takeProfitEnabled) return;
    if (operatorSlTpLockedRef.current) return;
    if (positionShares == null || !(positionShares > 0)) return;
    setTakeProfitShares(String(floorShares4(positionShares)));
  }, [takeProfitSimple, takeProfitEnabled, positionShares, token]);

  // If you pre-set TP before owning shares, auto-size when a position appears.
  useEffect(() => {
    if (!takeProfitEnabled) return;
    if (positionShares == null || !(positionShares > 0)) return;
    if (takeProfitShares.trim()) return;
    setTakeProfitShares(String(floorShares4(positionShares)));
  }, [positionShares, takeProfitEnabled, takeProfitShares, token]);

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

  // Fast REST top-of-book while SL/TP armed — bid can move faster than chart-driven props.
  useEffect(() => {
    const needPoll =
      (accountMode === 'live' || accountMode === 'paper') && (stopLossEnabled || takeProfitEnabled);
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
      if (cancelled || document.visibilityState === 'hidden') return;
      if (inFlight) return;
      inFlight = true;
      void clobBook(tok)
        .then((res) => {
          if (cancelled) return;
          if (!isOk(res)) return;
          const tob = topOfBook(res.data);
          const b = tob.bestBid != null && tob.bestBid > 0 ? roundPrice01(tob.bestBid) : null;
          const a = tob.bestAsk != null && tob.bestAsk > 0 ? roundPrice01(tob.bestAsk) : null;
          setStopPollBid01(b);
          setStopPollAsk01(a);
          setStopPollAtMs(Date.now());
        })
        .finally(() => {
          inFlight = false;
        });
    };
    tick();
    const id = window.setInterval(tick, 400);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [accountMode, stopLossEnabled, takeProfitEnabled, bracketPollToken, token]);

  // Stop-loss trigger loop: uses best bid when available, else last-trade/mid mark; paper fills at limit when crossed.
  useEffect(() => {
    const tok = bracketOutcomeTokenRef.current?.trim() || token?.trim();
    if (!tok) return;
    if (!stopLossEnabled) {
      setStopLossStatus('OFF');
      return;
    }
    const stop01 = centsStrTo01(stopLossStopCents);
    const limit01 = centsStrTo01(stopLossLimitCents);
    const shReq = Number(stopLossShares);
    if (stop01 == null || limit01 == null || !Number.isFinite(shReq) || shReq <= 0) {
      setStopLossStatus('ARMED');
      return;
    }
    const bracketLane: 'up' | 'down' =
      bracketOutcomeLaneRef.current ??
      (tok === upToken?.trim() ? 'up' : tok === downToken?.trim() ? 'down' : lane);
    const heldForSl =
      accountMode === 'paper' ? getPaperPosition(paperAccount, tok).shares : liveLaneShares('display', bracketLane);
    if (!(heldForSl > 0)) {
      setStopLossStatus('ARMED');
      return;
    }
    const positionForSl =
      accountMode === 'paper' ? heldForSl : liveLaneShares('sell', bracketLane);
    const touch = bracketLane === 'up' ? (bookTouchUp ?? null) : (bookTouchDown ?? null);
    const bidTouch = touch?.bestBid != null && touch.bestBid > 0 ? roundPrice01(touch.bestBid) : null;
    const stripMid01 = bracketStripMid01;
    const bidForSl = bracketAutomationBid01({
      pollBid01: stopPollBid01,
      touchBid01: bidTouch,
      fallback01: stripMid01 ?? displayMark01,
      forPaper: accountMode === 'paper',
      allowMidFallback: accountMode === 'live',
    });
    const slEval = evaluateStopLossCross({
      stop01,
      bid01: bidForSl,
      prevBid01: stopLossPrevBidRef.current,
      stripMid01,
      honorChartMid: true,
    });
    if (bidForSl != null) stopLossPrevBidRef.current = bidForSl;
    if (stripMid01 != null) stopLossPrevStripMidRef.current = stripMid01;
    const crossed = slEval.crossed;
    const ref01 = slEval.ref01;
    if (ref01 != null) stopLossLastCrossRef.current = ref01;

    if (!crossed) {
      if (!stopLossFireLockRef.current) {
        stopLossLastFireTokRef.current = null;
        stopLossLastAttemptMsRef.current = 0;
        setStopLossStatus('ARMED');
      }
      return;
    }
    if (ref01 == null || !(ref01 > 0) || ref01 >= 1) {
      if (!stopLossFireLockRef.current) {
        stopLossLastFireTokRef.current = null;
        stopLossLastAttemptMsRef.current = 0;
        setStopLossStatus('ARMED');
      }
      return;
    }
    if (stopLossFireLockRef.current) return;
    if (takeProfitFireLockRef.current) return;
    if (stopLossLastFireTokRef.current === tok) return;
    if (bracketExitCooldownActive(stopLossLastAttemptMsRef.current)) return;

    stopLossFireLockRef.current = true;
    stopLossLastAttemptMsRef.current = Date.now();
    setStopLossStatus('TRIGGERED');

    void (async () => {
      try {
        let sellable = positionForSl;
        const px = stopLossExecLimit01({ stop01, limit01, ref01, simple: stopLossSimple });
        const quoted01 = ref01;

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
              refCents: ref01 != null ? ref01 * 100 : null,
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
                markPrice01: ref01,
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
              refCents: ref01 != null ? ref01 * 100 : null,
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

        try {
          await tradeUpdateBalanceAllowance({ tokenId: tok, assetType: 'conditional' });
          const balRes = await tradeBalanceAllowance({ tokenId: tok, assetType: 'conditional' });
          if (isOk(balRes)) {
            const liveSh = parseOutcomeSharesBalance(balRes.data.balance);
            if (liveSh != null && liveSh > 0) {
              if (bracketLane === 'up') setBalUp(liveSh);
              else setBalDown(liveSh);
            }
          }
        } catch {
          /* use cached position estimate */
        }

        sellable = liveLaneShares('sell', bracketLane);
        if (!(sellable > 0)) {
          const displaySl = liveLaneShares('display', bracketLane);
          if (displaySl > 0) sellable = displaySl;
        }
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

        const slFakFloor01 = stopLossSimple ? stop01 : Math.min(limit01, stop01);
        const refCents = ref01 != null ? ref01 * 100 : null;
        const optimistic = appendTradeHistoryWithId({
          ...tradeHistoryMarketMeta,
          mode: 'live',
          exec: 'limit',
          side: 'sell',
          token: tok,
          label: bracketLabel,
          price01: px,
          quotedPrice01: quoted01,
          intendedPrice01: px,
          submittedPrice01: null,
          fillAvgPrice01: null,
          markPrice01: ref01,
          shares: 0,
          requestedShares: sizeLive,
          remainingShares: sizeLive,
          usdCents: Math.abs(Math.round(px * sizeLive * 100)),
          status: 'sending',
          auditNote: `stop_loss_fak stop=${(stop01 * 100).toFixed(1)}¢ bid=${refCents != null ? refCents.toFixed(1) : '?'}¢ lim=${(px * 100).toFixed(1)}¢`,
        });
        setHistoryRows(optimistic.rows);
        const controller = new AbortController();
        const tClient0 = performance.now();
        const exitRes = await submitLiveBracketFakSell({
          token: tok,
          marketSlug: marketSlug.trim(),
          outcome: bracketOutcome,
          lane: bracketLane,
          price01: px,
          sizeShares: sizeLive,
          floor01: slFakFloor01,
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
              ? `Stop-loss market sell (${sizeLive.toFixed(4)} sh) — FAK had no match; confirming…`
              : `Stop-loss FAK @ ${(px * 100).toFixed(1)}¢ (${sizeLive.toFixed(4)} sh)${refCents != null ? ` · bid was ${refCents.toFixed(1)}¢` : ''} — confirming…`,
          );
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
  }, [
    accountMode,
    bookTouchUp?.bestAsk,
    bookTouchUp?.bestBid,
    bookTouchDown?.bestAsk,
    bookTouchDown?.bestBid,
    bracketStripMid01,
    displayMark01,
    label,
    lane,
    marketSlug,
    positionShares,
    refreshAvgEntry,
    refreshOpenOrders,
    refreshPositionAndMaxSell,
    resolvedBullpenOutcome,
    afterLiveSellRowReconcile,
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

  // Take-profit: bid crosses up through take → FAK limit sell (book retry / market fallback).
  useEffect(() => {
    const tok = bracketOutcomeTokenRef.current?.trim() || token?.trim();
    if (!tok) return;
    if (!takeProfitEnabled) {
      setTakeProfitStatus('OFF');
      return;
    }
    const take01 = centsStrTo01(takeProfitTakeCents);
    const limit01 = centsStrTo01(takeProfitLimitCents);
    const shReq = Number(takeProfitShares);
    if (take01 == null || limit01 == null || !Number.isFinite(shReq) || shReq <= 0) {
      setTakeProfitStatus('ARMED');
      return;
    }
    const bracketLane: 'up' | 'down' =
      bracketOutcomeLaneRef.current ??
      (tok === upToken?.trim() ? 'up' : tok === downToken?.trim() ? 'down' : lane);
    const heldForTp =
      accountMode === 'paper' ? getPaperPosition(paperAccount, tok).shares : liveLaneShares('display', bracketLane);
    if (!(heldForTp > 0)) {
      setTakeProfitStatus('ARMED');
      return;
    }
    const touch = bracketLane === 'up' ? (bookTouchUp ?? null) : (bookTouchDown ?? null);
    const bidTouch = touch?.bestBid != null && touch.bestBid > 0 ? roundPrice01(touch.bestBid) : null;
    const stripMid01 = bracketStripMid01;
    const bidForTp = bracketAutomationBid01({
      pollBid01: stopPollBid01,
      touchBid01: bidTouch,
      fallback01: stripMid01 ?? displayMark01,
      forPaper: accountMode === 'paper',
      allowMidFallback: accountMode === 'live',
    });
    const tpEval = evaluateTakeProfitCross({
      take01,
      bid01: bidForTp,
      prevBid01: takeProfitPrevBidRef.current,
      stripMid01,
      honorChartMid: true,
    });
    if (bidForTp != null) takeProfitPrevBidRef.current = bidForTp;
    if (stripMid01 != null) takeProfitPrevStripMidRef.current = stripMid01;
    const crossed = tpEval.crossed;
    const ref01 = tpEval.ref01;
    if (ref01 != null) takeProfitLastCrossRef.current = ref01;

    if (!crossed) {
      if (!takeProfitFireLockRef.current) {
        takeProfitLastFireTokRef.current = null;
        takeProfitLastAttemptMsRef.current = 0;
        setTakeProfitStatus('ARMED');
      }
      return;
    }
    if (ref01 == null || !(ref01 > 0) || ref01 >= 1) {
      if (!takeProfitFireLockRef.current) {
        takeProfitLastFireTokRef.current = null;
        takeProfitLastAttemptMsRef.current = 0;
        setTakeProfitStatus('ARMED');
      }
      return;
    }
    if (takeProfitFireLockRef.current) return;
    if (stopLossEnabled && stopLossFireLockRef.current) return;
    if (takeProfitLastFireTokRef.current === tok) return;
    if (bracketExitCooldownActive(takeProfitLastAttemptMsRef.current)) return;

    takeProfitFireLockRef.current = true;
    takeProfitLastAttemptMsRef.current = Date.now();
    setTakeProfitStatus('TRIGGERED');

    void (async () => {
      try {
        const px = takeProfitExecLimit01({ take01, limit01, ref01, simple: takeProfitSimple });
        const quoted01 = ref01;

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
              refCents: ref01 != null ? ref01 * 100 : null,
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
                markPrice01: ref01,
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
              refCents: ref01 != null ? ref01 * 100 : null,
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

        try {
          await tradeUpdateBalanceAllowance({ tokenId: tok, assetType: 'conditional' });
          const balRes = await tradeBalanceAllowance({ tokenId: tok, assetType: 'conditional' });
          if (isOk(balRes)) {
            const liveSh = parseOutcomeSharesBalance(balRes.data.balance);
            if (liveSh != null && liveSh > 0) {
              if (bracketLane === 'up') setBalUp(liveSh);
              else setBalDown(liveSh);
            }
          }
        } catch {
          /* use cached position estimate */
        }
        let sellableTp = liveLaneShares('sell', bracketLane);
        if (!(sellableTp > 0)) {
          const displayTp = liveLaneShares('display', bracketLane);
          if (displayTp > 0) sellableTp = displayTp;
        }
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

        const refCents = ref01 != null ? ref01 * 100 : null;
        const optimistic = appendTradeHistoryWithId({
          ...tradeHistoryMarketMeta,
          mode: 'live',
          exec: 'limit',
          side: 'sell',
          token: tok,
          label: bracketLabel,
          price01: px,
          quotedPrice01: quoted01,
          intendedPrice01: px,
          submittedPrice01: null,
          fillAvgPrice01: null,
          markPrice01: ref01,
          shares: 0,
          requestedShares: sizeLive,
          remainingShares: sizeLive,
          usdCents: Math.abs(Math.round(px * sizeLive * 100)),
          status: 'sending',
          auditNote: `take_profit_fak take=${(take01 * 100).toFixed(1)}¢ bid=${refCents != null ? refCents.toFixed(1) : '?'}¢ lim=${(px * 100).toFixed(1)}¢`,
        });
        setHistoryRows(optimistic.rows);
        const controller = new AbortController();
        const tClient0 = performance.now();
        const exitRes = await submitLiveBracketFakSell({
          token: tok,
          marketSlug: marketSlug.trim(),
          outcome: bracketOutcome,
          lane: bracketLane,
          price01: px,
          sizeShares: sizeLive,
          floor01: take01,
          signal: controller.signal,
        });
        const clientMs = Math.round(performance.now() - tClient0);
        if (!exitRes.ok) {
          const e = exitRes.apiErr ?? ({ error: exitRes.error } as ApiErr);
          takeProfitLastFireTokRef.current = null;
          const errMsg = formatTradeApiError(e);
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
              ? `Take-profit market sell (${sizeLive.toFixed(4)} sh) — FAK had no match; confirming…`
              : `Take-profit FAK @ ${(px * 100).toFixed(1)}¢ (${sizeLive.toFixed(4)} sh)${refCents != null ? ` · bid was ${refCents.toFixed(1)}¢` : ''} — confirming…`,
          );
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
  }, [
    accountMode,
    bookTouchUp?.bestAsk,
    bookTouchUp?.bestBid,
    bookTouchDown?.bestAsk,
    bookTouchDown?.bestBid,
    bracketStripMid01,
    displayMark01,
    label,
    lane,
    marketSlug,
    positionShares,
    refreshAvgEntry,
    refreshOpenOrders,
    refreshPositionAndMaxSell,
    resolvedBullpenOutcome,
    afterLiveSellRowReconcile,
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

  // Keep live Sell view feeling instant: when switching to Sell (or swapping lane),
  // proactively refresh position + open orders in the background and auto-fill sell qty.
  useEffect(() => {
    if (accountMode !== 'live') return;
    if (action !== 'sell') return;
    if (!token) return;
    void refreshPositionAndMaxSell();
    void refreshOpenOrders();
    refreshAvgEntryThrottled();
    refreshLiveBalancesThrottled();
  }, [accountMode, action, token, refreshAvgEntryThrottled, refreshLiveBalancesThrottled, refreshOpenOrders, refreshPositionAndMaxSell]);

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
            void refreshLiveBalancesThrottled();
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
          void refreshLiveBalancesThrottled();
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
      const v = floorShares4(positionShares * pct);
      setSellQty(v > 0 ? String(v) : '0');
    },
    [positionShares],
  );

  // Avoid `Number('') === 0` → clamp to 1¢: that produced absurd live touch/limit prices before mid/book loaded.
  const explicitLimitCents = limitPriceCents.trim() !== '' ? Number(limitPriceCents) : NaN;
  const autoLimitCents =
    execMode === 'touch'
      ? touchLimitCents.trim() !== ''
        ? Number(touchLimitCents)
        : NaN
      : defaultLimitCents.trim() !== ''
        ? Number(defaultLimitCents)
        : NaN;
  const limitCents = Number.isFinite(explicitLimitCents) ? explicitLimitCents : autoLimitCents;
  const limit01 =
    Number.isFinite(limitCents) && limitCents > 0 ? Math.min(0.99, Math.max(0.01, limitCents / 100)) : null;

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
  const estShares =
    previewPrice01 != null && amtOk ? (unit === 'dollars' ? amtNum / previewPrice01 : amtNum) : null;
  const estCost =
    previewPrice01 != null && estShares != null
      ? unit === 'dollars'
        ? amtNum
        : estShares * previewPrice01
      : unit === 'dollars' && amtOk
        ? amtNum
        : null;
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
      if (unit === 'shares' && estShares != null) {
        return `${mode} · ${exec} · ${c}¢ · ~${estShares.toFixed(2)} sh · ${label}`;
      }
      if (unit === 'dollars' && amtOk) {
        return `${mode} · ${exec} · ${c}¢ · $${amtNum.toFixed(2)} notional · ${label}`;
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

  const maxSellStr =
    positionShares != null && positionShares > 0 ? fmtShares(positionShares, 'compact') : accountMode === 'live' && balLoading ? '…' : '—';

  const [quickSellMode, setQuickSellMode] = useState<'market' | 'touch_limit'>('market');

  const activeLiveOrderRow = useMemo(() => {
    if (accountMode !== 'live') return null;
    const tok = token?.trim();
    if (!tok) return null;
    const now = Date.now();
    const SHOW_FILLED_MS = 12_000;
    for (const r of historyRows) {
      if (r.mode !== 'live') continue;
      if (r.token?.trim() !== tok) continue;
      if (r.status === 'sending' || r.status === 'pending' || r.status === 'sent') return r;
      if ((r.status === 'partial' || r.status === 'filled') && !rowShowsExchangeFill(r)) return r;
      if (r.status === 'partial' && rowShowsExchangeFill(r)) return r;
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
      applyArmRiskAfterBuyFill(last.fillPrice01, totalSh);
    }
    syncRiskAutomationAfterSellFill(getPaperPosition(res.account, token).shares);
  }, [accountMode, applyArmRiskAfterBuyFill, mid, paperAccount, syncRiskAutomationAfterSellFill, token]);

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

                        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800/50 px-3 py-2 text-[11px]">
                          <span className="shrink-0 font-semibold text-zinc-500">Auto-arm</span>
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
                          <span className="w-full text-[10px] leading-snug text-zinc-500">
                            Checking SL/TP applies levels now and re-arms after each buy fill.
                          </span>
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
                            <div className="grid gap-2 sm:grid-cols-2">
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
                            <div className="grid border-t border-zinc-800/50 lg:grid-cols-2 lg:divide-x lg:divide-zinc-800/55">
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

                          {/* One input, always: stop trigger in cents. */}
                          <label className="block rounded-lg border border-rose-900/35 bg-rose-950/10 px-3 py-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-rose-200/80">Stop at (¢)</div>
                            <input
                              value={stopLossStopCents}
                              onChange={(e) => {
                                const v = e.target.value;
                                operatorSlTpLockedRef.current = true;
                                setStopLossStopCents(v);
                                // Default behavior: limit=stop, shares=max (simple bracket feel).
                                setStopLossLimitCents(v);
                                syncBracketPinFromOperatorEdits({ stopCents: v });
                                if (positionShares != null && positionShares > 0) setStopLossShares(String(floorShares4(positionShares)));
                              }}
                              inputMode="decimal"
                              placeholder={targets?.stopCents ?? 'e.g. 42'}
                              className="mt-1 min-h-[40px] w-full bg-transparent text-right font-mono text-lg font-black tabular-nums text-rose-50 outline-none"
                            />
                            {stopVersusRefPctLabel ? (
                              <div className="mt-1.5 text-right font-mono text-[11px] font-semibold tabular-nums text-rose-200/75">
                                {stopVersusRefPctLabel}
                              </div>
                            ) : null}
                          </label>

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

                              <div className="grid gap-2 sm:grid-cols-2">
                                <label className="rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Limit (¢)</div>
                                  <input
                                    value={stopLossLimitCents}
                                    onChange={(e) => setStopLossLimitCents(e.target.value)}
                                    inputMode="decimal"
                                    placeholder={limitPriceCents || targets?.stopCents || '—'}
                                    className="mt-1 min-h-[34px] w-full bg-transparent text-right font-mono text-[13px] font-semibold tabular-nums text-zinc-100 outline-none"
                                  />
                                </label>
                                <label className="rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Shares</div>
                                  <input
                                    value={stopLossShares}
                                    onChange={(e) => setStopLossShares(e.target.value)}
                                    inputMode="decimal"
                                    placeholder={positionShares != null ? String(floorShares4(positionShares)) : '—'}
                                    className="mt-1 min-h-[34px] w-full bg-transparent text-right font-mono text-[13px] font-semibold tabular-nums text-zinc-100 outline-none"
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
                                    if (positionShares == null || !(positionShares > 0)) return;
                                    setStopLossShares(String(floorShares4(positionShares)));
                                  }}
                                >
                                  = Max
                                </button>
                                {targets?.stopCents ? (
                                  <button
                                    type="button"
                                    className="rounded-lg border border-rose-800/35 bg-rose-950/20 px-2.5 py-1.5 text-[10px] font-bold text-rose-100 hover:bg-rose-950/35"
                                    title="Use assist stop as trigger"
                                    onClick={() => setStopLossStopCents(targets.stopCents)}
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

                          {/* One input, always: take trigger in cents. */}
                          <label className="block rounded-lg border border-emerald-900/35 bg-emerald-950/10 px-3 py-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-200/80">Take at (¢)</div>
                            <input
                              value={takeProfitTakeCents}
                              onChange={(e) => {
                                const v = e.target.value;
                                operatorSlTpLockedRef.current = true;
                                setTakeProfitTakeCents(v);
                                // Default behavior: limit=take, shares=max.
                                setTakeProfitLimitCents(v);
                                syncBracketPinFromOperatorEdits({ tpCents: v });
                                if (positionShares != null && positionShares > 0) setTakeProfitShares(String(floorShares4(positionShares)));
                              }}
                              inputMode="decimal"
                              placeholder={riskTargetsFromEntry?.tpCents ?? targets?.tpCents ?? 'e.g. 58'}
                              className="mt-1 min-h-[40px] w-full bg-transparent text-right font-mono text-lg font-black tabular-nums text-emerald-50 outline-none"
                            />
                            {takeVersusRefPctLabel ? (
                              <div className="mt-1.5 text-right font-mono text-[11px] font-semibold tabular-nums text-emerald-200/75">
                                {takeVersusRefPctLabel}
                              </div>
                            ) : null}
                          </label>

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

                              <div className="grid gap-2 sm:grid-cols-2">
                                <label className="rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Limit (¢)</div>
                                  <input
                                    value={takeProfitLimitCents}
                                    onChange={(e) => setTakeProfitLimitCents(e.target.value)}
                                    inputMode="decimal"
                                    placeholder={limitPriceCents || riskTargetsFromEntry?.tpCents || targets?.tpCents || '—'}
                                    className="mt-1 min-h-[34px] w-full bg-transparent text-right font-mono text-[13px] font-semibold tabular-nums text-zinc-100 outline-none"
                                  />
                                </label>
                                <label className="rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Shares</div>
                                  <input
                                    value={takeProfitShares}
                                    onChange={(e) => setTakeProfitShares(e.target.value)}
                                    inputMode="decimal"
                                    placeholder={positionShares != null ? String(floorShares4(positionShares)) : '—'}
                                    className="mt-1 min-h-[34px] w-full bg-transparent text-right font-mono text-[13px] font-semibold tabular-nums text-zinc-100 outline-none"
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
                                    if (positionShares == null || !(positionShares > 0)) return;
                                    setTakeProfitShares(String(floorShares4(positionShares)));
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
                                      if (c) {
                                        setTakeProfitTakeCents(c);
                                        setTakeProfitLimitCents(c);
                                      }
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
                                          setStopLossStopCents(s);
                                          setStopLossLimitCents(s);
                                          if (positionShares != null && positionShares > 0) setStopLossShares(String(floorShares4(positionShares)));
                                        }}
                                      >
                                        {d}¢
                                      </button>
                                    ))}
                                    {targets?.stopCents ? (
                                      <button
                                        type="button"
                                        className="min-h-[34px] rounded-lg border border-rose-700/50 bg-rose-950/35 px-2.5 text-[10px] font-bold text-rose-50 hover:bg-rose-950/55"
                                        onClick={() => {
                                          setStopLossStopCents(targets.stopCents);
                                          setStopLossLimitCents(targets.stopCents);
                                          if (positionShares != null && positionShares > 0) setStopLossShares(String(floorShares4(positionShares)));
                                        }}
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
                                          setTakeProfitTakeCents(s);
                                          setTakeProfitLimitCents(s);
                                          if (positionShares != null && positionShares > 0) setTakeProfitShares(String(floorShares4(positionShares)));
                                        }}
                                      >
                                        +{d}¢
                                      </button>
                                    ))}
                                    <button
                                      type="button"
                                      className="min-h-[34px] min-w-[3rem] rounded-lg border border-emerald-700/50 bg-emerald-950/35 px-2 text-[11px] font-bold text-emerald-50 hover:bg-emerald-950/55"
                                      onClick={() => {
                                        setTakeProfitTakeCents('99');
                                        setTakeProfitLimitCents('99');
                                        if (positionShares != null && positionShares > 0) setTakeProfitShares(String(floorShares4(positionShares)));
                                      }}
                                    >
                                      99¢
                                    </button>
                                    {riskTargetsFromEntry?.tpCents || targets?.tpCents ? (
                                      <button
                                        type="button"
                                        className="min-h-[34px] rounded-lg border border-emerald-700/50 bg-emerald-950/35 px-2.5 text-[10px] font-bold text-emerald-50 hover:bg-emerald-950/55"
                                        onClick={() => {
                                          const c = riskTargetsFromEntry?.tpCents ?? targets?.tpCents;
                                          if (c) {
                                            setTakeProfitTakeCents(c);
                                            setTakeProfitLimitCents(c);
                                            if (positionShares != null && positionShares > 0) setTakeProfitShares(String(floorShares4(positionShares)));
                                          }
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
      className={`${
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
            <h1 className="text-xl font-semibold tracking-tight text-zinc-100">
              {isSlide ? 'Trade' : 'TRADE'}
            </h1>
            {isSlide ? (
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
            ) : null}
          </div>
          {!isSlide ? (
            <p className="mt-1 text-[13px] leading-relaxed text-zinc-500">
              {isSidebarOnly ? 'Practice/live · outcome · size · brackets · submit.' : 'Mode · outcome · size · price · buy/sell.'}
            </p>
          ) : (
            <p className="mt-1 text-[13px] leading-relaxed text-zinc-500">
              <span className="font-medium text-zinc-400">Outcome</span>: side &amp; size.{' '}
              <span className="font-medium text-zinc-400">Brackets</span>: SL/TP &amp; quick assist.{' '}
              <span className="font-medium text-zinc-400">Orders &amp; position</span>: book, resting orders, balances.
            </p>
          )}
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
              <>
                <label className="flex min-w-[180px] items-center gap-2 rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2">
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
                  className="min-h-[44px] rounded-xl border border-emerald-800/40 bg-emerald-950/20 px-3 text-[11px] font-black text-emerald-100 hover:bg-emerald-950/35"
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
                  className="min-h-[44px] rounded-xl border border-zinc-700/60 bg-zinc-950/50 px-3 text-[11px] font-semibold text-zinc-200 hover:border-zinc-600/70 hover:bg-zinc-900/60"
                  title="Clear paper positions and start over with $5,000 play money"
                >
                  Reset demo
                </button>
              </>
            ) : null}
          </div>
        </div>

        {accountMode === 'live' ? (
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

        {accountMode === 'live' && liveStatusRow ? (
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
      </div>

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

      {isSlide ? (
        <div className="mt-3">
          <TradeSegmentedControl
            value={slideDockTab}
            onChange={(v) => setSlideDockTab(v as 'outcome' | 'brackets' | 'ledger')}
            options={[
              { value: 'outcome', label: 'Outcome', title: 'Pick side, size, buy / sell' },
              { value: 'brackets', label: 'Brackets', title: 'Stop-loss & take-profit automation' },
              { value: 'ledger', label: 'Orders & position', title: 'Open orders, book, balances' },
            ]}
            className="w-full"
            size="md"
          />
        </div>
      ) : null}

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
          {flashToast ? (
            <div className="min-w-0 break-words rounded-lg border border-zinc-700/50 bg-zinc-900/80 px-3 py-2 text-left text-[12px] leading-snug text-zinc-100">
              {flashToast}
            </div>
          ) : null}
          {lastAutoSell && Date.now() - lastAutoSell.ts <= 10 * 60_000 ? (
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
            <span className="text-[11px] font-black uppercase tracking-wide text-rose-200">Sell {upLabel}</span>
            <span className="font-mono text-2xl font-black tabular-nums text-emerald-100">{fmtCents(upMid)}</span>
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
            <span className="text-[11px] font-black uppercase tracking-wide text-rose-200">Sell {downLabel}</span>
            <span className="font-mono text-2xl font-black tabular-nums text-zinc-100">{fmtCents(downMid)}</span>
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
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{upLabel}</div>
            <div className={`mt-1 font-black tabular-nums text-emerald-100 ${isSlide ? 'text-3xl' : 'text-2xl'}`}>{fmtCents(upMid)}</div>
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
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{downLabel}</div>
            <div className={`mt-1 font-black tabular-nums text-zinc-100 ${isSlide ? 'text-3xl' : 'text-2xl'}`}>{fmtCents(downMid)}</div>
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
                      const cancelMs = Math.max(250, Math.min(5000, Math.floor(Number(pickAutoCancelMs) || 1500)));
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
                        const res = await tradeCreateOrderWithOpts(
                          { token, side: 'buy', price: bestAsk, size: sharesReq, signatureType: null, marketSlug: marketSlug ?? '', outcome: resolvedBullpenOutcome,
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
                        if (oid) {
                          pollRestingOrderFill(optimistic.id, oid, sharesReq, bestAsk, quoted01);
                          window.setTimeout(() => {
                            void tradeCancelOrder(oid);
                          }, cancelMs);
                        }
                        setOkMsg(`Buy sent · intended ${(bestAsk * 100).toFixed(1)}¢ — reading exchange state…`);
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
            <span className="font-mono text-zinc-500" title="USDC available for buys">
              {accountMode === 'paper'
                ? `Cash ${fmtUsdCents(paperAccount.cashUsdCents)}`
                : balLoading
                  ? 'Loading…'
                  : availUsdc != null
                    ? `Cash $${availUsdc.toFixed(2)}`
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

          {isSlide && unit === 'dollars' ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[50, 100, 200].map((n) => (
                <button
                  key={`tap-${n}`}
                  type="button"
                  onClick={() => setAmount(String(n))}
                  className="min-h-[40px] rounded-lg border border-emerald-800/50 bg-emerald-950/25 px-3 text-[12px] font-bold text-emerald-100 hover:bg-emerald-950/40"
                >
                  ${n}
                </button>
              ))}
            </div>
          ) : null}

          <div className="mt-2 flex flex-wrap gap-2">
            {(unit === 'dollars' ? [10, 25, 50, 100] : [10, 25, 50, 100]).map((n) => (
              <button
                key={`${unit}-${n}`}
                type="button"
                onClick={() => {
                  setAmount((prev) => {
                    const cur = Number(prev);
                    const base = Number.isFinite(cur) ? cur : 0;
                    return String(Math.max(0, base + n));
                  });
                }}
                className="min-h-[40px] rounded-lg border border-zinc-800/70 bg-black/25 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-black/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/35 active:scale-[0.98]"
              >
                {unit === 'dollars' ? `+$${n}` : `+${n} sh`}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void applyMaxBuy()}
              disabled={
                busySubmit ||
                busyRefresh ||
                (accountMode === 'paper' ? paperAccount.cashUsdCents <= 0 : !availUsdc) ||
                outcomeLocked ||
                (unit === 'shares' && (mid == null || mid <= 0))
              }
              aria-busy={busySubmit || busyRefresh}
              title={
                outcomeLocked
                  ? `Disabled: market looks locked at ${midIsExtremeLow ? '0¢' : midIsExtremeHigh ? '100¢' : '—'}`
                  : maxBuyDisabledReason
              }
              className="min-h-[40px] rounded-lg border border-zinc-600/80 bg-zinc-900/60 px-4 py-2 text-xs font-semibold text-zinc-100 hover:bg-zinc-800/80 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Max
            </button>
          </div>

          {executionBrief ? (
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

          {action === 'buy' && ptbContext ? (
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
              {chopAdvisory ? (
                <div className="mt-1 text-amber-200/85">
                  Chop / NO_EDGE on tape — desk suggests smaller size or wider limits; touch buys are not blocked.
                </div>
              ) : null}
              {buyGate.ok ? null : <div className="mt-1 text-amber-200/90">{buyGate.reason}</div>}
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
                value={limitPriceCents}
                onChange={(e) => setLimitPriceCents(e.target.value)}
                inputMode="numeric"
                aria-describedby={`${idLimitBuy}-hint`}
                className="min-h-[44px] w-full bg-transparent text-lg font-semibold tabular-nums text-zinc-100 outline-none"
                placeholder={execMode === 'touch' ? touchLimitCents || defaultLimitCents || '50' : defaultLimitCents || '50'}
              />
            </div>
            <p id={`${idLimitBuy}-hint`} className="mt-1 text-[11px] text-zinc-500">
              {execMode === 'touch'
                ? `Quick mode uses a fast limit near mid (≤ ${limitPriceCents || touchLimitCents || defaultLimitCents || '—'}¢).`
                : `Your buy fills when the market trades at or below ${limitPriceCents || defaultLimitCents || '—'}¢.`}
            </p>
            <details className="mt-2 rounded-xl border border-zinc-800/60 bg-zinc-950/20 px-3 py-2">
              <summary className="cursor-pointer select-none text-[11px] font-semibold text-zinc-300 hover:text-zinc-100 [&::-webkit-details-marker]:hidden">
                Scalp price guide (what to type + when to sell)
              </summary>
              <div className="mt-2 space-y-2 text-[11px] leading-relaxed text-zinc-400">
                <div className="flex flex-wrap gap-2 font-mono text-[10px] text-zinc-500">
                  <span className="rounded-md border border-zinc-800/60 bg-black/20 px-2 py-0.5">Bid {scalp.bid != null ? `${scalp.bid.toFixed(1)}¢` : '—'}</span>
                  <span className="rounded-md border border-zinc-800/60 bg-black/20 px-2 py-0.5">Ask {scalp.ask != null ? `${scalp.ask.toFixed(1)}¢` : '—'}</span>
                  <span className="rounded-md border border-zinc-800/60 bg-black/20 px-2 py-0.5">
                    Spread {scalp.spread != null ? `${scalp.spread.toFixed(1)}¢` : '—'}
                  </span>
                  <span className="rounded-md border border-zinc-800/60 bg-black/20 px-2 py-0.5">Min scalp move ~{scalp.minMove}¢</span>
                </div>

                <div className="rounded-lg border border-zinc-800/60 bg-black/20 px-2.5 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Entry (BUY)</div>
                  <ul className="mt-1 space-y-1">
                    <li>
                      - <span className="font-semibold text-zinc-200">Fast fill (take ask)</span>: type{' '}
                      <span className="font-mono text-zinc-200">{scalp.takeAsk != null ? `${scalp.takeAsk}¢` : 'Ask'}</span> (you pay spread).
                    </li>
                    <li>
                      - <span className="font-semibold text-zinc-200">Scalp entry (join bid)</span>: type{' '}
                      <span className="font-mono text-zinc-200">{scalp.joinBid != null ? `${scalp.joinBid}¢` : 'Bid'}</span>
                      {scalp.microImproveBuy != null ? (
                        <>
                          {' '}
                          or <span className="font-mono text-zinc-200">{scalp.microImproveBuy}¢</span> (bid+1 for slightly faster fill).
                        </>
                      ) : null}
                    </li>
                    <li>
                      - <span className="font-semibold text-zinc-200">If your signal says WAIT</span>: don’t “guess” price — only place the join-bid order and let it come to you.
                    </li>
                  </ul>
                  {scalp.readiness ? (
                    <div className="mt-2 text-[10px] text-zinc-500">
                      Signal state: <span className="font-semibold text-zinc-300">{scalp.readiness}</span>
                      {scalp.laneOk ? null : <span className="ml-2 text-amber-200/90">Lane mismatch — switch outcomes or skip.</span>}
                    </div>
                  ) : null}
                </div>

                <div className="rounded-lg border border-zinc-800/60 bg-black/20 px-2.5 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Exit (SELL)</div>
                  <ul className="mt-1 space-y-1">
                    <li>
                      - <span className="font-semibold text-zinc-200">Take-profit</span>: sell into bids once price is ~{scalp.minMove}¢ above your entry (don’t wait for the perfect top).
                    </li>
                    <li>
                      - <span className="font-semibold text-zinc-200">Stop</span>: cut quickly if you lose the confirmation (re-entering chop / back into the band) or you’re ~{Math.max(2, Math.ceil(scalp.minMove / 2))}¢ against entry.
                    </li>
                    <li>
                      - <span className="font-semibold text-zinc-200">Rule</span>: if spread is wide, your profit target must be wider too — otherwise you’ll “win the move” and still lose to spread/fees.
                    </li>
                  </ul>
                </div>
              </div>
            </details>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {quickLimitBuyPresets.map((p) => (
                <button
                  key={`qbuy-${p.key}`}
                  type="button"
                  onClick={() => {
                    setExecMode('limit');
                    setLimitPriceCents(String(p.cents));
                    setErr(null);
                    setOkMsg(null);
                  }}
                  className="rounded-lg border border-zinc-700/60 bg-zinc-900/45 px-2 py-1 text-[10px] font-bold text-zinc-200 hover:bg-zinc-800/70"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px] text-zinc-500">Then tap the main <span className="text-zinc-400">Buy</span> below.</p>
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
                {ptbContext ? (
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
                  <div className="mt-1 font-mono text-lg font-black tabular-nums text-emerald-100">{targets.tpCents}¢</div>
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
                            const sh = floorShares4(positionShares * pct);
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
                            const sh = floorShares4(positionShares * pct);
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
                        setStopLossStopCents(riskTargetsFromEntry.stopCents);
                        setStopLossLimitCents(riskTargetsFromEntry.stopCents);
                      }}
                    >
                      Apply to SL fields
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-emerald-800/35 bg-emerald-950/15 px-2.5 py-1.5 text-[10px] font-bold text-emerald-100 hover:bg-emerald-950/25"
                      title="Fill take-profit trigger/limit fields (live: open Sell → Take-profit)"
                      onClick={() => {
                        setTakeProfitTakeCents(riskTargetsFromEntry.tpCents);
                        setTakeProfitLimitCents(riskTargetsFromEntry.tpCents);
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

          {executeIntentSummary && action === 'buy' ? (
            <div className="mt-3 rounded-xl border border-zinc-700/50 bg-zinc-900/30 px-3 py-2 text-[11px] leading-snug text-zinc-300">
              <span className="font-semibold text-zinc-200">You&apos;re about to: </span>
              {executeIntentSummary}
            </div>
          ) : null}

          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-stretch">
            <button
              ref={buyButtonRef}
              type="button"
              disabled={busySubmit || outcomeLocked || !amtOk || limit01 == null || !Number.isFinite(limit01) || !buyGate.ok}
              aria-busy={busySubmit}
              className={`w-full rounded-xl px-4 py-3 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-40 ${
                isSlide
                  ? 'min-h-[48px] bg-emerald-400/70 shadow-none hover:bg-emerald-300/80'
                  : 'min-h-[52px] bg-emerald-400 shadow-lg shadow-emerald-950/30 hover:bg-emerald-300'
              } ${isSlide ? 'inline-flex items-center justify-center gap-2' : ''}`}
              onClick={async () => {
              if (submitLockRef.current) return;
              submitLockRef.current = true;
              const deskForcedShares = forcedAutoBuySharesRef.current;
              playTradeClick();
              setErr(null);
              setOkMsg(null);
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
                const submitLane = lane;
                const submitToken = submitLane === 'up' ? upToken : downToken;
                const submitLabel = submitLane === 'up' ? upLabel : downLabel;
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
                  const scaledAmt = unit === 'dollars' ? amtNum * setupScale : amtNum;
                  const shares =
                    deskForcedShares != null && deskForcedShares > 0
                      ? deskForcedShares
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
                      if (!r.ok) setErr(r.error);
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
                        applyArmRiskAfterBuyFill(r.fill.price01, r.fill.shares);
                        if (deskForcedShares != null) forcedAutoBuySharesRef.current = null;
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
                  const effAmtNum = unit === 'dollars' ? amtNum * setupScale : amtNum;
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
                    deskForcedShares != null && deskForcedShares > 0
                      ? deskForcedShares
                      : unit === 'dollars'
                        ? amtNum * setupScale
                        : amtNum;
                  const sizeSharesRaw = unit === 'shares' || deskForcedShares != null ? effAmtNum : price > 0 ? effAmtNum / price : NaN;
                  const sizeShares = Number.isFinite(sizeSharesRaw) ? floorShares4(sizeSharesRaw) : NaN;
                  if (!Number.isFinite(sizeShares) || sizeShares < 1e-4) {
                    setErr('Buy size is too small after rounding to 4 decimal shares.');
                    return;
                  }
                  if (deskForcedShares != null) forcedAutoBuySharesRef.current = null;
                  liveSubmitGenRef.current += 1;
                  const quoted01 = Number.isFinite(price) ? roundPrice01(price) : null;
                  const mark01 = mid != null && mid > 0 ? roundPrice01(mid) : null;
                  const optimistic = appendTradeHistoryWithId({ ...tradeHistoryMarketMeta,
                    mode: 'live',
                    exec: execMode,
                    side: 'buy',
                    token: submitToken,
                    label: submitLabel,
                    price01: quoted01,
                    quotedPrice01: quoted01,
                    intendedPrice01: price,
                    submittedPrice01: null,
                    fillAvgPrice01: null,
                    markPrice01: mark01,
                    shares: sizeShares,
                    requestedShares: sizeShares,
                    remainingShares: sizeShares,
                    usdCents: Number.isFinite(price) ? Math.abs(Math.round(price * sizeShares * 100)) : null,
                    status: 'sending',
                  });
                  setHistoryRows(optimistic.rows);
                  setPinnedLiveStatusId(optimistic.id);
                  setPinnedLiveStatusDismissed(false);
                  const controller = new AbortController();
                  setSubmitAbort(controller);
                  const tClient0 = performance.now();
                  const res = await tradeCreateOrderWithOpts(
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
                        submittedPrice01: null,
                        orderId: oid ?? undefined,
                        roundTripMs: rt,
                        price01: quoted01,
                        error: undefined,
                      }),
                    );
                    if (oid) pollRestingOrderFill(optimistic.id, oid, sizeShares, price, quoted01);
                    setOkMsg(
                      `${execMode === 'touch' ? 'Quick' : 'Limit'} buy sent · intended ${(price * 100).toFixed(1)}¢ · ack ${rt}ms — reading exchange state…`,
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
            {busySubmit ? (
              <>
                {isSlide ? (
                  <span
                    className="size-4 shrink-0 animate-spin rounded-full border-2 border-black/25 border-t-black"
                    aria-hidden
                  />
                ) : null}
                {isSlide ? 'SENDING…' : 'Submitting…'}
              </>
            ) : action === 'buy' ? (
              `Buy ${label}`
            ) : (
              `Sell ${label}`
            )}
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
                  value={limitPriceCents}
                  onChange={(e) => setLimitPriceCents(e.target.value)}
                  inputMode="numeric"
                  className="min-h-[40px] w-full bg-transparent text-base font-semibold tabular-nums text-zinc-100 outline-none"
                  placeholder={execMode === 'touch' ? touchLimitCents || defaultLimitCents || '50' : defaultLimitCents || '50'}
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {quickLimitSellPresets.map((p) => (
                  <button
                    key={`qsell-${p.key}`}
                    type="button"
                    onClick={() => {
                      setExecMode('limit');
                      setLimitPriceCents(String(p.cents));
                      setErr(null);
                      setOkMsg(null);
                    }}
                    className="rounded-lg border border-zinc-700/60 bg-zinc-900/45 px-2 py-1 text-[10px] font-bold text-zinc-200 hover:bg-zinc-800/70"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <details className="mt-2 rounded-xl border border-zinc-800/60 bg-zinc-950/20 px-3 py-2">
                <summary className="cursor-pointer select-none text-[11px] font-semibold text-zinc-300 hover:text-zinc-100 [&::-webkit-details-marker]:hidden">
                  Sell price guide (quick exits)
                </summary>
                <div className="mt-2 space-y-2 text-[11px] leading-relaxed text-zinc-400">
                  <div className="flex flex-wrap gap-2 font-mono text-[10px] text-zinc-500">
                    <span className="rounded-md border border-zinc-800/60 bg-black/20 px-2 py-0.5">Bid {scalp.bid != null ? `${scalp.bid.toFixed(1)}¢` : '—'}</span>
                    <span className="rounded-md border border-zinc-800/60 bg-black/20 px-2 py-0.5">Ask {scalp.ask != null ? `${scalp.ask.toFixed(1)}¢` : '—'}</span>
                    <span className="rounded-md border border-zinc-800/60 bg-black/20 px-2 py-0.5">
                      Spread {scalp.spread != null ? `${scalp.spread.toFixed(1)}¢` : '—'}
                    </span>
                  </div>
                  <ul className="space-y-1">
                    <li>
                      - <span className="font-semibold text-zinc-200">Instant exit</span>: type{' '}
                      <span className="font-mono text-zinc-200">{scalp.joinBid != null ? `${scalp.joinBid}¢` : 'Bid'}</span> (hit the bid).
                    </li>
                    <li>
                      - <span className="font-semibold text-zinc-200">Try for a better fill</span>: type{' '}
                      <span className="font-mono text-zinc-200">{scalp.microImproveSell != null ? `${scalp.microImproveSell}¢` : 'Ask−1'}</span>{' '}
                      and cancel quickly if it doesn’t fill.
                    </li>
                    <li>
                      - <span className="font-semibold text-zinc-200">Don’t round-trip</span>: if the tape slows at a wall, take the bid; waiting for one more tick is how scalps die.
                    </li>
                  </ul>
                </div>
              </details>
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
              className={`flex items-start justify-between gap-2 rounded-xl border px-3 py-2.5 text-[11px] leading-snug ${
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
          const selMax = selSellSh > 0 ? selSellSh : 0;

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
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{upLabel}</div>
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
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{downLabel}</div>
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
                      placeholder={`Qty (max ${selMax.toFixed(2)})`}
                      className="min-h-[42px] flex-1 rounded-xl border border-zinc-800/70 bg-black/20 px-3 font-mono text-[13px] text-zinc-100 outline-none focus:border-zinc-600/70"
                    />
                    <button
                      type="button"
                      disabled={!Number.isFinite(selMax) || selMax <= 0 || busySubmit || busyRefresh}
                      onClick={() => setSellQty(selMax > 0 ? String(floorShares4(selMax)) : '0')}
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
