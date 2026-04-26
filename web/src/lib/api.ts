export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: string; details?: unknown; raw?: string };

type JsonOpts = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

/** When set (e.g. `http://127.0.0.1:8787`), all `/api/...` calls go there — needed for `vite preview` or web-only dev without the Vite proxy. */
function apiBase(): string {
  const raw = import.meta.env.VITE_API_BASE;
  if (typeof raw === 'string') {
    const v = raw.trim().replace(/\/+$/, '');
    if (v) return v;
  }
  // Vite dev uses the proxy (same-origin `/api/*`) to avoid CORS; preview/static hosting does not.
  // When running a production build on localhost, default to the local API port so fetch works without extra env setup.
  try {
    const loc = window.location;
    const isLocalhost =
      loc.hostname === 'localhost' ||
      loc.hostname === '127.0.0.1' ||
      loc.hostname === '0.0.0.0' ||
      loc.hostname === '::1';
    if (isLocalhost && import.meta.env.PROD) return 'http://127.0.0.1:8787';
  } catch {
    /* ignore */
  }
  return '';
}

function apiUrl(path: string): string {
  const base = apiBase();
  const p = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${p}` : p;
}

export function apiWsUrl(path: string): string {
  const base = apiBase();
  const p = path.startsWith('/') ? path : `/${path}`;
  if (base) {
    const u = new URL(base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = p;
    u.search = '';
    u.hash = '';
    return u.toString();
  }
  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}${p}`;
}

function parseJsonBody(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    return { ok: false };
  }
}

/** 502/503 from proxy or crash often return HTML/plain text — surface a useful ApiErr instead of `bad_json_http_*`. */
function apiErrFromNonJsonResponse(res: Response, text: string): ApiErr {
  const status = res.status;
  const preview = (text.trim().slice(0, 280) || '(empty body)').replace(/\s+/g, ' ');
  const gateway = status === 502 || status === 503 || status === 504;
  return {
    ok: false,
    error: gateway ? 'bad_gateway' : `http_${status}_non_json`,
    details: {
      httpStatus: status,
      hint: gateway
        ? 'The trade API did not return JSON (server down, proxy error, or crash). From the repo root run `npm run dev -w api` so it listens on port 8787, or set VITE_API_BASE to your API URL for preview/production.'
        : 'The server returned a non-JSON response.',
      bodyPreview: preview,
    },
    raw: text.slice(0, 4000),
  };
}

function interpretParsedJson<T>(res: Response, parsed: unknown): ApiOk<T> | ApiErr {
  if (!res.ok) return (parsed as ApiErr) ?? { ok: false, error: `http_${res.status}` };
  if (parsed && typeof parsed === 'object' && 'ok' in parsed && (parsed as { ok: unknown }).ok === false) {
    return parsed as ApiErr;
  }
  return parsed as ApiOk<T>;
}

export async function postJson<T>(path: string, body: unknown): Promise<ApiOk<T> | ApiErr> {
  let text = '';
  try {
    const url = apiUrl(path);
    const res = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    text = await res.text();
    const parsedWrap = parseJsonBody(text);
    if (!parsedWrap.ok) return apiErrFromNonJsonResponse(res, text);
    return interpretParsedJson<T>(res, parsedWrap.value);
  } catch (e) {
    const url = apiUrl(path);
    let mixedContent = false;
    try {
      mixedContent = window.location.protocol === 'https:' && url.startsWith('http://');
    } catch {
      mixedContent = false;
    }
    return {
      ok: false,
      error: 'fetch_failed',
      details: {
        message: e instanceof Error ? e.message : String(e),
        name: e instanceof Error ? e.name : typeof e,
        url,
        apiBase: apiBase() || null,
        origin: (() => {
          try {
            return window.location.origin;
          } catch {
            return null;
          }
        })(),
        hint: mixedContent
          ? 'This looks like mixed-content (HTTPS page trying to call an HTTP API). Use an HTTPS API URL or serve the web app over HTTP for local dev.'
          : 'If you are on `npm run dev -w web`, make sure the API is running on :8787 (root `npm run dev` starts both). If you are on `vite preview`, set `VITE_API_BASE=http://127.0.0.1:8787` (or let preview default handle localhost).',
      },
    };
  }
}

