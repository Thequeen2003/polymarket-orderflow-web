import { useCallback, useState, type ReactElement, type ReactNode } from 'react';
import { loadDeskPanelOpen, saveDeskPanelOpen } from './deskPanelPrefs';

export function DeskClosePanel(props: {
  id: string;
  title: string;
  /** Shown on the collapsed tab — keep short. */
  summary?: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}): ReactElement {
  const { id, title, summary, badge, defaultOpen = false, className = '', bodyClassName = '', children } = props;
  const [open, setOpen] = useState(() => loadDeskPanelOpen(id, defaultOpen));

  const close = useCallback(() => {
    setOpen(false);
    saveDeskPanelOpen(id, false);
  }, [id]);

  const reopen = useCallback(() => {
    setOpen(true);
    saveDeskPanelOpen(id, true);
  }, [id]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={reopen}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-800/70 bg-zinc-950/40 px-2.5 py-1.5 text-left transition-colors hover:border-zinc-700/80 hover:bg-zinc-900/50 ${className}`}
        aria-expanded={false}
        aria-label={`Open ${title}`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-[9px] font-black uppercase tracking-[0.14em] text-zinc-500">{title}</span>
          {badge ? <span className="shrink-0">{badge}</span> : null}
          {summary ? <span className="min-w-0 truncate text-[10px] font-medium text-zinc-400">{summary}</span> : null}
        </span>
        <span className="shrink-0 text-[10px] font-bold text-zinc-500">Show</span>
      </button>
    );
  }

  return (
    <div className={`rounded-xl border border-zinc-800/70 bg-black/20 ${className}`}>
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800/60 px-2.5 py-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-[9px] font-black uppercase tracking-[0.14em] text-zinc-400">{title}</span>
          {badge}
          {summary ? <span className="min-w-0 truncate text-[10px] text-zinc-500">{summary}</span> : null}
        </div>
        <button
          type="button"
          onClick={close}
          className="shrink-0 rounded-md border border-zinc-700/60 bg-zinc-900/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-zinc-400 hover:border-zinc-600/70 hover:text-zinc-200"
          aria-label={`Close ${title}`}
        >
          Close
        </button>
      </div>
      <div className={bodyClassName}>{children}</div>
    </div>
  );
}
