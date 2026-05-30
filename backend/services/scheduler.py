"""
Earnings scheduler — APScheduler jobs for automated pre/post earnings alerts.

Schedule (all times CST / America/Chicago):
  08:30  pre_earnings_job    — discover today's reporters, send pre-earnings Telegram,
                               store tickers in SQLite
  15:00  start_eps_polling   — kick off 1-minute EPS poll interval job
  18:00  stop_eps_polling    — shut down the interval job

EPS poll logic (runs every 1 min, 3–6 PM CST):
  For each unnotified ticker: try fast EPS sources (Yahoo quoteSummary → Finviz).
  Once EPS confirmed, send post-earnings Telegram and mark DB record done.
"""
import logging
import sys
import os
import json
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger

from backend.db.earnings_tracker import (
    init_db, init_watchlist, upsert_ticker, mark_pre_notified,
    mark_post_notified, get_pending_post, get_watchlist, today_str,
)
from backend.services.earnings import (
    find_earnings_reporters,
    get_full_earnings_analysis,
    get_earnings_trade_for_date,
    get_earnings_dates_yf,
    get_eps_fast,
)
from backend.services.telegram_svc import send_telegram

logger = logging.getLogger(__name__)
CST = ZoneInfo("America/Chicago")

# ── Telegram credentials from root config ─────────────────────────────────────
try:
    _ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
    sys.path.insert(0, os.path.abspath(_ROOT))
    from config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  # type: ignore
except ImportError:
    TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
    TELEGRAM_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID", "")

# ── Scheduler instance ────────────────────────────────────────────────────────
scheduler = AsyncIOScheduler(timezone="America/Chicago")


def _env_enabled(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


_SCANNER_SNAPSHOT_ENABLED = _env_enabled(
    "SCANNER_SNAPSHOT_ENABLED",
    os.getenv("MOMENTUM_SNAPSHOT_ENABLED", "1"),
)
_SWEEP_DIGEST_ENABLED = _env_enabled("SWEEP_DIGEST_ENABLED", "1")
_HOLDINGS_SUMMARY_ENABLED = _env_enabled("HOLDINGS_SUMMARY_ENABLED", "1")
_HOLDINGS_EMAIL_ENABLED = _env_enabled("HOLDINGS_EMAIL_ENABLED", "1")
_HOLDINGS_TELEGRAM_ENABLED = _env_enabled("HOLDINGS_TELEGRAM_ENABLED", "1")
_NEWS_DIGEST_CATCHUP_ENABLED = _env_enabled("NEWS_DIGEST_CATCHUP_ENABLED", "1")
try:
    _NEWS_DIGEST_MAX_WORKERS = max(1, int(os.getenv("NEWS_DIGEST_MAX_WORKERS", "16")))
except ValueError:
    _NEWS_DIGEST_MAX_WORKERS = 16
# Earnings jobs — pre-earnings discovery (8:30 CST) + EPS polling
# (15:00–18:00 CST). Default OFF; set EARNINGS_JOBS_ENABLED=1 to re-enable.
_EARNINGS_JOBS_ENABLED = _env_enabled("EARNINGS_JOBS_ENABLED", "0")
# Regime-change Telegram alerts (verdict + γ flips). Default ON; set
# MACRO_ALERTS_ENABLED=0 to silence.
_MACRO_ALERTS_ENABLED  = _env_enabled("MACRO_ALERTS_ENABLED", "1")

_SCHEDULER_STATE_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "db", "scheduler_state.json")
)


def _load_scheduler_state() -> dict:
    try:
        with open(_SCHEDULER_STATE_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_scheduler_state(state: dict) -> None:
    try:
        os.makedirs(os.path.dirname(_SCHEDULER_STATE_PATH), exist_ok=True)
        tmp = f"{_SCHEDULER_STATE_PATH}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, sort_keys=True)
        os.replace(tmp, _SCHEDULER_STATE_PATH)
    except Exception as exc:
        logger.warning("[scheduler] state write failed: %s", exc)


def _daily_job_sent(key: str, day: str | None = None) -> bool:
    day = day or datetime.now(CST).date().isoformat()
    return _load_scheduler_state().get(key) == day


def _mark_daily_job_sent(key: str, day: str | None = None) -> None:
    day = day or datetime.now(CST).date().isoformat()
    state = _load_scheduler_state()
    state[key] = day
    _save_scheduler_state(state)


# ── Message formatters ────────────────────────────────────────────────────────

def _fmt_pre(ticker: str, analysis: dict) -> str:
    d     = analysis.get("direction", {})
    stats = analysis.get("stats", {})
    em    = analysis.get("expected_move", {})
    rev   = analysis.get("revisions", {})
    sq    = d.get("squeeze_setup")

    lines = [f"<b>📊 PRE-EARNINGS: {ticker}</b>"]

    next_e = analysis.get("next_earnings") or analysis.get("last_reported")
    lines.append(f"Earnings: <b>{next_e or 'Today'}</b>  |  Price: ${analysis.get('current_price', 0):.2f}")

    # EPS Estimate from analyst consensus
    eps_est    = rev.get("est_current")
    n_analysts = rev.get("analyst_count")
    if eps_est is not None:
        est_str = f"EPS Est: <b>${eps_est:.2f}</b>"
        if n_analysts:
            est_str += f"  ({n_analysts} analysts)"
        lines.append(est_str)

    dir_str = d.get("direction", "—")
    conf    = d.get("confidence", "")
    score   = d.get("score", 0)
    lines.append(f"Direction: <b>{dir_str}</b> ({conf}, score {score:+d})")

    if em and not em.get("error"):
        lines.append(
            f"Options move: ±{em.get('expected_move_pct', '—')}%"
            f"  |  IV skew: {em.get('iv_skew', '—')}%"
        )
    lines.append(f"Est move (blended): ±{analysis.get('estimated_move', '—')}%")

    if stats:
        lines.append(
            f"Hist avg: ±{stats.get('avg_abs_move', '—')}%"
            f"  |  Beat rate: {stats.get('beat_rate', '—')}%"
            f"  |  Bull rate: {stats.get('bull_rate', '—')}%"
        )

    if sq and sq.get("score", 0) >= 2:
        lines.append(f"🔥 SQUEEZE: {sq.get('label', '')} (score {sq.get('score')})")

    return "\n".join(lines)


def _fmt_post(ticker: str, trade: dict, eps: dict) -> str:
    eps_actual   = trade.get("eps_actual")   or eps.get("eps_actual")
    eps_estimate = trade.get("eps_estimate") or eps.get("eps_estimate")
    surp         = trade.get("eps_surprise") or eps.get("surprise_pct")
    beat         = (surp or 0) > 0
    gap          = trade.get("gap_pct") or 0
    day          = trade.get("day_pct") or 0
    price        = trade.get("current_price")
    direction    = trade.get("direction", "—")
    entry        = trade.get("entry")
    exit_p       = trade.get("exit")
    vol          = trade.get("vol_ratio")
    source       = eps.get("source", "")

    beat_icon = "✅ BEAT" if beat else "❌ MISS"

    # EPS line: Actual $X.XX  vs Est $X.XX  → +X.X% BEAT
    if eps_actual is not None:
        eps_line = f"EPS: <b>${eps_actual:.2f}</b>"
        if eps_estimate is not None:
            eps_line += f"  vs Est ${eps_estimate:.2f}"
        if surp is not None:
            sign = "+" if surp > 0 else ""
            eps_line += f"  →  {sign}{surp:.1f}%  {beat_icon}"
    elif surp is not None:
        sign = "+" if surp > 0 else ""
        eps_line = f"EPS Surprise: {sign}{surp:.1f}%  {beat_icon}"
    else:
        eps_line = "EPS: pending"

    result_icon = "✅" if beat else "❌"
    lines = [
        f"<b>{result_icon} POST-EARNINGS: {ticker}</b>",
        f"Date: {trade.get('date', today_str())}  |  Source: {source or '—'}",
        eps_line,
    ]

    # Price movement (may not be available for AMC reporters until next day)
    if gap or day:
        lines.append(f"Gap: {gap:+.1f}%  |  Day: {day:+.1f}%")
    elif price:
        lines.append(f"Last price: ${price:.2f}")

    if entry and exit_p:
        pnl = trade.get("pnl_pct") or 0
        lines.append(f"Entry: ${entry:.2f}  →  Exit: ${exit_p:.2f}  |  PnL: {pnl:+.1f}%")
    if vol:
        lines.append(f"Vol: {vol:.2f}×")

    return "\n".join(lines)


# ── Job: 8:30 AM CST — pre-earnings discovery ─────────────────────────────────

async def pre_earnings_job():
    today = today_str()
    logger.info(f"[scheduler] pre_earnings_job started for {today}")

    try:
        tickers = find_earnings_reporters(today)
    except Exception as e:
        logger.error(f"[scheduler] find_earnings_reporters failed: {e}")
        tickers = []

    # Also include any watchlist tickers reporting today
    try:
        from backend.services.earnings import _check_ticker_for_date
        for wt in get_watchlist():
            if wt not in tickers and _check_ticker_for_date(wt, today):
                tickers.append(wt)
    except Exception as e:
        logger.warning(f"[scheduler] watchlist merge failed: {e}")

    if not tickers:
        send_telegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
                      f"📭 <b>No earnings reporters</b> found in watchlist for {today}")
        logger.info("[scheduler] No reporters found")
        return

    # Store all tickers in DB (eps_estimate filled in per-ticker below)
    for t in tickers:
        upsert_ticker(t, today)

    # Summary header
    send_telegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
                  f"📅 <b>Earnings Today — {today}</b>\n"
                  f"Found: {', '.join(tickers)}\nSending pre-earnings analysis…")

    # Per-ticker pre-earnings alert
    for ticker in tickers:
        try:
            analysis = get_full_earnings_analysis(ticker)
            if analysis.get("error"):
                logger.warning(f"[scheduler] analysis error for {ticker}: {analysis['error']}")
                continue

            # Save eps_estimate to DB so poll can use it later
            eps_est = analysis.get("revisions", {}).get("est_current")
            if eps_est is not None:
                upsert_ticker(ticker, today, eps_estimate=eps_est)

            msg = _fmt_pre(ticker, analysis)
            ok  = send_telegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, msg)

            pre_drift = None
            dir_info  = analysis.get("direction", {})
            factors   = dir_info.get("factors", [])
            for f in factors:
                if "drift" in f.get("name", "").lower():
                    try:
                        pre_drift = float(f["value"].replace("%", "").replace("+", ""))
                    except Exception:
                        pass
                    break

            if ok:
                mark_pre_notified(ticker, today, pre_drift=pre_drift)
                logger.info(f"[scheduler] pre-earnings sent for {ticker}")
        except Exception as e:
            logger.error(f"[scheduler] pre-earnings error for {ticker}: {e}")


