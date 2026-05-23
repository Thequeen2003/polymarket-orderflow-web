import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react';
import {
  cryptoMarkToMarket,
  cryptoPaperTradeAndPersist,
  getCryptoPaperPosition,
  loadCryptoPaperAccount,
  saveCryptoPaperAccount,
} from './cryptoPaperTrading';
import { BtcUsdDecisionChart } from './BtcUsdDecisionChart';

export type TvTf = '5' | '10' | '30';

/** Isolated from RTDS `BTC-USD` on the other tab — marks here use Binance USDT last. */
const TV_PAPER_SYMBOL = 'BTC-USD-TV';

const DOWN_TICKETS_KEY = 'pm:tvbtc:downTickets:v1';

type DownTicket = { id: string; entryUsdt: number; stakeUsd: number; tf: TvTf; createdAt: number };

function loadDownTickets(): DownTicket[] {
  try {
    const raw = window.localStorage.getItem(DOWN_TICKETS_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw) as unknown;
    if (!Array.isArray(p)) return [];
    const out: DownTicket[] = [];
    for (const row of p) {
      if (!row || typeof row !== 'object') continue;
      const o = row as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id : '';
      const entryUsdt = Number(o.entryUsdt);
      const stakeUsd = Number(o.stakeUsd);
      const tf = o.tf === '5' || o.tf === '10' || o.tf === '30' ? o.tf : null;
      const createdAt = Number(o.createdAt);
      if (!id || !Number.isFinite(entryUsdt) || entryUsdt <= 0 || !Number.isFinite(stakeUsd) || stakeUsd <= 0 || !tf || !Number.isFinite(createdAt)) continue;
      out.push({ id, entryUsdt, stakeUsd, tf, createdAt });
    }
    return out;
  } catch {
    return [];
  }
}

function saveDownTickets(rows: DownTicket[]): void {
  try {
    window.localStorage.setItem(DOWN_TICKETS_KEY, JSON.stringify(rows));
  } catch {
    /* ignore */
  }
}

/** Paper wallet fields are stored as USD×100; display as ordinary dollar amounts (not Polymarket 0–100¢ shares). */
function fmtWalletUsd(usdTimes100: number): string {
  const dollars = usdTimes100 / 100;
  const neg = dollars < 0;
  const abs = Math.abs(dollars);
  return `${neg ? '-' : ''}$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function floorQty8(x: number): number {
  return Math.floor(x * 1e8) / 1e8;
}

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

type SpotTicker = { lastUsd: string; changePct: string } | null;

type ReadResult = { verdict: 'UP' | 'DOWN'; justification: string };

function tradingViewEmbedSrc(frameId: string, interval: TvTf): string {
  const p = new URLSearchParams({
    frameElementId: frameId,
    symbol: 'BINANCE:BTCUSDT',
    interval,
    hidesidetoolbar: '0',
    symboledit: '1',
    saveimage: '1',
    toolbarbg: '131722',
    studies: '[]',
    theme: 'dark',
    style: '1',
    timezone: 'exchange',
    locale: 'en',
    utm_source: '',
    utm_medium: 'widget',
    utm_campaign: 'chart',
    utm_term: 'BINANCE:BTCUSDT',
  });
  return `https://www.tradingview.com/widgetembed/?${p.toString()}`;
}

function sma(xs: number[], len: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (i + 1 < len) {
      out.push(NaN);
      continue;
    }
    let s = 0;
    for (let j = 0; j < len; j++) s += xs[i - j];
    out.push(s / len);
  }
  return out;
}

/** Merge consecutive 5m candles into synthetic 10m (Binance has no native 10m kline). */
function merge5mTo10m(five: Candle[]): Candle[] {
  const out: Candle[] = [];
  const n = five.length - (five.length % 2);
  for (let i = 0; i < n; i += 2) {
    const a = five[i]!;
    const b = five[i + 1]!;
    out.push({
      t: a.t,
      o: a.o,
      h: Math.max(a.h, b.h),
      l: Math.min(a.l, b.l),
      c: b.c,
      v: a.v + b.v,
    });
  }
  return out;
}

function parseKlines(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) return [];
  const out: Candle[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const t = Number(row[0]);
    const o = Number(row[1]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);
    const v = Number(row[5]);
    if (![t, o, h, l, c, v].every((x) => Number.isFinite(x))) continue;
    out.push({ t, o, h, l, c, v });
  }
  return out;
}

