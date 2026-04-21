import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import express from 'express';
import { AssetType, COLLATERAL_TOKEN_DECIMALS, CONDITIONAL_TOKEN_DECIMALS, OrderType, Side } from '@polymarket/clob-client';
import { getTradingClient, getTradingConfigFromEnv } from './polymarketTrading.js';

// Load env: monorepo root `.env` first, then `api/.env` (overrides) so keys work from either location.
{
  const here = fileURLToPath(import.meta.url);
  const apiRoot = resolve(here, '..', '..'); // api/src/server.ts -> api/
  const repoRoot = resolve(apiRoot, '..');
  dotenv.config({ path: resolve(repoRoot, '.env') });
  dotenv.config({ path: resolve(apiRoot, '.env'), override: true });
}

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const POLYMARKET_WEB = 'https://polymarket.com';

type CliResult =
  | { ok: true; stdout: string }
  | { ok: false; stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null };

function runCli(args: string[], opts?: { timeoutMs?: number }): Promise<CliResult> {
  const bin = process.env.POLYMARKET_BIN || 'polymarket';
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    const timeoutId = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      stdout += String(buf);
    });
    child.stderr.on('data', (buf) => {
      stderr += String(buf);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeoutId);
      if (code === 0) resolve({ ok: true, stdout });
      else resolve({ ok: false, stdout, stderr, code, signal });
    });
    child.on('error', (err) => {
      clearTimeout(timeoutId);
      resolve({ ok: false, stdout: '', stderr: err instanceof Error ? err.message : String(err), code: null, signal: null });
    });
  });
}

async function httpGetJson(url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await r.text();
  if (!r.ok) throw new Error(`http_${r.status}: ${text.slice(0, 240)}`);
  return JSON.parse(text) as unknown;
}

async function httpGetJsonWithHeaders(url: string, headers?: Record<string, string>): Promise<unknown> {
  const r = await fetch(url, { headers: { accept: 'application/json', ...(headers ?? {}) } });
  const text = await r.text();
  if (!r.ok) throw new Error(`http_${r.status}: ${text.slice(0, 240)}`);
  return JSON.parse(text) as unknown;
}

/** Accept raw slug or full `polymarket.com/event/...` / `.../market/...` URLs from users pasting links. */
function normalizeMarketLookupRef(raw: string): string {
  const s = decodeURIComponent(raw).trim();
  if (!s) return '';
  if (!/polymarket\.com/i.test(s)) return s;
  try {
    const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withProto);
    const parts = u.pathname.split('/').filter(Boolean);
    const keyIdx = parts.findIndex((p) => /^(event|events|market|markets)$/i.test(p));
    if (keyIdx !== -1 && parts[keyIdx + 1]) return decodeURIComponent(parts[keyIdx + 1]!);
    const last = parts[parts.length - 1];
    return last ? decodeURIComponent(last) : s;
  } catch {
    return s;
  }
}

function json(res: express.Response, status: number, body: unknown) {
  res.status(status);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

/** `polymarket -o json markets …` should be a JSON array; normalize if a future CLI wraps it. */
function marketsArrayFromStdout(stdout: string): unknown[] {
  const trimmed = stdout.trim().replace(/^\uFEFF/, '');
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    for (const key of ['markets', 'data', 'items', 'results'] as const) {
      const inner = o[key];
      if (Array.isArray(inner)) return inner;
    }
  }
  return [];
}

function parseClobTokenIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return [];
    if (t.startsWith('[')) {
      try {
        const p = JSON.parse(t) as unknown;
        if (Array.isArray(p)) return p.map(String).filter(Boolean);
      } catch {
        /* fall through */
      }
    }
    return t
      .split(',')
      .map((s) => s.replace(/^["'\s]+|["'\s]+$/g, '').trim())
      .filter(Boolean);
  }
  return [];
}

/** Gamma often returns `clobTokenIds` as a JSON string; normalize for the web client. */
function normalizeMarket(m: unknown): unknown {
  if (!m || typeof m !== 'object') return m;
  const o = m as Record<string, unknown>;
  const ids = parseClobTokenIds(o.clobTokenIds ?? o.clob_token_ids);
  return { ...o, clob_token_ids: ids };
}

async function gammaMarketsList(limit: number): Promise<unknown[]> {
  // Gamma supports different sort keys over time; try "most active" first, then fall back.
  const base = `${GAMMA}/markets?limit=${limit}&active=true&closed=false`;
  const tryUrls = [
    `${base}&archived=false&order=volume24hr&ascending=false`,
    `${base}&archived=false&order=volume&ascending=false`,
    `${base}&archived=false`,
    base,
  ];
  let lastErr: unknown = null;
  for (const url of tryUrls) {
    try {
      const data = await httpGetJson(url);
      if (Array.isArray(data)) return data;
      lastErr = new Error('gamma_bad_shape');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function isGammaMarketShape(o: Record<string, unknown>): boolean {
  if (typeof o.conditionId === 'string' && o.conditionId.startsWith('0x')) return true;
  if (o.clobTokenIds != null || o.clob_token_ids != null) return true;
  if (
    typeof o.question === 'string' &&
    (typeof o.slug === 'string' || typeof o.id === 'string' || typeof o.id === 'number')
  )
    return true;
  const mk = o.markets;
  const hasNestedMarkets = Array.isArray(mk) && mk.length > 0;
  if (
    !hasNestedMarkets &&
    typeof o.slug === 'string' &&
    o.slug.trim() &&
    (typeof o.id === 'string' || typeof o.id === 'number')
  )
    return true;
  return false;
}

/** Search / CLI may return events with nested `markets`; `/markets/slug/:eventSlug` 404s — expand to child markets only when the row is not already a market. */
function flattenSearchMarketRows(rows: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      out.push(row);
      continue;
    }
    const o = row as Record<string, unknown>;
    if (isGammaMarketShape(o)) {
      out.push(row);
      continue;
    }
    const mk = o.markets;
    if (Array.isArray(mk) && mk.length > 0) {
      const first = mk[0];
      const fo = first && typeof first === 'object' ? (first as Record<string, unknown>) : null;
      if (fo && isGammaMarketShape(fo)) {
        for (const m of mk) {
          if (m && typeof m === 'object') out.push(m);
        }
        continue;
      }
    }
    out.push(row);
  }
  return out;
}

function dedupeSearchRows(rows: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') {
      out.push(r);
      continue;
    }
    const o = r as Record<string, unknown>;
    const id = o.id;
    const slug = o.slug;
    const key =
      typeof id === 'string' || typeof id === 'number'
        ? `id:${String(id)}`
        : typeof slug === 'string' && slug.trim()
          ? `slug:${slug.trim()}`
          : `anon:${seen.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

const UPDOWN_5M_SEARCH: Record<string, string> = {
  btc: 'bitcoin 5m up or down',
  eth: 'ethereum 5m up or down',
  sol: 'solana 5m up or down',
};

const UPDOWN_15M_SEARCH: Record<string, string> = {
  btc: 'bitcoin 15m up or down',
  eth: 'ethereum 15m up or down',
  sol: 'solana 15m up or down',
};

function rankUpdownCandidates(
  rows: unknown[],
  asset: string,
  interval: '5m' | '15m',
): { slug: string; ts: number; active: boolean; closed: boolean; tokenIds: string[] }[] {
  const pref = `${asset.toLowerCase()}-updown-${interval}-`;
  const found: { slug: string; ts: number; active: boolean; closed: boolean; tokenIds: string[] }[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const slugRaw = String(o.slug ?? '').trim();
    const slug = slugRaw.toLowerCase();
    if (!slug.startsWith(pref)) continue;
    const tail = slug.slice(pref.length);
    if (!/^\d+$/.test(tail)) continue;
    const ts = Number(tail);
    const active = o.active === true;
    const closed = o.closed === true;
    const tokenIds = parseClobTokenIds(o.clobTokenIds ?? o.clob_token_ids);
    found.push({ slug: slugRaw, ts, active, closed, tokenIds });
  }
  found.sort((a, b) => {
    const aOpen = a.active && !a.closed;
    const bOpen = b.active && !b.closed;
    if (aOpen !== bOpen) return aOpen ? -1 : 1;
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.closed !== b.closed) return a.closed ? 1 : -1;
    return b.ts - a.ts;
  });
  return found;
}

async function clobHasOrderbook(tokenId: string): Promise<boolean> {
  const url = `${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`;
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (r.status === 404) return false;
  return r.ok;
}

function nowBucketSec(stepSec: number): { now: number; floor: number; ceil: number } {
  const now = Math.floor(Date.now() / 1000);
  const floor = Math.floor(now / stepSec) * stepSec;
  const ceil = Math.ceil(now / stepSec) * stepSec;
  return { now, floor, ceil };
}

async function gammaSearchMarkets(q: string, limitPerType: number, maxResults: number): Promise<unknown[]> {
  const url = `${GAMMA}/public-search?q=${encodeURIComponent(q)}&limit_per_type=${limitPerType}`;
  const body = (await httpGetJson(url)) as Record<string, unknown>;
  const events = Array.isArray(body.events) ? body.events : [];
  const topMarkets = Array.isArray(body.markets) ? body.markets : [];
  const fromEvents = events.flatMap((e) => {
    const ev = e as Record<string, unknown>;
    return Array.isArray(ev.markets) ? ev.markets : [];
  });
  const combined = [...topMarkets, ...fromEvents];
  return combined.slice(0, maxResults);
}

async function gammaMarketBySlugOrId(slugOrId: string): Promise<unknown> {
  const numeric = /^\d+$/.test(slugOrId);
  const path = numeric ? `/markets/${slugOrId}` : `/markets/slug/${encodeURIComponent(slugOrId)}`;
  return httpGetJson(`${GAMMA}${path}`);
}

async function clobBookHttp(tokenId: string): Promise<unknown> {
  const url = `${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`;
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await r.text();
  if (!r.ok) throw new Error(`clob_${r.status}: ${text.slice(0, 240)}`);
  return JSON.parse(text) as unknown;
}

async function tryPriceToBeat(slug: string): Promise<{ value: number; source: string }> {
  // Polymarket docs mention equity price-to-beat; crypto uses a similar pattern in the UI.
  const paths = [`/api/crypto/price-to-beat/${encodeURIComponent(slug)}`, `/api/equity/price-to-beat/${encodeURIComponent(slug)}`];
  let lastErr: unknown = null;
  for (const p of paths) {
    try {
      const data = (await httpGetJsonWithHeaders(`${POLYMARKET_WEB}${p}`, {
        // some endpoints are picky about UA
        'user-agent': 'polymarket-orderflow-web/1.0',
      })) as Record<string, unknown>;
      const vRaw = data.priceToBeat ?? data.price_to_beat ?? data.value ?? data.price ?? data;
      const v = typeof vRaw === 'number' ? vRaw : Number(vRaw);
      if (Number.isFinite(v)) return { value: v, source: p.includes('/crypto/') ? 'polymarket_ssr_crypto' : 'polymarket_ssr_equity' };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`price_to_beat_unavailable: ${String(lastErr)}`);
}

function parseUpdownBucketFromSlug(slug: string): { symbol: string; bucketStartMs: number } | null {
  const s = slug.trim().toLowerCase();
  // Current API shortcut slugs look like: btc-updown-5m-1776735900
  const m = /^([a-z0-9]{2,10})-updown-(5m|15m)-(\d{9,12})$/.exec(s);
  if (!m) return null;
  const asset = m[1]!;
  const startSec = Number(m[3]!);
  if (!Number.isFinite(startSec)) return null;
  return { symbol: `${asset}/usd`, bucketStartMs: startSec * 1000 };
}

function derivePtbFromRtdsHistory(symbol: string, bucketStartMs: number): number | null {
  const hist = rtdsHistory.get(symbol) ?? [];
  if (hist.length === 0) return null;
  // Prefer last tick at/before bucket start; else first tick after bucket start.
  let before: RtdsHistPoint | null = null;
  let after: RtdsHistPoint | null = null;
  for (let i = 0; i < hist.length; i++) {
    const p = hist[i]!;
    if (p.t <= bucketStartMs) before = p;
    else {
      after = p;
      break;
    }
  }
  const chosen = before ?? after;
  if (!chosen) return null;
  const v = Number(chosen.v);
  return Number.isFinite(v) ? v : null;
}

/** Polymarket RTDS websocket: `crypto_prices_chainlink` preferred; `crypto_prices` may supply Binance-backed values. */
type RtdsPrice = { symbol: string; value: number; ts: number; receivedAt: number; source: 'chainlink' | 'binance' };
type RtdsHistPoint = { t: number; v: number };
const rtdsCache = new Map<string, RtdsPrice>();
/** Ring buffer of Chainlink ticks per symbol (WS pushes) — returned to the web client to hydrate charts. */
const rtdsHistory = new Map<string, RtdsHistPoint[]>();
const RTDS_HIST_CAP = 900;
let rtdsWs: WebSocket | null = null;
let rtdsWsStarting: Promise<void> | null = null;

function normalizeChainlinkTsMs(tsRaw: number): number {
  if (!Number.isFinite(tsRaw)) return Date.now();
  return tsRaw < 1e12 ? tsRaw * 1000 : tsRaw;
}

function recordRtdsTick(symbol: string, value: number, tsRaw: number, source: RtdsPrice['source']): void {
  const sym = symbol.toLowerCase();
  const tsMs = normalizeChainlinkTsMs(tsRaw);
  rtdsCache.set(sym, {
    symbol: sym,
    value,
    ts: tsMs,
    receivedAt: Date.now(),
    source,
  });
  const arr = rtdsHistory.get(sym) ?? [];
  const last = arr[arr.length - 1];
  if (last && last.t === tsMs) {
    last.v = value;
  } else {
    arr.push({ t: tsMs, v: value });
    if (arr.length > RTDS_HIST_CAP) arr.splice(0, arr.length - RTDS_HIST_CAP);
  }
  rtdsHistory.set(sym, arr);
}

async function ensureRtdsWs(): Promise<void> {
  if (rtdsWs && rtdsWs.readyState === WebSocket.OPEN) return;
  if (rtdsWsStarting) return rtdsWsStarting;
  if (typeof WebSocket === 'undefined') throw new Error('websocket_unavailable_in_node');
  rtdsWsStarting = new Promise<void>((resolve) => {
    const ws = new WebSocket('wss://ws-live-data.polymarket.com');
    rtdsWs = ws;
    ws.onopen = () => {
      // Subscribe to a small default set; additional symbols are subscribed on-demand by the /api/rtds/crypto endpoint.
      const subs = ['btc/usd', 'eth/usd', 'sol/usd'].map((symbol) => ({
        topic: 'crypto_prices_chainlink',
        type: '*',
        filters: JSON.stringify({ symbol }),
      }));
      ws.send(JSON.stringify({ action: 'subscribe', subscriptions: subs }));
      resolve();
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        const topic = String(msg.topic ?? '');
        if (topic !== 'crypto_prices_chainlink' && topic !== 'crypto_prices') return;
        const payload = (msg.payload ?? {}) as Record<string, unknown>;
        const symbol = String(payload.symbol ?? '');
        const value = Number(payload.value);
        const ts = Number(payload.timestamp ?? msg.timestamp);
        if (!symbol || !Number.isFinite(value)) return;
        recordRtdsTick(
          symbol,
          value,
          Number.isFinite(ts) ? ts : Date.now(),
          topic === 'crypto_prices_chainlink' ? 'chainlink' : 'binance',
        );
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => {
      // allow restart
      rtdsWsStarting = null;
    };
    ws.onclose = () => {
      rtdsWsStarting = null;
    };
  });
  return rtdsWsStarting;
}

const rtdsSubscribed = new Set<string>(['btc/usd', 'eth/usd', 'sol/usd']);

function normalizeRtdsSymbol(s: string): string | null {
  const sym = s.trim().toLowerCase();
  if (!/^[a-z0-9]{2,12}\/usd$/.test(sym)) return null;
  return sym;
}

function ensureRtdsSubscribed(symbol: string): void {
  const sym = normalizeRtdsSymbol(symbol);
  if (!sym) return;
  if (rtdsSubscribed.has(sym)) return;
  rtdsSubscribed.add(sym);
  try {
    if (rtdsWs && rtdsWs.readyState === WebSocket.OPEN) {
      rtdsWs.send(
        JSON.stringify({
          action: 'subscribe',
          subscriptions: [{ topic: 'crypto_prices_chainlink', type: '*', filters: JSON.stringify({ symbol: sym }) }],
        }),
      );
    }
  } catch {
    /* ignore */
  }
}

const app = express();
/** Allow browser → API on another origin (e.g. `VITE_API_BASE=http://127.0.0.1:8787` with Vite preview). */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'accept, content-type');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({ limit: '256kb' }));

const ASSISTANT_SYSTEM =
  'You are a concise assistant for Polymarket CLOB order flow and prediction markets. Explain bids, asks, implied prices, and liquidity in plain language. Do not tell the user what to buy or sell; avoid personalized financial advice. If context is missing or partial, say so.';

function assistantConfig(): { ok: true; provider: string; baseUrl: string; apiKey: string; model: string } | { ok: false } {
  const apiKey =
    process.env.ASSISTANT_API_KEY?.trim() ||
    process.env.MOONSHOT_API_KEY?.trim() || // Kimi / Moonshot
    process.env.OPENAI_API_KEY?.trim() ||
    '';
  if (!apiKey) return { ok: false };
  const baseUrl =
    process.env.ASSISTANT_BASE_URL?.trim() ||
    (process.env.MOONSHOT_API_KEY?.trim() ? 'https://api.moonshot.ai/v1' : 'https://api.openai.com/v1');
  const provider = process.env.ASSISTANT_PROVIDER?.trim() || (process.env.MOONSHOT_API_KEY?.trim() ? 'moonshot' : 'openai');
  const model =
    process.env.ASSISTANT_MODEL?.trim() || (process.env.MOONSHOT_API_KEY?.trim() ? 'kimi-k2.5' : 'gpt-4o-mini');
  return { ok: true, provider, baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model };
}

app.get('/api/health', async (_req, res) => {
  const version = await runCli(['--version'], { timeoutMs: 5_000 });
  let gammaOk = false;
  try {
    const r = await fetch(`${GAMMA}/markets?limit=1`, { headers: { accept: 'application/json' } });
    gammaOk = r.ok;
  } catch {
    gammaOk = false;
  }
  const a = assistantConfig();
  const trading = getTradingConfigFromEnv();
  json(res, 200, {
    ok: true,
    data: {
      polymarket: version.ok ? version.stdout.trim() : null,
      gamma_reachable: gammaOk,
      trading_ready: trading.ok,
      trading_backend: 'polymarket_clob_api',
      trading_signer_address: trading.ok ? trading.config.signerAddress : null,
      trading_funder_address: trading.ok ? trading.config.funderAddress : null,
      assistant_available: a.ok,
      assistant_provider: a.ok ? a.provider : null,
      assistant_model: a.ok ? a.model : null,
      note: trading.ok
        ? 'Polymarket CLOB API trading is configured on the backend.'
        : 'Set POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER on the API server to enable live CLOB trading.',
    },
  });
});

app.get('/api/markets', async (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 20) || 20));
  const out = await runCli(['--output', 'json', 'markets', 'list', '--limit', String(limit)]);
  if (out.ok) {
    try {
      const rows = marketsArrayFromStdout(out.stdout).map(normalizeMarket);
      return json(res, 200, { ok: true, data: rows });
    } catch {
      /* fall through to HTTP */
    }
  }
  try {
    const rows = (await gammaMarketsList(limit)).map(normalizeMarket);
    return json(res, 200, { ok: true, data: rows });
  } catch (e) {
    return json(res, 502, {
      ok: false,
      error: 'markets_failed',
      details: { cli: out.ok ? 'bad_json' : out.stderr || out.stdout, http: String(e) },
    });
  }
});

app.get('/api/markets/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 20) || 20));
  if (!q) return json(res, 400, { ok: false, error: 'missing_q' });
  const out = await runCli(['--output', 'json', 'markets', 'search', q, '--limit', String(limit)]);
  if (out.ok) {
    try {
      const raw = marketsArrayFromStdout(out.stdout);
      const rows = dedupeSearchRows(flattenSearchMarketRows(raw)).map(normalizeMarket);
      return json(res, 200, { ok: true, data: rows });
    } catch {
      /* HTTP */
    }
  }
  try {
    const raw = await gammaSearchMarkets(q, limit, Math.max(50, limit * 5));
    const rows = dedupeSearchRows(flattenSearchMarketRows(raw)).map(normalizeMarket);
    return json(res, 200, { ok: true, data: rows });
  } catch (e) {
    return json(res, 502, {
      ok: false,
      error: 'search_failed',
      details: { cli: out.ok ? 'bad_json' : out.stderr || out.stdout, http: String(e) },
    });
  }
});

