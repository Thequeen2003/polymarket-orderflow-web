/**
 * Read balances and positions from the Bullpen CLI (live account on Polymarket).
 * Used when `POLYMARKET_USE_BULLPEN` / live orders via Bullpen — avoids broken local CLOB keys.
 */
import { normalizeBullpenOutcomeName, resolveBullpenOutcome } from './bullpenOutcome.js';

function parseNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

export function positionsArrayFromBullpenRoot(parsed: unknown): Record<string, unknown>[] {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
  if (typeof parsed !== 'object') return [];
  const root = parsed as Record<string, unknown>;
  const maybe = (root.positions ?? root.data ?? root.result) as unknown;
  if (Array.isArray(maybe)) return maybe.filter((x) => x && typeof x === 'object') as Record<string, unknown>[];
  return [];
}

/** USDC available for Polymarket trading from `bullpen polymarket positions` summary. */
export function bullpenCashBalanceFromRoot(parsed: unknown): number | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const summary = (parsed as Record<string, unknown>).summary;
  if (!summary || typeof summary !== 'object') return null;
  return parseNum((summary as Record<string, unknown>).cash_balance);
}

function slugMatches(wantSlug: string, row: Record<string, unknown>): boolean {
  const w = norm(wantSlug);
  if (!w) return false;
  const got = norm(row.slug ?? row.market_slug ?? row.marketSlug ?? row.market);
  if (!got) return false;
  if (got === w) return true;
  return got.endsWith(`/${w}`) || w.endsWith(`/${got}`) || got.endsWith(w) || w.endsWith(got);
}

function outcomeMatches(wantOutcome: string, marketSlug: string, row: Record<string, unknown>): boolean {
  const w = normalizeBullpenOutcomeName(
    resolveBullpenOutcome({ outcome: wantOutcome, marketSlug }),
  ).toLowerCase();
  if (!w) return false;
  const got = normalizeBullpenOutcomeName(
    String(row.outcome ?? row.outcome_name ?? row.outcomeName ?? ''),
  ).toLowerCase();
  return Boolean(got && got === w);
}

function tokenMatches(wantTokenId: string, row: Record<string, unknown>): boolean {
  const w = String(wantTokenId ?? '').trim();
  if (!w) return false;
  const fields = [
    row.asset,
    row.asset_id,
    row.assetId,
    row.token_id,
    row.tokenId,
    row.clob_token_id,
    row.clobTokenId,
  ];
  return fields.some((f) => String(f ?? '').trim() === w);
}

export function findBullpenPositionRow(
  positions: Record<string, unknown>[],
  opts: { marketSlug?: string; outcome?: string; tokenId?: string },
): Record<string, unknown> | undefined {
  const slug = String(opts.marketSlug ?? '').trim();
  const outcome = String(opts.outcome ?? '').trim();
  const tokenId = String(opts.tokenId ?? '').trim();

  if (tokenId) {
    const byToken = positions.find((p) => tokenMatches(tokenId, p));
    if (byToken) return byToken;
  }
  if (slug && outcome) {
    return positions.find((p) => slugMatches(slug, p) && outcomeMatches(outcome, slug, p));
  }
  return undefined;
}

export function positionSize(row: Record<string, unknown>): number {
  return parseNum(row.size ?? row.shares ?? row.position ?? row.quantity) ?? 0;
}

function toEntryPrice01(raw: unknown): number | null {
  const n = parseNum(raw);
  if (n == null) return null;
  if (n > 1.0001 && n <= 100) return n / 100;
  if (n >= 0 && n <= 1.0001) return n;
  return null;
}

/** Cost-basis entry only — never use mark/cur price fields mislabeled as avg_price. */
export function positionAvgEntry01(row: Record<string, unknown>): number | null {
  const costKeys = [
    'avg_entry',
    'avgEntry',
    'entry_price',
    'entryPrice',
    'cost_basis',
    'costBasis',
    'average_entry_price',
    'averageEntryPrice',
  ] as const;
  for (const k of costKeys) {
    const v = toEntryPrice01(row[k]);
    if (v != null) return v;
  }
  const mark = toEntryPrice01(
    row.cur_price ??
      row.curPrice ??
      row.mark_price ??
      row.markPrice ??
      row.current_price ??
      row.currentPrice,
  );
  const avgP = toEntryPrice01(row.avg_price ?? row.avgPrice);
  if (avgP != null && mark != null && Math.abs(avgP - mark) < 0.008) return null;
  return avgP;
}

/** Sum Polygon pUSD from `bullpen portfolio balances` when positions summary is missing. */
export function polymarketUsdcFromPortfolioBalances(parsed: unknown): number | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const chains = (parsed as Record<string, unknown>).chains;
  if (!Array.isArray(chains)) return null;
  for (const c of chains) {
    if (!c || typeof c !== 'object') continue;
    const o = c as Record<string, unknown>;
    const label = norm(o.label ?? o.chain_name);
    if (!label.includes('polymarket') && Number(o.chain_id) !== 10) continue;
    const items = o.items;
    if (!Array.isArray(items)) continue;
    let pusd = 0;
    let found = false;
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const row = it as Record<string, unknown>;
      if (norm(row.symbol) !== 'pusd') continue;
      const b = parseNum(row.balance);
      if (b != null) {
        pusd += b;
        found = true;
      }
    }
    if (found) return pusd;
  }
  return null;
}

export function bullpenStatusShowsLoggedIn(stdout: string): boolean {
  return /status:\s*logged in/i.test(stdout);
}
