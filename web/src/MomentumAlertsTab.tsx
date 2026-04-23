import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { clobBooks, marketsGet } from './lib/api';
import { midPrice, pickBookLevels } from './bookLevels';
import { estimateNet4cLong } from './executionEstimator';
import {
  appendSample,
  bucketConfidence,
  bucketSpread,
  computeStats,
  loadSamples,
  sampleFromNet4c,
  updateSampleById,
} from './playbookStats';
import { snapshotFromBook, type BookSnapshot } from './orderflowMetrics';
import type { SeriesPoint } from './MomentumChart';
import { seriesWindowDelta } from './chartReadouts';
import {
  buildUpScalpVerdict,
  detectWalls,
  evaluateTick,
  linearSlopePerSec,
} from './entryDecisionEngine';
import type {
  AlertEvent,
  AlertKind,
  AlertCooldowns,
  AlertPrefs,
  TradePlan,
  UpScalpSettings,
  WatchlistEntry,
} from './momentumAlertsTypes';
import {
  defaultAlertCooldowns,
  defaultAlertPrefs,
  defaultTradePlan,
  defaultUpScalpSettings,
  tradePlan65To70,
} from './momentumAlertsTypes';

const LS_WL = 'pm-momentum-watchlist-v1';
const LS_SCALP = 'pm-momentum-up-scalp-v1';
const LS_PREFS = 'pm-momentum-alert-prefs-v1';
const LS_FOCUS = 'pm-momentum-focus-slug-v1';
const LS_COOLDOWNS = 'pm-momentum-alert-cooldowns-v1';
const LS_FEED_FILTERS = 'pm-momentum-alert-feed-filters-v1';
const LS_PLAYBOOK_VIEW = 'pm-playbook-view-v1';
const LS_TRADE_PLAN = 'pm-momentum-trade-plan-v2';
const LS_CATCH_NOTIFY = 'pm-momentum-catch-notify-v1';

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
  momentum_catch: 'CATCH (zone + momo)',
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
  const [scalpSettings, setScalpSettings] = useState<UpScalpSettings>(() => defaultUpScalpSettings());
  const [prefs, setPrefs] = useState<AlertPrefs>(() => defaultAlertPrefs());
  const [cooldowns, setCooldowns] = useState<AlertCooldowns>(() => defaultAlertCooldowns());
  const [focusSlug, setFocusSlug] = useState<string>('');
  const [slugInput, setSlugInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [minConfidence, setMinConfidence] = useState<number>(55);
  const [hideLowConfidence, setHideLowConfidence] = useState<boolean>(false);
  const [playbookView, setPlaybookView] = useState<'kind' | 'confidence' | 'spread'>(() => 'kind');
  const [tradePlan, setTradePlan] = useState<TradePlan>(() => defaultTradePlan());
  const [catchDesktopNotify, setCatchDesktopNotify] = useState<boolean>(false);
  const tradePlanRef = useRef<TradePlan>(tradePlan);
  const catchNotifyRef = useRef(catchDesktopNotify);

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
  const feedRef = useRef<AlertEvent[]>([]);
  const lastBookRef = useRef<Record<string, unknown>>({});
  const scalpSettingsRef = useRef<UpScalpSettings>(defaultUpScalpSettings());

  useEffect(() => {
    feedRef.current = feed;
  }, [feed]);
  useEffect(() => {
    lastBookRef.current = lastBook;
  }, [lastBook]);
  useEffect(() => {
    scalpSettingsRef.current = scalpSettings;
  }, [scalpSettings]);
  useEffect(() => {
    tradePlanRef.current = tradePlan;
  }, [tradePlan]);
  useEffect(() => {
    catchNotifyRef.current = catchDesktopNotify;
  }, [catchDesktopNotify]);

  const scheduleReadyOutcomes = useCallback((sampleId: string, slug: string) => {
    const run = (slot: 'outcome30s' | 'outcome2m') => {
      const book = lastBookRef.current[slug];
      if (!book || typeof book !== 'object') return;
      const { bids, asks } = pickBookLevels(book);
      const n = estimateNet4cLong({
        asks,
        bids,
        shares: scalpSettingsRef.current.refShares,
        maxLevels: 18,
      });
      const payload = { t: Date.now(), ok: n.ok, profitCents: n.net.profitCents };
      updateSampleById(sampleId, slot === 'outcome30s' ? { outcome30s: payload } : { outcome2m: payload });
    };
    window.setTimeout(() => run('outcome30s'), 30_000);
    window.setTimeout(() => run('outcome2m'), 120_000);
  }, []);

  useEffect(() => {
    try {
      const w = localStorage.getItem(LS_WL);
      if (w) setWatchlist(JSON.parse(w) as WatchlistEntry[]);
      const sc = localStorage.getItem(LS_SCALP);
      if (sc) setScalpSettings({ ...defaultUpScalpSettings(), ...JSON.parse(sc) });
      const a = localStorage.getItem(LS_PREFS);
      if (a) setPrefs({ ...defaultAlertPrefs(), ...JSON.parse(a) });
      const c = localStorage.getItem(LS_COOLDOWNS);
      if (c) setCooldowns({ ...defaultAlertCooldowns(), ...JSON.parse(c) });
      const ff = localStorage.getItem(LS_FEED_FILTERS);
      if (ff) {
        const o = JSON.parse(ff) as { minConfidence?: number; hideLowConfidence?: boolean };
        if (typeof o.minConfidence === 'number' && Number.isFinite(o.minConfidence)) setMinConfidence(Math.max(0, Math.min(100, o.minConfidence)));
        if (typeof o.hideLowConfidence === 'boolean') setHideLowConfidence(o.hideLowConfidence);
      }
      const f = localStorage.getItem(LS_FOCUS);
      if (f) setFocusSlug(f);
      const pv = localStorage.getItem(LS_PLAYBOOK_VIEW);
      if (pv === 'kind' || pv === 'confidence' || pv === 'spread') setPlaybookView(pv);
      const tp = localStorage.getItem(LS_TRADE_PLAN);
      if (tp) setTradePlan({ ...defaultTradePlan(), ...JSON.parse(tp) });
      const cn = localStorage.getItem(LS_CATCH_NOTIFY);
      if (cn === '1') setCatchDesktopNotify(true);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_WL, JSON.stringify(watchlist));
  }, [watchlist]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_SCALP, JSON.stringify(scalpSettings));
    } catch {
      /* ignore */
    }
  }, [scalpSettings]);
  useEffect(() => {
    localStorage.setItem(LS_PREFS, JSON.stringify(prefs));
  }, [prefs]);
  useEffect(() => {
    localStorage.setItem(LS_COOLDOWNS, JSON.stringify(cooldowns));
  }, [cooldowns]);
  useEffect(() => {
    localStorage.setItem(LS_FEED_FILTERS, JSON.stringify({ minConfidence, hideLowConfidence }));
  }, [minConfidence, hideLowConfidence]);
  useEffect(() => {
    localStorage.setItem(LS_PLAYBOOK_VIEW, playbookView);
  }, [playbookView]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_TRADE_PLAN, JSON.stringify(tradePlan));
    } catch {
      /* ignore */
    }
  }, [tradePlan]);
  useEffect(() => {
    try {
      localStorage.setItem(LS_CATCH_NOTIFY, catchDesktopNotify ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [catchDesktopNotify]);
  useEffect(() => {
    if (focusSlug) localStorage.setItem(LS_FOCUS, focusSlug);
  }, [focusSlug]);

  useEffect(() => {
    if (!focusSlug && watchlist[0]) setFocusSlug(watchlist[0]!.slug);
  }, [watchlist, focusSlug]);

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
    const th = scalpSettingsRef.current.minMomentum;
    const scalp = scalpSettingsRef.current;
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
      const net4c = estimateNet4cLong({ asks, bids, shares: scalp.refShares, maxLevels: 18 });

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
        plan: { ...tradePlanRef.current, momentumThreshold: String(scalp.minMomentum) },
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
        const cd = cooldowns[ev.kind] ?? 45_000;
        if (now - last < cd) return false;
        lastFireRef.current[k] = now;
        return true;
      });
        if (cooled.length > 0) {
        for (const ev of cooled) {
          if (
            ev.kind === 'momentum_catch' &&
            catchNotifyRef.current &&
            typeof Notification !== 'undefined' &&
            Notification.permission === 'granted'
          ) {
            try {
              new Notification('Bullpen · CATCH', {
                body: `${ev.message}`,
                tag: `catch-${ev.slug}`,
              });
            } catch {
              /* ignore */
            }
          }
        }
        // Record playbook samples for each fired event (local only).
        const nowCool = Date.now();
        const recentKinds = (slug: string, kinds: AlertKind[]) => {
          const fromFeed = feedRef.current
            .filter((a) => a.slug === slug && nowCool - a.t < 90_000)
            .map((a) => a.kind);
          return [...new Set([...fromFeed, ...kinds])];
        };
        for (const ev of cooled) {
          const kindsForVerdict = recentKinds(
            ev.slug,
            cooled.filter((x) => x.slug === ev.slug).map((x) => x.kind),
          );
          const scalpVerdictSnap = buildUpScalpVerdict({
            net4c,
            settings: scalp,
            mid,
            slope,
            snap,
            wall,
            asks,
            recentAlertKinds: kindsForVerdict,
          });
          const sample = sampleFromNet4c({
            slug: ev.slug,
            kind: ev.kind,
            confidenceScore: ev.confidenceScore,
            spreadCents: bids[0]?.price != null && asks[0]?.price != null ? (asks[0]!.price - bids[0]!.price) * 100 : null,
            churn: snap.churn ?? null,
            verdict: scalpVerdictSnap.state,
            net4c,
          });
          appendSample(sample);
          if (scalpVerdictSnap.state === 'READY') {
            scheduleReadyOutcomes(sample.id, ev.slug);
          }
        }
        // Append (newest last) to avoid scroll-jumping when the feed is in an overflow container.
        setFeed((f) => [...f, ...cooled].slice(-120));
      }

      // Attach a quick “room to +4¢” context event when it’s clearly impossible.
      if (!net4c.ok && prefs.context) {
        const why = net4c.flags.slice(0, 2).join(', ');
        const msg = why
          ? `Net +4¢ looks hard for ${scalp.refShares}sh (${why}).`
          : `Net +4¢ looks hard for ${scalp.refShares}sh.`;
        const contextEv: AlertEvent = {
          id: `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          t: Date.now(),
          slug: e.slug,
          kind: 'context',
          message: msg,
          severity: 'info',
          confidenceScore: net4c.net.profitCents != null ? Math.max(0, Math.min(100, 50 + net4c.net.profitCents * 6)) : undefined,
          flags: net4c.flags.map((id) => ({ id, label: id, severity: id.includes('Wide') || id.includes('No') ? 'warn' : 'info' })),
          drivers: [
            { key: 'net4c.refShares', label: 'Ref size', value: `${scalp.refShares} sh`, raw: scalp.refShares },
            { key: 'net4c.profitCents', label: 'Est net (¢)', value: net4c.net.profitCents != null ? net4c.net.profitCents.toFixed(1) : '—', raw: net4c.net.profitCents ?? undefined },
            { key: 'net4c.requiredGrossCents', label: 'Req gross (¢)', value: net4c.net.requiredGrossCents != null ? net4c.net.requiredGrossCents.toFixed(1) : '—', raw: net4c.net.requiredGrossCents ?? undefined },
          ],
        };
        // Use cooldown gate to avoid spamming.
        const k = `${contextEv.slug}:${contextEv.kind}`;
        const last = lastFireRef.current[k] ?? 0;
        const cd = cooldowns[contextEv.kind] ?? 45_000;
        if (Date.now() - last >= cd) {
          lastFireRef.current[k] = Date.now();
          setFeed((f) => [...f, contextEv].slice(-120));
        }
      }
    }
  }, [watchlist, prefs, cooldowns, scheduleReadyOutcomes]);

  useEffect(() => {
    const id = window.setInterval(() => void poll(), 4_000);
    void poll();
    return () => window.clearInterval(id);
  }, [poll]);

  const focusEntry = watchlist.find((w) => w.slug === focusSlug) ?? watchlist[0];
  const focusBook = focusEntry ? lastBook[focusEntry.slug] : null;
  const focusMidSeries = focusEntry ? midsBySlug[focusEntry.slug] ?? [] : [];
  const focusSnaps = focusEntry ? snapsBySlug[focusEntry.slug] ?? [] : [];
  const recentKindsForFocus = useMemo(() => {
    if (!focusEntry) return [] as AlertKind[];
    const now = Date.now();
    return [
      ...new Set(
        feed.filter((a) => a.slug === focusEntry.slug && now - a.t < 90_000).map((a) => a.kind),
      ),
    ];
  }, [feed, focusEntry]);

  const scalpVerdict = useMemo(() => {
    const emptySnap: BookSnapshot = {
      t: 0,
      mid: null,
      spread: null,
      bidDepth: 0,
      askDepth: 0,
      imbalance: null,
      churn: null,
    };
    if (!focusBook || !focusEntry) {
      const net4c = estimateNet4cLong({
        asks: [],
        bids: [],
        shares: scalpSettings.refShares,
        maxLevels: 18,
      });
      return buildUpScalpVerdict({
        net4c,
        settings: scalpSettings,
        mid: null,
        slope: null,
        snap: emptySnap,
        wall: { bidWall: false, askWall: false, bidRatio: 0, askRatio: 0 },
        asks: [],
        recentAlertKinds: recentKindsForFocus,
      });
    }
    const mid = midPrice(focusBook);
    const slope = linearSlopePerSec(focusMidSeries.filter((p) => p.v != null) as { t: number; v: number }[]);
    const { bids, asks } = pickBookLevels(focusBook);
    const wall = detectWalls({ bids, asks });
    const net4c = estimateNet4cLong({ asks, bids, shares: scalpSettings.refShares, maxLevels: 18 });
    const lastSnap = focusSnaps[focusSnaps.length - 1] ?? emptySnap;
    return buildUpScalpVerdict({
      net4c,
      settings: scalpSettings,
      mid,
      slope,
      snap: lastSnap,
      wall,
      asks,
      recentAlertKinds: recentKindsForFocus,
    });
  }, [focusBook, focusEntry, focusMidSeries, focusSnaps, scalpSettings, recentKindsForFocus]);

  const ranked = useMemo(() => {
    return [...watchlist].sort((a, b) => (strength[b.slug] ?? 0) - (strength[a.slug] ?? 0));
  }, [watchlist, strength]);

  const filteredFeed = useMemo(() => {
    if (!hideLowConfidence) return feed;
    return feed.filter((a) => (a.confidenceScore ?? 100) >= minConfidence);
  }, [feed, hideLowConfidence, minConfidence]);

  const scalpFeedRank = useCallback((k: AlertKind): number => {
    const scores: Partial<Record<AlertKind, number>> = {
      momentum_catch: 6,
      momentum_start: 4,
      asks_eaten: 4,
      bid_wall: 3,
      near_entry: 1,
      near_target: 0,
      momentum_slow: -1,
      ask_wall: -2,
      weak_follow: -4,
      context: -1,
      bids_pulled: -1,
      spoof_suspect: -2,
      do_not_enter_signal: -3,
    };
    return scores[k] ?? 0;
  }, []);

  const rankedFeed = useMemo(() => {
    return [...filteredFeed].sort((a, b) => {
      const d = scalpFeedRank(b.kind) - scalpFeedRank(a.kind);
      if (d !== 0) return d;
      return b.t - a.t;
    });
  }, [filteredFeed, scalpFeedRank]);

  const playbookSamples = useMemo(() => loadSamples(), [feed]);
  const playbookGroups = useMemo(() => {
    const groups = new Map<string, typeof playbookSamples>();
    for (const s of playbookSamples) {
      const key =
        playbookView === 'kind'
          ? s.kind
          : playbookView === 'confidence'
            ? bucketConfidence(s.confidenceScore)
            : bucketSpread(s.spreadCents);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }
    const rows = [...groups.entries()].map(([k, list]) => ({ key: k, stats: computeStats(list) }));
    rows.sort((a, b) => b.stats.okRate - a.stats.okRate);
    return rows;
  }, [playbookSamples, playbookView]);

  const scalpToneClass =
    scalpVerdict.state === 'READY'
      ? 'border-emerald-800/40 bg-emerald-950/25 text-emerald-100'
      : scalpVerdict.state === 'WAIT'
        ? 'border-amber-800/40 bg-amber-950/20 text-amber-100'
        : 'border-red-800/40 bg-red-950/25 text-red-100';

  const rowStatusClass = (s: 'pass' | 'warn' | 'fail') =>
    s === 'pass' ? 'text-emerald-300' : s === 'warn' ? 'text-amber-200' : 'text-red-300';

  return (
    <div className="mt-5 space-y-5">
      <div className="rounded-2xl border border-zinc-800/50 bg-zinc-950/35 p-4 ring-1 ring-white/[0.02]">
        <div className="text-[13px] font-semibold text-zinc-100">+4¢ scalp finder</div>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          <span className="font-semibold text-zinc-300">Where READY comes from:</span> the green verdict runs a <span className="font-mono text-zinc-300">net +N¢</span> path
          at your ref share size (see settings) — if the book cannot support that net after spread/slip, you get AVOID even when mid is
          moving. Tune gates on the right; the alert feed is secondary.
        </p>
        <ol className="mt-2 list-inside list-decimal space-y-0.5 text-[11px] leading-snug text-zinc-400">
          <li>Add your market slug under Tracked markets (or Track current from Book).</li>
          <li>Pick Verdict focus market — the big READY / WAIT / AVOID card follows that slug.</li>
          <li>When READY fires, cross-check the ladder; use Momentum catch block if you want entry-band + tape alerts.</li>
        </ol>
        <p className="mt-2 text-[10px] text-zinc-600">Not financial advice.</p>
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
            <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">4¢ Up Scalp settings</div>
            <p className="mt-1 text-[10px] text-zinc-600">
              Tunes the READY / WAIT / AVOID verdict and net+4¢ checks (ref size applies to feasibility estimates).
            </p>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="block text-[10px] text-zinc-500">
                Target net (¢)
                <input
                  type="number"
                  min={1}
                  max={20}
                  step={0.5}
                  value={scalpSettings.targetNetCents}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    setScalpSettings((s) => ({ ...s, targetNetCents: Math.max(1, Math.min(20, v)) }));
                  }}
                  className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                />
              </label>
              <label className="block text-[10px] text-zinc-500">
                Max spread (¢)
                <input
                  type="number"
                  min={1}
                  max={25}
                  step={0.5}
                  value={scalpSettings.maxSpreadCents}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    setScalpSettings((s) => ({ ...s, maxSpreadCents: Math.max(1, Math.min(25, v)) }));
                  }}
                  className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                />
              </label>
              <label className="block text-[10px] text-zinc-500">
                Max req gross (¢)
                <input
                  type="number"
                  min={4}
                  max={40}
                  step={0.5}
                  value={scalpSettings.maxRequiredGrossCents}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    setScalpSettings((s) => ({ ...s, maxRequiredGrossCents: Math.max(4, Math.min(40, v)) }));
                  }}
                  className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                />
              </label>
              <label className="block text-[10px] text-zinc-500">
                Min clearance to ask wall (×0.01 price)
                <input
                  type="number"
                  min={0.002}
                  max={0.2}
                  step={0.001}
                  value={scalpSettings.minAskWallDistance}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    setScalpSettings((s) => ({ ...s, minAskWallDistance: Math.max(0.002, Math.min(0.2, v)) }));
                  }}
                  className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                />
              </label>
              <label className="block text-[10px] text-zinc-500">
                Min context confidence (0–100)
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={scalpSettings.minConfidence}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    setScalpSettings((s) => ({ ...s, minConfidence: Math.max(0, Math.min(100, Math.floor(v))) }));
                  }}
                  className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                />
              </label>
              <label className="block text-[10px] text-zinc-500">
                Min momentum (/s)
                <input
                  type="number"
                  min={0.001}
                  max={0.2}
                  step={0.001}
                  value={scalpSettings.minMomentum}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    setScalpSettings((s) => ({ ...s, minMomentum: Math.max(0.001, Math.min(0.2, v)) }));
                  }}
                  className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                />
              </label>
              <label className="block text-[10px] text-zinc-500 sm:col-span-2">
                Ref shares (net+4¢ path)
                <input
                  type="number"
                  min={1}
                  max={10_000}
                  step={1}
                  value={scalpSettings.refShares}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v)) return;
                    setScalpSettings((s) => ({ ...s, refShares: Math.max(1, Math.min(10_000, Math.floor(v))) }));
                  }}
                  className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                />
              </label>
            </div>
            <div className="mt-3 rounded-xl border border-amber-900/40 bg-amber-950/15 p-3">
              <div className="text-[10px] font-bold uppercase tracking-wide text-amber-200/80">Momentum catch (entry → target)</div>
              <p className="mt-1 text-[10px] leading-snug text-amber-100/60">
                Set your buy band and take-profit. When mid is <span className="text-amber-100">in the band</span> and tape slope is above your
                min momentum, you get a <span className="font-semibold text-amber-50">CATCH</span> alert (top of feed). Use decimals:{' '}
                <span className="font-mono">0.65</span> = 65¢.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setTradePlan(tradePlan65To70());
                    setScalpSettings((s) => ({ ...s, minMomentum: 0.012, targetNetCents: 5 }));
                  }}
                  className="rounded-lg border border-amber-600/50 bg-amber-950/40 px-2.5 py-1.5 text-[10px] font-bold text-amber-50 hover:bg-amber-950/60"
                >
                  Preset: 64–66¢ entry → 70¢ TP
                </button>
                <label className="flex cursor-pointer items-center gap-2 text-[10px] text-amber-100/80">
                  <input
                    type="checkbox"
                    checked={catchDesktopNotify}
                    onChange={async (e) => {
                      const on = e.target.checked;
                      if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
                        const p = await Notification.requestPermission();
                        setCatchDesktopNotify(p === 'granted');
                        return;
                      }
                      setCatchDesktopNotify(on && (typeof Notification === 'undefined' || Notification.permission === 'granted'));
                    }}
                  />
                  Desktop notify on CATCH
                </label>
              </div>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block text-[10px] text-zinc-500">
                  Planned entry (mid)
                  <input
                    value={tradePlan.plannedEntry}
                    onChange={(e) => setTradePlan((p) => ({ ...p, plannedEntry: e.target.value }))}
                    placeholder="0.65"
                    className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                  />
                </label>
                <label className="block text-[10px] text-zinc-500">
                  Take-profit (mid)
                  <input
                    value={tradePlan.targetSell}
                    onChange={(e) => setTradePlan((p) => ({ ...p, targetSell: e.target.value }))}
                    placeholder="0.70"
                    className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                  />
                </label>
                <label className="block text-[10px] text-zinc-500">
                  Entry band low
                  <input
                    value={tradePlan.entryRangeLow}
                    onChange={(e) => setTradePlan((p) => ({ ...p, entryRangeLow: e.target.value }))}
                    placeholder="0.64"
                    className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                  />
                </label>
                <label className="block text-[10px] text-zinc-500">
                  Entry band high
                  <input
                    value={tradePlan.entryRangeHigh}
                    onChange={(e) => setTradePlan((p) => ({ ...p, entryRangeHigh: e.target.value }))}
                    placeholder="0.66"
                    className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                  />
                </label>
              </div>
            </div>
            <label className="mt-2 block text-[10px] text-zinc-500">
              Verdict focus market
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

          <div className={`rounded-2xl border p-4 ${scalpToneClass}`}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide opacity-80">4¢ Up Scalp verdict</div>
              <div className="font-mono text-lg font-bold">{scalpVerdict.state}</div>
            </div>
            <div className="mt-1 text-sm font-semibold leading-snug">{scalpVerdict.headline}</div>
            {scalpVerdict.tickConfidence != null ? (
              <div className="mt-1 text-[10px] opacity-80">Snapshot confidence ~{scalpVerdict.tickConfidence.toFixed(0)}/100</div>
            ) : null}
            <div className="mt-3 space-y-2">
              {scalpVerdict.rows.map((r) => (
                <div
                  key={r.id}
                  className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-[11px]"
                >
                  <div className="min-w-0 font-semibold text-zinc-200/95">{r.label}</div>
                  <div className={`shrink-0 font-mono text-[10px] uppercase ${rowStatusClass(r.status)}`}>{r.status}</div>
                  <div className="w-full text-[10px] leading-snug text-zinc-400/95">{r.detail}</div>
                </div>
              ))}
            </div>
            <p className="mt-3 text-[10px] leading-snug opacity-70">
              Net+4¢ estimate runs first at your ref size — if execution fails, AVOID even when momentum looks good. Not financial
              advice; line up prints with the Book tab.
            </p>
          </div>

          <div className="rounded-2xl border border-zinc-800/50 bg-zinc-900/20 p-4">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Playbook (net +4¢ feasibility)</div>
                <p className="mt-1 text-[11px] text-zinc-500">
                  Local stats from fired alerts; includes scalp verdict when recorded. READY rows schedule 30s / 2m net+4¢ follow-ups.
                </p>
              </div>
              <select
                value={playbookView}
                onChange={(e) => setPlaybookView(e.target.value as 'kind' | 'confidence' | 'spread')}
                className="rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1 text-[11px] text-zinc-200"
              >
                <option value="kind">By kind</option>
                <option value="confidence">By confidence</option>
                <option value="spread">By spread</option>
              </select>
            </div>
            {playbookGroups.length === 0 ? (
              <div className="mt-3 text-xs text-zinc-600">No samples yet — let alerts run for a bit.</div>
            ) : (
              <div className="mt-3 space-y-2">
                {playbookGroups.slice(0, 10).map((r) => (
                  <div key={r.key} className="rounded-xl border border-zinc-800/60 bg-black/20 px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="text-xs font-semibold text-zinc-200">{r.key || '—'}</div>
                      <div className="font-mono text-[11px] text-zinc-500">n={r.stats.n}</div>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-zinc-400">
                      <span>
                        ok-rate <span className="font-mono text-zinc-200">{(r.stats.okRate * 100).toFixed(0)}%</span>
                      </span>
                      <span>
                        avg est <span className="font-mono text-zinc-200">{r.stats.avgProfitCents != null ? `${r.stats.avgProfitCents.toFixed(1)}¢` : '—'}</span>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
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
            <div className="mt-3 grid gap-2 rounded-xl border border-zinc-800/60 bg-black/20 p-3 sm:grid-cols-2">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Feed filter</div>
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-[10px] text-zinc-400">
                  <input type="checkbox" checked={hideLowConfidence} onChange={(e) => setHideLowConfidence(e.target.checked)} />
                  Hide low-confidence alerts
                </label>
                <label className="mt-2 block text-[10px] text-zinc-500">
                  Min confidence: <span className="font-mono text-zinc-300">{minConfidence.toFixed(0)}</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={minConfidence}
                    onChange={(e) => setMinConfidence(Number(e.target.value))}
                    className="mt-1 w-full"
                  />
                </label>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Cooldown (per kind)</div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {(Object.keys(prefs) as AlertKind[]).slice(0, 6).map((k) => (
                    <label key={k} className="block text-[10px] text-zinc-500">
                      {ALERT_LABELS[k]}
                      <input
                        value={Math.round((cooldowns[k] ?? 45_000) / 1000)}
                        onChange={(e) => {
                          const s = Number(e.target.value);
                          const v = Number.isFinite(s) ? Math.max(0, Math.min(600, Math.floor(s))) * 1000 : 45_000;
                          setCooldowns((c) => ({ ...c, [k]: v }));
                        }}
                        inputMode="numeric"
                        className="mt-0.5 w-full rounded-lg border border-zinc-700/50 bg-zinc-950/50 px-2 py-1.5 font-mono text-xs text-zinc-200"
                      />
                      <div className="mt-0.5 text-[10px] text-zinc-600">sec</div>
                    </label>
                  ))}
                </div>
                <div className="mt-2 text-[10px] text-zinc-600">Tip: other kinds use the defaults; we can expose all if you want.</div>
              </div>
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
              {rankedFeed.length === 0 ? (
                <div className="text-xs text-zinc-600">No alerts yet — tracking must run a few polls.</div>
              ) : (
                rankedFeed.map((a) => (
                  <details
                    key={a.id}
                    className="rounded-lg border border-zinc-800/60 bg-black/25 px-2 py-1.5 text-[11px] leading-snug text-zinc-300"
                  >
                    <summary className="cursor-pointer list-none outline-none marker:content-none [&::-webkit-details-marker]:hidden">
                      <span className="font-mono text-[10px] text-zinc-500">{new Date(a.t).toLocaleTimeString()}</span>{' '}
                      <span className="text-zinc-500">{a.slug.slice(0, 24)}</span> · {a.message}{' '}
                      {typeof a.confidenceScore === 'number' ? (
                        <span className="ml-2 font-mono text-[10px] text-zinc-500">conf {a.confidenceScore.toFixed(0)}</span>
                      ) : null}
                      {a.severity ? (
                        <span
                          className={`ml-2 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                            a.severity === 'critical'
                              ? 'border-rose-700/40 bg-rose-950/25 text-rose-200'
                              : a.severity === 'warn'
                                ? 'border-amber-700/35 bg-amber-950/20 text-amber-100'
                                : 'border-zinc-700/40 bg-zinc-950/30 text-zinc-300'
                          }`}
                        >
                          {a.severity.toUpperCase()}
                        </span>
                      ) : null}
                    </summary>
                    {a.flags?.length ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {a.flags.map((f) => (
                          <span
                            key={f.id}
                            className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                              f.severity === 'warn'
                                ? 'border-amber-700/35 bg-amber-950/20 text-amber-100/90'
                                : 'border-zinc-700/40 bg-zinc-950/30 text-zinc-300'
                            }`}
                          >
                            {f.label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {a.drivers?.length ? (
                      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                        {a.drivers.slice(0, 10).map((d) => (
                          <div key={d.key} className="rounded border border-zinc-800/60 bg-zinc-950/30 px-2 py-1">
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{d.label}</div>
                            <div className="mt-0.5 font-mono text-[11px] text-zinc-200">{d.value}</div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="mt-2 text-[10px] text-zinc-600">No driver details for this alert.</div>
                    )}
                  </details>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
