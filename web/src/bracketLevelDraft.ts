/** Persist SL/TP trigger ¢ per outcome token — survives lane switches and reloads before arming. */

export type BracketLevelsDraft = {
  sl: string;
  tp: string;
  at: number;
};

function key(token: string): string {
  return `pm:bracket-levels-draft:v1:${token.trim()}`;
}

export function loadBracketLevelsDraft(token: string): BracketLevelsDraft | null {
  const tid = token.trim();
  if (!tid) return null;
  try {
    const raw = window.localStorage.getItem(key(tid));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BracketLevelsDraft>;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      sl: typeof parsed.sl === 'string' ? parsed.sl : '',
      tp: typeof parsed.tp === 'string' ? parsed.tp : '',
      at: typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : 0,
    };
  } catch {
    return null;
  }
}

export function saveBracketLevelsDraft(token: string, draft: { sl: string; tp: string }): void {
  const tid = token.trim();
  if (!tid) return;
  const sl = draft.sl.trim();
  const tp = draft.tp.trim();
  if (!sl && !tp) {
    try {
      window.localStorage.removeItem(key(tid));
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    window.localStorage.setItem(
      key(tid),
      JSON.stringify({ sl, tp, at: Date.now() } satisfies BracketLevelsDraft),
    );
  } catch {
    /* ignore */
  }
}
