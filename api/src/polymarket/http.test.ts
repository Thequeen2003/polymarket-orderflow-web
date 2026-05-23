import { describe, expect, it, vi, afterEach } from 'vitest';

import { PolymarketHttpError, polymarketGetJson } from './http.js';

describe('polymarketGetJson', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses JSON on 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    const data = await polymarketGetJson('https://gamma-api.polymarket.com/markets?limit=1');
    expect(data).toEqual({ ok: true });
  });

  it('throws PolymarketHttpError on non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 502 })));
    await expect(polymarketGetJson('https://example.test/x')).rejects.toBeInstanceOf(PolymarketHttpError);
  });
});
