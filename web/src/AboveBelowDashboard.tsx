import { useEffect, useState, type ReactElement } from 'react';
import type { ClobBookEntry } from './lib/api';
import { displayPrice, midPrice, pickBookLevels } from './bookLevels';
import type { BookSnapshot } from './orderflowMetrics';
import { STREAM_ATTRIBUTION_LINE } from './streamAttribution';
import { resolveUpDownIndices } from './upDown';

function parseIsoMs(v: unknown): number | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function fmtAgo(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

function slope(points: { t: number; v: number | null }[]): number | null {
  const xs = points.filter((p) => typeof p.v === 'number' && Number.isFinite(p.v as number));
  if (xs.length < 2) return null;
  const a = xs[xs.length - 1]!;
  const b = xs[Math.max(0, xs.length - 6)]!;
  const dt = Math.max(1, a.t - b.t);
  return ((a.v as number) - (b.v as number)) / dt;
}

function firstWall(levels: { price: number; size: number }[], minSize: number): { price: number; size: number } | null {
  for (const l of levels) {
    if (l.size >= minSize) return l;
  }
  return null;
}

export function AboveBelowDashboard({
  market,
  books,
  outcomeLabels,
  flowSeriesForSlug,
  priceToBeat,
  refPrice,
}: {
  market: unknown | null;
  books: ClobBookEntry[] | null;
  outcomeLabels: string[];
  flowSeriesForSlug: Record<string, BookSnapshot[]> | null;
  priceToBeat: number | null;
  refPrice: number | null;
}): ReactElement | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  if (!books || books.length < 2) return null;
  const idx = resolveUpDownIndices(outcomeLabels, market);
  if (!idx) return null;
  const up = books[idx.up];
  const down = books[idx.down];
  if (!up || !down || up.error || down.error) return null;

  const midUp = midPrice(up.book);
  const midDown = midPrice(down.book);
  if (midUp == null || midDown == null) return null;
  const pUp = midUp + midDown > 0.05 ? midUp / (midUp + midDown) : midUp;
  const distPp = (pUp - 0.5) * 100;
  const favored = pUp > 0.5 ? 'up' : pUp < 0.5 ? 'down' : 'tie';

  const upSeries = flowSeriesForSlug?.[up.token] ?? [];
  const dnSeries = flowSeriesForSlug?.[down.token] ?? [];
  const sUp = slope(upSeries.map((p) => ({ t: p.t, v: p.mid })));
  const sDn = slope(dnSeries.map((p) => ({ t: p.t, v: p.mid })));
  const imbUp = upSeries.length ? upSeries[upSeries.length - 1]!.imbalance : null;
  const churnUp = upSeries.length ? upSeries[upSeries.length - 1]!.churn : null;

  const upName = outcomeLabels[idx.up] ?? 'Up';
  const downName = outcomeLabels[idx.down] ?? 'Down';

  const endMs = market && typeof market === 'object' ? parseIsoMs((market as Record<string, unknown>).endDate) : null;
  const toEnd = endMs != null ? endMs - now : null;

  const distToBeat = priceToBeat != null && refPrice != null ? refPrice - priceToBeat : null;
  const isUpDown =
    (market && typeof market === 'object' && typeof (market as Record<string, unknown>).slug === 'string'
      ? String((market as Record<string, unknown>).slug).toLowerCase().includes('updown')
      : false) ||
    (market && typeof market === 'object' && typeof (market as Record<string, unknown>).question === 'string'
      ? String((market as Record<string, unknown>).question).toLowerCase().includes('up or down')
      : false);

  const upLv = pickBookLevels(up.book);
  const dnLv = pickBookLevels(down.book);
  const wallAskUp = firstWall(upLv.asks, 250);
  const wallBidUp = firstWall(upLv.bids, 250);
  const wallAskDn = firstWall(dnLv.asks, 250);
  const wallBidDn = firstWall(dnLv.bids, 250);

  const momentumNote =
    sUp != null && sDn != null
      ? sUp > 0 && sDn < 0
        ? `Momentum favors “${upName}” (up mid rising, down mid falling).`
        : sUp < 0 && sDn > 0
          ? `Momentum favors “${downName}” (down mid rising, up mid falling).`
          : 'Momentum is mixed (both mids drifting similarly).'
      : 'Not enough history yet to estimate momentum.';

  const pressureNote =
    imbUp == null
      ? 'No imbalance metric yet (need a few snapshots).'
      : imbUp > 0.12
        ? 'Bid depth is stacked (buyers controlling the book).'
        : imbUp < -0.12
          ? 'Ask depth is stacked (sellers controlling the book).'
          : 'Depth is fairly balanced.';

  return (
    <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 shadow-inner shadow-black/15 ring-1 ring-white/[0.02]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[13px] font-semibold tracking-tight text-zinc-100">Above/Below dashboard</div>
        <div className="font-mono text-[11px] text-zinc-500">
          {toEnd != null ? (toEnd >= 0 ? `ends in ${fmtAgo(toEnd)}` : `ended ${fmtAgo(-toEnd)} ago`) : '— end unknown'}
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        {!isUpDown ? (
          <div className="rounded-xl border border-zinc-800/50 bg-black/20 p-3 lg:col-span-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Price-to-beat</div>
            <div className="mt-1 flex flex-wrap items-baseline gap-3">
              <div className="text-sm font-semibold text-zinc-100">
                Price to beat:{' '}
                <span className="font-mono">
                  {priceToBeat != null ? `$${priceToBeat.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
                </span>
              </div>
              <div className="text-sm font-semibold text-zinc-100">
                Spot:{' '}
                <span className="font-mono">
                  {refPrice != null ? `$${refPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
                </span>
              </div>
              <div className="text-xs text-zinc-500">
                {distToBeat != null ? (
                  <span>
                    Distance:{' '}
                    <span className={distToBeat >= 0 ? 'text-emerald-200' : 'text-rose-200'}>
                      {distToBeat >= 0 ? '+' : ''}
                      {distToBeat.toFixed(2)}
                    </span>
                  </span>
                ) : (
                  'Distance: —'
                )}
              </div>
            </div>
            <p className="mt-2 text-[10px] leading-snug text-zinc-600">
              {STREAM_ATTRIBUTION_LINE} PTB: Polymarket SSR. This distance is underlying vs the level.
            </p>
          </div>
        ) : null}

        <div className="rounded-xl border border-zinc-800/50 bg-black/20 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Implied finish</div>
          <div className="mt-1 text-sm font-semibold text-zinc-100">
            Favored:{' '}
            <span className={favored === 'up' ? 'text-emerald-200' : favored === 'down' ? 'text-sky-200' : 'text-zinc-200'}>
              {favored === 'up' ? upName : favored === 'down' ? downName : '—'}
            </span>{' '}
            <span className="text-zinc-500">
              ({upName} {(pUp * 100).toFixed(1)}% / {downName} {((1 - pUp) * 100).toFixed(1)}%)
            </span>{' '}
            <span className="text-xs font-normal text-zinc-500">({distPp >= 0 ? '+' : ''}{distPp.toFixed(1)}pp vs 50/50)</span>
          </div>
          <div className="mt-2 font-mono text-[11px] text-zinc-400">
            mid {upName} {displayPrice(midUp)} · {downName} {displayPrice(midDown)}
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800/50 bg-black/20 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Momentum & speed</div>
          <div className="mt-1 text-xs leading-relaxed text-zinc-300">{momentumNote}</div>
          <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[11px] text-zinc-400">
            <div>Δ/{'~'}25s {upName} {sUp != null ? sUp.toFixed(6) : '—'}</div>
            <div>Δ/{'~'}25s {downName} {sDn != null ? sDn.toFixed(6) : '—'}</div>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800/50 bg-black/20 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Order-flow pressure</div>
          <div className="mt-1 text-xs leading-relaxed text-zinc-300">{pressureNote}</div>
          <div className="mt-2 font-mono text-[11px] text-zinc-400">
            imbalance {imbUp != null ? `${(imbUp * 100).toFixed(0)}%` : '—'} · churn {churnUp != null ? churnUp.toFixed(1) : '—'}
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-zinc-800/50 bg-black/20 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Nearby liquidity (share price)</div>
          <div className="mt-2 grid gap-3 text-[11px] text-zinc-400 sm:grid-cols-2">
            <div className="rounded-lg border border-zinc-800/60 bg-black/15 p-2.5">
              <div className="mb-1 font-mono text-[11px] text-zinc-300">{upName}</div>
              <div className="grid gap-1 font-mono">
                <div>
                  ask wall:{' '}
                  {wallAskUp ? (
                    <span className="text-zinc-200">
                      {displayPrice(wallAskUp.price)} × {wallAskUp.size.toFixed(0)}
                    </span>
                  ) : (
                    '—'
                  )}
                </div>
                <div>
                  bid wall:{' '}
                  {wallBidUp ? (
                    <span className="text-zinc-200">
                      {displayPrice(wallBidUp.price)} × {wallBidUp.size.toFixed(0)}
                    </span>
                  ) : (
                    '—'
                  )}
                </div>
              </div>
            </div>
            <div className="rounded-lg border border-zinc-800/60 bg-black/15 p-2.5">
              <div className="mb-1 font-mono text-[11px] text-zinc-300">{downName}</div>
              <div className="grid gap-1 font-mono">
                <div>
                  ask wall:{' '}
                  {wallAskDn ? (
                    <span className="text-zinc-200">
                      {displayPrice(wallAskDn.price)} × {wallAskDn.size.toFixed(0)}
                    </span>
                  ) : (
                    '—'
                  )}
                </div>
                <div>
                  bid wall:{' '}
                  {wallBidDn ? (
                    <span className="text-zinc-200">
                      {displayPrice(wallBidDn.price)} × {wallBidDn.size.toFixed(0)}
                    </span>
                  ) : (
                    '—'
                  )}
                </div>
              </div>
            </div>
          </div>
          <p className="mt-2 text-[10px] leading-snug text-zinc-600">
            These are walls in the <span className="font-mono">share price</span> ladder, not the underlying BTC/ETH/SOL spot. They’re still
            useful for where orders may get filled or rejected.
          </p>
        </div>

        <div className="rounded-xl border border-zinc-800/50 bg-black/20 p-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Rejection vs breakout (heuristics)</div>
          <ul className="mt-2 list-inside list-disc space-y-1 text-xs leading-relaxed text-zinc-300">
            <li>
              <span className="text-zinc-400">Push</span>: {upName} mid rising + positive imbalance + high churn
            </li>
            <li>
              <span className="text-zinc-400">Fade</span>: mid stalls while imbalance flips negative or churn drops
            </li>
            <li>
              <span className="text-zinc-400">Trap risk</span>: wall appears/disappears quickly (needs tape to confirm; we only see snapshots)
            </li>
          </ul>
          <p className="mt-2 text-[10px] leading-snug text-zinc-600">Informational only — not entry/exit advice.</p>
        </div>
      </div>
    </div>
  );
}

