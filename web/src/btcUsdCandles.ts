/** Binance BTCUSDT OHLCV — shared by binary chart + TV tab reads. */

export type BtcUsdCandle = { t: number; o: number; h: number; l: number; c: number; v: number };

export type BtcUsdChartTf = '1m' | '5m' | '10m' | '15m' | '30m' | '1h';

export type BtcUsdBinaryBias = { verdict: 'UP' | 'DOWN' | 'WAIT'; justification: string };

export type BtcUsdPriceMovement = {
  changePct: number;
  lastBarPct: number;
  momentumPct: number;
  rangePosition: number;
  bullishBars: number;
  bearishBars: number;
  high: number;
  low: number;
  last: number;
};

export const BTC_USD_TF_OPTIONS: { id: BtcUsdChartTf; label: string }[] = [
  { id: '1m', label: '1m' },
  { id: '5m', label: '5m' },
  { id: '10m', label: '10m' },
  { id: '15m', label: '15m' },
  { id: '30m', label: '30m' },
  { id: '1h', label: '1h' },
];

export function sma(xs: number[], len: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    if (i + 1 < len) {
      out.push(NaN);
      continue;
    }
    let s = 0;
    for (let j = 0; j < len; j++) s += xs[i - j]!;
    out.push(s / len);
  }
  return out;
}

/** Merge consecutive 5m candles into synthetic 10m (Binance has no native 10m kline). */
export function merge5mTo10m(five: BtcUsdCandle[]): BtcUsdCandle[] {
  const out: BtcUsdCandle[] = [];
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

export function parseKlines(raw: unknown): BtcUsdCandle[] {
  if (!Array.isArray(raw)) return [];
  const out: BtcUsdCandle[] = [];
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

function tfFetchSpec(tf: BtcUsdChartTf): { interval: string; limit: number } {
  if (tf === '1m') return { interval: '1m', limit: 180 };
  if (tf === '5m') return { interval: '5m', limit: 160 };
  if (tf === '15m') return { interval: '15m', limit: 120 };
  if (tf === '30m') return { interval: '30m', limit: 96 };
  return { interval: '1h', limit: 72 };
}

export async function fetchBtcUsdCandles(tf: BtcUsdChartTf, signal?: AbortSignal): Promise<BtcUsdCandle[]> {
  if (tf === '10m') {
    const r = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=160', {
      signal,
      cache: 'no-store',
    });
    if (!r.ok) throw new Error(`klines ${r.status}`);
    const raw = (await r.json()) as unknown;
    return merge5mTo10m(parseKlines(raw));
  }
  const { interval, limit } = tfFetchSpec(tf);
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`, {
    signal,
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`klines ${r.status}`);
  const raw = (await r.json()) as unknown;
  return parseKlines(raw);
}

/** Price movement summary for the visible candle window. */
export function priceMovementFromCandles(candles: BtcUsdCandle[], lookback = 20): BtcUsdPriceMovement | null {
  if (candles.length < 2) return null;
  const slice = candles.slice(-Math.min(lookback, candles.length));
  const first = slice[0]!;
  const lastBar = slice[slice.length - 1]!;
  const last = lastBar.c;
  const changePct = ((last - first.o) / Math.max(1e-12, first.o)) * 100;
  const lastBarPct = ((lastBar.c - lastBar.o) / Math.max(1e-12, lastBar.o)) * 100;
  const ref = slice[Math.max(0, slice.length - 4)]!.c;
  const momentumPct = ((last - ref) / Math.max(1e-12, ref)) * 100;
  const high = Math.max(...slice.map((c) => c.h));
  const low = Math.min(...slice.map((c) => c.l));
  const rangePosition = (last - low) / Math.max(1e-12, high - low);
  let bullishBars = 0;
  let bearishBars = 0;
  for (const c of slice) {
    if (c.c >= c.o) bullishBars++;
    else bearishBars++;
  }
  return {
    changePct,
    lastBarPct,
    momentumPct,
    rangePosition,
    bullishBars,
    bearishBars,
    high,
    low,
    last,
  };
}

/**
 * Rules-only UP/DOWN bias from OHLCV — tuned for short binary-option horizons.
 * No news; uses MAs, slope, range position, and volume vs average.
 */
export function binaryBiasFromCandles(candles: BtcUsdCandle[]): BtcUsdBinaryBias {
  if (candles.length < 28) {
    return {
      verdict: 'WAIT',
      justification: 'Not enough closed candles to score; wait for more bars.',
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
    notes.push('Close above short MA.');
  } else {
    score -= 1;
    notes.push('Close below short MA.');
  }
  if (last > m20) score += 1;
  else score -= 1;

  const slope3 = (last - closes[n - 4]!) / Math.max(1e-12, closes[n - 4]!);
  if (slope3 > 0.0008) {
    score += 1;
    notes.push('Recent closes stair-step higher.');
  } else if (slope3 < -0.0008) {
    score -= 1;
    notes.push('Recent closes stair-step lower.');
  }

  const hi20 = Math.max(...highs.slice(-20));
  const lo20 = Math.min(...lows.slice(-20));
  const rng = Math.max(1e-9, hi20 - lo20);
  const pos = (last - lo20) / rng;
  if (pos > 0.88 && !bullBar) {
    score -= 1;
    notes.push('Price at range top on a weak close.');
  } else if (pos < 0.12 && bullBar) {
    score += 1;
    notes.push('Price lifts from range bottom.');
  }

  if (Number.isFinite(vAvg) && vAvg > 0 && vLast > vAvg * 1.12) {
    if (bullBar) {
      score += 1;
      notes.push('Volume swells on a green close.');
    } else {
      score -= 1;
      notes.push('Volume swells on a red close.');
    }
  }

  const prev = closes[n - 2]!;
  if (last > prev) score += 0.5;
  else if (last < prev) score -= 0.5;

  if (Math.abs(score) < 1.25) {
    return {
      verdict: 'WAIT',
      justification: 'Mixed signals — MAs and momentum disagree; no clear binary edge.',
    };
  }

  const verdict: 'UP' | 'DOWN' = score >= 0 ? 'UP' : 'DOWN';
  const pick = notes.slice(0, 2).join(' ');
  const justification =
    pick ||
    (verdict === 'UP'
      ? 'Net constructive posture vs moving averages.'
      : 'Net defensive posture vs moving averages.');

  return { verdict, justification };
}

/** Map chart TF to TradingView widget interval minutes. */
export function chartTfToTvMinutes(tf: BtcUsdChartTf): '1' | '5' | '10' | '15' | '30' | '60' {
  if (tf === '1m') return '1';
  if (tf === '5m') return '5';
  if (tf === '10m') return '10';
  if (tf === '15m') return '15';
  if (tf === '30m') return '30';
  return '60';
}
