/** Keep only resting CLOB/Bullpen orders in open-order API responses. */

function orderStatusUpper(o: Record<string, unknown>): string {
  return String(o.status ?? o.order_status ?? o.state ?? '').trim().toUpperCase();
}

export function isRestingOpenOrder(o: Record<string, unknown>): boolean {
  const status = orderStatusUpper(o);
  if (!status) return true;
  if (/\bCANCEL(L)?ED\b/.test(status)) return false;
  if (
    status === 'FILLED' ||
    status === 'MATCHED' ||
    status === 'EXECUTED' ||
    status === 'COMPLETE' ||
    status === 'COMPLETED' ||
    status === 'SETTLED' ||
    /\bFILLED\b/.test(status) ||
    /\bMATCHED\b/.test(status)
  ) {
    return false;
  }
  return (
    status === 'LIVE' ||
    status === 'OPEN' ||
    status === 'ACTIVE' ||
    status === 'UNFILLED' ||
    status === 'RESTING' ||
    status === 'PENDING' ||
    status === 'SUBMITTED' ||
    status === 'PLACED'
  );
}

export function filterRestingOpenOrders(orders: Record<string, unknown>[]): Record<string, unknown>[] {
  return orders.filter((o) => isRestingOpenOrder(o));
}
