import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import { PtbOpportunityModeChart } from './PtbOpportunityModeChart';
import { getPaperPosition, loadPaperAccount } from './paperTrading';
import { loadTradeHistory } from './tradeHistory';
import { computePtbChartDerivatives, type PtbChartDerivatives } from './ptbChartDerivatives';
import { buildSpotCandles } from './spotVsPtb';
import type { PtbControlSignal } from './ptbControlSignal';

export type MarketKey = 'btc' | 'eth' | 'sol' | 'matic' | 'alt';

const STRENGTH_HIGH_STREAK = 2;

const FLOW_BADGE: Record<'buy' | 'sell' | 'wait', string> = {
  buy: 'border-emerald-700/50 bg-emerald-950/30 text-emerald-200',
  sell: 'border-rose-700/50 bg-rose-950/30 text-rose-200',
  wait: 'border-amber-700/45 bg-amber-950/25 text-amber-100/90',
};

export type MultiMarketRow = {
  key: MarketKey;
  label: string;
  slug: string;
  spot: SpotPoint[];
  ptb: number | null;
  endsInMs: number | null;
  lastUpdateMs: number | null;
  upToken?: string;
  downToken?: string;
  /** No RTDS/shortcuts yet (e.g. MATIC/ALT) — show in scan but not in main chart. */
  disabled?: boolean;
};

type FlowTone = 'buy' | 'sell' | 'wait';

