/** Cumulative depth curve for DOM ladder visualization (Flow Zones). */

export function depthCurve(levels: { price: number; size: number }[], n: number): { x: number; y: number }[] {
  const slice = levels.slice(0, n);
  let cum = 0;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < slice.length; i++) {
    const l = slice[i]!;
    cum += Number.isFinite(l.size) ? l.size : 0;
    out.push({ x: i + 1, y: cum });
  }
  return out;
}

export function depthCurveToPath(points: { x: number; y: number }[], w: number, h: number, pad: number): string {
  if (points.length === 0) return '';
  const maxX = Math.max(1, ...points.map((p) => p.x));
  const maxY = Math.max(1e-9, ...points.map((p) => p.y));
  const x = (v: number) => pad + ((v - 1) / Math.max(1e-9, maxX - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - (v / maxY) * (h - pad * 2);
  let d = `M ${x(points[0]!.x).toFixed(2)} ${y(points[0]!.y).toFixed(2)}`;
  for (let i = 1; i < points.length; i++) d += ` L ${x(points[i]!.x).toFixed(2)} ${y(points[i]!.y).toFixed(2)}`;
  return d;
}

export function firstWall(levels: { price: number; size: number }[], minSize: number): { price: number; size: number } | null {
  for (const l of levels) if (l.size >= minSize) return l;
  return null;
}
