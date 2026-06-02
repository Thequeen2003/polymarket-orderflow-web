import { describe, expect, it } from 'vitest';
import { computeContractLagReadout, CONTRACT_LAG_MIN_CENTS } from './contractLag';

describe('contractLag', () => {
  it('computes DOWN lag when spot below PTB but Down mid sticky', () => {
    const r = computeContractLagReadout({
      modelPUp: 0.28,
      marketUp: 0.44,
      marketDown: 0.56,
      geo: 'BELOW',
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(r.lagDownCents).toBeCloseTo(16, 5);
    expect(r.favoredSide).toBe('down');
    expect(r.lagCents).toBeCloseTo(16, 5);
    expect(r.geoAligned).toBe(true);
  });

  it('flags lagging phase before repricing starts', () => {
    const r = computeContractLagReadout({
      modelPUp: 0.28,
      marketUp: 0.44,
      marketDown: 0.56,
      geo: 'BELOW',
      repricingIntoEdge: false,
      probDownDelta01: 0,
    });
    expect(r.phase).toBe('lagging');
    expect(r.tradeable).toBe(true);
  });

  it('flags catching_up when Down mid starts moving', () => {
    const r = computeContractLagReadout({
      modelPUp: 0.28,
      marketUp: 0.44,
      marketDown: 0.56,
      geo: 'BELOW',
      probDownDelta01: 0.03,
    });
    expect(r.phase).toBe('catching_up');
  });

  it('detects DOWN repricing via rising Down mid', () => {
    const r = computeContractLagReadout({
      modelPUp: 0.28,
      marketUp: 0.44,
      marketDown: 0.56,
      geo: 'BELOW',
      probDownDelta01: 0.025,
      probUpDelta01: 0,
    });
    expect(r.repricingIntoEdge).toBe(true);
  });

  it('aligned when lag under threshold', () => {
    const r = computeContractLagReadout({
      modelPUp: 0.55,
      marketUp: 0.54,
      marketDown: 0.46,
      geo: 'IN_BAND',
    });
    expect(r.lagCents).toBeLessThan(CONTRACT_LAG_MIN_CENTS);
    expect(r.phase).toBe('aligned');
  });
});
