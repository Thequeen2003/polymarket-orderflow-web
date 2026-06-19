import { describe, expect, it } from 'vitest';
import {
  bracketAutomationBid01,
  evaluateStopLossCross,
  evaluateTakeProfitCross,
  evaluateTrailingProfitExit,
  stopLossExecLimit01,
  slipSellFakLimit01,
  takeProfitExecLimit01,
  takeProfitRestingLimit01,
} from './bracketTrigger';

describe('bracketTrigger', () => {
  it('SL fires when bid is at or below stop (not edge-only)', () => {
    const r = evaluateStopLossCross({
      stop01: 0.8,
      bid01: 0.79,
      prevBid01: 0.81,
    });
    expect(r.crossed).toBe(true);
    expect(r.ref01).toBeCloseTo(0.79, 6);
  });

  it('SL fires when bid was already below stop on first sample', () => {
    const r = evaluateStopLossCross({
      stop01: 0.8,
      bid01: 0.78,
      prevBid01: null,
    });
    expect(r.crossed).toBe(true);
  });

  it('SL does not fire when bid is still above stop', () => {
    const r = evaluateStopLossCross({
      stop01: 0.8,
      bid01: 0.82,
      prevBid01: 0.83,
    });
    expect(r.crossed).toBe(false);
  });

  it('SL crosses when chart mid is through stop (honorChartMid)', () => {
    const r = evaluateStopLossCross({
      stop01: 0.8,
      bid01: 0.82,
      prevBid01: 0.83,
      stripMid01: 0.79,
      prevStripMid01: 0.81,
      honorChartMid: true,
    });
    expect(r.crossed).toBe(true);
    expect(r.ref01).toBeCloseTo(0.82, 6);
  });

  it('SL ignores chart mid when honorChartMid is off', () => {
    const r = evaluateStopLossCross({
      stop01: 0.8,
      bid01: 0.82,
      stripMid01: 0.79,
      honorChartMid: false,
    });
    expect(r.crossed).toBe(false);
  });

  it('stopLossExecLimit01 caps FAK at bid when bid is below stop', () => {
    expect(
      stopLossExecLimit01({ stop01: 0.8, limit01: 0.8, ref01: 0.79, simple: true }),
    ).toBeCloseTo(0.79, 6);
  });

  it('stopLossExecLimit01 uses stop when bid is at stop', () => {
    expect(
      stopLossExecLimit01({ stop01: 0.8, limit01: 0.75, ref01: 0.8, simple: true }),
    ).toBeCloseTo(0.8, 6);
  });

  it('TP crosses on bid up through take', () => {
    const r = evaluateTakeProfitCross({
      take01: 0.85,
      bid01: 0.86,
      prevBid01: 0.84,
    });
    expect(r.crossed).toBe(true);
    expect(r.ref01).toBeCloseTo(0.86, 6);
  });

  it('TP crosses when ask is at take but bid lags below (thin book)', () => {
    const r = evaluateTakeProfitCross({
      take01: 0.9,
      bid01: 0.88,
      ask01: 0.93,
      prevBid01: 0.87,
    });
    expect(r.crossed).toBe(true);
    expect(r.ref01).toBeCloseTo(0.88, 6);
  });

  it('TP crosses when chart mid is at take but bid is below (honorChartMid)', () => {
    const r = evaluateTakeProfitCross({
      take01: 0.63,
      bid01: 0.61,
      stripMid01: 0.64,
      honorChartMid: true,
    });
    expect(r.crossed).toBe(true);
    expect(r.ref01).toBeCloseTo(0.61, 6);
  });

  it('TP crosses on ask when watchAsk is enabled (dual-book poll)', () => {
    const r = evaluateTakeProfitCross({
      take01: 0.63,
      bid01: 0.61,
      ask01: 0.64,
      watchAsk: true,
    });
    expect(r.crossed).toBe(true);
    expect(r.ref01).toBeCloseTo(0.61, 6);
  });

  it('SL crosses on ask when watchAsk is enabled', () => {
    const r = evaluateStopLossCross({
      stop01: 0.8,
      bid01: 0.82,
      ask01: 0.79,
      watchAsk: true,
    });
    expect(r.crossed).toBe(true);
  });

  it('takeProfitExecLimit01 sells at bid (slipped) when bid is above take', () => {
    expect(
      takeProfitExecLimit01({ take01: 0.7, limit01: 0.7, ref01: 0.72, simple: true }),
    ).toBeCloseTo(0.71, 6);
  });

  it('takeProfitRestingLimit01 stays at armed take when bid is higher', () => {
    expect(takeProfitRestingLimit01({ take01: 0.45, limit01: 0.45, simple: true })).toBeCloseTo(0.45, 6);
  });

  it('slipSellFakLimit01 respects take floor', () => {
    expect(slipSellFakLimit01(0.52, 0.55)).toBeCloseTo(0.55, 6);
  });

  it('bracketAutomationBid01 prefers poll over touch', () => {
    expect(
      bracketAutomationBid01({ pollBid01: 0.55, touchBid01: 0.5, forPaper: false }),
    ).toBeCloseTo(0.55, 6);
  });

  it('bracketAutomationBid01 uses fallback on paper only', () => {
    expect(
      bracketAutomationBid01({ pollBid01: null, touchBid01: null, fallback01: 0.48, forPaper: true }),
    ).toBeCloseTo(0.48, 6);
    expect(
      bracketAutomationBid01({ pollBid01: null, touchBid01: null, fallback01: 0.48, forPaper: false }),
    ).toBeNull();
  });

  it('bracketAutomationBid01 can use mid fallback on live when book is empty', () => {
    expect(
      bracketAutomationBid01({
        pollBid01: null,
        touchBid01: null,
        fallback01: 0.48,
        forPaper: false,
        allowMidFallback: true,
      }),
    ).toBeCloseTo(0.48, 6);
  });

  it('trailing profit exits on pullback after activation', () => {
    const entry01 = 0.5;
    const peak = evaluateTrailingProfitExit({
      entry01,
      currentMark01: 0.54,
      peakMark01: null,
    });
    expect(peak.shouldExit).toBe(false);
    expect(peak.peakMark01).toBeCloseTo(0.54, 6);

    const exit = evaluateTrailingProfitExit({
      entry01,
      currentMark01: 0.515,
      peakMark01: peak.peakMark01,
      config: { activateGainCents: 2, trailByCents: 2, lockProfitCents: 0.5 },
    });
    expect(exit.shouldExit).toBe(true);
  });
});
