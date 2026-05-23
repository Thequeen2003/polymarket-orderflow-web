/**
 * Global keyboard-shortcut hook for the chart / signals page. Skips when the
 * user is typing in an input/textarea/select or has a modifier (other than
 * shift) held — so it never steals editing keys.
 *
 * Shortcuts:
 *   ?           toggle help dialog
 *   Esc         dismiss alert / cross-imminent banners (callers wire onDismiss)
 *   m           toggle alert chime on/off
 *   p           toggle pinned-note input visibility
 *   t           toggle "Test alert" (preview overlay)
 *   j           focus DOWN lane summary (callers can scroll-into-view)
 *   k           focus UP lane summary
 *   e           export trade journal as CSV (from card)
 *
 * Each handler is optional — pass null to skip. The hook is purely event
 * plumbing; it doesn't render anything (the help dialog component lives
 * separately).
 */
import { useEffect } from 'react';

export type ShortcutHandlers = {
  onToggleHelp?: (() => void) | null;
  onDismiss?: (() => void) | null;
  onToggleSound?: (() => void) | null;
  onTogglePinnedNote?: (() => void) | null;
  onTestBoom?: (() => void) | null;
  onFocusUp?: (() => void) | null;
  onFocusDown?: (() => void) | null;
  onExportJournal?: (() => void) | null;
};

const KEY_MAP: Record<string, keyof ShortcutHandlers> = {
  '?': 'onToggleHelp',
  Escape: 'onDismiss',
  m: 'onToggleSound',
  p: 'onTogglePinnedNote',
  t: 'onTestBoom',
  j: 'onFocusDown',
  k: 'onFocusUp',
  e: 'onExportJournal',
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = (ev: KeyboardEvent) => {
      // Honor cmd/ctrl/alt — those are app/system shortcuts.
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (isEditableTarget(ev.target)) return;
      // `?` requires shift on most layouts — accept either form.
      const key =
        ev.key === '?' || (ev.key === '/' && ev.shiftKey)
          ? '?'
          : ev.key === 'Escape'
            ? 'Escape'
            : ev.key.toLowerCase();
      const handlerKey = KEY_MAP[key];
      if (!handlerKey) return;
      const fn = handlers[handlerKey];
      if (typeof fn === 'function') {
        ev.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handlers, enabled]);
}

export const SHORTCUT_HELP: { key: string; description: string }[] = [
  { key: '?', description: 'Toggle this help' },
  { key: 'Esc', description: 'Dismiss alert / banner' },
  { key: 'm', description: 'Toggle alert chime' },
  { key: 'p', description: 'Toggle round note' },
  { key: 't', description: 'Fire test alert' },
  { key: 'k', description: 'Focus UP lane' },
  { key: 'j', description: 'Focus DOWN lane' },
  { key: 'e', description: 'Export trade journal (CSV)' },
];
