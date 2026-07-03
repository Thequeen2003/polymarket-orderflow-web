import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ResponsiveGridLayout, useContainerWidth, type Layout, type LayoutItem, type ResponsiveLayouts } from 'react-grid-layout';
import { Rnd } from 'react-rnd';
import { FlowZonesTab } from './FlowZonesTab';
import { clobBooks, marketsGet, priceToBeat, type ApiErr, type ApiOk, type ClobBookEntry } from './lib/api';
import type { BookSnapshot } from './orderflowMetrics';
import { midPrice } from './bookLevels';
import { PtbDualProbabilityChart } from './PtbDualProbabilityChart';
import type { SpotPoint } from './SpotLevelChart';
import { resolveUpDownIndices } from './upDown';
import type { SeriesPoint } from './MomentumChart';

type WorkspaceWidget =
  | { id: string; type: 'ptb_dual'; title?: string; slug: string }
  | { id: string; type: 'flow_zones'; title?: string; scope: 'current' };

type WorkspaceState = {
  v: 1;
  widgets: WorkspaceWidget[];
  layouts: ResponsiveLayouts;
};

const LS_KEY = 'pm-workspace-v1';
const LS_FLOAT_KEY = 'pm-workspace-float-v1';

type FloatMode = 'grid' | 'float';

type FloatWindow = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  open: boolean;
  opacity: number; // 0.35..1
};

type FloatState = {
  v: 1;
  mode: FloatMode;
  windows: Record<string, FloatWindow>;
};

