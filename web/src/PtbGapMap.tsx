import { useMemo, type ReactElement } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import { pickBookLevels, midPrice } from './bookLevels';
import { buildSpotCandles, type SpotTick } from './spotVsPtb';

const EPS_SIDE = 0.35;
const BIN_COUNT = 52;
const HOLD_FRAC = 0.56;
const GAP_CLEAN = 0.44;

function extentWithZero(minV: number, maxV: number): { min: number; max: number } {
  const lo = Math.min(0, minV);
  const hi = Math.max(0, maxV);
  if (lo === hi) return { min: lo - 1, max: hi + 1 };
  const pad = (hi - lo) * 0.08;
  return { min: lo - pad, max: hi + pad };
}

type Bin = {
  lo: number;
  hi: number;
  tickMass: number;
  bookMass: number;
};

function emptyBins(plotMin: number, plotMax: number, n: number): Bin[] {
  const w = (plotMax - plotMin) / n;
  return Array.from({ length: n }, (_, i) => ({
    lo: plotMin + i * w,
    hi: plotMin + (i + 1) * w,
    tickMass: 0,
    bookMass: 0,
  }));
}

function binIndex(d: number, plotMin: number, plotMax: number, n: number): number {
  const w = (plotMax - plotMin) / n;
  const i = Math.floor((d - plotMin) / w + 1e-12);
  return Math.max(0, Math.min(n - 1, i));
}

function addTickMass(bins: Bin[], d: number, plotMin: number, plotMax: number): void {
  const i = binIndex(d, plotMin, plotMax, bins.length);
  bins[i]!.tickMass += 1;
}

/** Map share-price ladder into Δ bins (illustrative): anchor outcome mid at current spot Δ. */
function addBookMass(
  bins: Bin[],
  bids: { price: number; size: number }[],
  asks: { price: number; size: number }[],
  mid: number | null,
  dSpot: number,
  spanUsd: number,
  plotMin: number,
  plotMax: number,
): void {
  if (mid == null || !Number.isFinite(mid)) return;
  const levels = [...bids.slice(0, 28), ...asks.slice(0, 28)];
  if (levels.length === 0) return;
  const spread =
    Math.max(...levels.map((l) => l.price)) - Math.min(...levels.map((l) => l.price));
  const scale = spanUsd / Math.max(0.06, Math.min(0.45, spread + 0.02));
  const n = bins.length;
  for (const l of levels) {
    if (!Number.isFinite(l.price) || !Number.isFinite(l.size) || l.size <= 0) continue;
    const d = dSpot + (l.price - mid) * scale;
    const mass = Math.sqrt(l.size) * (0.35 + l.price);
    const i = binIndex(d, plotMin, plotMax, n);
    bins[i]!.bookMass += mass;
  }
}

function normalize01(vals: number[]): number[] {
  const m = Math.max(1e-9, ...vals);
  return vals.map((v) => Math.min(1, v / m));
}

function contiguousMaxMean(scores: number[], i0: number, i1: number): { mean: number; a: number; b: number } | null {
  const lo = Math.min(i0, i1);
  const hi = Math.max(i0, i1);
  if (lo > hi) return null;
  let bestMean = -1;
  let bestA = lo;
  let bestB = lo;
  for (let a = lo; a <= hi; a++) {
    let s = 0;
    for (let b = a; b <= hi; b++) {
      s += scores[b]!;
      const len = b - a + 1;
      const mean = s / len;
      if (mean > bestMean && len >= 2) {
        bestMean = mean;
        bestA = a;
        bestB = b;
      }
    }
  }
  if (bestMean < 0) return null;
  return { mean: bestMean, a: bestA, b: bestB };
}

/**
 * PTB-centered Δ chart: candles, tick+book “vacuum” heatmap, live spot marker, and gap / fast-move readouts.
 */
