import { describe, expect, it } from 'vitest';
import { inferMarketKind, marketUsesPtbSpotDesk } from './marketKind';

describe('marketKind', () => {
  it('detects crypto updown slugs', () => {
    expect(inferMarketKind('btc-updown-5m-1776735900')).toBe('crypto_updown');
    expect(marketUsesPtbSpotDesk('crypto_updown')).toBe(true);
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
