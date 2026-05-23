import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  formatBracketCentsFromRaw,
  sanitizeBracketCentsDraft,
  shouldCommitBracketCentsOnBlur,
} from './bracketCentsInput';

export type BracketCentsFieldHandle = {
  /** Apply a valid pending draft (or current value) — e.g. before enabling SL/TP. */
  commitPending: () => void;
};

export type BracketCentsFieldProps = {
  value: string;
  onCommit: (formatted: string) => void;
  onPendingChange?: (raw: string) => void;
  /** True while the input is focused / drafting (parent can pin the Brackets tab). */
  onEditingChange?: (editing: boolean) => void;
  label?: ReactNode;
  footer?: ReactNode;
  placeholder?: string;
  variant?: 'stop' | 'take' | 'neutral';
  className?: string;
  labelClassName?: string;
  inputClassName?: string;
  hintClassName?: string;
};

const VARIANT_LABEL: Record<NonNullable<BracketCentsFieldProps['variant']>, string> = {
  stop: 'text-rose-200/80',
  take: 'text-emerald-200/80',
  neutral: 'text-zinc-500',
};

const VARIANT_INPUT: Record<NonNullable<BracketCentsFieldProps['variant']>, string> = {
  stop: 'text-rose-50',
  take: 'text-emerald-50',
  neutral: 'text-zinc-100',
};

export const BracketCentsField = forwardRef<BracketCentsFieldHandle, BracketCentsFieldProps>(
  function BracketCentsField(props, ref): ReactElement {
    const {
      value,
      onCommit,
      onPendingChange,
      onEditingChange,
      label,
      footer,
      placeholder,
      variant = 'neutral',
      className,
      labelClassName,
      inputClassName,
      hintClassName,
    } = props;
    const [draft, setDraft] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const enterRef = useRef(false);

    useEffect(() => {
      if (!editing) setDraft(null);
    }, [value, editing]);

    const display = draft ?? value;

    useEffect(() => {
      onPendingChange?.(editing && draft != null ? draft : value);
    }, [draft, editing, onPendingChange, value]);

    const setEditingState = useCallback(
      (next: boolean) => {
        setEditing(next);
        onEditingChange?.(next);
      },
      [onEditingChange],
    );

    const tryCommit = useCallback(
      (raw: string, viaEnter: boolean) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          setDraft(null);
          setEditingState(false);
          onCommit('');
          return;
        }
        const formatted = formatBracketCentsFromRaw(trimmed);
        if (formatted == null) {
          setDraft(null);
          setEditingState(false);
          return;
        }
        if (
          !shouldCommitBracketCentsOnBlur({
            draftRaw: trimmed,
            committedRaw: value,
            pressedEnter: viaEnter,
          })
        ) {
          setDraft(null);
          setEditingState(false);
          return;
        }
        setDraft(null);
        setEditingState(false);
        onCommit(formatted);
      },
      [onCommit, setEditingState, value],
    );

    useImperativeHandle(
      ref,
      () => ({
        commitPending: () => tryCommit(draft ?? value, true),
      }),
      [draft, tryCommit, value],
    );

    return (
      <label className={className ?? 'block'}>
        {label != null ? (
          <div className={labelClassName ?? `text-[10px] font-semibold uppercase tracking-wide ${VARIANT_LABEL[variant]}`}>
            {label}
          </div>
        ) : null}
        <input
          value={display}
          onFocus={() => {
            setEditingState(true);
            setDraft(value);
            enterRef.current = false;
          }}
          onChange={(e) => {
            setEditingState(true);
            setDraft(sanitizeBracketCentsDraft(e.target.value));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              enterRef.current = true;
              tryCommit(draft ?? value, true);
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(null);
              setEditingState(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
          onBlur={() => {
            const viaEnter = enterRef.current;
            enterRef.current = false;
            tryCommit(draft ?? value, viaEnter);
          }}
          inputMode="decimal"
          placeholder={placeholder}
          className={
            inputClassName ??
            `mt-1 min-h-[40px] w-full bg-transparent text-right font-mono text-lg font-black tabular-nums outline-none ${VARIANT_INPUT[variant]}`
          }
        />
        {editing ? (
          <div className={hintClassName ?? 'mt-1 text-right text-[9px] font-semibold text-zinc-500'}>
            Enter to apply · Esc to cancel
          </div>
        ) : null}
        {footer}
      </label>
    );
  },
);
