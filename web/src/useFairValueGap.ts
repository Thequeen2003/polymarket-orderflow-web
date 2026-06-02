import { useEffect, useMemo, useRef, useState } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import {
  appendFairValueGapSample,
  buildFairValueGapSampleInput,
  computeFairValueGap,
  type FairValueGapReadout,
  type FairValueGapSample,
} from './fairValueGap';

const SAMPLE_INTERVAL_MS = 1000;

export function useFairValueGap(params: {
  slug: string;
  spot: SpotPoint[];
  priceToBeat: number | null;
  pMktUp: number | null;
  probUp01?: number | null;
  probDown01?: number | null;
  enabled?: boolean;
}): {
  samples: FairValueGapSample[];
  readout: FairValueGapReadout | null;
} {
  const { slug, spot, priceToBeat, pMktUp, probUp01, probDown01, enabled = true } = params;
  const [samples, setSamples] = useState<FairValueGapSample[]>([]);
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

      const sample = buildFairValueGapSampleInput({
        now: spotLast,
        ptb: priceToBeat,
        spotPts: spot,
        pMkt: pMktUp,
        probUp01,
        probDown01,
        atMs: now,
      });
      if (!sample) return;
      setSamples((prev) => appendFairValueGapSample(prev, sample));
    };

    tick();
    const id = window.setInterval(tick, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, priceToBeat, spotLast, pMktUp, spot, probUp01, probDown01]);

  const readout = useMemo(() => {
    if (pMktUp == null || samples.length === 0) return null;
    const last = samples[samples.length - 1]!;
    return computeFairValueGap({
      pExpected: last.pExpected,
      pActual: last.pActual,
      samples,
    });
  }, [pMktUp, samples]);

  return { samples, readout };
}
