import { useEffect, useMemo, useRef, useState } from 'react';
import type { SpotPoint } from './SpotLevelChart';
import {
  appendPlmSample,
  computePlmLiveStats,
  detectPlmRepricingEvents,
  plmEdgeSeries,
  plmProbSeries,
  type PlmSample,
} from './probabilityLagMonitor';
import { computeMomentumProjection, type ProjectionTick } from './momentumProjection';

const SAMPLE_INTERVAL_MS = 1000;

function modelProbFromMomentum(probPts: ProjectionTick[]): number | null {
  const proj = computeMomentumProjection({
    pts: probPts,
    horizons: [{ label: '30s', sec: 30 }],
  });
  if (!proj) return null;
  return proj.points[0]?.price01 ?? proj.now01;
}

export function useBookProbabilityLagMonitor(params: {
  slug: string;
  probUpPts: ProjectionTick[];
  pMktUp: number | null;
  enabled?: boolean;
}) {
  const { slug, probUpPts, pMktUp, enabled = true } = params;
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

  useEffect(() => {
    if (!enabled || pMktUp == null || probUpPts.length < 3) return;

    const tick = () => {
      const now = Date.now();
      if (now - lastSampleAtRef.current < SAMPLE_INTERVAL_MS) return;
      lastSampleAtRef.current = now;

      const pModel = modelProbFromMomentum(probUpPts);
      if (pModel == null) return;
      const pMkt = Math.max(0.01, Math.min(0.99, pMktUp));
      const sample: PlmSample = {
        t: now,
        pMkt,
        pModel: Math.max(0.01, Math.min(0.99, pModel)),
        edge: Math.max(0.01, Math.min(0.99, pModel)) - pMkt,
      };
      setSamples((prev) => appendPlmSample(prev, sample));
    };

    tick();
    const id = window.setInterval(tick, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [enabled, pMktUp, probUpPts]);

  const events = useMemo(() => detectPlmRepricingEvents(samples), [samples]);
  const stats = useMemo(() => computePlmLiveStats(samples, events), [samples, events]);

  return {
    samples,
    events,
    stats,
    edgeSeries: useMemo(() => plmEdgeSeries(samples), [samples]),
    probSeries: useMemo(() => plmProbSeries(samples), [samples]),
  };
}

export function probPointsFromSeries(probUp: SpotPoint[]): ProjectionTick[] {
  return probUp
    .filter((p) => p.v != null && Number.isFinite(p.v))
    .map((p) => ({ t: p.t, v: p.v! }));
}
