import { describe, expect, it } from 'vitest';
import { formatDeskEntryDetail, formatDeskEntryPrimary, formatTokenFairCentsLine } from './tradeEntryBrief';
import type { OperatorVerdict } from './operatorVerdict';
import type { TradeLevels } from './tradeLevels';

describe('formatDeskEntryPrimary', () => {
  it('matches card entry / TP / SL cents', () => {
    const levels: TradeLevels = {
      lane: 'up',
      entry: 0.62,
      takeProfit: 0.74,
      stopLoss: 0.55,
      takeProfitGain: 0.12,
      stopLossLoss: 0.07,
      rrRatio: 1.71,
      horizonSec: 120,
      summary: 'x',
      collapsed: false,
    };
    const verdict: OperatorVerdict = {
      state: 'GO_LONG',
      color: 'green',
      bigVerb: 'ENTER UP',
      headline: 'legacy',
      reason: 'r',
      confidence: 'HIGH',
      blockers: [],
      primaryBlocker: null,
      isStandDown: false,
    };
    const line = formatDeskEntryPrimary(
      verdict,
      {
        action: 'INITIATE',
        lane: 'up',
        urgency: 'now',
        recommendedSize: 0.3,
        headline: 'INITIATE UP',
        reason: 'r',
        evidence: [],
        confidence: 'HIGH',
        defensive: false,
        edgePerShareUsd: 0.05,
        laneMid: 0.62,
        laneWinProb: 0.58,
      },
      levels,
      'Up',
      'Down',
    );
    expect(line).toBe('ENTER UP @ 62¢ · TP 74¢ · SL 55¢');
  });
});

describe('formatTokenFairCentsLine', () => {
  it('maps win % to fair ¢ and edge vs book', () => {
    expect(formatTokenFairCentsLine({ pWin01: 0.55, laneMid01: 0.41 })).toBe(
      'fair 55¢ (55%) · book 41¢ · +14¢/sh',
    );
  });
});

describe('formatDeskEntryDetail', () => {
  it('ties probability to Polymarket cents on the detail line', () => {
    const verdict: OperatorVerdict = {
      state: 'GO_SHORT',
      color: 'green',
      bigVerb: 'ENTER DOWN',
      headline: 'h',
      reason: 'r',
      confidence: 'HIGH',
      blockers: [],
      primaryBlocker: null,
      isStandDown: false,
    };
    const detail = formatDeskEntryDetail(
      verdict,
      {
        action: 'INITIATE',
        lane: 'down',
        urgency: 'now',
        recommendedSize: 0.3,
        headline: 'INITIATE DOWN',
        reason: 'r',
        evidence: [],
        confidence: 'HIGH',
        defensive: false,
        edgePerShareUsd: 0.14,
        laneMid: 0.41,
        laneWinProb: 0.55,
        laneOutcomeLabel: 'Down',
      },
      null,
      'Up',
      'Down',
    );
    expect(detail).toBe('Working mid 41¢ — TP/SL row loading');
  });
});
