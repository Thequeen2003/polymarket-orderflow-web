import { describe, expect, it } from 'vitest';
import { LIVE_BUY_FILL_GRACE_MS, resolveLiveOutcomeShares, resolveLiveLaneShares } from './livePositionTruth';

describe('resolveLiveOutcomeShares', () => {
  it('display uses max of clob, bullpen, history', () => {
    expect(
      resolveLiveOutcomeShares({
        clobBal: 3,
        bullpenShares: 5,
        historyEst: 4,
        policy: 'display',
      }),
    ).toBe(5);
  });

  it('sell prefers CLOB when positive', () => {
    expect(
      resolveLiveOutcomeShares({
        clobBal: 3.2,
        bullpenShares: 5,
        historyEst: 6,
        policy: 'sell',
      }),
    ).toBe(3.2);
  });

  it('sell uses bullpen/history only inside buy grace when CLOB is zero', () => {
    expect(
      resolveLiveOutcomeShares({
        clobBal: 0,
        bullpenShares: 4.5,
        historyEst: 3,
        policy: 'sell',
        msSinceBuyFill: 500,
      }),
    ).toBe(4.5);
  });

  it('sell returns zero outside grace when CLOB is zero', () => {
    expect(
      resolveLiveOutcomeShares({
        clobBal: 0,
        bullpenShares: 4,
        historyEst: 3,
        policy: 'sell',
        msSinceBuyFill: LIVE_BUY_FILL_GRACE_MS + 1,
      }),
    ).toBe(0);
  });
});

describe('resolveLiveLaneShares', () => {
  it('picks down lane inputs', () => {
    expect(
      resolveLiveLaneShares({
        lane: 'down',
        balUp: 1,
        balDown: 2.5,
        posSharesUp: 0,
        posSharesDown: 3,
        estSharesUp: 0,
        estSharesDown: 1,
        policy: 'display',
      }),
    ).toBe(3);
  });
});
