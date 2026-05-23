/**
 * SL/TP ¢ inputs: commit on Enter or safe blur — not on every keystroke (avoids arming at 5¢ while editing 55¢).
 */

import { roundPrice01ToCent } from './displayCents';

/** Strip invalid chars — whole cents only (drops fractional tail: 84.5 → 84). */
export function sanitizeBracketCentsDraft(raw: string): string {
  let s = raw.replace(/[^\d.]/g, '');
  const dot = s.indexOf('.');
  if (dot >= 0) s = s.slice(0, dot);
  return s.replace(/\D/g, '');
}

export function parseBracketCentsCommit(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  let v = n;
  if (v > 1.0001 && v <= 100) v = v / 100;
  if (!(v > 0) || v >= 1) return null;
  return roundPrice01ToCent(v);
}

export function formatBracketCents(price01: number): string {
  return String(Math.round(price01 * 100));
}

export function formatBracketCentsFromRaw(raw: string): string | null {
  const n = parseBracketCentsCommit(raw);
  return n == null ? null : formatBracketCents(n);
}

/** Automation reads committed state; optional pending draft while the field is focused. */
export function effectiveBracketCentsStr(committed: string, pendingDraft: string | null | undefined): string {
  const pending = pendingDraft?.trim();
  if (pending) return pending;
  return committed;
}

export function effectiveBracketCents01(committed: string, pendingDraft: string | null | undefined): number | null {
  return parseBracketCentsCommit(effectiveBracketCentsStr(committed, pendingDraft));
}

/**
 * Blur without Enter: reject likely mid-edit values (e.g. 55 → 5).
 * Enter always commits when parseable.
 */
export function shouldCommitBracketCentsOnBlur(args: {
  draftRaw: string;
  committedRaw: string;
  pressedEnter: boolean;
}): boolean {
  if (args.pressedEnter) return true;
  const draft = parseBracketCentsCommit(args.draftRaw);
  if (draft == null) return false;
  const committed = parseBracketCentsCommit(args.committedRaw);
  if (committed == null) return true;
  const draftC = draft * 100;
  const committedC = committed * 100;
  if (Math.abs(draftC - committedC) < 0.05) return true;
  if (committedC >= 10 && draftC < 10) return false;
  if (Math.abs(draftC - committedC) > 20) return false;
  return true;
}
