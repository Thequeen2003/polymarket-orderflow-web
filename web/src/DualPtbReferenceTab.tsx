import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ClobBookEntry } from './lib/api';
import { OverallOrderBookPanel } from './OverallOrderBookPanel';
import { PtbOpportunityModeChart } from './PtbOpportunityModeChart';
import { SignalsTradePanel } from './SignalsTradePanel';
import { pickMarketSlug } from './gammaMarketSlug';
import { pickConditionId } from './bookIntel';
import { useRecentTapePrints } from './useRecentTapePrints';
import type { SpotPoint } from './SpotLevelChart';
import { STREAM_ATTRIBUTION_LINE } from './streamAttribution';
import { underlyingChartTitle } from './underlyingChartTitle';
import { midPrice, topOfBook } from './bookLevels';
import { resolveUpDownIndices } from './upDown';
import { MachineVerdictCard } from './MachineVerdictCard';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import { TradeDirectiveCard } from './TradeDirectiveCard';
import type { TradeDirective } from './tradeDirective';
import { resolveTradeLevelsForDirective } from './tradeLevels';
import { updateStability, type DirectiveStability } from './directiveStability';
import { detectDirectiveDiscrepancy } from './directiveDiscrepancyGuard';
import {
  updateReEntryState,
  checkReEntry,
  type ReEntryState,
} from './reEntryGuard';
import { computeSizingMultiplier } from './directiveSizingMultiplier';
import {
  appendDirectiveToJournal,
  resetJournal,
  type DirectiveJournal,
} from './directiveJournal';

