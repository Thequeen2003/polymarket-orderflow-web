import type { ApiErr } from './lib/api';
import { clobBook, tradeCreateOrderWithOpts, tradeMarketOrderWithOpts } from './lib/api';
import { slipSellFakLimit01 } from './bracketTrigger';
import { topOfBook } from './bookLevels';
import { roundPrice01 } from './tradingRound';

export function isFakNoMatchMessage(msg: string): boolean {
  return /no orders found|no match|FAK|fully filled|FOK|killed/i.test(msg);
}

/** Live bracket exit: FAK limit at touch, refresh book + retry, then market sell shares. */
export async function submitLiveBracketFakSell(params: {
  token: string;
  marketSlug: string;
  outcome: string;
  lane: 'up' | 'down';
  price01: number;
  sizeShares: number;
  /** Minimum sell price (take level for TP; can be 0 for SL). */
  floor01: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<
  | { ok: true; data: unknown; path: 'fak' | 'fak_retry' | 'market' }
  | { ok: false; error: string; apiErr?: ApiErr }
> {
  const tryFak = async (price01: number, path: 'fak' | 'fak_retry') => {
    const res = await tradeCreateOrderWithOpts(
      {
        token: params.token,
        side: 'sell',
        price: price01,
        size: params.sizeShares,
        orderType: 'FAK',
        signatureType: null,
        marketSlug: params.marketSlug,
        outcome: params.outcome,
        lane: params.lane,
      },
      { signal: params.signal, timeoutMs: params.timeoutMs ?? 25_000 },
    );
    if (res.ok) return { ok: true as const, data: res.data, path };
    const e = res as ApiErr;
    return { ok: false as const, error: e.error, details: e.details, apiErr: e };
  };

  const first = await tryFak(params.price01, 'fak');
  if (first.ok) return first;

  const msg = `${first.error} ${JSON.stringify(first.details ?? '')}`;
  const bookRes = await clobBook(params.token);
  if (!isFakNoMatchMessage(msg)) {
    const bookPayloadEarly = bookRes.ok ? (bookRes.data as { book?: unknown } | null) : null;
    if (bookPayloadEarly?.book) {
      const { bestBid } = topOfBook(bookPayloadEarly.book);
      const bid01 = bestBid != null && bestBid > 0 && bestBid < 1 ? roundPrice01(bestBid) : null;
      if (bid01 != null) {
        const retryPx = slipSellFakLimit01(bid01, params.floor01);
        const retry = await tryFak(retryPx, 'fak_retry');
        if (retry.ok) return retry;
      }
    }
    return { ok: false, error: first.error, apiErr: first.apiErr };
  }

  const bookPayload = bookRes.ok ? (bookRes.data as { book?: unknown } | null) : null;
  if (bookPayload?.book) {
    const { bestBid } = topOfBook(bookPayload.book);
    const bid01 = bestBid != null && bestBid > 0 && bestBid < 1 ? roundPrice01(bestBid) : null;
    if (bid01 != null) {
      const retryPx = slipSellFakLimit01(bid01, params.floor01);
      if (Math.abs(retryPx - params.price01) > 1e-5) {
        const second = await tryFak(retryPx, 'fak_retry');
        if (second.ok) return second;
        if (!isFakNoMatchMessage(`${second.error} ${JSON.stringify(second.details ?? '')}`)) {
          return { ok: false, error: second.error, apiErr: second.apiErr };
        }
      }
    }
  }

  const marketRes = await tradeMarketOrderWithOpts(
    {
      token: params.token,
      side: 'sell',
      amount: params.sizeShares,
      signatureType: null,
      marketSlug: params.marketSlug,
      outcome: params.outcome,
      lane: params.lane,
    },
    { signal: params.signal, timeoutMs: params.timeoutMs ?? 25_000 },
  );
  if (marketRes.ok) return { ok: true, data: marketRes.data, path: 'market' };
  const me = marketRes as ApiErr;
  return { ok: false, error: me.error, apiErr: me };
}