export function PtbGapMap(props: {
  spot: SpotPoint[];
  priceToBeat: number | null;
  lastUpdateMs: number | null;
  /** CLOB books for above vs below outcomes (same order as dashboard up/down). */
  bookAbove: unknown;
  bookBelow: unknown;
  aboveLabel?: string;
  belowLabel?: string;
}): ReactElement | null {
  const { spot, priceToBeat, lastUpdateMs, bookAbove, bookBelow, aboveLabel = 'Above', belowLabel = 'Below' } = props;
  const pts = useMemo(() => spot.slice(-320), [spot]);
  const level = priceToBeat;

  const deltaPts: SpotTick[] = useMemo(() => {
    if (level == null || pts.length < 2) return [];
    return pts.map((p) => ({ t: p.t, v: p.v - level }));
  }, [level, pts]);

  const candles = useMemo(() => buildSpotCandles(deltaPts, 20), [deltaPts]);

  const model = useMemo(() => {
    if (level == null || deltaPts.length < 2) return null;
    const vals = deltaPts.map((p) => p.v);
    const vMin = Math.min(...vals);
    const vMax = Math.max(...vals);
    const { min: plotMin, max: plotMax } = extentWithZero(vMin, vMax);
    const span = Math.max(1e-9, plotMax - plotMin);
    const sessionRange = Math.max(1e-6, vMax - vMin, Math.abs(vals[vals.length - 1]!) * 0.35);

    const bins = emptyBins(plotMin, plotMax, BIN_COUNT);
    for (const p of deltaPts) addTickMass(bins, p.v, plotMin, plotMax);

    const { bids: bA, asks: aA } = pickBookLevels(bookAbove);
    const { bids: bB, asks: aB } = pickBookLevels(bookBelow);
    const midA = midPrice(bookAbove);
    const midB = midPrice(bookBelow);
    const dSpot = vals[vals.length - 1]!;
    addBookMass(bins, bA, aA, midA, dSpot, sessionRange, plotMin, plotMax);
    addBookMass(bins, bB, aB, midB, dSpot, sessionRange, plotMin, plotMax);

    const tickN = normalize01(bins.map((b) => b.tickMass));
    const bookN = normalize01(bins.map((b) => b.bookMass));
    const tickVac = tickN.map((t) => 1 - t);
    const bookVac = bookN.map((t) => 1 - t);
    const composite = bins.map((_, i) => Math.max(tickVac[i]! * 0.62 + bookVac[i]! * 0.38, tickVac[i]! * 0.85));

    let aboveClose = 0;
    let belowClose = 0;
    for (const c of candles) {
      if (c.c > 0.02) aboveClose++;
      else if (c.c < -0.02) belowClose++;
    }
    const totalC = aboveClose + belowClose;
    const holdAbove = totalC > 0 && aboveClose / totalC >= HOLD_FRAC;
    const holdBelow = totalC > 0 && belowClose / totalC >= HOLD_FRAC;

    const iSpot = binIndex(dSpot, plotMin, plotMax, BIN_COUNT);
    const i0 = binIndex(0, plotMin, plotMax, BIN_COUNT);
    const iHi = binIndex(vMax, plotMin, plotMax, BIN_COUNT);
    const iLo = binIndex(vMin, plotMin, plotMax, BIN_COUNT);

    const toward = contiguousMaxMean(composite, iSpot, i0);
    const towardMean = toward?.mean ?? 0;
    const towardOk = toward != null && toward.mean >= GAP_CLEAN;

    let extension: { mean: number; a: number; b: number } | null = null;
    if (holdAbove && dSpot > EPS_SIDE) {
      extension = contiguousMaxMean(composite, iSpot, iHi);
    } else if (holdBelow && dSpot < -EPS_SIDE) {
      extension = contiguousMaxMean(composite, iLo, iSpot);
    }
    const extMean = extension?.mean ?? 0;
    const extOk = extension != null && extension.mean >= GAP_CLEAN * 0.92;

    let highlight: { a: number; b: number; kind: 'toward-ptb' | 'extension' } | null = null;
    if (extOk && extMean >= towardMean * 0.88 && (holdAbove || holdBelow)) {
      highlight = { a: extension!.a, b: extension!.b, kind: 'extension' };
    } else if (towardOk) {
      highlight = { a: toward!.a, b: toward!.b, kind: 'toward-ptb' };
    } else if (extOk) {
      highlight = { a: extension!.a, b: extension!.b, kind: 'extension' };
    }

    let label = '';
    if (dSpot < -EPS_SIDE) {
      label = `Price sitting under PTB`;
      if (towardOk) label += ` + gap above (vacuum toward PTB)`;
      else label += ` — no clean vacuum band up to PTB in this window`;
    } else if (dSpot > EPS_SIDE) {
      label = `Price sitting above PTB`;
      if (towardOk) label += ` + gap below (vacuum back toward PTB)`;
      else label += ` — no clean vacuum band down to PTB in this window`;
    } else {
      label = `Price near PTB (${dSpot >= 0 ? 'slightly above' : 'slightly below'} the line)`;
    }

    let ruleLine = '';
    if (highlight?.kind === 'extension') {
      ruleLine =
        holdAbove && dSpot > 0
          ? `Fast-move lane: candles are holding above PTB and the same-side path (further above) shows a low-resistance strip — least friction for the next push in that direction.`
          : holdBelow && dSpot < 0
            ? `Fast-move lane: candles are holding below PTB and the same-side path (further below) shows a low-resistance strip — least friction for the next push in that direction.`
            : `Low-resistance strip detected along the extension side of the window.`;
    } else if (highlight?.kind === 'toward-ptb') {
      ruleLine = `Toward-PTB lane: spot rarely traded through this band vs thin combined depth — watch for a quicker snap through this pocket.`;
    } else {
      ruleLine = `No dominant vacuum lane vs PTB right now — liquidity and prints look more continuous in this slice.`;
    }

    return {
      plotMin,
      plotMax,
      span,
      dSpot,
      bins,
      composite,
      highlight,
      label,
      ruleLine,
    };
  }, [level, deltaPts, candles, bookAbove, bookBelow]);

  if (level == null || pts.length < 2 || !model) {
    return (
      <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 text-sm text-zinc-500 ring-1 ring-white/[0.02]">
        PTB gap map needs SSR PTB and RTDS spot (plus books for depth overlay).
      </div>
    );
  }

  const { plotMin, plotMax, span, dSpot, bins, composite, highlight, label, ruleLine } = model;
  const width = 600;
  const height = 212;
  const pad = 14;
  const innerH = height - pad * 2;
  const innerW = width - pad * 2;

  const tMin = deltaPts[0]!.t;
  const tMax = deltaPts[deltaPts.length - 1]!.t;
  const tSpan = Math.max(1, tMax - tMin);

  const yD = (dv: number) => pad + (1 - (dv - plotMin) / span) * innerH;
  const xT = (t: number) => pad + ((t - tMin) / tSpan) * innerW;
  const y0 = yD(0);

  const hi = Math.max(...composite);
  const gapAlpha = (g: number) => (hi > 1e-9 ? 0.08 + 0.55 * (g / hi) : 0.08);

  return (
    <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 shadow-inner shadow-black/15 ring-1 ring-white/[0.02]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[13px] font-semibold tracking-tight text-zinc-100">PTB gap map</div>
        <div className="font-mono text-[10px] text-zinc-500">
          {lastUpdateMs ? `updated ${new Date(lastUpdateMs).toLocaleTimeString()}` : '—'}
        </div>
      </div>

      <p className="mt-2 rounded-lg border border-violet-900/35 bg-violet-950/25 px-3 py-2 text-[11px] leading-relaxed text-violet-100/95">
        <span className="font-semibold text-violet-200">Read</span> · {label}
      </p>
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
        <span className="font-semibold text-cyan-200/90">Rule engine</span> · {ruleLine}
      </p>

      <div className="mt-3 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        Δ = spot − PTB (heat = low prints + thin mapped depth = vacuum lane)
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="mt-1 h-[212px] w-full">
        <rect x="0" y="0" width={width} height={height} rx="14" className="fill-black/30 stroke-zinc-800/45" />

        {/* Heatmap / ladder: per-bin horizontal strip */}
        {bins.map((b, i) => {
          const y1 = yD(b.hi);
          const y2 = yD(b.lo);
          const top = Math.min(y1, y2);
          const h = Math.max(1.5, Math.abs(y2 - y1));
          const g = composite[i] ?? 0;
          const inHi =
            highlight != null && i >= Math.min(highlight.a, highlight.b) && i <= Math.max(highlight.a, highlight.b);
          const fill = inHi
            ? highlight!.kind === 'extension'
              ? 'rgba(250, 204, 21, 0.42)'
              : 'rgba(34, 211, 238, 0.38)'
            : `rgba(139, 92, 246, ${gapAlpha(g)})`;
          const stroke = inHi
            ? highlight!.kind === 'extension'
              ? 'rgb(250 204 21)'
              : 'rgb(34 211 238)'
            : 'transparent';
          return (
            <rect
              key={i}
              x={pad}
              y={top}
              width={innerW}
              height={h}
              fill={fill}
              stroke={stroke}
              strokeWidth={inHi ? 1.25 : 0}
              className="pointer-events-none"
            />
          );
        })}

        <line x1={pad} x2={width - pad} y1={y0} y2={y0} className="stroke-amber-300" strokeWidth={2.2} />

        {candles.map((c, i) => {
          const x0 = xT(c.t0);
          const x1 = xT(c.t1);
          const xc = (x0 + x1) / 2;
          const bw = Math.max(2.2, (x1 - x0) * 0.52);
          const yH = yD(c.h);
          const yL = yD(c.l);
          const yO = yD(c.o);
          const yC = yD(c.c);
          const top = Math.min(yO, yC);
          const bot = Math.max(yO, yC);
          const bodyH = Math.max(1.2, bot - top);
          const bull = c.c >= c.o;
          const stroke = bull ? 'rgb(52 211 153 / 0.92)' : 'rgb(251 113 133 / 0.9)';
          const fill = bull ? 'rgba(16,185,129,0.42)' : 'rgba(244,63,94,0.38)';
          return (
            <g key={`${c.t0}-${i}`}>
              <line x1={xc} x2={xc} y1={yH} y2={yL} stroke={stroke} strokeWidth={1.05} opacity={0.95} />
              <rect x={xc - bw / 2} y={top} width={bw} height={bodyH} rx={1} fill={fill} stroke={stroke} strokeWidth={0.9} />
            </g>
          );
        })}

        <circle cx={xT(pts[pts.length - 1]!.t)} cy={yD(dSpot)} r="5.5" className="fill-white stroke-amber-200" strokeWidth={2} />

        <text x={pad + 4} y={Math.max(13, y0 - 5)} className="fill-amber-200/90" fontSize="10" fontFamily="ui-monospace, monospace">
          PTB
        </text>
        <text x={width - pad - 4} y={pad + 11} textAnchor="end" className="fill-zinc-500" fontSize="9" fontFamily="ui-monospace, monospace">
          +{plotMax.toFixed(2)}
        </text>
        <text x={width - pad - 4} y={height - pad - 2} textAnchor="end" className="fill-zinc-500" fontSize="9" fontFamily="ui-monospace, monospace">
          {plotMin.toFixed(2)}
        </text>
      </svg>

      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-zinc-500">
        <span>
          <span className="text-violet-300/90">Violet heat</span> = composite vacuum (ticks + depth)
        </span>
        <span>
          <span className="text-cyan-300/90">Cyan band</span> = toward-PTB pocket
        </span>
        <span>
          <span className="text-amber-200/90">Amber band</span> = same-side extension lane
        </span>
        <span className="font-mono">
          {aboveLabel} / {belowLabel} depth mapped with mids anchored at spot Δ — shape cue, not exact USD ladders.
        </span>
      </div>
    </div>
  );
}
