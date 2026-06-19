import { describe, expect, it } from 'vitest';
import { computeMarketBias, buildEntryEligibility } from './executionLayers';

describe('computeMarketBias', () => {
  it('shows UP bias when model and edge lean up', () => {
    const b = computeMarketBias({ modelPUp: 0.72, pMktUp: 0.55, pMktDown: 0.48, spotDirection: 'UP' });
    expect(b.direction).toBe('up');
    expect(b.headline).toMatch(/UP BIAS/i);
  });

  it('shows NO BIAS when flat and weak signals', () => {
    const b = computeMarketBias({ modelPUp: 0.51, pMktUp: 0.5, pMktDown: 0.51, spotDirection: 'FLAT' });
    expect(b.direction).toBe('none');
    expect(b.headline).toBe('NO BIAS');
  });
});

describe('buildEntryEligibility', () => {
  it('shows both sides with NOT READY status', () => {
    const e = buildEntryEligibility({
      up: {
        side: 'up',
        sideLabel: 'UP',
        probPct: 68,
        probOk: false,
        edgePp: 12,
        edgeOk: false,
        passCount: 1,
      },
      down: {
        side: 'down',
        sideLabel: 'DOWN',
        probPct: 32,
        probOk: false,
        edgePp: -12,
        edgeOk: false,
        passCount: 0,
      },
      momUp: { pass: false, detail: 'Spot flat' },
      momDown: { pass: false, detail: 'Spot flat' },
      phase: 'WAIT',
    });
    expect(e.status).toBe('NOT_READY');
    expect(e.up.probPct).toBe(68);
    expect(e.down.edgePp).toBe(-12);
    expect(e.footer).toMatch(/waiting for UP or DOWN/i);
  });
});
