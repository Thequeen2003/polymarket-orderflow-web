export type BacktestPoint = {
  /** Epoch ms */
  t: number;
  /** Fixed PTB for the round (USD). Repeated for convenience. */
  ptbUsd: number;
  /** Underlying spot (USD) at time t. */
  spotUsd: number;
  /** Outcome mid (0..1) for UP token at time t (nullable if unknown). */
  upMid01: number | null;
  /** Outcome mid (0..1) for DOWN token at time t (nullable if unknown). */
  downMid01: number | null;
};

export type BacktestDatasetV1 = {
  v: 1;
  slug: string;
  interval?: string;
  /** Outcome token ids for the round. */
  upTokenId: string;
  downTokenId: string;
  points: BacktestPoint[];
};

export type BacktestTrade = {
  t: number;
  tokenId: string;
  side: 'buy' | 'sell';
  price01: number;
  shares: number;
  usdCents: number;
  note?: string;
};

export type BacktestResult = {
  slug: string;
  points: number;
  startT: number | null;
  endT: number | null;
  finalCashUsdCents: number;
  finalRealizedPnlUsdCents: number;
  finalEquityUsdCents: number;
  trades: BacktestTrade[];
  /** Debug summary lines for quick iteration. */
  summaryLines: string[];
};

