import { useMemo, useState, type ReactElement } from 'react';
import type { ClobBookEntry } from './lib/api';
import { FlowZonesTab } from './FlowZonesTab';
import { OverallOrderBookPanel } from './OverallOrderBookPanel';
import { PtbOpportunityModeChart } from './PtbOpportunityModeChart';
import type { SpotPoint } from './SpotLevelChart';
import { underlyingChartTitle } from './underlyingChartTitle';
import { resolveUpDownIndices } from './upDown';
import { anchorPriceScale, buildSpotCandles } from './spotVsPtb';
import { computePtbChartDerivatives, type PtbChartDerivatives } from './ptbChartDerivatives';
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

function fmtUsdShort(n: number | null, maxFrac = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

function candleBucketCount(ptsLen: number): number {
  if (ptsLen < 4) return Math.max(2, ptsLen - 1);
  const n = Math.floor(ptsLen * 0.38);
  return Math.min(64, Math.max(16, n));
}

/** Separates venue facts from modeled / crowd signals so the UI reads less like fortune-telling. */
function buildGuessworkReadout(params: {
  ptb: number | null;
  spotLast: number | null;
  derived: PtbChartDerivatives | null;
  endsInMs: number | null;
  activeLane: 'up' | 'down';
  laneLabel: string;
  upLabel: string;
  downLabel: string;
  upMid: number | null;
  downMid: number | null;
}): { facts: string[]; models: string[]; play: string } | null {
  const { ptb, spotLast, derived, endsInMs, activeLane, laneLabel, upLabel, downLabel, upMid, downMid } = params;
  if (ptb == null || !Number.isFinite(ptb) || spotLast == null || !Number.isFinite(spotLast)) return null;
  const side = spotLast >= ptb ? 'above' : 'below';
  const facts: string[] = [
    `PTB (venue line): ${fmtUsd(ptb)}`,
    `Last underlying spot: ${fmtUsd(spotLast)} — ${side} PTB`,
  ];
  if (endsInMs != null && Number.isFinite(endsInMs)) {
    facts.push(`Time to round end (venue clock): ${fmtTimeRemaining(endsInMs)}`);
  }
  if (derived) {
    facts.push(
      `Engine: spot ${derived.position} vs band · control ${derived.controlSignal.replaceAll('_', ' ')} · slope ${derived.slopeUsdPerMin >= 0 ? '+' : ''}${derived.slopeUsdPerMin.toFixed(3)} $/min (${derived.slopeSampleCount} samples)`,
    );
  }
  const models: string[] = [
    'Settlement % and “cross soon” on the chart are a small normal model (drift + tick vol + chop penalty) — not the market oracle.',
    `You are viewing the ${laneLabel} lane (${activeLane.toUpperCase()}). It does not replace checking bid/ask for your actual fill.`,
  ];
  if (upMid != null && downMid != null && Number.isFinite(upMid) && Number.isFinite(downMid)) {
    models.push(
      `Implied mids: ${upLabel} ${(upMid * 100).toFixed(0)}¢ · ${downLabel} ${(downMid * 100).toFixed(0)}¢ — mid of the book, not guaranteed execution.`,
    );
  }
  let play =
    'Mechanical habit: if control is NO EDGE or structure is chop, assume you are missing information — default to smaller size or wait for a clean break/hold.';
  if (!derived) {
    play = 'Need a few more spot ticks before the engine labels control — avoid sizing on the chart alone.';
  } else if (derived.controlSignal === 'NO_EDGE' || derived.structureEvent === 'chop' || derived.reaction.kind === 'choppy_at_line') {
    play =
      'Tape says chop / no edge — feeling like you are guessing is correct. Prefer: wait, tighten risk, or trade only with hard limits you would accept if wrong.';
  } else if (derived.controlSignal === 'UP_CONTROL' || derived.controlSignal === 'DOWN_CONTROL') {
    const t = endsInMs != null && Number.isFinite(endsInMs) ? fmtTimeRemaining(endsInMs) : '—';
    play = `Tape leans ${derived.controlSignal.replaceAll('_', ' ')} — use it as context, then decide only from prices you can actually hit on the CLOB and time left (${t}).`;
  } else if (derived.controlSignal === 'REJECTION' || derived.controlSignal === 'TRANSITION') {
    play = 'Rotation or rejection in play — treat probabilities as extra context, not conviction; confirm with book flow and invalidation levels.';
  }
  return { facts, models, play };
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
  uiVariant?: 'default' | 'polymarket';
  rightPanel?: ReactElement | null;
  ptbSource?: string | null;
  spotFeedSource?: string | null;
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
    uiVariant = 'default',
    rightPanel = null,
    ptbSource = null,
    spotFeedSource = null,
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
  const [activeBookLane, setActiveBookLane] = useState<'up' | 'down'>('up');
  const activeBook = activeBookLane === 'up' ? upEntry?.book : downEntry?.book;
  const activeBookLabel = activeBookLane === 'up' ? upLabel : downLabel;

  const upMid = probUp.length ? (probUp[probUp.length - 1]!.v ?? null) : null;
  const downMid = probDown.length ? (probDown[probDown.length - 1]!.v ?? null) : null;

  const derivedBase = useMemo(() => {
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
    if (!derivedBase) return 'up';
    return derivedBase.distanceUsd >= 0 ? 'up' : 'down';
  }, [derivedBase]);

  /** Outcome-token book-flow series for the same lane as Spot vs PTB (UP/DOWN). */
  const bookFlowForChart = useMemo(() => {
    if (!flowSeriesForSlug || !idx || !books || books.length < 2) return null;
    const token = activeLane === 'up' ? books[idx.up]?.token : books[idx.down]?.token;
    if (!token) return null;
    return flowSeriesForSlug[token] ?? null;
  }, [flowSeriesForSlug, idx, activeLane, books]);

  const derived = useMemo(() => {
    const ptb = priceToBeat;
    if (ptb == null || !Number.isFinite(ptb) || spot.length < 2) return null;
    const pts = spot
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .slice(-320)
      .map((p) => ({ t: p.t, v: p.v }));
    if (pts.length < 2) return null;
    const candles = buildSpotCandles(pts, candleBucketCount(pts.length));
    return computePtbChartDerivatives({ pts, candles, ptb, bookFlow: bookFlowForChart ?? undefined });
  }, [priceToBeat, spot, bookFlowForChart]);

  const spotLast = spot.length ? spot[spot.length - 1]!.v : null;
  const spotPrev = spot.length >= 2 ? spot[spot.length - 2]!.v : null;
  const spotDelta = spotLast != null && spotPrev != null ? spotLast - spotPrev : null;
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

  const laneLabel = activeLane === 'up' ? upLabel : downLabel;
  const guessworkReadout = useMemo(
    () =>
      buildGuessworkReadout({
        ptb: priceToBeat,
        spotLast,
        derived,
        endsInMs,
        activeLane,
        laneLabel,
        upLabel,
        downLabel,
        upMid,
        downMid,
      }),
    [priceToBeat, spotLast, derived, endsInMs, activeLane, laneLabel, upLabel, downLabel, upMid, downMid],
  );

  const marketDetails = useMemo(() => {
    if (!market || typeof market !== 'object') return null;
    const m = market as Record<string, unknown>;
    const conditionId = (m.conditionId ?? m.condition_id ?? m.condition_id_hex ?? m.id) as unknown;
    const status = (m.status ?? m.active ?? m.state ?? '') as unknown;
    const outcomes = outcomeLabels.length ? outcomeLabels : [];
    return {
      conditionId: conditionId != null ? String(conditionId) : null,
      status: status != null ? String(status) : null,
      outcomes,
    };
  }, [market, outcomeLabels]);

  if (uiVariant === 'polymarket') {
    return (
      <div className="space-y-4">
        <div className="sticky top-2 z-[60]">
          <div className="grid gap-3 rounded-3xl border border-zinc-800/60 bg-[#0b1017]/70 p-4 shadow-[0_18px_70px_rgba(0,0,0,0.35)] ring-1 ring-white/[0.03] backdrop-blur-xl sm:grid-cols-3">
            <div className="rounded-2xl border border-zinc-800/50 bg-black/20 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Price to beat</div>
              <div className="mt-1 text-2xl font-semibold tracking-tight text-zinc-50">
                {priceToBeat == null ? '—' : `$${fmtUsdShort(priceToBeat, 2)}`}
              </div>
              <div className="mt-1 text-[11px] text-zinc-500">{underlyingChartTitle(market)}</div>
            </div>
            <div className="rounded-2xl border border-zinc-800/50 bg-black/20 p-4 text-center">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Time left</div>
              <div className="mt-1 font-mono text-3xl font-semibold tracking-tight text-zinc-50">{fmtTimeRemaining(endsInMs)}</div>
              <div className="mt-1 text-[11px] text-zinc-600">Interval clock</div>
            </div>
            <div className="rounded-2xl border border-zinc-800/50 bg-black/20 p-4 text-right">
              <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Spot price</div>
              <div className="mt-1 text-2xl font-semibold tracking-tight text-zinc-50">
                {spotLast == null ? '—' : `$${fmtUsdShort(spotLast, 2)}`}
              </div>
              <div className="mt-1 text-[11px] text-zinc-500">
                {spotDelta == null ? '—' : `${spotDelta >= 0 ? '+' : ''}${spotDelta.toFixed(2)}`}
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.8fr)_24rem] xl:items-start">
          <div className="space-y-4">
            <div className="rounded-[28px] border border-zinc-800/60 bg-[#0d1219] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.25)] ring-1 ring-white/[0.03]">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/50 pb-3">
                <div className="flex items-center gap-2">
                  <div className="rounded-lg border border-zinc-700/60 bg-black/25 p-1">
                    <button
                      type="button"
                      className="rounded-md bg-emerald-500/15 px-3 py-1 text-[11px] font-semibold text-emerald-200"
                      title="Chart mode"
                    >
                      BTC Price
                    </button>
                  </div>
                  <div className="text-[11px] font-semibold text-zinc-500">{underlyingChartTitle(market)}</div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="rounded-lg border border-zinc-700/60 bg-black/25 p-1">
                    <button type="button" className="rounded-md bg-zinc-900/40 px-3 py-1 text-[11px] font-semibold text-zinc-200">
                      LINE
                    </button>
                    <button type="button" className="rounded-md px-3 py-1 text-[11px] font-semibold text-zinc-500">
                      OHLC
                    </button>
                  </div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-emerald-600/30 bg-emerald-950/25 px-3 py-1 text-[11px] font-semibold text-emerald-100">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    LIVE
                  </div>
                </div>
              </div>

              <div className="mt-4">
                <PtbOpportunityModeChart
                  mode={activeLane}
                  spot={spot}
                  priceToBeat={priceToBeat}
                  lastUpdateMs={spotLastUpdateMs}
                  endsInMs={endsInMs}
                  chartTitle={underlyingChartTitle(market)}
                  upLabel={upLabel}
                  downLabel={downLabel}
                  lastProbUp={upMid}
                  lastProbDown={downMid}
                  bookFlow={bookFlowForChart}
                  ptbSource={ptbSource}
                  spotFeedSource={spotFeedSource}
                />
              </div>
            </div>

            <div className="rounded-[28px] border border-zinc-800/60 bg-[#0d1219] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.25)] ring-1 ring-white/[0.03]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/50 pb-3">
                <div className="text-[12px] font-semibold text-zinc-100">Order Book</div>
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

              <div className="mt-4">
                {activeBook && !(upEntry?.error || downEntry?.error) ? (
                  <OverallOrderBookPanel
                    title={`${activeBookLabel} order book`}
                    book={activeBook}
                    lastUpdateMs={booksFetchedAt}
                    maxLevels={14}
                    prefillLane={activeBookLane}
                  />
                ) : (
                  <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35 p-4 text-sm text-zinc-500">
                    Load a two-outcome UP/DOWN market with books to see the order book.
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-[28px] border border-zinc-800/60 bg-[#0d1219] p-4 shadow-[0_18px_60px_rgba(0,0,0,0.25)] ring-1 ring-white/[0.03]">
              <div className="border-b border-zinc-800/50 pb-3">
                <div className="text-[12px] font-semibold text-zinc-100">Market Details</div>
              </div>
              <div className="mt-4 space-y-2 text-[12px] text-zinc-300">
                <div className="flex items-start justify-between gap-4">
                  <span className="text-zinc-500">Condition ID</span>
                  <span className="max-w-[70%] break-all text-right font-mono text-[11px] text-zinc-300">
                    {marketDetails?.conditionId ?? '—'}
                  </span>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <span className="text-zinc-500">Status</span>
                  <span className="text-right">{marketDetails?.status ?? '—'}</span>
                </div>
                <div className="flex items-start justify-between gap-4">
                  <span className="text-zinc-500">Outcomes</span>
                  <span className="text-right">{marketDetails?.outcomes?.length ? marketDetails.outcomes.join(' / ') : '—'}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="xl:sticky xl:top-4">{rightPanel}</div>
        </div>
      </div>
    );
  }

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
            </div>
          </div>

        {spot.length < 2 ? (
          <div className="rounded-2xl border border-amber-900/35 bg-amber-950/15 px-4 py-3 text-sm leading-relaxed text-amber-100/90">
            <span className="font-semibold text-amber-50">Spot history is still warming up.</span>{' '}
            {spotStreamEligible ? (
              <span>RTDS ticks usually land within a few seconds on an active tab; the chart unlocks after two ticks.</span>
            ) : (
              <span>
                Open a <span className="font-mono text-amber-50/95">btc|eth|sol-updown-5m-*</span> or{' '}
                <span className="font-mono text-amber-50/95">*-updown-15m-*</span> slug so this view can subscribe to underlying spot.
              </span>
            )}
          </div>
        ) : null}

        {guessworkReadout ? (
          <div className="rounded-2xl border border-sky-900/45 bg-sky-950/20 px-4 py-3 ring-1 ring-sky-500/10">
            <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-sky-200/90">Know vs guess</div>
            <p className="mt-1.5 text-[11px] leading-snug text-sky-100/70">
              Use the bullets on the left as <span className="font-semibold text-sky-50">facts</span>; the right column is{' '}
              <span className="font-semibold text-sky-100/90">models + crowd</span> — useful, not prophetic.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-200/80">Observable</div>
                <ul className="mt-1.5 list-inside list-disc space-y-1 text-[11px] leading-snug text-zinc-200/95">
                  {guessworkReadout.facts.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-200/80">Still uncertain</div>
                <ul className="mt-1.5 list-inside list-disc space-y-1 text-[11px] leading-snug text-zinc-300/95">
                  {guessworkReadout.models.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="mt-3 rounded-xl border border-sky-800/40 bg-black/25 px-3 py-2 text-[11px] leading-relaxed text-sky-50/95">
              <span className="font-semibold text-sky-200">How to use this:</span> {guessworkReadout.play}
            </div>
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
          lastProbUp={upMid}
          lastProbDown={downMid}
          bookFlow={bookFlowForChart}
          ptbSource={ptbSource}
          spotFeedSource={spotFeedSource}
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
        {rightPanel ? (
          rightPanel
        ) : (
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
                  {spotLastUpdateMs ? (
                    <div className="mt-0.5 font-mono text-[10px] text-zinc-600">
                      RTDS {new Date(spotLastUpdateMs).toLocaleTimeString()}
                    </div>
                  ) : null}
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
        )}
      </div>
    </div>
  );
}

