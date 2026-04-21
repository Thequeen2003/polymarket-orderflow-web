import { useDeferredValue, useMemo, useState, type ReactElement } from 'react';
import { computePtbChartDerivatives } from './ptbChartDerivatives';
import type { PtbControlSignal } from './ptbChartDerivatives';
import type { SpotPoint } from './SpotLevelChart';
import { buildSpotCandles, ptbTouchEpsilonUsd } from './spotVsPtb';

export type PtbMultiAssetRow = {
  slug: string;
  /** e.g. BTC/USD */
  label: string;
  spot: SpotPoint[];
  priceToBeat: number | null;
  endsInMs: number | null;
  lastUpdateMs: number | null;
};

type SortMode = 'default' | 'distance_abs' | 'up_first' | 'down_first';

const MINI_W = 300;
const MINI_H = 132;
const PAD_L = 8;
const PAD_R = 6;
const PAD_Y = 6;

function fmtUsdShort(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function fmtClock(endsInMs: number | null): string {
  if (endsInMs == null || !Number.isFinite(endsInMs)) return '—';
  const s = Math.max(0, Math.floor(endsInMs / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function signalAccent(sig: PtbControlSignal | undefined): { ring: string; heat: 'up' | 'down' | 'neutral' } {
  switch (sig) {
    case 'UP_CONTROL':
      return { ring: 'ring-emerald-500/35', heat: 'up' };
    case 'DOWN_CONTROL':
      return { ring: 'ring-rose-500/35', heat: 'down' };
    case 'NO_EDGE':
      return { ring: 'ring-zinc-600/40', heat: 'neutral' };
    default:
      return { ring: 'ring-amber-500/25', heat: 'neutral' };
  }
}

function PtbMiniPanel(props: {
  row: PtbMultiAssetRow;
  heatmap: boolean;
  onExpand: () => void;
}): ReactElement {
  const { row, heatmap, onExpand } = props;
  const gradId = useMemo(() => `g${Math.random().toString(36).slice(2, 9)}`, []);
  const pts = useMemo(() => {
    const raw = row.spot.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v));
    if (raw.length < 2) return raw;
    const tEnd = raw[raw.length - 1]!.t;
    const tCut = tEnd - 180_000;
    return raw.filter((p) => p.t >= tCut).slice(-220);
  }, [row.spot]);
  const deferredPts = useDeferredValue(pts);

  const model = useMemo(() => {
    const ptb = row.priceToBeat;
    if (ptb == null || !Number.isFinite(ptb) || deferredPts.length < 2) return null;
    const candles = buildSpotCandles(deferredPts, Math.min(24, Math.max(8, Math.floor(deferredPts.length * 0.35))));
    const values = deferredPts.map((p) => p.v);
    const last = values[values.length - 1]!;
    const spotMin = Math.min(...values);
    const spotMax = Math.max(...values);
    const needAbove = Math.max(0, spotMax - ptb);
    const needBelow = Math.max(0, ptb - spotMin);
    const halfSpan = Math.max(needAbove, needBelow, Math.abs(ptb) * 3e-5, 1);
    const plotMin = ptb - halfSpan * 1.08;
    const plotMax = ptb + halfSpan * 1.08;
    if (!Number.isFinite(plotMin) || !Number.isFinite(plotMax) || !(plotMax > plotMin)) return null;
    const band = ptbTouchEpsilonUsd(deferredPts, ptb);
    const tMin = deferredPts[0]!.t;
    const tMax = deferredPts[deferredPts.length - 1]!.t;
    const derived = computePtbChartDerivatives({ pts: deferredPts, candles, ptb });
    const maxAbs = Math.max(band * 1.5, ...values.map((v) => Math.abs(v - ptb)));
    return { candles, last, plotMin, plotMax, band, tMin, tMax, derived, ptb, maxAbs };
  }, [deferredPts, row.priceToBeat]);

  const innerW = MINI_W - PAD_L - PAD_R;
  const innerH = MINI_H - PAD_Y * 2;
  const span = model ? Math.max(1e-9, model.plotMax - model.plotMin) : 1;
  const tSpan = model ? Math.max(1, model.tMax - model.tMin) : 1;
  const yPx = (v: number) => PAD_Y + (1 - (v - (model?.plotMin ?? 0)) / span) * innerH;
  const xPx = (t: number) => PAD_L + ((t - (model?.tMin ?? 0)) / tSpan) * innerW;
  const yBeat = model ? yPx(model.ptb) : MINI_H / 2;
  const heatIntensity = model ? clamp01(Math.abs(model.last - model.ptb) / Math.max(model.maxAbs, model.band * 1.5)) : 0;
  const sig = model?.derived.controlSignal;
  const { ring, heat } = signalAccent(sig);

  const subtitle = useMemo(() => {
    if (!model) return null;
    const d = model.derived;
    if (d.controlSignal === 'TRANSITION') return '(weakening / rotation)';
    if (d.controlSignal === 'REJECTION') return '(line test)';
    if (d.controlSignal === 'NO_EDGE') return '(low edge)';
    if (d.controlSignal === 'UP_CONTROL' && d.momentum === 'DOWN') return '(weakening)';
    if (d.controlSignal === 'DOWN_CONTROL' && d.momentum === 'UP') return '(weakening)';
    return null;
  }, [model]);

  const heatBg =
    heatmap && heat === 'up'
      ? 'bg-emerald-950/35'
      : heatmap && heat === 'down'
        ? 'bg-rose-950/35'
        : heatmap && heat === 'neutral'
          ? 'bg-zinc-900/50'
          : 'bg-[#0a0f14]';

  return (
    <button
      type="button"
      onClick={onExpand}
      className={`group w-full max-w-[340px] rounded-2xl border border-zinc-800/80 text-left shadow-lg shadow-black/30 ring-1 ring-inset ${ring} transition-colors hover:border-zinc-600/90 hover:bg-zinc-900/40 ${heatBg}`}
    >
      <div className="border-b border-zinc-800/70 px-3 py-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-[13px] font-bold tracking-tight text-zinc-100">{row.label}</div>
            <div className="mt-0.5 font-mono text-[11px] text-amber-200/90">PTB {fmtUsdShort(row.priceToBeat)}</div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Time</div>
            <div className="font-mono text-[12px] font-semibold tabular-nums text-zinc-200">{fmtClock(row.endsInMs)}</div>
          </div>
        </div>
      </div>

      <div className="relative px-1 pb-1 pt-0.5">
        <svg
          viewBox={`0 0 ${MINI_W} ${MINI_H}`}
          className="block h-[132px] w-full rounded-b-xl bg-[#070b10]"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden
        >
          <defs>
            <linearGradient id={`ha-${gradId}`} gradientUnits="userSpaceOnUse" x1={0} y1={yBeat} x2={0} y2={PAD_Y}>
              <stop offset="0%" stopColor="rgb(34 197 94)" stopOpacity={0} />
              <stop offset="100%" stopColor="rgb(21 128 61)" stopOpacity={0.05 + 0.18 * heatIntensity} />
            </linearGradient>
            <linearGradient id={`hb-${gradId}`} gradientUnits="userSpaceOnUse" x1={0} y1={yBeat} x2={0} y2={PAD_Y + innerH}>
              <stop offset="0%" stopColor="rgb(248 113 113)" stopOpacity={0} />
              <stop offset="100%" stopColor="rgb(185 28 28)" stopOpacity={0.05 + 0.18 * heatIntensity} />
            </linearGradient>
          </defs>
          <rect x={0} y={0} width={MINI_W} height={MINI_H} fill="#070b10" />
          {model ? (
            <>
              <rect x={PAD_L} y={PAD_Y} width={innerW} height={Math.max(0, yBeat - PAD_Y)} fill={`url(#ha-${gradId})`} />
              <rect x={PAD_L} y={yBeat} width={innerW} height={Math.max(0, PAD_Y + innerH - yBeat)} fill={`url(#hb-${gradId})`} />
              {model.candles.map((c, i) => {
                const x0 = xPx(c.t0);
                const x1 = xPx(c.t1);
                const xc = (x0 + x1) / 2;
                const slotW = x1 - x0;
                const bodyW = Math.max(10, Math.min(slotW * 0.82, innerW * 0.065));
                const yO = yPx(c.o);
                const yC = yPx(c.c);
                const yH = yPx(c.h);
                const yL = yPx(c.l);
                const bullish = c.c >= c.o;
                const bodyTop = Math.min(yO, yC);
                const bodyBot = Math.max(yO, yC);
                const rawBodyH = bodyBot - bodyTop;
                const bodyH = Math.max(3, rawBodyH);
                const bodyY = bodyTop - (bodyH - rawBodyH) / 2;
                const wickColor = bullish ? 'rgb(34 197 94)' : 'rgb(239 68 68)';
                const bodyFill = bullish ? 'rgb(22 163 74)' : 'rgb(220 38 38)';
                const bodyStroke = bullish ? 'rgb(74 222 128)' : 'rgb(248 113 113)';
                return (
                  <g key={`mc-${i}`}>
                    <line x1={xc} x2={xc} y1={yH} y2={bodyY} stroke={wickColor} strokeWidth={1.4} />
                    <line x1={xc} x2={xc} y1={bodyY + bodyH} y2={yL} stroke={wickColor} strokeWidth={1.4} />
                    <rect x={xc - bodyW / 2} y={bodyY} width={bodyW} height={bodyH} fill={bodyFill} stroke={bodyStroke} strokeWidth={1} />
                  </g>
                );
              })}
              <line
                x1={PAD_L}
                x2={PAD_L + innerW}
                y1={yBeat}
                y2={yBeat}
                stroke="rgb(250 234 80)"
                strokeWidth={2.4}
                strokeLinecap="round"
              />
            </>
          ) : (
            <text x={MINI_W / 2} y={MINI_H / 2} textAnchor="middle" fill="rgb(82 82 91)" fontSize="11">
              {row.priceToBeat == null ? 'No PTB' : 'Need ticks'}
            </text>
          )}
        </svg>
      </div>

      <div className="border-t border-zinc-800/70 px-3 py-2">
        <div className="text-[11px] font-black uppercase leading-tight tracking-wide text-zinc-100">
          {sig ? sig.replaceAll('_', ' ') : '—'}
        </div>
        {subtitle ? <div className="mt-0.5 text-[10px] font-medium text-zinc-500">{subtitle}</div> : null}
        <div className="mt-1.5 text-[10px] text-zinc-600 opacity-0 transition-opacity group-hover:opacity-100">Open full chart →</div>
      </div>
    </button>
  );
}

export function PtbMultiAssetGrid(props: {
  rows: PtbMultiAssetRow[];
  onOpenSlug: (slug: string) => void;
  onAddMarkets?: () => void;
}): ReactElement {
  const { rows, onOpenSlug, onAddMarkets } = props;
  const [sort, setSort] = useState<SortMode>('default');
  const [heatmap, setHeatmap] = useState(false);

  const sorted = useMemo(() => {
    const copy = [...rows];
    if (sort === 'default') return copy;
    const score = (r: PtbMultiAssetRow) => {
      const ptb = r.priceToBeat;
      const pts = r.spot;
      if (ptb == null || pts.length < 2) return { abs: 0, sign: 0 as -1 | 0 | 1 };
      const last = pts[pts.length - 1]!.v;
      const pct = ((last - ptb) / ptb) * 100;
      return { abs: Math.abs(pct), sign: last > ptb ? (1 as const) : last < ptb ? (-1 as const) : (0 as const) };
    };
    copy.sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      if (sort === 'distance_abs') return sb.abs - sa.abs;
      if (sort === 'up_first') return sb.sign - sa.sign;
      if (sort === 'down_first') return sa.sign - sb.sign;
      return 0;
    });
    return copy;
  }, [rows, sort]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Multi-asset PTB scan</h2>
          <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-zinc-500">
            Same layout per market: price vs PTB, distance tint, control signal. Click a card to open the full chart.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-800/70 bg-zinc-950/50 px-2 py-1.5 text-[11px] text-zinc-400">
            <input type="checkbox" checked={heatmap} onChange={(e) => setHeatmap(e.target.checked)} className="rounded border-zinc-600" />
            Heat tint
          </label>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
            className="rounded-lg border border-zinc-800/70 bg-zinc-950/80 px-2 py-1.5 text-[11px] text-zinc-200"
          >
            <option value="default">Sort: watch order</option>
            <option value="distance_abs">Sort: |distance|</option>
            <option value="up_first">Sort: UP side first</option>
            <option value="down_first">Sort: DOWN side first</option>
          </select>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-700/60 bg-zinc-950/40 px-4 py-8 text-center text-sm text-zinc-500">
          No markets in your watch list. Add Up/Down slugs on the <span className="font-semibold text-zinc-400">Watch</span> tab, then
          return here.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {sorted.map((row) => (
            <PtbMiniPanel key={row.slug} row={row} heatmap={heatmap} onExpand={() => onOpenSlug(row.slug)} />
          ))}
          {onAddMarkets ? (
            <button
              type="button"
              onClick={onAddMarkets}
              className="flex min-h-[200px] max-w-[340px] flex-col items-center justify-center rounded-2xl border border-dashed border-zinc-700/60 bg-zinc-950/30 px-4 text-center text-[13px] font-semibold text-zinc-500 transition-colors hover:border-zinc-600 hover:bg-zinc-900/40 hover:text-zinc-300"
            >
              + Add markets
              <span className="mt-2 text-[11px] font-normal text-zinc-600">Opens Watch list</span>
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
