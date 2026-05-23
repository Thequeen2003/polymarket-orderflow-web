/**
 * Confidence-adjusted sizing multiplier.
 *
 * The directive engine emits a nominal `recommendedSize`. Layer auxiliary checks
 * on top to shrink size when conditions degrade:
 *
 *   - Stability tier (whipsaw / forming / consolidating / stable)
 *   - Discrepancy state (sensors disagreeing with the directive)
 *   - Edge quality of the lane (HIGH / MED / LOW / THIN / NEGATIVE)
 *   - Active re-entry cool-down on the directive's lane
 *
 * Combined as a *product* — any one of these can shrink size meaningfully, all
 * four bad would crush size to a tiny fraction (which is the right answer; the
 * UI then highlights "you should probably skip this trade").
 *
 * Pure module — easy to unit-test, no React.
 */

import type { DirectiveStability } from './directiveStability';
import type { DirectiveDiscrepancy } from './directiveDiscrepancyGuard';
import type { LaneEdges, EdgeQuality } from './tradeEdgeCalculator';

export type SizingMultiplier = {
  stabilityFactor: number;
  discrepancyFactor: number;
  edgeQualityFactor: number;
  cooldownFactor: number;
  /** Product of all factors, clamped 0..1. */
  combined: number;
  /** Plain-English notes about which factors dragged size down. */
  notes: string[];
};

const STABILITY_FACTOR: Record<DirectiveStability['tier'], number> = {
  whipsaw: 0.3,
  forming: 0.6,
  consolidating: 0.85,
  stable: 1.0,
};

const QUALITY_FACTOR: Record<EdgeQuality, number> = {
  HIGH: 1.0,
  MED: 0.85,
  LOW: 0.7,
  THIN: 0.5,
  NEGATIVE: 0.2,
};

export function computeSizingMultiplier(input: {
  stability?: DirectiveStability | null;
  discrepancy?: DirectiveDiscrepancy | null;
  edges?: LaneEdges | null;
  /** Lane the directive is targeting. */
  lane?: 'up' | 'down' | null;
  /** True when the directive's lane is in re-entry cool-down. */
  cooldownActive?: boolean;
}): SizingMultiplier {
  const notes: string[] = [];

  // 1) Stability
  let stabilityFactor = 1.0;
  if (input.stability) {
    stabilityFactor = STABILITY_FACTOR[input.stability.tier];
    if (stabilityFactor < 1) {
      notes.push(`${input.stability.tier} ×${stabilityFactor.toFixed(2)}`);
    }
  }

  // 2) Discrepancy: high blocker → 0.4, any med → 0.7, any low → 0.85
  let discrepancyFactor = 1.0;
  if (input.discrepancy?.shouldBlock) {
    discrepancyFactor = 0.4;
    notes.push('disagreement (HIGH) ×0.40');
  } else if (input.discrepancy && input.discrepancy.warnings.some((w) => w.severity === 'med')) {
    discrepancyFactor = 0.7;
    notes.push('disagreement (MED) ×0.70');
  } else if (input.discrepancy?.any) {
    discrepancyFactor = 0.85;
    notes.push('disagreement (LOW) ×0.85');
  }

  // 3) Edge quality on the directive's lane
  let edgeQualityFactor = 1.0;
  if (input.edges && input.lane) {
    const laneEdge = input.lane === 'up' ? input.edges.up : input.edges.down;
    if (laneEdge) {
      edgeQualityFactor = QUALITY_FACTOR[laneEdge.quality];
      if (edgeQualityFactor < 1) {
        notes.push(`${laneEdge.quality} edge ×${edgeQualityFactor.toFixed(2)}`);
      }
    }
  }

  // 4) Re-entry cool-down
  const cooldownFactor = input.cooldownActive ? 0.4 : 1.0;
  if (input.cooldownActive) notes.push('cool-down ×0.40');

  const combined = Math.max(
    0,
    Math.min(1, stabilityFactor * discrepancyFactor * edgeQualityFactor * cooldownFactor),
  );

  return {
    stabilityFactor,
    discrepancyFactor,
    edgeQualityFactor,
    cooldownFactor,
    combined,
    notes,
  };
}
