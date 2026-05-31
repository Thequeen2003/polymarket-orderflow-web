import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { ClobBookEntry } from './lib/api';
import { pickConditionId } from './bookIntel';
import { FlowZoneSignalsPanel } from './FlowZoneSignalsPanel';
import { PtbDualProbabilityChart } from './PtbDualProbabilityChart';
import { PtbOpportunityModeChart } from './PtbOpportunityModeChart';
import { OverallOrderBookPanel } from './OverallOrderBookPanel';
import type { BookSnapshot } from './orderflowMetrics';
import { TrackingTab } from './TrackingTab';
import type { SpotPoint } from './SpotLevelChart';
import { pickMarketSlug } from './gammaMarketSlug';
import { parseUpdownSlug } from './sixPackUpdownSlugs';
import { underlyingChartTitle } from './underlyingChartTitle';
import { midPrice, topOfBook } from './bookLevels';
import { resolveUpDownIndices } from './upDown';
import { buildSpotCandles } from './spotVsPtb';
import { computePtbChartDerivatives } from './ptbChartDerivatives';
import { MachineVerdictCard } from './MachineVerdictCard';
import { tapeLaneVote, type SpotPtbMachineReadout } from './spotPtbMachineSignals';
import { TradeDirectiveCard, type TradeExecutionSnapshot } from './TradeDirectiveCard';
import type { TradeDirective } from './tradeDirective';
import { dispatchSignalRiskLevels } from './armRiskFromSignal';
import { resolveTradeLevelsForDirective, suggestLevelsForLane } from './tradeLevels';
import { buildPositionDeskAlerts, computePositionExitReadout } from './positionDeskAlerts';
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
  refreshJournalStats,
  resetJournal,
  type DirectiveJournal,
} from './directiveJournal';
import { useRecentTapePrints } from './useRecentTapePrints';
import { computeTapeVelocity, type TapeVelocity } from './tapeVelocity';
import type { SwitchForecast } from './sectionalMomentum';
import { computeSignalTakenPlaybook } from './signalTakenPlaybook';
import { SignalTakenAckPanel } from './SignalTakenAckPanel';
import { buildHeldSideDeskMetrics } from './heldSideDeskMetrics';
import {
  loadAutoTradeOnDoThisNow,
  loadAutoTradeSizeShares,
  loadTakeSignalStrategyIds,
  readSignalsDeskBoot,
  saveAutoTradeOnDoThisNow,
  saveAutoTradeSizeShares,
  saveTakeSignalStrategyIds,
  saveSignalsDeskPersist,
  clearAllSignalsDeskHolds,
  clearSignalsDeskPersist,
  toggleTakeSignalStrategyId,
} from './signalsPagePersist';
import type { ExecuteTakeSignalOpts } from './takeSignalDesk';
import { loadTradeAccountMode } from './tradeAccountMode';
import type { NoTradeScore } from './noTradeScore';
import { buildOperatorVerdict } from './operatorVerdict';
import { computeDeskSingleAction, type DeskSingleAction } from './deskSingleAction';
import { computeDualOutcomeWallFlow } from './dualOutcomeWalls';
import { computeSpotBandGaugeSnapshot, type SpotBandGaugeSnapshot } from './spotBandDeskAction';
import {
  BPX_DESK_TOAST_EVENT,
  BPX_TRADE_SYNC_SIZE_SHARES_EVENT,
  buildTakeSignalPlan,
  BPX_SIGNALS_LANE_SYNC_EVENT,
  executeTakeSignal,
  formatRoundClock,
  pickDeskActionForTake,
  marketUsesFiveMinuteExecuteGate,
  roundTimerAllowsExecute,
  roundTimerExecuteBlockReason,
} from './takeSignalDesk';
import { TakeSignalNowButton } from './TakeSignalNowButton';
import { DeskSyncBannerSlot } from './DeskSyncBannerSlot';
import { FivePctGainSignalCard } from './FivePctGainSignalCard';
import { useStableDeskAction } from './useStableDeskAction';
import { TakeSignalStrategyPanel } from './TakeSignalStrategyPanel';
import { evaluateFivePctGainStrategy } from './fivePctGainStrategy';
import { applyTakeSignalStrategies, type TakeSignalStrategyId } from './takeSignalStrategy';
import { price01ToWholeCents } from './displayCents';
import {
  applyTakeSignalStabilityGate,
  takeSignalPlanMeaningKey,
  updateStableTakeSignalPlan,
  type StableTakeSignalState,
} from './takeSignalStability';
import {
  BPX_SIGNALS_CLEAR_HOLD_EVENT,
  dispatchResetPhantomPosition,
  shouldSyncTradePanelToMasterLane,
  TRADE_PANEL_LANE_SYNC_DEBOUNCE_MS,
  type SignalsClearHoldDetail,
} from './signalsDeskHold';
import {
  buildEntryPhysicsBrief,
  buildExitPhysicsBrief,
  buildTakeSignalPhysicsHint,
  type EntryPhysicsInput,
} from './entryPhysicsBrief';
import {
  buildTradeCausalBlocks,
  buildTradeCausalBrief,
  buildTradeCausalHeadline,
  type TradeCausalInput,
} from './tradeCausalSignal';
import { useSignalsDeskHoldPositionSync } from './signalsDeskPosition';

/** Gray / WAIT sync copy — keep the prior “Do this now” line on screen when the live feed briefly drops here. */
function deskActionIsWeakFall(a: DeskSingleAction): boolean {
  if (a.tone === 'gray') return true;
  return a.primary.trim().toUpperCase().startsWith('WAIT');
}

/** Brief hold when the live strip flickers to WAIT/sync — must not block playbook flips. */
const DO_THIS_NOW_FALL_HOLD_MS = 6_000;
/** Min gap between auto-trade fires on the same slug (prevents re-entry spam on flicker). */
const AUTO_TRADE_COOLDOWN_MS = 45_000;

type SpotEngineCall = {
  lane: 'up' | 'down' | null;
  status: 'ENTER' | 'PREP' | 'WAIT';
  confidence: 'HIGH' | 'MED' | 'LOW';
  reason: string;
  enterWhen: string | null;
};

type DualEngineCall = {
  lane: 'up' | 'down';
  verdict: 'ENTER' | 'SCALP' | 'WATCH' | 'WAIT';
  gate: 'ARMED' | 'PARTIAL' | 'NOT_ARMED';
  enterLine: string | null;
  enterOnlyIf: string;
  go: boolean;
  laneLock: { lane: 'up' | 'down' | null; status: 'LOCKED' | 'FORMING' | 'WAIT'; confidence: 'HIGH' | 'MED' | 'LOW'; reason: string };
};

function crossCheckToneClass(tone: 'emerald' | 'amber' | 'zinc' | 'rose'): string {
  if (tone === 'emerald') return 'border-emerald-700/50 bg-emerald-950/30 text-emerald-200';
  if (tone === 'amber') return 'border-amber-700/50 bg-amber-950/30 text-amber-200';
  if (tone === 'rose') return 'border-rose-700/50 bg-rose-950/30 text-rose-200';
  return 'border-zinc-700/60 bg-zinc-950/20 text-zinc-300';
}

/** Which outcome book-flow feeds the Spot chart until the operator locks a view tab. */
function inferDefaultSpotChartLane(
  spot: SpotPoint[],
  ptb: number | null,
  probUp: SpotPoint[],
  probDown: SpotPoint[],
): 'up' | 'down' {
  const lastU = probUp.length ? probUp[probUp.length - 1]!.v : null;
  const lastD = probDown.length ? probDown[probDown.length - 1]!.v : null;
  if (ptb != null && Number.isFinite(ptb) && spot.length >= 1) {
    const last = spot[spot.length - 1]!.v;
    const band = Math.max(0.35, Math.abs(ptb) * 0.00035);
    if (last > ptb + band) return 'up';
    if (last < ptb - band) return 'down';
    if (lastU != null && lastD != null && Number.isFinite(lastU) && Number.isFinite(lastD)) {
      if (lastD > lastU + 0.015) return 'down';
      if (lastU > lastD + 0.015) return 'up';
    }
    return last >= ptb ? 'up' : 'down';
  }
  if (lastU != null && lastD != null && Number.isFinite(lastU) && Number.isFinite(lastD) && lastD > lastU + 0.015) {
    return 'down';
  }
  return 'up';
}

/** Richer than lane-only: spot ENTER vs Dual GO/gate/verdict. */
function synthesizeCrossCheck(
  spot: SpotEngineCall | null,
  dual: DualEngineCall | null,
  upLabel: string,
  downLabel: string,
): {
  pill: string;
  tone: 'emerald' | 'amber' | 'zinc' | 'rose';
  title: string;
  lines: string[];
} {
  if (!spot || !dual) {
    return {
      pill: 'INCOMPLETE',
      tone: 'zinc',
      title: 'Waiting for both engines',
      lines: [
        'Each chart publishes its call after it renders. Visit Spot vs PTB and Dual PTB once, then return here — or stay on Cross-check after a refresh.',
      ],
    };
  }
  if (spot.lane == null) {
    return {
      pill: 'INCOMPLETE',
      tone: 'zinc',
      title: 'Spot has not picked a side',
      lines: [
        'Spot vs PTB is still NO SIDE — usually quiet tape, inside the reaction band, or not enough ticks in the zoom window.',
      ],
    };
  }
  if (spot.lane !== dual.lane) {
    const s = spot.lane === 'up' ? upLabel : downLabel;
    const d = dual.lane === 'up' ? upLabel : downLabel;
    return {
      pill: 'CONFLICT',
      tone: 'rose',
      title: `Spot → ${s} · Dual → ${d}`,
      lines: [
        'The USD strip and the implied gate disagree on direction — treat as highest model risk.',
        'Avoid full size until lanes match, or explicitly decide which engine you trust for this regime.',
      ],
    };
  }
  const laneName = spot.lane === 'up' ? upLabel : downLabel;
  const spotEnter = spot.status === 'ENTER';
  const dualGo = dual.go;
  const dualArmed = dual.gate === 'ARMED';
  const dualEnterVerdict = dual.verdict === 'ENTER';

  if (spotEnter && dualGo && dualArmed && dualEnterVerdict) {
    return {
      pill: 'STRONG',
      tone: 'emerald',
      title: `${laneName}: ENTER + GO (ARMED)`,
      lines: [
        'Spot strip, dual verdict, gate, and GO flag line up — the strictest “both agree” state this panel tracks.',
        'Still size to your own risk: either engine can flip on the next candle bucket.',
      ],
    };
  }
  if (spotEnter && dualGo) {
    return {
      pill: 'AGREE',
      tone: 'emerald',
      title: `${laneName}: Spot ENTER + Dual GO`,
      lines: [
        dualArmed
          ? 'Gate is ARMED — closer to “full send”, but verdict or lock text may still warrant a skim.'
          : `Gate is ${dual.gate.replace('_', ' ')} — directional agreement without a fully armed gate; lean smaller or staged.`,
      ],
    };
  }
  if (dualGo && dualArmed && !spotEnter) {
    return {
      pill: 'CAUTION',
      tone: 'amber',
      title: `${laneName}: Dual GO (ARMED) · Spot not ENTER`,
      lines: [
        'Implieds + gate are hot before the USD strip confirms ENTER — common in fast tape or thin spot updates.',
        'Wait for Spot ENTER, or trade reduced size with hard stops.',
      ],
    };
  }
  if (spotEnter && !dualGo) {
    return {
      pill: 'CAUTION',
      tone: 'amber',
      title: `${laneName}: Spot ENTER · Dual not GO`,
      lines: [
        'Spot crossed your entry rules while Dual still says WAIT — you may be early vs the paired book.',
        'Prefer limits / scales until Dual flips GO, or reassess after one dual bucket closes.',
      ],
    };
  }
  return {
    pill: 'WATCH',
    tone: 'zinc',
    title: `${laneName}: same side · mixed readiness`,
    lines: [
      `Spot ${spot.status} · Dual ${dual.verdict} · gate ${dual.gate.replace('_', ' ')} — neither path is clearly “both green”.`,
      'Default stance: smaller probe, paper check, or skip until STRONG / AGREE.',
    ],
  };
}

