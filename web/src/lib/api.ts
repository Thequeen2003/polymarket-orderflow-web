import { roundPriceCentTick } from '../tradingRound';

export type ApiOk<T> = { ok: true; data: T };
export type ApiErr = { ok: false; error: string; details?: unknown; raw?: string };

/** Snap limit prices to 1¢ ticks before Bullpen/CLOB (avoids 0.545-style rejections). */
function normalizeLimitPrice01(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return price;
  return roundPriceCentTick(price);
}

type JsonOpts = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

type JsonRetryOpts = JsonOpts & {
  retries?: number;
  retryDelayMs?: number;
};

function fetchFailureCause(e: unknown, timedOut: boolean): 'timeout' | 'aborted' | 'network' {
  if (timedOut) return 'timeout';
  if (e instanceof Error && e.name === 'AbortError') return 'aborted';
  return 'network';
}

function isRetryableFetchFailure(err: ApiErr): boolean {
  if (err.error !== 'fetch_failed') return false;
  const d = err.details as { cause?: string; name?: string; message?: string } | undefined;
  if (d?.cause === 'timeout' || d?.cause === 'network' || d?.cause === 'aborted') return true;
  if (d?.name === 'AbortError') return true;
  const msg = String(d?.message ?? '').toLowerCase();
  return msg.includes('failed to fetch') || msg.includes('network') || msg.includes('econnrefused');
}

/** Transient upstream failures (Gamma warming up, brief 502s) — safe to retry market loads. */
export function isRetryableApiErr(err: ApiErr): boolean {
  if (
    err.error === 'market_get_failed' ||
    err.error === 'markets_failed' ||
    err.error === 'search_failed' ||
    err.error === 'updown_shortcut_failed' ||
    err.error === 'price_to_beat_failed' ||
    err.error === 'bad_gateway'
  ) {
    return true;
  }
  if (err.error.startsWith('http_502') || err.error.startsWith('http_503') || err.error.startsWith('http_504')) {
    return true;
  }
  return isRetryableFetchFailure(err);
}

function devFetchHint(mixedContent: boolean, cause: 'timeout' | 'aborted' | 'network'): string {
  if (mixedContent) {
    return 'This looks like mixed-content (HTTPS page trying to call an HTTP API). Use an HTTPS API URL or serve the web app over HTTP for local dev.';
  }
  if (cause === 'timeout') {
    return 'The API took too long — check the api terminal for stalls (Bullpen CLI / CLOB). Retry or hard-refresh.';
  }
  if (cause === 'aborted') {
    return 'Request was cancelled (tab refresh, HMR, or a new market load). Hard-refresh if books stay empty.';
  }
  return 'Start the API on port 8787 (`npm run dev` from repo root — web waits for `/api/health`), then hard-refresh. Or set `VITE_API_BASE=http://127.0.0.1:8787` in `web/.env.development`.';
}

async function getJsonWithRetry<T>(path: string, opts?: JsonRetryOpts): Promise<ApiOk<T> | ApiErr> {
  const retries = Math.max(0, opts?.retries ?? 0);
  const delay = opts?.retryDelayMs ?? 400;
  let last: ApiOk<T> | ApiErr = { ok: false, error: 'fetch_failed' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await getJson<T>(path, opts);
    if (last.ok || !isRetryableApiErr(last)) return last;
    if (attempt < retries) await new Promise((r) => setTimeout(r, delay * (attempt + 1)));
  }
  return last;
}

