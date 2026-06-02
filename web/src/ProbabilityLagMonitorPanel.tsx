import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import { EDGE_TRADE_THRESHOLD } from './probabilityEdgeScalp';
import { plmEventAgeLabel, PLM_MIN_EDGE_PP, buildPlmReplayLine, type PlmRepricingEvent } from './probabilityLagMonitor';
import { useProbabilityLagMonitor } from './useProbabilityLagMonitor';

function fmtProbPct01(p01: number): string {
  const pct = p01 * 100;
  return pct >= 10 ? `${pct.toFixed(1)}%` : `${pct.toFixed(2)}%`;
}

function fmtCents(v01: number): string {
  const c = v01 * 100;
  return c >= 10 ? `${c.toFixed(1)}¢` : `${c.toFixed(2)}¢`;
}

function fmtEdgePp(pp: number): string {
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)}pp`;
}

function MiniSparkline(props: {
  points: number[];
  height?: number;
  stroke?: string;
  zeroLine?: boolean;
}): ReactElement {
  const h = props.height ?? 56;
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
      const y = scaleY(v);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const zeroY = props.zeroLine ? scaleY(0) : null;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-14 w-full" preserveAspectRatio="none">
      {zeroY != null ? (
        <line x1={0} y1={zeroY} x2={w} y2={zeroY} stroke="rgb(63 63 70 / 0.6)" strokeDasharray="3 3" />
      ) : null}
      <path d={d} fill="none" stroke={props.stroke ?? 'rgb(34 211 238)'} strokeWidth={1.75} />
    </svg>
  );
}

function DualProbSparkline(props: {
  pMkt: number[];
  pModel: number[];
}): ReactElement {
  const h = 64;
  const w = 320;
  const n = Math.min(props.pMkt.length, props.pModel.length);
  if (n < 2) {
    return (
      <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full text-zinc-700">
        <text x={w / 2} y={h / 2} textAnchor="middle" className="fill-current text-[10px]">
          Collecting…
        </text>
      </svg>
    );
  }
  const all = [...props.pMkt.slice(-n), ...props.pModel.slice(-n)];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const pad = (max - min) * 0.05 || 1;
  const lo = min - pad;
  const hi = max + pad;
  const scaleY = (v: number) => h - ((v - lo) / (hi - lo)) * h;
  const line = (arr: number[]) =>
    arr
      .map((v, i) => {
        const x = (i / (n - 1)) * w;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${scaleY(v).toFixed(1)}`;
      })
      .join(' ');

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" preserveAspectRatio="none">
      <path d={line(props.pMkt.slice(-n))} fill="none" stroke="rgb(167 139 250)" strokeWidth={1.5} opacity={0.85} />
      <path d={line(props.pModel.slice(-n))} fill="none" stroke="rgb(52 211 153)" strokeWidth={1.75} />
    </svg>
  );
}

