import { useEffect, useRef, useState } from 'react';
import type { DeskSingleAction, DeskSingleActionTone } from './deskSingleAction';
import { deskActionHardKey, deskActionSoftKey } from './signalsDeskStable';

const SOFT_DEBOUNCE_MS = 900;
/** Hold gray/WAIT flickers briefly so entry copy does not bounce every tick. */
const WEAK_FALL_HOLD_MS = 3_000;

function isEntryTone(tone: DeskSingleActionTone): boolean {
  return tone === 'green' || tone === 'emerald';
}

function isWaitTone(tone: DeskSingleActionTone): boolean {
  return tone === 'gray' || tone === 'amber';
}

function isWeakFall(a: DeskSingleAction): boolean {
  if (a.tone === 'gray') return true;
  return a.primary.trim().toUpperCase().startsWith('WAIT');
}

function stripEqual(a: DeskSingleAction, b: DeskSingleAction): boolean {
  return (
    a.primary === b.primary &&
    (a.detail ?? '') === (b.detail ?? '') &&
    a.tone === b.tone &&
    (a.physicsLine ?? '') === (b.physicsLine ?? '') &&
    (a.wallBidWarning ?? '') === (b.wallBidWarning ?? '')
  );
}

/**
 * Desk "Do this now" copy: snap lane/verdict changes; debounce TP/SL detail flicker;
 * hold brief WAIT/gray dips before falling from a strong ENTER line.
 */
export function useStableDeskAction(live: DeskSingleAction, meaningKey: string): DeskSingleAction {
  const [displayed, setDisplayed] = useState(live);
  const displayedRef = useRef(displayed);
  displayedRef.current = displayed;

  const meaningRef = useRef(meaningKey);
  const hardRef = useRef(deskActionHardKey(live));
  const softRef = useRef(deskActionSoftKey(live));
  const lastToneRef = useRef(live.tone);
  const fallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallPendingRef = useRef<DeskSingleAction | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;

  const clearFallTimer = () => {
    if (fallTimerRef.current != null) {
      window.clearTimeout(fallTimerRef.current);
      fallTimerRef.current = null;
    }
  };

  const commitDisplayed = (next: DeskSingleAction) => {
    if (stripEqual(displayedRef.current, next)) return;
    displayedRef.current = next;
    setDisplayed(next);
    hardRef.current = deskActionHardKey(next);
    softRef.current = deskActionSoftKey(next);
    lastToneRef.current = next.tone;
  };

  const applyWeakFallPolicy = (candidate: DeskSingleAction) => {
    const showing = displayedRef.current;
    const liveWeak = isWeakFall(candidate);
    const showingWeak = isWeakFall(showing);

    if (!liveWeak) {
      clearFallTimer();
      fallPendingRef.current = null;
      commitDisplayed(candidate);
      return;
    }

    if (!showingWeak) {
      fallPendingRef.current = candidate;
      if (fallTimerRef.current == null) {
        fallTimerRef.current = window.setTimeout(() => {
          fallTimerRef.current = null;
          const pending = fallPendingRef.current;
          fallPendingRef.current = null;
          if (pending != null) commitDisplayed(pending);
        }, WEAK_FALL_HOLD_MS);
      } else {
        fallPendingRef.current = candidate;
      }
      return;
    }

    if (fallTimerRef.current == null) {
      commitDisplayed(candidate);
    } else {
      fallPendingRef.current = candidate;
    }
  };

  useEffect(() => {
    meaningRef.current = meaningKey;
    clearFallTimer();
    fallPendingRef.current = null;
    const next = liveRef.current;
    hardRef.current = deskActionHardKey(next);
    softRef.current = deskActionSoftKey(next);
    lastToneRef.current = next.tone;
    commitDisplayed(next);
  }, [meaningKey]);

  useEffect(() => {
    const liveNow = liveRef.current;
    if (meaningRef.current !== meaningKey) return;

    const hard = deskActionHardKey(liveNow);
    const soft = deskActionSoftKey(liveNow);

    if (hardRef.current !== hard) {
      clearFallTimer();
      fallPendingRef.current = null;
      applyWeakFallPolicy(liveNow);
      return;
    }

    if (softRef.current === soft) return;
    softRef.current = soft;

    const prevWait = isWaitTone(lastToneRef.current);
    const nowEntry = isEntryTone(liveNow.tone);
    lastToneRef.current = liveNow.tone;

    if (prevWait && nowEntry) {
      clearFallTimer();
      fallPendingRef.current = null;
      commitDisplayed(liveNow);
      return;
    }

    const id = window.setTimeout(() => {
      applyWeakFallPolicy(liveRef.current);
    }, SOFT_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [meaningKey, live.primary, live.detail, live.tone, live.wallBidWarning, live.physicsLine]);

  return displayed;
}
