import { type ReactElement, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ApiErr, MyFillRow } from './lib/api';
import {
  apiWsUrl,
  lastTradePrice,
  tradeAvgEntry,
  tradeBalanceAllowance,
  tradeCancelAllOrders,
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
  setPaperCashUsd,
} from './paperTrading';
import { pickBookLevels } from './bookLevels';
import {
  appendTradeHistory,
  appendTradeHistoryWithId,
  loadTradeHistory,
  updateTradeHistoryRow,
  TRADE_HISTORY_CHANGED_EVENT,
  type TradeHistoryRow,
} from './tradeHistory';
import { playTradeClick, playTradeError, playTradeFill } from './tradeSounds';
import { PAPER_ACCOUNT_SYNC_EVENT } from './paperAccountSync';
import { parseRestingOrderSnapshot } from './orderStatusParse';
import { floorShares4, roundPrice01, roundShares4, roundUsd2 } from './tradingRound';
import { extractOrderIdFromClobPayload, liveMarketOrderFillFromExecution, unwrapTradeActionData } from './tradeExecutionMeta';
import { reconcileTradeHistoryFromClob } from './reconcileTradeHistoryFromClob';

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
};

function parseUsdcBalance(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return roundUsd2(n);
}

/** Conservative 4dp floor so max-sell never exceeds wallet conditional balance. */
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
  const [execMode, setExecMode] = useState<'touch' | 'limit'>('touch');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [unit, setUnit] = useState<'dollars' | 'shares'>('dollars');
  const [accountMode, setAccountMode] = useState<'paper' | 'live'>('paper');
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
  const [paperCashEdit, setPaperCashEdit] = useState('462');

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
  const [availUsdc, setAvailUsdc] = useState<number | null>(null);
  const [balUp, setBalUp] = useState<number | null>(null);
  const [balDown, setBalDown] = useState<number | null>(null);
  const [balLoading, setBalLoading] = useState(false);
  const [balError, setBalError] = useState<string | null>(null);
  const [avgEntryUp, setAvgEntryUp] = useState<number | null>(null);
  const [avgEntryDown, setAvgEntryDown] = useState<number | null>(null);
  const [avgEntryErr, setAvgEntryErr] = useState<string | null>(null);

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
  /** CLOB last-trade print per outcome (live) — aligns “current price” with Polymarket-style marks. */
  const [lastTradeUp01, setLastTradeUp01] = useState<number | null>(null);
  const [lastTradeDown01, setLastTradeDown01] = useState<number | null>(null);
  const [flashToast, setFlashToast] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const toastIdRef = useRef(0);
  const toastTimersRef = useRef<Map<number, number>>(new Map());
  const [toasts, setToasts] = useState<Array<{ id: number; kind: 'ok' | 'err' | 'info'; message: string }>>([]);
  const [lastExecLatencyMs, setLastExecLatencyMs] = useState<number | null>(null);
  const liveSubmitGenRef = useRef(0);
  const submitLockRef = useRef(false);
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
  const lane = controlledLane ?? laneState;
  const token = lane === 'up' ? upToken : downToken;
  const label = lane === 'up' ? upLabel : downLabel;

  const livePositionShares = lane === 'up' ? balUp : balDown;
  const paperPos = useMemo(() => getPaperPosition(paperAccount, token), [paperAccount, token]);
  const positionShares = accountMode === 'paper' ? paperPos.shares : livePositionShares;

  // Stop-loss (client-side): when ref price crosses down through stop, submit a limit sell.
  const stopLossKey = useMemo(() => `pm:stoploss:v1:${token?.trim() || ''}`, [token]);
  const [stopLossEnabled, setStopLossEnabled] = useState(false);
  const [stopLossStopCents, setStopLossStopCents] = useState('');
  const [stopLossLimitCents, setStopLossLimitCents] = useState('');
  const [stopLossShares, setStopLossShares] = useState('');
  const [stopLossStatus, setStopLossStatus] = useState<'OFF' | 'ARMED' | 'TRIGGERED'>('OFF');
  const stopLossFireLockRef = useRef(false);
  const stopLossLastFireTokRef = useRef<string | null>(null);
  const stopLossLastCrossRef = useRef<number | null>(null);
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
    // Fallback polling only (primary updates come from websockets / book updates).
    // 500ms polling is overkill and causes UI thrash + needless upstream calls.
    const id = window.setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [accountMode, upToken, downToken, fetchLastTradesBoth]);

  const liveAvgEntry = lane === 'up' ? avgEntryUp : avgEntryDown;
  const paperUpPos = useMemo(() => getPaperPosition(paperAccount, upToken), [paperAccount, upToken]);
  const paperDownPos = useMemo(() => getPaperPosition(paperAccount, downToken), [paperAccount, downToken]);
  const paperMtm = useMemo(() => markToMarket({ account: paperAccount, tokenId: token, mid01: mid }), [paperAccount, token, mid]);

  const paperRestingForToken = useMemo(() => {
    if (!token) return [];
    return paperOrders
      .filter((o) => o.tokenId === token)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5);
  }, [paperOrders, token]);

  const recentFillsForToken = useMemo(() => {
    if (!token) return [];
    // Always show local fills immediately; merge in confirmed CLOB fills when available.
    const local = historyRows
      .filter((r) => r.token === token && r.mode === (accountMode === 'live' ? 'live' : 'paper') && (r.status === 'filled' || r.status === 'partial'))
      .slice()
      .sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

    if (accountMode !== 'live' || !myFills.length) return local.slice(0, 12);

    const confirmed = myFills
      .filter((f) => f.token_id === token)
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

    const byKey = new Map<string, (typeof local)[number]>();
    for (const r of local) byKey.set(`local:${r.id}`, r);
    for (const c of confirmed as any[]) byKey.set(`clob:${c.id}`, c);
    return Array.from(byKey.values())
      .slice()
      .sort((a: any, b: any) => (b.ts ?? 0) - (a.ts ?? 0))
      .slice(0, 12);
  }, [accountMode, historyRows, myFills, token]);

  const recentActivityForToken = useMemo(() => {
    if (!token) return [];
    return historyRows
      .filter((r) => r.token === token && r.mode === (accountMode === 'live' ? 'live' : 'paper'))
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

  const markCancelledForOrderId = useCallback(
    (oid: string) => {
      const orderId = String(oid ?? '').trim();
      if (!orderId) return;
      // Update the first matching row immediately for UX; background reconciliation will correct anything else.
      const match = historyRows.find((r) => r.mode === 'live' && r.orderId === orderId);
      if (match) {
        setHistoryRows(
          updateTradeHistoryRow(match.id, {
            status: 'cancelled',
            remainingShares: 0,
          }),
        );
      }
    },
    [historyRows],
  );

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

  const bookTouch = lane === 'up' ? bookTouchUp ?? null : bookTouchDown ?? null;
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
  }, [action, bookTouch?.bestAsk, bookTouch?.bestBid, displayMark01]);

  const spreadCents = useMemo(() => {
    const bid = bookTouch?.bestBid != null && bookTouch.bestBid > 0 ? roundPrice01(bookTouch.bestBid) : null;
    const ask = bookTouch?.bestAsk != null && bookTouch.bestAsk > 0 ? roundPrice01(bookTouch.bestAsk) : null;
    if (bid == null || ask == null) return null;
    return Math.max(0, ask - bid) * 100;
  }, [bookTouch?.bestAsk, bookTouch?.bestBid]);

  const [allowChopTrades, setAllowChopTrades] = useState(false);
  const [autoSizeSetup, setAutoSizeSetup] = useState(true);

  const entryReadiness = useMemo(() => {
    const s = ptbContext?.readinessState ?? null;
    const ln = ptbContext?.readinessLane ?? null;
    const why = ptbContext?.readinessWhy ?? null;
    return { state: s, lane: ln, why };
  }, [ptbContext?.readinessLane, ptbContext?.readinessState, ptbContext?.readinessWhy]);

  const chopLocked = useMemo(() => {
    if (!ptbContext) return false;
    const ctrl = ptbContext.controlSignal;
    const reg = ptbContext.structureEvent;
    return ctrl === 'NO_EDGE' || reg === 'chop';
  }, [ptbContext]);

  const laneMismatch = entryReadiness.lane != null && entryReadiness.lane !== lane;

  const buyGate = useMemo(() => {
    if (action !== 'buy') return { ok: true, reason: null as string | null };
    if (accountMode === 'paper') return { ok: true, reason: null as string | null };
    if (!token?.trim()) return { ok: false, reason: 'Token not ready yet.' };
    if (execMode !== 'touch') return { ok: true, reason: null as string | null };
    if (!allowChopTrades && chopLocked) return { ok: false, reason: 'Locked out: chop / NO_EDGE (enable override to trade anyway).' };
    if (laneMismatch) return { ok: false, reason: `Signal favors ${entryReadiness.lane === 'up' ? upLabel : downLabel} — switch lanes or wait.` };
    if (spreadCents != null) {
      const max = entryReadiness.state === 'ENTER' ? 1.6 : entryReadiness.state === 'SETUP' ? 2.6 : 1.4;
      if (spreadCents > max) return { ok: false, reason: `Spread too wide (${spreadCents.toFixed(1)}¢ > ${max.toFixed(1)}¢).` };
    }
    return { ok: true, reason: null as string | null };
  }, [
    accountMode,
    action,
    allowChopTrades,
    chopLocked,
    entryReadiness.lane,
    entryReadiness.state,
    execMode,
    laneMismatch,
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

  const pushFlash = useCallback((msg: string) => {
    setFlashToast(msg);
    if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      flashTimerRef.current = null;
      setFlashToast(null);
    }, 3800);
  }, []);

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

  useEffect(() => {
    return () => {
      if (killArmTimerRef.current != null) window.clearTimeout(killArmTimerRef.current);
      for (const t of toastTimersRef.current.values()) window.clearTimeout(t);
      toastTimersRef.current.clear();
    };
  }, []);
  const avgEntry = accountMode === 'paper' ? paperPos.avgCost01 : liveAvgEntry;

  /** Live: never inflate position from pending intent — balances come from CLOB after fill. */
  const optimisticPositionShares = positionShares;

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
          setBalError('Position/balance unavailable — is the API trading key configured?');
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
  }, [accountMode, upToken, downToken]);

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
        if (isOk(u)) setAvgEntryUp(u.data.avgEntry);
        if (isOk(d)) setAvgEntryDown(d.data.avgEntry);
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
    if (!isOk(rU) || !isOk(rD)) setBalError('Position/balance unavailable — is the API trading key configured?');
  }, [downToken, upToken]);

  const refreshLiveBalances = useCallback(async () => {
    if (accountMode !== 'live') return;
    if (!upToken || !downToken) return;
    setBalError(null);
    const gen = (liveBalancesRefreshRef.current.gen += 1);
    if (liveBalancesRefreshRef.current.inflight) return;
    liveBalancesRefreshRef.current.inflight = true;
    try {
      // Fast path: read immediately (no waiting on allowance refresh).
      await readLiveBalancesOnce();

      // Background reconcile: ask the API to refresh then read again.
      void (async () => {
        try {
          await Promise.all([
            tradeUpdateBalanceAllowance({ assetType: 'collateral' }),
            tradeUpdateBalanceAllowance({ tokenId: upToken, assetType: 'conditional' }),
            tradeUpdateBalanceAllowance({ tokenId: downToken, assetType: 'conditional' }),
          ]);
          if (gen !== liveBalancesRefreshRef.current.gen) return;
          await readLiveBalancesOnce();
        } catch {
          /* ignore background refresh errors */
        }
      })();
    } catch {
      setBalError('Could not load balances.');
    } finally {
      liveBalancesRefreshRef.current.inflight = false;
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
        const orders = (r.data as { orders?: unknown }).orders;
        setOpenOrders(Array.isArray(orders) ? orders : []);
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
      } else {
        setMyFills(Array.isArray(r.data.fills) ? r.data.fills : []);
      }
    } catch (e) {
      setMyFillsErr(`my_fills_failed · ${String(e)}`);
      setMyFills([]);
    }
  }, [accountMode, token]);

  const scheduleTruthRefreshBurst = useCallback(
    (tokenId: string | null, orderId?: string | null) => {
      if (accountMode !== 'live') return;
      const tid = tokenId?.trim();
      if (!tid) return;

      const doOnce = async () => {
        try {
          // Order tape first (updates local history rows fast).
          await reconcileTradeHistoryFromClob(tid);
        } catch {
          /* ignore */
        }
        setHistoryRows(loadTradeHistory());
        void refreshOpenOrders();
        void refreshMyFills(tid);
        refreshAvgEntryThrottled();
        refreshLiveBalancesThrottled();
        // If we have an order id, a direct getOrder poll will still be the final arbiter.
        // (pollRestingOrderFill already runs in parallel; this burst helps when a fast fill lands before UI catches up.)
        if (orderId) void tradeGetOrder(orderId).catch(() => undefined);
      };

      // Immediate + a couple short retries (CLOB tape can lag by a few hundred ms).
      void doOnce();
      window.setTimeout(() => void doOnce(), 450);
      window.setTimeout(() => void doOnce(), 1200);
    },
    [accountMode, refreshAvgEntryThrottled, refreshLiveBalancesThrottled, refreshMyFills, refreshOpenOrders],
  );

  useEffect(() => {
    if (accountMode !== 'live') return;
    if (!token && openOrdersScope === 'token') return;
    let cancelled = false;
    void (async () => {
      if (!cancelled) await refreshOpenOrders();
      if (!cancelled) await refreshMyFills();
    })();
    const t = window.setInterval(() => {
      if (!cancelled) void refreshOpenOrders();
      if (!cancelled) void refreshMyFills();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [accountMode, openOrdersScope, refreshMyFills, refreshOpenOrders, token]);

  const chooseAction = useCallback((a: 'buy' | 'sell') => {
    setAction(a);
    setErr(null);
    setOkMsg(null);
    if (a === 'sell') {
      setUnit('shares');
      setSellQty('');
    }
  }, []);

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
      if (controlledLane == null) setLaneState(L);
      onLaneChange?.(L);
      setErr(null);
      setOkMsg(null);
      if (action === 'sell') setSellQty('');
    },
    [action, controlledLane, onLaneChange],
  );

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

  const refreshPositionAndMaxSell = useCallback(async () => {
    if (!token) return;
    setErr(null);
    setBusyRefresh(true);
    try {
      if (accountMode === 'paper') {
        const sh = paperPos.shares;
        if (sh <= 0) {
          setSellQty('0');
          return;
        }
        const v = floorShares4(sh);
        setSellQty(v > 0 ? String(v) : '0');
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
      if (sh == null || sh <= 0) {
        setSellQty('0');
        return;
      }
      const v = sh;
      setSellQty(v > 0 ? String(v) : '0');
    } finally {
      setBusyRefresh(false);
    }
  }, [accountMode, paperPos.shares, token, upToken, downToken]);

  // Load persisted stop-loss config whenever token changes (live-only intent).
  useEffect(() => {
    const tok = token?.trim();
    stopLossFireLockRef.current = false;
    stopLossLastFireTokRef.current = null;
    stopLossLastCrossRef.current = null;
    if (!tok) {
      setStopLossEnabled(false);
      setStopLossStopCents('');
      setStopLossLimitCents('');
      setStopLossShares('');
      setStopLossStatus('OFF');
      return;
    }
    try {
      const raw = window.localStorage.getItem(stopLossKey);
      if (!raw) {
        setStopLossEnabled(false);
        setStopLossStatus('OFF');
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return;
      const o = parsed as Partial<StopLossConfig> & Record<string, unknown>;
      const enabled = o.enabled === true;
      const stop01 = typeof o.stop01 === 'number' && Number.isFinite(o.stop01) ? o.stop01 : null;
      const limit01 = typeof o.limit01 === 'number' && Number.isFinite(o.limit01) ? o.limit01 : null;
      const shares = typeof o.shares === 'number' && Number.isFinite(o.shares) ? o.shares : null;
      setStopLossEnabled(enabled);
      setStopLossStopCents(stop01 != null ? (stop01 * 100).toFixed(1) : '');
      setStopLossLimitCents(limit01 != null ? (limit01 * 100).toFixed(1) : '');
      setStopLossShares(shares != null ? String(shares) : '');
      setStopLossStatus(enabled ? 'ARMED' : 'OFF');
    } catch {
      setStopLossEnabled(false);
      setStopLossStatus('OFF');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stopLossKey]);

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
    };
    try {
      window.localStorage.setItem(stopLossKey, JSON.stringify(cfg));
    } catch {
      /* ignore */
    }
  }, [stopLossEnabled, stopLossLimitCents, stopLossShares, stopLossStopCents, stopLossKey, token]);

  // Stop-loss trigger loop: uses best bid when available, else last-trade/mid mark.
  useEffect(() => {
    if (accountMode !== 'live') {
      setStopLossStatus('OFF');
      return;
    }
    const tok = token?.trim();
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
    if (positionShares == null || !(positionShares > 0)) {
      setStopLossStatus('ARMED');
      return;
    }
    const touch = lane === 'up' ? (bookTouchUp ?? null) : (bookTouchDown ?? null);
    const bid = touch?.bestBid != null && touch.bestBid > 0 ? roundPrice01(touch.bestBid) : null;
    const ref01 = bid ?? (displayMark01 != null && displayMark01 > 0 ? roundPrice01(displayMark01) : null);
    if (ref01 == null || !(ref01 > 0) || ref01 >= 1) return;

    const prev = stopLossLastCrossRef.current;
    stopLossLastCrossRef.current = ref01;
    const crossed = prev != null && prev > stop01 && ref01 <= stop01;
    if (!crossed) {
      setStopLossStatus('ARMED');
      return;
    }
    if (stopLossFireLockRef.current) return;
    if (stopLossLastFireTokRef.current === tok) return;

    stopLossFireLockRef.current = true;
    stopLossLastFireTokRef.current = tok;
    setStopLossStatus('TRIGGERED');

    void (async () => {
      try {
        const sizeLive = floorShares4(Math.min(shReq, positionShares));
        if (!(sizeLive > 0) || sizeLive < 1e-4) return;
        const px = roundPrice01(clamp01(limit01));
        const quoted01 = ref01;
        const optimistic = appendTradeHistoryWithId({
          ...tradeHistoryMarketMeta,
          mode: 'live',
          exec: 'limit',
          side: 'sell',
          token: tok,
          label,
          price01: px,
          quotedPrice01: quoted01,
          intendedPrice01: px,
          submittedPrice01: null,
          fillAvgPrice01: null,
          markPrice01: ref01,
          shares: sizeLive,
          requestedShares: sizeLive,
          remainingShares: sizeLive,
          usdCents: Math.abs(Math.round(px * sizeLive * 100)),
          status: 'sending',
          auditNote: `stop_loss<=${(stop01 * 100).toFixed(1)}¢`,
        });
        setHistoryRows(optimistic.rows);
        const controller = new AbortController();
        const tClient0 = performance.now();
        const res = await tradeCreateOrderWithOpts(
          {
            token: tok,
            side: 'sell',
            price: px,
            size: sizeLive,
            orderType: 'GTC',
            signatureType: null,
            marketSlug: marketSlug ?? '',
            outcome: label,
          },
          { signal: controller.signal, timeoutMs: 25_000 },
        );
        const clientMs = Math.round(performance.now() - tClient0);
        if (!isOk(res)) {
          const e = res as ApiErr;
          setHistoryRows(
            updateTradeHistoryRow(optimistic.id, {
              status: 'failed',
              error: `${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`,
            }),
          );
          pushToast('err', `Stop-loss failed: ${e.error}`);
          playTradeError();
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
              price01: px,
              error: undefined,
            }),
          );
          if (oid) pollRestingOrderFill(optimistic.id, oid, sizeLive, px, quoted01);
          pushToast('ok', `Stop-loss sent: sell ${sizeLive.toFixed(4)} sh @ ${(px * 100).toFixed(1)}¢`);
          playTradeFill();
          void refreshAvgEntry();
          void refreshPositionAndMaxSell();
          void refreshOpenOrders();
        }
      } finally {
        stopLossFireLockRef.current = false;
      }
    })();
  }, [
    accountMode,
    bookTouchUp?.bestBid,
    bookTouchDown?.bestBid,
    displayMark01,
    label,
    lane,
    marketSlug,
    positionShares,
    refreshAvgEntry,
    refreshOpenOrders,
    refreshPositionAndMaxSell,
    stopLossEnabled,
    stopLossLimitCents,
    stopLossShares,
    stopLossStopCents,
    token,
    tradeHistoryMarketMeta,
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
          setPendingPos((p) => (p && p.token === token ? { ...p, status: 'filled' } : p));
          window.setTimeout(() => setPendingPos((p) => (p && p.token === token ? null : p)), 1200);
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
      let reconciledOnce = false;
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

        if (p.isCancelled) {
          updateTradeHistoryRow(rowId, {
            status: 'cancelled',
            requestedShares: orig,
            remainingShares: remaining,
            auditNote: p.statusRaw ? `cancelled:${p.statusRaw}` : 'cancelled',
          });
          setHistoryRows(loadTradeHistory());
          void refreshAvgEntry();
          void refreshPositionAndMaxSell();
          return;
        }

        const fillPx = p.avgPrice01 != null && p.avgPrice01 > 0 ? p.avgPrice01 : null;
        // For fast FAK sells, `getOrder()` can lag / report a misleading avg. Reconcile from the CLOB tape ASAP.
        if (!reconciledOnce && rowTok) {
          const shouldReconcile = fullyFilled || matched > 1e-6;
          if (shouldReconcile) {
            reconciledOnce = true;
            void (async () => {
              try {
                const n = await reconcileTradeHistoryFromClob(rowTok);
                if (n > 0) setHistoryRows(loadTradeHistory());
              } catch {
                /* ignore */
              }
            })();
          }
        }
        if (fullyFilled && fillPx != null) {
          const sh = matched > 0 ? matched : submittedSize;
          const note = priceAuditNote(quotedPrice01, intendedPrice01, p.avgPrice01);
          updateTradeHistoryRow(rowId, {
            status: 'filled',
            fillAvgPrice01: fillPx,
            submittedPrice01: p.limitPrice01 ?? undefined,
            quotedPrice01: quotedPrice01 ?? undefined,
            price01: fillPx,
            shares: sh,
            requestedShares: orig,
            remainingShares: 0,
            usdCents: Math.abs(Math.round(fillPx * sh * 100)),
            roundTripMs: Math.round(performance.now() - started),
            auditNote: note,
          });
          setHistoryRows(loadTradeHistory());
          if (rowTok) {
            void (async () => {
              try {
                const n = await reconcileTradeHistoryFromClob(rowTok);
                if (n > 0) setHistoryRows(loadTradeHistory());
              } catch {
                /* ignore */
              }
            })();
          }
          void refreshAvgEntry();
          void refreshPositionAndMaxSell();
          return;
        }

        // Update partial fills live (so UI matches Polymarket faster).
        if (matched > 1e-6 && matched > lastMatched + 1e-6) {
          lastMatched = matched;
          updateTradeHistoryRow(rowId, {
            status: 'partial',
            fillAvgPrice01: p.avgPrice01 ?? undefined,
            shares: matched,
            requestedShares: orig,
            remainingShares: remaining,
            price01: fillPx ?? undefined,
            usdCents: fillPx != null ? Math.abs(Math.round(fillPx * matched * 100)) : null,
            auditNote: p.avgPrice01 != null ? 'partial_live' : 'partial_live_no_avg',
          });
          setHistoryRows(loadTradeHistory());
          if (rowTok) {
            void (async () => {
              try {
                const n = await reconcileTradeHistoryFromClob(rowTok);
                if (n > 0) setHistoryRows(loadTradeHistory());
              } catch {
                /* ignore */
              }
            })();
          }
          void refreshAvgEntry();
          void refreshPositionAndMaxSell();
        }

        if (performance.now() - started < 120_000) {
          const age = performance.now() - started;
          const delay = age < 2500 ? 180 : age < 12_000 ? 260 : age < 45_000 ? 420 : 700;
          window.setTimeout(tick, delay);
          return;
        }

        if (matched < 1e-6) {
          updateTradeHistoryRow(rowId, {
            status: 'no_fill',
            requestedShares: orig,
            remainingShares: orig,
            auditNote: 'watch_timeout_no_match',
          });
        } else {
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
    [refreshAvgEntry, refreshPositionAndMaxSell],
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
  const midIsExtremeLow = mid01 != null && mid01 <= 0.01;
  const midIsExtremeHigh = mid01 != null && mid01 >= 0.99;
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
  const sellSharesClamped = useMemo(() => {
    if (!sellQtyOk) return null;
    if (positionShares != null) return Math.min(sellQtyNum, positionShares);
    if (balLoading) return null;
    return sellQtyNum;
  }, [sellQtyOk, sellQtyNum, positionShares, balLoading]);
  const sellEstValue = mid != null && sellSharesClamped != null ? sellSharesClamped * mid : null;

  const maxSellStr =
    positionShares != null && positionShares > 0 ? fmtShares(positionShares, 'compact') : accountMode === 'live' && balLoading ? '…' : '—';

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
      if (r.status === 'sending' || r.status === 'pending' || r.status === 'sent' || r.status === 'partial') return r;
      // Show recent filled trades briefly so instant fills are visible immediately after click.
      if (r.status === 'filled' && now - (r.ts ?? 0) <= SHOW_FILLED_MS) return r;
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
        shares: sellAmt,
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
              { token, side: 'sell', amount: sellAmt, signatureType: null, marketSlug: marketSlug ?? '', outcome: label },
              { signal: controller.signal, timeoutMs: 25_000 },
            )
          : await tradeCreateOrderWithOpts(
              // Limit-only: server always posts a true limit (GTC). We simulate "fill-and-kill" by cancelling remainder shortly after submit.
              { token, side: 'sell', price: intendedTouchPx, size: sellAmt, orderType: 'GTC', signatureType: null, marketSlug: marketSlug ?? '', outcome: label },
              { signal: controller.signal, timeoutMs: 25_000 },
            );
      const clientMs = Math.round(performance.now() - tClient0);
      if (!isOk(res)) {
        const e = res as ApiErr;
        setErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
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
          const fill = liveMarketOrderFillFromExecution(execution, result);
          if (fill.ok) {
            playTradeFill();
            setHistoryRows(
              updateTradeHistoryRow(optimistic.id, {
                status: fill.rowStatus,
                submittedPrice01: execution?.submitted_price_01 ?? null,
                fillAvgPrice01: fill.avg01,
                price01: fill.avg01,
                shares: fill.shares,
                remainingShares: Math.max(0, sellAmt - fill.shares),
                usdCents: Math.abs(Math.round(fill.avg01 * fill.shares * 100)),
                orderId: oid ?? undefined,
                roundTripMs: rt,
                error: undefined,
              }),
            );
            pushToast('ok', `Sold ${fill.shares.toFixed(4)} sh @ ${(fill.avg01 * 100).toFixed(2)}¢ (${fill.rowStatus})`);
            setOkMsg(`Market sell ${fill.rowStatus} · avg ${(fill.avg01 * 100).toFixed(2)}¢ · ack ${rt}ms`);
            // Make UI update immediately (positions, fills, open orders can lag otherwise).
            scheduleTruthRefreshBurst(token, oid ?? null);
          } else {
            // If we didn't get a canonical fill back, treat as "sent" and reconcile from CLOB tape shortly after.
            setHistoryRows(
              updateTradeHistoryRow(optimistic.id, {
                status: 'sent',
                submittedPrice01: execution?.submitted_price_01 ?? null,
                orderId: fill.orderId ?? oid ?? undefined,
                roundTripMs: rt,
                error: undefined,
              }),
            );
            setOkMsg(`Market sell sent · ack ${rt}ms — reconciling…`);
            scheduleTruthRefreshBurst(token, fill.orderId ?? oid ?? null);
          }
          setSellQty('');
        } else {
          setHistoryRows(
            updateTradeHistoryRow(optimistic.id, {
              status: 'sent',
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountMode, mid, paperAccount, token]);

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
            <p className="mt-1 text-[14px] leading-relaxed text-zinc-500">
              {isSidebarOnly
                ? 'Choose practice or live, pick a side, set how much, then confirm. Hover execution modes for a short explanation.'
                : 'Order type · outcome · size · review'}
            </p>
          ) : (
            <p className="mt-1 text-[13px] leading-relaxed text-zinc-500">
              Smart limit (quick) is the default — chart stays visible. Advanced switches between quick and custom limit ¢.
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
                  const r = await tradeCancelAllOrders();
                  if (!isOk(r)) setErr(`${(r as ApiErr).error}${(r as ApiErr).details ? ` · ${JSON.stringify((r as ApiErr).details)}` : ''}`);
                  else setOkMsg('Cancel-all sent. Verify on Polymarket Open Orders.');
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
                setAccountMode(v);
                setErr(null);
                setOkMsg(null);
              }}
              options={[
                { value: 'paper', label: 'Practice', title: 'Simulated cash and fills — nothing is sent on-chain' },
                { value: 'live', label: 'Live', title: 'Real orders via your configured API keys' },
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
                    placeholder="462.00"
                    title="Set your practice cash balance"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const v = Number(paperCashEdit);
                    if (!Number.isFinite(v) || v < 0) {
                      setErr('Enter a valid cash amount (e.g. 462).');
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
                ({openOrdersLoading ? '…' : openOrders.length})
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
                                  const r = await tradeCancelOrder(id);
                                  if (!isOk(r)) {
                                    const e = r as ApiErr;
                                    setOpenOrdersErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
                                  } else {
                                    setOkMsg('Cancel sent.');
                                    markCancelledForOrderId(id);
                                    void refreshOpenOrders();
                                  }
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
                  {liveStatusRow.status === 'filled'
                    ? 'FILLED'
                    : liveStatusRow.status === 'partial'
                      ? 'PARTIALLY FILLED'
                      : liveStatusRow.status === 'sent'
                        ? 'RESTING (OPEN)'
                        : liveStatusRow.status === 'pending'
                          ? 'PENDING'
                          : 'SENDING'}
                </div>
                <div className="mt-1 flex flex-wrap gap-2 font-mono text-[11px] text-amber-100/85">
                  <span className="rounded-lg border border-amber-800/30 bg-black/15 px-2 py-1">
                    filled {liveStatusRow.shares == null ? '—' : liveStatusRow.shares.toFixed(4)}
                    {liveStatusRow.requestedShares != null ? ` / ${liveStatusRow.requestedShares.toFixed(4)}` : ''}
                    {liveStatusRow.remainingShares != null ? ` · rem ${liveStatusRow.remainingShares.toFixed(4)}` : ''}
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
                    avg {liveStatusRow.fillAvgPrice01 == null ? '—' : `${(liveStatusRow.fillAvgPrice01 * 100).toFixed(2)}¢`}
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
                  disabled={!liveStatusRow.orderId}
                  onClick={async () => {
                    const oid = liveStatusRow.orderId;
                    if (!oid) return;
                    const r = await tradeCancelOrder(oid);
                    if (!isOk(r)) {
                      const e = r as ApiErr;
                      pushToast('err', `${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
                    } else {
                      pushToast('ok', 'Cancel sent.');
                      markCancelledForOrderId(oid);
                      void refreshOpenOrders();
                      setHistoryRows(loadTradeHistory());
                    }
                  }}
                  className="min-h-[40px] rounded-xl border border-rose-800/40 bg-rose-950/20 px-3 text-[11px] font-black text-rose-100 hover:bg-rose-950/35 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Cancel the active resting order (requires an order id)"
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
        <div className="mt-4 rounded-xl border border-sky-800/35 bg-sky-950/15 px-3 py-2.5 text-[11px] leading-relaxed text-sky-100/90">
          <span className="font-semibold text-sky-200">Live trading</span> sends real orders. Recent activity may show as{' '}
          <span className="font-medium text-sky-100">submitted</span> until a fill is confirmed. If balances stay empty, add{' '}
          <code className="rounded bg-black/25 px-1 py-0.5 font-mono text-[10px] text-sky-200">POLYMARKET_PRIVATE_KEY</code> to your API env and restart.
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

      {accountMode === 'live' && balError ? (
        <div className="mt-4 rounded-lg border border-amber-800/35 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-100/90">{balError}</div>
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

      {isSlide ? (
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
          <div className="grid min-w-0 grid-cols-2 gap-2">
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
        </div>
      ) : null}

      {/* Outcome */}
      <div className={isSlide ? 'mt-4' : 'mt-6'}>
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Outcome select</div>
        {!isSlide ? (
          <p className="mt-1 text-[11px] text-zinc-600">Tap the outcome you want to trade — mid price updates as the book moves.</p>
        ) : (
          <p className="mt-1 text-[11px] text-zinc-600">Large prices — tap side, size, then Enter.</p>
        )}
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
      </div>

      {action === 'buy' ? (
        <>
          {!isSlide ? (
            <div className="mt-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Order type</div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="min-h-[36px] rounded-lg border border-zinc-700/60 bg-black/20 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-black/30"
                >
                  {showAdvanced ? 'Hide advanced' : 'Advanced'}
                </button>
              </div>
              <div className="mt-2 rounded-xl border border-zinc-800/60 bg-zinc-950/30 px-3 py-3">
                <p className="mb-2 text-[10px] leading-snug text-zinc-500">
                  Limit orders only. Quick = auto ¢ near the quote; Custom = you type the ¢. Use Advanced for book tools.
                </p>
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
                          { token, side: 'buy', price: bestAsk, size: sharesReq, signatureType: null, marketSlug: marketSlug ?? '', outcome: label },
                          { timeoutMs: 25_000 },
                        );
                        const clientMs = Math.round(performance.now() - tClient0);
                        if (!isOk(res)) {
                          const e = res as ApiErr;
                          setErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
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
                        void refreshLiveBalances();
                        void refreshOpenOrders();
                        void refreshAvgEntry();
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
                          { token, side: 'buy', price: px01, size: sharesReq, signatureType: null, marketSlug: marketSlug ?? '', outcome: label },
                          { timeoutMs: 25_000 },
                        );
                        const clientMs = Math.round(performance.now() - tClient0);
                        if (!isOk(res)) {
                          const e = res as ApiErr;
                          setErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
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
                        void refreshLiveBalances();
                        void refreshOpenOrders();
                        void refreshAvgEntry();
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
                                }
                                return;
                              }

                              const res = await tradeCreateOrderWithOpts(
                                { token, side: 'buy', price: l.price, size: takeNum, signatureType: null, marketSlug: marketSlug ?? '', outcome: label },
                                { timeoutMs: 25_000 },
                              );
                              if (!isOk(res)) {
                                const e = res as ApiErr;
                                setErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
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
                            { token, side: action, price: leg.price01, size: leg.shares, signatureType: null, marketSlug: marketSlug ?? '', outcome: label },
                            { timeoutMs: 25_000 },
                          );
                          if (!isOk(res)) {
                            const e = res as ApiErr;
                            setErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
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

          {action === 'buy' && ptbContext ? (
            <div className="mt-3 rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2 text-[11px] text-zinc-400">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold text-zinc-300">
                  Signal: {ptbContext.readinessState ?? 'WAIT'}
                  {ptbContext.readinessLane ? ` · ${ptbContext.readinessLane === 'up' ? upLabel : downLabel}` : ''}
                </div>
                <label className="inline-flex items-center gap-2 text-[10px] font-semibold text-zinc-400">
                  <input
                    type="checkbox"
                    checked={autoSizeSetup}
                    onChange={(e) => setAutoSizeSetup(e.target.checked)}
                  />
                  Auto-size SETUP (¼ size)
                </label>
              </div>
              {!allowChopTrades && chopLocked ? (
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-amber-200/90">Chop / NO_EDGE: buys locked out.</div>
                  <button
                    type="button"
                    className="rounded-lg border border-amber-700/30 bg-amber-950/15 px-2 py-1 text-[10px] font-bold text-amber-100 hover:bg-amber-950/25"
                    onClick={() => setAllowChopTrades(true)}
                    title="Override safety gate and allow buying in chop/no-edge."
                  >
                    Override
                  </button>
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
            </div>
          ) : null}

          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto] sm:items-stretch">
            <button
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
                if (accountMode === 'paper') {
                  const px = limit01;
                  const setupScale =
                    autoSizeSetup && ptbContext?.readinessState === 'SETUP' && ptbContext?.readinessLane === lane ? 0.25 : 1;
                  const scaledAmt = unit === 'dollars' ? amtNum * setupScale : amtNum;
                  const shares = unit === 'shares' ? scaledAmt : px != null && px > 0 ? scaledAmt / px : NaN;
                  // Limit/touch in paper mode: rest if not marketable, auto-fill later when mid crosses.
                  if (mid == null || limit01 == null) {
                    setErr('Need a valid mid and limit price.');
                  } else {
                    const limit = limit01;
                    const marketable = mid <= limit;
                    if (marketable) {
                      const r = paperTrade({ account: paperAccount, tokenId: token, side: 'buy', shares, price01: Math.min(mid, limit) });
                      if (!r.ok) setErr(r.error);
                      else {
                        setPaperAccount(r.account);
                        setOkMsg(`Paper filled buy ${shares.toFixed(2)} sh of ${label}`);
                        setHistoryRows(
                          appendTradeHistory({ ...tradeHistoryMarketMeta,
                            mode: 'paper',
                            exec: execMode,
                            side: 'buy',
                            token,
                            label,
                            price01: r.fill.price01,
                            shares: r.fill.shares,
                            usdCents: Math.abs(r.fill.usdCents),
                            status: 'filled',
                          }),
                        );
                      }
                    } else {
                      const o = addPaperOrder({ tokenId: token, side: 'buy', limit01: limit, shares });
                      setOkMsg(`Paper order resting: buy ${shares.toFixed(2)} sh ≤ ${(limit * 100).toFixed(1)}¢`);
                      setHistoryRows(
                        appendTradeHistory({ ...tradeHistoryMarketMeta,
                          id: o.id,
                          ts: o.createdAt,
                          mode: 'paper',
                          exec: execMode,
                          side: 'buy',
                          token,
                          label,
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
                if (token?.trim()) {
                  const setupScale =
                    autoSizeSetup && ptbContext?.readinessState === 'SETUP' && ptbContext?.readinessLane === lane ? 0.25 : 1;
                  const effAmtNum = unit === 'dollars' ? amtNum * setupScale : amtNum;
                  const pxPreview = limit01;
                  const px =
                    pxPreview != null && Number.isFinite(pxPreview) && pxPreview > 0 && pxPreview < 1 ? pxPreview : null;
                  if (unit === 'dollars') {
                    // For $-based market buys, shares are not knowable until fill; do not guess.
                    const usd = Number.isFinite(effAmtNum) && effAmtNum > 0 ? roundUsd2(effAmtNum) : 0;
                    if (usd > 0) {
                      setPendingPos({ token, side: 'buy', kind: 'usd', usd, price01: px, status: 'submitting', createdAt: Date.now() });
                    }
                  } else {
                    const shPreview = roundShares4(effAmtNum);
                    if (Number.isFinite(shPreview) && shPreview > 0) {
                      setPendingPos({
                        token,
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
                  if (!token?.trim()) {
                    setErr('Outcome token is not ready yet — wait for this market to finish loading, then retry.');
                    return;
                  }
                  const price = limit01 ?? NaN;
                  const setupScale =
                    autoSizeSetup && ptbContext?.readinessState === 'SETUP' && ptbContext?.readinessLane === lane ? 0.25 : 1;
                  const effAmtNum = unit === 'dollars' ? amtNum * setupScale : amtNum;
                  const sizeSharesRaw = unit === 'shares' ? effAmtNum : price > 0 ? effAmtNum / price : NaN;
                  const sizeShares = Number.isFinite(sizeSharesRaw) ? floorShares4(sizeSharesRaw) : NaN;
                  if (!Number.isFinite(sizeShares) || sizeShares < 1e-4) {
                    setErr('Buy size is too small after rounding to 4 decimal shares.');
                    return;
                  }
                  liveSubmitGenRef.current += 1;
                  const quoted01 = Number.isFinite(price) ? roundPrice01(price) : null;
                  const mark01 = mid != null && mid > 0 ? roundPrice01(mid) : null;
                  const optimistic = appendTradeHistoryWithId({ ...tradeHistoryMarketMeta,
                    mode: 'live',
                    exec: execMode,
                    side: 'buy',
                    token,
                    label,
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
                    { token, side: 'buy', price, size: sizeShares, signatureType: null, marketSlug: marketSlug ?? '', outcome: label },
                    { signal: controller.signal, timeoutMs: 25_000 },
                  );
                  const clientMs = Math.round(performance.now() - tClient0);
                  if (!isOk(res)) {
                    const e = res as ApiErr;
                    setErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
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
                    if (oid) pollRestingOrderFill(optimistic.id, oid, sizeShares, price, quoted01);
                    setOkMsg(
                      `${execMode === 'touch' ? 'Quick' : 'Limit'} buy sent · intended ${(price * 100).toFixed(1)}¢ · ack ${rt}ms — reading exchange state…`,
                    );
                    // Make “Positions” feel instant after submit.
                    void refreshLiveBalances();
                    void refreshOpenOrders();
                    void refreshAvgEntry();
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
                {isSlide ? 'SENDING…' : 'Submitting…'}
              </>
            ) : action === 'buy' ? (
              `Buy ${label}`
            ) : (
              `Sell ${label}`
            )}
            </button>
            {accountMode === 'live' && activeLiveOrderRow?.orderId ? (
              <button
                type="button"
                disabled={busySubmit}
                className="min-h-[48px] rounded-xl border border-rose-800/40 bg-rose-950/20 px-4 text-[12px] font-black text-rose-100 hover:bg-rose-950/35 disabled:cursor-not-allowed disabled:opacity-40"
                title="Cancel the active live order for this outcome"
                onClick={async () => {
                  const oid = activeLiveOrderRow.orderId;
                  if (!oid) return;
                  const r = await tradeCancelOrder(oid);
                  if (!isOk(r)) {
                    const e = r as ApiErr;
                    pushToast('err', `${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
                  } else {
                    pushToast('ok', 'Cancel sent.');
                    void refreshOpenOrders();
                    void refreshMyFills();
                    setHistoryRows(loadTradeHistory());
                  }
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

            <div className="mt-3">
              {accountMode === 'live' ? (
                <details className="mb-3 rounded-xl border border-zinc-800/60 bg-zinc-950/30 p-3">
                  <summary className="cursor-pointer list-none text-[11px] font-semibold text-zinc-400 outline-none marker:content-none [&::-webkit-details-marker]:hidden hover:text-zinc-300">
                    <span className="font-mono text-zinc-600">▸</span> Stop-loss (auto stop-limit sell)
                    <span
                      className={`ml-2 inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-black ${
                        stopLossStatus === 'TRIGGERED'
                          ? 'border-rose-700/50 bg-rose-950/35 text-rose-100'
                          : stopLossEnabled
                            ? 'border-emerald-700/45 bg-emerald-950/25 text-emerald-100'
                            : 'border-zinc-700/50 bg-black/20 text-zinc-400'
                      }`}
                      title={stopLossStatus === 'TRIGGERED' ? 'Triggered (one-shot). Toggle off/on to re-arm.' : stopLossEnabled ? 'Armed' : 'Off'}
                    >
                      {stopLossStatus}
                    </span>
                  </summary>
                  <div className="mt-3 space-y-2">
                    <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                      <span className="text-[11px] font-semibold text-zinc-300">Enable</span>
                      <input
                        type="checkbox"
                        checked={stopLossEnabled}
                        onChange={(e) => {
                          const next = e.target.checked;
                          setStopLossEnabled(next);
                          setStopLossStatus(next ? 'ARMED' : 'OFF');
                          if (!next) {
                            setStopLossStopCents('');
                            setStopLossLimitCents('');
                            setStopLossShares('');
                          }
                        }}
                        className="h-4 w-4 accent-emerald-500"
                      />
                    </label>

                    <div className="grid gap-2 sm:grid-cols-3">
                      <label className="rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Stop (¢)</div>
                        <input
                          value={stopLossStopCents}
                          onChange={(e) => setStopLossStopCents(e.target.value)}
                          inputMode="decimal"
                          placeholder={targets?.stopCents ?? '—'}
                          disabled={!stopLossEnabled}
                          className="mt-1 min-h-[34px] w-full bg-transparent text-right font-mono text-[13px] font-semibold tabular-nums text-zinc-100 outline-none disabled:opacity-40"
                        />
                      </label>
                      <label className="rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Limit (¢)</div>
                        <input
                          value={stopLossLimitCents}
                          onChange={(e) => setStopLossLimitCents(e.target.value)}
                          inputMode="decimal"
                          placeholder={limitPriceCents || targets?.stopCents || '—'}
                          disabled={!stopLossEnabled}
                          className="mt-1 min-h-[34px] w-full bg-transparent text-right font-mono text-[13px] font-semibold tabular-nums text-zinc-100 outline-none disabled:opacity-40"
                        />
                      </label>
                      <label className="rounded-lg border border-zinc-800/60 bg-black/20 px-3 py-2">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Shares</div>
                        <input
                          value={stopLossShares}
                          onChange={(e) => setStopLossShares(e.target.value)}
                          inputMode="decimal"
                          placeholder={positionShares != null ? String(floorShares4(positionShares)) : '—'}
                          disabled={!stopLossEnabled}
                          className="mt-1 min-h-[34px] w-full bg-transparent text-right font-mono text-[13px] font-semibold tabular-nums text-zinc-100 outline-none disabled:opacity-40"
                        />
                      </label>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={!stopLossEnabled || positionShares == null || !(positionShares > 0)}
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
                          disabled={!stopLossEnabled}
                          className="rounded-lg border border-rose-800/35 bg-rose-950/20 px-2.5 py-1.5 text-[10px] font-bold text-rose-100 hover:bg-rose-950/35 disabled:opacity-40"
                          title="Use assist stop as trigger"
                          onClick={() => setStopLossStopCents(targets.stopCents)}
                        >
                          Use assist stop
                        </button>
                      ) : null}
                      <button
                        type="button"
                        disabled={!stopLossEnabled}
                        className="rounded-lg border border-amber-800/35 bg-amber-950/15 px-2.5 py-1.5 text-[10px] font-bold text-amber-100 hover:bg-amber-950/25 disabled:opacity-40"
                        title="Use current sell limit as stop-limit limit price"
                        onClick={() => setStopLossLimitCents(limitPriceCents || stopLossLimitCents)}
                      >
                        Limit = current
                      </button>
                    </div>

                    <p className="text-[10px] leading-relaxed text-zinc-500">
                      Watches <span className="font-mono text-zinc-400">best bid</span> (fallback: last trade / mid) and submits a{' '}
                      <span className="font-mono text-zinc-400">GTC limit sell</span> once price crosses down through Stop. Keep this tab open.
                    </p>
                  </div>
                </details>
              ) : null}
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
              <p className="mt-2 text-[10px] text-zinc-500">Use <span className="text-zinc-400">Max</span> for size, then the main sell button.</p>
            </div>

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
                              outcome: label,
                            },
                            { signal: controller.signal, timeoutMs: 25_000 },
                          );
                          const clientMs = Math.round(performance.now() - tClient0);
                          if (!isOk(res)) {
                            const e = res as ApiErr;
                            setErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
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
                        { token, side: 'sell', amount: sizeLive, signatureType: null, marketSlug: marketSlug ?? '', outcome: label },
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
                          outcome: label,
                        },
                        { signal: controller.signal, timeoutMs: 25_000 },
                      );
                  const clientMs = Math.round(performance.now() - tClient0);
                  if (!isOk(res)) {
                    const e = res as ApiErr;
                    setErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
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
                      const fill = liveMarketOrderFillFromExecution(execution, result);
                      if (fill.ok) {
                        playTradeFill();
                        setHistoryRows(
                          updateTradeHistoryRow(optimistic.id, {
                            status: fill.rowStatus,
                            submittedPrice01: execution?.submitted_price_01 ?? null,
                            fillAvgPrice01: fill.avg01,
                            price01: fill.avg01,
                            shares: fill.shares,
                            remainingShares: Math.max(0, sizeLive - fill.shares),
                            usdCents: Math.abs(Math.round(fill.avg01 * fill.shares * 100)),
                            orderId: oid ?? undefined,
                            roundTripMs: rt,
                            error: undefined,
                          }),
                        );
                        pushToast('ok', `Sold ${fill.shares.toFixed(4)} sh @ ${(fill.avg01 * 100).toFixed(2)}¢ (${fill.rowStatus})`);
                        setOkMsg(`Market sell-all ${fill.rowStatus} · avg ${(fill.avg01 * 100).toFixed(2)}¢ · ack ${rt}ms`);
                        scheduleTruthRefreshBurst(token, oid ?? null);
                      } else {
                        setHistoryRows(
                          updateTradeHistoryRow(optimistic.id, {
                            status: 'sent',
                            submittedPrice01: execution?.submitted_price_01 ?? null,
                            orderId: fill.orderId ?? oid ?? undefined,
                            roundTripMs: rt,
                            error: undefined,
                          }),
                        );
                        setOkMsg(`Market sell-all sent · ack ${rt}ms — reconciling…`);
                        scheduleTruthRefreshBurst(token, fill.orderId ?? oid ?? null);
                      }
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
          </div>
        </>
      )}

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

      {/* Polymarket-style cards */}
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
                {accountMode === 'live' ? openOrders.length : paperRestingForToken.length} open
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
                {accountMode === 'live' ? openOrders.length : paperRestingForToken.length}
              </span>
            </summary>
            <div className="px-4 pb-4">
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
                                const r = await tradeCancelOrder(id);
                                if (!isOk(r)) {
                                  const e = r as ApiErr;
                                  pushToast('err', `${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
                                } else {
                                  pushToast('ok', 'Cancel sent.');
                                  void refreshOpenOrders();
                                }
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
                      : { text: 'FILLED', cls: 'border-emerald-800/30 bg-emerald-950/15 text-emerald-200/90' };
                  const px = r.fillAvgPrice01 ?? r.price01;
                  const filled = r.shares;
                  const req = (r as any).requestedShares as number | null | undefined;
                  const rem = (r as any).remainingShares as number | null | undefined;
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
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-zinc-300">
                            <span>
                              {filled == null ? '—' : filled.toFixed(4)}
                              {req != null ? ` / ${Number(req).toFixed(4)}` : ''}{rem != null ? ` · rem ${Number(rem).toFixed(4)}` : ''}
                              {' '}sh
                            </span>
                            <span>
                              avg {px == null ? '—' : `${(px * 100).toFixed(2)}¢`}
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
                          {r.submittedPrice01 != null ? `sent ${(r.submittedPrice01 * 100).toFixed(1)}¢` : 'sent —'}
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
              : balUp != null
                ? balUp
                : null;
          const downSh =
            accountMode === 'paper'
              ? paperDownPos.shares
              : balDown != null
                ? balDown
                : null;
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
          const selAvg = tabLane === 'up' ? upAvg : downAvg;
          const selPx = tabLane === 'up' ? upPx : downPx;
          const selVal = selSh != null && selPx != null ? Math.round(selSh * selPx * 100) : null;
          const selMax = selSh != null && selSh > 0 ? selSh : 0;

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
                  disabled={busySubmit || busyRefresh || selSh == null || !(selSh > 0)}
                  onClick={async () => {
                    chooseAction('sell');
                    await runMarketSell(selSh ?? 0);
                  }}
                  className="mt-3 min-h-[46px] w-full rounded-xl bg-zinc-100 px-4 text-sm font-black text-black hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Close Position (Sell All {selSh != null ? `${selSh.toFixed(2)} sh` : ''})
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
                                  {(r.fillAvgPrice01 ?? r.submittedPrice01 ?? r.price01) == null
                                    ? '—'
                                    : `${(((r.fillAvgPrice01 ?? r.submittedPrice01 ?? r.price01) as number) * 100).toFixed(1)}¢`}
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
                                ) : (
                                  <span className="ml-2 rounded-full border border-emerald-800/30 bg-emerald-950/15 px-2 py-0.5 text-[9px] font-black text-emerald-200/90">
                                    FILLED
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 font-mono text-[11px] text-zinc-400">
                                {(r.shares ?? 0).toFixed(4)}
                                {(r as any).requestedShares != null ? ` / ${Number((r as any).requestedShares).toFixed(4)}` : ''}{' '}
                                @{' '}
                                {(r.fillAvgPrice01 ?? r.price01) == null
                                  ? '—'
                                  : `${((r.fillAvgPrice01 ?? r.price01)! * 100).toFixed(1)}¢`}
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