/** Resolve latest Polymarket Up/Down market slug for BTC / ETH / SOL (5m or 15m windows; Gamma + CLOB). */
app.get('/api/markets/updown-shortcut', async (req, res) => {
  const asset = String(req.query.asset ?? '').toLowerCase().trim();
  const intervalParam = String(req.query.interval ?? '').trim().toLowerCase();
  if (intervalParam !== '' && intervalParam !== '5m' && intervalParam !== '15m') {
    return json(res, 400, { ok: false, error: 'bad_interval', details: { allowed: ['5m', '15m'] } });
  }
  const interval: '5m' | '15m' = intervalParam === '15m' ? '15m' : '5m';
  const stepSec = interval === '15m' ? 900 : 300;
  if (asset !== 'btc' && asset !== 'eth' && asset !== 'sol') {
    return json(res, 400, { ok: false, error: 'bad_asset', details: { allowed: ['btc', 'eth', 'sol'] } });
  }
  try {
    const b = nowBucketSec(stepSec);
    // IMPORTANT: Polymarket uses the slug suffix as the *window start* bucket (not end).
    // Example: `sol-updown-5m-1776528300` corresponds to a 5-minute window starting at that unix time.
    const base = b.floor;
    const tryTs: number[] = [];
    for (let i = 0; i <= 8; i++) {
      if (i === 0) tryTs.push(base);
      else {
        tryTs.push(base - i * stepSec);
        tryTs.push(base + i * stepSec);
      }
    }
    // First try the deterministic slug rather than Gamma search (which can lag).
    for (const ts of tryTs) {
      const slug = `${asset}-updown-${interval}-${ts}`;
      try {
        const m = (await gammaMarketBySlugOrId(slug)) as Record<string, unknown>;
        const tokenIds = parseClobTokenIds(m.clobTokenIds ?? m.clob_token_ids);
        const t0 = tokenIds[0];
        if (t0 && (await clobHasOrderbook(t0))) {
          return json(res, 200, {
            ok: true,
            data: {
              slug,
              asset,
              interval,
              window: interval,
              tested: true,
              active: m.active === true,
              closed: m.closed === true,
              inferred_window_start_unix: ts,
              inferred_end_unix: ts + stepSec,
              start: new Date(ts * 1000).toISOString(),
              end: new Date((ts + stepSec) * 1000).toISOString(),
              bucket_now_unix: b.now,
              bucket_floor_unix: b.floor,
              bucket_ceil_unix: b.ceil,
            },
          });
        }
        // Market exists but no book; keep searching nearby windows.
      } catch {
        // Market slug doesn't exist yet.
      }
    }

    // Fallback to Gamma search results when deterministic lookup fails.
    const q = interval === '15m' ? UPDOWN_15M_SEARCH[asset] : UPDOWN_5M_SEARCH[asset];
    const raw = await gammaSearchMarkets(q, 25, 180);
    const rows = dedupeSearchRows(flattenSearchMarketRows(raw));
    const candidates = rankUpdownCandidates(rows, asset, interval);
    if (candidates.length === 0) {
      return json(res, 404, {
        ok: false,
        error: interval === '15m' ? 'no_updown_15m' : 'no_updown_5m',
        details: { asset, interval, q },
      });
    }
    const target = b.floor;

    const ordered = [...candidates].sort((a, b2) => {
      const aDist = Math.abs(a.ts - target);
      const bDist = Math.abs(b2.ts - target);
      if (aDist !== bDist) return aDist - bDist;
      // Prefer the bucket that is not in the past when tied (e.g. right after a boundary).
      const aPast = a.ts < target;
      const bPast = b2.ts < target;
      if (aPast !== bPast) return aPast ? 1 : -1;
      return b2.ts - a.ts;
    });

    // Prefer a candidate with an actual CLOB orderbook; test a few closest buckets.
    for (const c of ordered.slice(0, 10)) {
      const t0 = c.tokenIds[0];
      if (!t0) continue;
      try {
        if (await clobHasOrderbook(t0)) {
          return json(res, 200, {
            ok: true,
            data: {
              slug: c.slug,
              asset,
              interval,
              window: interval,
              tested: true,
              active: c.active,
              closed: c.closed,
              inferred_window_start_unix: c.ts,
              inferred_end_unix: c.ts + stepSec,
              start: new Date(c.ts * 1000).toISOString(),
              end: new Date((c.ts + stepSec) * 1000).toISOString(),
              bucket_now_unix: b.now,
              bucket_floor_unix: b.floor,
              bucket_ceil_unix: b.ceil,
            },
          });
        }
      } catch {
        /* ignore */
      }
    }

    const best = ordered[0]!;
    return json(res, 200, {
      ok: true,
      data: {
        slug: best.slug,
        asset,
        interval,
        window: interval,
        tested: false,
        active: best.active,
        closed: best.closed,
        inferred_window_start_unix: best.ts,
        inferred_end_unix: best.ts + stepSec,
        start: new Date(best.ts * 1000).toISOString(),
        end: new Date((best.ts + stepSec) * 1000).toISOString(),
        bucket_now_unix: b.now,
        bucket_floor_unix: b.floor,
        bucket_ceil_unix: b.ceil,
      },
    });
  } catch (e) {
    return json(res, 502, { ok: false, error: 'updown_shortcut_failed', details: { asset, interval, http: String(e) } });
  }
});

