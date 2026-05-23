import { describe, expect, it } from 'vitest';
import { outcomePositionsDetailMatchesTokens, type OutcomePositionsDetail } from './signalsDeskPosition';

describe('outcomePositionsDetailMatchesTokens', () => {
  const detail = (up: string, down: string): OutcomePositionsDetail => ({
    mode: 'paper',
    up: { tokenId: up, shares: 1 },
    down: { tokenId: down, shares: 0 },
  });

  it('requires both outcome token ids to match the active market', () => {
    expect(outcomePositionsDetailMatchesTokens(detail('up-a', 'down-a'), 'up-a', 'down-a')).toBe(true);
    expect(outcomePositionsDetailMatchesTokens(detail('up-a', 'down-a'), 'up-b', 'down-b')).toBe(false);
    expect(outcomePositionsDetailMatchesTokens(detail('up-a', 'down-a'), 'up-a', 'down-b')).toBe(false);
  });
});
