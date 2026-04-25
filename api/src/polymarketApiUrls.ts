/**
 * Polymarket public API bases — see
 * https://docs.polymarket.com/api-reference/introduction
 *
 * - Gamma: market discovery, events, search
 * - Data: positions, activity, leaderboards (many routes public)
 * - CLOB: orderbooks, trading (L2 for orders)
 * - Bridge: deposits/withdrawals (third-party; optional override for tooling)
 */

const D = {
  gamma: 'https://gamma-api.polymarket.com',
  clob: 'https://clob.polymarket.com',
  data: 'https://data-api.polymarket.com',
  web: 'https://polymarket.com',
  bridge: 'https://bridge.polymarket.com',
} as const;

function pick(env: string | undefined, fallback: string): string {
  const t = env?.trim();
  return t || fallback;
}

export function gammaApiUrl(e: NodeJS.ProcessEnv = process.env): string {
  return pick(e.POLYMARKET_GAMMA_API_URL, D.gamma);
}

/** CLOB REST host (same as {@linkcode POLYMARKET_HOST} in trading). */
export function clobApiUrl(e: NodeJS.ProcessEnv = process.env): string {
  return pick(e.POLYMARKET_CLOB_API_URL ?? e.POLYMARKET_HOST, D.clob);
}

export function dataApiUrl(e: NodeJS.ProcessEnv = process.env): string {
  return pick(e.POLYMARKET_DATA_API_URL, D.data);
}

export function polymarketWebUrl(e: NodeJS.ProcessEnv = process.env): string {
  return pick(e.POLYMARKET_WEB_URL, D.web);
}

/** Bridge is separate from the three core APIs; include for config parity with docs. */
export function bridgeApiUrl(e: NodeJS.ProcessEnv = process.env): string {
  return pick(e.POLYMARKET_BRIDGE_API_URL, D.bridge);
}

export function polymarketApiBasesForHealth(e: NodeJS.ProcessEnv = process.env): {
  documentation: string;
  gamma: string;
  clob: string;
  data: string;
  web: string;
  bridge: string;
} {
  return {
    documentation: 'https://docs.polymarket.com/api-reference/introduction',
    gamma: gammaApiUrl(e),
    clob: clobApiUrl(e),
    data: dataApiUrl(e),
    web: polymarketWebUrl(e),
    bridge: bridgeApiUrl(e),
  };
}
