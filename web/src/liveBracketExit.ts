import type { ApiErr } from './lib/api';
import { clobBook, tradeCreateOrderWithOpts, tradeMarketOrderWithOpts } from './lib/api';
import { slipSellFakLimit01 } from './bracketTrigger';
import { topOfBook } from './bookLevels';
import { roundPrice01 } from './tradingRound';

export function isFakNoMatchMessage(msg: string): boolean {
  return /no orders found|no match|could not match|not enough liquidity|insufficient liquidity|no liquidity|liquidity.*moving|FAK|fully filled|FOK|killed/i.test(msg);
}

export function shouldRetryFakAtBookBid(params: {
  currentBid01: number | null;
  currentPrice01: number;
  floor01: number;
}): { retry: false } | { retry: true; price01: number } {
  const bid01 = params.currentBid01;
  if (bid01 == null || !(bid01 > 0) || bid01 >= 1) return { retry: false };
  if (bid01 < params.floor01 - 1e-9) return { retry: false };
  const price01 = slipSellFakLimit01(bid01, params.floor01);
  if (Math.abs(price01 - params.currentPrice01) <= 1e-5) return { retry: false };
  return { retry: true, price01 };
}

type LiveBracketExitBase = {
  token: string;
  marketSlug: string;
  outcome: string;
  lane: 'up' | 'down';
  sizeShares: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};

/** Market sell immediately — used when SL/TP level is hit and speed matters most. */
export async function submitLiveBracketMarketSell(
  params: LiveBracketExitBase,
): Promise<
  | { ok: true; data: unknown; path: 'market' }
  | { ok: false; error: string; apiErr?: ApiErr }
> {
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

/** Live bracket exit: FAK limit at touch, refresh book + retry, then market sell shares. */
export async function submitLiveBracketFakSell(params: LiveBracketExitBase & {
  price01: number;
  /** Minimum sell price (take level for TP; can be 0 for SL). */
  floor01: number;
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
      const retryAt = shouldRetryFakAtBookBid({
        currentBid01: bid01,
        currentPrice01: params.price01,
        floor01: params.floor01,
      });
      if (retryAt.retry) {
        const retry = await tryFak(retryAt.price01, 'fak_retry');
        if (retry.ok) return retry;
        if (isFakNoMatchMessage(`${retry.error} ${JSON.stringify(retry.details ?? '')}`)) {
          const market = await submitLiveBracketMarketSell(params);
          if (market.ok) return market;
          return {
            ok: false,
            error: `${retry.error} · market_fallback_failed:${market.error}`,
            apiErr: market.apiErr ?? retry.apiErr,
          };
        }
      }
    }
    return { ok: false, error: first.error, apiErr: first.apiErr };
  }

  const bookPayload = bookRes.ok ? (bookRes.data as { book?: unknown } | null) : null;
  if (bookPayload?.book) {
    const { bestBid } = topOfBook(bookPayload.book);
    const bid01 = bestBid != null && bestBid > 0 && bestBid < 1 ? roundPrice01(bestBid) : null;
    const retryAt = shouldRetryFakAtBookBid({
      currentBid01: bid01,
      currentPrice01: params.price01,
      floor01: params.floor01,
    });
    if (retryAt.retry) {
      const second = await tryFak(retryAt.price01, 'fak_retry');
      if (second.ok) return second;
      if (!isFakNoMatchMessage(`${second.error} ${JSON.stringify(second.details ?? '')}`)) {
        return { ok: false, error: second.error, apiErr: second.apiErr };
      }
    }
  }

  const market = await submitLiveBracketMarketSell(params);
  if (market.ok) return market;
  return {
    ok: false,
    error: `${first.error} · market_fallback_failed:${market.error}`,
    apiErr: market.apiErr ?? first.apiErr,
  };
}

/** Bracket exit — `immediate` market sell on trigger; `limit_first` tries FAK then market. */
export async function submitLiveBracketExit(
  params: LiveBracketExitBase & {
    price01: number;
    floor01: number;
    urgency?: 'immediate' | 'limit_first';
  },
): Promise<
  | { ok: true; data: unknown; path: 'fak' | 'fak_retry' | 'market' }
  | { ok: false; error: string; apiErr?: ApiErr }
> {
  if (params.urgency === 'immediate') {
    return submitLiveBracketMarketSell(params);
  }
  return submitLiveBracketFakSell(params);
}
