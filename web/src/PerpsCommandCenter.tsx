import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react';

/**
 * Binance USDⓈ-M futures–oriented command center (public REST).
 * Charts use TradingView Binance perp symbols. If browser blocks fapi, TA falls back to spot klines.
 */

type AssetKey = 'BTC' | 'ETH' | 'SOL';

const ASSETS: { key: AssetKey; futuresSymbol: string; tvSymbol: string; label: string }[] = [
  { key: 'BTC', futuresSymbol: 'BTCUSDT', tvSymbol: 'BINANCE:BTCUSDT.P', label: 'BTC' },
  { key: 'ETH', futuresSymbol: 'ETHUSDT', tvSymbol: 'BINANCE:ETHUSDT.P', label: 'ETH' },
  { key: 'SOL', futuresSymbol: 'SOLUSDT', tvSymbol: 'BINANCE:SOLUSDT.P', label: 'SOL' },
];

type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

type PremiumRow = {
  markPrice: number;
  indexPrice: number;
  lastFundingRate: number;
  nextFundingTime: number;
  timeToFundingMs: number;
};

type LiqRisk = 'Low' | 'Medium' | 'High';

type SignalSide = 'LONG' | 'SHORT' | 'WAIT';

type CoreOutput = {
  side: SignalSide;
  entry: number;
  stop: number;
  takeProfit: number;
  liqRisk: LiqRisk;
  entryScore: number;
  reasons: string[];
  liqLong: number;
  liqShort: number;
  positionUsdSuggest: number;
};

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

function atr14(candles: Candle[]): number | null {
  if (candles.length < 16) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c));
    trs.push(tr);
  }
  if (trs.length < 14) return null;
  const tail = trs.slice(-14);
  return tail.reduce((a, b) => a + b, 0) / 14;
}

/** Rough isolated USDT-M liq (education only — not exchange guaranteed). mm ~ maintenance buffer. */
function isoLongLiqUsdM(entry: number, lev: number, mm = 0.005): number {
  const im = 1 / Math.max(1, lev);
  return entry * (1 - im + mm);
}

function isoShortLiqUsdM(entry: number, lev: number, mm = 0.005): number {
  const im = 1 / Math.max(1, lev);
  return entry * (1 + im - mm);
}

function liqBandRisk(mark: number, lev: number, side: 'LONG' | 'SHORT'): LiqRisk {
  const longL = isoLongLiqUsdM(mark, lev);
  const shortL = isoShortLiqUsdM(mark, lev);
  const distPct =
    side === 'LONG'
      ? Math.abs(mark - longL) / mark
      : Math.abs(shortL - mark) / mark;
  if (distPct < 0.015) return 'High';
  if (distPct < 0.04) return 'Medium';
  return 'Low';
}

function tvEmbedSrc(frameId: string, symbol: string): string {
  const p = new URLSearchParams({
    frameElementId: frameId,
    symbol,
    interval: '15',
    hidesidetoolbar: '0',
    symboledit: '1',
    theme: 'dark',
    style: '1',
    timezone: 'exchange',
    locale: 'en',
    utm_medium: 'widget',
    utm_campaign: 'chart',
  });
  return `https://www.tradingview.com/widgetembed/?${p.toString()}`;
}

async function fetchFuturesKlines(symbol: string, signal: AbortSignal): Promise<Candle[] | null> {
  try {
    const r = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=15m&limit=150`,
      { signal, cache: 'no-store' },
    );
    if (!r.ok) return null;
    return parseKlines(await r.json());
  } catch {
    return null;
  }
}

async function fetchSpotKlines(symbol: string, signal: AbortSignal): Promise<Candle[] | null> {
  try {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=15m&limit=150`,
      { signal, cache: 'no-store' },
    );
    if (!r.ok) return null;
    return parseKlines(await r.json());
  } catch {
    return null;
  }
}

