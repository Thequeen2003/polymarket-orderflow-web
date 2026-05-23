import { describe, expect, it } from 'vitest';
import { freshPaperAccount, paperTrade, undoPaperFilledBuy } from './paperTradingCore';

describe('undoPaperFilledBuy (paper refunds)', () => {
  it('refunds cash and restores position for a simple buy', () => {
    let a = freshPaperAccount(1);
    const b = paperTrade({ account: a, tokenId: 'tokA', side: 'buy', shares: 10, price01: 0.5, now: 2 });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    a = b.account;
    expect(a.cashUsdCents).toBe(7500 - 500);

    const u = undoPaperFilledBuy({
      account: a,
      tokenId: 'tokA',
      shares: 10,
      price01: 0.5,
      usdCents: 500,
      now: 3,
    });
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.account.cashUsdCents).toBe(7500);
    expect(u.account.positionsByToken.tokA?.shares ?? 0).toBe(0);
  });

  it('caps undo shares to ledger when history row is slightly high (6dp rounding)', () => {
    let a = freshPaperAccount(1);
    const b = paperTrade({ account: a, tokenId: 'tokB', side: 'buy', shares: 5, price01: 0.4, now: 2 });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    a = b.account;
    // Simulate persistence / float drift: ledger slightly below what a naive history row might show.
    a.positionsByToken.tokB = { shares: 4.999998, avgCost01: 0.4 };

    const u = undoPaperFilledBuy({
      account: a,
      tokenId: 'tokB',
      shares: 5,
      price01: 0.4,
      usdCents: Math.round(0.4 * 5 * 100),
      now: 3,
    });
    expect(u.ok).toBe(true);
    if (!u.ok) return;
    expect(u.account.positionsByToken.tokB?.shares ?? 0).toBe(0);
    expect(u.account.cashUsdCents).toBe(7500);
  });
});
