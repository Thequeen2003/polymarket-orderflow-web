import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type PtbBucketEntry = { value: number; source: string; savedAtMs: number };

const PTB_DISK_DIR = path.join(os.homedir(), '.polymarket-orderflow-web');
const PTB_DISK_FILE = path.join(PTB_DISK_DIR, 'ptb-by-bucket.json');

export function loadPtbBucketDiskCache(): Map<string, PtbBucketEntry> {
  try {
    const raw = fs.readFileSync(PTB_DISK_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, PtbBucketEntry>;
    const out = new Map<string, PtbBucketEntry>();
    for (const [k, v] of Object.entries(parsed)) {
      if (v && Number.isFinite(v.value)) out.set(k, v);
    }
    return out;
  } catch {
    return new Map();
  }
}

export function savePtbBucketDiskEntry(key: string, entry: { value: number; source: string }): void {
  try {
    fs.mkdirSync(PTB_DISK_DIR, { recursive: true });
    let existing: Record<string, PtbBucketEntry> = {};
    try {
      existing = JSON.parse(fs.readFileSync(PTB_DISK_FILE, 'utf8')) as Record<string, PtbBucketEntry>;
    } catch {
      /* fresh file */
    }
    existing[key] = { ...entry, savedAtMs: Date.now() };
    fs.writeFileSync(PTB_DISK_FILE, JSON.stringify(existing));
  } catch {
    /* ignore disk errors */
  }
}
