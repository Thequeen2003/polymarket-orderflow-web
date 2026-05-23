import { describe, expect, it } from 'vitest';

import { classifyPtbControlSignal } from './ptbControlSignal';
import type { PtbReactionAnalysis } from './spotVsPtb';

function stubReaction(over: Partial<PtbReactionAnalysis> = {}): PtbReactionAnalysis {
  return {
    kind: 'drifting_no_interaction',
    eps: 1,
    headline: '',
    reactionStrength: {
      tier: 'weak',
      shape: 'unclear',
      primary: '',
      avgBodyAtPtbPct: null,
      wickyBucketPct: null,
    },
    interaction: 'drift',
    candleAtPtb: '',
    orderFlowAggressive: null,
    flowAtLine: '',
    extensionFollowThrough: 'follow_through',
    extensionAfterPtb: '',
    extension: '',
    gaps: '',
    tradeAnswer: '',
    shellMarkAbove: null,
    shellMarkBelow: null,
    ...over,
  };
}

describe('classifyPtbControlSignal', () => {
  it('when Down is priced very rich, mismatch below+UP momentum explains board vs tape', () => {
    const r = classifyPtbControlSignal({
      position: 'BELOW',
      momentum: 'UP',
      interaction: 'hold',
      reaction: stubReaction(),
      dwellAboveMs: 200,
      dwellBelowMs: 200,
      dwellAtMs: 100,
      distanceUsd: -2,
      lastProbUp: 0.02,
      lastProbDown: 0.98,
    });
    expect(r.signal).toBe('TRANSITION');
    expect(r.blurb).toContain('Down is already');
    expect(r.blurb).toContain('98');
    expect(r.blurb).not.toContain('**');
  });

  it('same mismatch without CLOB mids keeps strike-vs-token disambiguation', () => {
    const r = classifyPtbControlSignal({
      position: 'BELOW',
      momentum: 'UP',
      interaction: 'hold',
      reaction: stubReaction(),
      dwellAboveMs: 200,
      dwellBelowMs: 200,
      dwellAtMs: 100,
      distanceUsd: -2,
    });
    expect(r.signal).toBe('TRANSITION');
    expect(r.blurb).toContain('CLOB');
    expect(r.blurb).not.toContain('**');
  });
});
