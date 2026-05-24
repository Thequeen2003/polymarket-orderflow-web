import { useEffect, useRef, useState } from 'react';
import type { DeskSingleAction } from './deskSingleAction';

const DETAIL_DEBOUNCE_MS = 900;

/**
 * Desk “Do this now” copy: snap on lane/verdict change; debounce detail/physics flicker.
 */
export function useStableDeskAction(live: DeskSingleAction, meaningKey: string): DeskSingleAction {
  const [displayed, setDisplayed] = useState(live);
  const meaningRef = useRef(meaningKey);

  useEffect(() => {
    if (meaningRef.current !== meaningKey) {
      meaningRef.current = meaningKey;
      setDisplayed(live);
      return;
    }
    setDisplayed((prev) =>
      prev.primary === live.primary && prev.tone === live.tone
        ? prev
        : { ...prev, primary: live.primary, tone: live.tone },
    );
    const id = window.setTimeout(() => setDisplayed(live), DETAIL_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [live, meaningKey]);

  return displayed;
}
