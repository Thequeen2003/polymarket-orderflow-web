import type { OperatorVerdict } from './operatorVerdict';
import type { PositionExitReadout } from './positionDeskAlerts';
import type { TradeDirective } from './tradeDirective';
import type { TradeLevels } from './tradeLevels';
import type { WallBidWarning } from './dualOutcomeWalls';
import {
  resolveDeskPlaybookAction,
  type DeskSingleAction,
  type DeskSingleActionTone,
  type SpotBandGaugeSnapshot,
} from './spotBandDeskAction';

export type { DeskSingleAction, DeskSingleActionTone, SpotBandGaugeSnapshot };

/**
 * Signals “Do this now” — one line from operator verdict + trade card; band is guide-only detail.
 */
export function computeDeskSingleAction(args: {
  manualLane: 'up' | 'down' | null;
  exitReadout: PositionExitReadout | null;
  verdict: OperatorVerdict | null;
  hasDirective: boolean;
  directive?: TradeDirective | null;
  levels?: TradeLevels | null;
  upLabel?: string;
  downLabel?: string;
  bandGauge?: SpotBandGaugeSnapshot | null;
  flowWinningLane?: 'up' | 'down' | null;
  bookControl?: 'up' | 'down' | null;
  wallHeadline?: string | null;
  wallBidWarnings?: WallBidWarning[];
  /** Spot vs PTB + book — shown under the primary line. */
  physicsLine?: string | null;
}): DeskSingleAction {
  const base = resolveDeskPlaybookAction(args);
  const physics = args.physicsLine?.trim() || null;
  return { ...base, physicsLine: physics ?? base.physicsLine ?? null };
}