# ── Job: 3 PM–6 PM CST — per-minute EPS poll ─────────────────────────────────

async def poll_for_eps():
    """
    1-min poll: check fast EPS sources, send post-earnings Telegram once confirmed.
    Sends as soon as EPS actual is available — doesn't wait for next-day price data.
    For AMC reporters the gap/day will be 0; for BMO they'll be populated once market closed.
    """
    import yfinance as yf
    from zoneinfo import ZoneInfo

    today   = today_str()
    pending = get_pending_post(today)

    if not pending:
        logger.debug("[scheduler] poll: no pending tickers")
        return

    logger.info(f"[scheduler] polling EPS for: {[r['ticker'] for r in pending]}")

    # Determine if market is closed (after 4 PM ET) — only then do we have closing prices
    now_et        = datetime.now(ZoneInfo("America/New_York"))
    market_closed = now_et.hour >= 16

    for row in pending:
        ticker       = row["ticker"]
        eps_est_db   = row.get("eps_estimate")   # saved at 8:30 AM
        try:
            # ── Step 1: fast EPS sources (Yahoo quoteSummary → Benzinga → Finviz) ──
            eps = get_eps_fast(ticker, today) or {}

            # ── Step 2: fall back to yfinance earnings_dates if fast failed ─────────
            if not eps or eps.get("eps_actual") is None:
                dates = get_earnings_dates_yf(ticker)
                found = next(
                    (e for e in reversed(dates)
                     if abs((datetime.strptime(e["date"], "%Y-%m-%d").date()
                             - datetime.strptime(today, "%Y-%m-%d").date()).days) <= 1
                     and e.get("eps_actual") is not None),
                    None,
                )
                if found:
                    eps = {
                        "eps_actual":   found.get("eps_actual"),
                        "eps_estimate": found.get("eps_estimate"),
                        "surprise_pct": found.get("surprise_pct"),
                        "source":       "yfinance",
                    }

            if not eps or eps.get("eps_actual") is None:
                logger.debug(f"[scheduler] {ticker}: no EPS data yet")
                continue

            # ── Back-fill eps_estimate from DB if fast source didn't return one ─────
            if eps.get("eps_estimate") is None and eps_est_db is not None:
                eps["eps_estimate"] = eps_est_db
                # Recalculate surprise with the saved estimate
                if eps.get("surprise_pct") is None and eps_est_db != 0:
                    actual = eps["eps_actual"]
                    eps["surprise_pct"] = round(
                        (actual - eps_est_db) / abs(eps_est_db) * 100, 1
                    )

            # ── Step 3: get price movement (only if market closed) ────────────────
            gap_pct = day_pct = current_price = None
            if market_closed:
                try:
                    hist = yf.Ticker(ticker).history(period="3d", interval="1d")
                    if len(hist) >= 2:
                        prev_close    = float(hist["Close"].iloc[-2])
                        today_open    = float(hist["Open"].iloc[-1])
                        today_close   = float(hist["Close"].iloc[-1])
                        gap_pct       = round((today_open  - prev_close) / prev_close * 100, 2)
                        day_pct       = round((today_close - prev_close) / prev_close * 100, 2)
                        current_price = today_close
                except Exception:
                    pass
            else:
                # Pre-close: fetch after-hours last price if available
                try:
                    fi = yf.Ticker(ticker).fast_info
                    current_price = float(getattr(fi, "last_price", None) or 0) or None
                except Exception:
                    pass

            trade = {
                "ticker":        ticker,
                "date":          today,
                "direction":     ("LONG" if (day_pct or 0) >= 0 else "SHORT") if day_pct is not None else "—",
                "gap_pct":       gap_pct or 0,
                "day_pct":       day_pct or 0,
                "pnl_pct":       day_pct or 0,
                "current_price": current_price,
                "eps_actual":    eps.get("eps_actual"),
                "eps_estimate":  eps.get("eps_estimate"),
                "eps_surprise":  eps.get("surprise_pct"),
                "beat":          (eps.get("surprise_pct") or 0) > 0,
            }

            msg = _fmt_post(ticker, trade, eps)
            ok  = send_telegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, msg)

            if ok:
                mark_post_notified(
                    ticker, today,
                    eps_actual   = eps.get("eps_actual"),
                    surprise_pct = eps.get("surprise_pct"),
                    eps_beat     = trade["beat"],
                    gap_pct      = gap_pct or 0,
                    day_pct      = day_pct or 0,
                    direction    = trade["direction"],
                    pnl_pct      = day_pct or 0,
                    vol_ratio    = None,
                    reason       = f"via {eps.get('source', 'fast lookup')}",
                )
                logger.info(
                    f"[scheduler] post-earnings sent for {ticker}: "
                    f"EPS={eps.get('eps_actual')}, surprise={eps.get('surprise_pct')}%"
                )

        except Exception as e:
            logger.error(f"[scheduler] poll error for {ticker}: {e}")


def start_eps_polling():
    """3:00 PM CST — add the 1-minute polling interval job."""
    if not scheduler.get_job("eps_poll"):
        scheduler.add_job(
            poll_for_eps,
            "interval",
            minutes=1,
            id="eps_poll",
            max_instances=1,
        )
        send_telegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
                      f"⏱ EPS polling started (every 1 min) for {today_str()}")
        logger.info("[scheduler] EPS polling started")


