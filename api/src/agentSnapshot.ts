import {
  clobBookHttp,
  clobLastTradePrice,
  dataApiRecentTrades,
  parseClobTokenIds,
} from './polymarket/index.js';
import { resolveCanonicalUpdownSlug } from './updownCanonicalProbe.js';
import type { RtdsHistPoint } from './ptbFromRtds.js';

export type UpdownAsset = 'btc' | 'eth' | 'sol' | 'hype';
export type UpdownInterval = '5m' | '15m' | '1h' | '4h' | '1d';

export type AgentSnapshotDeps = {
  resolveMarketBySlug: (slug: string) => Promise<unknown>;
  tryPriceToBeat: (slug: string) => Promise<{ value: number; source: string } | null>;
  tryRtdsBucketPtb: (bucket: { symbol: string; bucketStartMs: number }) => Promise<{ value: number; source: string } | null>;
  tryPolymarketPagePtb: (slug: string) => Promise<{ value: number; source: string } | null>;
  parseUpdownBucketFromSlug: (slug: string) => { symbol: string; bucketStartMs: number } | null;
  inferBucketFromTitledUpdownSlug: (slug: string) => Promise<{ symbol: string; bucketStartMs: number } | null>;
  ensureRtdsWs: () => Promise<void>;
  waitForRtdsPrice: (symbol: string, attempts?: number, delayMs?: number) => Promise<unknown>;
  rtdsHistoryForSymbol: (symbol: string) => RtdsHistPoint[];
  latestChainlinkUsdPrice: (symbol: string) => {
    symbol: string;
    value: number;
    ts: number;
    receivedAt: number;
    source: string;
  } | null;
};

export type AgentSnapshotOptions = {
  asset: UpdownAsset;
  interval: UpdownInterval;
  /** Max spot history points in payload (newest retained). Default 180. */
  spotHistoryLimit?: number;
  /** Max recent matched trades per outcome token. Default 40. */
  tapeLimit?: number;
  /** Max book levels per side in payload. Default 12. */
  bookDepth?: number;
};

type BookLevel = { price: number; size: number };

function stepSecForInterval(interval: UpdownInterval): number {
  if (interval === '15m') return 900;
  if (interval === '1h') return 3600;
  if (interval === '4h') return 4 * 3600;
  if (interval === '1d') return 24 * 3600;
  return 300;
}

function nowBucketSec(stepSec: number): { now: number; floor: number; ceil: number } {
  const now = Math.floor(Date.now() / 1000);
  const floor = Math.floor(now / stepSec) * stepSec;
  const ceil = Math.ceil(now / stepSec) * stepSec;
  return { now, floor, ceil };
}