function localhostApiBase(): string | null {
  try {
    const loc = window.location;
    const isLocalhost =
      loc.hostname === 'localhost' ||
      loc.hostname === '127.0.0.1' ||
      loc.hostname === '0.0.0.0' ||
      loc.hostname === '::1';
    if (!isLocalhost) return null;
    const port = String(import.meta.env.VITE_API_PORT ?? '8787').trim() || '8787';
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

/** When set (e.g. `http://127.0.0.1:8787`), all `/api/...` calls go there. */
function apiBase(): string {
  const raw = import.meta.env.VITE_API_BASE;
  if (typeof raw === 'string') {
    const v = raw.trim().replace(/\/+$/, '');
    if (v) return v;
  }
  // Local dev: same-origin `/api` via Vite proxy (one connection pool; avoids starving direct :8787).
  if (import.meta.env.DEV) return '';
  const previewLocal = localhostApiBase();
  if (previewLocal) return previewLocal;
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
  let timedOut = false;
  const t =
    timeoutMs && controller
      ? window.setTimeout(() => {
          timedOut = true;
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
    const cause = fetchFailureCause(e, timedOut);
    const message =
      cause === 'timeout' && timeoutMs
        ? `Request timed out after ${timeoutMs}ms`
        : e instanceof Error
          ? e.message
          : String(e);
    return {
      ok: false,
      error: 'fetch_failed',
      details: {
        message,
        name: e instanceof Error ? e.name : typeof e,
        cause,
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
        hint: devFetchHint(mixedContent, cause),
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
  return getJsonWithRetry<{
    polymarket: string | null;
    note: string;
    gamma_reachable?: boolean;
    trading_ready?: boolean;
    trading_live_orders_via?: 'bullpen' | 'clob';
    enable_live_trading?: boolean;
    live_trading_confirmed?: boolean;
    clob_config_ready?: boolean;
    trading_backend?: string | null;
    assistant_available?: boolean;
    assistant_provider?: string | null;
    assistant_model?: string | null;
  }>('/api/health', { timeoutMs: 15_000, retries: 2, retryDelayMs: 400 });
}

/** Live Polymarket HTTP reachability (Gamma + CLOB + Data) via our API proxy. */
export type PolymarketLiveStatus = {
  checkedAt: string;
  bases: {
    documentation: string;
    gamma: string;
    clob: string;
    data: string;
    web: string;
    bridge: string;
  };
  services: {
    name: 'gamma' | 'clob' | 'data';
    url: string;
    ok: boolean;
    status: number | null;
    latencyMs: number;
    note: string | null;
  }[];
  allPublicOk: boolean;
};

export function polymarketLiveStatus() {
  return getJson<PolymarketLiveStatus>('/api/polymarket/live/status', { timeoutMs: 20_000 });
}

/** Gamma market JSON (always live HTTP — no CLI fallback on this route). */
export function polymarketLiveMarket(slugOrId: string) {
  return getJson<{ slug: string; market: unknown; source: 'gamma_live' }>(
    `/api/polymarket/live/market/${encodeURIComponent(slugOrId)}`,
  );
}

export function polymarketLiveClobBook(tokenId: string) {
  const q = new URLSearchParams();
  q.set('token_id', tokenId);
  return getJson<{ token_id: string; book: unknown; source: 'clob_live' }>(
    `/api/polymarket/live/clob/book?${q.toString()}`,
  );
}

export function marketsList(limit = 20) {
  return getJsonWithRetry<unknown[]>(`/api/markets?limit=${encodeURIComponent(String(limit))}`, {
    timeoutMs: 12_000,
    retries: 2,
    retryDelayMs: 450,
  });
}

export function marketsSearch(q: string, limit = 20) {
  return getJsonWithRetry<unknown[]>(
    `/api/markets/search?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(String(limit))}`,
    { timeoutMs: 12_000, retries: 2, retryDelayMs: 450 },
  );
}

export type UpdownShortcutAsset = 'btc' | 'eth' | 'sol' | 'hype';
export type UpdownInterval = '5m' | '15m' | '1h' | '4h' | '1d';

export type AgentSnapshotData = {
  schema: string;
  generatedAtMs: number;
  query: { asset: UpdownShortcutAsset; interval: UpdownInterval };
  window?: { remainingMs?: number | null };
  market: { slug: string };
  underlying?: {
    spotVsPtbUsd?: number | null;
    spot?: { history?: { usd: number }[] };
  };
  outcomes?: {
    up?: { lane: 'up'; impliedMid: number | null; recentTrades?: { price: number; side: string }[] };
    down?: { lane: 'down'; impliedMid: number | null; recentTrades?: { price: number; side: string }[] };
  };
};

export function agentSnapshot(asset: UpdownShortcutAsset, interval: UpdownInterval = '15m') {
  const q = new URLSearchParams({ asset, interval });
  return getJsonWithRetry<AgentSnapshotData>(`/api/agent/snapshot?${q.toString()}`, {
    timeoutMs: 28_000,
    retries: 2,
    retryDelayMs: 600,
  });
}

export function marketsUpdownShortcut(asset: UpdownShortcutAsset, interval: UpdownInterval = '5m') {
  return getJsonWithRetry<{
    slug: string;
    asset: string;
    interval?: string;
    window: string;
    tested?: boolean;
    active?: boolean;
    closed?: boolean;
    start?: string | null;
    end?: string | null;
    /** Window open (unix seconds), aligned to market resolution — use for titled non-`btc-updown-*` slugs. */
    inferred_window_start_unix?: number;
    inferred_end_unix?: number;
    /** US/Eastern grid floor used for 1h/4h/1d shortcut search (may differ from UTC `bucket_floor_unix`). */
    bucket_floor_et_unix?: number;
    /** Slug to load in the UI — for 5m, prior bucket when its CLOB book is live, else `slug`. */
    trading_slug?: string;
    /** Gamma market payload when shortcut already resolved it — skips a second `/api/markets/get`. */
    market?: unknown;
  }>(`/api/markets/updown-shortcut?asset=${encodeURIComponent(asset)}&interval=${encodeURIComponent(interval)}`, {
    timeoutMs: 35_000,
    retries: 3,
    retryDelayMs: 700,
  });
}

export type SportsLeagueId = 'mlb' | 'nba' | 'nfl' | 'nhl' | 'epl' | 'ucl' | 'mls' | 'cfb' | 'cbb' | 'wnba' | 'ufc' | 'atp' | 'wta';

export type SportsShortcutPayload = {
  slug: string;
  league: string;
  question: string | null;
  gameStartTime: string | null;
  market?: unknown;
};

export type SportsLiveRow = SportsShortcutPayload & {
  endDate?: string | null;
  volume24hr?: number;
  active?: boolean;
  closed?: boolean;
};

export function marketsSportsShortcut(league: SportsLeagueId) {
  return getJsonWithRetry<SportsShortcutPayload>(
    `/api/markets/sports-shortcut?league=${encodeURIComponent(league)}`,
    { timeoutMs: 35_000, retries: 3, retryDelayMs: 700 },
  );
}

export function marketsSportsLive(league?: SportsLeagueId, limit = 16) {
  const q = new URLSearchParams();
  if (league) q.set('league', league);
  q.set('limit', String(limit));
  return getJsonWithRetry<SportsLiveRow[]>(`/api/markets/sports-live?${q.toString()}`, {
    timeoutMs: 35_000,
    retries: 2,
    retryDelayMs: 600,
  });
}

export async function marketsGet(slugOrId: string) {
  const path = `/api/markets/get/${encodeURIComponent(slugOrId)}`;
  return getJsonWithRetry<unknown>(path, { timeoutMs: 14_000, retries: 3, retryDelayMs: 500 });
}

export function priceToBeat(slugOrId: string) {
  return getJsonWithRetry<{
    slug: string;
    price_to_beat: number;
    source: string;
    preview?: boolean;
    opens_at_ms?: number;
  }>(
    `/api/price-to-beat/${encodeURIComponent(slugOrId)}`,
    { timeoutMs: 12_000, retries: 1, retryDelayMs: 400 },
  );
}

export type RtdsCryptoPoint = { t: number; v: number; src?: 'chainlink' | 'binance' };

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
  return getJsonWithRetry<ClobBookEntry[]>(`/api/clob/books?tokens=${encodeURIComponent(q)}`, {
    timeoutMs: 28_000,
    retries: 2,
    retryDelayMs: 650,
  });
}

export type BinanceDepthRow = { price: number; size: number };

export type BinanceDepthData = {
  symbol: string;
  lastUpdateId: number | null;
  bids: BinanceDepthRow[];
  asks: BinanceDepthRow[];
};

export function binanceDepth(symbol: string, limit = 100) {
  const q = new URLSearchParams();
  q.set('symbol', symbol);
  q.set('limit', String(limit));
  return getJson<BinanceDepthData>(`/api/binance/depth?${q.toString()}`);
}

export type BinanceAggTrade = { id: number; time: number; price: number; qty: number; buyerMaker: boolean };

export function binanceAggTrades(symbol: string, limit = 80) {
  const q = new URLSearchParams();
  q.set('symbol', symbol);
  q.set('limit', String(limit));
  return getJson<BinanceAggTrade[]>(`/api/binance/agg-trades?${q.toString()}`);
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
    lane?: 'up' | 'down';
  },
  opts?: JsonOpts,
) {
  return postJsonWithOpts<unknown>(
    '/api/trade/market-order',
    { ...body, market_slug: body.marketSlug ?? '', outcome: body.outcome ?? '', lane: body.lane },
    opts,
  );
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
  return postJson<unknown>('/api/trade/create-order', {
    ...body,
    price: normalizeLimitPrice01(body.price),
    market_slug: body.marketSlug ?? '',
    outcome: body.outcome ?? '',
  });
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
    /** Desk lane — API uses this + token to pick the Bullpen Up/Down outcome. */
    lane?: 'up' | 'down';
  },
  opts?: JsonOpts,
) {
  return postJsonWithOpts<unknown>(
    '/api/trade/create-order',
    {
      ...body,
      price: normalizeLimitPrice01(body.price),
      order_type: body.orderType ?? 'GTC',
      market_slug: body.marketSlug ?? '',
      outcome: body.outcome ?? '',
      lane: body.lane,
    },
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
export function tradeOrderFillIndex(params: { tokenId: string; force?: boolean }, opts?: JsonOpts) {
  const q = new URLSearchParams();
  q.set('token_id', params.tokenId);
  if (params.force) q.set('force', '1');
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

