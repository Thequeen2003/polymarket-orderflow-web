import { beforeEach, vi } from 'vitest';

const mem = new Map<string, string>();

export const mockLocalStorage = {
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
};

/** Install in-memory localStorage for trade-history and persist tests. */
export function installMockLocalStorage(): void {
  vi.stubGlobal('localStorage', mockLocalStorage);
  vi.stubGlobal('window', { localStorage: mockLocalStorage } as unknown as Window);
  beforeEach(() => {
    mockLocalStorage.clear();
  });
}
