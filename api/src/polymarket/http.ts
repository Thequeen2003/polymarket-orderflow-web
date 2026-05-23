/**
 * Thin fetch helpers for Polymarket public HTTP APIs (Gamma, CLOB, Data).
 */

export class PolymarketHttpError extends Error {
  readonly status: number;
  readonly bodyPreview: string;
  readonly url: string;

  constructor(status: number, bodyPreview: string, url: string) {
    super(`http_${status}: ${bodyPreview.slice(0, 240)}`);
    this.name = 'PolymarketHttpError';
    this.status = status;
    this.bodyPreview = bodyPreview;
    this.url = url;
  }
}

export type PolymarketGetJsonOpts = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export async function polymarketGetJson(url: string, opts?: PolymarketGetJsonOpts): Promise<unknown> {
  const timeoutMs = opts?.timeoutMs ?? 12_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signals: AbortSignal[] = [controller.signal];
  if (opts?.signal) signals.push(opts.signal);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : controller.signal;
  try {
    const r = await fetch(url, {
      headers: { accept: 'application/json', ...(opts?.headers ?? {}) },
      signal,
    });
    const text = await r.text();
    if (!r.ok) throw new PolymarketHttpError(r.status, text, url);
    const trimmed = text.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed) as unknown;
  } finally {
    clearTimeout(timer);
  }
}
