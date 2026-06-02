import type { ReactElement } from 'react';
import { buildSpotProjectionGrid, type SpotProjectionCell } from './spotPriceProjection';

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtDelta(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  const s = n >= 0 ? '+' : '-';
  return `${s}$${Math.abs(n).toFixed(0)}`;
}

export type PtbDirectionContext = {
  geo: 'ABOVE' | 'BELOW' | 'IN_BAND';
  separation: 'STRONG' | 'CLEAR' | 'WEAK';
  edgeLive: boolean;
  mode: 'up' | 'down';
  viewLabel: string;
  ptb: number;
  bandHi: number;
  bandLo: number;
};

type CellZone = 'above' | 'in_band' | 'below';

function classifyPrice(price: number, ctx: PtbDirectionContext): CellZone {
  if (price > ctx.bandHi) return 'above';
  if (price < ctx.bandLo) return 'below';
  return 'in_band';
}

function isFavorable(zone: CellZone, mode: 'up' | 'down'): boolean {
  return (zone === 'above' && mode === 'up') || (zone === 'below' && mode === 'down');
}

function cellBorder(zone: CellZone, mode: 'up' | 'down'): string {
  if (zone === 'in_band') return 'border-amber-600/50';
  return isFavorable(zone, mode) ? 'border-emerald-600/50' : 'border-rose-600/40';
}

function cellBg(zone: CellZone, mode: 'up' | 'down'): string {
  if (zone === 'in_band') return 'bg-amber-950/25';
  return isFavorable(zone, mode) ? 'bg-emerald-950/25' : 'bg-rose-950/20';
}

function cellPriceText(zone: CellZone, mode: 'up' | 'down'): string {
  if (zone === 'in_band') return 'text-amber-100';
  return isFavorable(zone, mode) ? 'text-emerald-100' : 'text-rose-200';
}

function deltaTone(delta: number, zone: CellZone | null, mode: 'up' | 'down' | null): string {
  if (zone && mode) {
    if (zone === 'in_band') return 'text-amber-300/80';
    return isFavorable(zone, mode) ? 'text-emerald-300' : 'text-rose-300';
  }
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.005) return 'text-zinc-400';
  return delta > 0 ? 'text-emerald-300' : 'text-rose-300';
}

function cellMeaning(zone: CellZone, mode: 'up' | 'down', price: number, ctx: PtbDirectionContext): string {
  if (zone === 'in_band') {
    const distHi = ctx.bandHi - price;
    const distLo = price - ctx.bandLo;
    if (mode === 'up') return `$${distHi.toFixed(0)} to break`;
    return `$${distLo.toFixed(0)} to break`;
  }
  const fav = isFavorable(zone, mode);
  if (fav) {
    const edge = mode === 'up' ? price - ctx.bandHi : ctx.bandLo - price;
    return `+$${edge.toFixed(0)} clear`;
  }
  const dist = mode === 'up' ? ctx.bandLo - price : price - ctx.bandHi;
  return `$${dist.toFixed(0)} wrong`;
}

function CompactCellView(props: {
  cell: SpotProjectionCell;
  ptbCtx: PtbDirectionContext | null | undefined;
}): ReactElement {
  const { cell, ptbCtx } = props;
  const ok = Number.isFinite(cell.price);
  const zone = ok && ptbCtx ? classifyPrice(cell.price, ptbCtx) : null;
  const mode = ptbCtx?.mode ?? null;

  const border = zone && mode ? cellBorder(zone, mode) : 'border-indigo-800/35';
  const bg = zone && mode ? cellBg(zone, mode) : 'bg-indigo-950/20';
  const priceClr = zone && mode ? cellPriceText(zone, mode) : 'text-indigo-50';
  const meaning = ok && zone && ptbCtx ? cellMeaning(zone, ptbCtx.mode, cell.price, ptbCtx) : null;

  return (
    <div
      className={`flex shrink-0 flex-col items-center rounded-lg border ${border} ${bg} px-1.5 py-1 min-w-[3.1rem]`}
      title={
        ok
          ? `${cell.label}: ${fmtUsd(cell.price)} (${fmtDelta(cell.deltaUsd)} vs now)${zone ? `\n${zone === 'in_band' ? 'IN BAND' : zone === 'above' ? 'ABOVE PTB' : 'BELOW PTB'}` : ''}${meaning ? `\n${meaning}` : ''}`
          : `${cell.label}: unknown`
      }
    >
      <span className="text-[8px] font-bold uppercase tracking-wide text-indigo-300/80">{cell.label}</span>
      <span className={`mt-0.5 font-mono text-[10px] font-semibold tabular-nums ${priceClr}`}>
        {fmtUsd(ok ? cell.price : null)}
      </span>
      {ok ? (
        <span className={`mt-0.5 font-mono text-[8px] tabular-nums ${deltaTone(cell.deltaUsd, zone, mode)}`}>
          {fmtDelta(cell.deltaUsd)}
        </span>
      ) : (
        <span className="mt-0.5 text-[8px] text-zinc-600">—</span>
      )}
    </div>
  );
}

