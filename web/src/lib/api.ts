export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: string; details?: unknown; raw?: string };

export async function postJson<T>(path: string, body: unknown): Promise<ApiOk<T> | ApiErr> {
  let text = '';
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    text = await res.text();
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!res.ok) return (parsed as ApiErr) ?? { ok: false, error: `http_${res.status}` };
      return parsed as ApiOk<T>;
    } catch {
      return { ok: false, error: `bad_json_http_${res.status}`, raw: text.slice(0, 4000) };
    }
  } catch (e) {
    return { ok: false, error: 'fetch_failed', details: String(e) };
  }
}

async function getJson<T>(path: string): Promise<ApiOk<T> | ApiErr> {
  let text = '';
  try {
    const res = await fetch(path, { headers: { accept: 'application/json' } });
    text = await res.text();
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!res.ok) return (parsed as ApiErr) ?? { ok: false, error: `http_${res.status}` };
      return parsed as ApiOk<T>;
    } catch {
      return { ok: false, error: `bad_json_http_${res.status}`, raw: text.slice(0, 4000) };
    }
  } catch (e) {
    return { ok: false, error: 'fetch_failed', details: String(e) };
  }
}

export function health() {
  return getJson<{
    polymarket: string | null;
    note: string;
    gamma_reachable?: boolean;
    assistant_available?: boolean;
    assistant_provider?: string | null;
    assistant_model?: string | null;
  }>('/api/health');
}

export function marketsList(limit = 20) {
  return getJson<unknown[]>(`/api/markets?limit=${encodeURIComponent(String(limit))}`);
}

export function marketsSearch(q: string, limit = 20) {
  return getJson<unknown[]>(`/api/markets/search?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(limit))}`);
}

export type UpdownShortcutAsset = 'btc' | 'eth' | 'sol';
export type UpdownInterval = '5m' | '15m';

export function marketsUpdownShortcut(asset: UpdownShortcutAsset, interval: UpdownInterval = '5m') {
  return getJson<{
    slug: string;
    asset: string;
    interval?: string;
    window: string;
    tested?: boolean;
    active?: boolean;
    closed?: boolean;
    start?: string | null;
    end?: string | null;
  }>(
    `/api/markets/updown-shortcut?asset=${encodeURIComponent(asset)}&interval=${encodeURIComponent(interval)}`,
  );
}

export function marketsGet(slugOrId: string) {
  return getJson<unknown>(`/api/markets/get/${encodeURIComponent(slugOrId)}`);
}

export function priceToBeat(slugOrId: string) {
  return getJson<{ slug: string; price_to_beat: number; source: string }>(`/api/price-to-beat/${encodeURIComponent(slugOrId)}`);
}

export function rtdsCrypto(symbol: 'btc/usd' | 'eth/usd' | 'sol/usd') {
  return getJson<{ symbol: string; value: number; ts: number; receivedAt: number; source: string }>(
    `/api/rtds/crypto?symbol=${encodeURIComponent(symbol)}`,
  );
}

export function clobBook(tokenId: string) {
  return getJson<unknown>(`/api/clob/book/${encodeURIComponent(tokenId)}`);
}

export type ClobBookEntry = { token: string; book: unknown; error: string | null };

export function clobBooks(tokenIds: string[]) {
  const q = tokenIds.join(',');
  return getJson<ClobBookEntry[]>(`/api/clob/books?tokens=${encodeURIComponent(q)}`);
}

export type DataTradeRow = {
  timestamp: number;
  side: string;
  price: number | null;
  size: number | null;
  outcome: string | null;
  asset: string;
  transactionHash: string | null;
  pseudonym: string | null;
};

/** Polymarket Data API (public) — prints for a market condition. Optional `asset` = CLOB token id to filter one outcome. */
export function recentTrades(params: { market: string; limit?: number; asset?: string }) {
  const q = new URLSearchParams();
  q.set('market', params.market);
  if (params.limit != null) q.set('limit', String(params.limit));
  if (params.asset) q.set('asset', params.asset);
  return getJson<DataTradeRow[]>(`/api/data/recent-trades?${q.toString()}`);
}

export function lastTradePrice(tokenId: string) {
  return getJson<{ price: string; side: string }>(
    `/api/clob/last-trade-price?token_id=${encodeURIComponent(tokenId)}`,
  );
}

export function assistantChat(body: {
  messages: { role: 'user' | 'assistant'; content: string }[];
  context?: string;
  /** Server clamps 64–1024; lower = faster / cheaper (default ~480 if omitted). */
  max_tokens?: number;
}) {
  return postJson<{ message: string }>('/api/assistant/chat', body);
}

export function tradeMarketOrder(body: { token: string; side: 'buy' | 'sell'; amount: number; signatureType?: string | null }) {
  return postJson<unknown>('/api/trade/market-order', body);
}

export function tradeCreateOrder(body: {
  token: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  signatureType?: string | null;
}) {
  return postJson<unknown>('/api/trade/create-order', body);
}

/** CLOB cached balance (USDC for buys, outcome shares for sells). */
export function tradeBalanceAllowance(params: { tokenId?: string; assetType: 'collateral' | 'conditional' }) {
  const q = new URLSearchParams();
  q.set('asset_type', params.assetType);
  if (params.tokenId) q.set('token_id', params.tokenId);
  return getJson<{ balance: string; allowance: string }>(`/api/trade/balance-allowance?${q.toString()}`);
}

/** Refresh on-chain balance view before Max / after deposits (matches Polymarket CLOB flow). */
export function tradeUpdateBalanceAllowance(body: { tokenId?: string; assetType: 'collateral' | 'conditional' }) {
  return postJson<{ updated: boolean }>('/api/trade/update-balance-allowance', {
    token_id: body.tokenId ?? '',
    asset_type: body.assetType,
  });
}

export function tradeAvgEntry(tokenId: string) {
  return getJson<{ tokenId: string; avgEntry: number | null; shares: number }>(`/api/trade/avg-entry?token_id=${encodeURIComponent(tokenId)}`);
}