/**
 * Signals tab: dual implied-probability OHLC when book mids exist; else USD spot vs PTB.
 */
export function SignalsPtbOnly(props: {
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
  /** Per-outcome book snapshots for flow-zone strip (same as Book tab / Flow Zones). */
  flowSeriesForSlug: Record<string, BookSnapshot[]> | null;
  endsInMs: number | null;
  booksFetchedAt: number | null;
  /** True when slug matches BTC/ETH/SOL Up/Down (RTDS underlying stream in App). */
  spotStreamEligible?: boolean;
  ptbSource?: string | null;
  spotFeedSource?: string | null;
  /** Open full trade history (main app tab); used by embedded portfolio under charts. */
  onOpenTradeHistory?: () => void;
  /** Trade slide slug/lane — when pinned to another market, charts and orders look “out of sync”. */
  tradePanelSlug?: string | null;
  tradePanelLane?: 'up' | 'down' | null;
  tradePanelPinned?: boolean;
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
    flowSeriesForSlug,
    endsInMs,
    booksFetchedAt,
    spotStreamEligible = false,
    ptbSource = null,
    spotFeedSource = null,
    onOpenTradeHistory,
    tradePanelSlug = null,
    tradePanelLane = null,
    tradePanelPinned = false,
  } = props;

  function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
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
  const deskSlug = pickMarketSlug(market);
  if (parseUpdownSlug(deskSlug) && upLabel.toUpperCase() === 'YES' && downLabel.toUpperCase() === 'NO') {
    upLabel = 'Up';
    downLabel = 'Down';
  }
  const upToken = idx && books ? (books[idx.up]?.token ?? '') : '';
  const downToken = idx && books ? (books[idx.down]?.token ?? '') : '';

  const conditionId = useMemo(() => pickConditionId(market), [market]);

  const trackingUpMid = useMemo(() => midPrice(bookAbove), [bookAbove]);
  const trackingDownMid = useMemo(() => midPrice(bookBelow), [bookBelow]);

  const trackingUnderCharts = useMemo(() => {
    if (!upToken.trim() || !downToken.trim()) return null;
    return (
      <TrackingTab
        embed
        showLiveTrades={false}
        upToken={upToken}
        downToken={downToken}
        conditionId={conditionId}
        upLabel={upLabel}
        downLabel={downLabel}
        slug={pickMarketSlug(market)}
        upMid01={trackingUpMid}
        downMid01={trackingDownMid}
        onOpenTradeHistory={onOpenTradeHistory}
      />
    );
  }, [upToken, downToken, conditionId, upLabel, downLabel, market, onOpenTradeHistory, trackingUpMid, trackingDownMid]);

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

  const [tradeDirectiveSpot, setTradeDirectiveSpot] = useState<TradeDirective | null>(null);
  const onTradeDirectiveSpot = useCallback((d: TradeDirective | null) => {
    setTradeDirectiveSpot(d);
  }, []);
  // ─── Master lane (must sit above tape hooks): chart directive drives desk tape ───
  const masterLane: 'up' | 'down' | null = tradeDirectiveSpot?.lane ?? null;
  const masterAction = tradeDirectiveSpot?.action ?? 'STAND_DOWN';
  const masterReady = masterAction === 'INITIATE' || masterAction === 'ADD' || masterAction === 'FLIP';

  const tradePanelOutOfSync =
    tradePanelPinned &&
    Boolean(slug?.trim()) &&
    Boolean(tradePanelSlug?.trim()) &&
    slug!.trim() !== tradePanelSlug!.trim();
  const tradeLaneOutOfSync =
    !tradePanelOutOfSync &&
    masterLane != null &&
    tradePanelLane != null &&
    masterReady &&
    tradePanelLane !== masterLane;

  const hasDual = probUp.length >= 1 && probDown.length >= 1;
  const spotChartLaneLockedRef = useRef(false);
  const lastSpotChartInferSlugRef = useRef<string | null>(null);
  const [spotChartLane, setSpotChartLane] = useState<'up' | 'down'>(() =>
    inferDefaultSpotChartLane(spot, priceToBeat, probUp, probDown),
  );
  /** Once per slug, when PTB + spot exist, align book-flow lane with the tape (no permanent UP default). */
  useEffect(() => {
    if (spotChartLaneLockedRef.current) return;
    const s = (slug ?? '').trim();
    if (!s) return;
    if (priceToBeat == null || !Number.isFinite(priceToBeat) || spot.length < 1) return;
    if (lastSpotChartInferSlugRef.current === s) return;
    lastSpotChartInferSlugRef.current = s;
    setSpotChartLane(inferDefaultSpotChartLane(spot, priceToBeat, probUp, probDown));
  }, [slug, spot, priceToBeat, probUp, probDown]);
  const [machineVerdictSpot, setMachineVerdictSpot] = useState<SpotPtbMachineReadout | null>(null);
  const onMachineVerdictSpot = useCallback((r: SpotPtbMachineReadout | null) => {
    setMachineVerdictSpot(r);
  }, []);
  // Desk tape follows order-flow winning side when known, else trade card / chart toggle.
  // Reading the wrong outcome token made tape vote against DOWN INITIATE (felt "rigged").
  const deskTapeLane =
    machineVerdictSpot?.flowWinningLane ?? masterLane ?? spotChartLane;
  const tapeTokenId = deskTapeLane === 'up' ? upToken : downToken;
  const tapePrints = useRecentTapePrints({ conditionId, activeTokenId: tapeTokenId });
  const spotChartBookFlow = useMemo(() => {
    if (!idx || !books || !flowSeriesForSlug) return null;
    const up = books[idx.up];
    const down = books[idx.down];
    if (!up?.token || !down?.token || up.error || down.error) return null;
    const tok = spotChartLane === 'up' ? up.token : down.token;
    const s = flowSeriesForSlug[tok];
    return s && s.length ? s : null;
  }, [idx, books, flowSeriesForSlug, spotChartLane]);
  const [bandGaugeSpot, setBandGaugeSpot] = useState<SpotBandGaugeSnapshot | null>(null);
  const onBandGaugeSpot = useCallback((g: SpotBandGaugeSnapshot | null) => {
    setBandGaugeSpot(g);
  }, []);

  /** PTB band guide for the desk strip — aligned to book/tape winning side, not chart toggle alone. */
  const deskBandGauge = useMemo(() => {
    const flowLane = machineVerdictSpot?.flowWinningLane ?? machineVerdictSpot?.focusLane ?? null;
    if (!bandGaugeSpot || !flowLane || bandGaugeSpot.mode === flowLane) return bandGaugeSpot;
    const halfBand = (bandGaugeSpot.bandHi - bandGaugeSpot.bandLo) / 2;
    const conviction =
      bandGaugeSpot.separation === 'STRONG'
        ? 'STRONG SEPARATION'
        : bandGaugeSpot.separation === 'CLEAR'
          ? 'CLEAR SEPARATION'
          : 'WEAK SEPARATION';
    return computeSpotBandGaugeSnapshot({
      mode: flowLane,
      spot: bandGaugeSpot.spot,
      ptb: bandGaugeSpot.ptb,
      band: halfBand,
      conviction,
      slopeUsdPerMin: bandGaugeSpot.slopeUsdPerMin,
      distUsd: bandGaugeSpot.distUsd,
      proj30s: bandGaugeSpot.proj30s,
      upLabel,
      downLabel,
    });
  }, [
    bandGaugeSpot,
    machineVerdictSpot?.flowWinningLane,
    machineVerdictSpot?.focusLane,
    upLabel,
    downLabel,
  ]);
  // Tape velocity, polled per second so it ticks even when prints are stale.
  const [tapeClock, setTapeClock] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setTapeClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const tapeNowSpot: TapeVelocity = useMemo(
    () => computeTapeVelocity(tapePrints, { now: tapeClock }),
    [tapePrints, tapeClock],
  );
  const tradeLevelsSpot = useMemo(
    () =>
      resolveTradeLevelsForDirective({
        directive: tradeDirectiveSpot,
        laneEdges: machineVerdictSpot?.edges ?? null,
        crossProb: machineVerdictSpot?.crossProb ?? null,
        endsInMs: endsInMs ?? null,
      }),
    [tradeDirectiveSpot, machineVerdictSpot?.crossProb, machineVerdictSpot?.edges, endsInMs],
  );
  const [stabilitySpot, setStabilitySpot] = useState<DirectiveStability | null>(null);
  useEffect(() => {
    if (!tradeDirectiveSpot) return;
    setStabilitySpot((prev) => updateStability(prev, tradeDirectiveSpot, Date.now()));
  }, [tradeDirectiveSpot]);
  const discrepancySpot = useMemo(
    () => detectDirectiveDiscrepancy(tradeDirectiveSpot, machineVerdictSpot),
    [tradeDirectiveSpot, machineVerdictSpot],
  );
  // Re-entry guard — track previous directive in a ref so transitions stamp cool-down on the just-vacated lane.
  const [reEntryStateSpot, setReEntryStateSpot] = useState<ReEntryState | null>(null);
  const previousDirectiveSpotRef = useRef<TradeDirective | null>(null);
  useEffect(() => {
    if (!tradeDirectiveSpot) return;
    const prev = previousDirectiveSpotRef.current;
    setReEntryStateSpot((s) => updateReEntryState(s, tradeDirectiveSpot, prev, Date.now()));
    previousDirectiveSpotRef.current = tradeDirectiveSpot;
  }, [tradeDirectiveSpot]);
  const [reEntryNowSpot, setReEntryNowSpot] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setReEntryNowSpot(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const reEntryCheckSpot = useMemo(() => {
    if (!tradeDirectiveSpot || !reEntryStateSpot) return null;
    return checkReEntry(reEntryStateSpot, tradeDirectiveSpot, reEntryNowSpot);
  }, [tradeDirectiveSpot, reEntryStateSpot, reEntryNowSpot]);
  const sizingMultiplierSpot = useMemo(() => {
    if (!tradeDirectiveSpot) return null;
    return computeSizingMultiplier({
      stability: stabilitySpot,
      discrepancy: discrepancySpot,
      edges: machineVerdictSpot?.edges ?? null,
      lane: tradeDirectiveSpot.lane,
      cooldownActive: reEntryCheckSpot?.onCooldown ?? false,
    });
  }, [tradeDirectiveSpot, stabilitySpot, discrepancySpot, machineVerdictSpot?.edges, reEntryCheckSpot]);
  /** Mirrored from `PtbOpportunityModeChart` so the Answer card below matches chart No-Trade math. */
  const [chartNoTradeScore, setChartNoTradeScore] = useState<NoTradeScore | null>(null);
  useEffect(() => {
    setChartNoTradeScore(null);
  }, [slug]);
  /** Bump with "Reset desk" so the chart clears its embedded directive journal without a slug change. */
  const [deskResetKey, setDeskResetKey] = useState(0);
  const [deskSeed] = useState(() => {
    const b = readSignalsDeskBoot(slug);
    return {
      manualPositionLane: b.manualPositionLane,
      signalTakenAtMs: b.signalTakenAtMs,
      signalTakenMid01: b.signalTakenMid01,
      journal: refreshJournalStats(b.journal, Date.now()),
    };
  });
  const [journalSpot, setJournalSpot] = useState<DirectiveJournal>(deskSeed.journal);
  /** Operator confirms they took the trade entry signal — feeds chart `currentPositionLane` + exit strip. */
  const [manualPositionLane, setManualPositionLane] = useState<'up' | 'down' | null>(deskSeed.manualPositionLane);
  const manualPositionLaneRef = useRef<'up' | 'down' | null>(deskSeed.manualPositionLane);

  const dualWallFlow = useMemo(
    () =>
      computeDualOutcomeWallFlow({
        upBook: bookAbove,
        downBook: bookBelow,
        upLabel,
        downLabel,
        entryLane: tradeDirectiveSpot?.lane ?? manualPositionLane,
      }),
    [bookAbove, bookBelow, upLabel, downLabel, tradeDirectiveSpot?.lane, manualPositionLane],
  );

  /** Take signal / auto-trade: tag I hold only after wallet shows shares on that outcome. */
  const [pendingHoldLane, setPendingHoldLane] = useState<'up' | 'down' | null>(null);
  const [signalTakenAtMs, setSignalTakenAtMs] = useState<number | null>(deskSeed.signalTakenAtMs);
  const [signalTakenMid01, setSignalTakenMid01] = useState<number | null>(deskSeed.signalTakenMid01);
  const prevDeskSlugRef = useRef<string | null>(null);
  const [autoTradeOnDoThisNow, setAutoTradeOnDoThisNow] = useState(() => loadAutoTradeOnDoThisNow());
  const [autoTradeSizeSharesStr, setAutoTradeSizeSharesStr] = useState(() => String(loadAutoTradeSizeShares()));
  const [takeSignalStrategyIds, setTakeSignalStrategyIds] = useState(() => loadTakeSignalStrategyIds());
  const lastAutoTakeKeyRef = useRef<string | null>(null);
  const lastAutoTakeAtMsRef = useRef(0);
  const [stableTakePlanState, setStableTakePlanState] = useState<StableTakeSignalState | null>(null);

  const autoTradeSizeShares = useMemo(() => {
    const n = Number(autoTradeSizeSharesStr);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  }, [autoTradeSizeSharesStr]);

  const autoTradeExecOpts = useMemo((): ExecuteTakeSignalOpts | null => {
    if (autoTradeSizeShares == null) return null;
    return { submitBuy: true, sizeShares: autoTradeSizeShares, armSlTp: false, endsInMs };
  }, [autoTradeSizeShares, endsInMs]);

  useEffect(() => {
    if (autoTradeSizeShares == null) return;
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent(BPX_TRADE_SYNC_SIZE_SHARES_EVENT, { detail: { sizeShares: autoTradeSizeShares } }),
    );
  }, [autoTradeSizeShares]);

  /** Reload desk ack / chart lane when the market slug changes (not only on full remount). */
  useEffect(() => {
    const s = (slug ?? '').trim();
    const prev = prevDeskSlugRef.current;
    prevDeskSlugRef.current = s || null;
    if (prev == null || prev === s) return;

    setTradeDirectiveSpot(null);
    setSwitchForecastSpot(null);
    setChartNoTradeScore(null);
    lastAutoTakeKeyRef.current = null;
    spotChartLaneLockedRef.current = false;
    lastSpotChartInferSlugRef.current = null;
    setDeskResetKey((k) => k + 1);

    if (!s) {
      setManualPositionLane(null);
      setPendingHoldLane(null);
      setSignalTakenAtMs(null);
      setSignalTakenMid01(null);
      setJournalSpot(resetJournal());
      setSpotChartLane(inferDefaultSpotChartLane(spot, priceToBeat, probUp, probDown));
      return;
    }

    const b = readSignalsDeskBoot(s);
    setManualPositionLane(b.manualPositionLane);
    setPendingHoldLane(null);
    setSignalTakenAtMs(b.signalTakenAtMs);
    setSignalTakenMid01(b.signalTakenMid01);
    setJournalSpot(b.journal);
    setSpotChartLane(inferDefaultSpotChartLane(spot, priceToBeat, probUp, probDown));
  }, [slug, spot, priceToBeat, probUp, probDown]);

  useEffect(() => {
    const slugKey = slug?.trim();
    if (!slugKey || !tradeLevelsSpot || tradeLevelsSpot.collapsed) return;
    const entry01 =
      signalTakenMid01 != null && Number.isFinite(signalTakenMid01) && signalTakenMid01 > 0 && signalTakenMid01 < 1
        ? signalTakenMid01
        : tradeLevelsSpot.entry;
    dispatchSignalRiskLevels({
      slug: slugKey,
      lane: tradeLevelsSpot.lane,
      entry01,
      takeProfit01: tradeLevelsSpot.takeProfit,
      stopLoss01: tradeLevelsSpot.stopLoss,
      collapsed: false,
    });
  }, [slug, tradeLevelsSpot, signalTakenMid01]);

  /** Prints + velocity for the outcome the operator marked with **I hold** (not desk / chart lane). */
  const heldOutcomeTapeTokenId =
    manualPositionLane === 'up' ? upToken : manualPositionLane === 'down' ? downToken : null;
  const heldOutcomeTapePrints = useRecentTapePrints({
    conditionId,
    activeTokenId: heldOutcomeTapeTokenId?.trim() ? heldOutcomeTapeTokenId : null,
  });
  const heldOutcomeTapeVelocity: TapeVelocity = useMemo(
    () => computeTapeVelocity(heldOutcomeTapePrints, { now: tapeClock }),
    [heldOutcomeTapePrints, tapeClock],
  );
  const [switchForecastSpot, setSwitchForecastSpot] = useState<SwitchForecast | null>(null);
  useEffect(() => {
    if (slug == null || !String(slug).trim()) return;
    saveSignalsDeskPersist(String(slug).trim(), {
      manualPositionLane,
      signalTakenAtMs,
      signalTakenMid01,
      journal: journalSpot,
    });
  }, [slug, manualPositionLane, signalTakenAtMs, signalTakenMid01, journalSpot]);
  useEffect(() => {
    if (!tradeDirectiveSpot) return;
    setJournalSpot((prev) =>
      appendDirectiveToJournal(prev, tradeDirectiveSpot, machineVerdictSpot, Date.now()),
    );
  }, [tradeDirectiveSpot, machineVerdictSpot]);
  const incomingSwitchLevelsSpot = useMemo(() => {
    const sf = switchForecastSpot;
    const edges = machineVerdictSpot?.edges ?? null;
    if (!sf || sf.status !== 'SWITCH_INCOMING' || sf.incomingLane == null || !edges) return null;
    if (!tradeDirectiveSpot?.lane || tradeDirectiveSpot.lane === sf.incomingLane) return null;
    return suggestLevelsForLane({
      lane: sf.incomingLane,
      laneEdges: edges,
      crossProb: machineVerdictSpot?.crossProb ?? null,
      endsInMs: endsInMs ?? null,
    });
  }, [switchForecastSpot, tradeDirectiveSpot, machineVerdictSpot?.edges, machineVerdictSpot?.crossProb, endsInMs]);

  const executionSnapshotSpot = useMemo((): TradeExecutionSnapshot | null => {
    if (manualPositionLane == null) return null;
    return {
      endsInMs,
      switchForecast: switchForecastSpot,
      crossProb01: machineVerdictSpot?.crossProb ?? null,
      upLabel,
      downLabel,
      currentPositionLane: manualPositionLane,
      incomingSwitchLevels: incomingSwitchLevelsSpot,
    };
  }, [
    manualPositionLane,
    endsInMs,
    switchForecastSpot,
    machineVerdictSpot?.crossProb,
    upLabel,
    downLabel,
    incomingSwitchLevelsSpot,
  ]);

  const signalTakenPlaybookSpot = useMemo(() => {
    if (manualPositionLane == null) return null;
    return computeSignalTakenPlaybook({
      myLane: manualPositionLane,
      takenAtMs: signalTakenAtMs,
      directive: tradeDirectiveSpot,
      levels: tradeLevelsSpot,
      crossProb: machineVerdictSpot?.crossProb ?? null,
      endsInMs,
      forecast: switchForecastSpot,
      tape: tapeNowSpot,
      upLabel,
      downLabel,
    });
  }, [
    manualPositionLane,
    signalTakenAtMs,
    tradeDirectiveSpot,
    tradeLevelsSpot,
    machineVerdictSpot?.crossProb,
    endsInMs,
    switchForecastSpot,
    tapeNowSpot,
    upLabel,
    downLabel,
  ]);

  const heldSideDeskMetricsSpot = useMemo(() => {
    if (manualPositionLane == null) return null;
    return buildHeldSideDeskMetrics({
      myLane: manualPositionLane,
      heldAtMid01: signalTakenMid01,
      impliedMidUp01: trackingUpMid,
      impliedMidDown01: trackingDownMid,
      crossProb: machineVerdictSpot?.crossProb ?? null,
      agreementScore: machineVerdictSpot?.agreementScore ?? null,
      endsInMs: endsInMs ?? null,
      takenAtMs: signalTakenAtMs,
      nowMs: tapeClock,
      tape: heldOutcomeTapeVelocity,
      directive: tradeDirectiveSpot,
      upLabel,
      downLabel,
    });
  }, [
    manualPositionLane,
    trackingUpMid,
    trackingDownMid,
    machineVerdictSpot?.crossProb,
    machineVerdictSpot?.agreementScore,
    endsInMs,
    signalTakenAtMs,
    tapeClock,
    heldOutcomeTapeVelocity,
    tradeDirectiveSpot,
    signalTakenMid01,
    upLabel,
    downLabel,
  ]);

  const positionDeskAlertsSpot = useMemo(() => {
    if (manualPositionLane == null) return [];
    return buildPositionDeskAlerts({
      heldLane: manualPositionLane,
      directive: tradeDirectiveSpot,
      forecast: switchForecastSpot,
      tape: tapeNowSpot,
      upLabel,
      downLabel,
    });
  }, [manualPositionLane, tradeDirectiveSpot, switchForecastSpot, tapeNowSpot, upLabel, downLabel]);

  const onAckSignalLane = useCallback(
    (lane: 'up' | 'down' | null) => {
      setPendingHoldLane(null);
      manualPositionLaneRef.current = lane;
      setManualPositionLane(lane);
      if (lane == null) {
        setSignalTakenAtMs(null);
        setSignalTakenMid01(null);
      } else {
        setSignalTakenAtMs(Date.now());
        const mid01 = lane === 'up' ? trackingUpMid : trackingDownMid;
        setSignalTakenMid01(mid01 != null && Number.isFinite(mid01) && mid01 > 0 && mid01 < 1 ? mid01 : null);
        const s = slug?.trim();
        if (s) {
          window.dispatchEvent(
            new CustomEvent(BPX_SIGNALS_LANE_SYNC_EVENT, {
              detail: { slug: s, lane, force: true },
            }),
          );
        }
      }
    },
    [slug, trackingUpMid, trackingDownMid],
  );

  manualPositionLaneRef.current = manualPositionLane;

  /** Last card lane we pushed to the trade panel — avoids snapping back when operator taps DOWN on the panel. */
  const lastSyncedMasterLaneRef = useRef<'up' | 'down' | null>(null);
  const laneSyncTimerRef = useRef<number | null>(null);

  useEffect(() => {
    lastSyncedMasterLaneRef.current = null;
    if (laneSyncTimerRef.current != null) {
      window.clearTimeout(laneSyncTimerRef.current);
      laneSyncTimerRef.current = null;
    }
  }, [slug]);

  /** Sync trade panel when the **card lane changes** (debounced); never fight operator UP/DOWN taps. */
  useEffect(() => {
    const s = slug?.trim();
    if (!s) return;
    if (tradePanelPinned && tradePanelSlug?.trim() && tradePanelSlug.trim() !== s) return;

    const clearTimer = () => {
      if (laneSyncTimerRef.current != null) {
        window.clearTimeout(laneSyncTimerRef.current);
        laneSyncTimerRef.current = null;
      }
    };

    const prev = lastSyncedMasterLaneRef.current;
    const whipsaw = stabilitySpot?.whipsaw === true;
    if (
      !shouldSyncTradePanelToMasterLane({
        masterLane,
        previousMasterLane: prev,
        manualPositionLane,
        masterReady,
        whipsaw,
      })
    ) {
      clearTimer();
      return;
    }

    const pushLane = (lane: 'up' | 'down') => {
      lastSyncedMasterLaneRef.current = lane;
      window.dispatchEvent(
        new CustomEvent(BPX_SIGNALS_LANE_SYNC_EVENT, {
          detail: { slug: s, lane },
        }),
      );
    };

    if (prev === null) {
      clearTimer();
      if (masterLane) pushLane(masterLane);
      return;
    }

    clearTimer();
    laneSyncTimerRef.current = window.setTimeout(() => {
      laneSyncTimerRef.current = null;
      if (lastSyncedMasterLaneRef.current === masterLane) return;
      if (
        !shouldSyncTradePanelToMasterLane({
          masterLane,
          previousMasterLane: lastSyncedMasterLaneRef.current,
          manualPositionLane: manualPositionLaneRef.current,
          masterReady,
          whipsaw: stabilitySpot?.whipsaw === true,
        })
      ) {
        return;
      }
      if (masterLane) pushLane(masterLane);
    }, TRADE_PANEL_LANE_SYNC_DEBOUNCE_MS);

    return clearTimer;
  }, [
    slug,
    masterLane,
    masterReady,
    manualPositionLane,
    tradePanelPinned,
    tradePanelSlug,
    stabilitySpot?.whipsaw,
  ]);

  /** Uncheck “I hold · UP/DOWN” when the trade panel reports that outcome is flat. */
  useEffect(() => {
    const onClearHold = (ev: Event) => {
      const lane = (ev as CustomEvent<SignalsClearHoldDetail>).detail?.lane;
      if (lane == null) return;
      if (manualPositionLaneRef.current !== lane) return;
      onAckSignalLane(null);
    };
    window.addEventListener(BPX_SIGNALS_CLEAR_HOLD_EVENT, onClearHold);
    return () => window.removeEventListener(BPX_SIGNALS_CLEAR_HOLD_EVENT, onClearHold);
  }, [onAckSignalLane]);

  const clearPendingHoldLane = useCallback(() => setPendingHoldLane(null), []);

  useSignalsDeskHoldPositionSync({
    slug: slug ?? '',
    manualLane: manualPositionLane,
    pendingHoldLane,
    upToken,
    downToken,
    onAckLane: onAckSignalLane,
    onPendingHoldConsumed: clearPendingHoldLane,
  });

  const clearAllDeskHolds = useCallback(() => {
    clearAllSignalsDeskHolds();
    setManualPositionLane(null);
    setPendingHoldLane(null);
    setSignalTakenAtMs(null);
    setSignalTakenMid01(null);
    manualPositionLaneRef.current = null;
    const s = slug?.trim();
    if (s) {
      saveSignalsDeskPersist(s, {
        manualPositionLane: null,
        signalTakenAtMs: null,
        signalTakenMid01: null,
        journal: journalSpot,
      });
    }
  }, [slug, journalSpot]);

  const resetSignalsDesk = useCallback(() => {
    clearAllSignalsDeskHolds();
    const s = slug?.trim();
    if (s) clearSignalsDeskPersist(s);
    setManualPositionLane(null);
    setPendingHoldLane(null);
    setSignalTakenAtMs(null);
    setSignalTakenMid01(null);
    manualPositionLaneRef.current = null;
    setJournalSpot(resetJournal());
    setStabilitySpot(updateStability(null, tradeDirectiveSpot, Date.now()));
    setReEntryStateSpot(null);
    previousDirectiveSpotRef.current = null;
    setSwitchForecastSpot(null);
    spotChartLaneLockedRef.current = false;
    lastSpotChartInferSlugRef.current = null;
    setSpotChartLane(inferDefaultSpotChartLane(spot, priceToBeat, probUp, probDown));
    setDeskResetKey((k) => k + 1);
    dispatchResetPhantomPosition({
      slug: s ?? undefined,
      upToken: upToken?.trim() || undefined,
      downToken: downToken?.trim() || undefined,
    });
  }, [slug, tradeDirectiveSpot, spot, priceToBeat, probUp, probDown, upToken, downToken]);

  const spotChartLive = priceToBeat != null && spot.length >= 2;
  const [spotChartCall, setSpotChartCall] = useState<{
    lane: 'up' | 'down' | null;
    status: 'ENTER' | 'PREP' | 'WAIT';
    confidence: 'HIGH' | 'MED' | 'LOW';
    reason: string;
    enterWhen: string | null;
  } | null>(null);
  const [dualChartCall, setDualChartCall] = useState<{
    lane: 'up' | 'down';
    verdict: 'ENTER' | 'SCALP' | 'WATCH' | 'WAIT';
    gate: 'ARMED' | 'PARTIAL' | 'NOT_ARMED';
    enterLine: string | null;
    enterOnlyIf: string;
    go: boolean;
    laneLock: { lane: 'up' | 'down' | null; status: 'LOCKED' | 'FORMING' | 'WAIT'; confidence: 'HIGH' | 'MED' | 'LOW'; reason: string };
  } | null>(null);

  // Some child charts publish summaries on every render (objects in deps change).
  // Guard against infinite re-render loops by only accepting a summary when it actually changed.
  const lastSpotCallKeyRef = useRef<string>('');
  const lastDualCallKeyRef = useRef<string>('');
  const onSpotPrimaryCall = useMemo(
    () => (c: SpotEngineCall) => {
      const key = JSON.stringify(c);
      if (key === lastSpotCallKeyRef.current) return;
      lastSpotCallKeyRef.current = key;
      setSpotChartCall(c);
    },
    [],
  );
  const onDualSummary = useMemo(
    () => (s: DualEngineCall) => {
      const key = JSON.stringify(s);
      if (key === lastDualCallKeyRef.current) return;
      lastDualCallKeyRef.current = key;
      setDualChartCall(s);
    },
    [],
  );
  /** Dual implied chart vs Spot strip picked different outcome lanes — Cross-check CONFLICT. */
  const crossEngineLaneConflict = useMemo(
    () =>
      hasDual &&
      spotChartCall?.lane != null &&
      dualChartCall != null &&
      spotChartCall.lane !== dualChartCall.lane,
    [hasDual, spotChartCall, dualChartCall],
  );

  const deskPhysicsInput = useMemo((): EntryPhysicsInput => {
    const spotLast = spot.length ? spot[spot.length - 1]!.v : null;
    const pu = probUp.length ? probUp[probUp.length - 1]!.v : null;
    const pd = probDown.length ? probDown[probDown.length - 1]!.v : null;
    const band =
      priceToBeat != null && Number.isFinite(priceToBeat)
        ? Math.max(0.35, Math.abs(priceToBeat) * 0.00035)
        : 50;
    return {
      spot: spotLast,
      ptb: priceToBeat,
      bandUsd: band,
      entryLane: tradeDirectiveSpot?.lane ?? null,
      heldLane: manualPositionLane,
      flowWinningLane: machineVerdictSpot?.flowWinningLane ?? null,
      lastProbUp: pu,
      lastProbDown: pd,
      wallHeadline: machineVerdictSpot?.wallFlow?.headline ?? dualWallFlow?.headline ?? null,
      upLabel,
      downLabel,
      endsInMs: endsInMs ?? null,
      crossProb: machineVerdictSpot?.crossProb ?? null,
      levels: tradeLevelsSpot,
    };
  }, [
    spot,
    priceToBeat,
    probUp,
    probDown,
    tradeDirectiveSpot?.lane,
    manualPositionLane,
    machineVerdictSpot?.flowWinningLane,
    machineVerdictSpot?.wallFlow?.headline,
    machineVerdictSpot?.crossProb,
    dualWallFlow?.headline,
    upLabel,
    downLabel,
    endsInMs,
    tradeLevelsSpot,
  ]);

  const deskCausalInput = useMemo((): TradeCausalInput => {
    const spotLast = deskPhysicsInput.spot;
    const pu = deskPhysicsInput.lastProbUp;
    const pd = deskPhysicsInput.lastProbDown;
    return {
      spot: spotLast,
      ptb: deskPhysicsInput.ptb,
      bandUsd: deskPhysicsInput.bandUsd,
      entryLane: deskPhysicsInput.entryLane,
      upLabel,
      downLabel,
      lastProbUp: pu,
      lastProbDown: pd,
      machine: machineVerdictSpot,
      switchForecast: switchForecastSpot,
      bandGauge: deskBandGauge,
      wallFlow: machineVerdictSpot?.wallFlow ?? dualWallFlow ?? null,
      endsInMs: deskPhysicsInput.endsInMs,
      crossProb: deskPhysicsInput.crossProb,
      levels: deskPhysicsInput.levels,
    };
  }, [
    deskPhysicsInput,
    machineVerdictSpot,
    switchForecastSpot,
    deskBandGauge,
    dualWallFlow,
    upLabel,
    downLabel,
  ]);

  const entryPhysicsLine = useMemo(
    () => buildTradeCausalBrief(deskCausalInput) ?? buildEntryPhysicsBrief(deskPhysicsInput),
    [deskCausalInput, deskPhysicsInput],
  );

  const tradeCausalBlocks = useMemo(() => buildTradeCausalBlocks(deskCausalInput), [deskCausalInput]);

  const causalHeadline = useMemo(() => buildTradeCausalHeadline(deskCausalInput), [deskCausalInput]);

  const positionExitReadoutSpot = useMemo(() => {
    if (manualPositionLane == null) return null;
    const base = computePositionExitReadout({
      heldLane: manualPositionLane,
      directive: tradeDirectiveSpot,
      forecast: switchForecastSpot,
      tape: tapeNowSpot,
      upLabel,
      downLabel,
    });
    const physics = buildExitPhysicsBrief({ ...deskPhysicsInput, heldLane: manualPositionLane });
    if (!physics) return base;
    const detail = base.detail ? `${base.detail} ${physics}` : physics;
    return { ...base, detail: detail.length > 320 ? `${detail.slice(0, 317)}…` : detail };
  }, [
    manualPositionLane,
    tradeDirectiveSpot,
    switchForecastSpot,
    tapeNowSpot,
    upLabel,
    downLabel,
    deskPhysicsInput,
  ]);

  const operatorVerdictDesk = useMemo(
    () =>
      buildOperatorVerdict({
        directive: tradeDirectiveSpot,
        levels: tradeLevelsSpot,
        stability: stabilitySpot,
        discrepancy: discrepancySpot,
        reEntry: reEntryCheckSpot,
        sizingMultiplier: sizingMultiplierSpot,
        noTradeScore: chartNoTradeScore,
        crossEngineLaneConflict,
        crossCheckSpotLane: spotChartCall?.lane ?? null,
        crossCheckDualLane: dualChartCall?.lane ?? null,
      }),
    [
      tradeDirectiveSpot,
      tradeLevelsSpot,
      stabilitySpot,
      discrepancySpot,
      reEntryCheckSpot,
      sizingMultiplierSpot,
      chartNoTradeScore,
      crossEngineLaneConflict,
      spotChartCall?.lane,
      dualChartCall?.lane,
    ],
  );

  const deskSingleActionLive = useMemo(
    () =>
      computeDeskSingleAction({
        manualLane: manualPositionLane,
        exitReadout: positionExitReadoutSpot,
        verdict: operatorVerdictDesk,
        hasDirective: tradeDirectiveSpot != null,
        directive: tradeDirectiveSpot,
        levels: tradeLevelsSpot,
        upLabel,
        downLabel,
        bandGauge: deskBandGauge,
        flowWinningLane: machineVerdictSpot?.flowWinningLane ?? null,
        bookControl: machineVerdictSpot?.sensors.bookControl ?? null,
        wallHeadline: machineVerdictSpot?.wallFlow?.headline ?? dualWallFlow?.headline ?? null,
        wallBidWarnings: dualWallFlow?.bidWarnings ?? machineVerdictSpot?.wallFlow?.bidWarnings ?? [],
        physicsLine: entryPhysicsLine,
      }),
    [
      manualPositionLane,
      positionExitReadoutSpot,
      operatorVerdictDesk,
      tradeDirectiveSpot,
      tradeLevelsSpot,
      upLabel,
      downLabel,
      deskBandGauge,
      entryPhysicsLine,
      machineVerdictSpot?.flowWinningLane,
      machineVerdictSpot?.sensors.bookControl,
      dualWallFlow?.headline,
      machineVerdictSpot?.wallFlow?.headline,
    ],
  );

  const deskSingleActionLiveRef = useRef(deskSingleActionLive);
  deskSingleActionLiveRef.current = deskSingleActionLive;

  const [deskSingleActionSpot, setDeskSingleActionSpot] = useState<DeskSingleAction>(() => deskSingleActionLive);
  const deskSingleActionSpotRef = useRef(deskSingleActionSpot);
  deskSingleActionSpotRef.current = deskSingleActionSpot;

  const doThisNowFallTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  const doThisNowFallPendingRef = useRef<DeskSingleAction | null>(null);
  const lastDeskSlugForStripRef = useRef<string | null>(slug);

  const deskLiveSig = useMemo(
    () =>
      `${deskSingleActionLive.primary}\u0000${deskSingleActionLive.detail ?? ''}\u0000${deskSingleActionLive.tone}`,
    [deskSingleActionLive.primary, deskSingleActionLive.detail, deskSingleActionLive.tone],
  );

  /** Lane / action / verdict state — when this changes, always adopt live (no fall-hold). */
  const deskMeaningKey = useMemo(
    () =>
      [
        manualPositionLane ?? '-',
        tradeDirectiveSpot?.action ?? '-',
        tradeDirectiveSpot?.lane ?? '-',
        operatorVerdictDesk?.state ?? '-',
        operatorVerdictDesk?.bigVerb ?? '-',
        tradeLevelsSpot
          ? `${price01ToWholeCents(tradeLevelsSpot.entry)}|${price01ToWholeCents(tradeLevelsSpot.takeProfit)}|${price01ToWholeCents(tradeLevelsSpot.stopLoss)}`
          : '-',
      ].join('|'),
    [
      manualPositionLane,
      tradeDirectiveSpot?.action,
      tradeDirectiveSpot?.lane,
      operatorVerdictDesk?.state,
      operatorVerdictDesk?.bigVerb,
      tradeLevelsSpot?.entry,
      tradeLevelsSpot?.takeProfit,
      tradeLevelsSpot?.stopLoss,
    ],
  );

  const deskSingleActionDisplay = useStableDeskAction(deskSingleActionSpot, deskMeaningKey);

  useEffect(() => {
    if (lastDeskSlugForStripRef.current === slug) return;
    lastDeskSlugForStripRef.current = slug;
    if (doThisNowFallTimerRef.current != null) {
      window.clearTimeout(doThisNowFallTimerRef.current);
      doThisNowFallTimerRef.current = null;
    }
    doThisNowFallPendingRef.current = null;
    setDeskSingleActionSpot(deskSingleActionLiveRef.current);
  }, [slug]);

  useEffect(() => {
    if (doThisNowFallTimerRef.current != null) {
      window.clearTimeout(doThisNowFallTimerRef.current);
      doThisNowFallTimerRef.current = null;
    }
    doThisNowFallPendingRef.current = null;
    setDeskSingleActionSpot(deskSingleActionLiveRef.current);
  }, [deskMeaningKey]);

  useEffect(() => {
    const live = deskSingleActionLiveRef.current;
    const clearFallTimer = () => {
      if (doThisNowFallTimerRef.current != null) {
        window.clearTimeout(doThisNowFallTimerRef.current);
        doThisNowFallTimerRef.current = null;
      }
    };

    const liveWeak = deskActionIsWeakFall(live);
    const showing = deskSingleActionSpotRef.current;
    const showingWeak = deskActionIsWeakFall(showing);

    if (!liveWeak) {
      clearFallTimer();
      doThisNowFallPendingRef.current = null;
      if (
        showing.primary !== live.primary ||
        (showing.detail ?? '') !== (live.detail ?? '') ||
        showing.tone !== live.tone
      ) {
        setDeskSingleActionSpot(live);
      }
      return;
    }

    if (!showingWeak) {
      doThisNowFallPendingRef.current = live;
      if (doThisNowFallTimerRef.current == null) {
        doThisNowFallTimerRef.current = window.setTimeout(() => {
          doThisNowFallTimerRef.current = null;
          const pending = doThisNowFallPendingRef.current;
          doThisNowFallPendingRef.current = null;
          if (pending != null) setDeskSingleActionSpot(pending);
        }, DO_THIS_NOW_FALL_HOLD_MS);
      } else {
        doThisNowFallPendingRef.current = live;
      }
      return;
    }

    if (doThisNowFallTimerRef.current == null) {
      if (
        showing.primary !== live.primary ||
        (showing.detail ?? '') !== (live.detail ?? '') ||
        showing.tone !== live.tone
      ) {
        setDeskSingleActionSpot(live);
      }
    } else {
      doThisNowFallPendingRef.current = live;
    }
    // Do not clear the fall timer on every deskLiveSig tick — that reset the 28s hold forever.
  }, [deskLiveSig]);

  const [flowZonesOpen, setFlowZonesOpen] = useState(false);

  const ptbContext = useMemo(() => {
    if (priceToBeat == null || !Number.isFinite(priceToBeat) || spot.length < 2) return null;
    const pts = spot
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .slice(-320)
      .map((p) => ({ t: p.t, v: p.v }));
    if (pts.length < 2) return null;
    const candles = buildSpotCandles(pts, Math.min(64, Math.max(12, Math.floor(pts.length * 0.22))));
    const lastProbUpPt = probUp.length ? (probUp[probUp.length - 1]!.v ?? null) : null;
    const lastProbDownPt = probDown.length ? (probDown[probDown.length - 1]!.v ?? null) : null;
    const d = computePtbChartDerivatives({
      pts,
      candles,
      ptb: priceToBeat,
      lastProbUp: lastProbUpPt,
      lastProbDown: lastProbDownPt,
    });

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
  }, [priceToBeat, spot, probUp, probDown]);

  // Page-level composite score. Replaces the old `earlySetup` derivation —
  // entry readiness now comes from the chart's directive (master action),
  // and tape velocity feeds in directly so the score moves before spot ticks
  // confirm. Keeping `overallSignal` (vs deferring to the directive engine)
  // because it adds book-spread / volatility / chase-risk context that lives
  // on this page only.
  const overallSignal = useMemo(() => {
    if (!ptbContext) return null;

    const regime = ptbContext.structureEvent ?? 'unknown';
    const chop = regime === 'chop' || ptbContext.controlSignal === 'NO_EDGE';
    const vol = Math.max(0.01, ptbContext.atrLikeUsd ?? 0.01);
    const eps = Math.max(0.35, ptbContext.bandUsd);

    // Chase-risk heuristic: one big last move, but still near band (classic "one candle bait").
    const jumpAbs = Math.abs(ptbContext.lastDeltaUsd ?? 0);
    const nearBand = Math.abs(ptbContext.distanceUsd) <= eps * 1.1;
    const chaseRisk = !masterReady && jumpAbs >= Math.max(0.35, vol * 2.2) && nearBand;

    // Liquidity / execution risk from touch spread (wide spread makes "good" signals bleed).
    const touchUp = topOfBook(bookAbove);
    const touchDown = topOfBook(bookBelow);
    const touch = masterLane === 'down' ? touchDown : touchUp;
    const spread01 =
      touch?.bestBid != null && touch?.bestAsk != null && Number.isFinite(touch.bestBid) && Number.isFinite(touch.bestAsk)
        ? Math.max(0, touch.bestAsk - touch.bestBid)
        : null;
    const spreadCents = spread01 != null ? spread01 * 100 : null;
    const wideSpread = spreadCents != null && spreadCents >= 2.2;

    let score = 50;
    if (ptbContext.controlSignal === 'UP_CONTROL' || ptbContext.controlSignal === 'DOWN_CONTROL') score += 12;
    if (regime === 'break_and_hold') score += 16;
    if (regime === 'extension') score += 8;
    // Master action drives the readiness boost (was earlySetup in the old code).
    if (masterAction === 'INITIATE' || masterAction === 'ADD' || masterAction === 'FLIP') score += 14;
    else if (masterAction === 'HOLD') score += 6;
    if (chop) score -= 28;
    if (chaseRisk) score -= 14;
    if (wideSpread) score -= 10;

    // Tape velocity contribution — buys lead time vs spot ticks confirming.
    let tapeAdj = 0;
    if (tapeNowSpot.reliable) {
      if (tapeNowSpot.dominance === 'buy' && masterLane === 'up') tapeAdj += 8;
      else if (tapeNowSpot.dominance === 'sell' && masterLane === 'down') tapeAdj += 8;
      else if (tapeNowSpot.dominance === 'buy' && masterLane === 'down') tapeAdj -= 10;
      else if (tapeNowSpot.dominance === 'sell' && masterLane === 'up') tapeAdj -= 10;
      if (tapeNowSpot.burst === 'extreme' && tapeNowSpot.dominance !== 'mixed') tapeAdj += 4;
      else if (tapeNowSpot.burst === 'aggressive' && tapeNowSpot.dominance !== 'mixed') tapeAdj += 2;
    }
    score += tapeAdj;

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
      tapeNowSpot.reliable && tapeNowSpot.dominance !== 'mixed'
        ? `DESK ${tapeNowSpot.dominance.toUpperCase()}`
        : null,
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
    if (masterAction === 'INITIATE' || masterAction === 'ADD' || masterAction === 'FLIP') {
      scoreReasons.push(`Trade card ${masterAction}: +14`);
    } else if (masterAction === 'HOLD') {
      scoreReasons.push('Trade card HOLD: +6');
    } else {
      scoreReasons.push(`Trade card ${masterAction}.`);
    }
    if (chop) scoreReasons.push('Chop / no-edge penalty: −28');
    if (chaseRisk) scoreReasons.push('Chase-risk (large last move near band): −14');
    if (wideSpread) scoreReasons.push(`Wide touch spread${spreadCents != null ? ` ~${spreadCents.toFixed(1)}¢` : ''}: −10`);
    if (tapeAdj !== 0) {
      scoreReasons.push(`Desk tape (${tapeNowSpot.dominance}/${tapeNowSpot.burst}): ${tapeAdj >= 0 ? '+' : ''}${tapeAdj}`);
    }
    if (sepAdj !== 0) scoreReasons.push(`Distance vs band (normalized): ${sepAdj >= 0 ? '+' : ''}${sepAdj.toFixed(1)}`);
    if (slopeAdj !== 0) scoreReasons.push(`Slope vs vol (normalized): ${slopeAdj >= 0 ? '+' : ''}${slopeAdj.toFixed(1)}`);
    scoreReasons.push(`Final score ${score} → ${verdict}.`);

    return { score, verdict, flags, spreadCents, chaseRisk, wideSpread, chop, scoreReasons } as const;
  }, [bookAbove, bookBelow, masterAction, masterLane, masterReady, ptbContext, tapeNowSpot]);

  // Compact score card. The old `ptbSignalCard` duplicated regime/control/slope tiles
  // already rendered inside `MachineVerdictCard`, plus a debounced "direction call" that
  // contradicted the directive. Now this card shows ONLY the page-level composite score
  // and "Why this score?" disclosure — primary direction lives in TradeDirectiveCard.
  const signalScoreCard = overallSignal ? (
    <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Signal score</div>
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
            title="Composite of regime + structure + slope + chase/liquidity risk + tape velocity"
          >
            {overallSignal.verdict} · {overallSignal.score}/100
          </div>
          {overallSignal.flags.length ? (
            overallSignal.flags.slice(0, 4).map((f) => (
              <span
                key={f}
                className="rounded-md border border-zinc-800/70 bg-zinc-950/30 px-2 py-0.5 text-[10px] font-semibold text-zinc-300"
              >
                {f}
              </span>
            ))
          ) : (
            <span className="text-[11px] font-semibold text-zinc-500">clean</span>
          )}
        </div>
      </div>
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
  ) : null;

  // ─── Lane Agreement Bar ─────────────────────────────────────────────────
  // 3-dot strip showing whether the directive, the machine vote, and the tape
  // all point the same way. Replaces the implicit "which of 5 lanes do I trust"
  // confusion with one explicit visual.
  const laneAgreement = useMemo(() => {
    const directiveLane: 'up' | 'down' | null = masterLane;
    const voteLane: 'up' | 'down' | null = machineVerdictSpot?.focusLane ?? null;
    const tapeLane: 'up' | 'down' | null =
      tapeNowSpot.reliable ? tapeLaneVote(deskTapeLane, tapeNowSpot.dominance) : null;
    const lanes: Array<'up' | 'down' | null> = [directiveLane, voteLane, tapeLane];
    const agreeUp = lanes.filter((l) => l === 'up').length;
    const agreeDown = lanes.filter((l) => l === 'down').length;
    const known = lanes.filter((l) => l != null).length;
    const winner: 'up' | 'down' | null = agreeUp > agreeDown ? 'up' : agreeDown > agreeUp ? 'down' : null;
    const aligned = winner != null ? (winner === 'up' ? agreeUp : agreeDown) : 0;
    let tier: 'STRONG' | 'AGREE' | 'MIXED' | 'IDLE';
    if (known === 0) tier = 'IDLE';
    else if (aligned === 3) tier = 'STRONG';
    else if (aligned === 2) tier = 'AGREE';
    else tier = 'MIXED';
    return { directiveLane, voteLane, tapeLane, winner, tier, agreeUp, agreeDown };
  }, [masterLane, machineVerdictSpot?.focusLane, tapeNowSpot.dominance, tapeNowSpot.reliable, deskTapeLane]);

  function laneDot(label: string, lane: 'up' | 'down' | null): ReactElement {
    const cls =
      lane === 'up'
        ? 'border-emerald-500/55 bg-emerald-950/40 text-emerald-100'
        : lane === 'down'
          ? 'border-rose-500/55 bg-rose-950/35 text-rose-100'
          : 'border-zinc-700/60 bg-zinc-900/30 text-zinc-500';
    const sym = lane === 'up' ? '▲ UP' : lane === 'down' ? '▼ DOWN' : '— —';
    return (
      <span
        key={label}
        className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-bold tracking-wide ${cls}`}
        title={`${label}: ${sym}`}
      >
        <span className="text-[9px] uppercase tracking-[0.14em] opacity-75">{label}</span>
        <span>{sym}</span>
      </span>
    );
  }

  const laneAgreementBar = (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 ${
        laneAgreement.tier === 'STRONG'
          ? laneAgreement.winner === 'up'
            ? 'border-emerald-500/55 bg-emerald-950/30'
            : 'border-rose-500/55 bg-rose-950/25'
          : laneAgreement.tier === 'AGREE'
            ? 'border-amber-500/35 bg-amber-950/15'
            : laneAgreement.tier === 'MIXED'
              ? 'border-rose-700/45 bg-rose-950/15'
              : 'border-zinc-800/60 bg-zinc-950/35'
      }`}
      title={
        laneAgreement.tier === 'MIXED'
          ? 'Sensors disagree on direction — wait for them to align.'
          : laneAgreement.tier === 'STRONG'
            ? 'All three sensors point the same way.'
            : laneAgreement.tier === 'AGREE'
              ? 'Two of three sensors agree — directional but not unanimous.'
              : 'Sensors not yet decisive — often waiting on tape volume or a clear lane on the trade card.'
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        {laneDot('Card', laneAgreement.directiveLane)}
        {laneDot('Vote', laneAgreement.voteLane)}
        {laneDot('Desk tape', laneAgreement.tapeLane)}
      </div>
      <div
        className={`rounded-md border px-2 py-1 text-[10px] font-black tracking-wide ${
          laneAgreement.tier === 'STRONG'
            ? laneAgreement.winner === 'up'
              ? 'border-emerald-400/55 bg-emerald-900/40 text-emerald-50'
              : 'border-rose-400/55 bg-rose-900/35 text-rose-50'
            : laneAgreement.tier === 'AGREE'
              ? 'border-amber-500/45 bg-amber-900/25 text-amber-100'
              : laneAgreement.tier === 'MIXED'
                ? 'border-rose-600/45 bg-rose-900/20 text-rose-100'
                : 'border-zinc-700/70 bg-zinc-800/40 text-zinc-300'
        }`}
      >
        {laneAgreement.tier}
        {laneAgreement.winner ? ` · ${laneAgreement.winner.toUpperCase()}` : ''}
      </div>
    </div>
  );

  const crossCheckMeta = useMemo(
    () => synthesizeCrossCheck(spotChartCall, dualChartCall, upLabel, downLabel),
    [spotChartCall, dualChartCall, upLabel, downLabel],
  );

  const crossCheckWarn = crossCheckMeta.pill === 'CONFLICT' || crossCheckMeta.pill === 'INCOMPLETE';
  const [crossCheckOpen, setCrossCheckOpen] = useState(crossCheckWarn);
  const prevCrossPillRef = useRef(crossCheckMeta.pill);
  useLayoutEffect(() => {
    const p = crossCheckMeta.pill;
    if (crossCheckWarn && prevCrossPillRef.current !== p) setCrossCheckOpen(true);
    prevCrossPillRef.current = p;
  }, [crossCheckMeta.pill, crossCheckWarn]);

  // Inline cross-engine strip — replaces the old `xcheck` chart tab. One-line by
  // default; click to expand the full Spot / Dual call breakdown without leaving
  // the main view.
  const crossCheckStrip = (
    <details
      className={`rounded-xl border ${crossCheckToneClass(crossCheckMeta.tone)}`}
      open={crossCheckOpen}
      onToggle={(e) => setCrossCheckOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-semibold tracking-wide hover:opacity-90 [&::-webkit-details-marker]:hidden">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-zinc-500/90" aria-hidden>▸</span>
            <span className="text-[9px] font-bold uppercase tracking-[0.16em] opacity-70">Cross-check</span>
            <span className="rounded-md border border-current/40 bg-black/30 px-2 py-0.5 text-[10px] font-extrabold tracking-wide">
              {crossCheckMeta.pill}
            </span>
          </div>
          <span className="min-w-0 truncate text-[11px] font-semibold opacity-90">{crossCheckMeta.title}</span>
        </div>
      </summary>
      <div className="border-t border-zinc-800/40 p-3">
        <ul className="list-disc space-y-1.5 pl-4 text-[11px] leading-relaxed text-zinc-300">
          {crossCheckMeta.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {spotBookAlignment ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-zinc-800/50 pt-2 text-[10px] leading-snug text-zinc-500">
            <span className="font-semibold uppercase tracking-[0.14em] text-zinc-500">Book vs spot</span>
            <span
              className={`rounded-md border px-2 py-0.5 font-mono font-semibold ${
                spotBookAlignment.align === 'ALIGNED'
                  ? 'border-emerald-800/50 bg-emerald-950/20 text-emerald-200/90'
                  : spotBookAlignment.align === 'DIVERGENT'
                    ? 'border-rose-800/50 bg-rose-950/25 text-rose-200/90'
                    : 'border-zinc-700/60 bg-zinc-950/30 text-zinc-300'
              }`}
            >
              {spotBookAlignment.align}
            </span>
            <span className="min-w-0 text-zinc-600">
              Underlying {spotBookAlignment.above ? 'above PTB' : spotBookAlignment.below ? 'below PTB' : 'near PTB'} · implied {upLabel}{' '}
              {spotBookAlignment.mU.toFixed(3)} · {downLabel} {spotBookAlignment.mD.toFixed(3)}
            </span>
          </div>
        ) : null}
        <div className="mt-2 grid gap-2 lg:grid-cols-2">
          <div className="rounded-lg border border-zinc-800/60 bg-black/25 p-2">
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Spot vs PTB</div>
            {spotChartCall ? (
              <>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className="rounded-md border border-zinc-800/70 bg-black/30 px-1.5 py-0.5 text-[10px] font-extrabold text-zinc-100">
                    {spotChartCall.status}
                  </span>
                  <span className="rounded-md border border-zinc-800/70 bg-black/30 px-1.5 py-0.5 text-[10px] font-mono text-zinc-200">
                    {spotChartCall.lane ? (spotChartCall.lane === 'up' ? upLabel : downLabel) : 'NO SIDE'}
                  </span>
                  <span className="rounded-md border border-zinc-800/70 bg-black/30 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400">
                    {spotChartCall.confidence}
                  </span>
                </div>
                <p className="mt-1 text-[10px] leading-snug text-zinc-400">{spotChartCall.reason}</p>
              </>
            ) : (
              <div className="mt-1 text-[10px] text-zinc-500">Waiting for spot/PTB chart to load.</div>
            )}
          </div>
          <div className="rounded-lg border border-zinc-800/60 bg-black/25 p-2">
            <div className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Dual PTB</div>
            {dualChartCall ? (
              <>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <span className="rounded-md border border-zinc-800/70 bg-black/30 px-1.5 py-0.5 text-[10px] font-extrabold text-zinc-100">
                    {dualChartCall.verdict}
                  </span>
                  <span className="rounded-md border border-zinc-800/70 bg-black/30 px-1.5 py-0.5 text-[10px] font-mono text-zinc-200">
                    {dualChartCall.lane === 'up' ? upLabel : downLabel}
                  </span>
                  <span className="rounded-md border border-zinc-800/70 bg-black/30 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400">
                    gate {dualChartCall.gate.replace('_', ' ')}
                  </span>
                  <span
                    className={`rounded-md border px-1.5 py-0.5 text-[10px] font-extrabold ${
                      dualChartCall.go
                        ? 'border-emerald-700/50 bg-emerald-950/25 text-emerald-200'
                        : 'border-zinc-700/60 bg-zinc-950/20 text-zinc-300'
                    }`}
                  >
                    {dualChartCall.go ? 'GO' : 'WAIT'}
                  </span>
                </div>
                <p className="mt-1 text-[10px] leading-snug text-zinc-400">{dualChartCall.enterOnlyIf}</p>
              </>
            ) : (
              <div className="mt-1 text-[10px] text-zinc-500">Waiting for dual chart to load.</div>
            )}
          </div>
        </div>
      </div>
    </details>
  );

  const deskActionForTake = useMemo(
    () => pickDeskActionForTake(deskSingleActionSpot, deskSingleActionLive),
    [deskSingleActionSpot, deskSingleActionLive],
  );

  const takeSignalPlanBase = useMemo(
    () =>
      buildTakeSignalPlan({
        verdict: operatorVerdictDesk,
        directive: tradeDirectiveSpot,
        levels: tradeLevelsSpot,
        crossEngineLaneConflict,
        deskAction: deskActionForTake,
        machine: machineVerdictSpot,
        endsInMs,
        slug,
        upLabel,
        downLabel,
      }),
    [
      operatorVerdictDesk,
      tradeDirectiveSpot,
      tradeLevelsSpot,
      crossEngineLaneConflict,
      deskActionForTake,
      machineVerdictSpot,
      endsInMs,
      slug,
      upLabel,
      downLabel,
    ],
  );

  const takeSignalStrategyCtx = useMemo(
    () => ({
      verdict: operatorVerdictDesk,
      directive: tradeDirectiveSpot,
      machine: machineVerdictSpot,
      noTradeScore: chartNoTradeScore,
      crossEngineLaneConflict,
      deskAction: deskActionForTake,
      tape: tapeNowSpot,
      slug,
      upLabel,
      downLabel,
      wallFlow: machineVerdictSpot?.wallFlow ?? dualWallFlow ?? null,
    }),
    [
      operatorVerdictDesk,
      tradeDirectiveSpot,
      machineVerdictSpot,
      chartNoTradeScore,
      crossEngineLaneConflict,
      deskActionForTake,
      tapeNowSpot,
      slug,
      upLabel,
      downLabel,
      dualWallFlow,
    ],
  );

  const takeSignalPlanFiltered = useMemo(
    () => applyTakeSignalStrategies(takeSignalPlanBase, takeSignalStrategyCtx, takeSignalStrategyIds),
    [takeSignalPlanBase, takeSignalStrategyCtx, takeSignalStrategyIds],
  );

  useEffect(() => {
    setStableTakePlanState((prev) => updateStableTakeSignalPlan(prev, takeSignalPlanFiltered, Date.now()));
  }, [takeSignalPlanFiltered]);

  useEffect(() => {
    setStableTakePlanState(null);
    lastAutoTakeKeyRef.current = null;
    lastAutoTakeAtMsRef.current = 0;
  }, [slug]);

  const takeSignalPlanSpot = useMemo(
    () =>
      applyTakeSignalStabilityGate(
        stableTakePlanState?.displayed ?? takeSignalPlanFiltered,
        stabilitySpot,
        tradeDirectiveSpot,
      ),
    [stableTakePlanState?.displayed, takeSignalPlanFiltered, stabilitySpot, tradeDirectiveSpot],
  );

  const fivePctGainActive = takeSignalStrategyIds.includes('five-pct-gain');

  const fivePctGainEval = useMemo(() => {
    if (!fivePctGainActive) return null;
    return evaluateFivePctGainStrategy({
      lane: takeSignalPlanBase.lane,
      entry01: takeSignalPlanBase.entry01,
      directive: tradeDirectiveSpot,
      machine: machineVerdictSpot,
      tape: tapeNowSpot,
      wallFlow: machineVerdictSpot?.wallFlow ?? dualWallFlow ?? null,
      slug,
      upLabel,
      downLabel,
    });
  }, [
    fivePctGainActive,
    takeSignalPlanBase.lane,
    takeSignalPlanBase.entry01,
    tradeDirectiveSpot,
    machineVerdictSpot,
    tapeNowSpot,
    dualWallFlow,
    slug,
    upLabel,
    downLabel,
  ]);

  const onToggleTakeSignalStrategy = useCallback((id: TakeSignalStrategyId, enabled: boolean) => {
    setTakeSignalStrategyIds((prev) => {
      const next = toggleTakeSignalStrategyId(prev, id, enabled);
      saveTakeSignalStrategyIds(next);
      return next;
    });
    lastAutoTakeKeyRef.current = null;
  }, []);

  const takeSignalPhysicsHint = useMemo(
    () =>
      buildTakeSignalPhysicsHint({
        ...deskPhysicsInput,
        entryLane: takeSignalPlanSpot.lane ?? deskPhysicsInput.entryLane,
        levels:
          takeSignalPlanSpot.lane && tradeLevelsSpot?.lane === takeSignalPlanSpot.lane
            ? tradeLevelsSpot
            : deskPhysicsInput.levels,
      }),
    [deskPhysicsInput, takeSignalPlanSpot.lane, tradeLevelsSpot],
  );

  const marketInterval = useMemo(() => (slug?.trim() ? parseUpdownSlug(slug.trim())?.interval : null), [slug]);
  const usesFiveMinBellGate = marketUsesFiveMinuteExecuteGate(slug, endsInMs);

  const autoTradeBlockReason = useMemo((): string | null => {
    if (!autoTradeOnDoThisNow) return null;
    if (autoTradeExecOpts == null) return 'Enter a valid share size above.';
    const timerBlock = roundTimerExecuteBlockReason(endsInMs, slug);
    if (timerBlock) return timerBlock;
    const plan = takeSignalPlanSpot;
    if (!plan.canTake) return plan.disabledReason ?? 'Take signal not ready — wait for ENTER on the card.';
    if (manualPositionLane === plan.lane) return `Already tagged I hold · ${plan.lane === 'up' ? upLabel : downLabel}.`;
    return null;
  }, [
    autoTradeOnDoThisNow,
    autoTradeExecOpts,
    endsInMs,
    slug,
    takeSignalPlanSpot,
    manualPositionLane,
    upLabel,
    downLabel,
  ]);

  const onTakeSignalNow = useCallback(
    (opts?: ExecuteTakeSignalOpts) => {
      const plan = takeSignalPlanSpot;
      if (!plan.canTake || !plan.lane) return;
      const sizeShares = opts?.sizeShares ?? autoTradeSizeShares;
      const live = loadTradeAccountMode() === 'live';
      const wantsBuy = opts?.submitBuy ?? (live && sizeShares != null && sizeShares > 0);
      const exec: ExecuteTakeSignalOpts = {
        ...(opts ?? {}),
        endsInMs,
        sizeShares: sizeShares ?? undefined,
        submitBuy: wantsBuy,
        armSlTp: opts?.armSlTp ?? false,
      };
      if (wantsBuy && !(sizeShares != null && sizeShares > 0)) return;
      const result = executeTakeSignal(plan, slug, exec);
      if (wantsBuy && !result.buySubmitted) {
        const reason =
          result.buySkippedReason ??
          (!live ? 'Paper mode — switch to Live in the trade panel to auto-buy.' : 'Buy was not submitted.');
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent(BPX_DESK_TOAST_EVENT, {
              detail: { kind: 'info' as const, message: reason, ttlMs: 7200 },
            }),
          );
        }
      }
      setPendingHoldLane(plan.lane);
    },
    [takeSignalPlanSpot, slug, autoTradeSizeShares, endsInMs],
  );

  useEffect(() => {
    lastAutoTakeKeyRef.current = null;
  }, [slug]);

  useEffect(() => {
    if (!autoTradeOnDoThisNow) return;
    const plan = takeSignalPlanSpot;
    if (!plan.canTake || !plan.lane || plan.entry01 == null) return;
    if (!roundTimerAllowsExecute(endsInMs, slug)) return;
    if (!autoTradeExecOpts) return;
    if (manualPositionLane === plan.lane) return;

    const now = Date.now();
    if (now - lastAutoTakeAtMsRef.current < AUTO_TRADE_COOLDOWN_MS) return;

    const sizeKey = autoTradeExecOpts.sizeShares != null ? String(autoTradeExecOpts.sizeShares) : '';
    const key = `${slug ?? ''}|${takeSignalPlanMeaningKey(plan)}|${sizeKey}`;
    if (lastAutoTakeKeyRef.current === key) return;
    lastAutoTakeKeyRef.current = key;
    lastAutoTakeAtMsRef.current = now;

    executeTakeSignal(plan, slug, autoTradeExecOpts);
    setPendingHoldLane(plan.lane);
  }, [
    autoTradeOnDoThisNow,
    autoTradeExecOpts,
    takeSignalPlanSpot,
    slug,
    endsInMs,
    manualPositionLane,
  ]);

  /** Clear stale “filling…” if auto-buy never landed shares. */
  useEffect(() => {
    if (pendingHoldLane == null) return;
    const lane = pendingHoldLane;
    const id = window.setTimeout(() => {
      setPendingHoldLane((p) => (p === lane && manualPositionLaneRef.current !== lane ? null : p));
    }, 120_000);
    return () => window.clearTimeout(id);
  }, [pendingHoldLane]);

  const onAutoTradeToggle = useCallback((enabled: boolean) => {
    setAutoTradeOnDoThisNow(enabled);
    saveAutoTradeOnDoThisNow(enabled);
    if (!enabled) lastAutoTakeKeyRef.current = null;
  }, []);

  const deskSingleActionSkin = useMemo(() => {
    const t = deskSingleActionDisplay.tone;
    if (t === 'rose') {
      return 'border-rose-500/60 bg-rose-950/45 ring-2 ring-rose-500/35 text-rose-50 shadow-lg shadow-rose-950/20';
    }
    if (t === 'emerald') {
      return 'border-emerald-600/55 bg-emerald-950/35 ring-1 ring-emerald-800/40 text-emerald-50';
    }
    if (t === 'green') {
      return 'border-emerald-500/55 bg-emerald-950/25 ring-1 ring-emerald-800/35 text-emerald-50';
    }
    if (t === 'red') {
      return 'border-rose-600/55 bg-rose-950/30 ring-1 ring-rose-800/40 text-rose-50';
    }
    if (t === 'amber') {
      return 'border-amber-500/55 bg-amber-950/30 ring-1 ring-amber-800/35 text-amber-50';
    }
    if (t === 'blue') {
      return 'border-indigo-500/50 bg-indigo-950/30 ring-1 ring-indigo-900/40 text-indigo-50';
    }
    return 'border-zinc-600/60 bg-zinc-900/55 ring-1 ring-zinc-800/45 text-zinc-100';
  }, [deskSingleActionDisplay.tone]);

  const spotVsPtbSection = (
    <div className="flex min-h-0 w-full min-w-0 flex-col gap-2">
      {/* Chart first — directive / verdict cards used to sit above and pushed it too far down. */}
      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
        <PtbOpportunityModeChart
          slug={slug}
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
          probUp={probUp}
          probDown={probDown}
          probLastUpdateMs={probLastUpdateMs}
          bookFlow={spotChartBookFlow}
          upOutcomeToken={upToken}
          downOutcomeToken={downToken}
          ptbSource={ptbSource}
          spotFeedSource={spotFeedSource}
          onPrimaryCall={onSpotPrimaryCall}
          onMachineReadout={onMachineVerdictSpot}
          onBandGaugeSnapshot={onBandGaugeSpot}
          onTradeDirective={onTradeDirectiveSpot}
          currentPositionLane={manualPositionLane}
          onSwitchForecast={setSwitchForecastSpot}
          recentPrints={tapePrints}
          tapeLane={deskTapeLane}
          chartAreaRoomy
          signalsEmbed
          onNoTradeScore={setChartNoTradeScore}
          deskResetKey={deskResetKey}
          wallFlow={dualWallFlow}
        />
      </div>
      {/* Lane-agreement bar — card · vote · desk tape — sits directly under the chart so
          the operator's first read is "do my sensors agree?" */}
      {laneAgreementBar}
      {/* Cross-engine strip (only when both engines are loaded). Inline collapsible —
          no more separate Cross-check tab. */}
      {hasDual ? crossCheckStrip : null}
      <div className="rounded-xl border border-sky-900/35 bg-sky-950/20 px-3 py-2 text-[10px] leading-snug text-sky-100/95">
        <span className="font-extrabold uppercase tracking-wide text-sky-200">Math · </span>
        <span className="font-semibold text-zinc-100">{upLabel}</span> / <span className="font-semibold text-zinc-100">{downLabel}</span> are{' '}
        <span className="font-semibold text-zinc-100">outcome tokens</span> on Polymarket (priced 0–100¢). The bell compares{' '}
        <span className="font-semibold text-zinc-100">settlement spot vs price-to-beat (PTB)</span>.{' '}
        <span className="font-semibold text-zinc-100">Do this now</span> = trade card action + entry/TP/SL on that token.{' '}
        <span className="font-semibold text-zinc-100">Sensor strip</span> = who controls the book (walls, mids, tape) — can disagree with spot vs PTB; follow the physics line when they fight.
      </div>
      <div className={`rounded-2xl border px-4 py-3.5 min-h-[12rem] ${deskSingleActionSkin}`}>
        <div className="text-[9px] font-black uppercase tracking-[0.22em] text-white/45">Do this now</div>
        <p className="mt-1 min-h-[1.35em] text-[clamp(1.08rem,3.6vw,1.5rem)] font-black leading-[1.15] tracking-tight">
          {deskSingleActionDisplay.primary}
        </p>
        <div className="mt-2 min-h-[2.75rem]">
          {deskSingleActionDisplay.physicsLine ? (
            <p className="rounded-lg border border-white/10 bg-black/25 px-2.5 py-2 text-[11px] font-medium leading-snug text-white/90">
              <span className="font-black uppercase tracking-wide text-white/50">Causal · </span>
              {deskSingleActionDisplay.physicsLine}
            </p>
          ) : null}
        </div>
        <div className="min-h-[1.25rem]">
          {deskSingleActionDisplay.detail ? (
            <p className="mt-2 text-[11px] font-semibold leading-snug text-white/70">{deskSingleActionDisplay.detail}</p>
          ) : null}
        </div>
        <div className="min-h-[2.25rem]">
          {deskSingleActionDisplay.wallBidWarning ? (
            <p className="mt-2 rounded-lg border border-amber-500/50 bg-amber-950/40 px-2.5 py-2 text-[10px] font-bold leading-snug text-amber-100">
              <span className="uppercase tracking-wide text-amber-200/90">Wall bid warning · </span>
              {deskSingleActionDisplay.wallBidWarning}
            </p>
          ) : null}
        </div>
        <TakeSignalNowButton
          plan={takeSignalPlanSpot}
          sizeShares={autoTradeSizeShares ?? 0}
          onTake={() => onTakeSignalNow()}
          physicsHint={takeSignalPhysicsHint}
        />
        <TakeSignalStrategyPanel
          activeIds={takeSignalStrategyIds}
          onToggle={onToggleTakeSignalStrategy}
          blockHint={
            takeSignalStrategyIds.length > 0 && !takeSignalPlanSpot.canTake && takeSignalPlanSpot.disabledReason
              ? takeSignalPlanSpot.disabledReason
              : null
          }
        />
        <FivePctGainSignalCard
          active={fivePctGainActive}
          signal={fivePctGainEval?.signal ?? null}
          blockedReason={fivePctGainEval?.ok ? null : fivePctGainEval?.reason ?? null}
        />
        <div className="mt-2.5 space-y-2 rounded-lg border border-zinc-700/40 bg-black/20 px-3 py-2">
          <label className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-400">Auto-trade size</span>
            <span className="text-[10px] text-zinc-500">shares</span>
          </label>
          <input
            type="number"
            min={0.1}
            step={0.1}
            inputMode="decimal"
            value={autoTradeSizeSharesStr}
            onChange={(e) => setAutoTradeSizeSharesStr(e.target.value)}
            onBlur={() => {
              const n = Number(autoTradeSizeSharesStr);
              if (!Number.isFinite(n) || n <= 0) {
                setAutoTradeSizeSharesStr(String(loadAutoTradeSizeShares()));
                return;
              }
              saveAutoTradeSizeShares(n);
            }}
            className="w-full min-h-[36px] rounded-lg border border-zinc-700/60 bg-zinc-950/60 px-3 text-right font-mono text-sm font-bold tabular-nums text-zinc-100 outline-none focus:border-emerald-600/50"
          />
          <label className="flex cursor-pointer items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0 accent-emerald-500"
              checked={autoTradeOnDoThisNow}
              onChange={(e) => onAutoTradeToggle(e.target.checked)}
            />
            <span className="text-[10px] leading-snug text-zinc-300">
              <span className="font-bold text-emerald-200/95">Auto-trade on Do this now</span>
              {' — '}
              when the strip flips to green <span className="font-semibold text-zinc-100">ENTER UP/DOWN</span>
              {usesFiveMinBellGate ? (
                <>
                  {' '}
                  and the bell is under <span className="font-mono font-semibold text-zinc-100">5:00</span>
                </>
              ) : marketInterval === '15m' ? (
                <> (15m round — no 5:00 wait)</>
              ) : null}
              , submit a limit buy at
              card entry for <span className="font-mono font-semibold text-zinc-100">{autoTradeSizeSharesStr}</span> sh,
              and tag I hold. Fires once per stable signal (lane · entry · size) after ~2–4s hold; 45s cooldown between fires.
              Brackets are not auto-armed from take signal.
            </span>
          </label>
          {autoTradeOnDoThisNow && autoTradeBlockReason ? (
            <p className="text-[10px] leading-snug text-amber-200/90">{autoTradeBlockReason}</p>
          ) : autoTradeOnDoThisNow && takeSignalPlanSpot.canTake && endsInMs != null && Number.isFinite(endsInMs) ? (
            <p className="text-[10px] leading-snug text-emerald-200/70">
              Armed · bell {formatRoundClock(endsInMs)} · fires when take signal is ready
            </p>
          ) : null}
          <p className="text-[10px] leading-snug text-zinc-500">
            <span className="font-semibold text-zinc-400">Take signal</span> uses the same size and submits the buy when the
            bell is under 5:00; <span className="font-semibold text-zinc-100">I hold</span> tags only after shares show in
            your wallet. Set SL/TP manually in the trade panel Brackets tab if you want exits armed.
          </p>
        </div>
      </div>
      <TradeDirectiveCard
        directive={tradeDirectiveSpot}
        compact
        deskFlow
        causalBlocks={tradeCausalBlocks}
        bandPlayStep={bandGaugeSpot?.activeStep ?? null}
        heldOutcomeLane={manualPositionLane}
        levels={tradeLevelsSpot}
        laneEdges={machineVerdictSpot?.edges ?? null}
        tpSlHorizon={{ crossProb: machineVerdictSpot?.crossProb ?? null, endsInMs }}
        upOutcomeLabel={upLabel}
        downOutcomeLabel={downLabel}
        stability={stabilitySpot}
        discrepancy={discrepancySpot}
        reEntry={reEntryCheckSpot}
        sizingMultiplier={sizingMultiplierSpot}
        noTradeScore={chartNoTradeScore}
        crossEngineLaneConflict={crossEngineLaneConflict}
        crossCheckSpotLane={spotChartCall?.lane ?? null}
        crossCheckDualLane={dualChartCall?.lane ?? null}
        journal={journalSpot}
        executionSnapshot={executionSnapshotSpot}
      >
        <SignalTakenAckPanel
          upLabel={upLabel}
          downLabel={downLabel}
          manualLane={manualPositionLane}
          pendingHoldLane={pendingHoldLane}
          onPickLane={onAckSignalLane}
          onResetDesk={resetSignalsDesk}
          onClearAllHolds={clearAllDeskHolds}
          playbook={signalTakenPlaybookSpot}
          positionAlerts={positionDeskAlertsSpot}
          heldMetrics={heldSideDeskMetricsSpot}
        />
      </TradeDirectiveCard>
      <MachineVerdictCard
        readout={machineVerdictSpot}
        physicsLine={causalHeadline ?? entryPhysicsLine}
        compact
        minimal
      />
      {signalScoreCard}
      <details className="rounded-xl border border-zinc-800/60 bg-zinc-950/35">
        <summary className="cursor-pointer select-none px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500 hover:text-zinc-300 [&::-webkit-details-marker]:hidden">
          <span className="mr-1 text-zinc-600" aria-hidden>▸</span>
          How to read this strip
        </summary>
        <p className="border-t border-zinc-800/50 px-4 py-2 text-[10px] leading-relaxed text-zinc-500">
          Same rules as the big chart: <span className="text-zinc-400">higher $ draws toward the top</span>; yellow PTB;
          green/red wash is <span className="text-zinc-400">above/below that line</span>, not "price good/bad". Momentum
          badges are <span className="text-zinc-400">short-bucket candle trend</span> and can disagree with spot vs PTB on a
          pullback. The strip uses your zoom (1m–15m) and up to a few hundred recent ticks from the server buffer.
        </p>
      </details>
      {spotChartLive ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              spotChartLaneLockedRef.current = true;
              setSpotChartLane('up');
            }}
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
            onClick={() => {
              spotChartLaneLockedRef.current = true;
              setSpotChartLane('down');
            }}
            className={`rounded-xl border px-3 py-2 text-sm font-semibold transition-colors ${
              spotChartLane === 'down'
                ? 'border-rose-500/60 bg-rose-950/30 text-rose-100'
                : 'border-zinc-800/70 bg-zinc-950/30 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {downLabel} view
          </button>
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
    </div>
  );

  /** Hidden dual engine — keeps cross-check strip fed while the fused chart shows UP/DOWN lines inline. */
  const hiddenDualEngine = hasDual ? (
    <div className="hidden" aria-hidden>
      <PtbDualProbabilityChart
        probUp={probUp}
        probDown={probDown}
        upLabel={upLabel}
        downLabel={downLabel}
        lastUpdateMs={probLastUpdateMs}
        priceToBeatUsd={priceToBeat}
        bookUp={bookAbove}
        bookDown={bookBelow}
        compactHeader
        hideReadingGuide
        largeCharts
        enginePlacement="below"
        onSummary={onDualSummary}
        upOutcomeToken={upToken ?? ''}
        downOutcomeToken={downToken ?? ''}
      />
    </div>
  ) : null;

  const body = hasDual ? (
    <div className="min-w-0 max-w-full space-y-3">
      {trackingUnderCharts}

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
      {trackingUnderCharts}
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
      {trackingUnderCharts}
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
    </div>
  );

  return (
    <>
      <DeskSyncBannerSlot>
        {tradePanelOutOfSync ? (
          <div className="rounded-xl border border-amber-500/50 bg-amber-950/35 px-4 py-3 text-[11px] leading-relaxed text-amber-100">
            <span className="font-bold text-amber-50">Trade panel is pinned to another market.</span> Charts and “Do this
            now” follow <span className="font-mono text-amber-50/95">{slug}</span>; orders and balances follow{' '}
            <span className="font-mono text-amber-50/95">{tradePanelSlug}</span>. Unpin in the trade slide (Markets → pin)
            or load that slug here so signals and execution match.
          </div>
        ) : tradeLaneOutOfSync ? (
          <div className="rounded-xl border border-indigo-500/40 bg-indigo-950/30 px-4 py-2.5 text-[11px] leading-relaxed text-indigo-100">
            Trade slide is on <span className="font-bold">{tradePanelLane === 'up' ? upLabel : downLabel}</span> while the
            card says <span className="font-bold">{masterLane === 'up' ? upLabel : downLabel}</span> — tap Take signal or
            flip UP/DOWN in the slide so they match.
          </div>
        ) : null}
      </DeskSyncBannerSlot>
      {hasDual ? (
        <>
          {hiddenDualEngine}
          {spotVsPtbSection}
        </>
      ) : null}
      {body}
    </>
  );
}
