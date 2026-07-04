import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { binanceAggTrades, binanceKlines, binanceTicker, type ApiOk, type BinanceAggTrade } from './lib/api';
import { fmtSpotUsd } from './fmtSpotUsd';
import { ohlcBarsFromBinary, SpotStyleOhlcChart } from './SpotStyleOhlcChart';
import {
  BINARY_EXPIRY_OPTIONS,
  barIntervalMsForExpiry,
  expiryBucketProgress,
  formatCountdown,
  msUntilExpiry,
  nextExpiryBucketMs,
  parseBinanceKlines,
  predictBinaryDirection,
  seedLiveCandleSeries,
  upsertTickCandle,
  type BinaryCandle,
  type BinaryExpirySec,
  type BinaryPrediction,
} from './binaryCandlePredictor';

const BTC_SYMBOL = 'BTCUSDT';
const CHART_BAR_SEC = 60 as BinaryExpirySec;

/** Horizons shown on the predictor desk (short → long). */
const PREDICT_HORIZONS = BINARY_EXPIRY_OPTIONS.filter((o) =>
  ([10, 30, 60, 120, 300, 600, 900] as BinaryExpirySec[]).includes(o.sec),
);

function isOk<T>(x: unknown): x is ApiOk<T> {
  return typeof x === 'object' && x !== null && (x as { ok?: boolean }).ok === true && 'data' in (x as object);
}

function HorizonCard(props: {
  label: string;
  prediction: BinaryPrediction;
  countdownMs: number;
  active: boolean;
  onSelect: () => void;
}): ReactElement {
  const { label, prediction, countdownMs, active, onSelect } = props;
  const up = prediction.direction === 'up';
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-xl border p-3 text-left transition-all ${
        active
          ? up
            ? 'border-emerald-600/60 bg-emerald-950/30 ring-1 ring-emerald-500/20'
            : 'border-rose-600/60 bg-rose-950/30 ring-1 ring-rose-500/20'
          : 'border-zinc-800/70 bg-zinc-950/40 hover:border-zinc-700 hover:bg-zinc-900/50'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-bold text-zinc-300">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-zinc-500">{formatCountdown(countdownMs)}</span>
      </div>
      <div className={`mt-1.5 font-mono text-lg font-black ${up ? 'text-emerald-300' : 'text-rose-300'}`}>
        {up ? 'UP ▲' : 'DOWN ▼'}
      </div>
      <div className="mt-1 text-[11px] text-zinc-500">
        {(prediction.probUp * 100).toFixed(0)}% up · {prediction.confidencePct}% conf
      </div>
    </button>
  );
}

