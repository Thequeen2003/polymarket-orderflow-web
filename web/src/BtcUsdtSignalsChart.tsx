import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { displayPrice } from './bookLevels';
import type { BookSnapshot } from './orderflowMetrics';
import type { SeriesPoint } from './MomentumChart';

function clamp01(x: number) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function extent(vals: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of vals) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) return { min: min - 1e-8, max: max + 1e-8 };
  return { min, max };
}

function toPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  let d = `M ${points[0]!.x.toFixed(2)} ${points[0]!.y.toFixed(2)}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i]!.x.toFixed(2)} ${points[i]!.y.toFixed(2)}`;
  return d;
}

function sparklinePath(pts: { x: number; y: number }[], pad: number, width: number): string {
  if (pts.length === 0) return '';
  if (pts.length >= 2) return toPath(pts);
  const p = pts[0]!;
  const span = Math.max(16, (width - pad * 2) * 0.14);
  const x0 = Math.max(pad + 1, p.x - span);
  return `M ${x0.toFixed(2)} ${p.y.toFixed(2)} L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
}

function areaUnderMid(pts: { x: number; y: number }[], yBase: number): string {
  if (pts.length === 0) return '';
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  let d = `M ${first.x.toFixed(2)} ${yBase.toFixed(2)} L ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i]!.x.toFixed(2)} ${pts[i]!.y.toFixed(2)}`;
  d += ` L ${last.x.toFixed(2)} ${yBase.toFixed(2)} Z`;
  return d;
}

function readoutFromSnaps(snaps: BookSnapshot[]): string {
  const mids = snaps.map((s) => s.mid).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (mids.length < 3) return 'Collecting depth polls…';
  const i0 = Math.max(0, mids.length - 12);
  const slice = mids.slice(i0);
  const d = slice[slice.length - 1]! - slice[0]!;
  const imbs = snaps
    .slice(-12)
    .map((s) => s.imbalance)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const imbAvg = imbs.length ? imbs.reduce((a, b) => a + b, 0) / imbs.length : 0;
  const tilt = imbAvg > 0.08 ? 'bid-heavy book' : imbAvg < -0.08 ? 'ask-heavy book' : 'balanced book';
  const dir = d > 0.25 ? 'mid grinding up' : d < -0.25 ? 'mid slipping' : 'mid mostly flat';
  return `${dir} over recent polls; ${tilt} on depth.`;
}

/**
 * Multi-strip signals chart for Binance BTCUSDT spot: mid, spread, imbalance + agg-tape buy share.
 * Data comes from the same ~2s depth polls as Book/Flow.
 */
export function BtcUsdtSignalsChart(props: {
  snapshots: BookSnapshot[];
  tapeBuyShare: SeriesPoint[];
  lastUpdateMs: number | null;
}): ReactElement {
  const { snapshots, tapeBuyShare, lastUpdateMs } = props;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  const stale = lastUpdateMs == null ? true : now - lastUpdateMs > 45_000;

  const width = 640;
  const pad = 12;
  const hMid = 118;
  const hSpread = 72;
  const hTape = 78;
  const gap = 8;
  const height = pad + hMid + gap + hSpread + gap + hTape + pad;

  const cleaned = useMemo(() => snapshots.filter((p) => Number.isFinite(p.t)), [snapshots]);
  const tMin = cleaned.length ? Math.min(...cleaned.map((p) => p.t)) : 0;
  const tMax = cleaned.length ? Math.max(...cleaned.map((p) => p.t)) : 1;
  const tSpan = Math.max(1, tMax - tMin);

  const tx = (t: number) => pad + ((t - tMin) / tSpan) * (width - pad * 2);

  const mids = cleaned.map((p) => p.mid).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const { min: midMin, max: midMax } = extent(mids);
  const yMid0 = pad;
  const yMid1 = yMid0 + hMid;
  const toYMid = (v: number) => yMid0 + (1 - clamp01((v - midMin) / (midMax - midMin))) * (hMid - 4);

  const midPts = cleaned.filter((p) => p.mid != null).map((p) => ({ x: tx(p.t), y: toYMid(p.mid!) }));
  const midYBase = yMid0 + hMid - 2;

  const spreads = cleaned.map((p) => p.spread).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const { min: spMin, max: spMax } = extent(spreads.length ? spreads : [0, 1]);
  const ySp0 = yMid1 + gap;
  const ySp1 = ySp0 + hSpread;
  const toYSp = (v: number) => ySp0 + (1 - clamp01((v - spMin) / (spMax - spMin))) * (hSpread - 4);

  const spPts = cleaned.filter((p) => p.spread != null).map((p) => ({ x: tx(p.t), y: toYSp(p.spread!) }));

  const yIm0 = ySp1 + gap;
  const yIm1 = yIm0 + hTape;
  const midY = yIm0 + hTape / 2;

  const tapeClean = useMemo(
    () => tapeBuyShare.filter((p) => Number.isFinite(p.t) && p.v != null && Number.isFinite(p.v as number)),
    [tapeBuyShare],
  );
  const tTapeMin = tapeClean.length ? Math.min(...tapeClean.map((p) => p.t)) : tMin;
  const tTapeMax = tapeClean.length ? Math.max(...tapeClean.map((p) => p.t)) : tMax;
  const tTapeSpan = Math.max(1, tTapeMax - tTapeMin);
  const txTape = (t: number) => pad + ((t - tTapeMin) / tTapeSpan) * (width - pad * 2);
  const tapePts = tapeClean.map((p) => {
    const v = p.v as number;
    const y = yIm1 - 4 - clamp01(v) * (hTape - 8);
    return { x: txTape(p.t), y };
  });

  const last = cleaned[cleaned.length - 1];
  const readout = useMemo(() => readoutFromSnaps(cleaned), [cleaned]);

  return (
    <div className="rounded-2xl border border-amber-900/30 bg-zinc-950/40 p-4 shadow-inner shadow-black/20 ring-1 ring-amber-500/10">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[15px] font-semibold tracking-wide text-amber-100/95">BTC/USDT · signals chart</div>
        <div
          className={`rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide ${
            stale ? 'border-zinc-700/40 bg-zinc-950/40 text-zinc-500' : 'border-emerald-700/40 bg-emerald-950/25 text-emerald-200'
          }`}
          title={lastUpdateMs ? `Last depth poll ${new Date(lastUpdateMs).toLocaleTimeString()}` : 'Waiting'}
        >
          {stale ? 'stale' : 'live'}
        </div>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
        Mid and spread from order book; bottom band is depth imbalance (bid vs ask stack). Orange trace = taker-buy share in the latest agg
        trade batch (0–100%).
      </p>

      <div className="mt-2 flex flex-wrap gap-2 font-mono text-[12px] text-zinc-300">
        <span className="rounded-md bg-zinc-900/55 px-2 py-1">mid {last?.mid != null ? displayPrice(last.mid) : '—'}</span>
        <span className="rounded-md bg-zinc-900/55 px-2 py-1">spread {last?.spread != null ? displayPrice(last.spread) : '—'}</span>
        <span className="rounded-md bg-zinc-900/55 px-2 py-1">
          imb {last?.imbalance != null ? `${(last.imbalance * 100).toFixed(0)}%` : '—'}
        </span>
      </div>

      <svg viewBox={`0 0 ${width} ${height}`} className="mt-3 h-[min(380px,52svh)] w-full">
        <rect x="0" y="0" width={width} height={height} rx="14" className="fill-black/30 stroke-zinc-800/45" />

        {/* Mid band */}
        <rect x={pad} y={yMid0} width={width - pad * 2} height={hMid} rx="10" className="fill-zinc-900/20 stroke-zinc-800/35" />
        <text x={pad + 8} y={yMid0 + 16} className="fill-zinc-500" fontSize="11" fontFamily="ui-monospace, monospace">
          Mid (USDT)
        </text>
        {midPts.length > 1 ? <path d={areaUnderMid(midPts, midYBase)} className="fill-cyan-500/12 stroke-none" /> : null}
        {midPts.length > 0 ? (
          <path d={sparklinePath(midPts, pad, width)} className="fill-none stroke-cyan-300" strokeWidth="2.2" />
        ) : null}
        {midPts.length > 0 ? (
          <circle cx={midPts[midPts.length - 1]!.x} cy={midPts[midPts.length - 1]!.y} r="3.5" className="fill-cyan-200" />
        ) : null}

        {/* Spread band */}
        <rect x={pad} y={ySp0} width={width - pad * 2} height={hSpread} rx="10" className="fill-zinc-900/20 stroke-zinc-800/35" />
        <text x={pad + 8} y={ySp0 + 16} className="fill-zinc-500" fontSize="11" fontFamily="ui-monospace, monospace">
          Spread (USDT)
        </text>
        {spPts.length > 0 ? (
          <path d={sparklinePath(spPts, pad, width)} className="fill-none stroke-violet-300" strokeWidth="1.85" />
        ) : null}

        {/* Imbalance + tape */}
        <rect x={pad} y={yIm0} width={width - pad * 2} height={hTape} rx="10" className="fill-zinc-900/20 stroke-zinc-800/35" />
        <text x={pad + 8} y={yIm0 + 16} className="fill-zinc-500" fontSize="11" fontFamily="ui-monospace, monospace">
          Imbalance (bars) · tape buy % (line)
        </text>
        <line x1={pad} x2={width - pad} y1={midY} y2={midY} className="stroke-zinc-700/50" strokeDasharray="4 3" />
        {cleaned.map((p, i) => {
          if (p.imbalance == null || !Number.isFinite(p.imbalance)) return null;
          const imb = p.imbalance;
          const x = tx(p.t);
          const w = 3;
          const h = (hTape / 2 - 8) * clamp01(Math.abs(imb));
          const y = imb >= 0 ? midY - h : midY;
          return <rect key={`imb-${i}`} x={x - w / 2} y={y} width={w} height={Math.max(h, 1)} rx="1" className={imb >= 0 ? 'fill-emerald-400/55' : 'fill-rose-400/55'} />;
        })}
        {tapePts.length > 0 ? (
          <path d={sparklinePath(tapePts, pad, width)} className="fill-none stroke-amber-300/90" strokeWidth="1.75" />
        ) : null}
      </svg>

      <div className="mt-3 rounded-xl border border-zinc-800/45 bg-black/25 px-3 py-2.5 text-[12px] leading-relaxed text-zinc-400">
        <span className="font-semibold text-amber-200/90">Readout:</span> {readout}
      </div>
    </div>
  );
}
