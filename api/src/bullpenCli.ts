/**
 * Bullpen CLI integration — live account reads/writes without local Polymarket CLOB keys.
 * @see https://cli.bullpen.fi
 */
import { spawn } from 'node:child_process';
import { clobBookHttp } from './polymarket/clobPublic.js';
import { formatBullpenPriceArg, roundPriceToTick } from './priceTick.js';
import {
  bullpenCashBalanceFromRoot,
  bullpenStatusShowsLoggedIn,
  findBullpenPositionRow,
  polymarketUsdcFromPortfolioBalances,
  positionAvgEntry01,
  positionSize,
  positionsArrayFromBullpenRoot,
} from './bullpenReads.js';

export type CliResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
};

export function bullpenBin(): string {
  return String(process.env.BULLPEN_BIN || 'bullpen').trim() || 'bullpen';
}

export function bullpenEnvName(): string {
  return String(process.env.BULLPEN_ENV ?? 'production').trim() || 'production';
}

export function parseJsonMaybe(text: string): unknown | null {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
}

export function runBullpen(args: string[], opts?: { timeoutMs?: number }): Promise<CliResult> {
  const bin = bullpenBin();
  const timeoutMs = opts?.timeoutMs ?? 35_000;
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BULLPEN_NON_INTERACTIVE: '1' },
    });
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
      if (code === 0) finish({ ok: true, stdout, stderr, code, signal });
      else finish({ ok: false, stdout, stderr, code, signal });
    });
  });
}

export async function bullpenJson(args: string[], opts?: { timeoutMs?: number }): Promise<
  | { ok: true; data: unknown }
  | { ok: false; output: string; code: number | null }
> {
  const base = ['--env', bullpenEnvName(), '--output', 'json'];
  const r = await runBullpen([...args, ...base], opts);
  const out = `${r.stdout}${r.stderr}`.trim();
  if (!r.ok) return { ok: false, output: out, code: r.code };
  const data = parseJsonMaybe(r.stdout);
  if (data == null) return { ok: false, output: out || 'empty stdout', code: r.code };
  return { ok: true, data };
}

let authCache: { at: number; ok: boolean } | null = null;

export async function bullpenSessionReady(): Promise<boolean> {
  const now = Date.now();
  if (authCache && now - authCache.at < 30_000) return authCache.ok;
  const r = await runBullpen(['status'], { timeoutMs: 12_000 });
  const ok = r.ok && bullpenStatusShowsLoggedIn(r.stdout);
  authCache = { at: now, ok };
  return ok;
}

export type BullpenPositionsSnapshot = {
  fetchedAtMs: number;
  parsed: unknown;
  positions: Record<string, unknown>[];
};

let positionsCache: BullpenPositionsSnapshot | null = null;
let positionsInflight: Promise<void> | null = null;

export async function refreshBullpenPositions(opts?: { force?: boolean }): Promise<void> {
  const now = Date.now();
  const ttlMs = 250;
  if (!opts?.force && positionsCache && now - positionsCache.fetchedAtMs < ttlMs) return;
  if (positionsInflight) return positionsInflight;
  positionsInflight = (async () => {
    try {
      const r = await bullpenJson(['polymarket', 'positions'], { timeoutMs: 25_000 });
      if (!r.ok) return;
      positionsCache = {
        fetchedAtMs: Date.now(),
        parsed: r.data,
        positions: positionsArrayFromBullpenRoot(r.data),
      };
    } finally {
      positionsInflight = null;
    }
  })();
  await positionsInflight;
}

export function cachedBullpenPositions(): BullpenPositionsSnapshot | null {
  return positionsCache;
}

export async function bullpenCollateralBalanceHuman(): Promise<number | null> {
  const cached = positionsCache;
  if (cached?.parsed != null) {
    const cash = bullpenCashBalanceFromRoot(cached.parsed);
    if (cash != null) return cash;
  }
  const clob = await bullpenClobBalance('collateral');
  if (clob?.balance != null) return Number(clob.balance);
  const port = await bullpenJson(['portfolio', 'balances'], { timeoutMs: 20_000 });
  if (port.ok) return polymarketUsdcFromPortfolioBalances(port.data);
  return null;
}

