import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOW_PRICE_DESK_PANELS,
  readNowPriceDeskPanels,
  toggleNowPriceDeskPanel,
  writeNowPriceDeskPanels,
} from './nowPriceDeskPanels';

const mem = new Map<string, string>();
const mockLocalStorage = {
  getItem(k: string) {
    return mem.has(k) ? mem.get(k)! : null;
  },
  setItem(k: string, v: string) {
    mem.set(k, v);
  },
  removeItem(k: string) {
    mem.delete(k);
  },
  clear() {
    mem.clear();
  },
  key(i: number) {
    const keys = [...mem.keys()];
    return keys[i] ?? null;
  },
  get length() {
    return mem.size;
  },
} as Storage;

describe('nowPriceDeskPanels', () => {
  beforeAll(() => {
    vi.stubGlobal('localStorage', mockLocalStorage);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    mem.clear();
  });

  it('defaults all panels open', () => {
    expect(DEFAULT_NOW_PRICE_DESK_PANELS).toEqual({ catch: true, signal: true, context: true });
    expect(readNowPriceDeskPanels()).toEqual(DEFAULT_NOW_PRICE_DESK_PANELS);
  });

  it('toggles a single panel', () => {
    const closed = toggleNowPriceDeskPanel(DEFAULT_NOW_PRICE_DESK_PANELS, 'signal');
    expect(closed.signal).toBe(false);
    expect(closed.catch).toBe(true);
  });

  it('round-trips localStorage', () => {
    const state = { catch: false, signal: true, context: false };
    writeNowPriceDeskPanels(state);
    expect(readNowPriceDeskPanels()).toEqual(state);
  });
});