async function getJson<T>(path: string, opts?: JsonOpts): Promise<ApiOk<T> | ApiErr> {
  let text = '';
  const timeoutMs = opts?.timeoutMs;
  const controller = timeoutMs ? new AbortController() : null;
  const t =
    timeoutMs && controller
      ? window.setTimeout(() => {
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
        }, timeoutMs)
      : null;
  try {
    const url = apiUrl(path);
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: opts?.signal ?? controller?.signal,
    });
    text = await res.text();
    const parsedWrap = parseJsonBody(text);
    if (!parsedWrap.ok) return apiErrFromNonJsonResponse(res, text);
    return interpretParsedJson<T>(res, parsedWrap.value);
  } catch (e) {
    const url = apiUrl(path);
    let mixedContent = false;
    try {
      mixedContent = window.location.protocol === 'https:' && url.startsWith('http://');
    } catch {
      mixedContent = false;
    }
    return {
      ok: false,
      error: 'fetch_failed',
      details: {
        message: e instanceof Error ? e.message : String(e),
        name: e instanceof Error ? e.name : typeof e,
        url,
        apiBase: apiBase() || null,
        origin: (() => {
          try {
            return window.location.origin;
          } catch {
            return null;
          }
        })(),
        timeoutMs: timeoutMs ?? null,
        hint: mixedContent
          ? 'This looks like mixed-content (HTTPS page trying to call an HTTP API). Use an HTTPS API URL or serve the web app over HTTP for local dev.'
          : 'If the web app is not running via the Vite dev server proxy, set `VITE_API_BASE` to your API URL (e.g. http://127.0.0.1:8787) and ensure the API is running.',
      },
    };
  } finally {
    if (t != null) window.clearTimeout(t);
  }
}

export async function postJsonWithOpts<T>(path: string, body: unknown, opts?: JsonOpts): Promise<ApiOk<T> | ApiErr> {
  let text = '';
  const timeoutMs = opts?.timeoutMs;
  const controller = timeoutMs ? new AbortController() : null;
  const t =
    timeoutMs && controller
      ? window.setTimeout(() => {
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
        }, timeoutMs)
      : null;
  try {
    const url = apiUrl(path);
    const res = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts?.signal ?? controller?.signal,
    });
    text = await res.text();
    const parsedWrap = parseJsonBody(text);
    if (!parsedWrap.ok) return apiErrFromNonJsonResponse(res, text);
    return interpretParsedJson<T>(res, parsedWrap.value);
  } catch (e) {
    const url = apiUrl(path);
    let mixedContent = false;
    try {
      mixedContent = window.location.protocol === 'https:' && url.startsWith('http://');
    } catch {
      mixedContent = false;
    }
    return {
      ok: false,
      error: 'fetch_failed',
      details: {
        message: e instanceof Error ? e.message : String(e),
        name: e instanceof Error ? e.name : typeof e,
        url,
        apiBase: apiBase() || null,
        origin: (() => {
          try {
            return window.location.origin;
          } catch {
            return null;
          }
        })(),
        timeoutMs: timeoutMs ?? null,
        hint: mixedContent
          ? 'This looks like mixed-content (HTTPS page trying to call an HTTP API). Use an HTTPS API URL or serve the web app over HTTP for local dev.'
          : 'If you are using `vite preview`, set `VITE_API_BASE=http://127.0.0.1:8787` (localhost preview also defaults there now). Otherwise, ensure the dev proxy is active or the API is reachable.',
      },
    };
  } finally {
    if (t != null) window.clearTimeout(t);
  }
}

