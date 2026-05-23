import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { binanceAggTrades, binanceDepth, type ApiErr, type ApiOk, type BinanceAggTrade, type ClobBookEntry } from './lib/api';
import { bookIntelLines, computeBookIntel } from './bookIntel';
import { displayPrice, midPrice, pickBookLevels, topOfBook, type BookLevel } from './bookLevels';
import { outcomeEntryExitHints } from './chartReadouts';
import { MomentumChart, type SeriesPoint } from './MomentumChart';
import { OrderFlowChart } from './OrderFlowChart';
import { snapshotFromBook, type BookSnapshot } from './orderflowMetrics';
import { TradeSegmentedControl } from './tradeUi';

function isOk<T>(x: unknown): x is ApiOk<T> {
  return typeof x === 'object' && x !== null && (x as { ok?: boolean }).ok === true && 'data' in (x as object);
}

function prettyErr(res: ApiErr): string {
  return JSON.stringify(res.details ?? res);
}

const SPOT_TOKEN = 'binance:BTCUSDT:depth';

type MainTabLite = 'book' | 'flowzones' | 'signals' | string;

function SpotLadders(props: { bids: BookLevel[]; asks: BookLevel[] }): ReactElement {
  const { bids, asks } = props;
  return (
    <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-sky-900/40 bg-sky-950/15 p-4 ring-1 ring-sky-500/10">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-sky-200/90">Bids</div>
        <div className="mt-2 max-h-72 overflow-auto rounded-xl border border-zinc-800/50 bg-black/20">
          <div className="grid grid-cols-[1fr_auto] gap-x-3 border-b border-zinc-800/50 bg-zinc-900/40 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            <span>Price (USDT)</span>
            <span className="text-right">Size</span>
          </div>
          {bids.slice(0, 32).map((l, i) => (
            <div
              key={`b-${i}-${l.price}`}
              className={`grid grid-cols-[1fr_auto] gap-x-3 border-b border-zinc-800/20 px-3 py-1 font-mono text-[12px] tabular-nums last:border-b-0 ${
                i % 2 === 0 ? 'bg-transparent' : 'bg-zinc-900/15'
              }`}
            >
              <span className="text-sky-100/95">{displayPrice(l.price)}</span>
              <span className="text-right text-zinc-400">{l.size.toFixed(5).replace(/\.?0+$/, '')}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-2xl border border-emerald-900/40 bg-emerald-950/15 p-4 ring-1 ring-emerald-500/10">
        <div className="text-[12px] font-semibold uppercase tracking-wide text-emerald-200/90">Asks</div>
        <div className="mt-2 max-h-72 overflow-auto rounded-xl border border-zinc-800/50 bg-black/20">
          <div className="grid grid-cols-[1fr_auto] gap-x-3 border-b border-zinc-800/50 bg-zinc-900/40 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            <span>Price (USDT)</span>
            <span className="text-right">Size</span>
          </div>
          {asks.slice(0, 32).map((l, i) => (
            <div
              key={`a-${i}-${l.price}`}
              className={`grid grid-cols-[1fr_auto] gap-x-3 border-b border-zinc-800/20 px-3 py-1 font-mono text-[12px] tabular-nums last:border-b-0 ${
                i % 2 === 0 ? 'bg-transparent' : 'bg-zinc-900/15'
              }`}
            >
              <span className="text-emerald-100/95">{displayPrice(l.price)}</span>
              <span className="text-right text-zinc-400">{l.size.toFixed(5).replace(/\.?0+$/, '')}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function BinanceBtcUsdtMarketView(props: {
  mainTab: MainTabLite;
  chartEnabled: boolean;
  setChartEnabled: (v: boolean | ((b: boolean) => boolean)) => void;
  flowMode: 'price' | 'flow';
  setFlowMode: (v: 'price' | 'flow') => void;
  onClose: () => void;
}): ReactElement {
  const { mainTab, chartEnabled, setChartEnabled, flowMode, setFlowMode, onClose } = props;

  const [books, setBooks] = useState<ClobBookEntry[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bidSeries, setBidSeries] = useState<SeriesPoint[]>([]);
  const [askSeries, setAskSeries] = useState<SeriesPoint[]>([]);
  const [flowSeries, setFlowSeries] = useState<BookSnapshot[]>([]);
  const [trades, setTrades] = useState<BinanceAggTrade[]>([]);
  const prevMapsRef = useRef<{ bids: Map<string, number>; asks: Map<string, number> } | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const poll = useCallback(async () => {
    const dRes = await binanceDepth('BTCUSDT', 80);
    if (!isOk(dRes)) {
      setErr(prettyErr(dRes as ApiErr));
      return;
    }
    setErr(null);
    const bookObj = { bids: dRes.data.bids, asks: dRes.data.asks };
    const ts = Date.now();
    setBooks([{ token: SPOT_TOKEN, book: bookObj, error: null }]);
    setFetchedAt(ts);

    const tob = topOfBook(bookObj);
    setBidSeries((prev) => [...prev, { t: ts, v: tob.bestBid }].slice(-180));
    setAskSeries((prev) => [...prev, { t: ts, v: tob.bestAsk }].slice(-180));

    const { snap, next } = snapshotFromBook(bookObj, ts, prevMapsRef.current);
    prevMapsRef.current = next;
    setFlowSeries((prev) => [...prev, snap].slice(-360));

    const tRes = await binanceAggTrades('BTCUSDT', 100);
    if (isOk(tRes)) setTrades(Array.isArray(tRes.data) ? tRes.data : []);
  }, []);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      await poll();
    };
    void tick();
    const id = window.setInterval(() => void tick(), 2_000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [poll]);

  const entry = books?.[0] ?? null;
  const parsed = useMemo(() => (entry && !entry.error ? pickBookLevels(entry.book) : { bids: [], asks: [] }), [entry]);
  const mid = entry && !entry.error ? midPrice(entry.book) : null;
  const tob = entry && !entry.error ? topOfBook(entry.book) : null;
  const intel = useMemo(() => (entry && !entry.error ? computeBookIntel(entry.book) : null), [entry]);

  const flowForChart = useMemo(() => flowSeries, [flowSeries]);

  const buyAgg = useMemo(() => trades.filter((t) => !t.buyerMaker).length, [trades]);
  const sellAgg = useMemo(() => trades.filter((t) => t.buyerMaker).length, [trades]);

  const lastSnap = flowSeries.length ? flowSeries[flowSeries.length - 1]! : null;

  const feedBadge = useMemo(() => {
    if (err) {
      return { label: 'Depth error', cls: 'border-rose-700/45 bg-rose-950/25 text-rose-100/90' };
    }
    if (fetchedAt == null) {
      return { label: 'Connecting…', cls: 'border-zinc-600/50 bg-zinc-900/50 text-zinc-400' };
    }
    const age = nowTick - fetchedAt;
    if (age < 6_000) {
      return { label: 'Data stable', cls: 'border-emerald-700/45 bg-emerald-950/30 text-emerald-100/95' };
    }
    if (age < 18_000) {
      return { label: 'Data aging', cls: 'border-amber-700/40 bg-amber-950/25 text-amber-100/90' };
    }
    return { label: 'Stale — check API / network', cls: 'border-rose-700/45 bg-rose-950/25 text-rose-100/90' };
  }, [err, fetchedAt, nowTick]);

  if (mainTab !== 'book' && mainTab !== 'flowzones' && mainTab !== 'signals') {
    return (
      <div className="mt-5 rounded-2xl border border-zinc-800/50 bg-zinc-950/30 p-4 text-sm text-zinc-500">
        Binance BTC/USDT spot workspace is active — use <span className="font-medium text-zinc-300">Book</span>,{' '}
        <span className="font-medium text-zinc-300">Flow</span>, or <span className="font-medium text-zinc-300">Signals</span> for this market.
        <button
          type="button"
          onClick={onClose}
          className="ml-3 rounded-lg border border-cyan-800/50 bg-cyan-950/30 px-2 py-1 text-xs font-semibold text-cyan-100 hover:bg-cyan-950/45"
        >
          Exit spot market
        </button>
      </div>
    );
  }

  return (
    <div className="mt-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-cyan-800/45 bg-cyan-950/20 px-4 py-3 ring-1 ring-cyan-500/15">
        <div>
          <div className="text-sm font-semibold tracking-tight text-cyan-50">BTC / USDT · Binance spot (separate market)</div>
          <p className="mt-1 max-w-2xl text-[11px] leading-snug text-zinc-500">
            Full order book, flow, and spot signals from your API proxy — not Polymarket CLOB. Your Polymarket slug in the sidebar is unchanged; this layer sits on top.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <div
            className={`rounded-full border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide ${feedBadge.cls}`}
            title={fetchedAt != null ? `Last depth poll ${new Date(fetchedAt).toLocaleTimeString()}` : 'Waiting for first depth response'}
          >
            {feedBadge.label}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-xl border border-zinc-600/60 bg-zinc-900/60 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-800/80"
          >
            Exit spot market
          </button>
        </div>
      </div>

      {err ? <pre className="overflow-auto rounded-xl border border-rose-900/40 bg-rose-950/20 p-3 text-xs text-rose-100/90">{err}</pre> : null}

      {mainTab === 'book' ? (
        <div>
          <div className="mb-4 rounded-2xl border border-zinc-800/40 bg-zinc-900/20 p-3 ring-1 ring-white/[0.02]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Spot mids (USDT)</div>
              <div className="flex flex-wrap gap-2">
                <TradeSegmentedControl
                  value={flowMode}
                  onChange={(v) => setFlowMode(v as 'price' | 'flow')}
                  options={[
                    { value: 'price', label: 'Price' },
                    { value: 'flow', label: 'Order flow' },
                  ]}
                />
                <button
                  type="button"
                  onClick={() => setChartEnabled((v) => !v)}
                  className={`rounded-lg border px-3 py-1.5 text-[11px] font-semibold transition-colors ${
                    chartEnabled
                      ? 'border-emerald-700/40 bg-emerald-950/20 text-emerald-100 hover:bg-emerald-950/35'
                      : 'border-zinc-700/50 bg-zinc-950/20 text-zinc-300 hover:bg-zinc-900/40'
                  }`}
                  title="Polls depth every ~2s when on"
                >
                  {chartEnabled ? 'Charts on' : 'Charts off'}
                </button>
              </div>
            </div>
            {chartEnabled && bidSeries.length >= 1 && askSeries.length >= 1 ? (
              <div className="mt-3">
                {flowMode === 'price' ? (
                  <MomentumChart
                    title="Best bid vs best ask (USDT)"
                    aLabel="Best bid"
                    aTone="up"
                    a={bidSeries.slice(-120)}
                    bLabel="Best ask"
                    bTone="down"
                    b={askSeries.slice(-120)}
                    lastUpdateMs={fetchedAt}
                    priceToBeatUsd={null}
                  />
                ) : (
                  <OrderFlowChart
                    title="Order flow (depth churn + mid — Binance BTCUSDT)"
                    series={flowForChart.slice(-180)}
                    lastUpdateMs={fetchedAt}
                    priceToBeatUsd={null}
                  />
                )}
              </div>
            ) : (
              <div className="mt-2 text-xs text-zinc-600">Enable charts and wait a poll or two for bid/ask history.</div>
            )}
          </div>

          {entry && !entry.error ? (
            <div className="rounded-2xl border border-zinc-800/50 bg-gradient-to-b from-zinc-900/25 to-zinc-950/40 p-4 shadow-lg shadow-black/25 ring-1 ring-white/[0.03]">
              <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-800/40 pb-3">
                <div className="text-[15px] font-semibold tracking-tight text-zinc-100">Consolidated book</div>
                <div className="font-mono text-[11px] text-zinc-400">
                  mid {mid != null ? displayPrice(mid) : '—'} · bid {tob?.bestBid != null ? displayPrice(tob.bestBid) : '—'} · ask{' '}
                  {tob?.bestAsk != null ? displayPrice(tob.bestAsk) : '—'}
                </div>
              </div>
              <div className="mt-3 rounded-xl border border-zinc-800/50 bg-zinc-900/30 px-3 py-2.5 ring-1 ring-white/[0.02]">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Microstructure</div>
                <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-zinc-400">
                  {outcomeEntryExitHints({
                    label: 'BTC/USDT',
                    mid,
                    bestBid: tob?.bestBid ?? null,
                    bestAsk: tob?.bestAsk ?? null,
                  }).map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
              {intel ? (
                <div className="mt-3 rounded-xl border border-emerald-900/30 bg-emerald-950/15 px-3 py-2.5 ring-1 ring-white/[0.02]">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300/90">Depth read</div>
                  <ul className="mt-1.5 space-y-1 text-[11px] leading-relaxed text-emerald-100/90">
                    {bookIntelLines(intel).map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <SpotLadders bids={parsed.bids} asks={parsed.asks} />
            </div>
          ) : (
            <div className="text-sm text-zinc-500">Loading depth…</div>
          )}
        </div>
      ) : null}

      {mainTab === 'flowzones' ? (
        <div className="space-y-4">
          <OrderFlowChart
            title="Flow — mid, imbalance, churn (Binance BTCUSDT)"
            series={flowForChart.slice(-220)}
            lastUpdateMs={fetchedAt}
            priceToBeatUsd={null}
            large
          />
          <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 ring-1 ring-white/[0.02]">
            <div className="text-[12px] font-semibold text-zinc-200">Agg trade lean (window)</div>
            <p className="mt-1 text-[11px] text-zinc-500">
              Taker buys (aggressive) vs taker sells — coarse tape tilt, same spirit as Polymarket flow zones desk tape.
            </p>
            <div className="mt-3 flex flex-wrap gap-4 font-mono text-sm">
              <span className="text-emerald-300/90">Taker buys ≈ {buyAgg}</span>
              <span className="text-rose-300/90">Taker sells ≈ {sellAgg}</span>
            </div>
          </div>
          <div className="max-h-64 overflow-auto rounded-xl border border-zinc-800/50 bg-black/25">
            <table className="w-full border-collapse text-left text-[11px] text-zinc-300">
              <thead className="sticky top-0 z-[1] bg-zinc-900/95 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="border-b border-zinc-800/60 px-2 py-2">Time</th>
                  <th className="border-b border-zinc-800/60 px-2 py-2">Side</th>
                  <th className="border-b border-zinc-800/60 px-2 py-2">Price</th>
                  <th className="border-b border-zinc-800/60 px-2 py-2">Qty</th>
                </tr>
              </thead>
              <tbody>
                {trades.slice(0, 80).map((r) => (
                  <tr key={r.id} className="border-b border-zinc-800/30 hover:bg-zinc-800/25">
                    <td className="whitespace-nowrap px-2 py-1.5 font-mono text-zinc-500">
                      {new Date(r.time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </td>
                    <td className={`px-2 py-1.5 ${r.buyerMaker ? 'text-rose-300/90' : 'text-emerald-300/90'}`}>
                      {r.buyerMaker ? 'Sell' : 'Buy'}
                    </td>
                    <td className="px-2 py-1.5 font-mono">{displayPrice(r.price)}</td>
                    <td className="px-2 py-1.5 font-mono text-zinc-400">{r.qty.toFixed(5).replace(/\.?0+$/, '')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {mainTab === 'signals' ? (
        <div className="space-y-4">
          <div className="rounded-2xl border border-amber-900/35 bg-amber-950/15 p-4 ring-1 ring-amber-500/10">
            <div className="text-[12px] font-semibold text-amber-100/90">Spot signals desk</div>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
              Polymarket PTB / implied six-pack logic does not apply here — below is live microstructure from the Binance book poll (same stack as Book/Flow).
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Mid</div>
              <div className="mt-1 font-mono text-lg font-bold text-zinc-50">{mid != null ? displayPrice(mid) : '—'}</div>
            </div>
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Spread</div>
              <div className="mt-1 font-mono text-lg font-bold text-zinc-50">
                {lastSnap?.spread != null ? displayPrice(lastSnap.spread) : '—'}
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Depth imbalance</div>
              <div className="mt-1 font-mono text-lg font-bold text-zinc-50">
                {lastSnap?.imbalance != null ? lastSnap.imbalance.toFixed(3) : '—'}
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Churn (last)</div>
              <div className="mt-1 font-mono text-lg font-bold text-zinc-50">
                {lastSnap?.churn != null ? lastSnap.churn.toFixed(2) : '—'}
              </div>
            </div>
          </div>
          <OrderFlowChart
            title="Signals strip — same flow series as Flow tab"
            series={flowForChart.slice(-200)}
            lastUpdateMs={fetchedAt}
            priceToBeatUsd={null}
            compact
          />
        </div>
      ) : null}
    </div>
  );
}
