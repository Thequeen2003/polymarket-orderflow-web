import { describe, expect, it } from 'vitest';
import { computePositionBracketCall } from './positionBracketCall';

describe('computePositionBracketCall', () => {
  it('returns null without entry', () => {
    expect(computePositionBracketCall({ entry01: null })).toBeNull();
  });

  it('sell_now when desk TP falls below avg entry', () => {
    const r = computePositionBracketCall({
      entry01: 0.55,
      armedTp01: 0.62,
      liveDeskTp01: 0.52,
      bid01: 0.54,
    });
    expect(r).not.toBeNull();
    expect(r!.action).toBe('sell_now');
    expect(r!.reason).toBe('desk_tp_below_entry');
    expect(r!.headline).toMatch(/below entry/);
  });

  it('take_profit when bid reaches armed TP', () => {
    const r = computePositionBracketCall({
      entry01: 0.5,
      armedTp01: 0.62,
      bid01: 0.63,
      liveDeskTp01: 0.64,
    });
    expect(r!.action).toBe('take_profit');
    expect(r!.reason).toBe('tp_hit');
  });

  it('sell_now when bid crosses stop', () => {
    const r = computePositionBracketCall({
      entry01: 0.55,
      armedTp01: 0.65,
      armedSl01: 0.5,
      bid01: 0.49,
    });
    expect(r!.action).toBe('sell_now');
    expect(r!.reason).toBe('sl_crossed');
  });

  it('hold when desk TP stays above entry', () => {
    const r = computePositionBracketCall({
      entry01: 0.55,
      armedTp01: 0.62,
      liveDeskTp01: 0.58,
      bid01: 0.56,
    });
    expect(r!.action).toBe('hold');
    expect(r!.reason).toBe('on_track');
  });

  it('prefers TP hit over desk TP below entry', () => {
    const r = computePositionBracketCall({
      entry01: 0.5,
      armedTp01: 0.62,
      liveDeskTp01: 0.48,
      bid01: 0.63,
    });
    expect(r!.reason).toBe('tp_hit');
  });
});
