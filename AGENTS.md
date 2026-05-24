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
