import { useSyncExternalStore } from 'react';

let clockMs = Date.now();
const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function emitTick(): void {
  clockMs = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (intervalId == null) {
    intervalId = setInterval(emitTick, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId != null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

function getSnapshot(): number {
  return clockMs;
}

/** Shared 1s clock — only components that call this hook re-render on tick. */
export function usePredictionClockMs(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