function ExpandedCellView(props: {
  cell: SpotProjectionCell;
  ptbCtx: PtbDirectionContext | null | undefined;
}): ReactElement {
  const { cell, ptbCtx } = props;
  const ok = Number.isFinite(cell.price);
  const zone = ok && ptbCtx ? classifyPrice(cell.price, ptbCtx) : null;
  const mode = ptbCtx?.mode ?? null;

  const border = zone && mode ? cellBorder(zone, mode) : 'border-indigo-800/35';
  const bg = zone && mode ? cellBg(zone, mode) : 'bg-indigo-950/20';
  const priceClr = zone && mode ? cellPriceText(zone, mode) : 'text-indigo-50';
  const meaning = ok && zone && ptbCtx ? cellMeaning(zone, ptbCtx.mode, cell.price, ptbCtx) : null;

  const zoneBadge = zone && mode ? (() => {
    if (zone === 'in_band') return { label: 'BAND', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30' };
    const fav = isFavorable(zone, mode);
    const lbl = zone === 'above' ? 'ABOVE' : 'BELOW';
    return fav
      ? { label: lbl, cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' }
      : { label: lbl, cls: 'bg-rose-500/15 text-rose-300 border-rose-500/30' };
  })() : null;

  return (
    <div
      className={`flex shrink-0 flex-col items-center rounded-lg border ${border} ${bg} px-2 py-1.5 min-w-[4.5rem]`}
      title={
        ok
          ? `${cell.label}: ${fmtUsd(cell.price)} (${fmtDelta(cell.deltaUsd)} vs now)${zone ? `\n${zone === 'in_band' ? 'IN BAND' : zone === 'above' ? 'ABOVE PTB' : 'BELOW PTB'}` : ''}${meaning ? `\n${meaning}` : ''}`
          : `${cell.label}: unknown`
      }
    >
      <span className="text-[8px] font-bold uppercase tracking-wide text-indigo-300/80">{cell.label}</span>
      <span className={`mt-0.5 font-mono text-[11px] font-semibold tabular-nums ${priceClr}`}>
        {fmtUsd(ok ? cell.price : null)}
      </span>
      {ok ? (
        <span className={`mt-0.5 font-mono text-[8px] tabular-nums ${deltaTone(cell.deltaUsd, zone, mode)}`}>
          {fmtDelta(cell.deltaUsd)}
        </span>
      ) : (
        <span className="mt-0.5 text-[8px] text-zinc-600">—</span>
      )}
      {zoneBadge ? (
        <span className={`mt-1 rounded border px-1.5 py-px text-[7px] font-black uppercase tracking-wider ${zoneBadge.cls}`}>
          {zoneBadge.label}
        </span>
      ) : null}
      {meaning ? (
        <span className="mt-0.5 text-center text-[7px] leading-tight text-zinc-400">{meaning}</span>
      ) : null}
    </div>
  );
}

function directionLabel(ctx: PtbDirectionContext): string {
  if (ctx.geo === 'IN_BAND') return 'IN BAND';
  return ctx.geo === 'ABOVE' ? 'ABOVE PTB' : 'BELOW PTB';
}

function nowMeaning(ctx: PtbDirectionContext): string {
  if (ctx.geo === 'IN_BAND') return 'Confirm break before acting';
  if (ctx.edgeLive) return `Favors ${ctx.viewLabel} — edge live`;
  return ctx.geo === 'ABOVE'
    ? `Above band — ${ctx.mode === 'up' ? 'favorable' : 'wrong side'}`
    : `Below band — ${ctx.mode === 'down' ? 'favorable' : 'wrong side'}`;
}

function ctxBoxStyles(ctx: PtbDirectionContext): { border: string; bg: string; text: string; dot: string } {
  if (ctx.geo === 'IN_BAND') {
    return { border: 'border-amber-500/50', bg: 'bg-amber-500/8', text: 'text-amber-200', dot: 'bg-amber-400' };
  }
  if (ctx.edgeLive) {
    return { border: 'border-emerald-500/50', bg: 'bg-emerald-500/8', text: 'text-emerald-200', dot: 'bg-emerald-400' };
  }
  return { border: 'border-zinc-600/50', bg: 'bg-zinc-800/25', text: 'text-zinc-300', dot: 'bg-zinc-500' };
}

export function SpotPriceProjectionGrid(props: {
  spotLast: number | null;
  slopeUsdPerSec: number | null;
  endsInMs?: number | null;
  assetLabel?: string;
  ptbContext?: PtbDirectionContext | null;
}): ReactElement | null {
  const { spotLast, slopeUsdPerSec, endsInMs, assetLabel, ptbContext } = props;
  if (spotLast == null || slopeUsdPerSec == null) return null;

  const grid = buildSpotProjectionGrid({ spotLast, slopeUsdPerSec, endsInMs });
  if (!grid) return null;

  const slopePerMin = grid.slopeUsdPerSec * 60;

  return (
    <div className="mt-2 rounded-xl border border-indigo-700/40 bg-indigo-950/15 px-3 py-2.5 ring-1 ring-indigo-900/25">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div
          className="text-[9px] font-extrabold uppercase tracking-[0.16em] text-indigo-200/90"
          title="Linear extrapolation from latest tick slope — not a forecast guarantee"
        >
          Projected {assetLabel ? `${assetLabel} ` : ''}spot
        </div>
        <div className="font-mono text-sm font-semibold tabular-nums text-indigo-100/90 sm:text-base">
          Now {fmtUsd(grid.currentSpot)}
          <span className="text-indigo-300/60"> · </span>
          Slope {slopePerMin >= 0 ? '+' : ''}
          {slopePerMin.toFixed(2)}/m
        </div>
      </div>

      {ptbContext ? (() => {
        const s = ctxBoxStyles(ptbContext);
        return (
          <div
            className={`mt-2 flex items-center gap-2 rounded-lg border ${s.border} ${s.bg} px-2.5 py-1.5`}
            title={`PTB ${fmtUsd(ptbContext.ptb)} · Band ${fmtUsd(ptbContext.bandLo)}–${fmtUsd(ptbContext.bandHi)} · ${ptbContext.viewLabel} lens`}
          >
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${s.dot}`} />
            <span className={`text-[10px] font-black uppercase tracking-wide ${s.text}`}>
              {directionLabel(ptbContext)}
            </span>
            <span className="text-[9px] font-semibold uppercase tracking-wide text-white/40">
              {ptbContext.separation}
            </span>
            <span className="mx-1 hidden text-zinc-700 sm:inline">|</span>
            <span className="hidden text-[9px] leading-tight text-zinc-400 sm:inline">
              {nowMeaning(ptbContext)}
            </span>
            <span className="ml-auto font-mono text-[8px] tabular-nums text-zinc-500">
              PTB {fmtUsd(ptbContext.ptb)}
            </span>
          </div>
        );
      })() : null}

      {ptbContext ? (
        <div className="mt-1.5 flex items-center gap-3 text-[8px] font-semibold text-zinc-500">
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500/70" />
            {ptbContext.mode === 'up' ? 'Above' : 'Below'} = favorable
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500/70" />
            Band = unconfirmed
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-rose-500/70" />
            {ptbContext.mode === 'up' ? 'Below' : 'Above'} = wrong side
          </span>
        </div>
      ) : null}

      <div className="mt-2">
        <div className="text-[8px] font-semibold uppercase tracking-wide text-indigo-400/70">1m → 30m</div>
        <div className="mt-1 flex gap-1 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:thin]">
          {grid.minuteHorizons.map((cell) => (
            <CompactCellView key={cell.label} cell={cell} ptbCtx={ptbContext} />
          ))}
        </div>
      </div>

      <div className="mt-2 border-t border-indigo-800/30 pt-2">
        <div className="text-[8px] font-semibold uppercase tracking-wide text-indigo-400/70">5m · 15m · 30m · 1h · EOD</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {grid.longerHorizons.map((cell) => (
            <ExpandedCellView key={cell.label} cell={cell} ptbCtx={ptbContext} />
          ))}
        </div>
      </div>
    </div>
  );
}
