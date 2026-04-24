import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clobBooks, marketsGet, marketsUpdownShortcut, recentTrades, type ApiOk, type ClobBookEntry, type DataTradeRow } from './lib/api';
import { midPrice } from './bookLevels';
import {
  DEFAULT_PAPER_CONFIG,
  type PaperEvent,
  type PaperOrder,
  type PaperOpenPosition,
  type PaperPersistedV1,
  loadPaperState,
  pushEvents,
  savePaperState,
  stepPaperMarketWithOrders,
  tapeLean,
} from './smartMoneyPaperEngine';
import { SIX_PACK_ROWS, type SixPackKey, labelForSixPackKey, tradingSlugFromLiveShortcut } from './sixPackUpdownSlugs';
import { resolveUpDownIndices } from './upDown';

const LS_ENABLED = 'bp_paper_smart_money_enabled.v1';
const RING_MAX = 32;

function isOk<T>(x: unknown): x is ApiOk<T> {
  return typeof x === 'object' && x !== null && (x as ApiOk<T>).ok === true && 'data' in (x as object);
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

function pickConditionId(m: unknown): string | null {
  if (!m || typeof m !== 'object') return null;
  const id = (m as Record<string, unknown>).conditionId;
  return typeof id === 'string' && id.startsWith('0x') ? id : null;
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

function endsInFromMarket(m: unknown): number | null {
  if (!m || typeof m !== 'object') return null;
  const endRaw = (m as Record<string, unknown>).endDate;
  if (typeof endRaw === 'string') {
    const t = Date.parse(endRaw);
    if (Number.isFinite(t)) return t - Date.now();
  }
  return null;
}

export type SmartMoneyRowDisplay = {
  key: SixPackKey;
  label: string;
  slug: string;
  upMid: number | null;
  downMid: number | null;
  tapeDiff: number;
  lean: 'up' | 'down' | null;
  upNet: number;
  downNet: number;
  pos: PaperOpenPosition | null;
  openOrders: PaperOrder[];
  refHigh: number | null;
  endsInMs: number | null;
  err: string | null;
};

function readEnabled(): boolean {
  try {
    return localStorage.getItem(LS_ENABLED) === '1';
  } catch {
    return false;
  }
}

function writeEnabled(v: boolean) {
  try {
    localStorage.setItem(LS_ENABLED, v ? '1' : '0');
  } catch {
    /* ignore */
  }
}

type Ring = { up: (number | null)[]; down: (number | null)[] };

/**
 * Shadow poll + paper bot for all six up/down slugs. Does not touch the main `selectedSlug` / book state.
 */
export function useSmartMoneyPaperBot(): {
  enabled: boolean;
  setEnabled: (v: boolean) => void;
  rows: SmartMoneyRowDisplay[];
  eventTail: PaperEvent[];
  lastTickAt: number | null;
  globalErr: string | null;
} {
  const [enabled, setEnabledState] = useState(false);
  const [slugs, setSlugs] = useState<Partial<Record<SixPackKey, string>>>({});
  const [rowSnap, setRowSnap] = useState<Partial<Record<SixPackKey, SmartMoneyRowDisplay>>>({});
  const [persist, setPersist] = useState<PaperPersistedV1>(() => loadPaperState());
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);
  const [globalErr, setGlobalErr] = useState<string | null>(null);

  const ringRef = useRef<Record<string, Ring>>({});
  const mounted = useRef(true);
  const slugsRef = useRef(slugs);
  slugsRef.current = slugs;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      setEnabledState(readEnabled());
      setPersist(loadPaperState());
    });
  }, []);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    writeEnabled(v);
  }, []);

  const resolveSlugsOnce = useCallback(async () => {
    if (!enabled) return;
    const next: Partial<Record<SixPackKey, string>> = { ...slugsRef.current };
    for (const row of SIX_PACK_ROWS) {
      const r = await marketsUpdownShortcut(row.asset, row.interval);
      if (isOk(r)) {
        next[row.key] = tradingSlugFromLiveShortcut(r.data.slug, row.interval);
      }
    }
    if (mounted.current) {
      setSlugs(next);
      slugsRef.current = next;
    }
  }, [enabled]);

  const runFullTick = useCallback(async () => {
    if (!enabled) return;
    if (!mounted.current) return;
    setGlobalErr(null);
    const now = Date.now();
    const cfg = DEFAULT_PAPER_CONFIG;

    const currentSlugs = { ...slugsRef.current };
    for (const row of SIX_PACK_ROWS) {
      if (!currentSlugs[row.key]?.trim()) {
        const r = await marketsUpdownShortcut(row.asset, row.interval);
        if (isOk(r)) currentSlugs[row.key] = tradingSlugFromLiveShortcut(r.data.slug, row.interval);
      }
    }
    if (mounted.current) {
      setSlugs(currentSlugs);
      slugsRef.current = currentSlugs;
    }

    type Meta = {
      key: SixPackKey;
      slug: string;
      upTok: string;
      downTok: string;
      conditionId: string;
      endsInMs: number | null;
    };
    const metas: Meta[] = [];
    let p = loadPaperState();

    for (const row of SIX_PACK_ROWS) {
      const slug = (currentSlugs[row.key] ?? '').trim();
      if (!slug) {
        p = {
          ...p,
          byKey: {
            ...p.byKey,
            [row.key]: {
              lastSlug: p.byKey[row.key]?.lastSlug ?? '',
              pos: p.byKey[row.key]?.pos ?? null,
              orders: p.byKey[row.key]?.orders ?? [],
            },
          },
        };
        continue;
      }
      const mRes = await marketsGet(slug);
      if (!isOk(mRes)) continue;
      const market = mRes.data;
      const labels = pickOutcomeLabels(market);
      const toks = pickTokenIds(market);
      const idx = resolveUpDownIndices(labels, market);
      const cond = pickConditionId(market);
      if (!idx || toks.length < 2 || !cond) continue;
      const upTok = toks[idx.up] ?? '';
      const downTok = toks[idx.down] ?? '';
      if (!upTok || !downTok) continue;
      metas.push({ key: row.key, slug, upTok, downTok, conditionId: cond, endsInMs: endsInFromMarket(market) });
    }

    const allTokens: string[] = [];
    for (const m of metas) {
      allTokens.push(m.upTok, m.downTok);
    }
    const uniqueTokens = [...new Set(allTokens)];
    const bookByToken: Record<string, ClobBookEntry> = {};
    if (uniqueTokens.length > 0) {
      const bRes = await clobBooks(uniqueTokens);
      if (isOk(bRes)) {
        for (const e of bRes.data) {
          bookByToken[e.token] = e;
        }
      } else if (mounted.current) {
        setGlobalErr('CLOB books request failed (paper layer)');
      }
    }

    const tradeByKey: Record<string, DataTradeRow[]> = {};
    for (const m of metas) {
      const tRes = await recentTrades({ market: m.conditionId, limit: 80 });
      tradeByKey[m.key] = isOk(tRes) && Array.isArray(tRes.data) ? tRes.data : [];
    }

    const nextSnap: Partial<Record<SixPackKey, SmartMoneyRowDisplay>> = {};

    for (const m of metas) {
      const upE = bookByToken[m.upTok];
      const downE = bookByToken[m.downTok];
      const upBook = upE && !upE.error ? upE.book : null;
      const downBook = downE && !downE.error ? downE.book : null;
      const upMid = upBook ? midPrice(upBook) : null;
      const downMid = downBook ? midPrice(downBook) : null;

      const ring = ringRef.current[m.key] ?? { up: [], down: [] };
      if (upMid != null) ring.up = [...ring.up, upMid].slice(-RING_MAX);
      if (downMid != null) ring.down = [...ring.down, downMid].slice(-RING_MAX);
      ringRef.current[m.key] = ring;

      const rowsAll = tradeByKey[m.key] ?? [];
      const upRows = rowsAll.filter((r) => r.asset === m.upTok);
      const downRows = rowsAll.filter((r) => r.asset === m.downTok);
      const { lean, upNet, downNet, diff } = tapeLean(upRows, downRows, cfg.minTapeSkew);
      const refUp = (() => {
        const a = ring.up;
        let best: number | null = null;
        for (const x of a.slice(-cfg.refMidWindow)) {
          if (x == null || !Number.isFinite(x)) continue;
          if (best == null || x > best) best = x;
        }
        return best;
      })();
      const refDn = (() => {
        const a = ring.down;
        let best: number | null = null;
        for (const x of a.slice(-cfg.refMidWindow)) {
          if (x == null || !Number.isFinite(x)) continue;
          if (best == null || x > best) best = x;
        }
        return best;
      })();
      const refShow = lean === 'down' ? refDn : refUp;

      const lastSlug = p.byKey[m.key]?.lastSlug ?? null;
      const posIn = p.byKey[m.key]?.pos ?? null;
      const ordersIn = p.byKey[m.key]?.orders ?? [];
      const step = stepPaperMarketWithOrders({
        now,
        key: m.key,
        slug: m.slug,
        lastSlug,
        upBook: upBook ?? { bids: [], asks: [] },
        downBook: downBook ?? { bids: [], asks: [] },
        upTokenId: m.upTok,
        downTokenId: m.downTok,
        upMid,
        downMid,
        upMidHistory: ring.up,
        downMidHistory: ring.down,
        upRows,
        downRows,
        endsInMs: m.endsInMs,
        pos: posIn,
        orders: ordersIn,
        cfg,
      });
      p = {
        v: 1,
        byKey: { ...p.byKey, [m.key]: { lastSlug: step.nextLastSlug, pos: step.nextPos, orders: step.nextOrders } },
        eventTail: pushEvents(p.eventTail, step.events),
      };

      nextSnap[m.key] = {
        key: m.key,
        label: labelForSixPackKey(m.key),
        slug: m.slug,
        upMid,
        downMid,
        tapeDiff: diff,
        lean,
        upNet,
        downNet,
        pos: step.nextPos,
        openOrders: step.nextOrders,
        refHigh: refShow,
        endsInMs: m.endsInMs,
        err: null,
      };
    }

    for (const row of SIX_PACK_ROWS) {
      if (nextSnap[row.key]) continue;
      const slug = (currentSlugs[row.key] ?? '—').trim() || '—';
      const pk = p.byKey[row.key];
      nextSnap[row.key] = {
        key: row.key,
        label: labelForSixPackKey(row.key),
        slug,
        upMid: null,
        downMid: null,
        tapeDiff: 0,
        lean: null,
        upNet: 0,
        downNet: 0,
        pos: pk?.pos ?? null,
        openOrders: pk?.orders ?? [],
        refHigh: null,
        endsInMs: null,
        err: slug === '—' ? 'resolving slug…' : 'waiting for data',
      };
    }

    savePaperState(p);
    if (mounted.current) {
      setPersist(p);
      setRowSnap(nextSnap);
      setLastTickAt(now);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    void runFullTick();
    const a = window.setInterval(() => void runFullTick(), 10_000);
    return () => window.clearInterval(a);
  }, [enabled, runFullTick]);

  useEffect(() => {
    if (!enabled) return;
    void resolveSlugsOnce();
    const a = window.setInterval(() => void resolveSlugsOnce(), 20_000);
    return () => window.clearInterval(a);
  }, [enabled, resolveSlugsOnce]);

  const rows = useMemo((): SmartMoneyRowDisplay[] => {
    return SIX_PACK_ROWS.map((r) => {
      return (
        rowSnap[r.key] ?? {
          key: r.key,
          label: labelForSixPackKey(r.key),
          slug: slugs[r.key] && slugs[r.key]!.trim() ? slugs[r.key]! : '—',
          upMid: null,
          downMid: null,
          tapeDiff: 0,
          lean: null,
          upNet: 0,
          downNet: 0,
          pos: persist.byKey[r.key]?.pos ?? null,
          openOrders: persist.byKey[r.key]?.orders ?? [],
          refHigh: null,
          endsInMs: null,
          err: null,
        }
      );
    });
  }, [rowSnap, slugs, persist]);

  return {
    enabled,
    setEnabled,
    rows,
    eventTail: persist.eventTail,
    lastTickAt,
    globalErr,
  };
}
