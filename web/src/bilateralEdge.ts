/**
 * Per-side model − market edge (UP and DOWN computed independently).
 * Avoids inferring DOWN edge as −edgeUp when the book has overround or split mids.
 */

export type BilateralEdgeSnapshot = {
  modelPUp: number | null;
  modelPDown: number | null;
  pMktUp: number | null;
  pMktDown: number | null;
  edgeUpPp: number | null;
  edgeDownPp: number | null;
};

export function computeBilateralEdge(params: {
  modelPUp: number | null;
  pMktUp: number | null;
  pMktDown?: number | null;
  modelPDown?: number | null;
}): BilateralEdgeSnapshot {
  const modelPUp = params.modelPUp;
  const pMktUp = params.pMktUp;
  const pMktDown =
    params.pMktDown != null && Number.isFinite(params.pMktDown)
      ? params.pMktDown
      : pMktUp != null && Number.isFinite(pMktUp)
        ? 1 - pMktUp
        : null;
  const modelPDown =
    params.modelPDown != null && Number.isFinite(params.modelPDown)
      ? params.modelPDown
      : modelPUp != null && Number.isFinite(modelPUp)
        ? 1 - modelPUp
        : null;

  const edgeUpPp =
    modelPUp != null && pMktUp != null && Number.isFinite(modelPUp) && Number.isFinite(pMktUp)
      ? (modelPUp - pMktUp) * 100
      : null;
  const edgeDownPp =
    modelPDown != null && pMktDown != null && Number.isFinite(modelPDown) && Number.isFinite(pMktDown)
      ? (modelPDown - pMktDown) * 100
      : null;

  return { modelPUp, modelPDown, pMktUp, pMktDown, edgeUpPp, edgeDownPp };
}

/** Pick the side with stronger edge when pass counts tie (for diagnostics / spike lane). */
export function pickStrongerEdgeSide(
  edgeUpPp: number | null,
  edgeDownPp: number | null,
): 'up' | 'down' | null {
  const ue = edgeUpPp ?? -Infinity;
  const de = edgeDownPp ?? -Infinity;
  if (!Number.isFinite(ue) && !Number.isFinite(de)) return null;
  if (Math.abs(ue - de) < 0.001) return ue >= de ? 'up' : 'down';
  return ue > de ? 'up' : 'down';
}

export function pickLeadingSideByScore<T extends { passCount: number; edgePp: number | null }>(
  up: T,
  down: T,
): T {
  if (up.passCount !== down.passCount) {
    return up.passCount > down.passCount ? up : down;
  }
  return pickStrongerEdgeSide(up.edgePp, down.edgePp) === 'down' ? down : up;
}

/** Lane hint for spike / early jump when edge clears minimum on one or both sides. */
export function pickEdgeLaneHint(
  edgeUpPp: number | null,
  edgeDownPp: number | null,
  minEdgePp: number,
): 'up' | 'down' | null {
  const upOk = edgeUpPp != null && edgeUpPp >= minEdgePp;
  const downOk = edgeDownPp != null && edgeDownPp >= minEdgePp;
  if (upOk && !downOk) return 'up';
  if (downOk && !upOk) return 'down';
  if (upOk && downOk) return pickStrongerEdgeSide(edgeUpPp, edgeDownPp);
  return null;
}
