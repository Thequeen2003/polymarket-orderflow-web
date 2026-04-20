import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function fmtC(p: number | null): string {
  if (p == null || !Number.isFinite(p)) return '—';
  return `${(p * 100).toFixed(1)}¢`;
}

function fmtUsd(x: number | null): string {
  if (x == null || !Number.isFinite(x)) return '—';
  const s = x >= 0 ? '+' : '';
  return `${s}$${Math.abs(x).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

type Mode = 'shares' | 'dollars';

export type GapAutofill = {
  side: 'up' | 'down';
  entry: number;
  gapLo: number;
  gapHi: number;
  strength10: number;
  exitWall: number | null;
};

export function DecisionCalculatorPanel(props: {
  ptbProb?: number; // default 0.5
  currentProbUp: number | null;
  currentProbDown: number | null;
  gap?: GapAutofill | null;
  tappedProb?: number | null;
  tapSeq?: number;
  liveGaps?: {
    up: { lo: number; hi: number; strength10: number; active: boolean; exitWall: number | null } | null;
    down: { lo: number; hi: number; strength10: number; active: boolean; exitWall: number | null } | null;
    lastUp: number;
    lastDown: number;
  } | null;
  /** Upper chart row = “up” lane; lower row = “down” lane (e.g. YES / NO). */
  upLaneLabel?: string;
  downLaneLabel?: string;
}): ReactElement {
  const {
    ptbProb = 0.5,
    currentProbUp,
    currentProbDown,
    gap,
    tappedProb,
    tapSeq = 0,
    liveGaps = null,
    upLaneLabel = 'Upside',
    downLaneLabel = 'Downside',
  } = props;
  const [open, setOpen] = useState(true);
  const [tapTarget, setTapTarget] = useState<'entry' | 'exit'>('exit');
  const [showManual, setShowManual] = useState(false);
  const [entrySide, setEntrySide] = useState<'up' | 'down'>(() => {
    const raw = window.localStorage.getItem('decCalc.entrySide');
    return raw === 'down' ? 'down' : 'up';
  });
  const [mode, setMode] = useState<Mode>('shares');
  const currentForSide = entrySide === 'up' ? currentProbUp : currentProbDown;
  const entryLaneName = entrySide === 'up' ? upLaneLabel : downLaneLabel;
  const [entry, setEntry] = useState<number>(() => (currentForSide != null ? clamp01(currentForSide) : 0.5));
  const [exit, setExit] = useState<number | null>(null);
  const [shares, setShares] = useState<number>(() => {
    const raw = window.localStorage.getItem('decCalc.shares');
    const n = raw ? Number(raw) : 100;
    return Number.isFinite(n) ? Math.max(0, n) : 100;
  });
  const [dollars, setDollars] = useState<number>(() => {
    const raw = window.localStorage.getItem('decCalc.dollars');
    const n = raw ? Number(raw) : 100;
    return Number.isFinite(n) ? Math.max(0, n) : 100;
  });
  const [entryFollowLive, setEntryFollowLive] = useState<boolean>(() => {
    const raw = window.localStorage.getItem('decCalc.entryFollowLive');
    return raw == null ? true : raw === '1';
  });
  const dragRef = useRef<{ dragging: boolean; dx: number; dy: number }>({ dragging: false, dx: 0, dy: 0 });
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    const raw = window.localStorage.getItem('decCalc.pos');
    if (raw) {
      try {
        const p = JSON.parse(raw) as { x: number; y: number };
        if (Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y };
      } catch {
        // ignore
      }
    }
    const w = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const h = typeof window !== 'undefined' ? window.innerHeight : 900;
    return { x: Math.max(16, w - 420 - 16), y: Math.max(16, h - 520 - 16) };
  });

  // Autofill when user clicks a gap.
  useEffect(() => {
    if (!gap) return;
    setEntrySide(gap.side);
    setEntry(clamp01(gap.entry));
    setExit(clamp01(gap.gapHi));
  }, [gap]);

  // Default rule: entry follows current price.
  useEffect(() => {
    if (!entryFollowLive) return;
    if (currentForSide == null) return;
    setEntry(clamp01(currentForSide));
  }, [currentForSide, entryFollowLive]);

  useEffect(() => {
    window.localStorage.setItem('decCalc.entrySide', entrySide);
  }, [entrySide]);

  // Tap-to-fill from chart.
  useEffect(() => {
    if (tappedProb == null) return;
    const v = clamp01(tappedProb);
    if (tapTarget === 'entry') {
      setEntry(v);
      setEntryFollowLive(false);
      window.localStorage.setItem('decCalc.entryFollowLive', '0');
    } else {
      setExit(v);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tapSeq]);

  // Persist size + prefs.
  useEffect(() => {
    window.localStorage.setItem('decCalc.shares', String(shares));
  }, [shares]);
  useEffect(() => {
    window.localStorage.setItem('decCalc.dollars', String(dollars));
  }, [dollars]);
  useEffect(() => {
    window.localStorage.setItem('decCalc.entryFollowLive', entryFollowLive ? '1' : '0');
  }, [entryFollowLive]);
  useEffect(() => {
    window.localStorage.setItem('decCalc.pos', JSON.stringify(pos));
  }, [pos]);

  const rr = useMemo(() => {
    const e = clamp01(entry);
    const x = exit == null ? e : clamp01(exit);
    const move = x - e;
    const risk = Math.max(1e-9, Math.min(e, 1 - e)); // crude “max loss” proxy to 0 or 1
    const reward = Math.abs(move);
    const r = reward / risk;
    return { move, risk, reward, r };
  }, [entry, exit]);

  const pnl = useMemo(() => {
    const e = clamp01(entry);
    const x = exit == null ? e : clamp01(exit);
    if (mode === 'shares') {
      const profit = (x - e) * shares;
      const cost = e * shares;
      const pct = cost > 0 ? (profit / cost) * 100 : 0;
      return { profitUsd: profit, pct };
    }
    const cost = Math.max(1e-9, dollars);
    const sh = cost / Math.max(1e-9, e);
    const profit = (x - e) * sh;
    const pct = (profit / cost) * 100;
    return { profitUsd: profit, pct };
  }, [dollars, entry, exit, mode, shares]);

  const ptbRead = useMemo(() => {
    const cur = clamp01(entry);
    const d = (cur - ptbProb) * 100;
    const abs = Math.abs(d);
    const label = abs >= 10 ? 'Overextended' : abs >= 4 ? 'Leaning' : 'Fair';
    const edge = abs >= 10 ? 'High' : abs >= 4 ? 'Medium' : 'Low';
    return { d, label, edge };
  }, [entry, ptbProb]);

  const gapCalc = useMemo(() => {
    if (!gap) return null;
    const lo = clamp01(gap.gapLo);
    const hi = clamp01(gap.gapHi);
    const cur = clamp01(entry);
    const dist = Math.abs(hi - lo);
    const maxTheoretical = gap.side === 'up' ? Math.max(0, hi - cur) : Math.max(0, cur - lo);
    const capturePct = dist > 1e-9 ? Math.min(1, maxTheoretical / dist) : 0;
    const beforeWall = gap.exitWall ?? null;
    const fullGap = gap.side === 'up' ? hi : lo;
    const safeExit = gap.side === 'up' ? Math.max(lo, hi - dist * 0.3) : Math.min(hi, lo + dist * 0.3);
    return { lo, hi, dist, maxTheoretical, capturePct, beforeWall, fullGap, safeExit };
  }, [entry, gap]);

  const bestGap = useMemo(() => {
    if (!liveGaps) return null;
    const pickScore = (g: { strength10: number; active: boolean }) => g.strength10 + (g.active ? 0.8 : 0);
    const up = liveGaps.up;
    const dn = liveGaps.down;
    if (up && dn) return pickScore(up) >= pickScore(dn) ? ({ side: 'up' as const, g: up, entry: liveGaps.lastUp }) : ({ side: 'down' as const, g: dn, entry: liveGaps.lastDown });
    if (up) return { side: 'up' as const, g: up, entry: liveGaps.lastUp };
    if (dn) return { side: 'down' as const, g: dn, entry: liveGaps.lastDown };
    return null;
  }, [liveGaps]);

  if (!open) {
    return (
      <div className="fixed bottom-4 right-4 z-40">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-xl border border-zinc-700/60 bg-zinc-950/70 px-4 py-2 text-xs font-semibold text-zinc-200 shadow-lg shadow-black/30"
        >
          Open calculator
        </button>
      </div>
    );
  }

  const quickExits = [
    { d: 0.03, label: '+3¢' },
    { d: 0.05, label: '+5¢' },
    { d: 0.07, label: '+7¢' },
    { d: 0.1, label: '+10¢' },
  ];

  return (
    <div
      className="fixed z-40 w-[min(420px,calc(100vw-2rem))]"
      style={{ left: Math.round(pos.x), top: Math.round(pos.y) }}
    >
      <div className="rounded-2xl border border-zinc-800/70 bg-zinc-950/80 p-4 shadow-2xl shadow-black/35 ring-1 ring-white/[0.03] backdrop-blur">
        <div
          className="flex cursor-move items-start justify-between gap-3 rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-2"
          onPointerDown={(e) => {
            dragRef.current.dragging = true;
            dragRef.current.dx = e.clientX - pos.x;
            dragRef.current.dy = e.clientY - pos.y;
            (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!dragRef.current.dragging) return;
            const nx = e.clientX - dragRef.current.dx;
            const ny = e.clientY - dragRef.current.dy;
            setPos({ x: Math.max(6, nx), y: Math.max(6, ny) });
          }}
          onPointerUp={() => {
            dragRef.current.dragging = false;
          }}
        >
          <div>
            <div className="text-[12px] font-semibold tracking-tight text-zinc-100">Decision accelerator</div>
            <div className="mt-0.5 text-[10px] leading-snug text-zinc-500">
              Chart tap → fills {tapTarget === 'entry' ? 'entry' : 'exit'} here. Lane tap / Plan on Signals opens the trade plan for
              thesis + ranges.
            </div>
            <div
              className={`mt-2 inline-flex max-w-full flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 ${
                entrySide === 'up'
                  ? 'border-emerald-700/45 bg-emerald-950/30 text-emerald-100'
                  : 'border-sky-700/45 bg-sky-950/30 text-sky-100'
              }`}
              title="Upper chart panel = up lane · Lower panel = down lane"
            >
              <span className="text-[9px] font-bold uppercase tracking-wide text-zinc-400">Sizing</span>
              <span className="truncate text-[12px] font-black">{entryLaneName}</span>
              <span className="text-[9px] font-normal text-zinc-500">({entrySide === 'up' ? 'up' : 'down'} lane)</span>
            </div>
          </div>
          <div className="flex items-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
            <div className="inline-flex rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-1">
              <button
                type="button"
                onClick={() => setTapTarget('entry')}
                className={`rounded-md px-2 py-1 text-[10px] font-semibold uppercase ${
                  tapTarget === 'entry' ? 'bg-zinc-700/60 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                tap→entry
              </button>
              <button
                type="button"
                onClick={() => setTapTarget('exit')}
                className={`rounded-md px-2 py-1 text-[10px] font-semibold uppercase ${
                  tapTarget === 'exit' ? 'bg-zinc-700/60 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                tap→exit
              </button>
            </div>
            <div className="inline-flex max-w-[min(200px,46vw)] rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-1">
              <button
                type="button"
                onClick={() => setEntrySide('up')}
                className={`max-w-[50%] truncate rounded-md px-2 py-1 text-[10px] font-bold ${
                  entrySide === 'up' ? 'bg-zinc-700/60 text-emerald-200' : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title={`Up lane (upper chart): ${upLaneLabel}`}
              >
                {upLaneLabel}
              </button>
              <button
                type="button"
                onClick={() => setEntrySide('down')}
                className={`max-w-[50%] truncate rounded-md px-2 py-1 text-[10px] font-bold ${
                  entrySide === 'down' ? 'bg-zinc-700/60 text-sky-200' : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title={`Down lane (lower chart): ${downLaneLabel}`}
              >
                {downLaneLabel}
              </button>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="text-xs font-semibold text-zinc-400 hover:text-zinc-200">
              Hide
            </button>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2 text-[11px] text-zinc-300">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
                Entry · <span className="font-bold text-zinc-300">{entryLaneName}</span>
              </div>
              <button
                type="button"
                onClick={() => setEntryFollowLive((v) => !v)}
                className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase ${
                  entryFollowLive ? 'border-emerald-700/40 bg-emerald-950/20 text-emerald-100' : 'border-zinc-700/50 bg-zinc-900/30 text-zinc-400'
                }`}
                title="When ON, entry auto-follows current price"
              >
                live
              </button>
            </div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <div className="font-mono text-[12px] text-zinc-100">{fmtC(entry)}</div>
              <button
                type="button"
                onClick={() => {
                  if (currentForSide == null) return;
                  setEntry(clamp01(currentForSide));
                  setEntryFollowLive(true);
                }}
                className="rounded-lg border border-zinc-700/55 bg-zinc-900/40 px-2 py-1 text-[10px] font-semibold text-zinc-200 hover:bg-zinc-900/60"
                title="Tap: set entry to current"
              >
                Use current
              </button>
            </div>
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowManual((v) => !v)}
                className="text-[10px] font-semibold text-zinc-500 hover:text-zinc-300"
              >
                {showManual ? 'Hide manual' : 'Manual…'}
              </button>
              {showManual ? (
                <input
                  value={entry}
                  onChange={(e) => {
                    setEntry(clamp01(Number(e.target.value)));
                    setEntryFollowLive(false);
                  }}
                  className="mt-1 w-full rounded-lg border border-zinc-700/50 bg-zinc-900/40 px-2 py-1 font-mono text-[12px] text-zinc-100"
                  type="number"
                  step="0.001"
                  min={0}
                  max={1}
                />
              ) : null}
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2 text-[11px] text-zinc-300">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Exit</div>
            <div className="mt-1 flex items-center justify-between gap-2">
              <div className="font-mono text-[12px] text-zinc-100">{exit == null ? '—' : fmtC(exit)}</div>
              <button
                type="button"
                onClick={() => setExit(null)}
                className="rounded-lg border border-zinc-700/55 bg-zinc-900/40 px-2 py-1 text-[10px] font-semibold text-zinc-200 hover:bg-zinc-900/60"
                title="Clear exit"
              >
                Clear
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {quickExits.map((b) => (
                <button
                  key={b.label}
                  type="button"
                  onClick={() => setExit(clamp01(entry + b.d))}
                  className="rounded-lg border border-zinc-700/55 bg-zinc-900/40 px-2 py-1 text-[10px] font-semibold text-zinc-200 hover:bg-zinc-900/60"
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          {gapCalc ? (
            <button
              type="button"
              onClick={() => {
                setExit(clamp01(gapCalc.fullGap));
              }}
              className="rounded-xl border border-violet-700/40 bg-violet-950/20 px-3 py-1.5 text-[11px] font-semibold text-violet-100 hover:bg-violet-950/35"
              title="Trade from gap: Entry=current · Exit=top of gap"
            >
              Trade gap
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              if (!gapCalc) return;
              if (gapCalc.beforeWall != null) setExit(clamp01(gapCalc.beforeWall));
              else setExit(clamp01(gapCalc.fullGap));
            }}
            className={`rounded-xl border px-3 py-1.5 text-[11px] font-semibold ${
              gapCalc ? 'border-amber-700/50 bg-amber-950/25 text-amber-100 hover:bg-amber-950/40' : 'border-zinc-800/50 bg-zinc-950/30 text-zinc-600'
            }`}
            disabled={!gapCalc}
            title={gapCalc ? 'Auto to first wall (if found) or top of gap' : 'Click a gap first'}
          >
            To wall
          </button>
        </div>

        {gapCalc ? (
          <div className="mt-2 grid grid-cols-1 gap-2">
            <div className="rounded-xl border border-violet-800/35 bg-violet-950/15 px-3 py-2 text-[11px] text-violet-100/90">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-200/90">Smart exits (tap)</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {gapCalc.beforeWall != null ? (
                  <button
                    type="button"
                    onClick={() => setExit(clamp01(gapCalc.beforeWall!))}
                    className="rounded-xl border border-amber-700/50 bg-amber-950/25 px-3 py-1.5 font-mono text-[11px] font-semibold text-amber-100 hover:bg-amber-950/40"
                    title="Sell before wall"
                  >
                    Before wall: {fmtC(gapCalc.beforeWall)}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setExit(clamp01(gapCalc.fullGap))}
                  className="rounded-xl border border-violet-700/40 bg-violet-950/20 px-3 py-1.5 font-mono text-[11px] font-semibold text-violet-100 hover:bg-violet-950/35"
                  title="Full gap"
                >
                  Full gap: {fmtC(gapCalc.fullGap)}
                </button>
                <button
                  type="button"
                  onClick={() => setExit(clamp01(gapCalc.safeExit))}
                  className="rounded-xl border border-zinc-700/55 bg-zinc-900/40 px-3 py-1.5 font-mono text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900/60"
                  title="Safer exit inside gap"
                >
                  Safe: {fmtC(gapCalc.safeExit)}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {bestGap && !gapCalc ? (
          <div className="mt-2 rounded-xl border border-emerald-900/35 bg-emerald-950/15 px-3 py-2 text-[11px] text-emerald-100/90">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-200/90">Dynamic gap entries</div>
              <div className="min-w-0 truncate font-mono text-[10px] text-emerald-200/70" title={bestGap.side === 'up' ? upLaneLabel : downLaneLabel}>
                {bestGap.side === 'up' ? upLaneLabel : downLaneLabel} {Math.round(bestGap.g.lo * 100)}–{Math.round(bestGap.g.hi * 100)}¢ ·{' '}
                {bestGap.g.strength10.toFixed(1)}/10
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setEntry(clamp01(bestGap.entry));
                  setEntryFollowLive(false);
                  setExit(clamp01(bestGap.g.hi));
                }}
                className="rounded-xl border border-emerald-700/40 bg-emerald-950/25 px-3 py-1.5 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-950/40"
                title="Auto: Entry=current · Exit=gap top"
              >
                Trade {bestGap.side === 'up' ? upLaneLabel : downLaneLabel} gap
              </button>
              {bestGap.g.exitWall != null ? (
                <button
                  type="button"
                  onClick={() => {
                    setEntry(clamp01(bestGap.entry));
                    setEntryFollowLive(false);
                    setExit(clamp01(bestGap.g.exitWall!));
                  }}
                  className="rounded-xl border border-amber-700/45 bg-amber-950/25 px-3 py-1.5 text-[11px] font-semibold text-amber-100 hover:bg-amber-950/40"
                  title="Auto: exit at first wall after the gap"
                >
                  Exit @ wall {fmtC(bestGap.g.exitWall)}
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2 text-[11px] text-zinc-300">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Size mode</div>
            <div className="mt-2 inline-flex rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-1">
              <button
                type="button"
                onClick={() => setMode('shares')}
                className={`rounded-md px-2.5 py-1 text-[10px] font-semibold uppercase ${
                  mode === 'shares' ? 'bg-zinc-700/60 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                shares
              </button>
              <button
                type="button"
                onClick={() => setMode('dollars')}
                className={`rounded-md px-2.5 py-1 text-[10px] font-semibold uppercase ${
                  mode === 'dollars' ? 'bg-zinc-700/60 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                $
              </button>
            </div>
            {mode === 'shares' ? (
              <label className="mt-2 block font-mono text-[11px] text-zinc-400">
                shares
                <input
                  value={shares}
                  onChange={(e) => setShares(Math.max(0, Number(e.target.value)))}
                  className="mt-1 w-full rounded-lg border border-zinc-700/50 bg-zinc-900/40 px-2 py-1 text-[12px] text-zinc-100"
                  type="number"
                  step="1"
                  min={0}
                />
              </label>
            ) : (
              <label className="mt-2 block font-mono text-[11px] text-zinc-400">
                $
                <input
                  value={dollars}
                  onChange={(e) => setDollars(Math.max(0, Number(e.target.value)))}
                  className="mt-1 w-full rounded-lg border border-zinc-700/50 bg-zinc-900/40 px-2 py-1 text-[12px] text-zinc-100"
                  type="number"
                  step="1"
                  min={0}
                />
              </label>
            )}
          </div>

          <div className="rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2 text-[11px] text-zinc-300">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Output</div>
            <div className="mt-1 truncate text-[10px] font-semibold text-zinc-400" title={entryLaneName}>
              For <span className="text-zinc-200">{entryLaneName}</span>
            </div>
            <div className="mt-2 space-y-1 font-mono text-[11px] text-zinc-400">
              <div>
                profit <span className={pnl.profitUsd >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{fmtUsd(pnl.profitUsd)}</span>
              </div>
              <div>
                move <span className="text-zinc-200">{(((exit == null ? entry : clamp01(exit)) - clamp01(entry)) * 100).toFixed(1)}¢</span>
              </div>
              <div>
                return <span className="text-zinc-200">{pnl.pct.toFixed(1)}%</span>
              </div>
              <div>
                R/R <span className="text-zinc-200">{rr.r.toFixed(2)}×</span>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-3 grid gap-2 lg:grid-cols-2">
          <div className="rounded-xl border border-amber-800/35 bg-amber-950/15 px-3 py-2 text-[11px] text-amber-100/90">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-200/90">PTB calculator (50¢)</div>
            <div className="mt-1 font-mono text-[11px] text-amber-100/85">
              dist {ptbRead.d >= 0 ? '+' : ''}
              {ptbRead.d.toFixed(1)}pp · {ptbRead.label} · edge {ptbRead.edge}
            </div>
          </div>
          <div className="rounded-xl border border-violet-800/35 bg-violet-950/15 px-3 py-2 text-[11px] text-violet-100/90">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-200/90">Gap calculator</div>
            {gapCalc ? (
              <div className="mt-1 font-mono text-[11px] text-violet-100/85">
                gap {Math.round(gapCalc.lo * 100)}→{Math.round(gapCalc.hi * 100)}¢ · max {Math.round(gapCalc.maxTheoretical * 100)}¢ · capture{' '}
                {(gapCalc.capturePct * 100).toFixed(0)}%
              </div>
            ) : (
              <div className="mt-1 text-[11px] text-zinc-500">Click a void block to autofill.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

