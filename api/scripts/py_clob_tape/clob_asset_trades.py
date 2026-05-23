#!/usr/bin/env python3
"""Fetch recent trades for one CLOB outcome token using py-clob-client-v2 (L2)."""

from __future__ import annotations

import json
import os
import sys


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: clob_asset_trades.py <token_id> [limit]", file=sys.stderr)
        sys.exit(2)
    token = sys.argv[1].strip()
    limit = min(200, max(1, int(sys.argv[2]) if len(sys.argv) > 2 else 60))

    host = (
        os.environ.get("POLYMARKET_CLOB_API_URL")
        or os.environ.get("POLYMARKET_HOST")
        or "https://clob.polymarket.com"
    ).rstrip("/")
    chain_id = int(os.environ.get("POLYMARKET_CHAIN_ID", "137"))
    pk = (os.environ.get("POLYMARKET_PRIVATE_KEY") or os.environ.get("PK") or "").strip()
    if not pk:
        print("missing POLYMARKET_PRIVATE_KEY or PK", file=sys.stderr)
        sys.exit(2)

    from py_clob_client_v2 import ApiCreds, ClobClient
    from py_clob_client_v2.clob_types import TradeParams

    if os.environ.get("CLOB_API_KEY") and os.environ.get("CLOB_SECRET") and os.environ.get("CLOB_PASS_PHRASE"):
        creds = ApiCreds(
            api_key=os.environ["CLOB_API_KEY"],
            api_secret=os.environ["CLOB_SECRET"],
            api_passphrase=os.environ["CLOB_PASS_PHRASE"],
        )
        client = ClobClient(host=host, chain_id=chain_id, key=pk, creds=creds)
    else:
        tmp = ClobClient(host=host, chain_id=chain_id, key=pk)
        creds = tmp.create_or_derive_api_key()
        client = ClobClient(host=host, chain_id=chain_id, key=pk, creds=creds)

    params = TradeParams(asset_id=token)
    rows: list[dict] = []
    cursor = None
    while len(rows) < limit:
        batch = client.get_trades_paginated(params, next_cursor=cursor)
        trades = batch.get("trades") or []
        if not trades:
            break
        for tr in trades:
            if not isinstance(tr, dict):
                continue
            if str(tr.get("asset_id", "")).strip() != token:
                continue
            row = _to_row(tr, token)
            if row:
                rows.append(row)
        nxt = batch.get("next_cursor")
        if not nxt or nxt == "LTE=":
            break
        cursor = nxt

    rows.sort(key=lambda r: r["timestamp"], reverse=True)
    print(json.dumps(rows[:limit], indent=2))


def _to_row(tr: dict, asset: str) -> dict | None:
    raw_t = tr.get("match_time") or tr.get("last_update") or tr.get("timestamp")
    ms = 0
    if isinstance(raw_t, str):
        from datetime import datetime

        try:
            ms = int(datetime.fromisoformat(raw_t.replace("Z", "+00:00")).timestamp() * 1000)
        except Exception:
            ms = 0
    elif isinstance(raw_t, (int, float)) and raw_t > 0:
        v = float(raw_t)
        ms = int(v) if v > 10_000_000_000 else int(v * 1000)
    if ms <= 0:
        return None
    ts_sec = ms // 1000

    side_raw = str(tr.get("side", "")).upper()
    if side_raw in ("SELL", "S"):
        side = "sell"
    elif side_raw in ("BUY", "B"):
        side = "buy"
    else:
        return None

    price = tr.get("price")
    try:
        p = float(price)
    except (TypeError, ValueError):
        return None
    if p <= 0 or p >= 1:
        if 1 < p <= 100:
            p = p / 100.0
        else:
            return None

    size_raw = tr.get("size") or tr.get("amount") or tr.get("quantity")
    try:
        sz = float(size_raw)
    except (TypeError, ValueError):
        return None
    if sz <= 0:
        return None

    tx = (
        tr.get("transaction_hash")
        or tr.get("transactionHash")
        or tr.get("tx_hash")
        or tr.get("id")
        or tr.get("trade_id")
    )

    return {
        "timestamp": ts_sec,
        "side": side,
        "price": p,
        "size": sz,
        "outcome": None,
        "asset": asset,
        "transactionHash": str(tx) if tx is not None else None,
        "pseudonym": None,
    }


if __name__ == "__main__":
    main()