def momentum_scan_job():
    """8:45 AM CST — scan momentum watchlist (hardcoded 20 + user watchlist), send weekly targets to Telegram."""
    from backend.services.scanner import scan_single, WATCHLISTS
    from backend.db.earnings_tracker import get_watchlist
    from concurrent.futures import ThreadPoolExecutor, as_completed

    core     = WATCHLISTS.get("momentum", [])
    watchlist = get_watchlist()
    # Merge: core first, then any watchlist tickers not already in core
    seen = set(core)
    extra = [t for t in watchlist if t not in seen]
    tickers = core + extra
    logger.info(f"[scheduler] momentum scan: {len(core)} core + {len(extra)} watchlist = {len(tickers)} total")
    logger.info(f"[scheduler] momentum scan started for {len(tickers)} tickers")

    results = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(scan_single, t): t for t in tickers}
        for fut in as_completed(futures):
            try:
                r = fut.result()
                if not r.get("error") and r.get("verdict") not in ("NEUTRAL",):
                    results.append(r)
            except Exception:
                pass

    if not results:
        send_telegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
                      f"📊 <b>Momentum Scan {today_str()}</b>\nNo strong signals found today.")
        return

    # Sort: score descending (strongest signals first)
    results.sort(key=lambda x: -(x.get("score") or 0))

    lines = [f"📊 <b>Momentum Watchlist — {today_str()}</b>",
             f"Signals: {len(results)} | Sorted by score\n"]

    for r in results:
        ticker  = r["ticker"]
        price   = r.get("price", 0)
        verdict = r.get("verdict", "—")
        score   = r.get("score", 0)
        entry   = r.get("entry")
        stop    = r.get("stop_loss")
        t1      = r.get("target1")
        t1_days = r.get("t1_days")
        t1_eta  = r.get("t1_days_text")
        rr      = r.get("rr_t1")
        weekly  = r.get("weekly_bias", {})
        w_bias  = weekly.get("bias", "—") if isinstance(weekly, dict) else str(weekly)
        opt_sum = r.get("opt_summary")

        icon = "🟢" if "BULL" in (verdict or "") else "🔴"
        line = f"{icon} <b>{ticker}</b> ${price:.2f} | {verdict} ({score:+d})"
        line += f"\n   Weekly: {w_bias}"
        if entry and stop and t1:
            line += f"\n   Entry: ${entry:.2f}  Stop: ${stop:.2f}  T1: ${t1:.2f}"
            if t1_eta:
                line += f" ({t1_eta})"
            elif t1_days:
                line += f" (~{int(t1_days)}d)"
            if rr:
                line += f"  R:R {rr:.1f}×"
        if opt_sum:
            line += f"\n   {opt_sum}"
        lines.append(line)

    send_telegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, "\n".join(lines))
    logger.info(f"[scheduler] momentum scan sent: {len(results)} signals")


def scanner_snapshot_job():
    """After market close: refresh saved scanner snapshots in Neon/Postgres."""
    if not _SCANNER_SNAPSHOT_ENABLED:
        logger.info("[scheduler] scanner snapshots skipped: SCANNER_SNAPSHOT_ENABLED=0")
        return
    try:
        from backend.services.scanner_snapshot import (
            configured_watchlists,
            prune_snapshots,
            refresh_snapshots,
        )

        watchlists = configured_watchlists()
        snaps = refresh_snapshots(watchlists)
        pruned = prune_snapshots(watchlists=watchlists)
        summary = ", ".join(
            f"{s.get('watchlist')}={s.get('count', 0)}"
            for s in snaps.get("watchlists", [])
        )
        logger.info(
            "[scheduler] scanner snapshots refreshed: %s for %s via %s; pruned=%s",
            summary,
            snaps.get("date"),
            snaps.get("store"),
            pruned.get("deleted"),
        )
    except Exception as e:
        logger.error(f"[scheduler] scanner snapshot refresh failed: {e}")


def momentum_snapshot_job():
    """Backward-compatible entrypoint for the old Momentum-only scheduler."""
    scanner_snapshot_job()


def sweep_digest_job():
    """Post-market: send V4/V3 sweep reclaim/reject setups from saved scans."""
    if not _SWEEP_DIGEST_ENABLED:
        logger.info("[scheduler] sweep digest skipped: SWEEP_DIGEST_ENABLED=0")
        return

    import html

    try:
        from backend.services.scanner_snapshot import (
            configured_watchlists,
            load_snapshot,
            refresh_snapshots,
        )

        watchlists = configured_watchlists()
        snapshots = [load_snapshot(w) for w in watchlists]
        if not any(s.get("available") and s.get("results") for s in snapshots):
            refreshed = refresh_snapshots(watchlists)
            snapshots = refreshed.get("watchlists", [])

        seen: set[str] = set()
        longs: list[dict] = []
        shorts: list[dict] = []

        for snap in snapshots:
            for row in snap.get("results") or []:
                ticker = str(row.get("ticker") or "").upper()
                if not ticker or ticker in seen or row.get("error"):
                    continue
                seen.add(ticker)

                dt4_setup = row.get("dt4_setup")
                dt3_setup = row.get("dt3_setup")
                dt3_side = row.get("dt3_side")

                is_long = dt4_setup == "sweep_reclaim_long" or (
                    dt3_setup == "sweep_reclaim" and dt3_side == "long"
                )
                is_short = dt4_setup == "sweep_reject_short" or (
                    dt3_setup == "sweep_reclaim" and dt3_side == "short"
                )
                if not is_long and not is_short:
                    continue

                rec = {
                    "ticker": ticker,
                    "price": row.get("price"),
                    "sector": row.get("sector"),
                    "verdict": row.get("verdict"),
                    "setup": dt4_setup or dt3_setup,
                    "grade": row.get("dt4_grade") or row.get("dt3_grade"),
                    "level": row.get("dt4_level") or row.get("dt3_level"),
                    "entry": row.get("dt4_entry") or row.get("dt3_entry"),
                    "stop": row.get("dt4_stop") or row.get("dt3_stop"),
                    "t1": row.get("dt4_t1") or row.get("dt3_t1"),
                    "rr": row.get("dt4_rr") or row.get("dt3_rr"),
                    "trigger": row.get("dt4_trigger") or row.get("dt3_rationale"),
                }
                (longs if is_long else shorts).append(rec)

        def _money(value) -> str:
            return f"${value:.2f}" if isinstance(value, (int, float)) else "-"

        def _line(row: dict) -> str:
            parts = [
                f"<b>{html.escape(row['ticker'])}</b>",
                _money(row.get("price")),
                html.escape(str(row.get("grade") or "")),
                html.escape(str(row.get("level") or "")),
            ]
            head = " ".join(p for p in parts if p and p != "-")
            setup = html.escape(str(row.get("setup") or "").replace("_", " "))
            risk = (
                f"watch {_money(row.get('entry'))} / stop {_money(row.get('stop'))} / "
                f"T1 {_money(row.get('t1'))}"
            )
            rr = row.get("rr")
            if isinstance(rr, (int, float)):
                risk += f" / R:R {rr:.2f}x"
            trigger = html.escape(str(row.get("trigger") or ""))[:180]
            return f"{head}\n   {setup} - {risk}\n   {trigger}"

        def _block(title: str, rows: list[dict]) -> str:
            if not rows:
                return f"<b>{title} (0)</b>\n-"
            rows.sort(key=lambda r: (-(r.get("rr") or 0), str(r.get("ticker") or "")))
            return f"<b>{title} ({len(rows)})</b>\n" + "\n\n".join(_line(r) for r in rows[:12])

        msg = (
            f"🎯 <b>Post-Market Sweep Setups - {today_str()}</b>\n"
            f"Watchlists: {html.escape(', '.join(watchlists))}\n\n"
            f"{_block('Sweep Reclaim Long', longs)}\n\n"
            f"{_block('Sweep Reclaim Short', shorts)}"
        )
        send_telegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, msg)
        logger.info(
            "[scheduler] sweep digest sent: %s long / %s short from %s tickers",
            len(longs),
            len(shorts),
            len(seen),
        )
    except Exception as e:
        logger.error(f"[scheduler] sweep digest failed: {e}")


