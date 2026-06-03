import { beforeEach, describe, expect, it } from 'vitest';

import { loadBracketLevelsDraft, saveBracketLevelsDraft } from './bracketLevelDraft';
import { installMockLocalStorage } from './test/mockLocalStorage';

describe('bracketLevelDraft', () => {
  beforeEach(() => {
    installMockLocalStorage();
  });

  it('round-trips draft cents per token', () => {
    saveBracketLevelsDraft('tok-a', { sl: '42', tp: '68' });
    expect(loadBracketLevelsDraft('tok-a')).toMatchObject({ sl: '42', tp: '68' });
  });

  it('clears when both empty', () => {
    saveBracketLevelsDraft('tok-b', { sl: '40', tp: '' });
    saveBracketLevelsDraft('tok-b', { sl: '', tp: '' });
    expect(loadBracketLevelsDraft('tok-b')).toBeNull();
  });
});