/**
 * Rules-only bias from OHLCV (same Binance spot series as BINANCE:BTCUSDT).
 * No news; uses MAs, short slope, range position, and volume vs its average.
 */
function shortTermReadFromCandles(candles: Candle[]): ReadResult {
  if (candles.length < 28) {
    return {
      verdict: 'DOWN',
      justification: 'Not enough closed candles to score; treat as no edge until more bars load.',
    };
  }

  const closes = candles.map((x) => x.c);
  const highs = candles.map((x) => x.h);
  const lows = candles.map((x) => x.l);
  const vols = candles.map((x) => x.v);
  const n = closes.length;
  const last = closes[n - 1]!;
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const vSma = sma(vols, 20);
  const m10 = ma10[n - 1]!;
  const m20 = ma20[n - 1]!;
  const vAvg = vSma[n - 1]!;
  const vLast = vols[n - 1]!;
  const lastBar = candles[n - 1]!;
  const bullBar = lastBar.c >= lastBar.o;

  let score = 0;
  const notes: string[] = [];

  if (last > m10) {
    score += 1;
    notes.push('Close holds above the short MA.');
  } else {
    score -= 1;
    notes.push('Close sits under the short MA.');
  }
  if (last > m20) score += 1;
  else score -= 1;

  const slope3 = (last - closes[n - 4]!) / Math.max(1e-12, closes[n - 4]!);
  if (slope3 > 0) {
    score += 1;
    notes.push('Recent closes stair-step higher.');
  } else if (slope3 < 0) {
    score -= 1;
    notes.push('Recent closes stair-step lower.');
  }

  const hi20 = Math.max(...highs.slice(-20));
  const lo20 = Math.min(...lows.slice(-20));
  const rng = Math.max(1e-9, hi20 - lo20);
  const pos = (last - lo20) / rng;
  if (pos > 0.9 && !bullBar) {
    score -= 1;
    notes.push('Price hugs the top of the recent range on a weak close.');
  } else if (pos < 0.12 && bullBar) {
    score += 1;
    notes.push('Price lifts from the bottom of the recent range.');
  }

  if (Number.isFinite(vAvg) && vAvg > 0 && vLast > vAvg * 1.15) {
    if (bullBar) {
      score += 1;
      notes.push('Volume swells on a supportive (green) close.');
    } else {
      score -= 1;
      notes.push('Volume swells on a defensive (red) close.');
    }
  }

  const prev = closes[n - 2]!;
  if (last > prev) score += 0.5;
  else if (last < prev) score -= 0.5;

  const verdict: 'UP' | 'DOWN' = score >= 0 ? 'UP' : 'DOWN';
  const pick = notes.slice(0, 2).join(' ');
  const justification =
    pick ||
    (verdict === 'UP'
      ? 'Net constructive posture vs moving averages and recent closes.'
      : 'Net defensive posture vs moving averages and recent closes.');

  return { verdict, justification };
}

const TF_OPTIONS: { id: TvTf; label: string }[] = [
  { id: '5', label: '5 mins' },
  { id: '10', label: '10 mins' },
  { id: '30', label: '30 mins' },
];

