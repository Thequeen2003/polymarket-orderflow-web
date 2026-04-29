import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import http from 'node:http';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import {
  AssetType,
  type ClobClient,
  type CreateOrderOptions,
  COLLATERAL_TOKEN_DECIMALS,
  CONDITIONAL_TOKEN_DECIMALS,
  OrderType,
  Side,
  type TradeParams,
} from '@polymarket/clob-client-v2';
import { extractCanonicalMarketFill } from './clobFillExtract.js';
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

// Hot-path cache to keep the UI "instant" during rapid trading.
// We keep this very short to avoid stale positions, while preventing repeated slow remote calls.
const avgEntryCache = new Map<
  string,
  { at: number; data: { tokenId: string; avgEntry: number | null; shares: number } }
>();

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

function runBullpen(args: string[], opts?: { timeoutMs?: number }): Promise<CliResult> {
  const bin = process.env.BULLPEN_BIN || 'bullpen';
  const timeoutMs = opts?.timeoutMs ?? 35_000;
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let done = false;
    const finish = (r: CliResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', () => {
      clearTimeout(t);
      finish({ ok: false, stdout, stderr, code: null, signal: null });
    });
    child.on('close', (code, signal) => {
      clearTimeout(t);
      if (code === 0) finish({ ok: true, stdout });
      else finish({ ok: false, stdout, stderr, code, signal });
    });
  });
}

function parseJsonMaybe(text: string): unknown | null {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
}

function envFlagTrue(raw: string | undefined): boolean {
  const v = String(raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** When false (default), slug+outcome do not route through Bullpen; use CLOB only. Set POLYMARKET_USE_BULLPEN=true for legacy Bullpen execution + position reads. */
function polymarketUseBullpen(): boolean {
  return envFlagTrue(process.env.POLYMARKET_USE_BULLPEN);
}

type BullpenPositionsCache = {
  fetchedAtMs: number;
  // The raw parsed JSON root (whatever Bullpen returns).
  parsed: unknown;
  // Best-effort normalized array of position objects.
  positions: Record<string, unknown>[];
};

const bullpenPositionsCache: { value: BullpenPositionsCache | null; inflight: Promise<void> | null } = {
  value: null,
  inflight: null,
};

function positionsArrayFromBullpenParsed(parsed: unknown): Record<string, unknown>[] {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
  if (typeof parsed !== 'object') return [];
  const root = parsed as Record<string, unknown>;
  const maybe = (root.positions ?? root.data ?? root.result) as unknown;
  if (Array.isArray(maybe)) return maybe.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
  return [];
}

async function refreshBullpenPositions(opts?: { force?: boolean }): Promise<void> {
  const now = Date.now();
  const ttlMs = 250; // keep UI feeling "live" despite CLI latency
  if (!opts?.force && bullpenPositionsCache.value && now - bullpenPositionsCache.value.fetchedAtMs < ttlMs) return;
  if (bullpenPositionsCache.inflight) return;
  const env = String(process.env.BULLPEN_ENV ?? 'production').trim() || 'production';
  bullpenPositionsCache.inflight = (async () => {
    try {
      const r = await runBullpen(['polymarket', 'positions', '--env', env, '--output', 'json'], { timeoutMs: 25_000 });
      if (!r.ok) return;
      const parsed = parseJsonMaybe(r.stdout);
      if (parsed == null) return;
      bullpenPositionsCache.value = {
        fetchedAtMs: Date.now(),
        parsed,
        positions: positionsArrayFromBullpenParsed(parsed),
      };
    } finally {
      bullpenPositionsCache.inflight = null;
    }
  })();
  await bullpenPositionsCache.inflight;
}

function cachedBullpenPositionsOrNull(): BullpenPositionsCache | null {
  return bullpenPositionsCache.value;
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

const UPDOWN_1H_SEARCH: Record<string, string[]> = {
  btc: ['bitcoin 1h up or down', 'bitcoin hourly up or down', 'bitcoin up or down hourly', 'bitcoin up or down 1 hour', 'bitcoin up or down'],
  eth: ['ethereum 1h up or down', 'ethereum hourly up or down', 'ethereum up or down hourly', 'ethereum up or down 1 hour', 'ethereum up or down'],
  sol: ['solana 1h up or down', 'solana hourly up or down', 'solana up or down hourly', 'solana up or down 1 hour', 'solana up or down'],
};

const UPDOWN_4H_SEARCH: Record<string, string> = {
  btc: 'bitcoin 4h up or down',
  eth: 'ethereum 4h up or down',
  sol: 'solana 4h up or down',
};

const UPDOWN_1D_SEARCH: Record<string, string> = {
  btc: 'bitcoin daily up or down',
  eth: 'ethereum daily up or down',
  sol: 'solana daily up or down',
};

function rankUpdownCandidates(
  rows: unknown[],
  asset: string,
  interval: '5m' | '15m' | '1h' | '4h' | '1d',
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

function parseIsoMs(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function assetSearchNeedle(asset: string): { slugNeedle: string; textNeedles: string[] } {
  const a = asset.toLowerCase().trim();
  if (a === 'btc') return { slugNeedle: 'btc', textNeedles: ['btc', 'bitcoin'] };
  if (a === 'eth') return { slugNeedle: 'eth', textNeedles: ['eth', 'ethereum'] };
  return { slugNeedle: 'sol', textNeedles: ['sol', 'solana'] };
}

function pickBestUpdownGeneral(
  rows: unknown[],
  asset: string,
  interval: '1h' | '1d',
): { slug: string; active: boolean; closed: boolean; tokenIds: string[]; startMs: number | null; endMs: number | null } | null {
  const { slugNeedle, textNeedles } = assetSearchNeedle(asset);
  const targetDurMs = interval === '1h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const scored: {
    slug: string;
    active: boolean;
    closed: boolean;
    tokenIds: string[];
    startMs: number | null;
    endMs: number | null;
    score: number;
  }[] = [];

  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const slugRaw = String(o.slug ?? '').trim();
    const slug = slugRaw.toLowerCase();
    if (!slugRaw) continue;
    // Must be an up/down style market.
    const title = String(o.title ?? o.question ?? '');
    const hay = `${slug} ${title}`.toLowerCase();
    if (!hay.includes('up') || !hay.includes('down')) continue;
    if (!textNeedles.some((n) => hay.includes(n))) continue;

    const tokenIds = parseClobTokenIds(o.clobTokenIds ?? o.clob_token_ids);
    if (tokenIds.length < 2) continue;

    const active = o.active === true;
    const closed = o.closed === true;
    // Closed markets are never useful as a "shortcut".
    if (closed) continue;
    const startMs = parseIsoMs(o.startDate ?? o.start_date);
    const endMs = parseIsoMs(o.endDate ?? o.end_date);

    // Prefer open, active, and nearer-expiring markets.
    const now = Date.now();
    const endDelta = endMs != null ? Math.abs(endMs - now) : 9e15;
    const durMs = startMs != null && endMs != null ? Math.max(0, endMs - startMs) : null;
    let score = 0;
    if (active && !closed) score += 5;
    if (!closed) score += 2;
    if (slug.includes(`${slugNeedle}-updown-`)) score += 2;
    // Strongly prefer candidates whose window duration matches the requested interval.
    if (durMs != null && durMs > 0) {
      const ratio = Math.abs(durMs - targetDurMs) / targetDurMs; // 0 is perfect
      // within 10% => big boost; within 25% => medium; else penalize.
      if (ratio <= 0.1) score += 6;
      else if (ratio <= 0.25) score += 3;
      else score -= Math.min(6, ratio * 6);
    } else {
      // Unknown duration: mild penalty (still allow).
      score -= 1;
    }
    // nearer is better
    score += Math.max(0, 3 - Math.min(3, endDelta / (6 * 60 * 60 * 1000))); // within ~6h gets boost

    scored.push({ slug: slugRaw, active, closed, tokenIds, startMs, endMs, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0] ?? null;
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
  const m = /^([a-z0-9]{2,10})-updown-(5m|15m|1h|4h|1d)-(\d{9,12})$/.exec(s);
  if (!m) return null;
  const asset = m[1]!;
  const startSec = Number(m[3]!);
  if (!Number.isFinite(startSec)) return null;
  return { symbol: `${asset}/usd`, bucketStartMs: startSec * 1000 };
}

/** Polymarket hourly/daily "Up or Down" markets often use titled slugs (not `btc-updown-1h-*`). */
function titledUpdownStepSecFromSlug(slug: string): number | null {
  const s = slug.trim().toLowerCase();
  if (s.includes('-up-or-down-on-')) return 86400;
  if (/-\d{1,2}(am|pm)-et$/i.test(s)) return 3600;
  return null;
}

function titledUpdownSymbolFromSlug(slug: string): string | null {
  const s = slug.trim().toLowerCase();
  if (s.startsWith('bitcoin-')) return 'btc/usd';
  if (s.startsWith('ethereum-')) return 'eth/usd';
  if (s.startsWith('solana-')) return 'sol/usd';
  return null;
}

async function inferBucketFromTitledUpdownSlug(slug: string): Promise<{ symbol: string; bucketStartMs: number } | null> {
  const stepSec = titledUpdownStepSecFromSlug(slug);
  const sym = titledUpdownSymbolFromSlug(slug);
  if (!stepSec || !sym) return null;
  try {
    const m = (await gammaMarketBySlugOrId(slug)) as Record<string, unknown>;
    const endMs = parseIsoMs(m.endDate ?? m.end_date);
    if (endMs == null) return null;
    const endSec = Math.floor(endMs / 1000);
    return { symbol: sym, bucketStartMs: (endSec - stepSec) * 1000 };
  } catch {
    return null;
  }
}

function inferredBucketStartSecFromEnd(endMs: number | null, stepSec: number, fallbackSec: number): number {
  if (endMs == null || !Number.isFinite(endMs)) return fallbackSec;
  return Math.floor(endMs / 1000) - stepSec;
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
const RTDS_HIST_CAP = 2400;
let rtdsWs: WebSocket | null = null;
let rtdsWsStarting: Promise<void> | null = null;

function normalizeChainlinkTsMs(tsRaw: number): number {
  if (!Number.isFinite(tsRaw)) return Date.now();
  return tsRaw < 1e12 ? tsRaw * 1000 : tsRaw;
}

/** Normalize RTDS symbols: Chainlink uses `eth/usd`; Binance uses `ethusdt`. */
function canonicalCryptoSpotSymbol(raw: string): string | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^[a-z0-9]{2,12}\/usd$/.test(s)) return s;
  const binanceToSlash: Record<string, string> = {
    btcusdt: 'btc/usd',
    ethusdt: 'eth/usd',
    solusdt: 'sol/usd',
    xrpusdt: 'xrp/usd',
  };
  return binanceToSlash[s] ?? null;
}

function recordRtdsTick(symbol: string, value: number, tsRaw: number, source: RtdsPrice['source']): void {
  const sym = canonicalCryptoSpotSymbol(symbol);
  if (!sym) return;
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
      // Chainlink (slash symbols) + Binance (concat symbols) — both map into `btc/usd`, `eth/usd`, `sol/usd`.
      const chainlinkSubs = ['btc/usd', 'eth/usd', 'sol/usd'].map((symbol) => ({
        topic: 'crypto_prices_chainlink',
        type: '*',
        filters: JSON.stringify({ symbol }),
      }));
      // Filters must be JSON-shaped; comma lists like "btcusdt,ethusdt" reject the *entire* subscribe batch (no Chainlink).
      const binanceSub = { topic: 'crypto_prices', type: 'update' };
      ws.send(JSON.stringify({ action: 'subscribe', subscriptions: [...chainlinkSubs, binanceSub] }));
      resolve();
    };
    /** Official RTDS client uses lowercase `ping` every 5s; long intervals risk idle disconnects. */
    const pingEveryMs = 5_000;
    const pingId = setInterval(() => {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      } catch {
        /* ignore */
      }
    }, pingEveryMs);
    const stopPing = () => {
      try {
        clearInterval(pingId);
      } catch {
        /* ignore */
      }
    };
    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(String(ev.data)) as unknown;
        const batch = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of batch) {
          const msg = item as Record<string, unknown>;
          const topic = String(msg.topic ?? '');
          if (topic !== 'crypto_prices_chainlink' && topic !== 'crypto_prices') continue;
          const payload = (msg.payload ?? {}) as Record<string, unknown>;
          const msgType = String(msg.type ?? '');
          const symRaw = String(payload.symbol ?? '');

          // Initial history: { topic, type: "subscribe", payload: { symbol, data: [{timestamp,value}, ...] } }
          if (msgType === 'subscribe' && Array.isArray(payload.data) && symRaw) {
            const src: RtdsPrice['source'] = symRaw.includes('/') ? 'chainlink' : 'binance';
            for (const row of payload.data) {
              if (!row || typeof row !== 'object') continue;
              const ro = row as Record<string, unknown>;
              const t = Number(ro.timestamp);
              const val = Number(ro.value);
              if (Number.isFinite(t) && Number.isFinite(val)) recordRtdsTick(symRaw, val, t, src);
            }
            continue;
          }

          const value = Number(payload.value);
          const ts = Number(payload.timestamp ?? msg.timestamp);
          if (!symRaw || !Number.isFinite(value)) continue;
          recordRtdsTick(
            symRaw,
            value,
            Number.isFinite(ts) ? ts : Date.now(),
            topic === 'crypto_prices_chainlink' ? 'chainlink' : 'binance',
          );
        }
      } catch {
        /* ignore */
      }
    };
    ws.onerror = () => {
      stopPing();
      // allow restart
      rtdsWsStarting = null;
    };
    ws.onclose = () => {
      stopPing();
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

type CacheEntry<T> = { ts: number; value: T };

function cacheGet<T>(entry: CacheEntry<T> | null, ttlMs: number): T | null {
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlMs) return null;
  return entry.value;
}

