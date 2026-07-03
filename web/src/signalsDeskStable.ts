import type { SwitchForecast } from './sectionalMomentum';
import type { DeskSingleAction } from './deskSingleAction';
import type { OperatorVerdict } from './operatorVerdict';
import type { NoTradeScore } from './noTradeScore';
import type { SpotBandGaugeSnapshot } from './spotBandDeskAction';
import type { SpotPtbMachineReadout } from './spotPtbMachineSignals';
import type { TradeDirective } from './tradeDirective';

/** Lane / verdict identity — not entry/TP/SL ticks (those stay in deskLiveSig). */
export function buildDeskMeaningKey(args: {
  manualLane: 'up' | 'down' | null;
  directive: TradeDirective | null;
  verdict: OperatorVerdict | null;
}): string {
  const d = args.directive;
  const v = args.verdict;
  return [
    args.manualLane ?? '-',
    d?.action ?? '-',
    d?.lane ?? '-',
    v?.state ?? '-',
    v?.bigVerb ?? '-',
  ].join('|');
}

export function tradeDirectiveMeaningKey(d: TradeDirective | null): string {
  if (!d) return '';
  return [d.action, d.lane ?? '-', d.confidence, d.defensive ? '1' : '0', d.headline.trim()].join('|');
}

export function machineReadoutMeaningKey(r: SpotPtbMachineReadout | null): string {
  if (!r) return '';
  const cross =
    r.crossProb != null && Number.isFinite(r.crossProb) ? Math.round(r.crossProb * 100) : '-';
  return [
    r.focusLane ?? '-',
    r.flowWinningLane ?? '-',
    Math.round(r.agreementScore),
    r.regime,
    r.urgency,
    cross,
    r.sensors.bookControl ?? '-',
    r.wallFlow?.headline?.trim() ?? '-',
  ].join('|');
}

export function bandGaugeMeaningKey(g: SpotBandGaugeSnapshot | null): string {
  if (!g) return '';
  return [g.mode, g.activeStep, g.separation, g.geo, g.favorableNow ? '1' : '0'].join('|');
}

export function noTradeScoreMeaningKey(s: NoTradeScore | null): string {
  if (!s) return '';
  const reasons = s.contributions
    .map((c) => c.reason)
    .sort()
    .join(',');
  return `${s.tier}|${Math.round(s.score)}|${reasons}`;
}

export function switchForecastMeaningKey(f: SwitchForecast | null): string {
  if (!f) return '';
  return [f.status, f.lane ?? '-', f.incomingLane ?? '-', f.confidence, f.headline.trim()].join('|');
}

export function deskActionHardKey(a: DeskSingleAction): string {
  return `${a.primary}\u0000${a.tone}\u0000${a.wallBidWarning ?? ''}`;
}

export function deskActionSoftKey(a: DeskSingleAction): string {
  return `${a.detail ?? ''}\u0000${a.physicsLine ?? ''}`;
}
