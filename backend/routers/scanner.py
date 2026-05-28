"""
GET /api/scanner/stream?watchlist=default
Server-Sent Events — yields one JSON result per ticker as it completes.
Final message: {"done": true, "total": N}
"""
import json
import asyncio
import os
from concurrent.futures import ThreadPoolExecutor
from typing import Optional
from fastapi import APIRouter, BackgroundTasks, Body, HTTPException, Query
from fastapi.responses import JSONResponse, StreamingResponse

from backend.services.scanner import (
    WATCHLISTS, scan_single, get_short_squeeze_tickers, get_telegram_watchlist,
)

router = APIRouter(prefix="/api/scanner", tags=["scanner"])


@router.get("/watchlists")
def get_watchlists():
    return {k: len(v) for k, v in WATCHLISTS.items()}


@router.post("/v3-refresh")
def v3_refresh(payload: dict = Body(...)):
    """Re-evaluate ONLY the V3 day-trading engine for a list of tickers.

    Designed to be polled every ~5 min from the frontend during V3 trade
    windows (09:50–11:00 / 13:30–15:30 ET) so the Day Trading column
    stays live without re-running the full scan_single pipeline (which
    re-fetches options, fundamentals, news, etc. — expensive).

    Request:  {"tickers": ["MU", "SPY", ...]}
    Response: {"results": {"MU": {dt3_setup, dt3_side, ..., dt3_pwh, ...},
                            ...},
               "count": <int>}
    """
    raw = payload.get("tickers") or []
    tickers = [t.strip().upper() for t in raw
               if isinstance(t, str) and t.strip()]
    # Bound size to keep the endpoint cheap; the scanner UI rarely shows
    # more than a few hundred rows.
    tickers = list(dict.fromkeys(tickers))[:200]
    if not tickers:
        return {"results": {}, "count": 0}

    # `notify` is the Rank-1+ subset the frontend wants Telegram alerts for.
    # Shape: {ticker: tier_label} — frontend computes the tier from its row
    # state (Exceptional / Actionable / Rank 1). Missing → no alert.
    notify_in = payload.get("notify") or {}
    notify: dict[str, str] = {}
    if isinstance(notify_in, dict):
        for k, v in notify_in.items():
            if isinstance(k, str) and isinstance(v, str):
                notify[k.strip().upper()] = v.strip()
    elif isinstance(notify_in, list):
        for k in notify_in:
            if isinstance(k, str):
                notify[k.strip().upper()] = "Rank 1"

    from concurrent.futures import as_completed
    from day_trading.v3 import analyze as _v3_analyze
    from backend.services.scanner import _v3_alert_once

    def _one(tk: str) -> tuple[str, dict]:
        try:
            r = _v3_analyze(tk)
            sig = r.get("signal") or {}
            lvl = r.get("levels") or {}
            tgts = sig.get("targets") or []
            setup = sig.get("setup")
            if not setup:
                setup = "no_setup" if lvl else "error"
            return tk, {
                "dt3_setup":     setup,
                "dt3_side":      sig.get("side"),
                "dt3_grade":     sig.get("grade"),
                "dt3_level":     sig.get("level"),
                "dt3_level_val": sig.get("level_val"),
                "dt3_entry":     sig.get("entry"),
                "dt3_stop":      sig.get("stop"),
                "dt3_t1":        tgts[0] if len(tgts) >= 1 else None,
                "dt3_t2":        tgts[1] if len(tgts) >= 2 else None,
                "dt3_rr":        sig.get("rr"),
                "dt3_rationale": sig.get("rationale") or r.get("error"),
                "dt3_pdh":       lvl.get("pdh"),
                "dt3_pdl":       lvl.get("pdl"),
                "dt3_pwh":       lvl.get("pwh"),
                "dt3_pwl":       lvl.get("pwl"),
                "dt3_as_of":     r.get("as_of"),
            }
        except Exception as e:
            return tk, {
                "dt3_setup":     "error",
                "dt3_rationale": f"{type(e).__name__}: {str(e)[:120]}",
            }

    out: dict = {}
    # Cap concurrency — yfinance gets cranky if hit by many parallel calls
    # at the open. v3 also has a 60s result cache, so most repeats are free.
    with ThreadPoolExecutor(max_workers=6) as ex:
        futures = {ex.submit(_one, tk): tk for tk in tickers}
        for fut in as_completed(futures):
            try:
                tk, data = fut.result(timeout=8.0)
                out[tk] = data
                # Telegram alert only for tickers in the notify allowlist
                # (Actionable / Exceptional / Rank 1). Dedup is inside the
                # helper, so this is safe to call every cycle.
                tier = notify.get(tk)
                if tier:
                    _v3_alert_once(tk, data, tier=tier)
            except Exception:
                continue

    return {"results": out, "count": len(out), "notify_count": len(notify)}