export async function bullpenClobBalance(
  assetType: 'collateral' | 'conditional',
  tokenId?: string,
): Promise<{ balance: string; allowance: string } | null> {
  const args = ['polymarket', 'clob', 'balance', '--asset-type', assetType];
  if (assetType === 'conditional') {
    const tid = String(tokenId ?? '').trim();
    if (!tid) return null;
    args.push('--token-id', tid);
  }
  const r = await bullpenJson(args, { timeoutMs: 20_000 });
  if (!r.ok || !r.data || typeof r.data !== 'object') return null;
  const o = r.data as Record<string, unknown>;
  const balance = String(o.balance ?? '');
  const allowance = typeof o.allowance === 'string' ? o.allowance : '';
  return { balance, allowance };
}

export function tradesArrayFromBullpenRoot(parsed: unknown): Record<string, unknown>[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const root = parsed as Record<string, unknown>;
  const maybe = (root.trades ?? root.activities ?? root.data) as unknown;
  if (Array.isArray(maybe)) return maybe.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
  if (Array.isArray(parsed)) return parsed.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
  return [];
}

export function ordersArrayFromBullpenRoot(parsed: unknown): Record<string, unknown>[] {
  if (!parsed || typeof parsed !== 'object') return [];
  const root = parsed as Record<string, unknown>;
  const maybe = (root.orders ?? root.data) as unknown;
  if (Array.isArray(maybe)) return maybe.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
  return [];
}

let tradeHistoryCache: { at: number; trades: Record<string, unknown>[] } | null = null;

export async function bullpenTradeHistory(opts?: { force?: boolean; limit?: number }): Promise<Record<string, unknown>[]> {
  const ttlMs = 5_000;
  const now = Date.now();
  if (!opts?.force && tradeHistoryCache && now - tradeHistoryCache.at < ttlMs) {
    return tradeHistoryCache.trades;
  }
  const r = await bullpenJson(['polymarket', 'orders', '--history'], { timeoutMs: 30_000 });
  if (!r.ok) return tradeHistoryCache?.trades ?? [];
  let trades = tradesArrayFromBullpenRoot(r.data);
  const limit = opts?.limit ?? 500;
  if (trades.length > limit) trades = trades.slice(0, limit);
  tradeHistoryCache = { at: now, trades };
  return trades;
}

export async function bullpenOpenOrders(): Promise<Record<string, unknown>[]> {
  const r = await bullpenJson(['polymarket', 'orders'], { timeoutMs: 25_000 });
  if (!r.ok) return [];
  return ordersArrayFromBullpenRoot(r.data);
}

export async function bullpenLookupOrder(orderId: string): Promise<unknown | null> {
  const id = String(orderId ?? '').trim();
  if (!id) return null;
  const r = await bullpenJson(['polymarket', 'clob', 'order', id], { timeoutMs: 20_000 });
  return r.ok ? r.data : null;
}

/** Bullpen returns exit 1 when the order is already gone — treat as success for the UI. */
export function bullpenCancelAlreadyDone(output: string): boolean {
  const c = output.toLowerCase();
  return (
    c.includes('already canceled') ||
    c.includes('already cancelled') ||
    c.includes('already canceled or matched') ||
    c.includes("can't be found") ||
    c.includes('cant be found') ||
    c.includes('order not cancelled') && c.includes('not found')
  );
}