app.get('/api/markets/get/:slug', async (req, res) => {
  const raw = String(req.params.slug ?? '').trim();
  const slug = normalizeMarketLookupRef(raw);
  if (!slug) return json(res, 400, { ok: false, error: 'missing_slug' });
  const out = await runCli(['--output', 'json', 'markets', 'get', slug]);
  if (out.ok) {
    try {
      const data = normalizeMarket(JSON.parse(out.stdout));
      return json(res, 200, { ok: true, data });
    } catch {
      /* HTTP */
    }
  }
  try {
    const data = normalizeMarket(await gammaMarketBySlugOrId(slug));
    return json(res, 200, { ok: true, data });
  } catch (e) {
    try {
      const ev = (await httpGetJson(`${GAMMA}/events/slug/${encodeURIComponent(slug)}`)) as Record<string, unknown>;
      const mk = Array.isArray(ev.markets) ? (ev.markets as unknown[])[0] : null;
      if (mk) {
        const data = normalizeMarket(mk);
        return json(res, 200, { ok: true, data });
      }
    } catch {
      /* final */
    }
    return json(res, 502, {
      ok: false,
      error: 'market_get_failed',
      details: { raw, slug, cli: out.ok ? 'bad_json' : out.stderr || out.stdout, http: String(e) },
    });
  }
});

