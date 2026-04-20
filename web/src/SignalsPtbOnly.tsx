import type { ReactElement } from 'react';
import type { ClobBookEntry } from './lib/api';
import { FlowZoneSignalsPanel } from './FlowZoneSignalsPanel';
import { PtbCenteredGapReactionChart } from './PtbCenteredGapReactionChart';
import { PtbDualProbabilityChart } from './PtbDualProbabilityChart';
import { OverallOrderBookPanel } from './OverallOrderBookPanel';
import type { BookSnapshot } from './orderflowMetrics';
import type { SpotPoint } from './SpotLevelChart';
import { SignalsTradePanel } from './SignalsTradePanel';
import { underlyingChartTitle } from './underlyingChartTitle';
import { resolveUpDownIndices } from './upDown';

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

  const body = hasDual ? (
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
      <PtbDualProbabilityChart
        probUp={probUp}
        probDown={probDown}
        upLabel={upLabel}
        downLabel={downLabel}
        lastUpdateMs={probLastUpdateMs}
        priceToBeatUsd={priceToBeat}
        bookUp={bookAbove}
        bookDown={bookBelow}
      />
      {upToken && downToken ? (
        <SignalsTradePanel
          upLabel={upLabel}
          downLabel={downLabel}
          upToken={upToken}
          downToken={downToken}
          upMid={probUp.length ? (probUp[probUp.length - 1]!.v ?? null) : null}
          downMid={probDown.length ? (probDown[probDown.length - 1]!.v ?? null) : null}
        />
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        <OverallOrderBookPanel title={`${upLabel} book`} book={bookAbove} lastUpdateMs={probLastUpdateMs} />
        <OverallOrderBookPanel title={`${downLabel} book`} book={bookBelow} lastUpdateMs={probLastUpdateMs} />
      </div>
    </div>
  ) : priceToBeat == null || spot.length < 2 ? (
    <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/50 p-6 text-center text-sm text-zinc-400">
      <p>
        For the <span className="text-zinc-200">dual belief</span> chart, turn on book polling on the <span className="text-zinc-200">Book</span>{' '}
        tab until both outcomes have mid history.
      </p>
      <p className="mt-2">
        Or wait for SSR <span className="text-zinc-200">price to beat</span> and RTDS <span className="text-zinc-200">spot</span> for the USD PTB
        chart fallback.
      </p>
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
      <PtbCenteredGapReactionChart
        spot={spot}
        priceToBeat={priceToBeat}
        lastUpdateMs={spotLastUpdateMs}
        bookAbove={bookAbove}
        bookBelow={bookBelow}
        chartTitle={underlyingChartTitle(market)}
        aboveLabel={upLabel}
        belowLabel={downLabel}
      />
    </div>
  );

  return (
    <>
      {body}
    </>
  );
}
