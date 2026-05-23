import { describe, expect, it } from 'vitest';
import { suggestTradeLevels, suggestLevelsForLane, resolveTradeLevelsForDirective } from './tradeLevels';
import type { LaneEdges, TradeEdge } from './tradeEdgeCalculator';
import type { TradeDirective } from './tradeDirective';

describe('suggestTradeLevels', () => {
  it('uses structural 4¢ bracket when model edge is zero or negative', () => {
    const z = suggestTradeLevels({ lane: 'up', entry: 0.5, edgeUsd: 0 });
    expect(z).not.toBeNull();
    expect(z!.takeProfitGain).toBeCloseTo(0.04, 3);
    expect(z!.stopLossLoss).toBeCloseTo(0.04, 3);
    const neg = suggestTradeLevels({ lane: 'up', entry: 0.5, edgeUsd: -0.05 });
    expect(neg).not.toBeNull();
    expect(neg!.takeProfitGain).toBeCloseTo(0.04, 3);
  });

  it('returns null for invalid entry (0 or 1)', () => {
    expect(suggestTradeLevels({ lane: 'up', entry: 0, edgeUsd: 0.1 })).toBeNull();
    expect(suggestTradeLevels({ lane: 'up', entry: 1, edgeUsd: 0.1 })).toBeNull();
  });

  it('uses equal TP and SL distance from entry (symmetric bracket)', () => {
    const r = suggestTradeLevels({ lane: 'up', entry: 0.55, edgeUsd: 0.15 });
    expect(r).not.toBeNull();
    expect(r!.takeProfitGain).toBeCloseTo(r!.stopLossLoss, 5);
    expect(r!.takeProfitGain).toBeCloseTo(0.0825, 3);
    expect(r!.takeProfit).toBeCloseTo(0.6325, 3);
    expect(r!.stopLoss).toBeCloseTo(0.4675, 3);
  });

  it('uses 4¢ floor on both legs when edge is small', () => {
    const r = suggestTradeLevels({ lane: 'up', entry: 0.5, edgeUsd: 0.03 });
    expect(r!.takeProfitGain).toBeCloseTo(0.04, 3);
    expect(r!.stopLossLoss).toBeCloseTo(0.04, 3);
    expect(r!.takeProfit).toBeCloseTo(0.54, 3);
    expect(r!.stopLoss).toBeCloseTo(0.46, 3);
  });

  it('R:R is ~1 on a fat edge (symmetric legs)', () => {
    const r = suggestTradeLevels({ lane: 'up', entry: 0.5, edgeUsd: 0.2 });
    expect(r!.rrRatio).toBeCloseTo(1, 2);
  });

  it('tightens TP and SL equally when cross prob is high', () => {
    const calm = suggestTradeLevels({ lane: 'up', entry: 0.55, edgeUsd: 0.15, crossProb: 0.3 });
    const jumpy = suggestTradeLevels({ lane: 'up', entry: 0.55, edgeUsd: 0.15, crossProb: 0.85 });
    expect(jumpy!.takeProfitGain).toBeLessThan(calm!.takeProfitGain);
    expect(jumpy!.stopLossLoss).toBeLessThan(calm!.stopLossLoss);
    expect(jumpy!.takeProfitGain).toBeCloseTo(jumpy!.stopLossLoss, 4);
    expect(calm!.takeProfitGain).toBeCloseTo(calm!.stopLossLoss, 4);
  });

  it('pins TP/SL only in the final ~15s', () => {
    const r = suggestTradeLevels({ lane: 'up', entry: 0.55, edgeUsd: 0.15, endsInMs: 10_000 });
    expect(r!.collapsed).toBe(true);
    expect(r!.takeProfit).toBe(r!.entry);
    expect(r!.stopLoss).toBe(r!.entry);
    expect(r!.summary).toMatch(/pinned/i);
  });

  it('keeps actionable TP/SL between 15s and 60s (tight band, not collapsed)', () => {
    const r = suggestTradeLevels({ lane: 'up', entry: 0.55, edgeUsd: 0.15, endsInMs: 30_000 });
    expect(r!.collapsed).toBe(false);
    expect(r!.takeProfit).toBeGreaterThan(r!.entry);
    expect(r!.stopLoss).toBeLessThan(r!.entry);
    expect(r!.summary).toMatch(/to bell/i);
    expect(r!.toBellBand).toBe(true);
  });

  it('uses full bracket when more than ~60s remain', () => {
    const late = suggestTradeLevels({ lane: 'up', entry: 0.55, edgeUsd: 0.15, endsInMs: 30_000 });
    const calm = suggestTradeLevels({ lane: 'up', entry: 0.55, edgeUsd: 0.15, endsInMs: 120_000 });
    expect(calm!.takeProfitGain).toBeGreaterThan(late!.takeProfitGain);
    expect(calm!.toBellBand).toBeFalsy();
  });

  it('clamps TP/SL to (0, 1)', () => {
    const r = suggestTradeLevels({ lane: 'up', entry: 0.95, edgeUsd: 0.4 });
    expect(r!.takeProfit).toBeLessThan(1);
    expect(r!.stopLoss).toBeGreaterThan(0);
  });

  it('summary contains lane, entry, TP, SL, RR', () => {
    const r = suggestTradeLevels({ lane: 'up', entry: 0.55, edgeUsd: 0.15 });
    expect(r!.summary).toContain('UP token');
    expect(r!.summary).toContain('0.55');
    expect(r!.summary).toContain('TP');
    expect(r!.summary).toContain('SL');
    expect(r!.summary).toContain('R:R');
  });

  it('DOWN lane levels match UP lane structure (same buy-side TP/SL math)', () => {
    const u = suggestTradeLevels({ lane: 'up', entry: 0.55, edgeUsd: 0.15 });
    const d = suggestTradeLevels({ lane: 'down', entry: 0.55, edgeUsd: 0.15 });
    expect(d!.takeProfitGain).toBeCloseTo(u!.takeProfitGain, 3);
    expect(d!.stopLossLoss).toBeCloseTo(u!.stopLossLoss, 3);
    expect(d!.lane).toBe('down');
  });
});

