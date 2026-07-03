const STORAGE_KEY = 'pm:updown-auto-roll:v1';

/** Default-on: roll to the next Up/Down bucket when the current window ends. */
export function readUpdownAutoRollEnabled(): boolean {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === '0') return false;
    return true;
  } catch {
    return true;
  }
}

export function saveUpdownAutoRollEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* ignore quota */
  }
}

/** True when the active window has ended (or Gamma marks it closed). */
export function shouldAutoRollUpdownMarket(args: {
  endsInMs: number | null;
  marketClosed: boolean;
}): boolean {
  if (args.marketClosed) return true;
  if (args.endsInMs != null && Number.isFinite(args.endsInMs) && args.endsInMs <= 2_000) return true;
  return false;
}
