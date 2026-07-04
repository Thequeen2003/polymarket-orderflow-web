import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { binanceAggTrades, binanceKlines, binanceTicker, type ApiOk, type BinanceAggTrade } from './lib/api';
import { fmtSpotUsd } from './fmtSpotUsd';
import { ohlcBarsFromBinary, SpotStyleOhlcChart } from './SpotStyleOhlcChart';
import {
  BINARY_PAYOUT_MULT,
  IQ_BINARY_EXPIRY_OPTIONS,
  barIntervalMsForExpiry,
  formatCountdown,
  msUntilExpiry,
  nextExpiryBucketMs,
  parseBinanceKlines,
  predictBinaryDirection,
  seedLiveCandleSeries,
  settleBinaryBet,
  upsertTickCandle,
  type BinaryCandle,
  type BinaryExpirySec,
  type BinaryPrediction,
} from './binaryCandlePredictor';

const BTC_SYMBOL = 'BTCUSDT';
const PAPER_KEY = 'binary-desk:paper:v1';
const BETS_KEY = 'binary-desk:bets:v1';
const DEFAULT_PAPER_USD = 10_000;

function isOk<T>(x: unknown): x is ApiOk<T> {
  return typeof x === 'object' && x !== null && (x as { ok?: boolean }).ok === true && 'data' in (x as object);
}

type PaperWallet = { cashUsd: number; updatedAt: number };

type OpenBet = {
  id: string;
  side: 'up' | 'down';
  strike: number;
  stakeUsd: number;
  expirySec: BinaryExpirySec;
  placedAtMs: number;
  expiresAtMs: number;
};

type SettledBet = OpenBet & {
  result: 'win' | 'loss' | 'push';
  settlePrice: number;
  pnlUsd: number;
  settledAtMs: number;
};

function loadPaper(): PaperWallet {
  try {
    const raw = window.localStorage.getItem(PAPER_KEY);
    if (!raw) return { cashUsd: DEFAULT_PAPER_USD, updatedAt: Date.now() };
    const p = JSON.parse(raw) as PaperWallet;
    if (!Number.isFinite(p.cashUsd)) return { cashUsd: DEFAULT_PAPER_USD, updatedAt: Date.now() };
    return p;
  } catch {
    return { cashUsd: DEFAULT_PAPER_USD, updatedAt: Date.now() };
  }
}

function savePaper(w: PaperWallet): void {
  try {
    window.localStorage.setItem(PAPER_KEY, JSON.stringify(w));
  } catch {
    /* ignore */
  }
}

function loadBets(): OpenBet[] {
  try {
    const raw = window.localStorage.getItem(BETS_KEY);
    if (!raw) return [];
    const rows = JSON.parse(raw) as OpenBet[];
    if (!Array.isArray(rows)) return [];
    return rows.filter((b) => b.expiresAtMs > Date.now());
  } catch {
    return [];
  }
}

function saveBets(rows: OpenBet[]): void {
  try {
    window.localStorage.setItem(BETS_KEY, JSON.stringify(rows));
  } catch {
    /* ignore */
  }
}