describe('suggestLevelsForLane', () => {
  it('delegates to suggestTradeLevels when edge positive', () => {
    const laneEdges: LaneEdges = {
      up: {
        lane: 'up',
        mid: 0.52,
        pWin: 0.62,
        edgePerShareUsd: 0.1,
        evPerDollar: 0,
        breakevenProb: 0.52,
        marginOverBreakeven: 0.1,
        quality: 'MED',
        summary: '',
      },
      down: null,
      bestLane: 'up',
      bestEdgeUsd: 0.1,
    };
    const r = suggestLevelsForLane({
      lane: 'up',
      laneEdges,
      crossProb: 0.4,
      endsInMs: 600_000,
    });
    expect(r).not.toBeNull();
    expect(r!.entry).toBeCloseTo(0.52, 4);
    expect(r!.takeProfit).toBeGreaterThan(r!.entry);
    expect(r!.stopLoss).toBeLessThan(r!.entry);
  });

  it('returns structural TP/SL when lane edge is non-+EV (mid still valid)', () => {
    expect(suggestLevelsForLane({ lane: 'up', laneEdges: null })).toBeNull();
    const thin: LaneEdges = {
      up: {
        lane: 'up',
        mid: 0.5,
        pWin: 0.5,
        edgePerShareUsd: -0.02,
        evPerDollar: 0,
        breakevenProb: 0.5,
        marginOverBreakeven: 0,
        quality: 'NEGATIVE',
        summary: '',
      },
      down: null,
      bestLane: null,
      bestEdgeUsd: 0,
    };
    const r = suggestLevelsForLane({ lane: 'up', laneEdges: thin });
    expect(r).not.toBeNull();
    expect(r!.entry).toBeCloseTo(0.5, 4);
    expect(r!.takeProfitGain).toBeCloseTo(0.04, 3);
  });
});

