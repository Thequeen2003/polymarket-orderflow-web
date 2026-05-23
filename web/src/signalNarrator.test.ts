import { describe, expect, it } from 'vitest';

import { buildSignalNarration } from './signalNarrator';
import type { TradeDirective } from './tradeDirective';
import type { SwitchForecast } from './sectionalMomentum';

const sf = (partial: Partial<SwitchForecast>): SwitchForecast =>
  ({
    status: 'WAIT',
    lane: null,
    driftLane: null,
    incomingLane: null,
    confidence: 'MED',
    etaSec: null,
    headline: '',
    reason: '',
    evidence: [],
    ...partial,
  }) as SwitchForecast;

const dir = (lane: 'up' | 'down'): TradeDirective =>
  ({ lane, action: 'INITIATE' }) as TradeDirective;

describe('buildSignalNarration', () => {
  it('reports alignment when card, chart, tape agree', () => {
    const r = buildSignalNarration({
      upLabel: 'Up',
      downLabel: 'Down',
      tradeDirective: dir('up'),
      switchForecast: sf({ status: 'GO_IN', lane: 'up' }),
      machineFocusLane: 'up',
      boomActive: false,
      boomLane: null,
      executionClash: false,
    });
    expect(r.tone).toBe('calm');
    expect(r.headline).toContain('Same story');
    expect(r.headline).toContain('Card');
    expect(r.headline).toContain('Chart');
    expect(r.headline).toContain('Tape');
  });

  it('reports split when lanes diverge', () => {
    const r = buildSignalNarration({
      upLabel: 'Up',
      downLabel: 'Down',
      tradeDirective: dir('up'),
      switchForecast: sf({ status: 'GO_IN', lane: 'down' }),
      machineFocusLane: 'up',
      boomActive: false,
      boomLane: null,
      executionClash: false,
    });
    expect(r.tone).toBe('split');
    expect(r.headline).toContain('Different stories');
    expect(r.headline).toMatch(/Up.*Down|Chart.*Card/);
  });

  it('uses incoming lane for switch forecast', () => {
    const r = buildSignalNarration({
      upLabel: 'Up',
      downLabel: 'Down',
      tradeDirective: dir('up'),
      switchForecast: sf({
        status: 'SWITCH_INCOMING',
        lane: 'up',
        incomingLane: 'down',
      }),
      machineFocusLane: 'up',
      boomActive: false,
      boomLane: null,
      executionClash: false,
    });
    expect(r.tone).toBe('split');
    expect(r.headline).toContain('Different stories');
  });

  it('handles EXIT before lane votes', () => {
    const r = buildSignalNarration({
      upLabel: 'Up',
      downLabel: 'Down',
      tradeDirective: dir('up'),
      switchForecast: sf({ status: 'EXIT', lane: 'up' }),
      machineFocusLane: 'down',
      boomActive: false,
      boomLane: null,
      executionClash: false,
    });
    expect(r.tone).toBe('split');
    expect(r.headline).toContain('EXIT');
  });

  it('excludes card from directional votes during stand-down', () => {
    const r = buildSignalNarration({
      upLabel: 'Up',
      downLabel: 'Down',
      tradeDirective: dir('down'),
      switchForecast: sf({ status: 'STAY_IN', lane: 'down' }),
      machineFocusLane: 'down',
      boomActive: false,
      boomLane: null,
      executionClash: true,
    });
    expect(r.headline).toContain('Chart, Tape');
    expect(r.headline).not.toMatch(/all point Down: Card/i);
    expect(r.headline).toContain('stand-down');
  });

  it('appends stand-down governance copy when aligned without card vote', () => {
    const r = buildSignalNarration({
      upLabel: 'Up',
      downLabel: 'Down',
      tradeDirective: dir('up'),
      switchForecast: sf({ status: 'GO_IN', lane: 'up' }),
      machineFocusLane: 'up',
      boomActive: false,
      boomLane: null,
      executionClash: true,
    });
    expect(r.headline).toContain('governs');
    expect(r.headline).toContain('stand-down');
  });

  it('explains tape WAIT while card GO (different scopes)', () => {
    const r = buildSignalNarration({
      upLabel: 'Up',
      downLabel: 'Down',
      tradeDirective: dir('down'),
      switchForecast: sf({ status: 'WAIT', headline: 'WAIT — no dominant lane' }),
      machineFocusLane: null,
      boomActive: false,
      boomLane: null,
      executionClash: false,
      tapeWaitCardGo: true,
    });
    expect(r.tone).toBe('split');
    expect(r.headline).toContain('WAIT');
    expect(r.headline).toContain('Down');
  });
});