export function health() {
  return getJson<{
    polymarket: string | null;
    note: string;
    gamma_reachable?: boolean;
    trading_ready?: boolean;
    trading_backend?: string | null;
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
export type UpdownInterval = '5m' | '15m' | '1h' | '4h' | '1d';

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

export type RtdsCryptoPoint = { t: number; v: number };

/** Latest underlying from Polymarket RTDS (Chainlink primary on WS; server may label Binance fallback). */
export function rtdsCrypto(symbol: string) {
  return getJson<{
    symbol: string;
    value: number;
    ts: number;
    receivedAt: number;
    source: string;
    /** Server-side Chainlink history (hydrates chart on load). */
    history?: RtdsCryptoPoint[];
  }>(`/api/rtds/crypto?symbol=${encodeURIComponent(symbol)}`);
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

export function tradeMarketOrder(body: {
  token: string;
  side: 'buy' | 'sell';
  amount: number;
  signatureType?: string | null;
  marketSlug?: string;
  outcome?: string;
}) {
  return postJson<unknown>('/api/trade/market-order', body);
}

export function tradeMarketOrderWithOpts(
  body: {
    token: string;
    side: 'buy' | 'sell';
    amount: number;
    signatureType?: string | null;
    marketSlug?: string;
    outcome?: string;
  },
  opts?: JsonOpts,
) {
  return postJsonWithOpts<unknown>('/api/trade/market-order', { ...body, market_slug: body.marketSlug ?? '', outcome: body.outcome ?? '' }, opts);
}

export function tradeCreateOrder(body: {
  token: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  signatureType?: string | null;
  marketSlug?: string;
  outcome?: string;
}) {
  return postJson<unknown>('/api/trade/create-order', { ...body, market_slug: body.marketSlug ?? '', outcome: body.outcome ?? '' });
}

export function tradeCreateOrderWithOpts(
  body: {
    token: string;
    side: 'buy' | 'sell';
    price: number;
    size: number;
    orderType?: 'GTC' | 'FAK';
    signatureType?: string | null;
    marketSlug?: string;
    outcome?: string;
  },
  opts?: JsonOpts,
) {
  return postJsonWithOpts<unknown>(
    '/api/trade/create-order',
    { ...body, order_type: body.orderType ?? 'GTC', market_slug: body.marketSlug ?? '', outcome: body.outcome ?? '' },
    opts,
  );
}

/** CLOB cached balance (USDC for buys, outcome shares for sells). */
export function tradeBalanceAllowance(params: {
  tokenId?: string;
  assetType: 'collateral' | 'conditional';
  marketSlug?: string;
  outcome?: string;
}) {
  const q = new URLSearchParams();
  q.set('asset_type', params.assetType);
  if (params.tokenId) q.set('token_id', params.tokenId);
  if (params.marketSlug) q.set('market_slug', params.marketSlug);
  if (params.outcome) q.set('outcome', params.outcome);
  return getJson<{ balance: string; allowance: string }>(`/api/trade/balance-allowance?${q.toString()}`);
}

/** Refresh on-chain balance view before Max / after deposits (matches Polymarket CLOB flow). */
export function tradeUpdateBalanceAllowance(body: { tokenId?: string; assetType: 'collateral' | 'conditional' }) {
  return postJson<{ updated: boolean }>('/api/trade/update-balance-allowance', {
    token_id: body.tokenId ?? '',
    asset_type: body.assetType,
  });
}

export function tradeAvgEntry(params: { tokenId: string; marketSlug?: string; outcome?: string }) {
  const q = new URLSearchParams();
  q.set('token_id', params.tokenId);
  if (params.marketSlug) q.set('market_slug', params.marketSlug);
  if (params.outcome) q.set('outcome', params.outcome);
  return getJson<{ tokenId: string; avgEntry: number | null; shares: number }>(`/api/trade/avg-entry?${q.toString()}`);
}

export function tradeGetOrder(orderId: string, opts?: JsonOpts) {
  return getJson<unknown>(`/api/trade/order?order_id=${encodeURIComponent(orderId)}`, opts);
}

/** CLOB trades tape keyed by order id — same source as Polymarket fills; used to reconcile local history. */
export function tradeOrderFillIndex(params: { tokenId: string }, opts?: JsonOpts) {
  const q = new URLSearchParams();
  q.set('token_id', params.tokenId);
  return getJson<{
    token_id: string;
    by_order_id: Record<string, { shares: number; avg_price_01: number; side: string; updated_at_ms: number }>;
  }>(`/api/trade/order-fill-index?${q.toString()}`, opts);
}

export function tradeOpenOrders(params?: { tokenId?: string }) {
  const q = new URLSearchParams();
  if (params?.tokenId) q.set('token_id', params.tokenId);
  const suffix = q.toString();
  return getJson<{ token_id: string | null; orders: unknown[] }>(`/api/trade/open-orders${suffix ? `?${suffix}` : ''}`);
}

export type MyFillRow = {
  token_id: string;
  order_id: string;
  side: 'buy' | 'sell';
  price_01: number;
  shares: number;
  match_time_ms: number;
  role: 'taker' | 'maker';
};

export function tradeMyFills(params: { tokenId: string; limit?: number }, opts?: JsonOpts) {
  const q = new URLSearchParams();
  q.set('token_id', params.tokenId);
  if (params.limit != null) q.set('limit', String(params.limit));
  return getJson<{ token_id: string; fills: MyFillRow[] }>(`/api/trade/my-fills?${q.toString()}`, opts);
}

export function tradeCancelOrder(orderId: string) {
  return postJson<{ cancelled: boolean; order_id: string }>('/api/trade/cancel-order', { order_id: orderId });
}

/** Kill switch — cancels every open order for the authenticated trader. */
export function tradeCancelAllOrders() {
  return postJson<unknown>('/api/trade/cancel-all', { confirm: true });
}

