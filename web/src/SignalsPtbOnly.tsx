import { useMemo, useState, type ReactElement } from 'react';
import type { ClobBookEntry } from './lib/api';
import { FlowZoneSignalsPanel } from './FlowZoneSignalsPanel';
import { PtbDualProbabilityChart } from './PtbDualProbabilityChart';
import { PtbOpportunityModeChart } from './PtbOpportunityModeChart';
import { OverallOrderBookPanel } from './OverallOrderBookPanel';
import type { BookSnapshot } from './orderflowMetrics';
import type { SpotPoint } from './SpotLevelChart';
import { SignalsTradePanel } from './SignalsTradePanel';
import { underlyingChartTitle } from './underlyingChartTitle';
import { STREAM_ATTRIBUTION_LINE } from './streamAttribution';
import { midPrice, topOfBook } from './bookLevels';
import { resolveUpDownIndices } from './upDown';
import { buildSpotCandles } from './spotVsPtb';
import { computePtbChartDerivatives } from './ptbChartDerivatives';

/**
 * Signals tab: dual implied-probability OHLC when book mids exist; else USD spot vs PTB.
 */
export function SignalsPtbOnly(props: {
  market: unknown | null;
  books: ClobBookEntry[] | null;
  outcomeLabels: string[];
  priceToBeat: number | null;
  spot: SpotPoint[];
  spotLastUpdateMs: number | null;
  probUp: SpotPoint[];
  probDown: SpotPoint[];
  probLastUpdateMs: number | null;
  /** Per-outcome book snapshots for flow-zone strip (same as Book tab / Flow Zones). */
  flowSeriesForSlug: Record<string, BookSnapshot[]> | null;
  endsInMs: number | null;
  booksFetchedAt: number | null;
  /** True when slug matches BTC/ETH/SOL Up/Down (RTDS underlying stream in App). */
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
    endsInMs,
    booksFetchedAt,
    spotStreamEligible = false,
  } = props;

  const idx = resolveUpDownIndices(outcomeLabels, market);
  let bookAbove: unknown = {};
  let bookBelow: unknown = {};
  let upLabel = 'YES';
  let downLabel = 'NO';
  if (idx && books && books.length >= 2) {
    const up = books[idx.up];
    const down = books[idx.down];
    if (up && down && !up.error && !down.error) {
      bookAbove = up.book;
      bookBelow = down.book;
      upLabel = outcomeLabels[idx.up] ?? upLabel;
      downLabel = outcomeLabels[idx.down] ?? downLabel;
    }
  }
  const upToken = idx && books ? (books[idx.up]?.token ?? '') : '';
  const downToken = idx && books ? (books[idx.down]?.token ?? '') : '';

  const hasDual = probUp.length >= 1 && probDown.length >= 1;
  const [spotChartLane, setSpotChartLane] = useState<'up' | 'down'>('up');
  const spotChartLive = priceToBeat != null && spot.length >= 2;
  const [chartTab, setChartTab] = useState<'spot' | 'dual'>(() => (hasDual ? 'spot' : 'spot'));

  const ptbContext = useMemo(() => {
    if (priceToBeat == null || !Number.isFinite(priceToBeat) || spot.length < 2) return null;
    const pts = spot
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .slice(-320)
      .map((p) => ({ t: p.t, v: p.v }));
    if (pts.length < 2) return null;
    const candles = buildSpotCandles(pts, Math.min(64, Math.max(12, Math.floor(pts.length * 0.22))));
    const d = computePtbChartDerivatives({ pts, candles, ptb: priceToBeat });
    return {
      ptbUsd: priceToBeat,
      bandUsd: d.reaction.eps,
      position: d.position,
      distanceUsd: d.distanceUsd,
      dwellAboveRatio: d.dwellAboveRatio,
      momentum: d.momentum,
      momentumStreak: d.momentumStreak,
      structureEvent: d.structureEvent,
      structureEventLabel: d.structureEventLabel,
      controlSignal: d.controlSignal,
      controlBlurb: d.controlBlurb,
      slopeUsdPerSec: d.slopeUsdPerSec,
      slopeUsdPerMin: d.slopeUsdPerMin,
    } as const;
  }, [priceToBeat, spot]);

  const earlySetup = useMemo(() => {
    if (!ptbContext) return null;
    const eps = Math.max(0.35, ptbContext.bandUsd);
    const dist = ptbContext.distanceUsd;
    const slope = ptbContext.slopeUsdPerMin;
    const dwell = ptbContext.dwellAboveRatio;
    const regime = ptbContext.structureEvent;
    const chop = regime === 'chop' || ptbContext.controlSignal === 'NO_EDGE';
    if (chop) return { state: 'WAIT' as const, lane: null as 'up' | 'down' | null, why: 'Chop / no-edge' };

    // “Before momentum”: looking for early separation + slope, but not yet a full break-and-hold.
    const isEarlyRegime = regime === 'probe' || regime === 'hover' || regime === 'extension';
    const nearLine = Math.abs(dist) <= eps * 1.2;
    const slopeOk = Math.abs(slope) >= 1.6; // $/min; conservative

    // Pre-arm conditions: early regime + slope + near line (setup forming).
    const preArmUp = isEarlyRegime && nearLine && slopeOk && slope > 0.9 && dwell >= 0.52;
    const preArmDown = isEarlyRegime && nearLine && slopeOk && slope < -0.9 && dwell <= 0.48;

    // “Enter correctly”: require a cleaner regime (break/hold or strong extension) + slope.
    const enterUp =
      (ptbContext.controlSignal === 'UP_CONTROL' || regime === 'break_and_hold') && slope > 1.2 && dwell >= 0.55;
    const enterDown =
      (ptbContext.controlSignal === 'DOWN_CONTROL' || regime === 'break_and_hold') && slope < -1.2 && dwell <= 0.45;

    if (enterUp) return { state: 'ENTER' as const, lane: 'up' as const, why: 'Control + slope + dwell' };
    if (enterDown) return { state: 'ENTER' as const, lane: 'down' as const, why: 'Control + slope + dwell' };
    if (preArmUp) return { state: 'SETUP' as const, lane: 'up' as const, why: 'Early separation forming' };
    if (preArmDown) return { state: 'SETUP' as const, lane: 'down' as const, why: 'Early separation forming' };
    return { state: 'WAIT' as const, lane: null as 'up' | 'down' | null, why: 'Not enough confirmation yet' };
  }, [ptbContext]);

  const ptbSignalCard = ptbContext ? (
    <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">PTB signal</div>
        <div
          className={`rounded-lg border px-2 py-1 text-[11px] font-semibold ${
            ptbContext.structureEvent === 'chop' || ptbContext.controlSignal === 'NO_EDGE'
              ? 'border-zinc-700/70 bg-zinc-900/30 text-zinc-200'
              : ptbContext.controlSignal === 'UP_CONTROL'
                ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-100'
                : ptbContext.controlSignal === 'DOWN_CONTROL'
                  ? 'border-rose-500/40 bg-rose-950/25 text-rose-100'
                  : 'border-amber-500/30 bg-amber-950/20 text-amber-100'
          }`}
          title={ptbContext.controlBlurb}
        >
          {ptbContext.controlSignal.replaceAll('_', ' ')}
        </div>
      </div>
      {earlySetup ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Entry readiness</div>
          <div
            className={`rounded-lg border px-2 py-1 text-[11px] font-bold ${
              earlySetup.state === 'ENTER'
                ? earlySetup.lane === 'up'
                  ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-100'
                  : 'border-rose-500/40 bg-rose-950/25 text-rose-100'
                : earlySetup.state === 'SETUP'
                  ? 'border-amber-500/35 bg-amber-950/20 text-amber-100'
                  : 'border-zinc-700/70 bg-zinc-900/30 text-zinc-200'
            }`}
            title={earlySetup.why}
          >
            {earlySetup.state}
            {earlySetup.lane ? ` · ${earlySetup.lane === 'up' ? upLabel : downLabel}` : ''}
          </div>
        </div>
      ) : null}
      <div className="mt-2 grid gap-2 md:grid-cols-3">
        <div className="rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Regime</div>
          <div className="mt-0.5 text-sm font-semibold text-zinc-200">{ptbContext.structureEventLabel}</div>
        </div>
        <div className="rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Spot vs PTB</div>
          <div className="mt-0.5 text-sm font-semibold text-zinc-200">
            {ptbContext.position} · band ±${ptbContext.bandUsd.toFixed(2)}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Slope</div>
          <div className="mt-0.5 text-sm font-semibold text-zinc-200">
            {ptbContext.slopeUsdPerMin >= 0 ? '+' : ''}
            {ptbContext.slopeUsdPerMin.toFixed(2)} $/min
          </div>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
        {ptbContext.structureEvent === 'chop' || ptbContext.controlSignal === 'NO_EDGE'
          ? 'Default: WAIT. This is chop / no-edge — if you trade anyway, size down and use hard limits.'
          : ptbContext.controlSignal === 'UP_CONTROL'
            ? `Bias: ${upLabel}. Prefer entries that hold above the band; avoid chasing if it snaps back into chop.`
            : ptbContext.controlSignal === 'DOWN_CONTROL'
              ? `Bias: ${downLabel}. Prefer entries that hold below the band; avoid chasing if it snaps back into chop.`
              : 'Mixed control (rejection/transition). Treat as conditional: wait for confirmation from the book / flow.'}
      </p>
    </div>
  ) : null;

  const ptbContextForTrade = useMemo(() => {
    if (!ptbContext) return null;
    return {
      ...ptbContext,
      readinessState: earlySetup?.state ?? 'WAIT',
      readinessLane: earlySetup?.lane ?? null,
      readinessWhy: earlySetup?.why ?? null,
    } as const;
  }, [earlySetup, ptbContext]);

  const spotVsPtbSection = (
    <>
      <div className="space-y-1 rounded-xl border border-zinc-800/60 bg-zinc-950/35 px-4 py-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-400">Spot vs PTB (USD · fixed line)</div>
        <p className="text-[10px] leading-relaxed text-zinc-500">
          Same rules as the big chart: <span className="text-zinc-400">higher $ draws toward the top</span>; yellow PTB;
          green/red wash is <span className="text-zinc-400">above/below that line</span>, not “price good/bad”. Momentum
          badges are <span className="text-zinc-400">short-bucket candle trend</span> and can disagree with spot vs PTB on a
          pullback. Only the last <span className="font-mono text-zinc-400">1m–5m</span> of ticks are shown.
        </p>
      </div>
      <PtbOpportunityModeChart
        mode={spotChartLane}
        spot={spot}
        priceToBeat={priceToBeat}
        lastUpdateMs={spotLastUpdateMs}
        endsInMs={endsInMs}
        chartTitle={underlyingChartTitle(market)}
        upLabel={upLabel}
        downLabel={downLabel}
      />
      {ptbSignalCard}
      {spotChartLive ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSpotChartLane('up')}
            className={`rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${
              spotChartLane === 'up'
                ? 'border-emerald-500/60 bg-emerald-950/35 text-emerald-100'
                : 'border-zinc-800/70 bg-zinc-950/30 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {upLabel} view
          </button>
          <button
            type="button"
            onClick={() => setSpotChartLane('down')}
            className={`rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${
              spotChartLane === 'down'
                ? 'border-rose-500/60 bg-rose-950/30 text-rose-100'
                : 'border-zinc-800/70 bg-zinc-950/30 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {downLabel} view
          </button>
          <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/35 px-3 py-2 text-[11px] leading-snug text-zinc-500">
            {STREAM_ATTRIBUTION_LINE}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/35 px-3 py-2 text-xs leading-relaxed text-zinc-500">
          {priceToBeat == null ? (
            <>SSR price-to-beat missing — chart frame shows above without the yellow anchor.</>
          ) : spotStreamEligible ? (
            <>LINE / OHLC need a second RTDS tick (a few seconds on this slug).</>
          ) : (
            <>
              For live candles, open <span className="font-mono text-zinc-400">btc|eth|sol-updown-*</span> — other markets keep the PTB line only
              until spot is wired.
            </>
          )}
        </div>
      )}
    </>
  );

  const body = hasDual ? (
    <div className="space-y-3">
      <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Chart</div>
          <div className="flex gap-1 rounded-xl border border-zinc-800/60 bg-black/20 p-1">
            <button
              type="button"
              onClick={() => setChartTab('spot')}
              className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold ${
                chartTab === 'spot' ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Spot vs PTB
            </button>
            <button
              type="button"
              onClick={() => setChartTab('dual')}
              className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold ${
                chartTab === 'dual' ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Dual PTB
            </button>
          </div>
        </div>

        <div className="mt-3">
          {chartTab === 'spot' ? (
            spotVsPtbSection
          ) : (
            <PtbDualProbabilityChart
              probUp={probUp}
              probDown={probDown}
              upLabel={upLabel}
              downLabel={downLabel}
              lastUpdateMs={probLastUpdateMs}
              priceToBeatUsd={priceToBeat}
              bookUp={bookAbove}
              bookDown={bookBelow}
              enginePlacement="below"
            />
          )}
        </div>
      </div>

      <details className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35" open={false}>
        <summary className="cursor-pointer select-none px-4 py-3 text-[11px] font-semibold text-zinc-400 hover:text-zinc-200 [&::-webkit-details-marker]:hidden">
          <span className="mr-1 text-zinc-600" aria-hidden>
            ▸
          </span>
          Signals + flow zones
        </summary>
        <div className="border-t border-zinc-800/50 p-3">
          <FlowZoneSignalsPanel
            market={market}
            books={books}
            outcomeLabels={outcomeLabels}
            flowSeriesForSlug={flowSeriesForSlug}
            priceToBeatUsd={priceToBeat}
            endsInMs={endsInMs}
            booksFetchedAt={booksFetchedAt}
          />
        </div>
      </details>
      {upToken && downToken ? (
        <SignalsTradePanel
          upLabel={upLabel}
          downLabel={downLabel}
          upToken={upToken}
          downToken={downToken}
          upMid={probUp.length ? (probUp[probUp.length - 1]!.v ?? null) : null}
          downMid={probDown.length ? (probDown[probDown.length - 1]!.v ?? null) : null}
          bookMidUp={midPrice(bookAbove)}
          bookMidDown={midPrice(bookBelow)}
          bookTouchUp={topOfBook(bookAbove)}
          bookTouchDown={topOfBook(bookBelow)}
          bookUp={bookAbove}
          bookDown={bookBelow}
          ptbContext={ptbContextForTrade}
        />
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        <OverallOrderBookPanel title={`${upLabel} book`} book={bookAbove} lastUpdateMs={probLastUpdateMs} />
        <OverallOrderBookPanel title={`${downLabel} book`} book={bookBelow} lastUpdateMs={probLastUpdateMs} />
      </div>
    </div>
  ) : priceToBeat == null || spot.length < 2 ? (
    <div className="space-y-3">
      {books && books.length >= 2 ? (
        <FlowZoneSignalsPanel
          market={market}
          books={books}
          outcomeLabels={outcomeLabels}
          flowSeriesForSlug={flowSeriesForSlug}
          priceToBeatUsd={priceToBeat}
          endsInMs={endsInMs}
          booksFetchedAt={booksFetchedAt}
        />
      ) : null}
      <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/50 p-6 text-center text-sm text-zinc-400">
        <p>
          For the <span className="text-zinc-200">dual belief</span> chart, turn on book polling on the <span className="text-zinc-200">Book</span>{' '}
          tab until both outcomes have mid history.
        </p>
        <p className="mt-2">
          For <span className="text-zinc-200">USD spot vs PTB</span>, load SSR price-to-beat and a{' '}
              <span className="font-mono text-zinc-300">btc|eth|sol-updown-*</span> slug so RTDS ticks fill (see note when mids exist).
        </p>
      </div>
      {spotVsPtbSection}
    </div>
  ) : (
    <div className="space-y-3">
      <FlowZoneSignalsPanel
        market={market}
        books={books}
        outcomeLabels={outcomeLabels}
        flowSeriesForSlug={flowSeriesForSlug}
        priceToBeatUsd={priceToBeat}
        endsInMs={endsInMs}
        booksFetchedAt={booksFetchedAt}
      />
      {spotVsPtbSection}
    </div>
  );

  return (
    <>
      {body}
    </>
  );
}