app.get('/api/clob/book/:token', async (req, res) => {
  const token = String(req.params.token ?? '').trim();
  if (!token) return json(res, 400, { ok: false, error: 'missing_token' });
  const out = await runCli(['--output', 'json', 'clob', 'book', token]);
  if (out.ok) {
    try {
      return json(res, 200, { ok: true, data: JSON.parse(out.stdout) });
    } catch {
      /* HTTP */
    }
  }
  try {
    const data = await clobBookHttp(token);
    return json(res, 200, { ok: true, data });
  } catch (e) {
    return json(res, 502, {
      ok: false,
      error: 'book_failed',
      details: { token, cli: out.ok ? 'bad_json' : out.stderr || out.stdout, http: String(e) },
    });
  }
});

app.get('/api/price-to-beat/:slug', async (req, res) => {
  const raw = String(req.params.slug ?? '').trim();
  const slug = normalizeMarketLookupRef(raw);
  if (!slug) return json(res, 400, { ok: false, error: 'missing_slug' });
  try {
    const out = await tryPriceToBeat(slug);
    return json(res, 200, { ok: true, data: { slug, price_to_beat: out.value, source: out.source } });
  } catch (e) {
    // Fallback for up/down shortcut slugs when Polymarket SSR endpoint format changes.
    const b = parseUpdownBucketFromSlug(slug);
    if (b) {
      try {
        await ensureRtdsWs();
        const v = derivePtbFromRtdsHistory(b.symbol, b.bucketStartMs);
        if (v != null) {
          return json(res, 200, { ok: true, data: { slug, price_to_beat: v, source: 'rtds_chainlink_bucket_floor' } });
        }
        const cached = rtdsCache.get(b.symbol);
        if (cached && Number.isFinite(cached.value)) {
          return json(res, 200, { ok: true, data: { slug, price_to_beat: cached.value, source: 'rtds_chainlink_latest' } });
        }
      } catch {
        // fallthrough to error
      }
    }
    return json(res, 502, { ok: false, error: 'price_to_beat_failed', details: { slug, err: String(e) } });
  }
});

/** Public Polymarket Data API — recent matched trades for a condition (no CLOB keys). */
app.get('/api/data/recent-trades', async (req, res) => {
  const market = String(req.query.market ?? '').trim().toLowerCase();
  if (!market || !/^0x[a-f0-9]{64}$/.test(market)) {
    return json(res, 400, {
      ok: false,
      error: 'bad_market',
      details: { hint: 'Pass market=<conditionId> as 0x + 64 hex (from Gamma market JSON).' },
    });
  }
  const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50) || 50));
  const asset = String(req.query.asset ?? '').trim();
  const url = `${DATA_API}/trades?limit=${limit}&market=${encodeURIComponent(market)}`;
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await r.text();
    if (!r.ok) {
      return json(res, 502, { ok: false, error: 'data_trades_http', details: { status: r.status, body: text.slice(0, 400) } });
    }
    const rows = JSON.parse(text) as unknown;
    if (!Array.isArray(rows)) {
      return json(res, 502, { ok: false, error: 'data_trades_shape', details: { body: text.slice(0, 200) } });
    }
    let list = rows;
    if (asset) {
      list = rows.filter((x) => x && typeof x === 'object' && String((x as Record<string, unknown>).asset) === asset);
    }
    const out = list.slice(0, limit).map((x) => {
      const o = x as Record<string, unknown>;
      const ts = Number(o.timestamp);
      const price = Number(o.price);
      const size = Number(o.size);
      return {
        timestamp: Number.isFinite(ts) ? ts : 0,
        side: String(o.side ?? ''),
        price: Number.isFinite(price) ? price : null,
        size: Number.isFinite(size) ? size : null,
        outcome: o.outcome != null ? String(o.outcome) : null,
        asset: o.asset != null ? String(o.asset) : '',
        transactionHash: o.transactionHash != null ? String(o.transactionHash) : null,
        pseudonym: o.pseudonym != null ? String(o.pseudonym) : null,
      };
    });
    return json(res, 200, { ok: true, data: out });
  } catch (e) {
    return json(res, 502, { ok: false, error: 'data_trades_failed', details: String(e) });
  }
});

/** Public CLOB — last trade print for a single outcome token. */
app.get('/api/clob/last-trade-price', async (req, res) => {
  const token = String(req.query.token_id ?? '').trim();
  if (!token) return json(res, 400, { ok: false, error: 'missing_token_id' });
  try {
    const url = `${CLOB}/last-trade-price?token_id=${encodeURIComponent(token)}`;
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await r.text();
    if (!r.ok) {
      return json(res, 502, { ok: false, error: 'last_trade_http', details: { status: r.status, body: text.slice(0, 400) } });
    }
    const o = JSON.parse(text) as Record<string, unknown>;
    return json(res, 200, {
      ok: true,
      data: {
        price: typeof o.price === 'string' ? o.price : String(o.price ?? ''),
        side: typeof o.side === 'string' ? o.side : String(o.side ?? ''),
      },
    });
  } catch (e) {
    return json(res, 502, { ok: false, error: 'last_trade_failed', details: String(e) });
  }
});

app.get('/api/rtds/crypto', async (req, res) => {
  const raw = String(req.query.symbol ?? '');
  const symbol = normalizeRtdsSymbol(raw);
  if (!symbol) return json(res, 400, { ok: false, error: 'bad_symbol', details: { hint: 'expected e.g. btc/usd', symbol: raw } });
  try {
    await ensureRtdsWs();
    ensureRtdsSubscribed(symbol);
  } catch (e) {
    return json(res, 502, { ok: false, error: 'rtds_unavailable', details: String(e) });
  }
  const v = rtdsCache.get(symbol);
  if (!v) return json(res, 404, { ok: false, error: 'no_price_yet', details: { symbol } });
  const history = rtdsHistory.get(symbol) ?? [];
  return json(res, 200, { ok: true, data: { ...v, history } });
});