function fmtUsd(n: number | null): string {
  return n == null || !Number.isFinite(n) ? '—' : `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function DualPtbReferenceTab(props: {
  /** Active market slug — forwarded to the chart so SECTIONAL_DECISION_EVENT toasts can filter by slug. */
  slug?: string | null;
  market: unknown | null;
  books: ClobBookEntry[] | null;
  outcomeLabels: string[];
  priceToBeat: number | null;
  spot: SpotPoint[];
  spotLastUpdateMs: number | null;
  probUp: SpotPoint[];
  probDown: SpotPoint[];
  probLastUpdateMs: number | null;
  endsInMs: number | null;
  /** Slug matches BTC/ETH/SOL Up/Down — App streams Polymarket RTDS underlying. */
  spotStreamEligible?: boolean;
}): ReactElement {
  const {
    slug = null,
    market,
    books,
    outcomeLabels,
    priceToBeat,
    spot,
    spotLastUpdateMs,
    probUp,
    probDown,
    probLastUpdateMs,
    endsInMs,
    spotStreamEligible = false,
  } = props;

  const idx = resolveUpDownIndices(outcomeLabels, market);
  let bookAbove: unknown = {};
  let bookBelow: unknown = {};
  let upLabel = 'UP';
  let downLabel = 'DOWN';
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
  const [activeLane, setActiveLane] = useState<'up' | 'down'>('up');
  // Live trade prints for the active lane — drives tape velocity + No-Trade tier.
  const conditionId = useMemo(() => pickConditionId(market), [market]);
  const tapeTokenId = activeLane === 'up' ? upToken : downToken;
  const tapePrints = useRecentTapePrints({ conditionId, activeTokenId: tapeTokenId });
  const [machineVerdict, setMachineVerdict] = useState<SpotPtbMachineReadout | null>(null);
  const onMachineVerdict = useCallback((r: SpotPtbMachineReadout | null) => {
    setMachineVerdict(r);
  }, []);
  const [tradeDirective, setTradeDirective] = useState<TradeDirective | null>(null);
  const onTradeDirective = useCallback((d: TradeDirective | null) => {
    setTradeDirective(d);
  }, []);
  const tradeLevels = useMemo(
    () =>
      resolveTradeLevelsForDirective({
        directive: tradeDirective,
        laneEdges: machineVerdict?.edges ?? null,
        crossProb: machineVerdict?.crossProb ?? null,
        endsInMs: endsInMs ?? null,
      }),
    [tradeDirective, machineVerdict?.crossProb, machineVerdict?.edges, endsInMs],
  );
  const [stability, setStability] = useState<DirectiveStability | null>(null);
  useEffect(() => {
    if (!tradeDirective) return;
    setStability((prev) => updateStability(prev, tradeDirective, Date.now()));
  }, [tradeDirective]);
  const discrepancy = useMemo(
    () => detectDirectiveDiscrepancy(tradeDirective, machineVerdict),
    [tradeDirective, machineVerdict],
  );
  const [reEntryState, setReEntryState] = useState<ReEntryState | null>(null);
  const previousDirectiveRef = useRef<TradeDirective | null>(null);
  useEffect(() => {
    if (!tradeDirective) return;
    const prev = previousDirectiveRef.current;
    setReEntryState((s) => updateReEntryState(s, tradeDirective, prev, Date.now()));
    previousDirectiveRef.current = tradeDirective;
  }, [tradeDirective]);
  const [reEntryNow, setReEntryNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setReEntryNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const reEntryCheck = useMemo(() => {
    if (!tradeDirective || !reEntryState) return null;
    return checkReEntry(reEntryState, tradeDirective, reEntryNow);
  }, [tradeDirective, reEntryState, reEntryNow]);
  const sizingMultiplier = useMemo(() => {
    if (!tradeDirective) return null;
    return computeSizingMultiplier({
      stability,
      discrepancy,
      edges: machineVerdict?.edges ?? null,
      lane: tradeDirective.lane,
      cooldownActive: reEntryCheck?.onCooldown ?? false,
    });
  }, [tradeDirective, stability, discrepancy, machineVerdict?.edges, reEntryCheck]);
  const [journal, setJournal] = useState<DirectiveJournal>(() => resetJournal());
  useEffect(() => {
    setJournal(resetJournal());
  }, [slug]);
  useEffect(() => {
    if (!tradeDirective) return;
    setJournal((prev) => appendDirectiveToJournal(prev, tradeDirective, machineVerdict, Date.now()));
  }, [tradeDirective, machineVerdict]);

  const upMid = probUp.length ? (probUp[probUp.length - 1]!.v ?? null) : null;
  const downMid = probDown.length ? (probDown[probDown.length - 1]!.v ?? null) : null;
  const spotLast = spot.length ? spot[spot.length - 1]!.v : null;
  /** Chart “Live” uses max(spot, book) so a quiet spot tick but fresh CLOB mid still counts as live. */
  const chartLastFreshMs =
    spotLastUpdateMs != null && probLastUpdateMs != null
      ? Math.max(spotLastUpdateMs, probLastUpdateMs)
      : spotLastUpdateMs ?? probLastUpdateMs ?? null;
  const spotDist = spotLast != null && priceToBeat != null ? spotLast - priceToBeat : null;

  const activeBook = activeLane === 'up' ? bookAbove : bookBelow;
  const activeBookLabel = activeLane === 'up' ? upLabel : downLabel;
  const strategyLine = useMemo(() => {
    if (spotDist == null || priceToBeat == null) return 'Load PTB and spot to compare the moving price candles against the fixed decision line.';
    if (spotDist > 0) return `Price candles are above PTB, so ${upLabel} has the current bias.`;
    if (spotDist < 0) return `Price candles are below PTB, so ${downLabel} has the current bias.`;
    return 'Price candles are sitting on PTB, so this is the no-trade reaction zone.';
  }, [priceToBeat, spotDist]);

  const timeLeft = useMemo(() => {
    if (endsInMs == null) return '—';
    const totalSec = Math.max(0, Math.floor(endsInMs / 1000));
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${String(sec).padStart(2, '0')}`;
  }, [endsInMs]);

  return (
    <div className="space-y-5 xl:space-y-6">
      <div className="overflow-hidden rounded-[28px] border border-zinc-800/70 bg-[#0d1219] shadow-[0_18px_60px_rgba(0,0,0,0.3)] ring-1 ring-white/[0.03]">
        <div className="border-b border-zinc-800/70 px-4 py-2.5 text-[11px] leading-relaxed text-zinc-500 sm:px-5">
          {STREAM_ATTRIBUTION_LINE} <span className="text-zinc-600">·</span> PTB is fixed for the window; candles track underlying spot.
        </div>
        <div className="grid gap-3 px-4 py-4 sm:px-5 sm:py-5 md:grid-cols-[1fr_auto] md:items-end md:gap-6">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Price to beat</div>
            <div className="mt-0.5 truncate text-3xl font-semibold tracking-tight text-zinc-50 sm:text-4xl">{fmtUsd(priceToBeat)}</div>
            <div className="mt-1 text-[12px] text-zinc-500">SSR decision boundary</div>
          </div>
          <div className="min-w-0 md:text-right">
            <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Time left</div>
            <div className="mt-0.5 font-mono text-3xl font-semibold tabular-nums tracking-tight text-zinc-50 sm:text-4xl">{timeLeft}</div>
            <div className="mt-1 text-left text-[12px] leading-snug text-zinc-500 md:text-right">{strategyLine}</div>
          </div>
        </div>
      </div>

      <div className="grid min-w-0 max-w-full gap-5 xl:grid-cols-[minmax(0,2.35fr)_minmax(19rem,28rem)] xl:items-start 2xl:grid-cols-[minmax(0,2.55fr)_minmax(20rem,30rem)]">
        <div className="min-w-0 max-w-full space-y-4 xl:space-y-5">
          <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/35 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-400">
            Main Chart
          </div>
          <PtbOpportunityModeChart
            chartAreaRoomy
            slug={slug}
            mode={activeLane}
            spot={spot}
            priceToBeat={priceToBeat}
            lastUpdateMs={chartLastFreshMs}
            endsInMs={endsInMs}
            chartTitle={underlyingChartTitle(market)}
            upLabel={upLabel}
            downLabel={downLabel}
            lastProbUp={upMid}
            lastProbDown={downMid}
            onMachineReadout={onMachineVerdict}
            onTradeDirective={onTradeDirective}
            recentPrints={tapePrints}
          />

          <TradeDirectiveCard
            directive={tradeDirective}
            compact
            levels={tradeLevels}
            laneEdges={machineVerdict?.edges ?? null}
            tpSlHorizon={{ crossProb: machineVerdict?.crossProb ?? null, endsInMs }}
            upOutcomeLabel={upLabel}
            downOutcomeLabel={downLabel}
            stability={stability}
            discrepancy={discrepancy}
            reEntry={reEntryCheck}
            sizingMultiplier={sizingMultiplier}
            journal={journal}
          />
          <MachineVerdictCard readout={machineVerdict} compact minimal />
          {spot.length < 2 ? (
            <div className="rounded-2xl border border-amber-900/35 bg-amber-950/15 px-4 py-3 text-sm leading-relaxed text-amber-100/90">
              <span className="font-semibold text-amber-50">Spot history is still warming up.</span>{' '}
              {spotStreamEligible ? (
                <span>RTDS ticks usually land within a few seconds on an active tab; the candle model needs at least two ticks.</span>
              ) : (
                <span>
                  Use <span className="font-mono text-amber-50/95">btc|eth|sol-updown-5m-*</span> or{' '}
                  <span className="font-mono text-amber-50/95">*-updown-15m-*</span> — other slugs do not map to RTDS underlying here yet.
                </span>
              )}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setActiveLane('up')}
              className={`rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${
                activeLane === 'up'
                  ? 'border-emerald-500/60 bg-emerald-950/35 text-emerald-100'
                  : 'border-zinc-800/70 bg-zinc-950/30 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {upLabel} book
            </button>
            <button
              type="button"
              onClick={() => setActiveLane('down')}
              className={`rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${
                activeLane === 'down'
                  ? 'border-rose-500/60 bg-rose-950/30 text-rose-100'
                  : 'border-zinc-800/70 bg-zinc-950/30 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {downLabel} book
            </button>
            <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/35 px-3 py-2 text-sm text-zinc-500">
              <span className="text-zinc-400">Spot</span> {fmtUsd(spotLast)}
              {spotLastUpdateMs ? (
                <span className="ml-2 font-mono text-[11px] text-zinc-600">
                  RTDS {new Date(spotLastUpdateMs).toLocaleTimeString()}
                </span>
              ) : null}
              {probLastUpdateMs ? (
                <span className="ml-2 font-mono text-[11px] text-zinc-600">
                  Mid {new Date(probLastUpdateMs).toLocaleTimeString()}
                </span>
              ) : null}
            </div>
          </div>

          {upToken && downToken ? (
            <OverallOrderBookPanel title={`${activeBookLabel} order book`} book={activeBook} lastUpdateMs={probLastUpdateMs ?? spotLastUpdateMs} maxLevels={10} />
          ) : (
            <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/40 p-5 text-sm text-zinc-500">
              This market loaded, but outcome books/tokens are not available yet for the Dual PTB order-book panel.
            </div>
          )}
        </div>

        <div className="xl:sticky xl:top-4">
          {upToken && downToken ? (
            <SignalsTradePanel
              marketSlug={pickMarketSlug(market)}
              gammaMarket={market}
              probMomentumUp={probUp}
              probMomentumDown={probDown}
              upLabel={upLabel}
              downLabel={downLabel}
              upToken={upToken}
              downToken={downToken}
              upMid={upMid}
              downMid={downMid}
              bookMidUp={midPrice(bookAbove)}
              bookMidDown={midPrice(bookBelow)}
              bookTouchUp={topOfBook(bookAbove)}
              bookTouchDown={topOfBook(bookBelow)}
              lane={activeLane}
              onLaneChange={setActiveLane}
              visualStyle="sidebar"
            />
          ) : (
            <div className="rounded-[28px] border border-zinc-800/70 bg-[#0d1219] p-5 text-sm text-zinc-500 ring-1 ring-white/[0.03]">
              Load both outcome tokens to activate the trade panel in this tab.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
