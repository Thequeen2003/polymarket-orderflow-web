import type { DirectiveStability } from './directiveStability';
import type { NoTradeScore } from './noTradeScore';
import type { OperatorVerdict } from './operatorVerdict';
import type { ReEntryGuardCheck } from './reEntryGuard';
import type { SizingMultiplier } from './directiveSizingMultiplier';
import type { TradeDirective } from './tradeDirective';
import type { TradeLevels } from './tradeLevels';

export type TraderDisciplineMode = 'PRESS' | 'PROBE' | 'WAIT' | 'SKIP' | 'MANAGE';

export type TraderDiscipline = {
  mode: TraderDisciplineMode;
  score: number;
  headline: string;
  sizePct: number;
  blockers: string[];
  confirmations: string[];
  rules: string[];
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function cents(v: number): string {
  return `${(v * 100).toFixed(1)}¢`;
}

function pushUnique(out: string[], value: string): void {
  if (!out.includes(value)) out.push(value);
}

export function buildTraderDiscipline(input: {
  directive: TradeDirective | null;
  verdict: OperatorVerdict;
  levels?: TradeLevels | null;
  noTradeScore?: NoTradeScore | null;
  stability?: DirectiveStability | null;
  reEntry?: ReEntryGuardCheck | null;
  sizingMultiplier?: SizingMultiplier | null;
}): TraderDiscipline {
  const { directive, verdict, levels, noTradeScore, stability, reEntry, sizingMultiplier } = input;
  const blockers: string[] = [];
  const confirmations: string[] = [];
  const rules: string[] = [];

  if (!directive || verdict.isStandDown) {
    return {
      mode: 'SKIP',
      score: verdict.isStandDown ? 15 : 0,
      headline: verdict.primaryBlocker ? `Skip: ${verdict.primaryBlocker}.` : 'Skip until the signal resolves.',
      sizePct: 0,
      blockers: verdict.blockers.length > 0 ? verdict.blockers.slice(0, 4) : ['no actionable signal'],
      confirmations,
      rules: ['Do not force a side while the card says wait.', 'Re-check after the next stable tick.'],
    };
  }

  if (verdict.state === 'EXIT_NOW' || directive.action === 'EXIT' || directive.action === 'TRIM' || directive.action === 'FLIP') {
    const closeFirst =
      directive.action === 'FLIP' && directive.flipHeldOutcomeLabel
        ? `Close ${directive.flipHeldOutcomeLabel} before buying the new side.`
        : 'Manage the open position before thinking about a new entry.';
    return {
      mode: 'MANAGE',
      score: 82,
      headline: 'Manage risk first.',
      sizePct: 0,
      blockers,
      confirmations: [verdict.reason].filter(Boolean).slice(0, 2),
      rules: [closeFirst, 'Use the live bid/ask, not the old target, if liquidity moves away.'],
    };
  }

  let score = 50;
  if (directive.confidence === 'HIGH') {
    score += 12;
    confirmations.push('high-confidence signal');
  } else if (directive.confidence === 'LOW') {
    score -= 12;
    blockers.push('low-confidence signal');
  }

  if (directive.edgePerShareUsd != null) {
    if (directive.edgePerShareUsd >= 0.08) {
      score += 18;
      confirmations.push(`strong modeled edge ${cents(directive.edgePerShareUsd)}/sh`);
    } else if (directive.edgePerShareUsd >= 0.035) {
      score += 10;
      confirmations.push(`positive modeled edge ${cents(directive.edgePerShareUsd)}/sh`);
    } else if (directive.edgePerShareUsd > 0) {
      score -= 8;
      blockers.push(`thin edge ${cents(directive.edgePerShareUsd)}/sh`);
    } else {
      score -= 28;
      blockers.push('modeled edge is negative');
    }
  }

  if (levels && !levels.collapsed) {
    if (levels.rrRatio >= 1.35) {
      score += 12;
      confirmations.push(`R:R ${levels.rrRatio.toFixed(2)} is acceptable`);
    } else if (levels.rrRatio >= 1.05) {
      score += 4;
      confirmations.push(`R:R ${levels.rrRatio.toFixed(2)} is workable`);
    } else {
      score -= 22;
      blockers.push(`R:R ${levels.rrRatio.toFixed(2)} is not worth pressing`);
    }

    if (levels.takeProfitGain >= 0.035) confirmations.push(`target gives +${cents(levels.takeProfitGain)}/sh`);
    else {
      score -= 8;
      blockers.push('profit target is too tight after spread');
    }

    if (levels.stopLossLoss > 0.075) {
      score -= 8;
      blockers.push(`stop risks ${cents(levels.stopLossLoss)}/sh`);
    }

    rules.push(`Entry discipline: avoid chasing above ${cents(levels.entry + 0.015)}.`);
    rules.push(`Bracket before entry: TP ${cents(levels.takeProfit)} / SL ${cents(levels.stopLoss)}.`);
  } else if (levels?.collapsed) {
    score -= 20;
    blockers.push('TP/SL collapsed into the bell');
    rules.push('Final seconds: manage exits only; skip fresh wide-limit entries.');
  } else {
    score -= 10;
    blockers.push('TP/SL not available yet');
    rules.push('Wait for the entry, TP, and stop row before sizing.');
  }

  if (noTradeScore) {
    if (noTradeScore.tier === 'RED') {
      score -= 35;
      blockers.push(noTradeScore.summary);
    } else if (noTradeScore.tier === 'YELLOW') {
      score -= 14;
      blockers.push(noTradeScore.summary);
    } else {
      confirmations.push('no-trade filter is green');
    }
  }

  if (stability?.tier === 'whipsaw') {
    score -= 30;
    blockers.push(`whipsaw ${stability.flipsLastMin}/min`);
  } else if (stability?.tier === 'forming') {
    score -= 10;
    blockers.push('signal is still forming');
  } else if (stability?.tier === 'stable') {
    confirmations.push('signal has stabilized');
  }

  if (reEntry?.onCooldown) {
    score -= 35;
    blockers.push(`cool-down ${Math.ceil(reEntry.msRemaining / 1000)}s`);
  }

  const mult = sizingMultiplier?.combined ?? 1;
  if (mult < 0.35) {
    score -= 18;
    blockers.push(`size multiplier only ×${mult.toFixed(2)}`);
  } else if (mult < 0.75) {
    score -= 8;
    blockers.push(`reduced size ×${mult.toFixed(2)}`);
  }

  const clampedScore = Math.round(clamp(score, 0, 100));
  const effectiveSizePct = Math.round(clamp((directive.recommendedSize ?? 0) * mult * 100, 0, 100));
  let mode: TraderDisciplineMode = 'PROBE';
  if (blockers.length >= 3 || clampedScore < 35) mode = 'SKIP';
  else if (blockers.length >= 2 || clampedScore < 55) mode = 'WAIT';
  else if (clampedScore >= 78 && directive.confidence !== 'LOW') mode = 'PRESS';

  const sizePct = mode === 'SKIP' || mode === 'WAIT' ? 0 : mode === 'PROBE' ? Math.min(effectiveSizePct, 25) : effectiveSizePct;
  if (mode === 'PROBE') pushUnique(rules, 'Probe only; add size after the next signal remains aligned.');
  if (mode === 'PRESS') pushUnique(rules, 'Press only while the card, edge, and bracket stay aligned.');
  if (blockers.length > 0) pushUnique(rules, 'One more blocker means no add.');

  const headline =
    mode === 'PRESS'
      ? 'Quality is high enough to press.'
      : mode === 'PROBE'
        ? 'Use small size; make the market prove it.'
        : mode === 'WAIT'
          ? 'Wait for a cleaner tick.'
          : 'Skip this setup.';

  return {
    mode,
    score: clampedScore,
    headline,
    sizePct,
    blockers: blockers.slice(0, 4),
    confirmations: confirmations.slice(0, 4),
    rules: rules.slice(0, 4),
  };
}
