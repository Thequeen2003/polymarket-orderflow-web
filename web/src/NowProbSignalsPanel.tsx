import { useMemo, type ReactElement } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import { computeBilateralEdge } from './bilateralEdge';
import { buildContractProbProjectionGrid, fmtContractCents, fmtContractDeltaCents } from './contractProbProjection';
import { computeMomentumProjection, type ProjectionTick } from './momentumProjection';
import { PredictionHorizonTimer } from './PredictionHorizonTimer';
import { recentProbDelta01 } from './contractLag';
import type { TapeVelocity } from './tapeVelocity';
import { MomentumProjectionStrip } from './MomentumProjectionStrip';

type DualCall = {
  lane: 'up' | 'down';
  verdict: string;
  gate: string;
  enterOnlyIf: string;
  go: boolean;
};

function fmtProbPct01(p01: number | null | undefined): string {
  if (p01 == null || !Number.isFinite(p01)) return '—';
  return `${(Math.max(0, Math.min(1, p01)) * 100).toFixed(1)}%`;
}

function fmtPp(pp: number): string {
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}

/** Book-native Now signals for sports / binary markets (no USD spot or PTB). */
export function NowProbSignalsPanel(props: {
  probUp?: SpotPoint[];
  probDown?: SpotPoint[];
  upLabel: string;
  downLabel: string;
  tape?: TapeVelocity | null;
  dualCall?: DualCall | null;
  probLastUpdateMs?: number | null;
  booksFetchedAt?: number | null;
}): ReactElement {
  const {
    probUp = [],
    probDown = [],
    upLabel,
    downLabel,
    tape,
    dualCall,
  } = props;

  const probTicksUp = useMemo(
    () => probUp.filter((p) => p.v != null && Number.isFinite(p.v)).map((p) => ({ t: p.t, v: p.v! })),
    [probUp],
  );
  const probTicksDown = useMemo(
    () => probDown.filter((p) => p.v != null && Number.isFinite(p.v)).map((p) => ({ t: p.t, v: p.v! })),
    [probDown],
  );

  const lastUp = probTicksUp.at(-1)?.v ?? null;
  const lastDown = probTicksDown.at(-1)?.v ?? null;
  const recentDeltaUp01 = useMemo(() => recentProbDelta01(probTicksUp, 30_000), [probTicksUp]);
  const recentDeltaDown01 = useMemo(() => recentProbDelta01(probTicksDown, 30_000), [probTicksDown]);

  const modelUp = useMemo(() => {
    const proj = computeMomentumProjection({
      pts: probTicksUp as ProjectionTick[],
      tapeNetPressure: tape?.netPressure ?? null,
      horizons: [{ label: '30s', sec: 30 }],
    });
    return proj?.points[0]?.price01 ?? proj?.now01 ?? lastUp;
  }, [probTicksUp, tape?.netPressure, lastUp]);

  const bilateral = useMemo(
    () =>
      computeBilateralEdge({
        modelPUp: modelUp,
        pMktUp: lastUp,
        pMktDown: lastDown,
      }),
    [modelUp, lastUp, lastDown],
  );

  const contractGrid = useMemo(
    () =>
      buildContractProbProjectionGrid({
        probUpPts: probTicksUp,
        probDownPts: probTicksDown,
        nowUp01: lastUp,
        nowDown01: lastDown,
        tapeNetPressure: tape?.netPressure ?? null,
      }),
    [probTicksUp, probTicksDown, lastUp, lastDown, tape?.netPressure],
  );

  if (lastUp == null && lastDown == null) {
    return (
      <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/40 px-4 py-8 text-center text-sm text-zinc-500">
        Load order books on the Book tab — {upLabel}/{downLabel} mids unlock Now Prob Signals.
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-2xl border border-zinc-800/60 bg-[#0b1018] p-3 sm:p-4">
      <div className="text-[10px] font-black uppercase tracking-[0.16em] text-sky-300/85">Now prob signals</div>

      <div className="rounded-xl border border-sky-800/40 bg-sky-950/20 px-3 py-2.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-[11px] tabular-nums">
          <span className="text-emerald-300/90">
            {upLabel} {fmtContractCents(lastUp)}
            {recentDeltaUp01 != null ? ` (${fmtContractDeltaCents(recentDeltaUp01)})` : ''}
          </span>
          <span className="text-zinc-600">·</span>
          <span className="text-rose-300/90">
            {downLabel} {fmtContractCents(lastDown)}
            {recentDeltaDown01 != null ? ` (${fmtContractDeltaCents(recentDeltaDown01)})` : ''}
          </span>
          {modelUp != null ? (
            <>
              <span className="text-zinc-600">·</span>
              <span className="text-zinc-400">
                Model P({upLabel}) <span className="text-zinc-200">{fmtProbPct01(modelUp)}</span>
              </span>
            </>
          ) : null}
          {bilateral.edgeUpPp != null ? (
            <>
              <span className="text-zinc-600">·</span>
              <span className={bilateral.edgeUpPp > 0.3 ? 'text-emerald-300' : bilateral.edgeUpPp < -0.3 ? 'text-rose-300' : 'text-zinc-400'}>
                {upLabel} edge {fmtPp(bilateral.edgeUpPp)}
              </span>
            </>
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-sky-800/30 pt-2">
          <span className="text-[8px] font-black uppercase tracking-[0.12em] text-sky-400/80">Timers</span>
          <PredictionHorizonTimer horizonSec={0} compact />
          <PredictionHorizonTimer horizonSec={30} compact />
          <PredictionHorizonTimer horizonSec={60} compact />
          <PredictionHorizonTimer horizonSec={300} compact />
        </div>
      </div>

      {dualCall ? (
        <div className="rounded-xl border border-violet-800/45 bg-violet-950/25 px-3 py-2.5">
          <div className="text-[9px] font-black uppercase tracking-[0.14em] text-violet-300/85">Dual belief call</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-black text-zinc-50">{dualCall.verdict}</span>
            <span className="rounded-md border border-zinc-700/50 px-2 py-0.5 font-mono text-[10px] text-zinc-300">
              {dualCall.lane === 'up' ? upLabel : downLabel}
            </span>
            <span className="font-mono text-[10px] text-zinc-500">{dualCall.gate.replace('_', ' ')}</span>
            <span className={dualCall.go ? 'text-emerald-300' : 'text-zinc-500'}>{dualCall.go ? 'GO' : 'WAIT'}</span>
          </div>
          <p className="mt-1 text-[10px] leading-snug text-zinc-400">{dualCall.enterOnlyIf}</p>
        </div>
      ) : null}

      {contractGrid ? (
        <div>
          <div className="text-[9px] font-black uppercase tracking-[0.14em] text-zinc-500">Contract mids · projected</div>
          <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
            {contractGrid.cells.map((cell) => (
              <div key={cell.horizonSec} className="rounded-lg border border-zinc-800/55 bg-black/20 px-2.5 py-2">
                <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">{cell.label}</div>
                <div className="mt-1 font-mono text-sm font-bold tabular-nums text-emerald-200">{fmtContractCents(cell.up01)}</div>
                <div className="font-mono text-sm font-bold tabular-nums text-rose-200">{fmtContractCents(cell.down01)}</div>
                {cell.deltaUp01 != null ? (
                  <div className="mt-1 font-mono text-[10px] text-zinc-500">{fmtContractDeltaCents(cell.deltaUp01)} {upLabel}</div>
                ) : null}
                <PredictionHorizonTimer horizonSec={cell.horizonSec} />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {probTicksUp.length >= 3 ? (
        <MomentumProjectionStrip pts={probTicksUp} tapeNetPressure={tape?.netPressure ?? null} outcomeLabel={upLabel} />
      ) : null}
    </div>
  );
}
