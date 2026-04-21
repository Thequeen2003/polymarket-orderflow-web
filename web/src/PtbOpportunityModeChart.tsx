import { useDeferredValue, useId, useMemo, useState, type ReactElement } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import { computePtbChartDerivatives, type PtbControlSignal } from './ptbChartDerivatives';
import { PTB_REACTION_DIMENSIONS, PTB_REACTION_ONE_LINER } from './ptbReactionFramework';
import { STREAM_ATTRIBUTION_LINE } from './streamAttribution';
import { anchorPriceScale, buildSpotCandles, candleStraddlesPtb, ptbTouchEpsilonUsd } from './spotVsPtb';

type Mode = 'up' | 'down';
type DominanceStatus = 'UP BIAS' | 'DOWN BIAS' | 'AT PTB';

const MODE_META: Record<Mode, { label: string; accent: string; soft: string; strongText: string; zoneLabel: string }> = {
  up: {
    label: 'UP VIEW',
    accent: 'rgb(52 211 153)',
    soft: 'rgba(16, 185, 129, 0.16)',
    strongText: 'text-emerald-300',
    zoneLabel: 'PTB DECISION LINE',
  },
  down: {
    label: 'DOWN VIEW',
    accent: 'rgb(248 113 113)',
    soft: 'rgba(239, 68, 68, 0.16)',
    strongText: 'text-rose-300',
    zoneLabel: 'PTB DECISION LINE',
  },
};

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function fmtUsd(n: number | null): string {
  return n == null || !Number.isFinite(n) ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtUsdSigned(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtPctSigned(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtAxisPrice(p: number): string {
  const a = Math.abs(p);
  if (a >= 1_000_000) return `$${(p / 1_000_000).toFixed(2)}M`;
  if (a >= 1_000) return `$${(p / 1_000).toFixed(2)}k`;
  return `$${p.toFixed(2)}`;
}

function fmtDwell(ms: number): string {
  if (ms < 500) return '0s';
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  const m = ms / 60_000;
  return m >= 10 ? `${m.toFixed(0)}m` : `${m.toFixed(1)}m`;
}

/** `m:ss` countdown from remaining ms (market round). */
function fmtTimeRemaining(endsInMs: number | null | undefined): string {
  if (endsInMs == null || !Number.isFinite(endsInMs)) return '—';
  const totalSec = Math.max(0, Math.floor(endsInMs / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function pctOfTotal(part: number, total: number): string {
  if (!(total > 0)) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

function statusSubtitle(params: {
  control: PtbControlSignal | undefined;
  momentum: 'UP' | 'DOWN' | 'NEUTRAL' | undefined;
}): string | null {
  const { control, momentum } = params;
  if (!control) return null;
  if (control === 'TRANSITION') return 'weakening or rotation';
  if (control === 'REJECTION') return 'line test failed';
  if (control === 'NO_EDGE') return 'near PTB band — low edge';
  if (control === 'UP_CONTROL' && momentum === 'DOWN') return 'weakening';
  if (control === 'DOWN_CONTROL' && momentum === 'UP') return 'weakening';
  return null;
}

function withAlpha(rgb: string, alpha: number): string {
  const m = rgb.match(/\d+/g);
  if (!m || m.length < 3) return rgb;
  return `rgba(${m[0]}, ${m[1]}, ${m[2]}, ${alpha})`;
}

function statusFor(params: { price: number; level: number; band: number; recentMove: number }): DominanceStatus {
  const { price, level, band, recentMove } = params;
  if (price > level + band && recentMove >= 0) return 'UP BIAS';
  if (price < level - band && recentMove <= 0) return 'DOWN BIAS';
  if (price > level + band * 1.35) return 'UP BIAS';
  if (price < level - band * 1.35) return 'DOWN BIAS';
  return 'AT PTB';
}

const W = 920;
const H = 420;

/**
 * OHLC bucket count: scales with tick count but stays below ~1 bucket / 2 ticks
 * so `buildSpotCandles` does not drop most buckets as empty (which looks like “no candles”).
 */
function candleBucketCount(ptsLen: number): number {
  if (ptsLen < 4) return Math.max(2, ptsLen - 1);
  const n = Math.floor(ptsLen * 0.38);
  // Rendering cost is dominated by candle SVG elements; keep this modest for smoothness.
  return Math.min(36, Math.max(14, n));
}

/** Evenly spaced time ticks (short windows get more labels, like Polymarket’s intraday strip). */
function buildEvenXTicks(tMin: number, tMax: number): number[] {
  const span = Math.max(1, tMax - tMin);
  const n = span < 120_000 ? 8 : span < 3_600_000 ? 7 : 6;
  const step = span / (n - 1);
  return Array.from({ length: n }, (_, i) => tMin + i * step);
}
const PAD_L = 18;
const PAD_R = 64;
const PAD_Y = 18;

export function PtbOpportunityModeChart(props: {
  mode: Mode;
  spot: SpotPoint[];
  priceToBeat: number | null;
  lastUpdateMs: number | null;
  /** Milliseconds until market / round end (from parent); drives “Time remaining”. */
  endsInMs?: number | null;
  chartTitle?: string;
  upLabel?: string;
  downLabel?: string;
}): ReactElement {
  const { mode, spot, priceToBeat, lastUpdateMs, endsInMs = null, chartTitle = 'Spot (USD)', upLabel = 'UP', downLabel = 'DOWN' } = props;
  const gradId = useId().replace(/:/g, '');
  /** LINE first matches common Polymarket UX: early window reads as a path on a short clock; switch to OHLC when you want buckets. */
  const [displayMode, setDisplayMode] = useState<'line' | 'ohlc'>('line');

  // Smaller window reduces SVG work and keeps UI responsive.
  const pts = useMemo(() => spot.filter((p) => isFiniteNumber(p.t) && isFiniteNumber(p.v)).slice(-260), [spot]);
  const deferredPts = useDeferredValue(pts);
  const meta = MODE_META[mode];
  const stale = lastUpdateMs == null || Date.now() - lastUpdateMs > 12_000;

  const model = useMemo(() => {
    if (priceToBeat == null || !Number.isFinite(priceToBeat) || pts.length < 2) return null;
    const candles = buildSpotCandles(pts, candleBucketCount(pts.length));
    const values = pts.map((p) => p.v);
    if (values.length < 2 || values.some((v) => !Number.isFinite(v))) return null;
    const last = values[values.length - 1]!;
    const first = values[0]!;
    const recentBase = values[Math.max(0, values.length - 7)] ?? first;
    const recentMove = last - recentBase;
    const pctChange = Math.abs(first) > 1e-12 ? ((last - first) / first) * 100 : 0;
    const distancePct = ((last - priceToBeat) / priceToBeat) * 100;
    // Keep PTB visually centered so the user can read drift cleanly.
    const { plotMin, plotMax } = anchorPriceScale({
      level: priceToBeat,
      spotMin: Math.min(...values),
      spotMax: Math.max(...values),
      anchorFrac: 0.5,
    });
    if (!Number.isFinite(plotMin) || !Number.isFinite(plotMax) || !(plotMax > plotMin)) return null;
    const band = ptbTouchEpsilonUsd(pts, priceToBeat);
    if (!Number.isFinite(band)) return null;
    const maxAbs = Math.max(band * 1.5, ...values.map((v) => Math.abs(v - priceToBeat)));
    const status = statusFor({ price: last, level: priceToBeat, band, recentMove });
    const favorableNow = mode === 'up' ? last > priceToBeat + band : last < priceToBeat - band;
    const selectedLabel = mode === 'up' ? upLabel : downLabel;
    const oppositeLabel = mode === 'up' ? downLabel : upLabel;
    const absDistance = Math.abs(last - priceToBeat);
    const conviction =
      absDistance >= band * 3 ? 'STRONG SEPARATION' : absDistance >= band * 1.75 ? 'CLEAR SEPARATION' : 'WEAK SEPARATION';
    const hint =
      status === 'AT PTB'
        ? 'Price is reacting at the line — no edge until it separates.'
        : favorableNow
          ? `Price is on the ${selectedLabel} side of PTB, so ${selectedLabel} has the bias.`
          : `Price is on the ${oppositeLabel} side of PTB, so this view is weak.`;
    return {
      candles,
      last,
      first,
      recentMove,
      pctChange,
      distancePct,
      plotMin,
      plotMax,
      band,
      maxAbs,
      status,
      conviction,
      hint,
      tMin: pts[0]!.t,
      tMax: pts[pts.length - 1]!.t,
    };
  }, [mode, priceToBeat, pts, upLabel, downLabel]);

  /** Deferred so heavy `analyzePtbReaction` does not block candle paints. */
  const derivedStrip = useMemo(() => {
    if (priceToBeat == null || !Number.isFinite(priceToBeat) || deferredPts.length < 2) return null;
    const candles = buildSpotCandles(deferredPts, candleBucketCount(deferredPts.length));
    return computePtbChartDerivatives({ pts: deferredPts, candles, ptb: priceToBeat });
  }, [deferredPts, priceToBeat]);

  // IMPORTANT: keep hook call order stable (do not add hooks after early returns).
  const trailPointsStr = useMemo(() => {
    if (!model || !derivedStrip) return null;
    const iw = W - PAD_L - PAD_R;
    const ih = H - PAD_Y * 2;
    const span = Math.max(1e-9, model.plotMax - model.plotMin);
    const tSpan = Math.max(1, model.tMax - model.tMin);
    const xTime = (t: number) => PAD_L + ((t - model.tMin) / tSpan) * iw;
    const yPrice = (v: number) => PAD_Y + (1 - (v - model.plotMin) / span) * ih;
    const closeSeries =
      model.candles.length >= 2
        ? model.candles.map((c) => ({ x: xTime((c.t0 + c.t1) / 2), y: yPrice(c.c) }))
        : pts.map((p) => ({ x: xTime(p.t), y: yPrice(p.v) }));
    if (closeSeries.length < 2) return null;
    const show =
      derivedStrip.structureEvent === 'drift' ||
      (derivedStrip.momentumStreak >= 2 && derivedStrip.momentum !== 'NEUTRAL');
    if (!show) return null;
    const take = closeSeries.slice(-14);
    if (take.length < 2) return null;
    return take.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  }, [derivedStrip, model, pts]);

  const ptbMarkers = useMemo(() => {
    if (!model || priceToBeat == null || !derivedStrip)
      return {
        rejection: null as null | { xc: number; yc: number },
        breakBox: null as null | { xc: number; y: number; w: number; h: number },
      };
    const iw = W - PAD_L - PAD_R;
    const ih = H - PAD_Y * 2;
    const span = Math.max(1e-9, model.plotMax - model.plotMin);
    const tSpan = Math.max(1, model.tMax - model.tMin);
    const xOf = (t: number) => PAD_L + ((t - model.tMin) / tSpan) * iw;
    const yOf = (v: number) => PAD_Y + (1 - (v - model.plotMin) / span) * ih;
    const eps = derivedStrip.reaction.eps;
    const candles = model.candles;
    let rejection: { xc: number; yc: number } | null = null;
    if (derivedStrip.interaction === 'rejection' || derivedStrip.reaction.kind === 'rejecting_off_line') {
      for (let i = candles.length - 1; i >= 0; i--) {
        const c = candles[i]!;
        if (!candleStraddlesPtb(c, priceToBeat, eps)) continue;
        const x0 = xOf(c.t0);
        const x1 = xOf(c.t1);
        const xc = (x0 + x1) / 2;
        const yc = (yOf(c.h) + yOf(c.l)) / 2;
        rejection = { xc, yc };
        break;
      }
    }
    let breakBox: { xc: number; y: number; w: number; h: number } | null = null;
    const k = derivedStrip.reaction.kind;
    if (k === 'break_hold' || k === 'extension_confirming') {
      for (let i = candles.length - 1; i >= 1; i--) {
        const cur = candles[i]!;
        const prev = candles[i - 1]!;
        if (!candleStraddlesPtb(prev, priceToBeat, eps) || candleStraddlesPtb(cur, priceToBeat, eps)) continue;
        const x0 = xOf(cur.t0);
        const x1 = xOf(cur.t1);
        const xc = (x0 + x1) / 2;
        const slotW = x1 - x0;
        const bodyW = Math.max(6, Math.min(slotW * 0.88, iw * 0.028));
        const yO = yOf(cur.o);
        const yC = yOf(cur.c);
        const bodyH = Math.max(4, Math.abs(yC - yO) * 1.12);
        const yBody = yC < yO ? yC : yO;
        breakBox = { xc, y: yBody - (bodyH - Math.abs(yC - yO)) / 2, w: bodyW, h: bodyH };
        break;
      }
    }
    return { rejection, breakBox };
  }, [model, derivedStrip, priceToBeat]);

  const width = W;
  const height = H;
  const padL = PAD_L;
  const padR = PAD_R;
  const padY = PAD_Y;
  const innerW = width - padL - padR;
  const innerH = height - padY * 2;

  /** Visual frame when PTB exists but we cannot plot candles yet (or no PTB at all). */
  const skeleton = useMemo(() => {
    if (priceToBeat != null && Number.isFinite(priceToBeat)) {
      const vals = pts.map((p) => p.v).filter((v) => Number.isFinite(v));
      const spotMin = vals.length ? Math.min(...vals, priceToBeat) : priceToBeat;
      const spotMax = vals.length ? Math.max(...vals, priceToBeat) : priceToBeat;
      let { plotMin, plotMax } = anchorPriceScale({
        level: priceToBeat,
        spotMin,
        spotMax,
        anchorFrac: 0.5,
      });
      if (!Number.isFinite(plotMin) || !Number.isFinite(plotMax) || !(plotMax > plotMin)) {
        plotMin = priceToBeat - Math.max(Math.abs(priceToBeat) * 5e-5, 2);
        plotMax = priceToBeat + Math.max(Math.abs(priceToBeat) * 5e-5, 2);
      }
      const band =
        pts.length >= 2 ? ptbTouchEpsilonUsd(pts, priceToBeat) : Math.max(Math.abs(priceToBeat) * 1.2e-4, 0.65, priceToBeat * 8e-5);
      const tEnd = pts.length >= 1 ? pts[pts.length - 1]!.t : lastUpdateMs ?? Date.now();
      let tMin = tEnd - 180_000;
      let tMax = tEnd;
      if (pts.length >= 1) {
        tMin = pts[0]!.t;
        tMax = pts.length >= 2 ? pts[pts.length - 1]!.t : pts[0]!.t + 90_000;
      }
      if (!(tMax > tMin)) tMax = tMin + 60_000;
      return { plotMin, plotMax, band, tMin, tMax, level: priceToBeat };
    }
    const plotMin = 0;
    const plotMax = 1;
    const tEnd = lastUpdateMs ?? Date.now();
    return { plotMin, plotMax, band: 0.05, tMin: tEnd - 180_000, tMax: tEnd, level: null as number | null };
  }, [priceToBeat, pts, lastUpdateMs]);

  if (!model) {
    const sk = skeleton;
    const sspan = Math.max(1e-9, sk.plotMax - sk.plotMin);
    const stSpan = Math.max(1, sk.tMax - sk.tMin);
    const skY = (v: number) => padY + (1 - (v - sk.plotMin) / sspan) * innerH;
    const skX = (t: number) => padL + ((t - sk.tMin) / stSpan) * innerW;
    const skYBeat = sk.level != null ? skY(sk.level) : padY + innerH * 0.5;
    const skBandTop = sk.level != null ? skY(sk.level + sk.band) : skYBeat - 40;
    const skBandBottom = sk.level != null ? skY(sk.level - sk.band) : skYBeat + 40;
    const tickPricesSk = Array.from({ length: 5 }, (_, i) => sk.plotMin + ((sk.plotMax - sk.plotMin) * i) / 4);
    const xTickTsSk = buildEvenXTicks(sk.tMin, sk.tMax);
    const skeletonMsg =
      sk.level == null
        ? 'Load SSR price-to-beat — the yellow line will lock here.'
        : pts.length === 0
          ? 'Waiting for first Chainlink spot tick…'
          : 'Waiting for a second tick to draw candles…';
    return (
      <div className="flex min-h-[min(88vh,920px)] flex-col overflow-hidden rounded-[30px] border border-zinc-800/90 bg-[#0b1018] shadow-[0_28px_80px_rgba(0,0,0,0.35)] ring-1 ring-zinc-700/40">
        <header className="shrink-0 border-b border-zinc-800/80 px-4 py-3 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-lg font-semibold tracking-tight text-zinc-100 sm:text-xl">{chartTitle}</span>
                <span
                  className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    mode === 'up' ? 'border-emerald-700/50 bg-emerald-950/40 text-emerald-200' : 'border-rose-700/50 bg-rose-950/40 text-rose-200'
                  }`}
                >
                  {meta.label}
                </span>
              </div>
              <p className="mt-2 max-w-xl text-sm text-zinc-400">{skeletonMsg}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {endsInMs != null ? (
                <div className="rounded-xl border border-amber-900/45 bg-amber-950/35 px-3 py-2 text-center">
                  <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-amber-200/85">Time remaining</div>
                  <div className="font-mono text-lg font-bold tabular-nums text-amber-50">{fmtTimeRemaining(endsInMs)}</div>
                </div>
              ) : null}
              <div
                className={`flex items-center gap-2 rounded-2xl border px-3 py-2 text-[11px] font-bold uppercase tracking-wide ${
                  stale ? 'border-zinc-700 bg-zinc-900 text-zinc-500' : 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${stale ? 'bg-zinc-600' : 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.65)]'}`} />
                Live
              </div>
            </div>
          </div>
        </header>
        <div className="min-h-0 flex-1 px-3 pt-2 sm:px-4">
          <svg
            viewBox={`0 0 ${width} ${height}`}
            className="block h-full min-h-[min(52vh,560px)] max-h-[73vh] w-full rounded-[24px] bg-[#0a0f16] [contain:paint]"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Spot versus price to beat chart frame"
          >
            <defs>
              <linearGradient id={`ptbSkBand-${gradId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(161, 161, 170, 0.14)" />
                <stop offset="100%" stopColor="rgba(161, 161, 170, 0.05)" />
              </linearGradient>
            </defs>
            <rect x="0" y="0" width={width} height={height} fill="#0a0f16" />
            {sk.level != null ? (
              <>
                <rect
                  x={padL}
                  y={Math.min(skBandTop, skBandBottom)}
                  width={innerW}
                  height={Math.max(14, Math.abs(skBandBottom - skBandTop))}
                  fill={`url(#ptbSkBand-${gradId})`}
                />
                <text
                  x={padL + 8}
                  y={Math.min(skBandTop, skBandBottom) - 6}
                  fill="rgb(161 161 170)"
                  fontSize="10"
                  fontWeight="700"
                >
                  [ NO EDGE ZONE ]
                </text>
              </>
            ) : null}
            {tickPricesSk.map((tp, i) => (
              <g key={`skg-${i}`}>
                <line x1={padL} x2={padL + innerW} y1={skY(tp)} y2={skY(tp)} stroke="rgba(39,39,42,0.85)" strokeWidth="1" />
                <text x={width - padR + 6} y={skY(tp) + 4} fill="rgb(161 161 170)" fontSize="10" fontFamily="ui-monospace, monospace">
                  {fmtAxisPrice(tp)}
                </text>
              </g>
            ))}
            <line x1={padL} x2={padL + innerW} y1={skYBeat} y2={skYBeat} stroke="rgb(250 204 21)" strokeWidth="9" strokeLinecap="round" opacity={0.2} />
            <line
              x1={padL}
              x2={padL + innerW}
              y1={skYBeat}
              y2={skYBeat}
              stroke={sk.level != null ? 'rgb(250 204 21)' : 'rgba(161,161,170,0.45)'}
              strokeWidth={sk.level != null ? 2.8 : 1.5}
              strokeDasharray={sk.level != null ? undefined : '8 6'}
              strokeLinecap="round"
            />
            <text x={padL + 8} y={skYBeat - 10} fill={sk.level != null ? 'rgb(250 204 21)' : 'rgb(161 161 170)'} fontSize="11" fontWeight="800">
              {sk.level != null ? 'PTB' : 'PTB (not loaded)'}
            </text>
            {sk.level != null ? (
              <>
                <rect x={width - padR - 136} y={Math.max(padY + 8, skYBeat - 14)} width="128" height="24" rx="12" fill="rgb(250 204 21)" />
                <text
                  x={width - padR - 72}
                  y={Math.max(padY + 24, skYBeat + 4)}
                  textAnchor="middle"
                  fill="#0a0a0a"
                  fontSize="11"
                  fontWeight="800"
                >
                  PTB {fmtUsd(sk.level)}
                </text>
              </>
            ) : null}
            {pts.length === 1 && sk.level != null ? (
              <circle cx={skX(pts[0]!.t)} cy={skY(pts[0]!.v)} r={7} fill="white" stroke={meta.accent} strokeWidth="2.2" opacity={0.95} />
            ) : null}
            <text x={padL + innerW / 2} y={padY + innerH * 0.42} textAnchor="middle" fill="rgb(113 113 122)" fontSize="13" fontWeight="600">
              {skeletonMsg}
            </text>
            <text x={padL + innerW / 2} y={padY + innerH * 0.52} textAnchor="middle" fill="rgb(82 82 91)" fontSize="11">
              Time →
            </text>
            {xTickTsSk.map((ts, i) => (
              <text
                key={`skxt-${i}`}
                x={skX(ts)}
                y={height - 4}
                textAnchor="middle"
                fill="rgb(113 113 122)"
                fontSize="9"
                fontFamily="ui-monospace, monospace"
              >
                {new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </text>
            ))}
          </svg>
        </div>
        <details className="mx-4 mb-3 mt-1 rounded-xl border border-zinc-800/50 bg-zinc-900/20 px-3 py-2 text-[11px] text-zinc-500">
          <summary className="cursor-pointer select-none font-semibold text-zinc-400">Attribution · framework</summary>
          <p className="mt-2 text-[10px] leading-snug text-zinc-600">{STREAM_ATTRIBUTION_LINE}</p>
          <p className="mt-2 text-zinc-500">{PTB_REACTION_ONE_LINER}</p>
        </details>
      </div>
    );
  }

  const span = Math.max(1e-9, model.plotMax - model.plotMin);
  const tSpan = Math.max(1, model.tMax - model.tMin);
  const yPrice = (v: number) => padY + (1 - (v - model.plotMin) / span) * innerH;
  const xTime = (t: number) => padL + ((t - model.tMin) / tSpan) * innerW;
  const yBeat = yPrice(priceToBeat!);
  const yBandTop = yPrice(priceToBeat! + model.band);
  const yBandBottom = yPrice(priceToBeat! - model.band);
  const tickPrices = Array.from({ length: 5 }, (_, i) => model.plotMin + ((model.plotMax - model.plotMin) * i) / 4);
  const xTickTs = buildEvenXTicks(model.tMin, model.tMax);
  const closeSeries =
    model.candles.length >= 2
      ? model.candles.map((c) => ({ x: xTime((c.t0 + c.t1) / 2), y: yPrice(c.c), v: c.c }))
      : pts.map((p) => ({ x: xTime(p.t), y: yPrice(p.v), v: p.v }));

  /** Raw ticks for LINE mode — smoother path on short timeframes than bucket mids. */
  const lineSeries = pts.map((p) => ({ x: xTime(p.t), y: yPrice(p.v), v: p.v }));
  const lineStroke = model.recentMove >= 0 ? 'rgb(74 222 128)' : 'rgb(251 113 133)';
  const lineFill = model.recentMove >= 0 ? 'rgba(74,222,128,0.14)' : 'rgba(251,113,133,0.14)';
  const linePathSeries = lineSeries.length >= 2 ? lineSeries : closeSeries;
  const lastPt = pts[pts.length - 1]!;
  const heatIntensity = clamp01(Math.abs(model.last - priceToBeat!) / Math.max(model.maxAbs, model.band * 1.5));
  const momUpStr = derivedStrip?.momentum === 'UP' && derivedStrip.momentumStreak >= 2;
  const momDnStr = derivedStrip?.momentum === 'DOWN' && derivedStrip.momentumStreak >= 2;
  const controlSig = derivedStrip?.controlSignal;
  const statusBarBorder =
    controlSig === 'UP_CONTROL'
      ? 'border-t-emerald-500/55'
      : controlSig === 'DOWN_CONTROL'
        ? 'border-t-rose-500/55'
        : controlSig === 'TRANSITION'
          ? 'border-t-amber-500/50'
          : controlSig === 'REJECTION'
            ? 'border-t-fuchsia-500/45'
            : 'border-t-zinc-600/60';

  const dwellTotal =
    derivedStrip != null ? derivedStrip.dwellAboveMs + derivedStrip.dwellBelowMs + derivedStrip.dwellAtMs : 0;
  const statusLine2 = statusSubtitle({ control: controlSig, momentum: derivedStrip?.momentum });
  const momArrow =
    derivedStrip?.momentum === 'UP' ? '↑' : derivedStrip?.momentum === 'DOWN' ? '↓' : '→';

  return (
    <div className="flex min-h-[min(88vh,920px)] flex-col overflow-hidden rounded-[30px] border border-zinc-800/90 bg-[#0b1018] shadow-[0_28px_80px_rgba(0,0,0,0.35)] ring-1 ring-zinc-700/40">
      <header className="shrink-0 border-b border-zinc-800/80 bg-[#0b1018] px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="truncate text-lg font-semibold tracking-tight text-zinc-100 sm:text-xl">{chartTitle}</span>
            <span
              className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                mode === 'up' ? 'border-emerald-700/50 bg-emerald-950/40 text-emerald-200' : 'border-rose-700/50 bg-rose-950/40 text-rose-200'
              }`}
            >
              {meta.label}
            </span>
            <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-zinc-50 sm:text-3xl">{fmtUsd(model.last)}</span>
            <span className={`text-sm font-semibold tabular-nums ${model.recentMove >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {fmtUsdSigned(model.recentMove)} <span className="font-normal text-zinc-500">({fmtPctSigned(model.pctChange)})</span>
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {endsInMs != null ? (
              <div className="rounded-xl border border-amber-900/45 bg-amber-950/35 px-3 py-2 text-center shadow-sm shadow-black/20">
                <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-amber-200/85">Time remaining</div>
                <div className="font-mono text-lg font-bold tabular-nums leading-tight text-amber-50">{fmtTimeRemaining(endsInMs)}</div>
              </div>
            ) : null}
            <div className="inline-flex rounded-2xl border border-zinc-800/80 bg-black/25 p-1 shadow-inner shadow-black/30">
              <button
                type="button"
                onClick={() => setDisplayMode('line')}
                className={`rounded-xl px-3 py-2 text-[11px] font-semibold sm:px-4 sm:text-[12px] ${
                  displayMode === 'line' ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                LINE
              </button>
              <button
                type="button"
                onClick={() => setDisplayMode('ohlc')}
                className={`rounded-xl px-3 py-2 text-[11px] font-semibold sm:px-4 sm:text-[12px] ${
                  displayMode === 'ohlc' ? 'bg-zinc-600 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                OHLC
              </button>
            </div>
            <div className={`rounded-2xl border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide ${
              model.status === 'UP BIAS'
                ? 'border-emerald-800/50 bg-emerald-950/30 text-emerald-200'
                : model.status === 'DOWN BIAS'
                  ? 'border-rose-800/50 bg-rose-950/30 text-rose-200'
                  : 'border-zinc-700/60 bg-zinc-900/40 text-zinc-200'
            }`}>
              {model.status}
            </div>
            <div
              className={`flex items-center gap-2 rounded-2xl border px-3 py-2 text-[11px] font-bold uppercase tracking-wide ${
                stale ? 'border-zinc-700 bg-zinc-900 text-zinc-500' : 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300'
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${stale ? 'bg-zinc-600' : 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.65)]'}`} />
              Live
            </div>
          </div>
        </div>
        <p className="mt-2 text-[10px] leading-snug text-zinc-600">
          <span className="font-semibold text-zinc-500">Read</span> — how spot behaves vs the fixed PTB line ·{' '}
          <span className="text-amber-200/80">Yellow</span> = PTB · LINE = ticks · OHLC = buckets
        </p>
      </header>

      <div className="min-h-0 flex-1 px-3 pt-2 sm:px-4 [contain:paint]">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="block h-full min-h-[min(52vh,560px)] max-h-[73vh] w-full rounded-[24px] bg-[#0a0f16]"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Spot price versus PTB"
        >
          <defs>
            <linearGradient id={`ptbFocusBand-${gradId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(161, 161, 170, 0.18)" />
              <stop offset="100%" stopColor="rgba(161, 161, 170, 0.06)" />
            </linearGradient>
            <linearGradient id={`heatAbove-${gradId}`} gradientUnits="userSpaceOnUse" x1={0} y1={yBeat} x2={0} y2={padY}>
              <stop offset="0%" stopColor="rgb(34 197 94)" stopOpacity={0} />
              <stop offset="100%" stopColor="rgb(21 128 61)" stopOpacity={0.06 + 0.22 * heatIntensity} />
            </linearGradient>
            <linearGradient id={`heatBelow-${gradId}`} gradientUnits="userSpaceOnUse" x1={0} y1={yBeat} x2={0} y2={padY + innerH}>
              <stop offset="0%" stopColor="rgb(248 113 113)" stopOpacity={0} />
              <stop offset="100%" stopColor="rgb(185 28 28)" stopOpacity={0.06 + 0.22 * heatIntensity} />
            </linearGradient>
            <marker id={`trailArr-${gradId}`} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth">
              <polygon points="0 0, 7 3.5, 0 7" fill="rgb(148 163 184)" fillOpacity={0.55} />
            </marker>
          </defs>

          <rect x="0" y="0" width={width} height={height} fill="#0a0f16" />

          <rect x={padL} y={Math.min(yBandTop, yBandBottom)} width={innerW} height={Math.max(12, Math.abs(yBandBottom - yBandTop))} fill={`url(#ptbFocusBand-${gradId})`} />
          <text
            x={padL + 8}
            y={Math.min(yBandTop, yBandBottom) - 6}
            fill="rgb(161 161 170)"
            fontSize="10"
            fontWeight="700"
          >
            [ NO EDGE ZONE ]
          </text>

          <rect x={padL} y={padY} width={innerW} height={Math.max(0, yBeat - padY)} fill={`url(#heatAbove-${gradId})`} className="pointer-events-none" />
          <rect x={padL} y={yBeat} width={innerW} height={Math.max(0, padY + innerH - yBeat)} fill={`url(#heatBelow-${gradId})`} className="pointer-events-none" />

          {closeSeries.length <= 52
            ? closeSeries.slice(1).map((p, i) => {
                const prev = closeSeries[i]!;
                const avg = (p.v + prev.v) / 2;
                const favorableDist =
                  mode === 'up' ? Math.max(0, avg - priceToBeat! - model.band) : Math.max(0, priceToBeat! - avg - model.band);
                const weakDist =
                  mode === 'up' ? Math.max(0, priceToBeat! - avg - model.band) : Math.max(0, avg - priceToBeat! - model.band);
                const opacity =
                  favorableDist > 0 ? 0.18 + 0.42 * clamp01(favorableDist / model.maxAbs) : 0.04 + 0.12 * clamp01(weakDist / model.maxAbs);
                const fill = favorableDist > 0 ? withAlpha(meta.accent, opacity) : `rgba(113, 113, 122, ${Math.min(0.12, opacity)})`;
                const d = `M ${prev.x.toFixed(2)} ${yBeat.toFixed(2)} L ${prev.x.toFixed(2)} ${prev.y.toFixed(2)} L ${p.x.toFixed(2)} ${p.y.toFixed(2)} L ${p.x.toFixed(2)} ${yBeat.toFixed(2)} Z`;
                return <path key={`gap-${i}`} d={d} fill={fill} className="pointer-events-none" />;
              })
            : null}

          {tickPrices.map((tp, i) => (
            <g key={`grid-${i}`}>
              <line x1={padL} x2={padL + innerW} y1={yPrice(tp)} y2={yPrice(tp)} stroke="rgba(39,39,42,0.8)" strokeWidth="1" />
              <text x={width - padR + 6} y={yPrice(tp) + 4} fill="rgb(161 161 170)" fontSize="10" fontFamily="ui-monospace, monospace">
                {fmtAxisPrice(tp)}
              </text>
            </g>
          ))}

          {displayMode === 'line' ? (
            <>
              <path
                d={`M ${linePathSeries.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' L ')} L ${linePathSeries[linePathSeries.length - 1]!.x.toFixed(2)} ${(
                  padY + innerH
                ).toFixed(2)} L ${linePathSeries[0]!.x.toFixed(2)} ${(padY + innerH).toFixed(2)} Z`}
                fill={lineFill}
                className="pointer-events-none"
              />
              {linePathSeries.slice(1).map((p, i) => {
                const prev = linePathSeries[i]!;
                const segUp = p.v >= prev.v;
                const stroke = segUp ? 'rgb(74 222 128)' : 'rgb(248 113 113)';
                return (
                  <line
                    key={`ls-${i}`}
                    x1={prev.x}
                    y1={prev.y}
                    x2={p.x}
                    y2={p.y}
                    stroke={stroke}
                    strokeWidth={2.75}
                    strokeLinecap="round"
                  />
                );
              })}
            </>
          ) : (
            model.candles.map((c, i) => {
              const x0 = xTime(c.t0);
              const x1 = xTime(c.t1);
              const xc = (x0 + x1) / 2;
              const slotW = x1 - x0;
              const bodyW = Math.max(9, Math.min(slotW * 0.92, innerW * 0.038));
              const yO = yPrice(c.o);
              const yC = yPrice(c.c);
              const yH = yPrice(c.h);
              const yL = yPrice(c.l);
              const bullish = c.c >= c.o;
              const aligned = mode === 'up' ? bullish && c.c > priceToBeat! : !bullish && c.c < priceToBeat!;
              const momBar = Boolean((momUpStr && bullish) || (momDnStr && !bullish));
              const stroke = aligned ? meta.accent : bullish ? 'rgb(52 211 153)' : 'rgb(251 113 133)';
              const fill = aligned ? (mode === 'up' ? 'rgba(16,185,129,0.55)' : 'rgba(248,113,113,0.55)') : bullish ? 'rgba(34,197,94,0.42)' : 'rgba(251,113,133,0.42)';
              const bodyH = Math.max(4, Math.abs(yC - yO) * (aligned || momBar ? 1.12 : 1));
              const yBody = yC < yO ? yC : yO;
              const wickW = momBar ? 2.65 : aligned ? 2.1 : 1.45;
              const bodyStrokeW = momBar ? 1.55 : aligned ? 1.35 : 1;
              return (
                <g key={`candle-${i}`}>
                  <line x1={xc} x2={xc} y1={yH} y2={yL} stroke={stroke} strokeWidth={wickW} opacity={0.98} />
                  <rect
                    x={xc - bodyW / 2}
                    y={yBody - (bodyH - Math.abs(yC - yO)) / 2}
                    width={bodyW}
                    height={bodyH}
                    rx="2"
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={bodyStrokeW}
                  />
                </g>
              );
            })
          )}

          {trailPointsStr ? (
            <polyline
              points={trailPointsStr}
              fill="none"
              stroke="rgb(148 163 184)"
              strokeWidth="1.75"
              strokeDasharray="5 4"
              strokeOpacity={0.45}
              strokeLinecap="round"
              strokeLinejoin="round"
              markerEnd={`url(#trailArr-${gradId})`}
              className="pointer-events-none"
            />
          ) : null}

          <line x1={padL} x2={padL + innerW} y1={yBeat} y2={yBeat} stroke="rgb(253 224 71)" strokeWidth={9} strokeLinecap="round" opacity={0.18} />
          <line
            x1={padL}
            x2={padL + innerW}
            y1={yBeat}
            y2={yBeat}
            stroke="rgb(250 234 80)"
            strokeWidth={3}
            strokeLinecap="round"
            opacity={1}
          />
          <text x={padL + 8} y={yBeat - 10} fill="rgb(253 224 71)" fontSize="11" fontWeight="800">
            PTB
          </text>
          <rect x={width - padR - 136} y={Math.max(padY + 8, yBeat - 14)} width="128" height="24" rx="12" fill="rgb(250 234 80)" />
          <text x={width - padR - 72} y={Math.max(padY + 24, yBeat + 4)} textAnchor="middle" fill="#0a0a0a" fontSize="11" fontWeight="800">
            PTB {fmtUsd(priceToBeat)}
          </text>

          {ptbMarkers.breakBox ? (
            <rect
              x={ptbMarkers.breakBox.xc - ptbMarkers.breakBox.w / 2 - 3}
              y={ptbMarkers.breakBox.y - 3}
              width={ptbMarkers.breakBox.w + 6}
              height={ptbMarkers.breakBox.h + 6}
              rx="4"
              fill="none"
              stroke="rgb(250 234 80)"
              strokeWidth="2.2"
              opacity={0.95}
            />
          ) : null}
          {ptbMarkers.rejection ? (
            <g transform={`translate(${ptbMarkers.rejection.xc},${ptbMarkers.rejection.yc})`} opacity={0.92}>
              <line x1={-7} y1={-7} x2={7} y2={7} stroke="rgb(251 113 133)" strokeWidth="2.4" strokeLinecap="round" />
              <line x1={-7} y1={7} x2={7} y2={-7} stroke="rgb(251 113 133)" strokeWidth="2.4" strokeLinecap="round" />
            </g>
          ) : null}

          <circle cx={xTime(lastPt.t)} cy={yPrice(lastPt.v)} r={6} fill="white" stroke={lineStroke} strokeWidth={2.2} />

          {xTickTs.map((ts, i) => (
            <text
              key={`xt-${i}`}
              x={xTime(ts)}
              y={height - 4}
              textAnchor="middle"
              fill="rgb(113 113 122)"
              fontSize="9"
              fontFamily="ui-monospace, monospace"
            >
              {new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </text>
          ))}
        </svg>
      </div>

      <section
        className={`shrink-0 border-t-2 bg-zinc-950/85 px-4 py-4 text-zinc-100 sm:px-5 ${statusBarBorder}`}
        title={derivedStrip?.controlBlurb ?? undefined}
      >
        <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Status</div>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-2xl font-black uppercase leading-none tracking-tight sm:text-3xl">
              {controlSig ? controlSig.replaceAll('_', ' ') : '…'}
            </div>
            {statusLine2 ? <div className="mt-1.5 text-sm font-medium text-zinc-500">({statusLine2})</div> : null}
            <p className="mt-2 max-w-prose text-[11px] leading-snug text-zinc-600">{model.hint}</p>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Distance</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-zinc-100">{fmtPctSigned(model.distancePct)}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Time below</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-zinc-100">
                {derivedStrip ? pctOfTotal(derivedStrip.dwellBelowMs, dwellTotal) : '—'}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Time above</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-zinc-100">
                {derivedStrip ? pctOfTotal(derivedStrip.dwellAboveMs, dwellTotal) : '—'}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Momentum</div>
              <div className="mt-0.5 font-mono text-lg font-bold text-zinc-100">
                {momArrow}{' '}
                <span className="text-sm font-semibold text-zinc-400">
                  {derivedStrip?.momentum ?? '—'}
                  {derivedStrip && derivedStrip.momentumStreak >= 2 ? ` ×${derivedStrip.momentumStreak}` : ''}
                </span>
              </div>
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-zinc-500">
          <span className="rounded border border-zinc-700/60 bg-black/30 px-2 py-1 font-mono text-zinc-400">
            {derivedStrip?.structureEvent?.replaceAll('_', ' ') ?? '—'} · Δ {derivedStrip ? fmtUsdSigned(derivedStrip.distanceUsd) : '—'}
          </span>
          <span className="rounded border border-zinc-700/60 bg-black/30 px-2 py-1 font-mono text-zinc-400">
            Slope {derivedStrip ? `${derivedStrip.slopeUsdPerMin >= 0 ? '+' : ''}${derivedStrip.slopeUsdPerMin.toFixed(3)}/m` : '—'}
          </span>
          <span className="rounded border border-zinc-700/60 bg-black/30 px-2 py-1 text-zinc-500">
            {model.conviction}
          </span>
        </div>
      </section>

      <details className="mx-4 mb-3 mt-1 rounded-xl border border-zinc-800/50 bg-zinc-900/20 px-3 py-2 text-[11px] text-zinc-500 ring-1 ring-white/[0.02]">
        <summary className="cursor-pointer select-none font-semibold text-zinc-400">Chart details · engine · attribution</summary>
        <p className="mt-2 text-[10px] leading-snug text-zinc-600">{STREAM_ATTRIBUTION_LINE}</p>
        <p className="mt-2 leading-relaxed text-zinc-500">{PTB_REACTION_ONE_LINER}</p>
        <ul className="mt-2 list-inside list-disc space-y-1 text-zinc-500">
          {PTB_REACTION_DIMENSIONS.map((d) => (
            <li key={d.title}>
              <span className="font-semibold text-zinc-400">{d.title}</span> — {d.body}
            </li>
          ))}
        </ul>
        <div className="mt-3 rounded-lg border border-zinc-800/60 bg-black/25 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-amber-100/90">
          <span className="font-semibold text-amber-200/90">PTB read</span> — {derivedStrip?.interactionLabel ?? 'Scoring…'}
        </div>
      </details>
    </div>
  );
}
