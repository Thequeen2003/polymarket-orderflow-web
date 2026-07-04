import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { binanceAggTrades, binanceKlines, binanceTicker, type ApiOk, type BinanceAggTrade } from './lib/api';
import { fmtSpotUsd } from './fmtSpotUsd';
import { ohlcBarsFromBinary, SpotStyleOhlcChart } from './SpotStyleOhlcChart';
import {
  barIntervalMsForExpiry,
  binanceKlineIntervalForExpiry,
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
import {
  buildPocketOptionMomentumReadout,
  POCKET_OPTION_EXPIRY_OPTIONS,
  POCKET_OPTION_PAYOUT_MULT,
  type PocketOptionMomentumReadout,
} from './pocketOptionDesk';

const BTC_SYMBOL = 'BTCUSDT';
const PAPER_KEY = 'pocket-option:paper:v1';
const BETS_KEY = 'pocket-option:bets:v1';
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

function PocketMomentumStrip(props: { readout: PocketOptionMomentumReadout }): ReactElement {
  const { readout } = props;
  const shell =
    readout.canTrade && readout.side === 'call'
      ? 'border-emerald-500/50 bg-emerald-950/35 ring-1 ring-emerald-500/25'
      : readout.canTrade && readout.side === 'put'
        ? 'border-rose-500/50 bg-rose-950/35 ring-1 ring-rose-500/25'
        : readout.timing === 'late'
          ? 'border-amber-600/45 bg-amber-950/30'
          : 'border-[#2a3a5c]/80 bg-[#0d1528]/90';

  return (
    <div className={`rounded-xl border px-4 py-3 ${shell}`} role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-lg">{readout.emoji}</span>
        <span className="text-sm font-semibold text-zinc-100 sm:text-base">{readout.headline}</span>
      </div>
      <p className="mt-1 text-xs text-zinc-400 sm:text-sm">{readout.tapeLine}</p>
      <p className="mt-1.5 text-xs text-zinc-300">{readout.actionHint}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {readout.confirmations.map((c) => (
          <span
            key={c.label}
            className={`rounded-md px-2 py-0.5 text-[10px] font-medium sm:text-xs ${
              c.ok ? 'bg-emerald-500/20 text-emerald-200' : 'bg-zinc-800/80 text-zinc-500'
            }`}
          >
            {c.ok ? '✓' : '○'} {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}

export function PocketOptionBitcoinTab(): ReactElement {
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

  const expiryMeta = POCKET_OPTION_EXPIRY_OPTIONS.find((o) => o.sec === expirySec) ?? POCKET_OPTION_EXPIRY_OPTIONS[2]!;
  const barSec = expiryMeta.sec;
  const intervalMs = barIntervalMsForExpiry(barSec);
  const countdownMs = msUntilExpiry(nextExpiryBucketMs(nowMs, barSec), nowMs);
  const activeStrike = openBets[0]?.strike ?? livePrice;

  useEffect(() => {
    const ms = barSec <= 60 ? 100 : 250;
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
        const kInt = binanceKlineIntervalForExpiry(barSec);
        const [kRes, tRes] = await Promise.all([binanceKlines(BTC_SYMBOL, kInt, 120), binanceAggTrades(BTC_SYMBOL, 400)]);
        if (!alive) return;
        if (isOk(kRes)) klinesRef.current = parseBinanceKlines(kRes.data);
        if (isOk(tRes) && Array.isArray(tRes.data)) {
          tradesRef.current = (tRes.data as BinanceAggTrade[]).map((t) => ({
            time: t.time,
            price: Number(t.price),
            qty: Number(t.qty),
          }));
        }
        setCandles(
          seedLiveCandleSeries({
            expirySec: barSec,
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
  }, [barSec, livePrice]);

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
      if (result === 'win') pnl = b.stakeUsd * POCKET_OPTION_PAYOUT_MULT;
      else if (result === 'loss') pnl = -b.stakeUsd;
      done.push({ ...b, result, settlePrice: livePrice, pnlUsd: pnl, settledAtMs: nowMs });
    }

    setPaper((p) => {
      let cash = p.cashUsd;
      for (const b of due) {
        const result = settleBinaryBet(b.side, b.strike, livePrice);
        let pnl = 0;
        if (result === 'win') pnl = b.stakeUsd * POCKET_OPTION_PAYOUT_MULT;
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
    setSettled((s) => [...done, ...s].slice(0, 10));
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

  const momentum = useMemo(
    () =>
      buildPocketOptionMomentumReadout({
        prediction,
        expirySec: barSec,
        nowMs,
        livePrice,
        strikePrice: activeStrike,
        buyVolRecent: buyVolRef.current * flowDecay,
        sellVolRecent: sellVolRef.current * flowDecay,
      }),
    [prediction, barSec, nowMs, livePrice, activeStrike, flowDecay],
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
      const label = side === 'up' ? 'CALL' : 'PUT';
      setBetMsg(`${label} · $${stake.toFixed(2)} @ ${fmtSpotUsd(livePrice)} · ${expiryMeta.label} · +${Math.round(POCKET_OPTION_PAYOUT_MULT * 100)}% payout`);
    },
    [stakeStr, livePrice, paper.cashUsd, barSec, expiryMeta.label],
  );

  const resetPaper = (): void => {
    const w = { cashUsd: DEFAULT_PAPER_USD, updatedAt: Date.now() };
    setPaper(w);
    savePaper(w);
  };

  const ohlcBars = useMemo(() => ohlcBarsFromBinary(candles, intervalMs), [candles, intervalMs]);
  const payoutDisplay = `+${Math.round(POCKET_OPTION_PAYOUT_MULT * 100)}%`;

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#1e3a5f]/60 bg-gradient-to-r from-[#070b14] via-[#0c1424] to-[#070b14] px-4 py-3 ring-1 ring-[#3b82f6]/10">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.22em] text-[#5b9cf5]">Pocket Option · practice</div>
          <div className="mt-0.5 text-lg font-semibold text-zinc-100">Bitcoin OTC / BTC</div>
          <div className="mt-0.5 text-[11px] text-zinc-500">Binance BTC/USDT feed · CALL/PUT vs strike · not connected to Pocket Option</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-3xl font-black tabular-nums tracking-tight text-white">
            {livePrice == null ? '—' : fmtSpotUsd(livePrice)}
          </div>
          {changePct != null ? (
            <div className={`font-mono text-sm font-semibold tabular-nums ${changePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {changePct >= 0 ? '+' : ''}
              {changePct.toFixed(2)}% 24h
            </div>
          ) : null}
        </div>
        <div className="rounded-xl border border-[#1e3a5f]/50 bg-[#0a1220]/80 px-4 py-2 text-right">
          <div className="text-[9px] font-semibold uppercase tracking-wide text-[#5b9cf5]/80">Demo balance</div>
          <div className="font-mono text-xl font-bold tabular-nums text-zinc-100">${paper.cashUsd.toFixed(2)}</div>
          <button type="button" onClick={resetPaper} className="mt-0.5 text-[10px] text-zinc-500 underline hover:text-zinc-300">
            Reset $10k
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {POCKET_OPTION_EXPIRY_OPTIONS.map((o) => {
          const active = o.sec === expirySec;
          return (
            <button
              key={o.sec}
              type="button"
              onClick={() => setExpirySec(o.sec)}
              className={`min-w-[3.25rem] rounded-xl px-3.5 py-2.5 font-mono text-sm font-bold transition-all ${
                active
                  ? 'bg-[#2563eb] text-white shadow-lg shadow-blue-950/50 ring-1 ring-blue-400/40'
                  : 'border border-[#1e3a5f]/60 bg-[#0a1220]/60 text-zinc-400 hover:border-[#2563eb]/40 hover:text-zinc-200'
              }`}
            >
              {o.label}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2 rounded-xl border border-[#1e3a5f]/50 bg-[#0a1220]/60 px-3 py-2 font-mono text-sm tabular-nums text-[#93c5fd]">
          <span className="text-[10px] uppercase text-zinc-500">Expires</span>
          {formatCountdown(countdownMs)}
        </div>
      </div>

      <PocketMomentumStrip readout={momentum} />

      {feedErr ? <div className="rounded-xl border border-rose-800/40 bg-rose-950/20 px-3 py-2 text-sm text-rose-200">{feedErr}</div> : null}
      {betMsg ? <div className="rounded-xl border border-emerald-800/40 bg-emerald-950/20 px-3 py-2 text-sm text-emerald-100">{betMsg}</div> : null}
      {betErr ? <div className="rounded-xl border border-rose-800/40 bg-rose-950/20 px-3 py-2 text-sm text-rose-200">{betErr}</div> : null}

      <SpotStyleOhlcChart
        bars={ohlcBars}
        livePrice={livePrice}
        strikePrice={activeStrike}
        chartTitle={`Bitcoin · ${expiryMeta.label} · Pocket Option style`}
        strikeLabel="STRIKE"
        defaultDisplayMode="ohlc"
        countdownMs={countdownMs}
        formatCountdown={formatCountdown}
        ariaLabel="Pocket Option BTC chart"
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="rounded-2xl border border-[#1e3a5f]/50 bg-[#0a1220]/50 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Open positions</div>
          {openBets.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">No open trades — use CALL or PUT when signal confirms.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {openBets.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-black/30 px-3 py-2 text-sm">
                  <span className={b.side === 'up' ? 'font-bold text-emerald-300' : 'font-bold text-rose-300'}>
                    {b.side === 'up' ? 'CALL' : 'PUT'}
                  </span>
                  <span className="font-mono text-zinc-300">${b.stakeUsd.toFixed(2)} @ {fmtSpotUsd(b.strike)}</span>
                  <span className="font-mono text-xs text-zinc-500">{formatCountdown(Math.max(0, b.expiresAtMs - nowMs))}</span>
                </li>
              ))}
            </ul>
          )}
          {settled.length > 0 ? (
            <div className="mt-4 border-t border-zinc-800/60 pt-3">
              <div className="text-[10px] font-semibold uppercase text-zinc-600">Recent</div>
              <ul className="mt-1 space-y-1 text-xs text-zinc-500">
                {settled.slice(0, 5).map((b) => (
                  <li key={`${b.id}-done`}>
                    {b.side === 'up' ? 'CALL' : 'PUT'} · {b.result} ·{' '}
                    <span className={b.pnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {b.pnlUsd >= 0 ? '+' : ''}${b.pnlUsd.toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <div className="rounded-2xl border border-[#1e3a5f]/60 bg-[#0a1220]/70 p-4 ring-1 ring-[#2563eb]/10">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Amount · USD</div>
          <input
            value={stakeStr}
            onChange={(e) => setStakeStr(e.target.value)}
            className="mt-1 w-full rounded-xl border border-[#1e3a5f]/60 bg-black/40 px-3 py-3 font-mono text-2xl font-bold tabular-nums text-white outline-none focus:border-[#2563eb]/60"
            inputMode="decimal"
          />
          <div className="mt-2 flex gap-2">
            {[10, 25, 50, 100].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setStakeStr(String(n))}
                className="flex-1 rounded-lg border border-[#1e3a5f]/50 py-1.5 text-xs font-semibold text-zinc-400 hover:bg-[#0f1a2e]"
              >
                ${n}
              </button>
            ))}
          </div>
          <div className="mt-1 text-center text-[10px] text-zinc-500">Win payout {payoutDisplay} · practice only</div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => placeBet('up')}
              className="flex min-h-[80px] flex-col items-center justify-center rounded-2xl bg-gradient-to-b from-emerald-400 to-emerald-600 font-black text-black shadow-lg shadow-emerald-950/40 hover:from-emerald-300"
            >
              <span className="text-xl">CALL</span>
              <span className="text-[10px] font-semibold opacity-90">Higher · {payoutDisplay}</span>
            </button>
            <button
              type="button"
              onClick={() => placeBet('down')}
              className="flex min-h-[80px] flex-col items-center justify-center rounded-2xl bg-gradient-to-b from-rose-400 to-rose-600 font-black text-black shadow-lg shadow-rose-950/40 hover:from-rose-300"
            >
              <span className="text-xl">PUT</span>
              <span className="text-[10px] font-semibold opacity-90">Lower · {payoutDisplay}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