export async function bullpenCancelOrder(
  orderId: string,
): Promise<{ ok: boolean; output: string; idempotent?: boolean }> {
  const id = String(orderId ?? '').trim();
  if (!id) return { ok: false, output: 'missing order id' };
  const r = await runBullpen(
    ['polymarket', 'orders', '--env', bullpenEnvName(), '--cancel', id, '--yes', '--output', 'json'],
    { timeoutMs: 30_000 },
  );
  const output = `${r.stdout}${r.stderr}`.trim();
  if (r.ok) return { ok: true, output };
  const parsed = parseJsonMaybe(r.stdout);
  const err =
    parsed && typeof parsed === 'object' ? String((parsed as Record<string, unknown>).error ?? '') : '';
  if (bullpenCancelAlreadyDone(err) || bullpenCancelAlreadyDone(output)) {
    return { ok: true, output, idempotent: true };
  }
  return { ok: false, output };
}

export async function bullpenCancelAllOrders(): Promise<{ ok: boolean; output: string; data: unknown | null }> {
  const r = await runBullpen(
    ['polymarket', 'orders', '--env', bullpenEnvName(), '--cancel-all', '--yes', '--output', 'json'],
    { timeoutMs: 45_000 },
  );
  const data = r.ok ? parseJsonMaybe(r.stdout) : null;
  return { ok: r.ok, output: `${r.stdout}${r.stderr}`.trim(), data };
}

function parseNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function tradeAssetId(t: Record<string, unknown>): string {
  return String(t.asset ?? t.asset_id ?? t.assetId ?? t.token_id ?? '').trim();
}

function tradeTimeMs(t: Record<string, unknown>): number {
  const raw = t.timestamp ?? t.match_time ?? t.created_at;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw > 1e12 ? raw : raw * 1000;
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return 0;
}

/** Cost-basis avg entry + open size from Bullpen trade history for one outcome token. */
export function avgEntryFromBullpenTrades(
  trades: Record<string, unknown>[],
  tokenId: string,
): { avgEntry: number | null; shares: number } {
  const tid = tokenId.trim();
  const rows = trades
    .filter((t) => tradeAssetId(t) === tid)
    .sort((a, b) => tradeTimeMs(a) - tradeTimeMs(b));

  let pos = 0;
  let cost = 0;
  for (const t of rows) {
    const side = String(t.side ?? '').toUpperCase();
    const size = parseNum(t.size) ?? 0;
    let price = parseNum(t.price) ?? 0;
    if (price > 1.0001 && price <= 100) price /= 100;
    if (size <= 0 || price < 0) continue;
    if (side === 'BUY' || side === 'B') {
      pos += size;
      cost += size * price;
    } else if (side === 'SELL' || side === 'S') {
      if (pos <= 0) continue;
      const avg = cost / pos;
      const qty = Math.min(size, pos);
      cost -= qty * avg;
      pos -= qty;
    }
  }
  const avgEntry = pos > 0 ? cost / pos : null;
  return { avgEntry, shares: pos };
}

export type BullpenMyFill = {
  token_id: string;
  order_id: string;
  side: 'buy' | 'sell';
  price_01: number;
  shares: number;
  match_time_ms: number;
  role: 'taker' | 'maker';
};

export function myFillsFromBullpenTrades(trades: Record<string, unknown>[], tokenId: string, limit: number): BullpenMyFill[] {
  const tid = tokenId.trim();
  const out: BullpenMyFill[] = [];
  for (const t of trades) {
    if (tradeAssetId(t) !== tid) continue;
    const sideRaw = String(t.side ?? '').toUpperCase();
    const side: 'buy' | 'sell' = sideRaw === 'SELL' || sideRaw === 'S' ? 'sell' : 'buy';
    let price = parseNum(t.price) ?? 0;
    if (price > 1.0001 && price <= 100) price /= 100;
    const shares = parseNum(t.size) ?? 0;
    if (shares <= 0) continue;
    out.push({
      token_id: tid,
      order_id: String(t.order_id ?? t.orderID ?? t.id ?? ''),
      side,
      price_01: price,
      shares,
      match_time_ms: tradeTimeMs(t),
      role: 'taker',
    });
    if (out.length >= limit) break;
  }
  return out.sort((a, b) => b.match_time_ms - a.match_time_ms);
}

