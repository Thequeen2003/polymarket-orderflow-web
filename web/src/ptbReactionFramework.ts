/**
 * Product framing: PTB reaction system (not a generic trading chart).
 *
 * The PTB is a fixed outcome boundary for the round; spot is the moving record of
 * collective repricing. Edge comes from interaction — position, distance, time at
 * level, momentum/slope, and tests of the line — read inside the window’s time
 * pressure, not from forecasting price in isolation.
 */

/** Shown in UI — one sentence. */
export const PTB_REACTION_ONE_LINER =
  'A real-time read of how spot behaves versus the fixed price-to-beat boundary—position, distance, time on side, momentum, and reactions at the line—inside this market window.';

/** Collapsible “dimensions” copy (short). */
export const PTB_REACTION_DIMENSIONS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Position',
    body: 'Above, below, or at PTB. Context for which outcome the tape is leaning toward—not a signal by itself.',
  },
  {
    title: 'Distance',
    body: 'How far spot sits from PTB: how much path + time would be needed for the other side to win from here.',
  },
  {
    title: 'Time on side',
    body: 'Persistence matters. The longer spot holds one side of the line, the more the window reinforces that read.',
  },
  {
    title: 'Momentum / slope',
    body: 'Diagonal flow vs the boundary—e.g. above PTB but fading down reads differently from above and pressing.',
  },
  {
    title: 'Reaction at PTB',
    body: 'Approach, break-and-hold, rejection, or chop at the band—where control can hand off or defend.',
  },
];
