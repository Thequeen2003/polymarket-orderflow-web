import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent, type ReactElement } from 'react';
import {
  BPX_BRACKET_DRAG_EVENT,
  BPX_BRACKET_OVERLAY_EVENT,
  type BpxBracketDragDetail,
  type BpxBracketOverlayDetail,
} from './bpxBracketOverlayEvent';
import type { SpotPoint } from './SpotLevelChart';
import type { BookSnapshot } from './orderflowMetrics';
import { computePtbChartDerivatives, type PtbControlSignal } from './ptbChartDerivatives';
import { computePtbSettlementCrossProjections } from './ptbProjection';
import { PTB_REACTION_DIMENSIONS, PTB_REACTION_ONE_LINER } from './ptbReactionFramework';
import { STREAM_ATTRIBUTION_LINE } from './streamAttribution';
import { buildSpotCandles, candleStraddlesPtb, ptbTouchEpsilonUsd } from './spotVsPtb';
import { computeTickSlopeUsdPerSec } from './ptbCoreEngine';
import {
  buildSpotSections,
  forecastMomentumSwitch,
  pickSectionPlan,
  type SpotSection,
  type SwitchForecast,
} from './sectionalMomentum';
import {
  PTB_CROSS_IMMINENT_EVENT,
  SECTIONAL_BOOM_EVENT,
  SECTIONAL_DECISION_EVENT,
  type PtbCrossImminentDetail,
  type SectionalBoomDetail,
  type SectionalDecisionDetail,
} from './sectionalDecisionEvent';
import type { DualOutcomeWallFlow } from './dualOutcomeWalls';
import {
  downsampleLinePoints,
  extentSymProb,
  normalizeProbSeries,
  padProbSeries,
  segmentDualLaneStyle,
} from './ptbLineChart';
import { computeSpotPtbMachineReadout, type SpotPtbMachineReadout } from './spotPtbMachineSignals';
import { computeSpotBandGaugeSnapshot, type SpotBandGaugeSnapshot } from './spotBandDeskAction';
import {
  estimateEndingProbability,
  estimatePtbCrossProbability,
  type EndingProbability,
  type PtbCrossEstimate,
} from './ptbCrossProbability';
import { detectMomentumAcceleration, type MomentumAcceleration } from './momentumAcceleration';
import { buildTradeDirective, type TradeDirective } from './tradeDirective';
import { buildOperatorVerdict, type OperatorVerdict } from './operatorVerdict';
import { TradeDirectiveCard } from './TradeDirectiveCard';
import { BoomOverlay } from './BoomOverlay';
import { SignalTruthStrip } from './SignalTruthStrip';
import { buildMtfConsensus, type MtfConsensus } from './multiTimeframeConsensus';
import { detectOverextension, type Overextension } from './overextensionDetector';
import { computeLaneEdges, type LaneEdges } from './tradeEdgeCalculator';
import { suggestLevelsForLane, resolveTradeLevelsForDirective, type TradeLevels } from './tradeLevels';
import { useDirectiveStability } from './useDirectiveStability';
import type { DirectiveStability } from './directiveStability';
import { clearTrackedPointerCapture, trackPointerCapture } from './pointerCaptureSafety';
import { detectDirectiveDiscrepancy, type DirectiveDiscrepancy } from './directiveDiscrepancyGuard';
import {
  bandGaugeMeaningKey,
  machineReadoutMeaningKey,
  noTradeScoreMeaningKey,
  switchForecastMeaningKey,
  tradeDirectiveMeaningKey,
} from './signalsDeskStable';
import {
  updateReEntryState,
  checkReEntry,
  type ReEntryState,
  type ReEntryGuardCheck,
} from './reEntryGuard';
import { computeSizingMultiplier, type SizingMultiplier } from './directiveSizingMultiplier';
import {
  appendDirectiveToJournal,
  resetJournal,
  type DirectiveJournal,
} from './directiveJournal';
import { computeTapeVelocity, type TapePrint, type TapeVelocity } from './tapeVelocity';
import { computeNoTradeScore, type NoTradeScore } from './noTradeScore';
import { useFeatureFlags } from './useFeatureFlags';
import { setFeatureFlag } from './featureFlags';
import { useKeyboardShortcuts, SHORTCUT_HELP } from './useKeyboardShortcuts';
import { playBoomChime, primeBoomChime } from './boomChime';
import { downloadJournalCsv } from './directiveJournal';
import { RoundNote } from './RoundNote';
import { classifyExitReason, updateReEntryStateWithReason } from './reEntryGuard';
import { fmtSpotUsd, fmtSpotUsdAxis, fmtSpotUsdSigned } from './fmtSpotUsd';
import { DeskClosePanel } from './DeskClosePanel';
import { SpotPriceProjectionGrid, type PtbDirectionContext } from './SpotPriceProjectionGrid';
import { computeStableProjectedHeader } from './chartStableProjectedHeader';
import { StableProjectedHeaderDisplay, useStableProjectedHeaderDisplay } from './StableProjectedHeaderDisplay';
import { parseUpdownSlug, titledUpdownAssetFromSlug } from './sixPackUpdownSlugs';

type Mode = 'up' | 'down';
type DominanceStatus = 'UP BIAS' | 'DOWN BIAS' | 'AT PTB';

type MomentumBuildup = {
  score: number;
  direction: 'UP' | 'DOWN' | 'NEUTRAL';
  label: string;
  tier: 'LOADING' | 'BUILDING' | 'READY' | 'FIRING' | 'NONE';
  signals: string[];
};

type BiasShift = {
  bias: 'STRONG UP' | 'UP' | 'NEUTRAL' | 'DOWN' | 'STRONG DOWN';
  biasScore: number;
  shifting: boolean;
  shiftDir: 'TO UP' | 'TO DOWN' | null;
  shiftUrgency: 'IMMINENT' | 'FORMING' | null;
  reasons: string[];
};

const MODE_META: Record<Mode, { label: string; accent: string; soft: string; strongText: string; zoneLabel: string }> = {
  up: {
    label: 'UP VIEW',
    accent: 'rgb(52 211 153)',
    soft: 'rgba(16, 185, 129, 0.16)',
    strongText: 'text-emerald-300',
    zoneLabel: 'PTB DECISION LINE',
  },
  down: {
    label: 'DOWN VIEW',
    accent: 'rgb(248 113 113)',
    soft: 'rgba(239, 68, 68, 0.16)',
    strongText: 'text-rose-300',
    zoneLabel: 'PTB DECISION LINE',
  },
};

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function fmtUsd(n: number | null): string {
  return fmtSpotUsd(n);
}

function fmtUsdSigned(n: number | null): string {
  return fmtSpotUsdSigned(n);
}

function fmtUsdSignedTight(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = n >= 0 ? '+' : '-';
  return `${s}$${Math.abs(n).toFixed(2)}`;
}

