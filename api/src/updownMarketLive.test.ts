import { describe, expect, it } from 'vitest';
import {
  buildTitledHourlySlug,
  currentEtHourEndUnixSec,
  isUpdownWindowOpen,
  titledUpdownAssetFromSlug,
  titledUpdownStepSecFromSlug,
} from './updownMarketLive.js';

describe('updownMarketLive', () => {
  it('detects titled hourly slugs', () => {
    expect(titledUpdownStepSecFromSlug('bitcoin-up-or-down-may-16-2026-4pm-et')).toBe(3600);
    expect(titledUpdownAssetFromSlug('bitcoin-up-or-down-may-16-2026-4pm-et')).toBe('btc');
    expect(titledUpdownStepSecFromSlug('btc-updown-5m-100')).toBeNull();
  });

  it('buildTitledHourlySlug uses ET hour in slug', () => {
    // 2026-05-16 20:35 ET
    const sec = Math.floor(Date.UTC(2026, 4, 17, 0, 35, 0) / 1000);
    expect(buildTitledHourlySlug('btc', sec)).toBe('bitcoin-up-or-down-may-16-2026-8pm-et');
    expect(currentEtHourEndUnixSec(sec)).toBe(sec - 35 * 60 + 3600);
  });

  it('treats future endDate as open even when Gamma closed=true', () => {
    const endMs = Date.now() + 45 * 60_000;
    expect(isUpdownWindowOpen({ active: true, closed: true, endMs })).toBe(true);
    expect(isUpdownWindowOpen({ active: true, closed: true, endMs: Date.now() - 300_000 })).toBe(false);
  });
});
