import { useEffect, useRef, useState } from 'react';
import { updateStability, type DirectiveStability } from './directiveStability';
import { tradeDirectiveMeaningKey } from './signalsDeskStable';
import type { TradeDirective } from './tradeDirective';

function stabilityDisplayUnchanged(prev: DirectiveStability | null, next: DirectiveStability): boolean {
  if (!prev?.current || !next.current) return false;
  if (prev.tier !== next.tier) return false;
  if (prev.whipsaw !== next.whipsaw) return false;
  if (prev.warnFresh !== next.warnFresh) return false;
  if (prev.rapidConviction !== next.rapidConviction) return false;
  if (prev.current.action !== next.current.action) return false;
  if (prev.current.lane !== next.current.lane) return false;
  if (Math.abs(prev.msSinceChange - next.msSinceChange) < 750) return true;
  return prev.summary === next.summary;
}

/** Track directive stability without re-rendering on every TradeDirective object identity tick. */
export function useDirectiveStability(
  directive: TradeDirective | null,
  resetKey = 0,
): DirectiveStability | null {
  const directiveRef = useRef(directive);
  directiveRef.current = directive;
  const meaningKey = tradeDirectiveMeaningKey(directive);

  const [stability, setStability] = useState<DirectiveStability | null>(null);

  useEffect(() => {
    setStability(null);
  }, [resetKey]);

  useEffect(() => {
    const live = directiveRef.current;
    if (!live) {
      setStability((prev) => (prev == null ? prev : null));
      return;
    }
    setStability((prev) => {
      const next = updateStability(prev, live, Date.now());
      return stabilityDisplayUnchanged(prev, next) ? prev : next;
    });
  }, [meaningKey]);

  useEffect(() => {
    if (!meaningKey) return;
    const id = window.setInterval(() => {
      const live = directiveRef.current;
      if (!live) return;
      setStability((prev) => {
        const next = updateStability(prev, live, Date.now());
        return stabilityDisplayUnchanged(prev, next) ? prev : next;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [meaningKey]);

  return stability;
}
