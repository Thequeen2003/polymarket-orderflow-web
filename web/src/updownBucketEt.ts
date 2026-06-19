const UP_DOWN_TZ = 'America/New_York';

type EtParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function etPartsAt(unixSec: number): EtParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: UP_DOWN_TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });
  const m: Record<string, number> = {};
  for (const part of fmt.formatToParts(new Date(unixSec * 1000))) {
    if (part.type !== 'literal') m[part.type] = Number(part.value);
  }
  return {
    year: m.year!,
    month: m.month!,
    day: m.day!,
    hour: m.hour! % 24,
    minute: m.minute!,
    second: m.second!,
  };
}

function isEtBucketStart(unixSec: number, stepSec: number): boolean {
  const p = etPartsAt(unixSec);
  if (p.minute !== 0 || p.second !== 0) return false;
  if (stepSec === 3600) return true;
  if (stepSec === 14400) return p.hour % 4 === 0;
  if (stepSec === 86400) return p.hour === 0;
  return false;
}

/** Daily Up/Down windows run noon ET → noon ET; floor `nowSec` to the active window open. */
export function bucketFloorNoonEtUnixSec(nowSec: number): number {
  let t = nowSec - (nowSec % 60);
  for (let i = 0; i <= 24 * 60; i++) {
    const p = etPartsAt(t);
    if (p.hour === 12 && p.minute === 0 && p.second === 0) return t;
    t -= 60;
  }
  return nowSec;
}

/**
 * Floor `nowSec` to the start of the active Polymarket-style bucket in US/Eastern.
 * 4h blocks: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 ET.
 */
export function bucketFloorEtUnixSec(stepSec: number, nowSec: number): number {
  if (stepSec !== 3600 && stepSec !== 14400 && stepSec !== 86400) {
    return Math.floor(nowSec / stepSec) * stepSec;
  }
  let t = nowSec - (nowSec % 60);
  const maxWalkMin = stepSec === 86400 ? 24 * 60 : stepSec === 14400 ? 4 * 60 : 60;
  for (let i = 0; i <= maxWalkMin; i++) {
    if (isEtBucketStart(t, stepSec)) return t;
    t -= 60;
  }
  return Math.floor(nowSec / stepSec) * stepSec;
}