async function fetchCandlesForTf(tf: TvTf, signal: AbortSignal): Promise<Candle[]> {
  if (tf === '10') {
    const r = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=160', { signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`klines ${r.status}`);
    const raw = (await r.json()) as unknown;
    return merge5mTo10m(parseKlines(raw));
  }
  const interval = tf === '5' ? '5m' : '30m';
  const limit = tf === '5' ? 120 : 80;
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`, {
    signal,
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`klines ${r.status}`);
  const raw = (await r.json()) as unknown;
  return parseKlines(raw);
}

export function TradingViewBtcUsdtTab(): ReactElement {
  const frameId = useId().replace(/:/g, '');
  const [tvTf, setTvTf] = useState<TvTf>('5');
  const src = useMemo(() => tradingViewEmbedSrc(frameId, tvTf), [frameId, tvTf]);

  const [ticker, setTicker] = useState<SpotTicker>(null);
  const [tickerErr, setTickerErr] = useState(false);

  const [readBusy, setReadBusy] = useState(false);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [readOut, setReadOut] = useState<ReadResult | null>(null);

  const [entryStr, setEntryStr] = useState('');
  const [entryDirty, setEntryDirty] = useState(false);
  const [stakeStr, setStakeStr] = useState('50');
  const [account, setAccount] = useState(() => loadCryptoPaperAccount());
  const [downTickets, setDownTickets] = useState<DownTicket[]>(() => loadDownTickets());
  const [betMsg, setBetMsg] = useState<string | null>(null);
  const [betErr, setBetErr] = useState<string | null>(null);

  const markUsd = useMemo(() => (ticker != null && Number.isFinite(Number(ticker.lastUsd)) ? Number(ticker.lastUsd) : null), [ticker]);
  const entryNum = Number(entryStr);
  const stakeUsd = Number(stakeStr);

  useEffect(() => {
    if (ticker && !entryDirty) setEntryStr(ticker.lastUsd);
  }, [ticker, entryDirty]);

  useEffect(() => {
    const pull = () => setAccount(loadCryptoPaperAccount());
    pull();
    const id = window.setInterval(pull, 4000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    let alive = true;

    async function pull(): Promise<void> {
      try {
        const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT', {
          signal: ac.signal,
          cache: 'no-store',
        });
        if (!r.ok || !alive) return;
        const j = (await r.json()) as { lastPrice?: string; priceChangePercent?: string };
        const last = j.lastPrice;
        const ch = j.priceChangePercent;
        if (typeof last === 'string' && typeof ch === 'string' && alive) {
          setTicker({ lastUsd: last, changePct: ch });
          setTickerErr(false);
        }
      } catch {
        if (alive) {
          setTickerErr(true);
          setTicker(null);
        }
      }
    }

    void pull();
    const id = window.setInterval(() => void pull(), 12_000);
    return () => {
      alive = false;
      ac.abort();
      window.clearInterval(id);
    };
  }, []);

  const runRead = useCallback(async () => {
    setReadBusy(true);
    setReadErr(null);
    setReadOut(null);
    const ac = new AbortController();
    const t = window.setTimeout(() => ac.abort(), 14_000);
    try {
      const candles = await fetchCandlesForTf(tvTf, ac.signal);
      setReadOut(shortTermReadFromCandles(candles));
    } catch (e) {
      setReadErr(e instanceof Error ? e.message : 'Could not load klines (network/CORS).');
    } finally {
      window.clearTimeout(t);
      setReadBusy(false);
    }
  }, [tvTf]);

  const chNum = ticker ? Number(ticker.changePct) : NaN;
  const chTone =
    !Number.isFinite(chNum) ? 'text-zinc-400' : chNum >= 0 ? 'text-emerald-300' : 'text-rose-300';

  const posTv = useMemo(() => getCryptoPaperPosition(account, TV_PAPER_SYMBOL), [account]);
  const mtmTv = useMemo(() => cryptoMarkToMarket({ account, symbol: TV_PAPER_SYMBOL, midUsd: markUsd }), [account, markUsd]);

  const tapUp = useCallback(() => {
    setBetErr(null);
    setBetMsg(null);
    if (!Number.isFinite(entryNum) || entryNum <= 0) {
      setBetErr('Set a valid entry price (USDT).');
      return;
    }
    if (!Number.isFinite(stakeUsd) || stakeUsd <= 0) {
      setBetErr('Set a valid stake in USD.');
      return;
    }
    const qty = floorQty8(stakeUsd / entryNum);
    if (!(qty > 0)) {
      setBetErr('Stake too small for that entry.');
      return;
    }
    const a = loadCryptoPaperAccount();
    const r = cryptoPaperTradeAndPersist({ account: a, symbol: TV_PAPER_SYMBOL, side: 'buy', priceUsd: entryNum, qty });
    if (!r.ok) {
      setBetErr(r.error === 'insufficient_cash' ? 'Insufficient paper cash (shared wallet).' : r.error);
      return;
    }
    setAccount(r.account);
    setBetMsg(`UP · paper bought ${qty} BTC (TV tab) @ $${entryNum.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  }, [entryNum, stakeUsd]);

  const tapDown = useCallback(() => {
    setBetErr(null);
    setBetMsg(null);
    if (!Number.isFinite(entryNum) || entryNum <= 0) {
      setBetErr('Set a valid entry price (USDT).');
      return;
    }
    if (!Number.isFinite(stakeUsd) || stakeUsd <= 0) {
      setBetErr('Set a valid stake in USD.');
      return;
    }
    const needCents = Math.round(stakeUsd * 100);
    const a = loadCryptoPaperAccount();
    if (a.cashUsdCents < needCents) {
      setBetErr('Insufficient paper cash for this stake (shared wallet).');
      return;
    }
    a.cashUsdCents -= needCents;
    a.updatedAt = Date.now();
    saveCryptoPaperAccount(a);
    const t: DownTicket = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      entryUsdt: entryNum,
      stakeUsd,
      tf: tvTf,
      createdAt: Date.now(),
    };
    setDownTickets((prev) => {
      const next = [...prev, t];
      saveDownTickets(next);
      return next;
    });
    setAccount(loadCryptoPaperAccount());
    setBetMsg(`DOWN · locked $${stakeUsd.toFixed(2)} vs entry $${entryNum.toLocaleString(undefined, { maximumFractionDigits: 2 })} (${tvTf} chart TF) — settle anytime at live mark.`);
  }, [entryNum, stakeUsd, tvTf]);

  const settleDown = useCallback(
    (id: string) => {
      setBetErr(null);
      setBetMsg(null);
      const ticket = downTickets.find((x) => x.id === id);
      if (!ticket) return;
      if (markUsd == null || !Number.isFinite(markUsd) || markUsd <= 0) {
        setBetErr('Need a live Binance mark to settle.');
        return;
      }
      const pnlUsd = (ticket.stakeUsd * (ticket.entryUsdt - markUsd)) / ticket.entryUsdt;
      const backUsd = ticket.stakeUsd + pnlUsd;
      const a = loadCryptoPaperAccount();
      a.cashUsdCents += Math.round(backUsd * 100);
      a.realizedPnlUsdCents += Math.round(pnlUsd * 100);
      a.updatedAt = Date.now();
      saveCryptoPaperAccount(a);
      setDownTickets((prev) => {
        const next = prev.filter((x) => x.id !== id);
        saveDownTickets(next);
        return next;
      });
      setAccount(a);
      setBetMsg(`Settled DOWN · approx P/L $${pnlUsd.toFixed(2)} (mark $${markUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}).`);
    },
    [downTickets, markUsd],
  );

  const closeLong = useCallback(() => {
    setBetErr(null);
    setBetMsg(null);
    if (markUsd == null || !Number.isFinite(markUsd) || markUsd <= 0) {
      setBetErr('Need a live Binance mark to sell.');
      return;
    }
    const a0 = loadCryptoPaperAccount();
    const q0 = getCryptoPaperPosition(a0, TV_PAPER_SYMBOL).qty;
    if (!(q0 > 0)) {
      setBetErr('No TV-tab long to close.');
      return;
    }
    const r = cryptoPaperTradeAndPersist({ account: a0, symbol: TV_PAPER_SYMBOL, side: 'sell', qty: q0, priceUsd: markUsd });
    if (!r.ok) {
      setBetErr(r.error);
      return;
    }
    setAccount(r.account);
    setBetMsg(`Closed TV long @ ~$${markUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}.`);
  }, [markUsd]);

  return (
    <div className="mt-5 space-y-4">
      <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/40 p-4 ring-1 ring-white/[0.03] sm:p-5">
        <h2 className="text-lg font-semibold tracking-tight text-zinc-100">BTC / USDT · spot chart</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">
          This is <span className="font-medium text-zinc-300">not</span> a Polymarket CLOB market — TradingView embed of Binance spot{' '}
          <span className="font-mono text-zinc-300">BTCUSDT</span>. Use the timeframe strip and the orange chart-read button below (separate from any Polymarket
          trade UI elsewhere in the app).
        </p>
        <div className="mt-3 border-t border-zinc-800/50 pt-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Spot last (USDT, full price)</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-2 font-mono tabular-nums">
            {ticker ? (
              <>
                <span className="text-2xl font-black tracking-tight text-zinc-50">
                  ${Number(ticker.lastUsd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <span className={`text-sm font-semibold ${chTone}`}>
                  24h {Number.isFinite(chNum) && chNum >= 0 ? '+' : ''}
                  {ticker.changePct}%
                </span>
              </>
            ) : tickerErr ? (
              <span className="text-sm text-zinc-500">Spot strip unavailable (browser blocked public ticker). Use the chart price readout.</span>
            ) : (
              <span className="text-sm text-zinc-500">Loading spot reference…</span>
            )}
          </div>
        </div>
      </div>

      <BtcUsdDecisionChart />

      {/* Timeframes + chart read: standalone controls (not Polymarket). */}
      <div className="rounded-2xl border border-zinc-800/70 bg-[#131722] p-3 ring-1 ring-orange-500/15 sm:p-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Chart timeframe</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {TF_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => {
                setTvTf(opt.id);
                setReadOut(null);
                setReadErr(null);
              }}
              className={`min-h-[40px] rounded-lg px-4 text-[13px] font-bold transition-colors ${
                tvTf === opt.id
                  ? 'bg-[#ff5a1f] text-white shadow-md shadow-orange-950/40 ring-1 ring-orange-400/50'
                  : 'border border-zinc-700/80 bg-zinc-900/60 text-zinc-200 hover:border-zinc-600 hover:bg-zinc-800/80'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
          10m uses merged pairs of 5m candles so the read matches a 10-minute view. The chart iframe reloads when you switch TF.
        </p>
        <div className="mt-4 border-t border-zinc-800/60 pt-4">
          <button
            type="button"
            disabled={readBusy}
            onClick={() => void runRead()}
            className="w-full min-h-[48px] rounded-xl bg-[#ff5a1f] px-4 text-sm font-black text-white shadow-lg shadow-orange-950/35 ring-1 ring-orange-400/40 hover:bg-[#ff6a2f] disabled:cursor-wait disabled:opacity-70 sm:max-w-md"
          >
            {readBusy ? 'Reading closed bars…' : 'Short-term read (same data as chart)'}
          </button>
          <p className="mt-2 text-[10px] leading-relaxed text-zinc-600">
            Fetches Binance public klines for the selected TF, scores only OHLCV (trend vs MAs, micro-slope, range location, volume vs avg). Output is{' '}
            <span className="font-mono text-zinc-400">UP</span> or <span className="font-mono text-zinc-400">DOWN</span> — not financial advice.
          </p>
          {readErr ? <p className="mt-2 text-[12px] text-rose-300">{readErr}</p> : null}
          {readOut ? (
            <div className="mt-3 rounded-xl border border-zinc-700/60 bg-black/35 px-4 py-3">
              <div className="font-mono text-2xl font-black tabular-nums text-zinc-50">{readOut.verdict}</div>
              <p className="mt-2 text-[13px] leading-snug text-zinc-300">{readOut.justification}</p>
            </div>
          ) : null}
        </div>
      </div>

      {/* Paper: buy at entry + tap UP (spot long) or DOWN (locked stake, settle vs mark) — not Polymarket. */}
      <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/50 p-4 ring-1 ring-emerald-500/10 sm:p-5">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Paper at price · tap direction</div>
        <p className="mt-1 text-[12px] leading-relaxed text-zinc-500">
          Choose <span className="text-zinc-300">5 / 10 / 30</span> above for your chart context. Set <span className="text-zinc-300">entry (USDT)</span> and{' '}
          <span className="text-zinc-300">$ stake</span>, then tap <span className="font-semibold text-emerald-300">UP</span> or{' '}
          <span className="font-semibold text-rose-300">DOWN</span>. Uses the same paper cash wallet as the <span className="text-zinc-300">BTC (paper)</span> tab;
          positions are tagged <span className="font-mono text-zinc-400">{TV_PAPER_SYMBOL}</span> so they do not mix with RTDS <span className="font-mono text-zinc-400">BTC-USD</span>.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block rounded-xl border border-zinc-800/70 bg-black/25 px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Entry price (USDT)</span>
            <input
              value={entryStr}
              onChange={(e) => {
                setEntryDirty(true);
                setEntryStr(e.target.value);
              }}
              inputMode="decimal"
              className="mt-1 w-full bg-transparent font-mono text-lg font-semibold tabular-nums text-zinc-100 outline-none"
              placeholder="78266.62"
            />
          </label>
          <label className="block rounded-xl border border-zinc-800/70 bg-black/25 px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Stake (USD)</span>
            <input
              value={stakeStr}
              onChange={(e) => setStakeStr(e.target.value)}
              inputMode="decimal"
              className="mt-1 w-full bg-transparent font-mono text-lg font-semibold tabular-nums text-zinc-100 outline-none"
              placeholder="50"
            />
          </label>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!ticker}
            onClick={() => {
              setEntryDirty(false);
              if (ticker) setEntryStr(ticker.lastUsd);
            }}
            className="rounded-lg border border-zinc-600/70 bg-zinc-900/60 px-3 py-1.5 text-[11px] font-bold text-zinc-200 hover:bg-zinc-800/80 disabled:opacity-40"
          >
            Sync entry → live last
          </button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => void tapUp()}
            className="min-h-[56px] rounded-xl bg-emerald-500 px-3 text-lg font-black text-black shadow-lg shadow-emerald-950/30 hover:bg-emerald-400"
          >
            UP
          </button>
          <button
            type="button"
            onClick={() => void tapDown()}
            className="min-h-[56px] rounded-xl bg-rose-500 px-3 text-lg font-black text-white shadow-lg shadow-rose-950/30 hover:bg-rose-400"
          >
            DOWN
          </button>
        </div>
        {betErr ? <p className="mt-2 text-[12px] text-rose-300">{betErr}</p> : null}
        {betMsg ? <p className="mt-2 text-[12px] text-emerald-200/90">{betMsg}</p> : null}

        <div className="mt-4 border-t border-zinc-800/60 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[11px] font-semibold text-zinc-400">Paper wallet</div>
            <div className="font-mono text-[12px] tabular-nums text-zinc-200">Cash {fmtWalletUsd(account.cashUsdCents)}</div>
          </div>
          <div className="mt-2 rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2 text-[12px] text-zinc-300">
            <span className="text-zinc-500">TV long </span>
            <span className="font-mono font-semibold text-zinc-100">{posTv.qty > 0 ? `${posTv.qty.toFixed(8)} BTC` : '— flat —'}</span>
            {posTv.avgCostUsd != null && posTv.qty > 0 ? (
              <span className="text-zinc-500"> · avg ${posTv.avgCostUsd.toFixed(2)}</span>
            ) : null}
            {markUsd != null && posTv.qty > 0 ? (
              <span className="text-zinc-500"> · uPnL {fmtWalletUsd(mtmTv.unrealizedPnlUsdCents)}</span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => void closeLong()}
            disabled={!(posTv.qty > 0) || markUsd == null}
            className="mt-2 w-full min-h-[40px] rounded-lg border border-zinc-600/80 bg-zinc-900/50 text-[12px] font-bold text-zinc-200 hover:bg-zinc-800/70 disabled:opacity-40"
          >
            Close TV long @ live mark
          </button>
        </div>

        {downTickets.length > 0 ? (
          <div className="mt-4 border-t border-zinc-800/60 pt-3">
            <div className="text-[11px] font-semibold text-zinc-400">Open DOWN tickets (stake locked)</div>
            <ul className="mt-2 space-y-2">
              {downTickets.map((tk) => {
                const u =
                  markUsd != null && Number.isFinite(markUsd)
                    ? (tk.stakeUsd * (tk.entryUsdt - markUsd)) / tk.entryUsdt
                    : null;
                return (
                  <li key={tk.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-900/35 bg-rose-950/15 px-3 py-2 text-[11px]">
                    <div className="min-w-0 text-zinc-300">
                      <span className="font-mono text-zinc-100">${tk.entryUsdt.toLocaleString()}</span> entry · ${tk.stakeUsd.toFixed(0)} st ·{' '}
                      <span className="text-zinc-500">{tk.tf}m</span>
                      {u != null && Number.isFinite(u) ? (
                        <span className={`ml-2 font-mono ${u >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>Δ ~${u.toFixed(2)}</span>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={() => settleDown(tk.id)}
                      disabled={markUsd == null}
                      className="shrink-0 rounded-lg border border-rose-700/50 bg-rose-900/30 px-2.5 py-1 text-[10px] font-black text-rose-100 hover:bg-rose-900/50 disabled:opacity-40"
                    >
                      Settle
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="relative w-full overflow-hidden rounded-2xl border border-zinc-800/60 bg-black ring-1 ring-white/[0.04]" style={{ minHeight: 'min(74vh, 760px)' }}>
        <iframe
          key={src}
          id={frameId}
          title="TradingView BTCUSDT chart"
          src={src}
          className="absolute inset-0 h-full w-full border-0"
          allow="clipboard-write; fullscreen"
          referrerPolicy="no-referrer-when-downgrade"
        />
      </div>

      <p className="text-center text-[11px] leading-relaxed text-zinc-600">
        Charts by{' '}
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noreferrer"
          className="text-amber-200/90 underline-offset-2 hover:underline"
        >
          TradingView
        </a>
        . Symbol <span className="font-mono text-zinc-500">BINANCE:BTCUSDT</span>.
      </p>
    </div>
  );
}
