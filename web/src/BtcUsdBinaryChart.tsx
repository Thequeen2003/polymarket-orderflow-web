import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react';
import {
  BTC_USD_TF_OPTIONS,
  binaryBiasFromCandles,
  fetchBtcUsdCandles,
  priceMovementFromCandles,
  type BtcUsdCandle,
  type BtcUsdChartTf,
} from './btcUsdCandles';

const W = 720;
const H = 300;
const PAD = { t: 16, r: 56, b: 36, l: 12 };

function fmtUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function BtcUsdBinaryChart(props: {
  tf: BtcUsdChartTf;
  onTfChange: (tf: BtcUsdChartTf) => void;
  /** Binary strike / entry — drawn as amber horizontal. */
  entryPrice?: number | null;
  /** Live mark — cyan dashed horizontal. */
  livePrice?: number | null;
}): ReactElement {
  const { tf, onTfChange, entryPrice, livePrice } = props;
  const gradUp = useId().replace(/:/g, '');
  const gradDn = useId().replace(/:/g, '');

  const [candles, setCandles] = useState<BtcUsdCandle[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const pull = useCallback(async (signal?: AbortSignal) => {
    try {
      const c = await fetchBtcUsdCandles(tf, signal);
      setCandles(c);
      setErr(null);
    } catch (e) {
      if (signal?.aborted) return;
      setErr(e instanceof Error ? e.message : 'Could not load BTCUSDT klines.');
      setCandles([]);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [tf]);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    void pull(ac.signal);
    const id = window.setInterval(() => void pull(), tf === '1m' ? 20_000 : 35_000);
    return () => {
      ac.abort();
      window.clearInterval(id);
    };
  }, [pull, tf]);

  const movement = useMemo(() => priceMovementFromCandles(candles), [candles]);
  const bias = useMemo(() => binaryBiasFromCandles(candles), [candles]);

  const chart = useMemo(() => {
    const innerW = W - PAD.l - PAD.r;
    const innerH = H - PAD.t - PAD.b;
    if (candles.length < 2) {
      return { candles: [] as BtcUsdCandle[], pMin: 0, pMax: 1, xCandle: (_i: number) => 0, yPrice: (_p: number) => 0, innerW, innerH };
    }

    const slice = candles;
    const lows = slice.map((c) => c.l);
    const highs = slice.map((c) => c.h);
    let pMin = Math.min(...lows);
    let pMax = Math.max(...highs);
    if (entryPrice != null && Number.isFinite(entryPrice)) {
      pMin = Math.min(pMin, entryPrice);
      pMax = Math.max(pMax, entryPrice);
    }
    if (livePrice != null && Number.isFinite(livePrice)) {
      pMin = Math.min(pMin, livePrice);
      pMax = Math.max(pMax, livePrice);
    }
    const padPct = 0.04;
    const span = Math.max(1e-9, pMax - pMin);
    pMin -= span * padPct;
    pMax += span * padPct;

    const n = slice.length;
    const slotW = innerW / n;

    const yPrice = (p: number) => PAD.t + innerH - ((p - pMin) / Math.max(1e-12, pMax - pMin)) * innerH;
    const xCandle = (i: number) => PAD.l + slotW * i + slotW / 2;

    return { candles: slice, pMin, pMax, xCandle, yPrice, innerW, innerH, slotW, n };
  }, [candles, entryPrice, livePrice]);

  const hover = hoverIdx != null && chart.candles[hoverIdx] ? chart.candles[hoverIdx]! : null;

  const biasClass =
    bias.verdict === 'UP'
      ? 'border-emerald-500/55 bg-emerald-950/35 text-emerald-200'
      : bias.verdict === 'DOWN'
        ? 'border-rose-500/55 bg-rose-950/35 text-rose-200'
        : 'border-zinc-600/60 bg-zinc-900/40 text-zinc-300';

  const entryDeltaPct =
    entryPrice != null && movement && entryPrice > 0
      ? ((movement.last - entryPrice) / entryPrice) * 100
      : null;

  return (
    <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/60 p-4 ring-1 ring-cyan-500/10 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
            BTC / USD · binary options chart
          </div>
          <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-zinc-500">
            Binance spot <span className="font-mono text-zinc-400">BTCUSDT</span> OHLC candles with timeframe control and
            price-movement readout for short UP/DOWN windows.
          </p>
        </div>
        <div
          className={`rounded-xl border px-4 py-2 text-center font-mono text-lg font-black tracking-tight ${biasClass}`}
          title={bias.justification}
        >
          {loading ? '…' : bias.verdict}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {BTC_USD_TF_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => onTfChange(opt.id)}
            className={`min-h-[34px] rounded-lg px-3 text-[12px] font-bold transition-colors ${
              tf === opt.id
                ? 'bg-cyan-600 text-white ring-1 ring-cyan-400/50'
                : 'border border-zinc-700/80 bg-zinc-900/60 text-zinc-200 hover:border-zinc-600'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {movement ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-zinc-800/60 bg-black/25 px-3 py-2">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Window move</div>
            <div
              className={`mt-0.5 font-mono text-sm font-bold tabular-nums ${movement.changePct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}
            >
              {fmtPct(movement.changePct)}
            </div>
            <div className="text-[10px] text-zinc-600">
              {fmtUsd(movement.low)} → {fmtUsd(movement.high)}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800/60 bg-black/25 px-3 py-2">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Last candle</div>
            <div
              className={`mt-0.5 font-mono text-sm font-bold tabular-nums ${movement.lastBarPct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}
            >
              {fmtPct(movement.lastBarPct)}
            </div>
            <div className="text-[10px] text-zinc-600">
              {movement.bullishBars}↑ · {movement.bearishBars}↓ in view
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800/60 bg-black/25 px-3 py-2">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">3-bar momentum</div>
            <div
              className={`mt-0.5 font-mono text-sm font-bold tabular-nums ${movement.momentumPct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}
            >
              {fmtPct(movement.momentumPct)}
            </div>
            <div className="text-[10px] text-zinc-600">Range position {(movement.rangePosition * 100).toFixed(0)}%</div>
          </div>
          <div className="rounded-xl border border-zinc-800/60 bg-black/25 px-3 py-2">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Last print</div>
            <div className="mt-0.5 font-mono text-sm font-bold tabular-nums text-zinc-100">{fmtUsd(movement.last)}</div>
            {entryDeltaPct != null ? (
              <div className={`text-[10px] font-mono ${entryDeltaPct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                vs entry {fmtPct(entryDeltaPct)}
              </div>
            ) : (
              <div className="text-[10px] text-zinc-600">Set entry below for strike delta</div>
            )}
          </div>
        </div>
      ) : null}

      {err ? (
        <p className="mt-3 text-[12px] text-rose-300">{err}</p>
      ) : (
        <div className="relative mt-4 w-full overflow-x-auto">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="h-auto w-full min-w-[320px]"
            role="img"
            aria-label="BTC USD candlestick chart"
            onMouseLeave={() => setHoverIdx(null)}
          >
            <defs>
              <linearGradient id={gradUp} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="rgb(34 197 94 / 0.35)" />
                <stop offset="100%" stopColor="rgb(34 197 94 / 0.05)" />
              </linearGradient>
              <linearGradient id={gradDn} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="rgb(239 68 68 / 0.35)" />
                <stop offset="100%" stopColor="rgb(239 68 68 / 0.05)" />
              </linearGradient>
            </defs>
            <rect x={0} y={0} width={W} height={H} fill="rgb(9 9 11 / 0.55)" rx={8} />

            {chart.candles.length >= 2
              ? [0.25, 0.5, 0.75].map((frac) => {
                  const p = chart.pMin + (chart.pMax - chart.pMin) * frac;
                  const y = chart.yPrice(p);
                  return (
                    <g key={frac}>
                      <line x1={PAD.l} x2={W - PAD.r} y1={y} y2={y} stroke="rgb(63 63 70 / 0.35)" strokeWidth={1} />
                      <text x={W - PAD.r + 6} y={y + 3} fill="rgb(161 161 170)" fontSize={9} fontFamily="ui-monospace, monospace">
                        {p >= 1000 ? `${(p / 1000).toFixed(1)}k` : p.toFixed(0)}
                      </text>
                    </g>
                  );
                })
              : null}

            {entryPrice != null && Number.isFinite(entryPrice) ? (
              <g>
                <line
                  x1={PAD.l}
                  x2={W - PAD.r}
                  y1={chart.yPrice(entryPrice)}
                  y2={chart.yPrice(entryPrice)}
                  stroke="rgb(251 191 36 / 0.9)"
                  strokeWidth={1.5}
                  strokeDasharray="6 4"
                />
                <text
                  x={PAD.l + 4}
                  y={chart.yPrice(entryPrice) - 4}
                  fill="rgb(251 191 36)"
                  fontSize={9}
                  fontWeight={600}
                >
                  ENTRY {fmtUsd(entryPrice)}
                </text>
              </g>
            ) : null}

            {livePrice != null && Number.isFinite(livePrice) ? (
              <g>
                <line
                  x1={PAD.l}
                  x2={W - PAD.r}
                  y1={chart.yPrice(livePrice)}
                  y2={chart.yPrice(livePrice)}
                  stroke="rgb(34 211 238 / 0.85)"
                  strokeWidth={1.25}
                  strokeDasharray="3 3"
                />
              </g>
            ) : null}

            {chart.candles.map((c, i) => {
              const xc = chart.xCandle(i);
              const slotW = chart.slotW ?? 8;
              const bodyW = Math.max(3, Math.min(slotW * 0.72, 14));
              const yO = chart.yPrice(c.o);
              const yC = chart.yPrice(c.c);
              const yH = chart.yPrice(c.h);
              const yL = chart.yPrice(c.l);
              const bullish = c.c >= c.o;
              const bodyTop = Math.min(yO, yC);
              const bodyBot = Math.max(yO, yC);
              const bodyH = Math.max(2, bodyBot - bodyTop);
              const wickColor = bullish ? 'rgb(74 222 128)' : 'rgb(248 113 113)';
              const bodyFill = bullish ? `url(#${gradUp})` : `url(#${gradDn})`;
              const bodyStroke = bullish ? 'rgb(34 197 94)' : 'rgb(239 68 68)';
              const isHover = hoverIdx === i;
              return (
                <g
                  key={c.t}
                  onMouseEnter={() => setHoverIdx(i)}
                  style={{ cursor: 'crosshair' }}
                >
                  {isHover ? (
                    <rect
                      x={PAD.l + slotW * i}
                      y={PAD.t}
                      width={slotW}
                      height={chart.innerH}
                      fill="rgb(255 255 255 / 0.04)"
                    />
                  ) : null}
                  <line x1={xc} x2={xc} y1={yH} y2={bodyTop} stroke={wickColor} strokeWidth={1.4} />
                  <line x1={xc} x2={xc} y1={bodyTop + bodyH} y2={yL} stroke={wickColor} strokeWidth={1.4} />
                  <rect
                    x={xc - bodyW / 2}
                    y={bodyTop}
                    width={bodyW}
                    height={bodyH}
                    fill={bodyFill}
                    stroke={bodyStroke}
                    strokeWidth={1.2}
                    rx={1}
                  />
                </g>
              );
            })}

            {hover ? (
              <g>
                <rect x={PAD.l + 8} y={PAD.t + 8} width={148} height={58} fill="rgb(0 0 0 / 0.82)" rx={6} stroke="rgb(63 63 70)" />
                <text x={PAD.l + 16} y={PAD.t + 22} fill="rgb(212 212 216)" fontSize={9} fontFamily="ui-monospace, monospace">
                  {fmtTime(hover.t)} · O {hover.o.toFixed(1)}
                </text>
                <text x={PAD.l + 16} y={PAD.t + 36} fill="rgb(212 212 216)" fontSize={9} fontFamily="ui-monospace, monospace">
                  H {hover.h.toFixed(1)} · L {hover.l.toFixed(1)}
                </text>
                <text x={PAD.l + 16} y={PAD.t + 50} fill="rgb(212 212 216)" fontSize={9} fontFamily="ui-monospace, monospace">
                  C {hover.c.toFixed(1)} · vol {hover.v.toFixed(2)}
                </text>
              </g>
            ) : null}
          </svg>
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">{bias.justification}</p>
    </div>
  );
}