/** Parallel order books (CLI first, HTTP fallback per token). */
app.get('/api/clob/books', async (req, res) => {
  const raw = String(req.query.tokens ?? '').trim();
  if (!raw) return json(res, 400, { ok: false, error: 'missing_tokens' });
  const tokens = raw.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 4);
  if (tokens.length === 0) return json(res, 400, { ok: false, error: 'missing_tokens' });

  const books = await Promise.all(
    tokens.map(async (token) => {
      const out = await runCli(['--output', 'json', 'clob', 'book', token]);
      if (out.ok) {
        try {
          return { token, book: JSON.parse(out.stdout) as unknown, error: null as string | null };
        } catch {
          /* try HTTP */
        }
      }
      try {
        return { token, book: await clobBookHttp(token), error: null as string | null };
      } catch (e) {
        return {
          token,
          book: null,
          error: String(e instanceof Error ? e.message : e).slice(0, 800),
        };
      }
    }),
  );

  return json(res, 200, { ok: true, data: books });
});

type ChatMsg = { role: 'user' | 'assistant' | 'system'; content: string };

/** Parses OpenAI-style `message.content` (string or multimodal array). */
function extractMessageContentField(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (content === null || content === undefined) return '';
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') chunks.push(part);
      else if (part && typeof part === 'object') {
        const o = part as Record<string, unknown>;
        if (typeof o.text === 'string') chunks.push(o.text);
      }
    }
    return chunks.join('\n').trim();
  }
  return '';
}

/**
 * OpenAI-compatible `choices[].message` — Kimi K2.5 (thinking on) may leave `content` empty
 * when `max_tokens` is consumed by `reasoning_content` first; vLLM may use `reasoning` instead.
 */
function extractChatCompletionText(message: Record<string, unknown> | null): string {
  if (!message) return '';
  const fromContent = extractMessageContentField(message.content);
  if (fromContent) return fromContent;
  const rc = message.reasoning_content;
  if (typeof rc === 'string' && rc.trim()) return rc.trim();
  const r = message.reasoning;
  if (typeof r === 'string' && r.trim()) return r.trim();
  return '';
}

/** Kimi K2 family on Moonshot rejects custom temperature (API: only 1 allowed). */
function moonshotModelRequiresTemperatureOne(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes('kimi-k2') || m.includes('kimi_k2') || /^kimi[-_]?k2/i.test(model);
}

/** `kimi-k2-thinking` cannot turn thinking off; other Kimi K2.x models support `response_format: { type: 'disabled' }`. */
function moonshotKimiThinkingCanDisable(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes('kimi-k2-thinking')) return false;
  return moonshotModelRequiresTemperatureOne(model);
}

function assistantChatTemperature(provider: string, model: string): number {
  const raw = process.env.ASSISTANT_TEMPERATURE?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.min(2, Math.max(0, n));
  }
  if (provider === 'moonshot' && moonshotModelRequiresTemperatureOne(model)) return 1;
  // Moonshot v1 models accept sub-1 temps; Kimi K2 does not (handled above).
  if (provider === 'moonshot') return 0.45;
  return 0.35;
}

function coerceChatMessages(raw: unknown): ChatMsg[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatMsg[] = [];
  for (const m of raw.slice(-14)) {
    if (!m || typeof m !== 'object') continue;
    const o = m as Record<string, unknown>;
    const role = o.role;
    const content = typeof o.content === 'string' ? o.content : '';
    if (role !== 'user' && role !== 'assistant') continue;
    const t = content.trim();
    if (!t) continue;
    out.push({ role, content: t.slice(0, 6_000) });
  }
  return out;
}

app.post('/api/assistant/chat', async (req, res) => {
  const cfg = assistantConfig();
  if (!cfg.ok) {
    return json(res, 503, {
      ok: false,
      error: 'assistant_no_key',
      details: {
        hint:
          'Set MOONSHOT_API_KEY, OPENAI_API_KEY, or ASSISTANT_API_KEY in `.env` at the repo root or in `api/.env`, then restart `npm run dev`. The API process only reads those files (not the Vite app env).',
      },
    });
  }

  const body = req.body as { messages?: unknown; context?: unknown; max_tokens?: unknown };
  const userMsgs = coerceChatMessages(body.messages);
  if (userMsgs.length === 0) return json(res, 400, { ok: false, error: 'missing_messages' });

  const ctx = typeof body.context === 'string' ? body.context.trim().slice(0, 8_000) : '';
  const systemContent = ctx ? `${ASSISTANT_SYSTEM}\n\n--- Page context (may be partial) ---\n${ctx}` : ASSISTANT_SYSTEM;

  const rawMax = Number(body.max_tokens);
  const envDefault = Number(process.env.ASSISTANT_MAX_TOKENS);
  const fallback = Number.isFinite(envDefault) && envDefault >= 64 ? Math.min(768, Math.floor(envDefault)) : 480;
  const model = cfg.model;
  const isMoonshotK2 = cfg.provider === 'moonshot' && moonshotModelRequiresTemperatureOne(model);
  /** Kimi K2 thinking + `content` share this budget; a 1k cap often yields empty `content`. */
  const maxTokenCap = isMoonshotK2 ? 16_384 : 1024;
  let maxTokens = Number.isFinite(rawMax) ? Math.min(maxTokenCap, Math.max(64, Math.floor(rawMax))) : Math.min(maxTokenCap, fallback);
  if (isMoonshotK2) {
    const thinkingOnly = model.toLowerCase().includes('kimi-k2-thinking');
    if (thinkingOnly) maxTokens = Math.max(maxTokens, 4096);
    else if (moonshotKimiThinkingCanDisable(model)) maxTokens = Math.max(maxTokens, 1024);
    maxTokens = Math.min(maxTokenCap, maxTokens);
  }

  const temperature = assistantChatTemperature(cfg.provider, model);
  const disableThinking =
    cfg.provider === 'moonshot' &&
    moonshotKimiThinkingCanDisable(model) &&
    process.env.ASSISTANT_KIMI_THINKING?.trim() !== '1';

  try {
    const controller = new AbortController();
    const timeoutMs = Number(process.env.ASSISTANT_TIMEOUT_MS) || 45_000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const payload: Record<string, unknown> = {
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: systemContent }, ...userMsgs],
    };
    if (disableThinking) payload.response_format = { type: 'disabled' };

    const r = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${cfg.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    clearTimeout(timeoutId);
    const text = await r.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return json(res, 502, { ok: false, error: 'assistant_bad_upstream', details: text.slice(0, 400) });
    }
    if (!r.ok) {
      const errBody = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).error : null;
      let detailStr = text.slice(0, 800);
      if (errBody && typeof errBody === 'object') {
        const eb = errBody as Record<string, unknown>;
        const msg = typeof eb.message === 'string' ? eb.message : JSON.stringify(errBody).slice(0, 800);
        detailStr = msg;
      }
      console.warn('[assistant] upstream_http', r.status, detailStr.slice(0, 500));
      return json(res, 502, {
        ok: false,
        error: 'assistant_upstream_http',
        details: {
          status: r.status,
          model,
          provider: cfg.provider,
          message: detailStr,
          hint:
            cfg.provider === 'moonshot'
              ? 'If you see "Invalid Model", set ASSISTANT_MODEL to a model your key supports (e.g. moonshot-v1-8k or kimi-k2-0905-preview per Moonshot docs). Kimi K2 models require temperature 1 — the server sets that automatically; override with ASSISTANT_TEMPERATURE=1 if needed.'
              : 'Check ASSISTANT_MODEL and billing for your OpenAI-compatible provider.',
        },
      });
    }
    const root = parsed as Record<string, unknown>;
    const choices = Array.isArray(root.choices) ? root.choices : [];
    const first = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>) : null;
    const msg = first?.message && typeof first.message === 'object' ? (first.message as Record<string, unknown>) : null;
    const content = extractChatCompletionText(msg);
    if (!content) {
      const finish =
        first && typeof first.finish_reason === 'string' ? first.finish_reason : null;
      console.warn('[assistant] empty_reply', {
        model,
        provider: cfg.provider,
        rawKeys: msg ? Object.keys(msg) : [],
        finish_reason: finish,
        max_tokens: maxTokens,
      });
      return json(res, 502, {
        ok: false,
        error: 'assistant_empty_reply',
        details: {
          model,
          finish_reason: finish,
          max_tokens: maxTokens,
          hint:
            'Kimi K2 models may return only reasoning until max_tokens is large enough. This server disables thinking for kimi-k2.5 by default and raises the token cap; set ASSISTANT_KIMI_THINKING=1 to keep thinking (needs a high max_tokens).',
        },
      });
    }
    return json(res, 200, { ok: true, data: { message: content } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const aborted = msg.toLowerCase().includes('aborted') || msg.toLowerCase().includes('abort');
    return json(res, 502, { ok: false, error: aborted ? 'assistant_timeout' : 'assistant_fetch_failed', details: msg });
  }
});

