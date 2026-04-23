import { type ReactElement, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ApiErr } from './lib/api';
import {
  tradeAvgEntry,
  tradeBalanceAllowance,
  tradeCancelAllOrders,
  tradeCancelOrder,
  tradeCreateOrderWithOpts,
  tradeGetOrder,
  tradeMarketOrderWithOpts,
  tradeUpdateBalanceAllowance,
} from './lib/api';
import { TradeSegmentedControl } from './tradeUi';
import { addPaperOrder, getPaperPosition, loadPaperAccount, markToMarket, matchPaperOrders, paperTrade, resetPaperAccount } from './paperTrading';
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
import { bestEffortMarketFill } from './marketOrderFill';
import { parseRestingOrderSnapshot } from './orderStatusParse';
import { floorShares4, roundPrice01, roundShares4, roundUsd2 } from './tradingRound';
import { extractOrderIdFromClobPayload, unwrapTradeActionData } from './tradeExecutionMeta';

function isOk<T>(res: { ok: boolean } & Record<string, unknown>): res is { ok: true; data: T } {
  return res.ok === true;
}

function parseUsdcBalance(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return roundUsd2(n);
}

/** Conservative 4dp floor so max-sell never exceeds wallet conditional balance. */
function parseOutcomeSharesBalance(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return floorShares4(n);
}

function fmtCents(p01: number | null): string {
  return p01 == null ? '—' : `${(p01 * 100).toFixed(1)}¢`;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
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

/** Polymarket rejects market BUY when notional is under $1 (e.g. shares × mid = $0.9988). */
const LIVE_MARKET_MIN_BUY_USD = 1;

function resolveLiveMarketBuyUsdc(
  unit: 'dollars' | 'shares',
  amtNum: number,
  mid: number | null,
):
  | { ok: true; usd: number; raw: number; minAdjusted: boolean }
  | { ok: false; raw: number; hint: string } {
  const rawUnrounded = unit === 'dollars' ? amtNum : mid != null && mid > 0 ? amtNum * mid : NaN;
  const raw = Number.isFinite(rawUnrounded) ? roundUsd2(rawUnrounded as number) : rawUnrounded;
  if (!Number.isFinite(raw) || raw <= 0) {
    return {
      ok: false,
      raw,
      hint:
        unit === 'shares' && (mid == null || mid <= 0)
          ? 'Need a valid price per share for this size (wait for the book or chart to load), or switch to $ and enter dollars.'
          : 'Enter a valid amount.',
    };
  }
  if (raw >= LIVE_MARKET_MIN_BUY_USD - 0.005) {
    return { ok: true, usd: raw, raw: rawUnrounded as number, minAdjusted: false };
  }
  const bumped = Math.ceil(raw * 100) / 100;
  if (bumped >= LIVE_MARKET_MIN_BUY_USD - 0.005) {
    return { ok: true, usd: bumped, raw: rawUnrounded as number, minAdjusted: true };
  }
  return {
    ok: false,
    raw,
    hint: `Live market buys need at least $${LIVE_MARKET_MIN_BUY_USD.toFixed(2)} notional. At this price, your size is about $${raw.toFixed(2)}. Increase size or use Limit.`,
  };
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
    slopeUsdPerSec: number;
  } | null;
  lane?: 'up' | 'down';
  onLaneChange?: (lane: 'up' | 'down') => void;
  visualStyle?: 'default' | 'sidebar' | 'slide';
};