/** Bullpen trade commands may print one JSON object then a second `{ "error": ... }` line. */
export function parseBullpenTradeStdout(stdout: string): unknown | null {
  const t = stdout.trim();
  if (!t) return null;
  const direct = parseJsonMaybe(t);
  if (direct != null) return direct;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const slice = parseJsonMaybe(t.slice(start, i + 1));
        if (slice != null) return slice;
        start = -1;
      }
    }
  }
  return null;
}

function bullpenTradeResult(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const root = parsed as Record<string, unknown>;
  const r = root.result;
  return r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
}

export function isBullpenFokKill(message: string): boolean {
  const c = message.toLowerCase();
  return c.includes('fully filled') || c.includes('fok orders') || c.includes('fill or kill');
}

export function bullpenTradeFailureHint(message: string): string {
  const c = message.toLowerCase();
  if (isBullpenFokKill(message)) {
    return 'No instant fill at the current ask/bid (FOK killed). Use Limit at the touch price, size slightly larger, or retry when spread tightens.';
  }
  if (c.includes('insufficient') && (c.includes('balance') || c.includes('pusd') || c.includes('usdc'))) {
    return 'Not enough pUSD on your Bullpen wallet — check `bullpen polymarket preflight` or deposit/wrap USDC.';
  }
  if (c.includes('outcome') && c.includes('not found')) {
    return 'Outcome label mismatch — BTC up/down markets need "Up" or "Down" (the app maps Yes/No automatically).';
  }
  if (c.includes('session expired') || c.includes('not logged') || c.includes('unauthorized')) {
    return 'Run `bullpen login` on the machine that runs the API, then `bullpen status`.';
  }
  if (c.includes('turnkey') || c.includes('sign_raw_payload') || c.includes('failed to sign')) {
    return 'Bullpen signer issue — try `bullpen upgrade`, then `bullpen logout` and `bullpen login` on the API host.';
  }
  if (c.includes('decimal places') || c.includes('tick size')) {
    return 'Limit price had too many decimals for this market (usually 1¢ ticks). The app now rounds to 2 decimals before sending — retry the order.';
  }
  return 'See message above; `bullpen polymarket preflight` and `bullpen doctor` on the API host.';
}

/**
 * Non-zero exit with JSON is often an order rejection (FOK), not a missing CLI.
 */
export function interpretBullpenTradeCli(
  stdout: string,
  stderr: string,
  exitCode: number | null,
):
  | { ok: true; parsed: unknown }
  | { ok: false; message: string; hint: string; parsed: unknown | null } {
  const parsed = parseBullpenTradeStdout(stdout);
  const result = bullpenTradeResult(parsed);
  if (result?.success === true) {
    return { ok: true, parsed: parsed ?? { result } };
  }
  if (parsed != null && result != null) {
    const root = parsed as Record<string, unknown>;
    const msg =
      String(result.error ?? root.error ?? '').trim() ||
      String(stderr ?? '').trim() ||
      'Bullpen order was rejected';
    return { ok: false, message: msg, hint: bullpenTradeFailureHint(msg), parsed };
  }
  if (exitCode === 0 && parsed != null) {
    return { ok: true, parsed };
  }
  const msg = (stderr || stdout).trim().slice(0, 1200) || 'Bullpen CLI failed';
  return { ok: false, message: msg, hint: bullpenTradeFailureHint(msg), parsed };
}

type ClobBookLevel = { price?: string; size?: string };

function bestAskBestBidFromBook(book: unknown): { bestAsk: number | null; bestBid: number | null } {
  const b = book as { asks?: ClobBookLevel[]; bids?: ClobBookLevel[] };
  let bestAsk: number | null = null;
  for (const a of b.asks ?? []) {
    const p = Number(a.price);
    if (Number.isFinite(p) && p > 0 && p < 1 && (bestAsk == null || p < bestAsk)) bestAsk = p;
  }
  let bestBid: number | null = null;
  for (const x of b.bids ?? []) {
    const p = Number(x.price);
    if (Number.isFinite(p) && p > 0 && p < 1 && (bestBid == null || p > bestBid)) bestBid = p;
  }
  return { bestAsk, bestBid };
}