function parseNumber(name: string, v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n)) return null;
  return n;
}

function toHumanAmount(raw: unknown, decimals: number): string | null {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return null;
  const denom = 10 ** decimals;
  return String(n / denom);
}

function normalizeAmountMaybe(raw: unknown, decimals: number, kind: 'collateral' | 'conditional'): string | null {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return null;
  // Some upstreams return base units (1e6) while others return human units already.
  // Heuristic: if it's huge, treat as base units; otherwise treat as already-human.
  const threshold = kind === 'collateral' ? 1e8 : 1e9; // ~100 USDC in base units; ~1000 shares in base units
  if (n >= threshold) return toHumanAmount(n, decimals);
  return String(n);
}

/** CLOB balance + allowance for Max / Available (USDC or outcome shares). */
app.get('/api/trade/balance-allowance', async (req, res) => {
  const tokenId = String(req.query.token_id ?? '').trim();
  const raw = String(req.query.asset_type ?? 'conditional').trim().toLowerCase();
  const assetType = raw === 'collateral' ? AssetType.COLLATERAL : AssetType.CONDITIONAL;
  if (assetType === AssetType.CONDITIONAL && !tokenId) {
    return json(res, 400, { ok: false, error: 'missing_token_id', details: { hint: 'Pass token_id for outcome (conditional) balance.' } });
  }

  const ready = await getTradingClient();
  if (!ready.ok) {
    return json(res, ready.error === 'trading_auth_failed' ? 502 : 503, {
      ok: false,
      error: ready.error,
      details: { hint: ready.hint, reason: ready.details },
    });
  }

  try {
    const params =
      assetType === AssetType.COLLATERAL
        ? { asset_type: AssetType.COLLATERAL }
        : { asset_type: AssetType.CONDITIONAL, token_id: tokenId };
    const data = await ready.client.getBalanceAllowance(params);
    // Normalize base-unit strings into human units for the web UI.
    const decimals = assetType === AssetType.COLLATERAL ? COLLATERAL_TOKEN_DECIMALS : CONDITIONAL_TOKEN_DECIMALS;
    const kind = assetType === AssetType.COLLATERAL ? 'collateral' : 'conditional';
    const balance =
      normalizeAmountMaybe((data as { balance?: unknown }).balance, decimals, kind) ??
      String((data as { balance?: unknown }).balance ?? '');
    const allowance =
      normalizeAmountMaybe((data as { allowance?: unknown }).allowance, decimals, kind) ??
      String((data as { allowance?: unknown }).allowance ?? '');
    return json(res, 200, { ok: true, data: { ...data, balance, allowance } });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      error: 'balance_allowance_failed',
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
});

/** Avg entry price (cost basis) for current user and token (0..1), computed from authenticated trade history. */
app.get('/api/trade/avg-entry', async (req, res) => {
  const tokenId = String(req.query.token_id ?? '').trim();
  if (!tokenId) return json(res, 400, { ok: false, error: 'missing_token_id' });

  const ready = await getTradingClient();
  if (!ready.ok) {
    return json(res, ready.error === 'trading_auth_failed' ? 502 : 503, {
      ok: false,
      error: ready.error,
      details: { hint: ready.hint, reason: ready.details },
    });
  }

  try {
    // Keep it light: fetch only the first page for this token. If you have very long history,
    // this is an estimate (still useful for most active markets).
    const trades = await ready.client.getTrades({ token_id: tokenId, limit: 500 } as never, true);

    const funder = ready.config.funderAddress.toLowerCase();
    const items = (Array.isArray(trades) ? trades : []) as unknown[];

    // Moving average cost basis.
    let pos = 0;
    let cost = 0;
    for (const t of items.slice().reverse()) {
      const trade = t as Record<string, unknown>;
      const sideRaw = String(trade.side ?? trade.taker_side ?? trade.maker_side ?? '').toLowerCase();
      const price = parseNumber('price', trade.price);
      const size = parseNumber('size', trade.size ?? trade.amount ?? trade.quantity);
      const maker = typeof trade.maker_address === 'string' ? trade.maker_address.toLowerCase() : '';
      const taker = typeof trade.taker_address === 'string' ? trade.taker_address.toLowerCase() : '';

      // If addresses exist, only include the user's own participation.
      const hasAddr = Boolean(maker || taker);
      const involved = !hasAddr || maker === funder || taker === funder;
      if (!involved) continue;
      if (price == null || size == null || price <= 0 || price >= 1 || size <= 0) continue;

      const isBuy = sideRaw === 'buy' || sideRaw === 'b';
      const isSell = sideRaw === 'sell' || sideRaw === 's';
      if (!isBuy && !isSell) continue;

      if (isBuy) {
        pos += size;
        cost += size * price;
      } else {
        if (pos <= 0) continue;
        const avg = cost / pos;
        const qty = Math.min(size, pos);
        cost -= qty * avg;
        pos -= qty;
      }
    }

    const avgEntry = pos > 0 ? cost / pos : null;
    return json(res, 200, { ok: true, data: { tokenId, avgEntry, shares: pos } });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      error: 'avg_entry_failed',
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
});

/** Refresh on-chain balance cache used by the CLOB (call before large sells if balances look stale). */
app.post('/api/trade/update-balance-allowance', async (req, res) => {
  const body = req.body as { token_id?: unknown; asset_type?: unknown };
  const tokenId = typeof body.token_id === 'string' ? body.token_id.trim() : '';
  const raw = typeof body.asset_type === 'string' ? body.asset_type.trim().toLowerCase() : 'conditional';
  const assetType = raw === 'collateral' ? AssetType.COLLATERAL : AssetType.CONDITIONAL;
  if (assetType === AssetType.CONDITIONAL && !tokenId) {
    return json(res, 400, { ok: false, error: 'missing_token_id' });
  }

  const ready = await getTradingClient();
  if (!ready.ok) {
    return json(res, ready.error === 'trading_auth_failed' ? 502 : 503, {
      ok: false,
      error: ready.error,
      details: { hint: ready.hint, reason: ready.details },
    });
  }

  try {
    const params =
      assetType === AssetType.COLLATERAL
        ? { asset_type: AssetType.COLLATERAL }
        : { asset_type: AssetType.CONDITIONAL, token_id: tokenId };
    await ready.client.updateBalanceAllowance(params);
    return json(res, 200, { ok: true, data: { updated: true } });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      error: 'update_balance_allowance_failed',
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
});

/** Real-money trading via the Polymarket CLOB API: market buy (USD) / market sell (shares).
 * Use FAK so available liquidity can fill partially instead of killing the whole order.
 */
app.post('/api/trade/market-order', async (req, res) => {
  const body = req.body as { token?: unknown; amount?: unknown; side?: unknown; signatureType?: unknown };
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const side = typeof body.side === 'string' ? body.side.trim().toLowerCase() : 'buy';
  const amount = parseNumber('amount', body.amount);

  if (!token) return json(res, 400, { ok: false, error: 'missing_token' });
  if (side !== 'buy' && side !== 'sell') return json(res, 400, { ok: false, error: 'bad_side' });
  if (amount == null || amount <= 0) return json(res, 400, { ok: false, error: 'bad_amount' });
  // Buys: `amount` is USDC. Sells: `amount` is shares (CLOB convention).
  if (side === 'buy' && amount > 10_000) return json(res, 400, { ok: false, error: 'bad_amount', details: { max_usdc: 10_000 } });
  if (side === 'sell' && amount > 2_000_000) return json(res, 400, { ok: false, error: 'bad_amount', details: { max_shares: 2_000_000 } });

  const ready = await getTradingClient();
  if (!ready.ok) {
    return json(res, ready.error === 'trading_auth_failed' ? 502 : 503, {
      ok: false,
      error: ready.error,
      details: { hint: ready.hint, reason: ready.details },
    });
  }

  try {
    // Sync CLOB balance view with chain state — often required before sells fill.
    if (side === 'sell') {
      await ready.client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: token });
    } else {
      await ready.client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    }

    const sideEnum = side === 'buy' ? Side.BUY : Side.SELL;
    const baseOrder = {
      tokenID: token,
      amount,
      side: sideEnum,
      /**
       * Must match the execution order type passed to `createAndPostMarketOrder` — otherwise
       * `calculateMarketPrice` defaults to FOK-style pricing while the matcher runs FAK, which
       * can yield “no orders found to match with FAK order”.
       */
      orderType: OrderType.FAK as const,
    };

    let parsed: unknown;
    try {
      parsed = await ready.client.createAndPostMarketOrder(baseOrder, undefined, OrderType.FAK);
    } catch (first) {
      const msg = first instanceof Error ? first.message : String(first);
      // Avoid FOK fallback: it can fail with "couldn't be fully filled" when the book is thin/moving,
      // which is worse UX than simply surfacing the original FAK failure with a liquidity hint.
      const liquidityHint =
        /no orders found/i.test(msg) ||
        /no match/i.test(msg) ||
        /FAK/i.test(msg) ||
        /FOK/i.test(msg) ||
        /fully filled/i.test(msg) ||
        /killed/i.test(msg);
      if (liquidityHint) {
        return json(res, 502, {
          ok: false,
          error: 'trade_api_failed',
          details: {
            message: msg,
            hint: 'Not enough liquidity to fill this as a market order right now. Try a smaller size, switch to Limit, or retry in a few seconds.',
          },
        });
      }
      throw first;
    }

    return json(res, 200, { ok: true, data: parsed });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const hint =
      /no orders found|FAK|FOK|no match/i.test(msg)
        ? 'No liquidity matched at the computed market price (book may be empty or moving). Try a smaller size, switch to Limit, or retry in a few seconds.'
        : undefined;
    return json(res, 502, {
      ok: false,
      error: 'trade_api_failed',
      details: { message: msg, ...(hint ? { hint } : {}) },
    });
  }
});

/** Real-money trading via the Polymarket CLOB API: limit orders (shares size + price). */
app.post('/api/trade/create-order', async (req, res) => {
  const body = req.body as { token?: unknown; price?: unknown; size?: unknown; side?: unknown; signatureType?: unknown };
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const side = typeof body.side === 'string' ? body.side.trim().toLowerCase() : 'buy';
  const price = parseNumber('price', body.price);
  const size = parseNumber('size', body.size);

  if (!token) return json(res, 400, { ok: false, error: 'missing_token' });
  if (side !== 'buy' && side !== 'sell') return json(res, 400, { ok: false, error: 'bad_side' });
  if (price == null || price <= 0 || price >= 1) return json(res, 400, { ok: false, error: 'bad_price' });
  if (size == null || size <= 0 || size > 2_000_000) return json(res, 400, { ok: false, error: 'bad_size' });

  const ready = await getTradingClient();
  if (!ready.ok) {
    return json(res, ready.error === 'trading_auth_failed' ? 502 : 503, {
      ok: false,
      error: ready.error,
      details: { hint: ready.hint, reason: ready.details },
    });
  }

  try {
    if (side === 'sell') {
      await ready.client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: token });
    } else {
      await ready.client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    }

    const parsed = await ready.client.createAndPostOrder(
      {
        tokenID: token,
        price,
        size,
        side: side === 'buy' ? Side.BUY : Side.SELL,
      },
      undefined,
      OrderType.GTC,
    );
    return json(res, 200, { ok: true, data: parsed });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      error: 'trade_api_failed',
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, () => {
  console.log(`[api] listening on http://127.0.0.1:${port}`);
  void ensureRtdsWs().catch(() => {
    /* RTDS warms on first /api/rtds/crypto request if this fails */
  });
});
