import type { ApiErr } from './lib/api';

/** Human-readable live-trade error (Bullpen / CLOB) instead of raw JSON blobs. */
export function formatTradeApiError(e: ApiErr): string {
  const parts: string[] = [e.error];
  const d = e.details;
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const o = d as Record<string, unknown>;
    const message = typeof o.message === 'string' ? o.message.trim() : '';
    const hint = typeof o.hint === 'string' ? o.hint.trim() : '';
    const reason = typeof o.reason === 'string' ? o.reason.trim() : '';
    if (message) parts.push(message);
    else if (reason) parts.push(reason);
    if (hint) parts.push(hint);
  } else if (d != null) {
    parts.push(typeof d === 'string' ? d : JSON.stringify(d));
  }
  return parts.filter(Boolean).join(' — ');
}