function isOk<T>(res: ApiOk<T> | ApiErr): res is ApiOk<T> {
  return (res as ApiOk<T>).ok === true && 'data' in (res as ApiOk<T>);
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `w-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function pickTokenIds(market: unknown): string[] {
  if (!market || typeof market !== 'object') return [];
  const anyMarket = market as Record<string, unknown>;
  const ids = anyMarket.clob_token_ids ?? anyMarket.clobTokenIds;
  if (Array.isArray(ids)) return ids.map(String).filter(Boolean);
  if (typeof ids === 'string') {
    const t = ids.trim();
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t) as unknown;
        if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
      } catch {
        /* ignore */
      }
    }
    return t.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function pickOutcomeLabels(market: unknown): string[] {
  if (!market || typeof market !== 'object') return [];
  const m = market as Record<string, unknown>;
  const raw = m.outcomes;
  if (Array.isArray(raw)) {
    return raw.map((o) => {
      if (typeof o === 'string') return o;
      if (o && typeof o === 'object') return String((o as Record<string, unknown>).title ?? (o as Record<string, unknown>).name ?? 'Outcome');
      return 'Outcome';
    });
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    } catch {
      /* ignore */
    }
  }
  return [];
}

function pickMarketQuestion(m: unknown): string {
  if (!m || typeof m !== 'object') return '';
  const o = m as Record<string, unknown>;
  return String(o.question ?? o.title ?? '').trim();
}

function readWorkspace(): WorkspaceState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) throw new Error('no');
    const parsed = JSON.parse(raw) as WorkspaceState;
    if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) throw new Error('bad');
    if (!Array.isArray(parsed.widgets)) throw new Error('bad');
    if (!parsed.layouts || typeof parsed.layouts !== 'object') throw new Error('bad');
    return parsed;
  } catch {
    const w1: WorkspaceWidget = { id: 'flow-current', type: 'flow_zones', title: 'Flow Zones', scope: 'current' };
    return {
      v: 1,
      widgets: [w1],
      layouts: {
        lg: [{ i: w1.id, x: 0, y: 0, w: 12, h: 10, minW: 6, minH: 6 }],
        md: [{ i: w1.id, x: 0, y: 0, w: 10, h: 10, minW: 6, minH: 6 }],
        sm: [{ i: w1.id, x: 0, y: 0, w: 6, h: 10, minW: 4, minH: 6 }],
      },
    };
  }
}

function readFloatState(): FloatState {
  try {
    const raw = localStorage.getItem(LS_FLOAT_KEY);
    if (!raw) throw new Error('no');
    const parsed = JSON.parse(raw) as FloatState;
    if (!parsed || typeof parsed !== 'object' || parsed.v !== 1) throw new Error('bad');
    if (parsed.mode !== 'grid' && parsed.mode !== 'float') throw new Error('bad');
    if (!parsed.windows || typeof parsed.windows !== 'object') throw new Error('bad');
    return parsed;
  } catch {
    return { v: 1, mode: 'float', windows: {} };
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function shortSlug(slug: string): string {
  const s = slug.trim();
  if (s.length <= 22) return s;
  return `${s.slice(0, 22)}…`;
}

function nextWindowZ(windows: Record<string, FloatWindow>): number {
  return Math.max(0, ...Object.values(windows).map((w) => w.z)) + 1;
}

function tileFloatWindows(params: {
  widgets: WorkspaceWidget[];
  windows: Record<string, FloatWindow>;
  boundsW: number;
  boundsH: number;
}): Record<string, FloatWindow> {
  const { widgets, windows, boundsW, boundsH } = params;
  const ids = widgets.map((w) => w.id);
  if (ids.length === 0) return windows;
  const pad = 14;
  const cols = ids.length <= 1 ? 1 : ids.length <= 4 ? 2 : ids.length <= 9 ? 3 : 4;
  const rows = Math.max(1, Math.ceil(ids.length / cols));
  const cellW = Math.max(320, Math.floor((boundsW - pad * (cols + 1)) / cols));
  const cellH = Math.max(220, Math.floor((boundsH - pad * (rows + 1)) / rows));
  const next = { ...windows };

  ids.forEach((id, i) => {
    const prev = windows[id];
    const col = i % cols;
    const row = Math.floor(i / cols);
    next[id] = {
      ...(prev ?? {
        id,
        x: 0,
        y: 0,
        w: cellW,
        h: cellH,
        z: i + 1,
        open: true,
        opacity: 0.96,
      }),
      x: pad + col * (cellW + pad),
      y: pad + row * (cellH + pad),
      w: cellW,
      h: cellH,
      z: i + 1,
      open: true,
    };
  });
  return next;
}

function cascadeFloatWindows(params: {
  widgets: WorkspaceWidget[];
  windows: Record<string, FloatWindow>;
  boundsW: number;
  boundsH: number;
}): Record<string, FloatWindow> {
  const { widgets, windows, boundsW, boundsH } = params;
  const ids = widgets.map((w) => w.id);
  if (ids.length === 0) return windows;
  const next = { ...windows };
  const baseW = Math.max(420, Math.min(720, boundsW - 120));
  const baseH = Math.max(280, Math.min(520, boundsH - 120));
  const stepX = 28;
  const stepY = 24;

  ids.forEach((id, i) => {
    const prev = windows[id];
    const x = clamp(18 + i * stepX, 10, Math.max(10, boundsW - baseW - 10));
    const y = clamp(18 + i * stepY, 10, Math.max(10, boundsH - baseH - 10));
    next[id] = {
      ...(prev ?? {
        id,
        x,
        y,
        w: baseW,
        h: baseH,
        z: i + 1,
        open: true,
        opacity: 0.94,
      }),
      x,
      y,
      w: baseW,
      h: baseH,
      z: i + 1,
      open: true,
    };
  });
  return next;
}

function sanitizeLayouts(layouts: ResponsiveLayouts, widgets: WorkspaceWidget[]): ResponsiveLayouts {
  const ids = new Set(widgets.map((w) => w.id));
  const clean = (ls: Layout | undefined) => (ls ?? []).filter((l) => ids.has(l.i));
  const out: ResponsiveLayouts = {};
  for (const bp of ['lg', 'md', 'sm', 'xs', 'xxs'] as const) out[bp] = clean(layouts[bp]);
  return out;
}

function ensureLayoutFor(
  layouts: ResponsiveLayouts,
  id: string,
  spec: { w: number; h: number; minW?: number; minH?: number },
): ResponsiveLayouts {
  const addIfMissing = (arr: Layout | undefined, x: number) => {
    const xs: LayoutItem[] = arr ? [...arr] : [];
    if (!xs.some((l) => l.i === id))
      xs.push({ i: id, x, y: Infinity, w: spec.w, h: spec.h, minW: spec.minW, minH: spec.minH, isResizable: true, isDraggable: true });
    return xs;
  };
  return {
    lg: addIfMissing(layouts.lg, 0),
    md: addIfMissing(layouts.md, 0),
    sm: addIfMissing(layouts.sm, 0),
    xs: addIfMissing(layouts.xs, 0),
    xxs: addIfMissing(layouts.xxs, 0),
  };
}

function WidgetFrame(props: {
  title: string;
  subtitle?: string;
  toolbar?: ReactElement;
  onClose?: () => void;
  children: ReactElement;
}): ReactElement {
  const { title, subtitle, toolbar, onClose, children } = props;
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-zinc-800/70 bg-gradient-to-b from-zinc-950/45 to-zinc-950/25 shadow-[0_10px_30px_rgba(0,0,0,0.35)] ring-1 ring-white/[0.03]">
      {/* Drag handle lives ONLY on this header (less jank). */}
      <div className="pm-widget-drag flex cursor-grab items-start justify-between gap-2 border-b border-zinc-800/70 bg-zinc-950/40 px-3 py-2 active:cursor-grabbing">
        <div className="flex min-w-0 items-start gap-2">
          <div className="mt-0.5 select-none text-zinc-600" title="Drag">
            ⋮⋮
          </div>
          <div className="min-w-0">
            <div className="truncate text-[12px] font-semibold tracking-tight text-zinc-100">{title}</div>
            {subtitle ? <div className="truncate font-mono text-[10px] text-zinc-500">{subtitle}</div> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {toolbar}
          {onClose ? (
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }}
              className="shrink-0 rounded-lg border border-zinc-700/60 bg-zinc-950/30 px-2 py-1 text-[10px] font-semibold text-zinc-300 hover:bg-zinc-900/55"
              title="Close"
            >
              ✕
            </button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
    </div>
  );
}

function PtbDualWidget(props: { slug: string; onOpenInBook: (slug: string) => void }): ReactElement {
  const { slug } = props;
  const [marketJson, setMarketJson] = useState<unknown | null>(null);
  const [books, setBooks] = useState<ClobBookEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ssrPtb, setSsrPtb] = useState<number | null>(null);
  const [lastUpdateMs, setLastUpdateMs] = useState<number | null>(null);
  const [seriesByToken, setSeriesByToken] = useState<Record<string, SeriesPoint[]>>({});

  const tokenIds = useMemo(() => pickTokenIds(marketJson), [marketJson]);
  const outcomeLabels = useMemo(() => pickOutcomeLabels(marketJson), [marketJson]);
  const idx = useMemo(() => resolveUpDownIndices(outcomeLabels, marketJson), [marketJson, outcomeLabels]);

  const refreshMarket = useCallback(async () => {
    setErr(null);
    const res = await marketsGet(slug);
    if (isOk(res)) setMarketJson(res.data);
    else setErr(String((res as ApiErr).error ?? 'market load failed'));
  }, [slug]);

  const refreshPtb = useCallback(async () => {
    const res = await priceToBeat(slug);
    if (isOk(res)) setSsrPtb(res.data.price_to_beat);
    else setSsrPtb(null);
  }, [slug]);

  const refreshBooksOnce = useCallback(async () => {
    if (tokenIds.length === 0) return;
    const res = await clobBooks(tokenIds);
    if (!isOk(res)) {
      setErr(String((res as ApiErr).error ?? 'book load failed'));
      return;
    }
    setBooks(res.data);
    const ts = Date.now();
    setLastUpdateMs(ts);
    setSeriesByToken((m) => {
      const next = { ...m };
      for (const e of res.data) {
        const token = e.token;
        const v = e.error ? null : midPrice(e.book);
        const prev = next[token] ?? [];
        next[token] = [...prev, { t: ts, v }].slice(-180);
      }
      return next;
    });
  }, [tokenIds]);

  useEffect(() => {
    void refreshMarket();
    void refreshPtb();
  }, [refreshMarket, refreshPtb]);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      await refreshBooksOnce();
    };
    void tick();
    const id = window.setInterval(() => void tick(), 5_000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [refreshBooksOnce]);

  const q = pickMarketQuestion(marketJson);
  const upLabel = idx ? (outcomeLabels[idx.up] ?? 'UP') : 'UP';
  const downLabel = idx ? (outcomeLabels[idx.down] ?? 'DOWN') : 'DOWN';

  const probUp = useMemo(() => {
    if (!idx || !books || books.length < 2) return [] as SpotPoint[];
    const tok = books[idx.up]?.token;
    if (!tok) return [];
    return (seriesByToken[tok] ?? [])
      .filter((p) => typeof p.v === 'number' && Number.isFinite(p.v as number))
      .map((p) => ({ t: p.t, v: p.v as number }))
      .slice(-220);
  }, [books, idx, seriesByToken]);

  const probDown = useMemo(() => {
    if (!idx || !books || books.length < 2) return [] as SpotPoint[];
    const tok = books[idx.down]?.token;
    if (!tok) return [];
    return (seriesByToken[tok] ?? [])
      .filter((p) => typeof p.v === 'number' && Number.isFinite(p.v as number))
      .map((p) => ({ t: p.t, v: p.v as number }))
      .slice(-220);
  }, [books, idx, seriesByToken]);

  const bookUp = idx && books ? books[idx.up]?.book ?? {} : {};
  const bookDown = idx && books ? books[idx.down]?.book ?? {} : {};

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 truncate text-[11px] text-zinc-400">{q || slug}</div>
        <button
          type="button"
          onClick={() => props.onOpenInBook(slug)}
          className="rounded-lg border border-zinc-700/55 bg-zinc-950/30 px-2.5 py-1 text-[10px] font-semibold text-zinc-200 hover:bg-zinc-900/45"
        >
          Open
        </button>
      </div>
      {err ? <div className="rounded-xl border border-amber-800/30 bg-amber-950/15 px-3 py-2 text-xs text-amber-100/90">{err}</div> : null}
      <PtbDualProbabilityChart
        probUp={probUp}
        probDown={probDown}
        upLabel={upLabel}
        downLabel={downLabel}
        lastUpdateMs={lastUpdateMs}
        priceToBeatUsd={ssrPtb}
        bookUp={bookUp}
        bookDown={bookDown}
        compactHeader
        playbookSlug={slug}
      />
    </div>
  );
}

export function WorkspaceTab(props: {
  currentSlug: string;
  market: unknown | null;
  books: ClobBookEntry[] | null;
  outcomeLabels: string[];
  flowSeriesForSlug: Record<string, BookSnapshot[]> | null;
  booksFetchedAt: number | null;
  priceToBeatUsd: number | null;
  endsInMs: number | null;
  onOpenInBook: (slug: string) => void;
}): ReactElement {
  const { currentSlug, market, books, outcomeLabels, flowSeriesForSlug, booksFetchedAt, priceToBeatUsd, endsInMs, onOpenInBook } = props;

  const [state, setState] = useState<WorkspaceState>(() => readWorkspace());
  const [floatState, setFloatState] = useState<FloatState>(() => readFloatState());
  const [addSlug, setAddSlug] = useState<string>('');
  const [multiSlugsText, setMultiSlugsText] = useState<string>('');
  const [multiAddPtbDual, setMultiAddPtbDual] = useState<boolean>(true);
  const [multiAddFlowZones, setMultiAddFlowZones] = useState<boolean>(false);
  const { width, containerRef, mounted } = useContainerWidth({ measureBeforeMount: true, initialWidth: 1280 });
  const bumpRef = useRef(1);

  const widgets = state.widgets;
  const layouts = useMemo(() => sanitizeLayouts(state.layouts, widgets), [state.layouts, widgets]);
  const floatCanvasH = useMemo(() => {
    if (typeof window === 'undefined') return 640;
    return Math.max(500, Math.min(736, Math.round(window.innerHeight * 0.76) - 96));
  }, []);
  const floatCanvasW = Math.max(720, width - 12);
  const ptbWidgets = useMemo(() => widgets.filter((w): w is Extract<WorkspaceWidget, { type: 'ptb_dual' }> => w.type === 'ptb_dual'), [widgets]);
  const hiddenWidgets = useMemo(() => widgets.filter((w) => floatState.windows[w.id] && !floatState.windows[w.id]!.open), [floatState.windows, widgets]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ ...state, layouts: sanitizeLayouts(state.layouts, state.widgets) }));
    } catch {
      /* ignore */
    }
  }, [state]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_FLOAT_KEY, JSON.stringify(floatState));
    } catch {
      /* ignore */
    }
  }, [floatState]);

  const ensureWindow = useCallback(
    (id: string, prefer: Partial<FloatWindow> = {}) => {
      setFloatState((fs) => {
        if (fs.windows[id]) return fs;
        const zMax = Math.max(0, ...Object.values(fs.windows).map((w) => w.z));
        const base: FloatWindow = {
          id,
          x: 20 + (Object.keys(fs.windows).length % 6) * 26,
          y: 20 + (Object.keys(fs.windows).length % 5) * 22,
          w: 520,
          h: 360,
          z: zMax + 1,
          open: true,
          opacity: 0.92,
        };
        const next = { ...base, ...prefer };
        return { ...fs, windows: { ...fs.windows, [id]: next } };
      });
    },
    [setFloatState],
  );

  const showWindow = useCallback(
    (id: string) => {
      setFloatState((fs) => {
        const w = fs.windows[id];
        if (!w) return fs;
        return {
          ...fs,
          windows: {
            ...fs.windows,
            [id]: { ...w, open: true, z: nextWindowZ(fs.windows) },
          },
        };
      });
    },
    [setFloatState],
  );

  useEffect(() => {
    // Ensure every widget has a floating window record (so float mode works immediately).
    for (const w of widgets) {
      ensureWindow(w.id, w.type === 'flow_zones' ? { w: 860, h: 520 } : { w: 620, h: 420 });
    }
  }, [ensureWindow, widgets]);

  const addPtbDual = useCallback(
    (slug: string) => {
      const s = slug.trim();
      if (!s) return;
      const existing = widgets.find((w) => w.type === 'ptb_dual' && w.slug === s);
      if (existing) {
        showWindow(existing.id);
        setAddSlug('');
        return;
      }
      const id = `ptb-${newId()}`;
      const w: WorkspaceWidget = { id, type: 'ptb_dual', slug: s, title: 'Dual PTB' };
      setState((st) => ({
        ...st,
        widgets: [...st.widgets, w],
        layouts: ensureLayoutFor(st.layouts, id, { w: 6, h: 9, minW: 4, minH: 6 }),
      }));
      ensureWindow(id, { w: 640, h: 460 });
      setAddSlug('');
    },
    [ensureWindow, setState, showWindow, widgets],
  );

  const addFlowZones = useCallback(() => {
    const exists = state.widgets.some((w) => w.type === 'flow_zones');
    if (exists) return;
    const id = 'flow-current';
    const w: WorkspaceWidget = { id, type: 'flow_zones', title: 'Flow Zones', scope: 'current' };
    setState((st) => ({
      ...st,
      widgets: [...st.widgets, w],
      layouts: ensureLayoutFor(st.layouts, id, { w: 12, h: 10, minW: 6, minH: 6 }),
    }));
    ensureWindow(id, { w: 980, h: 600 });
  }, [ensureWindow, state.widgets]);

  const removeWidget = useCallback((id: string) => {
    setState((st) => {
      const nextWidgets = st.widgets.filter((w) => w.id !== id);
      return { ...st, widgets: nextWidgets, layouts: sanitizeLayouts(st.layouts, nextWidgets) };
    });
    setFloatState((fs) => {
      const next = { ...fs.windows };
      delete next[id];
      return { ...fs, windows: next };
    });
  }, []);

  const closeWindow = useCallback((id: string) => {
    setFloatState((fs) => {
      const w = fs.windows[id];
      if (!w) return fs;
      return { ...fs, windows: { ...fs.windows, [id]: { ...w, open: false } } };
    });
  }, []);

  const restoreAllHidden = useCallback(() => {
    setFloatState((fs) => {
      const next = { ...fs.windows };
      let z = nextWindowZ(fs.windows);
      for (const w of widgets) {
        const cur = next[w.id];
        if (!cur) continue;
        next[w.id] = { ...cur, open: true, z: z++ };
      }
      return { ...fs, windows: next };
    });
  }, [widgets]);

  const tileAll = useCallback(() => {
    setFloatState((fs) => ({
      ...fs,
      mode: 'float',
      windows: tileFloatWindows({
        widgets,
        windows: fs.windows,
        boundsW: floatCanvasW,
        boundsH: floatCanvasH,
      }),
    }));
  }, [floatCanvasH, floatCanvasW, widgets]);

  const cascadeAll = useCallback(() => {
    setFloatState((fs) => ({
      ...fs,
      mode: 'float',
      windows: cascadeFloatWindows({
        widgets,
        windows: fs.windows,
        boundsW: floatCanvasW,
        boundsH: floatCanvasH,
      }),
    }));
  }, [floatCanvasH, floatCanvasW, widgets]);

  const parsedMultiSlugs = useMemo(() => {
    const raw = multiSlugsText
      .split(/[\n,]+/g)
      .map((s) => s.trim())
      .filter(Boolean);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of raw) {
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out.slice(0, 12);
  }, [multiSlugsText]);

  const addSelected = useCallback(() => {
    if (multiAddFlowZones) addFlowZones();
    if (multiAddPtbDual) {
      const slugs = parsedMultiSlugs.length ? parsedMultiSlugs : currentSlug ? [currentSlug] : [];
      for (const s of slugs) addPtbDual(s);
    }
    if (floatState.mode === 'float') window.setTimeout(() => tileAll(), 40);
  }, [addFlowZones, addPtbDual, currentSlug, floatState.mode, multiAddFlowZones, multiAddPtbDual, parsedMultiSlugs, tileAll]);

  const addCurrentStation = useCallback(() => {
    if (currentSlug) addPtbDual(currentSlug);
    addFlowZones();
    window.setTimeout(() => tileAll(), 40);
  }, [addFlowZones, addPtbDual, currentSlug, tileAll]);

  useEffect(() => {
    const slug = currentSlug.trim();
    if (!slug) return;
    const hasSlugWidget = widgets.some((w) => w.type === 'ptb_dual' && w.slug.trim().toLowerCase() === slug.toLowerCase());
    if (hasSlugWidget) return;
    const defaultOnlyFlow =
      widgets.length === 1 && widgets[0]?.type === 'flow_zones' && widgets[0]?.id === 'flow-current';
    if (!defaultOnlyFlow) return;
    addPtbDual(slug);
    window.setTimeout(() => tileAll(), 40);
  }, [addPtbDual, currentSlug, tileAll, widgets]);

  return (
    <div className="mt-5 space-y-3">
      <div className="rounded-2xl border border-zinc-800/70 bg-gradient-to-b from-zinc-950/40 to-zinc-900/15 p-4 ring-1 ring-white/[0.03]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold tracking-tight text-zinc-50">Mega workspace</div>
            <div className="mt-1 text-[12px] text-zinc-400">
              Check the modules you want, tile the charts, and keep one live desk open instead of tab-hopping between views.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-xl border border-zinc-800/70 bg-zinc-950/35 p-1">
              <button
                type="button"
                onClick={() => setFloatState((s) => ({ ...s, mode: 'float' }))}
                className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide ${
                  floatState.mode === 'float' ? 'bg-indigo-950/55 text-indigo-200' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                Floating
              </button>
              <button
                type="button"
                onClick={() => setFloatState((s) => ({ ...s, mode: 'grid' }))}
                className={`rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide ${
                  floatState.mode === 'grid' ? 'bg-zinc-800/60 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                Grid
              </button>
            </div>
            <button
              type="button"
              onClick={() => setState(readWorkspace())}
              className="rounded-xl border border-zinc-700/55 bg-zinc-950/35 px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900/55"
            >
              Reset layout
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-2xl border border-zinc-800/60 bg-black/20 p-3">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Station controls</span>
          <button
            type="button"
            onClick={addCurrentStation}
            className="rounded-full border border-emerald-700/45 bg-emerald-950/30 px-3 py-1.5 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-950/45"
          >
            Current market preset
          </button>
          <button
            type="button"
            onClick={tileAll}
            className="rounded-full border border-zinc-700/55 bg-zinc-950/35 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900/55"
          >
            Tile all
          </button>
          <button
            type="button"
            onClick={cascadeAll}
            className="rounded-full border border-zinc-700/55 bg-zinc-950/35 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900/55"
          >
            Cascade
          </button>
          <button
            type="button"
            onClick={restoreAllHidden}
            disabled={hiddenWidgets.length === 0}
            className="rounded-full border border-zinc-700/55 bg-zinc-950/35 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900/55 disabled:cursor-not-allowed disabled:opacity-45"
          >
            Restore hidden
          </button>
          <span className="ml-auto text-[11px] text-zinc-500">
            {ptbWidgets.length} market{ptbWidgets.length === 1 ? '' : 's'} · {widgets.length} widget{widgets.length === 1 ? '' : 's'}
          </span>
        </div>

        {ptbWidgets.length > 0 ? (
          <div className="mt-3 rounded-2xl border border-zinc-800/60 bg-black/20 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Market shelf</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {ptbWidgets.map((w) => {
                const hidden = !!floatState.windows[w.id] && !floatState.windows[w.id]!.open;
                return (
                  <div key={`shelf-${w.id}`} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700/55 bg-zinc-950/35 px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => showWindow(w.id)}
                      className="font-mono text-[11px] text-zinc-100 hover:text-white"
                      title={w.slug}
                    >
                      {shortSlug(w.slug)}
                    </button>
                    {hidden ? <span className="text-[9px] font-semibold uppercase tracking-wide text-amber-200/90">hidden</span> : null}
                    <button
                      type="button"
                      onClick={() => onOpenInBook(w.slug)}
                      className="rounded-full border border-zinc-700/55 px-2 py-0.5 text-[10px] font-semibold text-zinc-300 hover:bg-zinc-900/55"
                    >
                      Book
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div className="rounded-2xl border border-zinc-800/60 bg-black/20 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Widgets</div>
            <div className="mt-2 grid gap-2">
              <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-zinc-800/60 bg-zinc-950/30 px-3 py-2 text-[12px] text-zinc-200 hover:bg-zinc-900/35">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={multiAddPtbDual}
                  onChange={(e) => setMultiAddPtbDual(e.target.checked)}
                />
                <div className="min-w-0">
                  <div className="font-semibold text-zinc-100">Dual PTB</div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">One dual-probability chart tile per market slug.</div>
                </div>
              </label>

              <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-zinc-800/60 bg-zinc-950/30 px-3 py-2 text-[12px] text-zinc-200 hover:bg-zinc-900/35">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={multiAddFlowZones}
                  onChange={(e) => setMultiAddFlowZones(e.target.checked)}
                />
                <div className="min-w-0">
                  <div className="font-semibold text-zinc-100">Flow Zones</div>
                  <div className="mt-0.5 text-[11px] text-zinc-500">Keeps the current market’s flow / DOM module in the same workspace.</div>
                </div>
              </label>
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-800/60 bg-black/20 p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Markets</div>
            <label className="mt-2 block text-[11px] text-zinc-500">
              Slugs (comma or newline separated)
              <textarea
                value={multiSlugsText}
                onChange={(e) => setMultiSlugsText(e.target.value)}
                placeholder={currentSlug ? `${currentSlug}\n…another-slug` : 'paste slugs here'}
                rows={3}
                className="mt-1 w-full resize-y rounded-xl border border-zinc-700/50 bg-zinc-950/35 px-3 py-2 font-mono text-[12px] text-zinc-200 placeholder:text-zinc-700"
              />
            </label>
            {currentSlug ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                <span>Quick add:</span>
                <button
                  type="button"
                  onClick={() => setMultiSlugsText((t) => (t.trim() ? `${t.trim()}\n${currentSlug}` : currentSlug))}
                  className="rounded-full border border-zinc-700/55 bg-zinc-950/35 px-3 py-1.5 font-mono text-[11px] text-zinc-200 hover:bg-zinc-900/55"
                >
                  + {currentSlug}
                </button>
              </div>
            ) : null}
            {parsedMultiSlugs.length ? (
              <div className="mt-2 text-[10px] text-zinc-600">
                Selected slugs: <span className="font-mono text-zinc-400">{parsedMultiSlugs.join(', ')}</span>
              </div>
            ) : (
              <div className="mt-2 text-[10px] text-zinc-600">No slugs selected yet (will fall back to current slug if available).</div>
            )}
          </div>

          <div className="flex items-end">
            <button
              type="button"
              onClick={() => addSelected()}
              className="h-[44px] w-full rounded-xl border border-emerald-700/45 bg-emerald-950/30 px-4 text-xs font-semibold text-emerald-100 shadow-md shadow-emerald-950/20 hover:bg-emerald-950/45"
            >
              Add selected
            </button>
          </div>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
          <label className="block text-[11px] text-zinc-500">
            Add a single Dual PTB (legacy)
            <input
              value={addSlug}
              onChange={(e) => setAddSlug(e.target.value)}
              placeholder={currentSlug ? `e.g. ${currentSlug}` : 'paste a slug'}
              className="mt-1 w-full rounded-xl border border-zinc-700/50 bg-zinc-950/35 px-3 py-2 font-mono text-[12px] text-zinc-200 placeholder:text-zinc-700"
            />
          </label>
          <button
            type="button"
            onClick={() => addPtbDual(addSlug)}
            className="h-[40px] rounded-xl border border-zinc-700/55 bg-zinc-950/35 px-4 text-xs font-semibold text-zinc-200 hover:bg-zinc-900/55"
          >
            Add one
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="rounded-2xl border border-zinc-800/60 bg-zinc-950/25 p-2 ring-1 ring-white/[0.02]"
        style={{ minHeight: 520 }}
      >
        {!mounted ? (
          <div className="p-4 text-sm text-zinc-500">Loading workspace…</div>
        ) : floatState.mode === 'grid' ? (
          <ResponsiveGridLayout
            width={width}
            className="layout"
            rowHeight={22}
            cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
            breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 520, xxs: 0 }}
            layouts={layouts}
            dragConfig={{ handle: '.pm-widget-drag' }}
            onLayoutChange={(_layout: Layout, all: ResponsiveLayouts) => setState((st) => ({ ...st, layouts: all }))}
            margin={[10, 10]}
            containerPadding={[10, 10]}
          >
            {widgets.map((w) => {
              if (w.type === 'ptb_dual') {
                return (
                  <div key={w.id} data-grid={{}}>
                    <WidgetFrame
                      title={w.title ?? 'Dual PTB'}
                      subtitle={w.slug}
                      toolbar={
                        <button
                          type="button"
                          onClick={() => onOpenInBook(w.slug)}
                          className="rounded-lg border border-zinc-700/60 bg-zinc-950/30 px-2 py-1 text-[10px] font-semibold text-zinc-300 hover:bg-zinc-900/55"
                          title="Open in Book"
                        >
                          Book
                        </button>
                      }
                      onClose={floatState.mode === 'float' ? () => closeWindow(w.id) : () => removeWidget(w.id)}
                    >
                      <PtbDualWidget slug={w.slug} onOpenInBook={onOpenInBook} />
                    </WidgetFrame>
                  </div>
                );
              }
              if (w.type === 'flow_zones') {
                return (
                  <div key={w.id} data-grid={{}}>
                    <WidgetFrame
                      title={w.title ?? 'Flow Zones'}
                      subtitle="current market"
                      onClose={floatState.mode === 'float' ? () => closeWindow(w.id) : () => removeWidget(w.id)}
                    >
                      <FlowZonesTab
                        market={market}
                        books={books}
                        outcomeLabels={outcomeLabels}
                        flowSeriesForSlug={flowSeriesForSlug}
                        booksFetchedAt={booksFetchedAt}
                        priceToBeatUsd={priceToBeatUsd}
                        endsInMs={endsInMs}
                      />
                    </WidgetFrame>
                  </div>
                );
              }
              return null;
            })}
          </ResponsiveGridLayout>
        ) : (
          <div className="relative w-full overflow-hidden rounded-xl bg-black/15" style={{ height: floatCanvasH }}>
            {widgets.map((w) => {
              const win = floatState.windows[w.id];
              if (!win || !win.open) return null;
              const content =
                w.type === 'ptb_dual' ? (
                  <WidgetFrame
                    title={w.title ?? 'Dual PTB'}
                    subtitle={w.slug}
                    toolbar={
                      <button
                        type="button"
                        onClick={() => onOpenInBook(w.slug)}
                        className="rounded-lg border border-zinc-700/60 bg-zinc-950/30 px-2 py-1 text-[10px] font-semibold text-zinc-300 hover:bg-zinc-900/55"
                        title="Open in Book"
                      >
                        Book
                      </button>
                    }
                    onClose={() => closeWindow(w.id)}
                  >
                    <PtbDualWidget slug={w.slug} onOpenInBook={onOpenInBook} />
                  </WidgetFrame>
                ) : (
                  <WidgetFrame title={w.title ?? 'Flow Zones'} subtitle="current market" onClose={() => closeWindow(w.id)}>
                    <FlowZonesTab
                      market={market}
                      books={books}
                      outcomeLabels={outcomeLabels}
                      flowSeriesForSlug={flowSeriesForSlug}
                      booksFetchedAt={booksFetchedAt}
                      priceToBeatUsd={priceToBeatUsd}
                      endsInMs={endsInMs}
                    />
                  </WidgetFrame>
                );

              return (
                <Rnd
                  key={w.id}
                  bounds="parent"
                  size={{ width: win.w, height: win.h }}
                  position={{ x: win.x, y: win.y }}
                  minWidth={360}
                  minHeight={240}
                  dragHandleClassName="pm-widget-drag"
                  style={{ zIndex: win.z }}
                  onDragStart={() => {
                    bumpRef.current++;
                    setFloatState((fs) => ({
                      ...fs,
                      windows: { ...fs.windows, [w.id]: { ...fs.windows[w.id]!, z: Math.max(fs.windows[w.id]!.z, bumpRef.current) } },
                    }));
                  }}
                  onResizeStart={() => {
                    bumpRef.current++;
                    setFloatState((fs) => ({
                      ...fs,
                      windows: { ...fs.windows, [w.id]: { ...fs.windows[w.id]!, z: Math.max(fs.windows[w.id]!.z, bumpRef.current) } },
                    }));
                  }}
                  onDragStop={(_, d) => {
                    setFloatState((fs) => ({
                      ...fs,
                      windows: { ...fs.windows, [w.id]: { ...fs.windows[w.id]!, x: d.x, y: d.y } },
                    }));
                  }}
                  onResizeStop={(_, __, ref, ___, pos) => {
                    const nw = clamp(ref.offsetWidth, 300, 1600);
                    const nh = clamp(ref.offsetHeight, 220, 1200);
                    setFloatState((fs) => ({
                      ...fs,
                      windows: { ...fs.windows, [w.id]: { ...fs.windows[w.id]!, x: pos.x, y: pos.y, w: nw, h: nh } },
                    }));
                  }}
                >
                  <div style={{ height: '100%', width: '100%', opacity: clamp(win.opacity, 0.35, 1) }}>{content}</div>
                </Rnd>
              );
            })}

            {/* Re-open / hidden list */}
            {hiddenWidgets.length > 0 ? (
              <div className="absolute bottom-2 left-2 right-2 flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800/60 bg-zinc-950/50 px-3 py-2 text-[11px] text-zinc-300 backdrop-blur">
                <span className="text-zinc-500">Hidden:</span>
                {hiddenWidgets.map((w) => (
                    <button
                      key={`reopen-${w.id}`}
                      type="button"
                      onClick={() => showWindow(w.id)}
                      className="rounded-full border border-zinc-700/55 bg-zinc-950/40 px-3 py-1.5 font-mono text-[11px] text-zinc-200 hover:bg-zinc-900/55"
                    >
                      open {w.type === 'ptb_dual' ? (w.slug.length > 16 ? `${w.slug.slice(0, 16)}…` : w.slug) : 'flow'}
                    </button>
                  ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
