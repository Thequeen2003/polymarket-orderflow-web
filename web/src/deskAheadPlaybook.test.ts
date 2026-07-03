import { describe, expect, it } from 'vitest';
import {
  buildDeskAheadPlaybook,
  deskCatchModeLabel,
  formatDeskAheadPlaybookLine,
  formatDeskBracketLine,
} from './deskAheadPlaybook';
import type { NowPriceDeskTradeSignal } from './nowPriceDeskTradeSignal';

function baseSignal(over: Partial<NowPriceDeskTradeSignal> = {}): NowPriceDeskTradeSignal {
  return {
    phase: 'ALERT',
    lane: 'down',
    laneLabel: 'Down',
    headline: 'ALERT Down',
    exactAction: 'Hold confirmation.',
    confidencePct: 72,
    confirmPct: 80,
    confirmSecRemaining: null,
    readinessPct: 75,
    tpHitProbPct: 40,
    tpCents: 74,
    urgency: 'soon',
    blockers: [],
    canTrade: false,
    tone: 'down',
    emoji: '⏳',
    source: 'entry_moment',
    ...over,
  };
}

describe('buildDeskAheadPlaybook', () => {
  it('surfaces bracket + TP during confirm countdown', () => {
    const p = buildDeskAheadPlaybook({
      signal: baseSignal({ confirmSecRemaining: 4 }),
      entryMoment: {
        phase: 'CONFIRMING',
        lane: 'down',
        headline: 'CONFIRMING DOWN · 4s',
        exactAction: 'Hold 4s more',
        readinessPct: 82,
        confirmSecRemaining: 4,
        checks: [],
        urgency: 'wait',
        canExecute: false,
      },
      contractLead: null,
      pressureTiming: 'BUILDING',
      bandGauge: null,
      band: null,
      execution: null,
      advisory: null,
      bid01: 0.68,
      ask01: 0.69,
    });
    expect(p.mode).toBe('arm');
    expect(p.catchLine).toMatch(/BUY DOWN @ 68¢ · TP 74¢ IN 4s/);
    expect(p.bracket).toEqual({ entry: '68¢', tp: '74¢', sl: expect.any(String) });
    expect(p.do).toMatch(/exit at TP 74¢/);
    expect(formatDeskBracketLine(p.bracket, p.tpHitProbPct)).toMatch(/ENTRY 68¢ → TP 74¢/);
  });

  it('clarifies WATCH with full bracket', () => {
    const p = buildDeskAheadPlaybook({
      signal: baseSignal({ phase: 'ALERT' }),
      entryMoment: null,
      contractLead: {
        phase: 'WATCH',
        sideLabel: 'DOWN',
        title: 'Watch Down',
        actionLine: '10s building (+1.2¢)',
        reasonLine: 'Layers aligning',
        nowCents: '68',
        entry10sCents: '67',
        earlyGainCents: 1.2,
        confirmGainCents: 0.5,
        earlyHorizonSec: 10,
        confirmHorizonSec: 30,
      },
      pressureTiming: 'EARLY',
      bandGauge: null,
      band: null,
      execution: null,
      advisory: null,
      bid01: 0.68,
      ask01: 0.7,
    });
    expect(p.mode).toBe('watch');
    expect(p.catchLine).toMatch(/WATCH DOWN → BUY @ 68¢ · TP 74¢/);
    expect(p.do).toMatch(/TP 74¢/);
  });

  it('gives band-break wait with bracket', () => {
    const p = buildDeskAheadPlaybook({
      signal: baseSignal({ lane: 'up', laneLabel: 'Up', tpCents: 68 }),
      entryMoment: null,
      contractLead: null,
      pressureTiming: null,
      bandGauge: null,
      band: {
        ptb: 100,
        now: 100,
        bandHi: 105,
        bandLo: 95,
        bandUsd: 5,
        distNowFromPtb: 0,
        distAboveFromPtb: 5,
        distBelowFromPtb: 5,
        toConfirmedAboveFromNow: 5,
        toConfirmedBelowFromNow: 5,
        geo: 'IN_BAND',
      },
      execution: null,
      advisory: null,
      bid01: 0.62,
      ask01: 0.64,
    });
    expect(p.mode).toBe('wait');
    expect(p.catchLine).toMatch(/BUY UP @ 62¢ · TP 68¢/);
  });

  it('says buy now with bracket on GO', () => {
    const p = buildDeskAheadPlaybook({
      signal: baseSignal({ phase: 'ENTER', canTrade: true, urgency: 'now' }),
      entryMoment: null,
      contractLead: null,
      pressureTiming: 'EARLY',
      bandGauge: null,
      band: null,
      execution: null,
      advisory: null,
      bid01: 0.68,
      ask01: 0.69,
    });
    expect(p.mode).toBe('go');
    expect(p.catchLine).toBe('BUY DOWN NOW @ 68¢ · TP 74¢');
    expect(p.do).toMatch(/TP 74¢/);
    expect(deskCatchModeLabel(p.mode)).toBe('Go now');
  });

  it('formats flat line with bracket', () => {
    const line = formatDeskAheadPlaybookLine({
      mode: 'arm',
      catchLine: 'BUY DOWN @ 68¢ · TP 74¢ IN 4s',
      bracket: { entry: '68¢', tp: '74¢', sl: '65¢' },
      tpHitProbPct: 40,
      side: 'down',
      confirmSec: 4,
      when: '4s left',
      do: 'Stage limit · exit at TP 74¢',
      skip: 'No chase',
    });
    expect(line).toContain('ENTRY 68¢ → TP 74¢');
    expect(line).toContain('exit at TP 74¢');
  });
});
