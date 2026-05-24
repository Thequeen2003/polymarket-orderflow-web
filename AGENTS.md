# Agent / cloud setup

## Default branch

`main` (also mirrored as `master` on the remote).

## Dev server

From repo root:

```bash
npm install
npm run dev
```

- API: http://127.0.0.1:8787 (`/api/health`)
- Web: http://localhost:5173 (proxies `/api` to the API)

## Secrets (local only — do not commit)

Copy `api/.env.example` → `api/.env` and set at minimum:

- `POLYMARKET_PRIVATE_KEY` — live CLOB trading
- Optional: Bullpen / assistant keys per `api/.env.example`

Web dev proxy: optional `web/.env.development` from `web/.env.development.example`.

## Tests

```bash
npm test
```

## Cursor Cloud specific instructions

- **No `.env` required for read-only mode**: The API starts successfully with the default `.env.example` copied to `api/.env`. Live trading features are disabled but all read-only endpoints (market search, order books, price feeds) work fine.
- **Lint has pre-existing errors in `api/`**: `npm run lint` currently fails with 6 errors in `api/src/` (unused vars, prefer-const). These are pre-existing and unrelated to your changes — the `web/` workspace lints clean.
- **Dev startup order**: `npm run dev` uses `concurrently` + `wait-on` to start the API first (port 8787), then the Vite web frontend (port 5173) once the API health check passes. Allow ~10-15s for both to be ready.
- **External API dependency**: The app depends on public Polymarket APIs (Gamma, CLOB, Data, RTDS WebSocket) for market data. If outbound internet is unavailable, the API will still start but market endpoints will return errors.
- **Tests are fast and self-contained**: All 494 tests (13 API + 65 web test files) run in ~5s with no network or env dependencies.
