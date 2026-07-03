import type { ReactElement } from 'react';
import type { DualPtbBattleDesk as BattleDeskModel } from './dualPtbBattleMetrics';
import type { PtbTargetEngineCard } from './ptbTargetEngine';

function DominanceBar(props: { label: string; pct: number; tone: 'up' | 'down'; dimmed?: boolean }): ReactElement {
  const { label, pct, tone, dimmed = false } = props;
  const barCls = tone === 'up' ? 'bg-emerald-500/75' : 'bg-rose-500/75';
  return (
    <div className={dimmed ? 'opacity-40' : ''}>
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px]">
        <span className="font-semibold uppercase tracking-wide text-zinc-300">{label}</span>
        <span className="font-mono tabular-nums text-zinc-200">{pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800/70">
        <div className={`h-full rounded-full ${barCls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function DualPtbDecisionHero(props: {
  battle: BattleDeskModel;
  upLabel: string;
  downLabel: string;
}): ReactElement {
  const { battle, upLabel, downLabel } = props;
  const isEnter = battle.action === 'ENTER_UP' || battle.action === 'ENTER_DOWN';
  const isUp = battle.action === 'ENTER_UP' || battle.action === 'LEAN_UP';
  const laneLabel = isUp ? upLabel : downLabel;
  const actionText = isEnter ? `ENTER ${laneLabel.toUpperCase()}` : battle.action === 'WAIT' ? 'WAIT — NO EDGE' : `LEAN ${laneLabel.toUpperCase()}`;
  const stars = battle.consensusCount >= 4 ? '★★★' : battle.consensusCount >= 3 ? '★★' : battle.consensusCount >= 2 ? '★' : '';

  return (
    <div
      className={`rounded-2xl border px-4 py-3 ring-1 ${
        isEnter
          ? isUp
            ? 'border-emerald-500/45 bg-emerald-950/25 ring-emerald-500/20'
            : 'border-rose-500/45 bg-rose-950/20 ring-rose-500/20'
          : 'border-zinc-700/60 bg-zinc-950/50 ring-white/[0.03]'
      }`}
    >
      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">Trade signal</div>
      <div className={`mt-1 text-xl font-black tracking-tight sm:text-2xl ${isUp ? 'text-emerald-100' : 'text-rose-100'}`}>
        {isEnter ? '🟢' : battle.action === 'WAIT' ? '⚪' : '🔴'} {actionText} {stars}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-300">
        <span>
          Confidence <span className="font-bold text-zinc-50">{battle.actionConfidencePct}%</span>
        </span>
        <span>
          Consensus{' '}
          <span className={`font-bold ${battle.consensusQuality === 'HIGH' ? 'text-emerald-200' : 'text-amber-200'}`}>
            {battle.consensusCount}/{battle.consensusTotal}
          </span>
        </span>
        {battle.expectedMoveCents != null ? (
          <span>
            Expected move{' '}
            <span className="font-mono font-bold text-indigo-200">
              {battle.expectedMoveCents >= 0 ? '+' : ''}
              {battle.expectedMoveCents.toFixed(1)}¢
            </span>
          </span>
        ) : null}
        {battle.targetCents ? (
          <span>
            Target <span className="font-mono font-bold text-zinc-100">{battle.targetCents}</span>
          </span>
        ) : null}
        {battle.stopCents ? (
          <span>
            Stop <span className="font-mono font-bold text-zinc-100">{battle.stopCents}</span>
          </span>
        ) : null}
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <DominanceBar label={upLabel} pct={battle.upPct} tone="up" dimmed={battle.winningLane === 'down'} />
        <DominanceBar label={downLabel} pct={battle.downPct} tone="down" dimmed={battle.winningLane === 'up'} />
      </div>
    </div>
  );
}

export function DualPtbBattleStrip(props: {
  battle: BattleDeskModel;
  upLabel: string;
  downLabel: string;
}): ReactElement {
  const { battle, upLabel, downLabel } = props;
  const biasLabel =
    battle.bias === 'up' ? upLabel.toUpperCase() : battle.bias === 'down' ? downLabel.toUpperCase() : 'NEUTRAL';
  const biasCls =
    battle.bias === 'up' ? 'text-emerald-200' : battle.bias === 'down' ? 'text-rose-200' : 'text-zinc-400';

  return (
    <div className="rounded-xl border border-zinc-700/55 bg-zinc-950/70 px-3 py-2 ring-1 ring-amber-500/15">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[10px]">
        <span className="font-black uppercase tracking-[0.14em] text-amber-200/90">Battle</span>
        <span className="font-mono tabular-nums text-emerald-200">
          {upLabel} <span className="font-bold text-zinc-50">{battle.upPct}%</span>
        </span>
        <span className="font-mono tabular-nums text-rose-200">
          {downLabel} <span className="font-bold text-zinc-50">{battle.downPct}%</span>
        </span>
        <span className="text-zinc-500">·</span>
        <span className="text-zinc-400">
          Bias <span className={`font-bold ${biasCls}`}>{biasLabel}</span>
        </span>
        <span className="text-zinc-400">
          Δ{' '}
          <span className="font-mono font-bold text-zinc-100">
            {battle.strengthDiff >= 0 ? '+' : ''}
            {battle.strengthDiff}%
          </span>
        </span>
        <span className="text-zinc-400">
          Consensus{' '}
          <span className="font-bold text-zinc-100">
            {battle.consensusCount}/{battle.consensusTotal}
          </span>
        </span>
      </div>
      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-zinc-800/80">
        <div className="bg-emerald-500/80" style={{ width: `${battle.upPct}%` }} />
        <div className="bg-rose-500/80" style={{ width: `${battle.downPct}%` }} />
      </div>
    </div>
  );
}

export function DualPtbBattleMeter(props: {
  battle: BattleDeskModel;
  upLabel: string;
  downLabel: string;
}): ReactElement {
  const { battle, upLabel, downLabel } = props;
  const biasLabel =
    battle.bias === 'up' ? upLabel.toUpperCase() : battle.bias === 'down' ? downLabel.toUpperCase() : 'NEUTRAL';
  const biasCls =
    battle.bias === 'up' ? 'text-emerald-200' : battle.bias === 'down' ? 'text-rose-200' : 'text-zinc-400';

  return (
    <div className="flex h-full min-w-0 flex-col rounded-2xl border border-zinc-700/55 bg-zinc-950/70 px-3 py-3 ring-1 ring-amber-500/15">
      <div className="text-[10px] font-black uppercase tracking-[0.16em] text-amber-200/90">Dual PTB battle</div>
      <div className="mt-3 space-y-2 font-mono text-sm tabular-nums">
        <div className="flex items-center justify-between gap-2">
          <span className="text-emerald-200/90">{upLabel}</span>
          <span className="font-bold text-zinc-50">{battle.upPct}%</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-rose-200/90">{downLabel}</span>
          <span className="font-bold text-zinc-50">{battle.downPct}%</span>
        </div>
      </div>
      <div className="mt-3 border-t border-zinc-800/60 pt-3 text-[11px] text-zinc-300">
        <div>
          Strength diff{' '}
          <span className="font-mono font-bold text-zinc-100">
            {battle.strengthDiff >= 0 ? '+' : ''}
            {battle.strengthDiff}%
          </span>
        </div>
        <div className="mt-1">
          Bias <span className={`font-bold ${biasCls}`}>{biasLabel}</span>
        </div>
        <div className="mt-1">
          Confidence <span className="font-bold text-zinc-100">{battle.confidence}</span>
        </div>
      </div>
      <div className="mt-3 border-t border-zinc-800/60 pt-3 text-[10px] text-zinc-400">
        <div className="font-mono">
          UP {battle.spreadUpCents.toFixed(1)}¢ · DOWN {battle.spreadDownCents.toFixed(1)}¢
        </div>
        <div className="mt-1">
          Spread <span className="font-bold text-zinc-200">{battle.spreadCents.toFixed(1)}¢</span>{' '}
          <span className="text-zinc-500">· {battle.spreadLabel}</span>
        </div>
      </div>
      <div className="mt-3 border-t border-zinc-800/60 pt-3 text-[10px]">
        <div className="font-semibold uppercase tracking-wide text-zinc-500">Trade score</div>
        <div className="mt-1 font-mono text-zinc-200">
          {downLabel}: <span className="font-bold text-rose-200">{battle.tradeScoreDown}</span>
        </div>
        <div className="font-mono text-zinc-200">
          {upLabel}: <span className="font-bold text-emerald-200">{battle.tradeScoreUp}</span>
        </div>
        <div className="mt-1 text-zinc-500">Min trade score = {battle.minTradeScore}</div>
      </div>
      <div className="mt-3 border-t border-zinc-800/60 pt-3 text-[10px] text-zinc-300">
        <div>
          {upLabel} <span className="font-mono">{battle.upMomentumLabel}</span>
        </div>
        <div className="mt-0.5">
          {downLabel} <span className="font-mono">{battle.downMomentumLabel}</span>
        </div>
        <div className="mt-1 font-mono text-[9px] text-zinc-500">
          {upLabel} {battle.upSpeedCentsPerMin >= 0 ? '+' : ''}
          {battle.upSpeedCentsPerMin.toFixed(1)}¢/min · {downLabel}{' '}
          {battle.downSpeedCentsPerMin >= 0 ? '+' : ''}
          {battle.downSpeedCentsPerMin.toFixed(1)}¢/min
        </div>
      </div>
      <div className="mt-3 border-t border-zinc-800/60 pt-3">
        <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Agreement</div>
        <ul className="mt-1.5 space-y-1">
          {battle.agreementBadges.map((b) => (
            <li key={b.label} className="flex items-center justify-between gap-2 text-[10px]">
              <span className="text-zinc-400">{b.label}</span>
              <span className={b.ok ? 'font-bold text-emerald-300' : 'text-zinc-600'}>{b.ok ? '✔' : '—'}</span>
            </li>
          ))}
        </ul>
        <div
          className={`mt-2 text-[10px] font-bold uppercase tracking-wide ${
            battle.consensusQuality === 'HIGH' ? 'text-emerald-300' : 'text-amber-300'
          }`}
        >
          Consensus {battle.consensusCount}/{battle.consensusTotal}
          {battle.consensusQuality === 'LOW' ? ' · LOW QUALITY' : ''}
        </div>
      </div>
    </div>
  );
}

export function DualPtbCompactEngine(props: {
  ptbTarget: PtbTargetEngineCard;
  upLabel: string;
  downLabel: string;
  starred?: boolean;
}): ReactElement {
  const { ptbTarget, upLabel, downLabel, starred = true } = props;
  const laneLabel = ptbTarget.engineLane === 'up' ? upLabel : downLabel;
  const confPct = ptbTarget.momentum === 'Strong' ? 78 : ptbTarget.momentum === 'Medium' ? 63 : 44;

  return (
    <div className="rounded-xl border border-zinc-800/60 bg-zinc-950/45 px-3 py-2.5">
      <div className="text-[9px] font-black uppercase tracking-wide text-zinc-500">PTB target engine</div>
      <div className="mt-1 text-[12px] font-bold text-zinc-100">
        {laneLabel.toUpperCase()} {starred ? '★' : ''}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] sm:grid-cols-5">
        <div>
          <div className="text-zinc-500">Price</div>
          <div className="font-mono font-semibold text-zinc-100">{ptbTarget.nowLabel}</div>
        </div>
        <div>
          <div className="text-zinc-500">Target</div>
          <div className="font-mono font-semibold text-emerald-200">{ptbTarget.nextTargetLabel}</div>
        </div>
        <div>
          <div className="text-zinc-500">Momentum</div>
          <div className="font-semibold text-zinc-200">{ptbTarget.momentum}</div>
        </div>
        <div>
          <div className="text-zinc-500">Risk</div>
          <div className="font-semibold text-amber-200">{ptbTarget.reversalRisk}</div>
        </div>
        <div>
          <div className="text-zinc-500">Confidence</div>
          <div className="font-mono font-semibold text-zinc-100">{confPct}%</div>
        </div>
      </div>
    </div>
  );
}
