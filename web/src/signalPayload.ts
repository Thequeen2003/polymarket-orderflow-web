export type SignalTone = 'up' | 'down' | 'neutral';

export type SignalFlagSeverity = 'info' | 'warn';
export type SignalFlag = { id: string; label: string; severity: SignalFlagSeverity };

export type SignalDriver = {
  /** Stable key so we can compute deltas across ticks. */
  key: string;
  label: string;
  /** Human-formatted (already includes units). */
  value: string;
  /** Optional raw numeric value for sorting/scoring. */
  raw?: number;
  /** Optional formatted delta vs previous tick. */
  delta?: string;
};

export type SignalConfidence = {
  /** 0–100 */
  score: number;
  label: string;
};

export type SignalPayload = {
  kind: 'flow_zone' | 'momentum_alert';
  tone: SignalTone;
  headline: string;
  asOf: number;
  confidence: SignalConfidence;
  flags: SignalFlag[];
  drivers: SignalDriver[];
};

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

export function clamp100(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(100, Math.max(0, x));
}

export function confidenceLabel(score: number): string {
  const s = clamp100(score);
  if (s >= 80) return 'High';
  if (s >= 55) return 'Medium';
  return 'Low';
}

export function fmtSigned(n: number, digits = 2): string {
  const x = Number.isFinite(n) ? n : 0;
  const sign = x > 0 ? '+' : x < 0 ? '−' : '';
  return `${sign}${Math.abs(x).toFixed(digits)}`;
}