def holdings_summary_job():
    """Post-market: email and Telegram a focused holdings scanner summary."""
    if not _HOLDINGS_SUMMARY_ENABLED:
        logger.info("[scheduler] holdings summary skipped: HOLDINGS_SUMMARY_ENABLED=0")
        return

    import html
    from concurrent.futures import ThreadPoolExecutor, as_completed

    try:
        from backend.db.holdings_store import get_holdings_tickers
        from backend.services.email_svc import send_email
        from backend.services.scanner import scan_single

        tickers = get_holdings_tickers()
        if not tickers:
            logger.info("[scheduler] holdings summary skipped: holdings list is empty")
            return

        try:
            workers = int(os.getenv("HOLDINGS_SCAN_MAX_WORKERS", "5"))
        except ValueError:
            workers = 5
        workers = max(1, min(len(tickers), workers))

        by_ticker: dict[str, dict] = {}
        with ThreadPoolExecutor(max_workers=workers) as pool:
            # longterm mode keeps fundamentals/long-term context and skips
            # day-trading and options work. Swing + Fib fields are still built.
            futures = {pool.submit(scan_single, t, None, None, "longterm"): t for t in tickers}
            for fut in as_completed(futures):
                ticker = futures[fut]
                try:
                    by_ticker[ticker] = fut.result()
                except Exception as exc:
                    by_ticker[ticker] = {"ticker": ticker, "error": str(exc)[:120], "score": 0}
        rows = [by_ticker.get(t, {"ticker": t, "error": "scan missing", "score": 0}) for t in tickers]

        def _money(v) -> str:
            return f"${float(v):.2f}" if isinstance(v, (int, float)) else "-"

        def _pct(v) -> str:
            return f"{float(v):.2f}%" if isinstance(v, (int, float)) else "-"

        def _txt(v) -> str:
            return html.escape(str(v if v is not None else "-"))

        def _color_for_verdict(verdict: str) -> str:
            v = (verdict or "").upper()
            if "BULLISH" in v:
                return "#047857"
            if "BEARISH" in v or "SHORT" in v:
                return "#dc2626"
            return "#6b7280"

        def _color_for_status(status: str) -> str:
            return {
                "Actionable": "#047857",
                "PreBO": "#b45309",
                "BTD Trigger": "#0f766e",
                "Rank 1": "#2563eb",
                "Watch": "#6b7280",
                "Error": "#dc2626",
            }.get(status, "#6b7280")

        def _zone_style(zone: str) -> str:
            z = (zone or "").upper()
            if z in {"", "-", "NONE", "N/A"}:
                return "color:#6b7280;background:#f3f4f6;border:1px solid #e5e7eb;"
            if z == "LOW":
                return "color:#047857;background:#ecfdf5;border:1px solid #a7f3d0;"
            if z == "HIGH":
                return "color:#dc2626;background:#fef2f2;border:1px solid #fecaca;"
            if z:
                return "color:#92400e;background:#fffbeb;border:1px solid #fde68a;"
            return "color:#6b7280;background:#f3f4f6;border:1px solid #e5e7eb;"

        def _badge(label: str, color: str) -> str:
            return (
                f"<span style=\"display:inline-block;border-radius:4px;padding:2px 6px;"
                f"font-weight:700;color:{color};background:#f9fafb;border:1px solid #e5e7eb;\">"
                f"{html.escape(label)}</span>"
            )

        def _zone_badge(prefix: str, zone: str) -> str:
            value = html.escape(str(zone or "-"))
            return (
                f"<span style=\"display:inline-block;border-radius:4px;padding:2px 6px;"
                f"font-weight:700;{_zone_style(zone)}\">{html.escape(prefix)} {value}</span>"
            )

        def _entry_range(row: dict) -> str:
            entry = row.get("lre_entry")
            stop = row.get("lre_stop")
            if isinstance(entry, (int, float)) and isinstance(stop, (int, float)):
                lo = min(float(entry), float(stop))
                hi = max(float(entry), float(stop))
                return f"{_money(lo)} - {_money(hi)}"
            if isinstance(row.get("entry"), (int, float)) and isinstance(row.get("stop_loss"), (int, float)):
                lo = min(float(row["entry"]), float(row["stop_loss"]))
                hi = max(float(row["entry"]), float(row["stop_loss"]))
                return f"{_money(lo)} - {_money(hi)}"
            return "-"

        def _emas(row: dict) -> str:
            vals = [
                ("11", row.get("ema11")),
                ("20", row.get("ema20")),
                ("50", row.get("ema50")),
                ("200", row.get("ema200")),
            ]
            out = [f"EMA{k} {_money(v)}" for k, v in vals if isinstance(v, (int, float))]
            if isinstance(row.get("ema50_slope_pct"), (int, float)):
                sign = "+" if float(row["ema50_slope_pct"]) > 0 else ""
                out.append(f"50 slope {sign}{float(row['ema50_slope_pct']):.2f}%")
            return " | ".join(out) or "-"

        def _pw_levels(row: dict) -> str:
            parts: list[str] = []
            if isinstance(row.get("prev_week_high"), (int, float)):
                parts.append(f"PWH/L {_money(row.get('prev_week_high'))} / {_money(row.get('prev_week_low'))}")
            if isinstance(row.get("prev_month_high"), (int, float)):
                parts.append(f"PMH/L {_money(row.get('prev_month_high'))} / {_money(row.get('prev_month_low'))}")
            if isinstance(row.get("wk52_high"), (int, float)):
                parts.append(f"52wH/L {_money(row.get('wk52_high'))} / {_money(row.get('wk52_low'))}")
            return " | ".join(parts) or "-"

        def _long_term(row: dict) -> str:
            if row.get("error"):
                return html.escape(str(row.get("error") or "scan failed"))
            parts: list[str] = []
            if row.get("w30ma_curl"):
                parts.append(f"30wk MA curl {_money(row.get('w30ma'))}")
            if row.get("long_term_spring"):
                parts.append("Weekly spring")
            if row.get("lre_status") or row.get("lre_label"):
                label = " ".join(str(v) for v in (row.get("lre_status"), row.get("lre_label")) if v)
                entry = _money(row.get("lre_entry"))
                stop = _money(row.get("lre_stop"))
                risk = _pct(row.get("lre_risk_pct"))
                parts.append(f"{label} entry {entry} / stop {stop} / risk {risk}")
            entry_range = _entry_range(row)
            if entry_range != "-":
                parts.append(f"Entry range {entry_range}")
            emas = _emas(row)
            if emas != "-":
                parts.append(emas)
            pw = _pw_levels(row)
            if pw != "-":
                parts.append(pw)
            return html.escape("; ".join(parts) or "-")

        def _swing(row: dict) -> str:
            if row.get("error"):
                return "-"
            parts = [
                f"Entry {_money(row.get('entry'))}",
                f"Stop {_money(row.get('stop_loss'))}",
                f"T1 {_money(row.get('target1'))}",
            ]
            eta = row.get("t1_days_text") or row.get("t1_days")
            if eta:
                parts.append(f"ETA {eta}")
            if row.get("btd_state"):
                parts.append(f"BTD {row.get('btd_state')}")
            if row.get("swing_prebreakout"):
                parts.append(
                    f"PreBO {_pct(row.get('swing_prebreakout_dist_pct'))} under "
                    f"{_money(row.get('swing_prebreakout_level'))}"
                )
            return html.escape(" | ".join(parts))

        def _fib(row: dict) -> str:
            if row.get("error"):
                return "-"
            weekly = row.get("weekly_zone") or "-"
            earn = row.get("earn_zone") or "-"
            return html.escape(f"Wk {weekly} | Earn {earn}")

        def _status(row: dict) -> str:
            if row.get("error"):
                return "Error"
            if row.get("lre_status") in ("ACTIVE", "DISCOUNT"):
                return "Actionable"
            if row.get("swing_prebreakout"):
                return "PreBO"
            if row.get("btd_state") == "TRIGGER":
                return "BTD Trigger"
            if row.get("mtf_rank") == 1:
                return "Rank 1"
            return "Watch"

        errors = sum(1 for r in rows if r.get("error"))
        notable = sum(1 for r in rows if _status(r) in {"Actionable", "PreBO", "BTD Trigger", "Rank 1"})
        now = datetime.now(CST)
        subject = f"StockPulse Holdings Summary - {now:%Y-%m-%d}"

        html_rows = []
        for row in rows:
            status = _status(row)
            verdict = str(row.get("verdict") or "-")
            html_rows.append(
                "<tr>"
                f"<td style=\"border:1px solid #e5e7eb;padding:8px;vertical-align:top;\"><b>{_txt(str(row.get('ticker') or '').upper())}</b></td>"
                f"<td style=\"border:1px solid #e5e7eb;padding:8px;vertical-align:top;text-align:right;font-family:Consolas,monospace;\">{_money(row.get('price'))}</td>"
                f"<td style=\"border:1px solid #e5e7eb;padding:8px;vertical-align:top;\">{_badge(verdict, _color_for_verdict(verdict))}</td>"
                f"<td style=\"border:1px solid #e5e7eb;padding:8px;vertical-align:top;\">{_badge(status, _color_for_status(status))}</td>"
                f"<td style=\"border:1px solid #e5e7eb;padding:8px;vertical-align:top;\">{_long_term(row)}</td>"
                f"<td style=\"border:1px solid #e5e7eb;padding:8px;vertical-align:top;\">{_swing(row)}</td>"
                f"<td style=\"border:1px solid #e5e7eb;padding:8px;vertical-align:top;white-space:nowrap;\">"
                f"{_zone_badge('Wk', str(row.get('weekly_zone') or '-'))} "
                f"{_zone_badge('Earn', str(row.get('earn_zone') or '-'))}</td>"
                "</tr>"
            )

        html_body = f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="font-family:Arial,sans-serif;color:#111827;margin:0;padding:16px;background:#ffffff;">
  <h2 style="margin:0 0 6px 0;">StockPulse Holdings Summary</h2>
  <p style="color:#6b7280;font-size:12px;margin:0 0 14px 0;">{now:%Y-%m-%d %H:%M CT} &middot; {len(rows)} scanned &middot; {notable} notable &middot; {errors} errors</p>
  <table style="border-collapse:collapse;width:100%;font-size:13px;">
    <thead>
      <tr>
        <th style="background:#111827;color:#ffffff;text-align:left;padding:8px;border:1px solid #111827;">Ticker</th>
        <th style="background:#111827;color:#ffffff;text-align:left;padding:8px;border:1px solid #111827;">Price</th>
        <th style="background:#111827;color:#ffffff;text-align:left;padding:8px;border:1px solid #111827;">Verdict</th>
        <th style="background:#111827;color:#ffffff;text-align:left;padding:8px;border:1px solid #111827;">Status</th>
        <th style="background:#111827;color:#ffffff;text-align:left;padding:8px;border:1px solid #111827;">Long Term</th>
        <th style="background:#111827;color:#ffffff;text-align:left;padding:8px;border:1px solid #111827;">Swing</th>
        <th style="background:#111827;color:#ffffff;text-align:left;padding:8px;border:1px solid #111827;">Fib Zones</th>
      </tr>
    </thead>
    <tbody>
      {''.join(html_rows)}
    </tbody>
  </table>
