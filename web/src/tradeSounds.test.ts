import { describe, expect, it } from 'vitest';
import { okMsgIsExchangeFill } from './tradeSounds';

describe('okMsgIsExchangeFill', () => {
  it('allows confirmed exchange fills only', () => {
    expect(okMsgIsExchangeFill('Exchange confirmed: bought 5.0000 sh @ 58.00¢ fill')).toBe(true);
    expect(okMsgIsExchangeFill('Filled · 5.0000 sh @ 58.00¢')).toBe(true);
  });

  it('rejects sent / armed / cancel ack strings', () => {
    expect(okMsgIsExchangeFill('Buy sent · intended 40.0¢ — reading exchange state…')).toBe(false);
    expect(okMsgIsExchangeFill('SL/TP armed from 58.0¢ fill (TP 62.0¢ · SL 54.0¢).')).toBe(false);
    expect(okMsgIsExchangeFill('Order cancel sent.')).toBe(false);
  });
});
