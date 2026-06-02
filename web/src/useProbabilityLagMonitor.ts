import { useEffect, useMemo, useRef, useState } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import {
  appendPlmSample,
  buildPlmSampleInput,
  computePlmLiveStats,
  detectPlmRepricingEvents,
  plmEdgeSeries,
  plmProbSeries,
  type PlmRepricingEvent,
  type PlmSample,
} from './probabilityLagMonitor';

const SAMPLE_INTERVAL_MS = 1000;

export function useProbabilityLagMonitor(params: {
  slug: string;
  spot: SpotPoint[];
  priceToBeat: number | null;
  pMktUp: number | null;
  slopeUsdPerSec?: number | null;
  bandUsd?: number | null;
  enabled?: boolean;
}): {
  samples: PlmSample[];
  events: PlmRepricingEvent[];
  stats: ReturnType<typeof computePlmLiveStats>;
  edgeSeries: ReturnType<typeof plmEdgeSeries>;
  probSeries: ReturnType<typeof plmProbSeries>;
} {
  const { slug, spot, priceToBeat, pMktUp, slopeUsdPerSec, bandUsd, enabled = true } = params;
  const [samples, setSamples] = useState<PlmSample[]>([]);
  const slugRef = useRef(slug);
  const lastSampleAtRef = useRef(0);

  useEffect(() => {
    if (slugRef.current !== slug) {
      slugRef.current = slug;
      setSamples([]);
      lastSampleAtRef.current = 0;
    }
  }, [slug]);

  const spotLast = spot.length ? spot[spot.length - 1]!.v : null;

  useEffect(() => {
    if (!enabled || priceToBeat == null || spotLast == null || pMktUp == null) return;

    const tick = () => {
      const now = Date.now();
      if (now - lastSampleAtRef.current < SAMPLE_INTERVAL_MS) return;
      lastSampleAtRef.current = now;

      const sample = buildPlmSampleInput({
        now: spotLast,
        ptb: priceToBeat,
        spotPts: spot,
        pMkt: pMktUp,
        slopeUsdPerSec,
        bandUsd,
        atMs: now,
      });
      if (!sample) return;
      setSamples((prev) => appendPlmSample(prev, sample));
    };

    tick();
    const id = window.setInterval(tick, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, priceToBeat, spotLast, pMktUp, spot, slopeUsdPerSec, bandUsd]);

  const events = useMemo(() => detectPlmRepricingEvents(samples), [samples]);
  const stats = useMemo(() => computePlmLiveStats(samples, events), [samples, events]);
  const edgeSeries = useMemo(() => plmEdgeSeries(samples), [samples]);
  const probSeries = useMemo(() => plmProbSeries(samples), [samples]);

  return { samples, events, stats, edgeSeries, probSeries };
}
