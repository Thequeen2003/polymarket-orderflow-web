import type { ReactElement } from 'react';
import type { SettlementBiasDualReadout, SettlementBiasMomentumTier } from './binaryOutcomeBias';

function laneShell(lane: 'up' | 'down', strong = false): string {
  if (lane === 'up') {
    return strong
      ? 'border-emerald-500/55 bg-emerald-950/40 ring-1 ring-emerald-500/25'
      : 'border-emerald-700/45 bg-emerald-950/30';
  }
  return strong
    ? 'border-rose-500/55 bg-rose-950/40 ring-1 ring-rose-500/25'
    : 'border-rose-700/45 bg-rose-950/30';
}

function laneText(lane: 'up' | 'down'): string {
  return lane === 'up' ? 'text-emerald-100' : 'text-rose-100';
}

function tierLabel(tier: SettlementBiasMomentumTier, gaining: boolean): string {
  if (tier === 'flat') return 'Chop / noise';
  if (!gaining) {
    if (tier === 'strong') return 'Strong fade';
    if (tier === 'moderate') return 'Fading';
    return 'Soft fade';
  }
  if (tier === 'strong') return 'Strong push';
  if (tier === 'moderate') return 'Moderate drift';
  return 'Weak nudge';
}

function MomentumScoreTile(props: {
  lane: 'up' | 'down';
  label: string;
  side: { scorePct: number; tier: SettlementBiasMomentumTier; active: boolean; gaining: boolean };
  leading: boolean;
}): ReactElement {
  const { lane, label, side, leading } = props;
  const { scorePct, tier, active, gaining } = side;
  const arrow = !active ? '→' : gaining ? '↑' : '↓';
  return (
    <div
      className={`rounded-xl border px-2.5 py-2.5 ${
        active
          ? gaining
            ? laneShell(lane, leading && tier === 'strong')
            : 'border-zinc-700/50 bg-zinc-950/45 opacity-90'
          : 'border-zinc-800/55 bg-zinc-950/40 opacity-75'
      }`}
    >
      <div className="flex items-center justify-between gap-1">
        <div className="text-[8px] font-black uppercase tracking-[0.14em] text-zinc-500">Momentum {label}</div>
        {leading && active && gaining ? (
          <span className="rounded border border-white/10 bg-black/25 px-1 py-0.5 text-[7px] font-bold uppercase text-zinc-300">
            lead
          </span>
        ) : null}
      </div>
      <div
        className={`mt-1 flex items-center gap-1 ${
          !active ? 'text-zinc-500' : gaining ? laneText(lane) : 'text-zinc-400'
        }`}
      >
        <span aria-hidden className="text-base font-black">
          {arrow}
        </span>
        <span className="font-mono text-[clamp(1.15rem,3.5vw,1.5rem)] font-black tabular-nums leading-none">
          {active ? `${scorePct.toFixed(1)}%` : '—'}
        </span>
      </div>
      <div className="mt-1.5 text-[8px] font-bold uppercase tracking-wide text-zinc-500">
        {active ? tierLabel(tier, gaining) : 'Quiet tape'}
      </div>
    </div>
  );
}

export function SettlementBiasDualHero(props: {
  dual: SettlementBiasDualReadout;
  edgePp: number | null;
}): ReactElement {
  const { dual, edgePp } = props;
  const finish = dual.finish;
  const mom = dual.momentum;
  const momLeader = mom.favoredLane;

  return (
    <div className="space-y-2">
      <div className={`rounded-xl border px-2.5 py-2.5 ${laneShell(finish.lane, finish.probPct >= 70)}`}>
        <div className="text-[8px] font-black uppercase tracking-[0.14em] text-zinc-500">Finish score</div>
        <div className={`mt-1 text-[11px] font-bold uppercase leading-tight ${laneText(finish.lane)}`}>
          {finish.headline}
        </div>
        <div className={`mt-1 font-mono text-[clamp(1.35rem,4vw,1.75rem)] font-black tabular-nums leading-none ${laneText(finish.lane)}`}>
          {finish.probPct.toFixed(1)}%
        </div>
        <p className="mt-1.5 text-[9px] leading-snug text-zinc-400">{finish.subline}</p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <MomentumScoreTile lane="up" label={mom.upLabel} side={mom.up} leading={momLeader === 'up'} />
        <MomentumScoreTile lane="down" label={mom.downLabel} side={mom.down} leading={momLeader === 'down'} />
      </div>

      <p className="text-[9px] leading-snug text-zinc-500">{mom.subline}</p>

      {dual.splitNote ? (
        <div className="rounded-lg border border-amber-500/45 bg-amber-950/35 px-2.5 py-2 text-[10px] font-semibold leading-snug text-amber-100">
          ⚠ {dual.splitNote}
        </div>
      ) : dual.aligned ? (
        <div className="rounded-lg border border-emerald-700/40 bg-emerald-950/25 px-2.5 py-1.5 text-[9px] font-semibold text-emerald-200/95">
          ✓ Finish and momentum agree — {finish.label} at bell and tape now
        </div>
      ) : null}

      {edgePp != null && Math.abs(edgePp) >= 3 ? (
        <div className="font-mono text-[9px] font-bold tabular-nums text-amber-200/95">
          Model vs book on up: {edgePp >= 0 ? '+' : ''}
          {edgePp.toFixed(1)}pp
        </div>
      ) : null}
    </div>
  );
}
