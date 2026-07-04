/**
 * Short-horizon binary candle direction model — predicts whether price finishes
 * above or below the strike at expiry (UP/DOWN binary options on candle movement).
 */

export type BinaryCandle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** False while the bar is still forming. */
  closed: boolean;
};

export type BinaryExpirySec = 3 | 10 | 30 | 60 | 120 | 180 | 300 | 600 | 900;

export type BinaryAsset = 'BTC' | 'ETH' | 'SOL';

/** IQ Option turbo expiries (minutes) — matches IQ Option binary windows. */
export const IQ_BINARY_EXPIRY_OPTIONS: { sec: BinaryExpirySec; label: string; iqMin: number }[] = [
  { sec: 60, label: '1m', iqMin: 1 },
  { sec: 120, label: '2m', iqMin: 2 },
  { sec: 180, label: '3m', iqMin: 3 },
  { sec: 300, label: '5m', iqMin: 5 },
  { sec: 600, label: '10m', iqMin: 10 },
  { sec: 900, label: '15m', iqMin: 15 },
];

export const BINARY_EXPIRY_OPTIONS: { sec: BinaryExpirySec; label: string }[] = [
  { sec: 3, label: '3s' },
  { sec: 10, label: '10s' },
  { sec: 30, label: '30s' },
  { sec: 60, label: '1m' },
  { sec: 120, label: '2m' },
  { sec: 300, label: '5m' },
  { sec: 600, label: '10m' },
  { sec: 900, label: '15m' },
];

export const BINARY_ASSETS: { key: BinaryAsset; symbol: string; label: string }[] = [
  { key: 'BTC', symbol: 'BTCUSDT', label: 'BTC' },
  { key: 'ETH', symbol: 'ETHUSDT', label: 'ETH' },
  { key: 'SOL', symbol: 'SOLUSDT', label: 'SOL' },
];

export type BinaryPrediction = {
  direction: 'up' | 'down';
  probUp: number;
  confidencePct: number;
  score: number;
  reasons: string[];
  strikePrice: number;
  expiresAtMs: number;
};

export type FlowTick = { t: number; p: number; buyVol?: number; sellVol?: number };

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function sma(xs: number[], len: number): number[] {
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

/** Each chart bar = one binary expiry window (3s bar when 3s expiry is selected). */
export function barIntervalMsForExpiry(expirySec: number): number {
  return Math.max(1_000, expirySec * 1000);
}

/** @deprecated Use barIntervalMsForExpiry — bars now match the selected expiry window. */
export function chartIntervalMsForExpiry(expirySec: number): number {
  return barIntervalMsForExpiry(expirySec);
}

/** Next aligned expiry bucket boundary for countdown UI. */
export function nextExpiryBucketMs(nowMs: number, expirySec: number): number {
  const step = expirySec * 1000;
  return Math.ceil(nowMs / step) * step;
}

/** Fraction [0,1] elapsed in the current expiry bucket. */
export function expiryBucketProgress(nowMs: number, expirySec: number): number {
  const step = expirySec * 1000;
  const bucketStart = Math.floor(nowMs / step) * step;
  return Math.min(1, Math.max(0, (nowMs - bucketStart) / step));
}

/** Binance kline interval string when REST history is used. */
export function binanceKlineIntervalForExpiry(expirySec: number): string {
  if (expirySec <= 60) return '1m';
  if (expirySec <= 300) return '5m';
  return '15m';
}

/** Merge finer klines into exact expiry-sized bars. */
export function rebucketKlines(klines: BinaryCandle[], intervalMs: number): BinaryCandle[] {
  if (klines.length === 0) return [];
  const buckets = new Map<number, BinaryCandle>();
  for (const k of klines) {
    const bucket = Math.floor(k.t / intervalMs) * intervalMs;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, { t: bucket, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, closed: true });
      continue;
    }
    buckets.set(bucket, {
      t: bucket,
      o: existing.o,
      h: Math.max(existing.h, k.h),
      l: Math.min(existing.l, k.l),
      c: k.c,
      v: existing.v + k.v,
      closed: true,
    });
  }
  return [...buckets.values()].sort((a, b) => a.t - b.t);
}

/** Build OHLCV series from agg-trade prints bucketed to the bar interval. */
export function buildCandlesFromAggTrades(
  trades: { time: number; price: number; qty: number }[],
  intervalMs: number,
): BinaryCandle[] {
  const sorted = [...trades].sort((a, b) => a.time - b.time);
  let candles: BinaryCandle[] = [];
  for (const t of sorted) {
    if (!Number.isFinite(t.price) || t.price <= 0) continue;
    candles = upsertTickCandle(candles, { t: t.time, p: t.price, buyVol: t.qty }, intervalMs);
  }
  if (candles.length === 0) return candles;
  const next = [...candles];
  for (let i = 0; i < next.length - 1; i++) next[i] = { ...next[i]!, closed: true };
  return next;
}

