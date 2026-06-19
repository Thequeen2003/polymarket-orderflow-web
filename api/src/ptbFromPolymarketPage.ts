/** Parse embedded `priceToBeat` from Polymarket event HTML (works for 1h / 4h / 1d up-down). */
export async function tryPolymarketPagePtb(
  slug: string,
  webBase: string,
): Promise<{ value: number; source: string } | null> {
  const s = slug.trim();
  if (!s) return null;
  try {
    const res = await fetch(`${webBase.replace(/\/$/, '')}/event/${encodeURIComponent(s)}`, {
      headers: {
        'user-agent': 'polymarket-orderflow-web/1.0',
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/"priceToBeat"\s*:\s*(\d+(?:\.\d+)?)/);
    if (!m) return null;
    const v = Number(m[1]);
    if (!Number.isFinite(v) || v <= 0) return null;
    return { value: v, source: 'polymarket_page_price_to_beat' };
  } catch {
    return null;
  }
}
