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
  if (args.endsInMs != null && Number.isFinite(args.endsInMs) && args.endsInMs <= 5_000) return true;
  return false;
}

/** Clear per-slug roll lock once the new window has meaningful time left. */
export function shouldClearUpdownAutoRollKey(endsInMs: number | null): boolean {
  return endsInMs != null && Number.isFinite(endsInMs) && endsInMs > 8_000;
}

export type UpdownAutoRollTarget = {
  slug: string;
  forceReload: boolean;
};

/** Pick the next slug for auto-roll (step forward, else live API slug). */
export function pickUpdownAutoRollTarget(args: {
  selectedSlug: string;
  stepNextSlug: string | null;
  liveSlugFromApi: string | null;
}): UpdownAutoRollTarget | null {
  const selected = args.selectedSlug.trim().toLowerCase();
  const next = args.stepNextSlug?.trim() ?? '';
  const live = args.liveSlugFromApi?.trim() ?? '';

  if (next && next.toLowerCase() !== selected) {
    return { slug: next, forceReload: false };
  }
  if (live && live.toLowerCase() !== selected) {
    return { slug: live, forceReload: false };
  }
  if (next) return { slug: next, forceReload: true };
  if (live) return { slug: live, forceReload: true };
  return null;
}

export function updownAutoRollPollMs(endsInMs: number | null): number {
  if (endsInMs == null) return 500;
  if (endsInMs <= 0) return 150;
  if (endsInMs <= 3_000) return 300;
  if (endsInMs <= 15_000) return 700;
  if (endsInMs <= 60_000) return 1_500;
  return 4_000;
}

/** Poll shortcut API for the live bucket — faster near window end. */
export function updownLiveSlugPollMs(endsInMs: number | null): number {
  if (endsInMs == null) return 10_000;
  if (endsInMs <= 0) return 1_000;
  if (endsInMs <= 15_000) return 1_500;
  if (endsInMs <= 60_000) return 4_000;
  return 15_000;
}

/** Prefetch next bucket metadata + books when this much time remains (ms). */
export const UPDOWN_PREFETCH_LEAD_MS = 90_000;