/** Seed chart history: ticks for ultra-short expiries, rebucketed klines for longer ones. */
export function seedLiveCandleSeries(input: {
  expirySec: number;
  klines: BinaryCandle[];
  trades: { time: number; price: number; qty: number }[];
  livePrice: number | null;
  nowMs: number;
  maxBars?: number;
}): BinaryCandle[] {
  const intervalMs = barIntervalMsForExpiry(input.expirySec);
  const maxBars = input.maxBars ?? 48;
  let base: BinaryCandle[] =
    input.expirySec <= 60
      ? buildCandlesFromAggTrades(input.trades, intervalMs)
      : rebucketKlines(input.klines, intervalMs);

  base = base.slice(-maxBars);
  if (input.livePrice != null && Number.isFinite(input.livePrice) && input.livePrice > 0) {
    base = upsertTickCandle(base, { t: input.nowMs, p: input.livePrice }, intervalMs);
  }
  return base.slice(-maxBars);
}

export function parseBinanceKlines(raw: unknown): BinaryCandle[] {
  if (!Array.isArray(raw)) return [];
  const out: BinaryCandle[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const t = Number(row[0]);
    const o = Number(row[1]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);
    const v = Number(row[5]);
    if (![t, o, h, l, c, v].every((x) => Number.isFinite(x))) continue;
    out.push({ t, o, h, l, c, v, closed: true });
  }
  return out;
}

/** Bucket a price tick into synthetic OHLCV candles. */
export function upsertTickCandle(candles: BinaryCandle[], tick: FlowTick, intervalMs: number): BinaryCandle[] {
  const bucket = Math.floor(tick.t / intervalMs) * intervalMs;
  const next = [...candles];
  const last = next[next.length - 1];

  if (last && last.t === bucket) {
    next[next.length - 1] = {
      ...last,
      h: Math.max(last.h, tick.p),
      l: Math.min(last.l, tick.p),
      c: tick.p,
      v: last.v + (tick.buyVol ?? 0) + (tick.sellVol ?? 0),
      closed: false,
    };
    return next;
  }

  if (last && !last.closed) {
    next[next.length - 1] = { ...last, closed: true };
  }

  next.push({
    t: bucket,
    o: tick.p,
    h: tick.p,
    l: tick.p,
    c: tick.p,
    v: (tick.buyVol ?? 0) + (tick.sellVol ?? 0),
    closed: false,
  });
  return next.slice(-120);
}

/** Merge a live mark into the trailing (possibly open) kline bar. */
export function mergeLiveIntoCandles(candles: BinaryCandle[], livePrice: number, nowMs: number, intervalMs: number): BinaryCandle[] {
  if (!Number.isFinite(livePrice) || livePrice <= 0 || candles.length === 0) return candles;
  const bucket = Math.floor(nowMs / intervalMs) * intervalMs;
  const next = [...candles];
  const lastIdx = next.length - 1;
  const last = next[lastIdx]!;

  if (last.t === bucket) {
    next[lastIdx] = {
      ...last,
      h: Math.max(last.h, livePrice),
      l: Math.min(last.l, livePrice),
      c: livePrice,
      closed: false,
    };
    return next;
  }

  if (last.t < bucket) {
    if (!last.closed) next[lastIdx] = { ...last, closed: true };
    next.push({
      t: bucket,
      o: livePrice,
      h: livePrice,
      l: livePrice,
      c: livePrice,
      v: 0,
      closed: false,
    });
  }
  return next.slice(-120);
}

