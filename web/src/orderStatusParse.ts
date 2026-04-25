/** Best-effort parse of Polymarket `getOrder` payloads (shape varies). */

function pickNum(o: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const p = parseFloat(v);
      if (Number.isFinite(p)) return p;
    }
  }
  return null;
}

function toPrice01(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  if (raw <= 1) return raw;
  if (raw <= 100) return raw / 100;
  return null;
}

function plausibleOutcomeShares(n: number): boolean {
  return Number.isFinite(n) && n > 0 && n < 1e7;
}

function makerOrderAssetId(mo: Record<string, unknown>): string {
  return String(mo.asset_id ?? mo.assetId ?? mo.token_id ?? mo.tokenID ?? mo.asset ?? '').trim();
}

/** VWAP from maker fills on an order snapshot (`getOrder` / resting order). */
function vwap01FromMakerOrders(o: Record<string, unknown>, assetIdFilter?: string): number | null {
  const want = assetIdFilter?.trim() || '';
  const mos = o.maker_orders ?? o.makerOrders;
  if (!Array.isArray(mos) || mos.length === 0) return null;
  let anyMakerAsset = false;
  if (want) {
    for (const mo of mos) {
      if (!mo || typeof mo !== 'object') continue;
      if (makerOrderAssetId(mo as Record<string, unknown>)) {
        anyMakerAsset = true;
        break;
      }
    }
  }
  const filterByToken = Boolean(want && anyMakerAsset);
  let sumPxSz = 0;
  let sumSz = 0;
  for (const mo of mos) {
    if (!mo || typeof mo !== 'object') continue;
    const m = mo as Record<string, unknown>;
    if (filterByToken) {
      const aid = makerOrderAssetId(m);
      if (aid && aid !== want) continue;
    }
    const pRaw = pickNum(m, ['price', 'matched_price', 'avg_price', 'avgPrice']);
    const sRaw = pickNum(m, ['matched_amount', 'size', 'amount', 'quantity', 'shares']);
    if (pRaw == null || sRaw == null) continue;
    const p01 = toPrice01(pRaw);
    if (p01 == null || !plausibleOutcomeShares(sRaw)) continue;
    sumPxSz += p01 * sRaw;
    sumSz += sRaw;
  }
  if (sumSz <= 0) return null;
  return Math.round((sumPxSz / sumSz) * 1_000_000) / 1_000_000;
}

export type ParsedRestingOrder = {
  statusRaw: string;
  matchedShares: number | null;
  originalShares: number | null;
  /** Accepted limit price on the resting order (what Polymarket says the order is at). */
  limitPrice01: number | null;
  avgPrice01: number | null;
  /** True when order is done (filled, cancelled, or terminal matched). */
  isTerminal: boolean;
  isCancelled: boolean;
};

export function parseRestingOrderSnapshot(raw: unknown, assetIdFilter?: string): ParsedRestingOrder {
  if (!raw || typeof raw !== 'object') {
    return {
      statusRaw: '',
      matchedShares: null,
      originalShares: null,
      limitPrice01: null,
      avgPrice01: null,
      isTerminal: false,
      isCancelled: false,
    };
  }
  const o = raw as Record<string, unknown>;
  const statusRaw = String(o.status ?? o.order_status ?? o.state ?? '').trim();
  const u = statusRaw.toUpperCase();
  const limitRaw = pickNum(o, ['price', 'price01', 'limit_price', 'limitPrice', 'original_price', 'originalPrice']);
  const limitPrice01 = limitRaw != null ? toPrice01(limitRaw) : null;
  const matchedShares = pickNum(o, [
    'size_matched',
    'sizeMatched',
    'matched',
    'matched_size',
    'matchedSize',
    'filled_size',
    'filledSize',
    'filled_shares',
    'filledShares',
  ]);
  const originalShares = pickNum(o, ['original_size', 'originalSize', 'original', 'total_size', 'size']);
  const vwap = vwap01FromMakerOrders(o, assetIdFilter);
  const avgFillOnly = pickNum(o, ['avg_fill_price', 'avgFillPrice', 'avg_fill_price_01', 'mean_execution_price', 'meanExecutionPrice']);
  const avgLoose = pickNum(o, ['average_price', 'averagePrice', 'avg_price', 'avgPrice', 'price']);
  const avgPrice01 =
    vwap ??
    (avgFillOnly != null ? toPrice01(avgFillOnly) : null) ??
    (avgLoose != null ? toPrice01(avgLoose) : null);

  const isCancelled = u.includes('CANCEL');
  const fullyMatched =
    matchedShares != null &&
    originalShares != null &&
    matchedShares > 0 &&
    originalShares > 0 &&
    matchedShares >= originalShares - 5e-5;
  const isTerminal =
    isCancelled ||
    fullyMatched ||
    u === 'FILLED' ||
    u === 'MATCHED' ||
    u.includes('FILLED') ||
    u.includes('EXECUTED');

  return { statusRaw, matchedShares, originalShares, limitPrice01, avgPrice01, isTerminal, isCancelled };
}
