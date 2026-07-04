import type { ReactElement } from 'react';
import {
  buildSettlementBiasDualReadout,
  buildSettlementBiasWarning,
  type BinaryOutcomeEstimate,
  type SettlementBiasWarningLevel,
} from './binaryOutcomeBias';
import { SettlementBiasDualHero } from './SettlementBiasDualHero';
import { SettlementBiasModelCard } from './SettlementBiasModelCard';

function warningShell(level: SettlementBiasWarningLevel): string {
  if (level === 'watch') return 'border-amber-500/40 bg-amber-950/25';
  if (level === 'alert') return 'border-orange-500/45 bg-orange-950/30';
  if (level === 'critical') return 'border-rose-500/50 bg-rose-950/35 ring-1 ring-rose-500/30';
  return 'border-violet-800/40 bg-violet-950/20';
}

export function SettlementBiasPanelBody(props: {
  estimate: BinaryOutcomeEstimate;
  upLabel: string;
  downLabel: string;
  normMarketUp: number | null;
  probDeltaUp01?: number | null;
  probDeltaDown01?: number | null;
  compact?: boolean;
}): ReactElement {
  const { estimate, upLabel, downLabel, normMarketUp, probDeltaUp01, probDeltaDown01, compact = false } = props;
  const warning = buildSettlementBiasWarning({
    estimate,
    marketUp01: normMarketUp,
    upLabel,
    downLabel,
    probDeltaUp01,
    probDeltaDown01,
  });
  const dual = buildSettlementBiasDualReadout({
    estimate,
    upLabel,
    downLabel,
    probDeltaUp01,
    probDeltaDown01,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`shrink-0 border-b px-3 py-3 ${warningShell(warning.level)}`}>
        {warning.level !== 'none' ? (
          <div className="mb-2 flex items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-rose-400/60 bg-rose-600/25 text-lg font-black text-rose-100">
              ⚠
            </span>
            <div className="min-w-0 text-[11px] font-bold uppercase leading-snug text-rose-50">{warning.headline}</div>
          </div>
        ) : null}
        <SettlementBiasDualHero dual={dual} edgePp={warning.edgePp} />
        {warning.level !== 'none' ? (
          <p className="mt-2 text-[9px] font-medium leading-snug text-zinc-300/95">{warning.action}</p>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 sm:px-3">
        <SettlementBiasModelCard
          estimate={estimate}
          upLabel={upLabel}
          downLabel={downLabel}
          normMarketUp={normMarketUp}
          dual={dual}
          embedded
          compactSignals={compact}
        />
      </div>
    </div>
  );
}
