/**
 * Parse Polymarket / Bullpen open-order size fields.
 * CLOB resting orders often expose `size` as **remaining** unfilled shares, not original.
 */

function asNum(x: unknown): number | null {
  const n = typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
}

function matchedSharesFromSnapshot(r: Record<string, unknown>): number | null {
  return asNum(
    r.size_matched ??
      r.sizeMatched ??
      r.matched_size ??
      r.matchedSize ??
      r.matched ??
      r.filled_size ??
      r.filledSize ??
      r.filled_amount ??
      r.filledAmount,
  );
}

function explicitRemainingFromSnapshot(r: Record<string, unknown>): number | null {
  return asNum(
    r.remaining ??
      r.sizeRemaining ??
      r.remaining_size ??
      r.remainingSize ??
      r.open_size ??
      r.openSize ??
      r.unfilled_size ??
      r.unfilledSize,
  );
}

/** Total shares placed on the order (not remaining). */
export function orderOriginalSizeFromSnapshot(o: unknown): number | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const orig = asNum(
    r.original_size ??
      r.originalSize ??
      r.total_size ??
      r.totalSize ??
      r.original_amount ??
      r.originalAmount ??
      r.maker_amount ??
      r.makerAmount,
  );
  if (orig != null) return orig;
  const rem = explicitRemainingFromSnapshot(r) ?? asNum(r.size);
  const matched = matchedSharesFromSnapshot(r);
  if (rem != null && matched != null) return rem + matched;
  return null;
}

/** Shares still resting on the book. */
export function orderRemainingFromSnapshot(o: unknown): number | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const explicit = explicitRemainingFromSnapshot(r);
  if (explicit != null) return Math.max(0, explicit);

  const orig = orderOriginalSizeFromSnapshot(o);
  const matched = matchedSharesFromSnapshot(r);
  if (orig != null && matched != null) return Math.max(0, orig - matched);

  const sizeField = asNum(r.size ?? r.amount ?? r.quantity);
  if (sizeField == null) return null;
  if (orig == null) return Math.max(0, sizeField);
  if (sizeField <= orig + 1e-5) return Math.max(0, sizeField);
  return Math.max(0, orig - (matched ?? 0));
}

export function orderIdFromOpenSnapshot(o: unknown): string | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const id = r.id ?? r.orderID ?? r.orderId ?? r.order_id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/** Exchange open orders + local pending rows not yet visible on the book (deduped by order id). */
export function liveOpenOrderDisplayCount(exchangeOrders: unknown[], localPendingRows: { orderId?: string | null }[]): number {
  const seen = new Set<string>();
  let exchangeCount = 0;
  for (const o of exchangeOrders) {
    const id = orderIdFromOpenSnapshot(o);
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    exchangeCount += 1;
  }
  let extra = 0;
  for (const r of localPendingRows) {
    const id = r.orderId?.trim();
    if (id && seen.has(id)) continue;
    extra += 1;
  }
  return exchangeCount + extra;
}
