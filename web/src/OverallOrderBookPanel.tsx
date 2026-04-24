import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { displayPrice, pickBookLevels, topOfBook } from './bookLevels';

function fmtK(x: number): string {
  if (!Number.isFinite(x)) return '—';
  if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(2)}M`;
  if (x >= 1_000) return `${(x / 1_000).toFixed(2)}k`;
  return x.toFixed(0);
}

export function OverallOrderBookPanel(props: {
  title?: string;
  book: unknown;
  lastUpdateMs: number | null;
  maxLevels?: number;
  /** Optional: clicking a level can prefill the trade panel via a window event. */
  prefillLane?: 'up' | 'down';
}): ReactElement {
  const { title = 'Order Book', book, lastUpdateMs, maxLevels = 12, prefillLane } = props;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const stale = lastUpdateMs == null || now - lastUpdateMs > 20_000;
  const { asks, bids } = useMemo(() => pickBookLevels(book), [book]);
  const top = useMemo(() => topOfBook(book), [book]);
  const bestBid = top.bestBid;
  const bestAsk = top.bestAsk;
  const spread = bestBid != null && bestAsk != null && bestAsk >= bestBid ? bestAsk - bestBid : null;

  const asksTop = asks.slice(0, maxLevels);
  const bidsTop = bids.slice(0, maxLevels);
  const maxAsk = Math.max(1, ...asksTop.map((l) => (Number.isFinite(l.size) ? l.size : 0)));
  const maxBid = Math.max(1, ...bidsTop.map((l) => (Number.isFinite(l.size) ? l.size : 0)));

  const insights = useMemo(() => {
    const wallAsk = asksTop.reduce<{ price: number; size: number } | null>((best, l) => {
      if (!Number.isFinite(l.size)) return best;
      if (!best || l.size > best.size) return { price: l.price, size: l.size };
      return best;
    }, null);
    const wallBid = bidsTop.reduce<{ price: number; size: number } | null>((best, l) => {
      if (!Number.isFinite(l.size)) return best;
      if (!best || l.size > best.size) return { price: l.price, size: l.size };
      return best;
    }, null);
    const thinAsk =
      asksTop.length === 0
        ? null
        : asksTop.filter((l) => l.size <= maxAsk * 0.18).length >= Math.max(3, Math.floor(maxLevels * 0.45));
    const thinBid =
      bidsTop.length === 0
        ? null
        : bidsTop.filter((l) => l.size <= maxBid * 0.18).length >= Math.max(3, Math.floor(maxLevels * 0.45));
    return { wallAsk, wallBid, thinAsk, thinBid };
  }, [asksTop, bidsTop, maxAsk, maxBid, maxLevels]);

  const askShapeLabel =
    insights.thinAsk === null ? 'no ladder' : insights.thinAsk ? 'thin zone' : 'stacked depth';
  const bidShapeLabel =
    insights.thinBid === null ? 'no ladder' : insights.thinBid ? 'thin zone' : 'stacked depth';

  const Row = (p: { price: number; size: number; tone: 'ask' | 'bid'; max: number }) => {
    const w = Math.max(0, Math.min(1, p.size / p.max));
    const isAsk = p.tone === 'ask';
    const bar = isAsk ? 'bg-rose-700/35' : 'bg-emerald-700/35';
    const px = isAsk ? 'text-rose-200' : 'text-emerald-200';
    const wall = isAsk ? insights.wallAsk?.price === p.price : insights.wallBid?.price === p.price;
    const thin = p.size <= p.max * 0.18;
    const canPrefill = prefillLane != null;
    return (
      <div
        role={canPrefill ? 'button' : undefined}
        tabIndex={canPrefill ? 0 : undefined}
        onClick={() => {
          if (!canPrefill) return;
          const priceCents = Math.round(p.price * 1000) / 10; // keep 0.1¢ precision (matches other UI)
          window.dispatchEvent(
            new CustomEvent('bpx-trade-prefill', {
              detail: {
                lane: prefillLane,
                tone: p.tone,
                price01: p.price,
                priceCents,
              },
            }),
          );
        }}
        onKeyDown={(e) => {
          if (!canPrefill) return;
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          const priceCents = Math.round(p.price * 1000) / 10;
          window.dispatchEvent(
            new CustomEvent('bpx-trade-prefill', {
              detail: {
                lane: prefillLane,
                tone: p.tone,
                price01: p.price,
                priceCents,
              },
            }),
          );
        }}
        className={`relative grid grid-cols-[72px_1fr_72px] items-center gap-2 px-3 py-1.5 font-mono text-[11px] outline-none ${
          wall ? 'bg-amber-950/15' : thin ? 'bg-zinc-900/15' : ''
        } ${canPrefill ? 'cursor-pointer transition-colors hover:bg-white/[0.03] focus-visible:ring-2 focus-visible:ring-indigo-500/25' : ''}`}
      >
        <div className={`tabular-nums ${px}`}>
          {displayPrice(p.price)} {wall ? <span className="ml-1 text-[10px] font-bold text-amber-200">WALL</span> : thin ? <span className="ml-1 text-[10px] text-zinc-500">thin</span> : null}
        </div>
        <div className="relative h-4 overflow-hidden rounded bg-zinc-900/40">
          <div className={`absolute inset-y-0 right-0 ${bar}`} style={{ width: `${(w * 100).toFixed(1)}%` }} />
          <div className="relative px-2 text-right tabular-nums text-zinc-300">{fmtK(p.size)}</div>
        </div>
        <div className="text-right tabular-nums text-zinc-500">${fmtK(p.price * p.size)}</div>
      </div>
    );
  };

  return (
    <div className="rounded-2xl border border-zinc-800/60 bg-zinc-950/35 shadow-inner shadow-black/20 ring-1 ring-white/[0.02]">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800/60 px-4 py-3">
        <div className="text-[13px] font-semibold tracking-tight text-zinc-100">{title}</div>
        <div className="flex items-center gap-3 text-[11px] text-zinc-500">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${stale ? 'bg-zinc-700' : 'bg-emerald-400'}`} />
            <span>{stale ? 'Stale' : 'Live'}</span>
          </div>
          <div className="font-mono">
            Spread: <span className="text-zinc-300">{spread != null ? `${Math.round(spread * 100)}¢` : '—'}</span>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/40 bg-black/10 px-4 py-2 text-[10px] text-zinc-400">
        <div className="flex flex-wrap gap-2">
          <span
            className={`rounded-full border px-2 py-0.5 font-mono ${
              insights.thinAsk === null
                ? 'border-zinc-800/50 bg-zinc-950/30 text-zinc-600'
                : insights.thinAsk
                  ? 'border-violet-700/40 bg-violet-950/20 text-violet-200'
                  : 'border-zinc-800/50 bg-zinc-950/30 text-zinc-400'
            }`}
          >
            asks: {askShapeLabel}
          </span>
          <span
            className={`rounded-full border px-2 py-0.5 font-mono ${
              insights.thinBid === null
                ? 'border-zinc-800/50 bg-zinc-950/30 text-zinc-600'
                : insights.thinBid
                  ? 'border-violet-700/40 bg-violet-950/20 text-violet-200'
                  : 'border-zinc-800/50 bg-zinc-950/30 text-zinc-400'
            }`}
          >
            bids: {bidShapeLabel}
          </span>
        </div>
        <div className="font-mono text-zinc-500">
          {insights.wallAsk ? (
            <span>
              wall ask <span className="text-amber-200">{displayPrice(insights.wallAsk.price)}</span>
            </span>
          ) : null}
          {insights.wallBid ? (
            <span className="ml-3">
              wall bid <span className="text-amber-200">{displayPrice(insights.wallBid.price)}</span>
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-[72px_1fr_72px] gap-2 border-b border-zinc-800/50 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        <span>Price</span>
        <span className="text-center">Shares</span>
        <span className="text-right">Total</span>
      </div>

      <div className="divide-y divide-zinc-800/25">
        {asksTop.map((l, i) => (
          <Row key={`a-${l.price}-${i}`} price={l.price} size={l.size} tone="ask" max={maxAsk} />
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 border-y border-zinc-800/60 bg-zinc-900/25 px-3 py-2 font-mono text-[11px] text-zinc-400">
        <span>Last: {bestBid != null && bestAsk != null ? displayPrice((bestBid + bestAsk) / 2) : bestBid != null ? displayPrice(bestBid) : bestAsk != null ? displayPrice(bestAsk) : '—'}</span>
        <span>Spread: {spread != null ? `${Math.round(spread * 100)}¢` : '—'}</span>
      </div>

      <div className="divide-y divide-zinc-800/25">
        {bidsTop.map((l, i) => (
          <Row key={`b-${l.price}-${i}`} price={l.price} size={l.size} tone="bid" max={maxBid} />
        ))}
      </div>
    </div>
  );
}

