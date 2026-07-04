import { useMemo, type ReactElement } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import { computeTickSlopeUsdPerSec } from './ptbCoreEngine';
import { build30DayHourlySpotProjections, type DailyProjectionSummary, type HourlyProjectionRow } from './spotPriceProjection30d';

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtDelta(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = n >= 0 ? '+' : '-';
  return `${s}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function ptbSideBadge(side: HourlyProjectionRow['ptbSide']): ReactElement | null {
  if (!side) return null;
  const cls =
    side === 'above'
      ? 'border-emerald-500/40 bg-emerald-950/40 text-emerald-200'
      : side === 'below'
        ? 'border-rose-500/40 bg-rose-950/40 text-rose-200'
        : 'border-amber-500/40 bg-amber-950/40 text-amber-200';
  const label = side === 'above' ? 'ABOVE' : side === 'below' ? 'BELOW' : 'AT PTB';
  return (
    <span className={`rounded border px-1.5 py-px text-[9px] font-bold uppercase tracking-wide ${cls}`}>
      {label}
    </span>
  );
}

function DailySummaryCard(props: { row: DailyProjectionSummary }): ReactElement {
  const { row } = props;
  return (
    <div className="rounded-lg border border-zinc-800/60 bg-zinc-950/40 px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-zinc-500">Day {row.dayIndex}</div>
          <div className="text-sm font-semibold text-zinc-200">{row.dateLabel}</div>
        </div>
        {ptbSideBadge(row.ptbSideAtClose)}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-zinc-300 sm:grid-cols-4">
        <div>
          <span className="text-zinc-500">Open </span>
          {fmtUsd(row.openPrice)}
        </div>
        <div>
          <span className="text-zinc-500">Close </span>
          {fmtUsd(row.closePrice)}
        </div>
        <div>
          <span className="text-zinc-500">High </span>
          {fmtUsd(row.highPrice)}
        </div>
        <div>
          <span className="text-zinc-500">Low </span>
          {fmtUsd(row.lowPrice)}
        </div>
      </div>
      <div className="mt-1 font-mono text-[10px] tabular-nums text-zinc-500">
        Δ close vs now {fmtDelta(row.deltaCloseVsNowUsd)}
      </div>
    </div>
  );
}

export function RawProjectionsTab(props: {
  slug: string;
  assetLabel?: string | null;
  spot: SpotPoint[];
  priceToBeat: number | null;
  bandUsd?: number | null;
  marketJson?: unknown | null;
  books?: unknown | null;
}): ReactElement {
  const { slug, assetLabel, spot, priceToBeat, bandUsd, marketJson, books } = props;

  const spotLast = spot.length > 0 ? spot[spot.length - 1]!.v : null;

  const slopeUsdPerSec = useMemo(() => {
    if (spot.length < 2) return 0;
    const ticks = spot.map((p) => ({ t: p.t, v: p.v }));
    return computeTickSlopeUsdPerSec(ticks, 96).slopeUsdPerSec;
  }, [spot]);

  const grid = useMemo(() => {
    if (spotLast == null) return null;
    return build30DayHourlySpotProjections({
      spotLast,
      slopeUsdPerSec,
      ptbUsd: priceToBeat,
      bandUsd,
    });
  }, [spotLast, slopeUsdPerSec, priceToBeat, bandUsd]);

  const rowsByDay = useMemo(() => {
    if (!grid) return [];
    const map = new Map<number, HourlyProjectionRow[]>();
    for (const row of grid.hourlyRows) {
      const xs = map.get(row.dayIndex) ?? [];
      xs.push(row);
      map.set(row.dayIndex, xs);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [grid]);

  if (spotLast == null) {
    return (
      <div className="mt-5 rounded-xl border border-zinc-800/60 bg-zinc-950/30 px-4 py-8 text-center text-sm text-zinc-500">
        Waiting for live spot feed — open a market with RTDS spot (BTC/ETH/SOL up/down) to load projections.
      </div>
    );
  }

  return (
    <div className="mt-5 space-y-4">
      <div className="rounded-xl border border-indigo-800/45 bg-indigo-950/20 px-4 py-3 ring-1 ring-indigo-500/10">
        <h2 className="text-sm font-bold text-indigo-100">Raw projected spot · hourly × 30 days</h2>
        <p className="mt-1 text-[11px] leading-snug text-zinc-400">
          Linear extrapolation from the latest tick slope ({assetLabel ?? (slug || 'asset')}). Each row is +1 hour from now.
          Not a forecast — uses only spot tape + PTB available on this desk.
        </p>
        {grid ? (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] tabular-nums text-zinc-300">
            <span>
              Now <span className="font-bold text-white">{fmtUsd(grid.currentSpot)}</span>
            </span>
            <span>
              Slope{' '}
              <span className="font-bold text-indigo-200">
                {grid.slopeUsdPerMin >= 0 ? '+' : ''}
                {grid.slopeUsdPerMin.toFixed(2)}/m
              </span>
              <span className="text-zinc-500">
                {' '}
                ({grid.slopeUsdPerHour >= 0 ? '+' : ''}
                {grid.slopeUsdPerHour.toFixed(0)}/h)
              </span>
            </span>
            {grid.ptbUsd != null ? (
              <span>
                PTB <span className="font-bold text-zinc-100">{fmtUsd(grid.ptbUsd)}</span>
              </span>
            ) : null}
            <span className="text-zinc-500">
              Generated {new Date(grid.generatedAtMs).toLocaleTimeString()}
            </span>
          </div>
        ) : null}
      </div>

      {grid ? (
        <>
          <div>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-zinc-500">Daily summary (30 days)</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {grid.dailySummaries.map((d) => (
                <DailySummaryCard key={d.dayIndex} row={d} />
              ))}
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wide text-zinc-500">
              Hourly grid ({grid.hourlyRows.length} rows)
            </h3>
            <div className="max-h-[60vh] overflow-auto rounded-xl border border-zinc-800/60 bg-black/20">
              <table className="w-full min-w-[640px] border-collapse text-left text-[11px]">
                <thead className="sticky top-0 z-10 bg-zinc-950/95 text-[10px] font-bold uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="px-3 py-2">Day</th>
                    <th className="px-3 py-2">Hour</th>
                    <th className="px-3 py-2">Target time</th>
                    <th className="px-3 py-2 text-right">Projected</th>
                    <th className="px-3 py-2 text-right">Δ vs now</th>
                    <th className="px-3 py-2">vs PTB</th>
                  </tr>
                </thead>
                <tbody>
                  {rowsByDay.map(([dayIndex, rows]) =>
                    rows.map((row, i) => (
                      <tr
                        key={row.hourIndex}
                        className={`border-t border-zinc-800/40 ${i === 0 ? 'bg-zinc-900/30' : ''}`}
                      >
                        <td className="px-3 py-1.5 font-mono tabular-nums text-zinc-500">
                          {i === 0 ? `D${dayIndex}` : ''}
                        </td>
                        <td className="px-3 py-1.5 font-mono tabular-nums text-zinc-400">+{row.hourIndex}h</td>
                        <td className="px-3 py-1.5 text-zinc-300">{row.timeLabel}</td>
                        <td className="px-3 py-1.5 text-right font-mono font-semibold tabular-nums text-zinc-100">
                          {fmtUsd(row.price)}
                        </td>
                        <td
                          className={`px-3 py-1.5 text-right font-mono tabular-nums ${
                            row.deltaUsd >= 0 ? 'text-emerald-300' : 'text-rose-300'
                          }`}
                        >
                          {fmtDelta(row.deltaUsd)}
                        </td>
                        <td className="px-3 py-1.5">
                          {ptbSideBadge(row.ptbSide)}
                          {row.ptbDistUsd != null ? (
                            <span className="ml-1 font-mono text-[10px] tabular-nums text-zinc-500">
                              {fmtDelta(row.ptbDistUsd)}
                            </span>
                          ) : null}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}

      <details className="rounded-xl border border-zinc-800/50 bg-zinc-950/25">
        <summary className="cursor-pointer px-4 py-2.5 text-[11px] font-semibold text-zinc-400 hover:text-zinc-200">
          Raw market + books JSON
        </summary>
        <div className="grid grid-cols-1 gap-4 border-t border-zinc-800/50 p-4 lg:grid-cols-2">
          <div>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-zinc-500">Market</div>
            <pre className="max-h-[40vh] overflow-auto rounded-lg border border-zinc-800/50 bg-black/25 p-3 font-mono text-[10px] leading-relaxed text-zinc-400">
              {marketJson ? JSON.stringify(marketJson, null, 2) : '—'}
            </pre>
          </div>
          <div>
            <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-zinc-500">Books</div>
            <pre className="max-h-[40vh] overflow-auto rounded-lg border border-zinc-800/50 bg-black/25 p-3 font-mono text-[10px] leading-relaxed text-zinc-400">
              {books ? JSON.stringify(books, null, 2) : '—'}
            </pre>
          </div>
        </div>
      </details>
    </div>
  );
}