function parseIsoMs(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function parseOutcomeLabels(market: Record<string, unknown>): string[] {
  const raw = market.outcomes ?? market.outcomeNames ?? market.shortOutcomes;
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
    return t.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function parseBookLevels(rows: unknown): BookLevel[] {
  if (!Array.isArray(rows)) return [];
  const out: BookLevel[] = [];
  for (const row of rows) {
    if (Array.isArray(row) && row.length >= 2) {
      const price = Number(row[0]);
      const size = Number(row[1]);
      if (Number.isFinite(price) && Number.isFinite(size) && size > 0) out.push({ price, size });
      continue;
    }
    if (row && typeof row === 'object') {
      const o = row as Record<string, unknown>;
      const price = Number(o.price ?? o.p);
      const size = Number(o.size ?? o.s ?? o.amount);
      if (Number.isFinite(price) && Number.isFinite(size) && size > 0) out.push({ price, size });
    }
  }
  return out;
}

function summarizeBook(book: unknown, depth: number) {
  const o = book && typeof book === 'object' ? (book as Record<string, unknown>) : null;
  const bids = parseBookLevels(o?.bids).sort((a, b) => b.price - a.price);
  const asks = parseBookLevels(o?.asks).sort((a, b) => a.price - b.price);
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const mid = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  const bidDepthTop = bids.slice(0, depth).reduce((s, l) => s + l.size, 0);
  const askDepthTop = asks.slice(0, depth).reduce((s, l) => s + l.size, 0);
  return {
    bestBid,
    bestAsk,
    spread,
    mid,
    bidDepthTop,
    askDepthTop,
    bids: bids.slice(0, depth),
    asks: asks.slice(0, depth),
    tickSize: o?.tick_size ?? o?.tickSize ?? null,
    minOrderSize: o?.min_order_size ?? o?.minOrderSize ?? null,
  };
}

function trimMarket(market: Record<string, unknown>) {
  const tokenIds = parseClobTokenIds(market.clobTokenIds ?? market.clob_token_ids);
  return {
    slug: String(market.slug ?? ''),
    question: String(market.question ?? market.title ?? ''),
    conditionId: String(market.conditionId ?? market.condition_id ?? ''),
    active: market.active === true,
    closed: market.closed === true,
    endDate: market.endDate ?? market.end_date ?? null,
    outcomes: parseOutcomeLabels(market),
    clobTokenIds: tokenIds,
    volume: market.volume ?? market.volumeNum ?? null,
    liquidity: market.liquidity ?? market.liquidityNum ?? null,
  };
}

async function resolveLiveUpdownSlug(asset: UpdownAsset, interval: UpdownInterval) {
  const stepSec = stepSecForInterval(interval);
  const b = nowBucketSec(stepSec);
  const canonical = await resolveCanonicalUpdownSlug({
    asset,
    interval,
    stepSec,
    nowSec: b.now,
    floorSec: b.floor,
  });
  if (!canonical) {
    throw new Error(`no_live_updown_slug:${asset}:${interval}`);
  }
  const startSec = canonical.ts;
  const endSec = startSec + stepSec;
  return {
    slug: canonical.slug,
    market: canonical.market,
    window: {
      asset,
      interval,
      stepSec,
      startUnix: startSec,
      endUnix: endSec,
      startIso: new Date(startSec * 1000).toISOString(),
      endIso: new Date(endSec * 1000).toISOString(),
      nowUnix: b.now,
      remainingMs: Math.max(0, endSec * 1000 - Date.now()),
      elapsedMs: Math.max(0, Date.now() - startSec * 1000),
      pctElapsed: Math.min(1, Math.max(0, (Date.now() - startSec * 1000) / (stepSec * 1000))),
    },
  };
}

async function resolvePtb(
  slug: string,
  deps: AgentSnapshotDeps,
): Promise<{ priceToBeatUsd: number; source: string; preview?: boolean } | null> {
  let bucket = deps.parseUpdownBucketFromSlug(slug);
  if (!bucket) {
    bucket = await deps.inferBucketFromTitledUpdownSlug(slug);
  }
  const [ssr, rtds, page] = await Promise.all([
    bucket ? Promise.resolve(null) : deps.tryPriceToBeat(slug).catch(() => null),
    bucket ? deps.tryRtdsBucketPtb(bucket) : Promise.resolve(null),
    deps.tryPolymarketPagePtb(slug).catch(() => null),
  ]);
  const chosen = rtds ?? page ?? ssr;
  if (!chosen) return null;
  return {
    priceToBeatUsd: chosen.value,
    source: chosen.source,
    preview: chosen.source.includes('preview'),
  };
}

async function loadSpot(asset: UpdownAsset, deps: AgentSnapshotDeps, historyLimit: number) {
  const symbol = `${asset}/usd`;
  try {
    await deps.ensureRtdsWs();
    await deps.waitForRtdsPrice(symbol, 16, 80);
  } catch {
    /* may still have cache */
  }
  const live = deps.latestChainlinkUsdPrice(symbol);
  const hist = deps.rtdsHistoryForSymbol(symbol);
  const tail = hist.slice(-historyLimit);
  return {
    symbol,
    live: live
      ? {
          usd: live.value,
          tsMs: live.ts,
          receivedAtMs: live.receivedAt,
          source: live.source,
          ageMs: Date.now() - live.receivedAt,
        }
      : null,
    history: tail.map((p) => ({ tMs: p.t, usd: p.v, src: p.src ?? 'chainlink' })),
  };
}

export async function buildAgentSnapshot(opts: AgentSnapshotOptions, deps: AgentSnapshotDeps) {
  const spotHistoryLimit = Math.max(20, Math.min(600, opts.spotHistoryLimit ?? 180));
  const tapeLimit = Math.max(5, Math.min(100, opts.tapeLimit ?? 40));
  const bookDepth = Math.max(4, Math.min(30, opts.bookDepth ?? 12));

  const live = await resolveLiveUpdownSlug(opts.asset, opts.interval);
  const slug = live.slug;
  const marketRaw = (await deps.resolveMarketBySlug(slug)) as Record<string, unknown>;
  const market = trimMarket(marketRaw);
  const labels = market.outcomes.length >= 2 ? market.outcomes : ['Up', 'Down'];
  const [upToken, downToken] = market.clobTokenIds;

  const [ptb, spot, upBookRaw, downBookRaw, upLast, downLast] = await Promise.all([
    resolvePtb(slug, deps),
    loadSpot(opts.asset, deps, spotHistoryLimit),
    upToken ? clobBookHttp(upToken, { timeoutMs: 12_000 }).catch((e) => ({ error: String(e) })) : null,
    downToken ? clobBookHttp(downToken, { timeoutMs: 12_000 }).catch((e) => ({ error: String(e) })) : null,
    upToken ? clobLastTradePrice(upToken).catch(() => null) : null,
    downToken ? clobLastTradePrice(downToken).catch(() => null) : null,
  ]);

  const conditionId = market.conditionId;
  let recentTrades: Awaited<ReturnType<typeof dataApiRecentTrades>> = [];
  if (conditionId && /^0x[a-f0-9]{64}$/i.test(conditionId)) {
    try {
      recentTrades = await dataApiRecentTrades({ conditionId, limit: tapeLimit * 2 });
    } catch {
      recentTrades = [];
    }
  }

  const spotUsd = spot.live?.usd ?? null;
  const ptbUsd = ptb?.priceToBeatUsd ?? null;

  const outcome = (lane: 'up' | 'down', token: string | undefined, label: string, bookRaw: unknown, lastRaw: unknown) => {
    const bookErr = bookRaw && typeof bookRaw === 'object' && 'error' in (bookRaw as object) ? String((bookRaw as { error: unknown }).error) : null;
    const book = bookErr ? null : bookRaw;
    const summary = book ? summarizeBook(book, bookDepth) : null;
    const last =
      lastRaw && typeof lastRaw === 'object'
        ? {
            price: String((lastRaw as Record<string, unknown>).price ?? ''),
            side: String((lastRaw as Record<string, unknown>).side ?? ''),
          }
        : null;
    const tape = token
      ? recentTrades
          .filter((t) => t.asset === token)
          .slice(0, tapeLimit)
          .map((t) => ({
            tsMs: t.timestamp,
            side: t.side,
            price: t.price,
            size: t.size,
            outcome: t.outcome,
          }))
      : [];
    return {
      lane,
      label,
      tokenId: token ?? null,
      book: summary,
      bookError: bookErr,
      lastTrade: last,
      recentTrades: tape,
      impliedMid: summary?.mid ?? (last?.price ? Number(last.price) : null),
    };
  };

  const up = outcome('up', upToken, labels[0] ?? 'Up', upBookRaw, upLast);
  const down = outcome('down', downToken, labels[1] ?? 'Down', downBookRaw, downLast);

  return {
    schema: 'polymarket-orderflow-agent-snapshot/v1',
    generatedAt: new Date().toISOString(),
    generatedAtMs: Date.now(),
    query: { asset: opts.asset, interval: opts.interval },
    window: live.window,
    market,
    underlying: {
      asset: opts.asset.toUpperCase(),
      spot,
      priceToBeat: ptb,
      spotVsPtbUsd: spotUsd != null && ptbUsd != null ? spotUsd - ptbUsd : null,
      spotVsPtbPct: spotUsd != null && ptbUsd != null && ptbUsd !== 0 ? ((spotUsd - ptbUsd) / ptbUsd) * 100 : null,
    },
    outcomes: { up, down },
    notes: [
      'Prices in outcome books and trades are Polymarket probability decimals (0–1), not USD.',
      'UP/DOWN resolution is vs price-to-beat at window end (Chainlink BTC/USD for crypto updown).',
      'Use window.remainingMs and implied mids for timing; books are point-in-time snapshots.',
    ],
  };
}
