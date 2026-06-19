import { type ReactElement, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  formatBracketCentsFromRaw,
  sanitizeBracketCentsDraft,
  shouldCommitBracketCentsOnBlur,
} from './bracketCentsInput';
import {
  bracketAuxFromCents,
  bracketCentsFromAltModeDraft,
  bracketConversionFromInput,
  bracketRefLabel,
  bracketSizingKey,
  bracketTriggerFromTotalUsdDraft,
  centsStrFromTarget01,
  resolveBracketRef,
  sanitizeUsdBracketDraft,
  target01FromBracketInput,
  usdModeUsesTotal,
  type BracketInputMode,
  type BracketLegKind,
} from './lib/bracketLevelInput';

export type BracketTriggerDraftState = { draft: string; mode: BracketInputMode };

export type BracketTriggerInputProps = {
  kind: BracketLegKind;
  centsValue: string;
  onCentsChange: (cents: string) => void;
  avgEntry01: number | null;
  /** Buy limit price (¢ field) when not filled yet — anchors $/share gain/loss. */
  plannedEntry01?: number | null;
  mid01: number | null;
  /** Shares on the order or position — enables total-$ TP/SL (e.g. $50 on a $1000 buy). */
  orderShares?: number | null;
  /** When sizing in $ on the buy form, show this notional instead of shares × ref. */
  orderNotionalUsd?: number | null;
  placeholderCents?: string;
  onAfterChange?: () => void;
  /** Tighter layout for buy-panel stacking — compact gain/loss readout instead of full equivalent table. */
  compact?: boolean;
  /** Signal/spread suggested trigger (¢) — shown with projected gain/loss when input empty. */
  suggestedCents?: string;
  onApplySuggested?: () => void;
  /** Live draft while editing — parent can flush to committed state on Buy. */
  onDraftSync?: (state: BracketTriggerDraftState) => void;
};

const MODE_OPTIONS_BASE: { value: BracketInputMode; label: string; short: string; hintPerShare: string; hintTotal: string }[] = [
  { value: 'cents', label: 'Cents', short: '¢', hintPerShare: 'Trigger price in probability cents', hintTotal: 'Trigger price in probability cents' },
  { value: 'pct', label: 'Percent', short: '%', hintPerShare: 'Move vs your entry price', hintTotal: 'Move vs your entry price' },
  { value: 'usd', label: 'USD / sh', short: '$', hintPerShare: 'Gain or loss per share vs your entry', hintTotal: 'Total gain or loss on your order' },
];

