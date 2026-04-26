import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { rtdsCrypto, type ApiErr, type ApiOk } from './lib/api';
import {
  cryptoMarkToMarket,
  cryptoPaperTradeAndPersist,
  loadCryptoPaperAccount,
  resetCryptoPaperAccount,
  type CryptoPaperAccount,
} from './cryptoPaperTrading';

function isOk<T>(res: ApiOk<T> | ApiErr): res is ApiOk<T> {
  return (res as ApiOk<T>).ok === true && 'data' in (res as ApiOk<T>);
}

function fmtUsd(cents: number): string {
  const s = (cents / 100).toFixed(2);
  return `${cents < 0 ? '-' : ''}$${s.replace(/^-/, '')}`;
}

function fmtBtc(qty: number): string {
  const v = Number(qty);
  if (!Number.isFinite(v)) return '0';
  return v.toFixed(8).replace(/\.?0+$/, '');
}

const SYMBOL = 'BTC-USD';
const RTDS_SYMBOL = 'btc/usd';

export function BtcSpotPaperTest(): ReactElement {
  const [account, setAccount] = useState<CryptoPaperAccount>(() => loadCryptoPaperAccount());
  const [spotUsd, setSpotUsd] = useState<number | null>(null);
  const [spotAt, setSpotAt] = useState<number | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastFetchAtRef = useRef<number>(0);

  const mtm = useMemo(() => cryptoMarkToMarket({ account, symbol: SYMBOL, midUsd: spotUsd }), [account, spotUsd]);

  useEffect(() => {
    let stopped = false;
    let inflight = false;
    const tick = async () => {
      if (stopped || inflight) return;
      inflight = true;
      try {
        const res = await rtdsCrypto(RTDS_SYMBOL);
        if (!isOk(res)) {
          setErr(`RTDS error: ${res.error}`);
          return;
        }
        setErr(null);
        setSpotUsd(Number(res.data.value));
        setSpotAt(Number(res.data.ts));
        setSource(String(res.data.source ?? ''));
        lastFetchAtRef.current = Date.now();
      } finally {
        inflight = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1_000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, []);

  const trade = async (side: 'buy' | 'sell', qty: number) => {
    const px = spotUsd;
    if (px == null || !Number.isFinite(px) || px <= 0) {
      setErr('No spot price yet.');
      return;
    }
    setBusy(true);
    try {
      const r = cryptoPaperTradeAndPersist({ account, symbol: SYMBOL, side, qty, priceUsd: px, now: Date.now() });
      if (!r.ok) {
        setErr(r.error);
        return;
      }
      setErr(null);
      setAccount(r.account);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-5 max-w-3xl">
      <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/20 p-4 ring-1 ring-white/[0.02]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">BTC spot (live)</div>
            <div className="mt-1 text-lg font-semibold text-zinc-100">
              {spotUsd == null ? '—' : `$${spotUsd.toFixed(2)}`}
              <span className="ml-2 text-xs font-medium text-zinc-500">
                {source ? `(${source})` : ''}
                {spotAt ? ` · ${new Date(spotAt).toLocaleTimeString()}` : ''}
              </span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Paper account</div>
            <div className="mt-1 text-sm text-zinc-200">
              Cash <span className="font-semibold">{fmtUsd(account.cashUsdCents)}</span> · Equity{' '}
              <span className="font-semibold">{fmtUsd(mtm.equityUsdCents)}</span>
            </div>
            <div className="mt-1 text-xs text-zinc-500">
              Unrealized {fmtUsd(mtm.unrealizedPnlUsdCents)} · Realized {fmtUsd(mtm.realizedPnlUsdCents)}
            </div>
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-zinc-800/50 bg-black/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-zinc-200">
              Position <span className="font-semibold">{fmtBtc(mtm.posQty)} BTC</span>
              {mtm.posAvgUsd != null ? (
                <span className="ml-2 text-xs text-zinc-500">avg ${mtm.posAvgUsd.toFixed(2)}</span>
              ) : (
                <span className="ml-2 text-xs text-zinc-600">avg —</span>
              )}
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => setAccount(resetCryptoPaperAccount())}
              className="rounded-lg border border-zinc-800/70 bg-zinc-950/30 px-3 py-1.5 text-[11px] font-semibold text-zinc-300 hover:bg-zinc-900/40 disabled:opacity-40"
              title="Reset BTC paper account"
            >
              Reset
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void trade('buy', 0.001)}
              className="rounded-xl bg-emerald-600/90 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-emerald-950/30 hover:bg-emerald-500 disabled:opacity-40"
              title="Paper BUY 0.001 BTC at current spot"
            >
              Buy 0.001 BTC
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void trade('buy', 0.01)}
              className="rounded-xl bg-emerald-600/25 px-4 py-2 text-xs font-semibold text-emerald-100 ring-1 ring-emerald-700/40 hover:bg-emerald-600/35 disabled:opacity-40"
              title="Paper BUY 0.01 BTC at current spot"
            >
              Buy 0.01 BTC
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void trade('sell', 0.001)}
              className="rounded-xl bg-rose-600/90 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-rose-950/30 hover:bg-rose-500 disabled:opacity-40"
              title="Paper SELL 0.001 BTC at current spot"
            >
              Sell 0.001 BTC
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void trade('sell', 0.01)}
              className="rounded-xl bg-rose-600/25 px-4 py-2 text-xs font-semibold text-rose-100 ring-1 ring-rose-700/40 hover:bg-rose-600/35 disabled:opacity-40"
              title="Paper SELL 0.01 BTC at current spot"
            >
              Sell 0.01 BTC
            </button>
          </div>
        </div>

        {err ? <div className="mt-3 whitespace-pre-wrap text-xs text-rose-200/90">{err}</div> : null}
        <div className="mt-2 text-[11px] text-zinc-600">
          This is a live BTC price feed + paper fills at spot. No real exchange orders are placed yet.
          <span className="ml-2 text-zinc-700">
            (last fetch {lastFetchAtRef.current ? `${Math.max(0, Math.round((Date.now() - lastFetchAtRef.current) / 1000))}s ago` : '—'})
          </span>
        </div>
      </div>
    </div>
  );
}