</body>
</html>"""

        text_lines = [
            f"StockPulse Holdings Summary - {now:%Y-%m-%d %H:%M CT}",
            f"{len(rows)} scanned | {notable} notable | {errors} errors",
            "",
        ]
        for row in rows:
            text_lines.append(
                f"{str(row.get('ticker') or '').upper()} | {_money(row.get('price'))} | "
                f"{row.get('verdict') or '-'} | {_status(row)} | "
                f"LT: {html.unescape(_long_term(row))} | "
                f"Swing: {html.unescape(_swing(row))} | "
                f"Fib: {html.unescape(_fib(row))}"
            )
        text_body = "\n".join(text_lines)

        email_ok = True
        if _HOLDINGS_EMAIL_ENABLED:
            email_ok = send_email(subject, html_body, text_body)
            if not email_ok:
                logger.warning("[scheduler] holdings summary email send failed")

        telegram_ok = True
        if _HOLDINGS_TELEGRAM_ENABLED:
            blocks = [
                f"<b>{_txt(str(r.get('ticker') or '').upper())}</b> {_money(r.get('price'))} | "
                f"{_txt(r.get('verdict') or '-')} | {html.escape(_status(r))}\n"
                f"LT: {_long_term(r)}\n"
                f"Swing: {_swing(r)}\n"
                f"Fib: {_fib(r)}"
                for r in rows
            ]
            header = (
                f"<b>Holdings Summary - {now:%Y-%m-%d}</b>\n"
                f"{len(rows)} scanned | {notable} notable | {errors} errors"
            )
            chunks: list[str] = []
            current = header
            for block in blocks:
                if len(current) + len(block) + 2 > 3600 and current != header:
                    chunks.append(current)
                    current = "<b>Holdings Summary - continued</b>"
                current += "\n\n" + block
            chunks.append(current)
            for chunk in chunks:
                telegram_ok = send_telegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, chunk) and telegram_ok
            if not telegram_ok:
                logger.warning("[scheduler] holdings summary telegram send failed")

        logger.info(
            "[scheduler] holdings summary completed: %s scanned, %s notable, %s errors, email=%s, telegram=%s",
            len(rows),
            notable,
            errors,
            email_ok,
            telegram_ok,
        )
    except Exception as e:
        logger.error(f"[scheduler] holdings summary failed: {e}")


#: Watchlists scanned by the 8:00 AM CST news digest. Restricted to these
#: named lists only — short_squeeze and the dynamic TOS/Gmail list are
#: intentionally excluded to keep the digest focused and the scan cheap.
#: Counts (as of scanner.WATCHLISTS): default 50, tech 30, mega_cap 20,
#: momentum 20, etfs 56 — ~176 entries pre-dedupe, ~120 after dedupe.
NEWS_SCAN_LISTS: tuple[str, ...] = (
    "default", "tech", "mega_cap", "momentum", "etfs",
)


def news_summary_job(title: str = "News Digest", state_key: str = "news_summary"):
    """8:00 AM CST — scan a fixed set of watchlists (default/tech/mega_cap/
    momentum/etfs) and Telegram a Good/Bad news digest."""
    from backend.services.scanner import WATCHLISTS, ETF_SECTORS
    from backend.services.news_sentiment import get_news_details
    from concurrent.futures import ThreadPoolExecutor, as_completed

    # Known ETF universe: explicit ETF watchlist + sector/index ETF map.
    etf_set = set(WATCHLISTS.get("etfs", [])) | set(ETF_SECTORS.keys())

    # Union of the configured watchlists only, deduped (preserves order).
    tickers: list[str] = []
    seen: set = set()
    list_counts: list[str] = []
    for key in NEWS_SCAN_LISTS:
        lst = WATCHLISTS.get(key, [])
        added = 0
        for t in lst:
            if t not in seen:
                seen.add(t)
                tickers.append(t)
                added += 1
        list_counts.append(f"{key}={len(lst)}(+{added} new)")

    logger.info(
        f"[scheduler] news summary: scanning {len(tickers)} unique tickers "
        f"from {len(NEWS_SCAN_LISTS)} lists [{', '.join(list_counts)}]"
    )

    import html

    def _scan_with_news(ticker: str) -> dict:
        try:
            details = get_news_details(ticker)
            return {
                "ticker": ticker,
                "news": details.get("label", "No"),
                "news_good": details.get("good_score", 0) or 0,
                "news_bad": details.get("bad_score", 0) or 0,
                "news_headlines": details.get("headlines") or [],
                "verdict": "News",
            }
        except Exception as exc:
            logger.debug(f"[scheduler] news lookup failed for {ticker}: {exc}")
            row = {"ticker": ticker, "news": "No", "verdict": "News"}
        row["_news_checked"] = True
        return row

    good: list[dict] = []
    bad:  list[dict] = []
    with ThreadPoolExecutor(max_workers=_NEWS_DIGEST_MAX_WORKERS) as pool:
        futures = {pool.submit(_scan_with_news, t): t for t in tickers}
        for fut in as_completed(futures):
            try:
                r = fut.result()
            except Exception:
                continue
            label = r.get("news")
            g = r.get("news_good", 0) or 0
            b = r.get("news_bad", 0) or 0
            headlines = r.get("news_headlines") or []

            if label not in ("Good", "Bad"):
                continue
            rec = {
                "ticker":  r["ticker"],
                "price":   r.get("price"),
                "verdict": r.get("verdict", "—"),
                "g": g, "b": b, "net": g - b,
                "is_etf":  r["ticker"].upper() in etf_set,
                "headlines": headlines,
            }
            (good if label == "Good" else bad).append(rec)

    good.sort(key=lambda x: -x["net"])   # most net-positive first
    bad.sort(key=lambda x:  x["net"])    # most net-negative first

    def _detail(rows: list[dict], n: int = 3) -> str:
        if not rows:
            return "—"
        blocks = []
        for x in rows[:n]:
            net = x["net"]
            px = f"${x['price']:.2f}" if isinstance(x.get("price"), (int, float)) else ""
            head = (
                f"<b>{html.escape(x['ticker'])}</b> {px} · "
                f"{html.escape(str(x['verdict']))} · "
                f"+{x['g']}/-{x['b']} (Σ{'+' if net >= 0 else ''}{net})"
            )
            hls = []
            for hd in x["headlines"][:6]:    # over-fetch — we filter empties
                text = (hd.get("h") or "").strip()
                if not text:
                    continue              # never render a bare bubble
                ic  = "🟢" if hd.get("s") == "Good" else "🔴" if hd.get("s") == "Bad" else "⚪"
                src = f" — {html.escape(hd['src'])}" if hd.get("src") else ""
                hls.append(f"   {ic} {html.escape(text)}{src}")
                if len(hls) >= 3:
                    break
            blocks.append(head + ("\n" + "\n".join(hls) if hls else ""))
        return "\n\n".join(blocks)

    def _split(rows: list[dict]) -> tuple[list[dict], list[dict]]:
        return ([x for x in rows if not x["is_etf"]],
                [x for x in rows if x["is_etf"]])

    g_stk, g_etf = _split(good)
    b_stk, b_etf = _split(bad)

    msg = (
        f"📰 <b>News Digest — {today_str()}</b>\n"
        f"Scanned {len(tickers)} tickers · top 3 each\n\n"
        f"🟢 <b>Good — Stocks ({len(g_stk)})</b>\n{_detail(g_stk)}\n\n"
        f"🟢 <b>Good — ETFs ({len(g_etf)})</b>\n{_detail(g_etf)}\n\n"
        f"🔴 <b>Bad — Stocks ({len(b_stk)})</b>\n{_detail(b_stk)}\n\n"
        f"🔴 <b>Bad — ETFs ({len(b_etf)})</b>\n{_detail(b_etf)}"
    )
    if title != "News Digest":
        msg = msg.replace("<b>News Digest", f"<b>{html.escape(title)}", 1)
    sent_ok = send_telegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, msg)
    if sent_ok:
        _mark_daily_job_sent(state_key)
    else:
        logger.warning("[scheduler] news summary telegram send failed")
    # Diagnostic: count non-empty headlines actually rendered so we can spot
    # the "white bubbles, no text" regression at a glance.
    _hl_total = sum(
        1
        for rec in (good + bad)
        for hd in rec.get("headlines", [])[:6]
        if (hd.get("h") or "").strip()
    )
    logger.info(
        f"[scheduler] news summary completed: telegram={sent_ok} "
        f"{len(good)} good / {len(bad)} bad "
        f"(top 3 each with details) — {_hl_total} headline lines rendered"
    )


def post_market_news_summary_job():
    """After market close: send the Good/Bad news digest again."""
    news_summary_job("Post-Market News Digest", state_key="news_summary_post_market")


def schedule_news_summary_startup_catchup():
    """Queue one catch-up morning digest if the app starts after 8:00 CST."""
    if not _NEWS_DIGEST_CATCHUP_ENABLED:
        return
    now = datetime.now(CST)

    morning_at = now.replace(hour=8, minute=0, second=0, microsecond=0)
    cutoff_at = now.replace(hour=15, minute=30, second=0, microsecond=0)
    if not (morning_at <= now < cutoff_at):
        return

    day = now.date().isoformat()
    if _daily_job_sent("news_summary", day):
        logger.info("[scheduler] news summary catch-up skipped: already sent for %s", day)
        return

    run_at = now + timedelta(seconds=20)
    scheduler.add_job(
        news_summary_job,
        DateTrigger(run_date=run_at, timezone=CST),
        id="news_summary_startup_catchup",
        replace_existing=True,
        misfire_grace_time=3600,
        kwargs={"title": "News Digest (Catch-up)", "state_key": "news_summary"},
    )
    logger.info(
        "[scheduler] news summary catch-up queued for %s (missed 08:00 CST)",
        run_at.isoformat(),
    )


def telegram_watchlist_job():
    """7:15 PM CST — pull the day's tickers from the TOS scan email (Gmail)."""
    try:
        from backend.services.gmail_watchlist import (
            poll_and_store, fetch_today_watchlist,
        )
        n = poll_and_store()
        tickers = fetch_today_watchlist()
        logger.info(
            f"[scheduler] TOS/Gmail watchlist pull: {n} new email(s), "
            f"{len(tickers)} ticker(s) active"
        )
    except Exception as e:
        logger.error(f"[scheduler] TOS/Gmail watchlist pull failed: {e}")


