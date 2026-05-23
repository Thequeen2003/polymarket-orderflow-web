import { describe, expect, it } from 'vitest';
import { filledSharesFromRow, netMatchedSharesFromHistory, remainingSharesFromRow } from './tradeHistoryDisplay';
import type { TradeHistoryRow } from './tradeHistory';

function row(partial: Partial<TradeHistoryRow>): TradeHistoryRow {
  return {
    id: '1',
    ts: Date.now(),
    mode: 'live',
    exec: 'limit',
    side: 'sell',
    token: 'tok',
    label: 'Down',
    price01: 0.54,
    shares: 5,
    requestedShares: 5,
    remainingShares: 5,
    usdCents: 270,
    status: 'sent',
    ...partial,
  };
}

describe('tradeHistoryDisplay', () => {
  it('sent row with rem=size shows 0 filled (resting)', () => {
    const r = row({ status: 'sent', shares: 5, requestedShares: 5, remainingShares: 5 });
    expect(filledSharesFromRow(r)).toBe(0);
    expect(remainingSharesFromRow(r)).toBe(5);
  });

  it('exchange fill uses shares as filled', () => {
    const r = row({
      status: 'filled',
      shares: 5,
      fillAvgPrice01: 0.5,
      remainingShares: 0,
    });
    expect(filledSharesFromRow(r)).toBe(5);
  });

  it('partial open order 2/5', () => {
    const r = row({ status: 'sent', requestedShares: 5, remainingShares: 3, shares: 5 });
    expect(filledSharesFromRow(r)).toBe(2);
    expect(remainingSharesFromRow(r)).toBe(3);
  });

  it('netMatchedSharesFromHistory sums buys minus sells', () => {
    const buy = row({
      side: 'buy',
      status: 'filled',
      shares: 5,
      fillAvgPrice01: 0.5,
      remainingShares: 0,
      token: 'tok-a',
    });
    const sell = row({
      side: 'sell',
      status: 'filled',
      shares: 2,
      fillAvgPrice01: 0.54,
      remainingShares: 0,
      token: 'tok-a',
    });
    expect(netMatchedSharesFromHistory([buy, sell], 'tok-a')).toBe(3);
  });
});