export function BinaryCandleChartTab(): ReactElement {
  const [expirySec, setExpirySec] = useState<BinaryExpirySec>(60);
  const [candles, setCandles] = useState<BinaryCandle[]>([]);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [changePct, setChangePct] = useState<number | null>(null);
  const [feedErr, setFeedErr] = useState<string | null>(null);
  const [stakeStr, setStakeStr] = useState('25');
  const [paper, setPaper] = useState<PaperWallet>(() => loadPaper());
  const [openBets, setOpenBets] = useState<OpenBet[]>(() => loadBets());
  const [settled, setSettled] = useState<SettledBet[]>([]);
  const [betMsg, setBetMsg] = useState<string | null>(null);
  const [betErr, setBetErr] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const buyVolRef = useRef(0);
  const sellVolRef = useRef(0);
  const flowAtRef = useRef(Date.now());
  const klinesRef = useRef<BinaryCandle[]>([]);
  const tradesRef = useRef<{ time: number; price: number; qty: number }[]>([]);

  const expiryMeta = IQ_BINARY_EXPIRY_OPTIONS.find((o) => o.sec === expirySec) ?? IQ_BINARY_EXPIRY_OPTIONS[0]!;
  const barSec = expiryMeta.sec;
  const intervalMs = barIntervalMsForExpiry(barSec);
  const countdownMs = msUntilExpiry(nextExpiryBucketMs(nowMs, barSec), nowMs);
  const forming = candles[candles.length - 1] ?? null;

  useEffect(() => {
    const ms = barSec <= 120 ? 100 : 250;
    const id = window.setInterval(() => setNowMs(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [barSec]);

  useEffect(() => {
    if (livePrice == null || !Number.isFinite(livePrice)) return;
    setCandles((prev) => upsertTickCandle(prev, { t: Date.now(), p: livePrice }, intervalMs));
  }, [livePrice, intervalMs]);

  useEffect(() => {
    let alive = true;
    async function seed(): Promise<void> {
      try {
        const [kRes, tRes] = await Promise.all([binanceKlines(BTC_SYMBOL, barSec <= 300 ? '1m' : '5m', 120), binanceAggTrades(BTC_SYMBOL, 400)]);
        if (!alive) return;
        if (isOk(kRes)) klinesRef.current = parseBinanceKlines(kRes.data);
        if (isOk(tRes) && Array.isArray(tRes.data)) {
          tradesRef.current = (tRes.data as BinanceAggTrade[]).map((t) => ({ time: t.time, price: Number(t.price), qty: Number(t.qty) }));
        }
        const lp = livePrice;
        setCandles(
          seedLiveCandleSeries({
            expirySec: barSec,
            klines: klinesRef.current,
            trades: tradesRef.current,
            livePrice: lp,
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
  }, [barSec]);

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

  useEffect(() => {
    if (openBets.length === 0 || livePrice == null) return;
    const due = openBets.filter((b) => b.expiresAtMs <= nowMs);
    if (due.length === 0) return;

    const done: SettledBet[] = [];
    for (const b of due) {
      const result = settleBinaryBet(b.side, b.strike, livePrice);
      let pnl = 0;
      if (result === 'win') pnl = b.stakeUsd * BINARY_PAYOUT_MULT;
      else if (result === 'loss') pnl = -b.stakeUsd;
      done.push({ ...b, result, settlePrice: livePrice, pnlUsd: pnl, settledAtMs: nowMs });
    }

    setPaper((p) => {
      let cash = p.cashUsd;
      for (const b of due) {
        const result = settleBinaryBet(b.side, b.strike, livePrice);
        let pnl = 0;
        if (result === 'win') pnl = b.stakeUsd * BINARY_PAYOUT_MULT;
        else if (result === 'loss') pnl = -b.stakeUsd;
        cash += b.stakeUsd + pnl;
      }
      const next = { cashUsd: cash, updatedAt: nowMs };
      savePaper(next);
      return next;
    });
    setOpenBets((prev) => {
      const remaining = prev.filter((b) => b.expiresAtMs > nowMs);
      saveBets(remaining);
      return remaining;
    });
    setSettled((s) => [...done, ...s].slice(0, 8));
  }, [openBets, livePrice, nowMs]);

  const flowDecay = nowMs - flowAtRef.current > 30_000 ? 0 : 1;
  const prediction: BinaryPrediction = useMemo(
    () =>
      predictBinaryDirection({
        candles,
        livePrice: livePrice ?? 0,
        expirySec: barSec,
        nowMs,
        buyVolRecent: buyVolRef.current * flowDecay,
        sellVolRecent: sellVolRef.current * flowDecay,
      }),
    [candles, livePrice, barSec, nowMs, flowDecay],
  );

  const placeBet = useCallback(
    (side: 'up' | 'down') => {
      setBetErr(null);
      setBetMsg(null);
      const stake = Number(stakeStr);
      if (!Number.isFinite(stake) || stake <= 0) {
        setBetErr('Enter a valid stake.');
        return;
      }
      if (livePrice == null) {
        setBetErr('Waiting for price…');
        return;
      }
      if (paper.cashUsd < stake) {
        setBetErr('Not enough practice balance.');
        return;
      }
      const placedAtMs = Date.now();
      const bet: OpenBet = {
        id: `${placedAtMs}-${Math.random().toString(36).slice(2, 8)}`,
        side,
        strike: livePrice,
        stakeUsd: stake,
        expirySec: barSec,
        placedAtMs,
        expiresAtMs: placedAtMs + barSec * 1000,
      };
      const nextPaper = { cashUsd: paper.cashUsd - stake, updatedAt: placedAtMs };
      setPaper(nextPaper);
      savePaper(nextPaper);
      setOpenBets((prev) => {
        const next = [...prev, bet];
        saveBets(next);
        return next;
      });
      setBetMsg(`${side === 'up' ? 'HIGHER' : 'LOWER'} · $${stake.toFixed(2)} @ ${fmtSpotUsd(livePrice)} · ${expiryMeta.label}`);
    },
    [stakeStr, livePrice, paper.cashUsd, barSec, expiryMeta.label],
  );

  const resetPaper = (): void => {
    const w = { cashUsd: DEFAULT_PAPER_USD, updatedAt: Date.now() };
    setPaper(w);
    savePaper(w);
  };

  const up = prediction.direction === 'up';
  const ohlcBars = useMemo(() => ohlcBarsFromBinary(candles, intervalMs), [candles, intervalMs]);

  return (
    <div className="mt-4 space-y-4">
      {/* Header — IQ-style turbo binary desk */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-800/70 bg-gradient-to-r from-zinc-950 via-[#12121a] to-zinc-950 px-4 py-3 ring-1 ring-white/[0.03]">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-orange-400/90">Turbo binary desk</div>
          <div className="mt-0.5 text-lg font-semibold text-zinc-100">Bitcoin · BTC/USD</div>
          <div className="mt-0.5 text-[11px] text-zinc-500">IQ Option–style dashboard · live chart · practice only</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-3xl font-black tabular-nums tracking-tight text-white">
            {livePrice == null ? '—' : fmtSpotUsd(livePrice)}
          </div>
          {changePct != null ? (
            <div className={`font-mono text-sm font-semibold tabular-nums ${changePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}% 24h
            </div>
          ) : null}
        </div>
        <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/30 px-4 py-2 text-right">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-emerald-400/80">Practice balance</div>
          <div className="font-mono text-xl font-bold tabular-nums text-emerald-100">${paper.cashUsd.toFixed(2)}</div>
          <button type="button" onClick={resetPaper} className="mt-0.5 text-[10px] text-zinc-500 underline hover:text-zinc-300">
            Reset to $10k
          </button>
        </div>
      </div>

      {/* Expiry pills */}
      <div className="flex flex-wrap gap-2">
        {IQ_BINARY_EXPIRY_OPTIONS.map((o) => {
          const active = o.sec === expirySec;
          return (
            <button
              key={o.sec}
              type="button"
              onClick={() => setExpirySec(o.sec)}
              className={`min-w-[3.5rem] rounded-xl px-4 py-2.5 font-mono text-sm font-bold transition-all ${
                active
                  ? 'bg-orange-500 text-black shadow-lg shadow-orange-950/40'
                  : 'border border-zinc-700/60 bg-zinc-900/50 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>

      {feedErr ? <div className="rounded-xl border border-rose-800/40 bg-rose-950/20 px-3 py-2 text-sm text-rose-200">{feedErr}</div> : null}

      <SpotStyleOhlcChart
        bars={ohlcBars}
        livePrice={livePrice}
        strikePrice={openBets[0]?.strike ?? prediction.strikePrice}
        chartTitle={`Bitcoin · ${expiryMeta.label} bars`}
        strikeLabel="STRIKE"
        defaultDisplayMode="ohlc"
        countdownMs={countdownMs}
        formatCountdown={formatCountdown}
        ariaLabel="Turbo binary OHLC chart"
      />

      {/* Trade panel — side-by-side like IQ Option */}
      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className={`rounded-2xl border p-4 ring-1 ${up ? 'border-emerald-800/40 bg-emerald-950/20 ring-emerald-500/10' : 'border-rose-800/40 bg-rose-950/20 ring-rose-500/10'}`}>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Signal · {expiryMeta.label} window</div>
          <div className={`mt-1 font-mono text-3xl font-black ${up ? 'text-emerald-300' : 'text-rose-300'}`}>{up ? 'HIGHER ▲' : 'LOWER ▼'}</div>
          <div className="mt-2 text-sm text-zinc-400">
            {(prediction.probUp * 100).toFixed(0)}% higher · {prediction.confidencePct}% confidence
          </div>
          {forming ? (
            <div className="mt-3 grid grid-cols-4 gap-2 text-[11px]">
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
          <ul className="mt-3 space-y-0.5 text-[11px] text-zinc-500">
            {prediction.reasons.map((r, i) => (
              <li key={i}>· {r}</li>
            ))}
          </ul>
        </div>

        <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/60 p-4 ring-1 ring-white/[0.02]">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Amount</div>
          <input
            value={stakeStr}
            onChange={(e) => setStakeStr(e.target.value)}
            className="mt-1 w-full rounded-xl border border-zinc-700/60 bg-black/40 px-3 py-3 font-mono text-2xl font-bold tabular-nums text-white outline-none focus:border-orange-500/50"
            inputMode="decimal"
          />
          <div className="mt-2 flex gap-2">
            {[10, 25, 50, 100].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setStakeStr(String(n))}
                className="flex-1 rounded-lg border border-zinc-700/50 py-1.5 text-xs font-semibold text-zinc-400 hover:bg-zinc-800/50"
              >
                ${n}
              </button>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => placeBet('up')}
              className="flex min-h-[72px] flex-col items-center justify-center rounded-2xl bg-gradient-to-b from-emerald-400 to-emerald-600 font-black text-black shadow-lg shadow-emerald-950/30 hover:from-emerald-300 hover:to-emerald-500"
            >
              <span className="text-lg">HIGHER</span>
              <span className="text-[10px] opacity-80">price goes up</span>
            </button>
            <button
              type="button"
              onClick={() => placeBet('down')}
              className="flex min-h-[72px] flex-col items-center justify-center rounded-2xl bg-gradient-to-b from-rose-400 to-rose-600 font-black text-white shadow-lg shadow-rose-950/30 hover:from-rose-300 hover:to-rose-500"
            >
              <span className="text-lg">LOWER</span>
              <span className="text-[10px] opacity-90">price goes down</span>
            </button>
          </div>
          <button
            type="button"
            onClick={() => placeBet(prediction.direction)}
            className="mt-2 w-full rounded-xl border border-orange-500/30 bg-orange-500/10 py-2 text-sm font-bold text-orange-100 hover:bg-orange-500/20"
          >
            Follow signal · {up ? 'HIGHER' : 'LOWER'}
          </button>
          <p className="mt-2 text-center text-[10px] text-zinc-600">Payout ~{Math.round(BINARY_PAYOUT_MULT * 100)}% · settles vs strike at expiry</p>
          {betErr ? <p className="mt-2 text-center text-xs text-rose-300">{betErr}</p> : null}
          {betMsg ? <p className="mt-2 text-center text-xs text-emerald-300">{betMsg}</p> : null}
        </div>
      </div>

      {openBets.length > 0 ? (
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-3">
          <div className="text-[10px] font-semibold uppercase text-zinc-500">Open positions</div>
          <ul className="mt-2 space-y-1.5">
            {openBets.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-black/30 px-3 py-2 text-[12px]">
                <span className={`font-bold uppercase ${b.side === 'up' ? 'text-emerald-400' : 'text-rose-400'}`}>{b.side === 'up' ? 'Higher' : 'Lower'}</span>
                <span className="font-mono text-zinc-300">${b.stakeUsd.toFixed(2)} vs {fmtSpotUsd(b.strike)}</span>
                <span className="font-mono tabular-nums text-orange-300">{formatCountdown(msUntilExpiry(b.expiresAtMs, nowMs))}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {settled.length > 0 ? (
        <div className="rounded-xl border border-zinc-800/50 bg-zinc-950/30 p-3">
          <div className="text-[10px] font-semibold uppercase text-zinc-500">Recent results</div>
          <ul className="mt-1 space-y-1 text-[11px] text-zinc-400">
            {settled.map((s) => (
              <li key={s.id + String(s.settledAtMs)}>
                <span className={s.result === 'win' ? 'text-emerald-400' : s.result === 'loss' ? 'text-rose-400' : 'text-zinc-400'}>{s.result.toUpperCase()}</span>
                {' · '}
                {s.side === 'up' ? 'Higher' : 'Lower'} · P/L ${s.pnlUsd.toFixed(2)} @ {fmtSpotUsd(s.settlePrice)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
