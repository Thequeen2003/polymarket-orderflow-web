import { useEffect, useRef, type ReactElement } from 'react';
import { usePredictionClockMs } from './predictionClock';
import {
  formatCountdownSec,
  formatHorizonLabel,
  formatHorizonTimeFrame,
  formatProjectionClockTime,
} from './pricePredictionSignal';

function useAnchoredHorizonTarget(horizonSec: number, nowMs: number): number {
  const targetRef = useRef<number | null>(null);
  const horizonRef = useRef(horizonSec);

  useEffect(() => {
    if (horizonRef.current !== horizonSec) {
      horizonRef.current = horizonSec;
      targetRef.current = null;
    }
  }, [horizonSec]);

  if (horizonSec <= 0) return nowMs;

  if (targetRef.current == null) {
    targetRef.current = nowMs + horizonSec * 1000;
  } else if (nowMs >= targetRef.current) {
    targetRef.current = nowMs + horizonSec * 1000;
  }

  return targetRef.current;
}

export function PredictionHorizonTimer(props: {
  horizonSec: number;
  compact?: boolean;
}): ReactElement {
  const { horizonSec, compact = false } = props;
  const nowMs = usePredictionClockMs();
  const isNow = horizonSec <= 0;
  const targetMs = useAnchoredHorizonTarget(horizonSec, nowMs);
  const remainingSec = isNow ? 0 : Math.max(0, Math.ceil((targetMs - nowMs) / 1000));

  if (compact) {
    return (
      <span className="inline-flex flex-col rounded border border-indigo-700/45 bg-indigo-950/35 px-1.5 py-0.5 font-mono text-[9px] leading-tight tabular-nums">
        <span className="font-bold uppercase tracking-wide text-indigo-300/90">
          {isNow ? 'Now' : formatHorizonLabel(horizonSec)}
        </span>
        <span className="font-semibold text-amber-200/95">
          {isNow ? formatProjectionClockTime(nowMs) : `IN ${formatCountdownSec(remainingSec)}`}
        </span>
      </span>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-indigo-600/45 bg-indigo-950/40 px-2 py-1.5 font-mono tabular-nums ring-1 ring-indigo-500/15">
      <div className="text-[8px] font-black uppercase tracking-[0.14em] text-indigo-300">{formatHorizonTimeFrame(horizonSec)}</div>
      {isNow ? (
        <div className="mt-1 text-[12px] font-bold text-zinc-50">{formatProjectionClockTime(nowMs)}</div>
      ) : (
        <>
          <div className="mt-1 text-[12px] font-black text-amber-200">IN {formatCountdownSec(remainingSec)}</div>
          <div className="mt-0.5 text-[10px] font-semibold text-indigo-200/90">@ {formatProjectionClockTime(targetMs)}</div>
          <div className="mt-0.5 text-[8px] text-zinc-500">{formatHorizonLabel(horizonSec)} window</div>
        </>
      )}
    </div>
  );
}
