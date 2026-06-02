import { describe, expect, it } from 'vitest';

import {
  buildDeskMeaningKey,
  deskActionHardKey,
  deskActionSoftKey,
  tradeDirectiveMeaningKey,
} from './signalsDeskStable';
import type { DeskSingleAction } from './deskSingleAction';
import type { TradeDirective } from './tradeDirective';

describe('buildDeskMeaningKey', () => {
  it('ignores TP/SL cents so book ticks do not reset the strip', () => {
    const directive = {
      action: 'INITIATE',
      lane: 'up',
    } as TradeDirective;
    const verdict = { state: 'GO_LONG', bigVerb: 'ENTER UP' } as const;
    const k1 = buildDeskMeaningKey({ manualLane: null, directive, verdict: verdict as never });
    const k2 = buildDeskMeaningKey({
      manualLane: null,
      directive: { ...directive, lane: 'up' },
      verdict: verdict as never,
    });
    expect(k1).toBe(k2);
    expect(k1).toBe('-|INITIATE|up|GO_LONG|ENTER UP');
  });
});

describe('tradeDirectiveMeaningKey', () => {
  it('changes when action or lane changes', () => {
    const base = {
      action: 'INITIATE',
      lane: 'up',
      confidence: 'HIGH',
      defensive: false,
      headline: 'ENTER UP',
    } as TradeDirective;
    expect(tradeDirectiveMeaningKey(base)).not.toBe(
      tradeDirectiveMeaningKey({ ...base, lane: 'down' }),
    );
  });
});

describe('deskAction keys', () => {
  const base: DeskSingleAction = {
    primary: 'ENTER UP',
    detail: 'a',
    tone: 'green',
    wallBidWarning: null,
    physicsLine: 'p1',
  };

  it('hard key tracks primary/tone only', () => {
    expect(deskActionHardKey(base)).not.toBe(
      deskActionHardKey({ ...base, primary: 'WAIT', tone: 'gray' }),
    );
    expect(deskActionHardKey(base)).toBe(deskActionHardKey({ ...base, detail: 'b', physicsLine: 'p2' }));
  });

  it('soft key tracks detail/physics only', () => {
    expect(deskActionSoftKey(base)).toBe(deskActionSoftKey({ ...base, tone: 'amber' }));
    expect(deskActionSoftKey(base)).not.toBe(deskActionSoftKey({ ...base, detail: 'b' }));
  });
});
