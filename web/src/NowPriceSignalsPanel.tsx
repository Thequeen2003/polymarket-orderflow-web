import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import type { SpotBandGaugeSnapshot } from './spotBandDeskAction';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { TapeVelocity } from './tapeVelocity';
import { computeStableProjectedHeader } from './chartStableProjectedHeader';
import { PredictionHorizonTimer } from './PredictionHorizonTimer';
import { PricePredictionSignalCard } from './PricePredictionSignalCard';
import { buildContractProbProjectionGrid, enrichPricePredictionWithContracts } from './contractProbProjection';
import { computePricePredictionSignal, type PricePredictionProjection } from './pricePredictionSignal';
import { MachineVerdictCard } from './MachineVerdictCard';
import {
  buildNowPriceBandDistances,
  buildProjectionNowWindow,
  buildSpotBandGlance,
  type ConfirmedEdgeGlance,
  type NowPriceBandDistances,
  type ProjectionNowCell,
} from './nowPriceSignals';
import {
  computeFairValueEdgeSides,
  computeFairValueGapSignal,
  FVG_MIN_SAMPLES_FOR_MEAN,
  FVG_SIGNAL_STRONG_THRESHOLD,
  FVG_SIGNAL_WEAK_THRESHOLD,
  type FairValueGapReadout,
  type FairValueGapSignalReadout,
  type FairValueSimpleReadout,
  type FvgSignalTier,
} from './fairValueGap';
import { computeContractLagReadout, CONTRACT_LAG_STALE_MS, recentProbDelta01, type ContractLagPhase, type ContractLagReadout } from './contractLag';
import { lastPointMs, maxFeedMs } from './feedFreshness';
import type { StableProjectedHeaderSnapshot } from './chartStableProjectedHeader';
import type { GlanceTone } from './nowPriceGlance';
import { useFairValueGap } from './useFairValueGap';
import { estimateBinaryOutcomeBias, type BinaryBiasSignal, type BinaryOutcomeEstimate } from './binaryOutcomeBias';
import {
  EDGE_TRADE_THRESHOLD,
  evaluateProbabilityEdgeScalp,
  type ProbabilityEdgeScalp,
} from './probabilityEdgeScalp';
import {
  computeDeskSpeedSnapshot,
  formatProbSpeedPpMin,
  formatSpotSpeedPerMin,
  laneSupportLabel,
  speedDirectionArrow,
  type DeskSpeedSnapshot,
  type OutcomeLaneSpeed,
  type SpeedAlignment,
  type LaneSupport,
} from './deskSpeedLayers';
import { computeDirectionScore, directionScoreShortLabel, type DirectionScoreSnapshot } from './deskDirectionScore';
import { buildMtfConsensus } from './multiTimeframeConsensus';
import type { ContractLeadSignal } from './contractLeadSignal';
import { computeDirectionEngine, type DirectionEngineSignal } from './directionEngine';
import { NowPriceBuyStrip } from './NowPriceBuyStrip';
import { buildNowPriceDeskTradeSignal, type NowPriceDeskTradeSignal } from './nowPriceDeskTradeSignal';
import { buildDeskAheadPlaybook, deskCatchModeLabel, formatDeskBracketLine, type DeskAheadPlaybook } from './deskAheadPlaybook';
import { computePreBuyTpOutlook } from './positionTpOutlook';
import type { BuySideAdvisory } from './shouldBuyWhichSide';
import { computeEntryMoment } from './entryMoment';
import { spreadBracketFromFillPrice01, type BookTouchForArmRisk } from './armRiskFromSignal';
import { buildQuoteAssistTargets, loadEmergencyStopBundlePrefs } from './buyBundleStaging';
import {
  computeExecutionSignal,
  EXEC_MIN_EDGE_PP,
  EXEC_MIN_MODEL_PROB,
  type ExecutionSignal,
} from './executionSignal';
import { useExecutionConfirmTracker } from './executionSignalDesk';
import { computeContractEntryJump, type ContractEntryJump } from './deskSpeedGainPct';
import { computeBilateralEdge, pickEdgeLaneHint, pickStrongerEdgeSide } from './bilateralEdge';
import {
  computePressureBuildup,
  PRESSURE_CONFIRM_HORIZON_SEC,
  PRESSURE_EARLY_HORIZON_SEC,
  pressureBuildupShortLabel,
  type PressureBuildupSnapshot,
  type PressureVerdict,
} from './pressureBuildupScore';

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtUsdSigned(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const s = n >= 0 ? '+' : '-';
  return `${s}$${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function fmtDistClear(n: number, direction: 'above' | 'below'): string {
  if (!Number.isFinite(n)) return '—';
  if (n <= 0) return `clear +${fmtUsd(Math.abs(n))}`;
  return `${fmtUsd(n)} to ${direction}`;
}

function fmtCents(v01: number | null | undefined): string {
  if (v01 == null || !Number.isFinite(v01)) return '—';
  const c = v01 * 100;
  return c >= 10 ? `${c.toFixed(1)}¢` : `${c.toFixed(2)}¢`;
}

function fmtDeltaCents(d01: number | null | undefined): string {
  if (d01 == null || !Number.isFinite(d01)) return '—';
  const c = d01 * 100;
  if (Math.abs(c) < 0.05) return '0¢';
  return `${c >= 0 ? '+' : ''}${c.toFixed(1)}¢`;
}

function fmtProbPct01(p01: number | null | undefined): string {
  if (p01 == null || !Number.isFinite(p01)) return '—';
  const clamped = Math.max(0, Math.min(1, p01));
  const pct = clamped * 100;
  if (pct > 0 && pct < 0.01) return '<0.01%';
  if (pct > 0 && pct < 0.1) return '<0.1%';
  return pct >= 10 ? `${pct.toFixed(1)}%` : `${pct.toFixed(2)}%`;
}

function normalizeBinaryFlexible(
  up01: number | null,
  down01: number | null,
): { up: number | null; down: number | null } {
  const uOk = up01 != null && Number.isFinite(up01);
  const dOk = down01 != null && Number.isFinite(down01);
  if (!uOk && !dOk) return { up: null, down: null };

  // If only one side is available, infer the other as a complement for a binary view.
  if (uOk && !dOk) {
    const u = Math.max(0, Math.min(1, up01!));
    return { up: u, down: 1 - u };
  }
  if (!uOk && dOk) {
    const d = Math.max(0, Math.min(1, down01!));
    return { up: 1 - d, down: d };
  }

  const s = up01! + down01!;
  if (!Number.isFinite(s) || s <= 1e-9) return { up: null, down: null };
  const u = Math.max(0, Math.min(1, up01! / s));
  return { up: u, down: 1 - u };
}

function ConfirmedDistanceBox(props: {
  kind: 'above' | 'below';
  band: NowPriceBandDistances;
  glance: ConfirmedEdgeGlance;
}): ReactElement {
  const isAbove = props.kind === 'above';
  const { band, glance } = props;
  const level = isAbove ? band.bandHi : band.bandLo;
  const bandFromPtb = isAbove ? band.distAboveFromPtb : band.distBelowFromPtb;

  return (
    <div
      className={`flex min-w-[10rem] flex-1 flex-col rounded-xl border px-3 py-3 ${
        isAbove
          ? 'border-emerald-800/50 bg-emerald-950/20 text-emerald-50'
          : 'border-rose-800/50 bg-rose-950/20 text-rose-50'
      }`}
    >
      <div className="text-[10px] font-semibold leading-snug text-zinc-300/90">
        {isAbove ? 'UP wins if spot stays above this line' : 'DOWN wins if spot stays below this line'}
      </div>
      <div className="mt-2 font-mono text-2xl font-bold tabular-nums tracking-tight sm:text-[1.65rem]">
        {fmtUsd(level)}
      </div>
      <div className="mt-0.5 text-[10px] text-zinc-500">
        Chop band edge · {fmtUsd(bandFromPtb)} {isAbove ? 'above' : 'below'} PTB ({fmtUsd(band.ptb)})
      </div>
      <div className="mt-3 border-t border-white/10 pt-3">
        <div className="text-[9px] font-bold uppercase tracking-[0.12em] text-zinc-500">Right now</div>
        <div
          className={`mt-1 text-base font-bold leading-tight sm:text-lg ${
            glance.cleared ? (isAbove ? 'text-emerald-300' : 'text-rose-300') : 'text-amber-200'
          }`}
        >
          {glance.cleared ? '✓ ' : '○ '}
          {glance.primary}
        </div>
        <div className="mt-0.5 text-[11px] leading-snug text-zinc-400">{glance.secondary}</div>
      </div>
    </div>
  );
}

function NowWindowSummary(props: { band: NowPriceBandDistances; glance: ReturnType<typeof buildSpotBandGlance> }): ReactElement {
  const { band, glance } = props;
  const tone =
    band.geo === 'ABOVE' ? 'text-emerald-300' : band.geo === 'BELOW' ? 'text-rose-300' : 'text-amber-200';
  const border =
    band.geo === 'ABOVE'
      ? 'border-emerald-800/45 bg-emerald-950/15'
      : band.geo === 'BELOW'
        ? 'border-rose-800/45 bg-rose-950/15'
        : 'border-amber-800/45 bg-amber-950/15';

  return (
    <div className={`flex min-w-[10rem] flex-1 flex-col rounded-xl border px-3 py-3 ${border}`}>
      <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-500">Where spot is</div>
      <div className={`mt-1 text-lg font-bold leading-tight sm:text-xl ${tone}`}>{glance.headline}</div>
      <p className="mt-1 text-[11px] leading-snug text-zinc-400">{glance.subline}</p>
      <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
        <div className="flex items-start justify-between gap-2 text-[11px]">
          <span className="font-semibold text-emerald-300/90">UP line</span>
          <span className="text-right leading-snug text-zinc-200">
            {glance.upBreak.cleared ? (
              <span className="font-semibold text-emerald-300">✓ {glance.upBreak.primary}</span>
            ) : (
              <span className="text-amber-200">○ {glance.upBreak.primary}</span>
            )}
          </span>
        </div>
        <div className="flex items-start justify-between gap-2 text-[11px]">
          <span className="font-semibold text-rose-300/90">DOWN line</span>
          <span className="text-right leading-snug text-zinc-200">
            {glance.downBreak.cleared ? (
              <span className="font-semibold text-rose-300">✓ {glance.downBreak.primary}</span>
            ) : (
              <span className="text-amber-200">○ {glance.downBreak.primary}</span>
            )}
          </span>
        </div>
      </div>
      <div className="mt-2 font-mono text-[10px] tabular-nums text-zinc-500">
        Now {fmtUsd(band.now)} · PTB {fmtUsd(band.ptb)}
      </div>
    </div>
  );
}

function fmtProgressPct(pct: number | null, cleared: boolean): string {
  if (pct == null || !Number.isFinite(pct)) return '—';
  if (cleared && pct >= 100) return `${Math.round(pct)}% past`;
  return `${Math.round(Math.max(0, pct))}%`;
}

function fmtBandMultiple(n: number | null, cleared: boolean): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (cleared) return `${Math.abs(n).toFixed(1)}× band past`;
  return `${Math.max(0, n).toFixed(2)}× band`;
}

function ProjectionSideRow(props: {
  direction: 'above' | 'below';
  remainingUsd: number;
  pct: number | null;
  inBands: number | null;
}): ReactElement {
  const isAbove = props.direction === 'above';
  const cleared = props.remainingUsd <= 0.005;
  const tone = isAbove ? 'text-emerald-300' : 'text-rose-300';
  const bandNote = fmtBandMultiple(props.inBands, cleared);
  const pctNote = fmtProgressPct(props.pct, cleared);

  return (
    <div className={`rounded-md border border-white/5 bg-black/20 px-2 py-1.5 ${tone}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-black uppercase tracking-wide opacity-90">
          {isAbove ? 'Above side' : 'Below side'}
        </span>
        <span className="font-mono text-[10px] font-semibold tabular-nums text-zinc-300">
          {bandNote ? `${bandNote} · ` : ''}{pctNote}
        </span>
      </div>
      <div className="mt-0.5 font-mono text-[12px] font-bold tabular-nums text-zinc-100">
        {isAbove ? '↑' : '↓'} {fmtDistClear(props.remainingUsd, props.direction)}
      </div>
    </div>
  );
}

function NowWindowCell(props: { cell: ProjectionNowCell }): ReactElement {
  const { cell } = props;
  const zoneCls =
    cell.zone === 'above'
      ? 'border-emerald-700/45 bg-emerald-950/25 text-emerald-100'
      : cell.zone === 'below'
        ? 'border-rose-700/45 bg-rose-950/25 text-rose-100'
        : 'border-amber-700/45 bg-amber-950/25 text-amber-100';

  return (
    <div
      className={`flex min-w-[8.75rem] shrink-0 flex-col gap-1.5 rounded-xl border px-2.5 py-2 sm:min-w-[9.25rem] ${zoneCls}`}
      title={`${cell.label}: ${fmtUsd(cell.price)} (${fmtUsdSigned(cell.deltaUsd)} vs now)`}
    >
      <span className="text-[10px] font-black uppercase tracking-wide opacity-85">{cell.label}</span>
      <span className="font-mono text-sm font-bold tabular-nums sm:text-base">{fmtUsd(cell.price)}</span>
      <span className="font-mono text-xs font-semibold tabular-nums opacity-90">{fmtUsdSigned(cell.deltaUsd)}</span>
      <ProjectionSideRow
        direction="above"
        remainingUsd={cell.toConfirmedAbove}
        pct={cell.pctTowardAbove}
        inBands={cell.aboveInBands}
      />
      <ProjectionSideRow
        direction="below"
        remainingUsd={cell.toConfirmedBelow}
        pct={cell.pctTowardBelow}
        inBands={cell.belowInBands}
      />
    </div>
  );
}

function PtbLadderBar(props: { band: NowPriceBandDistances }): ReactElement {
  const { band } = props;
  const span = Math.max(band.bandHi - band.bandLo, 1);
  const pct = (v: number) => `${Math.min(100, Math.max(0, ((v - band.bandLo) / span) * 100))}%`;
  const nowPct = pct(band.now);
  const ptbPct = pct(band.ptb);

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-black/30 px-3 py-3">
      <div className="text-[9px] font-bold uppercase tracking-[0.14em] text-zinc-500">PTB ladder</div>
      <div className="relative mt-3 h-3 rounded-full bg-gradient-to-r from-rose-900/70 via-amber-900/50 to-emerald-900/70">
        <div
          className="absolute top-1/2 h-4 w-0.5 -translate-y-1/2 bg-amber-300/90"
          style={{ left: ptbPct }}
          title={`PTB ${fmtUsd(band.ptb)}`}
        />
        <div
          className="absolute top-1/2 h-5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-zinc-50 shadow shadow-black/40"
          style={{ left: nowPct }}
          title={`Now ${fmtUsd(band.now)}`}
        />
      </div>
      <div className="mt-2 flex justify-between font-mono text-[9px] tabular-nums text-zinc-500">
        <span className="text-rose-300/90">{fmtUsd(band.bandLo)}</span>
        <span className="text-amber-200/90">PTB {fmtUsd(band.ptb)}</span>
        <span className="text-emerald-300/90">{fmtUsd(band.bandHi)}</span>
      </div>
    </div>
  );
}

function alignmentTone(a: SpeedAlignment): 'up' | 'down' | 'flat' | 'warn' {
  if (a === 'TREND_GRIND') return 'up';
  if (a === 'CONVERGING') return 'warn';
  if (a === 'CHOP') return 'down';
  return 'flat';
}

function supportTone(s: LaneSupport): 'up' | 'down' | 'flat' {
  if (s === 'TAILWIND') return 'up';
  if (s === 'HEADWIND') return 'down';
  return 'flat';
}