export function BtcPricePredictorPage(): ReactElement {
  const [focusSec, setFocusSec] = useState<BinaryExpirySec>(60);
  const [candles, setCandles] = useState<BinaryCandle[]>([]);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [changePct, setChangePct] = useState<number | null>(null);
  const [feedErr, setFeedErr] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const buyVolRef = useRef(0);
  const sellVolRef = useRef(0);
  const flowAtRef = useRef(Date.now());
  const klinesRef = useRef<BinaryCandle[]>([]);
  const tradesRef = useRef<{ time: number; price: number; qty: number }[]>([]);

  const intervalMs = barIntervalMsForExpiry(CHART_BAR_SEC);
  const focusMeta = PREDICT_HORIZONS.find((o) => o.sec === focusSec) ?? PREDICT_HORIZONS[2]!;
  const countdownMs = msUntilExpiry(nextExpiryBucketMs(nowMs, focusSec), nowMs);
  const bucketProgress = expiryBucketProgress(nowMs, focusSec);
  const forming = candles[candles.length - 1] ?? null;

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (livePrice == null || !Number.isFinite(livePrice)) return;
    setCandles((prev) => upsertTickCandle(prev, { t: Date.now(), p: livePrice }, intervalMs));
  }, [livePrice, intervalMs]);

  useEffect(() => {
    let alive = true;
    async function seed(): Promise<void> {
      try {
        const [kRes, tRes] = await Promise.all([binanceKlines(BTC_SYMBOL, '1m', 120), binanceAggTrades(BTC_SYMBOL, 400)]);
        if (!alive) return;
        if (isOk(kRes)) klinesRef.current = parseBinanceKlines(kRes.data);
        if (isOk(tRes) && Array.isArray(tRes.data)) {
          tradesRef.current = (tRes.data as BinanceAggTrade[]).map((t) => ({ time: t.time, price: Number(t.price), qty: Number(t.qty) }));
        }
        setCandles(
          seedLiveCandleSeries({
            expirySec: CHART_BAR_SEC,
            klines: klinesRef.current,
            trades: tradesRef.current,
            livePrice,
            nowMs: Date.now(),
          }),
        );
        setFeedErr(null);
      } catch (e) {
        if (!alive) return;
        setFeedErr(e instanceof Error ? e.message : 'Feed error');
      }
    }
    void seed();
    const id = window.setInterval(() => void seed(), 20_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    async function tick(): Promise<void> {
      const res = await binanceTicker(BTC_SYMBOL);
      if (!alive || !isOk(res)) return;
      const d = res.data;
      if (d.lastPrice != null) setLivePrice(d.lastPrice);
      setChangePct(d.priceChangePercent);
    }
    void tick();
    const id = window.setInterval(() => void tick(), 300);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    async function flow(): Promise<void> {
      const res = await binanceAggTrades(BTC_SYMBOL, 80);
      if (!alive || !isOk(res)) return;
      let buy = 0;
      let sell = 0;
      setCandles((prev) => {
        let next = prev;
        for (const t of res.data as BinanceAggTrade[]) {
          const q = Number(t.qty);
          const p = Number(t.price);
          if (!Number.isFinite(q) || !Number.isFinite(p)) continue;
          if (t.buyerMaker) sell += q;
          else buy += q;
          next = upsertTickCandle(next, { t: t.time, p, buyVol: q }, intervalMs);
        }
        return next;
      });
      buyVolRef.current = buy;
      sellVolRef.current = sell;
      flowAtRef.current = Date.now();
    }
    void flow();
    const id = window.setInterval(() => void flow(), 1500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [intervalMs]);

  const flowDecay = nowMs - flowAtRef.current > 30_000 ? 0 : 1;

  const predictions = useMemo(() => {
    const map = new Map<BinaryExpirySec, BinaryPrediction>();
    for (const h of PREDICT_HORIZONS) {
      map.set(
        h.sec,
        predictBinaryDirection({
          candles,
          livePrice: livePrice ?? 0,
          expirySec: h.sec,
          nowMs,
          buyVolRecent: buyVolRef.current * flowDecay,
          sellVolRecent: sellVolRef.current * flowDecay,
        }),
      );
    }
    return map;
  }, [candles, livePrice, nowMs, flowDecay]);

  const focusPrediction = predictions.get(focusSec) ?? predictions.values().next().value!;
  const up = focusPrediction.direction === 'up';

  const ohlcBars = useMemo(() => ohlcBarsFromBinary(candles, intervalMs), [candles, intervalMs]);

  const consensus = useMemo(() => {
    let upCount = 0;
    for (const p of predictions.values()) {
      if (p.direction === 'up') upCount++;
    }
    const total = predictions.size;
    return { upCount, downCount: total - upCount, total, pctUp: total > 0 ? (upCount / total) * 100 : 50 };
  }, [predictions]);

  return (
    <div className="mt-4 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-zinc-800/70 bg-gradient-to-r from-[#0a0a0f] via-[#101018] to-[#0a0a0f] px-5 py-4 ring-1 ring-white/[0.03]">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-400/90">BTC price predictor</div>
          <div className="mt-0.5 text-xl font-semibold text-zinc-100">Bitcoin · Binance BTC/USDT</div>
          <div className="mt-0.5 text-[11px] text-zinc-500">Multi-horizon direction model · live spot feed · no trading</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-4xl font-black tabular-nums tracking-tight text-white">
            {livePrice == null ? '—' : fmtSpotUsd(livePrice)}
          </div>
          {changePct != null ? (
            <div className={`font-mono text-sm font-semibold tabular-nums ${changePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {changePct >= 0 ? '+' : ''}
              {changePct.toFixed(2)}% 24h
            </div>
          ) : null}
        </div>
        <div className="rounded-xl border border-zinc-700/50 bg-zinc-950/50 px-4 py-2.5 text-center">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Horizon consensus</div>
          <div className="mt-0.5 font-mono text-lg font-bold tabular-nums text-zinc-200">
            {consensus.upCount}/{consensus.total} UP
          </div>
          <div className="text-[10px] text-zinc-500">{consensus.pctUp.toFixed(0)}% bullish across windows</div>
        </div>
      </div>

      {feedErr ? <div className="rounded-xl border border-rose-800/40 bg-rose-950/20 px-3 py-2 text-sm text-rose-200">{feedErr}</div> : null}

      <div className="flex flex-wrap gap-2">
        {PREDICT_HORIZONS.map((o) => {
          const active = o.sec === focusSec;
          const p = predictions.get(o.sec);
          const bullish = p?.direction === 'up';
          return (
            <button
              key={o.sec}
              type="button"
              onClick={() => setFocusSec(o.sec)}
              className={`min-w-[3.25rem] rounded-xl px-3.5 py-2 font-mono text-sm font-bold transition-all ${
                active
                  ? 'bg-cyan-500 text-black shadow-lg shadow-cyan-950/40'
                  : bullish
                    ? 'border border-emerald-800/40 bg-emerald-950/20 text-emerald-200/90 hover:border-emerald-700/50'
                    : 'border border-rose-800/40 bg-rose-950/20 text-rose-200/90 hover:border-rose-700/50'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <div
          className={`rounded-2xl border p-5 ring-1 ${
            up ? 'border-emerald-800/45 bg-emerald-950/20 ring-emerald-500/10' : 'border-rose-800/45 bg-rose-950/20 ring-rose-500/10'
          }`}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                Primary signal · {focusMeta.label} horizon
              </div>
              <div className={`mt-1 font-mono text-4xl font-black ${up ? 'text-emerald-300' : 'text-rose-300'}`}>
                {up ? 'PRICE UP ▲' : 'PRICE DOWN ▼'}
              </div>
              <div className="mt-2 text-sm text-zinc-400">
                {(focusPrediction.probUp * 100).toFixed(1)}% probability higher · {focusPrediction.confidencePct}% model confidence
              </div>
            </div>
            <div className="text-right">
              <div className="relative mx-auto flex h-20 w-20 items-center justify-center">
                <svg className="-rotate-90" viewBox="0 0 36 36" width={80} height={80}>
                  <circle cx={18} cy={18} r={15.5} fill="none" stroke="rgb(39 39 42)" strokeWidth={3} />
                  <circle
                    cx={18}
                    cy={18}
                    r={15.5}
                    fill="none"
                    stroke="rgb(34 211 238)"
                    strokeWidth={3}
                    strokeDasharray={`${Math.round(bucketProgress * 100)} ${100 - Math.round(bucketProgress * 100)}`}
                    pathLength={100}
                  />
                </svg>
                <span className="absolute font-mono text-xs font-bold tabular-nums text-cyan-200">{formatCountdown(countdownMs)}</span>
              </div>
              <div className="mt-1 text-[9px] uppercase tracking-wide text-zinc-500">to next {focusMeta.label} bucket</div>
            </div>
          </div>

          {forming ? (
            <div className="mt-4 grid grid-cols-4 gap-2 text-[11px]">
              {(['O', 'H', 'L', 'C'] as const).map((k) => (
                <div key={k} className="rounded-lg bg-black/30 px-2 py-1.5">
                  <div className="text-zinc-500">{k}</div>
                  <div className="font-mono font-semibold text-zinc-200">
                    {fmtSpotUsd(k === 'C' ? (livePrice ?? forming.c) : k === 'O' ? forming.o : k === 'H' ? forming.h : forming.l)}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <ul className="mt-4 space-y-1 text-[12px] leading-relaxed text-zinc-400">
            {focusPrediction.reasons.map((r, i) => (
              <li key={i}>· {r}</li>
            ))}
          </ul>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-2">
          {PREDICT_HORIZONS.map((h) => {
            const p = predictions.get(h.sec)!;
            return (
              <HorizonCard
                key={h.sec}
                label={h.label}
                prediction={p}
                countdownMs={msUntilExpiry(nextExpiryBucketMs(nowMs, h.sec), nowMs)}
                active={h.sec === focusSec}
                onSelect={() => setFocusSec(h.sec)}
              />
            );
          })}
        </div>
      </div>

      <SpotStyleOhlcChart
        bars={ohlcBars}
        livePrice={livePrice}
        strikePrice={focusPrediction.strikePrice}
        chartTitle="Bitcoin · Binance BTC/USDT"
        strikeLabel="STRIKE"
        defaultDisplayMode="ohlc"
        countdownMs={countdownMs}
        formatCountdown={formatCountdown}
        ariaLabel="BTC price predictor OHLC chart"
      />
    </div>
  );
}