function ReplayCard(props: { event: PlmRepricingEvent; nowMs: number }): ReactElement {
  const { event, nowMs } = props;
  const replayLine = buildPlmReplayLine({
    nowMs,
    signalAtMs: event.signalAtMs,
    observeAtMs: event.observeAtMs,
    edgePp: event.edgePp,
    repricePp: event.repricePp,
  });
  return (
    <div
      className={`flex min-w-[16rem] max-w-[20rem] shrink-0 flex-col rounded-xl border px-3 py-2.5 ${
        event.caught
          ? 'border-emerald-700/50 bg-emerald-950/25'
          : 'border-zinc-700/50 bg-zinc-900/40'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className={`text-[9px] font-black uppercase tracking-[0.12em] ${
            event.caught ? 'text-emerald-300' : 'text-zinc-500'
          }`}
        >
          {event.caught ? 'Repricing caught' : 'No catch'}
        </span>
        <span className="font-mono text-[9px] tabular-nums text-zinc-500">{plmEventAgeLabel(nowMs, event)}</span>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-zinc-200">{replayLine}</p>
      <div className="mt-2 font-mono text-[9px] tabular-nums text-zinc-500">
        P_mkt {fmtCents(event.pMktAtSignal)} → {fmtCents(event.pMktAtObserve)} · lead {event.leadSec.toFixed(0)}s
      </div>
    </div>
  );
}

export function ProbabilityLagMonitorPanel(props: {
  slug: string;
  spot: SpotPoint[];
  priceToBeat: number | null;
  pMktUp: number | null;
  slopeUsdPerSec?: number | null;
  bandUsd?: number | null;
  upLabel: string;
  enabled?: boolean;
}): ReactElement {
  const { slug, spot, priceToBeat, pMktUp, slopeUsdPerSec, bandUsd, upLabel, enabled = true } = props;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const plm = useProbabilityLagMonitor({
    slug,
    spot,
    priceToBeat,
    pMktUp,
    slopeUsdPerSec,
    bandUsd,
    enabled,
  });

  const lastSample = plm.samples.length ? plm.samples[plm.samples.length - 1]! : null;
  const edgePp = plm.stats.currentEdgePp;
  const edgeTone =
    edgePp != null && edgePp > PLM_MIN_EDGE_PP ? 'up' : edgePp != null && edgePp < -PLM_MIN_EDGE_PP ? 'down' : 'flat';

  const edgePoints = useMemo(() => plm.edgeSeries.map((p) => p.edgePp), [plm.edgeSeries]);
  const pMktPoints = useMemo(() => plm.probSeries.map((p) => p.pMktPct), [plm.probSeries]);
  const pModelPoints = useMemo(() => plm.probSeries.map((p) => p.pModelPct), [plm.probSeries]);

  const recentEvents = [...plm.events].reverse().slice(0, 12);

  if (priceToBeat == null || pMktUp == null || !spot.length) {
    return (
      <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/40 px-4 py-8 text-center text-sm text-zinc-500">
        Load PTB, spot ticks, and {upLabel} mid history to start the Probability Lag Monitor.
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-cyan-900/40 bg-[#081018] p-3 sm:p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300/90">
            Probability Lag Monitor
          </div>
          <p className="mt-1 max-w-2xl text-[10px] leading-snug text-zinc-500">
            Stat arb with a clock: <span className="font-mono text-zinc-400">Edge = P_model − P_mkt</span>. Samples
            every 1s; replay detects ±{PLM_MIN_EDGE_PP.toFixed(0)}pp edge peaks and mid repricing ~30s later.
          </p>
        </div>
        {edgePp != null ? (
          <div
            className={`rounded-xl border px-4 py-2 text-center ${
              edgeTone === 'up'
                ? 'border-emerald-600/50 bg-emerald-950/35'
                : edgeTone === 'down'
                  ? 'border-rose-600/50 bg-rose-950/35'
                  : 'border-zinc-700/50 bg-zinc-900/40'
            }`}
          >
            <div className="text-[8px] font-bold uppercase tracking-[0.12em] text-zinc-500">Live edge</div>
            <div className="font-mono text-3xl font-bold tabular-nums">{fmtEdgePp(edgePp)}</div>
            <div className="text-[9px] text-zinc-500">
              {Math.abs(edgePp) >= PLM_MIN_EDGE_PP ? 'Mispricing zone' : 'Inside noise band'}
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-violet-800/40 bg-violet-950/15 px-3 py-2">
          <div className="text-[9px] font-bold uppercase text-zinc-500">P_mkt ({upLabel})</div>
          <div className="font-mono text-xl font-bold tabular-nums text-violet-100">
            {lastSample ? fmtProbPct01(lastSample.pMkt) : '—'}
          </div>
          <div className="text-[10px] text-zinc-500">{lastSample ? fmtCents(lastSample.pMkt) : 'contract mid'}</div>
        </div>
        <div className="rounded-lg border border-emerald-800/40 bg-emerald-950/15 px-3 py-2">
          <div className="text-[9px] font-bold uppercase text-zinc-500">P_model (desk)</div>
          <div className="font-mono text-xl font-bold tabular-nums text-emerald-100">
            {lastSample ? fmtProbPct01(lastSample.pModel) : '—'}
          </div>
          <div className="text-[10px] text-zinc-500">PTB + momentum + flow</div>
        </div>
        <div className="rounded-lg border border-zinc-700/50 bg-black/25 px-3 py-2">
          <div className="text-[9px] font-bold uppercase text-zinc-500">Session stats</div>
          <div className="mt-0.5 font-mono text-[11px] tabular-nums text-zinc-300">
            {plm.stats.caughtCount}/{plm.stats.eventCount} caught
            {plm.stats.catchRatePct != null ? ` (${plm.stats.catchRatePct.toFixed(0)}%)` : ''}
          </div>
          <div className="text-[10px] text-zinc-500">
            {plm.stats.medianLeadSec != null ? `median lead ${plm.stats.medianLeadSec.toFixed(0)}s · ` : ''}
            {plm.stats.sampleCount} samples / {Math.round(plm.stats.spanSec)}s
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-zinc-800/60 bg-black/25 px-3 py-2">
          <div className="flex items-baseline justify-between">
            <div className="text-[9px] font-bold uppercase tracking-[0.12em] text-cyan-400/80">Edge (pp)</div>
            <div className="font-mono text-[9px] text-zinc-600">±{(EDGE_TRADE_THRESHOLD * 100).toFixed(0)}pp band</div>
          </div>
          <MiniSparkline points={edgePoints} stroke="rgb(34 211 238)" zeroLine />
        </div>
        <div className="rounded-xl border border-zinc-800/60 bg-black/25 px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <div className="text-[9px] font-bold uppercase tracking-[0.12em] text-zinc-400">P_mkt vs P_model</div>
            <div className="font-mono text-[9px] text-zinc-600">
              <span className="text-violet-400">mkt</span> · <span className="text-emerald-400">model</span>
            </div>
          </div>
          <DualProbSparkline pMkt={pMktPoints} pModel={pModelPoints} />
        </div>
      </div>

      <div className="rounded-xl border border-indigo-800/40 bg-indigo-950/10 px-3 py-2.5">
        <div className="text-[9px] font-black uppercase tracking-[0.14em] text-indigo-300/85">Replay strip</div>
        <p className="mt-0.5 text-[10px] text-zinc-500">
          When edge spiked, did the contract mid reprice toward the model within ~30s?
        </p>
        {recentEvents.length ? (
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:thin]">
            {recentEvents.map((ev) => (
              <ReplayCard key={ev.id} event={ev} nowMs={nowMs} />
            ))}
          </div>
        ) : (
          <div className="mt-3 rounded-lg border border-dashed border-zinc-800/80 px-3 py-6 text-center text-[11px] text-zinc-500">
            Logging… need ~30s after a ±{PLM_MIN_EDGE_PP.toFixed(0)}pp edge peak to score repricing.
          </div>
        )}
      </div>

      {plm.stats.maxAbsEdgePp10m != null ? (
        <div className="font-mono text-[10px] tabular-nums text-zinc-600">
          Max |edge| last 10m: {fmtEdgePp(plm.stats.maxAbsEdgePp10m)}
          {plm.stats.medianRepricePp != null ? ` · median capture ${fmtEdgePp(plm.stats.medianRepricePp)}` : ''}
        </div>
      ) : null}
    </div>
  );
}
