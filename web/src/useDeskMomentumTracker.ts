import { useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeDeskMomentum,
  createDeskMomentumTracker,
  pushDeskMomentumSample,
  type DeskMomentumReadout,
} from './deskMomentumTracker';

const TICK_MS = 900;

export function useDeskMomentumTracker(args: {
  focusLane: 'up' | 'down' | null;
  focusMid01: number | null;
  liveDeskTp01: number | null;
  upMid01: number | null;
  downMid01: number | null;
  upLabel?: string;
  downLabel?: string;
  /** Reset samples when slug/market changes. */
  resetKey?: string | null;
}): DeskMomentumReadout | null {
  const { upLabel, downLabel, resetKey = null } = args;

  const argsRef = useRef(args);
  argsRef.current = args;

  const stateRef = useRef(createDeskMomentumTracker(args.focusLane));
  const resetRef = useRef<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const lane = argsRef.current.focusLane;
    const key = `${resetKey ?? ''}|${lane ?? ''}`;
    if (resetRef.current !== key) {
      resetRef.current = key;
      stateRef.current = createDeskMomentumTracker(lane);
      setVersion((v) => v + 1);
    }
  }, [resetKey, args.focusLane]);

  useEffect(() => {
    const lane = argsRef.current.focusLane;
    if (lane == null) return;

    const tick = () => {
      const a = argsRef.current;
      if (a.focusLane == null || a.focusMid01 == null || !(a.focusMid01 > 0 && a.focusMid01 < 1)) return;

      const prevLen = stateRef.current.samples.length;
      stateRef.current = pushDeskMomentumSample(stateRef.current, {
        focusLane: a.focusLane,
        ms: Date.now(),
        focusMid01: a.focusMid01,
        liveDeskTp01: a.liveDeskTp01,
        upMid01: a.upMid01,
        downMid01: a.downMid01,
      });
      if (stateRef.current.samples.length !== prevLen) {
        setVersion((v) => v + 1);
      }
    };

    tick();
    const id = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(id);
  }, [args.focusLane, resetKey]);

  return useMemo(
    () =>
      analyzeDeskMomentum({
        state: stateRef.current,
        upLabel,
        downLabel,
      }),
    [version, upLabel, downLabel, args.focusLane],
  );
}