function slipExplicitBuyPrice(bestAsk: number, tick = 0.01): number {
  const maxP = Math.min(0.99, 1 - tick);
  const cushion = Math.max(tick * 22, 0.012, bestAsk * 0.025);
  const target = Math.min(maxP, bestAsk + cushion);
  let out = Math.ceil((target + 1e-12) / tick) * tick;
  out = Math.min(maxP, Math.max(bestAsk, out));
  if (out <= bestAsk + 1e-12 && out + tick <= maxP + 1e-12) out = Math.min(maxP, out + tick);
  return roundPriceToTick(out, tick);
}

function slipExplicitSellPrice(bestBid: number, tick = 0.01): number {
  const minP = Math.max(0.01, tick);
  const cushion = Math.max(tick * 22, 0.012, bestBid * 0.025);
  const target = Math.max(minP, bestBid - cushion);
  let out = Math.floor((target - 1e-12) / tick) * tick;
  out = Math.max(minP, Math.min(bestBid, out));
  if (out >= bestBid - 1e-12 && out - tick >= minP - 1e-12) out = Math.max(minP, out - tick);
  return roundPriceToTick(out, tick);
}

function floorSizeShares4(n: number): number {
  return Math.floor(n * 10_000 + 1e-12) / 10_000;
}

/**
 * Bullpen `buy`/`sell` use FOK-style market paths; on FOK kill, retry as FAK limit at the touch.
 */
export async function bullpenExecuteMarketOrder(params: {
  marketSlug: string;
  outcomeArg: string;
  side: 'buy' | 'sell';
  amount: number;
  tokenId?: string;
  timeoutMs?: number;
}): Promise<{ r: CliResult; trade: ReturnType<typeof interpretBullpenTradeCli>; fakFallback?: boolean }> {
  const env = bullpenEnvName();
  const { marketSlug, outcomeArg, side, amount, tokenId, timeoutMs = 45_000 } = params;
  const marketArgs =
    side === 'buy'
      ? ['polymarket', 'buy', '--env', env, '--output', 'json', '--yes', marketSlug, outcomeArg, String(amount)]
      : ['polymarket', 'sell', '--env', env, '--output', 'json', '--yes', marketSlug, outcomeArg, String(amount)];

  let r = await runBullpen(marketArgs, { timeoutMs });
  let trade = interpretBullpenTradeCli(r.stdout, r.stderr, r.code);
  if (trade.ok || !tokenId?.trim()) return { r, trade };
  if (!isBullpenFokKill(trade.ok ? '' : trade.message)) return { r, trade };

  try {
    const book = await clobBookHttp(tokenId.trim());
    const { bestAsk, bestBid } = bestAskBestBidFromBook(book);
    const touch = side === 'buy' ? bestAsk : bestBid;
    if (touch == null) return { r, trade };

    const price = side === 'buy' ? slipExplicitBuyPrice(touch) : slipExplicitSellPrice(touch);
    const shares = side === 'buy' ? floorSizeShares4(amount / price) : floorSizeShares4(amount);
    if (shares < 1e-4) return { r, trade };

    const limitCmd =
      side === 'buy' ? 'limit-buy' : 'limit-sell';
    const fakArgs = [
      'polymarket',
      limitCmd,
      '--env',
      env,
      '--output',
      'json',
      '--yes',
      '--expiration',
      'fak',
      '--price',
      formatBullpenPriceArg(price),
      '--shares',
      String(shares),
      marketSlug,
      outcomeArg,
    ];
    const r2 = await runBullpen(fakArgs, { timeoutMs });
    const trade2 = interpretBullpenTradeCli(r2.stdout, r2.stderr, r2.code);
    if (trade2.ok) return { r: r2, trade: trade2, fakFallback: true };
  } catch {
    /* keep original FOK rejection */
  }
  return { r, trade };
}

export {
  findBullpenPositionRow,
  positionAvgEntry01,
  positionSize,
};