@router.get("/seasonality")
async def seasonality(ticker: str = Query(...)):
    """On-demand current-month + 12-month seasonality (cached per month).

    Kept off the scan hot path — the UI calls this only when the
    seasonality modal is opened.
    """
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"available": False, "reason": "no ticker"}
    loop = asyncio.get_event_loop()

    def _do():
        from backend.services.scanner import _seasonality_cached
        return _seasonality_cached(sym)

    return await loop.run_in_executor(None, _do)


@router.post("/telegram/refresh")
async def refresh_telegram_watchlist():
    """Force an immediate TOS-scan Gmail pull (don't wait for the 7:15 PM job)."""
    loop = asyncio.get_event_loop()

    def _do():
        from backend.services.gmail_watchlist import (
            poll_and_store, fetch_today_watchlist,
        )
        new = poll_and_store()
        tickers = fetch_today_watchlist()
        return {"new": new, "count": len(tickers), "tickers": tickers}

    return await loop.run_in_executor(None, _do)


@router.get("/snapshot")
def get_scanner_snapshot(
    watchlist: str = Query("default"),
    day: Optional[str] = Query(None),
):
    """Return the latest saved scanner snapshot for a watchlist."""
    from backend.services.scanner_snapshot import load_snapshot

    return load_snapshot(watchlist, day=day)


@router.post("/snapshot/run")
def run_scanner_snapshot(
    background_tasks: BackgroundTasks,
    watchlist: str = Query("default"),
    day: Optional[str] = Query(None),
):
    """Queue a saved scanner snapshot rebuild."""
    from backend.services.scanner_snapshot import refresh_snapshot

    background_tasks.add_task(refresh_snapshot, watchlist, day=day)
    return JSONResponse(
        status_code=202,
        content={"status": "queued", "watchlist": watchlist, "date": day},
    )


@router.post("/snapshot/run-all")
def run_all_scanner_snapshots(
    background_tasks: BackgroundTasks,
    day: Optional[str] = Query(None),
):
    """Queue saved snapshot rebuilds for configured watchlists."""
    from backend.services.scanner_snapshot import refresh_snapshots

    background_tasks.add_task(refresh_snapshots, day=day)
    return JSONResponse(
        status_code=202,
        content={"status": "queued", "date": day},
    )


@router.post("/snapshot/prune")
def prune_scanner_snapshots(days: Optional[int] = Query(None)):
    """Remove old saved scanner snapshots according to retention."""
    from backend.services.scanner_snapshot import prune_snapshots

    return prune_snapshots(days=days)


@router.delete("/snapshot")
def delete_scanner_snapshot(
    watchlist: str = Query("default"),
    day: Optional[str] = Query(None),
    all_days: bool = Query(False),
):
    """Delete one saved scanner snapshot day, or all days when all_days=true."""
    if not day and not all_days:
        raise HTTPException(
            status_code=400,
            detail="Pass day=YYYY-MM-DD or all_days=true.",
        )
    from backend.services.scanner_snapshot import delete_snapshot

    return delete_snapshot(watchlist, day=day)


@router.get("/stream")
async def stream_scan(
    watchlist: str = Query("default"),
    tickers:  str  = Query(""),          # comma-separated custom list
    as_of:    Optional[str] = Query(None),  # backtest date YYYY-MM-DD
    include_news: Optional[str] = Query(None),  # "1"/"true"/etc to opt-in per-scan
    mode: Optional[str] = Query("overview"),
):
    # Parse the per-call news override. None = let the backend env default
    # decide; True/False = force this scan one way regardless of env.
    news_override: Optional[bool] = None
    if include_news is not None:
        news_override = include_news.strip().lower() in {"1", "true", "yes", "on"}
    if tickers:
        ticker_list = [t.strip().upper() for t in tickers.split(",") if t.strip()]
    elif watchlist == "short_squeeze":
        loop = asyncio.get_event_loop()
        ticker_list = await loop.run_in_executor(None, get_short_squeeze_tickers)
    elif watchlist == "telegram":
        loop = asyncio.get_event_loop()
        ticker_list = await loop.run_in_executor(None, get_telegram_watchlist)
    else:
        ticker_list = WATCHLISTS.get(watchlist, WATCHLISTS["default"])
    tickers = ticker_list

    async def generate():
        loop = asyncio.get_event_loop()
        queue: asyncio.Queue = asyncio.Queue()
        try:
            worker_limit = int(os.getenv("SCANNER_MAX_WORKERS", "5"))
        except ValueError:
            worker_limit = 5
        max_workers = max(1, min(len(tickers), worker_limit))

        async def _scan_all():
            pool = ThreadPoolExecutor(max_workers=max_workers)
            try:
                futures = [loop.run_in_executor(pool, scan_single, t, as_of, news_override, mode) for t in tickers]
                for coro in asyncio.as_completed(futures):
                    result = await coro
                    await queue.put(result)
            finally:
                pool.shutdown(wait=False, cancel_futures=False)
                await queue.put(None)  # sentinel — done

        asyncio.create_task(_scan_all())

        count = 0
        while True:
            result = await queue.get()
            if result is None:
                break
            count += 1
            yield f"data: {json.dumps(result)}\n\n"

        yield f"data: {json.dumps({'done': True, 'total': count})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
