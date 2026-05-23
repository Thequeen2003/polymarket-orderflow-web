import { describe, expect, it } from 'vitest';

import {
  LIVE_TRADING_CONFIRM_PHRASE,
  isEnableLiveTrading,
  isLiveTradingConfirmed,
  liveOrdersViaBullpen,
  liveTradingGate,
} from './liveTradingPolicy.js';

describe('liveTradingPolicy', () => {
  it('requires ENABLE_LIVE_TRADING and confirm phrase', () => {
    expect(liveTradingGate({}).ok).toBe(false);
    expect(
      liveTradingGate({
        ENABLE_LIVE_TRADING: 'true',
        POLYMARKET_LIVE_CONFIRM: LIVE_TRADING_CONFIRM_PHRASE,
      }).ok,
    ).toBe(true);
  });

  it('uses CLOB when live gate passes and keys validate', () => {
    const env = {
      ENABLE_LIVE_TRADING: 'true',
      POLYMARKET_LIVE_CONFIRM: LIVE_TRADING_CONFIRM_PHRASE,
      POLYMARKET_PRIVATE_KEY: '0x' + '11'.repeat(32),
      POLYMARKET_FUNDER_ADDRESS: '0x' + '22'.repeat(20),
      POLYMARKET_SIGNATURE_TYPE: '0',
      POLYMARKET_CHAIN_ID: '137',
    };
    expect(isEnableLiveTrading(env)).toBe(true);
    expect(isLiveTradingConfirmed(env)).toBe(true);
    expect(liveOrdersViaBullpen(env)).toBe(false);
  });

  it('honors POLYMARKET_LIVE_ORDERS_VIA=bullpen over CLOB keys', () => {
    const env = {
      ENABLE_LIVE_TRADING: 'true',
      POLYMARKET_LIVE_CONFIRM: LIVE_TRADING_CONFIRM_PHRASE,
      POLYMARKET_LIVE_ORDERS_VIA: 'bullpen',
      POLYMARKET_PRIVATE_KEY: '0x' + '11'.repeat(32),
      POLYMARKET_FUNDER_ADDRESS: '0x' + '22'.repeat(20),
      POLYMARKET_SIGNATURE_TYPE: '0',
      POLYMARKET_CHAIN_ID: '137',
    };
    expect(liveOrdersViaBullpen(env)).toBe(true);
  });
});
