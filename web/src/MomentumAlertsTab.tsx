import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { clobBooks, marketsGet } from './lib/api';
import { midPrice, pickBookLevels } from './bookLevels';
import { snapshotFromBook, type BookSnapshot } from './orderflowMetrics';
import type { SeriesPoint } from './MomentumChart';
import { seriesWindowDelta } from './chartReadouts';
import {
  buildEntryVerdict,
  detectWalls,
  evaluateTick,
  linearSlopePerSec,
  parseMomentumThreshold,
} from './entryDecisionEngine';
import type {
  AlertEvent,
  AlertKind,
  AlertPrefs,
  TradePlan,
  WatchlistEntry,
} from './momentumAlertsTypes';
import { defaultAlertPrefs, defaultTradePlan } from './momentumAlertsTypes';

const LS_WL = 'pm-momentum-watchlist-v1';
const LS_PLAN = 'pm-momentum-trade-plan-v1';
const LS_PREFS = 'pm-momentum-alert-prefs-v1';
const LS_FOCUS = 'pm-momentum-focus-slug-v1';

function isOk<T>(x: unknown): x is { ok: true; data: T } {
  return typeof x === 'object' && x !== null && (x as { ok?: boolean }).ok === true && 'data' in (x as object);
}

function pickTokenIds(m: unknown): string[] {
  if (!m || typeof m !== 'object') return [];
  const o = m as Record<string, unknown>;
  const ids = o.clob_token_ids ?? o.clobTokenIds;
  if (Array.isArray(ids)) return ids.map(String).filter(Boolean);
  if (typeof ids === 'string') {
    const t = ids.trim();
    if (t.startsWith('[')) {
      try {
        const p = JSON.parse(t) as unknown;
        if (Array.isArray(p)) return p.map(String).filter(Boolean);
      } catch {
        /* ignore */
      }
    }
    return t.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function pickQuestion(m: unknown): string {
  if (!m || typeof m !== 'object') return '';
  const o = m as Record<string, unknown>;
  return String(o.question ?? o.title ?? '').trim();
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function fmtPtbUsd(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function MiniSpark({
  pts,
  tone,
  priceToBeatUsd,
}: {
  pts: SeriesPoint[];
  tone: 'up' | 'down';
  priceToBeatUsd?: number | null;
}): ReactElement {
  const w = 200;
  const h = 56;
  const pad = 4;
  const vals = pts.filter((p) => p.v != null).map((p) => p.v as number);
  if (vals.length < 2) {
    return <div className="text-[10px] text-zinc-600">Collecting…</div>;
  }
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) {
    min -= 0.01;
    max += 0.01;
  }
  const t0 = pts[0]!.t;
  const t1 = pts[pts.length - 1]!.t;
  const span = Math.max(1, t1 - t0);
  const stroke = tone === 'up' ? '#6ee7b7' : '#7dd3fc';
  const d = pts
    .filter((p) => p.v != null)
    .map((p, i) => {
      const x = pad + ((p.t - t0) / span) * (w - pad * 2);
      const y = pad + (1 - ((p.v as number) - min) / (max - min)) * (h - pad * 2);
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={w} height={h} className="shrink-0 overflow-visible">
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} opacity={0.95} />
      {priceToBeatUsd != null ? (
        <g aria-label="SSR PTB">
          <text x={pad} y={h - 6} fill="#fde68a" fontSize="6" fontFamily="ui-monospace, monospace">
            PTB {fmtPtbUsd(priceToBeatUsd)}
          </text>
          <line x1={pad} y1={h - 2} x2={w - pad} y2={h - 2} stroke="#fbbf24" strokeWidth={1.8} opacity={0.95} />
        </g>
      ) : null}
    </svg>
  );
}

const ALERT_LABELS: Record<AlertKind, string> = {
  momentum_start: 'Momentum ↑',
  momentum_slow: 'Momentum ↓',
  bid_wall: 'Bid wall',
  ask_wall: 'Ask wall',
  bids_pulled: 'Bids pulled',
  asks_eaten: 'Asks eaten',
  spoof_suspect: 'Spoof?',
  near_entry: 'Near entry',
  near_target: 'Near target',
  weak_follow: 'Weak follow',
  do_not_enter_signal: 'Do not enter',
  context: 'Context',
};

export function MomentumAlertsTab(props: {
  currentSlug: string;
  /** SSR underlying level — shown on mini sparklines when loaded for the open market. */
  priceToBeatUsd?: number | null;
  onOpenInBook: (slug: string) => void;
}): ReactElement {
  const { currentSlug, priceToBeatUsd, onOpenInBook } = props;
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [plan, setPlan] = useState<TradePlan>(() => defaultTradePlan());
  const [prefs, setPrefs] = useState<AlertPrefs>(() => defaultAlertPrefs());
  const [focusSlug, setFocusSlug] = useState<string>('');
  const [slugInput, setSlugInput] = useState('');
  const [busy, setBusy] = useState(false);

  const [midsBySlug, setMidsBySlug] = useState<Record<string, SeriesPoint[]>>({});
  const [snapsBySlug, setSnapsBySlug] = useState<Record<string, BookSnapshot[]>>({});
  const [lastBook, setLastBook] = useState<Record<string, unknown>>({});
  const [strength, setStrength] = useState<Record<string, number>>({});
  const [feed, setFeed] = useState<AlertEvent[]>([]);
  const midsRef = useRef<Record<string, SeriesPoint[]>>({});
  const snapsRef = useRef<Record<string, BookSnapshot[]>>({});
  const prevBestRef = useRef<Record<string, { bid: number; ask: number }>>({});
  const prevSlopeRef = useRef<Record<string, number | null>>({});
  const depthRef = useRef<Record<string, { bids: Map<string, number>; asks: Map<string, number> }>>({});
  const lastFireRef = useRef<Record<string, number>>({});

  useEffect(() => {
    try {
      const w = localStorage.getItem(LS_WL);
      if (w) setWatchlist(JSON.parse(w) as WatchlistEntry[]);
      const p = localStorage.getItem(LS_PLAN);
      if (p) setPlan({ ...defaultTradePlan(), ...JSON.parse(p) });
      const a = localStorage.getItem(LS_PREFS);
      if (a) setPrefs({ ...defaultAlertPrefs(), ...JSON.parse(a) });
      const f = localStorage.getItem(LS_FOCUS);
      if (f) setFocusSlug(f);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_WL, JSON.stringify(watchlist));
  }, [watchlist]);
  useEffect(() => {
    localStorage.setItem(LS_PLAN, JSON.stringify(plan));
  }, [plan]);
  useEffect(() => {
    localStorage.setItem(LS_PREFS, JSON.stringify(prefs));
  }, [prefs]);
  useEffect(() => {
    if (focusSlug) localStorage.setItem(LS_FOCUS, focusSlug);
  }, [focusSlug]);

  useEffect(() => {
    if (!focusSlug && watchlist[0]) setFocusSlug(watchlist[0]!.slug);
  }, [watchlist, focusSlug]);

  const momentumTh = useMemo(() => parseMomentumThreshold(plan), [plan]);

  const addEntry = useCallback(async (rawSlug: string) => {
    const slug = rawSlug.trim();
    if (!slug) return;
    setBusy(true);
    try {
      const res = await marketsGet(slug);
      if (!isOk(res)) return;
      const tokenIds = pickTokenIds(res.data);
      if (tokenIds.length === 0) return;
      const label = pickQuestion(res.data).slice(0, 72) || slug;
      setWatchlist((wl) => {
        if (wl.some((w) => w.slug === slug)) return wl;
        return [...wl, { id: newId(), slug, label, outcomeIndex: 0, tokenIds }];
      });
      setFocusSlug(slug);
    } finally {
      setBusy(false);
    }
  }, []);

  const removeEntry = useCallback((id: string) => {
    setWatchlist((wl) => wl.filter((w) => w.id !== id));
  }, []);

  const poll = useCallback(async () => {
    if (watchlist.length === 0) return;
    const th = parseMomentumThreshold(plan);
    for (const e of watchlist) {
      const ids = e.tokenIds;
      if (!ids?.length) continue;
      const tid = ids[e.outcomeIndex];
      if (!tid) continue;
      const res = await clobBooks([tid]);
      if (!isOk(res) || !res.data[0]) continue;
      const book = res.data[0]!.book;
      if (res.data[0]!.error) continue;
      const key = `${e.id}:${tid}`;
      const prevMaps = depthRef.current[key] ?? null;
      const { snap, next } = snapshotFromBook(book, Date.now(), prevMaps);
      depthRef.current[key] = next;
      const mid = midPrice(book);
      const { bids, asks } = pickBookLevels(book);
      const bb = bids[0]?.size ?? 0;
      const ba = asks[0]?.size ?? 0;
      const wall = detectWalls({ bids, asks });

      const prevMids = midsRef.current[e.slug] ?? [];
      const nextMids = mid != null ? [...prevMids, { t: snap.t, v: mid }].slice(-120) : prevMids;
      midsRef.current[e.slug] = nextMids;

      const prevSnaps = snapsRef.current[e.slug] ?? [];
      const nextSnaps = [...prevSnaps, snap].slice(-120);
      snapsRef.current[e.slug] = nextSnaps;

      const slope = linearSlopePerSec(nextMids.filter((x) => x.v != null) as { t: number; v: number }[]);
      const pb = prevBestRef.current[e.slug];
      const ps = prevSlopeRef.current[e.slug] ?? null;

      const events = evaluateTick({
        slug: e.slug,
        t: snap.t,
        mid,
        snap,
        bestBidSize: bb,
        bestAskSize: ba,
        wall,
        mids: nextMids.filter((x) => x.v != null) as { t: number; v: number }[],
        snaps: nextSnaps,
        prevBestBid: pb?.bid ?? null,
        prevBestAsk: pb?.ask ?? null,
        prevSlope: ps,
        plan,
        prefs,
        momentumThreshold: th,
      });

      prevBestRef.current[e.slug] = { bid: bb, ask: ba };
      prevSlopeRef.current[e.slug] = slope;

      setMidsBySlug((m) => ({ ...m, [e.slug]: nextMids }));
      setSnapsBySlug((m) => ({ ...m, [e.slug]: nextSnaps }));
      setLastBook((m) => ({ ...m, [e.slug]: book }));

      const ch = snap.churn ?? 0;
      const st = Math.min(100, Math.abs(slope ?? 0) * 4000 + Math.sqrt(ch + 1) * 3);
      setStrength((m) => ({ ...m, [e.slug]: st }));

      const now = Date.now();
      const cooled = events.filter((ev) => {
        if (!prefs[ev.kind]) return false;
        const k = `${ev.slug}:${ev.kind}`;
        const last = lastFireRef.current[k] ?? 0;
        if (now - last < 45_000) return false;
        lastFireRef.current[k] = now;
        return true;
      });
      if (cooled.length > 0) {
        setFeed((f) => [...cooled, ...f].slice(0, 120));
      }
    }
  }, [watchlist, plan, prefs]);

  useEffect(() => {
    const id = window.setInterval(() => void poll(), 4_000);
    void poll();
    return () => window.clearInterval(id);
  }, [poll]);

  const focusEntry = watchlist.find((w) => w.slug === focusSlug) ?? watchlist[0];
  const focusBook = focusEntry ? lastBook[focusEntry.slug] : null;
  const focusMidSeries = focusEntry ? midsBySlug[focusEntry.slug] ?? [] : [];
  const focusSnaps = focusEntry ? snapsBySlug[focusEntry.slug] ?? [] : [];
  const verdict = useMemo(() => {
    if (!focusEntry || !focusBook) {
      return buildEntryVerdict({
        mid: null,
        slope: null,
        snap: { t: 0, mid: null, spread: null, bidDepth: 0, askDepth: 0, imbalance: null, churn: null },
        wall: { bidWall: false, askWall: false, bidRatio: 0, askRatio: 0 },
        asks: [],
        plan,
        momentumThreshold: momentumTh,
      });
    }
    const mid = midPrice(focusBook);
    const slope = linearSlopePerSec(focusMidSeries.filter((p) => p.v != null) as { t: number; v: number }[]);
    const { bids, asks } = pickBookLevels(focusBook);
    const wall = detectWalls({ bids, asks });
    const lastSnap = focusSnaps[focusSnaps.length - 1] ?? {
      t: Date.now(),
      mid: null,
      spread: null,
      bidDepth: 0,
      askDepth: 0,
      imbalance: null,
      churn: null,
    };
    return buildEntryVerdict({ mid, slope, snap: lastSnap, wall, asks, plan, momentumThreshold: momentumTh });
  }, [focusEntry, focusBook, focusMidSeries, focusSnaps, plan, momentumTh]);

  const ranked = useMemo(() => {
    return [...watchlist].sort((a, b) => (strength[b.slug] ?? 0) - (strength[a.slug] ?? 0));
  }, [watchlist, strength]);

  const toneClass =
    verdict.tone === 'good'
      ? 'border-emerald-800/40 bg-emerald-950/25 text-emerald-100'
      : verdict.tone === 'wait'
        ? 'border-amber-800/40 bg-amber-950/20 text-amber-100'
        : verdict.tone === 'bad'
          ? 'border-red-800/40 bg-red-950/25 text-red-100'
          : 'border-zinc-800/50 bg-zinc-950/30 text-zinc-200';

  return (
    <div className="mt-5 space-y-5">
      <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 ring-1 ring-white/[0.02]">
        <div className="text-[13px] font-semibold text-zinc-100">Momentum + Alerts</div>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          Watch live mids and order-flow-derived signals across every market you track. Set your plan and alert rules; the feed
          surfaces entries to double-check before you click.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="space-y-3">
          <div className="rounded-2xl border border-zinc-800/50 bg-zinc-900/20 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Tracked markets</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <input
                value={slugInput}
                onChange={(e) => setSlugInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addEntry(slugInput);
                }}
                placeholder="Paste slug to track…"
                className="min-w-[12rem] flex-1 rounded-xl border border-zinc-700/50 bg-zinc-950/40 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void addEntry(slugInput)}
                className="rounded-xl border border-indigo-700/40 bg-indigo-950/30 px-3 py-2 text-xs font-semibold text-indigo-100 hover:bg-indigo-950/50 disabled:opacity-50"
              >
                Add
              </button>
              {currentSlug ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void addEntry(currentSlug)}
                  className="rounded-xl border border-zinc-700/50 bg-zinc-900/40 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-800/60 disabled:opacity-50"
                >
                  Track current
                </button>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            {ranked.length === 0 ? (
              <div className="rounded-xl border border-zinc-800/50 bg-black/20 px-3 py-4 text-sm text-zinc-500">
                No markets yet — add a slug or use Track current from the Book tab.
              </div>
            ) : (
              ranked.map((e) => {
                const pts = midsBySlug[e.slug] ?? [];
                const s = strength[e.slug] ?? 0;
                const slope = linearSlopePerSec(pts.filter((p) => p.v != null) as { t: number; v: number }[]);
                const tone: 'up' | 'down' = (slope ?? 0) >= 0 ? 'up' : 'down';
                return (
                  <div
                    key={e.id}
                    className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-zinc-800/50 bg-zinc-950/40 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-zinc-100">{e.label}</div>
                      <div className="truncate font-mono text-[11px] text-zinc-500">{e.slug}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-zinc-500">
                        <span>Strength {s.toFixed(0)}</span>
                        <span title="Slope of mid over recent points">{slope != null ? `${slope >= 0 ? '+' : ''}${slope.toFixed(5)}/s` : '—'}</span>
                        <span title="Change from oldest to newest point in the mini chart" className="text-zinc-400">
                          {seriesWindowDelta(pts).label}
                        </span>
                      </div>
                      {e.tokenIds && e.tokenIds.length > 1 ? (
                        <div className="mt-2 flex gap-1">
                          {e.tokenIds.map((_, idx) => (
                            <button
                              key={idx}
                              type="button"
                              onClick={() =>
                                setWatchlist((wl) =>
                                  wl.map((x) => (x.id === e.id ? { ...x, outcomeIndex: idx } : x)),
                                )
                              }
                              className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${
                                e.outcomeIndex === idx
                                  ? 'bg-zinc-700 text-zinc-100'
                                  : 'bg-zinc-900 text-zinc-500 hover:bg-zinc-800'
                              }`}
                            >
                              Out {idx + 1}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <MiniSpark
                      pts={pts.slice(-80)}
                      tone={tone}
                      priceToBeatUsd={e.slug === currentSlug ? priceToBeatUsd : null}
                    />
                    <div className="flex flex-col gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setFocusSlug(e.slug);
                          onOpenInBook(e.slug);
                        }}
                        className="rounded-lg border border-zinc-700/50 bg-zinc-900/50 px-2 py-1 text-[10px] font-semibold text-zinc-300 hover:bg-zinc-800"
                      >
                        Open in Book
                      </button>
                      <button
                        type="button"
                        onClick={() => removeEntry(e.id)}
                        className="rounded-lg border border-red-900/40 bg-red-950/20 px-2 py-1 text-[10px] font-semibold text-red-200/90 hover:bg-red-950/40"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="space-y-3">
          <div className="rounded-2xl border border-zinc-800/50 bg-zinc-900/20 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Trade plan</div>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="block text-[10px] text-zinc-500">
                Planned entry
                <input
                  value={plan.plannedEntry}
                  onChange={(e) => setPlan((p) => ({ ...p, plannedEntry: e.target.value }))}
                  className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                />
              </label>
              <label className="block text-[10px] text-zinc-500">
                Entry range low
                <input
                  value={plan.entryRangeLow}
                  onChange={(e) => setPlan((p) => ({ ...p, entryRangeLow: e.target.value }))}
                  className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                />
              </label>
              <label className="block text-[10px] text-zinc-500">
                Entry range high
                <input
                  value={plan.entryRangeHigh}
                  onChange={(e) => setPlan((p) => ({ ...p, entryRangeHigh: e.target.value }))}
                  className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                />
              </label>
              <label className="block text-[10px] text-zinc-500">
                Target sell
                <input
                  value={plan.targetSell}
                  onChange={(e) => setPlan((p) => ({ ...p, targetSell: e.target.value }))}
                  className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                />
              </label>
              <label className="block text-[10px] text-zinc-500">
                Risk
                <select
                  value={plan.riskLevel}
                  onChange={(e) => setPlan((p) => ({ ...p, riskLevel: e.target.value as TradePlan['riskLevel'] }))}
                  className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 text-xs text-zinc-200"
                >
                  <option value="">—</option>
                  <option value="low">Low</option>
                  <option value="med">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
              <label className="block text-[10px] text-zinc-500">
                Momentum threshold (/s)
                <input
                  value={plan.momentumThreshold}
                  onChange={(e) => setPlan((p) => ({ ...p, momentumThreshold: e.target.value }))}
                  className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                />
              </label>
            </div>
            <label className="mt-2 block text-[10px] text-zinc-500">
              Do not enter (notes)
              <textarea
                value={plan.doNotEnter}
                onChange={(e) => setPlan((p) => ({ ...p, doNotEnter: e.target.value }))}
                rows={2}
                className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 text-xs text-zinc-200"
              />
            </label>
            <label className="mt-2 block text-[10px] text-zinc-500">
              Entry assistant — focus market
              <select
                value={focusSlug}
                onChange={(e) => setFocusSlug(e.target.value)}
                className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 text-xs text-zinc-200"
              >
                {watchlist.map((w) => (
                  <option key={w.id} value={w.slug}>
                    {w.label.slice(0, 48)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className={`rounded-2xl border p-4 ${toneClass}`}>
            <div className="text-[11px] font-semibold uppercase tracking-wide opacity-80">Entry decision assistant</div>
            <div className="mt-2 text-sm font-semibold">{verdict.headline}</div>
            <ul className="mt-2 list-inside list-disc space-y-1 text-xs leading-relaxed opacity-95">
              {verdict.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
            <p className="mt-3 text-[10px] leading-snug opacity-70">
              Rule-based read from live book snapshots — not financial advice. For real entries/exits, always line up mid drift with the
              actual best bid/ask on the Book tab (that is where prints anchor).
            </p>
          </div>

          <div className="rounded-2xl border border-zinc-800/50 bg-zinc-900/20 p-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Alert types</div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {(Object.keys(prefs) as AlertKind[]).map((k) => (
                <label key={k} className="flex cursor-pointer items-center gap-2 text-[10px] text-zinc-400">
                  <input
                    type="checkbox"
                    checked={prefs[k]}
                    onChange={(e) => setPrefs((p) => ({ ...p, [k]: e.target.checked }))}
                  />
                  {ALERT_LABELS[k]}
                </label>
              ))}
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/40 p-4">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Alert feed</div>
              <button
                type="button"
                onClick={() => setFeed([])}
                className="text-[10px] font-semibold text-zinc-500 hover:text-zinc-300"
              >
                Clear
              </button>
            </div>
            <div className="mt-2 max-h-64 space-y-1.5 overflow-y-auto">
              {feed.length === 0 ? (
                <div className="text-xs text-zinc-600">No alerts yet — tracking must run a few polls.</div>
              ) : (
                feed.map((a) => (
                  <div key={a.id} className="rounded-lg border border-zinc-800/60 bg-black/25 px-2 py-1.5 text-[11px] leading-snug text-zinc-300">
                    <span className="font-mono text-[10px] text-zinc-500">{new Date(a.t).toLocaleTimeString()}</span>{' '}
                    <span className="text-zinc-500">{a.slug.slice(0, 24)}</span> · {a.message}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
