import { midPrice, pickBookLevels, spreadWidth, topOfBook, type BookLevel } from './bookLevels';

function sumNotional(levels: BookLevel[], n: number): number {
  let s = 0;
  for (let i = 0; i < Math.min(n, levels.length); i++) {
    s += levels[i]!.price * levels[i]!.size;
  }
  return s;
}

function sumSize(levels: BookLevel[], n: number): number {
  let s = 0;
  for (let i = 0; i < Math.min(n, levels.length); i++) s += levels[i]!.size;
  return s;
}

/** Touch microprice: where the next marginal trade “leans” using only best bid/ask sizes. */
function micropriceAtTouch(bestBid: number, bestAsk: number, bidSize: number, askSize: number): number | null {
  const d = bidSize + askSize;
  if (!(d > 0)) return null;
  return (bestBid * askSize + bestAsk * bidSize) / d;
}

export type BookIntel = {
  mid: number | null;
  spread: number | null;
  microprice: number | null;
  microSkew: number | null;
  bidNotional5: number;
  askNotional5: number;
  imbalanceNotional5: number | null;
  bidSize5: number;
  askSize5: number;
  /** First ask level (above touch) with unusually thin size vs neighbors — “air pocket” hint */
  thinAskStepHint: string | null;
};

export function computeBookIntel(book: unknown): BookIntel | null {
  const { bids, asks } = pickBookLevels(book);
  if (bids.length === 0 && asks.length === 0) return null;
  const mid = midPrice(book);
  const spread = spreadWidth(book);
  const tob = topOfBook(book);
  const bsz = bids[0]?.size ?? 0;
  const asz = asks[0]?.size ?? 0;
  let microprice: number | null = null;
  let microSkew: number | null = null;
  if (tob.bestBid != null && tob.bestAsk != null && bsz + asz > 0) {
    microprice = micropriceAtTouch(tob.bestBid, tob.bestAsk, bsz, asz);
    if (mid != null && microprice != null) microSkew = microprice - mid;
  }
  const bidN = sumNotional(bids, 5);
  const askN = sumNotional(asks, 5);
  const denom = bidN + askN;
  const imbalanceNotional5 = denom > 0 ? (bidN - askN) / denom : null;
  const bidSize5 = sumSize(bids, 5);
  const askSize5 = sumSize(asks, 5);

  let thinAskStepHint: string | null = null;
  if (asks.length >= 4) {
    const sizes = asks.slice(0, 8).map((l) => l.size);
    const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    for (let i = 1; i < Math.min(6, asks.length); i++) {
      if (avg > 0 && asks[i]!.size < avg * 0.25) {
        thinAskStepHint = `Thin ask band near ${asks[i]!.price.toFixed(4)} (size ${asks[i]!.size.toFixed(0)} vs avg ${avg.toFixed(0)})`;
        break;
      }
    }
  }

  return {
    mid,
    spread,
    microprice,
    microSkew,
    bidNotional5: bidN,
    askNotional5: askN,
    imbalanceNotional5,
    bidSize5,
    askSize5,
    thinAskStepHint,
  };
}

export function bookIntelLines(intel: BookIntel): string[] {
  const lines: string[] = [];
  if (intel.mid != null) lines.push(`Mid ${intel.mid.toFixed(4)} · spread ${intel.spread != null ? intel.spread.toFixed(4) : '—'}`);
  if (intel.microprice != null && intel.microSkew != null) {
    const dir = intel.microSkew > 0.0008 ? 'buy pressure at touch' : intel.microSkew < -0.0008 ? 'sell pressure at touch' : 'roughly neutral at touch';
    lines.push(`Microprice ${intel.microprice.toFixed(4)} (${dir}, skew ${intel.microSkew >= 0 ? '+' : ''}${intel.microSkew.toFixed(4)})`);
  }
  if (intel.imbalanceNotional5 != null) {
    const pct = (intel.imbalanceNotional5 * 100).toFixed(0);
    lines.push(
      `Notional depth top 5: bids $${intel.bidNotional5.toFixed(0)} vs asks $${intel.askNotional5.toFixed(0)} → imbalance ${pct}% (bid-heavy if +)`,
    );
  }
  lines.push(`Share size top 5: bids Σ${intel.bidSize5.toFixed(0)} vs asks Σ${intel.askSize5.toFixed(0)}`);
  if (intel.thinAskStepHint) lines.push(intel.thinAskStepHint);
  return lines;
}

/** One block for assistant / logs (no advice). */
export function bookIntelForAssistant(label: string, book: unknown): string {
  const intel = computeBookIntel(book);
  if (!intel) return `[${label}] book intel: (empty book)`;
  return [`[${label}] book intel:`, ...bookIntelLines(intel).map((l) => `  ${l}`)].join('\n');
}

export type GammaVolumeStats = {
  volume?: string;
  volume24hr?: string;
  liquidity?: string;
};

/** Best-effort Gamma fields (strings as returned by API). */
/** Parent market condition id (0x + 64 hex) for Data API trade filters. */
export function pickConditionId(market: unknown | null): string | null {
  if (!market || typeof market !== 'object') return null;
  const o = market as Record<string, unknown>;
  const c = o.conditionId ?? o.condition_id;
  if (typeof c !== 'string') return null;
  const t = c.trim();
  return /^0x[a-fA-F0-9]{64}$/i.test(t) ? t.toLowerCase() : null;
}

export function pickGammaVolumeStats(market: unknown | null): GammaVolumeStats {
  if (!market || typeof market !== 'object') return {};
  const o = market as Record<string, unknown>;
  const pick = (k: string) => {
    const v = o[k];
    if (v == null) return undefined;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'string' && v.trim()) return v.trim();
    return undefined;
  };
  return {
    volume: pick('volume') ?? pick('volumeNum') ?? pick('volumeClob'),
    volume24hr: pick('volume24hr') ?? pick('volume_24hr') ?? pick('volume24Hr'),
    liquidity: pick('liquidity') ?? pick('liquidityNum'),
  };
}

export function formatGammaVolumeLines(stats: GammaVolumeStats): string[] {
  const lines: string[] = [];
  if (stats.volume24hr) lines.push(`24h volume (Gamma): ${stats.volume24hr}`);
  if (stats.volume) lines.push(`Total volume (Gamma): ${stats.volume}`);
  if (stats.liquidity) lines.push(`Liquidity / pool (Gamma): ${stats.liquidity}`);
  if (lines.length === 0) lines.push('No Gamma volume fields on this row (still use CLOB for live quotes).');
  return lines;
}