function OutcomeLaneColumn(props: { lane: OutcomeLaneSpeed; accent: 'emerald' | 'rose' }): ReactElement {
  const { lane, accent } = props;
  const alignTone = alignmentTone(lane.alignment);
  const border = accent === 'emerald' ? 'border-emerald-800/50' : 'border-rose-800/50';
  const head = accent === 'emerald' ? 'text-emerald-300' : 'text-rose-300';

  return (
    <div className={`rounded-xl border ${border} bg-black/25 px-3 py-2.5`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className={`text-[10px] font-black uppercase tracking-[0.14em] ${head}`}>{lane.label} speed</div>
        <span className="font-mono text-[9px] tabular-nums text-zinc-500">score {lane.supportScore >= 0 ? '+' : ''}{lane.supportScore}</span>
      </div>

      {lane.prob ? (
        <div className="mt-2 rounded-lg border border-zinc-800/50 bg-zinc-950/40 px-2 py-1.5">
          <div className="text-[9px] font-semibold text-zinc-400">{lane.prob.label}</div>
          <div className="font-mono text-xl font-bold tabular-nums text-zinc-50">
            {speedDirectionArrow(lane.prob.direction)} {formatProbSpeedPpMin(lane.prob.velocityPerMin)}
          </div>
          <div className="text-[9px] text-zinc-500">
            Δ30 {lane.prob.delta30 >= 0 ? '+' : ''}{(lane.prob.delta30 * 100).toFixed(2)}pp · {lane.prob.interpretation}
          </div>
        </div>
      ) : (
        <div className="mt-2 text-[10px] text-zinc-600">Waiting for {lane.label} mid history…</div>
      )}

      <div className="mt-2 space-y-1 text-[10px] leading-snug">
        <div className="flex gap-2">
          <span className={`shrink-0 font-semibold uppercase ${supportTone(lane.spotSupport) === 'up' ? 'text-emerald-400' : supportTone(lane.spotSupport) === 'down' ? 'text-rose-400' : 'text-zinc-500'}`}>
            spot {laneSupportLabel(lane.spotSupport)}
          </span>
          <span className="text-zinc-500">{lane.spotNote}</span>
        </div>
        <div className="flex gap-2">
          <span className={`shrink-0 font-semibold uppercase ${supportTone(lane.ptbSupport) === 'up' ? 'text-emerald-400' : supportTone(lane.ptbSupport) === 'down' ? 'text-rose-400' : 'text-zinc-500'}`}>
            ptb {laneSupportLabel(lane.ptbSupport)}
          </span>
          <span className="text-zinc-500">{lane.ptbNote}</span>
        </div>
      </div>

      <div
        className={`mt-2 rounded-lg border px-2 py-1.5 ${
          alignTone === 'up'
            ? 'border-emerald-700/35 bg-emerald-950/15'
            : alignTone === 'down'
              ? 'border-rose-700/35 bg-rose-950/15'
              : alignTone === 'warn'
                ? 'border-amber-700/35 bg-amber-950/15'
                : 'border-zinc-700/40 bg-black/20'
        }`}
      >
        <div className="font-mono text-[11px] font-bold text-zinc-100">{lane.alignment.replace('_', ' ')}</div>
        <div className="text-[9px] font-semibold text-orange-200/80">{lane.mode.replace('_', ' ')}</div>
        <p className="mt-0.5 text-[9px] leading-snug text-zinc-500">{lane.alignmentNote}</p>
      </div>
    </div>
  );
}

function directionScoreTone(v: DirectionScoreSnapshot['verdict']): GlanceTone {
  if (v === 'STRONG_UP' || v === 'UP') return 'up';
  if (v === 'STRONG_DOWN' || v === 'DOWN') return 'down';
  if (v === 'WEAK_UP' || v === 'WEAK_DOWN') return 'warn';
  return 'flat';
}

function ScoreMetricValues(props: { detail: string; gainPct: string | null; active?: boolean }): ReactElement {
  const { detail, gainPct, active = false } = props;
  return (
    <div className="min-w-0 text-right">
      <div className="font-mono text-[10px] tabular-nums text-zinc-400">{detail}</div>
      {gainPct ? (
        <div className={`font-mono text-[9px] tabular-nums leading-tight ${active ? 'text-emerald-400/95' : 'text-zinc-500'}`}>
          {gainPct}
        </div>
      ) : null}
    </div>
  );
}

function pressureVerdictTone(
  v: PressureVerdict,
  kind: 'BUY' | 'SELL',
  timing?: PressureBuildupSnapshot['timing'],
): GlanceTone {
  if (timing === 'CHASING' || timing === 'EXTENDED') return 'warn';
  if (v === 'NO_TRADE') return 'flat';
  if (v === 'WATCH') return 'warn';
  if (kind === 'BUY') return 'up';
  return 'down';
}

function DirectionEngineCard(props: { signal: DirectionEngineSignal }): ReactElement {
  const { signal } = props;
  const tone: GlanceTone =
    signal.verdict === 'ENTER_UP' ? 'up' : signal.verdict === 'ENTER_DOWN' ? 'down' : 'flat';
  const shell =
    tone === 'up'
      ? 'border-emerald-600/55 bg-emerald-950/35 ring-1 ring-emerald-500/20'
      : tone === 'down'
        ? 'border-rose-600/55 bg-rose-950/35 ring-1 ring-rose-500/20'
        : 'border-zinc-700/55 bg-zinc-950/40 ring-1 ring-zinc-600/15';
  const confCls =
    signal.confidencePct >= 85
      ? 'text-emerald-300'
      : signal.confidencePct >= 70
        ? 'text-cyan-200'
        : signal.confidencePct >= 55
          ? 'text-amber-200'
          : 'text-zinc-500';
  const conflictCls =
    signal.conflictTone === 'high'
      ? 'text-rose-300'
      : signal.conflictTone === 'mid'
        ? 'text-amber-200'
        : 'text-emerald-300/90';

  return (
    <div className={`rounded-xl border px-3 py-3 sm:px-4 ${shell}`}>
      <div className="text-[9px] font-black uppercase tracking-[0.14em] text-indigo-300/85">Direction engine</div>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xl" aria-hidden>
              {signal.emoji}
            </span>
            <span className="text-xl font-black tracking-tight text-zinc-50 sm:text-2xl">{signal.headline}</span>
          </div>
          {signal.hardRule ? (
            <p className="mt-1 text-[10px] font-semibold text-amber-200/90">Hard rule — tier-1 stack overrides sensor noise</p>
          ) : null}
        </div>
        <div className="text-right font-mono tabular-nums">
          <div className={`text-lg font-black ${confCls}`}>Confidence: {signal.confidencePct}%</div>
          <div className={`text-[11px] font-semibold ${conflictCls}`}>
            {signal.conflictEmoji} Conflict: {signal.conflictPct}%
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-zinc-800/50 bg-black/25 px-2 py-1.5">
          <div className="text-[8px] font-bold uppercase tracking-wide text-zinc-500">Edge</div>
          <div className="font-mono text-sm font-bold text-zinc-100">{signal.edgeCents ?? '—'}</div>
        </div>
        <div className="rounded-lg border border-zinc-800/50 bg-black/25 px-2 py-1.5">
          <div className="text-[8px] font-bold uppercase tracking-wide text-zinc-500">Momentum</div>
          <div className="font-mono text-sm font-bold text-zinc-100">{signal.momentumLabel}</div>
        </div>
        <div className="rounded-lg border border-zinc-800/50 bg-black/25 px-2 py-1.5">
          <div className="text-[8px] font-bold uppercase tracking-wide text-zinc-500">PTB</div>
          <div className="font-mono text-sm font-bold text-zinc-100">{signal.ptbLabel}</div>
        </div>
        <div className="col-span-2 rounded-lg border border-zinc-800/50 bg-black/25 px-2 py-1.5 sm:col-span-3">
          <div className="text-[8px] font-bold uppercase tracking-wide text-zinc-500">Repricing</div>
          <div className="font-mono text-sm font-bold text-zinc-100">{signal.repricingLabel}</div>
        </div>
      </div>

      <ul className="mt-3 space-y-0.5">
        {signal.reasons.map((line) => (
          <li key={line} className="text-[11px] leading-snug text-zinc-300">
            {line}
          </li>
        ))}
      </ul>

      <details className="mt-3 rounded-lg border border-zinc-800/45 bg-black/20 px-2.5 py-2">
        <summary className="cursor-pointer text-[9px] font-semibold text-zinc-500 hover:text-zinc-300">
          Tier breakdown
        </summary>
        <div className="mt-2 space-y-2">
          <div>
            <div className="text-[8px] font-black uppercase tracking-wide text-cyan-400/80">Tier 1 — decides trade</div>
            <ul className="mt-1 space-y-0.5">
              {signal.tier1.map((s) => (
                <li key={s.id} className="flex justify-between gap-2 text-[10px] text-zinc-400">
                  <span>{s.label}</span>
                  <span className="font-mono text-zinc-300">{s.lane?.toUpperCase() ?? '—'}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-[8px] font-black uppercase tracking-wide text-violet-400/80">Tier 2 — confirmation</div>
            <ul className="mt-1 space-y-0.5">
              {signal.tier2.map((s) => (
                <li key={s.id} className="flex justify-between gap-2 text-[10px] text-zinc-400">
                  <span>{s.label}</span>
                  <span className="font-mono text-zinc-300">{s.lane?.toUpperCase() ?? '—'}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </div>
  );
}

function EntrySideGateColumn(props: { row: ExecutionSignal['entry']['up']; minProb: number; minEdge: number }): ReactElement {
  const { row, minProb, minEdge } = props;
  const mark = (ok: boolean) => (ok ? '✓' : '❌');
  const tone = row.side === 'up' ? 'text-emerald-300/90' : 'text-rose-300/90';
  return (
    <div className="rounded-lg border border-zinc-800/50 bg-black/20 px-2.5 py-2">
      <div className={`text-[10px] font-black uppercase tracking-wide ${tone}`}>{row.sideLabel}</div>
      <ul className="mt-1.5 space-y-1 font-mono text-[9px] tabular-nums text-zinc-400">
        <li>
          P {row.probPct != null ? `${row.probPct.toFixed(0)}%` : '—'} {mark(row.probOk)}
          {!row.probOk ? <span className="text-zinc-600"> (need {minProb}%)</span> : null}
        </li>
        <li>
          Edge {row.edgePp != null ? `${row.edgePp >= 0 ? '+' : ''}${row.edgePp.toFixed(0)}pp` : '—'} {mark(row.edgeOk)}
          {!row.edgeOk ? <span className="text-zinc-600"> (need +{minEdge}pp)</span> : null}
        </li>
        <li>
          Mom {mark(row.momentumOk)}{' '}
          <span className="text-zinc-600">{row.momentumOk ? 'ok' : row.momentumNote.replace(/^Need /, '')}</span>
        </li>
      </ul>
    </div>
  );
}

function ExecutionSignalCard(props: { signal: ExecutionSignal }): ReactElement {
  const { signal } = props;
  const showExecution = signal.phase === 'ENTER';
  const showConfirming = signal.phase === 'ALERT';
  const biasTone: GlanceTone =
    signal.bias.direction === 'up' ? 'up' : signal.bias.direction === 'down' ? 'down' : 'flat';
  const execTone: GlanceTone =
    signal.verdict === 'ENTER_UP' ? 'up' : signal.verdict === 'ENTER_DOWN' ? 'down' : 'flat';
  const shell =
    showExecution
      ? execTone === 'up'
        ? 'border-emerald-600/55 bg-emerald-950/35 ring-1 ring-emerald-500/20'
        : 'border-rose-600/55 bg-rose-950/35 ring-1 ring-rose-500/20'
      : showConfirming
        ? 'border-amber-700/55 bg-amber-950/30 ring-1 ring-amber-500/15'
        : 'border-zinc-700/55 bg-zinc-950/40 ring-1 ring-zinc-600/15';

  const holdPct = Math.min(100, Math.round((signal.confirmHeldMs / signal.confirmRequiredMs) * 100));

  return (
    <div className={`rounded-xl border px-3 py-3 sm:px-4 ${shell}`}>
      <div className="text-[9px] font-black uppercase tracking-[0.14em] text-cyan-300/85">Execution desk v2</div>

      {/* Layer 1 — Bias (always) */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800/45 bg-black/25 px-2.5 py-2">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-bold uppercase tracking-wide text-zinc-500">Bias</span>
          <span className="text-lg" aria-hidden>{signal.bias.emoji}</span>
          <span
            className={`text-sm font-black tracking-tight ${
              biasTone === 'up' ? 'text-emerald-200' : biasTone === 'down' ? 'text-rose-200' : 'text-zinc-300'
            }`}
          >
            {signal.bias.headline}
          </span>
        </div>
        <span className="max-w-[52%] text-right text-[9px] text-zinc-500">{signal.bias.detail}</span>
      </div>

      {/* Layer 2 — Entry eligibility (both sides always) */}
      <div className="mt-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[9px] font-bold uppercase tracking-wide text-zinc-500">Entry status</span>
          <span
            className={`text-[10px] font-black uppercase tracking-wide ${
              signal.entry.status === 'READY'
                ? 'text-emerald-300'
                : signal.entry.status === 'CONFIRMING'
                  ? 'text-amber-300'
                  : 'text-zinc-400'
            }`}
          >
            {signal.entry.statusLabel}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <EntrySideGateColumn row={signal.entry.up} minProb={EXEC_MIN_MODEL_PROB * 100} minEdge={EXEC_MIN_EDGE_PP} />
          <EntrySideGateColumn row={signal.entry.down} minProb={EXEC_MIN_MODEL_PROB * 100} minEdge={EXEC_MIN_EDGE_PP} />
        </div>
        <p className="mt-2 text-[10px] leading-snug text-zinc-500">{signal.entry.footer}</p>
      </div>

      {/* Layer 3 — Execution (only when ENTER) */}
      {showExecution ? (
        <div className="mt-3 rounded-lg border border-emerald-800/40 bg-emerald-950/20 px-2.5 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xl" aria-hidden>{signal.emoji}</span>
            <span className="text-lg font-black tracking-tight text-zinc-50">{signal.headline}</span>
          </div>
          <p className="mt-1 text-[10px] text-zinc-400">{signal.summaryLine}</p>
          <div className="mt-2 font-mono text-[11px] tabular-nums text-zinc-300">
            {signal.regimePlan.tp1Cents != null ? (
              <>TP1 +{signal.regimePlan.tp1Cents.toFixed(1)}¢{signal.dynamicTp.tp2Range ? ` · TP2 ${signal.dynamicTp.tp2Range}` : ''}</>
            ) : (
              <>TP {signal.dynamicTp.minCents.toFixed(1)}–{signal.dynamicTp.maxCents.toFixed(1)}¢</>
            )}
            <span className="text-zinc-500"> · {signal.dynamicTp.regime.replace('_', ' ')} · stop {signal.dynamicTp.timeStopSec}s</span>
          </div>
          {signal.regimePlan.trailing ? (
            <p className="mt-1.5 text-[9px] text-zinc-500">
              Trail: lock +{signal.regimePlan.trailing.lockProfitCents}¢ after +{signal.regimePlan.trailing.activateAtCents}¢
            </p>
          ) : null}
          {signal.regimePlan.exitNotes.length ? (
            <ul className="mt-1 space-y-0.5">
              {signal.regimePlan.exitNotes.map((note) => (
                <li key={note} className="text-[9px] text-zinc-500">· {note}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {showConfirming ? (
        <div className="mt-3 rounded-lg border border-amber-800/40 bg-amber-950/15 px-2.5 py-2">
          <div className="flex items-center gap-2">
            <span className="text-xl" aria-hidden>{signal.emoji}</span>
            <span className="text-sm font-bold text-amber-100">{signal.headline}</span>
          </div>
          <div className="mt-2">
            <div className="mb-1 flex justify-between text-[9px] font-semibold text-zinc-500">
              <span>Confirmation hold</span>
              <span>
                {Math.round(signal.confirmHeldMs / 1000)}s / {Math.round(signal.confirmRequiredMs / 1000)}s
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800/70">
              <div className="h-full rounded-full bg-amber-500/80 transition-all" style={{ width: `${holdPct}%` }} />
            </div>
          </div>
          <ul className="mt-2 space-y-1">
            {signal.gates.map((g) => (
              <li key={g.id} className="flex justify-between gap-2 text-[9px]">
                <span className={g.pass ? 'text-emerald-300/90' : 'text-zinc-500'}>
                  {g.pass ? '✓' : '○'} {g.label}
                </span>
                <span className="max-w-[55%] text-right font-mono text-zinc-500">{g.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ContractLeadCard(props: {
  lead: ContractLeadSignal;
  tone: 'up' | 'down' | 'warn' | 'flat';
}): ReactElement {
  const { lead, tone } = props;
  const phase = lead.phase;
  const shell =
    phase === 'SKIP'
      ? 'border-amber-700/55 bg-amber-950/30 ring-1 ring-amber-500/15'
      : phase === 'ENTER'
        ? tone === 'up'
          ? 'border-emerald-600/50 bg-emerald-950/35 ring-1 ring-emerald-500/20'
          : tone === 'down'
            ? 'border-rose-600/50 bg-rose-950/35 ring-1 ring-rose-500/20'
            : 'border-cyan-700/45 bg-cyan-950/25 ring-1 ring-cyan-500/15'
        : 'border-violet-700/40 bg-violet-950/22 ring-1 ring-violet-500/10';
  const labelColor =
    phase === 'SKIP' ? 'text-amber-400/95' : phase === 'ENTER' ? 'text-cyan-300/90' : 'text-violet-300/85';
  const titleColor =
    phase === 'SKIP' ? 'text-amber-100' : phase === 'ENTER' ? 'text-zinc-50' : 'text-violet-100/95';

  return (
    <div className={`mt-3 rounded-xl border px-3 py-2.5 ${shell}`}>
      <div className={`text-[9px] font-black uppercase tracking-[0.12em] ${labelColor}`}>
        {phase === 'ENTER' ? `${lead.earlyHorizonSec}s contract lead` : phase === 'SKIP' ? 'Late — skip entry' : 'Building'}
      </div>
      <p className={`mt-1 text-[13px] font-bold leading-snug ${titleColor}`}>{lead.title}</p>
      <p className="mt-1 font-mono text-[11px] tabular-nums leading-snug text-zinc-300">{lead.actionLine}</p>
      <p className="mt-1 text-[10px] leading-snug text-zinc-500">{lead.reasonLine}</p>
    </div>
  );
}

function PressureBuildupCard(props: {
  pressure: PressureBuildupSnapshot;
  upLabel: string;
  downLabel: string;
}): ReactElement {
  const { pressure, upLabel, downLabel } = props;
  const active = pressure.active;
  const tone = pressureVerdictTone(pressure.verdict, active.kind, pressure.timing);
  const shell =
    tone === 'up'
      ? 'border-emerald-700/50 bg-emerald-950/25 ring-1 ring-emerald-500/15'
      : tone === 'down'
        ? 'border-rose-700/50 bg-rose-950/25 ring-1 ring-rose-500/15'
        : tone === 'warn'
          ? 'border-amber-700/45 bg-amber-950/18 ring-1 ring-amber-500/12'
          : 'border-zinc-700/50 bg-zinc-950/30';
  const head =
    tone === 'up' ? 'text-emerald-200' : tone === 'down' ? 'text-rose-200' : tone === 'warn' ? 'text-amber-200' : 'text-zinc-300';

  return (
    <div className={`rounded-xl border px-3 py-3 sm:px-4 ${shell}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[9px] font-black uppercase tracking-[0.14em] text-violet-300/80">Pressure buildup</div>
          <div className={`mt-1 text-xl font-black tracking-tight sm:text-2xl ${head}`}>
            <span className="mr-1.5" aria-hidden>
              {pressure.emoji}
            </span>
            {pressure.headline}
          </div>
          <p className="mt-1 text-[10px] leading-snug text-zinc-500">{pressure.tagline}</p>
          {pressure.leadNote ? (
            <p className="mt-1 text-[10px] font-semibold leading-snug text-cyan-300/90">{pressure.leadNote}</p>
          ) : null}
          <p className="mt-1 font-mono text-[9px] tabular-nums leading-snug text-zinc-500">
            {pressure.earlyHorizonSec}s lead {pressure.scoreLine}
            {' · '}
            {pressure.confirmHorizonSec}s confirm {pressure.confirmActive.score}/{pressure.confirmActive.max}
            {pressure.timing !== 'EARLY' ? ` · ${pressure.timing}` : ''}
          </p>
          {pressure.gainSummary ? (
            <p className="mt-1 font-mono text-[9px] tabular-nums leading-snug text-violet-300/75">{pressure.gainSummary}</p>
          ) : null}
        </div>
        <div className="text-right">
          <div className="font-mono text-3xl font-black tabular-nums text-zinc-50">{pressure.scoreLine}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            {pressure.verdict.replace('_', ' ')}
            {pressure.timing === 'CHASING' ? ' · LATE' : ''}
          </div>
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-snug text-zinc-300">{active.interpretation}</p>

      {pressure.contractLead ? <ContractLeadCard lead={pressure.contractLead} tone={tone} /> : null}

      {pressure.spotJumpLine ? (
        <p className="mt-2 font-mono text-[10px] tabular-nums leading-snug text-zinc-500">{pressure.spotJumpLine}</p>
      ) : null}

      <ul className="mt-2 space-y-0.5">
        {active.rows.map((row) => (
          <li
            key={row.id}
            className={`text-[11px] leading-snug ${row.point ? 'text-emerald-300/95' : 'text-zinc-600'}`}
          >
            {row.point ? '✓' : '○'} {row.hitLine}
          </li>
        ))}
      </ul>

      <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
        {active.rows.map((row) => (
          <div
            key={`grid-${row.id}`}
            className={`flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5 ${
              row.point ? 'border-violet-800/35 bg-black/20' : 'border-zinc-800/50 bg-black/10'
            }`}
          >
            <span className={`text-[10px] font-semibold ${row.point ? 'text-violet-200/90' : 'text-zinc-500'}`}>
              {row.point ? '+1' : '0'} {row.label}
            </span>
            <ScoreMetricValues detail={row.detail} gainPct={row.gainPct} active={row.point === 1} />
          </div>
        ))}
      </div>

      {pressure.mtfSummary ? (
        <p className="mt-2 text-[10px] leading-snug text-zinc-500">MTF: {pressure.mtfSummary}</p>
      ) : null}

      <details className="mt-2">
        <summary className="cursor-pointer text-[10px] font-semibold text-zinc-500 hover:text-zinc-300">
          {active.kind === 'BUY' ? 'Sell' : 'Buy'} pressure · opposite side
        </summary>
        <div className="mt-2 rounded-lg border border-zinc-800/50 bg-black/15 px-2.5 py-2">
          <div className="text-[9px] font-bold uppercase text-zinc-500">
            {pressure.buy.kind === 'BUY' ? 'Buy' : 'Sell'} {pressure.buy.score}/{pressure.buy.max} ·{' '}
            {pressure.sell.kind === 'SELL' ? 'Sell' : 'Buy'} {pressure.sell.score}/{pressure.sell.max}
          </div>
          <ul className="mt-1.5 space-y-0.5 text-[10px] text-zinc-500">
            {(active.kind === 'BUY' ? pressure.sell : pressure.buy).rows.map((row) => (
              <li key={`opp-${row.id}`}>
                {row.point ? '✓' : '○'} {row.hitLine}
              </li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}

function DirectionScoreCard(props: {
  score: DirectionScoreSnapshot;
  upLabel: string;
  downLabel: string;
}): ReactElement {
  const { score, upLabel, downLabel } = props;
  const tone = directionScoreTone(score.verdict);
  const shell =
    tone === 'up'
      ? 'border-emerald-700/45 bg-emerald-950/20'
      : tone === 'down'
        ? 'border-rose-700/45 bg-rose-950/20'
        : tone === 'warn'
          ? 'border-amber-700/40 bg-amber-950/15'
          : 'border-zinc-700/50 bg-zinc-950/30';
  const head =
    tone === 'up' ? 'text-emerald-200' : tone === 'down' ? 'text-rose-200' : tone === 'warn' ? 'text-amber-200' : 'text-zinc-300';

  return (
    <div className={`rounded-xl border px-3 py-3 sm:px-4 ${shell}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[9px] font-black uppercase tracking-[0.14em] text-zinc-500">Direction score · {score.horizonSec}s</div>
          <div className={`mt-1 text-2xl font-black tracking-tight sm:text-3xl ${head}`}>
            <span className="mr-1.5" aria-hidden>
              {score.emoji}
            </span>
            {score.headline}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-3xl font-black tabular-nums text-zinc-50">{score.scoreLine}</div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Bias {score.bias}</div>
        </div>
      </div>

      <ul className="mt-2 space-y-0.5 text-[11px] leading-snug text-zinc-300">
        {score.activeBullets.map((line) => (
          <li key={line}>· {line}</li>
        ))}
        {score.activeBullets.length === 0 ? (
          <li className="text-zinc-500">No aligned speed signals — wait for clearer repricing.</li>
        ) : null}
      </ul>

      <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
        {score.activeRows.map((row) => (
          <div
            key={row.id}
            className={`flex items-center justify-between gap-2 rounded-lg border px-2 py-1.5 ${
              row.point ? 'border-emerald-800/35 bg-black/20' : 'border-zinc-800/50 bg-black/10'
            }`}
          >
            <span className={`text-[10px] font-semibold ${row.point ? 'text-emerald-300/90' : 'text-zinc-500'}`}>
              {row.point ? '+1' : '0'} {row.label}
            </span>
            <ScoreMetricValues detail={row.detail} gainPct={row.gainPct} active={row.point === 1} />
          </div>
        ))}
      </div>

      <details className="mt-2">
        <summary className="cursor-pointer text-[10px] font-semibold text-zinc-500 hover:text-zinc-300">Opposite side · full breakdown</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-emerald-900/30 bg-black/15 px-2 py-2">
            <div className="text-[9px] font-bold uppercase text-emerald-400/80">{upLabel} score</div>
            <div className="font-mono text-lg font-bold text-zinc-100">
              {score.up.score}/{score.up.max}
            </div>
          </div>
          <div className="rounded-lg border border-rose-900/30 bg-black/15 px-2 py-2">
            <div className="text-[9px] font-bold uppercase text-rose-400/80">{downLabel} score</div>
            <div className="font-mono text-lg font-bold text-zinc-100">
              {score.down.score}/{score.down.max}
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}

function DeskSpeedLayersCard(props: { speed: DeskSpeedSnapshot; embedded?: boolean }): ReactElement {
  const { speed, embedded = false } = props;
  const spot = speed.spot;
  const ptb = speed.ptbGap;

  return (
    <div
      className={
        embedded
          ? 'min-w-0'
          : 'rounded-xl border border-orange-800/40 bg-orange-950/12 px-3 py-3 sm:px-4'
      }
    >
      {!embedded ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[9px] font-black uppercase tracking-[0.14em] text-orange-300/90">
              Speed layers · {speed.horizonSec}s · UP / DOWN split
            </div>
            <p className="mt-1 max-w-3xl text-[10px] leading-snug text-zinc-500">
              Shared spot + PTB gap velocity; separate <span className="text-zinc-400">v_prob</span> and alignment per
              outcome. Tailwind = speed supports that side; headwind = fights it.
            </p>
          </div>
        </div>
      ) : null}

      <div className={`grid gap-2 sm:grid-cols-2 ${embedded ? '' : 'mt-3'}`}>
        {spot ? (
          <div className="rounded-lg border border-orange-800/40 bg-black/25 px-2.5 py-2">
            <div className="text-[10px] font-semibold text-zinc-200">Shared · {spot.label}</div>
            <div className="font-mono text-lg font-bold tabular-nums text-orange-100">
              {speedDirectionArrow(spot.direction)} {formatSpotSpeedPerMin(spot.velocityPerMin)}
            </div>
            <div className="text-[9px] text-zinc-500">{spot.interpretation} · Δ30 {fmtUsdSigned(spot.delta30)}</div>
          </div>
        ) : null}
        {ptb ? (
          <div className="rounded-lg border border-amber-800/35 bg-black/25 px-2.5 py-2">
            <div className="text-[10px] font-semibold text-zinc-200">Shared · {ptb.label}</div>
            <div className="font-mono text-lg font-bold tabular-nums text-amber-100">
              {speedDirectionArrow(ptb.direction)} {formatSpotSpeedPerMin(ptb.velocityPerMin)}
              {ptb.ptbGapMotion ? (
                <span className="ml-2 text-sm font-semibold text-amber-200/90">{ptb.ptbGapMotion.replace('_', ' ')}</span>
              ) : null}
            </div>
            <div className="text-[9px] text-zinc-500">
              {ptb.interpretation}
              {speed.gapClosurePctPerMin != null
                ? ` · gap closing ${speed.gapClosurePctPerMin.toFixed(1)}%/min`
                : ''}
            </div>
          </div>
        ) : null}
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        <OutcomeLaneColumn lane={speed.lanes.up} accent="emerald" />
        <OutcomeLaneColumn lane={speed.lanes.down} accent="rose" />
      </div>
    </div>
  );
}

function fmtEdgePp(edge: number): string {
  const pp = edge * 100;
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}

function tradeTone(side: string): 'up' | 'down' | 'flat' | 'warn' {
  if (side === 'LONG_UP') return 'up';
  if (side === 'LONG_DOWN') return 'down';
  return 'flat';
}

function SiglaChips(props: { siglas: string[] }): ReactElement {
  return (
    <div className="flex flex-wrap gap-1">
      {props.siglas.map((s) => {
        const up = s.includes('↑') || s === 'EDGE+' || s === 'REP+' || s === 'MOM✓' || s.includes('TR');
        const down = s.includes('↓') || s === 'EDGE−' || s === 'REP−' || s === 'MOM✗' || s.includes('MR');
        const hold = s.includes('—') || s === 'EDGE≈0' || s === 'PTB≈' || s === 'SIG—' || s === 'FIL—';
        const cls = up
          ? 'border-emerald-700/50 bg-emerald-950/40 text-emerald-200'
          : down
            ? 'border-rose-700/50 bg-rose-950/40 text-rose-200'
            : hold
              ? 'border-zinc-700/50 bg-zinc-900/50 text-zinc-400'
              : 'border-amber-700/50 bg-amber-950/30 text-amber-200';
        return (
          <span
            key={s}
            className={`rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wide ${cls}`}
            title={s}
          >
            {s}
          </span>
        );
      })}
    </div>
  );
}

function ProbabilityEdgeScalpCard(props: {
  scalp: ProbabilityEdgeScalp;
  upLabel: string;
  downLabel: string;
  embedded?: boolean;
}): ReactElement {
  const { scalp, upLabel, downLabel, embedded = false } = props;
  const sigTone = tradeTone(scalp.scalpSignal);
  const qualityCls =
    scalp.quality === 'HIGH'
      ? 'text-emerald-300'
      : scalp.quality === 'MEDIUM'
        ? 'text-amber-200'
        : scalp.quality === 'LOW'
          ? 'text-zinc-400'
          : 'text-zinc-600';

  return (
    <div className={embedded ? 'min-w-0' : 'rounded-xl border border-cyan-800/45 bg-cyan-950/15 px-3 py-3 sm:px-4'}>
      {!embedded ? (
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[9px] font-black uppercase tracking-[0.14em] text-cyan-300/90">
              Probability edge · scalp arb
            </div>
            <p className="mt-1 max-w-3xl text-[10px] leading-snug text-zinc-500">
              Trade mispricing, not direction: <span className="font-mono text-zinc-400">Edge = P_model − P_mkt</span>.
              Raw edge uses ±{(EDGE_TRADE_THRESHOLD * 100).toFixed(0)}% threshold; final{' '}
              <span className="font-mono text-zinc-400">SIG</span> adds momentum, PTB stretch, score θ, and repricing
              (catch probability lag, not reversal).
            </p>
            <div className="mt-2">
              <SiglaChips siglas={scalp.siglas} />
            </div>
          </div>
          <div
            className={`rounded-xl border px-4 py-2 text-center ${
              sigTone === 'up'
                ? 'border-emerald-600/60 bg-emerald-950/40'
                : sigTone === 'down'
                  ? 'border-rose-600/60 bg-rose-950/40'
                  : 'border-zinc-700/50 bg-zinc-900/40'
            }`}
          >
            <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-zinc-500">Final SIG</div>
            <div className="text-lg font-black tracking-tight text-zinc-50">
              {scalp.scalpSignal === 'LONG_UP'
                ? `LONG ${upLabel}`
                : scalp.scalpSignal === 'LONG_DOWN'
                  ? `LONG ${downLabel}`
                  : 'NO TRADE'}
            </div>
            <div className={`text-[10px] font-semibold ${qualityCls}`}>Quality {scalp.quality}</div>
          </div>
        </div>
      ) : null}

      <div className={`grid gap-2 sm:grid-cols-3 ${embedded ? '' : 'mt-3'}`}>
        <div className="rounded-lg border border-zinc-700/50 bg-black/25 px-2.5 py-2">
          <div className="text-[9px] font-bold uppercase text-zinc-500">P_mkt (contract)</div>
          <div className="font-mono text-xl font-bold tabular-nums text-zinc-200">{fmtProbPct01(scalp.pMkt)}</div>
          <div className="text-[10px] text-zinc-500">{fmtCents(scalp.pMkt)} implied {upLabel}</div>
        </div>
        <div className="rounded-lg border border-violet-800/40 bg-violet-950/20 px-2.5 py-2">
          <div className="text-[9px] font-bold uppercase text-violet-300/80">P_model (desk)</div>
          <div className="font-mono text-xl font-bold tabular-nums text-violet-100">{fmtProbPct01(scalp.pModel)}</div>
          <div className="text-[10px] text-zinc-500">PTB + momentum + flow</div>
        </div>
        <div
          className={`rounded-lg border px-2.5 py-2 ${
            scalp.edge > EDGE_TRADE_THRESHOLD
              ? 'border-emerald-700/50 bg-emerald-950/25'
              : scalp.edge < -EDGE_TRADE_THRESHOLD
                ? 'border-rose-700/50 bg-rose-950/25'
                : 'border-zinc-700/50 bg-black/25'
          }`}
        >
          <div className="text-[9px] font-bold uppercase text-zinc-500">Edge</div>
          <div className="font-mono text-xl font-bold tabular-nums">{fmtEdgePp(scalp.edge)}</div>
          <div className="text-[10px] leading-snug text-zinc-500">
            {scalp.gapFromMeanPp != null
              ? `Mean-adj FV gap ${scalp.gapFromMeanPp >= 0 ? '+' : ''}${scalp.gapFromMeanPp.toFixed(1)}pp · `
              : ''}
            {scalp.edge > EDGE_TRADE_THRESHOLD
              ? 'UP underpriced → lean long'
              : scalp.edge < -EDGE_TRADE_THRESHOLD
                ? 'UP overpriced → fade / short'
                : 'Inside fee + noise band'}
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-800/50 bg-black/20 px-2.5 py-2">
          <div className="text-[10px] font-semibold text-zinc-300">Step 3 — Raw edge trade</div>
          <div className="mt-1 text-[11px] text-zinc-400">{scalp.edgeTradeLabel}</div>
        </div>
        <div className="rounded-lg border border-zinc-800/50 bg-black/20 px-2.5 py-2">
          <div className="text-[10px] font-semibold text-zinc-300">Step 4 — Momentum filter (m_norm)</div>
          <div className="mt-1 font-mono text-[11px] tabular-nums text-zinc-400">
            m_norm {scalp.mNorm != null ? scalp.mNorm.toFixed(2) : '—'} ·{' '}
            <span className={scalp.momentumOk ? 'text-emerald-300' : 'text-amber-300'}>
              {scalp.momentumOk ? 'PASS' : 'BLOCK'}
            </span>
          </div>
          <div className="mt-0.5 text-[10px] text-zinc-500">{scalp.momentumNote}</div>
        </div>
        <div className="rounded-lg border border-zinc-800/50 bg-black/20 px-2.5 py-2">
          <div className="text-[10px] font-semibold text-zinc-300">Step 5 — PTB stretch</div>
          <div className="mt-1 font-mono text-[11px] tabular-nums text-zinc-400">
            Δ_PTB {scalp.deltaPtb != null ? `${(scalp.deltaPtb * 100).toFixed(3)}%` : '—'}
          </div>
          <div className="mt-0.5 text-[10px] text-zinc-500">{scalp.ptbSetupNote}</div>
        </div>
        <div className="rounded-lg border border-zinc-800/50 bg-black/20 px-2.5 py-2">
          <div className="text-[10px] font-semibold text-zinc-300">Step 6 — Scalp score</div>
          <div className="mt-1 font-mono text-[11px] tabular-nums text-cyan-200/90">
            Score {scalp.scalpScore >= 0 ? '+' : ''}
            {scalp.scalpScore.toFixed(3)} (θ = ±{scalp.scalpTheta})
          </div>
          <div className="mt-0.5 text-[10px] text-zinc-500">
            w₁·Edge + w₂·m_norm + w₃·Δ_PTB →{' '}
            {scalp.scoreSignal === 'LONG_UP'
              ? `SCR↑ ${upLabel}`
              : scalp.scoreSignal === 'LONG_DOWN'
                ? `SCR↓ ${downLabel}`
                : 'SCR— hold'}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-lg border border-amber-800/35 bg-amber-950/10 px-2.5 py-2">
        <div className="text-[10px] font-semibold text-amber-200/90">Step 9 — Execution (repricing)</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
          <span className={scalp.repricingIntoEdge ? 'font-semibold text-emerald-300' : 'text-amber-300'}>
            {scalp.repricingIntoEdge ? 'REP+ moving into edge' : 'REP− not yet repricing'}
          </span>
          <span className="text-zinc-600">·</span>
          <span className="text-zinc-400">{scalp.repricingNote}</span>
        </div>
        <div className="mt-1 text-[10px] text-zinc-500">
          Filtered: {scalp.filteredLabel}
        </div>
      </div>
    </div>
  );
}

function fmtPctDelta(model: number | null, market: number | null): string {
  if (model == null || market == null || !Number.isFinite(model) || !Number.isFinite(market)) return '';
  const d = (model - market) * 100;
  if (Math.abs(d) < 0.05) return '≈ market';
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}pp vs book`;
}

function signalTone(bounded: number): 'up' | 'down' | 'flat' {
  if (bounded > 0.12) return 'up';
  if (bounded < -0.12) return 'down';
  return 'flat';
}

function biasArrow(bounded: number): string {
  if (bounded > 0.08) return '↑';
  if (bounded < -0.08) return '↓';
  return '→';
}

function BinaryOutcomeModelCard(props: {
  estimate: BinaryOutcomeEstimate;
  upLabel: string;
  downLabel: string;
  normMarketUp: number | null;
  embedded?: boolean;
}): ReactElement {
  const { estimate, upLabel, downLabel, normMarketUp, embedded = false } = props;
  const modelTone = estimate.probUp >= 0.55 ? 'up' : estimate.probUp <= 0.45 ? 'down' : 'flat';

  return (
    <div className={embedded ? 'min-w-0' : 'rounded-xl border border-violet-800/45 bg-violet-950/20 px-3 py-3 sm:px-4'}>
      <div className={`flex flex-wrap items-start justify-between gap-3 ${embedded ? 'mb-3' : ''}`}>
        {!embedded ? (
          <div className="min-w-0 flex-1">
            <div className="text-[9px] font-black uppercase tracking-[0.14em] text-violet-300/90">
              Settlement bias model
            </div>
            <p className="mt-1 max-w-2xl text-[10px] leading-snug text-zinc-500">
              Binary contract: <span className="text-zinc-400">Y = 1</span> if spot finishes{' '}
              <span className="font-semibold text-amber-200/90">above PTB</span> at expiry. The desk does not forecast
              price — it estimates{' '}
              <span className="font-mono text-zinc-400">P̂(Y=1) = σ(w₁Δ_PTB + w₂m_norm + w₃S + w₄r)</span>.
            </p>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <div
            className={`rounded-lg border px-3 py-2 text-center ${
              modelTone === 'up'
                ? 'border-emerald-700/50 bg-emerald-950/35'
                : modelTone === 'down'
                  ? 'border-rose-700/50 bg-rose-950/35'
                  : 'border-zinc-700/50 bg-zinc-900/40'
            }`}
          >
            <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-zinc-500">Model P({upLabel})</div>
            <div className="font-mono text-2xl font-bold tabular-nums text-zinc-50">{fmtProbPct01(estimate.probUp)}</div>
            <div className="text-[9px] text-zinc-500">{fmtPctDelta(estimate.probUp, normMarketUp)}</div>
          </div>
          <div className="rounded-lg border border-zinc-700/50 bg-black/25 px-3 py-2 text-center">
            <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-zinc-500">Model P({downLabel})</div>
            <div className="font-mono text-xl font-bold tabular-nums text-zinc-300">{fmtProbPct01(estimate.probDown)}</div>
          </div>
          {normMarketUp != null ? (
            <div className="rounded-lg border border-zinc-700/40 bg-black/20 px-3 py-2 text-center">
              <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-zinc-500">P_mkt P({upLabel})</div>
              <div className="font-mono text-lg font-semibold tabular-nums text-zinc-400">{fmtProbPct01(normMarketUp)}</div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {estimate.signals.map((sig: BinaryBiasSignal) => (
          <div
            key={sig.id}
            className={`rounded-lg border px-2.5 py-2 ${
              signalTone(sig.bounded) === 'up'
                ? 'border-emerald-800/40 bg-emerald-950/15'
                : signalTone(sig.bounded) === 'down'
                  ? 'border-rose-800/40 bg-rose-950/15'
                  : 'border-zinc-800/50 bg-black/20'
            }`}
          >
            <div className="flex items-baseline justify-between gap-2">
              <div className="text-[10px] font-semibold text-zinc-200">
                {sig.label}{' '}
                <span
                  className={
                    signalTone(sig.bounded) === 'up'
                      ? 'text-emerald-300'
                      : signalTone(sig.bounded) === 'down'
                        ? 'text-rose-300'
                        : 'text-zinc-500'
                  }
                  aria-hidden
                >
                  {biasArrow(sig.bounded)}
                </span>
              </div>
              <div className="font-mono text-[11px] tabular-nums text-violet-200/90">
                {sig.contribution >= 0 ? '+' : ''}
                {sig.contribution.toFixed(2)} score
              </div>
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-zinc-500">{sig.formula}</div>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] tabular-nums text-zinc-400">
              <span>
                raw{' '}
                {sig.id === 'ptbDistance'
                  ? `${sig.raw >= 0 ? '+' : ''}${(sig.raw * 100).toFixed(3)}%`
                  : `${sig.raw >= 0 ? '+' : ''}${sig.raw.toFixed(4)}`}
              </span>
              <span>bounded {sig.bounded >= 0 ? '+' : ''}{sig.bounded.toFixed(3)}</span>
              <span>w×b {sig.contribution >= 0 ? '+' : ''}{sig.contribution.toFixed(2)}</span>
            </div>
            <div className="mt-1 text-[10px] leading-snug text-zinc-500">{sig.interpretation}</div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/5 pt-2 font-mono text-[10px] tabular-nums text-zinc-500">
        <span>
          Score{' '}
          <span className="font-semibold text-violet-200/90">
            {estimate.score >= 0 ? '+' : ''}
            {estimate.score.toFixed(3)}
          </span>
          <span className="text-zinc-600">
            {' '}
            (= {estimate.signals.map((s) => `${s.contribution >= 0 ? '+' : ''}${s.contribution.toFixed(2)}`).join(' ')})
          </span>
        </span>
        <span>σ(score) → P̂({upLabel}) {fmtProbPct01(estimate.probUp)}</span>
        <span>horizon {estimate.horizonSec}s</span>
        {estimate.missing.length ? (
          <span className="text-amber-400/90">partial: {estimate.missing.join(', ')}</span>
        ) : null}
      </div>
    </div>
  );
}

function DeepLayerBlock(props: { title: string; children: ReactNode }): ReactElement {
  return (
    <div className="rounded-xl border border-zinc-800/45 bg-black/20">
      <div className="border-b border-zinc-800/40 px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-zinc-500">
        {props.title}
      </div>
      <div className="px-3 py-3">{props.children}</div>
    </div>
  );
}

function PriceHeadlineRow(props: {
  spotUsd: number;
  ptbUsd: number;
  distVsPtb: number;
  spotProjections: PricePredictionProjection[] | null;
  upLabel: string;
  downLabel: string;
  probUp01: number | null;
  probDown01: number | null;
  probUpDelta01: number | null;
  probDownDelta01: number | null;
  modelPUp: number | null;
  edgePp: number | null;
}): ReactElement {
  const p = props;
  const sep = <span className="text-zinc-600">·</span>;
  return (
    <div className="rounded-xl border border-indigo-800/40 bg-indigo-950/20 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[11px] font-bold tabular-nums leading-snug">
        <span className="text-[13px] text-zinc-50">{fmtUsd(p.spotUsd)}</span>
        {sep}
        <span className="text-zinc-400">
          PTB <span className="text-zinc-200">{fmtUsd(p.ptbUsd)}</span>
        </span>
        {sep}
        <span className={p.distVsPtb >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{fmtUsdSigned(p.distVsPtb)} vs PTB</span>
        {p.spotProjections?.length ? (
          <>
            {sep}
            {p.spotProjections.map((proj, i) => (
              <span key={proj.horizonSec} className="text-indigo-200">
                {i > 0 ? sep : null}
                Projected {proj.label} {fmtUsd(proj.projectedUsd)}{' '}
                <span className="text-indigo-300/80">({fmtUsdSigned(proj.deltaVsNowUsd)})</span>
              </span>
            ))}
          </>
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[10px] tabular-nums">
        {p.probUp01 != null ? (
          <span className="text-emerald-300/90">
            {p.upLabel} {fmtCents(p.probUp01)}
            {p.probUpDelta01 != null ? ` (${fmtDeltaCents(p.probUpDelta01)})` : ''}
          </span>
        ) : null}
        {p.probUp01 != null && p.probDown01 != null ? sep : null}
        {p.probDown01 != null ? (
          <span className="text-rose-300/90">
            {p.downLabel} {fmtCents(p.probDown01)}
            {p.probDownDelta01 != null ? ` (${fmtDeltaCents(p.probDownDelta01)})` : ''}
          </span>
        ) : null}
        {p.modelPUp != null ? (
          <>
            {sep}
            <span className="text-zinc-400" title="Desk settlement model from spot vs PTB, momentum, and flow">
              Model P({p.upLabel}) <span className="text-zinc-200">{fmtProbPct01(p.modelPUp)}</span>
            </span>
          </>
        ) : null}
        {p.edgePp != null ? (() => {
          const edge = buildUpEdgeHeadline({
            edgePp: p.edgePp,
            modelPUp: p.modelPUp,
            pMktUp: p.probUp01,
            upLabel: p.upLabel,
          });
          const toneCls =
            edge.tone === 'up'
              ? 'text-emerald-300'
              : edge.tone === 'down'
                ? 'text-rose-300'
                : 'text-zinc-400';
          return (
            <>
              {sep}
              <span className={toneCls} title={edge.title}>
                <span className="text-zinc-500">{p.upLabel} edge</span>{' '}
                <span className="font-semibold">{fmtPp(p.edgePp)}</span>
                {edge.math ? <span className="font-normal text-zinc-600"> ({edge.math})</span> : null}
                <span className="font-normal text-zinc-500"> · {edge.qualifier}</span>
              </span>
            </>
          );
        })() : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-indigo-800/30 pt-2">
        <span className="text-[8px] font-black uppercase tracking-[0.12em] text-indigo-400/80">Timers</span>
        <PredictionHorizonTimer horizonSec={0} compact />
        {p.spotProjections?.map((proj) => (
          <PredictionHorizonTimer key={proj.horizonSec} horizonSec={proj.horizonSec} compact />
        ))}
      </div>
    </div>
  );
}

function CompactSnapshotStrip(props: {
  geo: string;
  geoTone: GlanceTone;
  spotUsd: number;
  ptbUsd: number;
  distVsPtb: number;
  tradeCall: string;
  tradeTone: GlanceTone;
  edgePp: number | null;
  edgeUpLabel: string;
  edgeTitle: string | null;
  speedHint: string | null;
  machineHint: string | null;
  upMid: string | null;
  downMid: string | null;
}): ReactElement {
  const p = props;
  const edgeStr = p.edgePp != null ? fmtPp(p.edgePp) : '—';
  const pill = (text: string, tone?: GlanceTone, title?: string) => (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded-md border px-2 py-1 font-mono text-[10px] font-bold tabular-nums ${
        tone === 'up'
          ? 'border-emerald-700/45 bg-emerald-950/30 text-emerald-200'
          : tone === 'down'
            ? 'border-rose-700/45 bg-rose-950/30 text-rose-200'
            : tone === 'warn'
              ? 'border-amber-700/40 bg-amber-950/25 text-amber-200'
              : 'border-zinc-700/50 bg-zinc-900/40 text-zinc-300'
      }`}
    >
      {text}
    </span>
  );

  return (
    <div className="rounded-xl border border-zinc-700/50 bg-zinc-950/50 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {pill(p.geo, p.geoTone)}
        {pill(fmtUsd(p.spotUsd))}
        {pill(`${fmtUsdSigned(p.distVsPtb)} PTB`)}
        {pill(p.tradeCall, p.tradeTone)}
        {pill(
          `${p.edgeUpLabel} edge ${edgeStr}`,
          p.edgePp != null && p.edgePp > 0.3 ? 'up' : p.edgePp != null && p.edgePp < -0.3 ? 'down' : 'flat',
          p.edgeTitle ?? undefined,
        )}
        {p.speedHint ? pill(p.speedHint, p.speedHint.includes('DOWN') ? 'down' : p.speedHint.includes('UP') ? 'up' : 'warn') : null}
        {p.machineHint ? pill(p.machineHint, 'flat') : null}
      </div>
      {p.upMid || p.downMid ? (
        <div className="mt-1.5 flex flex-wrap gap-x-3 font-mono text-[10px] tabular-nums text-zinc-500">
          {p.upMid ? <span className="text-emerald-300/85">{p.upMid}</span> : null}
          {p.downMid ? <span className="text-rose-300/85">{p.downMid}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function fmtEndsInShort(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  if (ms < 0) return 'ENDED';
  const sec = Math.floor(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rm = m % 60;
    return `${h}h${rm}m`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function quickCtxPill(tone: GlanceTone, large = false): string {
  const base = large ? 'rounded-xl border px-3 py-2 sm:px-4 sm:py-2.5' : 'rounded-lg border px-2.5 py-1.5';
  switch (tone) {
    case 'up':
      return `${base} border-emerald-600/50 bg-emerald-950/40 text-emerald-100`;
    case 'down':
      return `${base} border-rose-600/50 bg-rose-950/40 text-rose-100`;
    case 'warn':
      return `${base} border-amber-600/45 bg-amber-950/35 text-amber-100`;
    default:
      return `${base} border-zinc-600/50 bg-zinc-900/50 text-zinc-200`;
  }
}

/** Compact context strip — spot, contracts, breaks at desk-normal type. */
function NowPriceQuickContextStrip(props: {
  band: NowPriceBandDistances;
  glance: ReturnType<typeof buildSpotBandGlance>;
  geoTone: GlanceTone;
  upLabel: string;
  downLabel: string;
  probUp01: number | null;
  probDown01: number | null;
  probUpDelta01: number | null;
  probDownDelta01: number | null;
  modelPUp: number | null;
  edgeUpPp: number | null;
  edgeDownPp: number | null;
  activeLane: 'up' | 'down' | null;
  speedHint: string | null;
  machineHint: string | null;
  endsInMs: number | null | undefined;
  slopeUsdPerMin: number | null;
}): ReactElement {
  const p = props;
  const geoLabel = p.band.geo.replace('_', ' ');
  const endsLabel = fmtEndsInShort(p.endsInMs);
  const activeEdge =
    p.activeLane === 'down' ? p.edgeDownPp : p.activeLane === 'up' ? p.edgeUpPp : p.edgeUpPp;
  const slopeLabel =
    p.slopeUsdPerMin != null && Number.isFinite(p.slopeUsdPerMin)
      ? `${p.slopeUsdPerMin >= 0 ? '+' : ''}${p.slopeUsdPerMin.toFixed(1)}/min`
      : null;

  return (
    <div className="rounded-xl border border-zinc-700/50 bg-zinc-950/50 px-2.5 py-2.5 sm:px-3 sm:py-3">
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
        <span className={`${quickCtxPill(p.geoTone)} text-[10px] font-black uppercase tracking-wide`}>
          {geoLabel}
        </span>
        <span className="font-mono text-[13px] font-bold tabular-nums text-zinc-50">{fmtUsd(p.band.now)}</span>
        <span
          className={`font-mono text-[11px] font-bold tabular-nums ${
            p.band.distNowFromPtb >= 0 ? 'text-emerald-300' : 'text-rose-300'
          }`}
        >
          {fmtUsdSigned(p.band.distNowFromPtb)} vs PTB
        </span>
        <span className="font-mono text-[10px] text-zinc-500">PTB {fmtUsd(p.band.ptb)}</span>
        {endsLabel ? (
          <span className={`${quickCtxPill('warn')} font-mono text-[10px] font-bold tabular-nums`}>⏱ {endsLabel}</span>
        ) : null}
        {slopeLabel ? (
          <span className={`${quickCtxPill('flat')} font-mono text-[10px] font-bold tabular-nums`}>slope {slopeLabel}</span>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {p.probUp01 != null ? (
          <span className={`${quickCtxPill('up')} font-mono text-[10px] font-bold tabular-nums`}>
            {p.upLabel} {fmtCents(p.probUp01)}
            {p.probUpDelta01 != null ? <span className="opacity-85"> {fmtDeltaCents(p.probUpDelta01)}</span> : null}
          </span>
        ) : null}
        {p.probDown01 != null ? (
          <span className={`${quickCtxPill('down')} font-mono text-[10px] font-bold tabular-nums`}>
            {p.downLabel} {fmtCents(p.probDown01)}
            {p.probDownDelta01 != null ? <span className="opacity-85"> {fmtDeltaCents(p.probDownDelta01)}</span> : null}
          </span>
        ) : null}
        {activeEdge != null ? (
          <span
            className={`${quickCtxPill(
              activeEdge > 0.3 ? 'up' : activeEdge < -0.3 ? 'down' : 'flat',
            )} font-mono text-[10px] font-bold tabular-nums`}
          >
            Edge {fmtPp(activeEdge)}
          </span>
        ) : null}
        {p.modelPUp != null ? (
          <span className={`${quickCtxPill('flat')} font-mono text-[10px] font-bold tabular-nums`}>
            Model {p.upLabel} {fmtProbPct01(p.modelPUp)}
          </span>
        ) : null}
        {p.speedHint ? (
          <span className={`${quickCtxPill('warn')} text-[9px] font-bold uppercase tracking-wide`}>{p.speedHint}</span>
        ) : null}
        {p.machineHint ? (
          <span className={`${quickCtxPill('flat')} font-mono text-[10px] font-bold`}>{p.machineHint}</span>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-zinc-800/50 pt-2 text-[11px] font-semibold leading-snug">
        <span className={p.glance.upBreak.cleared ? 'text-emerald-300' : 'text-amber-200'}>
          {p.glance.upBreak.cleared ? '✓' : '○'} UP: {p.glance.upBreak.primary}
        </span>
        <span className={p.glance.downBreak.cleared ? 'text-rose-300' : 'text-amber-200'}>
          {p.glance.downBreak.cleared ? '✓' : '○'} DOWN: {p.glance.downBreak.primary}
        </span>
      </div>
      <p className="mt-1 text-[10px] leading-snug text-zinc-500">{p.glance.subline}</p>
    </div>
  );
}

type NowPriceHeroView = {
  tone: GlanceTone;
  emoji: string;
  primary: string;
  laneLabel: string | null;
  subline: string;
  detail: string | null;
  /** Structured next step before the desk signal fires. */
  aheadPlaybook: DeskAheadPlaybook;
  confidencePct: number | null;
  confirmPct: number | null;
  phaseLabel: string | null;
  edgePp: number | null;
  edgeCentsLabel: string | null;
  jumpGainCents: number | null;
  projJumpCents1m: number | null;
  jumpHeadline: string | null;
  projLine: string | null;
  tpHitProbPct: number | null;
  readinessPct: number;
  blockers: string[];
  canTrade: boolean;
  urgency: string;
};

type HeroMetricsCtx = {
  directionEngine: DirectionEngineSignal | null;
  bilateral: ReturnType<typeof computeBilateralEdge> | null;
  jumps: { up: ContractEntryJump | null; down: ContractEntryJump | null };
  contractLag: ReturnType<typeof computeContractLagReadout> | null;
};

function resolveHeroLaneMetrics(
  lane: 'up' | 'down',
  ctx: HeroMetricsCtx,
): Pick<
  NowPriceHeroView,
  'edgePp' | 'edgeCentsLabel' | 'jumpGainCents' | 'projJumpCents1m' | 'jumpHeadline' | 'projLine'
> {
  const edgePp = lane === 'up' ? ctx.bilateral?.edgeUpPp ?? null : ctx.bilateral?.edgeDownPp ?? null;
  let edgeCentsLabel: string | null = null;
  if (ctx.directionEngine?.proposedLane === lane && ctx.directionEngine.edgeCents) {
    edgeCentsLabel = ctx.directionEngine.edgeCents;
  } else if (ctx.contractLag) {
    const lag = lane === 'up' ? ctx.contractLag.lagUpCents : ctx.contractLag.lagDownCents;
    if (lag > 0.5) edgeCentsLabel = `+${lag.toFixed(1)}¢ lag`;
  }
  const jump = lane === 'up' ? ctx.jumps.up : ctx.jumps.down;
  return {
    edgePp,
    edgeCentsLabel,
    jumpGainCents: jump?.gainCents ?? null,
    projJumpCents1m: jump?.projJumpCentsFromNow1m ?? null,
    jumpHeadline: jump?.headline ?? null,
    projLine: jump?.projLine ?? null,
  };
}

const EMPTY_HERO_METRICS: Pick<
  NowPriceHeroView,
  'edgePp' | 'edgeCentsLabel' | 'jumpGainCents' | 'projJumpCents1m' | 'jumpHeadline' | 'projLine'
> = {
  edgePp: null,
  edgeCentsLabel: null,
  jumpGainCents: null,
  projJumpCents1m: null,
  jumpHeadline: null,
  projLine: null,
};

function resolveHeroLane(args: {
  executionSignal: ExecutionSignal | null;
  directionEngine: DirectionEngineSignal | null;
  tradeCall: string;
  upLabel: string;
  downLabel: string;
}): 'up' | 'down' | null {
  const { executionSignal, directionEngine, tradeCall, upLabel, downLabel } = args;
  if (executionSignal?.verdict === 'ENTER_UP' || directionEngine?.verdict === 'ENTER_UP') return 'up';
  if (executionSignal?.verdict === 'ENTER_DOWN' || directionEngine?.verdict === 'ENTER_DOWN') return 'down';
  return (
    directionEngine?.proposedLane ??
    (tradeCall.includes(upLabel) ? 'up' : tradeCall.includes(downLabel) ? 'down' : executionSignal?.proposedLane ?? null)
  );
}

function laneTpOutlook(args: {
  lane: 'up' | 'down';
  touch: BookTouchForArmRisk | null | undefined;
  mid01: number | null;
  probSeries: SpotPoint[];
  endsInMs?: number | null;
}) {
  const ask = args.touch?.bestAsk;
  const entry01 =
    ask != null && ask > 0 && ask < 1 ? ask : args.mid01 != null && args.mid01 > 0 && args.mid01 < 1 ? args.mid01 : null;
  if (entry01 == null) return null;
  const prefs = loadEmergencyStopBundlePrefs();
  let tpCents = '';
  if (prefs.autoTpOnFill) {
    const q = buildQuoteAssistTargets({
      quote01: entry01,
      bestBid: args.touch?.bestBid ?? null,
      bestAsk: args.touch?.bestAsk ?? null,
    });
    tpCents = q?.tpCents?.trim() ?? '';
  }
  if (!tpCents) tpCents = spreadBracketFromFillPrice01(entry01, args.touch ?? {}).tpCents;
  if (!tpCents.trim()) return null;
  return computePreBuyTpOutlook({
    entry01,
    tpCents,
    current01: args.mid01,
    probSeries: args.probSeries,
    endsInMs: args.endsInMs ?? null,
  });
}

function synthesizeHeroDetail(
  signal: NowPriceDeskTradeSignal,
  metrics: Pick<NowPriceHeroView, 'edgePp' | 'projLine' | 'jumpHeadline'>,
): string {
  const stalePullback =
    signal.exactAction.includes('Re-enter when pressure is EARLY') ||
    signal.exactAction.includes('do not chase the ask.');
  let detail =
    stalePullback && signal.laneLabel && (signal.phase === 'LEAN' || signal.headline.toUpperCase().includes('LEAN'))
      ? `Desk picks ${signal.laneLabel} — move already ran. Join on bid; don't chase wide ask. Hunt EARLY pressure (<4pp on 10s).`
      : signal.exactAction;

  if (signal.phase !== 'LEAN' && signal.phase !== 'ALERT') return detail;

  const extras: string[] = [];
  if (metrics.edgePp != null && metrics.edgePp < 3) {
    extras.push(
      metrics.edgePp <= 0
        ? `Base edge ${metrics.edgePp.toFixed(1)}pp — ${signal.laneLabel ?? 'side'} is rich vs model; limit on bid only.`
        : `Base edge +${metrics.edgePp.toFixed(1)}pp — thin cushion; don't pay the ask.`,
    );
  }
  if (metrics.projLine && !detail.includes(metrics.projLine)) {
    extras.push(metrics.projLine);
  } else if (metrics.jumpHeadline && !detail.includes(metrics.jumpHeadline)) {
    extras.push(metrics.jumpHeadline);
  }
  if (extras.length === 0) return detail;
  return `${detail} ${extras.join(' ')}`;
}

function deskTradeSignalToHeroView(
  signal: NowPriceDeskTradeSignal,
  metricsCtx: HeroMetricsCtx,
): NowPriceHeroView {
  const lane = signal.lane;
  const metrics = lane ? resolveHeroLaneMetrics(lane, metricsCtx) : EMPTY_HERO_METRICS;
  const phaseLabel =
    signal.phase === 'ENTER'
      ? 'GO'
      : signal.phase === 'ALERT'
        ? 'CONFIRM'
        : signal.phase === 'LEAN'
          ? 'EDGE'
          : signal.phase === 'NO_TRADE'
            ? 'SKIP'
            : null;
  const leanHeadline = signal.headline.toUpperCase().includes('LEAN');
  const primary =
    signal.phase === 'ENTER'
      ? 'ENTER'
      : signal.phase === 'LEAN' || signal.phase === 'ALERT'
        ? signal.phase
        : leanHeadline
          ? 'LEAN'
          : signal.phase;
  const subline =
    (signal.phase === 'LEAN' || primary === 'LEAN') && leanHeadline
      ? signal.confidencePct != null
        ? `${signal.confidencePct}% conf · timing entry, don't chase ask`
        : 'Desk edge live — time entry on bid, not wide ask'
      : signal.headline;
  return {
    tone: signal.tone,
    emoji: signal.emoji,
    primary,
    laneLabel: signal.laneLabel,
    subline,
    detail: synthesizeHeroDetail(signal, metrics),
    confidencePct: signal.confidencePct,
    confirmPct: signal.confirmPct,
    phaseLabel,
    tpHitProbPct: signal.tpHitProbPct,
    readinessPct: signal.readinessPct,
    blockers: signal.blockers,
    canTrade: signal.canTrade,
    urgency: signal.urgency,
    ...metrics,
  };
}

function nowPriceHeroShell(tone: GlanceTone, _phaseLabel: string | null): string {
  switch (tone) {
    case 'up':
      return 'border-emerald-600/55 bg-emerald-950/35 ring-1 ring-emerald-500/20';
    case 'down':
      return 'border-rose-600/55 bg-rose-950/35 ring-1 ring-rose-500/20';
    case 'warn':
      return 'border-amber-600/45 bg-amber-950/30 ring-1 ring-amber-500/15';
    default:
      return 'border-zinc-700/55 bg-zinc-950/40 ring-1 ring-zinc-600/15';
  }
}

function nowPriceHeroLaneTone(tone: GlanceTone): string {
  switch (tone) {
    case 'up':
      return 'text-emerald-200';
    case 'down':
      return 'text-rose-200';
    case 'warn':
      return 'text-amber-100';
    default:
      return 'text-zinc-100';
  }
}

function deskCatchStripShell(mode: DeskAheadPlaybook['mode']): string {
  switch (mode) {
    case 'go':
      return 'border-emerald-400 bg-emerald-500 shadow-lg shadow-emerald-900/50 ring-2 ring-emerald-300/60';
    case 'arm':
      return 'border-amber-400 bg-amber-500/95 shadow-lg shadow-amber-900/40 ring-2 ring-amber-300/50';
    case 'watch':
      return 'border-cyan-400 bg-cyan-600/90 shadow-lg shadow-cyan-900/40 ring-2 ring-cyan-300/40';
    case 'wait':
      return 'border-zinc-500 bg-zinc-800 shadow-md shadow-black/40 ring-1 ring-zinc-400/30';
    case 'skip':
      return 'border-zinc-600 bg-zinc-900/90 ring-1 ring-zinc-600/40';
  }
}

function deskCatchStripText(mode: DeskAheadPlaybook['mode']): string {
  return mode === 'go' || mode === 'arm' ? 'text-black' : 'text-zinc-50';
}

function DeskCatchStrip(props: { playbook: DeskAheadPlaybook }): ReactElement {
  const { playbook } = props;
  const pulse = playbook.mode === 'go' ? 'animate-pulse' : '';
  const textCls = deskCatchStripText(playbook.mode);
  const bracketLine = formatDeskBracketLine(playbook.bracket, playbook.tpHitProbPct);

  return (
    <div
      className={`rounded-2xl border-2 px-4 py-4 text-center sm:px-5 sm:py-5 ${deskCatchStripShell(playbook.mode)} ${pulse}`}
      role="status"
      aria-live="polite"
    >
      <div className={`text-[10px] font-black uppercase tracking-[0.22em] ${textCls} opacity-80`}>
        {deskCatchModeLabel(playbook.mode)}
      </div>
      <div
        className={`mt-1.5 font-black leading-[1.1] tracking-tight ${textCls} text-[clamp(1.35rem,5vw,2rem)]`}
      >
        {playbook.catchLine}
      </div>
      {bracketLine ? (
        <div
          className={`mt-2 font-mono text-[clamp(0.95rem,3.2vw,1.25rem)] font-black tabular-nums leading-snug tracking-tight ${textCls}`}
        >
          {bracketLine}
        </div>
      ) : null}
      {playbook.confirmSec != null && playbook.confirmSec > 0 ? (
        <div
          className={`mt-2 font-mono text-[clamp(2rem,8vw,3.25rem)] font-black tabular-nums leading-none ${textCls}`}
        >
          {playbook.confirmSec}s
        </div>
      ) : null}
      {playbook.mode !== 'go' ? (
        <div className="mx-auto mt-3 max-w-lg space-y-1 text-left text-[11px] leading-snug sm:text-xs">
          <div className={`flex gap-2 ${textCls} opacity-95`}>
            <span className="w-10 shrink-0 font-black uppercase opacity-70">When</span>
            <span className="min-w-0 font-semibold">{playbook.when}</span>
          </div>
          <div className={`flex gap-2 ${textCls}`}>
            <span className="w-10 shrink-0 font-black uppercase opacity-70">Do</span>
            <span className="min-w-0 font-bold">{playbook.do}</span>
          </div>
          {playbook.skip ? (
            <div className={`flex gap-2 ${textCls} opacity-75`}>
              <span className="w-10 shrink-0 font-bold uppercase opacity-70">Skip</span>
              <span className="min-w-0">{playbook.skip}</span>
            </div>
          ) : null}
        </div>
      ) : playbook.skip ? (
        <p className={`mt-2 text-[11px] font-bold ${textCls} opacity-85`}>{playbook.skip}</p>
      ) : null}
    </div>
  );
}

function NowPriceHeroSignalBanner(props: { view: NowPriceHeroView }): ReactElement {
  const { view } = props;
  const laneCls = nowPriceHeroLaneTone(view.tone);
  const confCls =
    view.confidencePct != null && view.confidencePct >= 85
      ? 'text-emerald-300'
      : view.confidencePct != null && view.confidencePct >= 70
        ? 'text-cyan-200'
        : view.confidencePct != null && view.confidencePct >= 55
          ? 'text-amber-200'
          : 'text-zinc-400';
  const pulse = view.canTrade ? 'animate-pulse' : '';

  return (
    <div className={`rounded-xl border px-3 py-3 sm:px-4 ${nowPriceHeroShell(view.tone, view.phaseLabel)} ${pulse}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] pb-2">
        <span className="text-[9px] font-black uppercase tracking-[0.16em] text-zinc-500">Main desk trade signal</span>
        <div className="flex flex-wrap items-center gap-2">
          {view.tpHitProbPct != null ? (
            <span
              className={`rounded-lg border px-2 py-0.5 font-mono text-[10px] font-black tabular-nums ${
                view.tpHitProbPct >= 55
                  ? 'border-emerald-600/45 bg-emerald-950/40 text-emerald-100'
                  : view.tpHitProbPct >= 35
                    ? 'border-amber-600/45 bg-amber-950/40 text-amber-50'
                    : 'border-rose-600/45 bg-rose-950/40 text-rose-50'
              }`}
            >
              TP {view.tpHitProbPct}%
            </span>
          ) : null}
          <span className="font-mono text-[10px] font-bold tabular-nums text-zinc-400">{view.readinessPct}% ready</span>
        </div>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2 sm:gap-3">
          <span className="select-none text-2xl leading-none sm:text-3xl" aria-hidden>
            {view.emoji}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
              <span className={`text-xl font-black uppercase tracking-tight sm:text-2xl ${laneCls}`}>
                {view.primary}
              </span>
              {view.laneLabel ? (
                <span className={`text-lg font-black tracking-tight sm:text-xl ${laneCls}`}>{view.laneLabel}</span>
              ) : null}
            </div>
            <p className="mt-1 text-[13px] font-bold leading-snug text-zinc-100 sm:text-sm">{view.subline}</p>
            {view.detail ? (
              <p className="mt-1.5 rounded-lg border border-black/30 bg-black/25 px-2.5 py-2 text-[11px] font-semibold leading-snug text-zinc-200">
                {view.detail}
              </p>
            ) : null}
            {view.blockers.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {view.blockers.map((b) => (
                  <span
                    key={b}
                    className="rounded-md border border-amber-600/40 bg-amber-950/35 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-100/90"
                  >
                    {b}
                  </span>
                ))}
              </div>
            ) : null}
            {view.edgePp != null || view.jumpGainCents != null || view.projJumpCents1m != null ? (
              <div className="mt-2.5 flex flex-wrap gap-2">
                {view.edgePp != null ? (
                  <div className="rounded-lg border border-black/35 bg-black/35 px-2.5 py-2 sm:min-w-[5.5rem]">
                    <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-zinc-500">
                      {view.edgePp >= 3 ? 'Edge' : view.edgePp <= 0 ? 'Rich vs model' : 'Thin edge'}
                    </div>
                    <div
                      className={`mt-0.5 font-mono text-lg font-black tabular-nums sm:text-xl ${
                        view.tone === 'up' ? 'text-emerald-300' : view.tone === 'down' ? 'text-rose-300' : 'text-zinc-200'
                      }`}
                    >
                      {fmtPp(view.edgePp)}
                    </div>
                    {view.edgeCentsLabel ? (
                      <div className="mt-0.5 font-mono text-[10px] font-semibold text-zinc-400">{view.edgeCentsLabel}</div>
                    ) : null}
                  </div>
                ) : null}
                {view.jumpGainCents != null && Math.abs(view.jumpGainCents) >= 0.05 ? (
                  <div className="rounded-lg border border-black/35 bg-black/35 px-2.5 py-2 sm:min-w-[5.5rem]">
                    <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-zinc-500">30s jump</div>
                    <div
                      className={`mt-0.5 font-mono text-lg font-black tabular-nums sm:text-xl ${
                        view.jumpGainCents >= 0 ? 'text-cyan-200' : 'text-rose-300/90'
                      }`}
                    >
                      {view.jumpGainCents >= 0 ? '+' : ''}
                      {view.jumpGainCents.toFixed(1)}¢
                    </div>
                    {view.jumpHeadline ? (
                      <div className="mt-1 max-w-xs text-[9px] leading-snug text-zinc-500">{view.jumpHeadline}</div>
                    ) : null}
                  </div>
                ) : null}
                {view.projJumpCents1m != null && Math.abs(view.projJumpCents1m) >= 0.05 ? (
                  <div className="rounded-lg border border-black/35 bg-black/35 px-2.5 py-2 sm:min-w-[5.5rem]">
                    <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-zinc-500">Proj 1m</div>
                    <div
                      className={`mt-0.5 font-mono text-lg font-black tabular-nums sm:text-xl ${
                        view.projJumpCents1m >= 0 ? 'text-violet-200' : 'text-amber-200/90'
                      }`}
                    >
                      ~{view.projJumpCents1m >= 0 ? '+' : ''}
                      {view.projJumpCents1m.toFixed(1)}¢
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
            {view.projLine ? (
              <p className="mt-1.5 max-w-3xl font-mono text-[10px] leading-snug text-zinc-500">{view.projLine}</p>
            ) : null}
            {view.confirmPct != null && view.confirmPct < 100 ? (
              <div className="mt-2.5 max-w-md">
                <div className="flex items-center justify-between text-[9px] font-bold uppercase tracking-wide text-amber-200/90">
                  <span>Continuation confirm</span>
                  <span className="font-mono tabular-nums">{view.confirmPct}%</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-black/40">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-amber-500/80 to-amber-300/90 transition-[width] duration-300"
                    style={{ width: `${view.confirmPct}%` }}
                  />
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {view.phaseLabel ? (
            <div className="text-[9px] font-black uppercase tracking-[0.16em] text-zinc-500">{view.phaseLabel}</div>
          ) : null}
          {view.confidencePct != null ? (
            <>
              <div className={`mt-0.5 font-mono text-2xl font-black tabular-nums sm:text-3xl ${confCls}`}>
                {view.confidencePct}%
              </div>
              <div className="text-[9px] font-bold uppercase tracking-wide text-zinc-500">Confidence</div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function fmtPp(pp: number): string {
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}

/** Desk model P(Up) minus Up mid, in percentage points. */
function upEdgePp(modelPUp: number | null, pMktUp: number | null): number | null {
  if (modelPUp == null || pMktUp == null || !Number.isFinite(modelPUp) || !Number.isFinite(pMktUp)) {
    return null;
  }
  return (modelPUp - pMktUp) * 100;
}

function buildUpEdgeHeadline(params: {
  edgePp: number;
  modelPUp: number | null;
  pMktUp: number | null;
  upLabel: string;
}): { qualifier: string; math: string | null; title: string; tone: GlanceTone } {
  const { edgePp, modelPUp, pMktUp, upLabel } = params;
  const qualifier =
    edgePp > 0.3 ? `${upLabel} cheap` : edgePp < -0.3 ? `${upLabel} rich` : 'near fair';
  const math =
    modelPUp != null && pMktUp != null ? `${fmtProbPct01(modelPUp)} − ${fmtProbPct01(pMktUp)}` : null;
  const title = [
    `${upLabel} edge = desk model P(${upLabel}) minus ${upLabel} mid on the book.`,
    'Positive → model thinks the contract is underpriced (cheap).',
    'Negative → model thinks the contract is overpriced (rich).',
    math ? `${math} = ${fmtPp(edgePp)} (${qualifier}).` : fmtPp(edgePp),
  ].join(' ');
  const tone: GlanceTone = edgePp > 0.3 ? 'up' : edgePp < -0.3 ? 'down' : 'flat';
  return { qualifier, math, title, tone };
}

function contractLagPhaseCls(phase: ContractLagPhase): string {
  if (phase === 'lagging') return 'border-amber-500/55 bg-amber-950/35 text-amber-100';
  if (phase === 'catching_up') return 'border-emerald-500/55 bg-emerald-950/35 text-emerald-100';
  return 'border-zinc-600/50 bg-zinc-900/40 text-zinc-300';
}

function ContractMidSparkline(props: {
  pts: { t: number; v: number }[];
  label: string;
  model01: number;
  accent: 'up' | 'down';
}): ReactElement | null {
  const last = props.pts.at(-1);
  const series = useMemo(() => props.pts.slice(-90), [props.pts, last?.t, last?.v]);
  if (series.length < 2) return null;

  const w = 280;
  const h = 56;
  const pad = 4;
  const vals = series.map((p) => p.v);
  const min = Math.min(...vals, props.model01);
  const max = Math.max(...vals, props.model01);
  const span = Math.max(max - min, 0.02);
  const toY = (v: number) => pad + (h - pad * 2) * (1 - (v - min) / span);
  const toX = (i: number) => pad + ((w - pad * 2) * i) / Math.max(1, series.length - 1);
  const path = series
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(p.v).toFixed(1)}`)
    .join(' ');
  const modelY = toY(props.model01);
  const stroke = props.accent === 'up' ? '#34d399' : '#fb7185';

  return (
    <div className="rounded-lg border border-zinc-800/50 bg-black/30 px-2 py-1.5">
      <div className="text-[8px] font-bold uppercase tracking-wide text-zinc-500">{props.label} mid · live</div>
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-1 block h-14 w-full" preserveAspectRatio="none">
        <line x1={pad} x2={w - pad} y1={modelY} y2={modelY} stroke="#a78bfa" strokeDasharray="3 3" strokeWidth="1" opacity="0.7" />
        <path d={path} fill="none" stroke={stroke} strokeWidth="1.75" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-0.5 flex justify-between font-mono text-[8px] tabular-nums text-zinc-600">
        <span>{fmtCents(min)}</span>
        <span className="text-violet-400/80">model {fmtCents(props.model01)}</span>
        <span>{fmtCents(max)}</span>
      </div>
    </div>
  );
}

function ContractLagBox(props: {
  lag: ContractLagReadout;
  upLabel: string;
  downLabel: string;
  distVsPtb: number;
  probTicksUp: { t: number; v: number }[];
  probTicksDown: { t: number; v: number }[];
}): ReactElement {
  const { lag, upLabel, downLabel, distVsPtb, probTicksUp, probTicksDown } = props;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const ageSec =
    lag.marketUpdatedAtMs != null
      ? Math.max(0, Math.round((nowMs - lag.marketUpdatedAtMs) / 1000))
      : null;
  const stale = ageSec != null && ageSec * 1000 > CONTRACT_LAG_STALE_MS;

  const favoredIsUp = lag.favoredSide === 'up';
  const favoredIsDown = lag.favoredSide === 'down';

  return (
    <div
      className={`rounded-2xl border p-3 sm:p-4 ${
        stale
          ? 'border-rose-700/55 bg-gradient-to-br from-rose-950/30 to-zinc-950/80'
          : 'border-amber-700/45 bg-gradient-to-br from-amber-950/25 to-zinc-950/80'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[10px] font-black uppercase tracking-[0.16em] text-amber-300/90">Contract lag</div>
            <span
              className={`rounded-md border px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wide ${
                stale
                  ? 'border-rose-600/60 bg-rose-950/50 text-rose-200'
                  : 'border-emerald-600/50 bg-emerald-950/40 text-emerald-200'
              }`}
            >
              {stale ? `STALE ${ageSec}s` : 'LIVE mids'}
            </span>
          </div>
          <div className="mt-1 text-[10px] text-zinc-500">
            Live CLOB mid vs model · 30s Δ shows recent move (not forward projection)
          </div>
        </div>
        <div
          className={`rounded-xl border px-4 py-2.5 text-center ${
            stale ? 'border-rose-600/50 bg-rose-950/35 text-rose-100' : contractLagPhaseCls(lag.phase)
          }`}
        >
          <div className="text-[8px] font-bold uppercase tracking-[0.14em] opacity-80">
            {stale ? 'data stale' : lag.phase.replace('_', ' ')}
          </div>
          <div className="mt-1 text-sm font-black leading-tight">{stale ? 'Mids not updating' : lag.call}</div>
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div
          className={`rounded-xl border px-3 py-2.5 ${
            favoredIsUp && lag.lagUpCents >= 5
              ? 'border-emerald-600/50 bg-emerald-950/25 ring-1 ring-emerald-500/20'
              : 'border-zinc-800/50 bg-black/25'
          }`}
        >
          <div className="text-[9px] font-bold uppercase tracking-wide text-zinc-500">{upLabel} lag</div>
          <div className={`mt-1 font-mono text-2xl font-black tabular-nums ${lag.lagUpCents > 0.5 ? 'text-emerald-300' : lag.lagUpCents < -0.5 ? 'text-rose-300/80' : 'text-zinc-400'}`}>
            {lag.lagUpCents >= 0 ? '+' : ''}{lag.lagUpCents.toFixed(1)}¢
          </div>
          <div className="mt-1 font-mono text-[10px] tabular-nums text-zinc-500">
            Mkt {fmtCents(lag.marketUp)} → model {fmtCents(lag.modelUp)}
            {lag.marketDeltaUpCents != null ? (
              <span className={lag.marketDeltaUpCents > 0 ? ' text-emerald-400' : lag.marketDeltaUpCents < 0 ? ' text-rose-400' : ''}>
                {' '}
                30s Δ {lag.marketDeltaUpCents >= 0 ? '+' : ''}{lag.marketDeltaUpCents.toFixed(1)}¢
              </span>
            ) : null}
          </div>
        </div>
        <div
          className={`rounded-xl border px-3 py-2.5 ${
            favoredIsDown && lag.lagDownCents >= 5
              ? 'border-emerald-600/50 bg-emerald-950/25 ring-1 ring-emerald-500/20'
              : 'border-zinc-800/50 bg-black/25'
          }`}
        >
          <div className="text-[9px] font-bold uppercase tracking-wide text-zinc-500">{downLabel} lag</div>
          <div className={`mt-1 font-mono text-2xl font-black tabular-nums ${lag.lagDownCents > 0.5 ? 'text-emerald-300' : lag.lagDownCents < -0.5 ? 'text-rose-300/80' : 'text-zinc-400'}`}>
            {lag.lagDownCents >= 0 ? '+' : ''}{lag.lagDownCents.toFixed(1)}¢
          </div>
          <div className="mt-1 font-mono text-[10px] tabular-nums text-zinc-500">
            Mkt {fmtCents(lag.marketDown)} → model {fmtCents(lag.modelDown)}
            {lag.marketDeltaDownCents != null ? (
              <span className={lag.marketDeltaDownCents > 0 ? ' text-emerald-400' : lag.marketDeltaDownCents < 0 ? ' text-rose-400' : ''}>
                {' '}
                30s Δ {lag.marketDeltaDownCents >= 0 ? '+' : ''}{lag.marketDeltaDownCents.toFixed(1)}¢
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <ContractMidSparkline pts={probTicksUp} label={upLabel} model01={lag.modelUp} accent="up" />
        <ContractMidSparkline pts={probTicksDown} label={downLabel} model01={lag.modelDown} accent="down" />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] tabular-nums text-zinc-500">
        <span>
          Spot {fmtUsdSigned(distVsPtb)} vs PTB
          {lag.geo ? ` · ${lag.geo.replace('_', ' ')}` : ''}
        </span>
        <span
          title={
            buildUpEdgeHeadline({
              edgePp: lag.edgePp,
              modelPUp: lag.modelUp,
              pMktUp: lag.marketUp,
              upLabel,
            }).title
          }
        >
          {upLabel} edge {fmtPp(lag.edgePp)}
        </span>
        <span className={lag.geoAligned ? 'text-emerald-400/90' : 'text-amber-400/90'}>
          {lag.geoAligned ? 'Geo ✓' : 'Geo ✗'}
        </span>
        {lag.repricingIntoEdge != null ? (
          <span className={lag.repricingIntoEdge ? 'text-emerald-400/90' : 'text-zinc-500'}>
            {lag.repricingIntoEdge ? 'REP+ catch-up' : 'REP− not moving yet'}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-[10px] leading-snug text-zinc-500">{lag.detail}</p>
      <p className="mt-1 text-[9px] text-zinc-600">
        Trade filter: lag ≥ +5¢ · |edge| ≥ 3pp · spot geometry confirms side · LAGGING = before jump · CATCHING UP = 56→70 move
      </p>
    </div>
  );
}

function fvgSignalTierCls(tier: FvgSignalTier): string {
  if (tier === 'STRONG_YES') return 'border-emerald-500/60 bg-emerald-950/45 text-emerald-100';
  if (tier === 'WEAK_YES') return 'border-emerald-700/45 bg-emerald-950/25 text-emerald-200';
  if (tier === 'STRONG_NO') return 'border-rose-500/60 bg-rose-950/45 text-rose-100';
  if (tier === 'WEAK_NO') return 'border-rose-700/45 bg-rose-950/25 text-rose-200';
  return 'border-zinc-600/50 bg-zinc-900/40 text-zinc-300';
}

function FairValueGapSignalBox(props: {
  signal: FairValueGapSignalReadout;
  upLabel: string;
  downLabel: string;
}): ReactElement {
  const { signal: s, upLabel, downLabel } = props;
  const buyLabel = s.trade === 'BUY_YES' || s.trade === 'SMALL_YES' ? upLabel : downLabel;

  return (
    <div className="rounded-2xl border border-violet-800/45 bg-gradient-to-br from-violet-950/30 to-zinc-950/80 p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-black uppercase tracking-[0.16em] text-violet-300/90">FVG signal</div>
          <div className="mt-1 text-[10px] text-zinc-500">Z × edge · single buy/sell score</div>
        </div>
        <div className={`rounded-xl border px-4 py-2.5 text-center ${fvgSignalTierCls(s.tier)}`}>
          <div className="text-[8px] font-bold uppercase tracking-[0.14em] opacity-80">Trade</div>
          <div className="mt-1 text-lg font-black leading-tight">{s.label}</div>
          {s.trade !== 'NO_TRADE' && s.trade !== 'SMALL_YES' && s.trade !== 'SMALL_NO' ? (
            <div className="mt-0.5 text-[10px] font-semibold opacity-90">{buyLabel}</div>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        <div className="rounded-lg border border-zinc-800/50 bg-black/25 px-2 py-1.5">
          <div className="text-[8px] font-bold uppercase text-zinc-500">FVG</div>
          <div className="font-mono text-sm font-bold tabular-nums text-cyan-200">{fmtPp(s.fvgPp)}</div>
          <div className="text-[9px] text-zinc-600">{s.fvgCents >= 0 ? '+' : ''}{s.fvgCents.toFixed(1)}¢ expected − mkt</div>
        </div>
        <div className="rounded-lg border border-zinc-800/50 bg-black/25 px-2 py-1.5">
          <div className="text-[8px] font-bold uppercase text-zinc-500">Z-score</div>
          <div className="font-mono text-sm font-bold tabular-nums text-amber-200">
            {s.zScore != null ? (s.zScore >= 0 ? '+' : '') + s.zScore.toFixed(2) : '—'}
          </div>
          <div className="text-[9px] text-zinc-600">
            {s.zReady && s.meanGapPp != null && s.stdGapPp != null
              ? `μ ${fmtPp(s.meanGapPp)} · σ ${s.stdGapPp.toFixed(1)}pp`
              : `need ${FVG_MIN_SAMPLES_FOR_MEAN} gap samples`}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800/50 bg-black/25 px-2 py-1.5">
          <div className="text-[8px] font-bold uppercase text-zinc-500">Edge</div>
          <div className="font-mono text-sm font-bold tabular-nums text-violet-200">{fmtPp(s.edgePp)}</div>
          <div className="text-[9px] text-zinc-600">P_model − P_market</div>
        </div>
        <div className="rounded-lg border border-zinc-800/50 bg-black/25 px-2 py-1.5 sm:col-span-2 lg:col-span-1">
          <div className="text-[8px] font-bold uppercase text-zinc-500">Signal</div>
          <div
            className={`font-mono text-lg font-black tabular-nums ${
              s.signal != null && s.signal > FVG_SIGNAL_WEAK_THRESHOLD
                ? 'text-emerald-300'
                : s.signal != null && s.signal < -FVG_SIGNAL_WEAK_THRESHOLD
                  ? 'text-rose-300'
                  : 'text-zinc-200'
            }`}
          >
            {s.signal != null ? (s.signal >= 0 ? '+' : '') + s.signal.toFixed(1) : '—'}
          </div>
          <div className="text-[9px] text-zinc-600">Z × edge (pp)</div>
        </div>
      </div>

      <p className="mt-2 text-[10px] leading-snug text-zinc-500">{s.detail}</p>
      <p className="mt-1 text-[9px] text-zinc-600">
        Rules: &gt;+{FVG_SIGNAL_STRONG_THRESHOLD} buy {upLabel} · +{FVG_SIGNAL_WEAK_THRESHOLD}…+{FVG_SIGNAL_STRONG_THRESHOLD}{' '}
        small {upLabel} · ±{FVG_SIGNAL_WEAK_THRESHOLD} flat · −{FVG_SIGNAL_STRONG_THRESHOLD}…−{FVG_SIGNAL_WEAK_THRESHOLD} small{' '}
        {downLabel} · &lt;−{FVG_SIGNAL_STRONG_THRESHOLD} buy {downLabel}
      </p>
    </div>
  );
}

function FairValueSimpleBox(props: {
  marketUp: number;
  fairUp: number;
  ptbUsd: number;
  modelPUp: number;
  stableHeader: StableProjectedHeaderSnapshot | null;
  edgeSides: FairValueSimpleReadout;
  yesLabel: string;
  noLabel: string;
}): ReactElement {
  const { marketUp, fairUp, ptbUsd, modelPUp, stableHeader, edgeSides, yesLabel, noLabel } = props;
  const gapPp = edgeSides.gapPp;
  const gapTone = gapPp > 0.3 ? 'text-emerald-300' : gapPp < -0.3 ? 'text-rose-300' : 'text-zinc-300';
  const favoredTone =
    edgeSides.favored === 'yes' ? 'border-emerald-600/55 bg-emerald-950/35' : edgeSides.favored === 'no' ? 'border-rose-600/55 bg-rose-950/35' : 'border-zinc-600/55 bg-zinc-900/40';

  const row = (label: string, value: ReactNode, hint?: string) => (
    <div className="flex items-baseline justify-between gap-3 border-b border-zinc-800/40 py-2 last:border-0">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold text-zinc-300">{label}</div>
        {hint ? <div className="text-[9px] text-zinc-600">{hint}</div> : null}
      </div>
      <div className="shrink-0 text-right font-mono text-sm font-bold tabular-nums text-zinc-50">{value}</div>
    </div>
  );

  return (
    <div className="rounded-2xl border border-cyan-800/45 bg-gradient-to-br from-cyan-950/25 to-zinc-950/80 p-3 sm:p-4">
      <div className="text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300/90">Fair value</div>

      <div className="mt-2 rounded-xl border border-zinc-800/55 bg-black/30 px-3 py-1">
        {row('Market price', fmtCents(marketUp), 'Contract mid (implied)')}
        {row('PTB (fair estimate)', fmtCents(fairUp), `Desk model · spot PTB ${fmtUsd(ptbUsd)}`)}
        {row(
          'Projected 30s move',
          stableHeader ? (
            <span>
              {fmtUsd(stableHeader.projectedSpotUsd)}{' '}
              <span className="text-[11px] font-semibold text-indigo-300/90">({fmtUsdSigned(stableHeader.deltaVsNowUsd)})</span>
            </span>
          ) : (
            '—'
          ),
          'Linear spot extrapolation',
        )}
        {row('Model P(Up)', fmtProbPct01(modelPUp), 'Settlement bias σ(score)')}
        {row(
          'Fair value gap',
          <span className={gapTone}>{fmtPp(gapPp)}</span>,
          'PTB fair − market price',
        )}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div
          className={`rounded-xl border px-3 py-2.5 text-center ${
            edgeSides.favored === 'yes' ? 'border-emerald-600/50 bg-emerald-950/30 ring-1 ring-emerald-500/25' : 'border-zinc-800/50 bg-black/25'
          }`}
        >
          <div className="text-[9px] font-bold uppercase tracking-wide text-zinc-500">{yesLabel}</div>
          <div
            className={`mt-1 font-mono text-lg font-black tabular-nums ${
              edgeSides.yesEdgePp > 0 ? 'text-emerald-300' : edgeSides.yesEdgePp < 0 ? 'text-rose-300/80' : 'text-zinc-400'
            }`}
          >
            {fmtPp(edgeSides.yesEdgePp)}
          </div>
          <div className="text-[9px] text-zinc-600">edge vs market</div>
        </div>
        <div
          className={`rounded-xl border px-3 py-2.5 text-center ${
            edgeSides.favored === 'no' ? 'border-rose-600/50 bg-rose-950/30 ring-1 ring-rose-500/25' : 'border-zinc-800/50 bg-black/25'
          }`}
        >
          <div className="text-[9px] font-bold uppercase tracking-wide text-zinc-500">{noLabel}</div>
          <div
            className={`mt-1 font-mono text-lg font-black tabular-nums ${
              edgeSides.noEdgePp > 0 ? 'text-emerald-300' : edgeSides.noEdgePp < 0 ? 'text-rose-300/80' : 'text-zinc-400'
            }`}
          >
            {fmtPp(edgeSides.noEdgePp)}
          </div>
          <div className="text-[9px] text-zinc-600">edge vs market</div>
        </div>
      </div>

      <div className={`mt-3 rounded-xl border px-3 py-2.5 text-center ${favoredTone}`}>
        <div className="text-[9px] font-bold uppercase tracking-[0.14em] opacity-80">Larger edge</div>
        <div className="mt-1 text-base font-black leading-tight">{edgeSides.favoredLabel}</div>
        <div className="mt-1 text-[10px] leading-snug opacity-90">{edgeSides.favoredDetail}</div>
      </div>
    </div>
  );
}

function FairValueGapCard(props: { fvg: FairValueGapReadout; upLabel: string }): ReactElement {
  const { fvg, upLabel } = props;
  return (
    <div className="min-w-0 space-y-2 text-[10px] leading-snug text-zinc-400">
      <p>
        <span className="font-semibold text-zinc-300">Expected</span> = desk P({upLabel}){' '}
        <span className="font-mono text-violet-200">{fmtProbPct01(fvg.pExpected)}</span>
        {' · '}
        <span className="font-semibold text-zinc-300">Actual</span> = market mid{' '}
        <span className="font-mono text-zinc-200">{fmtProbPct01(fvg.pActual)}</span>
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-zinc-800/50 bg-black/25 px-2 py-1.5">
          <div className="text-[8px] font-bold uppercase text-zinc-500">Raw gap</div>
          <div className="font-mono text-sm font-bold tabular-nums text-cyan-200">{fmtEdgePp(fvg.rawGap)}</div>
          <div className="text-[9px] text-zinc-600">expected − actual</div>
        </div>
        <div className="rounded-lg border border-zinc-800/50 bg-black/25 px-2 py-1.5">
          <div className="text-[8px] font-bold uppercase text-zinc-500">Mean gap</div>
          <div className="font-mono text-sm font-bold tabular-nums text-zinc-300">
            {fvg.meanGapPp != null ? fmtEdgePp(fvg.meanGap!) : '—'}
          </div>
          <div className="text-[9px] text-zinc-600">
            {fvg.meanReady ? `${fvg.sampleCount} samples` : `need ${FVG_MIN_SAMPLES_FOR_MEAN}`}
          </div>
        </div>
        <div className="rounded-lg border border-zinc-800/50 bg-black/25 px-2 py-1.5">
          <div className="text-[8px] font-bold uppercase text-zinc-500">Gap − mean</div>
          <div className="font-mono text-sm font-bold tabular-nums text-amber-200">{fmtEdgePp(fvg.gapFromMean)}</div>
          <div className="text-[9px] text-zinc-600">demeaned mispricing</div>
        </div>
        <div className="rounded-lg border border-zinc-800/50 bg-black/25 px-2 py-1.5">
          <div className="text-[8px] font-bold uppercase text-zinc-500">Fair vs odds</div>
          <div className="font-mono text-sm font-bold tabular-nums text-emerald-200">{fmtProbPct01(fvg.fairValueUp)}</div>
          <div className="text-[9px] text-zinc-600">{fmtEdgePp(fvg.fairEdge)} on market</div>
        </div>
      </div>
      <p className="text-zinc-500">{fvg.summary}</p>
    </div>
  );
}

function AngleChip(props: { label: string; value: string; tone?: 'up' | 'down' | 'flat' | 'warn' }): ReactElement {
  const toneCls =
    props.tone === 'up'
      ? 'border-emerald-700/50 bg-emerald-950/30 text-emerald-100'
      : props.tone === 'down'
        ? 'border-rose-700/50 bg-rose-950/30 text-rose-100'
        : props.tone === 'warn'
          ? 'border-amber-700/50 bg-amber-950/30 text-amber-100'
          : 'border-zinc-700/60 bg-zinc-900/40 text-zinc-200';
  return (
    <div className={`rounded-lg border px-2.5 py-2 ${toneCls}`}>
      <div className="text-[8px] font-bold uppercase tracking-[0.12em] opacity-70">{props.label}</div>
      <div className="mt-0.5 text-[11px] font-semibold leading-snug">{props.value}</div>
    </div>
  );
}

export function NowPriceSignalsPanel(props: {
  slug?: string;
  spot: SpotPoint[];
  priceToBeat: number | null;
  endsInMs?: number | null;
  bandGauge?: SpotBandGaugeSnapshot | null;
  ptbContext?: {
    bandUsd: number;
    slopeUsdPerSec: number;
    slopeUsdPerMin: number;
    distanceUsd: number;
    position: string;
    controlSignal: string;
    momentum: string;
  } | null;
  machineReadout?: SpotPtbMachineReadout | null;
  tape?: TapeVelocity | null;
  probUp?: SpotPoint[];
  probDown?: SpotPoint[];
  upLabel: string;
  downLabel: string;
  spotBookAlignment?: { align: string; above: boolean; below: boolean } | null;
  physicsLine?: string | null;
  probLastUpdateMs?: number | null;
  booksFetchedAt?: number | null;
  buySideAdvisory?: BuySideAdvisory | null;
  bookTouchUp?: BookTouchForArmRisk | null;
  bookTouchDown?: BookTouchForArmRisk | null;
}): ReactElement {
  const {
    slug = 'unknown',
    spot,
    priceToBeat,
    endsInMs,
    bandGauge,
    ptbContext,
    machineReadout,
    tape,
    probUp = [],
    probDown = [],
    upLabel,
    downLabel,
    spotBookAlignment,
    physicsLine,
    probLastUpdateMs,
    booksFetchedAt = null,
    buySideAdvisory = null,
    bookTouchUp = null,
    bookTouchDown = null,
  } = props;

  const spotLast = spot.length ? spot[spot.length - 1]!.v : null;
  const lastProbUp = probUp.length ? (probUp[probUp.length - 1]!.v ?? null) : null;
  const lastProbDown = probDown.length ? (probDown[probDown.length - 1]!.v ?? null) : null;

  const bandUsd =
    bandGauge != null
      ? (bandGauge.bandHi - bandGauge.bandLo) / 2
      : ptbContext?.bandUsd ?? null;

  const bandDistances = useMemo(() => {
    if (spotLast == null || priceToBeat == null || bandUsd == null) return null;
    return buildNowPriceBandDistances({ now: spotLast, ptb: priceToBeat, bandUsd });
  }, [spotLast, priceToBeat, bandUsd]);

  const glance = useMemo(() => (bandDistances ? buildSpotBandGlance(bandDistances) : null), [bandDistances]);

  const slopeUsdPerMin =
    ptbContext?.slopeUsdPerMin ??
    (bandGauge?.slopeUsdPerMin != null && Number.isFinite(bandGauge.slopeUsdPerMin) ? bandGauge.slopeUsdPerMin : null);
  const slopeUsdPerSec =
    ptbContext?.slopeUsdPerSec ??
    (slopeUsdPerMin != null && Number.isFinite(slopeUsdPerMin) ? slopeUsdPerMin / 60 : 0);

  const projectionWindow = useMemo(() => {
    if (bandDistances == null) return [];
    return buildProjectionNowWindow({
      now: bandDistances.now,
      slopeUsdPerSec,
      bandHi: bandDistances.bandHi,
      bandLo: bandDistances.bandLo,
      distAboveFromPtb: bandDistances.distAboveFromPtb,
      distBelowFromPtb: bandDistances.distBelowFromPtb,
      endsInMs,
    });
  }, [bandDistances, slopeUsdPerSec, endsInMs]);

  const stableHeader = useMemo(() => {
    if (spotLast == null) return null;
    return computeStableProjectedHeader({
      spotLast,
      slopeUsdPerSec,
      ptb: priceToBeat,
      lastProbUp,
      lastProbDown,
      upLabel,
      downLabel,
      horizonSec: 30,
    });
  }, [spotLast, slopeUsdPerSec, priceToBeat, lastProbUp, lastProbDown, upLabel, downLabel]);

  const pricePrediction = useMemo(() => {
    if (spotLast == null || priceToBeat == null) return null;
    return computePricePredictionSignal({
      spotUsd: spotLast,
      slopeUsdPerSec,
      ptbUsd: priceToBeat,
      bandUsd,
      horizonSec: 30,
      upLabel,
      downLabel,
    });
  }, [bandUsd, downLabel, priceToBeat, slopeUsdPerSec, spotLast, upLabel]);

  const probTicksUpEarly = useMemo(
    () =>
      probUp
        .filter((p) => p.v != null && Number.isFinite(p.v))
        .map((p) => ({ t: p.t, v: p.v! })),
    [probUp],
  );
  const probTicksDownEarly = useMemo(
    () =>
      probDown
        .filter((p) => p.v != null && Number.isFinite(p.v))
        .map((p) => ({ t: p.t, v: p.v! })),
    [probDown],
  );

  const contractProbGrid = useMemo(() => {
    return buildContractProbProjectionGrid({
      probUpPts: probTicksUpEarly,
      probDownPts: probTicksDownEarly,
      nowUp01: lastProbUp,
      nowDown01: lastProbDown,
      tapeNetPressure: tape?.netPressure ?? null,
    });
  }, [probTicksUpEarly, probTicksDownEarly, lastProbUp, lastProbDown, tape?.netPressure]);

  const pricePredictionDisplay = useMemo(() => {
    if (!pricePrediction) return null;
    if (!contractProbGrid) return pricePrediction;
    return enrichPricePredictionWithContracts(pricePrediction, contractProbGrid, upLabel, downLabel);
  }, [pricePrediction, contractProbGrid, upLabel, downLabel]);

  const normLive = useMemo(
    () => normalizeBinaryFlexible(lastProbUp, lastProbDown),
    [lastProbUp, lastProbDown],
  );

  const probTicksUp = probTicksUpEarly;
  const probTicksDown = probTicksDownEarly;

  const recentDeltaUp01 = useMemo(() => recentProbDelta01(probTicksUp, 30_000), [probTicksUp]);
  const recentDeltaDown01 = useMemo(() => recentProbDelta01(probTicksDown, 30_000), [probTicksDown]);

  const marketUpdatedAtMs = useMemo(
    () => maxFeedMs(probLastUpdateMs, booksFetchedAt, lastPointMs(probTicksUp), lastPointMs(probTicksDown)),
    [booksFetchedAt, probLastUpdateMs, probTicksDown, probTicksUp],
  );

  const normNow = normLive;
  const binaryBias = useMemo(() => {
    if (spotLast == null || priceToBeat == null) return null;
    return estimateBinaryOutcomeBias({
      now: spotLast,
      ptb: priceToBeat,
      spotPts: spot,
      pUp01: normLive.up ?? lastProbUp,
      slopeUsdPerSec,
      bandUsd,
      horizonSec: 30,
    });
  }, [spotLast, priceToBeat, spot, normLive.up, lastProbUp, slopeUsdPerSec, bandUsd]);

  const pMktUp = normLive.up ?? lastProbUp;
  const pMktDown = normLive.down ?? lastProbDown;

  const { samples: fvgSamples, readout: fairValueGap } = useFairValueGap({
    slug,
    spot,
    priceToBeat,
    pMktUp,
    probUp01: lastProbUp,
    probDown01: lastProbDown,
    enabled: true,
  });

  const edgeScalp = useMemo(() => {
    if (binaryBias == null || pMktUp == null || spotLast == null || priceToBeat == null) return null;
    return evaluateProbabilityEdgeScalp({
      estimate: binaryBias,
      pMkt: pMktUp,
      spotPts: spot,
      now: spotLast,
      ptb: priceToBeat,
      probUpDelta01: recentDeltaUp01,
      probDownDelta01: recentDeltaDown01,
      upLabel,
      downLabel,
      fairValueGap,
    });
  }, [binaryBias, pMktUp, spot, spotLast, priceToBeat, recentDeltaUp01, recentDeltaDown01, upLabel, downLabel, fairValueGap]);

  const deskSpeedConfirm = useMemo(() => {
    if (spotLast == null || priceToBeat == null) return null;
    return computeDeskSpeedSnapshot({
      spotPts: spot,
      nowSpot: spotLast,
      ptb: priceToBeat,
      probUpPts: probUp.map((p) => ({ t: p.t, v: p.v ?? null })),
      probDownPts: probDown.map((p) => ({ t: p.t, v: p.v ?? null })),
      pMktUp,
      pMktDown,
      upLabel,
      downLabel,
      horizonSec: PRESSURE_CONFIRM_HORIZON_SEC,
    });
  }, [spotLast, priceToBeat, spot, probUp, probDown, pMktUp, pMktDown, upLabel, downLabel]);

  const deskSpeedEarly = useMemo(() => {
    if (spotLast == null || priceToBeat == null) return null;
    return computeDeskSpeedSnapshot({
      spotPts: spot,
      nowSpot: spotLast,
      ptb: priceToBeat,
      probUpPts: probUp.map((p) => ({ t: p.t, v: p.v ?? null })),
      probDownPts: probDown.map((p) => ({ t: p.t, v: p.v ?? null })),
      pMktUp,
      pMktDown,
      upLabel,
      downLabel,
      horizonSec: PRESSURE_EARLY_HORIZON_SEC,
    });
  }, [spotLast, priceToBeat, spot, probUp, probDown, pMktUp, pMktDown, upLabel, downLabel]);

  const contractEarlyJumps = useMemo(
    () => ({
      up:
        deskSpeedEarly && pMktUp != null
          ? computeContractEntryJump({
              prob: deskSpeedEarly.lanes.up.prob,
              now01: pMktUp,
              horizonSec: PRESSURE_EARLY_HORIZON_SEC,
              outcomeLabel: upLabel,
            })
          : null,
      down:
        deskSpeedEarly && pMktDown != null
          ? computeContractEntryJump({
              prob: deskSpeedEarly.lanes.down.prob,
              now01: pMktDown,
              horizonSec: PRESSURE_EARLY_HORIZON_SEC,
              outcomeLabel: downLabel,
            })
          : null,
    }),
    [deskSpeedEarly, pMktUp, pMktDown, upLabel, downLabel],
  );

  const deskSpeed = deskSpeedConfirm;

  const fvgSignal = useMemo(() => {
    if (fairValueGap == null) return null;
    return computeFairValueGapSignal({
      fvg: fairValueGap,
      samples: fvgSamples,
      pModel: binaryBias?.probUp,
    });
  }, [fairValueGap, fvgSamples, binaryBias?.probUp]);

  const contractLag = useMemo(() => {
    if (binaryBias == null || pMktUp == null || pMktDown == null || bandDistances == null) return null;
    return computeContractLagReadout({
      modelPUp: binaryBias.probUp,
      marketUp: pMktUp,
      marketDown: pMktDown,
      probUpDelta01: recentDeltaUp01,
      probDownDelta01: recentDeltaDown01,
      edgePp: (binaryBias.probUp - pMktUp) * 100,
      geo: bandDistances.geo,
      upLabel,
      downLabel,
      marketUpdatedAtMs,
    });
  }, [
    binaryBias,
    pMktUp,
    pMktDown,
    bandDistances,
    recentDeltaUp01,
    recentDeltaDown01,
    marketUpdatedAtMs,
    upLabel,
    downLabel,
  ]);

  const [spotOpen, setSpotOpen] = useState(false);
  const [layersOpen, setLayersOpen] = useState(false);

  const fairValueSimple = useMemo(() => {
    if (binaryBias == null || pMktUp == null) return null;
    const fairUp = fairValueGap?.pExpected ?? binaryBias.probUp;
    return {
      fairUp,
      edgeSides: computeFairValueEdgeSides({
        fairUp,
        marketUp: pMktUp,
        yesLabel: upLabel,
        noLabel: downLabel,
      }),
    };
  }, [binaryBias, fairValueGap?.pExpected, pMktUp, upLabel, downLabel]);

  const bilateralEdgeSnap = useMemo(
    () =>
      computeBilateralEdge({
        modelPUp: binaryBias?.probUp ?? fairValueSimple?.fairUp ?? null,
        pMktUp,
        pMktDown,
      }),
    [binaryBias?.probUp, fairValueSimple?.fairUp, pMktUp, pMktDown],
  );

  const mtfConsensus = useMemo(() => {
    if (bandUsd == null || spot.length < 4) return null;
    return buildMtfConsensus(spot, bandUsd);
  }, [spot, bandUsd]);

  const pressureBuildup = useMemo(
    () =>
      deskSpeedEarly && deskSpeedConfirm && spotLast != null
        ? computePressureBuildup(deskSpeedEarly, deskSpeedConfirm, {
            mtf: mtfConsensus,
            upLabel,
            downLabel,
            nowSpot: spotLast,
            pMktUp: pMktUp,
            pMktDown: pMktDown,
          })
        : null,
    [deskSpeedEarly, deskSpeedConfirm, mtfConsensus, upLabel, downLabel, spotLast, pMktUp, pMktDown],
  );

  const directionScore = useMemo(
    () =>
      deskSpeed && spotLast != null
        ? computeDirectionScore(deskSpeed, upLabel, downLabel, {
            nowSpot: spotLast,
            pMktUp: pMktUp,
            pMktDown: pMktDown,
          })
        : null,
    [deskSpeed, upLabel, downLabel, spotLast, pMktUp, pMktDown],
  );

  const directionEngine = useMemo(() => {
    if (bandDistances == null) return null;
    const edgePp =
      binaryBias != null && pMktUp != null
        ? (binaryBias.probUp - pMktUp) * 100
        : fairValueGap?.rawGapPp ?? null;
    return computeDirectionEngine({
      geo: bandDistances.geo,
      modelPUp: binaryBias?.probUp ?? fairValueSimple?.fairUp ?? null,
      pMktUp,
      pMktDown,
      deskSpeed,
      machine: machineReadout ?? null,
      mtf: mtfConsensus,
      edgePp,
      contractLag: contractLag ?? undefined,
      repricingIntoEdge: edgeScalp?.repricingIntoEdge ?? contractLag?.repricingIntoEdge ?? null,
      upLabel,
      downLabel,
    });
  }, [
    bandDistances,
    binaryBias,
    pMktUp,
    pMktDown,
    fairValueGap?.rawGapPp,
    fairValueSimple?.fairUp,
    deskSpeed,
    machineReadout,
    mtfConsensus,
    contractLag,
    edgeScalp?.repricingIntoEdge,
    upLabel,
    downLabel,
  ]);

  const executionInputBase = useMemo(() => {
    if (bandDistances == null) return null;
    const modelPUp = binaryBias?.probUp ?? fairValueSimple?.fairUp ?? null;
    const bilateral = computeBilateralEdge({
      modelPUp,
      pMktUp,
      pMktDown,
    });
    const earlyJumpUp = deskSpeedEarly
      ? computeContractEntryJump({
          prob: deskSpeedEarly.lanes.up.prob,
          now01: pMktUp,
          horizonSec: PRESSURE_EARLY_HORIZON_SEC,
          outcomeLabel: upLabel,
        })
      : null;
    const earlyJumpDown = deskSpeedEarly
      ? computeContractEntryJump({
          prob: deskSpeedEarly.lanes.down.prob,
          now01: pMktDown,
          horizonSec: PRESSURE_EARLY_HORIZON_SEC,
          outcomeLabel: downLabel,
        })
      : null;
    const laneHint = pickEdgeLaneHint(bilateral.edgeUpPp, bilateral.edgeDownPp, 20);
    const strongerSide = pickStrongerEdgeSide(bilateral.edgeUpPp, bilateral.edgeDownPp);
    const earlyGain =
      laneHint === 'down' || (laneHint == null && strongerSide === 'down')
        ? earlyJumpDown?.gainCents ?? null
        : earlyJumpUp?.gainCents ?? null;

    return {
      geo: bandDistances.geo,
      modelPUp,
      pMktUp,
      pMktDown,
      edgePp: bilateral.edgeUpPp,
      deskSpeedEarly,
      deskSpeedConfirm: deskSpeedConfirm,
      machine: machineReadout ?? null,
      mtf: mtfConsensus,
      probUpDelta01: recentDeltaUp01,
      probDownDelta01: recentDeltaDown01,
      spotPts: spot.map((p) => ({ t: p.t, v: p.v })),
      nowSpotUsd: spotLast,
      earlyProbGainCents: earlyGain,
      pressureTiming: pressureBuildup?.timing ?? null,
      upLabel,
      downLabel,
    };
  }, [
    bandDistances,
    binaryBias,
    pMktUp,
    pMktDown,
    fairValueGap?.rawGapPp,
    fairValueSimple?.fairUp,
    deskSpeedEarly,
    deskSpeedConfirm,
    machineReadout,
    mtfConsensus,
    recentDeltaUp01,
    recentDeltaDown01,
    spot,
    spotLast,
    pressureBuildup?.timing,
    upLabel,
    downLabel,
  ]);

  const execConfirm = useExecutionConfirmTracker(executionInputBase);

  const executionSignal = useMemo(() => {
    if (!executionInputBase) return null;
    return computeExecutionSignal({
      ...executionInputBase,
      confirmHeldMs: execConfirm?.confirmHeldMs ?? 0,
    });
  }, [executionInputBase, execConfirm?.confirmHeldMs]);

  const entryMoment = useMemo(
    () =>
      computeEntryMoment({
        advisory: buySideAdvisory ?? null,
        execution: executionSignal,
        machine: machineReadout ?? null,
        pressureTiming: pressureBuildup?.timing ?? null,
        contractLead: pressureBuildup?.contractLead ?? null,
        upLabel,
        downLabel,
      }),
    [buySideAdvisory, executionSignal, machineReadout, pressureBuildup?.timing, pressureBuildup?.contractLead, upLabel, downLabel],
  );

  const speedHint = pressureBuildup
    ? pressureBuildupShortLabel(pressureBuildup)
    : directionScore
      ? directionScoreShortLabel(directionScore)
      : null;

  const tradeCall = edgeScalp
    ? edgeScalp.scalpSignal === 'LONG_UP'
      ? `LONG ${upLabel}`
      : edgeScalp.scalpSignal === 'LONG_DOWN'
        ? `LONG ${downLabel}`
        : 'NO TRADE'
    : machineReadout?.focusLane
      ? `LEAN ${machineReadout.focusLane === 'up' ? upLabel : downLabel}`
      : 'WAIT';

  const heroMetricsCtx: HeroMetricsCtx = useMemo(
    () => ({
      directionEngine,
      bilateral: bilateralEdgeSnap,
      jumps: contractEarlyJumps,
      contractLag,
    }),
    [directionEngine, bilateralEdgeSnap, contractEarlyJumps, contractLag],
  );

  const heroActiveLanePre = useMemo(
    () =>
      resolveHeroLane({
        executionSignal,
        directionEngine,
        tradeCall,
        upLabel,
        downLabel,
      }),
    [executionSignal, directionEngine, tradeCall, upLabel, downLabel],
  );

  const favoredTpOutlook = useMemo(() => {
    if (!heroActiveLanePre) return null;
    return laneTpOutlook({
      lane: heroActiveLanePre,
      touch: heroActiveLanePre === 'up' ? bookTouchUp : bookTouchDown,
      mid01: heroActiveLanePre === 'up' ? pMktUp : pMktDown,
      probSeries: heroActiveLanePre === 'up' ? probUp : probDown,
      endsInMs,
    });
  }, [heroActiveLanePre, bookTouchUp, bookTouchDown, pMktUp, pMktDown, probUp, probDown, endsInMs]);

  const deskTradeSignal = useMemo(
    () =>
      buildNowPriceDeskTradeSignal({
        execution: executionSignal,
        entryMoment,
        advisory: buySideAdvisory ?? null,
        directionEngine,
        tpOutlook: favoredTpOutlook,
        contractLead: pressureBuildup?.contractLead ?? null,
        pressureTiming: pressureBuildup?.timing ?? null,
        upLabel,
        downLabel,
      }),
    [executionSignal, entryMoment, buySideAdvisory, directionEngine, favoredTpOutlook, pressureBuildup?.contractLead, pressureBuildup?.timing, upLabel, downLabel],
  );

  const aheadPlaybook = useMemo(() => {
    const lane = deskTradeSignal.lane ?? heroActiveLanePre;
    const touch = lane === 'up' ? bookTouchUp : lane === 'down' ? bookTouchDown : null;
    return buildDeskAheadPlaybook({
      signal: deskTradeSignal,
      entryMoment,
      contractLead: pressureBuildup?.contractLead ?? null,
      pressureTiming: pressureBuildup?.timing ?? null,
      bandGauge: bandGauge ?? null,
      band: bandDistances,
      execution: executionSignal,
      advisory: buySideAdvisory ?? null,
      bid01: touch?.bestBid ?? null,
      ask01: touch?.bestAsk ?? null,
    });
  }, [
    deskTradeSignal,
    entryMoment,
    pressureBuildup?.contractLead,
    pressureBuildup?.timing,
    bandGauge,
    bandDistances,
    executionSignal,
    buySideAdvisory,
    heroActiveLanePre,
    bookTouchUp,
    bookTouchDown,
  ]);

  const heroSignal = useMemo(
    () => ({
      ...deskTradeSignalToHeroView(deskTradeSignal, heroMetricsCtx),
      aheadPlaybook,
    }),
    [deskTradeSignal, heroMetricsCtx, aheadPlaybook],
  );

  const heroActiveLane: 'up' | 'down' | null = deskTradeSignal.lane ?? heroActiveLanePre;

  if (spotLast == null || priceToBeat == null || bandDistances == null || !glance) {
    return (
      <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/40 px-4 py-8 text-center text-sm text-zinc-500">
        Load PTB and live spot ticks to open the Now Price Signals window.
      </div>
    );
  }

  const geoTone: GlanceTone =
    bandDistances.geo === 'ABOVE' ? 'up' : bandDistances.geo === 'BELOW' ? 'down' : 'warn';

  const headlineEdgePp =
    upEdgePp(binaryBias?.probUp ?? null, pMktUp) ??
    (edgeScalp?.edge != null ? edgeScalp.edge * 100 : null) ??
    fairValueGap?.rawGapPp ??
    null;

  const machineHint =
    machineReadout != null
      ? `${machineReadout.agreementScore}% ${machineReadout.focusLane?.toUpperCase() ?? 'SPLIT'}`
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-zinc-800/60 bg-[#0b1018] p-3 sm:p-4">
      <DeskCatchStrip playbook={heroSignal.aheadPlaybook} />
      <NowPriceHeroSignalBanner view={heroSignal} />

      <NowPriceQuickContextStrip
        band={bandDistances}
        glance={glance}
        geoTone={geoTone}
        upLabel={upLabel}
        downLabel={downLabel}
        probUp01={pMktUp}
        probDown01={pMktDown}
        probUpDelta01={recentDeltaUp01}
        probDownDelta01={recentDeltaDown01}
        modelPUp={binaryBias?.probUp ?? null}
        edgeUpPp={bilateralEdgeSnap.edgeUpPp}
        edgeDownPp={bilateralEdgeSnap.edgeDownPp}
        activeLane={heroActiveLane}
        speedHint={speedHint}
        machineHint={machineHint}
        endsInMs={endsInMs}
        slopeUsdPerMin={slopeUsdPerMin}
      />

      <NowPriceBuyStrip
        slug={slug}
        upLabel={upLabel}
        downLabel={downLabel}
        buySideAdvisory={buySideAdvisory}
        probUp={probUp}
        probDown={probDown}
        midUp01={pMktUp}
        midDown01={pMktDown}
        bookTouchUp={bookTouchUp}
        bookTouchDown={bookTouchDown}
        endsInMs={endsInMs}
        leanLane={heroActiveLane}
        entryMoment={entryMoment}
        deskTradeSignal={deskTradeSignal}
        contractLead={pressureBuildup?.contractLead ?? null}
        pressureTiming={pressureBuildup?.timing ?? null}
      />

      <details className="rounded-xl border border-zinc-800/50 bg-zinc-950/30 px-3 py-2">
        <summary className="cursor-pointer text-sm font-semibold text-zinc-500 hover:text-zinc-300 sm:text-base">
          Spot tape · projections · timers
        </summary>
        <div className="mt-2">
          <PriceHeadlineRow
            spotUsd={bandDistances.now}
            ptbUsd={bandDistances.ptb}
            distVsPtb={bandDistances.distNowFromPtb}
            spotProjections={pricePrediction?.projections ?? null}
            upLabel={upLabel}
            downLabel={downLabel}
            probUp01={pMktUp}
            probDown01={pMktDown}
            probUpDelta01={recentDeltaUp01}
            probDownDelta01={recentDeltaDown01}
            modelPUp={binaryBias?.probUp ?? null}
            edgePp={headlineEdgePp}
          />
        </div>
      </details>

      {pricePredictionDisplay ? (
        <PricePredictionSignalCard
          signal={pricePredictionDisplay}
          contractProb={contractProbGrid}
          upLabel={upLabel}
          downLabel={downLabel}
        />
      ) : null}

      {directionEngine ? (
        <details className="rounded-xl border border-zinc-800/50 bg-zinc-950/30 px-3 py-2" open>
          <summary className="cursor-pointer text-sm font-semibold text-zinc-500 hover:text-zinc-300 sm:text-base">
            Direction engine breakdown
          </summary>
          <div className="mt-2">
            <DirectionEngineCard signal={directionEngine} />
          </div>
        </details>
      ) : null}

      {executionSignal ? (
        <details className="rounded-xl border border-zinc-800/50 bg-zinc-950/30 px-3 py-2" open>
          <summary className="cursor-pointer text-sm font-semibold text-zinc-500 hover:text-zinc-300 sm:text-base">
            Execution gates
          </summary>
          <div className="mt-2">
            <ExecutionSignalCard signal={executionSignal} />
          </div>
        </details>
      ) : null}

      {contractLag ? (
        <ContractLagBox
          lag={contractLag}
          upLabel={upLabel}
          downLabel={downLabel}
          distVsPtb={bandDistances.distNowFromPtb}
          probTicksUp={probTicksUp}
          probTicksDown={probTicksDown}
        />
      ) : null}

      {fairValueSimple && binaryBias != null && pMktUp != null ? (
        <FairValueSimpleBox
          marketUp={pMktUp}
          fairUp={fairValueSimple.fairUp}
          ptbUsd={priceToBeat}
          modelPUp={binaryBias.probUp}
          stableHeader={stableHeader}
          edgeSides={fairValueSimple.edgeSides}
          yesLabel={upLabel.toLowerCase() === 'up' ? 'YES' : upLabel}
          noLabel={downLabel.toLowerCase() === 'down' ? 'NO' : downLabel}
        />
      ) : null}

      <details className="rounded-xl border border-zinc-800/50 bg-zinc-950/30 px-3 py-2">
        <summary className="cursor-pointer text-[10px] font-semibold text-zinc-500 hover:text-zinc-300">
          More signals (pressure, direction score, machine)
        </summary>
        <div className="mt-2 space-y-2.5">
          {pressureBuildup ? (
            <PressureBuildupCard pressure={pressureBuildup} upLabel={upLabel} downLabel={downLabel} />
          ) : null}
          {directionScore ? <DirectionScoreCard score={directionScore} upLabel={upLabel} downLabel={downLabel} /> : null}
        </div>
      </details>

      {physicsLine ? (
        <p className="rounded-lg border border-violet-800/30 bg-violet-950/15 px-2.5 py-2 text-[11px] leading-snug text-violet-100/90">
          {physicsLine}
        </p>
      ) : null}

      {machineReadout ? (
        <details className="rounded-xl border border-zinc-800/50 bg-zinc-950/30 px-3 py-2">
          <summary className="cursor-pointer text-[10px] font-semibold text-zinc-500 hover:text-zinc-300">
            Machine sensor breakdown
          </summary>
          <div className="mt-2">
            <MachineVerdictCard readout={machineReadout} physicsLine={null} compact minimal />
          </div>
        </details>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          className="rounded-lg border border-zinc-700/60 bg-zinc-900/80 px-2.5 py-1 text-[10px] font-semibold text-zinc-300 hover:bg-zinc-800/80"
          onClick={() => {
            const next = !(spotOpen && layersOpen);
            setSpotOpen(next);
            setLayersOpen(next);
          }}
        >
          {spotOpen && layersOpen ? 'Collapse all' : 'Expand all layers'}
        </button>
      </div>

      <details className="rounded-xl border border-zinc-800/55 bg-zinc-950/30" open={spotOpen}>
        <summary className="cursor-pointer list-none px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] text-zinc-400 marker:content-none [&::-webkit-details-marker]:hidden">
          Spot geometry · UP/DOWN breaks · PTB ladder
        </summary>
        <div className="space-y-2 border-t border-zinc-800/50 px-3 py-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <ConfirmedDistanceBox kind="above" band={bandDistances} glance={glance.upBreak} />
            <ConfirmedDistanceBox kind="below" band={bandDistances} glance={glance.downBreak} />
            <NowWindowSummary band={bandDistances} glance={glance} />
          </div>
          <PtbLadderBar band={bandDistances} />
        </div>
      </details>

      <details className="rounded-xl border border-zinc-800/55 bg-zinc-950/30" open={layersOpen}>
        <summary className="cursor-pointer list-none px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.14em] text-zinc-400 marker:content-none [&::-webkit-details-marker]:hidden">
          All signal layers — speed · model · edge · projections · sensors
        </summary>
        <div className="space-y-2 border-t border-zinc-800/50 px-3 py-3">
          {deskSpeed ? (
            <DeepLayerBlock title={`Speed layers · ${deskSpeed.horizonSec}s · UP / DOWN split`}>
              <DeskSpeedLayersCard speed={deskSpeed} embedded />
            </DeepLayerBlock>
          ) : null}

          {binaryBias ? (
            <DeepLayerBlock title="Settlement bias model">
              <BinaryOutcomeModelCard
                estimate={binaryBias}
                upLabel={upLabel}
                downLabel={downLabel}
                normMarketUp={pMktUp}
                embedded
              />
            </DeepLayerBlock>
          ) : null}

          {edgeScalp ? (
            <DeepLayerBlock title="Probability edge · scalp arb">
              <div className="mb-2">
                <SiglaChips siglas={edgeScalp.siglas} />
              </div>
              <ProbabilityEdgeScalpCard scalp={edgeScalp} upLabel={upLabel} downLabel={downLabel} embedded />
            </DeepLayerBlock>
          ) : null}

          {fairValueGap ? (
            <DeepLayerBlock title="Fair value gap (detail)">
              <FairValueGapCard fvg={fairValueGap} upLabel={upLabel} />
            </DeepLayerBlock>
          ) : null}

          {fvgSignal ? (
            <DeepLayerBlock title="FVG signal · Z-score">
              <FairValueGapSignalBox signal={fvgSignal} upLabel={upLabel} downLabel={downLabel} />
            </DeepLayerBlock>
          ) : null}

          <DeepLayerBlock title="Projected now window">
            <p className="mb-2 text-[10px] leading-snug text-zinc-500">
              Linear spot extrapolation from tick slope. Each horizon shows % toward confirmed above/below lines.
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:thin]">
              {projectionWindow.map((cell) => (
                <NowWindowCell key={cell.label} cell={cell} />
              ))}
            </div>
          </DeepLayerBlock>

          <DeepLayerBlock title="All angles">
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <AngleChip
            label="Spot geometry"
            value={`${bandDistances.geo.replace('_', ' ')} · ${fmtUsdSigned(bandDistances.distNowFromPtb)}`}
            tone={geoTone}
          />
          <AngleChip
            label="Candle momentum"
            value={ptbContext ? `${ptbContext.momentum} · ${ptbContext.position}` : '—'}
            tone={
              ptbContext?.momentum.includes('UP') ? 'up' : ptbContext?.momentum.includes('DOWN') ? 'down' : 'flat'
            }
          />
          <AngleChip
            label="Control signal"
            value={ptbContext?.controlSignal.replace(/_/g, ' ') ?? '—'}
            tone={
              ptbContext?.controlSignal.includes('UP')
                ? 'up'
                : ptbContext?.controlSignal.includes('DOWN')
                  ? 'down'
                  : 'warn'
            }
          />
          <AngleChip
            label="Tape"
            value={
              tape?.reliable
                ? `${tape.dominance.toUpperCase()} · ${tape.burst}${tape.microReliable ? ` · ${tape.acceleration}` : ''}`
                : 'Waiting for prints'
            }
            tone={tape?.dominance === 'buy' ? 'up' : tape?.dominance === 'sell' ? 'down' : 'flat'}
          />
          <AngleChip
            label={`${upLabel} implied`}
            value={lastProbUp != null ? `${(lastProbUp * 100).toFixed(1)}¢ mid` : '—'}
            tone="up"
          />
          <AngleChip
            label={`${downLabel} implied`}
            value={lastProbDown != null ? `${(lastProbDown * 100).toFixed(1)}¢ mid` : '—'}
            tone="down"
          />
          {edgeScalp ? (
            <AngleChip
              label="Prob edge"
              value={`${fmtEdgePp(edgeScalp.edge)} · ${edgeScalp.quality}`}
              tone={edgeScalp.edge > EDGE_TRADE_THRESHOLD ? 'up' : edgeScalp.edge < -EDGE_TRADE_THRESHOLD ? 'down' : 'flat'}
            />
          ) : null}
          {edgeScalp ? (
            <AngleChip
              label="Scalp SIG"
              value={
                edgeScalp.scalpSignal === 'LONG_UP'
                  ? `LONG ${upLabel}`
                  : edgeScalp.scalpSignal === 'LONG_DOWN'
                    ? `LONG ${downLabel}`
                    : 'NO TRADE'
              }
              tone={tradeTone(edgeScalp.scalpSignal)}
            />
          ) : null}
          {deskSpeed ? (
            <>
              <AngleChip
                label={`${upLabel} speed`}
                value={`${deskSpeed.lanes.up.alignment.replace('_', ' ')} · ${deskSpeed.lanes.up.supportScore >= 0 ? '+' : ''}${deskSpeed.lanes.up.supportScore}`}
                tone={alignmentTone(deskSpeed.lanes.up.alignment)}
              />
              <AngleChip
                label={`${downLabel} speed`}
                value={`${deskSpeed.lanes.down.alignment.replace('_', ' ')} · ${deskSpeed.lanes.down.supportScore >= 0 ? '+' : ''}${deskSpeed.lanes.down.supportScore}`}
                tone={alignmentTone(deskSpeed.lanes.down.alignment)}
              />
            </>
          ) : null}
          {deskSpeed?.lanes.up.prob ? (
            <AngleChip
              label="v_prob UP"
              value={formatProbSpeedPpMin(deskSpeed.lanes.up.prob.velocityPerMin)}
              tone={deskSpeed.lanes.up.prob.direction === 'UP' ? 'up' : deskSpeed.lanes.up.prob.direction === 'DOWN' ? 'down' : 'flat'}
            />
          ) : null}
          {deskSpeed?.lanes.down.prob ? (
            <AngleChip
              label="v_prob DOWN"
              value={formatProbSpeedPpMin(deskSpeed.lanes.down.prob.velocityPerMin)}
              tone={deskSpeed.lanes.down.prob.direction === 'UP' ? 'up' : deskSpeed.lanes.down.prob.direction === 'DOWN' ? 'down' : 'flat'}
            />
          ) : null}
          <AngleChip
            label="Book vs spot"
            value={spotBookAlignment ? `${spotBookAlignment.align}${spotBookAlignment.above ? ' · above PTB' : spotBookAlignment.below ? ' · below PTB' : ''}` : '—'}
            tone={
              spotBookAlignment?.align === 'ALIGNED'
                ? 'up'
                : spotBookAlignment?.align === 'DIVERGENT'
                  ? 'down'
                  : 'flat'
            }
          />
          <AngleChip
            label="Machine agreement"
            value={
              machineReadout
                ? `${machineReadout.agreementScore}% · ${machineReadout.focusLane?.toUpperCase() ?? 'SPLIT'} · ${machineReadout.regime}`
                : '—'
            }
            tone={
              machineReadout && machineReadout.agreementScore >= 72
                ? 'up'
                : machineReadout && machineReadout.agreementScore < 45
                  ? 'down'
                  : 'warn'
            }
          />
            </div>
          </DeepLayerBlock>
        </div>
      </details>
    </div>
  );
}