def sector_gamma_job():
    """After open/close on trading days: recompute all sector GEX so the
    per-sector daily streak is recorded even when no one has the UI open."""
    try:
        from backend.services.gex import compute_sector_gex
        res = compute_sector_gex()
        secs = res.get("sectors", [])
        avail = [s for s in secs if s.get("available")]
        longg = sum(1 for s in avail if s.get("regime") == "Long Gamma")
        shortg = sum(1 for s in avail if s.get("regime") == "Short Gamma")
        logger.info(
            f"[scheduler] sector gamma: {len(avail)}/{len(secs)} available "
            f"({longg} long, {shortg} short) — streaks recorded"
        )
    except Exception as e:
        logger.error(f"[scheduler] sector gamma job failed: {e}")


def spy_gamma_job():
    """After open/close on trading days: recompute SPY GEX so the daily sign is
    recorded (and the consecutive-day streak advances) even when nobody has
    the UI open. Without this, SPY's streak pins at ±1 because its sign is
    only written opportunistically on UI hits (sectors already have a job)."""
    try:
        from backend.services.gex import compute_spy_gex
        g = compute_spy_gex()
        if g.get("available"):
            logger.info(
                f"[scheduler] SPY gamma: {g.get('regime')} "
                f"net={g.get('net_gex')} streak={g.get('streak')} "
                f"store={g.get('store')} — sign recorded"
            )
        else:
            logger.warning(
                f"[scheduler] SPY gamma unavailable: "
                f"{g.get('reason', 'unknown')} — sign NOT recorded today"
            )
    except Exception as e:
        logger.error(f"[scheduler] SPY gamma job failed: {e}")


def stop_eps_polling():
    """6:00 PM CST — remove the polling job."""
    job = scheduler.get_job("eps_poll")
    if job:
        job.remove()
        send_telegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
                      f"🛑 EPS polling stopped for {today_str()}")
        logger.info("[scheduler] EPS polling stopped")


