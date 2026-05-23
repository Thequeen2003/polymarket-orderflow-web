# CLOB “live trades” tape (Python)

This folder is optional. The web app normally reads tape through **`GET /api/data/recent-trades`** on your Node API.

- **Public tape (default):** Polymarket **Data API** — no wallet keys.
- **CLOB-authenticated tape (same as [py-clob-client-v2](https://github.com/Polymarket/py-clob-client-v2)):** set on the API server:
  - `POLYMARKET_RECENT_TRADES_SOURCE=clob`
  - Same `POLYMARKET_*` / L2 credentials as live trading (`POLYMARKET_LIVE_ORDERS_VIA=clob`, etc.)
  - Requests that include **`asset=<outcome token id>`** use `getTradesPaginated` (TS `@polymarket/clob-client-v2`); requests **without** `asset` still use the Data API so full-market flows keep working.

Use this Python env if you want a standalone script or to compare payloads against the API.

## Setup

```bash
cd api/scripts/py_clob_tape
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

Set the same variables as in the [py-clob-client-v2 README](https://github.com/Polymarket/py-clob-client-v2) (`PK` or `POLYMARKET_PRIVATE_KEY`, and L2 `CLOB_API_KEY` / `CLOB_SECRET` / `CLOB_PASS_PHRASE`, or derive keys once with L1 only).

## Run

```bash
export POLYMARKET_PRIVATE_KEY=0x...
# plus L2 creds, or run once with PK-only to derive
python clob_asset_trades.py <TOKEN_ID> [LIMIT]
```

Prints a JSON array of `{ timestamp, side, price, size, asset, ... }` compatible with the web `DataTradeRow` shape (timestamps in **unix seconds**).
