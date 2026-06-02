import { useRef } from 'react';
import { pickBookLevels } from './bookLevels';
import { updateStableBookLadder, type StableBookLadderState } from './stableBookDisplay';

/** Smoothed bids/asks + depth scale for ladder panels (reduces WS tick flicker). */
export function useStableBookLadder(book: unknown, maxLevels = 12): StableBookLadderState {
  const stateRef = useRef<StableBookLadderState | null>(null);
  const { bids, asks } = pickBookLevels(book);
  stateRef.current = updateStableBookLadder(stateRef.current, { bids, asks }, maxLevels);
  return stateRef.current;
}
