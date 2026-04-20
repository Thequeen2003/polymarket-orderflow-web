export function underlyingChartTitle(market: unknown): string {
  if (!market || typeof market !== 'object') return 'Spot (USD)';
  const o = market as Record<string, unknown>;
  const g = typeof o.groupItemTitle === 'string' ? o.groupItemTitle.trim() : '';
  if (g) return `${g} (USD)`;
  const q = typeof o.question === 'string' ? o.question : '';
  if (/btc|bitcoin/i.test(q)) return 'BTC Price (USD)';
  if (/eth|ethereum/i.test(q)) return 'ETH Price (USD)';
  if (/\bsol\b|solana/i.test(q)) return 'SOL Price (USD)';
  return 'Spot (USD)';
}
