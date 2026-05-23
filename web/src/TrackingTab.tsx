import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { RecentPrintsPanel } from './RecentPrintsPanel';
import { PAPER_ACCOUNT_SYNC_EVENT } from './paperAccountSync';
import {
  cancelPaperOrder,
  getPaperPosition,
  loadPaperAccount,
  loadPaperOrders,
  PAPER_ORDERS_SYNC_EVENT,
  type PaperOrder,
} from './paperTrading';
import { loadTradeHistory, TRADE_HISTORY_CHANGED_EVENT, type TradeHistoryRow } from './tradeHistory';
import { loadTradeAccountMode, saveTradeAccountMode, TRADE_ACCOUNT_MODE_EVENT } from './tradeAccountMode';
import type { ApiErr, ApiOk } from './lib/api';
import { tradeAvgEntry, tradeBalanceAllowance, tradeOpenOrders, tradeUpdateBalanceAllowance } from './lib/api';
import { cancelOneLiveOrder } from './liveOrderCancel';

function isOk<T>(r: ApiOk<T> | ApiErr): r is ApiOk<T> {
  return r.ok === true;
}

const OUTCOME_NOTES_LS = 'pm:trackingOutcomeNotes:v1';

function loadOutcomeNotes(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(OUTCOME_NOTES_LS);
    if (!raw) return {};
    const p = JSON.parse(raw) as unknown;
    if (!p || typeof p !== 'object') return {};
    const o = p as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && k.trim()) out[k.trim()] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveOutcomeNotes(next: Record<string, string>): void {
  try {
    window.localStorage.setItem(OUTCOME_NOTES_LS, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function fmt01(p: number | null): string {
  if (p == null || !Number.isFinite(p) || p <= 0) return '—';
  return `${(p * 100).toFixed(1)}¢`;
}

function pickOrderId(o: unknown): string | null {
  const r = o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  const id =
    (typeof r?.id === 'string' && r.id) ||
    (typeof r?.orderID === 'string' && r.orderID) ||
    (typeof r?.order_id === 'string' && r.order_id) ||
    '';
  return id.trim() ? id.trim() : null;
}

function pickTokenId(o: unknown): string | null {
  const r = o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  const t =
    (typeof r?.asset_id === 'string' && r.asset_id) ||
    (typeof r?.tokenID === 'string' && r.tokenID) ||
    (typeof r?.token_id === 'string' && r.token_id) ||
    '';
  return t.trim() ? t.trim() : null;
}

function pickSide(o: unknown): string {
  const r = o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  const s = (typeof r?.side === 'string' && r.side) || (typeof r?.order_side === 'string' && r.order_side) || '';
  return s ? String(s).toUpperCase() : '—';
}

function pickPrice01(o: unknown): number | null {
  const r = o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  const raw = r?.price ?? r?.price01;
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return null;
}

/** Resting size left to fill (matches Polymarket “open” column), not `original_size` alone. */
function pickRemainingShares(o: unknown): number | null {
  const r = o && typeof o === 'object' ? (o as Record<string, unknown>) : null;
  if (!r) return null;
  const pickN = (v: unknown): number | null => {
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const rem = pickN(r.remaining ?? r.sizeRemaining ?? r.remaining_size);
  if (rem != null) return rem;
  const orig = pickN(r.original_size ?? r.originalSize ?? r.size ?? r.total_size);
  const matched = pickN(r.size_matched ?? r.sizeMatched ?? r.matched_size);
  if (orig != null && matched != null) return Math.max(0, orig - matched);
  return orig;
}

type TrackSub = 'live' | 'positions' | 'orders' | 'history' | 'automations';

function clearPersistedRiskForToken(tokenId: string): void {
  const t = tokenId.trim();
  if (!t) return;
  try {
    window.localStorage.removeItem(`pm:stoploss:v1:${t}`);
    window.localStorage.removeItem(`pm:takeprofit:v1:${t}`);
  } catch {
    /* ignore */
  }
  try {
    window.dispatchEvent(new CustomEvent('pm-clear-risk-prefs', { detail: { tokenId: t } }));
  } catch {
    /* ignore */
  }
}

function fmtHistoryTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

type TrackingKpiTileProps = {
  label: string;
  value: string;
  sub?: string;
  accent?: 'emerald' | 'sky' | 'zinc' | 'auto';
  valueClass?: string;
  badge?: ReactElement | null;
};

function TrackingKpiTile({ label, value, sub, accent, valueClass, badge }: TrackingKpiTileProps) {
  const accentClass =
    accent === 'emerald'
      ? 'border-emerald-500/20 ring-emerald-500/10'
      : accent === 'sky'
        ? 'border-sky-500/20 ring-sky-500/10'
        : 'border-zinc-800/60 ring-white/[0.02]';
  return (
    <div className={`min-w-[140px] flex-1 rounded-xl border bg-zinc-950/55 p-3 ring-1 ${accentClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{label}</span>
        {badge ?? null}
      </div>
      <div className={`mt-1.5 truncate font-mono text-[18px] font-semibold tabular-nums tracking-tight ${valueClass ?? 'text-zinc-50'}`}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 truncate text-[10px] leading-snug text-zinc-500">{sub}</div> : null}
    </div>
  );
}

export function TrackingTab(props: {
  upToken: string;
  downToken: string;
  conditionId: string | null;
  upLabel: string;
  downLabel: string;
  slug: string;
  onOpenTradeHistory?: () => void;
  onOpenSignals?: () => void;
  /** Tighter layout when nested under Signals charts (vs standalone Tracking tab). */
  embed?: boolean;
  /** When false, hides the Live trades (public tape) sub-tab — use under Signals to avoid duplicating the tape grid. */
  showLiveTrades?: boolean;
  /** Current mid (0..1) for the Up outcome — used to compute mark, notional, and unrealized P&L. */
  upMid01?: number | null;
  /** Current mid (0..1) for the Down outcome — used to compute mark, notional, and unrealized P&L. */
  downMid01?: number | null;
}): ReactElement {
  const {
    upToken,
    downToken,
    conditionId,
    upLabel,
    downLabel,
    slug,
    onOpenTradeHistory,
    onOpenSignals,
    embed = false,
    showLiveTrades = true,
    upMid01 = null,
    downMid01 = null,
  } = props;
  const tokens = useMemo(() => [upToken, downToken].filter((t) => t && t.trim()), [upToken, downToken]);

  const [portfolioMode, setPortfolioMode] = useState<'live' | 'paper'>(() => loadTradeAccountMode());
  useEffect(() => {
    const onMode = (ev: Event) => {
      const ce = ev as CustomEvent<{ mode?: 'live' | 'paper' }>;
      if (ce.detail?.mode === 'live' || ce.detail?.mode === 'paper') setPortfolioMode(ce.detail.mode);
    };
    window.addEventListener(TRADE_ACCOUNT_MODE_EVENT, onMode as EventListener);
    return () => window.removeEventListener(TRADE_ACCOUNT_MODE_EVENT, onMode as EventListener);
  }, []);
  const [subTab, setSubTab] = useState<TrackSub>(() => (showLiveTrades ? 'live' : 'positions'));
  const [tapeScope, setTapeScope] = useState<'all' | 'up' | 'down'>('all');

  const [busy, setBusy] = useState(false);
  const [liveErr, setLiveErr] = useState<string | null>(null);
  const [orders, setOrders] = useState<unknown[]>([]);
  const [usdc, setUsdc] = useState<string | null>(null);
  const [cashUsdNum, setCashUsdNum] = useState<number | null>(null);
  const [upPos, setUpPos] = useState<{ shares: number | null; avgEntry: number | null }>({ shares: null, avgEntry: null });
  const [downPos, setDownPos] = useState<{ shares: number | null; avgEntry: number | null }>({ shares: null, avgEntry: null });

  /** Token id of the row whose drawer (notes / SL-TP / open-in-signals) is expanded. */
  const [expandedToken, setExpandedToken] = useState<string | null>(null);

  const [paperOrders, setPaperOrders] = useState<PaperOrder[]>([]);

  const [outcomeNotes, setOutcomeNotes] = useState<Record<string, string>>(() => loadOutcomeNotes());
  const [noteDraftUp, setNoteDraftUp] = useState('');
  const [noteDraftDown, setNoteDraftDown] = useState('');

  const [historyRows, setHistoryRows] = useState<TradeHistoryRow[]>([]);

  const refreshLive = useCallback(async () => {
    setBusy(true);
    setLiveErr(null);
    try {
      const [bal, o, up, down] = await Promise.all([
        tradeBalanceAllowance({ assetType: 'collateral' }),
        tradeOpenOrders(tokens.length === 1 ? { tokenId: tokens[0] } : undefined),
        upToken ? tradeAvgEntry({ tokenId: upToken }) : Promise.resolve({ ok: true, data: { tokenId: '', avgEntry: null, shares: 0 } } as ApiOk<unknown>),
        downToken ? tradeAvgEntry({ tokenId: downToken }) : Promise.resolve({ ok: true, data: { tokenId: '', avgEntry: null, shares: 0 } } as ApiOk<unknown>),
      ]);

      if (isOk(bal)) {
        setUsdc(bal.data.balance);
        const n = Number(bal.data.balance);
        setCashUsdNum(Number.isFinite(n) ? n : null);
      } else {
        setUsdc(null);
        setCashUsdNum(null);
      }

      if (isOk(o)) setOrders(o.data.orders ?? []);
      else {
        setOrders([]);
        setLiveErr(`${o.error}${o.details ? ` · ${JSON.stringify(o.details)}` : ''}`);
      }

      if (isOk(up)) setUpPos({ shares: (up.data as { shares?: number }).shares ?? null, avgEntry: (up.data as { avgEntry?: number | null }).avgEntry ?? null });
      else setUpPos({ shares: null, avgEntry: null });
      if (isOk(down)) setDownPos({ shares: (down.data as { shares?: number }).shares ?? null, avgEntry: (down.data as { avgEntry?: number | null }).avgEntry ?? null });
      else setDownPos({ shares: null, avgEntry: null });
    } catch (e) {
      setLiveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [downToken, tokens.length, upToken]);

  const tokSet = useMemo(() => new Set(tokens.map((t) => t.trim()).filter(Boolean)), [tokens]);

  const refreshPaper = useCallback(() => {
    setBusy(true);
    try {
      const o = loadPaperOrders().filter((x) => tokSet.has(x.tokenId.trim()));
      setPaperOrders(o);
      const acc = loadPaperAccount();
      const cashUsd = acc.cashUsdCents / 100;
      setCashUsdNum(Number.isFinite(cashUsd) ? cashUsd : null);
      setUsdc(Number.isFinite(cashUsd) ? `$${cashUsd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null);
      const u = upToken.trim() ? getPaperPosition(acc, upToken) : { shares: 0, avgCost01: null };
      const d = downToken.trim() ? getPaperPosition(acc, downToken) : { shares: 0, avgCost01: null };
      setUpPos({ shares: u.shares, avgEntry: u.avgCost01 });
      setDownPos({ shares: d.shares, avgEntry: d.avgCost01 });
      setOrders([]);
      setLiveErr(null);
    } finally {
      setBusy(false);
    }
  }, [downToken, tokSet, upToken]);

  const refresh = useCallback(() => {
    if (portfolioMode === 'live') void refreshLive();
    else refreshPaper();
  }, [portfolioMode, refreshLive, refreshPaper]);

  useEffect(() => {
    if (portfolioMode !== 'live') return;
    void refreshLive();
  }, [portfolioMode, refreshLive]);

  useEffect(() => {
    if (portfolioMode !== 'paper') return;
    refreshPaper();
  }, [portfolioMode, refreshPaper]);

  useEffect(() => {
    const onPaper = () => {
      if (portfolioMode === 'paper') refreshPaper();
    };
    window.addEventListener(PAPER_ACCOUNT_SYNC_EVENT, onPaper);
    window.addEventListener(PAPER_ORDERS_SYNC_EVENT, onPaper);
    return () => {
      window.removeEventListener(PAPER_ACCOUNT_SYNC_EVENT, onPaper);
      window.removeEventListener(PAPER_ORDERS_SYNC_EVENT, onPaper);
    };
  }, [portfolioMode, refreshPaper]);

  useEffect(() => {
    if (subTab === 'orders') {
      if (portfolioMode === 'live') void refreshLive();
      else refreshPaper();
    }
  }, [subTab, portfolioMode, refreshLive, refreshPaper]);

  useEffect(() => {
    const n = loadOutcomeNotes();
    setOutcomeNotes(n);
    setNoteDraftUp(upToken.trim() ? (n[upToken.trim()] ?? '') : '');
    setNoteDraftDown(downToken.trim() ? (n[downToken.trim()] ?? '') : '');
  }, [upToken, downToken]);

  const reloadLocalHistory = useCallback(() => {
    const wantMode = portfolioMode === 'live' ? 'live' : 'paper';
    const rows = loadTradeHistory()
      .filter((r) => tokSet.has(r.token.trim()) && r.mode === wantMode)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 40);
    setHistoryRows(rows);
  }, [portfolioMode, tokSet]);

  useEffect(() => {
    reloadLocalHistory();
    const onCh = () => reloadLocalHistory();
    window.addEventListener(TRADE_HISTORY_CHANGED_EVENT, onCh);
    return () => window.removeEventListener(TRADE_HISTORY_CHANGED_EVENT, onCh);
  }, [reloadLocalHistory]);

  useEffect(() => {
    if (!showLiveTrades && subTab === 'live') setSubTab('positions');
  }, [showLiveTrades, subTab]);

  const tapeOutcomeLabel = tapeScope === 'up' ? upLabel : tapeScope === 'down' ? downLabel : null;
  const tapePanelTokenId = tapeScope === 'up' ? upToken : tapeScope === 'down' ? downToken : null;

  const tabs: { id: TrackSub; label: string }[] = useMemo(() => {
    const all: { id: TrackSub; label: string }[] = [
      { id: 'live', label: 'Live trades' },
      { id: 'positions', label: 'Positions' },
      { id: 'orders', label: 'Open orders' },
      { id: 'history', label: 'Trade history' },
      { id: 'automations', label: 'Automations' },
    ];
    return showLiveTrades ? all : all.filter((t) => t.id !== 'live');
  }, [showLiveTrades]);

  const persistNote = (tokenId: string, text: string) => {
    const t = tokenId.trim();
    if (!t) return;
    const next = { ...outcomeNotes };
    const trimmed = text.trim();
    if (trimmed) next[t] = trimmed;
    else delete next[t];
    saveOutcomeNotes(next);
    setOutcomeNotes(next);
  };

  const labelForTokenId = useCallback(
    (tid: string) => {
      const t = tid.trim();
      if (upToken.trim() === t) return upLabel;
      if (downToken.trim() === t) return downLabel;
      return 'Outcome';
    },
    [downToken, downLabel, upToken, upLabel],
  );

  const openOrdersLiveBody = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-zinc-100">Open orders (live)</div>
          <div className="mt-1 text-[11px] text-zinc-500">
            Resting CLOB limit orders for your wallet (all markets when both outcomes are loaded).
          </div>
        </div>
        <div className="text-[11px] font-mono text-zinc-500">{orders.length} orders</div>
      </div>

      {orders.length === 0 ? (
        <div className="mt-3 rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-3 text-[12px] text-zinc-500">None.</div>
      ) : (
        <div className="mt-3 overflow-auto rounded-xl border border-zinc-800/50">
          <div className="grid min-w-[720px] grid-cols-[160px_130px_90px_90px_1fr_120px] gap-2 border-b border-zinc-800/50 bg-black/20 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            <span>Order ID</span>
            <span>Token</span>
            <span>Side</span>
            <span className="text-right">Price</span>
            <span className="text-right">Remaining</span>
            <span className="text-right">Action</span>
          </div>
          {orders.slice(0, 200).map((o, idx) => {
            const oid = pickOrderId(o);
            const tok = pickTokenId(o);
            const px = pickPrice01(o);
            const sz = pickRemainingShares(o);
            return (
              <div
                key={`${oid ?? 'row'}-${idx}`}
                className="grid min-w-[720px] grid-cols-[160px_130px_90px_90px_1fr_120px] items-center gap-2 px-3 py-2 text-[12px] text-zinc-200"
              >
                <span className="truncate font-mono text-[11px] text-zinc-300">{oid ?? '—'}</span>
                <span className="truncate font-mono text-[11px] text-zinc-500">{tok ? `${tok.slice(0, 6)}…${tok.slice(-4)}` : '—'}</span>
                <span className="text-[11px] font-semibold">{pickSide(o)}</span>
                <span className="text-right font-mono text-[11px]">{px == null ? '—' : `${(px * 100).toFixed(1)}¢`}</span>
                <span className="text-right font-mono text-[11px]">{sz == null ? '—' : sz.toFixed(4)}</span>
                <span className="text-right">
                  <button
                    type="button"
                    disabled={!oid}
                    onClick={async () => {
                      if (!oid) return;
                      const res = await cancelOneLiveOrder(oid);
                      if (!res.ok) window.alert(res.message);
                      void refreshLive();
                    }}
                    className="rounded-lg border border-zinc-700/60 bg-black/20 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-black/30 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  const openOrdersPaperBody = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-zinc-100">Open orders (paper)</div>
          <div className="mt-1 text-[11px] text-zinc-500">
            Simulated resting limits from paper trading in Signals — stored only in this browser.
          </div>
        </div>
        <div className="text-[11px] font-mono text-zinc-500">{paperOrders.length} orders</div>
      </div>

      {paperOrders.length === 0 ? (
        <div className="mt-3 rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-3 text-[12px] text-zinc-500">None for this market.</div>
      ) : (
        <div className="mt-3 overflow-auto rounded-xl border border-zinc-800/50">
          <div className="grid min-w-[560px] grid-cols-[140px_1fr_72px_90px_90px_100px] gap-2 border-b border-zinc-800/50 bg-black/20 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            <span>Order ID</span>
            <span>Outcome</span>
            <span>Side</span>
            <span className="text-right">Limit</span>
            <span className="text-right">Shares</span>
            <span className="text-right">Action</span>
          </div>
          {paperOrders.slice(0, 200).map((o) => (
            <div
              key={o.id}
              className="grid min-w-[560px] grid-cols-[140px_1fr_72px_90px_90px_100px] items-center gap-2 px-3 py-2 text-[12px] text-zinc-200"
            >
              <span className="truncate font-mono text-[11px] text-zinc-300">{o.id.slice(0, 10)}…</span>
              <span className="text-[12px] text-zinc-300">{labelForTokenId(o.tokenId)}</span>
              <span className="text-[11px] font-semibold">{o.side.toUpperCase()}</span>
              <span className="text-right font-mono text-[11px]">{(o.limit01 * 100).toFixed(1)}¢</span>
              <span className="text-right font-mono text-[11px]">{o.shares.toFixed(4)}</span>
              <span className="text-right">
                <button
                  type="button"
                  onClick={() => {
                    cancelPaperOrder(o.id);
                    refreshPaper();
                  }}
                  className="rounded-lg border border-zinc-700/60 bg-black/20 px-2.5 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-black/30"
                >
                  Cancel
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );

  const upMark = upMid01 != null && Number.isFinite(upMid01) && upMid01 > 0 && upMid01 < 1 ? upMid01 : null;
  const downMark = downMid01 != null && Number.isFinite(downMid01) && downMid01 > 0 && downMid01 < 1 ? downMid01 : null;

  const computeRowMetrics = (
    pos: { shares: number | null; avgEntry: number | null },
    mark: number | null,
  ): { notionalUsd: number | null; unrealizedUsd: number | null; unrealizedPct: number | null } => {
    const shares = pos.shares;
    const avg = pos.avgEntry;
    const notionalUsd = shares != null && shares > 0 && mark != null ? shares * mark : null;
    const unrealizedUsd =
      shares != null && shares > 0 && avg != null && mark != null ? shares * (mark - avg) : null;
    const cost = shares != null && shares > 0 && avg != null ? shares * avg : null;
    const unrealizedPct = unrealizedUsd != null && cost != null && cost > 0 ? unrealizedUsd / cost : null;
    return { notionalUsd, unrealizedUsd, unrealizedPct };
  };

  const upMetrics = computeRowMetrics(upPos, upMark);
  const downMetrics = computeRowMetrics(downPos, downMark);

  const equityUsd =
    upMetrics.notionalUsd != null || downMetrics.notionalUsd != null
      ? (upMetrics.notionalUsd ?? 0) + (downMetrics.notionalUsd ?? 0)
      : null;
  const totalValueUsd = cashUsdNum != null ? (cashUsdNum + (equityUsd ?? 0)) : null;
  const totalUnrealizedUsd =
    upMetrics.unrealizedUsd != null || downMetrics.unrealizedUsd != null
      ? (upMetrics.unrealizedUsd ?? 0) + (downMetrics.unrealizedUsd ?? 0)
      : null;
  const totalCostBasis = (() => {
    const u = upPos.shares != null && upPos.shares > 0 && upPos.avgEntry != null ? upPos.shares * upPos.avgEntry : 0;
    const d = downPos.shares != null && downPos.shares > 0 && downPos.avgEntry != null ? downPos.shares * downPos.avgEntry : 0;
    const total = u + d;
    return total > 0 ? total : null;
  })();
  const totalUnrealizedPct =
    totalUnrealizedUsd != null && totalCostBasis != null ? totalUnrealizedUsd / totalCostBasis : null;

  const fmtUsd = (n: number | null, opts?: { signed?: boolean; cents?: boolean }) => {
    if (n == null || !Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    const cents = opts?.cents ?? true;
    const body = abs.toLocaleString(undefined, {
      minimumFractionDigits: cents ? 2 : 0,
      maximumFractionDigits: cents ? 2 : 0,
    });
    if (opts?.signed) return `${n > 0 ? '+' : n < 0 ? '−' : ''}$${body}`;
    return `$${body}`;
  };
  const fmtPct = (n: number | null, opts?: { signed?: boolean }) => {
    if (n == null || !Number.isFinite(n)) return '—';
    const v = n * 100;
    const body = Math.abs(v).toFixed(2);
    if (opts?.signed) return `${v > 0 ? '+' : v < 0 ? '−' : ''}${body}%`;
    return `${body}%`;
  };

  const pnlTone = (v: number | null): string => {
    if (v == null || !Number.isFinite(v) || v === 0) return 'text-zinc-300';
    return v > 0 ? 'text-emerald-300' : 'text-rose-300';
  };

  const positionRow = (
    label: string,
    token: string,
    pos: { shares: number | null; avgEntry: number | null },
    metrics: { notionalUsd: number | null; unrealizedUsd: number | null; unrealizedPct: number | null },
    mark: number | null,
    draft: string,
    setDraft: (s: string) => void,
    variant: 'up' | 'down',
  ) => {
    const v =
      variant === 'up'
        ? { dot: 'bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.5)]', label: 'text-sky-100', accentBg: 'bg-sky-500/[0.04]' }
        : { dot: 'bg-fuchsia-400 shadow-[0_0_8px_rgba(232,121,249,0.5)]', label: 'text-fuchsia-100', accentBg: 'bg-fuchsia-500/[0.04]' };
    const hasShares = pos.shares != null && pos.shares > 0;
    const tk = token.trim();
    const isOpen = tk !== '' && expandedToken === tk;
    const pnlClass = pnlTone(metrics.unrealizedUsd);

    const cellLabelCls = 'text-[9px] font-semibold uppercase tracking-wider text-zinc-500';
    return (
      <div className={`overflow-hidden ${v.accentBg}`}>
        <div className="grid grid-cols-2 items-center gap-x-3 gap-y-2 px-3 py-2.5 md:grid-cols-[minmax(140px,1.4fr)_repeat(5,minmax(70px,1fr))_auto]">
          <div className="col-span-2 flex min-w-0 items-center gap-2 md:col-span-1">
            <span className={`h-2 w-2 shrink-0 rounded-full ${v.dot}`} aria-hidden />
            <div className="min-w-0">
              <div className={`truncate text-[13px] font-semibold leading-tight ${v.label}`}>{label}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide">
                {hasShares ? (
                  <span className="rounded bg-emerald-950/60 px-1.5 py-0.5 font-bold text-emerald-300">LONG</span>
                ) : (
                  <span className="rounded bg-zinc-800/60 px-1.5 py-0.5 font-semibold text-zinc-500">No position</span>
                )}
                <span className="text-zinc-600">{variant === 'up' ? 'Up' : 'Down'}</span>
              </div>
            </div>
          </div>

          <div className="md:text-right">
            <div className={`md:hidden ${cellLabelCls}`}>Shares</div>
            <div
              className={`tabular-nums font-mono text-[13px] leading-tight ${
                hasShares ? 'text-zinc-100' : 'text-zinc-600'
              }`}
            >
              {pos.shares == null ? '—' : pos.shares.toFixed(4)}
            </div>
          </div>

          <div className="md:text-right">
            <div className={`md:hidden ${cellLabelCls}`}>Avg</div>
            <div className="tabular-nums font-mono text-[13px] leading-tight text-zinc-100">{fmt01(pos.avgEntry)}</div>
          </div>

          <div className="md:text-right">
            <div className={`md:hidden ${cellLabelCls}`}>Mark</div>
            <div className="tabular-nums font-mono text-[13px] leading-tight text-zinc-100">{fmt01(mark)}</div>
          </div>

          <div className="md:text-right">
            <div className={`md:hidden ${cellLabelCls}`}>Notional</div>
            <div
              className={`tabular-nums font-mono text-[13px] leading-tight ${
                metrics.notionalUsd != null ? 'text-zinc-100' : 'text-zinc-600'
              }`}
            >
              {fmtUsd(metrics.notionalUsd)}
            </div>
          </div>

          <div className="md:text-right">
            <div className={`md:hidden ${cellLabelCls}`}>Unrealized</div>
            <div className={`tabular-nums font-mono text-[13px] font-semibold leading-tight ${pnlClass}`}>
              {fmtUsd(metrics.unrealizedUsd, { signed: true })}
            </div>
            <div className={`tabular-nums text-[10px] leading-tight ${pnlClass}`}>
              {fmtPct(metrics.unrealizedPct, { signed: true })}
            </div>
          </div>

          <div className="col-span-2 flex justify-end md:col-span-1">
            <button
              type="button"
              disabled={!tk}
              onClick={() => setExpandedToken(isOpen ? null : tk)}
              className={`inline-flex h-7 items-center gap-1 rounded-md border border-zinc-700/60 bg-black/30 px-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-300 transition-colors hover:bg-black/50 disabled:opacity-40 ${
                isOpen ? 'border-sky-700/50 bg-sky-950/30 text-sky-200' : ''
              }`}
              aria-expanded={isOpen}
              aria-controls={tk ? `pos-drawer-${tk}` : undefined}
              title="Show notes, SL/TP, and links"
            >
              <span>{isOpen ? 'Hide' : 'Manage'}</span>
              <span aria-hidden className={`transition-transform ${isOpen ? 'rotate-180' : ''}`}>▾</span>
            </button>
          </div>
        </div>

        {isOpen ? (
          <div
            id={tk ? `pos-drawer-${tk}` : undefined}
            className="border-t border-zinc-800/60 bg-black/30 p-3"
          >
            <div className="grid gap-3 md:grid-cols-[1fr_minmax(0,260px)]">
              <div className="min-w-0">
                <div className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Notes</div>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={2}
                  placeholder={`Reminder for ${label}…`}
                  className="mt-1.5 min-h-[52px] w-full resize-none rounded-lg border border-zinc-800/70 bg-zinc-950/55 px-2.5 py-1.5 text-[12px] text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none focus:ring-1 focus:ring-sky-600/40"
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    disabled={!tk}
                    onClick={() => persistNote(token, draft)}
                    className="rounded-md border border-sky-800/45 bg-sky-950/30 px-2 py-1 text-[11px] font-semibold text-sky-50 hover:bg-sky-950/45 disabled:opacity-40"
                  >
                    Save note
                  </button>
                  <button
                    type="button"
                    disabled={!tk}
                    onClick={() => {
                      setDraft('');
                      persistNote(token, '');
                    }}
                    className="rounded-md border border-zinc-700/70 bg-zinc-950/40 px-2 py-1 text-[11px] font-semibold text-zinc-300 hover:bg-zinc-900/60 disabled:opacity-40"
                  >
                    Clear note
                  </button>
                  <button
                    type="button"
                    disabled={!tk}
                    onClick={() => {
                      if (!window.confirm(`Clear saved stop-loss / take-profit for ${label}?`)) return;
                      clearPersistedRiskForToken(token);
                    }}
                    className="rounded-md border border-rose-900/45 bg-rose-950/25 px-2 py-1 text-[11px] font-semibold text-rose-100 hover:bg-rose-950/40 disabled:opacity-40"
                    title={
                      portfolioMode === 'live'
                        ? 'Removes TP/SL automation prefs stored for this token; does not close exchange positions.'
                        : 'Removes TP/SL bracket prefs for this token (local storage; does not change simulated shares).'
                    }
                  >
                    Clear SL / TP
                  </button>
                </div>
              </div>

              <div className="min-w-0 rounded-lg border border-zinc-800/60 bg-zinc-950/55 p-2.5">
                <div className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Token id</div>
                <button
                  type="button"
                  onClick={() => {
                    if (!tk) return;
                    try {
                      void navigator.clipboard.writeText(tk);
                    } catch {
                      /* ignore */
                    }
                  }}
                  className="mt-1 block w-full truncate rounded-md border border-zinc-800/60 bg-black/40 px-2 py-1 text-left font-mono text-[10px] text-zinc-300 hover:bg-black/60 disabled:opacity-40"
                  title={tk ? `${tk} — click to copy` : 'No token id'}
                  disabled={!tk}
                >
                  {tk ? tk : '—'}
                </button>
                {onOpenSignals ? (
                  <button
                    type="button"
                    onClick={onOpenSignals}
                    className="mt-2 inline-flex w-full items-center justify-center gap-1 rounded-md border border-sky-800/45 bg-sky-950/25 px-2 py-1.5 text-[11px] font-semibold text-sky-100 hover:bg-sky-950/40"
                  >
                    Open in Signals →
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const headerTitle =
    embed && portfolioMode === 'live'
      ? 'Live portfolio'
      : embed && portfolioMode === 'paper'
        ? 'Paper portfolio'
        : !embed && portfolioMode === 'live'
          ? 'Tracking'
          : 'Tracking · paper';

  return (
    <div className={embed ? 'mt-0 space-y-3' : 'mt-5 space-y-4'}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Portfolio</span>
        <div className="inline-flex rounded-xl border border-zinc-700/50 bg-black/30 p-0.5">
          <button
            type="button"
            onClick={() => {
              saveTradeAccountMode('live');
              setPortfolioMode('live');
            }}
            className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors ${
              portfolioMode === 'live' ? 'bg-sky-600/45 text-sky-50 shadow-sm shadow-sky-900/40' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            Live
          </button>
          <button
            type="button"
            onClick={() => {
              saveTradeAccountMode('paper');
              setPortfolioMode('paper');
            }}
            className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors ${
              portfolioMode === 'paper' ? 'bg-amber-600/40 text-amber-50 shadow-sm shadow-amber-950/40' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            Paper
          </button>
        </div>
        <p className="min-w-[200px] flex-1 text-[11px] leading-snug text-zinc-500">
          {portfolioMode === 'live'
            ? 'Real wallet balances and Polymarket CLOB orders (needs API access; VPN/datacenter IPs are often blocked).'
            : 'Practice account only — reads local paper balances, simulated limits, and paper trade history. No CLOB calls.'}
        </p>
      </div>

      <div
        className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-zinc-800/50 bg-zinc-900/20 ring-1 ring-white/[0.02] ${embed ? 'p-3' : 'p-4'}`}
      >
        <div className="min-w-0">
          <div className={`font-semibold text-zinc-100 ${embed ? 'text-xs' : 'text-sm'}`}>{headerTitle}</div>
          <div className={`mt-1 leading-relaxed text-zinc-500 ${embed ? 'text-[11px]' : 'text-xs'}`}>
            {embed ? (
              <>
                {showLiveTrades ? 'Tape, positions, and open orders' : 'Positions and open orders'} for{' '}
                <span className="font-mono text-zinc-400">{slug || 'this market'}</span>
                {portfolioMode === 'paper' ? (
                  <span className="text-zinc-600"> · switch to Live to load real positions when your network can reach the CLOB.</span>
                ) : null}
                .
              </>
            ) : (
              <>
                Tape, positions, open orders, and local notes for{' '}
                <span className="font-mono text-zinc-400">{slug || 'this market'}</span>.
              </>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void refresh()}
            className="rounded-xl border border-zinc-700/50 bg-black/20 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-black/30 disabled:opacity-40"
          >
            Refresh
          </button>
          <button
            type="button"
            disabled={busy || tokens.length === 0 || portfolioMode !== 'live'}
            onClick={() => void tradeUpdateBalanceAllowance({ assetType: 'collateral' })}
            className="rounded-xl border border-zinc-700/50 bg-black/20 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-black/30 disabled:opacity-40"
            title={
              portfolioMode !== 'live'
                ? 'Only used for live CLOB trading'
                : 'Refresh CLOB cached balances (helps when sells say balance is stale)'
            }
          >
            Sync balances
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-zinc-800/70">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSubTab(t.id)}
            className={`relative px-3 py-2.5 text-[12px] font-semibold transition-colors ${
              subTab === t.id ? 'text-sky-300' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t.label}
            {subTab === t.id ? <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-sky-500" /> : null}
          </button>
        ))}
      </div>

      {portfolioMode === 'live' && liveErr ? (
        <div className="space-y-2">
          <div className="rounded-xl border border-rose-900/35 bg-rose-950/15 px-3 py-2 text-[12px] text-rose-100">{liveErr}</div>
          {liveErr.includes('clob_http_cloudflare_block') || liveErr.toLowerCase().includes('cloudflare') ? (
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 px-3 py-2 text-[12px] text-zinc-400">
              This panel only talks to Polymarket for <span className="text-zinc-200">Live</span>. Choose{' '}
              <span className="font-semibold text-amber-200/90">Paper</span> above to see your simulated portfolio without calling the CLOB.
            </div>
          ) : null}
        </div>
      ) : null}

      {subTab === 'live' && showLiveTrades ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {(['all', 'up', 'down'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setTapeScope(k)}
                className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${
                  tapeScope === k
                    ? 'border-sky-600/50 bg-sky-950/25 text-sky-100'
                    : 'border-zinc-800/60 bg-black/20 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {k === 'all' ? 'All outcomes' : k === 'up' ? upLabel : downLabel}
              </button>
            ))}
          </div>
          {conditionId ? (
            <RecentPrintsPanel
              conditionId={conditionId}
              activeTokenId={tapePanelTokenId}
              outcomeLabel={tapeOutcomeLabel}
              tapeScope={tapeScope === 'all' ? 'all' : 'one'}
            />
          ) : (
            <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 text-[13px] text-zinc-500">
              Load a market with a valid condition id to stream public tape trades.
            </div>
          )}
        </div>
      ) : null}

      {subTab === 'positions' ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2 px-0.5">
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Positions</h3>
              <p className="mt-0.5 text-[12px] text-zinc-600">
                {portfolioMode === 'live' ? 'Live wallet, mark, and unrealized P&L for this market.' : 'Paper account size and unrealized P&L for this market.'}
              </p>
            </div>
            {busy ? <span className="text-[11px] font-medium text-sky-400/90">Refreshing…</span> : null}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <TrackingKpiTile
              label="Cash"
              value={usdc ?? (cashUsdNum != null ? fmtUsd(cashUsdNum) : '—')}
              sub={portfolioMode === 'live' ? 'USDC on CLOB' : 'Practice USDC'}
              accent="emerald"
              badge={
                <span
                  className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                    portfolioMode === 'live' ? 'bg-sky-950/60 text-sky-300' : 'bg-amber-950/55 text-amber-200'
                  }`}
                >
                  {portfolioMode}
                </span>
              }
            />
            <TrackingKpiTile
              label="Equity"
              value={fmtUsd(equityUsd)}
              sub={equityUsd != null ? 'Shares × mark' : 'Awaiting mid'}
              accent="zinc"
            />
            <TrackingKpiTile
              label="Total"
              value={fmtUsd(totalValueUsd)}
              sub={totalValueUsd != null ? 'Cash + equity' : '—'}
              accent="sky"
            />
            <TrackingKpiTile
              label="Unrealized P&L"
              value={fmtUsd(totalUnrealizedUsd, { signed: true })}
              sub={totalUnrealizedPct != null ? fmtPct(totalUnrealizedPct, { signed: true }) : 'Awaiting mid'}
              accent="zinc"
              valueClass={pnlTone(totalUnrealizedUsd)}
            />
          </div>

          <div className="overflow-hidden rounded-xl border border-zinc-800/55 bg-zinc-950/35">
            <div className="hidden grid-cols-[minmax(120px,1.4fr)_repeat(5,minmax(70px,1fr))_auto] items-center gap-3 border-b border-zinc-800/60 bg-black/30 px-3 py-2 text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500 md:grid">
              <span>Outcome</span>
              <span className="text-right">Shares</span>
              <span className="text-right">Avg</span>
              <span className="text-right">Mark</span>
              <span className="text-right">Notional</span>
              <span className="text-right">Unrealized</span>
              <span className="text-right">Actions</span>
            </div>
            <div className="divide-y divide-zinc-800/60">
              {positionRow(upLabel, upToken, upPos, upMetrics, upMark, noteDraftUp, setNoteDraftUp, 'up')}
              {positionRow(downLabel, downToken, downPos, downMetrics, downMark, noteDraftDown, setNoteDraftDown, 'down')}
            </div>
          </div>

          {(upPos.shares == null || upPos.shares <= 0) && (downPos.shares == null || downPos.shares <= 0) ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-zinc-800/60 bg-zinc-950/30 px-3 py-2 text-[12px] text-zinc-500">
              <span>
                No {portfolioMode === 'live' ? 'live' : 'paper'} positions for this market yet.
              </span>
              {onOpenSignals ? (
                <button
                  type="button"
                  onClick={onOpenSignals}
                  className="rounded-md border border-sky-800/45 bg-sky-950/25 px-2 py-1 text-[11px] font-semibold text-sky-100 hover:bg-sky-950/40"
                >
                  Buy from Signals →
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {subTab === 'orders' ? (
        <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/40 p-4 ring-1 ring-white/[0.02]">
          {portfolioMode === 'live' ? openOrdersLiveBody : openOrdersPaperBody}
        </div>
      ) : null}

      {subTab === 'history' ? (
        <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/40 p-4 ring-1 ring-white/[0.02]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-sm font-semibold text-zinc-100">This market (local log)</div>
              <div className="mt-1 text-[11px] text-zinc-500">
                {portfolioMode === 'live'
                  ? 'Live trades recorded in this app for Up/Down tokens (not the full CLOB export).'
                  : 'Paper trades for Up/Down tokens from practice mode.'}
              </div>
            </div>
            {onOpenTradeHistory ? (
              <button
                type="button"
                onClick={onOpenTradeHistory}
                className="rounded-xl border border-zinc-700/50 bg-black/20 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-black/30"
              >
                Open full trade history
              </button>
            ) : null}
          </div>
          {historyRows.length === 0 ? (
            <div className="mt-4 rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-6 text-center text-[12px] text-zinc-500">
              No {portfolioMode === 'live' ? 'live' : 'paper'} rows for these tokens yet.
            </div>
          ) : (
            <div className="mt-4 max-h-[min(60vh,520px)] overflow-auto rounded-xl border border-zinc-800/50">
              <table className="w-full min-w-[640px] border-collapse text-left text-[11px]">
                <thead className="sticky top-0 z-[1] bg-zinc-950/95 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2">Side</th>
                    <th className="px-3 py-2">Outcome</th>
                    <th className="px-3 py-2 text-right">Shares</th>
                    <th className="px-3 py-2 text-right">Fill ¢</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {historyRows.map((r) => (
                    <tr key={r.id} className="border-t border-zinc-900/70 text-zinc-300">
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-zinc-500">{fmtHistoryTime(r.ts)}</td>
                      <td className={`px-3 py-2 font-bold ${r.side === 'buy' ? 'text-emerald-200' : 'text-rose-200'}`}>{r.side}</td>
                      <td className="px-3 py-2">{r.label || '—'}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">{r.shares == null ? '—' : r.shares.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums">
                        {r.fillAvgPrice01 == null ? '—' : `${(r.fillAvgPrice01 * 100).toFixed(1)}¢`}
                      </td>
                      <td className="px-3 py-2 text-zinc-400">{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {subTab === 'automations' ? (
        <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/40 p-4 text-[13px] leading-relaxed text-zinc-400 ring-1 ring-white/[0.02]">
          <div className="text-sm font-semibold text-zinc-100">Automations</div>
          <p className="mt-2">
            Stop-loss and take-profit brackets are armed from the <span className="text-zinc-200">Signals</span> trade panel (live or paper). Use{' '}
            <span className="text-zinc-200">Positions → Clear SL / TP</span> here to remove saved bracket prefs for that token without placing a trade.
          </p>
          {onOpenSignals ? (
            <button
              type="button"
              onClick={onOpenSignals}
              className="mt-4 rounded-xl border border-sky-800/40 bg-sky-950/20 px-3 py-2 text-xs font-semibold text-sky-100 hover:bg-sky-950/35"
            >
              Go to Signals (trade + TP/SL)
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
