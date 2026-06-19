import { useMemo, type ReactElement } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import { EDGE_TRADE_THRESHOLD } from './probabilityEdgeScalp';
import { PLM_MIN_EDGE_PP, plmEventAgeLabel, type PlmRepricingEvent } from './probabilityLagMonitor';
import { probPointsFromSeries, useBookProbabilityLagMonitor } from './useBookProbabilityLagMonitor';

function fmtEdgePp(pp: number): string {
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}

function MiniSparkline(props: { points: number[]; stroke?: string }): ReactElement {
  const h = 56;
  const w = 320;
  const pts = props.points;
  if (pts.length < 2) {
    return (
      <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full text-zinc-700">
        <text x={w / 2} y={h / 2} textAnchor="middle" className="fill-current text-[10px]">
          Collecting…
        </text>
      </svg>
    );
  }
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const pad = (max - min) * 0.08 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const scaleY = (v: number) => h - ((v - lo) / (hi - lo)) * h;
  const d = pts
    .map((v, i) => {
      const x = (i / (pts.length - 1)) * w;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${scaleY(v).toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full" preserveAspectRatio="none">
      <path d={d} fill="none" stroke={props.stroke ?? 'rgb(34 211 238)'} strokeWidth={1.75} />
    </svg>
  );
}

function PlmEventRow(props: { event: PlmRepricingEvent; nowMs: number }): ReactElement {
  const age = plmEventAgeLabel(props.nowMs, props.event);
  return (
    <div className="rounded-lg border border-zinc-800/55 bg-black/20 px-2.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] font-bold text-cyan-200">{fmtEdgePp(props.event.edgePp)}</span>
        <span className="text-[9px] text-zinc-500">{age}</span>
      </div>
      <p className="mt-1 text-[10px] leading-snug text-zinc-400">{props.event.replayLine}</p>
    </div>
  );
}

export function BookProbabilityLagPanelBody(props: {
  slug: string;
  probUp: SpotPoint[];
  pMktUp: number | null;
  upLabel: string;
  enabled?: boolean;
}): ReactElement {
  const probPts = useMemo(() => probPointsFromSeries(props.probUp), [props.probUp]);
  const plm = useBookProbabilityLagMonitor({
    slug: props.slug,
    probUpPts: probPts,
    pMktUp: props.pMktUp,
    enabled: props.enabled,
  });

  const edgePp = plm.stats.currentEdgePp;
  const edgeTone =
    edgePp != null && edgePp > PLM_MIN_EDGE_PP ? 'up' : edgePp != null && edgePp < -PLM_MIN_EDGE_PP ? 'down' : 'flat';
  const nowMs = Date.now();
  const recentEvents = [...plm.events].reverse().slice(0, 8);

  if (props.pMktUp == null || probPts.length < 3) {
    return (
      <div className="rounded-xl border border-zinc-800/55 bg-black/20 px-3 py-4 text-center text-[11px] text-zinc-500">
        PLM needs a few {props.upLabel} mid ticks — keep book polling on.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-cyan-900/40 bg-[#081018] px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300/90">Probability lag monitor</div>
          <p className="mt-1 max-w-2xl text-[10px] leading-snug text-zinc-500">
            Book mode: P_model from momentum on {props.upLabel} mids vs live mid — same edge/repricing logic as crypto PLM.
          </p>
        </div>
        {edgePp != null ? (
          <div
            className={`rounded-xl border px-3 py-2 text-center ${
              edgeTone === 'up'
                ? 'border-emerald-600/50 bg-emerald-950/35'
                : edgeTone === 'down'
                  ? 'border-rose-600/50 bg-rose-950/35'
                  : 'border-zinc-700/50 bg-zinc-900/40'
            }`}
          >
            <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-zinc-500">Live edge</div>
            <div className="font-mono text-2xl font-bold tabular-nums">{fmtEdgePp(edgePp)}</div>
          </div>
        ) : null}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-800/50 bg-black/25 px-2.5 py-2">
          <div className="text-[9px] font-bold uppercase text-zinc-500">Edge (pp)</div>
          <MiniSparkline points={plm.edgeSeries.map((p) => p.edgePp)} stroke="rgb(34 211 238)" />
        </div>
        <div className="rounded-lg border border-zinc-800/50 bg-black/25 px-2.5 py-2">
          <div className="text-[9px] font-bold uppercase text-zinc-500">P_mkt vs P_model</div>
          <MiniSparkline points={plm.probSeries.map((p) => p.pMktPct)} stroke="rgb(167 139 250)" />
        </div>
      </div>

      <div className="mt-2 font-mono text-[9px] tabular-nums text-zinc-500">
        Samples {plm.stats.sampleCount} · threshold ±{(EDGE_TRADE_THRESHOLD * 100).toFixed(0)}pp · catch{' '}
        {plm.stats.catchRatePct != null ? `${plm.stats.catchRatePct.toFixed(0)}%` : '—'}
      </div>

      {recentEvents.length ? (
        <div className="mt-3 space-y-1.5">
          {recentEvents.map((ev) => (
            <PlmEventRow key={ev.id} event={ev} nowMs={nowMs} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function BookProbabilityLagMonitorPanel(props: {
  slug: string;
  probUp: SpotPoint[];
  pMktUp: number | null;
  upLabel: string;
  enabled?: boolean;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <BookProbabilityLagPanelBody {...props} />
    </div>
  );
}