export function msUntilExpiry(expiresAtMs: number, nowMs: number): number {
  return Math.max(0, expiresAtMs - nowMs);
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return '0.0s';
  if (ms < 60_000) {
    const s = ms / 1000;
    return s < 10 ? `${s.toFixed(1)}s` : `${Math.ceil(s)}s`;
  }
  const m = Math.floor(ms / 60_000);
  const s = Math.ceil((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Score short-horizon direction from OHLCV + optional tick flow.
 * Positive score → UP favored; mapped through sigmoid to probUp.
 */
export function predictBinaryDirection(input: {
  candles: BinaryCandle[];
  livePrice: number;
  expirySec: number;
  nowMs: number;
  buyVolRecent?: number;
  sellVolRecent?: number;
}): BinaryPrediction {
  const { candles, livePrice, expirySec, nowMs } = input;
  const strikePrice = livePrice;
  const expiresAtMs = nowMs + expirySec * 1000;
  const reasons: string[] = [];
  let score = 0;

  if (candles.length < 3) {
    return {
      direction: 'up',
      probUp: 0.5,
      confidencePct: 50,
      score: 0,
      reasons: ['Waiting for more candle history…'],
      strikePrice,
      expiresAtMs,
    };
  }

  const closed = candles.filter((c) => c.closed);
  const series = closed.length >= 5 ? closed : candles;
  const closes = series.map((c) => c.c);
  const n = closes.length;
  const lastClose = closes[n - 1]!;
  const openBar = candles[candles.length - 1]!;
  const barBull = livePrice >= openBar.o;

  // Live bar direction — strongest signal for ultra-short expiries.
  if (barBull) {
    score += expirySec <= 30 ? 1.4 : 0.8;
    reasons.push('Live bar printing green vs its open.');
  } else {
    score -= expirySec <= 30 ? 1.4 : 0.8;
    reasons.push('Live bar printing red vs its open.');
  }

  const ma5 = sma(closes, Math.min(5, n));
  const ma10 = sma(closes, Math.min(10, n));
  const m5 = ma5[n - 1];
  const m10 = ma10[n - 1];
  if (Number.isFinite(m5!) && Number.isFinite(m10!)) {
    if (livePrice > m5! && m5! > m10!) {
      score += 1;
      reasons.push('Price stacked above short MAs.');
    } else if (livePrice < m5! && m5! < m10!) {
      score -= 1;
      reasons.push('Price stacked below short MAs.');
    }
  }

  const lookback = Math.min(4, n - 1);
  if (lookback >= 2) {
    const slope = (lastClose - closes[n - 1 - lookback]!) / Math.max(1e-12, closes[n - 1 - lookback]!);
    const microWeight = expirySec <= 60 ? 2.2 : 1.0;
    if (slope > 0) {
      score += microWeight * Math.min(0.003, slope) / 0.0008;
      if (reasons.length < 4) reasons.push('Micro momentum slopes up.');
    } else if (slope < 0) {
      score -= microWeight * Math.min(0.003, Math.abs(slope)) / 0.0008;
      if (reasons.length < 4) reasons.push('Micro momentum slopes down.');
    }
  }

  const hi = Math.max(...series.slice(-12).map((c) => c.h));
  const lo = Math.min(...series.slice(-12).map((c) => c.l));
  const rng = Math.max(1e-9, hi - lo);
  const pos = (livePrice - lo) / rng;
  if (pos > 0.88 && !barBull) {
    score -= 0.7;
    reasons.push('Rejection near range top.');
  } else if (pos < 0.12 && barBull) {
    score += 0.7;
    reasons.push('Bounce from range floor.');
  }

  const buyV = input.buyVolRecent ?? 0;
  const sellV = input.sellVolRecent ?? 0;
  const flowTotal = buyV + sellV;
  if (flowTotal > 0) {
    const imbalance = (buyV - sellV) / flowTotal;
    score += imbalance * (expirySec <= 60 ? 1.5 : 0.8);
    if (imbalance > 0.15) reasons.push('Agg-trade flow skews buy-side.');
    else if (imbalance < -0.15) reasons.push('Agg-trade flow skews sell-side.');
  }

  const prev = closes[n - 2];
  if (prev != null) {
    if (livePrice > prev) score += 0.4;
    else if (livePrice < prev) score -= 0.4;
  }

  const probUp = clamp01(sigmoid(score * 0.55));
  const confidencePct = Math.round(Math.abs(probUp - 0.5) * 200);
  const direction: 'up' | 'down' = probUp >= 0.5 ? 'up' : 'down';

  return {
    direction,
    probUp,
    confidencePct,
    score,
    reasons: reasons.slice(0, 4),
    strikePrice,
    expiresAtMs,
  };
}

/** Resolve a paper binary bet at expiry. */
export function settleBinaryBet(
  side: 'up' | 'down',
  strike: number,
  settlePrice: number,
): 'win' | 'loss' | 'push' {
  if (!Number.isFinite(strike) || !Number.isFinite(settlePrice)) return 'push';
  if (settlePrice === strike) return 'push';
  const wentUp = settlePrice > strike;
  if (side === 'up') return wentUp ? 'win' : 'loss';
  return wentUp ? 'loss' : 'win';
}

export const BINARY_PAYOUT_MULT = 0.85;