/**
 * Signals tab: order entry (buy/sell, market/limit, amounts) against Polymarket CLOB via API.
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
  const [execMode, setExecMode] = useState<'touch' | 'market' | 'limit'>('touch');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [unit, setUnit] = useState<'dollars' | 'shares'>('dollars');
  const [accountMode, setAccountMode] = useState<'paper' | 'live'>('paper');
  const [paperAccount, setPaperAccount] = useState(() => loadPaperAccount());
  const [historyRows, setHistoryRows] = useState<TradeHistoryRow[]>(() => loadTradeHistory());

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
  const [sellNowShares, setSellNowShares] = useState('5');
  const [sellAskCents, setSellAskCents] = useState('');

  const [busySubmit, setBusySubmit] = useState(false);
  const [busyRefresh, setBusyRefresh] = useState(false);
  const [submitAbort, setSubmitAbort] = useState<AbortController | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [availUsdc, setAvailUsdc] = useState<number | null>(null);
  const [balUp, setBalUp] = useState<number | null>(null);
  const [balDown, setBalDown] = useState<number | null>(null);
  const [balLoading, setBalLoading] = useState(false);
  const [balError, setBalError] = useState<string | null>(null);
  const [avgEntryUp, setAvgEntryUp] = useState<number | null>(null);
  const [avgEntryDown, setAvgEntryDown] = useState<number | null>(null);
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
  /** Live: book mid first (matches CLOB); paper: chart first. */
  const mid = useMemo(() => {
    const chart = lane === 'up' ? upMid : downMid;
    const book = lane === 'up' ? (bookMidUp ?? null) : (bookMidDown ?? null);
    const c = chart != null && Number.isFinite(chart) && chart > 0 ? chart : null;
    const b = book != null && Number.isFinite(book) && book > 0 ? book : null;
    if (accountMode === 'live') return b ?? c;
    return c ?? b;
  }, [lane, upMid, downMid, bookMidUp, bookMidDown, accountMode]);

  const livePositionShares = lane === 'up' ? balUp : balDown;
  const liveAvgEntry = lane === 'up' ? avgEntryUp : avgEntryDown;
  const paperPos = useMemo(() => getPaperPosition(paperAccount, token), [paperAccount, token]);
  const paperUpPos = useMemo(() => getPaperPosition(paperAccount, upToken), [paperAccount, upToken]);
  const paperDownPos = useMemo(() => getPaperPosition(paperAccount, downToken), [paperAccount, downToken]);
  const paperMtm = useMemo(() => markToMarket({ account: paperAccount, tokenId: token, mid01: mid }), [paperAccount, token, mid]);

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
    return mid != null && mid > 0 ? roundPrice01(mid) : null;
  }, [action, bookTouch?.bestAsk, bookTouch?.bestBid, mid]);

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
      setHistoryRows(loadTradeHistory());
    };
    window.addEventListener(PAPER_ACCOUNT_SYNC_EVENT, onSync);
    return () => window.removeEventListener(PAPER_ACCOUNT_SYNC_EVENT, onSync);
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

  const positionShares = accountMode === 'paper' ? paperPos.shares : livePositionShares;
  const avgEntry = accountMode === 'paper' ? paperPos.avgCost01 : liveAvgEntry;

  const midCents = mid != null ? mid * 100 : null;
  const defaultLimitCents = useMemo(() => {
    if (midCents == null) return '';
    if (action === 'buy') {
      const c = Math.min(99, Math.max(1, midCents + 0.5));
      return String(Math.round(c));
    }
    const c = Math.max(1, Math.min(99, midCents - 0.5));
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
          tradeBalanceAllowance({ tokenId: upToken, assetType: 'conditional' }),
          tradeBalanceAllowance({ tokenId: downToken, assetType: 'conditional' }),
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
    void (async () => {
      try {
        const [u, d] = await Promise.all([tradeAvgEntry(upToken), tradeAvgEntry(downToken)]);
        if (isOk(u)) setAvgEntryUp(u.data.avgEntry);
        else setAvgEntryUp(null);
        if (isOk(d)) setAvgEntryDown(d.data.avgEntry);
        else setAvgEntryDown(null);
      } catch {
        setAvgEntryUp(null);
        setAvgEntryDown(null);
      }
    })();
  }, [accountMode, upToken, downToken]);

  useEffect(() => {
    refreshAvgEntry();
  }, [refreshAvgEntry]);

  const chooseAction = useCallback((a: 'buy' | 'sell') => {
    setAction(a);
    setErr(null);
    setOkMsg(null);
    if (a === 'sell') {
      setUnit('shares');
      setSellQty('');
    }
  }, []);

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

  const pollRestingOrderFill = useCallback(
    (rowId: string, orderId: string, submittedSize: number, submittedPrice01: number, quotedPrice01: number | null) => {
      const myGen = liveSubmitGenRef.current;
      const started = performance.now();
      const tick = async () => {
        if (myGen !== liveSubmitGenRef.current) return;
        const res = await tradeGetOrder(orderId);
        if (myGen !== liveSubmitGenRef.current) return;
        if (!isOk(res)) {
          if (performance.now() - started < 28_000) window.setTimeout(tick, 500);
          return;
        }
        const p = parseRestingOrderSnapshot(res.data);
        const matched = p.matchedShares ?? 0;
        const orig = p.originalShares ?? submittedSize;
        const fullyFilled = orig > 0 ? matched >= orig - 1e-4 : matched > 0;

        if (p.isCancelled) {
          updateTradeHistoryRow(rowId, {
            status: 'cancelled',
            auditNote: p.statusRaw ? `cancelled:${p.statusRaw}` : 'cancelled',
          });
          setHistoryRows(loadTradeHistory());
          return;
        }

        const fillPx = p.avgPrice01 ?? submittedPrice01;
        if (fullyFilled && fillPx != null && fillPx > 0) {
          const sh = matched > 0 ? matched : submittedSize;
          const note = priceAuditNote(quotedPrice01, submittedPrice01, p.avgPrice01);
          updateTradeHistoryRow(rowId, {
            status: 'filled',
            fillAvgPrice01: p.avgPrice01 ?? submittedPrice01,
            submittedPrice01,
            quotedPrice01: quotedPrice01 ?? undefined,
            price01: fillPx,
            shares: sh,
            usdCents: Math.abs(Math.round(fillPx * sh * 100)),
            roundTripMs: Math.round(performance.now() - started),
            auditNote: note,
          });
          setHistoryRows(loadTradeHistory());
          void refreshAvgEntry();
          void refreshPositionAndMaxSell();
          return;
        }

        if (performance.now() - started < 28_000) {
          window.setTimeout(tick, 450);
          return;
        }

        if (matched < 1e-6) {
          updateTradeHistoryRow(rowId, {
            status: 'no_fill',
            auditNote: 'watch_timeout_no_match',
          });
        } else {
          updateTradeHistoryRow(rowId, {
            status: 'partial',
            fillAvgPrice01: p.avgPrice01,
            shares: matched,
            price01: p.avgPrice01,
            usdCents: p.avgPrice01 != null ? Math.abs(Math.round(p.avgPrice01 * matched * 100)) : null,
            auditNote: 'watch_timeout_partial',
          });
        }
        setHistoryRows(loadTradeHistory());
      };
      window.setTimeout(tick, 380);
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

  const amtNum = Number(amount);
  const amtOk = Number.isFinite(amtNum) && amtNum > 0;
  const estShares =
    mid != null && amtOk ? (unit === 'dollars' ? amtNum / Math.max(1e-9, mid) : amtNum) : null;
  const estCost =
    mid != null && estShares != null ? (unit === 'dollars' ? amtNum : estShares * mid) : unit === 'dollars' && amtOk ? amtNum : null;
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

  const maxBuyDisabledReason =
    unit === 'shares' && (mid == null || mid <= 0)
      ? 'Need a valid mid to convert USDC to shares for Max'
      : undefined;

  const liveMarketBuyUsdc = useMemo(() => {
    if (accountMode !== 'live' || action !== 'buy' || execMode !== 'market' || !amtOk) return null;
    return resolveLiveMarketBuyUsdc(unit, amtNum, mid);
  }, [accountMode, action, execMode, amtOk, unit, amtNum, mid]);

  const passiveLadder = useMemo(() => {
    if (action !== 'buy') return null;
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
  }, [action, passiveChunks, passiveLevels, passiveTargetCents, passiveTotalShares]);

  const runMarketSell = async (shares: number) => {
    if (!Number.isFinite(shares) || shares <= 0) return;
    if (!token?.trim()) {
      setErr('Outcome token is not ready yet — wait for this market to finish loading, then retry.');
      return;
    }
    if (accountMode === 'paper') {
      const res = paperTrade({ account: paperAccount, tokenId: token, side: 'sell', shares, price01: mid });
      if (!res.ok) {
        setErr(res.error);
      } else {
        setPaperAccount(res.account);
        setOkMsg(`Paper sold ${shares.toFixed(2)} shares of ${label}`);
        setHistoryRows(
          appendTradeHistory({ ...tradeHistoryMarketMeta,
            mode: 'paper',
            exec: execMode,
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
    liveSubmitGenRef.current += 1;
    const quoted01 = executableQuote01;
    const mark01 = mid != null && mid > 0 ? roundPrice01(mid) : null;
    const optimistic = appendTradeHistoryWithId({ ...tradeHistoryMarketMeta,
      mode: 'live',
      exec: 'market',
      side: 'sell',
      token,
      label,
      price01: quoted01,
      quotedPrice01: quoted01,
      submittedPrice01: null,
      fillAvgPrice01: null,
      markPrice01: mark01,
      shares: sellAmt,
      usdCents: null,
      status: 'sending',
    });
    setHistoryRows(optimistic.rows);
    const controller = new AbortController();
    setSubmitAbort(controller);
    const tClient0 = performance.now();
    const res = await tradeMarketOrderWithOpts(
      { token, side: 'sell', amount: sellAmt, signatureType: null },
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
      const fill = bestEffortMarketFill(result, { kind: 'sell', requestedShares: sellAmt, mid01: mid });
      const submitted01 = execution?.submitted_price_01 ?? null;
      const fillPx = fill.price01;
      const note = priceAuditNote(quoted01, submitted01, fillPx);
      const rt = mergeRoundTripMs(execution?.round_trip_ms, clientMs);
      setLastExecLatencyMs(rt);
      setHistoryRows(
        updateTradeHistoryRow(optimistic.id, {
          status: 'filled',
          submittedPrice01: submitted01 ?? undefined,
          fillAvgPrice01: fillPx ?? undefined,
          price01: fillPx ?? submitted01 ?? quoted01,
          shares: fill.shares ?? sellAmt,
          usdCents: fill.usdCents,
          roundTripMs: rt,
          orderId: execution?.order_id ?? undefined,
          auditNote: note,
          error: undefined,
        }),
      );
      const q = quoted01 != null ? `${(quoted01 * 100).toFixed(1)}¢` : '—';
      const s = submitted01 != null ? `${(submitted01 * 100).toFixed(1)}¢` : '—';
      const f = fillPx != null ? `${(fillPx * 100).toFixed(1)}¢` : '—';
      setOkMsg(`Sold ${(fill.shares ?? sellAmt).toFixed(2)} ${label} · quoted ${q} · sent ${s} · filled ${f} · ${rt}ms`);
      setSellQty('');
      void (async () => {
        const r = await tradeBalanceAllowance({ tokenId: token, assetType: 'conditional' });
        if (isOk(r)) {
          const sh = parseOutcomeSharesBalance(r.data.balance);
          if (token === upToken) setBalUp(sh);
          else if (token === downToken) setBalDown(sh);
        }
        refreshAvgEntry();
      })();
    }
    setSubmitAbort(null);
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
          <h1 className="text-lg font-semibold tracking-tight text-zinc-100">
            {isSlide ? 'Order' : isSidebarOnly ? 'Trade desk' : 'Trade'}
          </h1>
          {!isSlide ? (
            <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
              {isSidebarOnly
                ? 'Choose practice or live, pick a side, set how much, then confirm. Hover execution modes for a short explanation.'
                : 'Order type · outcome · size · review'}
            </p>
          ) : (
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              Smart limit (quick) is the default — chart stays visible. Advanced lets you switch to market or a custom limit.
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
            ) : null}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
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
        </div>
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
                    ? `${(paperUpPos.avgCost01 * 100).toFixed(1)}¢`
                    : avgEntryUp != null
                      ? `${(avgEntryUp * 100).toFixed(1)}¢`
                      : '—'
                } · mid ${fmtCents(midUpEff)}`}
              >
                @{' '}
                {accountMode === 'paper' && paperUpPos.avgCost01 != null && paperUpPos.avgCost01 > 0
                  ? `${(paperUpPos.avgCost01 * 100).toFixed(1)}¢`
                  : avgEntryUp != null
                    ? `${(avgEntryUp * 100).toFixed(1)}¢`
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
                    ? `${(paperDownPos.avgCost01 * 100).toFixed(1)}¢`
                    : avgEntryDown != null
                      ? `${(avgEntryDown * 100).toFixed(1)}¢`
                      : '—'
                } · mid ${fmtCents(midDownEff)}`}
              >
                @{' '}
                {accountMode === 'paper' && paperDownPos.avgCost01 != null && paperDownPos.avgCost01 > 0
                  ? `${(paperDownPos.avgCost01 * 100).toFixed(1)}¢`
                  : avgEntryDown != null
                    ? `${(avgEntryDown * 100).toFixed(1)}¢`
                    : '—'}{' '}
                · mid {fmtCents(midDownEff)}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Outcome */}
      <div className="mt-6">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Pick a side</div>
        {!isSlide ? (
          <p className="mt-1 text-[11px] text-zinc-600">Tap the outcome you want to trade — mid price updates as the book moves.</p>
        ) : (
          <p className="mt-1 text-[11px] text-zinc-600">Large prices — tap side, size, then Enter.</p>
        )}
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => chooseLane('up')}
            className={`rounded-xl border text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
              isSlide ? 'px-3 py-5' : 'px-4 py-3.5'
            } ${
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
              isSlide ? 'px-3 py-5' : 'px-4 py-3.5'
            } ${
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
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                  Execution ·{' '}
                  <span className="text-zinc-300">
                    {execMode === 'touch' ? 'Quick' : execMode === 'market' ? 'Market' : 'Limit'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="min-h-[36px] rounded-lg border border-zinc-700/60 bg-black/20 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-black/30"
                >
                  {showAdvanced ? 'Hide advanced' : 'Advanced'}
                </button>
              </div>
              {showAdvanced ? (
                <div className="mt-2 space-y-2 rounded-xl border border-zinc-800/60 bg-zinc-950/30 px-3 py-3">
                  <TradeSegmentedControl
                    value={execMode}
                    onChange={(v) => {
                      setExecMode(v as 'touch' | 'market' | 'limit');
                      setErr(null);
                      setOkMsg(null);
                      if (v === 'touch' && touchLimitCents) setLimitPriceCents(touchLimitCents);
                      else if (v === 'limit' && defaultLimitCents) setLimitPriceCents(defaultLimitCents);
                    }}
                    options={[
                      { value: 'touch', label: 'Quick', title: 'Places a limit very close to the current price — best for fast clicks' },
                      { value: 'market', label: 'Market', title: 'Fill immediately at the best prices in the book right now' },
                      { value: 'limit', label: 'Limit', title: 'You set the price; the order waits until the market comes to you' },
                    ]}
                  />
                  <p className="text-[11px] leading-relaxed text-zinc-500">
                    {execMode === 'touch'
                      ? 'Quick: tight limit around the mid — low fuss, good default.'
                      : execMode === 'market'
                        ? 'Market: trade now; final price depends on book depth.'
                        : 'Limit: your price; may take time to fill.'}
                  </p>
                </div>
              ) : null}
            </div>
          ) : (
            <details className="mt-4 rounded-xl border border-zinc-800/60 bg-zinc-950/30">
              <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-zinc-400 hover:text-zinc-300">
                Advanced · market or custom limit
              </summary>
              <div className="border-t border-zinc-800/50 px-3 py-3">
                <TradeSegmentedControl
                  value={execMode}
                  onChange={(v) => {
                    setExecMode(v as 'touch' | 'market' | 'limit');
                    setErr(null);
                    setOkMsg(null);
                    if (v === 'touch' && touchLimitCents) setLimitPriceCents(touchLimitCents);
                    else if (v === 'limit' && defaultLimitCents) setLimitPriceCents(defaultLimitCents);
                  }}
                  options={[
                    { value: 'touch', label: 'Smart limit', title: 'Tight limit near mid (default)' },
                    { value: 'market', label: 'Market', title: 'Fill at best available now' },
                    { value: 'limit', label: 'Limit', title: 'Your price' },
                  ]}
                />
              </div>
            </details>
          )}

          {isSlide || showAdvanced ? (
          <details className="mt-4 rounded-xl border border-zinc-800/60 bg-zinc-950/30">
            <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-zinc-400 hover:text-zinc-300">
              Advanced entry tools · order book + passive ladder
            </summary>
            <div className="border-t border-zinc-800/50 px-3 py-3">
          <div className="mt-4 space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Entry mode</div>
            <TradeSegmentedControl
              value={buyEntryMode}
              onChange={(v) => {
                setBuyEntryMode(v as 'single' | 'passive');
                setErr(null);
                setOkMsg(null);
              }}
              options={[
                { value: 'single', label: 'Single', title: 'One order: quick/manual sizing' },
                { value: 'passive', label: 'Passive ladder', title: 'Many small limit bids across 1–3 levels (no chasing)' },
              ]}
            />
            <div className="mt-3 rounded-xl border border-zinc-800/70 bg-zinc-950/25 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Buy from the order book (simple)</div>
              <div className="mt-2 text-[11px] leading-relaxed text-zinc-400">
                Click <span className="font-semibold text-zinc-200">Buy now</span> on a price level to take that liquidity at that exact price.
                If it doesn’t fill quickly, it auto-cancels so you don’t accidentally leave resting orders.
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                <span className="rounded-lg border border-zinc-800/60 bg-black/20 px-2 py-1 font-mono">
                  Best bid {bookTouch?.bestBid != null ? `${(bookTouch.bestBid * 100).toFixed(1)}¢` : '—'}
                </span>
                <span className="rounded-lg border border-zinc-800/60 bg-black/20 px-2 py-1 font-mono">
                  Best ask {bookTouch?.bestAsk != null ? `${(bookTouch.bestAsk * 100).toFixed(1)}¢` : '—'}
                </span>
                <span className="rounded-lg border border-zinc-800/60 bg-black/20 px-2 py-1 font-mono">
                  Spread{' '}
                  {bookTouch?.bestBid != null && bookTouch?.bestAsk != null
                    ? `${Math.max(0, Math.round((bookTouch.bestAsk - bookTouch.bestBid) * 1000) / 10).toFixed(1)}¢`
                    : '—'}
                </span>
              </div>
              <div className="mt-2 text-[11px] text-zinc-500">
                You can also type shares in <span className="font-mono text-zinc-200">Take</span> first.
              </div>

              <div className="mt-3 rounded-xl border border-zinc-800/60 bg-black/20 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">1-click buy</div>
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

                        const res = await tradeCreateOrderWithOpts(
                          { token, side: 'buy', price: bestAsk, size: sharesReq, signatureType: null },
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
                            price01: bestAsk,
                            shares: sharesReq,
                            usdCents: Math.abs(Math.round(bestAsk * sharesReq * 100)),
                            status: 'sent',
                            orderId: oid ?? null,
                          }),
                        );
                        if (oid) {
                          window.setTimeout(() => {
                            void tradeCancelOrder(oid);
                          }, cancelMs);
                        }
                        setOkMsg(`Buy best ask sent ${sharesReq.toFixed(2)} ${label} @ ${(bestAsk * 100).toFixed(1)}¢`);
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

                        const res = await tradeCreateOrderWithOpts(
                          { token, side: 'buy', price: px01, size: sharesReq, signatureType: null },
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
                            price01: px01,
                            shares: sharesReq,
                            usdCents: Math.abs(Math.round(px01 * sharesReq * 100)),
                            status: 'sent',
                            orderId: oid ?? null,
                          }),
                        );
                        setOkMsg(`Bid placed: buy ${sharesReq.toFixed(2)} ${label} @ ${(px01 * 100).toFixed(1)}¢ (waiting)`);
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
                                { token, side: 'buy', price: l.price, size: takeNum, signatureType: null },
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

                <div className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                  Places multiple small <span className="font-semibold text-zinc-300">limit buys</span> at your bid levels and waits for sellers to hit them
                  (no chasing upward).
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="text-[11px] text-zinc-400">
                    {passiveLadder
                      ? `~${passiveLadder.perChunkShares.toFixed(2)} sh × ${passiveLadder.chunks} orders`
                      : 'Enter valid ladder params'}
                  </div>
                  <button
                    type="button"
                    disabled={busySubmit || passiveLadder == null || !token?.trim() || accountMode === 'live' && execMode === 'market'}
                    className="rounded-xl border border-emerald-800/45 bg-emerald-950/25 px-4 py-2 text-[12px] font-bold text-emerald-100 hover:bg-emerald-950/35 disabled:cursor-not-allowed disabled:opacity-40"
                    title={execMode === 'market' ? 'Passive ladder uses resting limit orders (switch off Market).' : 'Place multiple small limit bids.'}
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
                        // Passive ladder always uses limit style (resting bids).
                        setExecMode('limit');
                        const created: { price01: number; shares: number; id?: string }[] = [];
                        if (accountMode === 'paper') {
                          for (const leg of passiveLadder.plan) {
                            const o = addPaperOrder({ tokenId: token, side: 'buy', limit01: leg.price01, shares: leg.shares });
                            created.push({ price01: leg.price01, shares: leg.shares, id: o.id });
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
                                price01: leg.price01,
                                shares: leg.shares,
                                usdCents: Math.abs(Math.round(leg.price01 * leg.shares * 100)),
                                status: 'sent',
                              }),
                            );
                          }
                          setOkMsg(`Paper ladder placed: ${created.length} bids around ${passiveLadder.targetCents}¢`);
                          return;
                        }

                        // Live: place multiple small GTC limit orders (resting).
                        for (const leg of passiveLadder.plan) {
                          const res = await tradeCreateOrderWithOpts(
                            { token, side: 'buy', price: leg.price01, size: leg.shares, signatureType: null },
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
                              side: 'buy',
                              token,
                              label,
                              price01: leg.price01,
                              shares: leg.shares,
                              usdCents: Math.abs(Math.round(leg.price01 * leg.shares * 100)),
                              status: 'sent',
                            }),
                          );
                        }
                        if (created.length > 0) setOkMsg(`Ladder placed: ${created.length} resting bids around ${passiveLadder.targetCents}¢`);
                      } finally {
                        setBusySubmit(false);
                        submitLockRef.current = false;
                      }
                    }}
                  >
                    Place ladder bids
                  </button>
                </div>
              </div>
            ) : null}
          </div>
            </div>
          </div>
        </details>
          ) : null}

          <div className="mt-2 flex flex-wrap items-end justify-between gap-2 text-xs text-zinc-400">
            <span className="font-semibold text-zinc-300">How much</span>
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
                (unit === 'shares' && (mid == null || mid <= 0))
              }
              aria-busy={busySubmit || busyRefresh}
              title={maxBuyDisabledReason}
              className="min-h-[40px] rounded-lg border border-zinc-600/80 bg-zinc-900/60 px-4 py-2 text-xs font-semibold text-zinc-100 hover:bg-zinc-800/80 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Max
            </button>
          </div>

          {execMode !== 'market' ? (
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
            </div>
          ) : null}

          <div className="mt-4 rounded-xl border border-zinc-800/70 bg-black/20 p-3 text-sm text-zinc-300">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Order summary</div>
            <div className="mt-2 flex items-center justify-between">
              <div className="text-zinc-500">Price / share</div>
              <div className="font-mono tabular-nums">{fmtCents(mid)}</div>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="text-zinc-500">Est. shares</div>
              <div className="font-mono tabular-nums">{estShares == null ? '—' : estShares.toFixed(2)}</div>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="text-zinc-500">Cost</div>
              <div className="font-mono tabular-nums">{estCost == null ? '—' : `$${estCost.toFixed(2)}`}</div>
            </div>
            {liveMarketBuyUsdc?.ok === true && liveMarketBuyUsdc.minAdjusted ? (
              <p className="mt-2 rounded-lg border border-amber-800/30 bg-amber-950/15 px-2 py-1.5 text-[11px] leading-relaxed text-amber-100/90">
                Live <span className="font-medium">Market</span> buy: notional was just under $1, so the request is rounded up to{' '}
                <span className="font-mono font-semibold">${liveMarketBuyUsdc.usd.toFixed(2)}</span> (exchange minimum).
              </p>
            ) : null}
            {liveMarketBuyUsdc?.ok === false ? (
              <p className="mt-2 rounded-lg border border-rose-900/35 bg-rose-950/15 px-2 py-1.5 text-[11px] leading-relaxed text-rose-100/90">
                {liveMarketBuyUsdc.hint}
              </p>
            ) : null}
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
                    title={`Spot vs PTB context\nPTB ${ptbContext.ptbUsd.toFixed(2)}\nBand ±$${ptbContext.bandUsd.toFixed(2)}\nPosition ${ptbContext.position}\nSlope ${ptbContext.slopeUsdPerSec >= 0 ? '+' : ''}${ptbContext.slopeUsdPerSec.toFixed(5)}/s`}
                  >
                    PTB {ptbContext.position}
                  </div>
                ) : null}
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-emerald-800/45 bg-emerald-950/20 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-200/80">{targets.sideLabel}</div>
                  <div className="mt-1 font-mono text-lg font-black tabular-nums text-emerald-100">{targets.tpCents}¢</div>
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
                </div>
                <div className="rounded-lg border border-rose-800/40 bg-rose-950/15 px-3 py-2">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-rose-200/80">Stop / invalidation</div>
                  <div className="mt-1 font-mono text-lg font-black tabular-nums text-rose-100">{targets.stopCents}¢</div>
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
                </div>
              </div>
            </div>
          ) : null}

          <button
            type="button"
            disabled={
              busySubmit ||
              !amtOk ||
              (execMode !== 'market' && (limit01 == null || !Number.isFinite(limit01))) ||
              (liveMarketBuyUsdc != null && !liveMarketBuyUsdc.ok)
            }
            aria-busy={busySubmit}
            className={`mt-4 min-h-[52px] w-full rounded-xl bg-emerald-400 px-4 py-3 text-sm font-bold text-black shadow-lg shadow-emerald-950/30 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40 ${
              isSlide ? 'inline-flex items-center justify-center gap-2' : ''
            }`}
            onClick={async () => {
              if (submitLockRef.current) return;
              submitLockRef.current = true;
              playTradeClick();
              setErr(null);
              setOkMsg(null);
              setBusySubmit(true);
              try {
                if (accountMode === 'paper') {
                  const px = execMode === 'market' ? mid : limit01;
                  const shares = unit === 'shares' ? amtNum : px != null && px > 0 ? amtNum / px : NaN;
                  if (execMode === 'market') {
                    const r = paperTrade({ account: paperAccount, tokenId: token, side: 'buy', shares, price01: px });
                    if (!r.ok) {
                      setErr(r.error);
                      setHistoryRows(
                        appendTradeHistory({ ...tradeHistoryMarketMeta,
                          mode: 'paper',
                          exec: execMode,
                          side: 'buy',
                          token,
                          label,
                          price01: px ?? null,
                          shares: Number.isFinite(shares) ? shares : null,
                          usdCents: null,
                          status: 'error',
                          error: r.error,
                        }),
                      );
                    } else {
                      setPaperAccount(r.account);
                      setOkMsg(`Paper bought ${shares.toFixed(2)} sh of ${label} @ ${(px! * 100).toFixed(1)}¢`);
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
                  }
                  return;
                }
                if (execMode === 'market') {
                  if (!token?.trim()) {
                    setErr('Outcome token is not ready yet — wait for this market to finish loading, then retry.');
                    return;
                  }
                  const resolved = resolveLiveMarketBuyUsdc(unit, amtNum, mid);
                  if (!resolved.ok) {
                    setErr(resolved.hint);
                    return;
                  }
                  liveSubmitGenRef.current += 1;
                  const amountUsd = resolved.usd;
                  const quoted01 = executableQuote01;
                  const mark01 = mid != null && mid > 0 ? roundPrice01(mid) : null;
                  const optimistic = appendTradeHistoryWithId({ ...tradeHistoryMarketMeta,
                    mode: 'live',
                    exec: 'market',
                    side: 'buy',
                    token,
                    label,
                    price01: quoted01,
                    quotedPrice01: quoted01,
                    submittedPrice01: null,
                    fillAvgPrice01: null,
                    markPrice01: mark01,
                    shares: unit === 'shares' && Number.isFinite(amtNum) ? roundShares4(amtNum) : null,
                    usdCents: Math.abs(Math.round(amountUsd * 100)),
                    status: 'sending',
                  });
                  setHistoryRows(optimistic.rows);
                  const controller = new AbortController();
                  setSubmitAbort(controller);
                  const tClient0 = performance.now();
                  const res = await tradeMarketOrderWithOpts(
                    { token, side: 'buy', amount: amountUsd, signatureType: null },
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
                    const fill = bestEffortMarketFill(result, {
                      kind: 'buy',
                      amountUsd,
                      mid01: mid,
                      requestedShares: unit === 'shares' && Number.isFinite(amtNum) ? roundShares4(amtNum) : null,
                    });
                    const submitted01 = execution?.submitted_price_01 ?? null;
                    const fillPx = fill.price01;
                    const note = priceAuditNote(quoted01, submitted01, fillPx);
                    const rt = mergeRoundTripMs(execution?.round_trip_ms, clientMs);
                    setLastExecLatencyMs(rt);
                    setHistoryRows(
                      updateTradeHistoryRow(optimistic.id, {
                        status: 'filled',
                        submittedPrice01: submitted01 ?? undefined,
                        fillAvgPrice01: fillPx ?? undefined,
                        price01: fillPx ?? submitted01 ?? quoted01,
                        shares: fill.shares,
                        usdCents: fill.usdCents ?? Math.abs(Math.round(amountUsd * 100)),
                        roundTripMs: rt,
                        orderId: execution?.order_id ?? undefined,
                        auditNote: note,
                        error: undefined,
                      }),
                    );
                    const q = quoted01 != null ? `${(quoted01 * 100).toFixed(1)}¢` : '—';
                    const s = submitted01 != null ? `${(submitted01 * 100).toFixed(1)}¢` : '—';
                    const f = fillPx != null ? `${(fillPx * 100).toFixed(1)}¢` : '—';
                    setOkMsg(
                      `${resolved.minAdjusted ? `Bought ~$${amountUsd.toFixed(2)} of ${label} (min $${LIVE_MARKET_MIN_BUY_USD})` : `Bought ~$${amountUsd.toFixed(2)} of ${label}`} · quoted ${q} · sent ${s} · filled ${f} · ${rt}ms`,
                    );
                    void refreshAvgEntry();
                  }
                } else {
                  if (!token?.trim()) {
                    setErr('Outcome token is not ready yet — wait for this market to finish loading, then retry.');
                    return;
                  }
                  const price = limit01 ?? NaN;
                  const sizeSharesRaw = unit === 'shares' ? amtNum : price > 0 ? amtNum / price : NaN;
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
                    submittedPrice01: null,
                    fillAvgPrice01: null,
                    markPrice01: mark01,
                    shares: sizeShares,
                    usdCents: Number.isFinite(price) ? Math.abs(Math.round(price * sizeShares * 100)) : null,
                    status: 'sending',
                  });
                  setHistoryRows(optimistic.rows);
                  const controller = new AbortController();
                  setSubmitAbort(controller);
                  const tClient0 = performance.now();
                  const res = await tradeCreateOrderWithOpts(
                    { token, side: 'buy', price, size: sizeShares, signatureType: null },
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
                    const sub = execution?.submitted_price_01 ?? price;
                    const rt = mergeRoundTripMs(execution?.round_trip_ms, clientMs);
                    setLastExecLatencyMs(rt);
                    setHistoryRows(
                      updateTradeHistoryRow(optimistic.id, {
                        status: 'sent',
                        submittedPrice01: sub,
                        orderId: oid ?? undefined,
                        roundTripMs: rt,
                        price01: quoted01,
                        error: undefined,
                      }),
                    );
                    if (oid) pollRestingOrderFill(optimistic.id, oid, sizeShares, sub, quoted01);
                    setOkMsg(
                      `${execMode === 'touch' ? 'Quick' : 'Limit'} buy sent ${sizeShares.toFixed(2)} ${label} @ ${(price * 100).toFixed(1)}¢ · ack ${rt}ms — watching fill`,
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
                {isSlide ? 'SENDING…' : 'Submitting…'}
              </>
            ) : (
              `Enter · Buy ${label}`
            )}
          </button>
        </>
      ) : (
        <>
          {!isSlide ? (
            <div className="mt-6 space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">How to execute</div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <TradeSegmentedControl
                  value={execMode}
                  onChange={(v) => {
                    setExecMode(v as 'touch' | 'market' | 'limit');
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
                    { value: 'market', label: 'Market', title: 'Sell now at the best bids available' },
                    { value: 'limit', label: 'Limit', title: 'You set the minimum price you are willing to accept' },
                  ]}
                />
                <p className="max-w-md text-[11px] leading-relaxed text-zinc-500">
                  {execMode === 'touch'
                    ? 'Quick: a tight limit around the mid for a fast, controlled exit.'
                    : execMode === 'market'
                      ? 'Market: sell the position immediately; price follows the book.'
                      : 'Limit: wait for the market to reach your price.'}
                </p>
              </div>
            </div>
          ) : (
            <details className="mt-4 rounded-xl border border-zinc-800/60 bg-zinc-950/30">
              <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-zinc-400 hover:text-zinc-300">
                Advanced · market or custom limit
              </summary>
              <div className="border-t border-zinc-800/50 px-3 py-3">
                <TradeSegmentedControl
                  value={execMode}
                  onChange={(v) => {
                    setExecMode(v as 'touch' | 'market' | 'limit');
                    setErr(null);
                    setOkMsg(null);
                    if (v === 'touch' && touchLimitCents) setLimitPriceCents(touchLimitCents);
                    else if (v === 'limit' && defaultLimitCents) setLimitPriceCents(defaultLimitCents);
                  }}
                  options={[
                    { value: 'touch', label: 'Smart limit', title: 'Tight limit near mid (default)' },
                    { value: 'market', label: 'Market', title: 'Sell at best bids now' },
                    { value: 'limit', label: 'Limit', title: 'Your minimum price' },
                  ]}
                />
              </div>
            </details>
          )}

          <div className="mt-4 rounded-xl border border-zinc-800/60 bg-black/20 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">1-click sell</div>
            <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-zinc-500">
              <span className="rounded-lg border border-zinc-800/60 bg-black/20 px-2 py-1 font-mono">
                Best bid {bookTouch?.bestBid != null ? `${(bookTouch.bestBid * 100).toFixed(1)}¢` : '—'}
              </span>
              <span className="rounded-lg border border-zinc-800/60 bg-black/20 px-2 py-1 font-mono">
                Best ask {bookTouch?.bestAsk != null ? `${(bookTouch.bestAsk * 100).toFixed(1)}¢` : '—'}
              </span>
            </div>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-800/70 bg-black/25 px-3 py-2">
                <span className="text-[11px] font-semibold text-zinc-400">Shares</span>
                <input
                  value={sellNowShares}
                  onChange={(e) => setSellNowShares(e.target.value)}
                  inputMode="decimal"
                  className="min-w-0 flex-1 bg-transparent text-right font-mono text-[13px] font-semibold text-zinc-100 outline-none"
                  placeholder="5"
                />
              </label>
              <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-zinc-800/70 bg-black/25 px-3 py-2">
                <span className="text-[11px] font-semibold text-zinc-400">Ask (¢)</span>
                <input
                  value={sellAskCents}
                  onChange={(e) => setSellAskCents(e.target.value)}
                  inputMode="decimal"
                  className="min-w-0 flex-1 bg-transparent text-right font-mono text-[13px] font-semibold text-zinc-100 outline-none"
                  placeholder="99.0"
                />
              </label>
              <div className="flex w-full flex-wrap gap-1.5 sm:w-auto">
                <button
                  type="button"
                  className="rounded-lg border border-zinc-700/60 bg-black/20 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-black/30"
                  disabled={bookTouch?.bestBid == null}
                  title="Set ask to best bid + 1¢"
                  onClick={() => {
                    if (bookTouch?.bestBid == null) return;
                    setSellAskCents(Math.max(1, Math.min(99, Math.round(bookTouch.bestBid * 100 + 1))).toFixed(0));
                  }}
                >
                  Bid+1¢
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-zinc-700/60 bg-black/20 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-black/30"
                  disabled={bookTouch?.bestBid == null}
                  title="Set ask to best bid + 2¢"
                  onClick={() => {
                    if (bookTouch?.bestBid == null) return;
                    setSellAskCents(Math.max(1, Math.min(99, Math.round(bookTouch.bestBid * 100 + 2))).toFixed(0));
                  }}
                >
                  Bid+2¢
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-zinc-700/60 bg-black/20 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-black/30"
                  disabled={bookTouch?.bestBid == null}
                  title="Set ask to best bid + 5¢"
                  onClick={() => {
                    if (bookTouch?.bestBid == null) return;
                    setSellAskCents(Math.max(1, Math.min(99, Math.round(bookTouch.bestBid * 100 + 5))).toFixed(0));
                  }}
                >
                  Bid+5¢
                </button>
              </div>
              <button
                type="button"
                disabled={
                  busySubmit ||
                  !token?.trim() ||
                  action !== 'sell' ||
                  bookTouch?.bestBid == null ||
                  !Number.isFinite(Number(sellNowShares)) ||
                  Number(sellNowShares) <= 0
                }
                className="min-h-[44px] rounded-xl bg-rose-500 px-4 text-[12px] font-bold text-black hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
                title="Sells at the current best bid level (exact price), then auto-cancels if not filled quickly."
                onClick={async () => {
                  if (submitLockRef.current) return;
                  submitLockRef.current = true;
                  setErr(null);
                  setOkMsg(null);
                  if (!token?.trim()) {
                    submitLockRef.current = false;
                    return;
                  }
                  const bestBid = bookTouch?.bestBid;
                  const sharesReq = Number(sellNowShares);
                  if (bestBid == null || !Number.isFinite(bestBid) || !Number.isFinite(sharesReq) || sharesReq <= 0) {
                    submitLockRef.current = false;
                    return;
                  }
                  const cancelMs = Math.max(250, Math.min(5000, Math.floor(Number(pickAutoCancelMs) || 1500)));
                  setBusySubmit(true);
                  try {
                    if (accountMode === 'paper') {
                      const r = paperTrade({ account: paperAccount, tokenId: token, side: 'sell', shares: sharesReq, price01: bestBid });
                      if (!r.ok) setErr(r.error);
                      else {
                        setPaperAccount(r.account);
                        setHistoryRows(
                          appendTradeHistory({
                            ...tradeHistoryMarketMeta,
                            mode: 'paper',
                            exec: 'limit',
                            side: 'sell',
                            token,
                            label,
                            price01: r.fill.price01,
                            shares: r.fill.shares,
                            usdCents: Math.abs(r.fill.usdCents),
                            status: 'filled',
                          }),
                        );
                        setOkMsg(`Sold ${r.fill.shares.toFixed(2)} ${label} @ ${(r.fill.price01 * 100).toFixed(1)}¢`);
                      }
                      return;
                    }

                    const res = await tradeCreateOrderWithOpts(
                      { token, side: 'sell', price: bestBid, size: sharesReq, signatureType: null },
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
                        side: 'sell',
                        token,
                        label,
                        price01: bestBid,
                        shares: sharesReq,
                        usdCents: Math.abs(Math.round(bestBid * sharesReq * 100)),
                        status: 'sent',
                        orderId: oid ?? null,
                      }),
                    );
                    if (oid) {
                      window.setTimeout(() => {
                        void tradeCancelOrder(oid);
                      }, cancelMs);
                    }
                    setOkMsg(`Sell best bid sent ${sharesReq.toFixed(2)} ${label} @ ${(bestBid * 100).toFixed(1)}¢`);
                  } finally {
                    setBusySubmit(false);
                    submitLockRef.current = false;
                  }
                }}
              >
                Sell best bid
              </button>
              <button
                type="button"
                disabled={
                  busySubmit ||
                  !token?.trim() ||
                  action !== 'sell' ||
                  !Number.isFinite(Number(sellNowShares)) ||
                  Number(sellNowShares) <= 0 ||
                  sellAskCents.trim() === '' ||
                  !Number.isFinite(Number(sellAskCents)) ||
                  Number(sellAskCents) <= 0
                }
                className="min-h-[44px] rounded-xl border border-zinc-700/60 bg-black/20 px-4 text-[12px] font-bold text-zinc-100 hover:bg-black/30 disabled:cursor-not-allowed disabled:opacity-40"
                title="Places a resting limit ask at your price (fills only if buyers lift you)."
                onClick={async () => {
                  if (submitLockRef.current) return;
                  submitLockRef.current = true;
                  setErr(null);
                  setOkMsg(null);
                  if (!token?.trim()) {
                    submitLockRef.current = false;
                    return;
                  }
                  const sharesReq = Number(sellNowShares);
                  const pxC = Number(sellAskCents);
                  const px01 = clamp01(pxC / 100);
                  if (!Number.isFinite(sharesReq) || sharesReq <= 0 || !Number.isFinite(px01) || px01 <= 0 || px01 >= 1) {
                    submitLockRef.current = false;
                    return;
                  }
                  setBusySubmit(true);
                  try {
                    if (accountMode === 'paper') {
                      const o = addPaperOrder({ tokenId: token, side: 'sell', limit01: px01, shares: sharesReq });
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
                          price01: px01,
                          shares: sharesReq,
                          usdCents: Math.abs(Math.round(px01 * sharesReq * 100)),
                          status: 'sent',
                        }),
                      );
                      setOkMsg(`Ask placed: sell ${sharesReq.toFixed(2)} ${label} @ ${(px01 * 100).toFixed(1)}¢ (waiting)`);
                      return;
                    }

                    const res = await tradeCreateOrderWithOpts(
                      { token, side: 'sell', price: px01, size: sharesReq, signatureType: null },
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
                        side: 'sell',
                        token,
                        label,
                        price01: px01,
                        shares: sharesReq,
                        usdCents: Math.abs(Math.round(px01 * sharesReq * 100)),
                        status: 'sent',
                        orderId: oid ?? null,
                      }),
                    );
                    setOkMsg(`Ask placed: sell ${sharesReq.toFixed(2)} ${label} @ ${(px01 * 100).toFixed(1)}¢ (waiting)`);
                  } finally {
                    setBusySubmit(false);
                    submitLockRef.current = false;
                  }
                }}
              >
                Place ask
              </button>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-zinc-800/70 bg-black/20 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Your position</div>
            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-sm text-zinc-200">
                {positionShares != null ? (
                  <span
                    className="inline-flex max-w-full flex-wrap items-baseline gap-x-1.5 gap-y-0.5"
                    title={`${fmtShares(positionShares, 'full')} shares`}
                  >
                    <span className="font-mono text-lg font-bold tabular-nums">{fmtShares(positionShares, 'compact')}</span>
                    <span className="text-xs font-semibold text-zinc-500">shares</span>
                    <span className="text-zinc-600">·</span>
                    <span className={`font-medium ${lane === 'up' ? 'text-emerald-300' : 'text-rose-300'}`}>{lane === 'up' ? upLabel : downLabel}</span>
                  </span>
                ) : (
                  <span className="text-zinc-500">—</span>
                )}
              </div>
              <div className="font-mono text-sm tabular-nums text-zinc-400">
                Value{' '}
                {positionShares != null && mid != null ? `$${(positionShares * mid).toFixed(2)}` : '—'} · Mid {fmtCents(mid)}
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
                  <div className="mt-0.5 font-mono text-sm text-zinc-100">{fmtCents(avgEntry)}</div>
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

            {execMode !== 'market' ? (
              <div className="mt-3">
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
              </div>
            ) : null}

            <div className="mt-4">
              <label htmlFor={idSellQty} className="text-xs font-semibold text-zinc-400">
                Sell quantity (shares)
              </label>
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
                    disabled={
                      busySubmit ||
                      sellSharesClamped == null ||
                      sellSharesClamped <= 0 ||
                      (execMode !== 'market' && (limit01 == null || !Number.isFinite(limit01)))
                    }
                    aria-busy={busySubmit}
                    className={`min-h-[48px] min-w-[6rem] rounded-xl bg-rose-500 px-4 text-sm font-bold text-black shadow-md shadow-rose-950/40 hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-40 ${
                      isSlide ? 'inline-flex items-center justify-center gap-2' : ''
                    }`}
                    onClick={async () => {
                      if (submitLockRef.current) return;
                      submitLockRef.current = true;
                      playTradeClick();
                      setErr(null);
                      setOkMsg(null);
                      if (sellSharesClamped == null || sellSharesClamped <= 0) return;
                      setBusySubmit(true);
                      try {
                        if (accountMode === 'paper') {
                          const px = execMode === 'market' ? mid : limit01;
                          const r = paperTrade({ account: paperAccount, tokenId: token, side: 'sell', shares: sellSharesClamped, price01: px });
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
                                shares: sellSharesClamped,
                                usdCents: null,
                                status: 'error',
                                error: r.error,
                              }),
                            );
                          } else {
                            setPaperAccount(r.account);
                            setOkMsg(`Paper sold ${sellSharesClamped.toFixed(2)} sh of ${label} @ ${(px! * 100).toFixed(1)}¢`);
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
                        if (execMode === 'market') {
                          await runMarketSell(sellSharesClamped);
                        } else {
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
                            submittedPrice01: null,
                            fillAvgPrice01: null,
                            markPrice01: mark01,
                            shares: sizeLive,
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
                              signatureType: null,
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
                            const sub = execution?.submitted_price_01 ?? price;
                            const rt = mergeRoundTripMs(execution?.round_trip_ms, clientMs);
                            setLastExecLatencyMs(rt);
                            setHistoryRows(
                              updateTradeHistoryRow(optimistic.id, {
                                status: 'sent',
                                submittedPrice01: sub,
                                orderId: oid ?? undefined,
                                roundTripMs: rt,
                                price01: quoted01,
                                error: undefined,
                              }),
                            );
                            if (oid) pollRestingOrderFill(optimistic.id, oid, sizeLive, sub, quoted01);
                            setOkMsg(
                              `${execMode === 'touch' ? 'Quick' : 'Limit'} sell sent ${sizeLive.toFixed(2)} ${label} @ ${(price * 100).toFixed(1)}¢ · ack ${rt}ms — watching fill`,
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
                    ) : (
                      `Sell ${label}`
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
                submitLockRef.current = true;
                playTradeClick();
                setErr(null);
                setOkMsg(null);
                if (positionShares == null || positionShares <= 0) return;
                setBusySubmit(true);
                try {
                  if (accountMode === 'paper') {
                    const px = execMode === 'market' ? mid : limit01;
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
                  if (execMode === 'market') {
                    await runMarketSell(positionShares);
                  } else {
                    const price =
                      execMode === 'touch'
                        ? // Quick sell = aggressive limit at executable reference (best bid; falls back to mid)
                          (executableQuote01 ?? mid ?? NaN)
                        : (limit01 ?? NaN);
                    const sizeLive = floorShares4(positionShares);
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
                      submittedPrice01: null,
                      fillAvgPrice01: null,
                      markPrice01: mark01,
                      shares: sizeLive,
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
                        signatureType: null,
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
                      const sub = execution?.submitted_price_01 ?? price;
                      const rt = mergeRoundTripMs(execution?.round_trip_ms, clientMs);
                      setLastExecLatencyMs(rt);
                      setHistoryRows(
                        updateTradeHistoryRow(optimistic.id, {
                          status: 'sent',
                          submittedPrice01: sub,
                          orderId: oid ?? undefined,
                          roundTripMs: rt,
                          price01: quoted01,
                          error: undefined,
                        }),
                      );
                      if (oid) pollRestingOrderFill(optimistic.id, oid, sizeLive, sub, quoted01);
                      setOkMsg(
                        `${execMode === 'touch' ? 'Quick' : 'Limit'} sell-all sent ${sizeLive.toFixed(2)} ${label} @ ${(price * 100).toFixed(1)}¢ · ack ${rt}ms — watching fill`,
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
                `Enter · Sell all (${fmtShares(positionShares, 'compact')} sh)`
              )}
            </button>
          </div>
        </>
      )}

      {toasts.length ? (
        <div className={`mt-4 space-y-2 ${isSlide ? 'hidden' : ''}`} aria-live="polite">
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

      <p className="mt-4 rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2.5 text-[11px] leading-relaxed text-zinc-500">
        <span className="font-semibold text-zinc-400">Trade history</span> lives in the main{' '}
        <span className="font-medium text-zinc-300">History</span> tab (filters, export CSV, clear). Local log:{' '}
        <span className="font-mono text-zinc-400">{historyRows.length}</span> rows.
      </p>

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
