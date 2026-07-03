import { describe, expect, it } from 'vitest';

import { multiPanelTileClass, visibleSignalsPanels, type SignalsMultiPanelState } from './signalsMultiPanel';

const base: SignalsMultiPanelState = {
  v: 2,
  enabled: true,
  panels: { spot: true, dual: true, now: true, plm: false },
  panelScale: { spot: 1, dual: 1, now: 1, plm: 1 },
};

describe('visibleSignalsPanels', () => {
  it('omits spot on book-only desk', () => {
    const v = visibleSignalsPanels(base, { hasDual: true, bookOnlyDesk: true, showNow: true });
    expect(v).toEqual(['dual', 'now']);
  });

  it('requires hasDual for dual panel', () => {
    const v = visibleSignalsPanels(base, { hasDual: false, bookOnlyDesk: false, showNow: true });
    expect(v).toEqual(['spot', 'now']);
  });
});

describe('multiPanelTileClass', () => {
  it('gives full width for single panel', () => {
    expect(multiPanelTileClass('spot', ['spot'])).toBe('col-span-full');
  });

  it('places now on full row when three panels', () => {
    const vis: Array<'spot' | 'dual' | 'now'> = ['spot', 'dual', 'now'];
    expect(multiPanelTileClass('now', vis)).toBe('xl:col-span-full');
  });
});