function fmtClock(endsInMs: number | null): string {
  if (endsInMs == null || !Number.isFinite(endsInMs)) return '—';
  const s = Math.max(0, Math.floor(endsInMs / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function dirFromSeries(spot: SpotPoint[]): 'UP' | 'DOWN' | 'FLAT' {
  if (spot.length < 4) return 'FLAT';
  const n = Math.min(14, spot.length - 1);
  const a = spot[spot.length - 1]!.v;
  const b = spot[spot.length - 1 - n]!.v;
  const d = a - b;
  const eps = Math.max(1e-9, Math.abs(a) * 2e-6);
  if (d > eps) return 'UP';
  if (d < -eps) return 'DOWN';
  return 'FLAT';
}

function laneFromGap(gapUsd: number | null): 'up' | 'down' {
  if (gapUsd == null) return 'up';
  return gapUsd >= 0 ? 'up' : 'down';
}

function strengthLabel(d: PtbChartDerivatives | null): 'HIGH' | 'MED' | 'LOW' {
  if (!d) return 'LOW';
  if (d.momentum === 'NEUTRAL') return 'LOW';
  if (d.momentumStreak >= STRENGTH_HIGH_STREAK) return 'HIGH';
  return 'MED';
}

function flowFromControl(sig: PtbControlSignal | '—'): { text: string; tone: FlowTone } {
  if (sig === '—') return { text: '—', tone: 'wait' };
  if (sig === 'UP_CONTROL') return { text: 'Buyers dominant', tone: 'buy' };
  if (sig === 'DOWN_CONTROL') return { text: 'Sellers dominant', tone: 'sell' };
  return { text: 'Neutral / wait', tone: 'wait' };
}

function useRowDerived(row: MultiMarketRow): {
  gapUsd: number | null;
  derived: PtbChartDerivatives | null;
  flow: { text: string; tone: FlowTone };
  strength: 'HIGH' | 'MED' | 'LOW';
  signalDisplay: PtbControlSignal | '—';
} {
  return useMemo(() => {
    if (row.disabled || row.ptb == null || row.spot.length < 1) {
      return {
        gapUsd: null,
        derived: null,
        flow: { text: '—', tone: 'wait' },
        strength: 'LOW',
        signalDisplay: '—',
      };
    }
    const gapUsd = row.spot[row.spot.length - 1]!.v - row.ptb;
    const pts = row.spot
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
      .slice(-220)
      .map((p) => ({ t: p.t, v: p.v }));
    if (pts.length < 3) {
      return {
        gapUsd,
        derived: null,
        flow: { text: '—', tone: 'wait' },
        strength: 'LOW',
        signalDisplay: '—',
      };
    }
    const candles = buildSpotCandles(pts, Math.min(24, Math.max(10, Math.floor(pts.length * 0.22))));
    const derived = computePtbChartDerivatives({ pts, candles, ptb: row.ptb });
    const flow = flowFromControl(derived.controlSignal);
    return {
      gapUsd,
      derived,
      flow,
      strength: strengthLabel(derived),
      signalDisplay: derived.controlSignal,
    };
  }, [row.disabled, row.ptb, row.spot]);
}

function MicroSpotSparkline(props: { spot: SpotPoint[] }): ReactElement {
  const { spot } = props;
  const d = useMemo(() => {
    const pts = spot.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v)).slice(-40);
    if (pts.length < 2) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo < 1e-12) return { pts, lo: lo - 1e-6, hi: hi + 1e-6, w: 56, h: 20 };
    return { pts, lo, hi, w: 56, h: 20 };
  }, [spot]);
  if (!d) {
    return <div className="h-[20px] w-14 rounded bg-zinc-900/80 ring-1 ring-zinc-800/60" />;
  }
  const { pts, lo, hi, w, h } = d;
  const t0 = pts[0]!.t;
  const t1 = pts[pts.length - 1]!.t;
  const tr = t1 - t0 || 1;
  const path = pts
    .map((p, i) => {
      const x = ((p.t - t0) / tr) * w;
      const y = h - ((p.v - lo) / (hi - lo)) * h;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={w} height={h} className="shrink-0 overflow-visible text-emerald-400/90" viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function MarketScanRow(props: {
  row: MultiMarketRow;
  selected: boolean;
  onSelect: () => void;
}): ReactElement {
  const { row, selected, onSelect } = props;
  const { gapUsd, flow, strength, signalDisplay } = useRowDerived(row);
  const spotDir = useMemo(() => dirFromSeries(row.spot), [row.spot]);
  const ptbArrow = row.disabled || gapUsd == null ? '—' : gapUsd >= 0 ? '↑' : '↓';
  const ring = selected ? 'ring-2 ring-amber-400/35' : 'ring-1 ring-white/[0.04]';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-xl border border-zinc-800/70 bg-[#0b1017] p-2.5 text-left transition-colors ${
        row.disabled ? 'opacity-60' : 'cursor-pointer hover:border-zinc-600/80 hover:bg-black/20'
      } ${ring}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-[12px] font-black tracking-tight text-zinc-100">{row.label}</div>
        <div className="font-mono text-[10px] text-zinc-500">{fmtClock(row.endsInMs)}</div>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          {row.disabled ? (
            <div className="h-5 w-14 rounded bg-zinc-900/50" />
          ) : (
            <MicroSpotSparkline spot={row.spot} />
          )}
          <div className="min-w-0 text-[9px] font-semibold uppercase leading-tight text-zinc-500">
            Spot {spotDir}
            <br />
            <span className="text-zinc-400">PTB {ptbArrow}</span>
          </div>
        </div>
        <div
          className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[8px] font-black uppercase ${
            flow.tone === 'buy' ? FLOW_BADGE.buy : flow.tone === 'sell' ? FLOW_BADGE.sell : FLOW_BADGE.wait
          }`}
        >
          {row.disabled ? '—' : flow.text.split(' ')[0]}
        </div>
      </div>
      <div className="mt-1.5 space-y-0.5 text-[9px] text-zinc-400">
        <div>
          <span className="text-zinc-500">Gap: </span>
          {row.disabled || gapUsd == null ? (
            '—'
          ) : (
            <span className="font-mono text-zinc-200">
              {gapUsd >= 0 ? '+' : ''}
              {gapUsd.toFixed(2)}$
            </span>
          )}
        </div>
        <div>
          <span className="text-zinc-500">Str: </span>
          {row.disabled ? '—' : <span className="font-bold text-zinc-200">{strength}</span>}
          {signalDisplay !== '—' ? (
            <span className="ml-1 font-mono text-zinc-600" title="control">
              {signalDisplay.replaceAll('_', ' ')}
            </span>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function FlowMomentumStrip(props: {
  label: string;
  gapUsd: number | null;
  strength: 'HIGH' | 'MED' | 'LOW';
  flow: { text: string; tone: FlowTone };
}): ReactElement {
  const sColor =
    props.strength === 'HIGH' ? 'text-amber-200' : props.strength === 'MED' ? 'text-zinc-200' : 'text-zinc-500';
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-3">
      <div className="rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2">
        <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Gap vs PTB</div>
        <div className="mt-0.5 font-mono text-[13px] text-zinc-100">
          {props.gapUsd == null
            ? '—'
            : `${props.gapUsd >= 0 ? '+' : ''}${props.gapUsd.toFixed(2)} USD${props.gapUsd >= 0 ? ' · above' : ' · below'}`}
        </div>
        <div className="text-[10px] text-zinc-500">{props.label}</div>
      </div>
      <div className="rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2">
        <div className="text-[9px] font-semibold uppercase tracking-wide text-zinc-500">Strength</div>
        <div className={`mt-0.5 text-[14px] font-black ${sColor}`}>{props.strength}</div>
        <div className="text-[10px] text-zinc-500">from candle + streak</div>
      </div>
      <div className={`rounded-xl border px-3 py-2 ${FLOW_BADGE[props.flow.tone]}`}>
        <div className="text-[9px] font-semibold uppercase tracking-wide opacity-80">Order flow hint</div>
        <div className="mt-0.5 text-[13px] font-bold">{props.flow.text}</div>
        <div className="text-[9px] opacity-70">UP/DOWN control — fast scan</div>
      </div>
    </div>
  );
}

function ProModeBlock(props: {
  showBook: boolean;
  showLiq: boolean;
  showEntry: boolean;
}): ReactElement {
  if (!props.showBook && !props.showLiq && !props.showEntry) return <></>;
  return (
    <div className="mt-3 rounded-xl border border-violet-800/40 bg-violet-950/15 p-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-violet-300/90">Pro mode — edge view</div>
      <div className="mt-2 grid gap-2 md:grid-cols-3">
        {props.showBook ? (
          <div className="rounded-lg border border-zinc-800/50 bg-black/20 p-2 text-[11px] text-zinc-400">
            <span className="font-semibold text-zinc-200">Order book pressure</span>
            <p className="mt-1">Ladder not wired in Command; open Focus market (Dual PTB) for live book.</p>
          </div>
        ) : null}
        {props.showLiq ? (
          <div className="rounded-lg border border-zinc-800/50 bg-black/20 p-2 text-[11px] text-zinc-400">
            <span className="font-semibold text-zinc-200">Liquidity gaps</span>
            <p className="mt-1">Thin vs thick zones: coming (needs per-market book stream).</p>
          </div>
        ) : null}
        {props.showEntry ? (
          <div className="rounded-lg border border-zinc-800/50 bg-black/20 p-2 text-[11px] text-zinc-400">
            <span className="font-semibold text-zinc-200">Entry zones (60–70¢ style)</span>
            <p className="mt-1">Outcome band hints: model not attached in Command view yet.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TradeCommandCenter(): ReactElement {
  const [paper, setPaper] = useState(() => loadPaperAccount());
  const [history, setHistory] = useState(() => loadTradeHistory());
  useEffect(() => {
    const id = window.setInterval(() => {
      setPaper(loadPaperAccount());
      setHistory(loadTradeHistory());
    }, 2_000);
    return () => window.clearInterval(id);
  }, []);
  const realized = paper.realizedPnlUsdCents / 100;
  const last = history[0];
  const openPositions = useMemo(() => {
    const out: { token: string; shares: number; avg: number | null }[] = [];
    const entries = Object.entries(paper.positionsByToken ?? {});
    for (const [token] of entries) {
      const p = getPaperPosition(paper, token);
      if (p.shares <= 0) continue;
      out.push({ token, shares: p.shares, avg: p.avgCost01 });
    }
    out.sort((a, b) => Math.abs(b.shares) - Math.abs(a.shares));
    return out.slice(0, 12);
  }, [paper]);
  return (
    <div className="rounded-2xl border border-zinc-800/70 bg-[#0b1017] p-4 shadow-lg shadow-black/25 ring-1 ring-white/[0.03]">
      <div className="flex items-start justify-between gap-2 border-b border-zinc-800/50 pb-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">Active trades</div>
          <div className="mt-0.5 text-[10px] text-zinc-500">Global (paper, local storage)</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Realized P/L</div>
          <div className="font-mono text-[14px] font-semibold text-zinc-200">{`${realized >= 0 ? '+' : '-'}$${Math.abs(realized).toFixed(2)}`}</div>
        </div>
      </div>
      <div className="mt-3 text-[11px] text-zinc-400">
        {last ? (
          <span className="font-mono text-zinc-300">
            Last: {last.side} {last.label} {last.status}
          </span>
        ) : (
          <span>No recent actions.</span>
        )}
      </div>
      <div className="mt-3">
        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Open</div>
        {openPositions.length ? (
          <div className="mt-2 space-y-2">
            {openPositions.map((p) => (
              <div key={p.token} className="rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11px] text-zinc-300">{`${p.token.slice(0, 8)}…${p.token.slice(-6)}`}</div>
                    <div className="mt-0.5 text-[10px] text-zinc-500">entry avg {p.avg == null ? '—' : `${(p.avg * 100).toFixed(1)}¢`}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[12px] font-semibold text-zinc-100">{p.shares.toFixed(2)} sh</div>
                    <div className="text-[10px] text-zinc-500">status: open</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-2 rounded-xl border border-zinc-800/60 bg-black/15 px-3 py-2 text-[11px] text-zinc-500">No open positions — scan left, trade center.</div>
        )}
      </div>
    </div>
  );
}

export function MultiMarketCommandView(props: {
  rows: MultiMarketRow[];
  intervalLabel: string;
  selectedKey: MarketKey;
  onSelectKey: (k: MarketKey) => void;
  onFocusMarket: (slug: string) => void;
  onOpenTradeDock: (opts: { slug: string; lane: 'up' | 'down' }) => void;
}): ReactElement {
  const { rows, intervalLabel, selectedKey, onSelectKey, onFocusMarket, onOpenTradeDock } = props;
  const selected = useMemo(() => rows.find((r) => r.key === selectedKey) ?? rows.find((r) => !r.disabled), [rows, selectedKey]);
  const [multiView, setMultiView] = useState(false);
  const [proMode, setProMode] = useState(false);
  const [proBook, setProBook] = useState(true);
  const [proLiq, setProLiq] = useState(true);
  const [proEntry, setProEntry] = useState(true);

  const rowFallback = useMemo(
    () =>
      ({
        key: 'btc',
        label: '',
        slug: '',
        spot: [] as SpotPoint[],
        ptb: null,
        endsInMs: null,
        lastUpdateMs: null,
        disabled: true,
      }) satisfies MultiMarketRow,
    [],
  );
  const selectedSnap = useRowDerived(selected ?? rowFallback);

  const tradable = selected && !selected.disabled && selected.slug;
  const liveRows = useMemo(() => rows.filter((r) => !r.disabled && r.slug), [rows]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-zinc-800/70 bg-[#0b1017] px-3 py-2.5 ring-1 ring-white/[0.03]">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500">Multi-market dashboard</div>
          <div className="text-sm font-bold text-zinc-100">Center = execution · sides = scan</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-800/60 bg-black/20 px-2.5 py-1.5 text-[11px] text-zinc-300">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded border-zinc-600"
              checked={multiView}
              onChange={(e) => setMultiView(e.target.checked)}
            />
            <span>Multi-view</span>
          </label>
          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-zinc-800/60 bg-black/20 px-2.5 py-1.5 text-[11px] text-zinc-300">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded border-zinc-600"
              checked={proMode}
              onChange={(e) => setProMode(e.target.checked)}
            />
            <span>Pro mode</span>
          </label>
        </div>
      </div>

      {proMode ? (
        <div className="flex flex-wrap gap-3 rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-2 text-[11px] text-zinc-400">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={proBook} onChange={(e) => setProBook(e.target.checked)} className="rounded border-zinc-600" />
            Book pressure
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={proLiq} onChange={(e) => setProLiq(e.target.checked)} className="rounded border-zinc-600" />
            Liquidity gaps
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={proEntry} onChange={(e) => setProEntry(e.target.checked)} className="rounded border-zinc-600" />
            Entry zones
          </label>
        </div>
      ) : null}

      <div className="grid min-h-0 gap-3 xl:grid-cols-[13.5rem_minmax(0,1fr)_17rem]">
        {/* Left: quick scan — click swaps center (no navigation) */}
        <div className="flex min-w-0 flex-col gap-2">
          <div className="text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Markets · {intervalLabel}</div>
          {rows.map((r) => (
            <MarketScanRow key={r.key} row={r} selected={r.key === selectedKey} onSelect={() => onSelectKey(r.key)} />
          ))}
        </div>

        {/* Center: focus (default) or multi full charts (advanced) */}
        <div className="min-w-0">
          {multiView ? (
            <div>
              <p className="mb-2 text-[11px] text-zinc-500">
                Multi-view: full charts for each connected market. Sides still switch selection for trade buttons below.
              </p>
              <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
                {liveRows.map((r) => (
                  <div key={r.key} className="min-w-0">
                    <PtbOpportunityModeChart
                      mode={laneFromGap(
                        r.ptb != null && r.spot.length ? r.spot[r.spot.length - 1]!.v - r.ptb : null,
                      )}
                      spot={r.spot}
                      priceToBeat={r.ptb}
                      lastUpdateMs={r.lastUpdateMs}
                      endsInMs={r.endsInMs}
                      chartTitle={r.label}
                      upLabel="UP"
                      downLabel="DOWN"
                    />
                  </div>
                ))}
                {rows.some((r) => r.disabled) ? (
                  <div className="rounded-2xl border border-dashed border-zinc-700/60 bg-black/20 p-4 text-[12px] text-zinc-500 lg:col-span-2 xl:col-span-3">
                    MATIC / ALT: feed + shortcuts not wired in this build — will appear in the same grid when available.
                  </div>
                ) : null}
              </div>
              {selected && tradable ? (
                <div className="mt-3 rounded-2xl border border-zinc-800/60 bg-[#0b1017] p-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Quick execute (selected: {selected.label})</div>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <button
                      type="button"
                      onClick={() => onOpenTradeDock({ slug: selected.slug, lane: 'up' })}
                      className="rounded-xl bg-emerald-400 px-3 py-2 text-[11px] font-black text-black hover:bg-emerald-300"
                    >
                      Buy Up
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenTradeDock({ slug: selected.slug, lane: 'down' })}
                      className="rounded-xl bg-rose-400 px-3 py-2 text-[11px] font-black text-black hover:bg-rose-300"
                    >
                      Buy Down
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        onOpenTradeDock({
                          slug: selected.slug,
                          lane: laneFromGap(
                            selected.ptb != null && selected.spot.length
                              ? selected.spot[selected.spot.length - 1]!.v - selected.ptb
                              : null,
                          ),
                        })
                      }
                      className="rounded-xl border border-zinc-800/70 bg-black/20 px-3 py-2 text-[11px] font-black text-zinc-200 hover:bg-black/30"
                    >
                      Sell
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenTradeDock({ slug: selected.slug, lane: 'up' })}
                      className="rounded-xl border border-amber-700/40 bg-amber-950/25 px-3 py-2 text-[11px] font-black text-amber-100"
                    >
                      Close / limit
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : selected && tradable ? (
            <div className="rounded-2xl border border-zinc-800/70 bg-[#0b1017] p-3 ring-1 ring-white/[0.03]">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/50 pb-2">
                <div className="min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-500">Main market · {intervalLabel}</div>
                  <div className="truncate text-[15px] font-bold text-zinc-50">{selected.label}</div>
                  <div className="truncate font-mono text-[10px] text-zinc-600">{selected.slug}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onFocusMarket(selected.slug)}
                    className="rounded-xl border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-[11px] font-bold text-amber-100 hover:bg-amber-950/45"
                    title="Deep book + full workflow"
                  >
                    Focus market
                  </button>
                </div>
              </div>
              <PtbOpportunityModeChart
                mode={laneFromGap(
                  selected.ptb != null && selected.spot.length
                    ? selected.spot[selected.spot.length - 1]!.v - selected.ptb
                    : null,
                )}
                spot={selected.spot}
                priceToBeat={selected.ptb}
                lastUpdateMs={selected.lastUpdateMs}
                endsInMs={selected.endsInMs}
                chartTitle={`${selected.label} · spot vs PTB`}
                upLabel="UP"
                downLabel="DOWN"
              />
              <FlowMomentumStrip
                label="single-market precision"
                gapUsd={selectedSnap.gapUsd}
                strength={selectedSnap.strength}
                flow={selectedSnap.flow}
              />
              {proMode ? <ProModeBlock showBook={proBook} showLiq={proLiq} showEntry={proEntry} /> : null}
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <button
                  type="button"
                  onClick={() => onOpenTradeDock({ slug: selected.slug, lane: 'up' })}
                  className="rounded-xl bg-emerald-400 px-3 py-2.5 text-[11px] font-black text-black hover:bg-emerald-300"
                >
                  Buy Up
                </button>
                <button
                  type="button"
                  onClick={() => onOpenTradeDock({ slug: selected.slug, lane: 'down' })}
                  className="rounded-xl bg-rose-400 px-3 py-2.5 text-[11px] font-black text-black hover:bg-rose-300"
                >
                  Buy Down
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onOpenTradeDock({
                      slug: selected.slug,
                      lane: laneFromGap(
                        selected.ptb != null && selected.spot.length
                          ? selected.spot[selected.spot.length - 1]!.v - selected.ptb
                          : null,
                      ),
                    })
                  }
                  className="rounded-xl border border-zinc-800/70 bg-black/20 px-3 py-2.5 text-[11px] font-black text-zinc-200 hover:bg-black/30"
                >
                  Sell
                </button>
                <button
                  type="button"
                  onClick={() => onOpenTradeDock({ slug: selected.slug, lane: 'up' })}
                  className="rounded-xl border border-amber-700/40 bg-amber-950/25 px-3 py-2.5 text-[11px] font-black text-amber-100 hover:bg-amber-950/35"
                >
                  Close / limit
                </button>
              </div>
            </div>
          ) : selected ? (
            <div className="rounded-2xl border border-dashed border-zinc-700/60 bg-[#0b1017] p-6 text-center">
              <div className="text-[15px] font-bold text-zinc-200">{selected.label}</div>
              <p className="mt-2 text-sm text-zinc-500">
                No live feed or up/down shortcut for this asset in this build — pick BTC, ETH, or SOL to trade. Multi-view will include
                these markets here when wired.
              </p>
            </div>
          ) : (
            <div className="rounded-2xl border border-zinc-800/60 bg-[#0b1017] p-6 text-center text-sm text-zinc-500">
              Select a market on the left.
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-3">
          <TradeCommandCenter />
        </div>
      </div>
    </div>
  );
}
