import { useEffect, useRef, useState } from 'react';
import type { DeskSingleAction, DeskSingleActionTone } from './deskSingleAction';
import { deskActionHardKey, deskActionSoftKey } from './signalsDeskStable';

const SOFT_DEBOUNCE_MS = 900;

/** Entry tones that should snap instantly when transitioning from a wait/gray state. */
function isEntryTone(tone: DeskSingleActionTone): boolean {
  return tone === 'green' || tone === 'emerald';
}

function isWaitTone(tone: DeskSingleActionTone): boolean {
  return tone === 'gray' || tone === 'amber';
}

/**
 * Desk "Do this now" copy: snap primary/tone/wall on lane change; debounce detail/physics flicker.
 * Instant-snap path: when transitioning from WAIT/gray to ENTER/green, bypass soft debounce
 * entirely so entry signals appear without any delay.
 */
export function useStableDeskAction(live: DeskSingleAction, meaningKey: string): DeskSingleAction {
  const [displayed, setDisplayed] = useState(live);
  const meaningRef = useRef(meaningKey);
  const hardRef = useRef(deskActionHardKey(live));
  const softRef = useRef(deskActionSoftKey(live));
  const lastToneRef = useRef(live.tone);

  useEffect(() => {
    const hard = deskActionHardKey(live);
    const soft = deskActionSoftKey(live);
    const meaningChanged = meaningRef.current !== meaningKey;

    if (meaningChanged) {
      meaningRef.current = meaningKey;
      hardRef.current = hard;
      softRef.current = soft;
      lastToneRef.current = live.tone;
      setDisplayed(live);
      return;
    }

    if (hardRef.current !== hard) {
      hardRef.current = hard;
      softRef.current = soft;
      lastToneRef.current = live.tone;
      setDisplayed(live);
      return;
    }

    if (softRef.current === soft) return;
    softRef.current = soft;

    // Instant-snap: WAIT → ENTER transitions bypass debounce so entry signals appear immediately.
    const prevWait = isWaitTone(lastToneRef.current);
    const nowEntry = isEntryTone(live.tone);
    lastToneRef.current = live.tone;

    if (prevWait && nowEntry) {
      setDisplayed(live);
      return;
    }

    const id = window.setTimeout(() => setDisplayed(live), SOFT_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [live, meaningKey]);

  return displayed;
}
