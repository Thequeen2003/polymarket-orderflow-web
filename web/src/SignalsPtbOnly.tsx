import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ClobBookEntry } from './lib/api';
import { pickConditionId } from './bookIntel';
import { FlowZoneSignalsPanel } from './FlowZoneSignalsPanel';
import { OrderFlowChart } from './OrderFlowChart';
import { PtbDualProbabilityChart } from './PtbDualProbabilityChart';
import { PtbOpportunityModeChart } from './PtbOpportunityModeChart';
import { OverallOrderBookPanel } from './OverallOrderBookPanel';
import type { BookSnapshot } from './orderflowMetrics';
import { RecentPrintsPanel } from './RecentPrintsPanel';
import type { SpotPoint } from './SpotLevelChart';
import { SignalsTradePanel } from './SignalsTradePanel';
import { underlyingChartTitle } from './underlyingChartTitle';
import { STREAM_ATTRIBUTION_LINE } from './streamAttribution';
import { midPrice, topOfBook } from './bookLevels';
import { resolveUpDownIndices } from './upDown';
import { buildSpotCandles } from './spotVsPtb';
import { computePtbChartDerivatives } from './ptbChartDerivatives';

function fmtMarketCountdown(endsInMs: number | null): string {
  if (endsInMs == null || !Number.isFinite(endsInMs)) return '—';
  if (endsInMs <= 0) return 'Ended';
  const s = Math.floor(endsInMs / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h >= 72) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${r}s`;
}

function applySignalToTradePanel(lane: 'up' | 'down'): void {
  window.dispatchEvent(
    new CustomEvent('bpx-trade-prefill', {
      detail: { lane, tone: 'ask' as const },
    }),
  );
}

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
  booksWsStatus?: string | null;
  ptbError?: string | null;
  rtdsError?: string | null;
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
    endsInMs,
    booksFetchedAt,
    spotStreamEligible = false,
    booksWsStatus = null,
    ptbError = null,
    rtdsError = null,
    ptbSource = null,
    spotFeedSource = null,
  } = props;

  function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
  }

  function fmtSigned(n: number, digits = 2): string {
    if (!Number.isFinite(n)) return '—';
    return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;
  }

  function fmtUsdSignedTight(v: number | null, digits = 2): string {
    if (v == null || !Number.isFinite(v)) return '—';
    const sign = v >= 0 ? '+' : '-';
    return `${sign}$${Math.abs(v).toFixed(digits)}`;
  }

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

  const conditionId = useMemo(() => pickConditionId(market), [market]);

  const activeOrderFlow = useMemo(() => {
    if (!idx || !books || !flowSeriesForSlug) return null;
    const up = books[idx.up];
    const down = books[idx.down];
    if (!up || !down || up.error || down.error) return null;
    const mu = midPrice(up.book);
    const md = midPrice(down.book);
    if (mu == null || md == null) return null;
    const useUp = mu >= md;
    return {
      token: useUp ? up.token : down.token,
      label: useUp ? upLabel : downLabel,
      series: (flowSeriesForSlug[useUp ? up.token : down.token] ?? []).slice(-180),
    };
  }, [books, downLabel, flowSeriesForSlug, idx, upLabel]);

  const spotBookAlignment = useMemo(() => {
    const spotLast = spot.length ? spot[spot.length - 1]!.v : null;
    const mU = midPrice(bookAbove);
    const mD = midPrice(bookBelow);
    if (spotLast == null || priceToBeat == null || mU == null || mD == null) return null;
    const band = Math.max(0.35, Math.abs(priceToBeat) * 0.00035);
    const above = spotLast > priceToBeat + band;
    const below = spotLast < priceToBeat - band;
    const bookSkewsUp = mU > mD + 0.008;
    const bookSkewsDown = mD > mU + 0.008;
    let align: 'ALIGNED' | 'DIVERGENT' | 'MIXED' = 'MIXED';
    if ((above && bookSkewsUp) || (below && bookSkewsDown)) align = 'ALIGNED';
    else if ((above && bookSkewsDown) || (below && bookSkewsUp)) align = 'DIVERGENT';
    return { align, spotLast, mU, mD, above, below };
  }, [bookAbove, bookBelow, priceToBeat, spot]);

  const hasDual = probUp.length >= 1 && probDown.length >= 1;
  const [spotChartLane, setSpotChartLane] = useState<'up' | 'down'>('up');
  const spotChartLive = priceToBeat != null && spot.length >= 2;
  const [chartTab, setChartTab] = useState<'spot' | 'dual'>(() => (hasDual ? 'spot' : 'spot'));
  const [flowZonesOpen, setFlowZonesOpen] = useState(true);
  const [signalAlerts, setSignalAlerts] = useState<{ ts: number; text: string }[]>([]);
  const lastSignalKeyRef = useRef<string | null>(null);
  const laneStreakRef = useRef<{ lane: 'up' | 'down' | null; streak: number }>({ lane: null, streak: 0 });
  const [lockedDirection, setLockedDirection] = useState<{
    lane: 'up' | 'down' | null;
    confidence: 'HIGH' | 'MED' | 'LOW';
    status: 'ENTER' | 'PREP' | 'WAIT';
    reason: string;
  }>({ lane: null, confidence: 'LOW', status: 'WAIT', reason: 'Waiting for a stable directional edge.' });

  const ptbContext = useMemo(() => {
    if (priceToBeat == null || !Number.isFinite(priceToBeat) || spot.length < 2) return null;
    const pts = spot
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .slice(-320)
      .map((p) => ({ t: p.t, v: p.v }));
    if (pts.length < 2) return null;
    const candles = buildSpotCandles(pts, Math.min(64, Math.max(12, Math.floor(pts.length * 0.22))));
    const d = computePtbChartDerivatives({ pts, candles, ptb: priceToBeat });

    // Volatility proxy (ATR-ish) from recent close-to-close absolute moves.
    // Used to normalize slope / distance so we stop treating tiny chop as “momentum”.
    const diffs: number[] = [];
    for (let i = 1; i < pts.length; i++) diffs.push(Math.abs(pts[i]!.v - pts[i - 1]!.v));
    diffs.sort((a, b) => a - b);
    const q = (p: number) => {
      if (!diffs.length) return 0;
      const at = clamp(Math.floor(p * (diffs.length - 1)), 0, diffs.length - 1);
      return diffs[at] ?? 0;
    };
    const atrLike = q(0.7); // robust, ignores single spikes
    const bandWidthPct = priceToBeat > 0 ? (d.reaction.eps / priceToBeat) * 100 : null;
    const lastDeltaUsd = pts.length >= 2 ? pts[pts.length - 1]!.v - pts[pts.length - 2]!.v : 0;

    return {
      ptbUsd: priceToBeat,
      bandUsd: d.reaction.eps,
      bandWidthPct,
      atrLikeUsd: atrLike,
      lastDeltaUsd,
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
    // Normalize slope threshold to current volatility so it scales across calm vs fast tape.
    const vol = Math.max(0.01, ptbContext.atrLikeUsd ?? 0.01);
    const slopeOk = Math.abs(slope) >= Math.max(1.2, vol * 7.5); // $/min; adaptive + conservative

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

  const overallSignal = useMemo(() => {
    if (!ptbContext || !earlySetup) return null;

    const regime = ptbContext.structureEvent ?? 'unknown';
    const chop = regime === 'chop' || ptbContext.controlSignal === 'NO_EDGE';
    const vol = Math.max(0.01, ptbContext.atrLikeUsd ?? 0.01);
    const eps = Math.max(0.35, ptbContext.bandUsd);

    // Chase-risk heuristic: one big last move, but still near band (classic “one candle bait”).
    const jumpAbs = Math.abs(ptbContext.lastDeltaUsd ?? 0);
    const nearBand = Math.abs(ptbContext.distanceUsd) <= eps * 1.1;
    const chaseRisk = earlySetup.state !== 'ENTER' && jumpAbs >= Math.max(0.35, vol * 2.2) && nearBand;

    // Liquidity / execution risk from touch spread (wide spread makes “good” signals bleed).
    const touchUp = topOfBook(bookAbove);
    const touchDown = topOfBook(bookBelow);
    const touch = earlySetup.lane === 'down' ? touchDown : touchUp;
    const spread01 =
      touch?.bestBid != null && touch?.bestAsk != null && Number.isFinite(touch.bestBid) && Number.isFinite(touch.bestAsk)
        ? Math.max(0, touch.bestAsk - touch.bestBid)
        : null;
    const spreadCents = spread01 != null ? spread01 * 100 : null;
    const wideSpread = spreadCents != null && spreadCents >= 2.2;

    // Score is intentionally conservative; “dominate” here means fewer trades, higher quality.
    let score = 50;
    if (ptbContext.controlSignal === 'UP_CONTROL' || ptbContext.controlSignal === 'DOWN_CONTROL') score += 12;
    if (regime === 'break_and_hold') score += 16;
    if (regime === 'extension') score += 8;
    if (earlySetup.state === 'ENTER') score += 14;
    if (earlySetup.state === 'SETUP') score += 6;
    if (chop) score -= 28;
    if (chaseRisk) score -= 14;
    if (wideSpread) score -= 10;

    // Reward separation relative to current band + volatility.
    const sep = Math.abs(ptbContext.distanceUsd) / Math.max(0.01, eps);
    score += clamp((sep - 0.8) * 10, -8, 10);
    const slopeN = Math.abs(ptbContext.slopeUsdPerMin ?? 0) / Math.max(0.01, vol * 8);
    score += clamp((slopeN - 0.9) * 10, -10, 10);

    score = Math.round(clamp(score, 0, 100));

    const verdict =
      score >= 78
        ? ('TRADE' as const)
        : score >= 64
          ? ('SETUP' as const)
          : score >= 44
            ? ('WAIT' as const)
            : ('AVOID' as const);

    const flags = [
      chop ? 'CHOP' : null,
      chaseRisk ? 'CHASE RISK' : null,
      wideSpread ? `WIDE SPREAD${spreadCents != null ? ` ~${spreadCents.toFixed(1)}¢` : ''}` : null,
      ptbContext.bandWidthPct != null && ptbContext.bandWidthPct >= 0.06 ? 'WIDE BAND' : null,
    ].filter(Boolean) as string[];

    const sepAdj = clamp((sep - 0.8) * 10, -8, 10);
    const slopeAdj = clamp((slopeN - 0.9) * 10, -10, 10);
    const scoreReasons: string[] = ['Start from base 50.'];
    if (ptbContext.controlSignal === 'UP_CONTROL' || ptbContext.controlSignal === 'DOWN_CONTROL') {
      scoreReasons.push(`Control (${String(ptbContext.controlSignal).replaceAll('_', ' ')}): +12`);
    } else {
      scoreReasons.push('No UP/DOWN control bonus.');
    }
    if (regime === 'break_and_hold') scoreReasons.push('Regime break-and-hold: +16');
    else if (regime === 'extension') scoreReasons.push('Regime extension: +8');
    else scoreReasons.push(`Regime ${regime} (no structural bonus).`);
    if (earlySetup.state === 'ENTER') scoreReasons.push('Entry readiness ENTER: +14');
    else if (earlySetup.state === 'SETUP') scoreReasons.push('Entry readiness SETUP: +6');
    else scoreReasons.push(`Entry readiness ${earlySetup.state}.`);
    if (chop) scoreReasons.push('Chop / no-edge penalty: −28');
    if (chaseRisk) scoreReasons.push('Chase-risk (large last move near band): −14');
    if (wideSpread) scoreReasons.push(`Wide touch spread${spreadCents != null ? ` ~${spreadCents.toFixed(1)}¢` : ''}: −10`);
    if (sepAdj !== 0) scoreReasons.push(`Distance vs band (normalized): ${sepAdj >= 0 ? '+' : ''}${sepAdj.toFixed(1)}`);
    if (slopeAdj !== 0) scoreReasons.push(`Slope vs vol (normalized): ${slopeAdj >= 0 ? '+' : ''}${slopeAdj.toFixed(1)}`);
    scoreReasons.push(`Final score ${score} → ${verdict}.`);

    return { score, verdict, flags, spreadCents, chaseRisk, wideSpread, chop, scoreReasons } as const;
  }, [bookAbove, bookBelow, earlySetup, ptbContext]);

  useEffect(() => {
    const key = `${overallSignal?.verdict ?? '—'}|${overallSignal?.score ?? '—'}|${earlySetup?.state ?? '—'}|${earlySetup?.lane ?? '—'}|${(overallSignal?.flags ?? []).join(',')}`;
    if (key === lastSignalKeyRef.current) return;
    lastSignalKeyRef.current = key;
    const ts = Date.now();
    const text = [
      overallSignal ? `${overallSignal.verdict} (${overallSignal.score})` : '—',
      earlySetup ? `${earlySetup.state}${earlySetup.lane ? ` · ${earlySetup.lane}` : ''}` : '',
      overallSignal?.flags?.length ? overallSignal.flags.join(', ') : '',
    ]
      .filter(Boolean)
      .join(' · ');
    setSignalAlerts((rows) => [{ ts, text }, ...rows].slice(0, 36));
  }, [earlySetup, overallSignal]);

  useEffect(() => {
    if (!overallSignal || !earlySetup) {
      laneStreakRef.current = { lane: null, streak: 0 };
      setLockedDirection({
        lane: null,
        confidence: 'LOW',
        status: 'WAIT',
        reason: 'Need more PTB context before direction is actionable.',
      });
      return;
    }

    const divergent = spotBookAlignment?.align === 'DIVERGENT';
    const candidateLane = earlySetup.lane;
    const candidateReady = earlySetup.state !== 'WAIT' && candidateLane != null && overallSignal.verdict !== 'AVOID' && !divergent;

    if (!candidateReady) {
      laneStreakRef.current = { lane: null, streak: 0 };
      const reason = divergent
        ? 'Spot and book are divergent; wait for re-alignment.'
        : overallSignal.verdict === 'AVOID'
          ? 'Composite score says avoid.'
          : 'No directional setup yet.';
      setLockedDirection({ lane: null, confidence: 'LOW', status: 'WAIT', reason });
      return;
    }

    const confidence: 'HIGH' | 'MED' =
      earlySetup.state === 'ENTER' && overallSignal.verdict === 'TRADE'
        ? 'HIGH'
        : 'MED';
    const prev = laneStreakRef.current;
    const streak = prev.lane === candidateLane ? prev.streak + 1 : 1;
    laneStreakRef.current = { lane: candidateLane, streak };
    const minStreak = confidence === 'HIGH' ? 2 : 3;

    if (streak < minStreak) {
      setLockedDirection({
        lane: null,
        confidence: 'LOW',
        status: 'WAIT',
        reason: `Directional edge forming (${streak}/${minStreak}) — waiting to avoid flip noise.`,
      });
      return;
    }

    setLockedDirection({
      lane: candidateLane,
      confidence,
      status: earlySetup.state === 'ENTER' ? 'ENTER' : 'PREP',
      reason:
        earlySetup.state === 'ENTER'
          ? 'Stable control + slope + dwell alignment.'
          : 'Stable setup detected; wait for final break/hold trigger.',
    });
  }, [earlySetup, overallSignal, spotBookAlignment]);

  const signalDesk = useMemo(() => {
    if (!books || books.length < 2 || !flowSeriesForSlug) return null;
    const rollSoon = endsInMs != null && endsInMs > 0 && endsInMs < 5 * 60 * 1000;
    return (
      <div className="space-y-2 rounded-2xl border border-zinc-800/60 bg-gradient-to-b from-zinc-900/45 to-zinc-950/40 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Signals desk</div>
          <div className="flex flex-wrap items-center gap-2 text-[12px] font-semibold text-zinc-200">
            <span className="rounded-lg border border-zinc-700/60 bg-black/25 px-2.5 py-1 font-mono text-amber-100/95">
              Ends in {fmtMarketCountdown(endsInMs)}
            </span>
            {booksFetchedAt != null ? (
              <span className="text-[11px] font-medium text-zinc-500" title="Last REST book refresh in App">
                Book REST {new Date(booksFetchedAt).toLocaleTimeString()}
              </span>
            ) : null}
          </div>
        </div>
        {rollSoon ? (
          <div className="rounded-xl border border-amber-600/40 bg-amber-950/25 px-3 py-2 text-[11px] font-semibold text-amber-100/95">
            Window rolls soon — liquidity and PTB can jump at expiry; size and limits accordingly.
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2 text-[10px] font-semibold">
          {booksWsStatus ? (
            <span className="rounded-lg border border-zinc-700/60 bg-zinc-950/50 px-2 py-1 text-zinc-400" title="CLOB market WebSocket">
              CLOB WS {booksWsStatus}
            </span>
          ) : (
            <span className="rounded-lg border border-zinc-800/60 px-2 py-1 text-zinc-600">CLOB WS —</span>
          )}
          {ptbError ? (
            <span className="rounded-lg border border-rose-800/50 bg-rose-950/30 px-2 py-1 text-rose-200/95">PTB {ptbError}</span>
          ) : (
            <span className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 px-2 py-1 text-emerald-200/80">PTB ok</span>
          )}
          {rtdsError ? (
            <span className="rounded-lg border border-rose-800/50 bg-rose-950/30 px-2 py-1 text-rose-200/95">RTDS {rtdsError}</span>
          ) : spotStreamEligible ? (
            <span className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 px-2 py-1 text-emerald-200/80">RTDS ok</span>
          ) : (
            <span className="rounded-lg border border-zinc-800/60 px-2 py-1 text-zinc-600">RTDS n/a</span>
          )}
        </div>
        {activeOrderFlow && activeOrderFlow.series.length >= 2 ? (
          <OrderFlowChart
            compact
            title={`Order flow · ${activeOrderFlow.label} (higher mid)`}
            series={activeOrderFlow.series}
            lastUpdateMs={probLastUpdateMs}
            priceToBeatUsd={priceToBeat}
          />
        ) : (
          <div className="rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-2 text-[11px] text-zinc-500">
            Order-flow strip needs a few book snapshots on the leading side (open Book tab briefly if this stays empty).
          </div>
        )}
        {spotBookAlignment ? (
          <div className="rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-2 text-[11px] leading-relaxed text-zinc-300">
            <span className="font-semibold text-zinc-200">Spot vs book mids: </span>
            underlying {spotBookAlignment.above ? 'above' : spotBookAlignment.below ? 'below' : 'near'} PTB · book{' '}
            {spotBookAlignment.mU >= spotBookAlignment.mD ? 'skew UP' : 'skew DOWN'} ({(spotBookAlignment.mU * 100).toFixed(1)}¢ /{' '}
            {(spotBookAlignment.mD * 100).toFixed(1)}¢)
            <span
              className={`ml-2 rounded-md border px-2 py-0.5 font-bold ${
                spotBookAlignment.align === 'ALIGNED'
                  ? 'border-emerald-700/50 text-emerald-200'
                  : spotBookAlignment.align === 'DIVERGENT'
                    ? 'border-amber-600/50 text-amber-100'
                    : 'border-zinc-700/60 text-zinc-400'
              }`}
            >
              {spotBookAlignment.align}
            </span>
          </div>
        ) : null}
        {signalAlerts.length ? (
          <details className="rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-2">
            <summary className="cursor-pointer text-[11px] font-semibold text-zinc-400 hover:text-zinc-200">
              Signal log ({signalAlerts.length})
            </summary>
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto font-mono text-[10px] text-zinc-500">
              {signalAlerts.map((a, i) => (
                <li key={`${a.ts}-${i}`}>
                  <span className="text-zinc-600">{new Date(a.ts).toLocaleTimeString()}</span> {a.text}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    );
  }, [
    activeOrderFlow,
    books,
    booksFetchedAt,
    booksWsStatus,
    endsInMs,
    flowSeriesForSlug,
    priceToBeat,
    probLastUpdateMs,
    ptbError,
    rtdsError,
    signalAlerts,
    spotBookAlignment,
    spotStreamEligible,
    upLabel,
    upToken,
  ]);

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
      {overallSignal ? (
        <div className="mt-2 rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Overall</div>
            <div className="flex flex-wrap items-center gap-2">
              <div
                className={`rounded-lg border px-2 py-1 text-[11px] font-extrabold tracking-wide ${
                  overallSignal.verdict === 'TRADE'
                    ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-100'
                    : overallSignal.verdict === 'SETUP'
                      ? 'border-amber-500/35 bg-amber-950/20 text-amber-100'
                      : overallSignal.verdict === 'WAIT'
                        ? 'border-zinc-700/70 bg-zinc-900/30 text-zinc-200'
                        : 'border-rose-500/35 bg-rose-950/20 text-rose-100'
                }`}
                title="Composite of regime + hold/separation + slope + chase/liquidity risk"
              >
                {overallSignal.verdict} · {overallSignal.score}/100
              </div>
              {overallSignal.flags.length ? (
                <div className="flex flex-wrap gap-1">
                  {overallSignal.flags.slice(0, 4).map((f) => (
                    <span
                      key={f}
                      className="rounded-lg border border-zinc-800/70 bg-zinc-950/30 px-2 py-1 text-[10px] font-semibold text-zinc-300"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              ) : (
                <span className="text-[11px] font-semibold text-zinc-500">clean</span>
              )}
            </div>
          </div>
          <div className="mt-2 grid gap-2 md:grid-cols-3">
            <div className="rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Vol (ATR-ish)</div>
              <div className="mt-0.5 text-sm font-semibold text-zinc-200">
                ±${(ptbContext.atrLikeUsd ?? 0).toFixed(2)}
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Band width</div>
              <div className="mt-0.5 text-sm font-semibold text-zinc-200">
                ±${ptbContext.bandUsd.toFixed(2)}
                <span className="ml-2 text-[11px] font-semibold text-zinc-500">
                  {ptbContext.bandWidthPct != null ? `(${ptbContext.bandWidthPct.toFixed(3)}%)` : ''}
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Distance</div>
              <div className="mt-0.5 text-sm font-semibold text-zinc-200">
                {ptbContext.position} {fmtUsdSignedTight(ptbContext.distanceUsd, 2)}
                <span className="ml-2 text-[11px] font-semibold text-zinc-500">
                  ({fmtSigned(ptbContext.distanceUsd / Math.max(0.01, ptbContext.bandUsd), 2)}× band)
                </span>
              </div>
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
            {overallSignal.verdict === 'TRADE'
              ? 'Trade only the side that matches control. Prefer pullback-holds; take partials into extension; stop is “back in band”.'
              : overallSignal.verdict === 'SETUP'
                ? 'Setup forming: wait for outside+hold (or a second push) — first push is where most wipeouts start.'
                : overallSignal.verdict === 'WAIT'
                  ? 'Default: WAIT. If you trade anyway, do it small and only on confirmation (hold).'
                  : 'Avoid: this tape is built to chop you or bleed you via spread. Wait for a regime flip / cleaner hold.'}
          </p>
          <div className="mt-2 rounded-xl border border-zinc-800/60 bg-zinc-950/25 px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Direction call</div>
              <div
                className={`rounded-lg border px-2 py-1 text-[10px] font-extrabold tracking-wide ${
                  lockedDirection.status === 'ENTER'
                    ? lockedDirection.lane === 'up'
                      ? 'border-emerald-500/45 bg-emerald-950/30 text-emerald-100'
                      : 'border-rose-500/45 bg-rose-950/25 text-rose-100'
                    : lockedDirection.status === 'PREP'
                      ? 'border-amber-500/35 bg-amber-950/20 text-amber-100'
                      : 'border-zinc-700/70 bg-zinc-900/30 text-zinc-200'
                }`}
              >
                {lockedDirection.status}
                {lockedDirection.lane ? ` · ${lockedDirection.lane === 'up' ? upLabel : downLabel}` : ' · NO SIDE'}
                {` · ${lockedDirection.confidence}`}
              </div>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">{lockedDirection.reason}</p>
          </div>
          {upToken && downToken ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => applySignalToTradePanel(lockedDirection.lane ?? 'up')}
                className={`rounded-lg border px-3 py-1.5 text-[11px] font-semibold ${
                  lockedDirection.lane === 'down'
                    ? 'border-rose-800/50 bg-rose-950/30 text-rose-100 hover:bg-rose-950/45'
                    : 'border-emerald-800/50 bg-emerald-950/30 text-emerald-100 hover:bg-emerald-950/45'
                }`}
                title="Sets trade panel to UP outcome and buy (limit); refine price on the ladder."
              >
                {lockedDirection.lane
                  ? `Use recommended side → ${lockedDirection.lane === 'up' ? upLabel : downLabel}`
                  : 'Use trade panel → follow manually'}
              </button>
              <button
                type="button"
                onClick={() => applySignalToTradePanel(lockedDirection.lane === 'up' ? 'down' : 'up')}
                className="rounded-lg border border-zinc-700/60 bg-zinc-950/30 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900/40"
                title="Sets trade panel to DOWN outcome and buy (limit); refine price on the ladder."
              >
                Alternate side → {lockedDirection.lane === 'up' ? downLabel : upLabel}
              </button>
            </div>
          ) : null}
          <details className="mt-2 rounded-lg border border-zinc-800/50 bg-zinc-950/25 px-2 py-1.5">
            <summary className="cursor-pointer text-[11px] font-semibold text-zinc-400 hover:text-zinc-200">
              Why this score?
            </summary>
            <ul className="mt-2 list-inside list-disc space-y-1 text-[10px] leading-relaxed text-zinc-500">
              {overallSignal.scoreReasons.map((r, j) => (
                <li key={j}>{r}</li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}
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
    const effectiveReadinessState = lockedDirection.status === 'ENTER' ? 'ENTER' : earlySetup?.state ?? 'WAIT';
    const effectiveLane = lockedDirection.lane ?? earlySetup?.lane ?? null;
    const effectiveWhy = lockedDirection.lane ? lockedDirection.reason : earlySetup?.why ?? null;
    return {
      ...ptbContext,
      readinessState: effectiveReadinessState,
      readinessLane: effectiveLane,
      readinessWhy: effectiveWhy,
    } as const;
  }, [earlySetup, lockedDirection, ptbContext]);

  const spotVsPtbSection = (
    <>
      <div className="space-y-1 rounded-xl border border-zinc-800/60 bg-zinc-950/35 px-4 py-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-400">Spot vs PTB (USD · fixed line)</div>
        <p className="text-[10px] leading-relaxed text-zinc-500">
          Same rules as the big chart: <span className="text-zinc-400">higher $ draws toward the top</span>; yellow PTB;
          green/red wash is <span className="text-zinc-400">above/below that line</span>, not “price good/bad”. Momentum
          badges are <span className="text-zinc-400">short-bucket candle trend</span> and can disagree with spot vs PTB on a
          pullback. The strip uses your zoom (1m–15m) and up to a few hundred recent ticks from the server buffer.
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
        lastProbUp={probUp.length ? (probUp[probUp.length - 1]!.v ?? null) : null}
        lastProbDown={probDown.length ? (probDown[probDown.length - 1]!.v ?? null) : null}
        ptbSource={ptbSource}
        spotFeedSource={spotFeedSource}
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

      <details
        className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35"
        open={flowZonesOpen}
        onToggle={(e) => setFlowZonesOpen((e.target as HTMLDetailsElement).open)}
      >
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
        <OverallOrderBookPanel
          title={`${upLabel} book`}
          book={bookAbove}
          lastUpdateMs={probLastUpdateMs}
          prefillLane="up"
        />
        <OverallOrderBookPanel
          title={`${downLabel} book`}
          book={bookBelow}
          lastUpdateMs={probLastUpdateMs}
          prefillLane="down"
        />
      </div>
      <RecentPrintsPanel
        conditionId={conditionId}
        activeTokenId={activeOrderFlow?.token || upToken || null}
        outcomeLabel={activeOrderFlow?.label ?? upLabel}
      />
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
      {books && books.length >= 2 ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <OverallOrderBookPanel
            title={`${upLabel} book`}
            book={bookAbove}
            lastUpdateMs={probLastUpdateMs}
            prefillLane="up"
          />
          <OverallOrderBookPanel
            title={`${downLabel} book`}
            book={bookBelow}
            lastUpdateMs={probLastUpdateMs}
            prefillLane="down"
          />
        </div>
      ) : null}
      <RecentPrintsPanel
        conditionId={conditionId}
        activeTokenId={activeOrderFlow?.token || upToken || null}
        outcomeLabel={activeOrderFlow?.label ?? upLabel}
      />
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
      <div className="grid gap-3 lg:grid-cols-2">
        <OverallOrderBookPanel
          title={`${upLabel} book`}
          book={bookAbove}
          lastUpdateMs={probLastUpdateMs}
          prefillLane="up"
        />
        <OverallOrderBookPanel
          title={`${downLabel} book`}
          book={bookBelow}
          lastUpdateMs={probLastUpdateMs}
          prefillLane="down"
        />
      </div>
      <RecentPrintsPanel
        conditionId={conditionId}
        activeTokenId={activeOrderFlow?.token || upToken || null}
        outcomeLabel={activeOrderFlow?.label ?? upLabel}
      />
    </div>
  );

  return (
    <>
      {signalDesk}
      {body}
    </>
  );
}
