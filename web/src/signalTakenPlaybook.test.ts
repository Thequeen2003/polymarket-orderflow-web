import { describe, expect, it } from 'vitest';
import { computeSignalTakenPlaybook } from './signalTakenPlaybook';
import type { TradeDirective } from './tradeDirective';
import type { SwitchForecast } from './sectionalMomentum';
import type { TapeVelocity } from './tapeVelocity';

const IDLE_TAPE: TapeVelocity = {
  recent: { buyVol: 0, sellVol: 0, count: 0, net: 0 },
  baseline: { buyVol: 0, sellVol: 0, count: 0, net: 0 },
  burstRatio: 0,
  burst: 'idle',
  netPressure: 0,
  dominance: 'idle',
  reliable: false,
  summary: 'idle',
};

/** Reliable tape leaning against an UP holder (sells dominating). */
const TAPE_FADE_UP: TapeVelocity = {
  recent: { buyVol: 1, sellVol: 50, count: 40, net: -30 },
  baseline: { buyVol: 10, sellVol: 10, count: 20, net: 0 },
  burstRatio: 1,
  burst: 'aggressive',
  netPressure: -22,
  dominance: 'sell',
  reliable: true,
  summary: 'sellers lean',
};

function dir(partial: Partial<TradeDirective>): TradeDirective {
  return {
    action: 'HOLD',
    lane: 'up',
    urgency: 'patient',
    recommendedSize: 0.2,
    headline: 'HOLD',
    reason: 'test',
    evidence: [],
    confidence: 'MED',
    defensive: false,
    edgePerShareUsd: 0.01,
    laneMid: 0.55,
    laneWinProb: 0.5,
    laneOutcomeLabel: 'Up',
    ...partial,
  };
}

describe('computeSignalTakenPlaybook', () => {
  it('flags risk when switch forms away from my lane', () => {
    const forecast: SwitchForecast = {
      status: 'SWITCH_INCOMING',
      lane: 'up',
      driftLane: 'up',
      incomingLane: 'down',
      confidence: 'MED',
      etaSec: 45,
      headline: 'x',
      reason: 'y',
      evidence: [],
    };
    const out = computeSignalTakenPlaybook({
      myLane: 'up',
      takenAtMs: 1,
      directive: dir({ lane: 'up', action: 'HOLD' }),
      levels: null,
      crossProb: 0.5,
      endsInMs: 20 * 60_000,
      forecast,
      tape: IDLE_TAPE,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(out.tone).toBe('risk');
    expect(out.bullets.some((b) => /switch forming toward Down/i.test(b))).toBe(true);
  });

  it('suggests trim when card says TRIM on same lane', () => {
    const out = computeSignalTakenPlaybook({
      myLane: 'down',
      takenAtMs: 1,
      directive: dir({ lane: 'down', action: 'TRIM' }),
      levels: null,
      crossProb: 0.5,
      endsInMs: 60 * 60_000,
      forecast: null,
      tape: IDLE_TAPE,
      upLabel: 'Yes',
      downLabel: 'No',
    });
    expect(out.tone).toMatch(/caution|risk/);
    expect(out.bullets.some((b) => /TRIM/i.test(b))).toBe(true);
  });

  it('escalates tone near the bell', () => {
    const out = computeSignalTakenPlaybook({
      myLane: 'up',
      takenAtMs: 1,
      directive: dir({ lane: 'up', action: 'HOLD' }),
      levels: null,
      crossProb: 0.55,
      endsInMs: 90_000,
      forecast: null,
      tape: IDLE_TAPE,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(out.bullets.some((b) => /1m|2m|bell|window/i.test(b))).toBe(true);
  });

  it('treats INITIATE on same lane as hold thesis after ack', () => {
    const out = computeSignalTakenPlaybook({
      myLane: 'up',
      takenAtMs: 1,
      directive: dir({ lane: 'up', action: 'INITIATE', headline: 'INITIATE UP' }),
      levels: null,
      crossProb: 0.5,
      endsInMs: 60 * 60_000,
      forecast: null,
      tape: IDLE_TAPE,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(out.headline).toMatch(/Holding Up/i);
    expect(out.bullets.some((b) => /hold Up|INITIATE/i.test(b))).toBe(true);
  });

  it('headline says holding when directive not yet loaded', () => {
    const out = computeSignalTakenPlaybook({
      myLane: 'down',
      takenAtMs: 1,
      directive: null,
      levels: null,
      crossProb: 0.5,
      endsInMs: 60 * 60_000,
      forecast: null,
      tape: IDLE_TAPE,
      upLabel: 'Yes',
      downLabel: 'No',
    });
    expect(out.headline).toMatch(/Holding No/i);
    expect(out.bullets.some((b) => /hold No/i.test(b))).toBe(true);
  });

  it('frames hold-the-dip when card backs lane, cross supportive, tape neutral', () => {
    const out = computeSignalTakenPlaybook({
      myLane: 'up',
      takenAtMs: 1,
      directive: dir({ lane: 'up', action: 'HOLD' }),
      levels: null,
      crossProb: 0.52,
      endsInMs: 60 * 60_000,
      forecast: null,
      tape: IDLE_TAPE,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(out.bullets.some((b) => /Dips are often noise/i.test(b))).toBe(true);
  });

  it('flags TP-mostly-gone when soft cross + rotation without card backing', () => {
    const out = computeSignalTakenPlaybook({
      myLane: 'up',
      takenAtMs: 1,
      directive: dir({ lane: 'down', action: 'INITIATE', headline: 'INITIATE DOWN' }),
      levels: null,
      crossProb: 0.34,
      endsInMs: 60 * 60_000,
      forecast: null,
      tape: IDLE_TAPE,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(out.tone).toBe('risk');
    expect(out.bullets.some((b) => /TP mostly gone/i.test(b))).toBe(true);
  });

  it('soft cross + tape fade + card still backs → stretched TP caution', () => {
    const out = computeSignalTakenPlaybook({
      myLane: 'up',
      takenAtMs: 1,
      directive: dir({ lane: 'up', action: 'HOLD' }),
      levels: null,
      crossProb: 0.34,
      endsInMs: 60 * 60_000,
      forecast: null,
      tape: TAPE_FADE_UP,
      upLabel: 'Up',
      downLabel: 'Down',
    });
    expect(out.tone).toMatch(/caution|risk/);
    expect(out.bullets.some((b) => /TP is harder|harder but not impossible/i.test(b))).toBe(true);
  });
});
