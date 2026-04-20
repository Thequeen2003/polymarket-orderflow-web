import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import {
  computeLiveGuidance,
  estimateHiddenRanges,
  type GapLite,
  type HiddenRanges,
  type TradeAction,
  type TradeLane,
} from './tradePlanAssistant';

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function fmtC(p: number): string {
  return `${(p * 100).toFixed(1)}¢`;
}

function fmtRange(lo: number, hi: number): string {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return `${fmtC(a)}–${fmtC(b)}`;
}

function parseDesiredExit(raw: string, entry: number): number {
  const t = raw.trim();
  if (!t) return clamp01(entry + 0.07);
  const n = Number(t);
  if (!Number.isFinite(n)) return clamp01(entry + 0.07);
  if (n > 1) return clamp01(n / 100);
  return clamp01(n);
}

function gapForLane(
  live: {
    up: GapLite | null;
    down: GapLite | null;
  } | null,
  lane: TradeLane,
): GapLite | null {
  if (!live) return null;
  return lane === 'up' ? live.up : live.down;
}

function midHistoryForLane(probUp: SpotPoint[], probDown: SpotPoint[], lane: TradeLane): number[] {
  const s = lane === 'up' ? probUp : probDown;
  return s
    .map((p) => (typeof p.v === 'number' && Number.isFinite(p.v) ? (p.v as number) : null))
    .filter((v): v is number => v != null)
    .map(clamp01)
    .slice(-32);
}

export type ChartTapPlan = { lane: TradeLane; prob: number; seq: number };

