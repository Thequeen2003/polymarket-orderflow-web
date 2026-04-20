import type { ReactElement } from 'react';
import type { ClobBookEntry } from './lib/api';
import { displayPrice, midPrice, pickBookLevels, spreadWidth } from './bookLevels';
import { resolveUpDownIndices } from './upDown';

/** Best-effort parse of a dollar strike / reference mentioned in copy (Polymarket often hides live “price to beat” in the UI only). */
function tryParseReferencePriceText(market: unknown): string | null {
  if (!market || typeof market !== 'object') return null;
  const o = market as Record<string, unknown>;
  const pieces = [o.groupItemTitle, o.question, o.title, o.description]
    .map((x) => (typeof x === 'string' ? x : ''))
    .join(' ');
  const m = pieces.match(/\$([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  return `$${m[1]!.replace(/,/g, '')}`;
}

export function OrderBookDirectionPanel({
  market,
  books,
  outcomeLabels,
}: {
  market: unknown | null;
  books: ClobBookEntry[] | null;
  outcomeLabels: string[];
}): ReactElement | null {
  if (!books || books.length < 2 || outcomeLabels.length < 2) return null;
  const idx = resolveUpDownIndices(outcomeLabels, market);
  if (!idx) return null;

  const upEntry = books[idx.up];
  const downEntry = books[idx.down];
  if (!upEntry || !downEntry || upEntry.error || downEntry.error) return null;

  const upBook = upEntry.book;
  const downBook = downEntry.book;
  if (!upBook || !downBook) return null;

  const uLv = pickBookLevels(upBook);
  const dLv = pickBookLevels(downBook);
  const hasUp = uLv.asks.length > 0 || uLv.bids.length > 0;
  const hasDown = dLv.asks.length > 0 || dLv.bids.length > 0;
  if (!hasUp && !hasDown) return null;

  const midUp = midPrice(upBook);
  const midDown = midPrice(downBook);
  const refText = tryParseReferencePriceText(market);

  let pUp: number | null = null;
  if (midUp != null && midDown != null) {
    const s = midUp + midDown;
    if (s > 0.05) pUp = midUp / s;
    else pUp = midUp;
  } else if (midUp != null) {
    pUp = midUp;
  }

  let verdict: 'above' | 'below' | 'balanced' | 'unclear' = 'unclear';
  const x = pUp ?? midUp;
  if (x != null && Number.isFinite(x)) {
    if (x > 0.55) verdict = 'above';
    else if (x < 0.45) verdict = 'below';
    else verdict = 'balanced';
  }

  const spU = spreadWidth(upBook);
  const spD = spreadWidth(downBook);
  const wide =
    (spU != null && spU > 0.12) || (spD != null && spD > 0.12)
      ? 'Spreads are wide — treat as a loose hint, not a price target.'
      : (spU != null && spU > 0.06) || (spD != null && spD > 0.06)
        ? 'Moderate spreads — probability is approximate.'
        : null;

  const upName = outcomeLabels[idx.up] ?? 'Up';
  const downName = outcomeLabels[idx.down] ?? 'Down';

  const directionLine =
    verdict === 'above'
      ? `Book leans finishing ABOVE the reference (more demand for “${upName}”).`
      : verdict === 'below'
        ? `Book leans finishing BELOW the reference (more demand for “${downName}”).`
        : verdict === 'balanced'
          ? 'Book is roughly split — no clear lean vs the reference from mids alone.'
          : 'Not enough book shape to call a lean — add liquidity or wait for quotes.';

  return (
    <div className="mt-4 rounded-2xl border border-emerald-500/20 bg-gradient-to-b from-emerald-950/25 to-zinc-950/40 px-4 py-3 ring-1 ring-emerald-500/10">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-300/90">vs price to beat (from the book)</p>
      <p className="mt-1 text-xs leading-relaxed text-zinc-400">
        For Up/Down markets, share <span className="text-zinc-300">≈ probability</span> the window finishes above or below the reference
        Polymarket sets. We infer that from <span className="text-zinc-300">mid prices</span> of each outcome’s CLOB.
      </p>

      <div className="mt-3 grid gap-2 font-mono text-xs text-zinc-300 sm:grid-cols-2">
        <div className="rounded-lg border border-zinc-800/60 bg-black/20 px-2.5 py-2">
          <span className="text-emerald-300/90">{upName}</span>
          <span className="ml-2 text-zinc-100">{midUp != null ? displayPrice(midUp) : '—'}</span>
          <span className="ml-1 text-zinc-500">mid</span>
        </div>
        <div className="rounded-lg border border-zinc-800/60 bg-black/20 px-2.5 py-2">
          <span className="text-sky-300/90">{downName}</span>
          <span className="ml-2 text-zinc-100">{midDown != null ? displayPrice(midDown) : '—'}</span>
          <span className="ml-1 text-zinc-500">mid</span>
        </div>
      </div>

      {pUp != null ? (
        <p className="mt-2 text-sm font-medium text-zinc-100">
          Implied chance “{upName}” (above ref): <span className="text-emerald-200/95">{(pUp * 100).toFixed(1)}%</span>
          {midUp != null && midDown != null ? (
            <span className="ml-2 font-normal text-zinc-500">(normalized from mids)</span>
          ) : (
            <span className="ml-2 font-normal text-amber-200/80">(one side thin — rough)</span>
          )}
        </p>
      ) : (
        <p className="mt-2 text-xs text-amber-200/85">One or both books are empty — can’t build a mid yet.</p>
      )}

      <p className="mt-2 text-sm leading-snug text-zinc-200">{directionLine}</p>

      {refText ? (
        <p className="mt-2 text-xs text-zinc-500">
          Parsed reference/strike from market text: <span className="font-mono text-zinc-400">{refText}</span> — live “price to beat” may differ
          if only shown on polymarket.com.
        </p>
      ) : (
        <p className="mt-2 text-xs text-zinc-500">
          No <span className="font-mono">$</span> strike found in API text; use Up/Down mids as the directional read vs the window’s reference
          shown on the site.
        </p>
      )}

      {wide ? <p className="mt-2 text-[11px] text-amber-200/85">{wide}</p> : null}

      <p className="mt-2 text-[10px] leading-snug text-zinc-600">
        Educational — not a prediction or trading advice. Resolution rules are on Polymarket.
      </p>
    </div>
  );
}
