import { useMemo, type ReactElement } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import { buildSpotCandles, type SpotTick } from './spotVsPtb';

function fmtUsdSigned(x: number): string {
  const s = x >= 0 ? '+' : '';
  return `${s}$${Math.abs(x).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export type AggregateDeltaCandle = {
  o: number;
  h: number;
  l: number;
  c: number;
  upperWickUsd: number;
  lowerWickUsd: number;
  rangeUsd: number;
  bodyUsd: number;
  bodyFrac: number;
};

export function computeAggregateDeltaCandle(pts: SpotPoint[], level: number): AggregateDeltaCandle | null {
  if (pts.length < 2 || !Number.isFinite(level)) return null;
  const d = pts.map((p) => p.v - level);
  const o = d[0]!;
  const c = d[d.length - 1]!;
  const h = Math.max(...d);
  const l = Math.min(...d);
  const topBody = Math.max(o, c);
  const botBody = Math.min(o, c);
  const upperWickUsd = Math.max(0, h - topBody);
  const lowerWickUsd = Math.max(0, botBody - l);
  const rangeUsd = h - l;
  const bodyUsd = Math.abs(c - o);
  const bodyFrac = rangeUsd > 1e-12 ? Math.min(1, bodyUsd / rangeUsd) : 1;
  return { o, h, l, c, upperWickUsd, lowerWickUsd, rangeUsd, bodyUsd, bodyFrac };
}

function extentWithZero(minV: number, maxV: number): { min: number; max: number } {
  const lo = Math.min(0, minV);
  const hi = Math.max(0, maxV);
  if (lo === hi) return { min: lo - 1, max: hi + 1 };
  const pad = (hi - lo) * 0.08;
  return { min: lo - pad, max: hi + pad };
}

/**
 * Above/below Yes/No view: spot distance from PTB (Y = 0). Wicks = stretch vs level; body = where spot opened/closed the window.
 */
export function PtbMarketReactionChart(props: {
  spot: SpotPoint[];
  priceToBeat: number | null;
  lastUpdateMs: number | null;
  aboveLabel?: string;
  belowLabel?: string;
}): ReactElement | null {
  const { spot, priceToBeat, lastUpdateMs, aboveLabel = 'YES (above)', belowLabel = 'NO (below)' } = props;
  const pts = useMemo(() => spot.slice(-280), [spot]);
  const level = priceToBeat;

  const deltaPts: SpotTick[] = useMemo(() => {
    if (level == null || pts.length < 2) return [];
    return pts.map((p) => ({ t: p.t, v: p.v - level }));
  }, [level, pts]);

  const agg = useMemo(() => (level != null ? computeAggregateDeltaCandle(pts, level) : null), [level, pts]);

  const candles = useMemo(() => buildSpotCandles(deltaPts, 18), [deltaPts]);

  const readouts = useMemo(() => {
    if (!agg || level == null) {
      return {
        side: 'at' as const,
        rejection: '',
        push: '',
        follow: '',
        c: 0,
      };
    }
    const { c, bodyFrac, rangeUsd } = agg;
    const side: 'above' | 'below' | 'at' = c > 0.02 ? 'above' : c < -0.02 ? 'below' : 'at';

    let rejection = 'No clean single-bar rejection pattern vs PTB in this aggregate window.';
    if (agg.h > 0.5 && c < -0.15 && agg.o > 0) {
      rejection = 'Rejection from above: spot stretched over PTB then closed the window back under — offers faded / longs trapped probe.';
    } else if (agg.l < -0.5 && c > 0.15 && agg.o < 0) {
      rejection = 'Rejection from below: spot probed under PTB then closed back above — dip bought / shorts trapped probe.';
    }

    const strongBody = bodyFrac >= 0.38;
    const wicky = bodyFrac < 0.22;
    let push = '';
    if (wicky && rangeUsd > 1) {
      push = 'Weak test / wicky: most of the move is wick — easy fake-out if spot snaps back through PTB.';
    } else if (strongBody && Math.sign(c) === Math.sign(agg.o) && side !== 'at') {
      push = 'Real push: solid body in the direction of the close vs PTB — more than a one-tick flirt.';
    } else {
      push = 'Mixed: body vs wicks is middling — treat as unfinished business until the next sweep or hold.';
    }

    const peak = Math.max(Math.abs(agg.h), Math.abs(agg.l));
    const follow =
      peak < 1e-6
        ? 'Follow-through: flat vs PTB — no extension to score.'
        : Math.abs(c) >= peak * 0.72
          ? 'Follow-through: close still near the window extreme vs PTB — extension largely held into the last print.'
          : Math.abs(c) <= peak * 0.35
            ? 'Follow-through / stall: window made a larger excursion than where spot closed — giveback from the best stretch.'
            : 'Follow-through: partial — some extension held but spot is mid-pack vs its best probe.';

    return { side, rejection, push, follow, c };
  }, [agg, level]);

  if (level == null || pts.length < 2) {
    return (
      <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 text-sm text-zinc-500 ring-1 ring-white/[0.02]">
        Load SSR price-to-beat and RTDS spot to see the Yes/No PTB reaction chart.
      </div>
    );
  }

  const width = 560;
  const height = 200;
  const pad = 14;
  const innerH = height - pad * 2;
  const innerW = width - pad * 2;

  const vals = deltaPts.map((p) => p.v);
  const vMin = vals.length ? Math.min(...vals) : -1;
  const vMax = vals.length ? Math.max(...vals) : 1;
  const { min: plotMin, max: plotMax } = extentWithZero(vMin, vMax);
  const span = Math.max(1e-9, plotMax - plotMin);

  const tMin = deltaPts[0]!.t;
  const tMax = deltaPts[deltaPts.length - 1]!.t;
  const tSpan = Math.max(1, tMax - tMin);

  const yD = (dv: number) => pad + (1 - (dv - plotMin) / span) * innerH;
  const xT = (t: number) => pad + ((t - tMin) / tSpan) * innerW;
  const y0 = yD(0);

  const last = pts[pts.length - 1]!.v - level;

  return (
    <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 shadow-inner shadow-black/15 ring-1 ring-white/[0.02]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[13px] font-semibold tracking-tight text-zinc-100">PTB reaction (Yes / No · above vs below)</div>
        <div className="font-mono text-[10px] text-zinc-500">
          {lastUpdateMs ? `spot ticks · ${new Date(lastUpdateMs).toLocaleTimeString()}` : 'no tick time'}
        </div>
      </div>

      {/* 1 — Current market vs PTB (first) */}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {readouts?.side === 'above' ? (
          <div className="rounded-xl border border-emerald-700/45 bg-emerald-950/35 px-4 py-2.5">
            <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-200/90">Active side</div>
            <div className="mt-0.5 text-lg font-bold tracking-tight text-emerald-100">Above PTB</div>
            <div className="mt-1 font-mono text-sm text-emerald-200/90">{aboveLabel}</div>
            <div className="mt-1 font-mono text-xs text-emerald-100/80">now {fmtUsdSigned(readouts.c)}</div>
          </div>
        ) : readouts?.side === 'below' ? (
          <div className="rounded-xl border border-rose-700/45 bg-rose-950/35 px-4 py-2.5">
            <div className="text-[10px] font-bold uppercase tracking-wide text-rose-200/90">Active side</div>
            <div className="mt-0.5 text-lg font-bold tracking-tight text-rose-100">Below PTB</div>
            <div className="mt-1 font-mono text-sm text-rose-200/90">{belowLabel}</div>
            <div className="mt-1 font-mono text-xs text-rose-100/80">now {fmtUsdSigned(readouts.c)}</div>
          </div>
        ) : (
          <div className="rounded-xl border border-amber-700/45 bg-amber-950/30 px-4 py-2.5">
            <div className="text-[10px] font-bold uppercase tracking-wide text-amber-200/90">Active side</div>
            <div className="mt-0.5 text-lg font-bold tracking-tight text-amber-50">At PTB</div>
            <div className="mt-1 font-mono text-xs text-amber-100/85">now {fmtUsdSigned(readouts?.c ?? 0)}</div>
          </div>
        )}
        <div className="min-w-[10rem] flex-1 rounded-xl border border-zinc-800/50 bg-black/25 px-3 py-2 font-mono text-[11px] text-zinc-400">
          <div>
            PTB <span className="text-amber-200/90">${level.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
          </div>
          <div className="mt-1">
            spot <span className="text-zinc-200">${pts[pts.length - 1]!.v.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-[1fr_140px]">
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Window in $ from PTB (Y = 0)</div>
          <svg viewBox={`0 0 ${width} ${height}`} className="h-[200px] w-full">
            <defs>
              <linearGradient id="ptbMktAbove" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(16 185 129)" stopOpacity="0.12" />
                <stop offset="100%" stopColor="rgb(16 185 129)" stopOpacity="0.02" />
              </linearGradient>
              <linearGradient id="ptbMktBelow" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgb(244 63 94)" stopOpacity="0.02" />
                <stop offset="100%" stopColor="rgb(244 63 94)" stopOpacity="0.12" />
              </linearGradient>
            </defs>
            <rect x="0" y="0" width={width} height={height} rx="14" className="fill-black/25 stroke-zinc-800/40" />
            {y0 > pad && y0 < height - pad ? (
              <rect x={pad} y={pad} width={innerW} height={y0 - pad} fill="url(#ptbMktAbove)" className="pointer-events-none" />
            ) : null}
            {y0 > pad && y0 < height - pad ? (
              <rect x={pad} y={y0} width={innerW} height={height - pad - y0} fill="url(#ptbMktBelow)" className="pointer-events-none" />
            ) : null}

            <line x1={pad} x2={width - pad} y1={y0} y2={y0} className="stroke-amber-300" strokeWidth={2.4} />

            {candles.map((c, i) => {
              const x0 = xT(c.t0);
              const x1 = xT(c.t1);
              const xc = (x0 + x1) / 2;
              const bw = Math.max(10, (x1 - x0) * 0.75);
              const yH = yD(c.h);
              const yL = yD(c.l);
              const yO = yD(c.o);
              const yC = yD(c.c);
              const bodyTop = Math.min(yO, yC);
              const bodyBot = Math.max(yO, yC);
              const rawBodyH = bodyBot - bodyTop;
              const bodyH = Math.max(3, rawBodyH);
              const bodyY = bodyTop - (bodyH - rawBodyH) / 2;
              const bull = c.c >= c.o;
              const wickColor = bull ? 'rgb(34 197 94)' : 'rgb(239 68 68)';
              const bodyFill = bull ? 'rgb(22 163 74)' : 'rgb(220 38 38)';
              const bodyStroke = bull ? 'rgb(74 222 128)' : 'rgb(248 113 113)';
              return (
                <g key={`${c.t0}-${i}`}>
                  <line x1={xc} x2={xc} y1={yH} y2={bodyY} stroke={wickColor} strokeWidth={1.5} />
                  <line x1={xc} x2={xc} y1={bodyY + bodyH} y2={yL} stroke={wickColor} strokeWidth={1.5} />
                  <rect x={xc - bw / 2} y={bodyY} width={bw} height={bodyH} fill={bodyFill} stroke={bodyStroke} strokeWidth={1} />
                </g>
              );
            })}

            <circle cx={xT(pts[pts.length - 1]!.t)} cy={yD(last)} r="5" className="fill-white stroke-amber-300" strokeWidth={2} />

            <text x={pad + 4} y={Math.max(14, y0 - 6)} className="fill-amber-200/90" fontSize="10" fontFamily="ui-monospace, monospace">
              PTB = 0 on this axis
            </text>
            <text x={width - pad - 4} y={pad + 11} textAnchor="end" className="fill-zinc-500" fontSize="9" fontFamily="ui-monospace, monospace">
              +{plotMax.toFixed(2)}
            </text>
            <text x={width - pad - 4} y={height - pad - 2} textAnchor="end" className="fill-zinc-500" fontSize="9" fontFamily="ui-monospace, monospace">
              {plotMin.toFixed(2)}
            </text>
          </svg>
        </div>

        {/* Session candle schematic: wick / body vs PTB */}
        {agg ? (
          <div className="flex flex-col items-center">
            <div className="mb-1 text-center text-[10px] font-semibold uppercase tracking-wide text-zinc-500">This window</div>
            <SessionDeltaCandle agg={agg} height={168} />
          </div>
        ) : null}
      </div>

      {/* Ordered readouts 2–5 */}
      {agg && readouts ? (
        <div className="mt-4 space-y-2 border-t border-zinc-800/50 pt-3 text-[11px] leading-relaxed text-zinc-300">
          <div className="rounded-lg border border-zinc-800/40 bg-zinc-900/40 px-3 py-2">
            <span className="font-semibold text-zinc-100">2 · Wick stretch vs PTB</span>
            <p className="mt-1 text-zinc-400">
              Upper wick (max above PTB): <span className="font-mono text-emerald-200/90">+${agg.upperWickUsd.toFixed(2)}</span> — how far
              “above” stretched. Lower wick (max below PTB):{' '}
              <span className="font-mono text-rose-200/90">${agg.lowerWickUsd.toFixed(2)}</span> depth under the line.
            </p>
          </div>
          <div className="rounded-lg border border-zinc-800/40 bg-zinc-900/40 px-3 py-2">
            <span className="font-semibold text-zinc-100">3 · Body strength (where spot held)</span>
            <p className="mt-1 text-zinc-400">
              Open→close in $ from PTB: <span className="font-mono text-zinc-200">{fmtUsdSigned(agg.c - agg.o)}</span> · body vs full range{' '}
              <span className="font-mono text-zinc-200">{(agg.bodyFrac * 100).toFixed(0)}%</span> — {readouts.push}
            </p>
          </div>
          <div className="rounded-lg border border-zinc-800/40 bg-zinc-900/40 px-3 py-2">
            <span className="font-semibold text-zinc-100">4 · Rejection read</span>
            <p className="mt-1 text-zinc-400">{readouts.rejection}</p>
          </div>
          <div className="rounded-lg border border-zinc-800/40 bg-zinc-900/40 px-3 py-2">
            <span className="font-semibold text-zinc-100">5 · Follow-through</span>
            <p className="mt-1 text-zinc-400">{readouts.follow}</p>
          </div>
        </div>
      ) : null}

      <p className="mt-2 text-[10px] leading-snug text-zinc-600">
        Synthetic buckets on (spot − PTB). Settlement for above/below follows underlying vs SSR PTB — implied Yes/No mids are not drawn here.
      </p>
    </div>
  );
}

function SessionDeltaCandle({ agg, height }: { agg: AggregateDeltaCandle; height: number }): ReactElement {
  const w = 56;
  const pad = 10;
  const midX = w / 2;
  const innerH = height - pad * 2;
  const sym = Math.max(Math.abs(agg.h), Math.abs(agg.l), Math.abs(agg.o), Math.abs(agg.c), 1e-6);
  const yFor = (dv: number) => pad + (1 - (dv + sym) / (2 * sym)) * innerH;
  const y0 = yFor(0);
  const yH = yFor(agg.h);
  const yL = yFor(agg.l);
  const yO = yFor(agg.o);
  const yC = yFor(agg.c);
  const topB = Math.min(yO, yC);
  const botB = Math.max(yO, yC);
  const bodyH = Math.max(2, botB - topB);
  const bull = agg.c >= agg.o;
  const wickColor = bull ? 'rgb(34 197 94)' : 'rgb(239 68 68)';
  const bodyFill = bull ? 'rgb(22 163 74)' : 'rgb(220 38 38)';
  const bodyStroke = bull ? 'rgb(74 222 128)' : 'rgb(248 113 113)';
  return (
    <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} className="shrink-0">
      <rect x="0" y="0" width={w} height={height} rx="10" className="fill-black/30 stroke-zinc-800/50" />
      <line x1={4} x2={w - 4} y1={y0} y2={y0} className="stroke-amber-400/70" strokeWidth={1.5} strokeDasharray="3 2" />
      <line x1={midX} x2={midX} y1={yH} y2={topB} stroke={wickColor} strokeWidth={1.8} />
      <line x1={midX} x2={midX} y1={topB + bodyH} y2={yL} stroke={wickColor} strokeWidth={1.8} />
      <rect x={midX - 14} y={topB} width={28} height={bodyH} fill={bodyFill} stroke={bodyStroke} strokeWidth={1.2} />
      <text x={w / 2} y={pad + 7} textAnchor="middle" className="fill-zinc-500" fontSize="7" fontFamily="ui-monospace, monospace">
        +H
      </text>
      <text x={w / 2} y={height - 2} textAnchor="middle" className="fill-zinc-500" fontSize="7" fontFamily="ui-monospace, monospace">
        −L
      </text>
    </svg>
  );
}
