/**
 * Load `repo/.env` then `api/.env` (overrides) once per process.
 * Import this module first from `server.ts` and scripts that need the same env.
 */
import dotenv from 'dotenv';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
export const API_ROOT = resolve(here, '..');
export const REPO_ROOT = resolve(API_ROOT, '..');

const LOADED_FLAG = 'POLYOF_ENV_LOADED';

export function loadAppEnv(): void {
  if (process.env[LOADED_FLAG] === '1') return;
  dotenv.config({ path: resolve(REPO_ROOT, '.env') });
  dotenv.config({ path: resolve(API_ROOT, '.env'), override: true });
  process.env[LOADED_FLAG] = '1';
}

loadAppEnv();