# ── Macro regime watcher ────────────────────────────────────────────────────
# Mirrors MarketRisk.tsx dayVerdict() so the alert text reflects exactly what
# the user sees in the UI. Two separate transitions are tracked:
#   - "verdict": Day to Buy / Wait for pullback / Sideline / Day to Sell
#   - "gamma":   γ Long Gamma / Short Gamma / Near Flip
# Persisted to chatgpt/backend/db/macro_state.json (gitignored). A 5-min
# inter-alert cooldown absorbs Near-Flip whipsaw on the boundaries.

_MACRO_STATE_PATH = os.path.join(
    os.path.dirname(__file__), "..", "db", "macro_state.json",
)
_MACRO_ALERT_COOLDOWN_SEC = 300  # 5 min between alerts of any kind


def _compute_day_verdict(gex_regime, btd_state, btd_zone, risk_score):
    """Return (label, reason). Exact mirror of MarketRisk.tsx dayVerdict()."""
    # Sell triggers — any single warning sign wins
    sell_reasons: list[str] = []
    if gex_regime in ("Short Gamma", "Near Flip"):
        sell_reasons.append(f"γ {gex_regime}")
    if btd_state == "DISARMED":
        sell_reasons.append("BTD DISARMED")
    if (risk_score or 0) >= 3:
        sell_reasons.append(f"Risk {risk_score} (HIGH)")
    if sell_reasons:
        return "Day to Sell", "Sell bias — " + " · ".join(sell_reasons)

    pullback_or_trigger = (
        btd_state == "TRIGGER"
        or (btd_state == "ARMED"      and btd_zone == "dip 20–50EMA")
        or (btd_state == "ARMED-DEEP" and btd_zone == "deep dip <50EMA")
    )
    is_extended = btd_state == "ARMED" and btd_zone == "extended >20EMA"

    if gex_regime == "Long Gamma" and pullback_or_trigger and (risk_score or 0) <= 2:
        suffix = " · half size — deeper risk" if btd_state == "ARMED-DEEP" else ""
        return "Day to Buy", (
            f"Buy bias — γ Long Gamma · BTD {btd_state}/{btd_zone or '?'} "
            f"· Risk {risk_score}/MOD or better{suffix}"
        )
    if gex_regime == "Long Gamma" and is_extended and (risk_score or 0) <= 2:
        return "Wait for pullback", (
            f"Environment OK (γ Long Gamma · Risk {risk_score}) but BTD ARMED "
            "· extended >20EMA — no entry trigger. Wait for price to pull "
            "back to 20EMA."
        )
    return "Sideline", (
        f"Mixed — γ:{gex_regime or '?'} · BTD:{btd_state or '?'} "
        f"· Risk:{risk_score}"
    )


def _load_macro_state() -> dict:
    try:
        if os.path.exists(_MACRO_STATE_PATH):
            import json
            with open(_MACRO_STATE_PATH, "r", encoding="utf-8") as fh:
                return json.load(fh)
    except Exception as e:
        logger.warning(f"[macro_watch] state read failed: {e}")
    return {}


def _save_macro_state(state: dict) -> None:
    try:
        import json
        os.makedirs(os.path.dirname(_MACRO_STATE_PATH), exist_ok=True)
        with open(_MACRO_STATE_PATH, "w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2)
    except Exception as e:
        logger.warning(f"[macro_watch] state write failed: {e}")


def _verdict_emoji(label: str) -> str:
    return {
        "Day to Buy": "📈",
        "Wait for pullback": "⏳",
        "Sideline": "⏸",
        "Day to Sell": "📉",
    }.get(label, "📊")


def macro_regime_watch_job():
    """Poll the macro snapshot every 5 min during market hours; Telegram on
    verdict transitions and γ regime flips. State persisted across restarts."""
    if not _MACRO_ALERTS_ENABLED:
        return
    import html
    from datetime import datetime, timezone

    try:
        from backend.routers.macro import macro_snapshot
        snap = macro_snapshot()
    except Exception as e:
        logger.warning(f"[macro_watch] snapshot failed: {e}")
        return

    gex   = snap.get("gex") or {}
    btd   = snap.get("btd") or {}
    risk  = snap.get("risk") or {}
    gex_avail   = gex.get("available") is True
    gex_regime  = gex.get("regime") if gex_avail else None
    btd_state   = btd.get("btd_state")
    btd_zone    = btd.get("btd_zone")
    risk_score  = int(risk.get("score") or 0)
    risk_label  = risk.get("label") or "?"
    verdict, reason = _compute_day_verdict(
        gex_regime, btd_state, btd_zone, risk_score
    )

    state = _load_macro_state()
    prev_verdict = state.get("verdict")
    prev_gamma   = state.get("gex_regime")
    now_iso      = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # Detect transitions
    transitions: list[tuple[str, str, str]] = []
    if prev_verdict and verdict != prev_verdict:
        transitions.append(("Verdict", prev_verdict, verdict))
    if prev_gamma and gex_regime and gex_regime != prev_gamma:
        transitions.append(("γ regime", prev_gamma, gex_regime))

    if not transitions:
        # First run — seed state without alerting
        if not prev_verdict:
            state.update(
                verdict=verdict, gex_regime=gex_regime,
                btd_state=btd_state, btd_zone=btd_zone,
                risk_score=risk_score, last_changed_at=now_iso,
            )
            _save_macro_state(state)
        return

    # Cooldown — avoid whipsaw storms on Near-Flip boundaries
    last_alert_iso = state.get("last_alerted_at")
    if last_alert_iso:
        try:
            last = datetime.fromisoformat(last_alert_iso)
            age_s = (datetime.now(timezone.utc) - last).total_seconds()
            if age_s < _MACRO_ALERT_COOLDOWN_SEC:
                logger.info(
                    f"[macro_watch] transition detected but within "
                    f"{int(age_s)}s cooldown — suppressing"
                )
                # Still persist new state so the next outside-cooldown change
                # is detected against a fresh baseline.
                state.update(
                    verdict=verdict, gex_regime=gex_regime,
                    btd_state=btd_state, btd_zone=btd_zone,
                    risk_score=risk_score, last_changed_at=now_iso,
                )
                _save_macro_state(state)
                return
        except Exception:
            pass

    # Build alert
    spy_chg_1d = ""
    vix_now    = ""
    for it in snap.get("items", []):
        if it.get("ticker") == "SPY":
            spy_chg_1d = f"SPY {it.get('chg_1d', 0):+.1f}% 1d · 5d {it.get('chg_5d', 0):+.1f}%"
        elif it.get("ticker") == "^VIX":
            vix_now = f"VIX {it.get('price', 0):.1f} ({it.get('chg_1d', 0):+.1f}% 1d)"

    e_prev = _verdict_emoji(prev_verdict or "")
    e_curr = _verdict_emoji(verdict)
    lines = [f"<b>🚨 MARKET REGIME CHANGE</b>"]
    for kind, before, after in transitions:
        lines.append(
            f"<b>{html.escape(kind)}:</b> {html.escape(before)} → "
            f"<b>{html.escape(after)}</b>"
        )
    lines.append("")
    lines.append(f"{e_curr} <b>{html.escape(verdict)}</b>")
    lines.append(f"<i>{html.escape(reason)}</i>")
    if spy_chg_1d or vix_now:
        ctx = " · ".join(x for x in (spy_chg_1d, vix_now, risk_label) if x)
        lines.append(f"\n{html.escape(ctx)}")
    msg = "\n".join(lines)

    try:
        send_telegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, msg)
        logger.info(
            f"[macro_watch] alerted: {prev_verdict} → {verdict} "
            f"(γ {prev_gamma} → {gex_regime})"
        )
    except Exception as e:
        logger.warning(f"[macro_watch] telegram send failed: {e}")

    state.update(
        verdict=verdict, gex_regime=gex_regime,
        btd_state=btd_state, btd_zone=btd_zone,
        risk_score=risk_score,
        last_changed_at=now_iso, last_alerted_at=now_iso,
    )
    _save_macro_state(state)


