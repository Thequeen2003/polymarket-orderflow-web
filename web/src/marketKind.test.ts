import { describe, expect, it } from 'vitest';
import { inferMarketKind, marketUsesPtbSpotDesk } from './marketKind';

describe('marketKind', () => {
  it('detects crypto updown slugs', () => {
    expect(inferMarketKind('btc-updown-5m-1776735900')).toBe('crypto_updown');
    expect(inferMarketKind('eth-updown-5m-1780860300')).toBe('crypto_updown');
    expect(inferMarketKind('sol-updown-5m-1780860300')).toBe('crypto_updown');
    expect(inferMarketKind('btc-updown-1h-1776735900')).toBe('crypto_updown');
    expect(marketUsesPtbSpotDesk('crypto_updown')).toBe(true);
  });

  it('detects titled Polymarket hourly/daily up-down slugs', () => {
    expect(inferMarketKind('bitcoin-up-or-down-may-16-2026-4pm-et')).toBe('crypto_updown');
    expect(inferMarketKind('ethereum-up-or-down-june-5-2026-11am-et')).toBe('crypto_updown');
    expect(inferMarketKind('solana-up-or-down-june-7-2026-3pm-et')).toBe('crypto_updown');
    expect(
      inferMarketKind('bitcoin-up-or-down-on-april-28-2026', {
        endDate: '2026-04-28T16:00:00.000Z',
      }),
    ).toBe('crypto_updown');
  });

  it('detects MLB sports slugs', () => {
    expect(inferMarketKind('mlb-tor-atl-2026-06-04')).toBe('sports_binary');
    expect(marketUsesPtbSpotDesk('sports_binary')).toBe(false);
  });

  it('detects sports from gameStartTime on market json', () => {
    expect(
      inferMarketKind('some-custom-slug', {
        gameStartTime: '2026-06-04 23:15:00+00',
        outcomes: '["A", "B"]',
      }),
    ).toBe('sports_binary');
  });
});
