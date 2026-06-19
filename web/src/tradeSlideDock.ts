export type SlideDockTab = 'outcome' | 'brackets' | 'ledger';

let cachedSlideDockTab: SlideDockTab = 'outcome';
let cachedSlideDockMarketSlug = '';

/** Restore slide dock tab for the same market across panel remounts. */
export function readSlideDockTab(marketSlug?: string): SlideDockTab {
  const slug = marketSlug?.trim() ?? '';
  if (!slug || slug !== cachedSlideDockMarketSlug) return 'outcome';
  return cachedSlideDockTab;
}

export function writeSlideDockTab(tab: SlideDockTab, marketSlug?: string): void {
  cachedSlideDockTab = tab;
  cachedSlideDockMarketSlug = marketSlug?.trim() ?? '';
}