export function ClickTradePlanPanel(props: {
  /** Increment from parent (e.g. toolbar "Open trade plan") to surface the panel. */
  openSignal?: number;
  upLabel: string;
  downLabel: string;
  liveGaps: {
    up: { lo: number; hi: number; strength10: number; active: boolean; exitWall: number | null } | null;
    down: { lo: number; hi: number; strength10: number; active: boolean; exitWall: number | null } | null;
    lastUp: number;
    lastDown: number;
  } | null;
  probUp: SpotPoint[];
  probDown: SpotPoint[];
  chartTap: ChartTapPlan | null;
  onDismissChartTap?: () => void;
}): ReactElement | null {
  const { openSignal = 0, upLabel, downLabel, liveGaps, probUp, probDown, chartTap, onDismissChartTap } = props;

  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<'setup' | 'live'>('setup');
  const [lane, setLane] = useState<TradeLane>('up');
  const [desiredRaw, setDesiredRaw] = useState('0.68');
  const [sessPeak, setSessPeak] = useState(0.5);
  const [sessTrough, setSessTrough] = useState(0.5);
  const lastTapSeq = useRef(-1);
  const lastOpenSignal = useRef(0);

  useEffect(() => {
    if (openSignal <= lastOpenSignal.current) return;
    lastOpenSignal.current = openSignal;
    setOpen(true);
    setPhase('setup');
  }, [openSignal]);

  const currentMid = lane === 'up' ? (liveGaps?.lastUp ?? null) : (liveGaps?.lastDown ?? null);
  const entry = currentMid != null ? clamp01(currentMid) : 0.5;

  const desiredExit = useMemo(() => parseDesiredExit(desiredRaw, entry), [desiredRaw, entry]);
  const ranges: HiddenRanges | null = useMemo(() => {
    return estimateHiddenRanges({
      entry,
      desiredExit,
      gap: gapForLane(liveGaps, lane),
    });
  }, [entry, desiredExit, lane, liveGaps]);

  const midHist = useMemo(() => midHistoryForLane(probUp, probDown, lane), [lane, probDown, probUp]);

  const otherLane = lane === 'up' ? 'down' : 'up';
  const otherMidRaw = otherLane === 'up' ? liveGaps?.lastUp : liveGaps?.lastDown;
  const otherEntry = otherMidRaw != null ? clamp01(otherMidRaw) : null;
  const otherDesiredExit = useMemo(() => {
    if (otherEntry == null) return null;
    return clamp01(otherEntry + 0.07);
  }, [otherEntry]);
  const otherRanges = useMemo(() => {
    if (otherEntry == null || otherDesiredExit == null) return null;
    return estimateHiddenRanges({
      entry: otherEntry,
      desiredExit: otherDesiredExit,
      gap: gapForLane(liveGaps, otherLane),
    });
  }, [liveGaps, otherDesiredExit, otherEntry, otherLane]);

  useEffect(() => {
    if (!chartTap || chartTap.seq === lastTapSeq.current) return;
    lastTapSeq.current = chartTap.seq;
    setOpen(true);
    setPhase('setup');
    setLane(chartTap.lane);
    const cur = chartTap.lane === 'up' ? liveGaps?.lastUp : liveGaps?.lastDown;
    const e = cur != null ? clamp01(cur) : clamp01(chartTap.prob);
    const guess = clamp01(e + 0.07);
    setDesiredRaw(guess.toFixed(3));
    setSessPeak(e);
    setSessTrough(e);
    onDismissChartTap?.();
  }, [chartTap, liveGaps?.lastDown, liveGaps?.lastUp, onDismissChartTap]);

  useEffect(() => {
    if (phase !== 'live' || currentMid == null) return;
    const c = clamp01(currentMid);
    setSessPeak((p) => Math.max(p, c));
    setSessTrough((t) => Math.min(t, c));
  }, [currentMid, phase]);

  const g = useMemo(() => {
    if (!ranges || currentMid == null) return null;
    const c = clamp01(currentMid);
    return computeLiveGuidance({
      bullish: ranges.bullish,
      entry,
      desiredExit,
      current: c,
      ranges,
      sessionPeak: sessPeak,
      sessionTrough: sessTrough,
      midHistory: midHist,
    });
  }, [currentMid, desiredExit, entry, midHist, ranges, sessPeak, sessTrough]);

  const thesis =
    lane === 'up'
      ? desiredExit >= entry
        ? `${upLabel} → about to move up`
        : `${upLabel} → fade / move lower`
      : desiredExit >= entry
        ? `${downLabel} → about to move up`
        : `${downLabel} → fade / move lower`;

  const actionStyle = (a: TradeAction): string => {
    if (a === 'CUT_NOW') return 'border-rose-500/55 bg-rose-950/40 text-rose-100';
    if (a === 'TAKE_PROFIT') return 'border-amber-500/50 bg-amber-950/35 text-amber-100';
    return 'border-emerald-600/45 bg-emerald-950/30 text-emerald-100';
  };

  if (!open) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:justify-end sm:pr-4">
      <div className="pointer-events-auto w-full max-w-[min(420px,calc(100vw-1.5rem))] sm:max-w-[420px]">
        <div className="rounded-2xl border border-zinc-700/60 bg-zinc-950/92 p-4 shadow-2xl shadow-black/50 ring-1 ring-white/[0.04] backdrop-blur-md">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[11px] font-black uppercase tracking-wide text-indigo-200/90">Trade plan</div>
                <div className="mt-0.5 text-[10px] text-zinc-500">Use the buttons under the chart, or tap candles / live dot / gap / wall.</div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="shrink-0 rounded-lg border border-zinc-700/50 px-2 py-1 text-[10px] font-semibold text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200"
              >
                Close
              </button>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-full border border-zinc-700/50 bg-black/25 px-2.5 py-1 text-[10px] font-semibold text-zinc-300">
                Phase: <span className="text-zinc-100">{phase === 'setup' ? 'Setup' : 'Live'}</span>
              </span>
              {phase === 'live' ? (
                <span className="rounded-full border border-emerald-800/40 bg-emerald-950/25 px-2.5 py-1 text-[10px] font-semibold text-emerald-200/90">
                  Tracking
                </span>
              ) : null}
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Direction</div>
                <div className="mt-1 inline-flex rounded-lg border border-zinc-700/55 bg-zinc-900/50 p-1">
                  <button
                    type="button"
                    onClick={() => setLane('up')}
                    className={`rounded-md px-3 py-1.5 text-[11px] font-bold ${
                      lane === 'up' ? 'bg-emerald-900/50 text-emerald-100' : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {upLabel}
                  </button>
                  <button
                    type="button"
                    onClick={() => setLane('down')}
                    className={`rounded-md px-3 py-1.5 text-[11px] font-bold ${
                      lane === 'down' ? 'bg-sky-900/50 text-sky-100' : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {downLabel}
                  </button>
                </div>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Thesis</div>
                <div className="mt-1 rounded-lg border border-zinc-800/60 bg-black/20 px-2.5 py-2 text-[11px] text-zinc-200">{thesis}</div>
              </div>
            </div>

            <div className="mt-3 rounded-xl border border-zinc-800/60 bg-zinc-950/45 px-3 py-2">
              <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Other outcome (read-only)</div>
              {otherEntry != null && otherRanges ? (
                <p className="mt-1 text-[10px] leading-relaxed text-zinc-400">
                  {otherLane === 'up' ? upLabel : downLabel} mid {fmtC(otherEntry)} — heuristic +7¢ exit → likely {fmtRange(otherRanges.likelyLo, otherRanges.likelyHi)} · stretch{' '}
                  {fmtRange(otherRanges.stretchLo, otherRanges.stretchHi)}. A clean break + FAST tape there would challenge this{' '}
                  {lane === 'up' ? upLabel : downLabel} plan.
                </p>
              ) : (
                <p className="mt-1 text-[10px] text-zinc-500">Need live mids on both outcomes to mirror the counter-lane.</p>
              )}
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Entry (live mid)</div>
                <div className="mt-1 font-mono text-sm font-bold text-zinc-50">{fmtC(entry)}</div>
              </div>
              <div className="rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Desired exit</div>
                <input
                  value={desiredRaw}
                  onChange={(e) => setDesiredRaw(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-zinc-700/50 bg-zinc-900/50 px-2 py-1.5 font-mono text-sm text-zinc-100 outline-none focus:border-indigo-500/40"
                  placeholder="0.68 or 68"
                  inputMode="decimal"
                />
                <div className="mt-1 text-[9px] text-zinc-600">Parsed: {fmtC(desiredExit)}</div>
              </div>
            </div>

            {ranges ? (
              <div className="mt-3 space-y-2 rounded-xl border border-zinc-800/55 bg-zinc-900/30 p-3">
                <div className="text-[10px] font-black uppercase tracking-wide text-zinc-400">Projected ranges</div>
                <div className="grid gap-2 font-mono text-[11px] text-zinc-200 sm:grid-cols-2">
                  <div>
                    <div className="text-[9px] font-semibold uppercase text-zinc-500">Safe exit</div>
                    <div>{fmtRange(ranges.safeLo, ranges.safeHi)}</div>
                  </div>
                  <div>
                    <div className="text-[9px] font-semibold uppercase text-zinc-500">Likely range</div>
                    <div>{fmtRange(ranges.likelyLo, ranges.likelyHi)}</div>
                  </div>
                  <div>
                    <div className="text-[9px] font-semibold uppercase text-zinc-500">Stretch exit</div>
                    <div>{fmtRange(ranges.stretchLo, ranges.stretchHi)}</div>
                  </div>
                  <div>
                    <div className="text-[9px] font-semibold uppercase text-zinc-500">Wall / stall</div>
                    <div>{ranges.wall != null ? fmtC(ranges.wall) : '—'}</div>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              {phase === 'setup' ? (
                <button
                  type="button"
                  onClick={() => {
                    const c = currentMid != null ? clamp01(currentMid) : entry;
                    setSessPeak(c);
                    setSessTrough(c);
                    setPhase('live');
                  }}
                  className="rounded-xl border border-indigo-500/45 bg-indigo-600/25 px-4 py-2 text-xs font-bold text-indigo-50 hover:bg-indigo-600/40"
                >
                  Arm &amp; track live
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setPhase('setup')}
                  className="rounded-xl border border-zinc-600/50 bg-zinc-900/50 px-4 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-800/60"
                >
                  Back to setup
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setPhase('setup');
                  const guess = clamp01(entry + 0.07);
                  setDesiredRaw(guess.toFixed(3));
                }}
                className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 px-3 py-2 text-xs font-semibold text-zinc-300 hover:bg-zinc-900/65"
              >
                Reset targets
              </button>
            </div>

            {phase === 'live' && g ? (
              <div className="mt-3 space-y-2 rounded-xl border border-zinc-800/60 bg-black/25 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Status</div>
                    <div className="text-sm font-bold text-zinc-100">{g.status}</div>
                  </div>
                  <div className={`rounded-xl border-2 px-3 py-2 text-center text-xs font-black uppercase ${actionStyle(g.action)}`}>
                    Action: {g.action === 'HOLD' ? 'Hold' : g.action === 'TAKE_PROFIT' ? 'Take profit' : 'Cut now'}
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between text-[10px] font-semibold uppercase text-zinc-500">
                    <span>Reversal risk</span>
                    <span className="font-mono text-zinc-300">{(g.reversalRisk01 * 100).toFixed(0)}%</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-900/70">
                    <div
                      className={`h-full ${g.reversalRisk01 > 0.65 ? 'bg-rose-400/85' : g.reversalRisk01 > 0.4 ? 'bg-amber-300/80' : 'bg-emerald-400/75'}`}
                      style={{ width: `${(g.reversalRisk01 * 100).toFixed(0)}%` }}
                    />
                  </div>
                </div>
                <p className="text-[11px] leading-relaxed text-zinc-400">{g.detail}</p>
              </div>
            ) : (
              <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">
                Arm the plan to turn on live wording: <span className="text-zinc-300">Holding clean</span>,{' '}
                <span className="text-zinc-300">Approaching target</span>, <span className="text-zinc-300">Cut now</span>, etc.
              </p>
            )}
        </div>
      </div>
    </div>
  );
}
