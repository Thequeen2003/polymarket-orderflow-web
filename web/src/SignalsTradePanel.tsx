import { type ReactElement, useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { ApiErr } from './lib/api';
import { tradeAvgEntry, tradeBalanceAllowance, tradeCreateOrder, tradeMarketOrder, tradeUpdateBalanceAllowance } from './lib/api';
import { TradeSegmentedControl } from './tradeUi';

function isOk<T>(res: { ok: boolean } & Record<string, unknown>): res is { ok: true; data: T } {
  return res.ok === true;
}

function parseBalance(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function fmtCents(p01: number | null): string {
  return p01 == null ? '—' : `${(p01 * 100).toFixed(1)}¢`;
}

const SHARES_FMT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const SHARES_COMPACT_FMT = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 2,
});

function fmtShares(shares: number | null, style: 'full' | 'compact' = 'compact'): string {
  if (shares == null) return '—';
  if (!Number.isFinite(shares)) return '—';
  const abs = Math.abs(shares);
  if (style === 'compact' && abs >= 10_000) return SHARES_COMPACT_FMT.format(shares);
  return SHARES_FMT.format(shares);
}

export type SignalsTradePanelProps = {
  upLabel: string;
  downLabel: string;
  upToken: string;
  downToken: string;
  upMid: number | null;
  downMid: number | null;
  lane?: 'up' | 'down';
  onLaneChange?: (lane: 'up' | 'down') => void;
  visualStyle?: 'default' | 'sidebar';
};

/**
 * Signals tab: order entry (buy/sell, market/limit, amounts) against Polymarket CLOB via API.
 */