function mkEdge(lane: 'up' | 'down', mid: number, pWin: number, edgeUsd: number): TradeEdge {
  return {
    lane,
    mid,
    pWin,
    edgePerShareUsd: edgeUsd,
    evPerDollar: mid > 0 ? edgeUsd / mid : 0,
    breakevenProb: mid,
    marginOverBreakeven: edgeUsd,
    quality: edgeUsd < 0 ? 'NEGATIVE' : edgeUsd >= 0.05 ? 'MED' : 'LOW',
    summary: '',
  };
}

describe('resolveTradeLevelsForDirective', () => {
  it('uses directive lane mid for TP/SL even when directive edge is negative (structural bracket)', () => {
    const laneEdges: LaneEdges = {
      up: mkEdge('up', 0.45, 0.58, 0.13),
      down: mkEdge('down', 0.55, 0.48, -0.07),
      bestLane: 'up',
      bestEdgeUsd: 0.13,
    };
    const directive = {
      lane: 'down',
      laneMid: 0.55,
      edgePerShareUsd: -0.07,
      action: 'INITIATE',
    } as TradeDirective;
    const r = resolveTradeLevelsForDirective({
      directive,
      laneEdges,
      crossProb: null,
      endsInMs: 600_000,
    });
    expect(r).not.toBeNull();
    expect(r!.lane).toBe('down');
    expect(r!.entry).toBeCloseTo(0.55, 4);
    expect(r!.takeProfitGain).toBeCloseTo(0.04, 3);
  });

  it('uses directive mid when directive edge is positive', () => {
    const laneEdges: LaneEdges = {
      up: mkEdge('up', 0.45, 0.55, 0.1),
      down: mkEdge('down', 0.55, 0.45, -0.1),
      bestLane: 'up',
      bestEdgeUsd: 0.1,
    };
    const directive = {
      lane: 'up',
      laneMid: 0.46,
      edgePerShareUsd: 0.12,
      action: 'INITIATE',
    } as TradeDirective;
    const r = resolveTradeLevelsForDirective({
      directive,
      laneEdges,
      crossProb: null,
      endsInMs: 600_000,
    });
    expect(r).not.toBeNull();
    expect(r!.lane).toBe('up');
    expect(r!.entry).toBeCloseTo(0.46, 4);
  });

  it('picks best lane when there is no directive', () => {
    const laneEdges: LaneEdges = {
      up: mkEdge('up', 0.4, 0.55, 0.15),
      down: null,
      bestLane: 'up',
      bestEdgeUsd: 0.15,
    };
    const r = resolveTradeLevelsForDirective({
      directive: null,
      laneEdges,
      crossProb: null,
      endsInMs: 600_000,
    });
    expect(r!.lane).toBe('up');
  });

  it('anchors TP/SL on directive laneMid and uses book edge when directive edge is null', () => {
    const laneEdges: LaneEdges = {
      up: mkEdge('up', 0.4, 0.5, 0.05),
      down: mkEdge('down', 0.62, 0.45, -0.02),
      bestLane: 'up',
      bestEdgeUsd: 0.05,
    };
    const directive = {
      lane: 'down',
      laneMid: 0.55,
      edgePerShareUsd: null,
      action: 'INITIATE',
    } as TradeDirective;
    const r = resolveTradeLevelsForDirective({
      directive,
      laneEdges,
      crossProb: null,
      endsInMs: 600_000,
    });
    expect(r).not.toBeNull();
    expect(r!.lane).toBe('down');
    expect(r!.entry).toBeCloseTo(0.55, 4);
    expect(r!.takeProfit).toBeGreaterThan(r!.entry);
    expect(r!.stopLoss).toBeLessThan(r!.entry);
  });
});
