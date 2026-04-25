/** Server-attached fields for trade API responses (market + limit). */

export type TradeFillEnvelope = {
  filled_shares: number | null;
  avg_fill_price_01: number | null;
  status: 'filled' | 'partial' | 'unknown';
};

export type TradeExecutionMeta = {
  submitted_price_01: number | null;
  submitted_size_shares?: number | null;
  order_id?: string | null;
  round_trip_ms?: number | null;
  best_bid_01?: number | null;
  best_ask_01?: number | null;
  /** Canonical market fill from server (`clobFillExtract`); limit orders usually omit until matched. */
  fill?: TradeFillEnvelope | null;
};

export type WrappedTradeResult<T = unknown> = {
  result: T;
  execution?: TradeExecutionMeta;
};

export function unwrapTradeActionData<T = unknown>(data: T | WrappedTradeResult<T>): WrappedTradeResult<T> {
  if (data && typeof data === 'object' && 'result' in data) {
    const w = data as WrappedTradeResult<T>;
    return { result: w.result, execution: w.execution };
  }
  return { result: data as T };
}

/** Pull CLOB order id from create/post responses (shape varies by SDK). */
export function extractOrderIdFromClobPayload(obj: unknown): string | null {
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

  // Common nesting shapes: { order: {...} }, { data: {...} }, { result: {...} }
  for (const k of ['order', 'data', 'result', 'payload', 'response'] as const) {
    const v = root[k];
    if (v && typeof v === 'object') {
      const got = pick(v as Record<string, unknown>);
      if (got) return got;
      // One more nesting level (e.g. data.order.id)
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

/** Use server `execution.fill` only — no client-side fill guessing. */
export function liveMarketOrderFillFromExecution(
  execution: TradeExecutionMeta | undefined,
  parsed: unknown,
):
  | { ok: true; shares: number; avg01: number; rowStatus: 'filled' | 'partial' }
  | { ok: false; orderId: string | null } {
  const fill = execution?.fill;
  const oid = execution?.order_id ?? extractOrderIdFromClobPayload(parsed);
  if (
    fill &&
    fill.filled_shares != null &&
    fill.avg_fill_price_01 != null &&
    Number.isFinite(fill.filled_shares) &&
    fill.filled_shares > 0 &&
    Number.isFinite(fill.avg_fill_price_01) &&
    fill.avg_fill_price_01 > 0 &&
    fill.avg_fill_price_01 < 1
  ) {
    const rowStatus: 'filled' | 'partial' = fill.status === 'partial' ? 'partial' : 'filled';
    return { ok: true, shares: fill.filled_shares, avg01: fill.avg_fill_price_01, rowStatus };
  }
  return { ok: false, orderId: oid };
}
