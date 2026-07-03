const PTB_NUM = String.raw`\d+(?:\.\d+)?`;

/** Locked PTB from dehydrated event JSON (settled windows and some hourly pages). */
export function parsePolymarketPagePtbFromHtml(html: string): { value: number; source: string } | null {
  const beat = html.match(new RegExp(String.raw`"priceToBeat"\s*:\s*(${PTB_NUM})`));
  if (beat) {
    const v = Number(beat[1]);
    if (Number.isFinite(v) && v > 0) return { value: v, source: 'polymarket_page_price_to_beat' };
  }
  // Live 15m/5m bucket pages expose the active window open as openPrice with closePrice still null.
  const open = html.match(new RegExp(String.raw`"openPrice"\s*:\s*(${PTB_NUM})\s*,\s*"closePrice"\s*:\s*null`));
  if (open) {
    const v = Number(open[1]);
    if (Number.isFinite(v) && v > 0) return { value: v, source: 'polymarket_page_open_price' };
  }
  return null;
}

/** Parse embedded PTB from Polymarket event HTML (works for 5m / 15m / 1h / 4h / 1d up-down). */
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
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    return parsePolymarketPagePtbFromHtml(html);
  } catch {
    return null;
  }
}
