import { useMemo, type ReactElement } from 'react';
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

function DeskSpeedLayersCard(props: { speed: DeskSpeedSnapshot }): ReactElement {
  const { speed } = props;
  const spot = speed.spot;
  const ptb = speed.ptbGap;

  return (
    <div className="rounded-xl border border-orange-800/40 bg-orange-950/12 px-3 py-3 sm:px-4">
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

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
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
}): ReactElement {
  const { scalp, upLabel, downLabel } = props;
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
    <div className="rounded-xl border border-cyan-800/45 bg-cyan-950/15 px-3 py-3 sm:px-4">
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

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
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
}): ReactElement {
  const { estimate, upLabel, downLabel, normMarketUp } = props;
  const modelTone = estimate.probUp >= 0.55 ? 'up' : estimate.probUp <= 0.45 ? 'down' : 'flat';

  return (
    <div className="rounded-xl border border-violet-800/45 bg-violet-950/20 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
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
}): ReactElement {
  const {
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

  const normNow = useMemo(
    () => normalizeBinaryFlexible(lastProbUp, lastProbDown),
    [lastProbUp, lastProbDown],
  );
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
      pUp01: norm30.up ?? normNow.up ?? lastProbUp,
      slopeUsdPerSec,
      bandUsd,
      horizonSec: 30,
    });
  }, [spotLast, priceToBeat, spot, norm30.up, normNow.up, lastProbUp, slopeUsdPerSec, bandUsd]);

  const pMktUp = norm30.up ?? normNow.up ?? lastProbUp;
  const pMktDown = norm30.down ?? normNow.down ?? lastProbDown;

  const edgeScalp = useMemo(() => {
    if (binaryBias == null || pMktUp == null || spotLast == null || priceToBeat == null) return null;
    return evaluateProbabilityEdgeScalp({
      estimate: binaryBias,
      pMkt: pMktUp,
      spotPts: spot,
      now: spotLast,
      ptb: priceToBeat,
      probUpDelta01: probProj.up30?.delta01 ?? null,
      upLabel,
      downLabel,
    });
  }, [binaryBias, pMktUp, spot, spotLast, priceToBeat, probProj.up30?.delta01, upLabel, downLabel]);

  const deskSpeed = useMemo(() => {
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
      horizonSec: 30,
    });
  }, [spotLast, priceToBeat, spot, probUp, probDown, pMktUp, pMktDown, upLabel, downLabel]);

  if (spotLast == null || priceToBeat == null || bandDistances == null || !glance) {
    return (
      <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/40 px-4 py-8 text-center text-sm text-zinc-500">
        Load PTB and live spot ticks to open the Now Price Signals window.
      </div>
    );
  }

  const geoTone =
    bandDistances.geo === 'ABOVE' ? 'up' : bandDistances.geo === 'BELOW' ? 'down' : ('warn' as const);

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-zinc-800/60 bg-[#0b1018] p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-indigo-300/85">Now price signals</div>
          <div className="mt-1 font-mono text-3xl font-bold tabular-nums tracking-tight text-zinc-50 sm:text-4xl">
            {fmtUsd(bandDistances.now)}
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] text-zinc-500">
            <span>
              PTB <span className="font-mono font-semibold text-amber-200/90">{fmtUsd(bandDistances.ptb)}</span>
            </span>
            <span className={`font-mono font-semibold tabular-nums ${geoTone === 'up' ? 'text-emerald-300' : geoTone === 'down' ? 'text-rose-300' : 'text-amber-200'}`}>
              {fmtUsdSigned(bandDistances.distNowFromPtb)} vs PTB
            </span>
            {stableHeader ? (
              <span className="font-mono tabular-nums text-indigo-300/90">
                Proj 30s {fmtUsd(stableHeader.projectedSpotUsd)} ({fmtUsdSigned(stableHeader.deltaVsNowUsd)})
              </span>
            ) : null}
            {probProj.up30 || probProj.down30 ? (
              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono tabular-nums">
                <span className="text-emerald-300/90">
                  {upLabel} {fmtCents(probProj.up30?.price01 ?? null)} ({fmtDeltaCents(probProj.up30?.delta01 ?? null)})
                </span>
                <span className="text-zinc-700/80">·</span>
                <span className="text-rose-300/90">
                  {downLabel} {fmtCents(probProj.down30?.price01 ?? null)} ({fmtDeltaCents(probProj.down30?.delta01 ?? null)})
                </span>
              </span>
            ) : null}
            {binaryBias ? (
              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono tabular-nums">
                <span className="text-violet-300/90">
                  Model P({upLabel}) {fmtProbPct01(binaryBias.probUp)}
                </span>
                <span className="text-zinc-700/80">·</span>
                <span className="text-zinc-500 text-[10px]">σ(4-signal score)</span>
              </span>
            ) : null}
            {norm30.up != null || normNow.up != null ? (
              <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono tabular-nums text-zinc-400">
                <span className="text-zinc-500">P_mkt</span>
                <span className="text-emerald-200/90">
                  {fmtProbPct01(norm30.up ?? normNow.up)} ({fmtCents(norm30.up ?? normNow.up)})
                </span>
              </span>
            ) : null}
            {edgeScalp ? (
              <span className="font-mono font-semibold tabular-nums text-cyan-300/90">
                Edge {fmtEdgePp(edgeScalp.edge)}
              </span>
            ) : null}
            {deskSpeed?.spot ? (
              <span className="font-mono font-semibold tabular-nums text-orange-300/90">
                v_spot {formatSpotSpeedPerMin(deskSpeed.spot.velocityPerMin)}
              </span>
            ) : null}
          </div>
          {edgeScalp ? (
            <div className="mt-2">
              <SiglaChips siglas={edgeScalp.siglas} />
            </div>
          ) : null}
        </div>
        {bandGauge ? (
          <div className="rounded-xl border border-zinc-700/50 bg-black/25 px-3 py-2 text-right">
            <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-zinc-500">Band playbook</div>
            <div className="text-[11px] font-semibold text-zinc-200">{bandGauge.glanceVerb}</div>
            <div className="text-[10px] text-zinc-500">{bandGauge.separation} · {bandGauge.geo.replace('_', ' ')}</div>
          </div>
        ) : null}
      </div>

      {deskSpeed ? <DeskSpeedLayersCard speed={deskSpeed} /> : null}

      {binaryBias ? (
        <BinaryOutcomeModelCard
          estimate={binaryBias}
          upLabel={upLabel}
          downLabel={downLabel}
          normMarketUp={pMktUp}
        />
      ) : null}

      {edgeScalp ? <ProbabilityEdgeScalpCard scalp={edgeScalp} upLabel={upLabel} downLabel={downLabel} /> : null}

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <ConfirmedDistanceBox kind="above" band={bandDistances} glance={glance.upBreak} />
        <ConfirmedDistanceBox kind="below" band={bandDistances} glance={glance.downBreak} />
        <NowWindowSummary band={bandDistances} glance={glance} />
      </div>

      <PtbLadderBar band={bandDistances} />

      <div className="rounded-xl border border-indigo-800/40 bg-indigo-950/15 px-3 py-2.5">
        <div className="text-[9px] font-black uppercase tracking-[0.14em] text-indigo-300/80">Projected now window</div>
        <p className="mt-0.5 text-[10px] leading-snug text-zinc-500">
          Linear spot extrapolation from tick slope. Each horizon shows % of the current gap to confirmed above/below
          (100% = at the line) and distance in × PTB band width.
        </p>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:thin]">
          {projectionWindow.map((cell) => (
            <NowWindowCell key={cell.label} cell={cell} />
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 text-[9px] font-black uppercase tracking-[0.14em] text-zinc-500">All angles</div>
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
      </div>

      {machineReadout ? (
        <MachineVerdictCard readout={machineReadout} physicsLine={physicsLine} compact minimal />
      ) : null}
    </div>
  );
}