export function SignalsTradePanel(props: SignalsTradePanelProps): ReactElement {
  const { upLabel, downLabel, upToken, downToken, upMid, downMid, lane: controlledLane, onLaneChange, visualStyle = 'default' } = props;
  const idBase = useId();
  const idAmount = `${idBase}-amount`;
  const idLimitBuy = `${idBase}-limit-buy`;
  const idLimitSell = `${idBase}-limit-sell`;
  const idSellQty = `${idBase}-sell-qty`;

  const [action, setAction] = useState<'buy' | 'sell'>('buy');
  const [laneState, setLaneState] = useState<'up' | 'down'>(controlledLane ?? 'up');
  const [mode, setMode] = useState<'market' | 'limit'>('market');
  const [unit, setUnit] = useState<'dollars' | 'shares'>('dollars');

  const [amount, setAmount] = useState('10');
  const [sellQty, setSellQty] = useState('');
  const [limitPriceCents, setLimitPriceCents] = useState('');

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [availUsdc, setAvailUsdc] = useState<number | null>(null);
  const [balUp, setBalUp] = useState<number | null>(null);
  const [balDown, setBalDown] = useState<number | null>(null);
  const [balLoading, setBalLoading] = useState(false);
  const [balError, setBalError] = useState<string | null>(null);
  const [avgEntryUp, setAvgEntryUp] = useState<number | null>(null);
  const [avgEntryDown, setAvgEntryDown] = useState<number | null>(null);

  const lane = controlledLane ?? laneState;
  const token = lane === 'up' ? upToken : downToken;
  const label = lane === 'up' ? upLabel : downLabel;
  const mid = lane === 'up' ? upMid : downMid;

  const positionShares = lane === 'up' ? balUp : balDown;
  const avgEntry = lane === 'up' ? avgEntryUp : avgEntryDown;

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

  useEffect(() => {
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
        if (isOk(rC)) setAvailUsdc(parseBalance(rC.data.balance));
        else setAvailUsdc(null);
        if (isOk(rU)) setBalUp(parseBalance(rU.data.balance));
        else setBalUp(null);
        if (isOk(rD)) setBalDown(parseBalance(rD.data.balance));
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
  }, [upToken, downToken]);

  useEffect(() => {
    if (!upToken || !downToken) return;
    let cancelled = false;
    void (async () => {
      try {
        const [u, d] = await Promise.all([tradeAvgEntry(upToken), tradeAvgEntry(downToken)]);
        if (cancelled) return;
        if (isOk(u)) setAvgEntryUp(u.data.avgEntry);
        if (isOk(d)) setAvgEntryDown(d.data.avgEntry);
      } catch {
        // Non-fatal: avg entry is optional UI detail.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [upToken, downToken]);

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
    setBusy(true);
    try {
      await tradeUpdateBalanceAllowance({ assetType: 'collateral' });
      const res = await tradeBalanceAllowance({ assetType: 'collateral' });
      if (!isOk(res)) {
        setErr('Could not read USDC balance.');
        return;
      }
      const usdc = parseBalance(res.data.balance);
      setAvailUsdc(usdc);
      if (usdc == null) return;
      if (unit === 'dollars') {
        const v = Math.floor(usdc * 100) / 100;
        setAmount(v > 0 ? String(v) : '0');
      } else if (mid != null && mid > 0) {
        const sh = usdc / mid;
        const v = Math.floor(sh * 1e4) / 1e4;
        setAmount(v > 0 ? String(v) : '0');
      }
    } finally {
      setBusy(false);
    }
  }, [mid, unit]);

  const refreshPositionAndMaxSell = useCallback(async () => {
    if (!token) return;
    setErr(null);
    setBusy(true);
    try {
      await tradeUpdateBalanceAllowance({ tokenId: token, assetType: 'conditional' });
      const res = await tradeBalanceAllowance({ tokenId: token, assetType: 'conditional' });
      if (!isOk(res)) {
        setErr('Could not read this outcome position.');
        return;
      }
      const sh = parseBalance(res.data.balance);
      if (token === upToken) setBalUp(sh);
      else if (token === downToken) setBalDown(sh);
      if (sh == null || sh <= 0) {
        setSellQty('0');
        return;
      }
      const v = Math.floor(sh * 1e4) / 1e4;
      setSellQty(v > 0 ? String(v) : '0');
    } finally {
      setBusy(false);
    }
  }, [token, upToken, downToken]);

  const applyPct = useCallback(
    (pct: number) => {
      if (positionShares == null || positionShares <= 0) return;
      const v = Math.floor(positionShares * pct * 1e4) / 1e4;
      setSellQty(v > 0 ? String(v) : '0');
    },
    [positionShares],
  );

  const limitCents = Number(limitPriceCents || defaultLimitCents);
  const limit01 = Number.isFinite(limitCents) ? Math.min(0.99, Math.max(0.01, limitCents / 100)) : null;

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

  const maxSellStr = positionShares != null && positionShares > 0 ? fmtShares(positionShares, 'compact') : balLoading ? '…' : '—';

  const maxBuyDisabledReason =
    unit === 'shares' && (mid == null || mid <= 0)
      ? 'Need a valid mid to convert USDC to shares for Max'
      : undefined;

  const runMarketSell = async (shares: number) => {
    if (!Number.isFinite(shares) || shares <= 0) return;
    const res = await tradeMarketOrder({ token, side: 'sell', amount: shares, signatureType: null });
    if (!isOk(res)) {
      const e = res as ApiErr;
      setErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
    } else {
      setOkMsg(`Sold ${shares.toFixed(2)} shares of ${label}`);
      setSellQty('');
      void (async () => {
        const r = await tradeBalanceAllowance({ tokenId: token, assetType: 'conditional' });
        if (isOk(r)) {
          const sh = parseBalance(r.data.balance);
          if (token === upToken) setBalUp(sh);
          else if (token === downToken) setBalDown(sh);
        }
      })();
    }
  };

  const dismissOk = () => setOkMsg(null);
  const isSidebar = visualStyle === 'sidebar';

  return (
    <div
      className={`border ring-1 ring-white/[0.04] ${
        isSidebar
          ? 'rounded-[28px] border-zinc-800/80 bg-[#0d1219] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.35)]'
          : 'rounded-2xl border-zinc-800/60 bg-gradient-to-b from-zinc-950/90 to-zinc-950/50 p-4 sm:p-5'
      }`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-zinc-100">Trade</h1>
          <p className="mt-0.5 text-[11px] text-zinc-500">Order type · outcome · size · review</p>
        </div>
        <div className="inline-flex rounded-xl border border-zinc-800/70 bg-black/30 p-1 shadow-inner shadow-black/40">
          <button
            type="button"
            onClick={() => chooseAction('buy')}
            className={`min-h-[44px] min-w-[5.5rem] rounded-lg px-4 py-2.5 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
              action === 'buy' ? 'bg-emerald-500 text-black shadow-sm' : 'text-zinc-400 hover:text-zinc-100'
            }`}
          >
            Buy
          </button>
          <button
            type="button"
            onClick={() => chooseAction('sell')}
            className={`min-h-[44px] min-w-[5.5rem] rounded-lg px-4 py-2.5 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/50 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
              action === 'sell' ? 'bg-rose-500 text-black shadow-sm' : 'text-zinc-400 hover:text-zinc-100'
            }`}
          >
            Sell
          </button>
        </div>
      </div>

      {balError ? (
        <div className="mt-4 rounded-lg border border-amber-800/35 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-100/90">{balError}</div>
      ) : null}

      {/* Outcome */}
      <div className="mt-6">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Outcome</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => chooseLane('up')}
            className={`rounded-xl border px-4 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
              lane === 'up'
                ? 'border-emerald-500/80 bg-emerald-950/35 ring-2 ring-emerald-500/30'
                : 'border-zinc-800/70 bg-black/20 hover:bg-black/30'
            }`}
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{upLabel}</div>
            <div className="mt-1 text-2xl font-black tabular-nums text-emerald-100">{fmtCents(upMid)}</div>
            <div className="mt-1 text-[11px] text-zinc-500">
              You hold{' '}
              <span className="font-mono text-zinc-300">{balUp != null ? `${balUp.toFixed(2)} sh` : balLoading ? '…' : '—'}</span>
            </div>
          </button>
          <button
            type="button"
            onClick={() => chooseLane('down')}
            className={`rounded-xl border px-4 py-3.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 ${
              lane === 'down'
                ? 'border-rose-500/75 bg-rose-950/25 ring-2 ring-rose-500/25'
                : 'border-zinc-800/70 bg-black/20 hover:bg-black/30'
            }`}
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{downLabel}</div>
            <div className="mt-1 text-2xl font-black tabular-nums text-zinc-100">{fmtCents(downMid)}</div>
            <div className="mt-1 text-[11px] text-zinc-500">
              You hold{' '}
              <span className="font-mono text-zinc-300">{balDown != null ? `${balDown.toFixed(2)} sh` : balLoading ? '…' : '—'}</span>
            </div>
          </button>
        </div>
      </div>

      {action === 'buy' ? (
        <>
          <div className="mt-6 space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Execution</div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <TradeSegmentedControl
                value={mode}
                onChange={(v) => {
                  setMode(v as 'market' | 'limit');
                  setErr(null);
                  setOkMsg(null);
                }}
                options={[
                  { value: 'market', label: 'Market' },
                  { value: 'limit', label: 'Limit' },
                ]}
              />
              <p className="text-[11px] text-zinc-500">
                {mode === 'market' ? 'Fills at best available prices now.' : 'Rests on the book until filled or canceled.'}
              </p>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-end justify-between gap-2 text-xs text-zinc-400">
            <span className="font-semibold text-zinc-300">Size</span>
            <span className="font-mono text-zinc-500" title="USDC available for buys">
              {balLoading ? 'Loading…' : availUsdc != null ? `Cash $${availUsdc.toFixed(2)}` : 'Cash —'}
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
              disabled={busy || !availUsdc || (unit === 'shares' && (mid == null || mid <= 0))}
              aria-busy={busy}
              title={maxBuyDisabledReason}
              className="min-h-[40px] rounded-lg border border-zinc-600/80 bg-zinc-900/60 px-4 py-2 text-xs font-semibold text-zinc-100 hover:bg-zinc-800/80 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Max
            </button>
          </div>

          {mode === 'limit' ? (
            <div className="mt-4">
              <label htmlFor={idLimitBuy} className="text-xs font-semibold text-zinc-400">
                Limit price (¢)
              </label>
              <div className="mt-1 rounded-xl border border-zinc-800/70 bg-black/25 px-3 py-3 focus-within:border-zinc-600/70">
                <input
                  id={idLimitBuy}
                  value={limitPriceCents}
                  onChange={(e) => setLimitPriceCents(e.target.value)}
                  inputMode="numeric"
                  aria-describedby={`${idLimitBuy}-hint`}
                  className="min-h-[44px] w-full bg-transparent text-lg font-semibold tabular-nums text-zinc-100 outline-none"
                  placeholder={defaultLimitCents || '50'}
                />
              </div>
              <p id={`${idLimitBuy}-hint`} className="mt-1 text-[11px] text-zinc-500">
                Limit buy fills when the book crosses ≤ {limitPriceCents || defaultLimitCents || '—'}¢
              </p>
            </div>
          ) : null}

          <div className="mt-4 rounded-xl border border-zinc-800/70 bg-black/20 p-3 text-sm text-zinc-300">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Review</div>
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
            <div className="mt-2 flex items-center justify-between">
              <div className="text-zinc-500">Potential payout</div>
              <div className="font-mono tabular-nums text-emerald-200">{payout == null ? '—' : `$${payout.toFixed(2)}`}</div>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="text-zinc-500">Potential profit</div>
              <div className="font-mono tabular-nums text-emerald-200">{profit == null ? '—' : `$${profit.toFixed(2)}`}</div>
            </div>
          </div>

          <button
            type="button"
            disabled={busy || !amtOk || (mode === 'limit' && (limit01 == null || !Number.isFinite(limit01)))}
            aria-busy={busy}
            className="mt-4 min-h-[52px] w-full rounded-xl bg-emerald-400 px-4 py-3 text-sm font-bold text-black shadow-lg shadow-emerald-950/30 hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={async () => {
              setErr(null);
              setOkMsg(null);
              setBusy(true);
              try {
                if (mode === 'market') {
                  const amountUsd = unit === 'dollars' ? amtNum : mid != null ? amtNum * mid : NaN;
                  const res = await tradeMarketOrder({ token, side: 'buy', amount: amountUsd, signatureType: null });
                  if (!isOk(res)) {
                    const e = res as ApiErr;
                    setErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
                  } else setOkMsg(`Bought ~$${amountUsd.toFixed(2)} of ${label}`);
                } else {
                  const price = limit01 ?? NaN;
                  const sizeShares = unit === 'shares' ? amtNum : price > 0 ? amtNum / price : NaN;
                  const res = await tradeCreateOrder({ token, side: 'buy', price, size: sizeShares, signatureType: null });
                  if (!isOk(res)) {
                    const e = res as ApiErr;
                    setErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
                  } else setOkMsg(`Limit buy ${label} ${sizeShares.toFixed(2)} @ ${(price * 100).toFixed(1)}¢`);
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Submitting…' : `Buy ${label}`}
          </button>
        </>
      ) : (
        <>
          <div className="mt-6 space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Execution</div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <TradeSegmentedControl
                value={mode}
                onChange={(v) => {
                  setMode(v as 'market' | 'limit');
                  setErr(null);
                  setOkMsg(null);
                }}
                options={[
                  { value: 'market', label: 'Market' },
                  { value: 'limit', label: 'Limit' },
                ]}
              />
              <p className="text-[11px] text-zinc-500">
                {mode === 'market' ? 'Sell immediately at best bid.' : 'Place a limit sell on the book.'}
              </p>
            </div>
          </div>

          <div className="mt-4 rounded-xl border border-zinc-800/70 bg-black/20 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Position</div>
            <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-sm text-zinc-200">
                {positionShares != null ? (
                  <>
                    <span className="font-mono text-lg font-bold tabular-nums" title={`${fmtShares(positionShares, 'full')} shares`}>
                      {fmtShares(positionShares, 'compact')}
                      <span className="ml-1 text-xs font-semibold text-zinc-500">sh</span>
                    </span>
                    <span className={`ml-1.5 font-medium ${lane === 'up' ? 'text-emerald-300' : 'text-rose-300'}`}>
                      {lane === 'up' ? upLabel : downLabel}
                    </span>
                  </>
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

            {mode === 'limit' ? (
              <div className="mt-3">
                <label htmlFor={idLimitSell} className="text-xs font-semibold text-zinc-400">
                  Limit price (¢)
                </label>
                <div className="mt-1 rounded-lg border border-zinc-800/70 bg-black/20 px-3 py-2.5">
                  <input
                    id={idLimitSell}
                    value={limitPriceCents}
                    onChange={(e) => setLimitPriceCents(e.target.value)}
                    inputMode="numeric"
                    className="min-h-[40px] w-full bg-transparent text-base font-semibold tabular-nums text-zinc-100 outline-none"
                    placeholder={defaultLimitCents || '50'}
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
                    disabled={busy}
                    aria-busy={busy}
                    className="min-h-[48px] min-w-[4.5rem] rounded-xl border border-zinc-600/80 bg-zinc-900/70 px-4 text-sm font-semibold text-zinc-100 hover:bg-zinc-800 disabled:opacity-40"
                  >
                    Max
                  </button>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      sellSharesClamped == null ||
                      sellSharesClamped <= 0 ||
                      (mode === 'limit' && (limit01 == null || !Number.isFinite(limit01)))
                    }
                    aria-busy={busy}
                    className="min-h-[48px] min-w-[6rem] rounded-xl bg-rose-500 px-4 text-sm font-bold text-black shadow-md shadow-rose-950/40 hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={async () => {
                      setErr(null);
                      setOkMsg(null);
                      if (sellSharesClamped == null || sellSharesClamped <= 0) return;
                      setBusy(true);
                      try {
                        if (mode === 'market') {
                          await runMarketSell(sellSharesClamped);
                        } else {
                          const price = limit01 ?? NaN;
                          const res = await tradeCreateOrder({
                            token,
                            side: 'sell',
                            price,
                            size: sellSharesClamped,
                            signatureType: null,
                          });
                          if (!isOk(res)) {
                            const e = res as ApiErr;
                            setErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
                          } else setOkMsg(`Limit sell ${label} ${sellSharesClamped.toFixed(2)} @ ${(price * 100).toFixed(1)}¢`);
                        }
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {busy ? '…' : `Sell ${label}`}
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
                    disabled={!can || busy}
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
                busy ||
                positionShares == null ||
                positionShares <= 0 ||
                (mode === 'limit' && (limit01 == null || !Number.isFinite(limit01)))
              }
              aria-busy={busy}
              className="mt-4 min-h-[48px] w-full rounded-xl border-2 border-rose-600/50 bg-transparent px-4 py-3 text-sm font-bold text-rose-200 hover:bg-rose-950/35 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={async () => {
                setErr(null);
                setOkMsg(null);
                if (positionShares == null || positionShares <= 0) return;
                setBusy(true);
                try {
                  if (mode === 'market') {
                    await runMarketSell(positionShares);
                  } else {
                    const price = limit01 ?? NaN;
                    const res = await tradeCreateOrder({
                      token,
                      side: 'sell',
                      price,
                      size: positionShares,
                      signatureType: null,
                    });
                    if (!isOk(res)) {
                      const e = res as ApiErr;
                      setErr(`${e.error}${e.details ? ` · ${JSON.stringify(e.details)}` : ''}`);
                    } else setOkMsg(`Limit sell all ${label} ${positionShares.toFixed(2)} @ ${(price * 100).toFixed(1)}¢`);
                  }
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? 'Submitting…' : `Sell entire position (${fmtShares(positionShares, 'compact')} sh)`}
            </button>
          </div>
        </>
      )}

      {err ? (
        <div role="alert" className="mt-4 rounded-lg border border-rose-800/35 bg-rose-950/15 px-3 py-2.5 text-[11px] text-rose-100">
          <span className="mr-1.5 font-bold">Error.</span>
          {err}
        </div>
      ) : null}
      {okMsg ? (
        <div
          className="mt-4 flex items-start justify-between gap-2 rounded-lg border border-emerald-800/30 bg-emerald-950/15 px-3 py-2.5 text-[11px] text-emerald-100"
          aria-live="polite"
        >
          <span>
            <span className="font-bold text-emerald-200">Done.</span> {okMsg}
          </span>
          <button
            type="button"
            onClick={dismissOk}
            className="shrink-0 rounded px-1.5 text-zinc-500 hover:bg-emerald-950/40 hover:text-zinc-300"
            aria-label="Dismiss success message"
          >
            ×
          </button>
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