def momentum_refresh_job():
    """Sunday 18:00 CST — re-screen the momentum universe and persist the
    top 20 to momentum_watchlist.json. Telegram a diff vs last week so the
    rotation is visible at a glance. WATCHLISTS["momentum"] auto-uses the
    new file (mtime-cached) on the next scan."""
    import html
    try:
        from backend.services.momentum_screener import (
            pick_momentum_top_n, save_momentum_list, load_momentum_list,
        )
        prev = load_momentum_list() or {}
        prev_set = set(prev.get("tickers") or [])

        result = pick_momentum_top_n(n=20)
        new_list = list(result.get("tickers") or [])
        new_set = set(new_list)
        if not new_set:
            err = result.get("error", "no candidates passed filters")
            logger.warning(f"[scheduler] momentum_refresh empty — {err}; keeping previous list")
            send_telegram(
                TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
                f"⚠️ Momentum refresh returned empty ({html.escape(str(err))}) — keeping previous list.",
            )
            return

        save_momentum_list(result)
        added   = sorted(new_set - prev_set)
        dropped = sorted(prev_set - new_set)
        scores  = result.get("scores", {})
        top5    = new_list[:5]
        top5_line = " · ".join(
            f"<b>{html.escape(t)}</b> +{scores.get(t, 0):.0f}%" for t in top5
        )
        msg = (
            f"📈 <b>Momentum list refreshed — {today_str()}</b>\n"
            f"<i>{result.get('passed_filters', '?')} of "
            f"{result.get('universe_size', '?')} candidates passed filters · "
            f"ranked by {result['criteria'].get('lookback_days', 63)}d return</i>\n"
            f"\nTop 5: {top5_line}\n"
        )
        if prev_set:   # only show diff if we have a previous run to compare
            msg += (
                f"\n<b>Added:</b>   {', '.join(html.escape(t) for t in added)   or '—'}"
                f"\n<b>Dropped:</b> {', '.join(html.escape(t) for t in dropped) or '—'}"
            )
        msg += f"\n\n<b>Full list:</b> {', '.join(html.escape(t) for t in new_list)}"
        send_telegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, msg)
        logger.info(
            f"[scheduler] momentum_refresh: wrote {len(new_set)} tickers "
            f"(+{len(added)} -{len(dropped)})"
        )
    except Exception as e:
        logger.error(f"[scheduler] momentum_refresh failed: {e}")
        try:
            send_telegram(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
                          f"❌ Momentum refresh failed: {type(e).__name__}: {str(e)[:200]}")
        except Exception:
            pass


# ── Scheduler setup ───────────────────────────────────────────────────────────

def setup_scheduler():
    """
    Register all cron jobs and initialise the database.
    Call once at FastAPI startup.
    """
    init_db()
    init_watchlist()  # creates watchlist table if not exists

    if _EARNINGS_JOBS_ENABLED:
        scheduler.add_job(
            pre_earnings_job,
            CronTrigger(hour=8, minute=30, timezone=CST),
            id="pre_earnings",
            replace_existing=True,
            misfire_grace_time=300,
        )

    scheduler.add_job(
        news_summary_job,
        CronTrigger(hour=8, minute=0, timezone=CST),
        id="news_summary",
        replace_existing=True,
        misfire_grace_time=600,
    )

    scheduler.add_job(
        post_market_news_summary_job,
        CronTrigger(day_of_week="mon-fri", hour=15, minute=35, timezone=CST),
        id="news_summary_post_market",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    scheduler.add_job(
        momentum_scan_job,
        CronTrigger(hour=8, minute=45, timezone=CST),
        id="momentum_scan",
        replace_existing=True,
        misfire_grace_time=300,
    )

    scheduler.add_job(
        scanner_snapshot_job,
        CronTrigger(day_of_week="mon-fri", hour=15, minute=25, timezone=CST),
        id="scanner_snapshots_close",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    scheduler.add_job(
        sweep_digest_job,
        CronTrigger(day_of_week="mon-fri", hour=15, minute=40, timezone=CST),
        id="sweep_digest_close",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    scheduler.add_job(
        holdings_summary_job,
        CronTrigger(hour=15, minute=50, timezone=CST),
        id="holdings_summary_close",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    # Sunday 6 PM CST — re-screen the momentum universe and persist top 20.
    # Misfire grace 6h so a Sunday-evening service restart still gets it.
    scheduler.add_job(
        momentum_refresh_job,
        CronTrigger(day_of_week="sun", hour=18, minute=0, timezone=CST),
        id="momentum_refresh",
        replace_existing=True,
        misfire_grace_time=21600,
    )

    # Every 5 min Mon–Fri 08:00–15:55 CST — watch for verdict / γ regime
    # transitions and Telegram on change. Snapshot is 5-min-cached so this
    # is essentially free; no extra yfinance load.
    if _MACRO_ALERTS_ENABLED:
        scheduler.add_job(
            macro_regime_watch_job,
            CronTrigger(day_of_week="mon-fri",
                        hour="8-15", minute="*/5", timezone=CST),
            id="macro_regime_watch",
            replace_existing=True,
            misfire_grace_time=300,
        )

    if _EARNINGS_JOBS_ENABLED:
        scheduler.add_job(
            start_eps_polling,
            CronTrigger(hour=15, minute=0, timezone=CST),
            id="start_polling",
            replace_existing=True,
        )

        scheduler.add_job(
            stop_eps_polling,
            CronTrigger(hour=18, minute=0, timezone=CST),
            id="stop_polling",
            replace_existing=True,
        )

    scheduler.add_job(
        telegram_watchlist_job,
        CronTrigger(hour=19, minute=15, timezone=CST),  # 7:15 PM CST
        id="telegram_watchlist",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    schedule_news_summary_startup_catchup()

    # Gamma refreshes twice on trading days: after open and after close.
    # SPY runs a few minutes before sectors so provider calls are staggered.
    scheduler.add_job(
        sector_gamma_job,
        CronTrigger(day_of_week="mon-fri", hour=8, minute=40, timezone=CST),
        id="sector_gamma_open",
        replace_existing=True,
        misfire_grace_time=3600,
    )
    scheduler.add_job(
        sector_gamma_job,
        CronTrigger(day_of_week="mon-fri", hour=15, minute=10, timezone=CST),
        id="sector_gamma_close",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    # These writes persist to Neon when DATABASE_URL is configured.
    scheduler.add_job(
        spy_gamma_job,
        CronTrigger(day_of_week="mon-fri", hour=8, minute=37, timezone=CST),
        id="spy_gamma_open",
        replace_existing=True,
        misfire_grace_time=3600,
    )
    scheduler.add_job(
        spy_gamma_job,
        CronTrigger(day_of_week="mon-fri", hour=15, minute=7, timezone=CST),
        id="spy_gamma_close",
        replace_existing=True,
        misfire_grace_time=3600,
    )

    # Prime the store at startup so the watchlist isn't empty before the
    # first 7:15 PM CST pull.
    try:
        telegram_watchlist_job()
    except Exception as e:
        logger.warning(f"[scheduler] startup TOS/Gmail prime failed: {e}")

    _macro_w = "macro_regime_watch every 5m Mon-Fri 8-15:55CST" if _MACRO_ALERTS_ENABLED else "macro_regime_watch DISABLED"
    logger.info(
        f"[scheduler] registered: scanner_snapshots@15:25CST, sweep_digest@15:40CST, "
        f"holdings_summary@15:50CST daily, momentum_refresh@Sun18:00CST, {_macro_w}"
    )
    _earn = (
        "pre_earnings@8:30CST, polling 15:00–18:00 CST"
        if _EARNINGS_JOBS_ENABLED
        else "earnings jobs DISABLED (set EARNINGS_JOBS_ENABLED=1 to re-enable)"
    )
    logger.info(
        f"[scheduler] registered: news_summary@8:00CST, news_summary_post_market@15:35CST, {_earn}, "
        "momentum@8:45CST, tos_gmail_watchlist@19:15CST, "
        "spy_gamma + sector_gamma after open and after close Mon–Fri"
    )
