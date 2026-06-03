import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import type { SpotBandGaugeSnapshot } from './spotBandDeskAction';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { TapeVelocity } from './tapeVelocity';
import { computeStableProjectedHeader } from './chartStableProjectedHeader';
import { MachineVerdictCard } from './MachineVerdictCard';
import { computeMomentumProjection, type ProjectionTick } from './momentumProjection';
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
import { formatCentsFrom01 } from './deskSpeedGainPct';
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

      {pressure.entryJump ? (
        <div
          className={`mt-3 rounded-xl border px-3 py-2.5 ${
            tone === 'up'
              ? 'border-emerald-600/45 bg-emerald-950/30'
              : tone === 'down'
                ? 'border-rose-600/45 bg-rose-950/30'
                : 'border-violet-700/40 bg-violet-950/20'
          }`}
        >
          <div className="text-[9px] font-black uppercase tracking-[0.12em] text-zinc-400">
            Live jump · contract ¢ · {pressure.confirmHorizonSec}s confirm
          </div>
          {pressure.timing === 'CHASING' || pressure.timing === 'EXTENDED' ? (
            <p className="mt-1 text-[10px] font-semibold text-amber-300/95">{pressure.timingReadout.note}</p>
          ) : null}
          <p className="mt-1.5 text-[12px] font-semibold leading-snug text-zinc-100">{pressure.entryJump.headline}</p>
          <p className="mt-1 text-[11px] leading-snug text-zinc-400">{pressure.entryJump.projLine}</p>
          <div className="mt-2 flex flex-wrap gap-3 font-mono text-[11px] tabular-nums">
            <span className="text-zinc-500">
              {pressure.confirmHorizonSec}s ago{' '}
              <span className="text-zinc-300">{formatCentsFrom01(pressure.entryJump.entry01)}</span>
            </span>
            <span className="text-zinc-500">
              Now <span className="font-bold text-zinc-50">{formatCentsFrom01(pressure.entryJump.now01)}</span>
            </span>
            <span className={pressure.entryJump.gainCents >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
              Move{' '}
              <span className="font-bold">
                {pressure.entryJump.gainCents >= 0 ? '+' : ''}
                {pressure.entryJump.gainCents.toFixed(1)}¢ ({pressure.entryJump.gainPct >= 0 ? '+' : ''}
                {pressure.entryJump.gainPct.toFixed(1)}%)
              </span>
            </span>
          </div>
        </div>
      ) : null}

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
  stableHeader: StableProjectedHeaderSnapshot | null;
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
        {p.stableHeader ? (
          <>
            {sep}
            <span className="text-indigo-200">
              Proj 30s {fmtUsd(p.stableHeader.projectedSpotUsd)}{' '}
              <span className="text-indigo-300/80">({fmtUsdSigned(p.stableHeader.deltaVsNowUsd)})</span>
            </span>
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
            <span className="text-zinc-400">
              Model P(Up) <span className="text-zinc-200">{fmtProbPct01(p.modelPUp)}</span>
            </span>
          </>
        ) : null}
        {p.edgePp != null ? (
          <>
            {sep}
            <span className={p.edgePp > 0.3 ? 'text-emerald-300' : p.edgePp < -0.3 ? 'text-rose-300' : 'text-zinc-400'}>
              Edge {fmtPp(p.edgePp)}
            </span>
          </>
        ) : null}
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
  speedHint: string | null;
  machineHint: string | null;
  upMid: string | null;
  downMid: string | null;
}): ReactElement {
  const p = props;
  const edgeStr = p.edgePp != null ? fmtPp(p.edgePp) : '—';
  const pill = (text: string, tone?: GlanceTone) => (
    <span
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
        {pill(`Edge ${edgeStr}`, p.edgePp != null && p.edgePp > 0.3 ? 'up' : p.edgePp != null && p.edgePp < -0.3 ? 'down' : 'flat')}
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

function fmtPp(pp: number): string {
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp`;
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
        <span>Edge {fmtPp(lag.edgePp)}</span>
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

  const probProj = useMemo(() => {
    const net = tape?.netPressure ?? null;
    const horizons = [
      { label: '30s', sec: 30 },
      { label: '1m', sec: 60 },
    ];
    const up = computeMomentumProjection({
      pts: probUp as ProjectionTick[],
      tapeNetPressure: net,
      horizons,
    });
    const down = computeMomentumProjection({
      pts: probDown as ProjectionTick[],
      tapeNetPressure: net != null ? -net : null,
      horizons,
    });
    return {
      up30: up?.points.find((p) => p.label === '30s') ?? null,
      down30: down?.points.find((p) => p.label === '30s') ?? null,
      up1m: up?.points.find((p) => p.label === '1m') ?? null,
      down1m: down?.points.find((p) => p.label === '1m') ?? null,
    };
  }, [probUp, probDown, tape?.netPressure]);

  const normLive = useMemo(
    () => normalizeBinaryFlexible(lastProbUp, lastProbDown),
    [lastProbUp, lastProbDown],
  );

  const probTicksUp = useMemo(
    () =>
      probUp
        .filter((p) => p.v != null && Number.isFinite(p.v))
        .map((p) => ({ t: p.t, v: p.v! })),
    [probUp],
  );
  const probTicksDown = useMemo(
    () =>
      probDown
        .filter((p) => p.v != null && Number.isFinite(p.v))
        .map((p) => ({ t: p.t, v: p.v! })),
    [probDown],
  );

  const recentDeltaUp01 = useMemo(() => recentProbDelta01(probTicksUp, 30_000), [probTicksUp]);
  const recentDeltaDown01 = useMemo(() => recentProbDelta01(probTicksDown, 30_000), [probTicksDown]);

  const marketUpdatedAtMs = useMemo(
    () => maxFeedMs(probLastUpdateMs, booksFetchedAt, lastPointMs(probTicksUp), lastPointMs(probTicksDown)),
    [booksFetchedAt, probLastUpdateMs, probTicksDown, probTicksUp],
  );

  const normNow = normLive;
  const norm30 = useMemo(() => {
    const u = probProj.up30?.price01 ?? lastProbUp ?? null;
    const d = probProj.down30?.price01 ?? lastProbDown ?? null;
    return normalizeBinaryFlexible(u, d);
  }, [probProj.up30?.price01, probProj.down30?.price01, lastProbUp, lastProbDown]);

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

  const speedHint = pressureBuildup
    ? pressureBuildupShortLabel(pressureBuildup)
    : directionScore
      ? directionScoreShortLabel(directionScore)
      : null;

  if (spotLast == null || priceToBeat == null || bandDistances == null || !glance) {
    return (
      <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/40 px-4 py-8 text-center text-sm text-zinc-500">
        Load PTB and live spot ticks to open the Now Price Signals window.
      </div>
    );
  }

  const geoTone: GlanceTone =
    bandDistances.geo === 'ABOVE' ? 'up' : bandDistances.geo === 'BELOW' ? 'down' : 'warn';

  const tradeCall = edgeScalp
    ? edgeScalp.scalpSignal === 'LONG_UP'
      ? `LONG ${upLabel}`
      : edgeScalp.scalpSignal === 'LONG_DOWN'
        ? `LONG ${downLabel}`
        : 'NO TRADE'
    : machineReadout?.focusLane
      ? `LEAN ${machineReadout.focusLane === 'up' ? upLabel : downLabel}`
      : 'WAIT';

  const tradeCallTone: GlanceTone =
    edgeScalp?.scalpSignal === 'LONG_UP' || machineReadout?.focusLane === 'up'
      ? 'up'
      : edgeScalp?.scalpSignal === 'LONG_DOWN' || machineReadout?.focusLane === 'down'
        ? 'down'
        : 'flat';

  const upMidSnap =
    pMktUp != null
      ? `${upLabel} ${fmtCents(pMktUp)}${recentDeltaUp01 != null ? ` (${fmtDeltaCents(recentDeltaUp01)})` : ''}`
      : null;
  const downMidSnap =
    pMktDown != null
      ? `${downLabel} ${fmtCents(pMktDown)}${recentDeltaDown01 != null ? ` (${fmtDeltaCents(recentDeltaDown01)})` : ''}`
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-2xl border border-zinc-800/60 bg-[#0b1018] p-3 sm:p-4">
      <div className="text-[10px] font-black uppercase tracking-[0.16em] text-indigo-300/85">Now price signals</div>

      <PriceHeadlineRow
        spotUsd={bandDistances.now}
        ptbUsd={bandDistances.ptb}
        distVsPtb={bandDistances.distNowFromPtb}
        stableHeader={stableHeader}
        upLabel={upLabel}
        downLabel={downLabel}
        probUp01={pMktUp}
        probDown01={pMktDown}
        probUpDelta01={recentDeltaUp01}
        probDownDelta01={recentDeltaDown01}
        modelPUp={binaryBias?.probUp ?? null}
        edgePp={binaryBias != null && pMktUp != null ? (binaryBias.probUp - pMktUp) * 100 : fairValueGap?.rawGapPp ?? null}
      />

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

      {pressureBuildup ? (
        <PressureBuildupCard pressure={pressureBuildup} upLabel={upLabel} downLabel={downLabel} />
      ) : null}

      {directionScore ? <DirectionScoreCard score={directionScore} upLabel={upLabel} downLabel={downLabel} /> : null}

      <CompactSnapshotStrip
        geo={bandDistances.geo.replace('_', ' ')}
        geoTone={geoTone}
        spotUsd={bandDistances.now}
        ptbUsd={bandDistances.ptb}
        distVsPtb={bandDistances.distNowFromPtb}
        tradeCall={tradeCall}
        tradeTone={tradeCallTone}
        edgePp={edgeScalp?.edge ?? fairValueGap?.rawGapPp ?? null}
        speedHint={speedHint}
        machineHint={
          machineReadout
            ? `${machineReadout.agreementScore}% ${machineReadout.focusLane?.toUpperCase() ?? 'SPLIT'}`
            : null
        }
        upMid={upMidSnap}
        downMid={downMidSnap}
      />

      {physicsLine ? (
        <p className="rounded-lg border border-violet-800/30 bg-violet-950/15 px-2.5 py-2 text-[11px] leading-snug text-violet-100/90">
          {physicsLine}
        </p>
      ) : null}

      {machineReadout ? (
        <MachineVerdictCard readout={machineReadout} physicsLine={null} compact minimal />
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
