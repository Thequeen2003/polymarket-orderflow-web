import type { ReactElement } from 'react';

import { formatWallBidWarnings } from './dualOutcomeWalls';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';

/** Compact summary lifted from Spot vs PTB for Signals / Dual PTB tabs. */
export function MachineVerdictCard(props: {
  readout: SpotPtbMachineReadout | null;
  /** Same plain physics as Do this now (spot vs PTB + book). */
  physicsLine?: string | null;
  /** Tighter padding when stacked above the chart in narrow layouts. */
  compact?: boolean;
  /**
   * Signals desk: hide vote audit / MTF / extra bullets — one headline line + chips only
   * so it does not compete with the trade card.
   */
  minimal?: boolean;
}): ReactElement | null {
  const { readout, physicsLine = null, compact, minimal = false } = props;
  if (!readout) return null;

  const agreeTone =
    readout.agreementScore >= 72
      ? 'border-emerald-500/50 bg-emerald-950/35 text-emerald-100'
      : readout.agreementScore >= 45
        ? 'border-amber-500/45 bg-amber-950/25 text-amber-100'
        : 'border-zinc-700/60 bg-zinc-900/40 text-zinc-300';

  const urgencyTone =
    readout.urgency === 'settlement'
      ? 'border-rose-500/60 bg-rose-950/40 text-rose-100'
      : readout.urgency === 'critical'
        ? 'border-amber-500/60 bg-amber-950/40 text-amber-100'
        : 'border-zinc-700/70 bg-black/35 text-zinc-400';

  const crossPct =
    readout.crossProb != null ? Math.round(readout.crossProb * 100) : null;
  const crossTone =
    crossPct == null
      ? 'border-zinc-700/70 bg-black/30 text-zinc-500'
      : crossPct >= 70
        ? 'border-fuchsia-500/55 bg-fuchsia-950/35 text-fuchsia-100'
        : crossPct <= 20
          ? 'border-emerald-500/45 bg-emerald-950/25 text-emerald-100'
          : 'border-amber-500/45 bg-amber-950/25 text-amber-100';

  const accel = readout.acceleration?.state ?? null;
  const accelTone =
    accel === 'accel-up'
      ? 'border-emerald-500/55 bg-emerald-950/35 text-emerald-100'
      : accel === 'accel-down'
        ? 'border-rose-500/55 bg-rose-950/35 text-rose-100'
        : accel === 'reversing'
          ? 'border-amber-500/55 bg-amber-950/30 text-amber-100'
          : accel === 'decel'
            ? 'border-zinc-600/60 bg-zinc-900/50 text-zinc-300'
            : null;
  const accelLabel =
    accel === 'accel-up'
      ? 'ACCEL UP'
      : accel === 'accel-down'
        ? 'ACCEL DOWN'
        : accel === 'reversing'
          ? 'REVERSING'
          : accel === 'decel'
            ? 'DECEL'
            : null;

  const overext = readout.overextension;
  const overextTone =
    overext?.state === 'overextended'
      ? 'border-rose-500/65 bg-rose-950/40 text-rose-100 animate-pulse'
      : overext?.state === 'stretched'
        ? 'border-amber-500/55 bg-amber-950/30 text-amber-100'
        : null;
  const overextLabel =
    overext?.state === 'overextended'
      ? `OVEREXTENDED ×${overext.ratio.toFixed(1)}`
      : overext?.state === 'stretched'
        ? `STRETCHED ×${overext.ratio.toFixed(1)}`
        : null;

  const mtf = readout.mtf;
  const edges = readout.edges;
  const bestEdgeUsd = edges?.bestEdgeUsd ?? 0;
  const bestEdgeLane = edges?.bestLane ?? null;
  const edgeTone =
    bestEdgeUsd >= 0.12
      ? 'border-emerald-500/65 bg-emerald-950/40 text-emerald-100'
      : bestEdgeUsd >= 0.05
        ? 'border-emerald-500/45 bg-emerald-950/25 text-emerald-100'
        : bestEdgeUsd >= 0.015
          ? 'border-amber-500/45 bg-amber-950/25 text-amber-100'
          : 'border-zinc-600/60 bg-zinc-900/40 text-zinc-300';

  return (
    <div
      className={`rounded-xl border border-indigo-800/45 bg-indigo-950/25 shadow-inner shadow-black/25 ${
        compact ? 'px-3 py-2' : 'px-4 py-3'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-black uppercase tracking-[0.16em] text-indigo-300/95">
          {minimal ? 'Sensor strip' : 'Machine verdict'}
        </span>
        <span className={`rounded-md border px-2 py-0.5 text-[11px] font-black tabular-nums ${agreeTone}`}>
          {readout.agreementScore}% agree
        </span>
        <span className="rounded-md border border-zinc-700/70 bg-black/35 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-zinc-400">
          {readout.regime}
        </span>
        <span className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${urgencyTone}`}>
          {readout.urgency}
        </span>
        {readout.focusLane ? (
          <span className="rounded-md border border-indigo-500/50 bg-indigo-950/40 px-2 py-0.5 text-[10px] font-black uppercase text-indigo-100">
            book pick {readout.flowWinningLane?.toUpperCase() ?? readout.focusLane.toUpperCase()}
          </span>
        ) : null}
        {!minimal ? (
          <span
            className="rounded-md border border-zinc-700/70 bg-black/35 px-2 py-0.5 text-[10px] font-bold uppercase text-zinc-500"
            title="How implied probability lines up with spot vs PTB"
          >
            align {readout.probVsSpot}
          </span>
        ) : null}
        {!minimal && crossPct != null ? (
          <span
            className={`rounded-md border px-2 py-0.5 text-[10px] font-bold tabular-nums ${crossTone}`}
            title={readout.crossEstimate?.summary ?? undefined}
          >
            cross {crossPct}%
          </span>
        ) : null}
        {!minimal && accelLabel && accelTone ? (
          <span
            className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tabular-nums ${accelTone}`}
            title={readout.acceleration?.summary ?? undefined}
          >
            {accelLabel}
          </span>
        ) : null}
        {!minimal && overextLabel && overextTone ? (
          <span
            className={`rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tabular-nums ${overextTone}`}
            title={overext?.summary ?? undefined}
          >
            {overextLabel}
          </span>
        ) : null}
        {!minimal && bestEdgeLane && bestEdgeUsd > 0 ? (
          <span
            className={`rounded-md border px-2 py-0.5 text-[10px] font-black uppercase tabular-nums ${edgeTone}`}
            title={
              bestEdgeLane === 'up'
                ? readout.edges?.up?.summary ?? undefined
                : readout.edges?.down?.summary ?? undefined
            }
          >
            edge {bestEdgeLane.toUpperCase()} +{bestEdgeUsd.toFixed(2)}
          </span>
        ) : null}
      </div>

      {physicsLine ? (
        <p className="mt-2 text-[10px] font-medium leading-snug text-indigo-50/95">{physicsLine}</p>
      ) : null}

      {readout.wallFlow?.bidWarnings.length ? (
        <p className="mt-2 rounded-lg border border-amber-500/45 bg-amber-950/35 px-2.5 py-1.5 text-[10px] font-semibold leading-snug text-amber-100">
          <span className="font-black uppercase tracking-wide text-amber-200/95">Wall bid · </span>
          {formatWallBidWarnings(readout.wallFlow.bidWarnings, readout.focusLane)}
        </p>
      ) : null}

      {minimal && readout.laneVotes && (readout.laneVotes.up > 0 || readout.laneVotes.down > 0) ? (
        <p className="mt-1.5 font-mono text-[9px] tabular-nums text-indigo-300/70">
          sensor votes {readout.laneVotes.up.toFixed(1)} UP · {readout.laneVotes.down.toFixed(1)} DOWN
          {readout.focusLane ? ` → ${readout.focusLane.toUpperCase()}` : ''}
        </p>
      ) : null}

      {/* Lane-vote bar — shows the raw weighted tallies that decided focusLane.
          Operators wanted transparency: "is the system actually biased UP, or
          do the votes really say UP?". This makes the call auditable. */}
      {!minimal && readout.laneVotes && (readout.laneVotes.up > 0 || readout.laneVotes.down > 0) ? (
        <LaneVoteBar
          up={readout.laneVotes.up}
          down={readout.laneVotes.down}
          focus={readout.focusLane}
        />
      ) : null}

      {!minimal && mtf && mtf.votes.length === 4 ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[9px] font-bold uppercase tracking-wider text-indigo-400/80">MTF stack</span>
          <div className="flex items-center gap-1">
            {mtf.votes.map((v) => {
              const dotTone =
                v.thin
                  ? 'bg-zinc-700/70 ring-zinc-700/50'
                  : v.vote === 'up'
                    ? 'bg-emerald-400/90 ring-emerald-400/40'
                    : v.vote === 'down'
                      ? 'bg-rose-400/90 ring-rose-400/40'
                      : 'bg-zinc-500/80 ring-zinc-500/40';
              return (
                <span key={v.key} className="flex flex-col items-center" title={`${v.key}: ${v.vote.toUpperCase()} (slope ${v.slopeUsdPerSec.toFixed(3)}/s)`}>
                  <span className={`block h-2.5 w-2.5 rounded-full ring-2 ${dotTone}`} />
                  <span className="mt-0.5 text-[8px] font-bold uppercase tabular-nums text-indigo-300/65">
                    {v.key}
                  </span>
                </span>
              );
            })}
          </div>
          <span
            className={`ml-auto rounded-md border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
              mtf.fullAgreement
                ? 'border-emerald-400/55 bg-emerald-950/35 text-emerald-100'
                : mtf.hasConflict
                  ? 'border-amber-400/45 bg-amber-950/30 text-amber-100'
                  : 'border-zinc-700/70 bg-zinc-900/40 text-zinc-300'
            }`}
            title={mtf.summary}
          >
            {mtf.fullAgreement && mtf.dominantLane
              ? `4/4 ${mtf.dominantLane.toUpperCase()}`
              : mtf.hasConflict
                ? 'split'
                : `${mtf.alignedCount}/${mtf.votes.length} ${mtf.dominantLane?.toUpperCase() ?? ''}`}
          </span>
        </div>
      ) : null}

      {!minimal && crossPct != null ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-[9px] font-bold uppercase tracking-wider text-indigo-400/80">PTB cross</span>
          <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-900/70 ring-1 ring-zinc-800/70">
            <div
              className={`absolute inset-y-0 left-0 rounded-full transition-all ${
                crossPct >= 70
                  ? 'bg-fuchsia-400/85'
                  : crossPct >= 40
                    ? 'bg-amber-400/85'
                    : 'bg-emerald-400/80'
              }`}
              style={{ width: `${Math.max(2, Math.min(100, crossPct))}%` }}
            />
          </div>
          <span className="w-9 text-right text-[10px] font-black tabular-nums text-indigo-100">
            {crossPct}%
          </span>
        </div>
      ) : null}

      <p className={`mt-1.5 text-[12px] font-medium leading-snug text-indigo-50/95 ${compact ? '' : 'sm:text-[13px]'}`}>
        {readout.lines[0] ?? '—'}
      </p>
      {!minimal && readout.lines.length > 1 ? (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-indigo-200/75">
          {readout.lines.slice(1, 5).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Tiny stacked horizontal bar showing the raw weighted UP/DOWN vote tallies
 * that decided `focusLane`. The chosen lane's segment is brighter and labeled.
 * Designed to be unobtrusive but auditable — operators can glance at it and
 * confirm "yes, the system really did weigh DOWN higher" without opening the
 * machine readout disclosure.
 */
function LaneVoteBar({
  up,
  down,
  focus,
}: {
  up: number;
  down: number;
  focus: 'up' | 'down' | null;
}): ReactElement {
  const total = Math.max(up + down, 0.001);
  const upPct = (up / total) * 100;
  const downPct = (down / total) * 100;
  const upHot = focus === 'up';
  const downHot = focus === 'down';
  return (
    <div className="mt-2 flex items-center gap-2" title={`Weighted sensor votes — UP ${up.toFixed(1)} / DOWN ${down.toFixed(1)}`}>
      <span className="text-[9px] font-bold uppercase tracking-wider text-indigo-400/80">
        Vote
      </span>
      <div className="relative flex h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-900/70 ring-1 ring-zinc-800/70">
        <div
          className={`h-full transition-all ${upHot ? 'bg-emerald-400/95' : 'bg-emerald-700/55'}`}
          style={{ width: `${Math.max(2, upPct)}%` }}
        />
        <div
          className={`h-full transition-all ${downHot ? 'bg-rose-400/95' : 'bg-rose-700/55'}`}
          style={{ width: `${Math.max(2, downPct)}%` }}
        />
      </div>
      <span className={`tabular-nums text-[10px] font-bold ${upHot ? 'text-emerald-100' : 'text-emerald-300/70'}`}>
        {up.toFixed(1)}
      </span>
      <span className="text-[9px] text-zinc-500">/</span>
      <span className={`tabular-nums text-[10px] font-bold ${downHot ? 'text-rose-100' : 'text-rose-300/70'}`}>
        {down.toFixed(1)}
      </span>
    </div>
  );
}
