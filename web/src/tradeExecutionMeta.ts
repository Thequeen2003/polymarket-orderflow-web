/** Server-attached fields for trade API responses (market + limit). */

export type TradeExecutionMeta = {
  submitted_price_01: number | null;
  submitted_size_shares?: number | null;
  order_id?: string | null;
  round_trip_ms?: number | null;
  best_bid_01?: number | null;
  best_ask_01?: number | null;
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
  const o = obj as Record<string, unknown>;
  for (const k of ['orderID', 'orderId', 'order_id', 'id'] as const) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}