async function fetchPremium(symbol: string, signal: AbortSignal): Promise<PremiumRow | null> {
  try {
    const r = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`, {
      signal,
      cache: 'no-store',
    });
    if (!r.ok) return null;
    const j = (await r.json()) as Record<string, unknown>;
    const mark = Number(j.markPrice);
    const idx = Number(j.indexPrice);
    const fr = Number(j.lastFundingRate);
    const nft = Number(j.nextFundingTime);
    if (!Number.isFinite(mark) || mark <= 0) return null;
    const now = Date.now();
    const next = Number.isFinite(nft) ? nft : now + 8 * 3600_000;
    return {
      markPrice: mark,
      indexPrice: Number.isFinite(idx) ? idx : mark,
      lastFundingRate: Number.isFinite(fr) ? fr : 0,
      nextFundingTime: next,
      timeToFundingMs: Math.max(0, next - now),
    };
  } catch {
    return null;
  }
}

/** Combined bias -100..100, reasons for UI */
function computeBias(candles: Candle[]): { score: number; reasons: string[] } {
  if (candles.length < 40) return { score: 0, reasons: ['Insufficient candle history for a stable read.'] };
  const closes = candles.map((c) => c.c);
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);
  const vols = candles.map((c) => c.v);
  const n = closes.length;
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const m20 = ma20[n - 1]!;
  const m50 = ma50[n - 1]!;
  const last = closes[n - 1]!;
  const volAvg = sma(vols, 20)[n - 1]!;
  const vLast = vols[n - 1]!;
  const hi20 = Math.max(...highs.slice(-20));
  const lo20 = Math.min(...lows.slice(-20));
  const rng = Math.max(1e-12, hi20 - lo20);
  const pos = (last - lo20) / rng;

  let s = 0;
  const reasons: string[] = [];

  if (last > m20 && m20 > m50) {
    s += 28;
    reasons.push('Trend: price above 20/50 structure (bullish stack).');
  } else if (last < m20 && m20 < m50) {
    s -= 28;
    reasons.push('Trend: price below 20/50 structure (bearish stack).');
  } else {
    reasons.push('Trend: mixed MA stack — no clean directional bias.');
  }

  const slope5 = (last - closes[n - 6]!) / Math.max(1e-12, closes[n - 6]!);
  if (slope5 > 0.002) {
    s += 18;
    reasons.push('Momentum: short-term slope still lifting.');
  } else if (slope5 < -0.002) {
    s -= 18;
    reasons.push('Momentum: short-term slope rolling over.');
  }

  if (Number.isFinite(volAvg) && volAvg > 0 && vLast > volAvg * 1.2) {
    s += last >= closes[n - 2]! ? 12 : -12;
    reasons.push(`Volume: last bar ${vLast > volAvg * 1.35 ? 'surge' : 'elevated'} vs 20-bar average.`);
  }

  if (pos > 0.88) {
    s -= 14;
    reasons.push('Support/resistance: printing near top of recent 20-bar range (extension risk).');
  } else if (pos < 0.12) {
    s += 14;
    reasons.push('Support/resistance: hugging lower band of recent range (bounce context).');
  } else {
    reasons.push('Support/resistance: mid-range relative to recent swing box.');
  }

  const atr = atr14(candles);
  if (atr != null && last > 0) {
    const vr = atr / last;
    if (vr < 0.0015) reasons.push('Volatility: narrow ATR% — chop risk; WAIT more likely.');
  }

  return { score: Math.max(-100, Math.min(100, s)), reasons: reasons.slice(0, 5) };
}

function buildSignal(args: {
  candles: Candle[];
  mark: number;
  leverage: number;
  riskPct: number;
  accountUsd: number;
}): CoreOutput {
  const { candles, mark, leverage, riskPct, accountUsd } = args;
  const { score, reasons } = computeBias(candles);
  const atr = atr14(candles);
  const atrSafe = atr != null && atr > 0 ? atr : mark * 0.004;

  const slDist = 1.6 * atrSafe;
  const tpDist = 2.8 * atrSafe;

  let side: SignalSide = 'WAIT';
  if (score >= 22) side = 'LONG';
  else if (score <= -22) side = 'SHORT';
  if (Math.abs(score) < 15) side = 'WAIT';
  if (atr != null && mark > 0 && atr / mark < 0.0012 && Math.abs(score) < 35) side = 'WAIT';

  const entry = mark;
  let stop = entry;
  let takeProfit = entry;
  if (side === 'LONG') {
    stop = entry - slDist;
    takeProfit = entry + tpDist;
  } else if (side === 'SHORT') {
    stop = entry + slDist;
    takeProfit = entry - tpDist;
  } else {
    stop = entry - slDist;
    takeProfit = entry + tpDist;
  }

  const liqLong = isoLongLiqUsdM(entry, leverage);
  const liqShort = isoShortLiqUsdM(entry, leverage);
  const liqRisk =
    side === 'LONG'
      ? liqBandRisk(mark, leverage, 'LONG')
      : side === 'SHORT'
        ? liqBandRisk(mark, leverage, 'SHORT')
        : liqBandRisk(mark, leverage, 'LONG');

  const slFrac = side === 'LONG' ? (entry - stop) / entry : side === 'SHORT' ? (stop - entry) / entry : Math.max((entry - stop) / entry, (stop - entry) / entry);
  const riskUsd = Math.max(0, accountUsd) * (riskPct / 100);
  const positionUsdSuggest =
    side === 'WAIT' || !Number.isFinite(slFrac) || slFrac <= 0 ? 0 : riskUsd / slFrac;

  const entryScore = Math.round(Math.min(100, Math.abs(score) + (side === 'WAIT' ? 10 : 18)));

  return {
    side,
    entry,
    stop,
    takeProfit,
    liqRisk,
    entryScore,
    reasons,
    liqLong,
    liqShort,
    positionUsdSuggest,
  };
}

export function PerpsCommandCenter(): ReactElement {
  const frameId = useId().replace(/:/g, '');
  const [asset, setAsset] = useState<AssetKey>('BTC');
  const meta = ASSETS.find((a) => a.key === asset)!;

  const [premium, setPremium] = useState<PremiumRow | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [dataSource, setDataSource] = useState<'futures' | 'spot' | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);

  const [leverage, setLeverage] = useState(10);
  const [riskPct, setRiskPct] = useState(1);
  const [accountUsd, setAccountUsd] = useState(10_000);

  const src = useMemo(() => tvEmbedSrc(frameId, meta.tvSymbol), [frameId, meta.tvSymbol]);

  const poll = useCallback(async () => {
    const ac = new AbortController();
    const t = window.setTimeout(() => ac.abort(), 12_000);
    try {
      const sym = meta.futuresSymbol;
      let kl = await fetchFuturesKlines(sym, ac.signal);
      let srcMode: 'futures' | 'spot' = 'futures';
      if (!kl?.length) {
        kl = await fetchSpotKlines(sym, ac.signal);
        srcMode = 'spot';
      }
      if (!kl?.length) {
        setFetchErr('Could not load OHLCV (network/CORS). Open API may be blocked in this browser.');
        setCandles([]);
        setDataSource(null);
      } else {
        setFetchErr(null);
        setCandles(kl);
        setDataSource(srcMode);
      }
      const prem = await fetchPremium(sym, ac.signal);
      setPremium(prem);
    } catch {
      setFetchErr('Request failed.');
    } finally {
      window.clearTimeout(t);
    }
  }, [meta.futuresSymbol]);

  useEffect(() => {
    void poll();
    const id = window.setInterval(() => void poll(), 12_000);
    return () => window.clearInterval(id);
  }, [poll]);

  const mark = premium?.markPrice ?? (candles.length ? candles[candles.length - 1]!.c : null);

  const core = useMemo(() => {
    if (mark == null || !Number.isFinite(mark) || candles.length < 40) return null;
    return buildSignal({
      candles,
      mark,
      leverage,
      riskPct,
      accountUsd,
    });
  }, [candles, mark, leverage, riskPct, accountUsd]);

  const fundingHours = premium ? premium.timeToFundingMs / 3600_000 : null;

  return (
    <div className="mt-4 min-h-0 w-full max-w-7xl space-y-5 pb-16">
      <div className="rounded-2xl border border-amber-500/25 bg-gradient-to-br from-zinc-950/95 via-zinc-950/90 to-amber-950/10 p-5 ring-1 ring-amber-500/15 sm:p-7">
        <h1 className="text-2xl font-bold tracking-tight text-zinc-50">Perps Trade Command Center</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
          Binance USDⓈ-M–oriented dashboard: live embed charts, klines-based bias, risk sizing, funding snapshot, and simplified liquidation math (
          <span className="text-amber-200/90">educational — not order routing</span>). Uses public REST; if your browser blocks futures endpoints, OHLCV falls back to spot.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {ASSETS.map((a) => (
          <button
            key={a.key}
            type="button"
            onClick={() => setAsset(a.key)}
            className={`min-h-[44px] rounded-xl border px-5 text-sm font-bold transition-colors ${
              asset === a.key
                ? 'border-amber-500/70 bg-amber-950/40 text-amber-50 ring-1 ring-amber-400/35'
                : 'border-zinc-700/70 bg-zinc-900/40 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
            }`}
          >
            {a.label}/USDT
          </button>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <div className="space-y-3">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Chart (TradingView · Binance perp)</div>
          <div className="relative min-h-[420px] w-full overflow-hidden rounded-2xl border border-zinc-800/70 bg-black ring-1 ring-white/[0.05] lg:min-h-[520px]">
            <iframe
              key={src}
              title={`${meta.label} perp chart`}
              src={src}
              className="absolute inset-0 h-full w-full border-0"
              allow="clipboard-write; fullscreen"
            />
          </div>
          <p className="text-center text-[11px] text-zinc-600">
            Charts by{' '}
            <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer" className="text-amber-200/80 hover:underline">
              TradingView
            </a>{' '}
            · {meta.tvSymbol}
          </p>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/60 p-4 ring-1 ring-white/[0.04]">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Mark · funding</div>
            {premium ? (
              <dl className="mt-3 space-y-2 font-mono text-[13px] tabular-nums text-zinc-200">
                <div className="flex justify-between gap-2">
                  <dt className="text-zinc-500">Mark</dt>
                  <dd>${premium.markPrice.toLocaleString(undefined, { maximumFractionDigits: meta.key === 'BTC' ? 2 : 2 })}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-zinc-500">Index</dt>
                  <dd>${premium.indexPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-zinc-500">Last funding (≈8h)</dt>
                  <dd className={premium.lastFundingRate >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                    {(premium.lastFundingRate * 100).toFixed(4)}%
                  </dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-zinc-500">Est. to funding</dt>
                  <dd>{fundingHours != null ? `${fundingHours.toFixed(2)} h` : '—'}</dd>
                </div>
              </dl>
            ) : (
              <p className="mt-2 text-[12px] text-zinc-500">Funding/mark from futures API unavailable — chart still loads.</p>
            )}
            <p className="mt-2 text-[10px] leading-snug text-zinc-600">
              Positive funding ≈ longs pay shorts (crowded long); negative the inverse. Not predictive — risk overlay only.
            </p>
          </div>

          <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/60 p-4 ring-1 ring-white/[0.04]">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Risk inputs</div>
            <label className="mt-3 block">
              <span className="text-[11px] text-zinc-500">Leverage (for liq math)</span>
              <input
                type="range"
                min={1}
                max={50}
                value={leverage}
                onChange={(e) => setLeverage(Number(e.target.value))}
                className="mt-1 w-full accent-amber-500"
              />
              <div className="text-right font-mono text-sm text-amber-200/90">{leverage}x</div>
            </label>
            <label className="mt-3 block">
              <span className="text-[11px] text-zinc-500">Account (USDT notional, paper)</span>
              <input
                value={accountUsd}
                onChange={(e) => setAccountUsd(Number(e.target.value))}
                inputMode="decimal"
                className="mt-1 w-full rounded-lg border border-zinc-800/80 bg-black/30 px-3 py-2 font-mono text-sm text-zinc-100 outline-none focus:border-amber-700/50"
              />
            </label>
            <label className="mt-3 block">
              <span className="text-[11px] text-zinc-500">Risk % per trade</span>
              <input
                type="range"
                min={0.25}
                max={5}
                step={0.25}
                value={riskPct}
                onChange={(e) => setRiskPct(Number(e.target.value))}
                className="mt-1 w-full accent-zinc-500"
              />
              <div className="text-right font-mono text-sm text-zinc-300">{riskPct}%</div>
            </label>
          </div>

          <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/60 p-4 ring-1 ring-white/[0.04]">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Liquidation (isolated approx.)</div>
            {core ? (
              <dl className="mt-3 space-y-2 font-mono text-[12px] tabular-nums text-zinc-300">
                <div className="flex justify-between gap-2">
                  <dt className="text-emerald-300/90">Long liq ~</dt>
                  <dd>${core.liqLong.toLocaleString(undefined, { maximumFractionDigits: 2 })}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-rose-300/90">Short liq ~</dt>
                  <dd>${core.liqShort.toLocaleString(undefined, { maximumFractionDigits: 2 })}</dd>
                </div>
              </dl>
            ) : (
              <p className="mt-2 text-[12px] text-zinc-500">Need live mark + candles.</p>
            )}
            <p className="mt-2 text-[10px] text-zinc-600">Uses simplified isolated formula; always verify on the exchange.</p>
          </div>
        </div>
      </div>

      {fetchErr ? (
        <div className="rounded-xl border border-rose-800/40 bg-rose-950/20 px-4 py-3 text-[13px] text-rose-200/90">{fetchErr}</div>
      ) : null}

      <div className="rounded-2xl border-2 border-amber-500/35 bg-zinc-950/80 p-6 shadow-2xl shadow-black/40 ring-1 ring-amber-500/20">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-200/70">Command output</div>
            <p className="mt-1 text-[11px] text-zinc-500">
              Long/short bias predictor + entry score · SL/TP from ATR bands · position size from risk % · enter vs wait gate
              {dataSource ? (
                <span className="ml-2 rounded-md border border-zinc-700/60 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                  OHLCV: {dataSource}
                </span>
              ) : null}
            </p>
          </div>
          {core ? (
            <div className="text-right">
              <div className="text-[10px] font-semibold uppercase text-zinc-500">Entry score</div>
              <div className="font-mono text-3xl font-black tabular-nums text-amber-200">{core.entryScore}</div>
            </div>
          ) : null}
        </div>

        {core ? (
          <div className="mt-6 grid gap-4 border-t border-zinc-800/60 pt-6 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-2 lg:col-span-3">
              <div
                className={`inline-flex rounded-2xl border-2 px-6 py-4 font-mono text-4xl font-black tracking-tight ${
                  core.side === 'LONG'
                    ? 'border-emerald-500/60 bg-emerald-950/30 text-emerald-300'
                    : core.side === 'SHORT'
                      ? 'border-rose-500/60 bg-rose-950/30 text-rose-300'
                      : 'border-zinc-600/60 bg-zinc-900/40 text-zinc-100'
                }`}
              >
                {core.side}
              </div>
              <p className="mt-3 text-[13px] font-semibold text-zinc-300">
                Should I enter or wait?{' '}
                <span className="text-zinc-100">
                  {core.side === 'WAIT' ? 'WAIT — edge too thin or chop / mixed signals.' : `Bias favors ${core.side} — size from risk panel only if process agrees.`}
                </span>
              </p>
            </div>
            <div className="rounded-xl border border-zinc-800/60 bg-black/30 px-4 py-3 font-mono text-sm text-zinc-200">
              <div className="text-[10px] font-semibold uppercase text-zinc-500">Entry</div>
              <div className="mt-1 text-lg">${core.entry.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
            </div>
            <div className="rounded-xl border border-zinc-800/60 bg-black/30 px-4 py-3 font-mono text-sm text-zinc-200">
              <div className="text-[10px] font-semibold uppercase text-zinc-500">Stop</div>
              <div className="mt-1 text-lg">${core.stop.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
            </div>
            <div className="rounded-xl border border-zinc-800/60 bg-black/30 px-4 py-3 font-mono text-sm text-zinc-200">
              <div className="text-[10px] font-semibold uppercase text-zinc-500">Take profit</div>
              <div className="mt-1 text-lg">${core.takeProfit.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
            </div>
            <div className="rounded-xl border border-zinc-800/60 bg-black/30 px-4 py-3 sm:col-span-2 lg:col-span-1">
              <div className="text-[10px] font-semibold uppercase text-zinc-500">Liquidation risk</div>
              <div
                className={`mt-1 text-xl font-black ${
                  core.liqRisk === 'High' ? 'text-rose-400' : core.liqRisk === 'Medium' ? 'text-amber-300' : 'text-emerald-400'
                }`}
              >
                {core.liqRisk}
              </div>
              <p className="mt-1 text-[11px] text-zinc-500">Vs suggested side @ {leverage}x (approximate).</p>
            </div>
            <div className="rounded-xl border border-zinc-800/60 bg-black/30 px-4 py-3 sm:col-span-2">
              <div className="text-[10px] font-semibold uppercase text-zinc-500">Reason</div>
              <ul className="mt-2 list-inside list-disc space-y-1 text-[13px] leading-relaxed text-zinc-300">
                {core.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl border border-amber-900/40 bg-amber-950/15 px-4 py-3 font-mono text-[13px] text-zinc-200 sm:col-span-2 lg:col-span-3">
              <div className="text-[10px] font-semibold uppercase text-amber-200/80">Position size (risk-based)</div>
              <p className="mt-2">
                Suggested notional ≈{' '}
                <span className="font-bold text-amber-100">
                  ${core.positionUsdSuggest.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>{' '}
                USDT for {riskPct}% risk on ${accountUsd.toLocaleString()} account (linear sizing vs stop distance).
              </p>
              <p className="mt-2 text-[11px] text-zinc-500">
                Funding fee impact (8h, last print):{' '}
                <span className={(premium?.lastFundingRate ?? 0) >= 0 ? 'text-emerald-300/90' : 'text-rose-300/90'}>
                  {(premium?.lastFundingRate ?? 0) * 100 >= 0 ? '+' : ''}
                  {((premium?.lastFundingRate ?? 0) * 100).toFixed(4)}%
                </span>{' '}
                — add to carry cost mentally if holding through funding.
              </p>
            </div>
          </div>
        ) : (
          <p className="mt-6 text-[14px] text-zinc-500">Loading analytics… (need ~40+ closed 15m candles)</p>
        )}
      </div>
    </div>
  );
}