function fmtPctSigned(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function fmtAxisPrice(p: number): string {
  return fmtSpotUsdAxis(p);
}

/** `m:ss` countdown from remaining ms (market round). */
function fmtTimeRemaining(endsInMs: number | null | undefined): string {
  if (endsInMs == null || !Number.isFinite(endsInMs)) return '—';
  const totalSec = Math.max(0, Math.floor(endsInMs / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function pctOfTotal(part: number, total: number): string {
  if (!(total > 0)) return '—';
  return `${Math.round((part / total) * 100)}%`;
}

function applySpotSignalToTradePanel(lane: 'up' | 'down'): void {
  window.dispatchEvent(
    new CustomEvent('bpx-trade-prefill', {
      detail: { lane, tone: 'ask' as const },
    }),
  );
}

function statusSubtitle(params: {
  control: PtbControlSignal | undefined;
  momentum: 'UP' | 'DOWN' | 'NEUTRAL' | undefined;
}): string | null {
  const { control, momentum } = params;
  if (!control) return null;
  if (control === 'TRANSITION') return 'weakening or rotation';
  if (control === 'REJECTION') return 'line test failed';
  if (control === 'NO_EDGE') return 'near PTB band — low edge';
  if (control === 'UP_CONTROL' && momentum === 'DOWN') return 'weakening';
  if (control === 'DOWN_CONTROL' && momentum === 'UP') return 'weakening';
  return null;
}


function statusFor(params: { price: number; level: number; band: number; recentMove: number }): DominanceStatus {
  const { price, level, band, recentMove } = params;
  if (price > level + band && recentMove >= 0) return 'UP BIAS';
  if (price < level - band && recentMove <= 0) return 'DOWN BIAS';
  if (price > level + band * 1.35) return 'UP BIAS';
  if (price < level - band * 1.35) return 'DOWN BIAS';
  return 'AT PTB';
}

/** Base SVG size (USD plot); rendered size follows container min/max height below. */
const W = 1040;
const H = 680;

/**
 * OHLC bucket count: scales with tick count but stays below ~1 bucket / 2 ticks
 * so `buildSpotCandles` does not drop most buckets as empty (which looks like “no candles”).
 */
function candleBucketCount(ptsLen: number): number {
  if (ptsLen < 4) return Math.max(2, ptsLen - 1);
  const n = Math.floor(ptsLen * 0.22);
  /** Fewer buckets → wider candles on the same window (readability on large chart). */
  return Math.min(16, Math.max(8, n));
}

/** Evenly spaced time ticks (short windows get more labels, like Polymarket’s intraday strip). */
function buildEvenXTicks(tMin: number, tMax: number): number[] {
  const span = Math.max(1, tMax - tMin);
  const n = span < 120_000 ? 8 : span < 3_600_000 ? 7 : 6;
  const step = span / (n - 1);
  return Array.from({ length: n }, (_, i) => tMin + i * step);
}

function fmtSourceChip(s: string | null | undefined, max = 42): string | null {
  if (s == null) return null;
  const t = s.trim();
  if (!t) return null;
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Linear interpolate spot value at `tMs` along tick series (crosshair readout). */
function interpolateSpotAtTime(pts: SpotPoint[], tMs: number): { t: number; v: number } | null {
  if (pts.length === 0) return null;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (tMs <= first.t) return { t: first.t, v: first.v };
  if (tMs >= last.t) return { t: last.t, v: last.v };
  let lo = 0;
  let hi = pts.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (pts[mid]!.t <= tMs) lo = mid;
    else hi = mid;
  }
  const a = pts[lo]!;
  const b = pts[lo + 1]!;
  if (!(b.t > a.t)) return { t: tMs, v: b.v };
  const w = (tMs - a.t) / (b.t - a.t);
  return { t: tMs, v: a.v + w * (b.v - a.v) };
}

function svgClientToLocal(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const p = svg.createSVGPoint();
  p.x = clientX;
  p.y = clientY;
  const loc = p.matrixTransform(ctm.inverse());
  return { x: loc.x, y: loc.y };
}
const PAD_L = 18;
const PAD_R = 64;
const PAD_Y = 18;

/** Bottom strip height (probability ¢) below USD plot when trade bracket overlay applies. */
const PROB_STRIP_H = 54;
const PROB_STRIP_GAP = 6;

const DUAL_PROB_STRIP_H = 132;
const DUAL_PROB_STRIP_GAP = 8;

function parseTradeBracketCents01(raw: string): number | null {
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return null;
  return n / 100;
}

/** Δ¢ and % vs avg entry (same convention as TradingView “vs avg price”). */
function fmtProbPnlVsEntry(level01: number, entry01: number | null | undefined): string | null {
  if (entry01 == null || !(entry01 > 0) || !(entry01 < 1) || !Number.isFinite(level01)) return null;
  const d = level01 - entry01;
  const dCents = d * 100;
  const pct = (d / entry01) * 100;
  const sc = dCents > 1e-6 ? '+' : dCents < -1e-6 ? '−' : '±';
  const sp = pct > 1e-6 ? '+' : pct < -1e-6 ? '−' : '±';
  return `${sc}${Math.abs(dCents).toFixed(1)}¢ ${sp}${Math.abs(pct).toFixed(1)}%`;
}

/**
 * Band playbook: one “hot” card at a time — Confirm while in-band, then alternates
 * Entry ↔ Exit when edge is live (read order: confirm → work entry → watch exit).
 */
function SpotBandPlayCardRow(props: {
  inBand: boolean;
  edgeOk: boolean;
  confirmBody: string;
  entryLineFmt: string;
  stopBand: string;
  tpLine: string;
  reclaimFmt: string;
  slope: number | null;
}): ReactElement {
  const { inBand, edgeOk, confirmBody, entryLineFmt, stopBand, tpLine, reclaimFmt, slope } = props;
  const [pulseTick, setPulseTick] = useState(0);
  useEffect(() => {
    setPulseTick(0);
  }, [inBand, edgeOk]);
  useEffect(() => {
    if (inBand || !edgeOk) return;
    const id = window.setInterval(() => setPulseTick((n) => n + 1), 3600);
    return () => window.clearInterval(id);
  }, [inBand, edgeOk]);

  const pulseConfirm = inBand;
  const pulseEntry = edgeOk && !inBand && pulseTick % 2 === 0;
  const pulseExit = edgeOk && !inBand && pulseTick % 2 === 1;

  const dim = (lit: boolean) => ((inBand || edgeOk) && !lit ? 'opacity-[0.62]' : '');
  const hot = 'motion-safe:animate-pulse motion-reduce:animate-none ring-2 ring-offset-2 ring-offset-zinc-950 scale-[1.02] z-[1] shadow-lg transition-shadow duration-300';

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
      <div
        className={`rounded-xl border-l-4 px-3 py-2.5 border-y border-r border-zinc-800/60 ${
          inBand ? 'border-amber-400 bg-amber-950/20' : edgeOk ? 'border-cyan-400 bg-cyan-950/15' : 'border-zinc-600 bg-black/25'
        } ${pulseConfirm ? `${hot} ring-amber-300/60` : ''} ${dim(pulseConfirm)}`}
      >
        <div className="flex items-center justify-between gap-1">
          <div className="text-[9px] font-black uppercase tracking-[0.18em] text-cyan-200/90">Confirm</div>
          {inBand ? (
            <span className="shrink-0 rounded bg-amber-500/25 px-1.5 py-px text-[8px] font-black uppercase tracking-wide text-amber-100">
              Guide
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-[11px] font-semibold leading-snug text-zinc-100">{confirmBody}</p>
      </div>
      <div
        className={`rounded-xl border-l-4 px-3 py-2.5 border-y border-r border-zinc-800/60 ${
          edgeOk ? 'border-emerald-400 bg-emerald-950/15' : 'border-zinc-600 bg-black/20'
        } ${pulseEntry ? `${hot} ring-emerald-300/55` : ''} ${dim(pulseEntry)}`}
      >
        <div className="flex items-center justify-between gap-1">
          <div className="text-[9px] font-black uppercase tracking-[0.18em] text-emerald-200/90">Entry</div>
          {edgeOk && !inBand ? (
            <span className="shrink-0 rounded bg-emerald-500/20 px-1.5 py-px text-[8px] font-black uppercase tracking-wide text-emerald-100">
              Guide
            </span>
          ) : null}
        </div>
        {inBand ? (
          <p className="mt-1 text-[11px] font-semibold leading-snug text-zinc-100">
            In band — use ABOVE / BELOW break levels in Confirm; entries are timing-only.
          </p>
        ) : edgeOk ? (
          <p className="mt-1 text-[11px] font-semibold leading-snug text-zinc-100">
            Pullback that <span className="text-emerald-200">stays outside</span> band (holds{' '}
            <span className="font-mono text-emerald-100">{entryLineFmt}</span>).
          </p>
        ) : (
          <p className="mt-1 text-[11px] font-semibold leading-snug text-zinc-400">No entry — not on this view&apos;s side.</p>
        )}
        <p className="mt-1 text-[10px] leading-snug text-zinc-500">
          Stop: back into <span className="font-mono text-zinc-300">{stopBand}</span>
        </p>
      </div>
      <div
        className={`rounded-xl border-l-4 border-rose-400 bg-rose-950/10 px-3 py-2.5 border-y border-r border-zinc-800/60 ${
          pulseExit ? `${hot} ring-rose-300/55` : ''
        } ${dim(pulseExit)}`}
      >
        <div className="flex items-center justify-between gap-1">
          <div className="text-[9px] font-black uppercase tracking-[0.18em] text-rose-200/90">Exit</div>
          {edgeOk && !inBand ? (
            <span className="shrink-0 rounded bg-rose-500/20 px-1.5 py-px text-[8px] font-black uppercase tracking-wide text-rose-100">
              Guide
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-[11px] font-semibold leading-snug text-zinc-100">
          If price <span className="text-rose-200">re-enters</span> the band <span className="font-mono text-zinc-200">{stopBand}</span>
          {slope != null ? ' or slope flips against you.' : '.'}
        </p>
        <p className="mt-1 text-[10px] leading-snug text-zinc-400">
          Reclaim: lose <span className="font-mono text-zinc-200">{reclaimFmt}</span> = exit pressure
        </p>
      </div>
      <div
        className={`rounded-xl border-l-4 border-indigo-400 bg-indigo-950/15 px-3 py-2.5 border-y border-r border-zinc-800/60 ${
          edgeOk && !inBand ? 'opacity-80' : ''
        }`}
      >
        <div className="text-[9px] font-black uppercase tracking-[0.18em] text-indigo-200/90">TP / proj</div>
        <p className="mt-1 font-mono text-[13px] font-bold text-indigo-50">30s → {tpLine}</p>
        <p className="mt-1 text-[10px] leading-snug text-indigo-200/70">Linear proj from slope — not a guarantee.</p>
      </div>
    </div>
  );
}

export function PtbOpportunityModeChart(props: {
  mode: Mode;
  spot: SpotPoint[];
  priceToBeat: number | null;
  lastUpdateMs: number | null;
  /** Milliseconds until market / round end (from parent); drives “Time remaining”. */
  endsInMs?: number | null;
  /** Last implied mid (0–1) for settlement/cross model confirmation. */
  lastProbUp?: number | null;
  lastProbDown?: number | null;
  /** Full UP/DOWN implied-mid series — renders dual PTB lines under the spot chart when both are present. */
  probUp?: SpotPoint[];
  probDown?: SpotPoint[];
  probLastUpdateMs?: number | null;
  /** Book flow snapshots for the active UP/DOWN outcome token. */
  bookFlow?: BookSnapshot[] | null;
  chartTitle?: string;
  upLabel?: string;
  downLabel?: string;
  /** API label for PTB (`priceToBeat` `source`). */
  ptbSource?: string | null;
  /** RTDS label for underlying spot stream (`rtdsCrypto` `source`). */
  spotFeedSource?: string | null;
  /** When set with down outcome token, bracket overlay + draggable ¢ strip sync with the trade panel. */
  upOutcomeToken?: string | null;
  downOutcomeToken?: string | null;
  /** Taller chart area, relaxed max height — Dual PTB tab avoids clipping the plot/strip inside the card. */
  chartAreaRoomy?: boolean;
  /** Signals Spot vs PTB: chart first (fills viewport), controls/meta below; plot scales much larger. */
  signalsEmbed?: boolean;
  /** UP/DOWN split desk: one column per lane — shorter plot, lighter chrome. */
  signalsCombinedColumn?: boolean;
  /** When false, parent owns desk callbacks (sibling column publishes). Default true. */
  publishDesk?: boolean;
  onPrimaryCall?: (c: {
    lane: 'up' | 'down' | null;
    status: 'ENTER' | 'PREP' | 'WAIT';
    confidence: 'HIGH' | 'MED' | 'LOW';
    reason: string;
    enterWhen: string | null;
  }) => void;
  /** Active market slug — used to tag the sectional decision toast event so listeners ignore stale slugs. */
  slug?: string | null;
  /** Fused machine readout (agreement %, regime, …) for parent tabs — Signals / Dual PTB verdict strip. */
  onMachineReadout?: (readout: SpotPtbMachineReadout | null) => void;
  /** Lane the user is currently long (for HOLD / FLIP / EXIT directive branches). `null` = flat. */
  currentPositionLane?: 'up' | 'down' | null;
  /** Top-level directive callback — fires on every recompute so toast/notify integrations can react. */
  onTradeDirective?: (directive: TradeDirective | null) => void;
  /** Parent (Signals) may subscribe to sectional switch state for exit strip / playbook. */
  onSwitchForecast?: (sf: SwitchForecast | null) => void;
  /**
   * Recent prints (matched trades) for the active outcome — feeds the tape-velocity
   * sensor + the No-Trade composite. Parent fetches via `recentTrades` and
   * normalizes to `{ ts, side, size }`. Optional — chart degrades gracefully when null.
   */
  recentPrints?: TapePrint[] | null;
  /** Which outcome token `recentPrints` are for (UP vs DOWN) — required for tape→lane vote. */
  tapeLane?: 'up' | 'down' | null;
  /** Parent (Signals) can mirror No-Trade composite for the single Answer card below the chart. */
  onNoTradeScore?: (score: NoTradeScore | null) => void;
  /** Bump to clear the embedded directive mini-journal without changing slug (Signals "Reset desk"). */
  deskResetKey?: number;
  /** Band gauge snapshot for parent “Do this now” strip (BELOW PTB / EDGE LIVE / Step 1–3). */
  onBandGaugeSnapshot?: (snapshot: SpotBandGaugeSnapshot | null) => void;
  /** UP + DOWN CLOB books — bid/ask wall read for machine + Do this now (parent passes both legs). */
  wallFlow?: DualOutcomeWallFlow | null;
}): ReactElement {
  const {
    mode,
    spot,
    priceToBeat,
    lastUpdateMs,
    endsInMs = null,
    lastProbUp = null,
    lastProbDown = null,
    probUp = [],
    probDown = [],
    bookFlow = null,
    chartTitle = 'Spot (USD)',
    upLabel = 'UP',
    downLabel = 'DOWN',
    ptbSource = null,
    spotFeedSource = null,
    upOutcomeToken = null,
    downOutcomeToken = null,
    chartAreaRoomy = false,
    signalsEmbed = false,
    signalsCombinedColumn = false,
    publishDesk = true,
    onPrimaryCall,
    slug = null,
    onMachineReadout,
    currentPositionLane = null,
    onTradeDirective,
    onSwitchForecast,
    recentPrints = null,
    tapeLane = null,
    onNoTradeScore,
    deskResetKey = 0,
    onBandGaugeSnapshot,
    wallFlow = null,
  } = props;
  const hasDualProbInput = probUp.length >= 1 && probDown.length >= 1;
  const featureFlags = useFeatureFlags();
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [pinnedNoteVisible, setPinnedNoteVisible] = useState<boolean>(featureFlags.pinnedNote);
  useEffect(() => {
    setPinnedNoteVisible(featureFlags.pinnedNote);
  }, [featureFlags.pinnedNote]);
  const reduceMotion =
    featureFlags.respectReducedMotion && typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;
  // Hide legacy mini “rules” panels; the big Trade Plan card is the primary read.
  const showLegacyRulePanels = false;
  const chartPanelWrapSk =
    signalsCombinedColumn
      ? 'min-h-0 flex-1 overflow-x-hidden overflow-y-visible px-1.5 pt-1 sm:px-2'
      : chartAreaRoomy
        ? signalsEmbed
          ? 'overflow-x-hidden overflow-y-visible px-1.5 pt-1 sm:px-2'
          : 'flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-visible px-2 pt-1 sm:px-3 sm:pt-2'
        : 'min-h-0 flex-1 overflow-hidden px-3 pt-2 sm:px-4';
  const chartPanelWrapMain =
    signalsCombinedColumn
      ? 'min-h-0 flex-1 overflow-x-hidden overflow-y-visible px-1.5 pt-1 sm:px-2 [contain:paint]'
      : chartAreaRoomy
        ? signalsEmbed
          ? 'overflow-x-hidden overflow-y-visible px-1.5 pt-1 sm:px-2'
          : 'flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-visible px-2 pt-1 sm:px-3 sm:pt-2'
        : 'min-h-0 flex-1 overflow-hidden px-3 pt-2 sm:px-4 [contain:paint]';
  /** Dual PTB only — tall plot + high cap so the PTB chart reads at “dashboard” scale, not a card thumbnail. */
  const chartSvgSk =
    signalsCombinedColumn
      ? 'block h-full min-h-[min(26svh,320px)] max-h-[min(38svh,440px)] w-full rounded-[18px] bg-[#0a0f16] [contain:paint]'
      : chartAreaRoomy
        ? signalsEmbed
          ? 'block h-full min-h-[min(52svh,520px)] w-full max-w-none rounded-[20px] bg-[#0a0f16]'
          : 'block h-full min-h-[min(68svh,1500px)] w-full max-w-none flex-1 rounded-[24px] bg-[#0a0f16] [contain:paint] xl:min-h-[min(74svh,1700px)]'
        : 'block h-full min-h-[min(54vh,620px)] max-h-[min(88vh,960px)] w-full rounded-[24px] bg-[#0a0f16] [contain:paint]';
  const chartSvgMain =
    signalsCombinedColumn
      ? 'block h-full min-h-[min(26svh,320px)] max-h-[min(38svh,440px)] w-full rounded-[18px] bg-[#0a0f16] [contain:strict]'
      : chartAreaRoomy
        ? signalsEmbed
          ? 'block h-full min-h-[min(52svh,520px)] w-full max-w-none rounded-[20px] bg-[#0a0f16]'
          : 'block h-full min-h-[min(68svh,1500px)] w-full max-w-none flex-1 rounded-[24px] bg-[#0a0f16] xl:min-h-[min(74svh,1700px)] [contain:strict]'
        : 'block h-full min-h-[min(54vh,620px)] max-h-[min(88vh,960px)] w-full rounded-[24px] bg-[#0a0f16] [contain:strict]';
  const gradId = useId().replace(/:/g, '');
  const [displayMode, setDisplayMode] = useState<'line' | 'ohlc'>('line');
  type ZoomSec = 60 | 120 | 300 | 900 | 1800 | 3600 | 7200 | 14400;
  const [zoomWindow, setZoomWindowState] = useState<ZoomSec>(300);
  const userPickedZoomRef = useRef(false);
  const setZoomWindow = useCallback((w: ZoomSec, fromUser = true) => {
    if (fromUser) userPickedZoomRef.current = true;
    setZoomWindowState(w);
  }, []);
  const ZOOM_OPTIONS: readonly { sec: ZoomSec; label: string }[] = [
    { sec: 60, label: '1m' },
    { sec: 120, label: '2m' },
    { sec: 300, label: '5m' },
    { sec: 900, label: '15m' },
    { sec: 1800, label: '30m' },
    { sec: 3600, label: '1h' },
    { sec: 7200, label: '2h' },
    { sec: 14400, label: '4h' },
  ];
  type CrosshairState = { plotX: number; yOnPath: number; t: number; v: number; distPct: number };
  const [crosshair, setCrosshair] = useState<CrosshairState | null>(null);
  const spotSvgRef = useRef<SVGSVGElement | null>(null);
  const [bracketOverlay, setBracketOverlay] = useState<BpxBracketOverlayDetail | null>(null);
  const dragStripRef = useRef<'sl' | 'tp' | 'ref' | null>(null);
  const didAuto15mZoom = useRef(false);

  useEffect(() => {
    const fn = (ev: Event) => {
      const d = (ev as CustomEvent<BpxBracketOverlayDetail>).detail;
      if (d && typeof d === 'object') setBracketOverlay(d);
    };
    window.addEventListener(BPX_BRACKET_OVERLAY_EVENT, fn as EventListener);
    return () => window.removeEventListener(BPX_BRACKET_OVERLAY_EVENT, fn as EventListener);
  }, []);
  useEffect(() => {
    if (didAuto15mZoom.current) return;
    if (endsInMs == null || !Number.isFinite(endsInMs)) return;
    // Don't override if the user already changed zoom on this chart.
    if (userPickedZoomRef.current) {
      didAuto15mZoom.current = true;
      return;
    }
    // Pick a default window proportional to the remaining round so a 1h market
    // doesn't show only the last 15 of 60 minutes (and vice-versa for a 5m market).
    const minMs = endsInMs;
    let pick: ZoomSec | null = null;
    if (minMs > 150 * 60_000) pick = 14400; // > 2.5h → 4h view
    else if (minMs > 70 * 60_000) pick = 7200; // > 70m → 2h view
    else if (minMs > 30 * 60_000) pick = 3600; // > 30m → 1h view
    else if (minMs > 14 * 60_000) pick = 1800; // > 14m → 30m view
    else if (minMs > 7 * 60_000) pick = 900; // > 7m → 15m view
    if (pick != null) {
      setZoomWindow(pick, false);
      didAuto15mZoom.current = true;
    }
  }, [endsInMs, setZoomWindow]);

  // Only clear on changes that actually invalidate the hovered point
  // (zoom, line/ohlc, or PTB anchor). `spot` is a fresh array reference on
  // every poll, so listing it here used to blank the crosshair every tick.
  useEffect(() => {
    setCrosshair(null);
  }, [zoomWindow, displayMode, priceToBeat]);

  const overlayAppliesSpot = useMemo(() => {
    const u = upOutcomeToken?.trim() ?? '';
    const d = downOutcomeToken?.trim() ?? '';
    if (!bracketOverlay || !u || !d) return false;
    return bracketOverlay.upToken?.trim() === u && bracketOverlay.downToken?.trim() === d;
  }, [bracketOverlay, upOutcomeToken, downOutcomeToken]);

  const chartInnerW = W - PAD_L - PAD_R;

  const emitStripDrag = useCallback(
    (kind: 'sl' | 'tp' | 'ref', clientX: number) => {
      if (!overlayAppliesSpot || !bracketOverlay) return;
      const svg = spotSvgRef.current;
      if (!svg) return;
      const loc = svgClientToLocal(svg, clientX, 0);
      if (!loc) return;
      const t = (loc.x - PAD_L) / chartInnerW;
      const p = Math.max(0.001, Math.min(0.999, t));
      const centsStr = (Math.round(p * 1000) / 10).toFixed(1);
      const detail: BpxBracketDragDetail = {
        kind,
        centsStr,
        tradeLane: bracketOverlay.tradeLane,
        upToken: bracketOverlay.upToken,
        downToken: bracketOverlay.downToken,
      };
      window.dispatchEvent(new CustomEvent(BPX_BRACKET_DRAG_EVENT, { detail }));
    },
    [overlayAppliesSpot, bracketOverlay],
  );

  const onStripPointerDown = useCallback(
    (kind: 'sl' | 'tp' | 'ref', e: PointerEvent<SVGLineElement>) => {
      if (!overlayAppliesSpot || !bracketOverlay) return;
      const bsl = parseTradeBracketCents01(bracketOverlay.slStopCents);
      const btp = parseTradeBracketCents01(bracketOverlay.tpTakeCents);
      const brf = parseTradeBracketCents01(bracketOverlay.refCents);
      if (kind === 'sl' && bsl == null) return;
      if (kind === 'tp' && btp == null) return;
      if (kind === 'ref' && brf == null) return;
      e.preventDefault();
      e.stopPropagation();
      dragStripRef.current = kind;
      const el = e.currentTarget as SVGElement;
      el.setPointerCapture(e.pointerId);
      trackPointerCapture(el, e.pointerId);
      emitStripDrag(kind, e.clientX);
    },
    [overlayAppliesSpot, bracketOverlay, emitStripDrag],
  );

  const onStripPointerMove = useCallback(
    (e: PointerEvent<SVGLineElement>) => {
      const k = dragStripRef.current;
      if (!k) return;
      e.preventDefault();
      emitStripDrag(k, e.clientX);
    },
    [emitStripDrag],
  );

  const onStripPointerUp = useCallback((e: PointerEvent<SVGLineElement>) => {
    dragStripRef.current = null;
    clearTrackedPointerCapture(e.currentTarget as SVGElement, e.pointerId);
  }, []);

  useEffect(() => () => {
    dragStripRef.current = null;
  }, []);

  const pts = useMemo(() => {
    const all = spot.filter((p) => isFiniteNumber(p.t) && isFiniteNumber(p.v));
    if (all.length < 2) return all;
    const cutoff = all[all.length - 1]!.t - zoomWindow * 1000;
    const windowed = all.filter((p) => p.t >= cutoff);
    // Wider zooms need more headroom (4h market at ~5s polling ≈ 2880 ticks → cap 2400 to match server).
    const cap =
      zoomWindow >= 7200 ? 2400 : zoomWindow >= 1800 ? 900 : zoomWindow >= 900 ? 480 : 280;
    return windowed.length >= 2 ? windowed.slice(-cap) : all.slice(-cap);
  }, [spot, zoomWindow]);
  const tickMeta = useMemo(() => {
    const n = pts.length;
    if (n < 2) return { n, spanSec: 0, sparse: true, zoomSec: zoomWindow };
    const spanMs = pts[n - 1]!.t - pts[0]!.t;
    const spanSec = spanMs / 1000;
    const sparse = n < 8 || spanSec < zoomWindow * 0.22;
    return { n, spanSec, sparse, zoomSec: zoomWindow };
  }, [pts, zoomWindow]);
  const meta = MODE_META[mode];
  const spotLastPointMs = pts.length ? pts[pts.length - 1]!.t : null;
  const feedLastMs =
    lastUpdateMs != null && spotLastPointMs != null
      ? Math.max(lastUpdateMs, spotLastPointMs)
      : lastUpdateMs ?? spotLastPointMs;
  const staleAfterMs = signalsEmbed ? 90_000 : 55_000;
  const [chartNow, setChartNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setChartNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);
  const stale = feedLastMs == null ? pts.length < 2 : chartNow - feedLastMs > staleAfterMs;

  const model = useMemo(() => {
    if (priceToBeat == null || !Number.isFinite(priceToBeat) || pts.length < 2) return null;
    const candles = buildSpotCandles(pts, candleBucketCount(pts.length));
    let spotMin = Infinity;
    let spotMax = -Infinity;
    let maxAbs = 0;
    for (let i = 0; i < pts.length; i++) {
      const v = pts[i]!.v;
      if (!Number.isFinite(v)) continue;
      if (v < spotMin) spotMin = v;
      if (v > spotMax) spotMax = v;
      const d = Math.abs(v - priceToBeat);
      if (d > maxAbs) maxAbs = d;
    }
    if (!Number.isFinite(spotMin)) return null;
    const last = pts[pts.length - 1]!.v;
    const first = pts[0]!.v;
    const recentBase = pts[Math.max(0, pts.length - 7)]?.v ?? first;
    const recentMove = last - recentBase;
    const pctChange = Math.abs(first) > 1e-12 ? ((last - first) / first) * 100 : 0;
    const distancePct = ((last - priceToBeat) / priceToBeat) * 100;
    const needAbove = Math.max(0, spotMax - priceToBeat);
    const needBelow = Math.max(0, priceToBeat - spotMin);
    const halfSpan = Math.max(needAbove, needBelow, Math.abs(priceToBeat) * 3e-5, 1);
    const plotMin = priceToBeat - halfSpan * 1.08;
    const plotMax = priceToBeat + halfSpan * 1.08;
    if (!(plotMax > plotMin)) return null;
    const band = ptbTouchEpsilonUsd(pts, priceToBeat);
    if (!Number.isFinite(band)) return null;
    if (maxAbs < band * 1.5) maxAbs = band * 1.5;
    const status = statusFor({ price: last, level: priceToBeat, band, recentMove });
    const favorableNow = mode === 'up' ? last > priceToBeat + band : last < priceToBeat - band;
    const selectedLabel = mode === 'up' ? upLabel : downLabel;
    const oppositeLabel = mode === 'up' ? downLabel : upLabel;
    const absDistance = Math.abs(last - priceToBeat);
    const conviction =
      absDistance >= band * 3 ? 'STRONG SEPARATION' : absDistance >= band * 1.75 ? 'CLEAR SEPARATION' : 'WEAK SEPARATION';
    const hint =
      status === 'AT PTB'
        ? 'Price is reacting at the line — no edge until it separates.'
        : favorableNow
          ? `Price is on the ${selectedLabel} side of PTB, so ${selectedLabel} has the bias.`
          : `Price is on the ${oppositeLabel} side of PTB, so this view is weak.`;
    return {
      candles, last, first, recentMove, pctChange, distancePct,
      plotMin, plotMax, band, maxAbs, status, conviction, hint,
      tMin: pts[0]!.t, tMax: pts[pts.length - 1]!.t,
    };
  }, [mode, priceToBeat, pts, upLabel, downLabel]);

  const dualProbOverlay = useMemo(() => {
    if (!model || !hasDualProbInput) return null;
    const u0 = padProbSeries(normalizeProbSeries(probUp.map((pt) => ({ t: pt.t, v: pt.v }))));
    const d0 = padProbSeries(normalizeProbSeries(probDown.map((pt) => ({ t: pt.t, v: pt.v }))));
    if (u0.length < 2 || d0.length < 2) return null;
    const tMin = model.tMin;
    const tMax = model.tMax;
    const inWindow = (pt: { t: number; v: number }) => pt.t >= tMin - 1 && pt.t <= tMax + 1;
    const uW = u0.filter(inWindow);
    const dW = d0.filter(inWindow);
    const seriesUp = (uW.length >= 2 ? uW : u0).map((pt) => ({ t: pt.t, v: pt.v }));
    const seriesDown = (dW.length >= 2 ? dW : d0).map((pt) => ({ t: pt.t, v: pt.v }));
    const vals = [...seriesUp, ...seriesDown].map((pt) => pt.v);
    const scale = extentSymProb(Math.min(...vals), Math.max(...vals));
    return { tMin, tMax, seriesUp, seriesDown, scale, lastU: u0[u0.length - 1]!.v, lastD: d0[d0.length - 1]!.v };
  }, [hasDualProbInput, model, probDown, probUp]);

  const plotBaseH = dualProbOverlay ? 780 : H;
  const dualStripExtra = dualProbOverlay ? DUAL_PROB_STRIP_GAP + DUAL_PROB_STRIP_H : 0;
  const bracketStripExtra = model != null && overlayAppliesSpot ? PROB_STRIP_GAP + PROB_STRIP_H + 12 : 0;
  const svgHeight = plotBaseH + dualStripExtra + bracketStripExtra;

  const derivedStrip = useMemo(() => {
    if (!model || priceToBeat == null || !Number.isFinite(priceToBeat)) return null;
    return computePtbChartDerivatives({
      pts,
      candles: model.candles,
      ptb: priceToBeat,
      bookFlow: bookFlow ?? undefined,
      lastProbUp,
      lastProbDown,
    });
  }, [model, priceToBeat, pts, bookFlow, lastProbUp, lastProbDown]);

  const settlementCross = useMemo(() => {
    if (!model || !derivedStrip || priceToBeat == null || !Number.isFinite(priceToBeat)) return null;
    const Tsec =
      endsInMs != null && Number.isFinite(endsInMs) && endsInMs > 0
        ? Math.max(1, endsInMs / 1000)
        : Math.max(30, (model.tMax - model.tMin) / 1000);
    return computePtbSettlementCrossProjections({
      pts,
      candles: model.candles,
      ptb: priceToBeat,
      s0: model.last,
      Tsec,
      slopeUsdPerSec: derivedStrip.slopeUsdPerSec,
      slopeSampleCount: derivedStrip.slopeSampleCount,
      controlSignal: derivedStrip.controlSignal,
      structureEvent: derivedStrip.structureEvent,
      structureEventLabel: derivedStrip.structureEventLabel,
      reactionKind: derivedStrip.reaction.kind,
      lastProbUp,
      lastProbDown,
      bookFlow: bookFlow ?? undefined,
    });
  }, [model, derivedStrip, priceToBeat, pts, endsInMs, lastProbUp, lastProbDown, bookFlow]);

  const primaryCall = useMemo(() => {
    type Gate = { k: string; ok: boolean; v: string };
    if (!model || !derivedStrip || priceToBeat == null || !Number.isFinite(priceToBeat)) {
      return {
        lane: null as 'up' | 'down' | null,
        status: 'WAIT' as const,
        confidence: 'LOW' as const,
        reason: 'Need more spot/PTB structure before a directional call.',
        gates: [] as Gate[],
        enterWhen: null as string | null,
      };
    }

    const band = Math.max(0.35, model.band);
    const dist = model.last - priceToBeat;
    const absDist = Math.abs(dist);
    const bandX = absDist / band;
    const control = derivedStrip.controlSignal;
    const structure = derivedStrip.structureEvent;
    const momentum = derivedStrip.momentum;
    const chop = control === 'NO_EDGE' || structure === 'chop';
    if (chop) {
      return {
        lane: null as 'up' | 'down' | null,
        status: 'WAIT' as const,
        confidence: 'LOW' as const,
        reason: 'Chop / no-edge regime. Wait for clear separation and hold.',
        gates: [
          {
            k: 'Tradable regime',
            ok: false,
            v: `${String(structure).replaceAll('_', ' ')} · ${String(control).replaceAll('_', ' ')}`,
          },
        ] as Gate[],
        enterWhen: 'Wait until structure leaves chop and control is UP_CONTROL or DOWN_CONTROL (or price holds ≥1.2× band past PTB).',
      };
    }

    let lane: 'up' | 'down' | null = null;
    if (control === 'UP_CONTROL') lane = 'up';
    else if (control === 'DOWN_CONTROL') lane = 'down';
    else if (absDist >= band * 1.05) lane = dist >= 0 ? 'up' : 'down';

    if (!lane) {
      return {
        lane: null as 'up' | 'down' | null,
        status: 'WAIT' as const,
        confidence: 'LOW' as const,
        reason: 'No dominant side yet. Stay patient near the PTB line.',
        gates: [
          { k: 'Tradable regime', ok: true, v: 'Not chop' },
          {
            k: 'Dominant side',
            ok: false,
            v: `Control ${String(control).replaceAll('_', ' ')} · ${bandX.toFixed(2)}× band (need 1.05× for lean-by-distance)`,
          },
        ] as Gate[],
        enterWhen:
          'Pick a side only after UP_CONTROL / DOWN_CONTROL, or after spot holds ≥1.05× the reaction band on one side of PTB.',
      };
    }

    const momentumAligned = momentum === (lane === 'up' ? 'UP' : 'DOWN');
    const strongControl = (lane === 'up' && control === 'UP_CONTROL') || (lane === 'down' && control === 'DOWN_CONTROL');
    const highSep = absDist >= band * 1.35;
    const medSep = absDist >= band * 1.1;
    const confidence: 'HIGH' | 'MED' | 'LOW' =
      strongControl && highSep && momentumAligned ? 'HIGH' : strongControl || highSep || (medSep && momentumAligned) ? 'MED' : 'LOW';
    const status: 'ENTER' | 'PREP' | 'WAIT' =
      confidence === 'HIGH'
        ? 'ENTER'
        : confidence === 'MED' && strongControl && medSep && momentumAligned
          ? 'ENTER'
          : confidence === 'MED'
            ? 'PREP'
            : 'WAIT';
    const laneLabel = lane === 'up' ? upLabel : downLabel;
    const reason =
      status === 'ENTER'
        ? `${laneLabel} has control + separation. Enter on pullback-hold outside the band.`
        : status === 'PREP'
          ? `${laneLabel} is favored, but wait for a cleaner hold / momentum alignment.`
          : `${laneLabel} has early lean only; avoid forcing entries.`;

    const gates: Gate[] = [
      { k: 'Tradable regime', ok: true, v: 'Not chop' },
      { k: 'Favored lane', ok: true, v: laneLabel },
      {
        k: 'Control matches lane',
        ok: strongControl,
        v: strongControl ? `${control}` : `have ${String(control).replaceAll('_', ' ')} vs ${laneLabel}`,
      },
      {
        k: 'Separation ≥ 1.35× band',
        ok: highSep,
        v: `${bandX.toFixed(2)}× band`,
      },
      {
        k: 'Momentum vs lane',
        ok: momentumAligned,
        v: momentumAligned ? `${momentum}` : `bucket ${momentum} (want ${lane === 'up' ? 'UP' : 'DOWN'})`,
      },
    ];

    const missing: string[] = [];
    if (!strongControl) missing.push('UP/DOWN control on this lane');
    if (!highSep && !medSep) missing.push('|spot−PTB| ≥ 1.1× band');
    if (!momentumAligned) missing.push('short-bucket momentum aligned with lane');
    const enterWhen =
      status === 'ENTER'
        ? 'This zoom: all listed gates pass — still use limits; invalidation is a snap back through the band.'
        : `For ENTER on ${laneLabel}: ${missing.length ? missing.join(' · ') : 'n/a'}.`;

    return { lane, status, confidence, reason, gates, enterWhen };
  }, [derivedStrip, model, priceToBeat, upLabel, downLabel]);

  useEffect(() => {
    if (!publishDesk || !onPrimaryCall) return;
    onPrimaryCall({
      lane: primaryCall.lane,
      status: primaryCall.status,
      confidence: primaryCall.confidence,
      reason: primaryCall.reason,
      enterWhen: primaryCall.enterWhen ?? null,
    });
  }, [publishDesk, onPrimaryCall, primaryCall.confidence, primaryCall.enterWhen, primaryCall.lane, primaryCall.reason, primaryCall.status]);

  /**
   * Sectional breakdown for long-window markets (1h / 4h). The user wants to see the
   * round broken into 15-minute slices and get an early heads-up when momentum is
   * about to flip — so they can decide GO IN / STAY / EXIT before price actually
   * crosses PTB. See `sectionalMomentum.ts` for the pure logic.
   */
  const sectionalPlan = useMemo(() => pickSectionPlan(zoomWindow), [zoomWindow]);
  const sections: SpotSection[] = useMemo(() => {
    if (!sectionalPlan || priceToBeat == null || !Number.isFinite(priceToBeat) || pts.length < 2) return [];
    const flatBand = model ? Math.max(0.5, model.band * 0.6) : 0.5;
    return buildSpotSections(pts, priceToBeat, sectionalPlan.sectionMs, sectionalPlan.count, flatBand);
  }, [sectionalPlan, pts, priceToBeat, model]);

  const switchForecast: SwitchForecast | null = useMemo(() => {
    // Run without `sectionalPlan` so sub‑60s zoom still gets Answer / boom / machine row.
    // When no slice plan, `sections` is empty and the forecaster returns WAIT until data fills.
    if (!model || priceToBeat == null) return null;
    const flowBias: -1 | 0 | 1 =
      derivedStrip == null
        ? 0
        : derivedStrip.controlSignal === 'UP_CONTROL'
          ? 1
          : derivedStrip.controlSignal === 'DOWN_CONTROL'
            ? -1
            : 0;
    return forecastMomentumSwitch({
      sections,
      microSlopeUsdPerSec: derivedStrip?.slopeUsdPerSec ?? null,
      spot: model.last,
      ptb: priceToBeat,
      bandUsd: Math.max(0.5, model.band),
      primaryLane: primaryCall.lane,
      primaryStatus: primaryCall.status,
      primaryConfidence: primaryCall.confidence,
      flowBias,
      endsInMsRemaining: endsInMs ?? null,
    });
  }, [sections, model, priceToBeat, derivedStrip, primaryCall.lane, primaryCall.status, primaryCall.confidence, endsInMs]);

  /**
   * Statistical estimate of P(spot crosses PTB at least once before round end).
   * Brownian-bridge approximation using OLS drift + RMS volatility from the last
   * 5 minutes of ticks. Refreshed on every render that updates `pts`/`endsInMs`.
   */
  const crossEstimate: PtbCrossEstimate | null = useMemo(() => {
    if (!model || priceToBeat == null) return null;
    return estimatePtbCrossProbability({
      pts,
      spot: model.last,
      ptb: priceToBeat,
      endsInMs: endsInMs ?? null,
      bandUsd: Math.max(0.5, model.band),
    });
  }, [pts, model, priceToBeat, endsInMs]);

  /** Late-vs-early slope thrust — flags accelerating / decelerating / reversing momentum. */
  const acceleration: MomentumAcceleration | null = useMemo(() => {
    if (pts.length < 8) return null;
    return detectMomentumAcceleration(pts, { lateMs: 60_000, earlyMs: 120_000 });
  }, [pts]);

  /** Multi-timeframe drift consensus (1m/5m/15m/30m). */
  const mtf: MtfConsensus | null = useMemo(() => {
    if (pts.length < 8 || !model) return null;
    return buildMtfConsensus(pts, Math.max(0.5, model.band));
  }, [pts, model]);

  /** Anti-chase overextension guard. */
  const overextension: Overextension | null = useMemo(() => {
    if (pts.length < 30 || !model) return null;
    return detectOverextension(pts, {
      windowMs: 60_000,
      baselineCount: 10,
      minBandUsd: Math.max(0.3, model.band * 0.5),
    });
  }, [pts, model]);

  /** Terminal-side probability (P(spot ends above/below PTB)). */
  const endingProb: EndingProbability | null = useMemo(() => {
    if (!model || priceToBeat == null) return null;
    return estimateEndingProbability({
      pts,
      spot: model.last,
      ptb: priceToBeat,
      endsInMs: endsInMs ?? null,
      bandUsd: Math.max(0.5, model.band),
    });
  }, [pts, model, priceToBeat, endsInMs]);

  /** Per-lane $ edge derived from terminal probability + current implied mids. */
  const laneEdges: LaneEdges | null = useMemo(() => {
    if (!endingProb) return null;
    return computeLaneEdges({
      upMid: lastProbUp,
      downMid: lastProbDown,
      endAboveProb: endingProb.endAboveProb,
      modelConfidence: endingProb.confidence,
    });
  }, [endingProb, lastProbUp, lastProbDown]);

  /**
   * Tape velocity — aggressor flow on the desk's active outcome token.
   * Computed before machine fusion so prints can vote in the agreement tally.
   */
  const [tapeNow, setTapeNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!recentPrints || recentPrints.length === 0) return;
    const id = window.setInterval(() => setTapeNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [recentPrints]);
  const tapeVelocity: TapeVelocity | null = useMemo(() => {
    if (!recentPrints || recentPrints.length === 0) return null;
    return computeTapeVelocity(recentPrints, { now: tapeNow });
  }, [recentPrints, tapeNow]);

  /** Fused sensor row — spot vs PTB, implied mids, book control, dwell, sections, time pressure. */
  const machineReadout: SpotPtbMachineReadout | null = useMemo(() => {
    if (!model || priceToBeat == null) return null;
    return computeSpotPtbMachineReadout({
      sections,
      spot: model.last,
      ptb: priceToBeat,
      bandUsd: Math.max(0.5, model.band),
      lastProbUp,
      lastProbDown,
      controlSignal: derivedStrip?.controlSignal ?? 'NO_EDGE',
      dwellMajoritySign: derivedStrip?.dwellMajoritySign ?? 0,
      slopeUsdPerSec: derivedStrip?.slopeUsdPerSec ?? null,
      primaryLane: primaryCall.lane,
      endsInMs: endsInMs ?? null,
      crossEstimate,
      acceleration,
      mtf,
      overextension,
      endingProb,
      edges: laneEdges,
      tape: tapeVelocity,
      tapeLane: tapeLane ?? null,
      wallFlow,
    });
  }, [
    sections,
    model,
    priceToBeat,
    derivedStrip?.controlSignal,
    derivedStrip?.dwellMajoritySign,
    derivedStrip?.slopeUsdPerSec,
    lastProbUp,
    lastProbDown,
    primaryCall.lane,
    endsInMs,
    crossEstimate,
    acceleration,
    mtf,
    overextension,
    endingProb,
    laneEdges,
    tapeVelocity,
    tapeLane,
    wallFlow,
  ]);

  const machineReadoutRef = useRef(machineReadout);
  machineReadoutRef.current = machineReadout;
  const machineReadoutKey = machineReadoutMeaningKey(machineReadout);

  useEffect(() => {
    if (!publishDesk) return;
    onMachineReadout?.(machineReadoutRef.current);
  }, [publishDesk, machineReadoutKey, onMachineReadout]);

  /**
   * Top-level "what should I actually do?" directive — fuses the machine readout
   * with the user's current position into a single verb (INITIATE / HOLD / FLIP /
   * TRIM / EXIT / ADD / STAND_DOWN). Pure derivation, see `tradeDirective.ts`.
   */
  const tradeDirective: TradeDirective | null = useMemo(() => {
    if (!machineReadout) return null;
    return buildTradeDirective({
      machine: machineReadout,
      forecast: switchForecast,
      currentPositionLane: currentPositionLane ?? null,
      upLabel,
      downLabel,
    });
  }, [machineReadout, switchForecast, currentPositionLane, upLabel, downLabel]);

  const tradeDirectiveRef = useRef(tradeDirective);
  tradeDirectiveRef.current = tradeDirective;
  const tradeDirectiveKey = tradeDirectiveMeaningKey(tradeDirective);

  useEffect(() => {
    if (!publishDesk) return;
    onTradeDirective?.(tradeDirectiveRef.current);
  }, [publishDesk, tradeDirectiveKey, onTradeDirective]);

  const switchForecastRef = useRef(switchForecast);
  switchForecastRef.current = switchForecast;
  const switchForecastKey = switchForecastMeaningKey(switchForecast);

  useEffect(() => {
    if (!publishDesk) return;
    onSwitchForecast?.(switchForecastRef.current);
  }, [publishDesk, switchForecastKey, onSwitchForecast]);

  /** Auto-suggested take-profit / stop-loss levels for the Answer card (directive lane, else best +EV book). */
  const tradeLevels: TradeLevels | null = useMemo(
    () =>
      resolveTradeLevelsForDirective({
        directive: tradeDirective,
        laneEdges,
        crossProb: machineReadout?.crossProb ?? null,
        endsInMs: endsInMs ?? null,
      }),
    [tradeDirective, laneEdges, machineReadout?.crossProb, endsInMs],
  );

  /** Hypothetical TP/SL for the sectional incoming lane when it differs from the card (preview only). */
  const incomingSwitchLevels: TradeLevels | null = useMemo(() => {
    const sf = switchForecast;
    if (!sf || sf.status !== 'SWITCH_INCOMING' || sf.incomingLane == null || !laneEdges) return null;
    if (tradeDirective?.lane == null || tradeDirective.lane === sf.incomingLane) return null;
    const cp = machineReadout?.crossProb ?? crossEstimate?.prob ?? null;
    return suggestLevelsForLane({
      lane: sf.incomingLane,
      laneEdges,
      crossProb: cp,
      endsInMs: endsInMs ?? null,
    });
  }, [switchForecast, tradeDirective?.lane, laneEdges, machineReadout?.crossProb, crossEstimate?.prob, endsInMs]);

  /**
   * Stability tracker — kills whipsaw trades by showing the user how long the
   * directive has been steady. Holds state via useState so the next render gets
   * the previous snapshot for change detection.
   */
  const directiveStability = useDirectiveStability(tradeDirective, deskResetKey);

  /** Sensor-vs-directive discrepancy check for the warning stripe. */
  const directiveDiscrepancy: DirectiveDiscrepancy | null = useMemo(() => {
    if (!tradeDirective || !machineReadout) return null;
    return detectDirectiveDiscrepancy(tradeDirective, machineReadout);
  }, [tradeDirective, machineReadout]);

  /**
   * Re-entry guard. Track the previous directive in a ref so transitions
   * (EXIT / FLIP / STAND_DOWN / TRIM) stamp a cool-down on the just-vacated lane.
   * `reEntryCheck` holds the live check used by the card to render the chip /
   * stripe and to feed the sizing multiplier.
   */
  const [reEntryState, setReEntryState] = useState<ReEntryState | null>(null);
  const previousDirectiveRef = useRef<TradeDirective | null>(null);
  // Reason-tagged cool-downs need fresh stability/discrepancy/edge at the
  // moment of the transition, so we read them from refs the next effect keeps
  // current. (We can't depend on them in this effect or it would re-run too often.)
  const stabilityRef = useRef<DirectiveStability | null>(null);
  const discrepancyRef = useRef<DirectiveDiscrepancy | null>(null);
  const laneEdgesRef = useRef<LaneEdges | null>(null);
  useEffect(() => {
    stabilityRef.current = directiveStability;
  }, [directiveStability]);
  useEffect(() => {
    discrepancyRef.current = directiveDiscrepancy;
  }, [directiveDiscrepancy]);
  useEffect(() => {
    laneEdgesRef.current = laneEdges;
  }, [laneEdges]);
  // Mirror the live verdict inputs into refs so the BOOM dispatch effect can
  // build the operator verdict at fire time without re-subscribing to all of
  // them (which would noisily re-run the effect on every directive tick).
  const directiveRef = useRef<TradeDirective | null>(null);
  const tradeLevelsRef = useRef<TradeLevels | null>(null);
  const reEntryCheckRef = useRef<ReEntryGuardCheck | null>(null);
  const sizingMultiplierRef = useRef<SizingMultiplier | null>(null);
  const noTradeScoreRef = useRef<NoTradeScore | null>(null);
  useEffect(() => {
    if (!tradeDirective) return;
    const prev = previousDirectiveRef.current;
    if (featureFlags.reasonCooldowns) {
      const exitingLane = prev?.lane ?? null;
      const exitingLaneEdge = exitingLane && laneEdgesRef.current
        ? exitingLane === 'up'
          ? laneEdgesRef.current.up
          : laneEdgesRef.current.down
        : null;
      const reason = classifyExitReason({
        whipsaw: stabilityRef.current?.tier === 'whipsaw',
        highDiscrepancy: discrepancyRef.current?.shouldBlock ?? false,
        edgeUsd: exitingLaneEdge?.edgePerShareUsd ?? null,
      });
      setReEntryState((current) =>
        updateReEntryStateWithReason(current, tradeDirective, prev, Date.now(), reason),
      );
    } else {
      setReEntryState((current) => updateReEntryState(current, tradeDirective, prev, Date.now()));
    }
    previousDirectiveRef.current = tradeDirective;
  }, [tradeDirective, featureFlags.reasonCooldowns]);
  // Tick the re-entry check every second so the chip counts down even when the
  // directive itself is steady. Cheap — just a setState with the same data.
  const [reEntryNow, setReEntryNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setReEntryNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const reEntryCheck: ReEntryGuardCheck | null = useMemo(() => {
    if (!tradeDirective || !reEntryState) return null;
    return checkReEntry(reEntryState, tradeDirective, reEntryNow);
  }, [tradeDirective, reEntryState, reEntryNow]);

  /** Confidence-adjusted sizing multiplier (stability × discrepancy × edge × cool-down). */
  const sizingMultiplier: SizingMultiplier | null = useMemo(() => {
    if (!tradeDirective) return null;
    return computeSizingMultiplier({
      stability: directiveStability,
      discrepancy: directiveDiscrepancy,
      edges: laneEdges,
      lane: tradeDirective.lane,
      cooldownActive: reEntryCheck?.onCooldown ?? false,
    });
  }, [tradeDirective, directiveStability, directiveDiscrepancy, laneEdges, reEntryCheck]);

  // Keep verdict-input refs current so the BOOM dispatch effect can call
  // buildOperatorVerdict at fire time without depending on these in its deps.
  useEffect(() => {
    directiveRef.current = tradeDirective;
  }, [tradeDirective]);
  useEffect(() => {
    tradeLevelsRef.current = tradeLevels;
  }, [tradeLevels]);
  useEffect(() => {
    reEntryCheckRef.current = reEntryCheck;
  }, [reEntryCheck]);
  useEffect(() => {
    sizingMultiplierRef.current = sizingMultiplier;
  }, [sizingMultiplier]);

  /**
   * Decision journal — rolling history of directive changes for the mini-tape
   * on the card. Reset whenever the slug changes (new round = clean slate).
   */
  const [directiveJournal, setDirectiveJournal] = useState<DirectiveJournal>(() => resetJournal());
  useEffect(() => {
    setDirectiveJournal(resetJournal());
  }, [slug, deskResetKey]);
  useEffect(() => {
    if (!tradeDirective) return;
    setDirectiveJournal((prev) =>
      appendDirectiveToJournal(prev, tradeDirective, machineReadout, Date.now()),
    );
  }, [tradeDirective, machineReadout]);

  /**
   * No-Trade composite — fuses whipsaw, discrepancy, edge, overextension,
   * regime, settlement, cool-down, and tape into a single 0..100 stand-down score.
   */
  const noTradeScore: NoTradeScore | null = useMemo(() => {
    return computeNoTradeScore({
      stability: directiveStability,
      discrepancy: directiveDiscrepancy,
      edges: laneEdges,
      lane: tradeDirective?.lane ?? null,
      machine: machineReadout,
      overextension,
      reEntry: reEntryCheck,
      tape: tapeVelocity,
      inSettlement: machineReadout?.urgency === 'settlement',
    });
  }, [
    directiveStability,
    directiveDiscrepancy,
    laneEdges,
    tradeDirective?.lane,
    machineReadout,
    overextension,
    reEntryCheck,
    tapeVelocity,
  ]);
  useEffect(() => {
    noTradeScoreRef.current = noTradeScore;
  }, [noTradeScore]);

  const noTradeScoreKey = noTradeScoreMeaningKey(noTradeScore);

  useEffect(() => {
    if (!publishDesk) return;
    onNoTradeScore?.(noTradeScoreRef.current);
  }, [publishDesk, noTradeScoreKey, onNoTradeScore]);

  /**
   * Operator verdict — same fusion the trade card displays. Hoisted to the
   * chart so the No-Trade banner can collapse to a thin strip when the verdict
   * is already shouting STAND_DOWN (avoids two screaming red blocks).
   */
  const operatorVerdict = useMemo(
    () =>
      buildOperatorVerdict({
        directive: tradeDirective,
        levels: tradeLevels,
        stability: directiveStability,
        discrepancy: directiveDiscrepancy,
        reEntry: reEntryCheck,
        sizingMultiplier,
        noTradeScore,
      }),
    [
      tradeDirective,
      tradeLevels,
      directiveStability,
      directiveDiscrepancy,
      reEntryCheck,
      sizingMultiplier,
      noTradeScore,
    ],
  );

  /** True when a real directive exists but operator verdict is STAND_DOWN — structural signals may still run, but execution hints should defer to the card. */
  const executionClash = useMemo(
    () => tradeDirective != null && operatorVerdict.isStandDown,
    [tradeDirective, operatorVerdict.isStandDown],
  );

  /** Sectional banner is WAIT but the card already cleared GO — different scopes (slice vs full model), not a wiring bug. */
  const tapeWaitCardGo = useMemo(
    () =>
      tradeDirective != null &&
      !operatorVerdict.isStandDown &&
      (operatorVerdict.state === 'GO_LONG' || operatorVerdict.state === 'GO_SHORT') &&
      switchForecast != null &&
      switchForecast.status === 'WAIT',
    [tradeDirective, operatorVerdict.isStandDown, operatorVerdict.state, switchForecast],
  );

  // Late-binding refs so keyboard handlers can call setters/callbacks defined
  // further down in the component body (avoid hoisting ordering issues).
  const dismissBannersRef = useRef<() => void>(() => undefined);
  const fireTestBoomRef = useRef<() => void>(() => undefined);
  const lastBoomChimeKeyRef = useRef<string>('');
  const onExportJournal = useCallback(() => {
    downloadJournalCsv(directiveJournal, slug);
  }, [directiveJournal, slug]);
  const onToggleSound = useCallback(() => {
    primeBoomChime();
    setFeatureFlag('boomSound', !featureFlags.boomSound);
  }, [featureFlags.boomSound]);
  useKeyboardShortcuts(
    {
      onToggleHelp: () => setShortcutHelpOpen((v) => !v),
      onDismiss: () => dismissBannersRef.current(),
      onToggleSound,
      onTogglePinnedNote: () => setPinnedNoteVisible((v) => !v),
      onTestBoom: () => fireTestBoomRef.current(),
      onExportJournal,
    },
    featureFlags.keyboardShortcuts,
  );

  /**
   * Imminent PTB cross alert — fires once when cross prob crosses ≥ 70% with high
   * confidence and re-arms only after prob falls back below 55%. This is decoupled
   * from BOOM (which is about agreement + dwell) so the user gets a heads-up purely
   * on barrier-crossing probability, even when sensors are split.
   */
  const lastCrossImminentRef = useRef<{ armed: boolean }>({ armed: true });
  const [crossImminentBanner, setCrossImminentBanner] = useState<{
    prob: number;
    currentSide: 'above' | 'below' | 'at';
    expiresAtMs: number;
  } | null>(null);
  useEffect(() => {
    if (!crossEstimate || crossEstimate.confidence === 'low') return;
    const pct = crossEstimate.prob;
    const armed = lastCrossImminentRef.current.armed;
    if (!armed) {
      // Re-arm once prob settles back down so we can fire again later.
      if (pct < 0.55) lastCrossImminentRef.current.armed = true;
      return;
    }
    if (pct < 0.7) return;
    lastCrossImminentRef.current.armed = false;
    const dist = crossEstimate.distanceUsd;
    const currentSide: 'above' | 'below' | 'at' =
      Math.abs(dist) <= 0.25 ? 'at' : dist > 0 ? 'above' : 'below';
    setCrossImminentBanner({
      prob: pct,
      currentSide,
      expiresAtMs: Date.now() + 8_000,
    });
    try {
      window.dispatchEvent(
        new CustomEvent(PTB_CROSS_IMMINENT_EVENT, {
          detail: {
            slug: slug ?? '',
            prob: pct,
            currentSide,
            distanceUsd: dist,
            horizonSec: crossEstimate.horizonSec,
            upLabel,
            downLabel,
          } satisfies PtbCrossImminentDetail,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [crossEstimate, slug, upLabel, downLabel]);

  useEffect(() => {
    if (!crossImminentBanner) return;
    const remain = crossImminentBanner.expiresAtMs - Date.now();
    if (remain <= 0) {
      setCrossImminentBanner(null);
      return;
    }
    const id = window.setTimeout(() => setCrossImminentBanner(null), remain);
    return () => window.clearTimeout(id);
  }, [crossImminentBanner]);

  /**
   * Notify listeners (SignalsTradePanel) when the forecast status transitions —
   * so the user gets a toast for "SWITCH INCOMING" / "EXIT" / "GO IN" without
   * staring at the chart.
   */
  const lastForecastKeyRef = useRef<string>('');
  useEffect(() => {
    if (!switchForecast) return;
    const entryish =
      switchForecast.status === 'GO_IN' ||
      switchForecast.status === 'STAY_IN' ||
      switchForecast.status === 'SWITCH_INCOMING';
    const guardBlocksToast = entryish && executionClash;
    const key = `${switchForecast.status}|${switchForecast.lane ?? '-'}|${switchForecast.incomingLane ?? '-'}|${switchForecast.confidence}|${entryish ? (executionClash ? 'blk' : 'go') : 'na'}`;
    if (key === lastForecastKeyRef.current) return;
    lastForecastKeyRef.current = key;
    if (switchForecast.status === 'WAIT') return;
    // Skip LOW-confidence STAY_IN noise — that would toast on every micro tick.
    if (switchForecast.status === 'STAY_IN' && switchForecast.confidence === 'LOW') return;
    if (guardBlocksToast) return;
    try {
      window.dispatchEvent(
        new CustomEvent(SECTIONAL_DECISION_EVENT, {
          detail: {
            slug: slug ?? '',
            status: switchForecast.status,
            lane: switchForecast.lane,
            driftLane: switchForecast.driftLane,
            incomingLane: switchForecast.incomingLane,
            confidence: switchForecast.confidence,
            etaSec: switchForecast.etaSec,
            headline: switchForecast.headline,
            reason: switchForecast.reason,
          } satisfies SectionalDecisionDetail,
        }),
      );
    } catch {
      /* dispatchEvent rarely throws; ignore. */
    }
  }, [switchForecast, slug, executionClash]);

  /**
   * BOOM detection — when SWITCH_INCOMING / EXIT / GO_IN persists in the same
   * direction for a few ticks (regardless of MED↔HIGH confidence flicker), or when
   * all three signals — primary + sectional drift + book flow — agree on one tick,
   * we treat it as *confirmed* and fire a louder event with a big in-chart overlay.
   *
   * Dwell tracks `(status, lane, incomingLane)` only — confidence is allowed to
   * wobble so the boom doesn't reset every micro tick.
   */
  type BoomState = {
    kind: 'OPPOSITE_INCOMING' | 'EXIT_NOW' | 'TRIPLE_CONFIRM_ENTRY';
    lane: 'up' | 'down';
    headline: string;
    reason: string;
    etaSec: number | null;
    /** Wall-clock when the boom should fade out of the overlay. */
    expiresAtMs: number;
  };
  const [boom, setBoom] = useState<BoomState | null>(null);
  const dwellRef = useRef<{
    key: string;
    count: number;
    bestConf: 'HIGH' | 'MED' | 'LOW';
    /** Last spot series timestamp — dwell ticks only advance on fresh ticks, not on machineReadout churn. */
    lastSpotT: number;
  }>({ key: '', count: 0, bestConf: 'LOW', lastSpotT: 0 });
  const lastBoomKeyRef = useRef<string>('');
  /** Surface dwell to UI so the user can see "we're watching, 2/3 confirmed". */
  const [dwellInfo, setDwellInfo] = useState<{ count: number; need: number } | null>(null);

  /**
   * Boom chime — play a short tone when a fresh BOOM appears, gated on the
   * `boomSound` flag. Track the last boom key so we don't replay on tick churn.
   */
  useEffect(() => {
    if (!boom || !featureFlags.boomSound) return;
    const key = `${boom.kind}|${boom.lane}`;
    if (lastBoomChimeKeyRef.current === key) return;
    lastBoomChimeKeyRef.current = key;
    try {
      playBoomChime(boom.kind);
    } catch {
      /* ignore audio errors */
    }
  }, [boom, featureFlags.boomSound]);

  /** TP/SL on the BOOM lane — uses terminal-probability lane edges (same math as trade card). */
  const boomLevels: TradeLevels | null = useMemo(() => {
    if (!boom) return null;
    const cp = machineReadout?.crossProb ?? crossEstimate?.prob ?? null;
    return suggestLevelsForLane({
      lane: boom.lane,
      laneEdges,
      crossProb: cp,
      endsInMs: endsInMs ?? null,
    });
  }, [boom, laneEdges, machineReadout?.crossProb, crossEstimate?.prob, endsInMs]);

  const boomOppositeMid: number | null = useMemo(() => {
    if (!boom || !laneEdges) return null;
    return (boom.lane === 'up' ? laneEdges.down?.mid : laneEdges.up?.mid) ?? null;
  }, [boom, laneEdges]);

  const boomIncomingEdge = useMemo(() => {
    if (!boom || !laneEdges) return null;
    return boom.lane === 'up' ? laneEdges.up : laneEdges.down;
  }, [boom, laneEdges]);

  useEffect(() => {
    if (!switchForecast) return;
    const f = switchForecast;
    const key = `${f.status}|${f.lane ?? '-'}|${f.incomingLane ?? '-'}`;
    const lastSpotT = pts.length > 0 ? pts[pts.length - 1]!.t : 0;
    const confRank = (c: 'HIGH' | 'MED' | 'LOW') => (c === 'HIGH' ? 2 : c === 'MED' ? 1 : 0);
    if (dwellRef.current.key !== key) {
      dwellRef.current = { key, count: 1, bestConf: f.confidence, lastSpotT };
    } else if (lastSpotT > dwellRef.current.lastSpotT) {
      dwellRef.current.lastSpotT = lastSpotT;
      dwellRef.current.count += 1;
      if (confRank(f.confidence) > confRank(dwellRef.current.bestConf)) {
        dwellRef.current.bestConf = f.confidence;
      }
    }
    const dwell = dwellRef.current.count;
    const bestConf = dwellRef.current.bestConf;

    /** Triple-confirm: primary call ENTER + sectional drift on same lane + flow agrees. */
    const flowBias: -1 | 0 | 1 =
      derivedStrip == null
        ? 0
        : derivedStrip.controlSignal === 'UP_CONTROL'
          ? 1
          : derivedStrip.controlSignal === 'DOWN_CONTROL'
            ? -1
            : 0;
    const tripleEntry =
      (f.status === 'GO_IN' || f.status === 'STAY_IN') &&
      f.lane != null &&
      primaryCall.status === 'ENTER' &&
      primaryCall.lane === f.lane &&
      ((f.lane === 'up' && flowBias >= 0) || (f.lane === 'down' && flowBias <= 0));

    // Surface the dwell to the user so they can see when we're "watching".
    let needForBoom = 0;
    if (f.status === 'SWITCH_INCOMING' || f.status === 'EXIT') {
      needForBoom = bestConf === 'HIGH' ? 1 : bestConf === 'MED' ? 2 : 3;
    } else if (tripleEntry) {
      needForBoom = bestConf === 'HIGH' ? 1 : 2;
    }
    const dwellBlockedByGuards =
      executionClash && (f.status === 'SWITCH_INCOMING' || tripleEntry);
    setDwellInfo(needForBoom > 0 && !dwellBlockedByGuards ? { count: dwell, need: needForBoom } : null);

    /**
     * SWITCH/EXIT confirmation:
     *   HIGH conf      → fire on first tick (no dwell needed)
     *   MED conf       → fire after 2 same-direction ticks
     *   LOW conf       → fire after 3 same-direction ticks (still actionable structurally)
     */
    const switchConfirmed =
      (f.status === 'SWITCH_INCOMING' || f.status === 'EXIT') &&
      ((bestConf === 'HIGH' && dwell >= 1) ||
        (bestConf === 'MED' && dwell >= 2) ||
        (bestConf === 'LOW' && dwell >= 3));

    /** Triple-entry confirmation: HIGH on first tick, MED after 2 ticks, LOW never. */
    const tripleConfirmed = tripleEntry && ((bestConf === 'HIGH' && dwell >= 1) || (bestConf === 'MED' && dwell >= 2));

    /** BOOM only fires when fused sensors mostly agree — avoids flashy noise on pure conflicts. */
    const agree = machineReadout?.agreementScore;
    const BOOM_MIN_SWITCH = 38;
    const BOOM_MIN_TRIPLE = 56;
    const switchAgreeOk =
      machineReadout == null ||
      agree == null ||
      agree >= BOOM_MIN_SWITCH ||
      bestConf === 'HIGH';
    const tripleAgreeOk =
      machineReadout == null ||
      agree == null ||
      agree >= BOOM_MIN_TRIPLE;

    /**
     * Cross-prob gates — extra check for the lane the boom is firing for:
     *   - SWITCH/EXIT: incoming side must have ≥ 35% chance of crossing PTB before bell
     *     (otherwise the "switch" is statistically toothless even if drift agrees).
     *   - TRIPLE entry: must have ≥ 35% cross prob unless we're already on the right side
     *     of PTB and aligned with the lane (then crossing isn't required to win).
     *   - HIGH conf still bypasses for switches (urgent calls shouldn't be blocked).
     */
    const crossProb = crossEstimate?.prob ?? null;
    const crossConf = crossEstimate?.confidence ?? 'low';
    const crossOk =
      crossProb == null ||
      crossConf === 'low' ||
      bestConf === 'HIGH' ||
      crossProb >= 0.35;
    /** Settlement window (<60s): never fire new BOOM entries — only EXIT calls can fire. */
    const inSettlement = machineReadout?.urgency === 'settlement';

    let next: BoomState | null = null;
    if (switchConfirmed && switchAgreeOk && (crossOk || f.status === 'EXIT')) {
      // EXIT calls always fire (preserving capital is not gated by cross-prob).
      // SWITCH_INCOMING during settlement is suppressed — round won't have time.
      if (f.status === 'SWITCH_INCOMING' && inSettlement) {
        // skip
      } else {
        const incoming = f.incomingLane ?? (f.lane === 'up' ? 'down' : 'up');
        const lane = (f.status === 'EXIT' ? f.lane : incoming) ?? 'up';
        const isExit = f.status === 'EXIT';
        const incLabel = lane === 'up' ? upLabel : downLabel;
        const oppLabel = lane === 'up' ? downLabel : upLabel;
        next = {
          kind: isExit ? 'EXIT_NOW' : 'OPPOSITE_INCOMING',
          lane,
          headline: isExit
            ? `EXIT ${oppLabel.toUpperCase()} — ${incLabel.toUpperCase()} TAKING OVER`
            : `BOOM — ${incLabel.toUpperCase()} MOMENTUM INCOMING`,
          reason: f.reason,
          etaSec: f.etaSec,
          expiresAtMs: Date.now() + (bestConf === 'HIGH' ? 9_000 : 7_000),
        };
      }
    } else if (tripleConfirmed && tripleAgreeOk && crossOk && !inSettlement && f.lane != null) {
      const lane = f.lane;
      const incLabel = lane === 'up' ? upLabel : downLabel;
      next = {
        kind: 'TRIPLE_CONFIRM_ENTRY',
        lane,
        headline: `BOOM — TRIPLE CONFIRM · GO IN ${incLabel.toUpperCase()}`,
        reason: 'Spot vs PTB, sectional drift, and book flow all agree on this lane.',
        etaSec: null,
        expiresAtMs: Date.now() + 7_000,
      };
    }

    if (!next) return;

    // Same inputs as TradeDirectiveCard — the operator verdict is the single "enter /
    // don't enter" truth. BOOM used to fire purely on sectional + flow while guards
    // could still force DON'T TRADE on the card, which read as broken UX.
    const verdictAtFire = buildOperatorVerdict({
      directive: directiveRef.current,
      levels: tradeLevelsRef.current,
      stability: stabilityRef.current,
      discrepancy: discrepancyRef.current,
      reEntry: reEntryCheckRef.current,
      sizingMultiplier: sizingMultiplierRef.current,
      noTradeScore: noTradeScoreRef.current,
    });
    const hasDirectiveAtFire = directiveRef.current != null;
    const tripleMatchesVerdict =
      (verdictAtFire.state === 'GO_LONG' && next.lane === 'up') ||
      (verdictAtFire.state === 'GO_SHORT' && next.lane === 'down');
    if (next.kind === 'TRIPLE_CONFIRM_ENTRY' && hasDirectiveAtFire && !tripleMatchesVerdict) return;
    // OPPOSITE_INCOMING / EXIT_NOW: always surface — card may still say WAIT; overlay + clash copy explain the split.

    const boomKey = `${next.kind}|${next.lane}`;
    if (boomKey === lastBoomKeyRef.current) return; // already fired this exact boom; wait for state to clear
    lastBoomKeyRef.current = boomKey;
    setBoom(next);

    const crossProbMerged = machineReadout?.crossProb ?? crossEstimate?.prob ?? null;
    const incomingEdge = next.lane === 'up' ? laneEdges?.up : laneEdges?.down;
    const oppMid = next.lane === 'up' ? laneEdges?.down?.mid : laneEdges?.up?.mid;
    const lvls = incomingEdge
      ? suggestLevelsForLane({
          lane: next.lane,
          laneEdges,
          crossProb: crossProbMerged,
          endsInMs: endsInMs ?? null,
        })
      : null;

    try {
      window.dispatchEvent(
        new CustomEvent(SECTIONAL_BOOM_EVENT, {
          detail: {
            slug: slug ?? '',
            kind: next.kind,
            lane: next.lane,
            laneLabel: next.lane === 'up' ? upLabel : downLabel,
            oppositeLabel: next.lane === 'up' ? downLabel : upLabel,
            etaSec: next.etaSec,
            headline: next.headline,
            reason: next.reason,
            agreementScore: machineReadout?.agreementScore ?? null,
            crossProb: crossProbMerged,
            modelWinPct: incomingEdge ? Math.round(incomingEdge.pWin * 100) : null,
            edgePerShareUsd: incomingEdge?.edgePerShareUsd ?? null,
            edgeQuality: incomingEdge?.quality ?? null,
            oppositeMid: oppMid ?? null,
            takeProfit: lvls?.takeProfit ?? null,
            stopLoss: lvls?.stopLoss ?? null,
            rrRatio: lvls?.rrRatio ?? null,
            levelsCollapsed: lvls?.collapsed ?? false,
            verdict: {
              state: verdictAtFire.state,
              bigVerb: verdictAtFire.bigVerb,
              headline: verdictAtFire.headline,
              reason: verdictAtFire.reason,
              confidence: verdictAtFire.confidence,
            },
          } satisfies SectionalBoomDetail,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [
    switchForecast,
    derivedStrip,
    primaryCall.status,
    primaryCall.lane,
    slug,
    upLabel,
    downLabel,
    machineReadout,
    crossEstimate,
    laneEdges,
    endsInMs,
    executionClash,
    pts,
  ]);

  /** Clear stale booms when their TTL expires or the forecast moves to WAIT. */
  useEffect(() => {
    if (!boom) return;
    const remain = boom.expiresAtMs - Date.now();
    if (remain <= 0) {
      setBoom(null);
      return;
    }
    const id = window.setTimeout(() => setBoom(null), remain);
    return () => window.clearTimeout(id);
  }, [boom]);

  /** Allow the next boom once the forecast has actually changed away from a confirmed state. */
  useEffect(() => {
    if (!switchForecast) return;
    if (switchForecast.status === 'WAIT' || switchForecast.status === 'STAY_IN') {
      lastBoomKeyRef.current = '';
    }
  }, [switchForecast]);

  /**
   * Manual "test boom" — lets the user verify the overlay/animation paint without
   * waiting for a real signal. Lane mirrors the active mode so the colors match.
   */
  const fireTestBoom = useCallback(() => {
    const lane: 'up' | 'down' = mode;
    const incLabel = lane === 'up' ? upLabel : downLabel;
    const oppLabel = lane === 'up' ? downLabel : upLabel;
    setBoom({
      kind: 'OPPOSITE_INCOMING',
      lane,
      headline: `TEST — ${incLabel.toUpperCase()} MOMENTUM INCOMING`,
      reason: `(Test fire — overlay preview only.) Real booms watch sectional drift vs the last 30–60s slope on ${oppLabel} → ${incLabel}.`,
      etaSec: 30,
      expiresAtMs: Date.now() + 6_000,
    });
  }, [mode, upLabel, downLabel]);
  // Bind the keyboard-shortcut callbacks now that fireTestBoom & setCrossImminentBanner exist.
  useEffect(() => {
    fireTestBoomRef.current = fireTestBoom;
  }, [fireTestBoom]);
  useEffect(() => {
    dismissBannersRef.current = () => {
      setBoom(null);
      setCrossImminentBanner(null);
      setShortcutHelpOpen(false);
    };
  }, []);

  /** Key price levels — swing highs/lows from candles for S/R. */
  const priceLevels = useMemo(() => {
    if (!model || model.candles.length < 5) return [];
    const candles = model.candles;
    const levels: { price: number; kind: 'high' | 'low' }[] = [];
    for (let i = 2; i < candles.length - 2; i++) {
      const c = candles[i]!;
      const prevH = Math.max(candles[i - 1]!.h, candles[i - 2]!.h);
      const nextH = Math.max(candles[i + 1]!.h, candles[i + 2]!.h);
      if (c.h > prevH && c.h > nextH) levels.push({ price: c.h, kind: 'high' });
      const prevL = Math.min(candles[i - 1]!.l, candles[i - 2]!.l);
      const nextL = Math.min(candles[i + 1]!.l, candles[i + 2]!.l);
      if (c.l < prevL && c.l < nextL) levels.push({ price: c.l, kind: 'low' });
    }
    const eps = (model.plotMax - model.plotMin) * 0.02;
    const deduped: typeof levels = [];
    for (const lv of levels) {
      if (!deduped.some((d) => Math.abs(d.price - lv.price) < eps)) deduped.push(lv);
    }
    return deduped.slice(0, 6);
  }, [model]);

  const buildup: MomentumBuildup | null = useMemo(() => {
    if (!model || !derivedStrip || model.candles.length < 4) return null;
    const candles = model.candles;
    const n = candles.length;
    let score = 0;
    const signals: string[] = [];

    // 1. Consecutive closes in same direction (streak)
    const streak = derivedStrip.momentumStreak;
    const mom = derivedStrip.momentum;
    if (streak >= 4) { score += 30; signals.push(`${streak}-candle streak`); }
    else if (streak >= 3) { score += 20; signals.push(`${streak}-candle streak`); }
    else if (streak >= 2) { score += 8; }

    // 2. Body expansion — are recent bodies getting bigger? (momentum loading)
    const recentBodies: number[] = [];
    const olderBodies: number[] = [];
    const half = Math.floor(n / 2);
    for (let i = 0; i < n; i++) {
      const body = Math.abs(candles[i]!.c - candles[i]!.o);
      if (i >= half) recentBodies.push(body); else olderBodies.push(body);
    }
    const avgRecent = recentBodies.length > 0 ? recentBodies.reduce((a, b) => a + b, 0) / recentBodies.length : 0;
    const avgOlder = olderBodies.length > 0 ? olderBodies.reduce((a, b) => a + b, 0) / olderBodies.length : 0;
    if (avgOlder > 0 && avgRecent > avgOlder * 1.8) { score += 20; signals.push('bodies expanding'); }
    else if (avgOlder > 0 && avgRecent > avgOlder * 1.3) { score += 10; signals.push('bodies growing'); }

    // 3. Squeeze detection — tight range then expansion
    const lastThree = candles.slice(-3);
    const priorFive = candles.slice(Math.max(0, n - 8), Math.max(0, n - 3));
    if (priorFive.length >= 2 && lastThree.length >= 2) {
      const priorAvgRange = priorFive.reduce((s, c) => s + (c.h - c.l), 0) / priorFive.length;
      const lastRange = lastThree[lastThree.length - 1]!.h - lastThree[lastThree.length - 1]!.l;
      const priorMinRange = Math.min(...priorFive.map(c => c.h - c.l));
      if (priorMinRange < priorAvgRange * 0.5 && lastRange > priorAvgRange * 1.4) {
        score += 25; signals.push('squeeze breakout');
      } else if (priorMinRange < priorAvgRange * 0.65 && lastRange > priorAvgRange * 1.1) {
        score += 12; signals.push('range expanding');
      }
    }

    // 4. Slope acceleration — current slope faster than earlier slope
    if (pts.length >= 8) {
      const halfPts = Math.floor(pts.length / 2);
      const earlySlope = computeTickSlopeUsdPerSec(pts.slice(0, halfPts));
      const lateSlope = computeTickSlopeUsdPerSec(pts.slice(halfPts));
      const accel = Math.abs(lateSlope.slopeUsdPerSec) - Math.abs(earlySlope.slopeUsdPerSec);
      if (accel > 0 && Math.abs(lateSlope.slopeUsdPerSec) > Math.abs(earlySlope.slopeUsdPerSec) * 1.8) {
        score += 20; signals.push('accelerating');
      } else if (accel > 0 && Math.abs(lateSlope.slopeUsdPerSec) > Math.abs(earlySlope.slopeUsdPerSec) * 1.3) {
        score += 10; signals.push('slope rising');
      }
      if (accel < 0 && Math.abs(lateSlope.slopeUsdPerSec) < Math.abs(earlySlope.slopeUsdPerSec) * 0.4) {
        score -= 15; signals.push('decelerating');
      }
    }

    // 5. Stacking closes further from PTB (accumulating separation)
    if (priceToBeat != null && n >= 4) {
      const lastFour = candles.slice(-4);
      const dists = lastFour.map(c => c.c - priceToBeat!);
      const allSameSign = dists.every(d => d > 0) || dists.every(d => d < 0);
      const increasing = allSameSign && Math.abs(dists[3]!) > Math.abs(dists[0]!) * 1.15;
      if (increasing) { score += 15; signals.push('separating from PTB'); }
    }

    score = Math.max(0, Math.min(100, score));
    const direction = mom === 'UP' || mom === 'DOWN' ? mom : (score >= 20 ? (derivedStrip.slopeUsdPerSec > 0 ? 'UP' : 'DOWN') : 'NEUTRAL');
    let tier: MomentumBuildup['tier'];
    let label: string;
    if (score >= 70) { tier = 'FIRING'; label = 'Momentum firing — strong directional move underway'; }
    else if (score >= 45) { tier = 'READY'; label = 'Momentum ready — breakout conditions met'; }
    else if (score >= 25) { tier = 'BUILDING'; label = 'Momentum building — watch for continuation'; }
    else if (score >= 10) { tier = 'LOADING'; label = 'Momentum loading — early signs of buildup'; }
    else { tier = 'NONE'; label = 'No momentum buildup detected'; }

    return { score, direction, label, tier, signals };
  }, [model, derivedStrip, pts, priceToBeat]);

  const biasShift: BiasShift | null = useMemo(() => {
    if (!model || !derivedStrip || model.candles.length < 5 || priceToBeat == null) return null;
    const candles = model.candles;
    const n = candles.length;
    const reasons: string[] = [];

    // --- Bias score: -100 (strong down) to +100 (strong up) ---
    let raw = 0;

    // Candle streak direction
    const streak = derivedStrip.momentumStreak;
    const mom = derivedStrip.momentum;
    if (mom === 'UP') raw += Math.min(35, streak * 10);
    else if (mom === 'DOWN') raw -= Math.min(35, streak * 10);

    // Slope direction and magnitude
    const slope = derivedStrip.slopeUsdPerSec;
    const slopeContrib = Math.min(25, Math.abs(slope) * 800);
    raw += slope > 0 ? slopeContrib : -slopeContrib;

    // Position vs PTB
    const dist = model.last - priceToBeat;
    const distNorm = Math.min(20, (Math.abs(dist) / Math.max(model.band, 0.01)) * 5);
    raw += dist > 0 ? distNorm : -distNorm;

    // Last 3 candles: net direction
    const last3 = candles.slice(-3);
    const net3 = last3.reduce((s, c) => s + (c.c >= c.o ? 1 : -1), 0);
    raw += net3 * 7;

    const biasScore = Math.max(-100, Math.min(100, Math.round(raw)));
    const bias: BiasShift['bias'] = biasScore >= 50 ? 'STRONG UP' : biasScore >= 15 ? 'UP' : biasScore <= -50 ? 'STRONG DOWN' : biasScore <= -15 ? 'DOWN' : 'NEUTRAL';

    // --- Shift detection: is momentum about to reverse? ---
    let shifting = false;
    let shiftDir: BiasShift['shiftDir'] = null;
    let shiftUrgency: BiasShift['shiftUrgency'] = null;
    let shiftScore = 0;

    // 1. Opposing candle after streak (first sign of reversal)
    if (streak >= 2 && n >= 2) {
      const prev = candles[n - 2]!;
      const last = candles[n - 1]!;
      const prevBull = prev.c >= prev.o;
      const lastBull = last.c >= last.o;
      if (prevBull !== lastBull) {
        shiftScore += 25;
        reasons.push(lastBull ? 'first green after red streak' : 'first red after green streak');
      }
    }

    // 2. Wick rejection — long wick in opposite direction of trend
    if (n >= 1) {
      const last = candles[n - 1]!;
      const body = Math.abs(last.c - last.o);
      const range = last.h - last.l;
      if (range > 0) {
        const upperWick = last.h - Math.max(last.o, last.c);
        const lowerWick = Math.min(last.o, last.c) - last.l;
        if (mom === 'UP' && upperWick > body * 1.5 && upperWick > range * 0.45) {
          shiftScore += 30; reasons.push('rejection wick at top');
        }
        if (mom === 'DOWN' && lowerWick > body * 1.5 && lowerWick > range * 0.45) {
          shiftScore += 30; reasons.push('rejection wick at bottom');
        }
      }
    }

    // 3. Slope deceleration — was fast, now slowing
    if (pts.length >= 10) {
      const third = Math.floor(pts.length / 3);
      const earlySlope = computeTickSlopeUsdPerSec(pts.slice(0, third));
      const lateSlope = computeTickSlopeUsdPerSec(pts.slice(-third));
      const earlyAbs = Math.abs(earlySlope.slopeUsdPerSec);
      const lateAbs = Math.abs(lateSlope.slopeUsdPerSec);
      if (earlyAbs > 1e-9 && lateAbs < earlyAbs * 0.35) {
        shiftScore += 25; reasons.push('momentum fading');
      } else if (earlyAbs > 1e-9 && lateAbs < earlyAbs * 0.6) {
        shiftScore += 12; reasons.push('momentum slowing');
      }
      // Slope sign flip
      if (earlySlope.slopeUsdPerSec > 1e-9 && lateSlope.slopeUsdPerSec < -1e-9) {
        shiftScore += 30; reasons.push('slope flipped to sell');
      } else if (earlySlope.slopeUsdPerSec < -1e-9 && lateSlope.slopeUsdPerSec > 1e-9) {
        shiftScore += 30; reasons.push('slope flipped to buy');
      }
    }

    // 4. Body exhaustion — bodies shrinking in trend direction
    if (n >= 4 && (mom === 'UP' || mom === 'DOWN')) {
      const recent = candles.slice(-3);
      const prior = candles.slice(-6, -3);
      if (prior.length >= 2) {
        const avgRecentBody = recent.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / recent.length;
        const avgPriorBody = prior.reduce((s, c) => s + Math.abs(c.c - c.o), 0) / prior.length;
        if (avgPriorBody > 0 && avgRecentBody < avgPriorBody * 0.45) {
          shiftScore += 20; reasons.push('bodies exhausting');
        }
      }
    }

    // 5. Failed new high/low — tried to extend but closed back
    if (n >= 3) {
      const c1 = candles[n - 3]!;
      const c2 = candles[n - 2]!;
      const c3 = candles[n - 1]!;
      if (mom === 'UP' && c2.h > c1.h && c3.c < c2.c && c3.c < c2.o) {
        shiftScore += 20; reasons.push('failed new high');
      }
      if (mom === 'DOWN' && c2.l < c1.l && c3.c > c2.c && c3.c > c2.o) {
        shiftScore += 20; reasons.push('failed new low');
      }
    }

    if (shiftScore >= 35) {
      shifting = true;
      shiftDir = biasScore > 0 ? 'TO DOWN' : biasScore < 0 ? 'TO UP' : (slope < 0 ? 'TO DOWN' : 'TO UP');
      shiftUrgency = shiftScore >= 60 ? 'IMMINENT' : 'FORMING';
    }

    return { bias, biasScore, shifting, shiftDir, shiftUrgency, reasons };
  }, [model, derivedStrip, pts, priceToBeat]);

  const trailPointsStr = useMemo(() => {
    if (!model || model.candles.length < 3) return null;
    const iw = W - PAD_L - PAD_R;
    const ih = H - PAD_Y * 2;
    const span = Math.max(1e-9, model.plotMax - model.plotMin);
    const tSpan = Math.max(1, model.tMax - model.tMin);
    const xTime = (t: number) => PAD_L + ((t - model.tMin) / tSpan) * iw;
    const yPrice = (v: number) => PAD_Y + (1 - (v - model.plotMin) / span) * ih;
    const take = model.candles.slice(-6);
    if (take.length < 3) return null;
    return take.map((c) => `${xTime((c.t0 + c.t1) / 2).toFixed(1)},${yPrice(c.c).toFixed(1)}`).join(' ');
  }, [model]);

  const ptbMarkers = useMemo(() => {
    if (!model || priceToBeat == null || !derivedStrip)
      return {
        rejection: null as null | { xc: number; yc: number },
        breakBox: null as null | { xc: number; y: number; w: number; h: number },
      };
    const iw = W - PAD_L - PAD_R;
    const ih = H - PAD_Y * 2;
    const span = Math.max(1e-9, model.plotMax - model.plotMin);
    const tSpan = Math.max(1, model.tMax - model.tMin);
    const xOf = (t: number) => PAD_L + ((t - model.tMin) / tSpan) * iw;
    const yOf = (v: number) => PAD_Y + (1 - (v - model.plotMin) / span) * ih;
    const eps = derivedStrip.reaction.eps;
    const candles = model.candles;
    let rejection: { xc: number; yc: number } | null = null;
    if (derivedStrip.interaction === 'rejection' || derivedStrip.reaction.kind === 'rejecting_off_line') {
      for (let i = candles.length - 1; i >= 0; i--) {
        const c = candles[i]!;
        if (!candleStraddlesPtb(c, priceToBeat, eps)) continue;
        const x0 = xOf(c.t0);
        const x1 = xOf(c.t1);
        const xc = (x0 + x1) / 2;
        const yc = (yOf(c.h) + yOf(c.l)) / 2;
        rejection = { xc, yc };
        break;
      }
    }
    let breakBox: { xc: number; y: number; w: number; h: number } | null = null;
    const k = derivedStrip.reaction.kind;
    if (k === 'break_hold' || k === 'extension_confirming') {
      for (let i = candles.length - 1; i >= 1; i--) {
        const cur = candles[i]!;
        const prev = candles[i - 1]!;
        if (!candleStraddlesPtb(prev, priceToBeat, eps) || candleStraddlesPtb(cur, priceToBeat, eps)) continue;
        const x0 = xOf(cur.t0);
        const x1 = xOf(cur.t1);
        const xc = (x0 + x1) / 2;
        const slotW = x1 - x0;
        const bodyW = Math.max(18, Math.min(slotW * 0.88, iw * 0.072));
        const yO = yOf(cur.o);
        const yC = yOf(cur.c);
        const bodyH = Math.max(6, Math.abs(yC - yO) * 1.12);
        const yBody = yC < yO ? yC : yO;
        breakBox = { xc, y: yBody - (bodyH - Math.abs(yC - yO)) / 2, w: bodyW, h: bodyH };
        break;
      }
    }
    return { rejection, breakBox };
  }, [model, derivedStrip, priceToBeat]);

  const width = W;
  const height = plotBaseH;
  const padL = PAD_L;
  const padR = PAD_R;
  const padY = PAD_Y;
  const innerW = width - padL - padR;
  const innerH = height - padY * 2;

  /** Visual frame when PTB exists but we cannot plot candles yet (or no PTB at all). */
  const skeleton = useMemo(() => {
    if (priceToBeat != null && Number.isFinite(priceToBeat)) {
      let spotMin = priceToBeat;
      let spotMax = priceToBeat;
      for (let i = 0; i < pts.length; i++) {
        const v = pts[i]!.v;
        if (!Number.isFinite(v)) continue;
        if (v < spotMin) spotMin = v;
        if (v > spotMax) spotMax = v;
      }
      const needAbove = Math.max(0, spotMax - priceToBeat);
      const needBelow = Math.max(0, priceToBeat - spotMin);
      const halfSpan = Math.max(needAbove, needBelow, Math.abs(priceToBeat) * 3e-5, 1);
      let plotMin = priceToBeat - halfSpan * 1.08;
      let plotMax = priceToBeat + halfSpan * 1.08;
      if (!Number.isFinite(plotMin) || !Number.isFinite(plotMax) || !(plotMax > plotMin)) {
        plotMin = priceToBeat - Math.max(Math.abs(priceToBeat) * 5e-5, 2);
        plotMax = priceToBeat + Math.max(Math.abs(priceToBeat) * 5e-5, 2);
      }
      const band =
        pts.length >= 2 ? ptbTouchEpsilonUsd(pts, priceToBeat) : Math.max(Math.abs(priceToBeat) * 1.2e-4, 0.65, priceToBeat * 8e-5);
      const tEnd = pts.length >= 1 ? pts[pts.length - 1]!.t : lastUpdateMs ?? Date.now();
      let tMin = tEnd - 180_000;
      let tMax = tEnd;
      if (pts.length >= 1) {
        tMin = pts[0]!.t;
        tMax = pts.length >= 2 ? pts[pts.length - 1]!.t : pts[0]!.t + 90_000;
      }
      if (!(tMax > tMin)) tMax = tMin + 60_000;
      return { plotMin, plotMax, band, tMin, tMax, level: priceToBeat };
    }
    const tEnd = lastUpdateMs ?? Date.now();
    let tMin = tEnd - 180_000;
    let tMax = tEnd;
    if (pts.length >= 1) {
      tMin = pts[0]!.t;
      tMax = pts.length >= 2 ? pts[pts.length - 1]!.t : pts[0]!.t + 90_000;
    }
    if (!(tMax > tMin)) tMax = tMin + 60_000;
    if (pts.length >= 1) {
      let spotMin = Infinity;
      let spotMax = -Infinity;
      for (let i = 0; i < pts.length; i++) {
        const v = pts[i]!.v;
        if (!Number.isFinite(v)) continue;
        if (v < spotMin) spotMin = v;
        if (v > spotMax) spotMax = v;
      }
      if (Number.isFinite(spotMin) && Number.isFinite(spotMax)) {
        const mid = (spotMin + spotMax) / 2;
        const halfSpan = Math.max((spotMax - spotMin) / 2, Math.abs(mid) * 3e-5, 25);
        return {
          plotMin: mid - halfSpan * 1.08,
          plotMax: mid + halfSpan * 1.08,
          band: Math.max(halfSpan * 0.08, 0.5),
          tMin,
          tMax,
          level: null as number | null,
        };
      }
    }
    const plotMin = 0;
    const plotMax = 1;
    return { plotMin, plotMax, band: 0.05, tMin, tMax, level: null as number | null };
  }, [priceToBeat, pts, lastUpdateMs]);

  const projection = useMemo(() => {
    if (derivedStrip == null || !model) return null;
    const slope = derivedStrip.slopeUsdPerSec;
    if (slope == null || !Number.isFinite(slope)) return null;
    const t1 = 30;
    const t2 = 60;
    const p1 = model.last + slope * t1;
    const p2 = model.last + slope * t2;
    const hasStreak = derivedStrip.momentumStreak >= 3;
    return {
      p1,
      p2,
      t1,
      t2,
      label: `Proj ${t1}s`,
      sub: hasStreak ? `${derivedStrip.momentum} ×${derivedStrip.momentumStreak}` : null,
    };
  }, [derivedStrip, model]);

  const stableProjectedHeaderLive = useMemo(() => {
    if (!model || derivedStrip == null) return null;
    return computeStableProjectedHeader({
      spotLast: model.last,
      slopeUsdPerSec: derivedStrip.slopeUsdPerSec,
      ptb: priceToBeat,
      lastProbUp,
      lastProbDown,
      upLabel,
      downLabel,
      horizonSec: projection?.t1 ?? 30,
    });
  }, [model, derivedStrip, priceToBeat, lastProbUp, lastProbDown, upLabel, downLabel, projection?.t1]);

  const stableProjectedHeader = useStableProjectedHeaderDisplay(stableProjectedHeaderLive);

  const bandGaugeSnapshot = useMemo(() => {
    if (!model || priceToBeat == null || !Number.isFinite(priceToBeat)) return null;
    return computeSpotBandGaugeSnapshot({
      mode,
      spot: model.last,
      ptb: priceToBeat,
      band: model.band,
      conviction: model.conviction,
      slopeUsdPerMin: derivedStrip?.slopeUsdPerMin ?? null,
      distUsd: derivedStrip?.distanceUsd ?? null,
      proj30s: projection?.p1 ?? null,
      upLabel,
      downLabel,
    });
  }, [model, priceToBeat, mode, derivedStrip, projection, upLabel, downLabel]);

  const bandGaugeSnapshotKey = bandGaugeMeaningKey(bandGaugeSnapshot);
  const bandGaugeSnapshotRef = useRef(bandGaugeSnapshot);
  bandGaugeSnapshotRef.current = bandGaugeSnapshot;

  useEffect(() => {
    if (!publishDesk) return;
    onBandGaugeSnapshot?.(bandGaugeSnapshotRef.current);
  }, [publishDesk, bandGaugeSnapshotKey, onBandGaugeSnapshot]);

  if (!model) {
    const sk = skeleton;
    const sspan = Math.max(1e-9, sk.plotMax - sk.plotMin);
    const stSpan = Math.max(1, sk.tMax - sk.tMin);
    const skY = (v: number) => padY + (1 - (v - sk.plotMin) / sspan) * innerH;
    const skX = (t: number) => padL + ((t - sk.tMin) / stSpan) * innerW;
    const skYBeat = sk.level != null ? skY(sk.level) : padY + innerH * 0.5;
    const skBandTop = sk.level != null ? skY(sk.level + sk.band) : skYBeat - 40;
    const skBandBottom = sk.level != null ? skY(sk.level - sk.band) : skYBeat + 40;
    const tickPricesSk = Array.from({ length: 5 }, (_, i) => sk.plotMin + ((sk.plotMax - sk.plotMin) * i) / 4);
    const xTickTsSk = buildEvenXTicks(sk.tMin, sk.tMax);
    const isFreshSpotFeed = (spotFeedSource ?? '').toLowerCase().length > 0;
    const skeletonMsg =
      sk.level == null
        ? 'Load SSR price-to-beat — the yellow line will lock here.'
        : pts.length === 0
          ? isFreshSpotFeed
            ? `Waiting for first underlying tick (${spotFeedSource})…`
            : 'No underlying spot feed wired for this slug yet — only the PTB line will draw.'
          : 'Waiting for a second tick to draw candles…';
    return (
      <div className="flex min-h-0 flex-col rounded-[30px] border border-zinc-800/90 bg-[#0b1018] shadow-[0_28px_80px_rgba(0,0,0,0.35)] ring-1 ring-zinc-700/40">
        <header className="shrink-0 border-b border-zinc-800/80 px-4 py-3 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-lg font-semibold tracking-tight text-zinc-100 sm:text-xl">{chartTitle}</span>
                <span
                  className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    mode === 'up' ? 'border-emerald-700/50 bg-emerald-950/40 text-emerald-200' : 'border-rose-700/50 bg-rose-950/40 text-rose-200'
                  }`}
                >
                  {meta.label}
                </span>
              </div>
              <p className="mt-2 max-w-xl text-sm text-zinc-400">{skeletonMsg}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {endsInMs != null ? (
                <div className="rounded-xl border border-amber-900/45 bg-amber-950/35 px-3 py-2 text-center">
                  <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-amber-200/85">Time remaining</div>
                  <div className="font-mono text-lg font-bold tabular-nums text-amber-50">{fmtTimeRemaining(endsInMs)}</div>
                </div>
              ) : null}
              <div
                className={`flex items-center gap-2 rounded-2xl border px-3 py-2 text-[11px] font-bold uppercase tracking-wide ${
                  stale ? 'border-zinc-700 bg-zinc-900 text-zinc-500' : 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300'
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${stale ? 'bg-zinc-600' : 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.65)]'}`} />
                {stale ? 'Stale' : 'Live'}
              </div>
            </div>
          </div>
        </header>
        <div className={chartPanelWrapSk}>
          <svg
            viewBox={`0 0 ${width} ${svgHeight}`}
            className={chartSvgSk}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="Spot versus price to beat chart frame"
          >
            <defs>
              <linearGradient id={`ptbSkBand-${gradId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="rgba(161, 161, 170, 0.14)" />
                <stop offset="100%" stopColor="rgba(161, 161, 170, 0.05)" />
              </linearGradient>
            </defs>
            <rect x="0" y="0" width={width} height={svgHeight} fill="#0a0f16" />
            {sk.level != null ? (
              <>
                <rect
                  x={padL}
                  y={Math.min(skBandTop, skBandBottom)}
                  width={innerW}
                  height={Math.max(14, Math.abs(skBandBottom - skBandTop))}
                  fill={`url(#ptbSkBand-${gradId})`}
                />
                <text
                  x={padL + 8}
                  y={Math.min(skBandTop, skBandBottom) - 6}
                  fill="rgb(161 161 170)"
                  fontSize="10"
                  fontWeight="700"
                >
                  [ NO EDGE ZONE ]
                </text>
              </>
            ) : null}
            {tickPricesSk.map((tp, i) => (
              <g key={`skg-${i}`}>
                <line x1={padL} x2={padL + innerW} y1={skY(tp)} y2={skY(tp)} stroke="rgba(39,39,42,0.85)" strokeWidth="1" />
                <text x={width - padR + 6} y={skY(tp) + 4} fill="rgb(161 161 170)" fontSize="10" fontFamily="ui-monospace, monospace">
                  {fmtAxisPrice(tp)}
                </text>
              </g>
            ))}
            <line x1={padL} x2={padL + innerW} y1={skYBeat} y2={skYBeat} stroke="rgb(250 204 21)" strokeWidth="9" strokeLinecap="round" opacity={0.2} />
            <line
              x1={padL}
              x2={padL + innerW}
              y1={skYBeat}
              y2={skYBeat}
              stroke={sk.level != null ? 'rgb(250 204 21)' : 'rgba(161,161,170,0.45)'}
              strokeWidth={sk.level != null ? 2.8 : 1.5}
              strokeDasharray={sk.level != null ? undefined : '8 6'}
              strokeLinecap="round"
            />
            <text x={padL + 8} y={skYBeat - 10} fill={sk.level != null ? 'rgb(250 204 21)' : 'rgb(161 161 170)'} fontSize="11" fontWeight="800">
              {sk.level != null ? 'PTB' : 'PTB (not loaded)'}
            </text>
            {sk.level != null ? (
              <>
                <rect x={width - padR - 136} y={Math.max(padY + 8, skYBeat - 14)} width="128" height="24" rx="12" fill="rgb(250 204 21)" />
                <text
                  x={width - padR - 72}
                  y={Math.max(padY + 24, skYBeat + 4)}
                  textAnchor="middle"
                  fill="#0a0a0a"
                  fontSize="11"
                  fontWeight="800"
                >
                  PTB {fmtUsd(sk.level)}
                </text>
              </>
            ) : null}
            {pts.length === 1 && sk.level != null ? (
              <circle cx={skX(pts[0]!.t)} cy={skY(pts[0]!.v)} r={7} fill="white" stroke={meta.accent} strokeWidth="2.2" opacity={0.95} />
            ) : null}
            <text x={padL + innerW / 2} y={padY + innerH * 0.42} textAnchor="middle" fill="rgb(113 113 122)" fontSize="13" fontWeight="600">
              {skeletonMsg}
            </text>
            <text x={padL + innerW / 2} y={padY + innerH * 0.52} textAnchor="middle" fill="rgb(82 82 91)" fontSize="11">
              Time →
            </text>
            {xTickTsSk.map((ts, i) => (
              <text
                key={`skxt-${i}`}
                x={skX(ts)}
                y={svgHeight - 4}
                textAnchor="middle"
                fill="rgb(113 113 122)"
                fontSize="9"
                fontFamily="ui-monospace, monospace"
              >
                {new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </text>
            ))}
          </svg>
        </div>
        <details className="mx-4 mb-3 mt-1 rounded-xl border border-zinc-800/50 bg-zinc-900/20 px-3 py-2 text-[11px] text-zinc-500">
          <summary className="cursor-pointer select-none font-semibold text-zinc-400">Attribution · framework</summary>
          <p className="mt-2 text-[10px] leading-snug text-zinc-600">{STREAM_ATTRIBUTION_LINE}</p>
          <p className="mt-2 text-zinc-500">{PTB_REACTION_ONE_LINER}</p>
        </details>
      </div>
    );
  }

  const span = Math.max(1e-9, model.plotMax - model.plotMin);
  const tSpan = Math.max(1, model.tMax - model.tMin);
  const yPrice = (v: number) => padY + (1 - (v - model.plotMin) / span) * innerH;
  const xTime = (t: number) => padL + ((t - model.tMin) / tSpan) * innerW;
  const yBeat = yPrice(priceToBeat!);
  const yBandTop = yPrice(priceToBeat! + model.band);
  const yBandBottom = yPrice(priceToBeat! - model.band);
  const tickPrices = Array.from({ length: 5 }, (_, i) => model.plotMin + ((model.plotMax - model.plotMin) * i) / 4);
  const xTickTs = buildEvenXTicks(model.tMin, model.tMax);
  const closeSeries =
    model.candles.length >= 2
      ? model.candles.map((c) => ({ x: xTime((c.t0 + c.t1) / 2), y: yPrice(c.c), v: c.c }))
      : pts.map((p) => ({ x: xTime(p.t), y: yPrice(p.v), v: p.v }));

  /** Raw ticks for LINE mode — smoother path on short timeframes than bucket mids. */
  const lineSeries = pts.map((p) => ({ x: xTime(p.t), y: yPrice(p.v), v: p.v }));
  const lineStroke = model.recentMove >= 0 ? 'rgb(74 222 128)' : 'rgb(251 113 133)';
  const lineFill = model.recentMove >= 0 ? 'rgba(74,222,128,0.14)' : 'rgba(251,113,133,0.14)';
  const linePathSeries = lineSeries.length >= 2 ? lineSeries : closeSeries;
  const lastPt = pts[pts.length - 1]!;
  const heatIntensity = clamp01(Math.abs(model.last - priceToBeat!) / Math.max(model.maxAbs, model.band * 1.5));
  const controlSig = derivedStrip?.controlSignal;
  const statusBarBorder =
    controlSig === 'UP_CONTROL'
      ? 'border-t-emerald-500/55'
      : controlSig === 'DOWN_CONTROL'
        ? 'border-t-rose-500/55'
        : controlSig === 'TRANSITION'
          ? 'border-t-amber-500/50'
          : controlSig === 'REJECTION'
            ? 'border-t-fuchsia-500/45'
            : 'border-t-zinc-600/60';

  const dwellTotal =
    derivedStrip != null ? derivedStrip.dwellAboveMs + derivedStrip.dwellBelowMs + derivedStrip.dwellAtMs : 0;
  const statusLine2 = statusSubtitle({ control: controlSig, momentum: derivedStrip?.momentum });
  const momArrow =
    derivedStrip?.momentum === 'UP' ? '↑' : derivedStrip?.momentum === 'DOWN' ? '↓' : '→';

  const positionVsPtbLabel = (() => {
    if (derivedStrip == null) return { title: '—', sub: 'Load data', className: 'border-zinc-600 bg-zinc-900/50 text-zinc-400' };
    const p = derivedStrip.position;
    if (p === 'ABOVE') {
      return {
        title: 'ABOVE PTB',
        sub: 'Spot is above the level (favors the "above PTB" side while price stays there)',
        className: 'border-emerald-500/50 bg-emerald-950/50 text-emerald-100',
      };
    }
    if (p === 'BELOW') {
      return {
        title: 'BELOW PTB',
        sub: 'Spot is under the level (favors the "below PTB" side while price stays there)',
        className: 'border-rose-500/50 bg-rose-950/50 text-rose-100',
      };
    }
    return {
      title: 'AT / CHOP',
      sub: 'Inside the touch band — edge vs settlement still unclear',
      className: 'border-amber-500/50 bg-amber-950/45 text-amber-100',
    };
  })();

  const pathNowLabel = (() => {
    if (derivedStrip == null) return { title: '—', sub: 'Candles in the visible window only', className: 'border-zinc-600 bg-zinc-900/50 text-zinc-400' };
    const m = derivedStrip.momentum;
    if (m === 'UP') {
      return {
        title: '↑ Pushing (short run)',
        sub: 'Recent buckets + slope: upward pressure — can still be below PTB on a bounce',
        className: 'border-sky-500/45 bg-sky-950/40 text-sky-100',
      };
    }
    if (m === 'DOWN') {
      return {
        title: '↓ Pressing (short run)',
        sub: 'Recent buckets + slope: downward pressure — can still be above PTB on a pullback',
        className: 'border-violet-500/40 bg-violet-950/35 text-violet-100',
      };
    }
    return {
      title: '→ Flat / mixed',
      sub: 'No clear candle push in this zoom — check Distance for side of line',
      className: 'border-zinc-500/50 bg-zinc-900/55 text-zinc-200',
    };
  })();

  const playbook = (() => {
    if (derivedStrip == null) {
      return {
        entry: '—',
        exit: '—',
        tp: '—',
        stop: '—',
        entryTone: 'border-zinc-700/60 bg-zinc-950/30 text-zinc-400',
        exitTone: 'border-zinc-700/60 bg-zinc-950/30 text-zinc-400',
      };
    }
    const bandHi = priceToBeat! + model.band;
    const bandLo = priceToBeat! - model.band;
    const hiTxt = fmtUsd(bandHi);
    const loTxt = fmtUsd(bandLo);
    const ptbTxt = fmtUsd(priceToBeat!);

    const inBand = derivedStrip.position === 'AT';
    const favorSide = mode === 'up' ? derivedStrip.position === 'ABOVE' : derivedStrip.position === 'BELOW';
    const againstSide = mode === 'up' ? derivedStrip.position === 'BELOW' : derivedStrip.position === 'ABOVE';
    const momAgree =
      mode === 'up' ? derivedStrip.momentum === 'UP' : derivedStrip.momentum === 'DOWN';
    const momAgainst =
      mode === 'up' ? derivedStrip.momentum === 'DOWN' : derivedStrip.momentum === 'UP';

    const entryBase = inBand
      ? `WAIT: let it separate outside the band (>${mode === 'up' ? hiTxt : loTxt}) and hold.`
      : favorSide
        ? `ENTER on pullback that stays outside the band (holds ${mode === 'up' ? hiTxt : loTxt}).`
        : `SKIP / FADE: you’re on the wrong side until reclaim (${mode === 'up' ? hiTxt : loTxt}).`;

    const exitBase = inBand
      ? `NO EDGE: exit if it can’t leave the band (around ${ptbTxt} ± ε).`
      : favorSide
        ? `EXIT if it re-enters the band (${loTxt}–${hiTxt}) or flips slope.`
        : `EXIT / don’t add until it reclaims the band edge (${mode === 'up' ? hiTxt : loTxt}).`;

    const entryAdd =
      derivedStrip.controlSignal === 'REJECTION'
        ? ' Rejection: wait for next clean hold.'
        : derivedStrip.controlSignal === 'TRANSITION'
          ? ' Transition: size down; confirm hold.'
          : momAgainst
            ? ' Momentum disagrees: avoid chasing.'
            : momAgree
              ? ' Momentum agrees: ok to press on confirmation.'
              : '';

    const exitAdd =
      derivedStrip.controlSignal === 'REJECTION'
        ? ' Treat as invalidation until reclaimed.'
        : derivedStrip.controlSignal === 'TRANSITION'
          ? ' Tighten risk; watch for rotation.'
          : '';

    const slope = derivedStrip.slopeUsdPerSec;
    const canProject = slope != null && Number.isFinite(slope) && !inBand && favorSide;
    const tpSec = 30;
    const projTp = canProject ? model.last + slope * tpSec : null;
    const tp =
      canProject && projTp != null
        ? `TP (proj ${tpSec}s): ${fmtUsd(projTp)}`
        : inBand
          ? `TP: — (in band)`
          : favorSide
            ? 'TP: — (need slope)'
            : 'TP: — (wrong side)';

    const stop =
      inBand
        ? `Stop: ${loTxt}–${hiTxt} (band)`
        : favorSide
          ? `Stop: back into band (${loTxt}–${hiTxt})`
          : `Stop: reclaim ${mode === 'up' ? hiTxt : loTxt}`;

    const entryTone = againstSide
      ? 'border-rose-700/50 bg-rose-950/20 text-rose-100'
      : inBand
        ? 'border-amber-700/50 bg-amber-950/15 text-amber-100'
        : 'border-emerald-700/50 bg-emerald-950/15 text-emerald-100';

    const exitTone = inBand
      ? 'border-amber-700/50 bg-amber-950/15 text-amber-100'
      : favorSide
        ? 'border-sky-700/45 bg-sky-950/15 text-sky-100'
        : 'border-zinc-700/60 bg-zinc-950/25 text-zinc-200';

    return {
      entry: `${entryBase}${entryAdd}`,
      exit: `${exitBase}${exitAdd}`,
      tp,
      stop,
      entryTone,
      exitTone,
    };
  })();

  return (
    <div
      className={`flex min-h-0 flex-col border border-zinc-800/90 bg-[#0b1018] ring-1 ring-zinc-700/40 ${
        signalsCombinedColumn
          ? 'rounded-2xl shadow-lg shadow-black/25'
          : 'rounded-[30px] shadow-[0_28px_80px_rgba(0,0,0,0.35)]'
      }`}
    >
      <div className={signalsEmbed ? 'flex w-full min-w-0 flex-col' : 'flex min-h-0 w-full min-w-0 flex-1 flex-col'}>
      <header className={`shrink-0 border-b border-zinc-800/80 bg-[#0b1018] ${signalsCombinedColumn ? 'px-2 py-2 sm:px-3' : 'px-4 py-3 sm:px-5'}`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            {!signalsCombinedColumn ? (
              <span className="truncate text-lg font-semibold tracking-tight text-zinc-100 sm:text-xl">{chartTitle}</span>
            ) : null}
            <span
              className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                mode === 'up' ? 'border-emerald-700/50 bg-emerald-950/40 text-emerald-200' : 'border-rose-700/50 bg-rose-950/40 text-rose-200'
              }`}
            >
              {meta.label}
            </span>
            {stableProjectedHeader ? (
              <StableProjectedHeaderDisplay
                snapshot={stableProjectedHeader}
                liveNowSpotUsd={model.last}
                confirmedBand={
                  bandGaugeSnapshot
                    ? {
                        bandHi: bandGaugeSnapshot.bandHi,
                        bandLo: bandGaugeSnapshot.bandLo,
                        ptb: bandGaugeSnapshot.ptb,
                      }
                    : null
                }
              />
            ) : (
              <>
                <span className="font-mono text-2xl font-semibold tabular-nums tracking-tight text-zinc-50 sm:text-3xl">{fmtUsd(model.last)}</span>
                <span className={`text-sm font-semibold tabular-nums ${model.recentMove >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {fmtUsdSigned(model.recentMove)} <span className="font-normal text-zinc-500">({fmtPctSigned(model.pctChange)})</span>
                </span>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {endsInMs != null ? (
              <div className="rounded-xl border border-amber-900/45 bg-amber-950/35 px-3 py-2 text-center shadow-sm shadow-black/20">
                <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-amber-200/85">Time remaining</div>
                <div className="font-mono text-lg font-bold tabular-nums leading-tight text-amber-50">{fmtTimeRemaining(endsInMs)}</div>
              </div>
            ) : null}
            <div className="inline-flex rounded-2xl border border-zinc-800/80 bg-black/25 p-1 shadow-inner shadow-black/30">
              <button
                type="button"
                onClick={() => setDisplayMode('line')}
                className={`rounded-xl px-3 py-2 text-[11px] font-semibold sm:px-4 sm:text-[12px] ${
                  displayMode === 'line' ? 'bg-zinc-700 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                LINE
              </button>
              <button
                type="button"
                onClick={() => setDisplayMode('ohlc')}
                className={`rounded-xl px-3 py-2 text-[11px] font-semibold sm:px-4 sm:text-[12px] ${
                  displayMode === 'ohlc' ? 'bg-zinc-600 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                OHLC
              </button>
            </div>
            <div className="inline-flex flex-wrap rounded-2xl border border-zinc-800/80 bg-black/25 p-1 shadow-inner shadow-black/30">
              {ZOOM_OPTIONS.map(({ sec, label }) => (
                <button
                  key={sec}
                  type="button"
                  onClick={() => setZoomWindow(sec)}
                  className={`rounded-xl px-2.5 py-2 text-[11px] font-semibold ${
                    zoomWindow === sec ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className={`rounded-2xl border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide ${
              model.status === 'UP BIAS'
                ? 'border-emerald-800/50 bg-emerald-950/30 text-emerald-200'
                : model.status === 'DOWN BIAS'
                  ? 'border-rose-800/50 bg-rose-950/30 text-rose-200'
                  : 'border-zinc-700/60 bg-zinc-900/40 text-zinc-200'
            }`}>
              {model.status}
            </div>
            <div
              className={`flex items-center gap-2 rounded-2xl border px-3 py-2 text-[11px] font-bold uppercase tracking-wide ${
                stale ? 'border-zinc-700 bg-zinc-900 text-zinc-500' : 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300'
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${stale ? 'bg-zinc-600' : 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.65)]'}`} />
              {stale ? 'Stale' : 'Live'}
            </div>
          </div>
        </div>
        {(fmtSourceChip(ptbSource) != null ||
          fmtSourceChip(spotFeedSource) != null ||
          tickMeta.n >= 2 ||
          (lastProbUp != null && Number.isFinite(lastProbUp)) ||
          (lastProbDown != null && Number.isFinite(lastProbDown))) ? (
          <div className="mt-2 flex flex-col gap-1.5 border-t border-zinc-800/50 pt-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] leading-snug text-zinc-500">
              {fmtSourceChip(ptbSource) != null ? (
                <span title="How the venue PTB was resolved for this slug">
                  <span className="font-semibold text-zinc-400">PTB</span>{' '}
                  <span className="font-mono text-zinc-300">{fmtSourceChip(ptbSource)}</span>
                </span>
              ) : null}
              {fmtSourceChip(spotFeedSource) != null ? (
                <span title="Underlying spot feed label from RTDS">
                  <span className="font-semibold text-zinc-400">Spot</span>{' '}
                  <span className="font-mono text-zinc-300">{fmtSourceChip(spotFeedSource)}</span>
                </span>
              ) : null}
              {tickMeta.n >= 2 ? (
                <span title="Tick coverage in the current zoom strip">
                  <span className="font-semibold text-zinc-400">Ticks</span>{' '}
                  <span className="font-mono text-zinc-300">
                    {tickMeta.n} pts · {tickMeta.spanSec < 120 ? `${tickMeta.spanSec.toFixed(0)}s` : `${(tickMeta.spanSec / 60).toFixed(1)}m`}{' '}
                    span · {tickMeta.zoomSec < 120 ? `${tickMeta.zoomSec}s` : `${tickMeta.zoomSec / 60}m`} zoom
                  </span>
                  {tickMeta.sparse ? (
                    <span className="ml-1 rounded border border-amber-800/50 bg-amber-950/30 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-200/90">
                      sparse
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
            <p className="text-[9px] text-zinc-600">Hover the chart plot for time, interpolated spot, and % vs PTB.</p>
          </div>
        ) : null}
        {!signalsCombinedColumn ? (
          <>
        <DeskClosePanel
          id="spot-level-path"
          title="Level & path"
          summary={`${positionVsPtbLabel.title} · ${pathNowLabel.title}`}
          defaultOpen={false}
          className="mt-2"
          bodyClassName="p-2"
        >
          <div className="flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-stretch sm:gap-3">
            <div
              className={`min-w-0 flex-1 rounded-xl border-2 px-3 py-2.5 shadow-md shadow-black/30 ${positionVsPtbLabel.className}`}
              title="Where spot is vs the fixed PTB: which side of the level is ahead right now, not the tick path."
            >
              <div className="text-[9px] font-extrabold uppercase tracking-[0.18em] text-inherit/90">1 · Level (vs PTB)</div>
              <div className="mt-0.5 text-lg font-black leading-tight tracking-tight sm:text-xl">{positionVsPtbLabel.title}</div>
              <div className="mt-1 text-[10px] leading-snug text-inherit/95">{positionVsPtbLabel.sub}</div>
            </div>
            <div
              className={`min-w-0 flex-1 rounded-xl border-2 px-3 py-2.5 shadow-md shadow-black/30 ${pathNowLabel.className}`}
              title="Candles + slope in the visible 1m–5m window only — can disagree with the level (pullback, bounce)."
            >
              <div className="text-[9px] font-extrabold uppercase tracking-[0.18em] text-inherit/90">2 · Path (this window)</div>
              <div className="mt-0.5 text-lg font-black leading-tight tracking-tight sm:text-xl">{pathNowLabel.title}</div>
              <div className="mt-1 text-[10px] leading-snug text-inherit/95">{pathNowLabel.sub}</div>
            </div>
          </div>
        </DeskClosePanel>
        <p className="mt-2 text-[10px] leading-snug text-zinc-600">
          <span className="font-semibold text-zinc-500">Read</span> — how spot behaves vs the fixed PTB line ·{' '}
          <span className="text-amber-200/80">Yellow</span> = PTB · LINE = ticks · OHLC = buckets
        </p>
        <DeskClosePanel
          id="spot-single-call"
          title="Single call"
          summary={`${primaryCall.status}${primaryCall.lane ? ` · ${primaryCall.lane === 'up' ? upLabel : downLabel}` : ' · NO SIDE'} · ${primaryCall.confidence}`}
          badge={
            executionClash ? (
              <span className="rounded border border-amber-600/40 bg-amber-950/30 px-1.5 py-px text-[8px] font-bold uppercase text-amber-200">
                Card overrides
              </span>
            ) : null
          }
          defaultOpen={false}
          className="mt-2"
          bodyClassName="px-3 py-2"
        >
          {executionClash ? (
            <div className="mb-2 rounded-lg border border-amber-700/45 bg-amber-950/25 px-2.5 py-2 text-[10px] font-semibold leading-snug text-amber-100/95">
              <span className="font-extrabold uppercase tracking-wide text-amber-200">Trade card overrides · </span>
              Spot strip can still read <span className="font-mono text-amber-50">ENTER</span> — the Answer card says{' '}
              <span className="font-mono text-amber-50">{operatorVerdict.bigVerb}</span> until blockers clear (
              {operatorVerdict.blockers.slice(0, 2).join(' · ') || operatorVerdict.headline}). Treat this box as{' '}
              <span className="italic text-amber-100/85">context</span>, not permission to size in.
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Single call</div>
            <div
              className={`rounded-lg border px-2 py-1 text-[10px] font-extrabold tracking-wide ${
                executionClash && primaryCall.status === 'ENTER'
                  ? 'border-amber-600/50 bg-amber-950/30 text-amber-100'
                  : primaryCall.status === 'ENTER'
                    ? primaryCall.lane === 'up'
                      ? 'border-emerald-500/45 bg-emerald-950/30 text-emerald-100'
                      : 'border-rose-500/45 bg-rose-950/25 text-rose-100'
                    : primaryCall.status === 'PREP'
                      ? 'border-amber-500/35 bg-amber-950/20 text-amber-100'
                      : 'border-zinc-700/70 bg-zinc-900/30 text-zinc-200'
              }`}
            >
              {primaryCall.status}
              {primaryCall.lane ? ` · ${primaryCall.lane === 'up' ? upLabel : downLabel}` : ' · NO SIDE'}
              {` · ${primaryCall.confidence}`}
            </div>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">{primaryCall.reason}</p>
          {primaryCall.gates.length ? (
            <div className="mt-2 rounded-lg border border-zinc-800/70 bg-black/30 px-2 py-2">
              <div className="text-[9px] font-black uppercase tracking-wide text-zinc-500">Entry gates (this chart)</div>
              <div className="mt-1.5 grid gap-x-2 gap-y-1 sm:grid-cols-2">
                {primaryCall.gates.map((g) => (
                  <div key={g.k} className="flex min-w-0 items-start justify-between gap-2">
                    <span className={`text-[10px] font-semibold ${g.ok ? 'text-emerald-200' : 'text-zinc-400'}`}>
                      {g.ok ? '✓' : '—'} {g.k}
                    </span>
                    <span className="min-w-0 truncate font-mono text-[9px] text-zinc-500" title={g.v}>
                      {g.v}
                    </span>
                  </div>
                ))}
              </div>
              {primaryCall.enterWhen ? (
                <p className="mt-2 border-t border-zinc-800/60 pt-2 text-[10px] leading-snug text-amber-100/90">{primaryCall.enterWhen}</p>
              ) : null}
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => applySpotSignalToTradePanel(primaryCall.lane ?? mode)}
              className={`rounded-lg border px-3 py-1.5 text-[11px] font-semibold ${
                (primaryCall.lane ?? mode) === 'up'
                  ? 'border-emerald-800/50 bg-emerald-950/30 text-emerald-100 hover:bg-emerald-950/45'
                  : 'border-rose-800/50 bg-rose-950/30 text-rose-100 hover:bg-rose-950/45'
              }`}
              title="Set the trade panel to this chart's primary side."
            >
              Use recommended side → {(primaryCall.lane ?? mode) === 'up' ? upLabel : downLabel}
            </button>
            <button
              type="button"
              onClick={() => applySpotSignalToTradePanel((primaryCall.lane ?? mode) === 'up' ? 'down' : 'up')}
              className="rounded-lg border border-zinc-700/60 bg-zinc-950/30 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900/40"
              title="Set the trade panel to the opposite lane."
            >
              Alternate side → {(primaryCall.lane ?? mode) === 'up' ? downLabel : upLabel}
            </button>
          </div>
        </DeskClosePanel>
        <details className="mt-2 rounded-lg border border-zinc-800/70 bg-black/25 px-3 py-2 text-[10px] leading-relaxed text-zinc-500 open:bg-black/35">
          <summary className="cursor-pointer select-none font-semibold text-zinc-400 marker:text-zinc-600">
            Chart read — axis, tints, time window, momentum (tap)
          </summary>
          <ul className="mt-2 list-disc space-y-1.5 pl-4 text-zinc-500">
            <li>
              <span className="text-zinc-400">USD axis is not inverted:</span> higher underlying = toward the{' '}
              <strong className="text-zinc-300">top</strong> of the chart; PTB is the yellow line.
            </li>
            <li>
              <span className="text-zinc-400">Green / red wash:</span> area <strong className="text-zinc-300">above</strong> PTB = spot
              <strong className="text-zinc-300"> above</strong> the level; <strong className="text-zinc-300">below</strong> PTB = spot{' '}
              <strong className="text-zinc-300">below</strong> — not “price good/bad”, only side of the line.
            </li>
            <li>
              <span className="text-zinc-400">Time scope:</span> only the last <strong className="text-zinc-300">{zoomWindow}s</strong> of ticks are
              plotted; wider swings happened earlier are off-screen.
            </li>
            <li>
              <span className="text-zinc-400">↑ MOM / ↓ MOM badge:</span> recent <strong className="text-zinc-300">bucket candle direction</strong>{' '}
              (plus slope) — a <strong className="text-zinc-300">↓</strong> pullback can print while spot is still above PTB.
            </li>
            <li>
              <span className="text-zinc-400">{meta.label}:</span> tints the <strong className="text-zinc-300">hint card</strong> for your
              selected outcome; it does <strong className="text-zinc-300">not</strong> flip the price scale.
            </li>
          </ul>
        </details>
          </>
        ) : (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span
              className={`rounded-md border px-2 py-0.5 text-[9px] font-extrabold tracking-wide ${
                primaryCall.status === 'ENTER'
                  ? primaryCall.lane === 'up'
                    ? 'border-emerald-500/45 bg-emerald-950/30 text-emerald-100'
                    : 'border-rose-500/45 bg-rose-950/25 text-rose-100'
                  : primaryCall.status === 'PREP'
                    ? 'border-amber-500/35 bg-amber-950/20 text-amber-100'
                    : 'border-zinc-700/70 bg-zinc-900/30 text-zinc-200'
              }`}
            >
              {primaryCall.status}
              {primaryCall.lane ? ` · ${primaryCall.lane === 'up' ? upLabel : downLabel}` : ''}
            </span>
            <span className="text-[9px] leading-snug text-zinc-500">{positionVsPtbLabel.title}</span>
          </div>
        )}
      </header>

      {switchForecast && !signalsCombinedColumn ? (
        <div className="mx-3 mt-2 space-y-2 sm:mx-4">
          {featureFlags.pinnedNote ? (
            <DeskClosePanel id="round-note" title="Note" summary="Round journal" defaultOpen={false}>
              <RoundNote slug={slug} visible={pinnedNoteVisible} />
            </DeskClosePanel>
          ) : null}
          <DeskClosePanel
            id="signal-stack"
            title="Signal stack"
            summary={operatorVerdict.bigVerb}
            badge={
              executionClash ? (
                <span className="rounded border border-rose-500/35 bg-rose-950/40 px-1 py-px text-[8px] font-bold uppercase text-rose-200">
                  Card wins
                </span>
              ) : null
            }
            defaultOpen={false}
            bodyClassName="p-1.5"
          >
            <SignalTruthStrip
              tradeDirective={tradeDirective}
              operatorVerdict={operatorVerdict}
              switchForecast={switchForecast}
              boomActive={boom != null}
              boomKind={boom?.kind ?? null}
              boomLane={boom?.lane ?? null}
              upLabel={upLabel}
              downLabel={downLabel}
              executionClash={executionClash}
              tapeWaitCardGo={tapeWaitCardGo}
              machineFocusLane={machineReadout?.focusLane ?? null}
              machineAgreementPct={machineReadout?.agreementScore ?? null}
              inSettlement={machineReadout?.urgency === 'settlement'}
            />
          </DeskClosePanel>
          {featureFlags.tapeVelocity && tapeVelocity ? (
            <DeskClosePanel
              id="tape-velocity"
              title="Tape"
              summary={`${tapeVelocity.dominance} · ${tapeVelocity.burst}`}
              defaultOpen={false}
              bodyClassName="p-1.5"
            >
              <TapeVelocityStrip
                tape={tapeVelocity}
                lane={tradeDirective?.lane ?? null}
                upLabel={upLabel}
                downLabel={downLabel}
                reduceMotion={reduceMotion}
              />
            </DeskClosePanel>
          ) : null}
          {boom ? (
            <BoomOverlay
              kind={boom.kind}
              lane={boom.lane}
              laneLabel={boom.lane === 'up' ? upLabel : downLabel}
              oppositeLabel={boom.lane === 'up' ? downLabel : upLabel}
              headline={boom.headline}
              reason={boom.reason}
              etaSec={boom.etaSec}
              levels={boomLevels}
              agreementScore={machineReadout?.agreementScore ?? null}
              crossProb={machineReadout?.crossProb ?? crossEstimate?.prob ?? null}
              incomingEdge={boomIncomingEdge}
              oppositeMid={boomOppositeMid}
              warmupNotice={tradeDirective == null && boom.kind !== 'EXIT_NOW'}
              structuralVsCardClash={executionClash}
              onDismiss={() => setBoom(null)}
            />
          ) : null}
          {tradeDirective && !signalsEmbed ? (
            <DeskClosePanel
              id="answer-card"
              title="Answer"
              summary={operatorVerdict.bigVerb}
              defaultOpen
              bodyClassName="p-2"
            >
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="rounded-md border border-emerald-500/50 bg-emerald-950/35 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.2em] text-emerald-100">
                  Answer
                </span>
                <span className="text-[10px] text-zinc-500">Size · TP/SL · guards</span>
              </div>
              <TradeDirectiveCard
                directive={tradeDirective}
                levels={tradeLevels}
                laneEdges={laneEdges}
                tpSlHorizon={{
                  crossProb: machineReadout?.crossProb ?? null,
                  endsInMs,
                }}
                upOutcomeLabel={upLabel}
                downOutcomeLabel={downLabel}
                stability={directiveStability}
                discrepancy={directiveDiscrepancy}
                reEntry={reEntryCheck}
                sizingMultiplier={sizingMultiplier}
                journal={directiveJournal}
                onExportJournal={featureFlags.journalExport ? onExportJournal : null}
                noTradeScore={noTradeScore}
                compact
                executionSnapshot={{
                  endsInMs,
                  switchForecast,
                  crossProb01: machineReadout?.crossProb ?? crossEstimate?.prob ?? null,
                  upLabel,
                  downLabel,
                  currentPositionLane,
                  incomingSwitchLevels,
                }}
              />
            </DeskClosePanel>
          ) : !signalsEmbed && !tradeDirective ? (
            <div className="mb-2 rounded-xl border border-dashed border-zinc-800/70 bg-zinc-950/25 px-3 py-2.5 text-center">
              <span className="text-[9px] font-black uppercase tracking-[0.2em] text-zinc-500">Answer</span>
              <p className="mt-0.5 text-[11px] font-medium leading-snug text-zinc-400">
                No trade card yet — below is <span className="text-zinc-300">context only</span>.
              </p>
            </div>
          ) : null}
          {!signalsEmbed && featureFlags.noTradeBanner && noTradeScore && noTradeScore.tier !== 'GREEN' ? (
            <DeskClosePanel
              id="no-trade-banner"
              title="No-trade"
              summary={`${noTradeScore.tier} · ${noTradeScore.score}/100`}
              defaultOpen={false}
              bodyClassName="p-1.5"
            >
              <NoTradeBanner score={noTradeScore} reduceMotion={reduceMotion} compact={executionClash} />
            </DeskClosePanel>
          ) : null}
          {shortcutHelpOpen ? (
            <ShortcutHelp onClose={() => setShortcutHelpOpen(false)} />
          ) : null}
          {crossImminentBanner ? (
            <div
              className={`mb-2 flex flex-wrap items-center gap-2 rounded-2xl border-2 px-3 py-2 text-fuchsia-50 shadow-lg shadow-black/40 ${
                executionClash
                  ? 'border-fuchsia-500/35 bg-gradient-to-r from-fuchsia-900/40 to-indigo-950/50'
                  : 'border-fuchsia-400/65 animate-pulse bg-gradient-to-r from-fuchsia-700/55 to-indigo-900/45'
              }`}
            >
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-fuchsia-300 text-base font-black text-zinc-950 shadow shadow-black/40">
                ⟂
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-black uppercase tracking-tight">
                  PTB cross risk · {Math.round(crossImminentBanner.prob * 100)}%
                </span>
                <span className="text-[11px] leading-snug text-fuchsia-100/85">
                  {crossImminentBanner.currentSide === 'above'
                    ? `Model: likely flips toward ${downLabel} before bell.`
                    : crossImminentBanner.currentSide === 'below'
                      ? `Model: likely flips toward ${upLabel} before bell.`
                      : 'Spot on PTB — line can resolve either way.'}
                </span>
                {executionClash ? (
                  <span className="mt-1 text-[10px] leading-snug text-zinc-400">
                    Trade card says wait — <span className="font-semibold text-zinc-300">chart is context only</span>.
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setCrossImminentBanner(null)}
                className="rounded-md border border-fuchsia-300/50 bg-fuchsia-300/15 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-fuchsia-50 hover:bg-fuchsia-300/25"
              >
                Dismiss
              </button>
            </div>
          ) : null}
          <DeskClosePanel
            id="chart-tape-context"
            title="Chart / tape"
            summary={
              machineReadout
                ? `Sensors ${Math.round(machineReadout.agreementScore)}% · ${switchForecast.status}`
                : switchForecast.status
            }
            badge={
              <span className="rounded border border-zinc-700/60 bg-zinc-900/50 px-1 py-px text-[8px] font-semibold uppercase text-zinc-400">
                {executionClash ? 'Answer block is law' : tapeWaitCardGo ? 'Tape WAIT · card GO' : 'context'}
              </span>
            }
            defaultOpen={false}
            bodyClassName="space-y-2 p-2"
          >
            <DecisionBanner
              forecast={switchForecast}
              upLabel={upLabel}
              downLabel={downLabel}
              dwellInfo={dwellInfo}
              onTestBoom={fireTestBoom}
              machine={machineReadout}
              operatorVerdict={operatorVerdict}
              hasDirective={tradeDirective != null}
              tapeWaitCardGo={tapeWaitCardGo}
            />
            {sections.length > 0 && sectionalPlan != null ? (
              <SectionalStrip
                sections={sections}
                sectionMs={sectionalPlan.sectionMs}
                upLabel={upLabel}
                downLabel={downLabel}
                forecast={switchForecast}
                executionClash={executionClash}
              />
            ) : (
              <div className="rounded-xl border border-dashed border-zinc-800/80 bg-zinc-950/20 px-3 py-2.5 text-center text-[10px] leading-relaxed text-zinc-500">
                {sectionalPlan ? (
                  <>
                    <span className="font-semibold text-zinc-400">Round breakdown</span> — waiting for enough spot ticks to paint{' '}
                    {sectionalPlan.count} slice{sectionalPlan.count === 1 ? '' : 's'} (
                    {sectionalPlan.sectionMs >= 60_000
                      ? `${Math.round(sectionalPlan.sectionMs / 60_000)}m`
                      : `${Math.round(sectionalPlan.sectionMs / 1000)}s`}{' '}
                    each). The strip reappears as data fills; try a wider zoom if this stays empty.
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-zinc-400">Round breakdown</span> — set chart zoom to{' '}
                    <strong className="text-zinc-300">≥ 1 minute</strong> for sectional slices. The Answer card, TP/SL, and
                    boom above still use spot, book, and PTB sensors at any zoom.
                  </>
                )}
              </div>
            )}
          </DeskClosePanel>
        </div>
      ) : null}

      <div className={chartPanelWrapMain}>
        <svg
          ref={spotSvgRef}
          viewBox={`0 0 ${width} ${svgHeight}`}
          className={chartSvgMain}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Spot price versus PTB"
        >
          <defs>
            <linearGradient id={`ptbFocusBand-${gradId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(161, 161, 170, 0.18)" />
              <stop offset="100%" stopColor="rgba(161, 161, 170, 0.06)" />
            </linearGradient>
            <linearGradient id={`heatAbove-${gradId}`} gradientUnits="userSpaceOnUse" x1={0} y1={yBeat} x2={0} y2={padY}>
              <stop offset="0%" stopColor="rgb(34 197 94)" stopOpacity={0} />
              <stop offset="100%" stopColor="rgb(21 128 61)" stopOpacity={0.06 + 0.22 * heatIntensity} />
            </linearGradient>
            <linearGradient id={`heatBelow-${gradId}`} gradientUnits="userSpaceOnUse" x1={0} y1={yBeat} x2={0} y2={padY + innerH}>
              <stop offset="0%" stopColor="rgb(248 113 113)" stopOpacity={0} />
              <stop offset="100%" stopColor="rgb(185 28 28)" stopOpacity={0.06 + 0.22 * heatIntensity} />
            </linearGradient>
            <marker id={`trailArr-${gradId}`} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="strokeWidth">
              <polygon points="0 1, 10 5, 0 9" fill="rgb(226 232 240)" fillOpacity={0.85} />
            </marker>
          </defs>

          <rect x="0" y="0" width={width} height={svgHeight} fill="#0a0f16" />

          <rect x={padL} y={Math.min(yBandTop, yBandBottom)} width={innerW} height={Math.max(12, Math.abs(yBandBottom - yBandTop))} fill={`url(#ptbFocusBand-${gradId})`} />
          <g>
            <title>
              Narrow ±ε band around PTB (touch / chop). Wider separation from the line is outside this band — do not
              confuse band height with how far spot is from PTB in dollars; use the right-hand price labels.
            </title>
            <text
              x={padL + 8}
              y={Math.min(yBandTop, yBandBottom) - 6}
              fill="rgb(161 161 170)"
              fontSize="10"
              fontWeight="700"
            >
              [ NO EDGE ZONE ]
            </text>
          </g>

          <rect x={padL} y={padY} width={innerW} height={Math.max(0, yBeat - padY)} fill={`url(#heatAbove-${gradId})`} className="pointer-events-none">
            <title>{`USD above PTB (spot > ${fmtUsd(priceToBeat!)}) — green tint`}</title>
          </rect>
          <rect x={padL} y={yBeat} width={innerW} height={Math.max(0, padY + innerH - yBeat)} fill={`url(#heatBelow-${gradId})`} className="pointer-events-none">
            <title>{`USD below PTB (spot < ${fmtUsd(priceToBeat!)}) — red tint`}</title>
          </rect>

          {closeSeries.length >= 2 ? (
            <path
              d={`M ${closeSeries[0]!.x.toFixed(1)} ${yBeat.toFixed(1)} ${closeSeries.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')} L ${closeSeries[closeSeries.length - 1]!.x.toFixed(1)} ${yBeat.toFixed(1)} Z`}
              fill={meta.soft}
              className="pointer-events-none"
            />
          ) : null}

          {(() => {
            const tickFont = 12;
            const tickX = width - 4;
            return tickPrices.map((tp, i) => (
              <g key={`grid-${i}`}>
                <line x1={padL} x2={padL + innerW} y1={yPrice(tp)} y2={yPrice(tp)} stroke="rgba(39,39,42,0.8)" strokeWidth="1" />
                <text
                  x={tickX}
                  y={yPrice(tp) + 4}
                  fill="rgb(228 228 231)"
                  fontSize={tickFont}
                  fontFamily="ui-monospace, monospace"
                  fontWeight={600}
                  textAnchor="end"
                  stroke="rgb(10 15 22)"
                  strokeWidth={2.4}
                  paintOrder="stroke"
                >
                  {fmtAxisPrice(tp)}
                </text>
              </g>
            ));
          })()}
          <g>
            {/* HIGHER $ / LOWER $ legends sit just past the bias meter on the left
                (the meter bar+labels span padL+4..padL+90 at roughly padY+8..padY+8+bH). */}
            <text
              x={padL + 96}
              y={padY + 16}
              textAnchor="start"
              fontSize="12"
              fontWeight="800"
              fontFamily="ui-sans-serif, system-ui, sans-serif"
              fill="rgb(212 212 216)"
              stroke="rgb(10 15 22)"
              strokeWidth="2.2"
              strokeLinejoin="round"
              paintOrder="stroke fill"
            >
              HIGHER $
            </text>
            <text
              x={padL + 96}
              y={padY + innerH - 3}
              textAnchor="start"
              fontSize="12"
              fontWeight="800"
              fontFamily="ui-sans-serif, system-ui, sans-serif"
              fill="rgb(212 212 216)"
              stroke="rgb(10 15 22)"
              strokeWidth="2.2"
              strokeLinejoin="round"
              paintOrder="stroke fill"
            >
              LOWER $
            </text>
          </g>

          {/* Price levels (S/R) */}
          {priceLevels.map((lv, i) => {
            const y = yPrice(lv.price);
            const isHigh = lv.kind === 'high';
            const color = isHigh ? 'rgb(251 146 60)' : 'rgb(96 165 250)';
            return (
              <g key={`lvl-${i}`} className="pointer-events-none">
                <line x1={padL} x2={padL + innerW} y1={y} y2={y} stroke={color} strokeWidth="1.2" strokeDasharray="6 3" opacity={0.6} />
                <rect x={padL + 2} y={y - 8} width={isHigh ? 12 : 10} height={14} rx="3" fill={color} fillOpacity={0.15} />
                <text x={padL + 5} y={y + 3} fill={color} fontSize="8" fontWeight="700" opacity={0.85}>
                  {isHigh ? 'R' : 'S'}
                </text>
                <text x={padL + 18} y={y - 2} fill={color} fontSize="9" fontFamily="ui-monospace, monospace" opacity={0.7}>
                  {fmtAxisPrice(lv.price)}
                </text>
              </g>
            );
          })}

          {displayMode === 'line' ? (() => {
              const fill_d = `M ${linePathSeries[0]!.x.toFixed(1)} ${(padY + innerH).toFixed(1)} ${linePathSeries.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')} L ${linePathSeries[linePathSeries.length - 1]!.x.toFixed(1)} ${(padY + innerH).toFixed(1)} Z`;
              let upD = '';
              let dnD = '';
              for (let i = 1; i < linePathSeries.length; i++) {
                const prev = linePathSeries[i - 1]!;
                const cur = linePathSeries[i]!;
                const seg = `M${prev.x.toFixed(1)} ${prev.y.toFixed(1)}L${cur.x.toFixed(1)} ${cur.y.toFixed(1)}`;
                if (cur.v >= prev.v) upD += seg; else dnD += seg;
              }
              return (
                <>
                  <path d={fill_d} fill={lineFill} className="pointer-events-none" />
                  {upD && <path d={upD} fill="none" stroke="rgb(74 222 128)" strokeWidth={3.35} strokeLinecap="round" />}
                  {dnD && <path d={dnD} fill="none" stroke="rgb(248 113 113)" strokeWidth={3.35} strokeLinecap="round" />}
                </>
              );
            })() : (
            model.candles.map((c, i) => {
              const x0 = xTime(c.t0);
              const x1 = xTime(c.t1);
              const xc = (x0 + x1) / 2;
              const slotW = x1 - x0;
              const bodyW = Math.max(24, Math.min(slotW * 0.86, innerW * 0.1));
              const yO = yPrice(c.o);
              const yC = yPrice(c.c);
              const yH = yPrice(c.h);
              const yL = yPrice(c.l);
              const bullish = c.c >= c.o;
              const bodyTop = Math.min(yO, yC);
              const bodyBot = Math.max(yO, yC);
              const rawBodyH = bodyBot - bodyTop;
              const bodyH = Math.max(6, rawBodyH);
              const bodyY = bodyTop - (bodyH - rawBodyH) / 2;
              const wickColor = bullish ? 'rgb(34 197 94)' : 'rgb(239 68 68)';
              const bodyFill = bullish ? 'rgb(22 163 74)' : 'rgb(220 38 38)';
              const bodyStroke = bullish ? 'rgb(74 222 128)' : 'rgb(248 113 113)';
              return (
                <g key={`candle-${i}`}>
                  <line x1={xc} x2={xc} y1={yH} y2={bodyY} stroke={wickColor} strokeWidth={2.1} />
                  <line x1={xc} x2={xc} y1={bodyY + bodyH} y2={yL} stroke={wickColor} strokeWidth={2.1} />
                  <rect
                    x={xc - bodyW / 2}
                    y={bodyY}
                    width={bodyW}
                    height={bodyH}
                    fill={bodyFill}
                    stroke={bodyStroke}
                    strokeWidth={1.55}
                  />
                </g>
              );
            })
          )}

          {trailPointsStr ? (
            <polyline
              points={trailPointsStr}
              fill="none"
              stroke="rgb(226 232 240)"
              strokeWidth="2.2"
              strokeOpacity={0.7}
              strokeLinecap="round"
              strokeLinejoin="round"
              markerEnd={`url(#trailArr-${gradId})`}
              className="pointer-events-none"
            />
          ) : null}

          <line x1={padL} x2={padL + innerW} y1={yBeat} y2={yBeat} stroke="rgb(253 224 71)" strokeWidth={9} strokeLinecap="round" opacity={0.18} />
          <line
            x1={padL}
            x2={padL + innerW}
            y1={yBeat}
            y2={yBeat}
            stroke="rgb(250 234 80)"
            strokeWidth={3}
            strokeLinecap="round"
            opacity={1}
          />
          <text x={padL + 8} y={yBeat - 10} fill="rgb(253 224 71)" fontSize="11" fontWeight="800">
            PTB
          </text>
          <rect x={width - padR - 136} y={Math.max(padY + 8, yBeat - 14)} width="128" height="24" rx="12" fill="rgb(250 234 80)" />
          <text x={width - padR - 72} y={Math.max(padY + 24, yBeat + 4)} textAnchor="middle" fill="#0a0a0a" fontSize="11" fontWeight="800">
            PTB {fmtUsd(priceToBeat)}
          </text>

          {ptbMarkers.breakBox ? (
            <rect
              x={ptbMarkers.breakBox.xc - ptbMarkers.breakBox.w / 2 - 3}
              y={ptbMarkers.breakBox.y - 3}
              width={ptbMarkers.breakBox.w + 6}
              height={ptbMarkers.breakBox.h + 6}
              rx="4"
              fill="none"
              stroke="rgb(250 234 80)"
              strokeWidth="2.2"
              opacity={0.95}
            />
          ) : null}
          {ptbMarkers.rejection ? (
            <g transform={`translate(${ptbMarkers.rejection.xc},${ptbMarkers.rejection.yc})`} opacity={0.92}>
              <line x1={-7} y1={-7} x2={7} y2={7} stroke="rgb(251 113 133)" strokeWidth="2.4" strokeLinecap="round" />
              <line x1={-7} y1={7} x2={7} y2={-7} stroke="rgb(251 113 133)" strokeWidth="2.4" strokeLinecap="round" />
            </g>
          ) : null}

          <circle cx={xTime(lastPt.t)} cy={yPrice(lastPt.v)} r={7} fill="white" stroke={lineStroke} strokeWidth={2.5} />

          {/* Momentum badge on chart */}
          {derivedStrip ? (() => {
            const momLabel = derivedStrip.momentum === 'UP' ? '↑ MOM' : derivedStrip.momentum === 'DOWN' ? '↓ MOM' : '→ FLAT';
            const momColor = derivedStrip.momentum === 'UP' ? 'rgb(52 211 153)' : derivedStrip.momentum === 'DOWN' ? 'rgb(251 113 133)' : 'rgb(161 161 170)';
            const momBg = derivedStrip.momentum === 'UP' ? 'rgba(16,185,129,0.2)' : derivedStrip.momentum === 'DOWN' ? 'rgba(248,113,113,0.2)' : 'rgba(113,113,122,0.15)';
            const badgeX = xTime(lastPt.t) + 14;
            const badgeY = yPrice(lastPt.v) - 16;
            const streak = derivedStrip.momentumStreak;
            return (
              <g className="pointer-events-none">
                <title>
                  Recent OHLC bucket direction (and streak). Not the same as “spot above PTB”: e.g. ↓ MOM can show
                  during a small pullback while spot is still above the yellow line.
                </title>
                <rect x={badgeX - 2} y={badgeY - 10} width={streak >= 2 ? 72 : 56} height={18} rx="9" fill={momBg} stroke={momColor} strokeWidth="1.2" strokeOpacity={0.7} />
                <text x={badgeX + 4} y={badgeY + 2} fill={momColor} fontSize="10" fontWeight="800" fontFamily="ui-monospace, monospace">
                  {momLabel}{streak >= 2 ? ` x${streak}` : ''}
                </text>
              </g>
            );
          })() : null}

          {/* Momentum buildup gauge — top-CENTER of chart so it never overlaps with the
              left-side bias meter or the right-side PTB price chip (which can sit anywhere
              along the y-axis based on yBeat). */}
          {buildup && buildup.tier !== 'NONE' ? (() => {
            const barW = 100;
            // Outer rect uses (barW + 68) wide; centre under the chart with a safe min margin
            // away from the bias meter on the left (~padL+90) and the PTB chip on the right.
            const totalW = barW + 68;
            const gx = padL + Math.max(110, Math.round((innerW - totalW) / 2));
            const gy = padY + 6;
            const barH = 8;
            const fill01 = buildup.score / 100;
            const tierColor = buildup.tier === 'FIRING' ? 'rgb(250 204 21)' :
              buildup.tier === 'READY' ? 'rgb(52 211 153)' :
              buildup.tier === 'BUILDING' ? 'rgb(96 165 250)' : 'rgb(161 161 170)';
            const tierBg = buildup.tier === 'FIRING' ? 'rgba(250,204,21,0.15)' :
              buildup.tier === 'READY' ? 'rgba(52,211,153,0.12)' :
              buildup.tier === 'BUILDING' ? 'rgba(96,165,250,0.1)' : 'rgba(161,161,170,0.08)';
            const arrow = buildup.direction === 'UP' ? '▲' : buildup.direction === 'DOWN' ? '▼' : '◆';
            return (
              <g className="pointer-events-none">
                <rect x={gx - 6} y={gy - 2} width={barW + 68} height={34} rx="8" fill={tierBg} stroke={tierColor} strokeWidth="0.8" strokeOpacity={0.5} />
                <text x={gx} y={gy + 10} fill={tierColor} fontSize="9" fontWeight="800" fontFamily="ui-monospace, monospace">
                  {arrow} {buildup.tier}
                </text>
                <rect x={gx} y={gy + 16} width={barW} height={barH} rx={barH / 2} fill="rgba(39,39,42,0.8)" />
                <rect x={gx} y={gy + 16} width={barW * fill01} height={barH} rx={barH / 2} fill={tierColor} />
                <text x={gx + barW + 6} y={gy + 24} fill={tierColor} fontSize="10" fontWeight="700" fontFamily="ui-monospace, monospace">
                  {buildup.score}
                </text>
              </g>
            );
          })() : null}

          {/* Bias meter — left side vertical bar */}
          {biasShift ? (() => {
            const bx = padL + 4;
            const by = padY + 8;
            const bH = Math.min(innerH - 20, 160);
            const mid = by + bH / 2;
            const fill01 = (biasShift.biasScore + 100) / 200;
            const needleY = by + bH * (1 - fill01);
            const biasColor = biasShift.biasScore >= 30 ? 'rgb(52 211 153)' : biasShift.biasScore <= -30 ? 'rgb(248 113 113)' : 'rgb(161 161 170)';
            return (
              <g className="pointer-events-none">
                <rect x={bx} y={by} width={6} height={bH} rx={3} fill="rgba(39,39,42,0.7)" />
                <rect x={bx} y={mid} width={6} height={1} fill="rgba(161,161,170,0.5)" />
                <rect x={bx - 1} y={Math.min(needleY, mid)} width={8} height={Math.max(2, Math.abs(needleY - mid))} rx={2}
                  fill={biasColor} opacity={0.85} />
                <circle cx={bx + 3} cy={needleY} r={5} fill={biasColor} stroke="#0a0f16" strokeWidth={2} />
                <text x={bx + 14} y={by + 3} fill="rgb(113 113 122)" fontSize="7" fontWeight="700">
                  {(upLabel ?? 'UP').slice(0, 6).toUpperCase()}
                </text>
                <text x={bx + 14} y={by + bH + 1} fill="rgb(113 113 122)" fontSize="7" fontWeight="700">
                  {(downLabel ?? 'DOWN').slice(0, 6).toUpperCase()}
                </text>
                <text x={bx + 14} y={needleY + 3} fill={biasColor} fontSize="9" fontWeight="800" fontFamily="ui-monospace, monospace">
                  {biasShift.bias}
                </text>
                {biasShift.shifting ? (
                  <g>
                    <rect x={bx + 14} y={needleY + 8} width={biasShift.shiftUrgency === 'IMMINENT' ? 80 : 66} height={16} rx={4}
                      fill={biasShift.shiftUrgency === 'IMMINENT' ? 'rgba(250,204,21,0.2)' : 'rgba(250,204,21,0.1)'}
                      stroke="rgb(250 204 21)" strokeWidth={biasShift.shiftUrgency === 'IMMINENT' ? 1.2 : 0.8} />
                    <text x={bx + 18} y={needleY + 20} fill="rgb(250 204 21)" fontSize="8" fontWeight="800" fontFamily="ui-monospace, monospace">
                      ⚡ {biasShift.shiftUrgency} {biasShift.shiftDir}
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })() : null}

          {crosshair ? (
            <g className="pointer-events-none">
              <line
                x1={crosshair.plotX}
                x2={crosshair.plotX}
                y1={padY}
                y2={padY + innerH}
                stroke="rgba(248,250,252,0.38)"
                strokeWidth="1"
                strokeDasharray="5 4"
              />
              <circle
                cx={crosshair.plotX}
                cy={crosshair.yOnPath}
                r={5.5}
                fill="rgb(250 250 250)"
                stroke="rgb(56 189 248)"
                strokeWidth="2"
              />
              {(() => {
                const tw = 210;
                const tx = Math.min(Math.max(padL + 6, crosshair.plotX + 10), padL + innerW - tw - 6);
                const ty = padY + 8;
                const tStr = new Date(crosshair.t).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                });
                const vStr = `${fmtUsd(crosshair.v)} · ${fmtPctSigned(crosshair.distPct)} vs PTB`;
                return (
                  <g>
                    <rect
                      x={tx - 5}
                      y={ty - 3}
                      width={tw}
                      height={38}
                      rx="7"
                      fill="rgba(15,23,42,0.94)"
                      stroke="rgba(148,163,184,0.4)"
                      strokeWidth="1"
                    />
                    <text x={tx} y={ty + 11} fill="rgb(226 232 240)" fontSize="10" fontWeight="800" fontFamily="ui-monospace, monospace">
                      {tStr}
                    </text>
                    <text x={tx} y={ty + 27} fill="rgb(148 163 184)" fontSize="9" fontFamily="ui-monospace, monospace">
                      {vStr}
                    </text>
                  </g>
                );
              })()}
            </g>
          ) : null}

          {dualProbOverlay
            ? (() => {
                const stripY0 = padY + innerH + DUAL_PROB_STRIP_GAP;
                const gridY0 = stripY0 + 30;
                const gridBottom = stripY0 + DUAL_PROB_STRIP_H - 8;
                const gridH = Math.max(8, gridBottom - gridY0);
                const probSpan = Math.max(1e-9, dualProbOverlay.scale.max - dualProbOverlay.scale.min);
                const yProb = (p: number) => gridY0 + (1 - (clamp01(p) - dualProbOverlay.scale.min) / probSpan) * gridH;
                const y50 = yProb(0.5);
                const ptsU = downsampleLinePoints(dualProbOverlay.seriesUp, 480);
                const ptsD = downsampleLinePoints(dualProbOverlay.seriesDown, 480);
                const fmtCents = (p: number) => `${(clamp01(p) * 100).toFixed(1)}¢`;
                const renderLane = (lane: 'up' | 'down', pts: typeof ptsU) =>
                  pts.slice(1).map((b, i) => {
                    const a = pts[i]!;
                    const vPrev = i > 0 ? pts[i - 1]!.v : null;
                    const st = segmentDualLaneStyle(lane, vPrev, a.v, b.v, a.t, b.t, 0.5);
                    return (
                      <line
                        key={`dual-${lane}-${b.t}-${i}`}
                        x1={xTime(a.t)}
                        y1={yProb(a.v)}
                        x2={xTime(b.t)}
                        y2={yProb(b.v)}
                        stroke={st.stroke}
                        strokeWidth={st.strokeWidth}
                        strokeLinecap="round"
                        className="pointer-events-none"
                      />
                    );
                  });
                const centTicks = [0, 0.25, 0.5, 0.75, 1].filter(
                  (tp) => tp >= dualProbOverlay.scale.min - 1e-9 && tp <= dualProbOverlay.scale.max + 1e-9,
                );
                return (
                  <g aria-label="Dual PTB implied mid strip">
                    <rect
                      x={padL}
                      y={stripY0}
                      width={innerW}
                      height={DUAL_PROB_STRIP_H}
                      rx={12}
                      fill="rgba(9,10,12,0.96)"
                      stroke="rgba(63,63,70,0.88)"
                      strokeWidth={1}
                    />
                    <text x={padL + 8} y={stripY0 + 14} fill="rgb(251,191,36)" fontSize="9" fontWeight="800">
                      DUAL PTB · book-implied mids vs 50¢
                    </text>
                    <text x={padL + 8} y={stripY0 + 24} fill="rgb(113,113,122)" fontSize="8" fontWeight="600">
                      <tspan fill="rgb(167,243,208)">{upLabel}</tspan> {fmtCents(dualProbOverlay.lastU)}
                      {' · '}
                      <tspan fill="rgb(254,202,202)">{downLabel}</tspan> {fmtCents(dualProbOverlay.lastD)}
                    </text>
                    {centTicks.map((tp) => (
                      <line
                        key={`dpg-${tp}`}
                        x1={padL}
                        x2={padL + innerW}
                        y1={yProb(tp)}
                        y2={yProb(tp)}
                        stroke={Math.abs(tp - 0.5) < 1e-6 ? 'rgba(250,204,21,0.22)' : 'rgba(255,255,255,0.05)'}
                        strokeWidth={1}
                        className="pointer-events-none"
                      />
                    ))}
                    <line
                      x1={padL}
                      x2={padL + innerW}
                      y1={y50}
                      y2={y50}
                      stroke="rgb(250 204 21)"
                      strokeWidth={2}
                      strokeDasharray="5 4"
                      className="pointer-events-none"
                    />
                    {renderLane('down', ptsD)}
                    {renderLane('up', ptsU)}
                    <circle
                      cx={xTime(ptsU[ptsU.length - 1]!.t)}
                      cy={yProb(dualProbOverlay.lastU)}
                      r={4.5}
                      fill="white"
                      stroke="rgb(52 211 153)"
                      strokeWidth={2}
                      className="pointer-events-none"
                    />
                    <circle
                      cx={xTime(ptsD[ptsD.length - 1]!.t)}
                      cy={yProb(dualProbOverlay.lastD)}
                      r={4.5}
                      fill="white"
                      stroke="rgb(251 113 133)"
                      strokeWidth={2}
                      className="pointer-events-none"
                    />
                    <text
                      x={padL + innerW - 6}
                      y={stripY0 + 14}
                      textAnchor="end"
                      fill="rgb(113,113,122)"
                      fontSize="8"
                      fontWeight="600"
                    >
                      {upLabel} / {downLabel}
                    </text>
                  </g>
                );
              })()
            : null}

          {overlayAppliesSpot && bracketOverlay ? (() => {
            const stripY0 =
              padY +
              innerH +
              (dualProbOverlay ? DUAL_PROB_STRIP_GAP + DUAL_PROB_STRIP_H + PROB_STRIP_GAP : PROB_STRIP_GAP);
            const bo = bracketOverlay;
            const bsl = parseTradeBracketCents01(bo.slStopCents);
            const btp = parseTradeBracketCents01(bo.tpTakeCents);
            const brf = parseTradeBracketCents01(bo.refCents);
            const slMu = !bo.stopLossEnabled;
            const tpMu = !bo.takeProfitEnabled;
            const laneP = bo.tradeLane;
            const ap = laneP === 'up' ? lastProbUp : lastProbDown;
            const xL = ap != null && Number.isFinite(ap) ? padL + clamp01(ap) * innerW : null;
            const xSl = bsl != null ? padL + clamp01(bsl) * innerW : null;
            const xTp = btp != null ? padL + clamp01(btp) * innerW : null;
            const xRf = brf != null ? padL + clamp01(brf) * innerW : null;
            const avgE =
              bo.avgEntry01 != null && Number.isFinite(bo.avgEntry01) && bo.avgEntry01 > 0 && bo.avgEntry01 < 1
                ? bo.avgEntry01
                : null;
            const xAvg = avgE != null ? padL + clamp01(avgE) * innerW : null;
            const pnlBits: string[] = [];
            if (avgE != null) {
              pnlBits.push(`My entry ${(avgE * 100).toFixed(1)}¢`);
              if (btp != null) {
                const s = fmtProbPnlVsEntry(btp, avgE);
                if (s) pnlBits.push(`TP ${s}`);
              }
              if (bsl != null) {
                const s = fmtProbPnlVsEntry(bsl, avgE);
                if (s) pnlBits.push(`SL ${s}`);
              }
              if (brf != null) {
                const s = fmtProbPnlVsEntry(brf, avgE);
                if (s) pnlBits.push(`REF ${s}`);
              }
            }
            const pnlSummary = pnlBits.length > 1 ? pnlBits.join(' · ') : null;
            const stripGridY0 = stripY0 + 28;
            return (
              <g aria-label="Trade bracket cents strip">
                <rect
                  x={padL}
                  y={stripY0}
                  width={innerW}
                  height={PROB_STRIP_H}
                  rx={10}
                  fill="rgba(15,23,42,0.92)"
                  stroke="rgba(63,63,70,0.9)"
                  strokeWidth={1}
                />
                <text
                  x={padL + 6}
                  y={stripY0 + 12}
                  fill="rgb(161,161,170)"
                  fontSize="9"
                  fontWeight="800"
                  className="pointer-events-none"
                >
                  TRADE ¢ · {laneP === 'up' ? upLabel : downLabel} (live mid + drag SL / TP / REF)
                </text>
                {pnlSummary ? (
                  <text
                    x={padL + 6}
                    y={stripY0 + 23}
                    fill="rgb(203,213,225)"
                    fontSize="8"
                    fontWeight="800"
                    fontFamily="ui-monospace, monospace"
                    className="pointer-events-none"
                  >
                    {pnlSummary.length > 118 ? `${pnlSummary.slice(0, 115)}…` : pnlSummary}
                  </text>
                ) : null}
                {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                  <line
                    key={`psg-${f}`}
                    x1={padL + f * innerW}
                    x2={padL + f * innerW}
                    y1={stripGridY0}
                    y2={stripY0 + PROB_STRIP_H - 4}
                    stroke="rgba(255,255,255,0.06)"
                    strokeWidth={1}
                    className="pointer-events-none"
                  />
                ))}
                {[0, 50, 100].map((c) => (
                  <text
                    key={`psl-${c}`}
                    x={padL + (c / 100) * innerW}
                    y={stripY0 + PROB_STRIP_H - 2}
                    textAnchor="middle"
                    fill="rgb(113,113,122)"
                    fontSize="8"
                    fontFamily="ui-monospace, monospace"
                    className="pointer-events-none"
                  >
                    {c}¢
                  </text>
                ))}
                {xL != null ? (
                  <g className="pointer-events-none">
                    <line
                      x1={xL}
                      x2={xL}
                      y1={stripGridY0}
                      y2={stripY0 + PROB_STRIP_H - 6}
                      stroke="rgb(250,250,250)"
                      strokeWidth={2}
                      strokeLinecap="round"
                    />
                    <polygon
                      points={`${xL},${stripGridY0 + 6} ${xL - 5},${stripGridY0 - 2} ${xL + 5},${stripGridY0 - 2}`}
                      fill="rgb(250,250,250)"
                    />
                  </g>
                ) : null}
                {xAvg != null ? (
                  <g className="pointer-events-none" opacity={0.95}>
                    <line
                      x1={xAvg}
                      x2={xAvg}
                      y1={stripGridY0}
                      y2={stripY0 + PROB_STRIP_H - 6}
                      stroke="rgba(167,139,250,0.85)"
                      strokeWidth={2}
                      strokeDasharray="3 4"
                      strokeLinecap="round"
                    />
                    <rect
                      x={xAvg - 3}
                      y={stripGridY0 - 4}
                      width={6}
                      height={6}
                      rx={1}
                      fill="rgb(167,139,250)"
                      stroke="rgba(0,0,0,0.45)"
                      strokeWidth={0.5}
                    />
                  </g>
                ) : null}
                {xSl != null ? (
                  <g opacity={slMu ? 0.48 : 1}>
                    <line
                      x1={xSl}
                      x2={xSl}
                      y1={stripGridY0}
                      y2={stripY0 + PROB_STRIP_H - 4}
                      stroke="rgba(251,113,133,0.45)"
                      strokeWidth={18}
                      strokeLinecap="round"
                      pointerEvents="stroke"
                      className="cursor-ew-resize touch-none"
                      onPointerDown={(e) => onStripPointerDown('sl', e)}
                      onPointerMove={onStripPointerMove}
                      onPointerUp={onStripPointerUp}
                      onPointerCancel={onStripPointerUp}
                    />
                    <line
                      x1={xSl}
                      x2={xSl}
                      y1={stripGridY0}
                      y2={stripY0 + PROB_STRIP_H - 4}
                      stroke="rgb(251,113,133)"
                      strokeWidth={2}
                      strokeLinecap="round"
                      className="pointer-events-none"
                    />
                  </g>
                ) : null}
                {xTp != null ? (
                  <g opacity={tpMu ? 0.48 : 1}>
                    <line
                      x1={xTp}
                      x2={xTp}
                      y1={stripGridY0}
                      y2={stripY0 + PROB_STRIP_H - 4}
                      stroke="rgba(52,211,153,0.4)"
                      strokeWidth={18}
                      strokeLinecap="round"
                      pointerEvents="stroke"
                      className="cursor-ew-resize touch-none"
                      onPointerDown={(e) => onStripPointerDown('tp', e)}
                      onPointerMove={onStripPointerMove}
                      onPointerUp={onStripPointerUp}
                      onPointerCancel={onStripPointerUp}
                    />
                    <line
                      x1={xTp}
                      x2={xTp}
                      y1={stripGridY0}
                      y2={stripY0 + PROB_STRIP_H - 4}
                      stroke="rgb(52,211,153)"
                      strokeWidth={2}
                      strokeLinecap="round"
                      className="pointer-events-none"
                    />
                  </g>
                ) : null}
                {xRf != null ? (
                  <g opacity={0.92}>
                    <line
                      x1={xRf}
                      x2={xRf}
                      y1={stripGridY0}
                      y2={stripY0 + PROB_STRIP_H - 4}
                      stroke="rgba(251,191,36,0.45)"
                      strokeWidth={18}
                      strokeLinecap="round"
                      pointerEvents="stroke"
                      className="cursor-ew-resize touch-none"
                      onPointerDown={(e) => onStripPointerDown('ref', e)}
                      onPointerMove={onStripPointerMove}
                      onPointerUp={onStripPointerUp}
                      onPointerCancel={onStripPointerUp}
                    />
                    <line
                      x1={xRf}
                      x2={xRf}
                      y1={stripGridY0}
                      y2={stripY0 + PROB_STRIP_H - 4}
                      stroke="rgb(251,191,36)"
                      strokeWidth={2}
                      strokeDasharray="4 5"
                      strokeLinecap="round"
                      className="pointer-events-none"
                    />
                  </g>
                ) : null}
              </g>
            );
          })() : null}

          {xTickTs.map((ts, i) => (
            <text
              key={`xt-${i}`}
              x={xTime(ts)}
              y={svgHeight - 4}
              textAnchor="middle"
              fill="rgb(113 113 122)"
              fontSize="9"
              fontFamily="ui-monospace, monospace"
            >
              {new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </text>
          ))}

          <rect
            x={padL}
            y={padY}
            width={innerW}
            height={innerH}
            fill="transparent"
            className="cursor-crosshair"
            onMouseMove={(e) => {
              const svg = e.currentTarget.ownerSVGElement;
              const ptb = priceToBeat;
              if (!svg || ptb == null || !Number.isFinite(ptb)) return;
              const loc = svgClientToLocal(svg, e.clientX, e.clientY);
              if (!loc) return;
              const { x, y } = loc;
              if (x < padL || x > padL + innerW || y < padY || y > padY + innerH) {
                setCrosshair(null);
                return;
              }
              const tHover = model.tMin + ((x - padL) / innerW) * tSpan;
              const iv = interpolateSpotAtTime(pts, tHover);
              if (!iv) return;
              const plotX = padL + ((iv.t - model.tMin) / tSpan) * innerW;
              const yOnPath = yPrice(iv.v);
              const distPct = ptb > 0 ? ((iv.v - ptb) / ptb) * 100 : 0;
              setCrosshair({ plotX, yOnPath, t: iv.t, v: iv.v, distPct });
            }}
            onMouseLeave={() => setCrosshair(null)}
          />
        </svg>
      </div>
      </div>

      {!signalsEmbed ? (
      <section
        className={`shrink-0 border-t-2 bg-zinc-950/85 px-4 py-4 text-zinc-100 sm:px-5 ${statusBarBorder}`}
        title={derivedStrip?.controlBlurb ?? undefined}
      >
        <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Status</div>
        <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-2xl font-black uppercase leading-none tracking-tight sm:text-3xl">
              {controlSig ? controlSig.replaceAll('_', ' ') : '…'}
            </div>
            {statusLine2 ? <div className="mt-1.5 text-sm font-medium text-zinc-500">({statusLine2})</div> : null}
            <p className="mt-2 max-w-prose text-[11px] leading-snug text-zinc-600">{model.hint}</p>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Distance</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-zinc-100">{fmtPctSigned(model.distancePct)}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Time below</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-zinc-100">
                {derivedStrip ? pctOfTotal(derivedStrip.dwellBelowMs, dwellTotal) : '—'}
              </div>
            </div>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Time above</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-zinc-100">
                {derivedStrip ? pctOfTotal(derivedStrip.dwellAboveMs, dwellTotal) : '—'}
              </div>
            </div>
            <div title="Share of visible-window time inside the ±ε PTB touch band (chop / no edge).">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Time at band</div>
              <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-zinc-100">
                {derivedStrip ? pctOfTotal(derivedStrip.dwellAtMs, dwellTotal) : '—'}
              </div>
            </div>
            <div className="col-span-2 sm:col-span-3 lg:col-span-1" title="Bucket candle direction + slope over the visible window — can disagree with spot still above/below PTB on a pullback.">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Candle momentum</div>
              <div className="mt-0.5 font-mono text-lg font-bold text-zinc-100">
                {momArrow}{' '}
                <span className="text-sm font-semibold text-zinc-400">
                  {derivedStrip?.momentum ?? '—'}
                  {derivedStrip && derivedStrip.momentumStreak >= 2 ? ` ×${derivedStrip.momentumStreak}` : ''}
                </span>
              </div>
              <div className="mt-0.5 text-[9px] leading-snug text-zinc-600">Short-horizon OHLC trend, not “vs PTB” by itself</div>
            </div>
          </div>
        </div>
        {showLegacyRulePanels ? (
          <>
            <div className="mt-3 grid gap-2 lg:grid-cols-2">
              <div className={`rounded-xl border px-3 py-2 ${playbook.entryTone}`} title="Entry trigger is framed as: outside band + hold; not a prediction.">
                <div className="text-[9px] font-extrabold uppercase tracking-[0.18em] text-inherit/90">Entry</div>
                <div className="mt-1 text-[11px] leading-snug text-inherit/95">{playbook.entry}</div>
                <div className="mt-1 text-[10px] font-semibold text-inherit/80">{playbook.stop}</div>
              </div>
              <div className={`rounded-xl border px-3 py-2 ${playbook.exitTone}`} title="Exit/invalidation is framed as: back into band or rotation; keep it mechanical.">
                <div className="text-[9px] font-extrabold uppercase tracking-[0.18em] text-inherit/90">Exit</div>
                <div className="mt-1 text-[11px] leading-snug text-inherit/95">{playbook.exit}</div>
                <div className="mt-1 text-[10px] font-semibold text-inherit/85">{playbook.tp}</div>
              </div>
            </div>

            {settlementCross ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <div
                  className="rounded-xl border border-violet-600/40 bg-violet-950/25 px-3 py-2"
                  title={
                    `${settlementCross.blurb}\n` +
                    `50% band ${fmtUsd(settlementCross.band50Low)} – ${fmtUsd(settlementCross.band50High)} · ` +
                    `80% ${fmtUsd(settlementCross.band80Low)} – ${fmtUsd(settlementCross.band80High)}`
                  }
                >
                  <div className="text-[9px] font-extrabold uppercase tracking-[0.18em] text-violet-200/85">Settlement (vs PTB @ end)</div>
                  <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-violet-100">
                    Above {Math.round(settlementCross.pAboveAtEnd * 100)}% · Below {Math.round(settlementCross.pBelowAtEnd * 100)}%
                  </div>
                  <div className="mt-0.5 text-[10px] text-violet-200/70">
                    Confidence:{' '}
                    <span className="font-bold uppercase text-violet-100">{settlementCross.confidence}</span>
                    {' · '}
                    E[close] {fmtUsd(settlementCross.expectedEndPrice)}
                  </div>
                </div>
                <div
                  className="rounded-xl border border-cyan-600/40 bg-cyan-950/20 px-3 py-2"
                  title={
                    `P(cross PTB within window): 30s ${Math.round(settlementCross.pCrossIn30s * 100)}%, ` +
                    `60s ${Math.round(settlementCross.pCrossIn60s * 100)}%, 120s ${Math.round(settlementCross.pCrossIn120s * 100)}%. ` +
                    (settlementCross.tCrossMedianSec != null
                      ? `Rough median time to line (drift toward line): ${settlementCross.tCrossMedianSec < 60 ? `${settlementCross.tCrossMedianSec.toFixed(0)}s` : `${(settlementCross.tCrossMedianSec / 60).toFixed(1)}m`}.`
                      : 'Median time to line: n/a (drift not toward PTB).') +
                    `\n${settlementCross.blurb}`
                  }
                >
                  <div className="text-[9px] font-extrabold uppercase tracking-[0.18em] text-cyan-200/85">Cross soon</div>
                  <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-cyan-100">
                    60s: {Math.round(settlementCross.pCrossIn60s * 100)}%
                    <span className="text-cyan-200/50"> · 30s {Math.round(settlementCross.pCrossIn30s * 100)}%</span>
                    <span className="text-cyan-200/50"> · 120s {Math.round(settlementCross.pCrossIn120s * 100)}%</span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-cyan-200/70">
                    {settlementCross.confidence === 'low' || derivedStrip?.controlSignal === 'NO_EDGE' || derivedStrip?.structureEvent === 'chop' ? (
                      <span>Low conf. in chop / near band — use for timing only.</span>
                    ) : (
                      <span>Barrier MC from drift + tick vol; hover for 30/120s + bands.</span>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {derivedStrip?.structureEvent === 'chop' || derivedStrip?.reaction?.kind === 'choppy_at_line' ? (
          <div
            className="mt-2 rounded-lg border border-amber-600/50 bg-amber-950/25 px-3 py-2 text-[10px] leading-snug text-amber-100/95"
            title="Repeated crosses / negotiation at PTB — favor risk management: tighten, wait for a clean test."
          >
            <span className="font-bold text-amber-200">Chop / NO EDGE</span> — action is noisy; settlement & cross readouts are down-weighted. Prefer mechanical invalidations over forcing sells into the band.
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-zinc-400">
          <span
            className="rounded border border-zinc-600/70 bg-zinc-950/80 px-2 py-1 font-mono text-zinc-200"
            title={derivedStrip?.structureEventLabel ?? undefined}
          >
            {derivedStrip?.structureEvent?.replaceAll('_', ' ') ?? '—'} · Δ {derivedStrip ? fmtUsdSigned(derivedStrip.distanceUsd) : '—'}
          </span>
          <span
            className="rounded border border-zinc-600/70 bg-zinc-950/80 px-2 py-1 font-mono text-zinc-200"
            title={derivedStrip != null ? `Tick slope window ~${Math.round(derivedStrip.slopeWindowMs / 1000)}s, n=${derivedStrip.slopeSampleCount}` : undefined}
          >
            Slope {derivedStrip ? `${derivedStrip.slopeUsdPerMin >= 0 ? '+' : ''}${derivedStrip.slopeUsdPerMin.toFixed(3)}/m` : '—'}
          </span>
          {projection ? (
            <span
              className="rounded border border-indigo-600/40 bg-indigo-950/25 px-2 py-1 font-mono text-indigo-100"
              title={`Linear extrapolation: current tick slope × time. Not a prediction.\n${projection.t1}s → ${fmtUsd(projection.p1)}\n${projection.t2}s → ${fmtUsd(projection.p2)}${projection.sub ? `\n(${projection.sub})` : ''}`}
            >
              {projection.label} → {fmtUsd(projection.p1)}
            </span>
          ) : null}
          <span className="rounded border border-zinc-700/60 bg-black/30 px-2 py-1 text-zinc-500">{model.conviction}</span>
        </div>

        {priceToBeat != null && model && derivedStrip ? (() => {
          const _band = model.band;
          const _lo = priceToBeat - _band;
          const _hi = priceToBeat + _band;
          const _d = model.last - priceToBeat;
          const _inBand = Math.abs(_d) <= _band;
          const _geo = _inBand ? 'IN_BAND' as const : _d > 0 ? 'ABOVE' as const : 'BELOW' as const;
          const _absDist = Math.abs(_d);
          const _sep = _absDist >= _band * 3 ? 'STRONG' as const : _absDist >= _band * 1.75 ? 'CLEAR' as const : 'WEAK' as const;
          const _favorableNow = mode === 'up' ? model.last > _hi : model.last < _lo;
          const _edgeLive = _sep !== 'WEAK' && _favorableNow;
          const _ptbCtx: PtbDirectionContext = {
            geo: _geo, separation: _sep, edgeLive: _edgeLive, mode,
            viewLabel: mode === 'up' ? upLabel : downLabel,
            ptb: priceToBeat, bandHi: _hi, bandLo: _lo,
          };
          return (
            <SpotPriceProjectionGrid
              spotLast={model.last}
              slopeUsdPerSec={derivedStrip.slopeUsdPerSec}
              endsInMs={endsInMs}
              assetLabel={
                slug
                  ? (parseUpdownSlug(slug)?.asset ?? titledUpdownAssetFromSlug(slug) ?? undefined)?.toUpperCase()
                  : undefined
              }
              ptbContext={_ptbCtx}
            />
          );
        })() : null}

        {/* Make “WEAK SEPARATION” impossible to misread: bold, actionable, not just a chip. */}
        {priceToBeat != null && model ? (() => {
          const band = model.band;
          const lo = priceToBeat - band;
          const hi = priceToBeat + band;
          const now = model.last;
          const d = now - priceToBeat;
          const inBand = Math.abs(d) <= band;
          const side = inBand ? 'IN BAND' : d > 0 ? 'ABOVE' : 'BELOW';
          const sep = model.conviction;
          const favorableNow = mode === 'up' ? now > hi : now < lo;
          const edgeOk = sep !== 'WEAK SEPARATION' && favorableNow;

          const entryLine = mode === 'up' ? hi : lo;
          const stopBand = `${fmtUsd(lo)}–${fmtUsd(hi)}`;
          const proj30s = projection?.p1 ?? null;
          const tpLine = proj30s != null ? fmtUsd(proj30s) : '—';
          const settlementLine = settlementCross
            ? `Above ${Math.round(settlementCross.pAboveAtEnd * 100)}% · Below ${Math.round(settlementCross.pBelowAtEnd * 100)}%`
            : '—';
          const confLine = settlementCross ? `${settlementCross.confidence}` : '—';
          const eClose = settlementCross?.expectedEndPrice ?? null;
          const crossSoon = settlementCross
            ? `60s: ${Math.round(settlementCross.pCrossIn60s * 100)}% · 30s ${Math.round(settlementCross.pCrossIn30s * 100)}% · 120s ${Math.round(
                settlementCross.pCrossIn120s * 100,
              )}%`
            : '—';
          const slope = derivedStrip?.slopeUsdPerMin ?? null;
          const dist = derivedStrip?.distanceUsd ?? null;
          const structure = derivedStrip?.structureEvent?.replaceAll('_', ' ') ?? '—';

          const accentBorder =
            inBand
              ? 'border-amber-500/55'
              : favorableNow
                ? mode === 'up'
                  ? 'border-emerald-500/45'
                  : 'border-rose-500/45'
                : 'border-zinc-700/60';
          const accentBg =
            inBand
              ? 'from-amber-950/30'
              : favorableNow
                ? mode === 'up'
                  ? 'from-emerald-950/22'
                  : 'from-rose-950/22'
                : 'from-zinc-900/40';

          const glanceVerb =
            inBand ? 'WAIT — CONFIRM BREAK' : edgeOk ? 'EDGE LIVE — OK TO WORK' : 'NOT THIS VIEW — STAND ASIDE';
          const glanceGeo =
            side === 'IN BAND' ? 'IN BAND' : side === 'ABOVE' ? 'ABOVE PTB' : 'BELOW PTB';
          const glanceGeoClass =
            inBand
              ? 'text-amber-100'
              : side === 'ABOVE'
                ? 'text-sky-100'
                : 'text-rose-100';
          const glanceVerbClassFinal =
            inBand ? 'text-amber-200/95' : edgeOk ? 'text-emerald-200' : 'text-zinc-400';

          const confirmBody = inBand
            ? `Break & hold: above ${fmtUsd(hi)} (Up lens) or below ${fmtUsd(lo)} (Down lens).`
            : edgeOk
              ? mode === 'up'
                ? `Hold above ${fmtUsd(hi)} after pullbacks — stay outside band.`
                : `Hold below ${fmtUsd(lo)} after pullbacks — stay outside band.`
              : `Price is outside band on the other side — switch ${mode === 'up' ? downLabel : upLabel} view or wait.`;

          const reclaimFmt = mode === 'up' ? fmtUsd(hi) : fmtUsd(lo);

          return (
            <div className={`mt-3 rounded-2xl border-2 ${accentBorder} bg-gradient-to-br ${accentBg} via-zinc-950/60 to-black/40 p-4 ring-1 ring-white/[0.03]`}>
              {/* Glance: geographic vs PTB first — trains fast read (above / below / in-band). */}
              <div
                className={`rounded-xl border px-3 py-3 sm:px-4 sm:py-3.5 ${
                  inBand
                    ? 'border-amber-500/50 bg-amber-500/10'
                    : edgeOk
                      ? side === 'ABOVE'
                        ? 'border-sky-500/45 bg-sky-500/10'
                        : 'border-rose-500/45 bg-rose-500/10'
                      : 'border-zinc-600/50 bg-zinc-950/40'
                }`}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-[10px] font-black uppercase tracking-[0.22em] text-white/50">Where price is</div>
                    <div className={`mt-1 font-black leading-[1.05] tracking-tight ${glanceGeoClass} text-[clamp(1.75rem,5.5vw,2.65rem)]`}>
                      {glanceGeo}
                    </div>
                    <div className={`mt-1 text-[13px] font-bold uppercase tracking-wide ${glanceVerbClassFinal}`}>{glanceVerb}</div>
                  </div>
                  <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
                    <div
                      className={`rounded-lg border px-3 py-1.5 text-center text-[10px] font-black uppercase tracking-wide ${
                        sep === 'STRONG SEPARATION'
                          ? 'border-white/25 bg-white/10 text-white'
                          : sep === 'CLEAR SEPARATION'
                            ? 'border-white/15 bg-black/25 text-zinc-100'
                            : 'border-zinc-600/60 bg-black/30 text-zinc-300'
                      }`}
                    >
                      {sep.replace(' SEPARATION', '')}
                      <span className="block text-[9px] font-bold normal-case tracking-normal text-white/60">separation</span>
                    </div>
                    <div className="rounded-lg border border-zinc-700/60 bg-black/30 px-3 py-2 text-right">
                      <div className="text-[9px] font-bold uppercase tracking-wide text-zinc-500">Now</div>
                      <div className="mt-0.5 font-mono text-[13px] font-extrabold tabular-nums text-zinc-50">
                        {fmtUsd(now)} <span className="text-zinc-500">({fmtUsdSignedTight(now - priceToBeat)})</span>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="mt-2 border-t border-white/10 pt-2 text-[11px] leading-snug text-zinc-300">
                  Band <span className="font-mono text-zinc-100">{fmtUsd(lo)}–{fmtUsd(hi)}</span> · PTB{' '}
                  <span className="font-mono text-zinc-100">{fmtUsd(priceToBeat)}</span> · {mode === 'up' ? upLabel : downLabel}{' '}
                  <span className="text-zinc-500">view</span>
                </div>
              </div>

              <SpotBandPlayCardRow
                inBand={inBand}
                edgeOk={edgeOk}
                confirmBody={confirmBody}
                entryLineFmt={fmtUsd(entryLine)}
                stopBand={stopBand}
                tpLine={tpLine}
                reclaimFmt={reclaimFmt}
                slope={slope}
              />

              <div className="mt-2 grid gap-2 md:grid-cols-2">
                <div className="rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2">
                  <div className="text-[10px] font-black uppercase tracking-wide text-zinc-400">Settlement (vs PTB @ end)</div>
                  <div className="mt-1 font-mono text-[12px] font-bold text-zinc-100">{settlementLine}</div>
                  <div className="mt-1 text-[11px] text-zinc-400">
                    Confidence: <span className="font-semibold text-zinc-200">{confLine}</span> · E[close]{' '}
                    <span className="font-mono text-zinc-200">{eClose != null ? fmtUsd(eClose) : '—'}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-zinc-500">Cross soon: {crossSoon}</div>
                </div>
                <div className="rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2">
                  <div className="text-[10px] font-black uppercase tracking-wide text-zinc-400">Why</div>
                  <div className="mt-1 text-[12px] font-semibold text-zinc-100">
                    {inBand ? 'Low edge near PTB band — timing only.' : edgeOk ? 'Separation + slope support — press only on confirmation.' : 'Outside band exists, but not aligned to this view.'}
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-zinc-300">
                    {structure} · Δ {dist != null ? fmtUsdSignedTight(dist) : '—'} · Slope {slope != null ? `${slope >= 0 ? '+' : ''}${slope.toFixed(3)}/m` : '—'} · Proj 30s →{' '}
                    {proj30s != null ? fmtUsd(proj30s) : '—'}
                  </div>
                </div>
              </div>
            </div>
          );
        })() : null}

        {buildup && buildup.tier !== 'NONE' ? (() => {
          const tierColor = buildup.tier === 'FIRING' ? 'border-yellow-500/60 bg-yellow-950/30'
            : buildup.tier === 'READY' ? 'border-emerald-500/50 bg-emerald-950/25'
            : buildup.tier === 'BUILDING' ? 'border-blue-500/40 bg-blue-950/20'
            : 'border-zinc-700/50 bg-zinc-900/30';
          const textColor = buildup.tier === 'FIRING' ? 'text-yellow-200'
            : buildup.tier === 'READY' ? 'text-emerald-200'
            : buildup.tier === 'BUILDING' ? 'text-blue-200'
            : 'text-zinc-400';
          const barColor = buildup.tier === 'FIRING' ? 'bg-yellow-400'
            : buildup.tier === 'READY' ? 'bg-emerald-400'
            : buildup.tier === 'BUILDING' ? 'bg-blue-400'
            : 'bg-zinc-500';
          const arrow = buildup.direction === 'UP' ? '▲' : buildup.direction === 'DOWN' ? '▼' : '◆';
          return (
            <div className={`mt-3 rounded-xl border px-3 py-2.5 ${tierColor}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className={`font-mono text-base font-black ${textColor}`}>{arrow} {buildup.tier}</span>
                  <span className={`font-mono text-xs font-bold tabular-nums ${textColor}`}>{buildup.score}/100</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {buildup.signals.map((s, i) => (
                    <span key={i} className={`rounded-md border border-current/20 px-1.5 py-0.5 text-[10px] font-semibold ${textColor}`}>{s}</span>
                  ))}
                </div>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800/80">
                <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${buildup.score}%` }} />
              </div>
              <p className={`mt-1.5 text-[10px] leading-snug ${textColor} opacity-80`}>{buildup.label}</p>
            </div>
          );
        })() : null}

        {biasShift ? (() => {
          const isUp = biasShift.biasScore > 0;
          const strength = Math.abs(biasShift.biasScore);
          const biasBarColor = isUp ? 'bg-emerald-400' : biasShift.biasScore < 0 ? 'bg-rose-400' : 'bg-zinc-500';
          const biasTextColor = isUp ? 'text-emerald-200' : biasShift.biasScore < 0 ? 'text-rose-200' : 'text-zinc-400';
          const biasBorder = biasShift.shifting
            ? (biasShift.shiftUrgency === 'IMMINENT' ? 'border-yellow-500/70 bg-yellow-950/20' : 'border-yellow-600/40 bg-yellow-950/10')
            : (isUp ? 'border-emerald-700/40 bg-emerald-950/15' : biasShift.biasScore < 0 ? 'border-rose-700/40 bg-rose-950/15' : 'border-zinc-700/40 bg-zinc-900/20');
          return (
            <div className={`mt-3 rounded-xl border px-3 py-2.5 ${biasBorder}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div>
                    <div className="text-[9px] font-bold uppercase tracking-wide text-zinc-500">Bias</div>
                    <div className={`font-mono text-lg font-black leading-tight ${biasTextColor}`}>
                      {isUp ? '▲' : biasShift.biasScore < 0 ? '▼' : '◆'} {biasShift.bias}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    <div className="h-2 w-28 overflow-hidden rounded-full bg-zinc-800/80">
                      <div className={`h-full rounded-full ${biasBarColor}`} style={{ width: `${strength}%`, marginLeft: isUp ? '50%' : `${50 - strength}%` }} />
                    </div>
                    <div className="flex justify-between text-[7px] font-bold text-zinc-600">
                      <span>SELL</span><span>NEUTRAL</span><span>BUY</span>
                    </div>
                  </div>
                </div>
                {biasShift.shifting ? (
                  <div className={`rounded-lg border px-2.5 py-1.5 ${biasShift.shiftUrgency === 'IMMINENT' ? 'border-yellow-400/60 bg-yellow-400/10' : 'border-yellow-500/30 bg-yellow-500/5'}`}>
                    <div className={`font-mono text-xs font-black ${biasShift.shiftUrgency === 'IMMINENT' ? 'text-yellow-200' : 'text-yellow-300/80'}`}>
                      ⚡ SHIFT {biasShift.shiftUrgency} {biasShift.shiftDir}
                    </div>
                  </div>
                ) : null}
              </div>
              {biasShift.reasons.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {biasShift.reasons.map((r, i) => (
                    <span key={i} className="rounded-md border border-yellow-600/30 bg-yellow-950/15 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-200/80">{r}</span>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })() : null}
      </section>
      ) : null}

      {!signalsEmbed ? (
      <details className="mx-4 mb-3 mt-1 rounded-xl border border-zinc-800/50 bg-zinc-900/20 px-3 py-2 text-[11px] text-zinc-500 ring-1 ring-white/[0.02]">
        <summary className="cursor-pointer select-none font-semibold text-zinc-400">Chart details · engine · attribution</summary>
        <p className="mt-2 text-[10px] leading-snug text-zinc-600">{STREAM_ATTRIBUTION_LINE}</p>
        <p className="mt-2 leading-relaxed text-zinc-500">{PTB_REACTION_ONE_LINER}</p>
        <ul className="mt-2 list-inside list-disc space-y-1 text-zinc-500">
          {PTB_REACTION_DIMENSIONS.map((d) => (
            <li key={d.title}>
              <span className="font-semibold text-zinc-400">{d.title}</span> — {d.body}
            </li>
          ))}
        </ul>
        <div className="mt-3 rounded-lg border border-zinc-800/60 bg-black/25 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-amber-100/90">
          <span className="font-semibold text-amber-200/90">PTB read</span> — {derivedStrip?.interactionLabel ?? 'Scoring…'}
        </div>
      </details>
      ) : null}
    </div>
  );
}

// =====================================================================================
// Decision banner — big, prominent block above the chart on 1h / 4h windows.
// =====================================================================================
function DecisionBanner({
  forecast,
  upLabel,
  downLabel,
  dwellInfo,
  onTestBoom,
  machine,
  operatorVerdict,
  hasDirective,
  tapeWaitCardGo = false,
}: {
  forecast: SwitchForecast;
  upLabel: string;
  downLabel: string;
  /** When set, renders a "watching X/Y" dwell pill so the user can see the loud alert is being tracked. */
  dwellInfo?: { count: number; need: number } | null;
  /** Manual test-fire — proves the overlay paint without waiting for a real signal. */
  onTestBoom?: () => void;
  /** Fused sensors — agreement %, regime, urgency, prob↔spot. */
  machine?: SpotPtbMachineReadout | null;
  /** Same execution gate as the trade card — when STAND_DOWN, entry-style sectional hype is labeled non-executable. */
  operatorVerdict: OperatorVerdict;
  /** False until the trade engine has produced a directive — avoids treating "no signal yet" as an execution clash. */
  hasDirective: boolean;
  /** Sectional WAIT while Answer GO — slice has no dominant lane; card uses full model. */
  tapeWaitCardGo?: boolean;
}): ReactElement {
  const { status, lane, incomingLane, confidence, etaSec } = forecast;
  const laneLabel = lane === 'up' ? upLabel : lane === 'down' ? downLabel : '—';
  const incomingLabel = incomingLane === 'up' ? upLabel : incomingLane === 'down' ? downLabel : null;

  const structureOnly =
    hasDirective &&
    operatorVerdict.isStandDown &&
    (status === 'GO_IN' || status === 'STAY_IN' || status === 'SWITCH_INCOMING' || status === 'EXIT');

  const palette = (() => {
    if (structureOnly) {
      return {
        bg: 'from-zinc-900/90 via-zinc-950/92 to-rose-950/35',
        border: 'border-rose-500/50',
        text: 'text-zinc-100',
        dot: 'bg-rose-400',
        icon: '⏸',
      };
    }
    switch (status) {
      case 'GO_IN':
        return lane === 'up'
          ? { bg: 'from-emerald-700/55 to-emerald-900/40', border: 'border-emerald-400/60', text: 'text-emerald-50', dot: 'bg-emerald-300', icon: '▲' }
          : { bg: 'from-rose-700/55 to-rose-900/40', border: 'border-rose-400/60', text: 'text-rose-50', dot: 'bg-rose-300', icon: '▼' };
      case 'STAY_IN':
        return lane === 'up'
          ? { bg: 'from-emerald-800/40 to-emerald-950/30', border: 'border-emerald-500/40', text: 'text-emerald-100', dot: 'bg-emerald-300', icon: '➤' }
          : { bg: 'from-rose-800/40 to-rose-950/30', border: 'border-rose-500/40', text: 'text-rose-100', dot: 'bg-rose-300', icon: '➤' };
      case 'EXIT':
        return { bg: 'from-amber-700/55 to-rose-900/45', border: 'border-amber-400/65', text: 'text-amber-50', dot: 'bg-amber-300', icon: '✕' };
      case 'SWITCH_INCOMING':
        return { bg: 'from-amber-700/45 to-indigo-900/40', border: 'border-amber-300/55', text: 'text-amber-50', dot: 'bg-amber-300', icon: '⚡' };
      default:
        return { bg: 'from-zinc-800/40 to-zinc-900/40', border: 'border-zinc-700/60', text: 'text-zinc-200', dot: 'bg-zinc-500', icon: '⏸' };
    }
  })();

  const confTone =
    confidence === 'HIGH' ? 'bg-amber-300/25 text-amber-100 border-amber-300/50'
    : confidence === 'MED' ? 'bg-indigo-300/15 text-indigo-100 border-indigo-300/40'
    : 'bg-zinc-700/30 text-zinc-300 border-zinc-600/40';

  const headline = forecast.headline.replace('UP', upLabel).replace('DOWN', downLabel);

  const showIntensityBars = status === 'SWITCH_INCOMING' || status === 'EXIT';
  const lockBarPct =
    dwellInfo != null && dwellInfo.need > 0
      ? Math.min(100, Math.round((dwellInfo.count / dwellInfo.need) * 100))
      : null;
  const crossBarPct = machine?.crossProb != null ? Math.round(machine.crossProb * 100) : null;
  const sectionalConfPct = confidence === 'HIGH' ? 100 : confidence === 'MED' ? 66 : 33;

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 ${palette.border} bg-gradient-to-r ${palette.bg} px-4 py-3 shadow-lg shadow-black/40`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className={`flex flex-wrap gap-2 ${structureOnly ? 'items-start' : 'items-center'}`}>
          <span className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${palette.dot} text-base font-black text-zinc-950 shadow shadow-black/40`}>
            {palette.icon}
          </span>
          {structureOnly ? (
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md border border-zinc-600/70 bg-zinc-950/60 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wider text-zinc-400">
                  Tape / chart
                </span>
                <span className={`text-sm font-bold uppercase tracking-tight ${palette.text} sm:text-base`}>{headline}</span>
                <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${confTone}`}>
                  {confidence}
                </span>
              </div>
              <p className="text-[10px] leading-snug text-zinc-400">
                <span className="font-semibold text-rose-200/90">Stand-down</span> on the Answer card — do not size off this
                headline. Use the Answer block above for whipsaw, cooldown, and risk chips.
              </p>
            </div>
          ) : (
            <>
              <span className={`text-base font-black uppercase tracking-tight ${palette.text} sm:text-lg`}>{headline}</span>
              <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${confTone}`}>
                {confidence}
              </span>
            </>
          )}
          {!structureOnly ? (
            <>
          {etaSec != null && status === 'SWITCH_INCOMING' ? (
            <span className="rounded-md border border-amber-300/60 bg-amber-200/15 px-1.5 py-0.5 text-[10px] font-extrabold tracking-wide text-amber-100">
              ETA ~{etaSec}s
            </span>
          ) : null}
          {dwellInfo ? (
            <span
              className={`rounded-md border px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${
                dwellInfo.count >= dwellInfo.need
                  ? 'border-amber-300/70 bg-amber-300/20 text-amber-100 animate-pulse'
                  : 'border-zinc-700/70 bg-zinc-900/40 text-zinc-300'
              }`}
              title="Advances on new spot ticks while the sectional call stays the same — not every UI refresh."
            >
              LOCK {dwellInfo.count}/{dwellInfo.need}
            </span>
          ) : null}
            </>
          ) : null}
          {onTestBoom ? (
            <button
              type="button"
              onClick={onTestBoom}
              className="rounded-md border border-zinc-700/70 bg-zinc-900/45 px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-zinc-300 hover:bg-zinc-800/60 hover:text-zinc-100"
              title="Preview the full-screen alert overlay."
            >
              Test alert
            </button>
          ) : null}
        </div>
        {!structureOnly ? (
          <p className={`text-[11px] leading-relaxed ${palette.text}/85`}>{forecast.reason}</p>
        ) : (
          <p className="text-[10px] leading-relaxed text-zinc-500">{forecast.reason}</p>
        )}
        {tapeWaitCardGo && !structureOnly ? (
          <p className="mt-1 rounded-lg border border-amber-700/45 bg-amber-950/25 px-2 py-1.5 text-[10px] leading-snug text-amber-100/95">
            <span className="font-semibold text-amber-200">Answer card GO</span> — this line is the{' '}
            <span className="font-semibold text-zinc-200">sectional slice</span> only (mixed buckets). The trade card also
            uses control, book, and PTB; it can show ENTER while the slice still says WAIT.
          </p>
        ) : null}
        {showIntensityBars ? (
          <div className="mt-2 grid max-w-lg gap-2 sm:grid-cols-3">
            {lockBarPct != null ? (
              <div>
                <div className={`flex justify-between text-[9px] font-bold uppercase tracking-wide ${palette.text}/70`}>
                  <span>Alert lock</span>
                  <span className="tabular-nums">{lockBarPct}%</span>
                </div>
                <div className="mt-0.5 h-2 overflow-hidden rounded-full bg-black/35 ring-1 ring-white/10">
                  <div
                    className={`h-full rounded-full ${lockBarPct >= 100 ? 'bg-amber-300' : 'bg-amber-400/80'}`}
                    style={{ width: `${lockBarPct}%` }}
                  />
                </div>
              </div>
            ) : null}
            {crossBarPct != null ? (
              <div>
                <div className={`flex justify-between text-[9px] font-bold uppercase tracking-wide ${palette.text}/70`}>
                  <span>PTB cross</span>
                  <span className="tabular-nums">{crossBarPct}%</span>
                </div>
                <div className="mt-0.5 h-2 overflow-hidden rounded-full bg-black/35 ring-1 ring-white/10">
                  <div
                    className={`h-full rounded-full ${
                      crossBarPct >= 70 ? 'bg-fuchsia-400/90' : crossBarPct >= 40 ? 'bg-amber-300/90' : 'bg-emerald-400/85'
                    }`}
                    style={{ width: `${crossBarPct}%` }}
                  />
                </div>
              </div>
            ) : null}
            <div>
              <div className={`flex justify-between text-[9px] font-bold uppercase tracking-wide ${palette.text}/70`}>
                <span>Sectional</span>
                <span className="tabular-nums">{sectionalConfPct}%</span>
              </div>
              <div className="mt-0.5 h-2 overflow-hidden rounded-full bg-black/35 ring-1 ring-white/10">
                <div
                  className={`h-full rounded-full ${
                    confidence === 'HIGH' ? 'bg-emerald-400/90' : confidence === 'MED' ? 'bg-indigo-400/90' : 'bg-zinc-500/90'
                  }`}
                  style={{ width: `${sectionalConfPct}%` }}
                  title={`Forecast confidence: ${confidence}`}
                />
              </div>
            </div>
          </div>
        ) : null}
        {machine && !structureOnly ? (
          <p className="mt-1.5 text-[10px] font-semibold tracking-wide text-zinc-400">
            <span className="font-black uppercase tracking-wider text-zinc-500">Sensors</span>{' '}
            <span className="tabular-nums text-zinc-200">{machine.agreementScore}%</span>
            <span className="text-zinc-600"> · </span>
            <span className="text-zinc-200">{machine.regime}</span>
            {machine.crossProb != null ? (
              <>
                <span className="text-zinc-600"> · </span>
                <span className="tabular-nums text-zinc-200">{Math.round(machine.crossProb * 100)}% cross</span>
              </>
            ) : null}
            <span className="text-zinc-600"> · </span>
            <span className="text-zinc-300">align {machine.probVsSpot}</span>
          </p>
        ) : machine && structureOnly ? (
          <p className="mt-1 text-[9px] leading-snug text-zinc-500">
            Full sensor chips are on the trade card above — expand “Why & sizes” there if you need them.
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 text-right">
        <span className="text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-300/85">
          {status === 'SWITCH_INCOMING' ? 'Slice drift' : 'Lane'}
        </span>
        <span className={`text-lg font-black ${palette.text}`}>{laneLabel}</span>
        {status === 'SWITCH_INCOMING' && incomingLabel ? (
          structureOnly ? (
            <span className="max-w-[10rem] text-[10px] font-semibold leading-snug text-zinc-500">
              Model leans {incomingLabel}
            </span>
          ) : (
            <span className="text-[10px] font-bold uppercase tracking-wide text-amber-200">
              → desk tape → {incomingLabel}
            </span>
          )
        ) : null}
      </div>
    </div>
  );
}

// =====================================================================================
// Sectional strip — N color-coded blocks (UP/DOWN/FLAT) for the round breakdown.
// =====================================================================================
function SectionalStrip({
  sections,
  sectionMs,
  upLabel,
  downLabel,
  forecast,
  executionClash = false,
}: {
  sections: SpotSection[];
  sectionMs: number;
  upLabel: string;
  downLabel: string;
  forecast: SwitchForecast | null;
  /** Trade card STAND_DOWN while sectional still shows momentum — soften strip copy + motion. */
  executionClash?: boolean;
}): ReactElement {
  const minutes = Math.round(sectionMs / 60_000);
  const totalMin = minutes * sections.length;
  const entryishSectional =
    forecast != null &&
    (forecast.status === 'GO_IN' || forecast.status === 'STAY_IN' || forecast.status === 'SWITCH_INCOMING');
  const switchOn =
    forecast != null && forecast.status === 'SWITCH_INCOMING' && forecast.incomingLane != null;
  const fromLane: 'up' | 'down' | null = switchOn ? forecast.lane ?? forecast.driftLane : null;
  const toLane: 'up' | 'down' | null = switchOn ? forecast.incomingLane : null;
  const etaUrgencyPct = (() => {
    if (!switchOn || forecast.etaSec == null || !Number.isFinite(forecast.etaSec) || forecast.etaSec <= 0) {
      return null;
    }
    const e = Math.max(5, forecast.etaSec);
    const urgency01 = 1 - Math.min(1, (e - 5) / 590);
    return Math.min(100, Math.max(0, Math.round(100 * urgency01)));
  })();
  const evidencePick =
    switchOn && forecast.evidence.length > 0 ? forecast.evidence.slice(0, 4) : [];

  return (
    <div className="mt-2 rounded-xl border border-zinc-800/70 bg-black/25 px-3 py-2 shadow-inner shadow-black/30">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[10px] font-black uppercase tracking-[0.14em] text-zinc-500">Round slices</div>
          <div className="text-[9px] tabular-nums text-zinc-600">
            {sections.length} × {minutes}m · {totalMin}m
          </div>
        </div>
        <div className="flex items-center gap-2 text-[9px] uppercase tracking-wide text-zinc-500">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-emerald-500" /> {upLabel}</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-rose-500" /> {downLabel}</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-zinc-600" /> flat</span>
        </div>
      </div>
      {switchOn && fromLane && toLane ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-gradient-to-r from-amber-950/40 to-indigo-950/30 px-2.5 py-1.5">
          <span className="text-[9px] font-black uppercase tracking-wider text-amber-200/90">Tape vs slices</span>
          <span
            className={`rounded-md px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${
              fromLane === 'up'
                ? 'bg-emerald-500/35 text-emerald-100 ring-1 ring-emerald-400/40'
                : 'bg-rose-500/35 text-rose-100 ring-1 ring-rose-400/40'
            }`}
          >
            {fromLane === 'up' ? upLabel : downLabel}
          </span>
          <span className="text-[11px] font-black text-amber-200/80">→</span>
          <span
            className={`rounded-md px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${
              toLane === 'up'
                ? 'bg-emerald-400/45 text-emerald-50 ring-1 ring-amber-300/45'
                : 'bg-rose-400/45 text-rose-50 ring-1 ring-amber-300/45'
            }`}
          >
            {toLane === 'up' ? upLabel : downLabel}
          </span>
          <span className="ml-auto max-w-[11rem] text-right text-[8px] font-semibold uppercase leading-snug tracking-wide text-zinc-500">
            {executionClash ? 'View only' : 'Rightmost slice = live tape'}
          </span>
        </div>
      ) : null}
      <div className="mt-1.5 flex h-9 w-full overflow-hidden rounded-lg border border-zinc-900/60 bg-black/40">
        {sections.map((s, i) => {
          const isLast = i === sections.length - 1;
          const baseColor =
            s.direction === 'UP' ? 'bg-emerald-600' : s.direction === 'DOWN' ? 'bg-rose-600' : 'bg-zinc-700';
          const opacity = 0.45 + Math.min(0.55, s.intensity01 * 0.55);
          const moveLabel = `${s.netUsd >= 0 ? '+' : ''}${s.netUsd.toFixed(s.netUsd < 100 ? 2 : 1)}`;
          const slopeLabel = `${s.slopeUsdPerMin >= 0 ? '+' : ''}${s.slopeUsdPerMin.toFixed(2)}/m`;
          const tip =
            `${s.direction} · net ${moveLabel} · slope ${slopeLabel}` +
            (s.ptbCrosses > 0 ? ` · ${s.ptbCrosses} PTB cross${s.ptbCrosses === 1 ? '' : 'es'}` : '');
          const lastSegSwitch = isLast && switchOn && !executionClash;
          const pulseClass = lastSegSwitch
            ? 'ring-2 ring-inset ring-amber-300/55 shadow-[0_0_14px_rgba(251,191,36,0.28)] z-[1]'
            : isLast && !executionClash && !switchOn
              ? 'animate-pulse'
              : '';
          return (
            <div
              key={i}
              className={`relative min-w-0 flex-1 ${baseColor} ${pulseClass}`}
              style={{ opacity }}
              title={tip}
            >
              {sections.length <= 8 ? (
                <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-1 text-[9px] font-bold leading-tight text-white/95 [text-shadow:0_1px_2px_rgba(0,0,0,0.55)]">
                  <span className="truncate">{moveLabel}</span>
                  <span className="truncate text-[8px] font-semibold opacity-80">{slopeLabel}</span>
                </div>
              ) : null}
              {i < sections.length - 1 ? (
                <span className="absolute inset-y-0 right-0 w-px bg-black/40" />
              ) : null}
            </div>
          );
        })}
      </div>
      {forecast && forecast.status === 'SWITCH_INCOMING' && forecast.incomingLane ? (
        executionClash ? (
          <p className="mt-1.5 text-[10px] leading-snug text-zinc-500">
            <span className="font-bold text-zinc-300">Chart:</span> leaning {forecast.incomingLane === 'up' ? upLabel : downLabel}
            {forecast.etaSec != null ? <> · ~{forecast.etaSec}s</> : null}.{' '}
            <span className="font-bold text-rose-200/90">Do not size</span> — trade card says wait.
          </p>
        ) : (
          <>
            <p className="mt-1.5 text-[10px] leading-snug text-amber-200/90">
              <span className="font-bold text-amber-100">Switch watch:</span> desk tape toward{' '}
              <strong className="text-amber-50">{forecast.incomingLane === 'up' ? upLabel : downLabel}</strong>
              {forecast.etaSec != null ? (
                <>
                  {' '}
                  · model ETA <span className="font-mono font-bold tabular-nums">~{forecast.etaSec}s</span> vs PTB
                </>
              ) : (
                '.'
              )}
            </p>
            {etaUrgencyPct != null ? (
              <div className="mt-2">
                <div className="flex justify-between text-[8px] font-bold uppercase tracking-wide text-zinc-500">
                  <span>ETA pressure</span>
                  <span className="tabular-nums text-amber-200/90">{etaUrgencyPct}%</span>
                </div>
                <div
                  className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-black/45 ring-1 ring-amber-500/20"
                  title="Fills as the model ETA gets shorter (5s–10m band)."
                >
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-amber-400/90 to-orange-400/85"
                    style={{ width: `${etaUrgencyPct}%` }}
                  />
                </div>
              </div>
            ) : null}
            {evidencePick.length > 0 ? (
              <ul className="mt-2 space-y-0.5 border-t border-amber-500/15 pt-1.5 text-[9px] leading-snug text-zinc-400">
                {evidencePick.map((line, j) => (
                  <li key={j} className="flex gap-1.5">
                    <span className="shrink-0 font-black text-amber-500/80">·</span>
                    <span className="min-w-0">{line}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )
      ) : null}
      {executionClash && entryishSectional && forecast && forecast.status !== 'SWITCH_INCOMING' ? (
        <p className="mt-1.5 text-[10px] leading-snug text-zinc-500">
          <span className="font-bold text-zinc-300">Chart:</span> {forecast.status.replace('_', ' ')} on{' '}
          {forecast.lane === 'up' ? upLabel : forecast.lane === 'down' ? downLabel : '—'}.{' '}
          <span className="font-bold text-rose-200/90">Do not trade</span> — trade card says wait.
        </p>
      ) : null}
    </div>
  );
}

// =====================================================================================
// TapeVelocityStrip — buyer/seller pressure + burst chip on the active outcome.
// Driven by `computeTapeVelocity`. Renders nothing until the tape has prints.
// =====================================================================================
function TapeVelocityStrip({
  tape,
  lane,
  upLabel,
  downLabel,
  reduceMotion,
}: {
  tape: TapeVelocity;
  lane: 'up' | 'down' | null;
  upLabel: string;
  downLabel: string;
  reduceMotion: boolean;
}): ReactElement | null {
  if (tape.recent.count === 0) return null;
  const dom = tape.dominance;
  const fightsLane =
    lane != null && ((lane === 'up' && dom === 'sell') || (lane === 'down' && dom === 'buy'));
  const burstColor =
    tape.burst === 'extreme'
      ? 'border-fuchsia-400/60 bg-fuchsia-950/40 text-fuchsia-100'
      : tape.burst === 'aggressive'
        ? 'border-amber-400/55 bg-amber-950/40 text-amber-100'
        : 'border-zinc-700/60 bg-zinc-900/40 text-zinc-300';
  const domColor =
    dom === 'buy'
      ? 'border-emerald-400/55 bg-emerald-950/35 text-emerald-100'
      : dom === 'sell'
        ? 'border-rose-400/55 bg-rose-950/35 text-rose-100'
        : 'border-zinc-700/60 bg-zinc-900/40 text-zinc-300';
  const pulse = !reduceMotion && (tape.burst === 'extreme' || tape.burst === 'aggressive') ? 'animate-pulse' : '';
  // Net-pressure mini bar: -100..100 → 0..100% of half-bar width on the matching side.
  const pct = Math.min(100, Math.abs(tape.netPressure));
  return (
    <div
      className={`mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800/70 bg-zinc-950/35 px-2.5 py-1.5 text-[10px] ${pulse}`}
      title={tape.summary}
    >
      <span className="font-black uppercase tracking-wider text-zinc-500" title="Recent CLOB prints — desk context, not the trade card">
        Desk tape
      </span>
      <span className={`rounded-md border px-1.5 py-0.5 font-extrabold uppercase ${domColor}`}>
        {dom === 'buy' ? 'BUYERS' : dom === 'sell' ? 'SELLERS' : dom === 'mixed' ? 'mixed' : 'idle'}
        <span className="ml-1 tabular-nums opacity-85">
          {tape.netPressure >= 0 ? '+' : ''}
          {tape.netPressure.toFixed(0)}
        </span>
      </span>
      <span className={`rounded-md border px-1.5 py-0.5 font-extrabold uppercase ${burstColor}`}>
        {tape.burst === 'extreme' ? '⚡ extreme' : tape.burst === 'aggressive' ? '⚡ aggressive' : tape.burst}
        <span className="ml-1 tabular-nums opacity-85">×{tape.burstRatio.toFixed(1)}</span>
      </span>
      <span className="rounded-md border border-zinc-700/55 bg-zinc-900/40 px-1.5 py-0.5 tabular-nums text-zinc-300">
        {tape.recent.count} prints / 30s
      </span>
      {fightsLane ? (
        <span
          className={`rounded-md border border-rose-400/65 bg-rose-950/40 px-1.5 py-0.5 font-black uppercase text-rose-100 ${pulse}`}
          title="Tape pressure opposes the lane your card is sized for — re-check before adding."
        >
          ⚠ tape vs {lane === 'up' ? upLabel : downLabel}
        </span>
      ) : null}
      <div className="ml-auto flex h-2 w-32 overflow-hidden rounded-full border border-zinc-800 bg-zinc-950/60">
        <div className="flex-1 flex justify-end">
          {tape.netPressure < 0 ? (
            <div
              className="h-full bg-rose-400/80"
              style={{ width: `${pct}%` }}
              aria-label={`Sell pressure ${pct.toFixed(0)}%`}
            />
          ) : null}
        </div>
        <span className="h-full w-px bg-zinc-700" />
        <div className="flex-1 flex justify-start">
          {tape.netPressure >= 0 ? (
            <div
              className="h-full bg-emerald-400/80"
              style={{ width: `${pct}%` }}
              aria-label={`Buy pressure ${pct.toFixed(0)}%`}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// =====================================================================================
// NoTradeBanner — single composite risk banner. Renders when score is YELLOW or RED.
//
// In `compact` mode it collapses to a thin one-line strip. The chart sets compact
// when the operator-verdict band is already showing wait / pause — the verdict is
// the dominant signal and we don't want two screaming red blocks fighting for
// attention. The strip still surfaces the score + top reason as a hoverable summary.
// =====================================================================================
function NoTradeBanner({
  score,
  reduceMotion,
  compact = false,
}: {
  score: NoTradeScore;
  reduceMotion: boolean;
  compact?: boolean;
}): ReactElement {
  const palette =
    score.tier === 'RED'
      ? 'border-rose-400/65 bg-rose-950/40 text-rose-50'
      : 'border-amber-400/55 bg-amber-950/35 text-amber-50';
  // In compact mode, never pulse — the verdict band is already pulling focus.
  const pulse = !reduceMotion && !compact && score.tier === 'RED' ? 'animate-pulse' : '';

  if (compact) {
    const topReasons = score.contributions
      .slice(0, 3)
      .map((c) => c.reason.replace(/_/g, ' '))
      .join(', ');
    return (
      <div
        role="status"
        aria-live="polite"
        className={`mb-2 flex items-center gap-2 rounded-lg border px-2.5 py-1 text-[11px] ${palette}`}
        title={score.summary}
      >
        <span className="text-sm">{score.tier === 'RED' ? '⛔' : '⚠'}</span>
        <span className="font-bold uppercase tracking-wider">
          Risk {score.score}
        </span>
        <span className="truncate text-[10px] opacity-85">
          {topReasons || score.summary}
        </span>
        <span className="ml-auto text-[9px] uppercase tracking-wider opacity-60">↑ answer</span>
      </div>
    );
  }

  return (
    <div
      role={score.tier === 'RED' ? 'alert' : 'status'}
      aria-live="polite"
      className={`mb-2 flex flex-wrap items-start gap-2 rounded-2xl border-2 px-3 py-2 ${palette} ${pulse}`}
      title={score.summary}
    >
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-base font-black">
        {score.tier === 'RED' ? '⛔' : '⚠'}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-black uppercase tracking-tight">
          {score.tier === 'RED' ? 'High no-trade risk' : 'Elevated risk'} · {score.score}/100
        </span>
        <ul className="mt-1 grid grid-cols-1 gap-x-3 gap-y-0.5 text-[11px] leading-snug sm:grid-cols-2">
          {score.contributions.slice(0, 2).map((c) => (
            <li key={c.reason} className="flex items-start gap-1.5">
              <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-white/65" aria-hidden />
              <span>
                <strong className="font-bold uppercase tracking-wide">
                  {c.reason.replace(/_/g, ' ')} (+{c.weight})
                </strong>{' '}
                — {c.message}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// =====================================================================================
// ShortcutHelp — small dismissible dialog listing keyboard shortcuts.
// =====================================================================================
function ShortcutHelp({ onClose }: { onClose: () => void }): ReactElement {
  return (
    <div className="mb-2 flex flex-wrap items-start gap-3 rounded-2xl border border-zinc-700/70 bg-zinc-900/85 px-3 py-2 text-[11px] text-zinc-100 shadow-lg shadow-black/40">
      <span className="text-base">⌨</span>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-black uppercase tracking-[0.2em] text-zinc-300">
            Keyboard shortcuts
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-700/70 bg-zinc-800/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide hover:bg-zinc-800"
          >
            Close
          </button>
        </div>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-3">
          {SHORTCUT_HELP.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <kbd className="inline-flex min-w-[1.6em] items-center justify-center rounded border border-zinc-700/70 bg-zinc-950/50 px-1.5 py-0.5 font-mono text-[10px] font-bold text-zinc-200">
                {s.key}
              </kbd>
              <span className="text-[11px] text-zinc-300">{s.description}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
