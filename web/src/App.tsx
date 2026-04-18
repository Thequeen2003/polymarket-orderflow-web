import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { clobBooks, health, marketsGet, marketsList, marketsSearch, type ApiErr, type ApiOk } from './lib/api';
import type { ClobBookEntry } from './lib/api';

function pretty(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function isOk<T>(res: ApiOk<T> | ApiErr): res is ApiOk<T> {
  return (res as ApiOk<T>).ok === true && 'data' in (res as ApiOk<T>);
}

function shortToken(id: string) {
  if (id.length <= 24) return id;
  return `${id.slice(0, 12)}…${id.slice(-8)}`;
}

function pickTokenIds(market: unknown): string[] {
  if (!market || typeof market !== 'object') return [];
  const anyMarket = market as Record<string, unknown>;
  const ids = anyMarket.clob_token_ids;
  if (Array.isArray(ids)) return ids.map(String).filter(Boolean);
  if (typeof ids === 'string') return ids.split(',').map((s) => s.trim()).filter(Boolean);
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

type BookLevel = { price: number; size: number };

function pickBookLevels(book: unknown): { bids: BookLevel[]; asks: BookLevel[] } {
  if (!book || typeof book !== 'object') return { bids: [], asks: [] };
  const anyBook = book as Record<string, unknown>;
  const bidsRaw = Array.isArray(anyBook.bids) ? anyBook.bids : [];
  const asksRaw = Array.isArray(anyBook.asks) ? anyBook.asks : [];
  const toLevel = (v: unknown): BookLevel | null => {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const price = Number(o.price ?? o.rate ?? o.value);
    const size = Number(o.size ?? o.shares ?? o.amount ?? o.quantity);
    if (!Number.isFinite(price) || !Number.isFinite(size)) return null;
    return { price, size };
  };
  const bids = bidsRaw.map(toLevel).filter((x): x is BookLevel => x !== null).sort((a, b) => b.price - a.price);
  const asks = asksRaw.map(toLevel).filter((x): x is BookLevel => x !== null).sort((a, b) => a.price - b.price);
  return {
    bids: bids.slice(0, 36),
    asks: asks.slice(0, 36),
  };
}

function BookSide({
  title,
  levels,
  tone,
}: {
  title: string;
  levels: BookLevel[];
  tone: 'ask' | 'bid';
}): ReactElement {
  const empty = levels.length === 0;
  return (
    <div className="rounded-xl border border-zinc-900 bg-zinc-950/50 p-3">
      <div className={`text-sm font-medium ${tone === 'ask' ? 'text-emerald-200' : 'text-sky-200'}`}>{title}</div>
      <div className="mt-2 space-y-1 text-xs">
        {empty ? (
          <div className="text-zinc-500">No levels yet.</div>
        ) : (
          levels.map((l, i) => (
            <div key={`${tone}-${i}`} className="flex items-center justify-between rounded bg-zinc-900/40 px-2 py-1">
              <span className="font-mono text-zinc-200">{l.price}</span>
              <span className="font-mono text-zinc-400">{l.size}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function App() {
  const [apiHealth, setApiHealth] = useState<string>('Checking API…');
  const [q, setQ] = useState('');
  const [markets, setMarkets] = useState<unknown[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string>('');
  const [marketJson, setMarketJson] = useState<unknown | null>(null);
  const [books, setBooks] = useState<ClobBookEntry[] | null>(null);
  const [booksLoading, setBooksLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tokenIds = useMemo(() => pickTokenIds(marketJson), [marketJson]);
  const outcomeLabels = useMemo(() => pickOutcomeLabels(marketJson), [marketJson]);

  const loadBooks = useCallback(async (ids: string[]) => {
    if (ids.length === 0) {
      setBooks(null);
      return;
    }
    setBooksLoading(true);
    setError(null);
    const res = await clobBooks(ids);
    setBooksLoading(false);
    if (isOk(res)) setBooks(res.data);
    else setError(pretty(res));
  }, []);

  useEffect(() => {
    void (async () => {
      const h = await health();
      if (isOk(h)) setApiHealth(h.data.polymarket ? `API OK — ${h.data.polymarket}` : 'API OK (polymarket binary not found or empty)');
      else setApiHealth(`API error: ${h.error}`);

      const list = await marketsList(25);
      if (isOk(list)) setMarkets(list.data);
    })();
  }, []);

  useEffect(() => {
    if (tokenIds.length === 0) {
      setBooks(null);
      return;
    }
    void loadBooks(tokenIds);
  }, [tokenIds, loadBooks]);

  async function runSearch() {
    setError(null);
    const term = q.trim();
    if (!term) {
      const list = await marketsList(25);
      if (isOk(list)) setMarkets(list.data);
      else setError(list.error);
      return;
    }
    const res = await marketsSearch(term, 25);
    if (isOk(res)) setMarkets(res.data);
    else setError(res.error);
  }

  async function loadMarket(slug: string) {
    setSelectedSlug(slug);
    setError(null);
    setMarketJson(null);
    setBooks(null);
    if (!slug) return;
    const res = await marketsGet(slug);
    if (isOk(res)) setMarketJson(res.data);
    else setError(pretty(res));
  }

  return (
    <div className="min-h-full bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-xl font-semibold tracking-tight">Polymarket Order Flow (Live)</h1>
            <div className="text-xs text-zinc-400">{apiHealth}</div>
          </div>
          <p className="text-sm text-zinc-400">
            Standalone app: Vite UI proxies to a local API on port <span className="font-mono">8787</span>, which shells out to the
            official <code className="rounded bg-zinc-900 px-1.5 py-0.5">polymarket</code> CLI. Run{' '}
            <code className="rounded bg-zinc-900 px-1.5 py-0.5">npm run dev</code> from the repo root.
          </p>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-zinc-800 bg-zinc-950/30 p-4">
            <div className="flex items-center gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch();
                }}
                placeholder="Search markets (e.g. election, bitcoin)…"
                className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm outline-none focus:border-fuchsia-400"
              />
              <button
                type="button"
                onClick={() => void runSearch()}
                className="rounded-lg bg-fuchsia-500 px-3 py-2 text-sm font-medium text-black hover:bg-fuchsia-400"
              >
                Search
              </button>
            </div>

            <div className="mt-3 text-xs text-zinc-400">Pick a market to load CLOB books for each token id.</div>
            <div className="mt-3 max-h-[60vh] overflow-auto rounded-lg border border-zinc-900">
              {markets.length === 0 ? (
                <div className="p-3 text-sm text-zinc-500">No results yet.</div>
              ) : (
                <ul className="divide-y divide-zinc-900">
                  {markets.map((m, idx) => {
                    const obj = m && typeof m === 'object' ? (m as Record<string, unknown>) : null;
                    const slug = String(obj?.slug ?? obj?.id ?? obj?.question ?? idx);
                    const label = String(obj?.question ?? obj?.title ?? obj?.slug ?? obj?.id ?? `Market ${idx + 1}`);
                    return (
                      <li key={`${slug}-${idx}`}>
                        <button
                          type="button"
                          className={`w-full px-3 py-2 text-left text-sm hover:bg-zinc-900/60 ${selectedSlug === slug ? 'bg-zinc-900/50' : ''}`}
                          onClick={() => void loadMarket(slug)}
                        >
                          <div className="truncate text-zinc-100">{label}</div>
                          <div className="truncate text-xs text-zinc-500">{slug}</div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-950/30 p-4 lg:col-span-2">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-sm font-medium">Market</div>
              <div className="text-xs text-zinc-500">{selectedSlug || '—'}</div>
              {booksLoading ? <div className="text-xs text-fuchsia-300">Loading books…</div> : null}
            </div>

            {tokenIds.length === 0 ? (
              <div className="mt-3 text-sm text-zinc-500">Select a market to load token ids and order books.</div>
            ) : null}

            {error ? (
              <pre className="mt-4 overflow-auto rounded-lg border border-red-900/50 bg-red-950/20 p-3 text-xs text-red-200">{error}</pre>
            ) : null}

            {books && books.length > 0 ? (
              <div className="mt-4 space-y-6">
                {books.map((entry, idx) => {
                  const label = outcomeLabels[idx] ?? `Outcome ${idx + 1}`;
                  const parsed = pickBookLevels(entry.book);
                  return (
                    <div key={entry.token} className="rounded-xl border border-zinc-800 bg-zinc-950/20 p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <div className="text-sm font-medium text-zinc-200">{label}</div>
                        <div className="font-mono text-[11px] text-zinc-500">{shortToken(entry.token)}</div>
                      </div>
                      {entry.error ? (
                        <div className="mt-2 rounded border border-amber-900/40 bg-amber-950/20 p-2 text-xs text-amber-200">{entry.error}</div>
                      ) : null}
                      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                        <BookSide title="Buyable (asks)" levels={parsed.asks} tone="ask" />
                        <BookSide title="Sellable (bids)" levels={parsed.bids} tone="bid" />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : tokenIds.length > 0 && !booksLoading && !error ? (
              <div className="mt-4 text-sm text-zinc-500">No book payload yet.</div>
            ) : null}

            <details className="mt-6 rounded-xl border border-zinc-900 bg-zinc-950/50 p-3">
              <summary className="cursor-pointer text-sm text-zinc-300">Raw JSON</summary>
              <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs text-zinc-500">Market</div>
                  <pre className="max-h-[40vh] overflow-auto rounded-lg border border-zinc-900 bg-black/20 p-3 text-xs text-zinc-200">
                    {marketJson ? pretty(marketJson) : '—'}
                  </pre>
                </div>
                <div>
                  <div className="mb-1 text-xs text-zinc-500">Books</div>
                  <pre className="max-h-[40vh] overflow-auto rounded-lg border border-zinc-900 bg-black/20 p-3 text-xs text-zinc-200">
                    {books ? pretty(books) : '—'}
                  </pre>
                </div>
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
