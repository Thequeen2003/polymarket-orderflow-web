import { describe, expect, it } from 'vitest';
import { readSlideDockTab, writeSlideDockTab } from './tradeSlideDock';

describe('tradeSlideDock', () => {
  it('restores ledger tab for the same market slug', () => {
    writeSlideDockTab('ledger', 'btc-updown-5m');
    expect(readSlideDockTab('btc-updown-5m')).toBe('ledger');
  });

  it('resets to outcome when market slug changes', () => {
    writeSlideDockTab('ledger', 'market-a');
    expect(readSlideDockTab('market-b')).toBe('outcome');
  });
});
