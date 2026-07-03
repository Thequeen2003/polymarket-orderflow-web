import type { PositionDeskSignal } from './positionDeskSignal';

export function shouldDispatchDeskAutoExit(input: {
  enabled: boolean;
  liveMode: boolean;
  heldLane: 'up' | 'down' | null;
  signal: PositionDeskSignal | null;
  minExitPressure: number;
}): { dispatch: boolean; blockReason: string | null } {
  if (!input.enabled) return { dispatch: false, blockReason: null };
  if (!input.liveMode) {
    return { dispatch: false, blockReason: 'Paper mode — switch to Live in the trade panel to auto-exit.' };
  }
  if (input.heldLane == null) return { dispatch: false, blockReason: null };
  const sig = input.signal;
  if (!sig) return { dispatch: false, blockReason: null };
  if (sig.action !== 'sell_now' && sig.action !== 'take_profit') {
    return { dispatch: false, blockReason: null };
  }
  if (sig.exitPressure < input.minExitPressure) {
    return {
      dispatch: false,
      blockReason: `Exit pressure ${Math.round(sig.exitPressure)} below minimum ${input.minExitPressure}.`,
    };
  }
  return { dispatch: true, blockReason: null };
}

export function deskAutoExitFireKey(
  slug: string | null | undefined,
  heldLane: 'up' | 'down',
  signal: PositionDeskSignal,
): string {
  return `${slug ?? ''}|${heldLane}|${signal.action}|${signal.reason}|${Math.round(signal.exitPressure)}`;
}
