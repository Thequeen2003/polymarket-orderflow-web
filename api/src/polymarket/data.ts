import { dataApiUrl } from '../polymarketApiUrls.js';
import { polymarketGetJson } from './http.js';

const DATA = () => dataApiUrl();

export type DataApiTradeRow = {
  timestamp: number;
  side: string;
  price: number | null;
  size: number | null;
  outcome: string | null;
  asset: string;
  transactionHash: string | null;
  pseudonym: string | null;
};

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Public Data API — matched trades for a condition id (no CLOB keys). */
export async function dataApiRecentTrades(params: {
  conditionId: string;
  limit: number;
}): Promise<DataApiTradeRow[]> {
  const market = params.conditionId.trim().toLowerCase();
  const url = `${DATA()}/trades?limit=${params.limit}&market=${encodeURIComponent(market)}`;
  const raw = await polymarketGetJson(url);
  if (!Array.isArray(raw)) return [];
  const out: DataApiTradeRow[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const o = row as Record<string, unknown>;
    const ts = num(o.timestamp ?? o.match_time ?? o.time);
    if (ts == null) continue;
    out.push({
      timestamp: ts > 1e12 ? Math.floor(ts) : Math.floor(ts * 1000),
      side: String(o.side ?? o.taker_side ?? ''),
      price: num(o.price),
      size: num(o.size ?? o.amount),
      outcome: o.outcome != null ? String(o.outcome) : null,
      asset: String(o.asset ?? o.asset_id ?? ''),
      transactionHash: o.transactionHash != null ? String(o.transactionHash) : o.transaction_hash != null ? String(o.transaction_hash) : null,
      pseudonym: o.pseudonym != null ? String(o.pseudonym) : o.name != null ? String(o.name) : null,
    });
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out;
}
