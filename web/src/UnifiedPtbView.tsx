import { useMemo, useState, type ReactElement } from 'react';
import type { ClobBookEntry } from './lib/api';
import { FlowZonesTab } from './FlowZonesTab';
import { OverallOrderBookPanel } from './OverallOrderBookPanel';
import { PtbOpportunityModeChart } from './PtbOpportunityModeChart';
import { SignalsTradePanel } from './SignalsTradePanel';
import type { SpotPoint } from './SpotLevelChart';
import { underlyingChartTitle } from './underlyingChartTitle';
import { resolveUpDownIndices } from './upDown';
import { anchorPriceScale, buildSpotCandles } from './spotVsPtb';
import { computePtbChartDerivatives } from './ptbChartDerivatives';
import type { BookSnapshot } from './orderflowMetrics';

function fmtUsd(n: number | null, maxFrac = 2): string {
  return n == null || !Number.isFinite(n) ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: maxFrac })}`;
}

function fmtPctSigned(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtUsdSigned(n: number | null, maxFrac = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: maxFrac })}`;
}

function fmtTimeRemaining(endsInMs: number | null | undefined): string {
  if (endsInMs == null || !Number.isFinite(endsInMs)) return '—';
  const totalSec = Math.max(0, Math.floor(endsInMs / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function candleBucketCount(ptsLen: number): number {
  if (ptsLen < 4) return Math.max(2, ptsLen - 1);
  const n = Math.floor(ptsLen * 0.38);
  return Math.min(64, Math.max(16, n));
}

export function UnifiedPtbView(props: {
  market: unknown | null;
  books: ClobBookEntry[] | null;
  outcomeLabels: string[];
  priceToBeat: number | null;
  spot: SpotPoint[];
  spotLastUpdateMs: number | null;
  probUp: SpotPoint[];
  probDown: SpotPoint[];
  probLastUpdateMs: number | null;
  flowSeriesForSlug: Record<string, BookSnapshot[]> | null;
  booksFetchedAt: number | null;
  endsInMs: number | null;
  spotStreamEligible?: boolean;
}): ReactElement {
  const {
    market,
    books,
    outcomeLabels,
    priceToBeat,
    spot,
    spotLastUpdateMs,
    probUp,
    probDown,
    probLastUpdateMs,
    flowSeriesForSlug,
    booksFetchedAt,
    endsInMs,
    spotStreamEligible = false,
  } = props;

  const idx = resolveUpDownIndices(outcomeLabels, market);
  let upLabel = 'UP';
  let downLabel = 'DOWN';
  if (idx && books && books.length >= 2) {
    upLabel = outcomeLabels[idx.up] ?? upLabel;
    downLabel = outcomeLabels[idx.down] ?? downLabel;
  }

  const upEntry = idx && books ? books[idx.up] ?? null : null;
  const downEntry = idx && books ? books[idx.down] ?? null : null;
  const upToken = upEntry?.token ?? '';
  const downToken = downEntry?.token ?? '';
  const [activeBookLane, setActiveBookLane] = useState<'up' | 'down'>('up');
  const [tradeLane, setTradeLane] = useState<'up' | 'down'>('up');
  const [tradeOpen, setTradeOpen] = useState(false);
  const activeBook = activeBookLane === 'up' ? upEntry?.book : downEntry?.book;
  const activeBookLabel = activeBookLane === 'up' ? upLabel : downLabel;
  const tradeEnabled = Boolean(upToken && downToken);

  const upMid = probUp.length ? (probUp[probUp.length - 1]!.v ?? null) : null;
  const downMid = probDown.length ? (probDown[probDown.length - 1]!.v ?? null) : null;

  const derived = useMemo(() => {
    const ptb = priceToBeat;
    if (ptb == null || !Number.isFinite(ptb) || spot.length < 2) return null;
    const pts = spot
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .slice(-320)
      .map((p) => ({ t: p.t, v: p.v }));
    if (pts.length < 2) return null;
    const candles = buildSpotCandles(pts, candleBucketCount(pts.length));
    return computePtbChartDerivatives({ pts, candles, ptb });
  }, [priceToBeat, spot]);

  const activeLane = useMemo<'up' | 'down'>(() => {
    if (!derived) return 'up';
    return derived.distanceUsd >= 0 ? 'up' : 'down';
  }, [derived]);

  const spotLast = spot.length ? spot[spot.length - 1]!.v : null;
  const distUsd = derived?.distanceUsd ?? null;
  const distPct = derived?.distancePct ?? null;

  const band = useMemo(() => {
    const ptb = priceToBeat;
    if (ptb == null || !Number.isFinite(ptb) || spot.length < 2) return null;
    const values = spot.slice(-240).map((p) => p.v);
    const { plotMin, plotMax } = anchorPriceScale({
      level: ptb,
      spotMin: Math.min(...values),
      spotMax: Math.max(...values),
      anchorFrac: 0.5,
    });
    return plotMax - plotMin;
  }, [priceToBeat, spot]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_23rem]">
        <div className="space-y-4">
        <div className="sticky top-2 z-[60]">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-zinc-800/70 bg-[#0b1017]/80 px-3 py-2 shadow-[0_10px_40px_rgba(0,0,0,0.22)] ring-1 ring-white/[0.03] backdrop-blur-xl">
            <div className="min-w-0">
              <div className="truncate text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Spot vs PTB</div>
              <div className="truncate text-[12px] font-semibold text-zinc-200">{underlyingChartTitle(market)}</div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={!tradeEnabled}
                onClick={() => setTradeOpen((v) => !v)}
                className={`min-h-[38px] rounded-xl border px-3 text-[12px] font-black tracking-wide ring-1 ring-white/[0.04] transition-colors ${
                  tradeEnabled
                    ? tradeOpen
                      ? 'border-amber-500/50 bg-amber-500/10 text-amber-100 hover:bg-amber-500/15'
                      : 'border-zinc-700/70 bg-black/20 text-zinc-200 hover:bg-black/30'
                    : 'border-zinc-800/70 bg-black/15 text-zinc-500'
                }`}
                title={tradeEnabled ? (tradeOpen ? 'Close trade' : 'Open trade') : 'Trade unavailable (needs outcome tokens)'}
              >
                Trade
              </button>
            </div>
          </div>

          {tradeOpen ? (
            <div className="mt-2 overflow-hidden rounded-[24px] border border-zinc-800/70 bg-zinc-950/75 shadow-[0_18px_60px_rgba(0,0,0,0.35)] ring-1 ring-white/[0.04] backdrop-blur-xl">
              <div className="flex items-center justify-between gap-2 border-b border-zinc-800/70 bg-black/20 px-3 py-2">
                <div className="text-[11px] font-black uppercase tracking-[0.16em] text-amber-200/90">Trade</div>
                <button
                  type="button"
                  onClick={() => setTradeOpen(false)}
                  className="rounded-xl border border-zinc-800/70 bg-black/15 px-2.5 py-1.5 text-[10px] font-bold text-zinc-300 hover:bg-black/25"
                >
                  Close
                </button>
              </div>
              <div className="max-h-[min(58vh,720px)] overflow-auto p-3">
                {tradeEnabled ? (
                  <SignalsTradePanel
                    upLabel={upLabel}
                    downLabel={downLabel}
                    upToken={upToken}
                    downToken={downToken}
                    upMid={upMid}
                    downMid={downMid}
                    lane={tradeLane}
                    onLaneChange={setTradeLane}
                    visualStyle="sidebar"
                  />
                ) : (
                  <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35 p-4 text-sm text-zinc-500">
                    Load a two-outcome market to enable trading. Your API needs <code className="text-zinc-400">POLYMARKET_PRIVATE_KEY</code> set to place real orders.
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>

        {spot.length < 2 ? (
          <div className="rounded-2xl border border-amber-900/35 bg-amber-950/15 px-4 py-3 text-sm leading-relaxed text-amber-100/90">
            <span className="font-semibold text-amber-50">No candle stream yet.</span>{' '}
            {spotStreamEligible ? (
              <span>RTDS spot should appear within a few seconds — keep this tab open.</span>
            ) : (
              <span>Load a btc/eth/sol up/down market to enable RTDS spot streaming in this view.</span>
            )}
          </div>
        ) : null}

        <PtbOpportunityModeChart
          mode={activeLane}
          spot={spot}
          priceToBeat={priceToBeat}
          lastUpdateMs={spotLastUpdateMs}
          endsInMs={endsInMs}
          chartTitle={underlyingChartTitle(market)}
          upLabel={upLabel}
          downLabel={downLabel}
        />

          <div className="grid gap-4 xl:grid-cols-2">
            <div>
              <div className="mb-2 rounded-xl border border-zinc-800/60 bg-zinc-950/35 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-400">
                Flow Zones
              </div>
            <FlowZonesTab
              market={market}
              books={books}
              outcomeLabels={outcomeLabels}
              flowSeriesForSlug={flowSeriesForSlug}
              booksFetchedAt={booksFetchedAt}
              priceToBeatUsd={priceToBeat}
              endsInMs={endsInMs}
            />
            </div>

            <div>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800/60 bg-zinc-950/35 px-4 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-400">Order Book</div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setActiveBookLane('up')}
                    className={`rounded-lg border px-2.5 py-1 text-[12px] font-semibold transition-colors ${
                      activeBookLane === 'up'
                        ? 'border-emerald-500/50 bg-emerald-950/25 text-emerald-100'
                        : 'border-zinc-800/60 bg-black/10 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {upLabel}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveBookLane('down')}
                    className={`rounded-lg border px-2.5 py-1 text-[12px] font-semibold transition-colors ${
                      activeBookLane === 'down'
                        ? 'border-rose-500/50 bg-rose-950/20 text-rose-100'
                        : 'border-zinc-800/60 bg-black/10 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {downLabel}
                  </button>
                </div>
              </div>

              {activeBook && !(upEntry?.error || downEntry?.error) ? (
                <OverallOrderBookPanel title={`${activeBookLabel} order book`} book={activeBook} lastUpdateMs={booksFetchedAt} maxLevels={12} />
              ) : (
                <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35 p-4 text-sm text-zinc-500">
                  Load a two-outcome UP/DOWN market with books to see the order book.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="xl:sticky xl:top-4">
        <div className="rounded-[28px] border border-zinc-800/70 bg-[#0d1219] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.25)] ring-1 ring-white/[0.03]">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Unified panel</div>
              <div className="mt-1 text-lg font-semibold tracking-tight text-zinc-50">Spot · PTB · Prob</div>
            </div>
            <div className="text-right">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Time remaining</div>
              <div className="mt-1 font-mono text-xl font-semibold text-zinc-100">{fmtTimeRemaining(endsInMs)}</div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-emerald-800/40 bg-emerald-950/20 p-3">
              <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-200/90">{upLabel} (YES)</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-emerald-100">{upMid == null ? '—' : `${Math.round(upMid * 100)}¢`}</div>
              <div className="mt-1 text-[11px] text-emerald-200/70">{probLastUpdateMs ? new Date(probLastUpdateMs).toLocaleTimeString() : '—'}</div>
            </div>
            <div className="rounded-2xl border border-rose-800/40 bg-rose-950/20 p-3">
              <div className="text-[10px] font-bold uppercase tracking-wide text-rose-200/90">{downLabel} (NO)</div>
              <div className="mt-1 font-mono text-2xl font-semibold text-rose-100">{downMid == null ? '—' : `${Math.round(downMid * 100)}¢`}</div>
              <div className="mt-1 text-[11px] text-rose-200/70">{probLastUpdateMs ? new Date(probLastUpdateMs).toLocaleTimeString() : '—'}</div>
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-zinc-800/60 bg-black/20 p-3">
            <div className="grid grid-cols-2 gap-2 text-[12px] text-zinc-300">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Spot</div>
                <div className="mt-0.5 font-mono text-[13px] text-zinc-100">{fmtUsd(spotLast)}</div>
              </div>
              <div className="text-right">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">PTB</div>
                <div className="mt-0.5 font-mono text-[13px] text-amber-200/90">{fmtUsd(priceToBeat)}</div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/35 p-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Distance</div>
                <div className="mt-0.5 font-mono text-[13px] text-zinc-100">
                  {fmtUsdSigned(distUsd)} <span className="text-zinc-500">({fmtPctSigned(distPct)})</span>
                </div>
                <div className="mt-1 text-[11px] text-zinc-500">band {fmtUsd(band, 0)}</div>
              </div>
              <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/35 p-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Status</div>
                <div className="mt-0.5 text-[12px] text-zinc-200">{derived?.controlSignal ?? '—'}</div>
                <div className="mt-1 text-[11px] text-zinc-500">{derived?.controlBlurb ?? '—'}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