export function BracketTriggerInput(props: BracketTriggerInputProps): ReactElement {
  const {
    kind,
    centsValue,
    onCentsChange,
    avgEntry01,
    plannedEntry01,
    mid01,
    orderShares,
    orderNotionalUsd,
    placeholderCents,
    onAfterChange,
    compact = false,
    suggestedCents,
    onApplySuggested,
    onDraftSync,
  } = props;

  const [mode, setMode] = useState<BracketInputMode>('cents');
  const [draft, setDraft] = useState(centsValue);
  const [editing, setEditing] = useState(false);
  const id = useId();
  const enterCommitRef = useRef(false);
  const skipBlurCommitRef = useRef(false);
  const prevSizingKeyRef = useRef('');
  const sizingEffectReadyRef = useRef(false);
  /** Ref mirror — onChange must not read stale `mode` from a pre-switch render closure. */
  const modeRef = useRef<BracketInputMode>('cents');
  modeRef.current = mode;

  const { ref01, source: refSource } = useMemo(
    () => resolveBracketRef({ avgEntry01, plannedEntry01, mid01 }),
    [avgEntry01, mid01, plannedEntry01],
  );
  const sizingKey = bracketSizingKey(ref01, orderShares);
  const refSuffix = bracketRefLabel(refSource);
  const usdIsTotal = usdModeUsesTotal(orderShares);

  const modeOptions = useMemo(
    () =>
      MODE_OPTIONS_BASE.map((opt) => ({
        ...opt,
        label: opt.value === 'usd' && usdIsTotal ? 'Total $' : opt.label,
        hint: usdIsTotal ? opt.hintTotal : opt.hintPerShare,
      })),
    [usdIsTotal],
  );

  const orderNotional =
    orderNotionalUsd != null && orderNotionalUsd > 0
      ? orderNotionalUsd
      : usdIsTotal && orderShares != null && ref01 != null && orderShares > 0 && ref01 > 0
        ? orderShares * ref01
        : null;

  /** Sync from parent when not focused — ref/mid ticks must not wipe in-progress edits. */
  useEffect(() => {
    if (editing) return;
    if (mode === 'cents') {
      setDraft(centsValue);
      return;
    }
    if (ref01 == null) {
      setDraft('');
      return;
    }
    setDraft(
      bracketAuxFromCents({
        mode,
        centsStr: centsValue,
        kind,
        ref01,
        shares: orderShares,
      }),
    );
  }, [centsValue, editing, kind, mode, orderShares, ref01]);

  /** When buy size or entry ref changes, re-commit % / Total $ intent to a new trigger ¢. */
  useEffect(() => {
    if (!sizingEffectReadyRef.current) {
      sizingEffectReadyRef.current = true;
      prevSizingKeyRef.current = sizingKey;
      return;
    }
    const prev = prevSizingKeyRef.current;
    prevSizingKeyRef.current = sizingKey;
    if (editing || mode === 'cents' || ref01 == null) return;
    if (prev === sizingKey) return;
    const raw = draft.trim();
    if (!raw) return;
    const nextCents = bracketCentsFromAltModeDraft({
      mode,
      draft: raw,
      kind,
      ref01,
      shares: orderShares,
    });
    if (nextCents == null) return;
    const aux = bracketAuxFromCents({ mode, centsStr: nextCents, kind, ref01, shares: orderShares });
    if (aux) setDraft(aux);
    if (nextCents !== centsValue) onCentsChange(nextCents);
  }, [
    centsValue,
    draft,
    editing,
    kind,
    mode,
    onCentsChange,
    orderShares,
    ref01,
    sizingKey,
  ]);

  const syncDraftToParent = useCallback(
    (nextDraft: string, nextMode: BracketInputMode = modeRef.current) => {
      onDraftSync?.({ draft: nextDraft, mode: nextMode });
    },
    [onDraftSync],
  );

  const clearDraftToParent = useCallback(() => {
    onDraftSync?.({ draft: '', mode: 'cents' });
  }, [onDraftSync]);

  const commitCentsDraft = useCallback(
    (raw: string, viaEnter: boolean) => {
      const trimmed = raw.trim();
      if (!trimmed) {
        setDraft('');
        onCentsChange('');
        clearDraftToParent();
        onAfterChange?.();
        return;
      }
      if (ref01 != null && usdModeUsesTotal(orderShares)) {
        const usdCommit = bracketTriggerFromTotalUsdDraft({
          raw: trimmed,
          kind,
          ref01,
          shares: orderShares!,
        });
        if (usdCommit) {
          setMode('usd');
          setDraft(usdCommit.usdRaw);
          onCentsChange(usdCommit.centsStr);
          clearDraftToParent();
          onAfterChange?.();
          return;
        }
      }
      const formatted = formatBracketCentsFromRaw(trimmed);
      if (formatted == null) {
        setDraft(centsValue);
        return;
      }
      if (
        !shouldCommitBracketCentsOnBlur({
          draftRaw: trimmed,
          committedRaw: centsValue,
          pressedEnter: viaEnter,
        })
      ) {
        setDraft(centsValue);
        return;
      }
      setDraft(formatted);
      onCentsChange(formatted);
      clearDraftToParent();
      onAfterChange?.();
    },
    [centsValue, clearDraftToParent, kind, onAfterChange, onCentsChange, orderShares, ref01],
  );

  const applyFromDraft = useCallback(
    (raw: string, inputMode: BracketInputMode, viaEnter: boolean) => {
      if (inputMode === 'cents') {
        commitCentsDraft(raw, viaEnter);
        return;
      }
      if (ref01 == null) return;
      const trimmed = raw.trim();
      if (!trimmed) {
        setDraft('');
        onCentsChange('');
        clearDraftToParent();
        onAfterChange?.();
        return;
      }
      const target01 = target01FromBracketInput({ mode: inputMode, raw: trimmed, kind, ref01, shares: orderShares });
      if (target01 == null) return;
      const cents = centsStrFromTarget01(target01);
      const aux = bracketAuxFromCents({ mode: inputMode, centsStr: cents, kind, ref01, shares: orderShares });
      setDraft(aux || trimmed);
      onCentsChange(cents);
      clearDraftToParent();
      onAfterChange?.();
    },
    [clearDraftToParent, commitCentsDraft, kind, onAfterChange, onCentsChange, orderShares, ref01],
  );

  const finishEditing = useCallback(
    (viaEnter: boolean) => {
      if (mode === 'cents') {
        commitCentsDraft(draft, viaEnter);
      } else {
        applyFromDraft(draft, mode, viaEnter);
      }
      setEditing(false);
    },
    [applyFromDraft, commitCentsDraft, draft, mode],
  );

  const conversionInputRaw = mode === 'cents' && !editing ? centsValue : draft;

  const conversion = useMemo(
    () => bracketConversionFromInput({ mode, raw: conversionInputRaw, kind, ref01, shares: orderShares }),
    [conversionInputRaw, kind, mode, orderShares, ref01],
  );

  const triggerMisaligned =
    conversion.target01 != null &&
    ref01 != null &&
    (kind === 'sl' ? conversion.target01 >= ref01 - 1e-6 : conversion.target01 <= ref01 + 1e-6);

  const suggestedPreview = useMemo(() => {
    const sug = suggestedCents?.trim();
    if (!sug || centsValue.trim() || ref01 == null) return null;
    return bracketConversionFromInput({ mode: 'cents', raw: sug, kind, ref01, shares: orderShares });
  }, [centsValue, kind, orderShares, ref01, suggestedCents]);

  const showCompactConversions =
    compact &&
    ref01 != null &&
    conversion.target01 != null &&
    (centsValue.trim() || draft.trim() || conversionInputRaw.trim());
  const gainLossLabel = kind === 'sl' ? 'Loss' : 'Gain';

  const compactConversionRows = useMemo(() => {
    const rows: { key: string; short: string; value: string; active: boolean }[] = [];
    if (conversion.centsLabel !== '—' && conversion.centsLabel !== '…') {
      rows.push({ key: 'cents', short: 'Trigger', value: conversion.centsLabel, active: mode === 'cents' });
    }
    if (conversion.pctLabel !== '—' && conversion.pctLabel !== '…') {
      rows.push({ key: 'pct', short: 'Move', value: conversion.pctLabel, active: mode === 'pct' });
    }
    if (conversion.usdLabel !== '—' && conversion.usdLabel !== '…') {
      rows.push({
        key: 'usd',
        short: conversion.usdUsesTotal ? gainLossLabel : '$/sh',
        value: conversion.usdLabel,
        active: mode === 'usd',
      });
    }
    return rows;
  }, [
    conversion.centsLabel,
    conversion.pctLabel,
    conversion.usdLabel,
    conversion.usdUsesTotal,
    gainLossLabel,
    mode,
  ]);

  const title = kind === 'sl' ? 'Stop trigger' : 'Take-profit trigger';
  const border =
    kind === 'sl' ? 'border-rose-900/40 bg-rose-950/15' : 'border-emerald-900/40 bg-emerald-950/15';
  const labelTone = kind === 'sl' ? 'text-rose-200' : 'text-emerald-200';
  const inputTone = kind === 'sl' ? 'text-rose-50' : 'text-emerald-50';
  const activeRing = kind === 'sl' ? 'ring-rose-400/35 border-rose-700/45' : 'ring-emerald-400/35 border-emerald-700/45';
  const activeBg = kind === 'sl' ? 'bg-rose-950/25' : 'bg-emerald-950/25';

  const activeMode = modeOptions.find((m) => m.value === mode)!;

  const inputPlaceholder =
    mode === 'cents'
      ? placeholderCents ?? (kind === 'sl' ? '42' : '58')
      : mode === 'pct'
        ? kind === 'sl'
          ? '5'
          : '8'
        : usdIsTotal
          ? '50'
          : '0.04';

  const conversionRows: { key: BracketInputMode; label: string; detail: string; value: string }[] = [
    { key: 'cents', label: 'Trigger (¢)', detail: 'Limit sell price', value: conversion.centsLabel },
    {
      key: 'pct',
      label: 'Move (%)',
      detail: kind === 'sl' ? 'Below entry' : 'Above entry',
      value: conversion.pctLabel,
    },
    {
      key: 'usd',
      label: usdIsTotal ? 'Total ($)' : 'Per share ($)',
      detail:
        conversion.usdDetail ??
        (kind === 'sl' ? (usdIsTotal ? 'Max loss on order' : 'Loss vs entry') : usdIsTotal ? 'Profit on order' : 'Gain vs entry'),
      value: conversion.usdLabel,
    },
  ];

  const switchMode = (next: BracketInputMode) => {
    if (next !== 'cents' && ref01 == null) return;
    if (editing) finishEditing(true);
    let nextDraft = centsValue;
    if (next === 'cents') {
      setDraft(centsValue);
    } else if (ref01 != null) {
      nextDraft = bracketAuxFromCents({ mode: next, centsStr: centsValue, kind, ref01, shares: orderShares });
      setDraft(nextDraft);
    }
    modeRef.current = next;
    setMode(next);
    syncDraftToParent(nextDraft, next);
  };

  return (
    <div
      className={`min-w-0 border ${compact ? 'rounded-lg px-2 py-1.5' : 'rounded-xl px-3 py-3 sm:px-3.5 sm:py-3.5'} ${border}`}
    >
      <div className={`flex flex-wrap items-center justify-between gap-1.5 ${compact ? 'gap-1' : 'gap-2'}`}>
        <div className={`font-bold uppercase tracking-wide ${labelTone} ${compact ? 'text-[9px]' : 'text-[11px]'}`}>
          {title}
        </div>
        {!compact ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {ref01 != null ? (
              <div className="shrink-0 rounded-lg border border-zinc-800/60 bg-black/25 px-2 py-1 text-right font-mono text-[11px] tabular-nums text-zinc-300">
                Ref {(ref01 * 100).toFixed(1)}¢
                <span className="ml-1 text-[10px] font-sans text-zinc-500">· {refSuffix}</span>
              </div>
            ) : null}
            {orderNotional != null ? (
              <div className="shrink-0 rounded-lg border border-zinc-800/60 bg-black/25 px-2 py-1 text-right font-mono text-[11px] tabular-nums text-zinc-300">
                ~{Math.round(orderShares!).toLocaleString()} sh
                <span className="ml-1 text-[10px] font-sans text-zinc-500">· ${orderNotional.toFixed(0)}</span>
              </div>
            ) : null}
          </div>
        ) : ref01 != null ? (
          <span className="font-mono text-[9px] tabular-nums text-zinc-500">
            ref {(ref01 * 100).toFixed(1)}¢
            {orderNotional != null && orderShares != null ? (
              <>
                {' '}
                · ~{Math.round(orderShares).toLocaleString()} sh · ${orderNotional.toFixed(0)} notional
              </>
            ) : null}
          </span>
        ) : null}
      </div>

      <div
        className={`grid grid-cols-3 gap-0.5 rounded-md border border-zinc-800/55 bg-black/30 p-0.5 ${compact ? 'mt-1.5' : 'mt-2.5 gap-1 rounded-lg p-1'}`}
      >
        {modeOptions.map((opt) => {
          const active = mode === opt.value;
          const disabled = opt.value !== 'cents' && ref01 == null;
          return (
            <button
              key={opt.value}
              type="button"
              disabled={disabled}
              title={opt.hint}
              onClick={() => switchMode(opt.value)}
              className={`rounded px-0.5 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                compact ? 'min-h-[26px] py-0.5' : 'min-h-[36px] rounded-md px-1 py-1.5'
              } ${
                active
                  ? `${activeBg} font-bold ${inputTone} ring-1 ring-inset ${activeRing}`
                  : 'text-zinc-400 hover:bg-zinc-900/50 hover:text-zinc-200'
              }`}
            >
              <div className={`font-bold leading-tight ${compact ? 'text-[9px]' : 'text-[11px]'}`}>{opt.label}</div>
              {!compact ? <div className="mt-0.5 font-mono text-[10px] leading-none opacity-80">{opt.short}</div> : null}
            </button>
          );
        })}
      </div>

      <label htmlFor={id} className={compact ? 'mt-1.5 block' : 'mt-2.5 block'}>
        {!compact ? <div className="text-[10px] font-semibold text-zinc-400">{activeMode.hint}</div> : null}
        <div
          className={`flex items-center overflow-hidden rounded-lg border border-zinc-800/60 bg-black/35 ring-1 ring-white/[0.03] ${
            compact ? 'mt-0 min-h-[34px] px-2' : 'mt-1.5 min-h-[48px] rounded-xl px-3'
          }`}
        >
          {mode === 'cents' ? (
            <span className={`mr-1 shrink-0 font-mono font-bold text-zinc-500 ${compact ? 'text-sm' : 'text-lg'}`}>¢</span>
          ) : mode === 'pct' ? (
            <span className={`mr-1 shrink-0 font-mono font-bold text-zinc-500 ${compact ? 'text-sm' : 'text-lg'}`}>%</span>
          ) : (
            <span className={`mr-1 shrink-0 font-mono font-bold text-zinc-500 ${compact ? 'text-sm' : 'text-lg'}`}>$</span>
          )}
          <input
            id={id}
            value={draft}
            onFocus={() => {
              setEditing(true);
              enterCommitRef.current = false;
            }}
            onChange={(e) => {
              setEditing(true);
              const v =
                mode === 'cents'
                  ? sanitizeBracketCentsDraft(e.target.value)
                  : sanitizeUsdBracketDraft(e.target.value, usdIsTotal);
              setDraft(v);
              syncDraftToParent(v, modeRef.current);
            }}
            onBlur={() => {
              if (skipBlurCommitRef.current) {
                skipBlurCommitRef.current = false;
                return;
              }
              const viaEnter = enterCommitRef.current;
              enterCommitRef.current = false;
              finishEditing(viaEnter);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                enterCommitRef.current = true;
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                skipBlurCommitRef.current = true;
                finishEditing(true);
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDraft(
                  mode === 'cents'
                    ? centsValue
                    : ref01 != null
                      ? bracketAuxFromCents({ mode, centsStr: centsValue, kind, ref01, shares: orderShares })
                      : '',
                );
                setEditing(false);
                (e.target as HTMLInputElement).blur();
              }
            }}
            inputMode={mode === 'usd' && usdIsTotal ? 'decimal' : 'decimal'}
            placeholder={inputPlaceholder}
            aria-label={`${title} — ${activeMode.label}`}
            className={`min-w-0 flex-1 bg-transparent font-mono font-bold tabular-nums outline-none ${inputTone} ${
              compact ? 'text-base' : 'text-xl sm:text-2xl'
            }`}
          />
        </div>
      </label>

      {compact && suggestedCents?.trim() ? (
        <div className="mt-1 min-h-[1.75rem]">
          {suggestedPreview && !centsValue.trim() ? (
            <div
              className={`flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded border px-1.5 py-1 ${
                kind === 'sl' ? 'border-rose-800/25 bg-rose-950/10' : 'border-emerald-800/25 bg-emerald-950/10'
              }`}
            >
              <span className={`text-[9px] leading-snug ${kind === 'sl' ? 'text-rose-300/85' : 'text-emerald-300/85'}`}>
                Suggested{' '}
                <span className={`font-mono font-bold ${inputTone}`}>{suggestedCents.trim()}¢</span>
                {suggestedPreview.pctLabel !== '—' || suggestedPreview.usdLabel !== '—' ? (
                  <>
                    <span className="text-zinc-600"> · </span>
                    <span className="text-zinc-500">{gainLossLabel}</span>{' '}
                    <span className={`font-mono font-bold ${inputTone}`}>{suggestedPreview.pctLabel}</span>
                    {suggestedPreview.usdLabel !== '—' ? (
                      <>
                        <span className="text-zinc-600"> · </span>
                        <span className={`font-mono font-bold ${inputTone}`}>{suggestedPreview.usdLabel}</span>
                      </>
                    ) : null}
                  </>
                ) : null}
              </span>
              {onApplySuggested ? (
                <button
                  type="button"
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-bold ${
                    kind === 'sl'
                      ? 'border-rose-700/40 bg-rose-950/30 text-rose-100 hover:bg-rose-900/40'
                      : 'border-emerald-700/40 bg-emerald-950/30 text-emerald-100 hover:bg-emerald-900/40'
                  }`}
                  onClick={onApplySuggested}
                >
                  Use
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {compact && triggerMisaligned ? (
        <p className="mt-1 text-[9px] leading-snug text-amber-200/90">
          {kind === 'sl'
            ? 'Stop is at or above entry — use a lower ¢ trigger for a long backup stop.'
            : 'Take-profit is at or below entry — use a higher ¢ trigger.'}
        </p>
      ) : null}

      {compact && ref01 != null ? (
        <div className="mt-1 min-h-[2.375rem]">
          {showCompactConversions && compactConversionRows.length > 0 ? (
            <div className="flex gap-1">
              {compactConversionRows.map((row) => (
                <div
                  key={row.key}
                  className={`min-w-0 flex-1 rounded border px-1 py-0.5 text-center ${
                    row.active
                      ? `${activeBg} ring-1 ring-inset ${activeRing}`
                      : 'border-zinc-800/50 bg-black/25'
                  }`}
                >
                  <div className="truncate text-[8px] font-semibold uppercase tracking-wide text-zinc-500">
                    {row.short}
                  </div>
                  <div
                    className={`truncate font-mono text-[10px] font-bold tabular-nums ${
                      row.active ? inputTone : 'text-zinc-300'
                    }`}
                  >
                    {row.value}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {!compact ? (
        <div className="mt-3 space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">Equivalent levels</div>
          {conversionRows.map((row) => {
            const active = mode === row.key;
            return (
              <div
                key={row.key}
                className={`flex min-h-[44px] items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
                  active
                    ? `${activeBg} ${activeRing} ring-1 ring-inset`
                    : 'border-zinc-800/50 bg-zinc-950/40'
                }`}
              >
                <div className="min-w-0">
                  <div className={`text-[11px] font-bold ${active ? inputTone : 'text-zinc-300'}`}>{row.label}</div>
                  <div className="truncate text-[10px] text-zinc-500">{row.detail}</div>
                </div>
                <div
                  className={`shrink-0 text-right font-mono text-base font-black tabular-nums sm:text-lg ${
                    active ? inputTone : 'text-zinc-200'
                  }`}
                >
                  {row.value}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {!compact && ref01 == null && mode !== 'cents' ? (
        <p className="mt-2 text-[11px] leading-snug text-amber-200/90">
          Set a buy price and amount, or load a fill, to edit in percent or total $ — use <span className="font-semibold">Cents</span> meanwhile.
        </p>
      ) : null}
      {!compact && ref01 != null && !usdIsTotal && mode === 'usd' ? (
        <p className="mt-2 text-[11px] leading-snug text-amber-200/90">
          Enter buy size (or hold a position) to unlock <span className="font-semibold">Total $</span> — values here are $/share (e.g. 0.05), not whole dollars.
        </p>
      ) : null}
      {!compact && usdIsTotal && mode === 'usd' ? (
        <p className="mt-2 text-[10px] leading-snug text-zinc-500">
          Type whole dollars (e.g. <span className="font-mono text-zinc-300">50</span> = ${kind === 'sl' ? 'max loss' : 'profit'} on this order). Press Enter or tap away to apply.
        </p>
      ) : null}
    </div>
  );
}
