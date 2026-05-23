import type { Express, Response } from 'express';
import {
  clobBookHttp,
  clobLastTradePrice,
  dataApiRecentTrades,
  gammaMarketBySlugOrId,
  normalizeMarket,
  probePolymarketLive,
  PolymarketHttpError,
} from './polymarket/index.js';

function json(res: Response, status: number, body: unknown) {
  res.status(status);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.send(JSON.stringify(body));
}

/** Accept raw slug or full polymarket.com URLs (same as main server). */
export function normalizeMarketLookupRef(raw: string): string {
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

/**
 * Explicit live Polymarket HTTP routes (Gamma / CLOB / Data).
 * The rest of `/api/*` may still fall back to the `polymarket` CLI when installed.
 */
export function registerPolymarketLiveRoutes(app: Express): void {
  app.get('/api/polymarket/live/status', async (_req, res) => {
    try {
      const status = await probePolymarketLive();
      return json(res, 200, { ok: true, data: status });
    } catch (e) {
      return json(res, 502, { ok: false, error: 'live_status_failed', details: String(e) });
    }
  });

  app.get('/api/polymarket/live/market/:slug', async (req, res) => {
    const raw = String(req.params.slug ?? '').trim();
    const slug = normalizeMarketLookupRef(raw);
    if (!slug) return json(res, 400, { ok: false, error: 'missing_slug' });
    try {
      const market = normalizeMarket(await gammaMarketBySlugOrId(slug));
      return json(res, 200, { ok: true, data: { slug, market, source: 'gamma_live' } });
    } catch (e) {
      const details = e instanceof PolymarketHttpError ? { status: e.status, url: e.url } : String(e);
      return json(res, 502, { ok: false, error: 'gamma_market_failed', details });
    }
  });

  app.get('/api/polymarket/live/clob/book', async (req, res) => {
    const token = String(req.query.token_id ?? req.query.token ?? '').trim();
    if (!token) return json(res, 400, { ok: false, error: 'missing_token_id' });
    try {
      const book = await clobBookHttp(token);
      return json(res, 200, { ok: true, data: { token_id: token, book, source: 'clob_live' } });
    } catch (e) {
      const details = e instanceof PolymarketHttpError ? { status: e.status, url: e.url } : String(e);
      return json(res, 502, { ok: false, error: 'clob_book_failed', details });
    }
  });

  app.get('/api/polymarket/live/clob/last-trade-price', async (req, res) => {
    const token = String(req.query.token_id ?? '').trim();
    if (!token) return json(res, 400, { ok: false, error: 'missing_token_id' });
    try {
      const row = await clobLastTradePrice(token);
      return json(res, 200, { ok: true, data: row });
    } catch (e) {
      const details = e instanceof PolymarketHttpError ? { status: e.status, url: e.url } : String(e);
      return json(res, 502, { ok: false, error: 'clob_last_trade_failed', details });
    }
  });

  app.get('/api/polymarket/live/data/trades', async (req, res) => {
    const market = String(req.query.market ?? '').trim().toLowerCase();
    if (!market || !/^0x[a-f0-9]{64}$/.test(market)) {
      return json(res, 400, {
        ok: false,
        error: 'bad_market',
        details: { hint: 'Pass market=<conditionId> as 0x + 64 hex.' },
      });
    }
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50) || 50));
    try {
      const rows = await dataApiRecentTrades({ conditionId: market, limit });
      return json(res, 200, { ok: true, data: rows });
    } catch (e) {
      const details = e instanceof PolymarketHttpError ? { status: e.status, url: e.url } : String(e);
      return json(res, 502, { ok: false, error: 'data_trades_failed', details });
    }
  });
}
