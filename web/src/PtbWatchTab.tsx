import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { clobBooks, marketsGet, priceToBeat, type ApiErr, type ApiOk, type ClobBookEntry } from './lib/api';
import { midPrice } from './bookLevels';
import { PtbDualProbabilityChart } from './PtbDualProbabilityChart';
import type { SpotPoint } from './SpotLevelChart';
import { resolveUpDownIndices } from './upDown';
import type { SeriesPoint } from './MomentumChart';

function isOk<T>(res: ApiOk<T> | ApiErr): res is ApiOk<T> {
  return (res as ApiOk<T>).ok === true && 'data' in (res as ApiOk<T>);
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

function WatchCard(props: {
  slug: string;
  onRemove: () => void;
  onOpenInBook: (slug: string) => void;
}): ReactElement {
  const { slug, onRemove, onOpenInBook } = props;
  const [marketJson, setMarketJson] = useState<unknown | null>(null);
  const [books, setBooks] = useState<ClobBookEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ssrPtb, setSsrPtb] = useState<number | null>(null);
  const [lastUpdateMs, setLastUpdateMs] = useState<number | null>(null);
  const [seriesByToken, setSeriesByToken] = useState<Record<string, SeriesPoint[]>>({});

  const tokenIds = useMemo(() => pickTokenIds(marketJson), [marketJson]);
  const outcomeLabels = useMemo(() => pickOutcomeLabels(marketJson), [marketJson]);

  const idx = useMemo(() => resolveUpDownIndices(outcomeLabels, marketJson), [marketJson, outcomeLabels]);

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

  const upLabel = idx ? (outcomeLabels[idx.up] ?? 'UP') : 'UP';
  const downLabel = idx ? (outcomeLabels[idx.down] ?? 'DOWN') : 'DOWN';

  const bookUp = idx && books ? books[idx.up]?.book ?? {} : {};
  const bookDown = idx && books ? books[idx.down]?.book ?? {} : {};

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

  return (
    <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35 p-4 ring-1 ring-white/[0.02]">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-zinc-800/50 pb-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-zinc-100">{q || slug}</div>
          <div className="mt-1 truncate font-mono text-[11px] text-zinc-500">{slug}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => onOpenInBook(slug)}
            className="rounded-lg border border-zinc-700/50 bg-zinc-900/35 px-3 py-1.5 text-[11px] font-semibold text-zinc-200 hover:bg-zinc-900/55"
          >
            Open
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded-lg border border-rose-800/40 bg-rose-950/20 px-3 py-1.5 text-[11px] font-semibold text-rose-100 hover:bg-rose-950/35"
          >
            Remove
          </button>
        </div>
      </div>

      {err ? <div className="mt-3 rounded-xl border border-amber-800/30 bg-amber-950/15 px-3 py-2 text-xs text-amber-100/90">{err}</div> : null}

      <div className="mt-3">
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
        />
      </div>
    </div>
  );
}

export function PtbWatchTab(props: {
  watchedSlugs: string[];
  onChangeWatchedSlugs: (next: string[]) => void;
  recentSlugs: string[];
  currentSlug: string;
  onOpenInBook: (slug: string) => void;
}): ReactElement {
  const { watchedSlugs, onChangeWatchedSlugs, recentSlugs, currentSlug, onOpenInBook } = props;
  const MAX = 6;

  const add = (slug: string) => {
    const s = slug.trim();
    if (!s) return;
    if (watchedSlugs.includes(s)) return;
    if (watchedSlugs.length >= MAX) {
      onChangeWatchedSlugs([...watchedSlugs.slice(1), s]);
      return;
    }
    onChangeWatchedSlugs([...watchedSlugs, s]);
  };

  const chips = recentSlugs.filter((s) => s && s !== currentSlug && !watchedSlugs.includes(s)).slice(0, 10);

  return (
    <div className="mt-5 space-y-4">
      <div className="rounded-2xl border border-zinc-800/60 bg-zinc-900/20 p-4 ring-1 ring-white/[0.02]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-zinc-100">PTB watchlist</div>
            <div className="mt-1 text-xs leading-relaxed text-zinc-500">
              One-tap adds (no typing). Each card polls its own books every <span className="font-mono text-zinc-400">5s</span>. Max{' '}
              <span className="font-mono text-zinc-400">{MAX}</span> markets.
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!currentSlug}
              onClick={() => add(currentSlug)}
              className="rounded-xl border border-emerald-700/45 bg-emerald-950/25 px-4 py-2 text-xs font-semibold text-emerald-100 hover:bg-emerald-950/40 disabled:opacity-40"
            >
              + Add current
            </button>
            <button
              type="button"
              onClick={() => onChangeWatchedSlugs([])}
              className="rounded-xl border border-zinc-700/50 bg-zinc-950/30 px-4 py-2 text-xs font-semibold text-zinc-200 hover:bg-zinc-900/50"
            >
              Clear all
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {chips.length === 0 ? <div className="text-xs text-zinc-600">Open a few markets first — they’ll appear here as quick-add chips.</div> : null}
          {chips.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="rounded-full border border-zinc-700/55 bg-zinc-950/35 px-3 py-1.5 font-mono text-[11px] text-zinc-200 hover:bg-zinc-900/55"
            >
              + {s}
            </button>
          ))}
        </div>
      </div>

      {watchedSlugs.length === 0 ? (
        <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35 p-6 text-center text-sm text-zinc-400">
          Nothing on the watchlist yet. Tap <span className="text-zinc-200">+ Add current</span> or a recent chip.
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {watchedSlugs.map((s) => (
            <WatchCard
              key={s}
              slug={s}
              onRemove={() => onChangeWatchedSlugs(watchedSlugs.filter((x) => x !== s))}
              onOpenInBook={onOpenInBook}
            />
          ))}
        </div>
      )}
    </div>
  );
}
