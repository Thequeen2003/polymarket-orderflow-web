import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';

import type { DirectiveAction, TradeDirective } from './tradeDirective';
import type { TradeLevels } from './tradeLevels';
import { suggestLevelsForLane } from './tradeLevels';
import type { LaneEdges, TradeEdge } from './tradeEdgeCalculator';
import type { DirectiveStability } from './directiveStability';
import type { DirectiveDiscrepancy } from './directiveDiscrepancyGuard';
import type { ReEntryGuardCheck } from './reEntryGuard';
import type { SizingMultiplier } from './directiveSizingMultiplier';
import type { DirectiveJournal } from './directiveJournal';
import type { NoTradeScore } from './noTradeScore';
import type { SwitchForecast } from './sectionalMomentum';
import { buildTraderDiscipline, type TraderDiscipline } from './traderDiscipline';
import {
  buildOperatorVerdict,
  type OperatorVerdict,
  type VerdictColor,
} from './operatorVerdict';
import { buildEntryProfitBrief } from './tradeEntryBrief';
import type { BandPlayStep } from './spotBandDeskAction';
import type { CausalBlock } from './tradeCausalSignal';

/** Bell countdown `m:ss` (same convention as the chart header). */
function fmtClock(endsInMs: number | null | undefined): string {
  if (endsInMs == null || !Number.isFinite(endsInMs)) return '—';
  const totalSec = Math.max(0, Math.floor(endsInMs / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

/** Live seconds remaining from last sectional PTB ETA (distance / micro slope). */
function useExitPtbCountdownSec(sf: SwitchForecast | null, active: boolean): number | null {
  const [sec, setSec] = useState<number | null>(null);
  useEffect(() => {
    if (!active || !sf || sf.etaSec == null || !Number.isFinite(sf.etaSec)) {
      setSec(null);
      return;
    }
    const total = Math.max(1, Math.round(sf.etaSec));
    const deadline = Date.now() + total * 1000;
    const tick = () => setSec(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [active, sf?.etaSec, sf?.lane, sf?.confidence, sf?.status]);

  return sec;
}

export type TradeExecutionSnapshot = {
  /** Ms until round / market end — drives the bell clock. */
  endsInMs: number | null;
  /** Sectional switch / exit read (same engine as chart banner). */
  switchForecast: SwitchForecast | null;
  /** PTB cross probability 0..1 when available (fused or model). */
  crossProb01: number | null;
  upLabel: string;
  downLabel: string;
  /** Bracket / paper lane you are working — labels the snapshot “your side”. */
  currentPositionLane?: 'up' | 'down' | null;
  /**
   * When chart shows SWITCH_INCOMING away from the card lane, optional TP/SL for the
   * *incoming* token (same math as boom overlay) — hypothetical until the card flips.
   */
  incomingSwitchLevels?: TradeLevels | null;
};

function ExecutionSnapshotPanel(props: {
  snapshot: TradeExecutionSnapshot;
  directive: TradeDirective;
  levels: TradeLevels | null | undefined;
  verdict: OperatorVerdict;
  compact: boolean;
  /** `exit` — risk strip; `momentumConflict` — card adds one way while chart warns opposite switch. */
  panelMode: 'exit' | 'momentumConflict';
}): ReactElement | null {
  const { snapshot, directive, levels, verdict, compact, panelMode } = props;
  const {
    endsInMs,
    switchForecast: sf,
    crossProb01,
    upLabel,
    downLabel,
    currentPositionLane,
    incomingSwitchLevels,
  } = snapshot;

  const structuralExit = sf?.status === 'EXIT';
  const exitPtbSec = useExitPtbCountdownSec(sf, structuralExit);

  const bellAnchorRef = useRef<{ start: number; remainingMs: number } | null>(null);
  useEffect(() => {
    if (endsInMs != null && Number.isFinite(endsInMs)) {
      bellAnchorRef.current = { start: Date.now(), remainingMs: endsInMs };
    } else {
      bellAnchorRef.current = null;
    }
  }, [endsInMs]);
  const [bellTick, setBellTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setBellTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const liveBellMs = useMemo(() => {
    void bellTick;
    const b = bellAnchorRef.current;
    if (b == null) return endsInMs;
    return Math.max(0, b.remainingMs - (Date.now() - b.start));
  }, [endsInMs, bellTick]);

  const laneLab = directive.lane === 'up' ? upLabel : directive.lane === 'down' ? downLabel : null;
  const incomingLab =
    sf?.incomingLane === 'up' ? upLabel : sf?.incomingLane === 'down' ? downLabel : null;
  const etaShort =
    sf?.etaSec != null && Number.isFinite(sf.etaSec) ? `~${Math.round(sf.etaSec)}s` : 'soon';

  const borderTone =
    panelMode === 'momentumConflict'
      ? 'border-sky-500/40 bg-sky-950/20 ring-sky-900/30'
      : verdict.state === 'EXIT_NOW'
        ? 'border-rose-500/45 bg-rose-950/25 ring-rose-900/35'
        : 'border-amber-500/40 bg-amber-950/20 ring-amber-900/30';

  const flipLine = (() => {
    if (sf?.status === 'SWITCH_INCOMING' && sf.incomingLane) {
      const lab = sf.incomingLane === 'up' ? upLabel : downLabel;
      const eta = sf.etaSec != null && Number.isFinite(sf.etaSec) ? `~${Math.round(sf.etaSec)}s` : 'soon';
      return `Switch forming toward ${lab} · ETA ${eta}`;
    }
    if (sf?.status === 'EXIT' && sf.lane) {
      return `Sectional EXIT on ${sf.lane === 'up' ? upLabel : downLabel}`;
    }
    if (crossProb01 != null && Number.isFinite(crossProb01)) {
      return `PTB cross model ${Math.round(crossProb01 * 100)}%`;
    }
    return null;
  })();

  const tpLine = (() => {
    if (levels && !levels.collapsed && directive.lane) {
      const tpC = (levels.takeProfit * 100).toFixed(1);
      return (
        <>
          Still take profit near{' '}
          <span className="font-mono font-bold text-emerald-100">{levels.takeProfit.toFixed(2)}</span>{' '}
          <span className="text-zinc-400">({tpC}¢)</span>
          <span className="text-zinc-500">
            {' '}
            · +{levels.takeProfitGain.toFixed(2)} vs plan {levels.entry.toFixed(2)}
          </span>
          {panelMode === 'momentumConflict' ? (
            <span className="text-sky-200/90"> · {laneLab}-thesis only while switch forms</span>
          ) : null}
        </>
      );
    }
    if (levels?.collapsed) {
      return <span className="text-amber-100/90">{levels.summary}</span>;
    }
    if (directive.laneMid != null) {
      return (
        <>
          Lane mid <span className="font-mono font-bold text-zinc-100">{directive.laneMid.toFixed(2)}</span>{' '}
          <span className="text-zinc-500">({(directive.laneMid * 100).toFixed(1)}¢)</span>
          <span className="text-zinc-500"> — full TP row when model unlocks.</span>
        </>
      );
    }
    return <span className="text-zinc-500">TP row fills when edge + horizon are available.</span>;
  })();

  return (
    <div
      className={`rounded-xl border px-3 py-2 shadow-inner shadow-black/25 ring-1 ${borderTone} ${
        compact ? 'text-[10px] leading-snug' : 'text-[11px] leading-snug'
      } text-amber-50/95`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[9px] font-black uppercase tracking-[0.16em] text-amber-200/85">
          {panelMode === 'momentumConflict' ? 'Momentum vs card' : 'Exit & timing'}
        </span>
        {currentPositionLane ? (
          <span className="rounded-md border border-zinc-600/60 bg-black/35 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-zinc-300">
            Your side: {currentPositionLane === 'up' ? upLabel : downLabel}
          </span>
        ) : null}
      </div>
      {panelMode === 'momentumConflict' && laneLab && incomingLab ? (
        <p className="mt-1.5 text-[10px] leading-snug text-sky-100/90">
          <span className="font-bold text-sky-50">Card line {laneLab}</span> — chart / slices show a switch forming toward{' '}
          <span className="font-bold text-sky-50">{incomingLab}</span> in {etaShort}.{' '}
          <span className="text-zinc-300">
            TP/SL below stay on <span className="font-semibold text-zinc-200">{laneLab}</span> (current card thesis). If{' '}
            {incomingLab} wins the switch first, ignore those targets for the other side until the card updates.
          </span>
        </p>
      ) : null}
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5">
          <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Time left</div>
          <div className="mt-0.5 font-mono text-sm font-black tabular-nums text-amber-100">{fmtClock(liveBellMs)}</div>
          <div className="text-[9px] text-zinc-500">to bell</div>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5">
          <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">
            {structuralExit ? 'Exit window' : 'Flip pressure'}
          </div>
          {structuralExit && exitPtbSec !== null ? (
            <>
              <div className="mt-0.5 flex items-baseline gap-0.5 font-mono tabular-nums">
                <span className="text-xl font-black text-rose-200">{exitPtbSec}</span>
                <span className="text-sm font-bold text-rose-300/85">s</span>
              </div>
              <div className="text-[9px] leading-tight text-rose-100/80">Est. to PTB at this micro slope</div>
            </>
          ) : structuralExit ? (
            <div className="mt-0.5 text-[10px] leading-snug text-rose-100/85">
              No PTB ETA from slope — use <span className="font-semibold text-amber-100">Time left</span> to bell.
            </div>
          ) : verdict.state === 'EXIT_NOW' || directive.action === 'EXIT' ? (
            <div className="mt-0.5 text-[10px] font-semibold leading-snug text-rose-100/90">
              Card / verdict exit — close on your desk clock; watch tape + bell.
            </div>
          ) : null}
          <div
            className={`font-semibold text-amber-50/95 ${
              structuralExit && exitPtbSec !== null ? 'mt-1.5 text-[9px] leading-snug' : 'mt-0.5'
            }`}
          >
            {flipLine ?? '—'}
          </div>
          {(sf?.status === 'SWITCH_INCOMING' || sf?.status === 'EXIT') &&
          crossProb01 != null &&
          Number.isFinite(crossProb01) ? (
            <div className="mt-1.5">
              <div className="flex justify-between text-[8px] font-bold uppercase tracking-wide text-zinc-500">
                <span>PTB cross</span>
                <span className="tabular-nums">{Math.round(crossProb01 * 100)}%</span>
              </div>
              <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-black/50 ring-1 ring-white/10">
                <div
                  className={`h-full rounded-full ${
                    crossProb01 >= 0.7 ? 'bg-fuchsia-400/85' : crossProb01 >= 0.4 ? 'bg-amber-300/85' : 'bg-emerald-400/80'
                  }`}
                  style={{ width: `${Math.min(100, Math.round(crossProb01 * 100))}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>
        <div className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5 sm:col-span-1">
          <div className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Profit line</div>
          <div className="mt-0.5">{tpLine}</div>
        </div>
      </div>
      {panelMode === 'momentumConflict' && incomingLab && incomingSwitchLevels ? (
        <div className="mt-2 rounded-lg border border-indigo-500/35 bg-indigo-950/25 px-2 py-2 ring-1 ring-indigo-900/30">
          <div className="text-[9px] font-black uppercase tracking-[0.12em] text-indigo-200/90">
            If switch completes · {incomingLab} (preview)
          </div>
          {incomingSwitchLevels.collapsed ? (
            <p className="mt-1 text-[10px] leading-snug text-amber-100/90">{incomingSwitchLevels.summary}</p>
          ) : (
            <div className="mt-1.5 grid grid-cols-3 gap-1.5 text-[10px]">
              {(() => {
                const incDown = incomingSwitchLevels.lane === 'down';
                return (
                  <>
                    <div>
                      <div className="text-[8px] font-bold uppercase text-zinc-500">Entry</div>
                      <div className="font-mono font-bold tabular-nums text-zinc-100">
                        {incomingSwitchLevels.entry.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div
                        className={`text-[8px] font-bold uppercase ${incDown ? 'text-sky-400/85' : 'text-emerald-400/80'}`}
                      >
                        TP
                      </div>
                      <div
                        className={`font-mono font-bold tabular-nums ${incDown ? 'text-sky-100' : 'text-emerald-100'}`}
                      >
                        {incomingSwitchLevels.takeProfit.toFixed(2)}{' '}
                        <span
                          className={`text-[9px] font-semibold ${incDown ? 'text-sky-300/85' : 'text-emerald-300/85'}`}
                        >
                          +{incomingSwitchLevels.takeProfitGain.toFixed(2)}
                        </span>
                      </div>
                    </div>
                    <div>
                      <div className="text-[8px] font-bold uppercase text-rose-400/80">SL</div>
                      <div className="font-mono font-bold tabular-nums text-rose-100">
                        {incomingSwitchLevels.stopLoss.toFixed(2)}{' '}
                        <span className="text-[9px] font-semibold text-rose-300/85">
                          −{incomingSwitchLevels.stopLossLoss.toFixed(2)}
                        </span>
                      </div>
                    </div>
                    <div className="col-span-3 text-[9px] leading-snug text-zinc-400">
                      R:R {incomingSwitchLevels.rrRatio.toFixed(2)} · not active until the card moves to {incomingLab}.
                    </div>
                  </>
                );
              })()}
            </div>
          )}
        </div>
      ) : panelMode === 'momentumConflict' && incomingLab ? (
        <p className="mt-2 text-[9px] leading-snug text-zinc-500">
          No +EV preview row for {incomingLab} yet (flat or −EV vs model at this mid). Watch the switch strip; card TP/SL
          still governs execution.
        </p>
      ) : null}
      {(() => {
        const exitish =
          verdict.state === 'EXIT_NOW' ||
          directive.action === 'EXIT' ||
          directive.action === 'TRIM' ||
          directive.action === 'FLIP';
        const watchfulHold =
          panelMode === 'exit' &&
          currentPositionLane != null &&
          !exitish &&
          !structuralExit &&
          (!sf || (sf.status !== 'SWITCH_INCOMING' && sf.status !== 'EXIT'));
        return watchfulHold ? (
          <p className="mt-2 text-[9px] leading-snug text-zinc-500">
            No sectional exit / switch on your lane yet — bell + PTB cross above still govern risk. When tape fades your
            tag (see playbook), treat prints as exit liquidity.
          </p>
        ) : null;
      })()}
    </div>
  );
}

function TraderDisciplinePanel(props: { coach: TraderDiscipline; compact: boolean }): ReactElement {
  const { coach, compact } = props;
  const tone =
    coach.mode === 'PRESS'
      ? {
          border: 'border-emerald-600/45',
          bg: 'from-emerald-950/35 to-zinc-950/45',
          text: 'text-emerald-100',
          chip: 'border-emerald-500/45 bg-emerald-950/50 text-emerald-100',
        }
      : coach.mode === 'PROBE'
        ? {
            border: 'border-sky-600/45',
            bg: 'from-sky-950/30 to-zinc-950/45',
            text: 'text-sky-100',
            chip: 'border-sky-500/45 bg-sky-950/50 text-sky-100',
          }
        : coach.mode === 'WAIT'
          ? {
              border: 'border-amber-600/45',
              bg: 'from-amber-950/30 to-zinc-950/45',
              text: 'text-amber-100',
              chip: 'border-amber-500/45 bg-amber-950/50 text-amber-100',
            }
          : coach.mode === 'MANAGE'
            ? {
                border: 'border-indigo-600/45',
                bg: 'from-indigo-950/30 to-zinc-950/45',
                text: 'text-indigo-100',
                chip: 'border-indigo-500/45 bg-indigo-950/50 text-indigo-100',
              }
            : {
                border: 'border-rose-600/45',
                bg: 'from-rose-950/30 to-zinc-950/45',
                text: 'text-rose-100',
                chip: 'border-rose-500/45 bg-rose-950/50 text-rose-100',
              };

  return (
    <div className={`rounded-xl border ${tone.border} bg-gradient-to-r ${tone.bg} px-3 py-2.5`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[9px] font-black uppercase tracking-[0.18em] text-zinc-500">Trader coach</div>
          <div className={`mt-0.5 ${compact ? 'text-sm' : 'text-base'} font-black uppercase tracking-tight ${tone.text}`}>
            {coach.mode} · {coach.headline}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-lg border px-2 py-1 text-[10px] font-black uppercase tracking-wide ${tone.chip}`}>
            Quality {coach.score}/100
          </span>
          <span className="rounded-lg border border-zinc-700/70 bg-black/35 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-zinc-200">
            Size {coach.sizePct}%
          </span>
        </div>
      </div>

      <div className="mt-2 grid gap-2 md:grid-cols-3">
        <div className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5">
          <div className="text-[8px] font-black uppercase tracking-wide text-emerald-300/80">Confirmations</div>
          <ul className="mt-1 space-y-1 text-[10px] leading-snug text-zinc-300">
            {(coach.confirmations.length > 0 ? coach.confirmations : ['waiting for stronger evidence']).slice(0, 3).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5">
          <div className="text-[8px] font-black uppercase tracking-wide text-rose-300/80">Blockers</div>
          <ul className="mt-1 space-y-1 text-[10px] leading-snug text-zinc-300">
            {(coach.blockers.length > 0 ? coach.blockers : ['none active']).slice(0, 3).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/25 px-2 py-1.5">
          <div className="text-[8px] font-black uppercase tracking-wide text-sky-300/80">Rules</div>
          <ul className="mt-1 space-y-1 text-[10px] leading-snug text-zinc-300">
            {coach.rules.slice(0, 3).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * Prominent "what should I actually do" card. Renders a single dominant
 * **verdict band** (ENTER / EXIT / HOLD / DON'T TRADE) at the top so the
 * operator sees ONE answer before opening anything else. The **TP/SL** block
 * is always visible directly under the verdict. The rest of the nuance
 * (sizing factors, journal mini-tape, discrepancy warnings, etc.) lives
 * inside a collapsible “Why & sizes” disclosure that is closed by default
 * for clear verdicts (GO / EXIT / STAND_DOWN) and open for ambiguous HOLDs.
 */
export function TradeDirectiveCard(props: {
  directive: TradeDirective | null;
  /** Tighter spacing for narrow contexts (Signals tab). */
  compact?: boolean;
  /** Auto-suggested take-profit / stop-loss levels — null when no actionable trade. */
  levels?: TradeLevels | null;
  /** How long the directive has been stable; flags whipsaw. */
  stability?: DirectiveStability | null;
  /** Sensor disagreement check; surfaces a warning stripe. */
  discrepancy?: DirectiveDiscrepancy | null;
  /** Re-entry cool-down state — when set & active, displays a chip + reduces displayed size. */
  reEntry?: ReEntryGuardCheck | null;
  /** Confidence-adjusted sizing multiplier. When provided, displayed size = nominal × combined. */
  sizingMultiplier?: SizingMultiplier | null;
  /** Rolling decision history. When provided, last 4 entries render as mini-tape. */
  journal?: DirectiveJournal | null;
  /** Optional click handler to export the journal as CSV. When set, renders a small button. */
  onExportJournal?: (() => void) | null;
  /** No-Trade composite. Very high scores with RED tier can force STAND_DOWN (see `buildOperatorVerdict`). */
  noTradeScore?: NoTradeScore | null;
  /** Signals: Spot strip vs Dual chart on opposite lanes — forces STAND_DOWN on fresh entries. */
  crossEngineLaneConflict?: boolean | null;
  /** With `crossEngineLaneConflict`, pass both engine lanes for clearer STAND_DOWN copy (Signals). */
  crossCheckSpotLane?: 'up' | 'down' | null;
  crossCheckDualLane?: 'up' | 'down' | null;
  /**
   * When set (chart embed), shows **Exit & timing**: bell countdown, sectional switch ETA,
   * PTB cross %, and the numeric TP line (prob + ¢) for EXIT / trim / flip and live switch risk.
   */
  executionSnapshot?: TradeExecutionSnapshot | null;
  /** Per-lane book from the terminal EV engine — enables Up+Down TP/SL rows together. */
  laneEdges?: LaneEdges | null;
  /** Cross prob + time left; paired with `laneEdges` for dual TP/SL. */
  tpSlHorizon?: { crossProb: number | null; endsInMs: number | null } | null;
  /** Signals desk: show one TP/SL row for the answer lane only (no Up+Down block). */
  singleOutcomeTpSl?: boolean;
  /** When dual TP/SL is shown, highlights the outcome shares the operator said they hold. */
  heldOutcomeLane?: 'up' | 'down' | null;
  /**
   * Signals desk: render `children` after timing snapshot and before TP/SL
   * (e.g. “I entered” ack between entry verdict and bracket).
   */
  deskFlow?: boolean;
  children?: ReactNode;
  upOutcomeLabel?: string;
  downOutcomeLabel?: string;
  /** Chart band playbook phase — gates entry box (confirm / enter / wait). */
  bandPlayStep?: BandPlayStep | null;
  /** Generator → rise → effect → signal chain (Signals desk). */
  causalBlocks?: CausalBlock[];
}): ReactElement | null {
  const {
    directive,
    compact,
    levels,
    stability,
    discrepancy,
    reEntry,
    sizingMultiplier,
    journal,
    onExportJournal,
    noTradeScore,
    crossEngineLaneConflict = false,
    crossCheckSpotLane = null,
    crossCheckDualLane = null,
    executionSnapshot = null,
    laneEdges = null,
    tpSlHorizon = null,
    singleOutcomeTpSl = false,
    heldOutcomeLane = null,
    deskFlow = false,
    children = null,
    upOutcomeLabel = 'UP',
    downOutcomeLabel = 'DOWN',
    bandPlayStep = null,
    causalBlocks = [],
  } = props;

  const causalLabel: Record<CausalBlock['id'], string> = {
    generator: 'Generator',
    rise: 'Rise',
    effect: 'Effect',
    signal: 'Signal',
    warn: 'Conflict',
  };

  const playbookChip = useMemo(() => {
    if (!bandPlayStep) return null;
    if (bandPlayStep === 'confirm') {
      return { label: 'Confirm', body: 'Break out of the PTB band before sizing in.', tone: 'amber' as const };
    }
    if (bandPlayStep === 'weak_sep') {
      return { label: 'Wait', body: 'Weak separation — timing only, no press.', tone: 'amber' as const };
    }
    if (bandPlayStep === 'stand_aside') {
      return { label: 'Stand aside', body: 'Spot is on the other side of PTB for this view.', tone: 'zinc' as const };
    }
    if (bandPlayStep === 'entry') {
      return { label: 'Enter', body: 'Edge live — use entry / TP / SL below on pullbacks.', tone: 'emerald' as const };
    }
    return null;
  }, [bandPlayStep]);

  const verdict = useMemo<OperatorVerdict>(
    () =>
      buildOperatorVerdict({
        directive,
        levels: levels ?? null,
        stability: stability ?? null,
        discrepancy: discrepancy ?? null,
        reEntry: reEntry ?? null,
        sizingMultiplier: sizingMultiplier ?? null,
        noTradeScore: noTradeScore ?? null,
        crossEngineLaneConflict: !!crossEngineLaneConflict,
        crossCheckSpotLane: crossCheckSpotLane ?? null,
        crossCheckDualLane: crossCheckDualLane ?? null,
      }),
    [directive, levels, stability, discrepancy, reEntry, sizingMultiplier, noTradeScore, crossEngineLaneConflict, crossCheckSpotLane, crossCheckDualLane],
  );
  const tpAnswerHighlightLane = useMemo(
    () => (directive ? resolveTpAnswerHighlightLane(verdict, directive) : null),
    [verdict.isStandDown, verdict.state, directive?.lane, directive],
  );
  const entryProfitBrief = useMemo(
    () =>
      directive ? buildEntryProfitBrief(verdict, directive, levels, upOutcomeLabel, downOutcomeLabel) : null,
    [verdict, directive, levels, upOutcomeLabel, downOutcomeLabel],
  );
  const traderDiscipline = useMemo<TraderDiscipline>(
    () =>
      buildTraderDiscipline({
        directive,
        verdict,
        levels: levels ?? null,
        noTradeScore: noTradeScore ?? null,
        stability: stability ?? null,
        reEntry: reEntry ?? null,
        sizingMultiplier: sizingMultiplier ?? null,
      }),
    [directive, verdict, levels, noTradeScore, stability, reEntry, sizingMultiplier],
  );
  const verdictPalette = VERDICT_PALETTE[verdict.color];
  const { showTimingStrip, snapshotPanelMode, hasMomentumVsCardClash } = useMemo(() => {
    if (!executionSnapshot) {
      return {
        showTimingStrip: false,
        snapshotPanelMode: 'exit' as const,
        hasMomentumVsCardClash: false,
      };
    }
    const sf = executionSnapshot.switchForecast;
    const positioned = executionSnapshot.currentPositionLane != null;
    const exitish =
      verdict.state === 'EXIT_NOW' ||
      directive?.action === 'EXIT' ||
      directive?.action === 'TRIM' ||
      directive?.action === 'FLIP';
    const clashMomentum =
      !verdict.isStandDown &&
      (verdict.state === 'GO_LONG' || verdict.state === 'GO_SHORT') &&
      (directive?.action === 'INITIATE' || directive?.action === 'ADD') &&
      directive?.lane != null &&
      sf?.status === 'SWITCH_INCOMING' &&
      sf.incomingLane != null &&
      directive != null &&
      sf.incomingLane !== directive.lane;
    // While the operator has affirmed a position, keep bell / cross / flip readout
    // visible even on HOLD — otherwise "heading down" moments hide the strip until EXIT prints.
    const stripUseful = exitish || clashMomentum || positioned;
    const panelMode: 'exit' | 'momentumConflict' = exitish ? 'exit' : clashMomentum ? 'momentumConflict' : 'exit';
    return {
      showTimingStrip: stripUseful,
      snapshotPanelMode: panelMode,
      hasMomentumVsCardClash: clashMomentum,
    };
  }, [executionSnapshot, verdict.state, verdict.isStandDown, directive?.action, directive?.lane, directive]);
  const switchIncomingLabelForTpFootnote = useMemo(() => {
    if (snapshotPanelMode !== 'momentumConflict' || !executionSnapshot?.switchForecast?.incomingLane) return null;
    const il = executionSnapshot.switchForecast.incomingLane;
    return il === 'up' ? executionSnapshot.upLabel : executionSnapshot.downLabel;
  }, [snapshotPanelMode, executionSnapshot]);

  if (!directive) return null;

  // Default-open details only for HOLD (ambiguous — operator wants context).
  // Clear verdicts (GO/EXIT/STAND_DOWN) hide the chip jungle until requested.
  const detailsDefaultOpen = verdict.state === 'HOLD';

  const palette = ACTION_PALETTE[directive.action];
  // If a sizing multiplier is provided, show the *adjusted* size as the primary
  // number. The original directive size is still tracked as `nominalSizePct` for
  // a small "raw 50%" subscript when the multiplier shrunk things meaningfully.
  const nominalSize = directive.recommendedSize ?? 0;
  const effectiveSize = sizingMultiplier ? nominalSize * sizingMultiplier.combined : nominalSize;
  const sizePct = Math.round(effectiveSize * 100);
  const nominalSizePct = Math.round(nominalSize * 100);
  const sizeWasReduced = sizingMultiplier != null && sizingMultiplier.combined < 0.95 && nominalSizePct > 0;

  return (
    <div className="space-y-2">
      {/*
        VERDICT BAND — the single dominant answer. Always visible, big bold,
        color-coded by verdict.color. Operator should be able to act from this
        alone without expanding details.
      */}
      <div
        className={`rounded-2xl border-2 ${verdictPalette.border} bg-gradient-to-r ${verdictPalette.bg} px-4 ${
          compact ? 'py-3' : 'py-4'
        } shadow-xl shadow-black/40`}
        data-verdict={verdict.state}
      >
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full ${verdictPalette.dot} text-2xl font-black text-zinc-950 shadow-md shadow-black/50 ${
              verdict.state === 'EXIT_NOW' || directive.urgency === 'now' ? 'animate-pulse' : ''
            }`}
          >
            {verdict.state === 'GO_LONG' ? '▲' : verdict.state === 'GO_SHORT' ? '▼' : verdictPalette.icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span
                className={`font-black uppercase tracking-tight leading-none ${
                  compact ? 'text-3xl sm:text-4xl' : 'text-2xl sm:text-3xl'
                } ${verdictPalette.text}`}
              >
                {verdict.bigVerb}
              </span>
              <span
                className={`rounded-md border px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${
                  verdict.confidence === 'HIGH'
                    ? 'border-amber-300/60 bg-amber-300/15 text-amber-100'
                    : verdict.confidence === 'MED'
                      ? 'border-indigo-300/45 bg-indigo-300/10 text-indigo-100'
                      : 'border-zinc-700/70 bg-zinc-900/40 text-zinc-300'
                }`}
              >
                {verdict.confidence}
              </span>
              {directive.urgency === 'now' && !verdict.isStandDown ? (
                hasMomentumVsCardClash ? (
                  <span
                    className="rounded-md border border-sky-500/55 bg-sky-950/45 px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-sky-100"
                    title="Sectional tape is winding toward the other side — see Momentum vs card below."
                  >
                    Switch risk
                  </span>
                ) : (
                  <span className="rounded-md border border-rose-400/65 bg-rose-950/45 px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-rose-100 animate-pulse">
                    ACT NOW
                  </span>
                )
              ) : null}
            </div>
            <p className={`mt-1 text-sm font-semibold leading-snug ${verdictPalette.headlineText}`}>
              {verdict.headline}
            </p>
            {compact &&
            !verdict.isStandDown &&
            directive.lane != null &&
            (directive.action === 'INITIATE' || directive.action === 'ADD' || directive.action === 'FLIP') ? (
              <p className="mt-2 rounded-lg border border-zinc-700/60 bg-black/40 px-2.5 py-2 text-[10px] leading-snug text-zinc-400">
                <span className="font-bold uppercase tracking-wide text-zinc-300">Polymarket outcome · </span>
                This lane sizes conditional shares for{' '}
                <span className="font-semibold text-zinc-100">
                  {directive.lane === 'up' ? upOutcomeLabel : downOutcomeLabel}
                </span>
                . That is the token named in your market — it is not the same as “BTC goes down” unless that token is literally “down wins.”
              </p>
            ) : null}
            {!(verdict.isStandDown && verdict.blockers.length > 0) ? (
              <p className="mt-0.5 text-[11px] leading-snug text-zinc-300/80">{verdict.reason}</p>
            ) : null}
            {verdict.blockers.length > 0 && verdict.isStandDown ? (
              <ul className="mt-1.5 flex flex-wrap gap-1 text-[10px]">
                {verdict.blockers.slice(0, 4).map((b, i) => (
                  <li
                    key={i}
                    className="rounded border border-rose-500/45 bg-rose-950/30 px-1.5 py-0.5 font-bold uppercase tracking-wide text-rose-100"
                  >
                    {b}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </div>

      {playbookChip ? (
        <div
          className={`rounded-lg border px-3 py-2 text-[11px] leading-snug ${
            playbookChip.tone === 'amber'
              ? 'border-amber-600/50 bg-amber-950/25 text-amber-100'
              : playbookChip.tone === 'emerald'
                ? 'border-emerald-600/45 bg-emerald-950/20 text-emerald-100'
                : 'border-zinc-700/60 bg-zinc-900/40 text-zinc-300'
          }`}
        >
          <span className="text-[9px] font-black uppercase tracking-[0.18em] text-white/50">{playbookChip.label}</span>
          <p className="mt-0.5 font-semibold">{playbookChip.body}</p>
        </div>
      ) : null}

      <TraderDisciplinePanel coach={traderDiscipline} compact={!!compact} />

      {causalBlocks.length > 0 ? (
        <div className="rounded-lg border border-indigo-500/35 bg-indigo-950/20 px-3 py-2.5">
          <div className="text-[9px] font-black uppercase tracking-[0.2em] text-indigo-200/70">
            Causal chain · generator → rise → effect → signal
          </div>
          <ul className="mt-1.5 space-y-1.5">
            {causalBlocks.map((b, i) => (
              <li
                key={`${b.id}-${i}`}
                className={`text-[10px] font-medium leading-snug ${
                  b.id === 'warn'
                    ? 'text-amber-100'
                    : b.id === 'signal'
                      ? 'text-emerald-100'
                      : 'text-indigo-50/95'
                }`}
              >
                <span
                  className={`font-black uppercase tracking-wide ${
                    b.id === 'warn'
                      ? 'text-amber-300/90'
                      : b.id === 'signal'
                        ? 'text-emerald-300/90'
                        : 'text-indigo-300/80'
                  }`}
                >
                  {causalLabel[b.id]} ·{' '}
                </span>
                {b.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {entryProfitBrief && bandPlayStep !== 'confirm' && bandPlayStep !== 'weak_sep' ? (
        <div
          className={`rounded-xl border px-3 py-2.5 shadow-inner ring-1 ${
            verdict.state === 'GO_SHORT'
              ? 'border-rose-800/50 bg-gradient-to-r from-rose-950/30 to-zinc-950/50 ring-rose-900/30'
              : 'border-emerald-800/50 bg-gradient-to-r from-emerald-950/25 to-zinc-950/50 ring-emerald-900/28'
          }`}
        >
          <div className="text-[9px] font-black uppercase tracking-[0.16em] text-zinc-500">
            Entry point & desired profit · {entryProfitBrief.token}
          </div>
          <p className="mt-1 text-[11px] font-semibold leading-snug text-zinc-200">
            <span className="font-bold text-zinc-500">When: </span>
            {entryProfitBrief.whenCopy}
          </p>
          {entryProfitBrief.mode === 'full' ? (
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-zinc-800/70 bg-black/35 px-2 py-1.5">
                <div className="text-[8px] font-bold uppercase tracking-wide text-zinc-500">Entry (~)</div>
                <div className="font-mono text-base font-black tabular-nums text-zinc-100">
                  {entryProfitBrief.entryCents.toFixed(1)}¢
                </div>
                <div className="mt-0.5 text-[9px] text-zinc-500">Limit / join bid zone</div>
              </div>
              <div className="rounded-lg border border-emerald-700/45 bg-emerald-950/35 px-2 py-1.5 ring-1 ring-emerald-500/25">
                <div className="text-[8px] font-bold uppercase tracking-wide text-emerald-300/95">Desired profit (TP)</div>
                <div className="font-mono text-base font-black tabular-nums text-emerald-100">
                  {entryProfitBrief.tpCents.toFixed(1)}¢
                </div>
                <div className="mt-0.5 text-[10px] font-semibold text-emerald-200/95">
                  +{entryProfitBrief.profitCents.toFixed(1)}¢ / share · R:R {entryProfitBrief.rr.toFixed(2)}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800/70 bg-black/35 px-2 py-1.5">
                <div className="text-[8px] font-bold uppercase tracking-wide text-zinc-500">Stop (~)</div>
                <div className="font-mono text-base font-black tabular-nums text-rose-100">
                  {entryProfitBrief.slCents.toFixed(1)}¢
                </div>
                <div className="mt-0.5 text-[9px] text-zinc-500">Where thesis breaks</div>
              </div>
            </div>
          ) : null}
          {entryProfitBrief.mode === 'mid_only' ? (
            <>
              <div className="mt-2 font-mono text-sm font-black tabular-nums text-zinc-100">
                Working mid · {entryProfitBrief.entryCents.toFixed(1)}¢
              </div>
              <p className="mt-1 text-[11px] leading-snug text-zinc-400">{entryProfitBrief.note}</p>
            </>
          ) : null}
          {entryProfitBrief.mode === 'wait' ? (
            <p className="mt-2 text-[11px] leading-snug text-zinc-400">{entryProfitBrief.note}</p>
          ) : null}
        </div>
      ) : null}

      {showTimingStrip && executionSnapshot ? (
        <ExecutionSnapshotPanel
          snapshot={executionSnapshot}
          directive={directive}
          levels={levels}
          verdict={verdict}
          compact={!!compact}
          panelMode={snapshotPanelMode}
        />
      ) : null}

      {deskFlow && children ? <div className="space-y-2">{children}</div> : null}

      {/* TP/SL — always visible (not inside collapsible details). */}
      <TradeLevelsPanel
        levels={levels ?? null}
        outcomeName={
          directive.laneOutcomeLabel ??
          (directive.lane === 'up' ? 'UP' : directive.lane === 'down' ? 'DOWN' : null)
        }
        switchIncomingLabel={switchIncomingLabelForTpFootnote}
        laneEdges={laneEdges}
        tpSlHorizon={tpSlHorizon}
        singleLaneOnly={singleOutcomeTpSl}
        heldLane={heldOutcomeLane}
        upOutcomeLabel={upOutcomeLabel}
        downOutcomeLabel={downOutcomeLabel}
        directiveLane={tpAnswerHighlightLane}
      />

      {/* DETAILS DISCLOSURE — chips, journal, discrepancy, etc. Collapsed by default. */}
      <details
        className={`group rounded-xl border ${palette.border} bg-gradient-to-r ${palette.bg} px-3 ${
          compact ? 'py-1.5' : 'py-2'
        }`}
        open={detailsDefaultOpen}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 select-none">
          <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-zinc-300/85">
            <span className="text-zinc-500 group-open:rotate-90 transition-transform">▶</span>
            Why & sizes · {directive.action} {directive.lane ? (directive.lane === 'up' ? '↑' : '↓') : ''}
          </span>
          {stability ? (
            <span className="text-[9px] uppercase tracking-wider text-zinc-500 tabular-nums">
              {stability.tier} · {Math.round(stability.msSinceChange / 1000)}s
            </span>
          ) : null}
        </summary>
      <div className="mt-2 flex flex-wrap items-start gap-3">
        <span
          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${palette.dot} text-lg font-black text-zinc-950 shadow shadow-black/40`}
        >
          {palette.icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`text-base font-black uppercase tracking-tight ${palette.text} sm:text-lg`}
              data-action={directive.action}
            >
              {directive.headline}
            </span>
            <span
              className={`rounded-md border px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${
                directive.confidence === 'HIGH'
                  ? 'border-amber-300/60 bg-amber-300/15 text-amber-100'
                  : directive.confidence === 'MED'
                    ? 'border-indigo-300/45 bg-indigo-300/10 text-indigo-100'
                    : 'border-zinc-700/70 bg-zinc-900/40 text-zinc-300'
              }`}
            >
              {directive.confidence}
            </span>
            <span
              className={`rounded-md border px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${
                directive.urgency === 'now'
                  ? 'border-rose-400/65 bg-rose-950/45 text-rose-100 animate-pulse'
                  : directive.urgency === 'soon'
                    ? 'border-amber-400/55 bg-amber-950/35 text-amber-100'
                    : 'border-zinc-700/70 bg-zinc-900/40 text-zinc-300'
              }`}
            >
              {directive.urgency === 'now' ? 'ACT NOW' : directive.urgency === 'soon' ? 'ACT SOON' : 'PATIENT'}
            </span>
            {nominalSize > 0 ? (
              <span
                className={`rounded-md border px-1.5 py-0.5 text-[10px] font-black uppercase tabular-nums ${
                  sizeWasReduced
                    ? 'border-amber-400/55 bg-amber-950/35 text-amber-100'
                    : 'border-emerald-400/55 bg-emerald-950/40 text-emerald-100'
                }`}
                title={
                  sizingMultiplier
                    ? `Adjusted size — nominal ${nominalSizePct}% × ${sizingMultiplier.combined.toFixed(2)} (${
                        sizingMultiplier.notes.join(', ') || 'full confidence'
                      })`
                    : 'Suggested fraction of available bank — scale by your own risk.'
                }
              >
                size {sizePct}%
                {sizeWasReduced ? (
                  <span className="ml-1 text-[9px] font-semibold text-amber-300/70">
                    of {nominalSizePct}%
                  </span>
                ) : null}
              </span>
            ) : null}
            {reEntry?.onCooldown ? (
              <span
                className="rounded-md border border-rose-400/65 bg-rose-950/40 px-1.5 py-0.5 text-[10px] font-black uppercase tabular-nums text-rose-100 animate-pulse"
                title={reEntry.reason}
              >
                cool-down {Math.ceil(reEntry.msRemaining / 1000)}s
              </span>
            ) : null}
            {directive.edgePerShareUsd != null && directive.laneMid != null ? (
              <span
                className={`rounded-md border px-1.5 py-0.5 text-[10px] font-black tabular-nums ${
                  directive.edgePerShareUsd >= 0.12
                    ? 'border-emerald-400/65 bg-emerald-950/40 text-emerald-100'
                    : directive.edgePerShareUsd >= 0.05
                      ? 'border-emerald-400/45 bg-emerald-950/25 text-emerald-100'
                      : directive.edgePerShareUsd >= 0
                        ? 'border-amber-400/50 bg-amber-950/30 text-amber-100'
                        : 'border-rose-400/55 bg-rose-950/35 text-rose-100'
                }`}
                title={
                  directive.laneWinProb != null
                    ? `Model ${Math.round(directive.laneWinProb * 100)}% vs market mid ${directive.laneMid.toFixed(2)} → edge ${directive.edgePerShareUsd >= 0 ? '+' : ''}${directive.edgePerShareUsd.toFixed(3)}/share`
                    : undefined
                }
              >
                edge {directive.edgePerShareUsd >= 0 ? '+' : ''}{directive.edgePerShareUsd.toFixed(2)}/sh
              </span>
            ) : null}
            {directive.defensive ? (
              <span className="rounded-md border border-zinc-600/60 bg-black/40 px-1.5 py-0.5 text-[10px] font-bold uppercase text-zinc-300">
                defensive
              </span>
            ) : null}
            {stability ? (
              <span
                className={`rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                  stability.tier === 'whipsaw'
                    ? 'border-rose-400/65 bg-rose-950/45 text-rose-100 animate-pulse'
                    : stability.tier === 'forming'
                      ? 'border-amber-400/55 bg-amber-950/35 text-amber-100'
                      : stability.tier === 'consolidating'
                        ? 'border-indigo-400/45 bg-indigo-950/30 text-indigo-100'
                        : 'border-emerald-400/55 bg-emerald-950/30 text-emerald-100'
                }`}
                title={stability.summary}
              >
                {stability.tier === 'whipsaw'
                  ? `WHIPSAW · ${stability.flipsLastMin}/min`
                  : stability.tier === 'stable'
                    ? `STABLE · ${Math.round(stability.msSinceChange / 1000)}s`
                    : stability.tier === 'consolidating'
                      ? `${Math.round(stability.msSinceChange / 1000)}s`
                      : `FRESH · ${Math.round(stability.msSinceChange / 1000)}s`}
              </span>
            ) : null}
          </div>
          <p className={`mt-1 text-[11px] leading-relaxed ${palette.text}/85`}>{directive.reason}</p>
          {directive.evidence.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-[10px] leading-snug text-zinc-300/85">
              {directive.evidence.slice(0, 4).map((e, i) => (
                <li key={i}>• {e}</li>
              ))}
            </ul>
          ) : null}
          {directive.recommendedSize > 0 ? (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-400">
                Suggested size
              </span>
              <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-900/70 ring-1 ring-zinc-800/70">
                <div
                  className={`absolute inset-y-0 left-0 rounded-full transition-all ${
                    sizePct >= 70 ? 'bg-emerald-400/85' : sizePct >= 40 ? 'bg-amber-400/85' : 'bg-zinc-500'
                  }`}
                  style={{ width: `${Math.max(2, Math.min(100, sizePct))}%` }}
                />
              </div>
              <span className="w-9 text-right text-[10px] font-black tabular-nums text-zinc-100">
                {sizePct}%
              </span>
            </div>
          ) : null}
          {directive.laneMid != null && directive.laneWinProb != null ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-zinc-400/85">
              <span>
                Model:{' '}
                <strong className="text-zinc-100 tabular-nums">
                  {Math.round(directive.laneWinProb * 100)}%
                </strong>
              </span>
              <span className="text-zinc-600">·</span>
              <span>
                Market mid:{' '}
                <strong className="text-zinc-100 tabular-nums">
                  {directive.laneMid.toFixed(2)}
                </strong>
              </span>
              <span className="text-zinc-600">·</span>
              <span>
                Breakeven:{' '}
                <strong className="text-zinc-100 tabular-nums">
                  {(directive.laneMid * 100).toFixed(0)}%
                </strong>
              </span>
            </div>
          ) : null}

          {discrepancy && discrepancy.any ? (
            <div
              className={`mt-2 rounded-lg border px-2 py-1.5 text-[10px] leading-relaxed ${
                discrepancy.shouldBlock
                  ? 'border-rose-400/55 bg-rose-950/30 text-rose-100'
                  : 'border-amber-400/45 bg-amber-950/25 text-amber-100'
              }`}
              title={`${discrepancy.warnings.length} discrepancy warning${discrepancy.warnings.length === 1 ? '' : 's'} (score ${discrepancy.score})`}
            >
              <div className="mb-0.5 flex items-center gap-1.5">
                <span className="text-[9px] font-black uppercase tracking-wider">
                  {discrepancy.shouldBlock ? '⚠️ Disagreement' : '⚐ Notes'}
                </span>
                <span className="tabular-nums opacity-80">score {discrepancy.score}</span>
              </div>
              <ul className="space-y-0.5">
                {discrepancy.warnings.slice(0, 3).map((w, i) => (
                  <li key={i}>
                    <strong className="font-bold">{w.severity.toUpperCase()}:</strong> {w.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {reEntry?.onCooldown ? (
            <div
              className="mt-2 rounded-lg border border-rose-400/55 bg-rose-950/30 px-2 py-1.5 text-[10px] leading-snug text-rose-100"
              title={reEntry.reason}
            >
              <strong className="text-[9px] font-black uppercase tracking-wider text-rose-200">
                ⛔ Re-entry guard
              </strong>{' '}
              {reEntry.reason}
            </div>
          ) : null}

          {sizingMultiplier && sizingMultiplier.notes.length > 0 && nominalSize > 0 ? (
            <div
              className="mt-1.5 flex flex-wrap items-center gap-1 text-[9px] uppercase tracking-wider text-zinc-400/85"
              title={`Combined multiplier ×${sizingMultiplier.combined.toFixed(2)} — applied to nominal ${nominalSizePct}%`}
            >
              <span className="font-bold text-zinc-500">size adj:</span>
              {sizingMultiplier.notes.map((n, i) => (
                <span
                  key={i}
                  className="rounded border border-zinc-700/60 bg-zinc-900/40 px-1 py-px font-semibold text-zinc-300"
                >
                  {n}
                </span>
              ))}
            </div>
          ) : null}

          {journal && journal.entries.length >= 2 ? (
            <div className="mt-2 rounded-lg border border-zinc-800/65 bg-black/25 px-2 py-1 text-[10px]">
              <div className="mb-0.5 flex items-center justify-between text-[9px] uppercase tracking-wider text-zinc-500">
                <span className="font-bold">Recent calls</span>
                <span className="flex items-center gap-2 tabular-nums text-zinc-600">
                  <span>
                    {journal.stats.total} in {journal.stats.windowMinutes.toFixed(1)}m
                    {journal.stats.averageAgreement != null
                      ? ` · agree ${Math.round(journal.stats.averageAgreement)}%`
                      : ''}
                  </span>
                  {onExportJournal ? (
                    <button
                      type="button"
                      onClick={onExportJournal}
                      className="rounded border border-zinc-700/60 bg-zinc-900/60 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-zinc-300 hover:bg-zinc-800"
                      title="Export call history as CSV (or press 'e')"
                    >
                      ⬇ CSV
                    </button>
                  ) : null}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {journal.entries.slice(-5).map((e, i) => (
                  <span
                    key={`${e.ts}-${i}`}
                    className={`tabular-nums rounded border px-1 py-0.5 text-[9px] font-semibold ${journalChipColor(
                      e.action,
                    )}`}
                    title={`${new Date(e.ts).toLocaleTimeString()} — ${e.headline}${
                      e.agreementScore != null ? ` (${Math.round(e.agreementScore)}% agree)` : ''
                    }`}
                  >
                    {e.action}
                    {e.lane ? <span className="ml-0.5 opacity-75">{e.lane === 'up' ? '↑' : '↓'}</span> : null}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      </details>
    </div>
  );
}

const VERDICT_PALETTE: Record<VerdictColor, {
  bg: string;
  border: string;
  text: string;
  headlineText: string;
  dot: string;
  icon: string;
}> = {
  green: {
    bg: 'from-emerald-700/65 to-emerald-900/45',
    border: 'border-emerald-300/70',
    text: 'text-emerald-50',
    headlineText: 'text-emerald-100',
    dot: 'bg-emerald-300',
    icon: '▲',
  },
  red: {
    bg: 'from-rose-700/70 to-rose-900/55',
    border: 'border-rose-300/70',
    text: 'text-rose-50',
    headlineText: 'text-rose-100',
    dot: 'bg-rose-300',
    icon: '✕',
  },
  amber: {
    bg: 'from-amber-700/55 to-amber-900/40',
    border: 'border-amber-300/65',
    text: 'text-amber-50',
    headlineText: 'text-amber-100',
    dot: 'bg-amber-300',
    icon: '－',
  },
  blue: {
    bg: 'from-indigo-700/55 to-indigo-900/40',
    border: 'border-indigo-300/55',
    text: 'text-indigo-50',
    headlineText: 'text-indigo-100',
    dot: 'bg-indigo-300',
    icon: '＝',
  },
  gray: {
    bg: 'from-zinc-800/65 to-zinc-900/55',
    border: 'border-zinc-600/70',
    text: 'text-zinc-100',
    headlineText: 'text-zinc-200',
    dot: 'bg-zinc-400',
    icon: '⏸',
  },
};

/**
 * Which TP/SL row gets the amber ring — must track the **operator verdict**, not raw
 * `directive.lane` alone. Otherwise whipsaw / no-trade can STAND_DOWN while the directive
 * still carries an INITIATE lane, and "Answer lane" looks broken or misleading.
 */
function resolveTpAnswerHighlightLane(verdict: OperatorVerdict, directive: TradeDirective): 'up' | 'down' | null {
  if (verdict.isStandDown) return null;
  switch (verdict.state) {
    case 'GO_LONG':
      return 'up';
    case 'GO_SHORT':
      return 'down';
    default:
      return directive.lane;
  }
}

function LaneTpMiniRow(props: {
  lane: 'up' | 'down';
  outcomeLabel: string;
  display: TradeLevels | null;
  rawEdge: TradeEdge | null;
  isCardLane: boolean;
  /** Operator-affirmed Polymarket shares (Signals desk). */
  isHeldLane?: boolean;
}): ReactElement {
  const { lane, outcomeLabel, display, rawEdge, isCardLane, isHeldLane = false } = props;
  const downSkin = lane === 'down';
  const ringClass = isCardLane ? 'ring-1 ring-amber-500/40' : isHeldLane ? 'ring-1 ring-violet-500/40' : '';

  const badges =
    isCardLane || isHeldLane ? (
      <div className="flex flex-wrap justify-end gap-1">
        {isCardLane ? (
          <span
            className="rounded border border-amber-500/40 bg-amber-950/35 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-amber-100/95"
            title="Matches the verdict band (Enter Up/Down, Hold, Exit…). Hidden during stand-down."
          >
            Answer
          </span>
        ) : null}
        {isHeldLane ? (
          <span
            className="rounded border border-violet-500/40 bg-violet-950/35 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-violet-100/95"
            title="Outcome you tapped as held — not the same as spot direction."
          >
            You
          </span>
        ) : null}
      </div>
    ) : null;

  if (display && !display.collapsed) {
    return (
      <div
        className={`rounded-lg border px-2 py-1.5 shadow-inner shadow-black/20 ${ringClass} ${
          downSkin
            ? 'border-rose-900/45 bg-gradient-to-br from-zinc-950/85 to-rose-950/20'
            : 'border-emerald-900/40 bg-gradient-to-br from-zinc-950/80 to-emerald-950/18'
        }`}
      >
        <div className="mb-1 flex flex-wrap items-center justify-between gap-1">
          <span
            className={`text-[10px] font-black uppercase tracking-[0.12em] ${downSkin ? 'text-rose-200/90' : 'text-emerald-200/90'}`}
          >
            {outcomeLabel}
          </span>
          {badges}
        </div>
        <div className="grid grid-cols-3 gap-2 rounded-md border border-zinc-800/70 bg-black/35 px-2 py-1 text-[10px]">
          <div className="flex flex-col">
            <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Entry</span>
            <span className="tabular-nums font-semibold text-zinc-100">{display.entry.toFixed(2)}</span>
          </div>
          <div className="flex flex-col">
            <span
              className={`text-[9px] font-bold uppercase tracking-wider ${downSkin ? 'text-sky-400/90' : 'text-emerald-400/85'}`}
            >
              TP
            </span>
            <span className={`tabular-nums font-bold ${downSkin ? 'text-sky-100' : 'text-emerald-100'}`}>
              {display.takeProfit.toFixed(2)}{' '}
              <span className={`text-[9px] font-semibold ${downSkin ? 'text-sky-300/85' : 'text-emerald-300/85'}`}>
                +{display.takeProfitGain.toFixed(2)}
              </span>
            </span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] font-bold uppercase tracking-wider text-rose-400/85">SL</span>
            <span className="tabular-nums font-bold text-rose-100">
              {display.stopLoss.toFixed(2)}{' '}
              <span className="text-[9px] font-semibold text-rose-300/85">−{display.stopLossLoss.toFixed(2)}</span>
            </span>
          </div>
          <div className="col-span-3 flex justify-between border-t border-zinc-800/60 pt-0.5 text-[9px] text-zinc-500">
            <span>
              R:R <strong className="text-zinc-300">{display.rrRatio.toFixed(2)}</strong>
            </span>
            <span className="max-w-[58%] truncate" title={display.summary}>
              {display.summary}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (display && display.collapsed) {
    return (
      <div
        className={`rounded-lg border px-2 py-2 shadow-inner shadow-black/20 ${ringClass} ${
          downSkin
            ? 'border-rose-800/50 bg-rose-950/30 ring-1 ring-rose-900/25'
            : 'border-amber-800/50 bg-amber-950/25 ring-1 ring-amber-900/20'
        }`}
      >
        <div className="mb-1 flex flex-wrap items-center justify-between gap-1">
          <span
            className={`text-[10px] font-black uppercase tracking-[0.12em] ${downSkin ? 'text-rose-200/90' : 'text-amber-200/90'}`}
          >
            {outcomeLabel}
          </span>
          {badges}
        </div>
        <div className="text-[9px] font-black uppercase tracking-wide text-amber-100/95">Bell · TP/SL pinned to mid</div>
        <p className="mt-1 text-[10px] leading-snug text-zinc-200">{display.summary}</p>
        <div className="mt-1 font-mono text-[11px] font-semibold tabular-nums text-zinc-400">Mid · {display.entry.toFixed(2)}</div>
      </div>
    );
  }

  if (rawEdge) {
    const e = rawEdge.edgePerShareUsd;
    const edgeTxt = `${e >= 0 ? '+' : ''}${e.toFixed(3)}/sh`;
    return (
      <div
        className={`rounded-lg border border-zinc-800/80 bg-zinc-950/50 px-2 py-1.5 shadow-inner shadow-black/20 ${ringClass}`}
      >
        <div className="mb-0.5 flex flex-wrap items-center justify-between gap-1">
          <span className="text-[10px] font-black uppercase tracking-[0.12em] text-zinc-400">{outcomeLabel}</span>
          {badges}
        </div>
        <div className="grid grid-cols-3 gap-2 text-[10px]">
          <div>
            <span className="text-[9px] font-bold uppercase text-zinc-500">Entry</span>
            <div className="tabular-nums font-semibold text-zinc-200">{rawEdge.mid.toFixed(2)}</div>
          </div>
          <div>
            <span className="text-[9px] font-bold uppercase text-zinc-500">TP</span>
            <div className="font-semibold text-zinc-500">—</div>
          </div>
          <div>
            <span className="text-[9px] font-bold uppercase text-zinc-500">SL</span>
            <div className="font-semibold text-zinc-500">—</div>
          </div>
        </div>
        <p className="mt-1 text-[9px] leading-snug text-zinc-500">
          Model edge {edgeTxt}. Bracket width scales with positive edge; otherwise a 4¢ symmetric floor applies when levels load from the chart.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-zinc-800/70 bg-zinc-950/40 px-2 py-1.5 text-[10px] text-zinc-500">
      <span className="font-bold text-zinc-400">{outcomeLabel}</span>
      <span className="text-zinc-600"> — no implied mid on the wire yet.</span>
    </div>
  );
}

function DualOutcomeTpSlBlock(props: {
  laneEdges: LaneEdges;
  horizon: { crossProb: number | null; endsInMs: number | null };
  upOutcomeLabel: string;
  downOutcomeLabel: string;
  directiveLane: 'up' | 'down' | null;
  levels: TradeLevels | null;
  switchIncomingLabel: string | null;
  /** Outcome shares the operator said they hold (Signals desk). */
  heldLane?: 'up' | 'down' | null;
}): ReactElement {
  const {
    laneEdges,
    horizon,
    upOutcomeLabel,
    downOutcomeLabel,
    directiveLane,
    levels,
    switchIncomingLabel,
    heldLane = null,
  } = props;

  const { upLv, downLv } = useMemo(() => {
    const cp = horizon.crossProb;
    const em = horizon.endsInMs;
    return {
      upLv: suggestLevelsForLane({ lane: 'up', laneEdges, crossProb: cp, endsInMs: em }),
      downLv: suggestLevelsForLane({ lane: 'down', laneEdges, crossProb: cp, endsInMs: em }),
    };
  }, [laneEdges, horizon.crossProb, horizon.endsInMs]);

  /** Only replace the whole dual panel when *both* outcome rows are bell-pinned; otherwise keep the other side's numbers visible. */
  const bothLanesPinned =
    upLv != null && downLv != null && upLv.collapsed === true && downLv.collapsed === true;

  if (bothLanesPinned) {
    const summary = upLv.summary ?? downLv.summary ?? 'Bell imminent — TP/SL pinned; exit with market sells or resting brackets.';
    return (
      <div className="rounded-xl border border-rose-800/55 bg-rose-950/30 px-3 py-2 shadow-inner shadow-black/25 ring-1 ring-rose-900/40">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[10px] font-black uppercase tracking-[0.14em] text-rose-200/95">TP / SL</span>
          <span className="text-[9px] font-semibold uppercase tracking-wider text-rose-300/80">Bell imminent</span>
        </div>
        <p className="text-[11px] leading-snug text-rose-100/90">{summary}</p>
      </div>
    );
  }

  const upPick = levels?.lane === 'up' ? levels : upLv;
  const downPick = levels?.lane === 'down' ? levels : downLv;

  return (
    <div className="rounded-xl border border-zinc-700/70 bg-zinc-950/50 px-3 py-2 shadow-inner shadow-black/30 ring-1 ring-zinc-800/60">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] font-black uppercase tracking-[0.14em] text-zinc-400">TP / SL</span>
        <span className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Up + Down</span>
      </div>
      <div className="space-y-2">
        <LaneTpMiniRow
          lane="up"
          outcomeLabel={upOutcomeLabel}
          display={upPick}
          rawEdge={laneEdges.up}
          isCardLane={directiveLane === 'up'}
          isHeldLane={heldLane === 'up'}
        />
        <LaneTpMiniRow
          lane="down"
          outcomeLabel={downOutcomeLabel}
          display={downPick}
          rawEdge={laneEdges.down}
          isCardLane={directiveLane === 'down'}
          isHeldLane={heldLane === 'down'}
        />
      </div>
      {directiveLane == null && !switchIncomingLabel ? (
        <p className="mt-1 text-[9px] leading-snug text-zinc-600">
          Stand-down or no executable side — no row is tagged as the live answer lane.
        </p>
      ) : null}
      {switchIncomingLabel ? (
        <p className="mt-1 rounded-md border border-sky-800/50 bg-sky-950/25 px-2 py-1 text-[9px] leading-snug text-sky-100/90">
          <span className="font-bold text-sky-50">Switch forming toward {switchIncomingLabel}</span>
          {` — TP/SL rows stay on each token until the card flips. `}
          {directiveLane != null ? (
            <>
              The amber tag marks <span className="font-semibold text-sky-50">{directiveLane === 'up' ? upOutcomeLabel : downOutcomeLabel}</span>{' '}
              (model answer lane).
            </>
          ) : (
            <span className="text-sky-200/85">Stand-down — follow the Answer band above; no tagged TP row.</span>
          )}
        </p>
      ) : null}
      {heldLane != null ? (
        <p className="mt-1 text-[9px] leading-snug text-zinc-500">
          <span className="font-semibold text-violet-200/90">You</span> tags the outcome you said you hold;{' '}
          <span className="font-semibold text-amber-200/90">Answer</span> is the model lane on the verdict band. When they diverge, defend your fill first.
        </p>
      ) : null}
    </div>
  );
}

/** TP/SL grid — pinned outside collapsible details so it stays visible at all times. */
function TradeLevelsPanel(props: {
  levels: TradeLevels | null;
  /** Market outcome name for the directive lane — scopes rows to this token's mid, not spot. */
  outcomeName: string | null;
  /** When set, sectional tape is winding toward this side while card stays on `outcomeName`. */
  switchIncomingLabel?: string | null;
  laneEdges?: LaneEdges | null;
  tpSlHorizon?: { crossProb: number | null; endsInMs: number | null } | null;
  /** When true, skip dual Up+Down block and use single-lane TP/SL from `levels`. */
  singleLaneOnly?: boolean;
  upOutcomeLabel?: string;
  downOutcomeLabel?: string;
  /** Verdict-aligned lane for the amber ring (GO_LONG→up, GO_SHORT→down, else directive.lane; null if stand-down). */
  directiveLane?: 'up' | 'down' | null;
  /** Operator-affirmed held outcome — violet “You” tag on dual TP/SL rows. */
  heldLane?: 'up' | 'down' | null;
}): ReactElement {
  const {
    levels,
    outcomeName,
    switchIncomingLabel = null,
    laneEdges = null,
    tpSlHorizon = null,
    singleLaneOnly = false,
    upOutcomeLabel = 'UP',
    downOutcomeLabel = 'DOWN',
    directiveLane = null,
    heldLane = null,
  } = props;

  if (
    !singleLaneOnly &&
    laneEdges &&
    tpSlHorizon &&
    (laneEdges.up != null || laneEdges.down != null)
  ) {
    return (
      <DualOutcomeTpSlBlock
        laneEdges={laneEdges}
        horizon={tpSlHorizon}
        upOutcomeLabel={upOutcomeLabel}
        downOutcomeLabel={downOutcomeLabel}
        directiveLane={directiveLane}
        levels={levels}
        switchIncomingLabel={switchIncomingLabel}
        heldLane={heldLane}
      />
    );
  }

  const outcomeLane = levels?.lane ?? null;
  const downSkin = outcomeLane === 'down';
  const tokenTitle = outcomeName ?? (outcomeLane === 'up' ? 'UP' : outcomeLane === 'down' ? 'DOWN' : null);

  if (levels?.collapsed) {
    return (
      <div className="rounded-xl border border-rose-800/55 bg-rose-950/30 px-3 py-2 shadow-inner shadow-black/25 ring-1 ring-rose-900/40">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[10px] font-black uppercase tracking-[0.14em] text-rose-200/95">TP / SL</span>
          <span className="text-[9px] font-semibold uppercase tracking-wider text-rose-300/80">Bell imminent</span>
        </div>
        <p className="text-[11px] leading-snug text-rose-100/90">{levels.summary}</p>
      </div>
    );
  }

  if (!levels) {
    return (
      <div className="rounded-xl border border-zinc-700/70 bg-zinc-950/50 px-3 py-2 shadow-inner shadow-black/30 ring-1 ring-zinc-800/60">
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[10px] font-black uppercase tracking-[0.14em] text-zinc-400">TP / SL</span>
          <span className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Waiting</span>
        </div>
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-zinc-800/70 bg-black/35 px-2 py-2 text-[10px]">
          <div className="flex flex-col">
            <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Entry</span>
            <span className="tabular-nums font-semibold text-zinc-500">—</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">TP</span>
            <span className="tabular-nums font-semibold text-zinc-500">—</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">SL</span>
            <span className="tabular-nums font-semibold text-zinc-500">—</span>
          </div>
          <div className="col-span-3 border-t border-zinc-800/70 pt-1.5 text-[10px] leading-snug text-zinc-500">
            Preset targets appear when there is a clear +EV lane (INITIATE / ADD / FLIP with edge).
            {tokenTitle ? ` Plan uses ${tokenTitle} token mid.` : ''}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`rounded-xl border px-3 py-2 shadow-inner shadow-black/30 ring-1 ${
        downSkin
          ? 'border-rose-900/45 bg-gradient-to-br from-zinc-950/85 to-rose-950/25 ring-rose-900/35'
          : 'border-emerald-900/40 bg-gradient-to-br from-zinc-950/80 to-emerald-950/20 ring-emerald-900/35'
      }`}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span
          className={`text-[10px] font-black uppercase tracking-[0.14em] ${downSkin ? 'text-rose-200/90' : 'text-emerald-200/90'}`}
        >
          TP / SL
        </span>
        <div className="flex flex-col items-end gap-0.5 text-right">
          <div className="flex flex-wrap items-center justify-end gap-1">
            <span
              className={`text-[9px] font-semibold uppercase tracking-wider ${downSkin ? 'text-rose-400/75' : 'text-emerald-400/70'}`}
            >
              Auto
            </span>
            {levels.toBellBand ? (
              <span className="rounded border border-amber-600/45 bg-amber-950/35 px-1.5 py-px text-[8px] font-bold uppercase tracking-wide text-amber-100/90">
                To bell
              </span>
            ) : null}
          </div>
          {tokenTitle ? (
            <span className="max-w-[14rem] text-[9px] font-bold leading-tight text-zinc-400">{tokenTitle}</span>
          ) : null}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 rounded-lg border border-zinc-800/70 bg-black/35 px-2 py-1.5 text-[10px]">
        <div className="flex flex-col">
          <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">Entry</span>
          <span className="tabular-nums font-semibold text-zinc-100">{levels.entry.toFixed(2)}</span>
        </div>
        <div className="flex flex-col">
          <span
            className={`text-[9px] font-bold uppercase tracking-wider ${downSkin ? 'text-sky-400/90' : 'text-emerald-400/85'}`}
          >
            TP
          </span>
          <span
            className={`tabular-nums font-bold ${downSkin ? 'text-sky-100' : 'text-emerald-100'}`}
            title={`+${levels.takeProfitGain.toFixed(3)}/share`}
          >
            {levels.takeProfit.toFixed(2)}{' '}
            <span className={`text-[9px] font-semibold ${downSkin ? 'text-sky-300/85' : 'text-emerald-300/85'}`}>
              +{levels.takeProfitGain.toFixed(2)}
            </span>
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[9px] font-bold uppercase tracking-wider text-rose-400/85">SL</span>
          <span className="tabular-nums font-bold text-rose-100" title={`−${levels.stopLossLoss.toFixed(3)}/share`}>
            {levels.stopLoss.toFixed(2)}{' '}
            <span className="text-[9px] font-semibold text-rose-300/85">−{levels.stopLossLoss.toFixed(2)}</span>
          </span>
        </div>
        <div className="col-span-3 flex items-center justify-between border-t border-zinc-800/70 pt-1">
          <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500">
            R:R{' '}
            <strong
              className={`tabular-nums ${
                levels.rrRatio >= 1.3
                  ? downSkin
                    ? 'text-sky-200'
                    : 'text-emerald-200'
                  : levels.rrRatio >= 1
                    ? 'text-amber-200'
                    : 'text-zinc-300'
              }`}
            >
              {levels.rrRatio.toFixed(2)}
            </strong>
          </span>
          <span className="min-w-0 max-w-[55%] truncate text-[9px] tracking-wider text-zinc-500" title={levels.summary}>
            {levels.summary}
          </span>
        </div>
      </div>
      {tokenTitle ? (
        <p className="mt-1.5 text-[9px] leading-snug text-zinc-500">
          <span className="font-semibold text-zinc-400">{tokenTitle}</span>
          {` — Entry / TP / SL are this outcome token's implied mid (share price 0–1). They are `}
          <span className="font-semibold text-zinc-400">not</span>
          {` spot vs PTB.`}
        </p>
      ) : null}
      {switchIncomingLabel && tokenTitle ? (
        <p className="mt-1 rounded-md border border-sky-800/50 bg-sky-950/25 px-2 py-1 text-[9px] leading-snug text-sky-100/90">
          <span className="font-bold text-sky-50">Switch forming toward {switchIncomingLabel}</span>
          {` — rows above stay on `}
          <span className="font-semibold text-sky-50">{tokenTitle}</span>
          {` until the directive flips.`}
        </p>
      ) : null}
    </div>
  );
}

function journalChipColor(action: DirectiveAction): string {
  switch (action) {
    case 'INITIATE':
    case 'ADD':
      return 'border-emerald-500/55 bg-emerald-950/35 text-emerald-100';
    case 'HOLD':
      return 'border-indigo-500/45 bg-indigo-950/30 text-indigo-100';
    case 'TRIM':
      return 'border-amber-500/55 bg-amber-950/30 text-amber-100';
    case 'FLIP':
      return 'border-fuchsia-500/55 bg-fuchsia-950/35 text-fuchsia-100';
    case 'EXIT':
    case 'STAND_DOWN':
      return 'border-rose-500/55 bg-rose-950/35 text-rose-100';
    default:
      return 'border-zinc-700/55 bg-zinc-900/40 text-zinc-300';
  }
}

const ACTION_PALETTE: Record<DirectiveAction, {
  bg: string;
  border: string;
  text: string;
  dot: string;
  icon: string;
}> = {
  INITIATE: {
    bg: 'from-emerald-700/55 to-emerald-900/40',
    border: 'border-emerald-400/65',
    text: 'text-emerald-50',
    dot: 'bg-emerald-300',
    icon: '▲',
  },
  ADD: {
    bg: 'from-emerald-800/50 to-emerald-950/35',
    border: 'border-emerald-400/55',
    text: 'text-emerald-100',
    dot: 'bg-emerald-300',
    icon: '＋',
  },
  HOLD: {
    bg: 'from-indigo-800/40 to-indigo-950/30',
    border: 'border-indigo-400/40',
    text: 'text-indigo-100',
    dot: 'bg-indigo-300',
    icon: '＝',
  },
  TRIM: {
    bg: 'from-amber-800/45 to-amber-950/35',
    border: 'border-amber-400/55',
    text: 'text-amber-100',
    dot: 'bg-amber-300',
    icon: '－',
  },
  EXIT: {
    bg: 'from-rose-700/55 to-rose-900/45',
    border: 'border-rose-400/65',
    text: 'text-rose-50',
    dot: 'bg-rose-300',
    icon: '✕',
  },
  FLIP: {
    bg: 'from-fuchsia-700/55 to-indigo-900/45',
    border: 'border-fuchsia-400/65',
    text: 'text-fuchsia-50',
    dot: 'bg-fuchsia-300',
    icon: '⇌',
  },
  STAND_DOWN: {
    bg: 'from-zinc-800/50 to-zinc-900/40',
    border: 'border-zinc-700/65',
    text: 'text-zinc-200',
    dot: 'bg-zinc-500',
    icon: '⏸',
  },
};
