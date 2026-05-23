import { clobApiUrl } from '../polymarketApiUrls.js';
import { PolymarketHttpError, polymarketGetJson } from './http.js';

const CLOB = () => clobApiUrl().replace(/\/+$/, '');

const DEFAULT_BOOK_TIMEOUT_MS = 10_000;

export async function clobBookHttp(tokenId: string, opts?: { timeoutMs?: number }): Promise<unknown> {
  const url = `${CLOB()}/book?token_id=${encodeURIComponent(tokenId)}`;
  return polymarketGetJson(url, { timeoutMs: opts?.timeoutMs ?? DEFAULT_BOOK_TIMEOUT_MS });
}

export async function clobHasOrderbook(tokenId: string): Promise<boolean> {
  const url = `${CLOB()}/book?token_id=${encodeURIComponent(tokenId)}`;
  try {
    await polymarketGetJson(url, { timeoutMs: 8_000 });
    return true;
  } catch (e) {
    if (e instanceof PolymarketHttpError && e.status === 404) return false;
    throw e;
  }
}

export async function clobLastTradePrice(tokenId: string): Promise<unknown> {
  const url = `${CLOB()}/last-trade-price?token_id=${encodeURIComponent(tokenId)}`;
  return polymarketGetJson(url, { timeoutMs: 8_000 });
}

/** Health probe — detects Cloudflare HTML block pages (`/ok` returns JSON `"OK"`). */
export async function clobOkJsonProbe(host?: string): Promise<{ ok: boolean; status: number | null; note: string | null }> {
  const base = (host ?? CLOB()).replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}/ok`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const text = await r.text();
    if (/cloudflare|Attention Required|you have been blocked|cf-ray/i.test(text) || text.trim().startsWith('<!DOCTYPE')) {
      return { ok: false, status: r.status, note: 'cloudflare_or_html' };
    }
    if (!r.ok) return { ok: false, status: r.status, note: `http_${r.status}` };
    const trimmed = text.trim();
    if (trimmed === '"OK"' || trimmed === 'OK') return { ok: true, status: r.status, note: null };
    return { ok: false, status: r.status, note: 'unexpected_body' };
  } catch (e) {
    return { ok: false, status: null, note: e instanceof Error ? e.message : String(e) };
  }
}
