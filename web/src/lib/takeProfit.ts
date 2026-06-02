export type TakeProfitTriggerState = {
  /** The previous sampled reference price (0..1). */
  prevRef01: number | null;
  /** Consecutive "up" samples (curr > prev). */
  upStreak: number;
  /** Highest range band already triggered (>= 0). */
  lastBand: number;
};

/**
 * Range bands above momentum:
 * - band 0: below first TP step
 * - band 1: [momentum+step, momentum+2*step)
 * - band 2: [momentum+2*step, ...)
 */
export function takeProfitBand(params: {
  ref01: number;
  momentum01: number;
  step01: number;
}): number {
  const { ref01, momentum01, step01 } = params;
  if (!Number.isFinite(ref01) || !Number.isFinite(momentum01) || !Number.isFinite(step01)) return 0;
  if (!(ref01 > 0 && ref01 < 1)) return 0;
  if (!(momentum01 > 0 && momentum01 < 1)) return 0;
  if (!(step01 > 0 && step01 < 1)) return 0;
  const d = ref01 - momentum01;
  if (d < step01) return 0;
  // Epsilon avoids float edge cases at exact boundaries (e.g. 0.58-0.50 = 0.079999999...).
  return Math.floor((d + 1e-9) / step01);
}

export function nextTakeProfitState(params: {
  state: TakeProfitTriggerState;
  ref01: number | null;
  momentum01: number | null;
  step01: number;
  /** Require this many consecutive up samples before any trigger. */
  minUpStreak: number;
}): { state: TakeProfitTriggerState; shouldTrigger: boolean; band: number } {
  const { state, ref01, momentum01, step01, minUpStreak } = params;
  const prev = state.prevRef01;

  if (ref01 == null || momentum01 == null) {
    return { state: { ...state, prevRef01: ref01 }, shouldTrigger: false, band: 0 };
  }
  if (!Number.isFinite(ref01) || !Number.isFinite(momentum01)) {
    return { state: { ...state, prevRef01: ref01 }, shouldTrigger: false, band: 0 };
  }
  if (!(ref01 > 0 && ref01 < 1) || !(momentum01 > 0 && momentum01 < 1)) {
    return { state: { ...state, prevRef01: ref01 }, shouldTrigger: false, band: 0 };
  }

  const up = prev != null && Number.isFinite(prev) && ref01 > prev;
  const upStreak = up ? state.upStreak + 1 : 0;

  const band = takeProfitBand({ ref01, momentum01, step01 });
  const shouldTrigger = upStreak >= Math.max(1, minUpStreak) && band >= 1 && band > state.lastBand;

  return {
    state: { prevRef01: ref01, upStreak, lastBand: shouldTrigger ? band : state.lastBand },
    shouldTrigger,
    band,
  };
}