function cacheSet<T>(value: T): CacheEntry<T> {
  return { ts: Date.now(), value };
}

// Local-only in-memory caches to avoid hammering Gamma / CLI on tight UI refresh loops.
let gammaReachableCache: CacheEntry<boolean> | null = null;
const marketsListCache = new Map<number, CacheEntry<unknown[]>>();

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
  const cachedGamma = cacheGet(gammaReachableCache, 30_000);
  let gammaOk = cachedGamma ?? false;
  if (cachedGamma == null) {
    try {
      const r = await fetch(`${GAMMA}/markets?limit=1`, { headers: { accept: 'application/json' } });
      gammaOk = r.ok;
    } catch {
      gammaOk = false;
    }
    gammaReachableCache = cacheSet(gammaOk);
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
  const cached = cacheGet(marketsListCache.get(limit) ?? null, 15_000);
  if (cached) return json(res, 200, { ok: true, data: cached });

  const out = await runCli(['--output', 'json', 'markets', 'list', '--limit', String(limit)]);
  if (out.ok) {
    try {
      const rows = marketsArrayFromStdout(out.stdout).map(normalizeMarket);
      marketsListCache.set(limit, cacheSet(rows));
      return json(res, 200, { ok: true, data: rows });
    } catch {
      /* fall through to HTTP */
    }
  }
  try {
    const rows = (await gammaMarketsList(limit)).map(normalizeMarket);
    marketsListCache.set(limit, cacheSet(rows));
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
  const allowed = ['5m', '15m', '1h', '4h', '1d'] as const;
  if (intervalParam !== '' && !(allowed as readonly string[]).includes(intervalParam)) {
    return json(res, 400, { ok: false, error: 'bad_interval', details: { allowed } });
  }
  const interval: '5m' | '15m' | '1h' | '4h' | '1d' =
    intervalParam === '15m' ? '15m' : intervalParam === '1h' ? '1h' : intervalParam === '4h' ? '4h' : intervalParam === '1d' ? '1d' : '5m';
  const stepSec = interval === '15m' ? 900 : interval === '1h' ? 3600 : interval === '4h' ? 4 * 3600 : interval === '1d' ? 24 * 3600 : 300;
  if (asset !== 'btc' && asset !== 'eth' && asset !== 'sol') {
    return json(res, 400, { ok: false, error: 'bad_asset', details: { allowed: ['btc', 'eth', 'sol'] } });
  }
  try {
    const b = nowBucketSec(stepSec);
    // NOTE: 1h/1d slugs are not perfectly consistent, but when the canonical
    // `asset-updown-<interval>-<bucket>` slug exists it is the most reliable
    // (fastest + correctly bucketed). We always try deterministic lookup first
    // for every interval, and only fall back to Gamma search when needed.
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
    if (stepSec === 900) {
      for (const o of [300, -300, 600, -600, 1500, -1500, 30 * 60, -30 * 60, 15 * 60, -15 * 60, 5 * 60, -5 * 60]) {
        for (const t0 of [base, base - 900, base + 900, base - 2 * 900, base + 2 * 900]) {
          tryTs.push(t0 + o);
        }
      }
    }
    const tryTsOrdered = Array.from(new Set(tryTs)).sort((a, c) => {
      const da = Math.abs(a - b.now);
      const dc = Math.abs(c - b.now);
      if (da !== dc) return da - dc;
      // When equally close, prefer the current/just-started bucket over the next one.
      // For longer windows (1h/4h/1d), opening a future bucket yields a market that may be "active"
      // but has a PTB bucket start in the future, which breaks client PTB/spot alignment.
      if (interval === '1h' || interval === '4h' || interval === '1d') {
        const aFuture = a > b.now;
        const cFuture = c > b.now;
        if (aFuture !== cFuture) return aFuture ? 1 : -1;
      }
      return a - c;
    });
    // First try the deterministic slug rather than Gamma search (which can lag).
    for (const ts of tryTsOrdered) {
      // For longer windows, do not select a future bucket start. Some markets open early with a live book,
      // but PTB/spot alignment is defined by the *current* bucket start.
      if ((interval === '1h' || interval === '4h' || interval === '1d') && ts > b.now + 60) continue;
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
    if (interval === '1d') {
      const q = UPDOWN_1D_SEARCH[asset];
      const raw = await gammaSearchMarkets(q, 25, 260);
      const rows = dedupeSearchRows(flattenSearchMarketRows(raw));
      const best = pickBestUpdownGeneral(rows, asset, '1d');
      if (!best) {
        return json(res, 404, { ok: false, error: 'no_updown_1d', details: { asset, interval, q } });
      }
      const t0 = best.tokenIds[0];
      if (t0 && !(await clobHasOrderbook(t0))) {
        return json(res, 404, { ok: false, error: 'no_updown_1d_book', details: { asset, interval, slug: best.slug } });
      }
      const inferredStart = inferredBucketStartSecFromEnd(
        best.endMs,
        stepSec,
        best.startMs != null ? Math.floor(best.startMs / 1000) : b.floor,
      );
      const inferredEndSec = best.endMs != null ? Math.floor(best.endMs / 1000) : inferredStart + stepSec;
      return json(res, 200, {
        ok: true,
        data: {
          slug: best.slug,
          asset,
          interval,
          window: interval,
          tested: true,
          active: best.active,
          closed: best.closed,
          inferred_window_start_unix: inferredStart,
          inferred_end_unix: inferredEndSec,
          start: new Date(inferredStart * 1000).toISOString(),
          end: new Date(inferredEndSec * 1000).toISOString(),
          bucket_now_unix: b.now,
          bucket_floor_unix: b.floor,
          bucket_ceil_unix: b.ceil,
        },
      });
    }

    const q =
      interval === '15m'
        ? UPDOWN_15M_SEARCH[asset]
        : interval === '4h'
          ? UPDOWN_4H_SEARCH[asset]
          : interval === '1h'
            ? (UPDOWN_1H_SEARCH[asset][0] ?? `${asset} hourly up or down`)
            : UPDOWN_5M_SEARCH[asset];
    const raw = await gammaSearchMarkets(q, 25, interval === '1h' ? 260 : 180);
    const rows = dedupeSearchRows(flattenSearchMarketRows(raw));
    const candidates = rankUpdownCandidates(rows, asset, interval);
    if (candidates.length === 0) {
      // 1h markets sometimes don't use the canonical `asset-updown-1h-<bucket>` slug format.
      // Fall back to a broader search and pick the best open candidate with a live book.
      if (interval === '1h') {
        const qs = UPDOWN_1H_SEARCH[asset];
        let best:
          | { slug: string; active: boolean; closed: boolean; tokenIds: string[]; startMs: number | null; endMs: number | null }
          | null = null;
        let qUsed = qs[0] ?? q;
        for (const qq of qs) {
          qUsed = qq;
          const raw2 = await gammaSearchMarkets(qq, 25, 320);
          const rows2 = dedupeSearchRows(flattenSearchMarketRows(raw2));
          best = pickBestUpdownGeneral(rows2, asset, '1h');
          if (best) break;
        }
        if (best) {
          const t0 = best.tokenIds[0];
          if (t0 && (await clobHasOrderbook(t0))) {
            const inferredStart = inferredBucketStartSecFromEnd(
              best.endMs,
              stepSec,
              best.startMs != null ? Math.floor(best.startMs / 1000) : b.floor,
            );
            const inferredEndSec = best.endMs != null ? Math.floor(best.endMs / 1000) : inferredStart + stepSec;
            return json(res, 200, {
              ok: true,
              data: {
                slug: best.slug,
                asset,
                interval,
                window: interval,
                tested: true,
                active: best.active,
                closed: best.closed,
                inferred_window_start_unix: inferredStart,
                inferred_end_unix: inferredEndSec,
                start: new Date(inferredStart * 1000).toISOString(),
                end: new Date(inferredEndSec * 1000).toISOString(),
                bucket_now_unix: b.now,
                bucket_floor_unix: b.floor,
                bucket_ceil_unix: b.ceil,
                search_q: qUsed,
              },
            });
          }
        }
      }
      // Final fallback: scan Gamma “active markets” list and pick the best matching duration.
      // This is slower but tends to be more reliable than search when titles/slugs vary.
      if (interval === '1h') {
        try {
          const rows3 = (await gammaMarketsList(450)).map(normalizeMarket);
          const best3 = pickBestUpdownGeneral(rows3, asset, '1h');
          if (best3) {
            const t0 = best3.tokenIds[0];
            if (t0 && (await clobHasOrderbook(t0))) {
              const inferredStart = inferredBucketStartSecFromEnd(
                best3.endMs,
                stepSec,
                best3.startMs != null ? Math.floor(best3.startMs / 1000) : b.floor,
              );
              const inferredEndSec = best3.endMs != null ? Math.floor(best3.endMs / 1000) : inferredStart + stepSec;
              return json(res, 200, {
                ok: true,
                data: {
                  slug: best3.slug,
                  asset,
                  interval,
                  window: interval,
                  tested: true,
                  active: best3.active,
                  closed: best3.closed,
                  inferred_window_start_unix: inferredStart,
                  inferred_end_unix: inferredEndSec,
                  start: new Date(inferredStart * 1000).toISOString(),
                  end: new Date(inferredEndSec * 1000).toISOString(),
                  bucket_now_unix: b.now,
                  bucket_floor_unix: b.floor,
                  bucket_ceil_unix: b.ceil,
                  source: 'gamma_markets_list',
                },
              });
            }
          }
        } catch {
          /* ignore */
        }
      }
      return json(res, 404, {
        ok: false,
        error:
          interval === '15m'
            ? 'no_updown_15m'
            : interval === '4h'
              ? 'no_updown_4h'
              : interval === '1h'
                ? 'no_updown_1h'
                : 'no_updown_5m',
        details: { asset, interval, q },
      });
    }
    const target = b.floor;

    const ordered = [...candidates].sort((a, b2) => {
      const aDist = Math.abs(a.ts - target);
      const bDist = Math.abs(b2.ts - target);
      if (aDist !== bDist) return aDist - bDist;
      // When tied, prefer the current/previous bucket for longer windows to avoid selecting
      // a future-starting market that can appear "active" but doesn't line up with the current PTB bucket.
      const aPast = a.ts < target;
      const bPast = b2.ts < target;
      if (aPast !== bPast) {
        if (interval === '1h' || interval === '4h') return aPast ? -1 : 1;
        return aPast ? 1 : -1;
      }
      return b2.ts - a.ts;
    });

    // Prefer a candidate with an actual CLOB orderbook; test a few closest buckets.
    for (const c of ordered.slice(0, 10)) {
      if ((interval === '1h' || interval === '4h') && c.ts > b.now + 60) continue;
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
    let b = parseUpdownBucketFromSlug(slug);
    if (!b) b = await inferBucketFromTitledUpdownSlug(slug);
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
  let v = rtdsCache.get(symbol);
  // First ticks can lag a few hundred ms after subscribe; short wait avoids empty charts on cold load.
  if (!v && rtdsWs && rtdsWs.readyState === WebSocket.OPEN) {
    for (let i = 0; i < 16 && !v; i++) {
      await new Promise<void>((r) => setTimeout(r, 75));
      v = rtdsCache.get(symbol);
    }
  }
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

function toPrice01Maybe(v: unknown): number | null {
  const n = parseNumber('price', v);
  if (n == null) return null;
  if (n > 0 && n <= 1) return n;
  if (n > 1 && n <= 100) return n / 100;
  return null;
}

function roundPrice01Api(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function floorSizeShares4(n: number): number {
  return Math.floor(n * 10_000 + 1e-12) / 10_000;
}

function roundSizeShares4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function toHumanAmount(raw: unknown, decimals: number): string | null {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return null;
  const denom = 10 ** decimals;
  return String(n / denom);
}

function normalizeAmountMaybe(raw: unknown, decimals: number, _kind: 'collateral' | 'conditional'): string | null {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n)) return null;
  // CLOB balances are usually smallest-unit integers (e.g. 6dp → 12.94 shares as "12940000").
  // Human values are typically decimals ("12.94") or small whole numbers ("5") and must not be divided.
  const str = typeof raw === 'string' ? raw.trim() : '';
  const intOk =
    (typeof raw === 'string' && /^-?\d+$/.test(str) && !/[eE]/.test(str)) ||
    (typeof raw === 'number' && Number.isInteger(n));
  if (!intOk) {
    return String(n);
  }
  const minRaw = 10 ** Math.max(0, decimals - 2);
  if (Math.abs(n) < minRaw) {
    return String(n);
  }
  return toHumanAmount(n, decimals) ?? String(n);
}

type ClobBookLevel = { price?: string; size?: string };

function bestAskBestBidFromBook(book: unknown): { bestAsk: number | null; bestBid: number | null } {
  const b = book as { asks?: ClobBookLevel[]; bids?: ClobBookLevel[] };
  let bestAsk: number | null = null;
  for (const a of b.asks ?? []) {
    const p = Number(a.price);
    if (Number.isFinite(p) && p > 0 && p < 1) {
      if (bestAsk == null || p < bestAsk) bestAsk = p;
    }
  }
  let bestBid: number | null = null;
  for (const x of b.bids ?? []) {
    const p = Number(x.price);
    if (Number.isFinite(p) && p > 0 && p < 1) {
      if (bestBid == null || p > bestBid) bestBid = p;
    }
  }
  return { bestAsk, bestBid };
}

function extractOrderIdFromClobPayload(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const pick = (o: Record<string, unknown>): string | null => {
    for (const k of ['orderID', 'orderId', 'order_id', 'id'] as const) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };
  const root = obj as Record<string, unknown>;
  const direct = pick(root);
  if (direct) return direct;
  for (const k of ['order', 'data', 'result', 'payload', 'response'] as const) {
    const v = root[k];
    if (v && typeof v === 'object') {
      const got = pick(v as Record<string, unknown>);
      if (got) return got;
      for (const k2 of ['order', 'data', 'result'] as const) {
        const vv = (v as Record<string, unknown>)[k2];
        if (vv && typeof vv === 'object') {
          const got2 = pick(vv as Record<string, unknown>);
          if (got2) return got2;
        }
      }
    }
  }
  return null;
}

function parseTickSizeOrDefault(tickStr: string): number {
  const t = Number(tickStr);
  return Number.isFinite(t) && t > 0 && t < 1 ? t : 0.01;
}

function parseTickSizeFromBook(book: unknown): '0.1' | '0.01' | '0.001' | '0.0001' | null {
  if (!book || typeof book !== 'object') return null;
  const raw = String((book as { tick_size?: unknown }).tick_size ?? '').trim();
  if (raw === '0.1' || raw === '0.01' || raw === '0.001' || raw === '0.0001') return raw;
  return null;
}

function parseNegRiskFromBook(book: unknown): boolean | null {
  if (!book || typeof book !== 'object') return null;
  const v = (book as { neg_risk?: unknown }).neg_risk;
  return typeof v === 'boolean' ? v : null;
}

function builderCodeFromEnv(): string | undefined {
  const raw = String(process.env.POLYMARKET_BUILDER_CODE ?? '').trim();
  if (!raw) return undefined;
  return /^0x[0-9a-fA-F]{64}$/.test(raw) ? raw : undefined;
}

/** When SDK-walked depth fails the matcher, cross with an explicit limit just past the touch (tick-aligned). */
function slipExplicitBuyPrice(bestAsk: number, tick: number): number {
  const maxP = Math.min(0.99, 1 - tick);
  const cushion = Math.max(tick * 22, 0.012, bestAsk * 0.025);
  const target = Math.min(maxP, bestAsk + cushion);
  let out = Math.ceil((target + 1e-12) / tick) * tick;
  out = Math.min(maxP, Math.max(bestAsk, out));
  // If rounding collapsed to the touch, step one tick up so the matcher sees a true cross.
  if (out <= bestAsk + 1e-12 && out + tick <= maxP + 1e-12) out = Math.min(maxP, out + tick);
  return out;
}

function slipExplicitSellPrice(bestBid: number, tick: number): number {
  const minP = Math.max(0.01, tick);
  const cushion = Math.max(tick * 22, 0.012, bestBid * 0.025);
  const target = Math.max(minP, bestBid - cushion);
  let out = Math.floor((target - 1e-12) / tick) * tick;
  out = Math.max(minP, Math.min(bestBid, out));
  if (out >= bestBid - 1e-12 && out - tick >= minP - 1e-12) out = Math.max(minP, out - tick);
  return out;
}

function isLiquidityClassMarketError(msg: string): boolean {
  return (
    /no orders found/i.test(msg) ||
    /no match/i.test(msg) ||
    /FAK/i.test(msg) ||
    /FOK/i.test(msg) ||
    /fully filled/i.test(msg) ||
    /killed/i.test(msg)
  );
}

type FakMarketPayload = {
  tokenID: string;
  amount: number;
  side: Side;
  orderType: typeof OrderType.FAK;
  price?: number;
  userUSDCBalance?: number;
  builderCode?: string;
};

/** `createAndPostOrder` / `createAndPostMarketOrder` post-options — see Polymarket `clob-client` README on GitHub. */
async function clobOrderBuilderOptions(
  client: ClobClient,
  tokenId: string,
): Promise<Pick<CreateOrderOptions, 'tickSize' | 'negRisk'>> {
  try {
    const book = await client.getOrderBook(tokenId);
    const tickSize = parseTickSizeFromBook(book);
    const negRisk = parseNegRiskFromBook(book);
    if (tickSize != null && negRisk != null) return { tickSize, negRisk };
  } catch {
    /* fallback below */
  }
  const [tickSize, negRisk] = await Promise.all([client.getTickSize(tokenId), client.getNegRisk(tokenId)]);
  return { tickSize, negRisk };
}

/**
 * Prefer an explicit tick-aligned cross price from the live book on every market order.
 * Skips SDK-only `calculateMarketPrice` when possible — that path often disagrees with the matcher by a tick.
 */
async function attachBookCrossPricePrefer(client: ClobClient, base: FakMarketPayload): Promise<FakMarketPayload> {
  if (base.price != null && Number.isFinite(base.price) && base.price > 0 && base.price < 1) return base;
  try {
    const book = await client.getOrderBook(base.tokenID);
    const tick = parseTickSizeOrDefault(parseTickSizeFromBook(book) ?? '0.01');
    const { bestAsk, bestBid } = bestAskBestBidFromBook(book);
    if (base.side === Side.BUY && bestAsk != null) {
      return { ...base, price: slipExplicitBuyPrice(bestAsk, tick) };
    }
    if (base.side === Side.SELL && bestBid != null) {
      return { ...base, price: slipExplicitSellPrice(bestBid, tick) };
    }
  } catch {
    /* SDK will derive price inside createMarketOrder */
  }
  return base;
}

async function createAndPostMarketOrderWithBookSlippage(client: ClobClient, base: FakMarketPayload): Promise<unknown> {
  const ob = await clobOrderBuilderOptions(client, base.tokenID);
  try {
    return await client.createAndPostMarketOrder(base, ob, OrderType.FAK);
  } catch (first) {
    const msg = first instanceof Error ? first.message : String(first);
    if (!isLiquidityClassMarketError(msg)) throw first;

    const book = await client.getOrderBook(base.tokenID);
    const tick = parseTickSizeOrDefault(parseTickSizeFromBook(book) ?? '0.01');
    const { bestAsk, bestBid } = bestAskBestBidFromBook(book);

    let slip: number | null = null;
    if (base.side === Side.BUY) {
      if (bestAsk == null) throw first;
      slip = slipExplicitBuyPrice(bestAsk, tick);
    } else {
      if (bestBid == null) throw first;
      slip = slipExplicitSellPrice(bestBid, tick);
    }

    const slipped = { ...base, price: slip, orderType: OrderType.FAK as const };
    try {
      return await client.createAndPostMarketOrder(slipped, ob, OrderType.FAK);
    } catch {
      return await client.createAndPostMarketOrder(
        { ...slipped, orderType: OrderType.FOK as const },
        ob,
        OrderType.FOK,
      );
    }
  }
}

/** CLOB balance + allowance for Max / Available (pUSD or outcome shares). */
app.get('/api/trade/balance-allowance', async (req, res) => {
  const tokenId = String(req.query.token_id ?? '').trim();
  const raw = String(req.query.asset_type ?? 'conditional').trim().toLowerCase();
  const assetType = raw === 'collateral' ? AssetType.COLLATERAL : AssetType.CONDITIONAL;
  const marketSlug = String(req.query.market_slug ?? '').trim();
  const outcome = String(req.query.outcome ?? '').trim();
  if (assetType === AssetType.CONDITIONAL && !tokenId) {
    return json(res, 400, { ok: false, error: 'missing_token_id', details: { hint: 'Pass token_id for outcome (conditional) balance.' } });
  }

  // Optional: when POLYMARKET_USE_BULLPEN=true, Bullpen positions for slug+outcome (must hit a row or we fall through to CLOB).
  if (assetType === AssetType.CONDITIONAL && marketSlug && outcome && polymarketUseBullpen()) {
    const cached = cachedBullpenPositionsOrNull();
    if (!cached) await refreshBullpenPositions({ force: true });
    else void refreshBullpenPositions();

    const arr = (cachedBullpenPositionsOrNull()?.positions ?? []) as Record<string, unknown>[];
    const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
    const hit = arr.find((p) => {
      if (!p || typeof p !== 'object') return false;
      const o = p as Record<string, unknown>;
      const slug = norm(o.slug ?? o.market_slug ?? o.marketSlug ?? o.market);
      const out = norm(o.outcome ?? o.outcome_name ?? o.outcomeName);
      return slug === norm(marketSlug) && out === norm(outcome);
    }) as Record<string, unknown> | undefined;
    if (hit) {
      const size = parseNumber('size', hit.size ?? hit.shares ?? hit.position ?? hit.quantity) ?? 0;
      return json(res, 200, { ok: true, data: { balance: String(size), allowance: '' } });
    }
    // No matching Bullpen row — use CLOB balance (avoids false zero vs Polymarket).
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

function tradeMatchTimeMs(trade: Record<string, unknown>): number {
  const raw = trade.match_time ?? trade.last_update ?? trade.timestamp;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  return 0;
}

function tradeInvolvesAddresses(trade: Record<string, unknown>, addrs: Set<string>): boolean {
  const owner = typeof trade.owner === 'string' ? trade.owner.toLowerCase() : '';
  const makerRoot = typeof trade.maker_address === 'string' ? trade.maker_address.toLowerCase() : '';
  if (owner && addrs.has(owner)) return true;
  if (makerRoot && addrs.has(makerRoot)) return true;
  const mos = trade.maker_orders;
  if (Array.isArray(mos)) {
    for (const mo of mos) {
      if (!mo || typeof mo !== 'object') continue;
      const m = mo as Record<string, unknown>;
      const ma = typeof m.maker_address === 'string' ? m.maker_address.toLowerCase() : '';
      const ow = typeof m.owner === 'string' ? m.owner.toLowerCase() : '';
      if ((ma && addrs.has(ma)) || (ow && addrs.has(ow))) return true;
    }
  }
  return false;
}

/** Paginated CLOB trades for one outcome token (same tape Polymarket uses for fills / profile). */
async function clobListTradesForAssetId(client: ClobClient, tokenId: string, maxPages: number): Promise<Record<string, unknown>[]> {
  const params: TradeParams = { asset_id: tokenId };
  const items: Record<string, unknown>[] = [];
  let cursor: string | undefined = undefined;
  for (let page = 0; page < maxPages; page++) {
    const batch = await client.getTradesPaginated(params as never, cursor);
    for (const tr of batch.trades) items.push(tr as unknown as Record<string, unknown>);
    const next = batch.next_cursor;
    if (!next || next === 'LTE=' || batch.trades.length === 0) break;
    cursor = next;
  }
  items.sort((a, b) => tradeMatchTimeMs(a) - tradeMatchTimeMs(b));
  return items;
}

type OrderFillIndexEntry = {
  shares: number;
  avg_price_01: number;
  side: 'buy' | 'sell';
  updated_at_ms: number;
};

/** VWAP fill per CLOB order id (taker_order_id or maker resting id) for reconciliation with local UI history. */
function buildOrderFillIndexFromTrades(
  items: Record<string, unknown>[],
  tokenId: string,
  myAddrs: Set<string>,
): Record<string, OrderFillIndexEntry> {
  type Cell = { sz: number; pxSz: number; t: number; side: 'buy' | 'sell' };
  const map = new Map<string, Cell>();

  const anyAddrHit = items.some((t) => String(t.asset_id ?? '') === tokenId && tradeInvolvesAddresses(t, myAddrs));

  const bump = (orderId: string, shares: number, price01: number, side: 'buy' | 'sell', at: number) => {
    if (!orderId || shares <= 0 || price01 <= 0 || price01 >= 1) return;
    const cur = map.get(orderId);
    if (!cur) {
      map.set(orderId, { sz: shares, pxSz: shares * price01, t: at, side });
      return;
    }
    cur.sz += shares;
    cur.pxSz += shares * price01;
    cur.t = Math.max(cur.t, at);
    map.set(orderId, cur);
  };

  for (const trade of items) {
    if (String(trade.asset_id ?? '') !== tokenId) continue;
    if (anyAddrHit && !tradeInvolvesAddresses(trade, myAddrs)) continue;

    const owner = typeof trade.owner === 'string' ? trade.owner.toLowerCase() : '';
    const isTaker = Boolean(owner && myAddrs.has(owner));
    const mos = trade.maker_orders;
    const myMakerOrders: Record<string, unknown>[] = [];
    if (Array.isArray(mos)) {
      for (const mo of mos) {
        if (!mo || typeof mo !== 'object') continue;
        const m = mo as Record<string, unknown>;
        const ma = typeof m.maker_address === 'string' ? m.maker_address.toLowerCase() : '';
        const ow = typeof m.owner === 'string' ? m.owner.toLowerCase() : '';
        const asset = String(m.asset_id ?? '');
        if (asset !== tokenId) continue;
        if ((ma && myAddrs.has(ma)) || (ow && myAddrs.has(ow))) myMakerOrders.push(m);
      }
    }
    const isMaker = myMakerOrders.length > 0;
    if (!isTaker && !isMaker) continue;

    const tradeSideRaw = String(trade.side ?? '').toUpperCase();
    const takerIsBuy = tradeSideRaw === 'BUY' || tradeSideRaw === 'B';
    const takerIsSell = tradeSideRaw === 'SELL' || tradeSideRaw === 'S';
    if (!takerIsBuy && !takerIsSell) continue;

    const effectiveIsBuy = isMaker ? takerIsSell : takerIsBuy;
    const at = tradeMatchTimeMs(trade);

    if (isTaker) {
      const price01 = toPrice01Maybe(trade.price);
      if (price01 == null) continue;
      const sizeRaw = trade.size ?? trade.amount ?? trade.quantity;
      const sizeNorm = normalizeAmountMaybe(sizeRaw, CONDITIONAL_TOKEN_DECIMALS, 'conditional');
      const size = parseNumber('size', sizeNorm ?? sizeRaw);
      if (size == null || size <= 0) continue;
      const side: 'buy' | 'sell' = effectiveIsBuy ? 'buy' : 'sell';
      const oid = String(trade.taker_order_id ?? (trade as { takerOrderId?: unknown }).takerOrderId ?? '').trim();
      if (oid) bump(oid, size, price01, side, at);
      continue;
    }

    if (isMaker) {
      for (const m of myMakerOrders) {
        const mo = m as Record<string, unknown>;
        const oid = String(mo.order_id ?? mo.orderId ?? '').trim();
        if (!oid) continue;
        const p01 = toPrice01Maybe(mo.price);
        if (p01 == null) continue;
        const raw = (mo.matched_amount ?? mo.matchedAmount ?? mo.size ?? mo.amount ?? mo.quantity) as unknown;
        const norm = normalizeAmountMaybe(raw, CONDITIONAL_TOKEN_DECIMALS, 'conditional');
        const sz = parseNumber('size', norm ?? raw);
        if (sz == null || sz <= 0) continue;
        const moSide = String(mo.side ?? '').toUpperCase();
        const side: 'buy' | 'sell' = moSide === 'SELL' || moSide === 'S' ? 'sell' : 'buy';
        bump(oid, sz, p01, side, at);
      }
    }
  }

  const out: Record<string, OrderFillIndexEntry> = {};
  for (const [k, v] of map) {
    if (v.sz <= 0) continue;
    out[k] = {
      shares: roundSizeShares4(v.sz),
      avg_price_01: roundPrice01Api(v.pxSz / v.sz),
      side: v.side,
      updated_at_ms: v.t,
    };
  }
  return out;
}

/** Avg entry price (cost basis) for current user and token (0..1), from CLOB `/data/trades` for this `asset_id`. */
app.get('/api/trade/avg-entry', async (req, res) => {
  const tokenId = String(req.query.token_id ?? '').trim();
  if (!tokenId) return json(res, 400, { ok: false, error: 'missing_token_id' });
  const marketSlug = String(req.query.market_slug ?? '').trim();
  const outcome = String(req.query.outcome ?? '').trim();

  const cacheKey = `${tokenId}`;
  const cached = avgEntryCache.get(cacheKey);
  // Serve cached values aggressively to keep UI instant.
  // (We still refresh frequently elsewhere via WS triggers + manual refresh.)
  if (cached && Date.now() - cached.at < 20_000) {
    return json(res, 200, { ok: true, data: cached.data });
  }

  // Fast-path: Polymarket Data API positions (matches what the UI shows).
  // This is both quicker and more accurate than reconstructing cost basis from a limited trade tape window.
  try {
    const cfg = getTradingConfigFromEnv();
    if (cfg.ok) {
      const addrs = [cfg.config.funderAddress, cfg.config.signerAddress]
        .map((x) => String(x ?? '').trim())
        .filter(Boolean);
      const uniq = Array.from(new Set(addrs.map((a) => a.toLowerCase())));
      const tryAddr = async (addr: string) => {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 1400);
        try {
          // `sizeThreshold=0` can return a huge payload (including closed positions) and be slow.
          // Use a tiny threshold so we still include small positions but skip zeros.
          const url = `${DATA_API}/positions?user=${encodeURIComponent(addr)}&sizeThreshold=0.0001`;
          const r = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
          if (!r.ok) return null;
          const rows = (await r.json()) as unknown;
          if (!Array.isArray(rows)) return null;
          const hit = rows.find((x) => {
            if (!x || typeof x !== 'object') return false;
            const o = x as Record<string, unknown>;
            const asset = String(o.asset ?? o.asset_id ?? o.assetId ?? '').trim();
            return asset === tokenId;
          }) as Record<string, unknown> | undefined;
          if (!hit) return null;
          const avg = toPrice01Maybe(
            hit.avgPrice ?? hit.avg_price ?? hit.avgEntry ?? hit.avg_entry ?? hit.entry_price ?? hit.entryPrice,
          );
          const shares = parseNumber('size', hit.size ?? hit.shares ?? hit.position ?? hit.quantity) ?? 0;
          if (!(shares > 0)) return null;
          return { tokenId, avgEntry: avg, shares: roundSizeShares4(shares) };
        } catch {
          return null;
        } finally {
          clearTimeout(t);
        }
      };

      const hits = await Promise.all(uniq.map((a) => tryAddr(a)));
      const hit = hits.find(Boolean);
      if (hit) {
        avgEntryCache.set(cacheKey, { at: Date.now(), data: hit });
        return json(res, 200, { ok: true, data: hit });
      }
    }
  } catch {
    // Fall through to Bullpen/CLOB reconstruction.
  }

  if (marketSlug && outcome && polymarketUseBullpen()) {
    const cached = cachedBullpenPositionsOrNull();
    if (!cached) await refreshBullpenPositions({ force: true });
    else void refreshBullpenPositions();

    const arr = (cachedBullpenPositionsOrNull()?.positions ?? []) as Record<string, unknown>[];
    if (arr.length > 0) {
      const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
      const hit = arr.find((p) => {
        if (!p || typeof p !== 'object') return false;
        const o = p as Record<string, unknown>;
        const slug = norm(o.slug ?? o.market_slug ?? o.marketSlug ?? o.market);
        const out = norm(o.outcome ?? o.outcome_name ?? o.outcomeName);
        return slug === norm(marketSlug) && out === norm(outcome);
      }) as Record<string, unknown> | undefined;
      if (hit) {
        const avg = toPrice01Maybe(hit.avg_entry ?? hit.avgEntry ?? hit.entry_price ?? hit.entryPrice ?? hit.avg_price ?? hit.avgPrice);
        const shares = parseNumber('size', hit.size ?? hit.shares ?? hit.position ?? hit.quantity) ?? 0;
        return json(res, 200, { ok: true, data: { tokenId, avgEntry: avg, shares: roundSizeShares4(shares) } });
      }
    }
    // fall through to CLOB-derived avg when Bullpen off, empty, or no matching row
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
    const funder = ready.config.funderAddress.toLowerCase();
    const signer = ready.config.signerAddress.toLowerCase();
    const myAddrs = new Set([funder, signer].filter(Boolean));

    const items = await clobListTradesForAssetId(ready.client, tokenId, 24);

    const anyAddrHit = items.some((t) => String(t.asset_id ?? '') === tokenId && tradeInvolvesAddresses(t, myAddrs));

    let pos = 0;
    let cost = 0;
    for (const trade of items) {
      if (String(trade.asset_id ?? '') !== tokenId) continue;
      if (anyAddrHit && !tradeInvolvesAddresses(trade, myAddrs)) continue;

      // Trade payload side is from the taker perspective. If we are a maker on this fill,
      // our effective side is the opposite (maker sells to a BUY taker, and vice versa).
      const owner = typeof trade.owner === 'string' ? trade.owner.toLowerCase() : '';
      const isTaker = owner && myAddrs.has(owner);
      const mos = trade.maker_orders;
      const myMakerOrders: Record<string, unknown>[] = [];
      if (Array.isArray(mos)) {
        for (const mo of mos) {
          if (!mo || typeof mo !== 'object') continue;
          const m = mo as Record<string, unknown>;
          const ma = typeof m.maker_address === 'string' ? m.maker_address.toLowerCase() : '';
          const ow = typeof m.owner === 'string' ? m.owner.toLowerCase() : '';
          const asset = String(m.asset_id ?? '');
          if (asset !== tokenId) continue;
          if ((ma && myAddrs.has(ma)) || (ow && myAddrs.has(ow))) myMakerOrders.push(m);
        }
      }
      const isMaker = myMakerOrders.length > 0;
      if (!isTaker && !isMaker) continue;

      const tradeSideRaw = String(trade.side ?? '').toUpperCase();
      const takerIsBuy = tradeSideRaw === 'BUY' || tradeSideRaw === 'B';
      const takerIsSell = tradeSideRaw === 'SELL' || tradeSideRaw === 'S';
      if (!takerIsBuy && !takerIsSell) continue;

      const effectiveIsBuy = isMaker ? takerIsSell : takerIsBuy;
      const effectiveIsSell = isMaker ? takerIsBuy : takerIsSell;

      const price =
        // Prefer maker order price when we are maker (more reliable for our fills).
        isMaker ? parseNumber('price', myMakerOrders[0]?.price) : parseNumber('price', trade.price);
      if (price == null || price <= 0 || price >= 1) continue;

      // Size should be OUR matched amount, not necessarily the whole trade size.
      let size: number | null = null;
      if (isMaker) {
        let sum = 0;
        for (const m of myMakerOrders) {
          const raw = (m.matched_amount ?? m.matchedAmount ?? m.size ?? m.amount ?? m.quantity) as unknown;
          const norm = normalizeAmountMaybe(raw, CONDITIONAL_TOKEN_DECIMALS, 'conditional');
          const s = parseNumber('size', norm ?? raw);
          if (s != null && s > 0) sum += s;
        }
        size = sum > 0 ? sum : null;
      } else {
        const sizeRaw = trade.size ?? trade.amount ?? trade.quantity;
        const sizeNorm = normalizeAmountMaybe(sizeRaw, CONDITIONAL_TOKEN_DECIMALS, 'conditional');
        size = parseNumber('size', sizeNorm ?? sizeRaw);
      }
      if (size == null || size <= 0) continue;

      if (effectiveIsBuy) {
        pos += size;
        cost += size * price;
      } else if (effectiveIsSell) {
        if (pos <= 0) continue;
        const avg = cost / pos;
        const qty = Math.min(size, pos);
        cost -= qty * avg;
        pos -= qty;
      }
    }

    const avgEntry = pos > 0 ? roundPrice01Api(cost / pos) : null;
    const sharesOut = roundSizeShares4(pos);
    const data = { tokenId, avgEntry, shares: sharesOut };
    avgEntryCache.set(cacheKey, { at: Date.now(), data });
    return json(res, 200, { ok: true, data });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      error: 'avg_entry_failed',
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
});

/**
 * Canonical fill snapshot per CLOB order id (from the same `/data` trades feed as Polymarket profile).
 * Lets the web UI overwrite optimistic rows so shares/avg match the exchange.
 */
app.get('/api/trade/order-fill-index', async (req, res) => {
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
    const funder = ready.config.funderAddress.toLowerCase();
    const signer = ready.config.signerAddress.toLowerCase();
    const myAddrs = new Set([funder, signer].filter(Boolean));
    const items = await clobListTradesForAssetId(ready.client, tokenId, 28);
    const by_order_id = buildOrderFillIndexFromTrades(items, tokenId, myAddrs);
    return json(res, 200, { ok: true, data: { token_id: tokenId, by_order_id } });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      error: 'order_fill_index_failed',
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
});

type MyFillRow = {
  token_id: string;
  order_id: string;
  side: 'buy' | 'sell';
  price_01: number;
  shares: number;
  match_time_ms: number;
  role: 'taker' | 'maker';
};

/**
 * Confirmed fills for the authenticated wallet, derived from the same CLOB trades tape Polymarket uses.
 * Returns the most recent fills for one outcome token (asset_id).
 */
app.get('/api/trade/my-fills', async (req, res) => {
  const tokenId = String(req.query.token_id ?? '').trim();
  if (!tokenId) return json(res, 400, { ok: false, error: 'missing_token_id' });
  const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? '40'), 10) || 40));

  const ready = await getTradingClient();
  if (!ready.ok) {
    return json(res, ready.error === 'trading_auth_failed' ? 502 : 503, {
      ok: false,
      error: ready.error,
      details: { hint: ready.hint, reason: ready.details },
    });
  }

  try {
    const funder = ready.config.funderAddress.toLowerCase();
    const signer = ready.config.signerAddress.toLowerCase();
    const myAddrs = new Set([funder, signer].filter(Boolean));

    const items = await clobListTradesForAssetId(ready.client, tokenId, 28);
    const out: MyFillRow[] = [];

    for (const trade of items) {
      if (String(trade.asset_id ?? '') !== tokenId) continue;
      if (!tradeInvolvesAddresses(trade, myAddrs)) continue;

      const owner = typeof trade.owner === 'string' ? trade.owner.toLowerCase() : '';
      const isTaker = Boolean(owner && myAddrs.has(owner));
      const mos = trade.maker_orders;
      const myMakerOrders: Record<string, unknown>[] = [];
      if (Array.isArray(mos)) {
        for (const mo of mos) {
          if (!mo || typeof mo !== 'object') continue;
          const m = mo as Record<string, unknown>;
          const ma = typeof m.maker_address === 'string' ? m.maker_address.toLowerCase() : '';
          const ow = typeof m.owner === 'string' ? m.owner.toLowerCase() : '';
          const asset = String(m.asset_id ?? '');
          if (asset !== tokenId) continue;
          if ((ma && myAddrs.has(ma)) || (ow && myAddrs.has(ow))) myMakerOrders.push(m);
        }
      }
      const isMaker = myMakerOrders.length > 0;
      if (!isTaker && !isMaker) continue;

      const px = toPrice01Maybe(trade.price);
      if (px == null) continue;

      const tradeSideRaw = String(trade.side ?? '').toUpperCase();
      const takerIsBuy = tradeSideRaw === 'BUY' || tradeSideRaw === 'B';
      const takerIsSell = tradeSideRaw === 'SELL' || tradeSideRaw === 'S';
      if (!takerIsBuy && !takerIsSell) continue;

      const at = tradeMatchTimeMs(trade);

      // If we were taker, emit one fill row keyed by taker_order_id.
      if (isTaker) {
        const sizeRaw = trade.size ?? trade.amount ?? trade.quantity;
        const sizeNorm = normalizeAmountMaybe(sizeRaw, CONDITIONAL_TOKEN_DECIMALS, 'conditional');
        const size = parseNumber('size', sizeNorm ?? sizeRaw);
        if (size == null || size <= 0) continue;
        const side: 'buy' | 'sell' = takerIsBuy ? 'buy' : 'sell';
        const oid = String(trade.taker_order_id ?? (trade as { takerOrderId?: unknown }).takerOrderId ?? '').trim();
        if (oid) {
          out.push({
            token_id: tokenId,
            order_id: oid,
            side,
            price_01: roundPrice01Api(px),
            shares: roundSizeShares4(size),
            match_time_ms: at,
            role: 'taker',
          });
        }
      }

      // If we were maker, emit one row per maker order id (only our maker orders).
      if (isMaker) {
        for (const m of myMakerOrders) {
          const mo = m as Record<string, unknown>;
          const oid = String(mo.order_id ?? mo.orderId ?? '').trim();
          if (!oid) continue;

          // Maker matched size is on maker_order object.
          const raw = (mo.matched_amount ?? mo.matchedAmount ?? mo.size ?? mo.amount ?? mo.quantity) as unknown;
          const norm = normalizeAmountMaybe(raw, CONDITIONAL_TOKEN_DECIMALS, 'conditional');
          const sz = parseNumber('size', norm ?? raw);
          if (sz == null || sz <= 0) continue;

          // When we are maker, our effective side is opposite the taker side.
          const side: 'buy' | 'sell' = takerIsBuy ? 'sell' : 'buy';
          out.push({
            token_id: tokenId,
            order_id: oid,
            side,
            price_01: roundPrice01Api(px),
            shares: roundSizeShares4(sz),
            match_time_ms: at,
            role: 'maker',
          });
        }
      }
    }

    out.sort((a, b) => b.match_time_ms - a.match_time_ms);
    return json(res, 200, { ok: true, data: { token_id: tokenId, fills: out.slice(0, limit) } });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      error: 'my_fills_failed',
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
  const body = req.body as {
    token?: unknown;
    amount?: unknown;
    side?: unknown;
    signatureType?: unknown;
    market_slug?: unknown;
    outcome?: unknown;
  };
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const side = typeof body.side === 'string' ? body.side.trim().toLowerCase() : 'buy';
  const amount = parseNumber('amount', body.amount);
  const marketSlug = typeof body.market_slug === 'string' ? body.market_slug.trim() : '';
  const outcome = typeof body.outcome === 'string' ? body.outcome.trim() : '';

  if (!token) return json(res, 400, { ok: false, error: 'missing_token' });
  if (side !== 'buy' && side !== 'sell') return json(res, 400, { ok: false, error: 'bad_side' });
  if (amount == null || amount <= 0) return json(res, 400, { ok: false, error: 'bad_amount' });
  // Buys: `amount` is pUSD notional. Sells: `amount` is shares (CLOB convention).
  if (side === 'buy' && amount > 10_000) return json(res, 400, { ok: false, error: 'bad_amount', details: { max_pusd: 10_000 } });
  if (side === 'sell' && amount > 2_000_000) return json(res, 400, { ok: false, error: 'bad_amount', details: { max_shares: 2_000_000 } });

  /** Polymarket CLOB rejects marketable BUY below $1 notional. */
  const MIN_MARKET_BUY_PUSD = 1;
  let orderAmount = amount;
  if (side === 'buy' && amount < MIN_MARKET_BUY_PUSD - 1e-9) {
    const bumped = Math.ceil(amount * 100 - 1e-9) / 100;
    if (bumped < MIN_MARKET_BUY_PUSD - 1e-9) {
      return json(res, 400, {
        ok: false,
        error: 'bad_amount',
        details: {
          message: `Market buy notional must be at least $${MIN_MARKET_BUY_PUSD} pUSD.`,
          min_pusd: MIN_MARKET_BUY_PUSD,
        },
      });
    }
    orderAmount = bumped;
  }
  if (side === 'buy') {
    orderAmount = Number(orderAmount.toFixed(2));
  }
  // CLOB share sizes are effectively 4dp; rounding up can exceed balance and reject sells.
  if (side === 'sell') {
    orderAmount = floorSizeShares4(amount);
    if (orderAmount < 1e-4) {
      return json(res, 400, {
        ok: false,
        error: 'bad_amount',
        details: { hint: 'Sell size is too small after rounding to 4 decimal shares.' },
      });
    }
  }

  // Optional: slug+outcome + POLYMARKET_USE_BULLPEN=true routes execution through Bullpen CLI.
  if (marketSlug && outcome && polymarketUseBullpen()) {
    const env = String(process.env.BULLPEN_ENV ?? 'production').trim() || 'production';
    const t0 = Date.now();
    const args =
      side === 'buy'
        ? ['polymarket', 'buy', '--env', env, '--output', 'json', '--yes', marketSlug, outcome, String(orderAmount)]
        : ['polymarket', 'sell', '--env', env, '--output', 'json', '--yes', marketSlug, outcome, String(orderAmount)];
    const r = await runBullpen(args, { timeoutMs: 45_000 });
    if (!r.ok) {
      return json(res, 502, {
        ok: false,
        error: 'bullpen_trade_failed',
        details: {
          message: (r.stderr || r.stdout || '').trim().slice(0, 1200) || 'Bullpen CLI failed.',
          code: r.code,
          hint: 'Ensure `bullpen` is installed and authenticated (`bullpen status`, `bullpen login`).',
        },
      });
    }
    const parsed = parseJsonMaybe(r.stdout) ?? { stdout: r.stdout.trim() };
    const asObj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    const orderId = asObj ? extractOrderIdFromClobPayload(asObj) : null;
    const fillPrice01 = asObj ? (typeof asObj.price01 === 'number' ? asObj.price01 : typeof asObj.price === 'number' ? asObj.price : null) : null;
    const fill = extractCanonicalMarketFill(parsed, { side: side as 'buy' | 'sell', amount: orderAmount, tokenID: token });
    return json(res, 200, {
      ok: true,
      data: {
        result: parsed,
        execution: {
          submitted_price_01: typeof fillPrice01 === 'number' && Number.isFinite(fillPrice01) ? fillPrice01 : null,
          order_id: orderId,
          round_trip_ms: Date.now() - t0,
          fill: {
            filled_shares: fill.filled_shares,
            avg_fill_price_01: fill.avg_fill_price_01,
            status: fill.status,
          },
        },
      },
    });
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
    // Sync CLOB balance view with chain state — often required before sells fill.
    const builderCode = builderCodeFromEnv();
    if (side === 'sell') {
      await ready.client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: token });
    } else {
      await ready.client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    }

    const sideEnum = side === 'buy' ? Side.BUY : Side.SELL;
    const baseOrder: FakMarketPayload = {
      tokenID: token,
      amount: orderAmount,
      side: sideEnum,
      /**
       * Must match the execution order type passed to `createAndPostMarketOrder` — otherwise
       * `calculateMarketPrice` defaults to FOK-style pricing while the matcher runs FAK, which
       * can yield “no orders found to match with FAK order”.
       */
      orderType: OrderType.FAK,
      ...(builderCode ? { builderCode } : {}),
    };
    if (side === 'buy') {
      try {
        const bal = await ready.client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const usdcBal = parseFloat(String((bal as { balance?: unknown }).balance ?? ''));
        if (Number.isFinite(usdcBal) && usdcBal > 0) baseOrder.userUSDCBalance = usdcBal;
      } catch {
        /* optional for V2 fee-aware sizing */
      }
    }

    const t0 = Date.now();
    let parsed: unknown;
    let submittedCrossPrice: number | null = null;
    try {
      const priced = await attachBookCrossPricePrefer(ready.client, baseOrder);
      submittedCrossPrice =
        priced.price != null && Number.isFinite(priced.price) && priced.price > 0 && priced.price < 1
          ? priced.price
          : null;
      parsed = await createAndPostMarketOrderWithBookSlippage(ready.client, priced);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isLiquidityClassMarketError(msg)) {
        return json(res, 502, {
          ok: false,
          error: 'trade_api_failed',
          details: {
            message: msg,
            hint:
              'Could not match a market order after a book-based retry (FAK then FOK at a wider limit). The book may be empty or moving — try a smaller size, wait a few seconds, or use a Limit order.',
          },
        });
      }
      throw err;
    }

    const fill = extractCanonicalMarketFill(parsed, { side: side as 'buy' | 'sell', amount: orderAmount, tokenID: token });
    return json(res, 200, {
      ok: true,
      data: {
        result: parsed,
        execution: {
          submitted_price_01: submittedCrossPrice,
          order_id: extractOrderIdFromClobPayload(parsed),
          round_trip_ms: Date.now() - t0,
          fill: {
            filled_shares: fill.filled_shares,
            avg_fill_price_01: fill.avg_fill_price_01,
            status: fill.status,
          },
        },
      },
    });
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
  const body = req.body as {
    token?: unknown;
    price?: unknown;
    size?: unknown;
    side?: unknown;
    order_type?: unknown;
    expiration?: unknown;
    post_only?: unknown;
    postOnly?: unknown;
    signatureType?: unknown;
    market_slug?: unknown;
    outcome?: unknown;
  };
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  const side = typeof body.side === 'string' ? body.side.trim().toLowerCase() : 'buy';
  const orderTypeRaw = typeof body.order_type === 'string' ? body.order_type.trim().toUpperCase() : 'GTC';
  const priceRaw = parseNumber('price', body.price);
  const sizeRaw = parseNumber('size', body.size);
  const expirationRaw = parseNumber('expiration', body.expiration);
  const postOnlyRaw = body.post_only ?? body.postOnly;
  const marketSlug = typeof body.market_slug === 'string' ? body.market_slug.trim() : '';
  const outcome = typeof body.outcome === 'string' ? body.outcome.trim() : '';

  if (!token) return json(res, 400, { ok: false, error: 'missing_token' });
  if (side !== 'buy' && side !== 'sell') return json(res, 400, { ok: false, error: 'bad_side' });
  if (orderTypeRaw !== 'GTC' && orderTypeRaw !== 'GTD') {
    return json(res, 400, {
      ok: false,
      error: 'bad_order_type',
      details: { hint: 'Limit endpoint supports GTC or GTD only. Use /api/trade/market-order for FAK/FOK.' },
    });
  }
  if (priceRaw == null || priceRaw <= 0 || priceRaw >= 1) return json(res, 400, { ok: false, error: 'bad_price' });
  if (sizeRaw == null || sizeRaw <= 0 || sizeRaw > 2_000_000) return json(res, 400, { ok: false, error: 'bad_size' });
  const postOnly =
    postOnlyRaw === true ||
    (typeof postOnlyRaw === 'string' && ['1', 'true', 'yes', 'on'].includes(postOnlyRaw.trim().toLowerCase()));
  if (orderTypeRaw === 'GTD') {
    const nowSec = Math.floor(Date.now() / 1000);
    if (expirationRaw == null || !Number.isFinite(expirationRaw) || expirationRaw < nowSec + 60) {
      return json(res, 400, {
        ok: false,
        error: 'bad_expiration',
        details: { hint: 'GTD requires `expiration` at least 60 seconds in the future (unix seconds).' },
      });
    }
  }

  const price = roundPrice01Api(priceRaw);
  if (price <= 0 || price >= 1) {
    return json(res, 400, {
      ok: false,
      error: 'bad_price',
      details: { hint: 'Price rounds to an invalid value for this market tick size.' },
    });
  }
  const size = floorSizeShares4(sizeRaw);
  if (size < 1e-4) {
    return json(res, 400, {
      ok: false,
      error: 'bad_size',
      details: { hint: 'Order size rounds to zero at 4 decimal shares — increase size slightly.' },
    });
  }

  if (marketSlug && outcome && polymarketUseBullpen()) {
    const env = String(process.env.BULLPEN_ENV ?? 'production').trim() || 'production';
    const t0 = Date.now();
    const cmd =
      side === 'buy'
        ? ['polymarket', 'limit-buy', '--env', env, '--output', 'json', '--yes', '--price', String(price), '--shares', String(size), marketSlug, outcome]
        : ['polymarket', 'limit-sell', '--env', env, '--output', 'json', '--yes', '--price', String(price), '--shares', String(size), marketSlug, outcome];
    const r = await runBullpen(cmd, { timeoutMs: 45_000 });
    if (!r.ok) {
      return json(res, 502, {
        ok: false,
        error: 'bullpen_trade_failed',
        details: {
          message: (r.stderr || r.stdout || '').trim().slice(0, 1200) || 'Bullpen CLI failed.',
          code: r.code,
          hint: 'Ensure `bullpen` is installed and authenticated (`bullpen status`, `bullpen login`).',
        },
      });
    }
    const parsed = parseJsonMaybe(r.stdout) ?? { stdout: r.stdout.trim() };
    const asObj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    const orderId = asObj ? extractOrderIdFromClobPayload(asObj) : null;
    return json(res, 200, {
      ok: true,
      data: {
        result: parsed,
        execution: {
          submitted_price_01: price,
          submitted_size_shares: size,
          order_id: orderId,
          round_trip_ms: Date.now() - t0,
        },
      },
    });
  }

  const ready = await getTradingClient();
  if (!ready.ok) {
    return json(res, ready.error === 'trading_auth_failed' ? 502 : 503, {
      ok: false,
      error: ready.error,
      details: { hint: ready.hint, reason: ready.details },
    });
  }

  const t0 = Date.now();
  try {
    if (side === 'sell') {
      await ready.client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: token });
    } else {
      await ready.client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    }

    const orderType = orderTypeRaw === 'GTD' ? OrderType.GTD : OrderType.GTC;
    const builderCode = builderCodeFromEnv();
    const parsed = await ready.client.createAndPostOrder(
      {
        tokenID: token,
        price,
        size,
        side: side === 'buy' ? Side.BUY : Side.SELL,
        ...(orderType === OrderType.GTD && expirationRaw != null ? { expiration: Math.floor(expirationRaw) } : {}),
        ...(builderCode ? { builderCode } : {}),
      },
      await clobOrderBuilderOptions(ready.client, token),
      orderType,
      postOnly,
    );
    const orderId = extractOrderIdFromClobPayload(parsed);
    return json(res, 200, {
      ok: true,
      data: {
        result: parsed,
        execution: {
          submitted_price_01: price,
          submitted_size_shares: size,
          order_type: orderType,
          post_only: postOnly,
          expiration: orderType === OrderType.GTD && expirationRaw != null ? Math.floor(expirationRaw) : 0,
          order_id: orderId,
          round_trip_ms: Date.now() - t0,
        },
      },
    });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      error: 'trade_api_failed',
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
});

/** Fetch a single order by id (for fill / no-fill reconciliation). */
app.get('/api/trade/order', async (req, res) => {
  const orderId = String(req.query.order_id ?? '').trim();
  if (!orderId) return json(res, 400, { ok: false, error: 'missing_order_id' });

  const ready = await getTradingClient();
  if (!ready.ok) {
    return json(res, ready.error === 'trading_auth_failed' ? 502 : 503, {
      ok: false,
      error: ready.error,
      details: { hint: ready.hint, reason: ready.details },
    });
  }

  try {
    const data = await ready.client.getOrder(orderId);
    return json(res, 200, { ok: true, data });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      error: 'get_order_failed',
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
});

/** List open orders (resting) for the authenticated trader. Optional `token_id` filters one market/outcome. */
app.get('/api/trade/open-orders', async (req, res) => {
  const tokenId = String(req.query.token_id ?? '').trim();

  const ready = await getTradingClient();
  if (!ready.ok) {
    return json(res, ready.error === 'trading_auth_failed' ? 502 : 503, {
      ok: false,
      error: ready.error,
      details: { hint: ready.hint, reason: ready.details },
    });
  }

  try {
    const params = tokenId ? ({ token_id: tokenId } as Record<string, unknown>) : ({} as Record<string, unknown>);
    // `ClobClient.getOpenOrders` returns `OpenOrder[]` (it paginates internally); older code wrongly expected `{ data, next_cursor }`.
    const batch = await ready.client.getOpenOrders(params as never, false);
    const items: unknown[] = Array.isArray(batch)
      ? batch
      : batch && typeof batch === 'object' && Array.isArray((batch as { data?: unknown }).data)
        ? ((batch as { data: unknown[] }).data as unknown[])
        : [];
    return json(res, 200, { ok: true, data: { token_id: tokenId || null, orders: items } });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      error: 'open_orders_failed',
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
});

/** Cancel one resting order by CLOB order id. */
app.post('/api/trade/cancel-order', async (req, res) => {
  const body = req.body as { order_id?: unknown; orderID?: unknown };
  const orderId =
    (typeof body.order_id === 'string' && body.order_id.trim()) ||
    (typeof body.orderID === 'string' && body.orderID.trim()) ||
    '';
  if (!orderId) return json(res, 400, { ok: false, error: 'missing_order_id' });

  const ready = await getTradingClient();
  if (!ready.ok) {
    return json(res, ready.error === 'trading_auth_failed' ? 502 : 503, {
      ok: false,
      error: ready.error,
      details: { hint: ready.hint, reason: ready.details },
    });
  }

  try {
    await ready.client.cancelOrder({ orderID: orderId } as { orderID: string });
    return json(res, 200, { ok: true, data: { cancelled: true, order_id: orderId } });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      error: 'cancel_order_failed',
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
});

/**
 * Cancel all open orders for the authenticated trader (kill switch).
 * Requires `{ "confirm": true }` in the JSON body to avoid accidental taps.
 */
app.post('/api/trade/cancel-all', async (req, res) => {
  const body = req.body as { confirm?: unknown };
  if (body.confirm !== true) {
    return json(res, 400, {
      ok: false,
      error: 'confirm_required',
      details: { hint: 'Send JSON body { "confirm": true } to cancel every open order.' },
    });
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
    const data = await ready.client.cancelAll();
    return json(res, 200, { ok: true, data });
  } catch (error) {
    return json(res, 502, {
      ok: false,
      error: 'cancel_all_failed',
      details: { message: error instanceof Error ? error.message : String(error) },
    });
  }
});

/** Last-resort JSON errors (uncaught async throws, etc.) so the web client never sees HTML on 500. */
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[api] unhandled_error', err);
  if (res.headersSent) return;
  json(res, 500, {
    ok: false,
    error: 'internal_error',
    details: { message: err instanceof Error ? err.message : String(err) },
  });
});

const port = Number(process.env.PORT ?? 8787);

function safeJsonStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return JSON.stringify({ ok: false, error: 'stringify_failed' });
  }
}

