import { useEffect, useMemo, useRef } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import type { SpotBandGaugeSnapshot } from './spotBandDeskAction';
import { estimateBinaryOutcomeBias } from './binaryOutcomeBias';
import { recentProbDelta01 } from './contractLag';
import { useSettlementBiasDeskOptional } from './SettlementBiasDeskContext';

function normalizeBinaryFlexible(
  up01: number | null,
  down01: number | null,
): { up: number | null; down: number | null } {
  const uOk = up01 != null && Number.isFinite(up01);
  const dOk = down01 != null && Number.isFinite(down01);
  if (!uOk && !dOk) return { up: null, down: null };
  if (uOk && !dOk) {
    const u = Math.max(0, Math.min(1, up01!));
    return { up: u, down: 1 - u };
  }
  if (!uOk && dOk) {
    const d = Math.max(0, Math.min(1, down01!));
    return { up: 1 - d, down: d };
  }
  const s = up01! + down01!;
  if (!Number.isFinite(s) || s <= 1e-9) return { up: null, down: null };
  const u = Math.max(0, Math.min(1, up01! / s));
  return { up: u, down: 1 - u };
}

/** Keeps the Settle hang dock fed whenever the PTB signals desk is mounted — not only on the Now Price tab. */
export function useSettlementBiasFeed(args: {
  slug: string | null;
  enabled: boolean;
  spot: SpotPoint[];
  priceToBeat: number | null;
  probUp: SpotPoint[];
  probDown: SpotPoint[];
  upLabel: string;
  downLabel: string;
  bandGauge?: SpotBandGaugeSnapshot | null;
  ptbContext?: { bandUsd: number; slopeUsdPerSec?: number; slopeUsdPerMin?: number } | null;
}): void {
  const publish = useSettlementBiasDeskOptional()?.publish;
  const prevSlugRef = useRef<string | null>(null);

  const spotLast = args.spot.length ? args.spot[args.spot.length - 1]!.v : null;
  const lastProbUp = args.probUp.length ? (args.probUp[args.probUp.length - 1]!.v ?? null) : null;
  const lastProbDown = args.probDown.length ? (args.probDown[args.probDown.length - 1]!.v ?? null) : null;

  const bandUsd =
    args.bandGauge != null
      ? (args.bandGauge.bandHi - args.bandGauge.bandLo) / 2
      : args.ptbContext?.bandUsd ?? null;

  const slopeUsdPerMin =
    args.ptbContext?.slopeUsdPerMin ??
    (args.bandGauge?.slopeUsdPerMin != null && Number.isFinite(args.bandGauge.slopeUsdPerMin)
      ? args.bandGauge.slopeUsdPerMin
      : null);
  const slopeUsdPerSec =
    args.ptbContext?.slopeUsdPerSec ??
    (slopeUsdPerMin != null && Number.isFinite(slopeUsdPerMin) ? slopeUsdPerMin / 60 : 0);

  const normLive = useMemo(
    () => normalizeBinaryFlexible(lastProbUp, lastProbDown),
    [lastProbUp, lastProbDown],
  );

  const probTicksUp = useMemo(
    () =>
      args.probUp
        .filter((p) => p.v != null && Number.isFinite(p.v))
        .map((p) => ({ t: p.t, v: p.v! })),
    [args.probUp],
  );
  const probTicksDown = useMemo(
    () =>
      args.probDown
        .filter((p) => p.v != null && Number.isFinite(p.v))
        .map((p) => ({ t: p.t, v: p.v! })),
    [args.probDown],
  );

  const recentDeltaUp01 = useMemo(() => recentProbDelta01(probTicksUp, 30_000), [probTicksUp]);
  const recentDeltaDown01 = useMemo(() => recentProbDelta01(probTicksDown, 30_000), [probTicksDown]);

  const binaryBias = useMemo(() => {
    if (!args.enabled || spotLast == null || args.priceToBeat == null) return null;
    return estimateBinaryOutcomeBias({
      now: spotLast,
      ptb: args.priceToBeat,
      spotPts: args.spot,
      pUp01: normLive.up ?? lastProbUp,
      slopeUsdPerSec,
      bandUsd,
      horizonSec: 30,
    });
  }, [args.enabled, args.priceToBeat, args.spot, spotLast, normLive.up, lastProbUp, slopeUsdPerSec, bandUsd]);

  const pMktUp = normLive.up ?? lastProbUp;

  useEffect(() => {
    if (!publish) return;

    const slugKey = (args.slug ?? '').trim();
    if (prevSlugRef.current != null && prevSlugRef.current !== slugKey) {
      publish(null);
    }
    prevSlugRef.current = slugKey || null;

    if (!args.enabled || binaryBias == null) {
      publish(null);
      return;
    }

    publish({
      estimate: binaryBias,
      upLabel: args.upLabel,
      downLabel: args.downLabel,
      normMarketUp: pMktUp,
      probDeltaUp01: recentDeltaUp01,
      probDeltaDown01: recentDeltaDown01,
    });
  }, [
    publish,
    args.enabled,
    args.slug,
    args.upLabel,
    args.downLabel,
    binaryBias,
    pMktUp,
    recentDeltaUp01,
    recentDeltaDown01,
  ]);

  useEffect(() => {
    if (!publish) return;
    return () => publish(null);
  }, [publish]);
}
