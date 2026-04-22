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

export type ParsedRestingOrder = {
  statusRaw: string;
  matchedShares: number | null;
  originalShares: number | null;
  avgPrice01: number | null;
  /** True when order is done (filled, cancelled, or terminal matched). */
  isTerminal: boolean;
  isCancelled: boolean;
};

export function parseRestingOrderSnapshot(raw: unknown): ParsedRestingOrder {
  if (!raw || typeof raw !== 'object') {
    return {
      statusRaw: '',
      matchedShares: null,
      originalShares: null,
      avgPrice01: null,
      isTerminal: false,
      isCancelled: false,
    };
  }
  const o = raw as Record<string, unknown>;
  const statusRaw = String(o.status ?? o.order_status ?? o.state ?? '').trim();
  const u = statusRaw.toUpperCase();
  const matchedShares = pickNum(o, ['size_matched', 'sizeMatched', 'matched', 'matched_size', 'filled_size']);
  const originalShares = pickNum(o, ['original_size', 'originalSize', 'size', 'original']);
  const avgRaw = pickNum(o, ['avg_price', 'avgPrice', 'average_price', 'price']);
  const avgPrice01 = avgRaw != null ? toPrice01(avgRaw) : null;

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

  return { statusRaw, matchedShares, originalShares, avgPrice01, isTerminal, isCancelled };
}