function userChannelAuthFromEnv(): { apiKey: string; secret: string; passphrase: string } | null {
  const apiKey = String(process.env.POLYMARKET_API_KEY ?? '').trim();
  const secret = String(process.env.POLYMARKET_API_SECRET ?? '').trim();
  const passphrase = String(process.env.POLYMARKET_API_PASSPHRASE ?? '').trim();
  if (!apiKey || !secret || !passphrase) return null;
  return { apiKey, secret, passphrase };
}

const server = http.createServer(app);

// Server-side bridge: Polymarket user WS -> browser WS (never expose creds to web).
const wss = new WebSocketServer({ server, path: '/api/trade/user-ws' });
wss.on('connection', async (client) => {
  const auth = userChannelAuthFromEnv();
  if (!auth) {
    client.send(
      safeJsonStringify({
        ok: false,
        error: 'missing_api_creds_for_user_ws',
        details: { hint: 'Set POLYMARKET_API_KEY / POLYMARKET_API_SECRET / POLYMARKET_API_PASSPHRASE in api/.env' },
      }),
    );
    client.close();
    return;
  }

  // Best-effort: annotate user WS messages from *our* perspective (maker vs taker),
  // so the web UI can display the same fill side/price Polymarket shows.
  const ready = await getTradingClient();
  const myAddrs =
    ready.ok
      ? new Set([ready.config.funderAddress.toLowerCase(), ready.config.signerAddress.toLowerCase()].filter(Boolean))
      : new Set<string>();

  const wsNum = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };

  const wsPrice01 = (raw: unknown): number | null => {
    const n = wsNum(raw);
    if (n == null) return null;
    if (n > 0 && n <= 1) return n;
    if (n > 1 && n <= 100) return n / 100;
    return null;
  };

  const perspectiveFromPayload = (obj: Record<string, unknown>): { myRole?: 'maker' | 'taker'; mySide?: 'buy' | 'sell'; myPrice01?: number; mySize?: number } => {
    if (myAddrs.size === 0) return {};
    const tradeSideRaw = String(obj.side ?? '').toUpperCase();
    const takerIsBuy = tradeSideRaw === 'BUY' || tradeSideRaw === 'B';
    const takerIsSell = tradeSideRaw === 'SELL' || tradeSideRaw === 'S';
    if (!takerIsBuy && !takerIsSell) return {};

    const owner = typeof obj.owner === 'string' ? obj.owner.toLowerCase() : '';
    const isTaker = owner && myAddrs.has(owner);

    const makerOrders = obj.maker_orders;
    let isMaker = false;
    let makerMatched = 0;
    let makerPrice01: number | null = null;
    if (Array.isArray(makerOrders)) {
      for (const mo of makerOrders) {
        if (!mo || typeof mo !== 'object') continue;
        const m = mo as Record<string, unknown>;
        const ma = typeof m.maker_address === 'string' ? m.maker_address.toLowerCase() : '';
        const ow = typeof m.owner === 'string' ? m.owner.toLowerCase() : '';
        const hit = (ma && myAddrs.has(ma)) || (ow && myAddrs.has(ow));
        if (!hit) continue;
        isMaker = true;
        const amtRaw = m.matched_amount ?? m.matchedAmount ?? m.size ?? m.amount ?? m.quantity;
        const norm = normalizeAmountMaybe(amtRaw, CONDITIONAL_TOKEN_DECIMALS, 'conditional');
        const s = wsNum(norm ?? amtRaw);
        if (s != null && s > 0) makerMatched += s;
        if (makerPrice01 == null) makerPrice01 = wsPrice01(m.price);
      }
    }

    if (!isTaker && !isMaker) return {};
    const role: 'maker' | 'taker' = isMaker ? 'maker' : 'taker';
    const mySide: 'buy' | 'sell' =
      role === 'maker'
        ? takerIsBuy
          ? 'sell'
          : 'buy'
        : takerIsBuy
          ? 'buy'
          : 'sell';

    const myPrice01 = role === 'maker' ? makerPrice01 ?? wsPrice01(obj.price) : wsPrice01(obj.price);
    const mySize =
      role === 'maker'
        ? makerMatched > 0
          ? makerMatched
          : wsNum(obj.size)
        : wsNum(obj.size);

    return { myRole: role, mySide, myPrice01: myPrice01 ?? undefined, mySize: mySize ?? undefined };
  };

  let upstream: WebSocket | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  const closeAll = () => {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
    try {
      upstream?.close();
    } catch {
      /* ignore */
    }
    upstream = null;
    try {
      client.close();
    } catch {
      /* ignore */
    }
  };

  try {
    upstream = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/user');
  } catch {
    client.send(safeJsonStringify({ ok: false, error: 'user_ws_connect_failed' }));
    closeAll();
    return;
  }

  upstream.on('open', () => {
    upstream?.send(
      safeJsonStringify({
        type: 'user',
        auth: { apiKey: auth.apiKey, secret: auth.secret, passphrase: auth.passphrase },
      }),
    );
    // Docs: keepalive PING every ~10s.
    pingTimer = setInterval(() => {
      try {
        upstream?.send(safeJsonStringify({ type: 'PING' }));
      } catch {
        /* ignore */
      }
    }, 10_000);
  });

  upstream.on('message', (buf) => {
    try {
      if (client.readyState !== WebSocket.OPEN) return;
      const raw = String(buf);
      if (myAddrs.size === 0) {
        client.send(raw);
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        client.send(raw);
        return;
      }
      if (!parsed || typeof parsed !== 'object') {
        client.send(raw);
        return;
      }
      const obj = parsed as Record<string, unknown>;
      const p = perspectiveFromPayload(obj);
      if (p.mySide || p.myPrice01 != null || p.mySize != null) {
        obj.my_role = p.myRole;
        obj.my_side = p.mySide;
        obj.my_price01 = p.myPrice01;
        obj.my_size = p.mySize;
      }
      client.send(safeJsonStringify(obj));
    } catch {
      /* ignore */
    }
  });
  upstream.on('close', () => {
    closeAll();
  });
  upstream.on('error', () => {
    client.send(safeJsonStringify({ ok: false, error: 'user_ws_upstream_error' }));
    closeAll();
  });

  client.on('close', () => {
    closeAll();
  });
  client.on('error', () => {
    closeAll();
  });
});

server.listen(port, () => {
  console.log(`[api] listening on http://127.0.0.1:${port}`);
  void ensureRtdsWs().catch(() => {
    /* RTDS warms on first /api/rtds/crypto request if this fails */
  });
});
