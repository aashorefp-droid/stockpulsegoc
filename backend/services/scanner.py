"""
Single-stock scan logic — reuses the full scoring pipeline.
Designed to be called in parallel from the scanner router.
"""
import logging
import os
import requests
import sys
import time
import yfinance as yf
import pandas as pd
from datetime import date, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Iterator, Optional

_scanner_logger = logging.getLogger(__name__)


# ── V3 Telegram alert (shared by scan_single + the v3-refresh router) ──────
# Daily-deduped: at most one alert per (ticker, setup_kind) per calendar day.
# Resets naturally when date.today() advances. Best-effort: errors swallowed
# (no telegram creds / network blip → just no alert, never crash the scan).
_V3_ALERT_LOG: dict[tuple[str, str], "date"] = {}


def _v3_qualifying_tier(row: dict) -> Optional[str]:
    """Map a row to the highest tier it satisfies: Exceptional > Actionable
    > Rank 1 > None. Matches the frontend filter tests on page.tsx so the
    Telegram alert only fires for setups that show up in those tabs."""
    if row.get("mtf_rank") != 1:
        return None
    if (row.get("entry_grade") in ("S", "A")
            and row.get("vol_trend") == "ACCUMULATING"):
        return "Exceptional"
    if row.get("lre_status") in ("ACTIVE", "DISCOUNT"):
        return "Actionable"
    return "Rank 1"


def _v3_alert_once(ticker: str, dt3: dict,
                   *, tier: Optional[str] = None) -> None:
    setup = (dt3.get("dt3_setup") or "").lower()
    if setup not in ("sweep_reclaim", "break_retest"):
        return
    side = (dt3.get("dt3_side") or "").lower()
    if side not in ("long", "short"):
        return
    if not tier:
        return  # not a qualifying row (not Rank 1+) — suppress alert
    key   = (ticker.upper(), setup)
    today = date.today()
    if _V3_ALERT_LOG.get(key) == today:
        return  # already alerted for this setup on this ticker today

    try:
        from backend.services.telegram_svc import send_telegram
        # Telegram creds: prefer env, fall back to root streamlit/config.py
        # via the chain that already powers backend.config (works locally;
        # on Render env vars must be set).
        tok  = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
        chat = os.getenv("TELEGRAM_CHAT_ID", "").strip()
        if not (tok and chat):
            try:
                _root = os.path.abspath(os.path.join(
                    os.path.dirname(__file__), "..", ".."))
                if _root not in sys.path:
                    sys.path.insert(0, _root)
                import importlib
                _cfg = importlib.import_module("config")
                tok  = tok  or str(getattr(_cfg, "TELEGRAM_BOT_TOKEN", "") or "")
                chat = chat or str(getattr(_cfg, "TELEGRAM_CHAT_ID",   "") or "")
            except Exception:
                pass
        if not (tok and chat):
            return  # no creds → silent skip

        import html
        arrow = "📈" if side == "long" else "📉"
        grade = dt3.get("dt3_grade")  or ""
        level = dt3.get("dt3_level")  or "?"
        lv    = dt3.get("dt3_level_val")
        entry = dt3.get("dt3_entry")
        stop  = dt3.get("dt3_stop")
        t1    = dt3.get("dt3_t1")
        t2    = dt3.get("dt3_t2")
        rr    = dt3.get("dt3_rr")
        rationale = html.escape((dt3.get("dt3_rationale") or "")[:240])

        def _m(v): return f"${v:.2f}" if isinstance(v, (int, float)) else "—"
        def _r(v): return f"{v}×" if v is not None else "—"

        msg = (
            f"<b>{arrow} V3 {html.escape(tier)} — "
            f"{html.escape(ticker.upper())}</b>\n"
            f"<i>{html.escape(setup.replace('_', '+'))} · {side} · "
            f"{html.escape(str(grade))}</i>\n"
            f"Lvl: {html.escape(str(level))} {_m(lv)}\n"
            f"Entry: {_m(entry)}  Stop: {_m(stop)}\n"
            f"T1: {_m(t1)}  T2: {_m(t2)}  R:R: {_r(rr)}\n"
            f"\n<i>{rationale}</i>"
        )
        send_telegram(tok, chat, msg)
        _V3_ALERT_LOG[key] = today
        _scanner_logger.info(
            f"[scanner] V3 alert sent: {ticker} {setup} {side}"
        )
    except Exception as e:
        _scanner_logger.warning(
            f"[scanner] V3 alert failed for {ticker}: "
            f"{type(e).__name__}: {str(e)[:120]}"
        )

from backend.services.analysis import (
    full_score_pipeline, get_entry_grade, calc_trade_levels,
    compute_weekly_bias, compute_daily_bias, compute_4h_bias,
    mtf_signal_action, calc_atr, calc_weekly_atr, compute_seasonality,
    get_fundamentals, compute_btd, compute_w30, _col,
)
from backend.services.market_data import alpaca_get, get_daily_bars_alpaca, get_five_min_bars_alpaca
from backend.services.options import get_options_strategy, get_options_bias
from backend.config import ALPACA_API_KEY, ALPACA_API_SECRET


def _env_enabled(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


_SCAN_INCLUDE_EARNINGS = _env_enabled("SCANNER_INCLUDE_EARNINGS")
_SCAN_INCLUDE_NEWS = _env_enabled("SCANNER_INCLUDE_NEWS")
_SCAN_INCLUDE_OPTIONS = _env_enabled("SCANNER_INCLUDE_OPTIONS", "1")
_SCAN_FIB_USE_EARNINGS = _env_enabled("SCANNER_FIB_USE_EARNINGS", "1")

# Options enabled but no Alpaca creds → every options call will silently
# return None. Log once at startup so the empty Options column has a
# visible cause instead of being a mystery.
if _SCAN_INCLUDE_OPTIONS and not (ALPACA_API_KEY and ALPACA_API_SECRET):
    import logging as _opt_log
    _opt_log.getLogger(__name__).warning(
        "[scanner] SCANNER_INCLUDE_OPTIONS=1 but ALPACA_API_KEY / "
        "ALPACA_API_SECRET are unset in this process — Options column will "
        "be empty for every ticker. Restart from bounce.bat after editing "
        "it, or set SCANNER_INCLUDE_OPTIONS=0 to silence."
    )
_SCAN_INCLUDE_SHORT_FLOAT = _env_enabled("SCANNER_INCLUDE_SHORT_FLOAT")
_DAY_TRADING_V3_ENABLED = _env_enabled("DAY_TRADING_V3_ENABLED", "1")
_DAY_TRADING_V4_ENABLED = _env_enabled("DAY_TRADING_V4_ENABLED", "1")

# ── Watchlists ────────────────────────────────────────────────────────────────

class _WatchlistsDict(dict):
    """dict subclass that transparently overrides WATCHLISTS["momentum"]
    with the auto-refreshed JSON (written weekly by momentum_refresh_job)
    when present. Falls back to the hardcoded list otherwise. Mtime-cached
    so hot-path scans don't hit disk on every access."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self._momentum_cache: tuple[float, list[str]] | None = None

    def _momentum_override(self) -> list[str] | None:
        try:
            from backend.services.momentum_screener import (
                JSON_PATH, load_momentum_list,
            )
            if not JSON_PATH.exists():
                return None
            mtime = JSON_PATH.stat().st_mtime
            if self._momentum_cache and self._momentum_cache[0] == mtime:
                return self._momentum_cache[1]
            data = load_momentum_list() or {}
            tickers = list(data.get("tickers") or [])
            if not tickers:
                return None
            self._momentum_cache = (mtime, tickers)
            return tickers
        except Exception:
            return None

    def __getitem__(self, key):
        if key == "momentum":
            override = self._momentum_override()
            if override is not None:
                return override
        return super().__getitem__(key)

    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default


WATCHLISTS: dict[str, list[str]] = _WatchlistsDict({
    "default": [
        "AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA", "AMD", "NFLX", "CRM",
        "ORCL", "ADBE", "INTC", "PYPL", "XYZ", "SHOP", "COIN", "UBER", "ABNB", "SNOW",
        "BA", "CAT", "GS", "JPM", "V", "MA", "DIS", "NKE", "SBUX", "MCD",
        "XOM", "CVX", "PFE", "JNJ", "UNH", "MRNA", "LLY", "ABBV", "BMY", "MRK",
        "SPY", "QQQ", "DIA", "XLF", "XLE", "XLK", "ARKK", "SOXX", "SMH", "MRVL",
    ],
    "tech": [
        "AAPL", "MSFT", "NVDA", "GOOGL", "META", "AMD", "TSLA", "ORCL", "ADBE", "CRM",
        "INTC", "QCOM", "TXN", "MU", "AMAT", "LRCX", "KLAC", "MRVL", "AVGO", "ARM",
        "PLTR", "SNOW", "DDOG", "ZS", "CRWD", "NET", "MDB", "SMCI", "DELL", "HPE",
    ],
    "mega_cap": [
        "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO", "LLY", "JPM",
        "V", "UNH", "XOM", "MA", "JNJ", "PG", "HD", "COST", "MRK", "ABBV",
    ],
    "etfs": [
        "XLB", "XLC", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV",
        "XLY", "VAW", "VOX", "VDE", "VFH", "VIS", "VGT", "VDC", "VNQ", "VPU",
        "VHT", "VCR", "RTM", "IXE", "KBE", "ITA", "IYW", "KXI", "REZ", "IDU",
        "IXJ", "RXI", "GLD", "SLV", "DBMF", "HFGM", "CTA", "PPI", "UUP", "TLT",
        "JPST", "BIL", "SHY", "SCHD", "VXUS", "VTI", "IEMG", "SPY", "QQQ", "USMV",
        "SPLV", "GLDM", "TIP", "VTIP", "SCHP", "RINF",
    ],
    "momentum": [
        "NVDA", "MRVL", "AVGO", "ARM", "PLTR", "CRWD", "DDOG", "NET", "SMCI",
        "TSLA", "META", "AMZN", "GOOGL", "MSFT", "AMD", "SNOW", "ZS", "SHOP", "COIN", "UBER",
    ],
    # Fallback only — overridden at runtime by get_short_squeeze_tickers()
    "short_squeeze": [
        "TSLA", "COIN", "RIVN", "LCID", "NKLA", "BBAI", "SOUN", "MSTR", "IONQ",
        "SMCI", "BYND", "SPCE", "RIDE", "WKHS", "FFIE", "MULN", "ASTS", "RKLB",
        "ACHR", "JOBY", "LILM", "CLOV", "WISH", "SKLZ", "DKNG", "PLBY", "CVNA",
        "GME", "AMC", "BBBY", "KOSS", "EXPR",
    ],
})

SWING_UNIVERSE_PRESETS: dict[str, dict] = {
    "nyse_swing": {"exchange": "NYSE", "min_price": 10.0, "min_volume": 0, "limit": 200},
    "nasdaq_swing": {"exchange": "NASDAQ", "min_price": 10.0, "min_volume": 0, "limit": 200},
}
_SWING_UNIVERSE_CACHE: dict[str, tuple[float, list[str]]] = {}


def _plain_stock_symbol(symbol: str) -> bool:
    return bool(symbol) and symbol.isalpha()


def _dedupe_symbols(symbols: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in symbols:
        sym = str(raw or "").strip().upper()
        if sym and sym not in seen and _plain_stock_symbol(sym):
            seen.add(sym)
            out.append(sym)
    return out


def _alpaca_asset_symbols(exchange: str) -> list[str]:
    if not (ALPACA_API_KEY and ALPACA_API_SECRET):
        return []
    headers = {
        "APCA-API-KEY-ID": ALPACA_API_KEY,
        "APCA-API-SECRET-KEY": ALPACA_API_SECRET,
    }
    params = {"status": "active", "asset_class": "us_equity"}
    if exchange:
        params["exchange"] = exchange
    r = requests.get("https://api.alpaca.markets/v2/assets", params=params, headers=headers, timeout=20)
    r.raise_for_status()
    assets = r.json() or []
    symbols = [
        a.get("symbol", "")
        for a in assets
        if a.get("tradable") and a.get("status") == "active"
    ]
    return _dedupe_symbols(symbols)


def _alpaca_ranked_swing_universe(exchange: str, min_price: float, min_volume: int, limit: int) -> list[str]:
    symbols = _alpaca_asset_symbols(exchange)
    if not symbols:
        return []
    ranked: list[tuple[int, str]] = []
    for start in range(0, len(symbols), 100):
        batch = symbols[start:start + 100]
        try:
            data = alpaca_get(
                "/v2/stocks/snapshots",
                {"symbols": ",".join(batch), "feed": "iex"},
                ALPACA_API_KEY,
                ALPACA_API_SECRET,
            )
        except Exception:
            continue
        raw_snaps = data.get("snapshots") if isinstance(data, dict) else {}
        snaps = raw_snaps if isinstance(raw_snaps, dict) and raw_snaps else data
        if not isinstance(snaps, dict):
            snaps = {}
        batch_set = {s.upper() for s in batch}
        for sym, snap in snaps.items():
            if str(sym).upper() not in batch_set or not isinstance(snap, dict):
                continue
            daily = snap.get("dailyBar") or {}
            trade = snap.get("latestTrade") or {}
            price = trade.get("p") or daily.get("c") or 0
            volume = daily.get("v") or 0
            try:
                if float(price) >= min_price and int(volume) >= min_volume:
                    ranked.append((int(volume), str(sym).upper()))
            except Exception:
                continue
    ranked.sort(reverse=True)
    return _dedupe_symbols([sym for _, sym in ranked])[:limit]


def _yahoo_ranked_swing_universe(exchange: str, min_price: float, min_volume: int, limit: int) -> list[str]:
    exchange_codes = {
        "NYSE": {"NYQ"},
        "NASDAQ": {"NMS", "NGM", "NCM", "NAS"},
    }.get(exchange.upper(), set())
    headers = {"User-Agent": "Mozilla/5.0"}
    tickers: list[str] = []
    for offset in range(0, 1000, 250):
        body = {
            "offset": offset,
            "size": 250,
            "sortField": "regularMarketVolume",
            "sortType": "DESC",
            "quoteType": "EQUITY",
            "query": {
                "operator": "AND",
                "operands": [
                    {"operator": "EQ", "operands": ["region", "us"]},
                    {"operator": "GT", "operands": ["regularMarketPrice", min_price]},
                    {"operator": "GT", "operands": ["regularMarketVolume", min_volume]},
                ],
            },
            "userId": "",
            "userIdType": "guid",
        }
        try:
            r = requests.post("https://query1.finance.yahoo.com/v1/finance/screener", json=body, headers=headers, timeout=15)
            r.raise_for_status()
            quotes = (r.json().get("finance", {}).get("result") or [{}])[0].get("quotes") or []
        except Exception:
            break
        if not quotes:
            break
        for q in quotes:
            sym = str(q.get("symbol") or "").upper()
            exch = str(q.get("exchange") or "").upper()
            if exchange_codes and exch not in exchange_codes:
                continue
            tickers.append(sym)
            if len(_dedupe_symbols(tickers)) >= limit:
                return _dedupe_symbols(tickers)[:limit]
    return _dedupe_symbols(tickers)[:limit]


def get_swing_universe_tickers(watchlist: str) -> list[str]:
    key = (watchlist or "").strip().lower()
    preset = SWING_UNIVERSE_PRESETS.get(key)
    if not preset:
        return []
    ttl = 3600
    now = time.time()
    cached = _SWING_UNIVERSE_CACHE.get(key)
    if cached and now - cached[0] < ttl:
        return list(cached[1])

    exchange = str(preset["exchange"])
    min_price = float(preset["min_price"])
    min_volume = int(preset["min_volume"])
    limit = int(preset["limit"])
    tickers: list[str] = []
    try:
        tickers = _alpaca_ranked_swing_universe(exchange, min_price, min_volume, limit)
    except Exception as exc:
        _scanner_logger.warning("[scanner] %s Alpaca universe failed: %s", key, str(exc)[:120])
    if not tickers:
        try:
            tickers = _yahoo_ranked_swing_universe(exchange, min_price, min_volume, limit)
        except Exception as exc:
            _scanner_logger.warning("[scanner] %s Yahoo universe failed: %s", key, str(exc)[:120])
    if tickers:
        _SWING_UNIVERSE_CACHE[key] = (now, tickers)
    return tickers


ETF_SECTORS: dict[str, str] = {
    "XLB": "Materials", "VAW": "Materials", "RTM": "Materials",
    "XLC": "Communication", "VOX": "Communication",
    "XLE": "Energy", "VDE": "Energy", "IXE": "Energy",
    "XLF": "Financials", "VFH": "Financials", "KBE": "Banks",
    "XLI": "Industrials", "VIS": "Industrials", "ITA": "Aerospace",
    "XLK": "Technology", "VGT": "Technology", "IYW": "Technology", "QQQ": "Nasdaq 100",
    "XLP": "Staples", "VDC": "Staples", "KXI": "Staples",
    "XLRE": "Real Estate", "VNQ": "Real Estate", "REZ": "Real Estate",
    "XLU": "Utilities", "VPU": "Utilities", "IDU": "Utilities",
    "XLV": "Health Care", "VHT": "Health Care", "IXJ": "Health Care",
    "XLY": "Discretionary", "VCR": "Discretionary", "RXI": "Discretionary",
    "DIA": "Dow 30", "IWM": "Russell 2000",
    "ARKK": "Innovation", "SOXX": "Semiconductors", "SMH": "Semiconductors",
    "GLD": "Gold", "GLDM": "Gold", "SLV": "Silver",
    "DBMF": "Managed Futures", "CTA": "Managed Futures", "HFGM": "Alternatives",
    "PPI": "Inflation", "RINF": "Inflation",
    "UUP": "US Dollar",
    "TLT": "Treasury", "JPST": "Short Bond", "BIL": "T-Bills", "SHY": "Treasury",
    "TIP": "TIPS", "VTIP": "Short TIPS", "SCHP": "TIPS",
    "SCHD": "Dividend", "VXUS": "International", "IEMG": "Emerging Markets",
    "VTI": "US Total Market", "SPY": "S&P 500", "USMV": "Low Volatility", "SPLV": "Low Volatility",
}


def _sector_for_ticker(ticker: str, info: Optional[dict] = None) -> str:
    symbol = (ticker or "").upper()
    if symbol in ETF_SECTORS:
        return ETF_SECTORS[symbol]
    info = info or {}
    sector = info.get("sector") or info.get("category") or info.get("industry")
    if sector:
        return str(sector)
    if info.get("quoteType") == "ETF":
        return "ETF"
    return "Unknown"


def _is_etf_symbol(ticker: str) -> bool:
    return (ticker or "").upper() in ETF_SECTORS


def _etf_fundamentals(ticker: str, price: float) -> dict:
    sector = _sector_for_ticker(ticker)
    return {
        "name": ticker,
        "sector": sector,
        "industry": "ETF",
        "market_cap": "N/A",
        "price": price,
        "target_mean_price": None,
        "pe_ratio": "N/A",
        "forward_pe": "N/A",
        "price_to_book": "N/A",
        "price_to_sales": "N/A",
        "enterprise_to_revenue": "N/A",
        "enterprise_to_ebitda": "N/A",
        "eps": "N/A",
        "profit_margin": None,
        "dividend_yield": None,
        "52w_high": "N/A",
        "52w_low": "N/A",
        "avg_volume": "N/A",
        "beta": "N/A",
        "description": f"{ticker} ETF / fund.",
    }


# ── Live short-squeeze fetcher ─────────────────────────────────────────────────

def get_telegram_watchlist() -> list[str]:
    """
    Tickers from the ThinkOrSwim scan email (TOS → Gmail), refreshed every
    Saturday by the scheduler ~7:15 PM CST and on-demand via Hard pull.
    (Name kept for wiring stability; source is now Gmail, not Telegram.)
    Falls back to the default watchlist if the store is empty.
    """
    try:
        from backend.services.gmail_watchlist import fetch_today_watchlist
        tickers = fetch_today_watchlist()
        if tickers:
            return tickers
    except Exception as e:
        print(f"⚠️ TOS/Gmail watchlist fetch failed: {e}")
    return WATCHLISTS["default"]


def get_earnings_watchlist() -> list[str]:
    """Today's earnings scanner tickers, placeholder table first, then discovery."""
    try:
        from backend.db.earnings_tracker import today_str
        from backend.services.earnings import find_earnings_reporters

        return find_earnings_reporters(today_str())
    except Exception as e:
        print(f"⚠️ Earnings watchlist fetch failed: {e}")
    return []


def get_short_squeeze_tickers(min_short_pct: float = 10.0, limit: int = 40) -> list[str]:
    """
    Pull US stocks sorted by short % of float (desc) from Yahoo Finance screener.
    Filters: short float > min_short_pct%, US exchange, market cap > $50M.
    Falls back to hardcoded list on any error.
    """
    # Strategy 1: Yahoo Finance custom screener API
    try:
        url = "https://query1.finance.yahoo.com/v1/finance/screener"
        headers = {"User-Agent": "Mozilla/5.0"}
        body = {
            "offset": 0,
            "size": limit,
            "sortField": "percentofsharesfloatshort",
            "sortType": "DESC",
            "quoteType": "EQUITY",
            "query": {
                "operator": "AND",
                "operands": [
                    {"operator": "GT", "operands": ["percentofsharesfloatshort", min_short_pct / 100]},
                    {"operator": "EQ", "operands": ["region", "us"]},
                    {"operator": "GT", "operands": ["intradaymarketcap", 50_000_000]},
                ],
            },
            "userId": "",
            "userIdType": "guid",
        }
        r = requests.post(url, json=body, headers=headers, timeout=15)
        r.raise_for_status()
        quotes = r.json()["finance"]["result"][0]["quotes"]
        tickers = [q["symbol"] for q in quotes if "." not in q.get("symbol", "")]
        if tickers:
            return tickers[:limit]
    except Exception:
        pass

    # Strategy 2: Yahoo Finance predefined "most shorted" screener
    try:
        url = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved"
        params = {"formatted": "false", "scrIds": "most_shorted_stocks", "count": limit}
        headers = {"User-Agent": "Mozilla/5.0"}
        r = requests.get(url, params=params, headers=headers, timeout=10)
        r.raise_for_status()
        quotes = r.json()["finance"]["result"][0]["quotes"]
        tickers = [q["symbol"] for q in quotes if "." not in q.get("symbol", "")]
        if tickers:
            return tickers[:limit]
    except Exception:
        pass

    # Fallback: hardcoded list
    return WATCHLISTS["short_squeeze"]


def _round2(v) -> float:
    try:
        return round(float(v), 2)
    except Exception:
        return 0.0


def _money_short(v) -> Optional[str]:
    try:
        n = float(v)
    except Exception:
        return None
    sign = "-" if n < 0 else ""
    n = abs(n)
    if n >= 1e12:
        return f"{sign}${n / 1e12:.2f}T"
    if n >= 1e9:
        return f"{sign}${n / 1e9:.2f}B"
    if n >= 1e6:
        return f"{sign}${n / 1e6:.2f}M"
    if n >= 1e3:
        return f"{sign}${n / 1e3:.1f}K"
    return f"{sign}${n:.0f}"


def _bar_date(daily_df: pd.DataFrame) -> date:
    try:
        idx = daily_df.index[-1]
        if hasattr(idx, "date"):
            return idx.date()
        return date.fromisoformat(str(idx)[:10])
    except Exception:
        return date.today()


def _next_trading_day(d: date) -> date:
    nxt = d + timedelta(days=1)
    while nxt.weekday() >= 5:
        nxt += timedelta(days=1)
    return nxt


def _idx_date(i) -> date:
    return i.date() if hasattr(i, "date") else date.fromisoformat(str(i)[:10])


def _forward_bars(ticker: str, scan_date: date, n_days: int) -> Optional[pd.DataFrame]:
    """
    Up to n_days daily bars STRICTLY AFTER scan_date — skips weekends and
    holidays via real bars (a Fri/Sat scan rolls forward to Monday+).
    Columns lowercased, ascending. Backtest-only; returns None if no forward
    bar exists yet (window not closed).
    """
    win_start = scan_date + timedelta(days=1)
    # calendar cushion: ~1.6× trading days + a week for weekends/holidays
    win_end   = scan_date + timedelta(days=int(n_days * 1.6) + 7)
    df = None
    try:
        df = get_daily_bars_alpaca(ticker, str(win_start), str(win_end),
                                   ALPACA_API_KEY, ALPACA_API_SECRET)
    except Exception:
        df = None
    if df is None or df.empty:
        try:
            h = yf.Ticker(ticker).history(
                start=str(win_start), end=str(win_end + timedelta(days=1)),
                interval="1d")
            if not h.empty:
                h.columns = [c.lower() for c in h.columns]
                df = h
        except Exception:
            df = None
    if df is None or df.empty:
        return None
    try:
        df = df.copy()
        df.index = pd.to_datetime(df.index)
        df = df.sort_index()
        fwd = df[[_idx_date(i) > scan_date for i in df.index]].head(n_days)
        return fwd if not fwd.empty else None
    except Exception:
        return None


def _simulate_swing(fwd: Optional[pd.DataFrame], direction: str,
                    entry, stop, t1) -> dict:
    """
    Walk forward bars: did target1 print before stop_loss, in the trade's
    direction (LONG unless verdict bearish)? Same-bar ambiguity resolves
    stop-first (conservative). Unresolved at window end → OPEN, marked to
    market on the last close. r_mult is realized R (risk = |entry-stop|).
    """
    out: dict = {"outcome": None, "r_mult": None, "bars": None}
    try:
        if (fwd is None or fwd.empty or entry is None
                or stop is None or t1 is None):
            return out
        risk = abs(float(entry) - float(stop))
        if risk <= 0:
            return out
        entry = float(entry); stop = float(stop); t1 = float(t1)
        hc = _col(fwd, "high"); lc = _col(fwd, "low"); cc = _col(fwd, "close")
        long_ = direction != "SHORT"
        for n, (_, bar) in enumerate(fwd.iterrows(), start=1):
            hi = float(bar[hc]); lo = float(bar[lc])
            hit_stop = (lo <= stop) if long_ else (hi >= stop)
            hit_t1   = (hi >= t1)   if long_ else (lo <= t1)
            if hit_stop:                       # stop-first on ambiguous bars
                return {"outcome": "LOSS", "r_mult": -1.0, "bars": n}
            if hit_t1:
                return {"outcome": "WIN",
                        "r_mult": round(abs(t1 - entry) / risk, 2), "bars": n}
        last_close = float(fwd.iloc[-1][cc])
        m2m = (last_close - entry) if long_ else (entry - last_close)
        return {"outcome": "OPEN", "r_mult": round(m2m / risk, 2),
                "bars": int(len(fwd))}
    except Exception:
        return out


def _lre_takeaway(verdict: str, label: str, status: str, direction: str) -> str:
    """Compact read of verdict + LRE quality/status for the scanner cell."""
    is_lean = verdict in ("LEAN BULLISH", "LEAN BEARISH")
    is_weak = label == "Weak"
    is_decent = label == "Decent"
    is_strong = label in ("GOOD", "STRONG", "PRIME")
    side = "long" if direction == "LONG" else "short"

    if status == "INVALIDATED":
        return f"{side.title()} invalidated"

    if is_weak:
        base = "Weak short; bounce risk" if direction == "SHORT" else "Weak long; fade risk"
    elif is_decent:
        base = f"Decent {side}; confirm"
    elif is_strong and is_lean:
        base = f"Lean {side}; watch"
    elif is_strong:
        base = f"Active {side} setup"
    else:
        base = f"{side.title()} setup"

    if status == "ACTIVE":
        return base
    if status == "DISCOUNT":
        return f"{base}; better price"
    if status == "STALE":
        return f"{base}; extended"
    return base


def _verdict_flip_info(daily_df: pd.DataFrame, current_verdict: str, lookback: int = 90) -> dict:
    """Find the latest historical date where verdict changed into current verdict."""
    if daily_df is None or len(daily_df) < 80 or not current_verdict:
        return {}

    start_idx = max(60, len(daily_df) - lookback)
    history: list[tuple[str, str]] = []
    for end_idx in range(start_idx, len(daily_df) + 1):
        try:
            scored = full_score_pipeline(daily_df.iloc[:end_idx])
            verdict = scored.get("verdict")
            if not verdict:
                continue
            idx = daily_df.index[end_idx - 1]
            dt = pd.to_datetime(idx).date().isoformat()
            history.append((dt, verdict))
        except Exception:
            continue

    if len(history) < 2:
        return {}

    current_date = history[-1][0]
    prev_verdict = None
    flip_date = None
    for i in range(len(history) - 1, 0, -1):
        if history[i][1] != history[i - 1][1]:
            flip_date = history[i][0]
            prev_verdict = history[i - 1][1]
            break

    if not flip_date or history[-1][1] != current_verdict:
        return {}

    try:
        days_since = (date.fromisoformat(current_date) - date.fromisoformat(flip_date)).days
    except Exception:
        days_since = None

    return {
        "verdict_flip_date": flip_date,
        "verdict_flip_from": prev_verdict,
        "verdict_flip_days": days_since,
        "verdict_flip_text": f"Flip {flip_date[5:]} from {prev_verdict}",
    }


def _low_risk_entry(price: float, verdict: str, confidence: str, mtf_rank: int,
                    vol_profile: dict, vol_trend: str, trade: dict) -> dict:
    """Score low-risk entries for directional setups."""
    bullish = verdict in ("BULLISH", "LEAN BULLISH")
    bearish = verdict in ("BEARISH", "LEAN BEARISH")
    atr = float(trade.get("atr") or 0)
    if not price or atr <= 0 or (not bullish and not bearish):
        return {}

    score = 0
    reasons: list[str] = []

    if vol_profile:
        val = float(vol_profile.get("val") or 0)
        vah = float(vol_profile.get("vah") or 0)
        vol_bias = vol_profile.get("vol_bias")
        near_val = val > 0 and (val - atr * 0.5) <= price <= (val + atr * 0.5)
        near_vah = vah > 0 and (vah - atr * 0.5) <= price <= (vah + atr * 0.5)
        if bullish and near_val:
            score += 1
            reasons.append("near VAL")
        elif bearish and near_vah:
            score += 1
            reasons.append("near VAH")
        if bullish and vol_bias == "BULLISH":
            score += 1
            reasons.append("VA bias bullish")
        elif bearish and vol_bias == "BEARISH":
            score += 1
            reasons.append("VA bias bearish")

    if mtf_rank == 1:
        score += 1
        reasons.append("MTF aligned")
    if bullish and vol_trend == "ACCUMULATING":
        score += 1
        reasons.append("accumulating")
    elif bearish and vol_trend == "DISTRIBUTING":
        score += 1
        reasons.append("distributing")
    risk_pct = trade.get("risk_pct")
    if risk_pct is not None and 0 < float(risk_pct) < 3:
        score += 1
        reasons.append("tight stop <3%")
    if confidence == "HIGH":
        score += 1
        reasons.append("high confidence")

    score = min(score, 5)
    # NOTE: do NOT bail when score == 0. The entry/stop computation below is
    # unconditional and produces valid levels for any directional ticker;
    # only the *quality* label needs the score. Returning the levels lets
    # the UI show an "Entry Range" for tickers that didn't tick any LRE
    # qualifier (wide stop, no VAL/VAH proximity, etc.). The star badge in
    # the verdict column stays gated on score > 0 — that keeps it clean.

    if score >= 5:
        label = "PRIME"
    elif score >= 4:
        label = "STRONG"
    elif score >= 3:
        label = "GOOD"
    elif score >= 2:
        label = "Decent"
    elif score >= 1:
        label = "Weak"
    else:
        label = "Watch"  # levels only — no qualifying LRE factor fired

    if bullish:
        entry = price
        val = float((vol_profile or {}).get("val") or 0)
        if val > 0 and val < price:
            entry = val
        stop = entry - atr
        direction = "LONG"
    else:
        entry = price
        vah = float((vol_profile or {}).get("vah") or 0)
        if vah > price:
            entry = vah
        stop = entry + atr
        direction = "SHORT"

    lre_risk = abs(entry - stop) / entry * 100 if entry > 0 else 0
    near = abs(price - entry) / entry <= 0.05 if entry > 0 else False
    if bullish:
        status = "ACTIVE" if near else ("INVALIDATED" if price < stop else ("DISCOUNT" if price < entry else "STALE"))
    else:
        status = "ACTIVE" if near else ("INVALIDATED" if price > stop else ("DISCOUNT" if price > entry else "STALE"))

    return {
        "lre_score": score,
        "lre_label": label,
        "lre_direction": direction,
        "lre_reason": " | ".join(reasons),
        "lre_entry": _round2(entry),
        "lre_stop": _round2(stop),
        "lre_risk_pct": _round2(lre_risk),
        "lre_status": status,
        "lre_takeaway": _lre_takeaway(verdict, label, status, direction),
    }


# ── Single ticker scan ────────────────────────────────────────────────────────

def _num(v) -> Optional[float]:
    try:
        if v in (None, "N/A"):
            return None
        return float(v)
    except Exception:
        return None


def _valuation_target_pe(growth: Optional[float], margin_pct: Optional[float], debt_to_equity: Optional[float]) -> float:
    multiple = 18.0
    if growth is not None:
        if growth >= 0.20:
            multiple = 28.0
        elif growth >= 0.10:
            multiple = 24.0
        elif growth >= 0.05:
            multiple = 21.0
        elif growth < 0:
            multiple = 12.0
    if margin_pct is not None:
        if margin_pct >= 25:
            multiple += 2.0
        elif margin_pct < 0:
            multiple -= 4.0
        elif margin_pct < 5:
            multiple -= 2.0
    if debt_to_equity is not None:
        if debt_to_equity <= 50:
            multiple += 1.0
        elif debt_to_equity >= 250:
            multiple -= 3.0
        elif debt_to_equity >= 150:
            multiple -= 1.5
    return max(8.0, min(35.0, multiple))


def _valuation_target_ps(growth: Optional[float], margin_pct: Optional[float]) -> float:
    multiple = 3.0
    if growth is not None:
        if growth >= 0.30:
            multiple = 10.0
        elif growth >= 0.20:
            multiple = 7.0
        elif growth >= 0.10:
            multiple = 5.0
        elif growth < 0:
            multiple = 1.5
    if margin_pct is not None:
        if margin_pct >= 25:
            multiple += 2.0
        elif margin_pct < 0:
            multiple -= 1.5
        elif margin_pct < 5:
            multiple -= 0.5
    return max(0.5, min(15.0, multiple))


def _valuation_target_pb(growth: Optional[float], margin_pct: Optional[float]) -> float:
    multiple = 2.5
    if margin_pct is not None:
        if margin_pct >= 25:
            multiple += 2.0
        elif margin_pct >= 15:
            multiple += 1.0
        elif margin_pct < 0:
            multiple -= 1.0
    if growth is not None:
        if growth >= 0.20:
            multiple += 1.0
        elif growth < 0:
            multiple -= 0.5
    return max(0.8, min(8.0, multiple))


def _valuation_estimate(f: dict) -> dict:
    """Simple current valuation read from snapshot fundamentals, not historical."""
    score = 0
    reasons: list[str] = []

    price = _num(f.get("price"))
    target = _num(f.get("target_mean_price"))
    target_upside = None
    if price and target:
        target_upside = (target - price) / price * 100
        reasons.append(f"Analyst target {target_upside:+.0f}%")
        if target_upside >= 20:
            score += 2
        elif target_upside >= 8:
            score += 1
        elif target_upside <= -20:
            score -= 2
        elif target_upside <= -8:
            score -= 1

    forward_pe = _num(f.get("forward_pe"))
    pe = _num(f.get("pe_ratio"))
    pe_used = forward_pe or pe
    if pe_used:
        pe_name = "Fwd P/E" if forward_pe else "P/E"
        reasons.append(f"{pe_name} {pe_used:.1f}")
        if pe_used <= 15:
            score += 1
        elif pe_used >= 60:
            score -= 2
        elif pe_used >= 35:
            score -= 1

    growth = _num(f.get("earnings_growth"))
    if growth is not None:
        growth_pct = growth * 100
        reasons.append(f"Growth {growth_pct:+.0f}%")
        if growth >= 0.20:
            score += 1
        elif growth < -0.05:
            score -= 1

    margin = _num(f.get("profit_margin"))
    if margin is not None:
        reasons.append(f"Margin {margin:.0f}%")
        if margin >= 20:
            score += 1
        elif margin < 0:
            score -= 2
        elif margin < 5:
            score -= 1

    cashflow = _num(f.get("free_cashflow"))
    if cashflow is None:
        cashflow = _num(f.get("operating_cashflow"))
    if cashflow is not None:
        reasons.append(f"Cash flow {_money_short(cashflow)}")
        score += 1 if cashflow > 0 else -1

    debt_to_equity = _num(f.get("debt_to_equity"))
    if debt_to_equity is not None:
        reasons.append(f"D/E {debt_to_equity:.0f}%")
        if debt_to_equity <= 50:
            score += 1
        elif debt_to_equity >= 250:
            score -= 2
        elif debt_to_equity >= 150:
            score -= 1

    price_to_book = _num(f.get("price_to_book"))
    if price_to_book:
        reasons.append(f"P/B {price_to_book:.1f}")
        if price_to_book <= 3:
            score += 1
        elif price_to_book >= 10:
            score -= 1

    if score >= 4:
        label = "Undervalued"
    elif score >= 2:
        label = "Attractive"
    elif score >= -1:
        label = "Fair Value"
    elif score >= -3:
        label = "Expensive"
    else:
        label = "Overvalued"

    def _sane(value: Optional[float]) -> bool:
        if value is None or not price:
            return False
        return abs(value - price) / price <= 1.0  # within ±100% of current price

    pe_fair_value = None
    pe_upside_pct = None
    pe_source = None
    if price and pe_used and pe_used >= 8.0:
        implied_eps = price / pe_used
        fair_pe = _valuation_target_pe(growth, margin, debt_to_equity)
        candidate = implied_eps * fair_pe
        if candidate > 0 and _sane(candidate):
            pe_fair_value = candidate
            pe_source = f"P/E fair value ({fair_pe:.0f}x earnings)"

    if pe_fair_value is None and price:
        ps_ratio = _num(f.get("price_to_sales"))
        if ps_ratio and ps_ratio > 0:
            sales_per_share = price / ps_ratio
            fair_ps = _valuation_target_ps(growth, margin)
            candidate = sales_per_share * fair_ps
            if candidate > 0 and _sane(candidate):
                pe_fair_value = candidate
                pe_source = f"P/S fair value ({fair_ps:.1f}x sales)"

    if pe_fair_value is None and price:
        pb_ratio = _num(f.get("price_to_book"))
        if pb_ratio and pb_ratio > 0:
            book_per_share = price / pb_ratio
            fair_pb = _valuation_target_pb(growth, margin)
            candidate = book_per_share * fair_pb
            if candidate > 0 and _sane(candidate):
                pe_fair_value = candidate
                pe_source = f"P/B fair value ({fair_pb:.1f}x book)"

    if pe_fair_value is None and price:
        implied_pct = max(-0.30, min(0.30, score * 0.06))
        pe_fair_value = price * (1 + implied_pct)
        pe_source = f"Score-implied fair value (score {score:+d})"

    if pe_fair_value and price:
        pe_upside_pct = (pe_fair_value - price) / price * 100

    analyst_fair_value = target if (target and target > 0) else None
    analyst_upside_pct = None
    if analyst_fair_value and price:
        analyst_upside_pct = (analyst_fair_value - price) / price * 100

    candidates: list[tuple[float, float, str]] = []
    if analyst_fair_value:
        candidates.append((analyst_fair_value, 0.60, "Analyst target"))
    if pe_fair_value:
        candidates.append((pe_fair_value, 0.40, pe_source or "P/E fair value"))
    if not candidates and price:
        implied_pct = max(-0.30, min(0.30, score * 0.06))
        candidates.append((price * (1 + implied_pct), 1.0, "Score-implied fair value"))

    fair_value = None
    valuation_upside_pct = None
    valuation_source = None
    if candidates:
        total_weight = sum(weight for _, weight, _ in candidates)
        fair_value = sum(value * weight for value, weight, _ in candidates) / total_weight if total_weight else None
        valuation_source = " + ".join(source for _, _, source in candidates[:2])
        if fair_value and price:
            valuation_upside_pct = (fair_value - price) / price * 100

    cyclical_peak_risk = False
    cyclical_peak_reason = None
    trailing_pe_raw = _num(f.get("pe_ratio"))
    forward_pe_raw = _num(f.get("forward_pe"))
    triggers: list[str] = []
    if trailing_pe_raw is not None and 0 < trailing_pe_raw < 10:
        triggers.append(f"Trail P/E {trailing_pe_raw:.0f}x (possible peak EPS)")
    if (
        trailing_pe_raw is not None
        and forward_pe_raw is not None
        and trailing_pe_raw > 0
        and forward_pe_raw > trailing_pe_raw * 1.5
    ):
        triggers.append(
            f"Fwd P/E {forward_pe_raw:.0f}x >> Trail {trailing_pe_raw:.0f}x (EPS drop expected)"
        )
    if analyst_upside_pct is not None and analyst_upside_pct <= -15:
        triggers.append(f"Analyst target {analyst_upside_pct:+.0f}% (Street skeptical)")
    if triggers:
        cyclical_peak_risk = True
        cyclical_peak_reason = " | ".join(triggers)

    long_runway = False
    long_runway_reason = None
    if (
        not cyclical_peak_risk
        and growth is not None and growth >= 0.05
        and margin is not None and margin >= 10
        and cashflow is not None and cashflow > 0
        and (debt_to_equity is None or debt_to_equity <= 150)
        and pe_used is not None and 10 <= pe_used <= 60
        and score >= 0
        and (analyst_upside_pct is None or analyst_upside_pct >= -10)
    ):
        long_runway = True
        long_runway_bits = [
            f"Growth {growth * 100:+.0f}%",
            f"Margin {margin:.0f}%",
            "Positive FCF",
            f"Score {score:+d}",
        ]
        long_runway_reason = "Durable fundamentals — " + " | ".join(long_runway_bits)

    multi_bagger = False
    multi_bagger_reason = None
    revenue_growth = _num(f.get("revenue_growth"))
    total_cash = _num(f.get("total_cash"))
    market_cap_raw = _num(f.get("market_cap_raw"))
    ps_ratio = _num(f.get("price_to_sales"))
    spec_score = 0.0
    spec_bits: list[str] = []
    if revenue_growth is not None:
        if revenue_growth >= 0.25:
            spec_score += 2.0
            spec_bits.append(f"Rev growth {revenue_growth * 100:+.0f}%")
        elif revenue_growth >= 0.08:
            spec_score += 1.0
            spec_bits.append(f"Rev growth {revenue_growth * 100:+.0f}%")
    if market_cap_raw is not None and market_cap_raw <= 20e9:
        spec_score += 1.0
        spec_bits.append(
            f"Cap ${market_cap_raw/1e9:.1f}B" if market_cap_raw >= 1e9
            else f"Cap ${market_cap_raw/1e6:.0f}M"
        )
    if debt_to_equity is not None and debt_to_equity <= 100:
        spec_score += 1.0
        spec_bits.append(f"D/E {debt_to_equity:.0f}%")
    if total_cash is not None and total_cash > 0:
        spec_score += 1.0
        spec_bits.append(
            f"Cash ${total_cash/1e9:.1f}B" if total_cash >= 1e9
            else f"Cash ${total_cash/1e6:.0f}M"
        )
    if ps_ratio is not None and 0 < ps_ratio <= 25:
        spec_score += 1.0
        spec_bits.append(f"P/S {ps_ratio:.1f}x")
    if analyst_upside_pct is not None:
        if analyst_upside_pct >= 20:
            spec_score += 1.0
            spec_bits.append(f"Target {analyst_upside_pct:+.0f}%")
        elif analyst_upside_pct >= 10:
            spec_score += 0.5
            spec_bits.append(f"Target {analyst_upside_pct:+.0f}%")
    if (
        not cyclical_peak_risk
        and not long_runway
        and spec_score >= 5
        and (
            (revenue_growth is not None and revenue_growth >= 0.08)
            or (analyst_upside_pct is not None and analyst_upside_pct >= 20)
        )
        and (market_cap_raw is None or market_cap_raw <= 20e9)
        and (debt_to_equity is None or debt_to_equity <= 150)
        and (total_cash is None or total_cash > 0)
        and (ps_ratio is None or 0 < ps_ratio <= 25)
    ):
        multi_bagger = True
        bits = spec_bits
        multi_bagger_reason = "Speculative upside - " + " | ".join(bits)

    reason = " | ".join(reasons[:7]) if reasons else "Insufficient valuation fundamentals"
    return {
        "valuation_label": label,
        "valuation_score": score,
        "valuation_reason": reason,
        "valuation_fair_value": _round2(fair_value) if fair_value is not None else None,
        "valuation_upside_pct": _round2(valuation_upside_pct) if valuation_upside_pct is not None else None,
        "valuation_source": valuation_source,
        "valuation_pe_fair_value": _round2(pe_fair_value) if pe_fair_value is not None else None,
        "valuation_pe_upside_pct": _round2(pe_upside_pct) if pe_upside_pct is not None else None,
        "valuation_pe_source": pe_source,
        "valuation_analyst_fair_value": _round2(analyst_fair_value) if analyst_fair_value is not None else None,
        "valuation_analyst_upside_pct": _round2(analyst_upside_pct) if analyst_upside_pct is not None else None,
        "cyclical_peak_risk": cyclical_peak_risk,
        "cyclical_peak_reason": cyclical_peak_reason,
        "long_runway": long_runway,
        "long_runway_reason": long_runway_reason,
        "multi_bagger": multi_bagger,
        "multi_bagger_reason": multi_bagger_reason,
    }


def _fundamental_signals(ticker: str, fundamentals: Optional[dict] = None) -> str:
    """Return compact labels for the scanner Fundamental column."""
    f = fundamentals if fundamentals is not None else (get_fundamentals(ticker) or {})
    labels: list[str] = []

    earnings_growth = f.get("earnings_growth")
    if earnings_growth is not None:
        if earnings_growth > 0.25:
            labels.append("📈 Strong Earnings Growth")
        elif earnings_growth < -0.10:
            labels.append("⚠ Earnings Declining")

    profit_margin = f.get("profit_margin")
    if profit_margin is not None:
        if profit_margin > 20:
            labels.append("💰 High Margins")
        elif profit_margin < 0:
            labels.append("⚠ Unprofitable")

    dividend_yield = f.get("dividend_yield")
    if dividend_yield is not None and dividend_yield > 3:
        labels.append("💵 Good Dividend")

    short_pct = f.get("short_pct_float")
    if short_pct is not None and short_pct >= 10:
        labels.append("🔥 High Short Interest")

    debt_to_equity = f.get("debt_to_equity")
    total_debt = f.get("total_debt")
    try:
        if debt_to_equity is not None:
            dte = float(debt_to_equity)
            if dte >= 150:
                labels.append(f"High Debt D/E {dte:.0f}%")
            elif dte <= 50:
                labels.append(f"Low Debt D/E {dte:.0f}%")
            else:
                labels.append(f"Debt D/E {dte:.0f}%")
        else:
            debt_text = _money_short(total_debt)
            if debt_text:
                labels.append(f"Debt {debt_text}")
    except Exception:
        debt_text = _money_short(total_debt)
        if debt_text:
            labels.append(f"Debt {debt_text}")

    cashflow = f.get("free_cashflow")
    cashflow_label = "Cash Flow"
    if cashflow is None:
        cashflow = f.get("operating_cashflow")
        cashflow_label = "Op Cash Flow"
    cashflow_text = _money_short(cashflow)
    if cashflow_text:
        try:
            labels.append(
                f"{'Positive' if float(cashflow) >= 0 else 'Negative'} {cashflow_label} {cashflow_text}"
            )
        except Exception:
            labels.append(f"{cashflow_label} {cashflow_text}")

    week52_high = f.get("52w_high")
    week52_low = f.get("52w_low")
    try:
        price = float(f.get("price") or 0)
        hi = float(week52_high) if week52_high not in (None, "N/A") else 0
        lo = float(week52_low) if week52_low not in (None, "N/A") else 0
        if price > 0 and hi > lo:
            pos = (price - lo) / (hi - lo) * 100
            if pos > 90:
                labels.append("🏁 Near 52W High")
            elif pos < 15:
                labels.append("🧊 Near 52W Low")
    except Exception:
        pass

    if not labels:
        market_cap = f.get("market_cap")
        pe_ratio = f.get("pe_ratio")
        profit_margin = f.get("profit_margin")
        dividend_yield = f.get("dividend_yield")
        short_pct = f.get("short_pct_float")
        if market_cap and market_cap != "N/A":
            labels.append(f"🏢 MCap {market_cap}")
        if pe_ratio and pe_ratio != "N/A":
            labels.append(f"📊 P/E {pe_ratio}")
        if profit_margin is not None:
            labels.append(f"💰 Margin {profit_margin}%")
        if dividend_yield is not None and dividend_yield > 0:
            labels.append(f"💵 Div {dividend_yield}%")
        if short_pct is not None:
            labels.append(f"🔥 Short {short_pct}%")

    return " | ".join(labels) if labels else "Unavailable"


def _cpr_fields(daily_df: pd.DataFrame, current_price: float) -> dict:
    """Compute Central Pivot Range fields expected by the scanner UI."""
    if daily_df is None or len(daily_df) < 2 or current_price <= 0:
        return {}

    hi_col = _col(daily_df, "high")
    lo_col = _col(daily_df, "low")
    close_col = _col(daily_df, "close")
    open_col = _col(daily_df, "open")

    prev = daily_df.iloc[-2]
    prev_high = float(prev[hi_col])
    prev_low = float(prev[lo_col])
    prev_close = float(prev[close_col])
    if prev_high <= 0 or prev_low <= 0:
        return {}

    p = (prev_high + prev_low + prev_close) / 3
    bc_raw = (prev_high + prev_low) / 2
    tc_raw = 2 * p - bc_raw
    top = max(tc_raw, bc_raw)
    bot = min(tc_raw, bc_raw)
    width_pct = ((top - bot) / p * 100) if p > 0 else 0

    cpr_type = "Normal"
    if width_pct < 0.15:
        cpr_type = "Narrow"
    elif width_pct > 0.5:
        cpr_type = "Wide"

    if current_price > top:
        position = "Above"
    elif current_price < bot:
        position = "Below"
    else:
        position = "Inside"

    interp_map = {
        ("Narrow", "Above"): f"Trending day up - price above TC (${top:.2f})",
        ("Narrow", "Inside"): f"Trending day - inside CPR (${bot:.2f}-${top:.2f})",
        ("Narrow", "Below"): f"Trending day down - price below BC (${bot:.2f})",
        ("Wide", "Above"): f"Range day - above TC (${top:.2f}), may pull back toward TC/P (${top:.2f}/${p:.2f})",
        ("Wide", "Inside"): f"Range day - chop between TC and BC",
        ("Wide", "Below"): f"Range day - below BC (${bot:.2f}), may bounce toward BC/P (${bot:.2f}/${p:.2f})",
        ("Normal", "Above"): f"Bullish bias - above TC (${top:.2f})",
        ("Normal", "Inside"): f"Neutral - inside CPR (${bot:.2f}-${top:.2f})",
        ("Normal", "Below"): f"Bearish bias - below BC (${bot:.2f})",
    }

    atr = calc_atr(daily_df)
    day_open = float(daily_df[open_col].iloc[-1]) if open_col in daily_df.columns else current_price
    cpr_day_result = "Inside CPR; wait"
    cpr_day_entry = cpr_day_stop = cpr_day_t1 = None
    # REVERT_DAY_TRIGGER_V2: additive trigger text. Entry/T1 are anchored to
    # the day's open (Stop stays at the pivot P); current_price is no longer used.
    open_context = (
        f"Open above TC (${top:.2f})" if day_open > top else
        f"Open below BC (${bot:.2f})" if day_open < bot else
        f"Open inside CPR (${bot:.2f}-${top:.2f})"
    )
    cpr_day_trigger_text = f"Break TC ${top:.2f} / BC ${bot:.2f}"
    cpr_day_invalidation_text = "Failed break back inside CPR"
    cpr_day_target_text = f"Breakout side + ${atr * 0.5:.2f}" if atr > 0 else "Next CPR edge"
    cpr_day_ref = f"{open_context}; wait for TC/BC break."
    if position == "Above":
        cpr_day_result = "Trend up" if cpr_type == "Narrow" else (
            "Above CPR; pullback risk" if cpr_type == "Wide" else "Bullish above TC"
        )
        cpr_day_entry = day_open
        cpr_day_stop = p
        cpr_day_t1 = day_open + atr if atr > 0 else day_open + (top - bot)
        if cpr_day_t1 <= day_open and atr > 0:
            cpr_day_t1 = day_open + atr * 0.5
        cpr_day_trigger_text = (
            f"Hold > TC ${top:.2f}" if day_open >= top else f"Reclaim TC ${top:.2f}"
        )
        cpr_day_invalidation_text = f"Back < P ${p:.2f}"
        cpr_day_target_text = f"${cpr_day_t1:.2f}" if cpr_day_t1 is not None else "Open + ATR"
        cpr_day_ref = f"{open_context}; long only while holding above TC/P."
    elif position == "Below":
        cpr_day_result = "Trend down" if cpr_type == "Narrow" else (
            "Below CPR; bounce risk" if cpr_type == "Wide" else "Bearish below BC"
        )
        cpr_day_entry = day_open
        cpr_day_stop = p
        cpr_day_t1 = day_open - atr if atr > 0 else day_open - (top - bot)
        if cpr_day_t1 >= day_open and atr > 0:
            cpr_day_t1 = day_open - atr * 0.5
        cpr_day_trigger_text = (
            f"Hold < BC ${bot:.2f}" if day_open <= bot else f"Lose BC ${bot:.2f}"
        )
        cpr_day_invalidation_text = f"Back > P ${p:.2f}"
        cpr_day_target_text = f"${cpr_day_t1:.2f}" if cpr_day_t1 is not None else "Open - ATR"
        cpr_day_ref = f"{open_context}; short only while staying below BC/P."

    cur = daily_df.iloc[-1]
    cur_high = float(cur[hi_col])
    cur_low = float(cur[lo_col])
    cur_close = float(cur[close_col])
    cur_range = max(cur_high - cur_low, 0.0)
    close_pos = (cur_close - cur_low) / cur_range if cur_range > 0 else 0.5
    atr_for_next = atr if atr > 0 else cur_range
    range_atr = cur_range / atr_for_next if atr_for_next > 0 else 0
    atr_pct = atr_for_next / cur_close * 100 if cur_close > 0 and atr_for_next > 0 else 0

    next_p = (cur_high + cur_low + cur_close) / 3
    next_bc_raw = (cur_high + cur_low) / 2
    next_tc_raw = 2 * next_p - next_bc_raw
    next_top = max(next_tc_raw, next_bc_raw)
    next_bot = min(next_tc_raw, next_bc_raw)
    next_width_pct = ((next_top - next_bot) / next_p * 100) if next_p > 0 else 0
    next_cpr_type = "Normal"
    if next_width_pct < 0.15:
        next_cpr_type = "Narrow"
    elif next_width_pct > 0.5:
        next_cpr_type = "Wide"

    scan_date = _bar_date(daily_df)
    next_day_date = _next_trading_day(scan_date)
    up_trigger = cur_high
    down_trigger = cur_low
    up_target = cur_high + atr_for_next * 0.5
    down_target = cur_low - atr_for_next * 0.5

    if range_atr >= 1.25 and close_pos >= 0.70:
        next_day_outcome = "Trending Bullish"
        next_day_bias = "Extended Bullish"
        next_day_target = up_target
        setup = f"Close near high after {range_atr:.1f} ATR day"
        action = "needs open/hold above high for continuation; losing pivot favors pullback."
    elif range_atr >= 1.25 and close_pos <= 0.30:
        next_day_outcome = "Trending Bearish"
        next_day_bias = "Extended Bearish"
        next_day_target = down_target
        setup = f"Close near low after {range_atr:.1f} ATR day"
        action = "needs open/hold below low for continuation; reclaiming pivot favors bounce."
    elif close_pos >= 0.65 and cur_close >= next_p:
        next_day_outcome = "Bullish"
        next_day_bias = "Bullish Watch"
        next_day_target = up_target
        setup = f"Close strong ({close_pos * 100:.0f}% of range)"
        action = "open above high favors continuation; inside open uses pivot as support test."
    elif close_pos <= 0.35 and cur_close <= next_p:
        next_day_outcome = "Bearish"
        next_day_bias = "Bearish Watch"
        next_day_target = down_target
        setup = f"Close weak ({close_pos * 100:.0f}% of range)"
        action = "open below low favors breakdown; inside open uses pivot as resistance test."
    elif next_cpr_type == "Wide":
        next_day_outcome = "Range"
        next_day_bias = "Range Watch"
        next_day_target = next_p
        setup = "Wide next CPR"
        action = "expect chop or mean reversion unless price clears prior high/low."
    else:
        next_day_outcome = "Neutral"
        next_day_bias = "Neutral Watch"
        next_day_target = next_p
        setup = "Close mid-range"
        action = "inside open is balanced; wait for prior high/low break."

    next_day_ref = f"P {next_p:.2f} / ATR {atr_for_next:.2f}"
    next_day_summary = (
        f"{next_day_date.isoformat()}: {next_day_outcome}. {setup}. ATR ${atr_for_next:.2f} ({atr_pct:.1f}%). "
        f"Open > H ${up_trigger:.2f} points to ${up_target:.2f}; "
        f"open < L ${down_trigger:.2f} points to ${down_target:.2f}; {action}"
    )
    next_day_prediction = next_day_summary

    out = {
        "cpr_type": cpr_type,
        "cpr_tc": _round2(top),
        "cpr_bc": _round2(bot),
        "cpr_p": _round2(p),
        "cpr_position": position,
        "cpr_interpretation": interp_map.get((cpr_type, position), "-"),
        "cpr_day_result": cpr_day_result,
        "cpr_day_entry": _round2(cpr_day_entry) if cpr_day_entry is not None else None,
        "cpr_day_stop": _round2(cpr_day_stop) if cpr_day_stop is not None else None,
        "cpr_day_t1": _round2(cpr_day_t1) if cpr_day_t1 is not None else None,
        "cpr_day_trigger_text": cpr_day_trigger_text,
        "cpr_day_invalidation_text": cpr_day_invalidation_text,
        "cpr_day_target_text": cpr_day_target_text,
        "cpr_day_ref": cpr_day_ref,
        "next_day_date": next_day_date.isoformat(),
        "next_day_outcome": next_day_outcome,
        "next_day_bias": next_day_bias,
        "next_day_summary": next_day_summary,
        "next_day_prediction": next_day_prediction,
        "next_day_open": None,
        "next_day_ref": next_day_ref,
        "next_day_target": _round2(next_day_target) if next_day_target is not None else None,
        "next_day_atr": _round2(atr_for_next),
        "next_day_atr_pct": _round2(atr_pct),
        "next_day_trigger_up": _round2(up_trigger),
        "next_day_trigger_down": _round2(down_trigger),
        "next_day_pivot": _round2(next_p),
        "prev_day_high": _round2(prev_high),
        "prev_day_low": _round2(prev_low),
    }
    if atr > 0:
        out.update({
            "exp_move_up": _round2(current_price + atr),
            "exp_move_down": _round2(current_price - atr),
            "exp_move_pct": _round2(atr / current_price * 100),
            "day_open": _round2(day_open),
            "exp_move_open_up": _round2(day_open + atr),
            "exp_move_open_dn": _round2(day_open - atr),
            "exp_move_open_pct": _round2(atr / day_open * 100) if day_open > 0 else 0,
        })
    return out


def _day_volume_confirm_text(position: str, vol_trend: str | None, vol_surge: bool, vol_ratio: float | None = None) -> str:
    trend = (vol_trend or "").upper()
    ratio_text = f" ({vol_ratio:.1f}x avg)" if isinstance(vol_ratio, (int, float)) and vol_ratio > 0 else ""
    if position == "Above":
        if trend == "ACCUMULATING" and vol_surge:
            return f"Confirmed: accumulating + volume surge{ratio_text}"
        if trend == "ACCUMULATING":
            return f"Supportive: accumulating volume{ratio_text}"
        if trend == "DISTRIBUTING":
            return f"Caution: distribution against long{ratio_text}"
        if vol_surge:
            return f"Watch: volume surge; confirm direction{ratio_text}"
        return "Needs volume: no clear accumulation"
    if position == "Below":
        if trend == "DISTRIBUTING" and vol_surge:
            return f"Confirmed: distributing + volume surge{ratio_text}"
        if trend == "DISTRIBUTING":
            return f"Supportive: distributing volume{ratio_text}"
        if trend == "ACCUMULATING":
            return f"Caution: accumulation against short{ratio_text}"
        if vol_surge:
            return f"Watch: volume surge; confirm direction{ratio_text}"
        return "Needs volume: no clear distribution"
    if vol_surge:
        return f"Watch: volume surge; wait for CPR break{ratio_text}"
    return "Needs volume on CPR break"


def _opening_15m_volume_signal(ticker: str, target_date: date) -> dict:
    start = target_date - timedelta(days=35)
    df = pd.DataFrame()
    try:
        df = get_five_min_bars_alpaca(ticker, str(start), str(target_date), ALPACA_API_KEY, ALPACA_API_SECRET)
    except Exception:
        pass
    if df is None or df.empty:
        try:
            hist = yf.Ticker(ticker).history(
                start=str(start),
                end=str(target_date + timedelta(days=1)),
                interval="5m",
                prepost=False,
            )
            if not hist.empty:
                hist.columns = [c.lower() for c in hist.columns]
                if hist.index.tz is None:
                    hist.index = hist.index.tz_localize("America/New_York")
                else:
                    hist.index = hist.index.tz_convert("America/New_York")
                df = hist[[c for c in ["open", "high", "low", "close", "volume"] if c in hist.columns]]
        except Exception:
            df = pd.DataFrame()
    if df is None or df.empty or "volume" not in df.columns:
        return {
            "cpr_day_15m_volume_text": "15m pending: waiting for opening bars",
            "cpr_day_15m_volume_ratio": None,
            "cpr_day_15m_volume_surge": False,
        }

    idx = pd.to_datetime(df.index)
    if idx.tz is None:
        idx = idx.tz_localize("America/New_York")
    else:
        idx = idx.tz_convert("America/New_York")
    work = df.copy()
    work.index = idx
    mask = (
        (work.index.time >= pd.Timestamp("09:30").time()) &
        (work.index.time < pd.Timestamp("09:45").time())
    )
    opening = work.loc[mask]
    if opening.empty:
        text = "15m pending: waiting for opening bars"
        return {"cpr_day_15m_volume_text": text, "cpr_day_15m_volume_ratio": None, "cpr_day_15m_volume_surge": False}

    grouped = opening.groupby(opening.index.date)["volume"].agg(["sum", "count"])
    if target_date not in grouped.index:
        text = "15m pending: waiting for opening bars"
        return {"cpr_day_15m_volume_text": text, "cpr_day_15m_volume_ratio": None, "cpr_day_15m_volume_surge": False}

    target = grouped.loc[target_date]
    count = int(target["count"])
    if count < 3:
        text = f"15m pending: {count}/3 bars"
        return {"cpr_day_15m_volume_text": text, "cpr_day_15m_volume_ratio": None, "cpr_day_15m_volume_surge": False}

    prior = grouped[(grouped.index < target_date) & (grouped["count"] >= 3) & (grouped["sum"] > 0)]["sum"].tail(10)
    if prior.empty:
        text = "15m baseline pending"
        return {"cpr_day_15m_volume_text": text, "cpr_day_15m_volume_ratio": None, "cpr_day_15m_volume_surge": False}

    avg = float(prior.mean())
    ratio = float(target["sum"]) / avg if avg > 0 else 0.0
    ratio = round(ratio, 2)
    if ratio >= 1.5:
        text = f"15m Surge {ratio:.1f}x avg"
    elif ratio >= 1.1:
        text = f"15m Active {ratio:.1f}x avg"
    elif ratio >= 0.8:
        text = f"15m Normal {ratio:.1f}x avg"
    else:
        text = f"15m Light {ratio:.1f}x avg"
    return {
        "cpr_day_15m_volume_text": text,
        "cpr_day_15m_volume_ratio": ratio,
        "cpr_day_15m_volume_surge": ratio >= 1.5,
    }


_NEXT_EARN_CACHE: dict = {}   # {ticker: (date_cached, value)} — refreshed daily


_SEASONALITY_CACHE: dict = {}   # {(ticker, "YYYY-MM"): dict} — refreshed monthly


_EARN_DATES_CACHE: dict = {}


_FUND_CACHE: dict = {}


def _seasonality_cached(ticker: str) -> dict:
    """Current-month seasonality, cached per ticker per calendar month."""
    today = date.today()
    key = (ticker, f"{today.year}-{today.month:02d}")
    hit = _SEASONALITY_CACHE.get(key)
    if hit is not None:
        return hit
    try:
        val = compute_seasonality(ticker) or {"available": False}
    except Exception:
        val = {"available": False}
    _SEASONALITY_CACHE[key] = val
    return val


def _next_earnings_cached(ticker: str) -> Optional[str]:
    """Next earnings date (YYYY-MM-DD), cached once per calendar day."""
    today = date.today()
    hit = _NEXT_EARN_CACHE.get(ticker)
    if hit and hit[0] == today:
        return hit[1]
    val = None
    try:
        from backend.services.earnings import get_next_earnings_date
        val = get_next_earnings_date(ticker)
    except Exception:
        val = None
    _NEXT_EARN_CACHE[ticker] = (today, val)
    return val


def _fundamentals_cached(ticker: str) -> dict:
    """Fundamentals are slow yfinance quoteSummary calls; cache once per day."""
    today = date.today()
    hit = _FUND_CACHE.get(ticker)
    if hit and hit[0] == today:
        return hit[1]
    try:
        val = get_fundamentals(ticker) or {}
    except Exception:
        val = {}
    _FUND_CACHE[ticker] = (today, val)
    return val


_SCAN_FIB_RET = [0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0]
_SCAN_FIB_EXT = [1.272, 1.414, 1.618, 2.0, 2.618]
_SCAN_FIB_NEG = [0.236, 0.382, 0.5, 0.618, 1.0]


def _fib_zone_label(pos_pct: Optional[float]) -> Optional[str]:
    if pos_pct is None:
        return None
    if pos_pct >= 70:
        return "HIGH"
    if pos_pct <= 30:
        return "LOW"
    return "MID"


def _scan_fib_levels(lo: float, hi: float) -> dict[str, float]:
    try:
        lo = float(lo)
        hi = float(hi)
    except Exception:
        return {}
    if hi <= lo:
        return {}
    rng = hi - lo
    levels: dict[str, float] = {}
    for f in _SCAN_FIB_RET:
        levels[f"R {f * 100:.1f}%"] = hi - rng * f
    for f in _SCAN_FIB_EXT:
        levels[f"E {f * 100:.1f}%"] = lo + rng * f
    for f in _SCAN_FIB_NEG:
        levels[f"N -{f * 100:.1f}%"] = lo - rng * f
    return levels


def _rows_between_dates(daily_df: pd.DataFrame, start_d: date, end_d: date) -> pd.DataFrame:
    try:
        mask = [start_d <= _idx_date(idx) <= end_d for idx in daily_df.index]
        return daily_df[mask]
    except Exception:
        return pd.DataFrame()


def _earnings_dates_cached(ticker: str) -> list[date]:
    today = date.today()
    hit = _EARN_DATES_CACHE.get(ticker)
    if hit and hit[0] == today:
        return hit[1]
    dates: list[date] = []
    try:
        from backend.services.earnings import get_earnings_dates_yf
        for item in get_earnings_dates_yf(ticker) or []:
            raw = item.get("date")
            if not raw:
                continue
            try:
                dates.append(date.fromisoformat(str(raw)[:10]))
            except Exception:
                continue
    except Exception:
        dates = []
    dates = sorted(set(dates))
    _EARN_DATES_CACHE[ticker] = (today, dates)
    return dates


def _fib_compression(levels: dict[str, float], swing_range: float) -> bool:
    vals = sorted(levels.values())
    thresh = swing_range * 0.03 if swing_range > 0 else 0
    if len(vals) < 3 or thresh <= 0:
        return False
    for i in range(len(vals) - 2):
        if vals[i + 2] - vals[i] <= thresh:
            return True
    return False


def _directional_fib_target(levels: dict[str, float], price: float, direction: str) -> tuple[Optional[str], Optional[float]]:
    if price <= 0 or not levels:
        return None, None
    eps = max(price * 0.001, 0.01)
    ordered = sorted(levels.items(), key=lambda kv: kv[1])
    if direction == "SHORT":
        below = [(name, val) for name, val in ordered if val < price - eps]
        return below[-1] if below else (None, None)
    above = [(name, val) for name, val in ordered if val > price + eps]
    return above[0] if above else (None, None)


def _fib_target_ladder(levels: dict[str, float], price: float, direction: str) -> list[dict]:
    if price <= 0:
        return []
    eps = max(price * 0.001, 0.01)
    rows = []
    for name, val in levels.items():
        try:
            v = float(val)
        except Exception:
            continue
        if direction == "SHORT" and v < price - eps:
            rows.append({"kind": "Fib", "label": name, "price": v})
        elif direction != "SHORT" and v > price + eps:
            rows.append({"kind": "Fib", "label": name, "price": v})
    rows.sort(key=lambda r: r["price"], reverse=(direction == "SHORT"))

    out: list[dict] = []
    for row in rows:
        p = float(row["price"])
        if any(abs(float(x["price"]) - p) <= max(0.25, price * 0.001) for x in out):
            continue
        out.append({
            "kind": row["kind"],
            "label": row["label"],
            "price": _round2(p),
            "reward_pct": _round2(abs(p - price) / price * 100),
        })
        if len(out) >= 6:
            break
    return out


def _ladder_prices(rows: list[dict], *, above: Optional[float] = None,
                   below: Optional[float] = None, limit: int = 3) -> str:
    vals: list[float] = []
    for row in rows:
        try:
            price = float(row.get("price"))
        except Exception:
            continue
        if above is not None and price <= above:
            continue
        if below is not None and price >= below:
            continue
        if any(abs(v - price) <= max(0.25, abs(price) * 0.001) for v in vals):
            continue
        vals.append(price)
        if len(vals) >= limit:
            break
    return " / ".join(f"${v:.2f}" for v in vals)


def _weekly_fib_zone_fields(daily_df: pd.DataFrame, price: float) -> dict:
    if daily_df is None or daily_df.empty or price <= 0:
        return {}
    hi_col = _col(daily_df, "high")
    lo_col = _col(daily_df, "low")
    scan_d = _bar_date(daily_df)
    week_start = scan_d - timedelta(days=scan_d.weekday())
    wk = _rows_between_dates(daily_df, week_start, scan_d)
    if wk.empty or len(wk) < 2:
        wk = daily_df.tail(5)
    try:
        wk_hi = float(wk[hi_col].max())
        wk_lo = float(wk[lo_col].min())
        rng = wk_hi - wk_lo
        pos = ((price - wk_lo) / rng * 100) if rng > 0 else 50.0
        return {
            "weekly_zone": _fib_zone_label(pos),
            "weekly_pos_pct": _round2(pos),
            "weekly_fib_low": _round2(wk_lo),
            "weekly_fib_high": _round2(wk_hi),
        }
    except Exception:
        return {}


def _earnings_swing(ticker: str, daily_df: pd.DataFrame, scan_date: date) -> Optional[dict]:
    if not _SCAN_FIB_USE_EARNINGS:
        return None
    dates = [d for d in _earnings_dates_cached(ticker) if d <= scan_date]
    if len(dates) < 2:
        return None
    start_d, end_d = dates[-2], dates[-1]
    rows = _rows_between_dates(daily_df, start_d, end_d)
    if rows.empty:
        return None
    hi_col = _col(rows, "high")
    lo_col = _col(rows, "low")
    try:
        lo = float(rows[lo_col].min())
        hi = float(rows[hi_col].max())
    except Exception:
        return None
    if hi <= lo:
        return None
    return {
        "source": "Earn swing",
        "low": lo,
        "high": hi,
        "window": f"{start_d.isoformat()} -> {end_d.isoformat()}",
        "prev_earnings": start_d.isoformat(),
        "last_earnings": end_d.isoformat(),
    }


def _fallback_swing(daily_df: pd.DataFrame) -> Optional[dict]:
    if daily_df is None or daily_df.empty:
        return None
    hi_col = _col(daily_df, "high")
    lo_col = _col(daily_df, "low")
    rows = daily_df.tail(252)
    try:
        lo = float(rows[lo_col].min())
        hi = float(rows[hi_col].max())
    except Exception:
        return None
    if hi <= lo:
        return None
    return {"source": "52w swing", "low": lo, "high": hi, "window": None}


def _fib_earnings_commentary(
    *,
    direction: str,
    target_name: Optional[str],
    target_val: Optional[float],
    reward_pct: Optional[float],
    near_name: str,
    near_val: float,
    earn_zone: Optional[str],
    weekly_zone: Optional[str],
    source: str,
    prev_earnings: Optional[str],
    last_earnings: Optional[str],
    next_earnings: Optional[str],
    target_ladder: Optional[list[dict]] = None,
    reclaim_ladder: Optional[list[dict]] = None,
) -> str:
    target_txt = (
        f"{target_name} ${target_val:.2f}" if target_name and target_val is not None
        else f"{near_name} ${near_val:.2f}"
    )
    level_txt = f"${target_val:.2f}" if target_val is not None else f"${near_val:.2f}"
    reward_txt = f" ({reward_pct:.2f}% away)" if reward_pct is not None else ""
    date_bits: list[str] = []
    if next_earnings:
        date_bits.append(f"Next earnings {next_earnings}")
    if prev_earnings and last_earnings:
        date_bits.append(f"earn swing {prev_earnings} to {last_earnings}")
    elif last_earnings:
        date_bits.append(f"last earnings {last_earnings}")
    date_txt = "; ".join(date_bits) if date_bits else f"{source} basis"

    gate_txt = (
        f"{target_txt} is a nearby gate, not a full earnings target"
        if reward_pct is not None and reward_pct <= 1.5
        else f"{target_txt} is the next Fib checkpoint"
    )

    target_ladder = target_ladder or []
    reclaim_ladder = reclaim_ladder or []
    downside_targets = _ladder_prices(target_ladder, below=target_val, limit=3)
    upside_targets = _ladder_prices(reclaim_ladder, above=target_val, limit=3)

    if direction == "SHORT":
        follow_through = (
            f" toward {downside_targets}"
            if downside_targets else ""
        )
        reclaim_context = (
            f" and puts {upside_targets} back in play"
            if upside_targets else ""
        )
        pass_fail = (
            f"hold below {level_txt} favors downside follow-through{follow_through}; "
            f"reclaim above {level_txt} weakens the short read{reclaim_context}"
        )
    else:
        upside_targets = _ladder_prices(target_ladder, above=target_val, limit=3)
        downside_targets = _ladder_prices(reclaim_ladder, below=target_val, limit=3)
        continuation = (
            f" toward {upside_targets}"
            if upside_targets else ""
        )
        rejection_context = (
            f" and puts {downside_targets} back in play"
            if downside_targets else ""
        )
        pass_fail = (
            f"hold above {level_txt} favors continuation{continuation}; "
            f"rejection below {level_txt} favors a fade back into the range{rejection_context}"
        )

    zone_txt = ""
    if earn_zone and weekly_zone:
        if weekly_zone == "HIGH" and earn_zone != "HIGH":
            zone_txt = " Weekly HIGH means the earnings reaction is stretched short term, so acceptance matters."
        elif weekly_zone == "LOW" and earn_zone != "LOW":
            zone_txt = " Weekly LOW means the reaction is near short-term support, so reclaim/hold matters."
        elif earn_zone == "HIGH":
            zone_txt = " Earn HIGH means price is already near the top of the earnings swing."
        elif earn_zone == "LOW":
            zone_txt = " Earn LOW means price is near the lower part of the earnings swing."
    elif weekly_zone:
        zone_txt = f" Weekly {weekly_zone} is the short-term range context."

    return f"{date_txt}. {gate_txt}{reward_txt}; {pass_fail}.{zone_txt}".strip()


def _fib_target_fields(ticker: str, daily_df: pd.DataFrame, price: float,
                       direction: str, scan_date: date,
                       include_earnings: bool = True,
                       next_earnings: Optional[str] = None) -> dict:
    out = _weekly_fib_zone_fields(daily_df, price)
    swing = _earnings_swing(ticker, daily_df, scan_date) if include_earnings else None
    if swing is None:
        swing = _fallback_swing(daily_df)
    if swing is None or price <= 0:
        return out

    if include_earnings and not next_earnings:
        future_dates = [d for d in _earnings_dates_cached(ticker) if d > scan_date]
        if future_dates:
            next_earnings = future_dates[0].isoformat()

    lo = float(swing["low"])
    hi = float(swing["high"])
    rng = hi - lo
    levels = _scan_fib_levels(lo, hi)
    if not levels:
        return out

    near_name, near_val = min(levels.items(), key=lambda kv: abs(kv[1] - price))
    tgt_name, tgt_val = _directional_fib_target(levels, price, direction)
    pos = ((price - lo) / rng * 100) if rng > 0 else 50.0
    target_reward_pct = None
    if tgt_val is not None and price > 0:
        target_reward_pct = abs(tgt_val - price) / price * 100
    earn_zone = _fib_zone_label(pos) if swing["source"] == "Earn swing" else None
    weekly_zone = out.get("weekly_zone")
    prev_earnings = swing.get("prev_earnings")
    last_earnings = swing.get("last_earnings")
    rounded_tgt = _round2(tgt_val) if tgt_val is not None else None
    rounded_reward = _round2(target_reward_pct) if target_reward_pct is not None else None
    target_ladder = _fib_target_ladder(levels, price, direction)
    reclaim_ladder = _fib_target_ladder(
        levels,
        rounded_tgt or price,
        "LONG" if direction == "SHORT" else "SHORT",
    )

    out.update({
        "earn_zone": earn_zone,
        "fib_pos_pct": _round2(pos),
        "near_fib_name": near_name,
        "near_fib_price": _round2(near_val),
        "fib_compression": _fib_compression(levels, rng),
        "fib_target": rounded_tgt,
        "fib_target_name": tgt_name,
        "fib_target_reward_pct": rounded_reward,
        "fib_target_ladder": target_ladder,
        "fib_reclaim_ladder": reclaim_ladder,
        "fib_target_source": swing["source"],
        "fib_swing_low": _round2(lo),
        "fib_swing_high": _round2(hi),
        "fib_swing_range": _round2(rng),
        "fib_earn_window": swing.get("window"),
        "fib_prev_earnings": prev_earnings,
        "fib_last_earnings": last_earnings,
        "fib_next_earnings": next_earnings,
    })
    out["fib_commentary"] = _fib_earnings_commentary(
        direction=direction,
        target_name=tgt_name,
        target_val=rounded_tgt,
        reward_pct=rounded_reward,
        near_name=near_name,
        near_val=_round2(near_val),
        earn_zone=earn_zone,
        weekly_zone=weekly_zone,
        source=swing["source"],
        prev_earnings=prev_earnings,
        last_earnings=last_earnings,
        next_earnings=next_earnings,
        target_ladder=target_ladder,
        reclaim_ladder=reclaim_ladder,
    )
    return out


def _compute_swing_levels(daily_df) -> dict:
    """Multi-timeframe S/R for the SWING column:
    - PWH/PWL: last 5 completed trading days
    - PMH/PML: last 21 completed trading days
    - 52wH/52wL: last 252 completed trading days

    Excludes today's in-progress bar so the levels are stable during a scan.
    Returns a subset of {prev_week_high, prev_week_low, prev_month_high,
    prev_month_low, wk52_high, wk52_low} — only the ones with enough bars.
    """
    if daily_df is None or daily_df.empty:
        return {}
    hi = _col(daily_df, "high")
    lo = _col(daily_df, "low")
    if not hi or not lo:
        return {}
    # Drop today's bar if the daily frame includes the current session — the
    # scan elsewhere already uses iloc[-1] as "today" so iloc[:-1] is the
    # completed-bar set. If <2 rows, fall back to whatever we have.
    df = daily_df.iloc[:-1] if len(daily_df) >= 2 else daily_df

    out: dict = {}
    if len(df) >= 5:
        w = df.iloc[-5:]
        out["prev_week_high"] = _round2(float(w[hi].max()))
        out["prev_week_low"]  = _round2(float(w[lo].min()))
    if len(df) >= 21:
        m = df.iloc[-21:]
        out["prev_month_high"] = _round2(float(m[hi].max()))
        out["prev_month_low"]  = _round2(float(m[lo].min()))
    if len(df) >= 200:                      # accept <252 if the symbol's
        y = df.iloc[-252:]                   # history is short of a full year
        out["wk52_high"] = _round2(float(y[hi].max()))
        out["wk52_low"]  = _round2(float(y[lo].min()))
    return out


def _scanner_mode(mode: Optional[str]) -> str:
    raw = (mode or "overview").strip().lower().replace("-", "_")
    if raw in {"", "all", "full", "overview"}:
        return "overview"
    if raw == "swing":
        return "swing"
    if raw in {"longterm", "long_term", "lt"}:
        return "longterm"
    if raw in {"fib", "fib_targets", "fibonacci"}:
        return "fib"
    if raw in {"day", "daytrading", "day_trading", "dt4"}:
        return "daytrading"
    if raw in {"option", "options"}:
        return "options"
    return "overview"


def scan_single(ticker: str, as_of: Optional[str] = None,
                include_news: Optional[bool] = None,
                mode: Optional[str] = None) -> dict:
    try:
        ticker = (ticker or "").strip().upper()
        scan_mode = _scanner_mode(mode)
        include_fundamentals = scan_mode in {"overview", "longterm"}
        include_day_trading = scan_mode in {"overview", "daytrading"}
        include_options = scan_mode in {"overview", "options"}
        is_etf = _is_etf_symbol(ticker)
        if as_of:
            end = date.fromisoformat(as_of)
            # Roll back to Friday if weekend
            if end.weekday() == 5:   # Saturday
                end = end - timedelta(days=1)
            elif end.weekday() == 6: # Sunday
                end = end - timedelta(days=2)
        else:
            end = date.today()
        start = end - timedelta(days=400)

        daily_df = None
        try:
            daily_df = get_daily_bars_alpaca(ticker, str(start), str(end), ALPACA_API_KEY, ALPACA_API_SECRET)
        except Exception:
            pass

        if daily_df is None or daily_df.empty:
            hist = yf.Ticker(ticker).history(start=str(start), end=str(end + timedelta(days=1)), interval="1d")
            if not hist.empty:
                hist.columns = [c.lower() for c in hist.columns]
                daily_df = hist

        if daily_df is None or len(daily_df) < 30:
            return {"ticker": ticker, "error": "Insufficient data", "score": 0}

        scored      = full_score_pipeline(daily_df)
        verdict     = scored.get("verdict", "NEUTRAL")
        confidence  = scored.get("confidence", "N/A")
        score       = scored.get("score", 0)
        direction   = "SHORT" if verdict in ("BEARISH", "LEAN BEARISH") else "LONG"

        close_col   = _col(daily_df, "close")
        price       = round(float(daily_df[close_col].iloc[-1]), 2)

        grade       = get_entry_grade(score, confidence)
        weekly      = compute_weekly_bias(daily_df)
        daily_b     = compute_daily_bias(daily_df)
        signal      = mtf_signal_action(weekly, daily_b, daily_b)
        trade       = calc_trade_levels(daily_df, verdict, price)

        # Buy-The-Dip EMA structure (per-ticker — own structure only;
        # market-level regime gate lives in the Market Risk bar).
        btd = compute_btd(daily_df, regime_ok=True)

        # Weinstein 30-week MA curl (long-term Stage 1→2 turn).
        w30 = compute_w30(daily_df)

        # Weekly ATR (volatility on weekly bars).
        wkatr = calc_weekly_atr(daily_df)

        # Recent-headline sentiment (Finviz, cached 10 min). Best-effort —
        # never let a news fetch break a scan.
        news_label, news_good, news_bad = "No", 0, 0
        news_headlines: list = []
        # Per-call override beats the env-default (e.g. UI "Include news"
        # toggle). None → fall back to the module flag, True/False → force.
        _news_on = _SCAN_INCLUDE_NEWS if include_news is None else bool(include_news)
        if _news_on and not is_etf:
            try:
                from backend.services.news_sentiment import get_news_details
                _nd = get_news_details(ticker)
                news_label = _nd.get("label", "No")
                news_good  = _nd.get("good_score", 0)
                news_bad   = _nd.get("bad_score", 0)
                news_headlines = [
                    {"h": (x.get("headline") or "").strip()[:140],
                     "s": x.get("sentiment", "Neutral"),
                     "src": x.get("source", ""),
                     "t": (f'{x.get("date","")} {x.get("time","")}').strip()}
                    for x in (_nd.get("headlines") or [])[:12]
                    if (x.get("headline") or "").strip()  # drop empty-text items
                ]
            except Exception:
                pass

        # Next scheduled earnings date (cached daily — best-effort).
        next_earnings = (
            _next_earnings_cached(ticker)
            if (_SCAN_INCLUDE_EARNINGS and not is_etf)
            else None
        )
        # Seasonality is intentionally NOT computed here — it's fetched
        # on-demand via GET /api/scanner/seasonality (kept off the scan
        # hot path; see _seasonality_cached).

        vol_profile     = scored.get("vol_profile") or {}
        strategy_sig    = scored.get("strategy_signals") or {}
        flip_info       = _verdict_flip_info(daily_df, verdict)
        lre             = _low_risk_entry(
            price=price,
            verdict=verdict,
            confidence=confidence,
            mtf_rank=signal["rank"],
            vol_profile=vol_profile,
            vol_trend=vol_profile.get("vol_trend", "N/A"),
            trade=trade,
        )
        fundamentals = {"price": price}
        fundamental_signals = ""
        valuation = {}
        if include_fundamentals:
            fundamentals = _etf_fundamentals(ticker, price) if is_etf else _fundamentals_cached(ticker)
            fundamentals.setdefault("price", price)
            fundamental_signals = _fundamental_signals(ticker, fundamentals)
            valuation = _valuation_estimate(fundamentals)

        cpr = {}
        fib_targets = _fib_target_fields(
            ticker, daily_df, price, direction, end,
            include_earnings=not is_etf,
            next_earnings=next_earnings,
        )
        if include_day_trading:
            cpr = _cpr_fields(daily_df, price)
            cpr["cpr_day_volume_text"] = _day_volume_confirm_text(
                cpr.get("cpr_position", ""),
                vol_profile.get("vol_trend", "N/A"),
                bool(vol_profile.get("vol_surge", False)),
                vol_profile.get("vol_ratio"),
            )
            cpr.update(_opening_15m_volume_signal(ticker, end))

        # V4 day-trading: PDH/PWH/PDL/PWL plan engine. It uses the daily
        # bars already fetched for the scanner, so it is cheap and can be
        # turned off with DAY_TRADING_V4_ENABLED=0.
        if include_day_trading and _DAY_TRADING_V4_ENABLED:
            try:
                from day_trading.v4 import analyze_from_daily as _dt4_analyze
                _dt4 = _dt4_analyze(ticker, daily_df, scan_date=end, current_price=price)
                _sig = _dt4.get("signal") or {}
                _lvl = _dt4.get("levels") or {}
                cpr.update({
                    "dt4_enabled": True,
                    "dt4_setup": _sig.get("setup"),
                    "dt4_context": _sig.get("context"),
                    "dt4_side": _sig.get("side"),
                    "dt4_bias": _sig.get("bias"),
                    "dt4_grade": _sig.get("grade"),
                    "dt4_level": _sig.get("level"),
                    "dt4_level_val": _sig.get("level_val"),
                    "dt4_entry": _sig.get("entry"),
                    "dt4_stop": _sig.get("stop"),
                    "dt4_t1": _sig.get("t1"),
                    "dt4_t2": _sig.get("t2"),
                    "dt4_rr": _sig.get("rr"),
                    "dt4_trigger": _sig.get("trigger"),
                    "dt4_invalidation": _sig.get("invalidation"),
                    "dt4_target_plan": _sig.get("target_plan"),
                    "dt4_exit_plan": _sig.get("exit_plan"),
                    "dt4_note": _sig.get("note"),
                    "dt4_pdh": _round2(_lvl.get("pdh")),
                    "dt4_pdl": _round2(_lvl.get("pdl")),
                    "dt4_pwh": _round2(_lvl.get("pwh")),
                    "dt4_pwl": _round2(_lvl.get("pwl")),
                    "dt4_atr": _round2(_lvl.get("atr")),
                })
            except Exception as exc:
                cpr.update({
                    "dt4_enabled": True,
                    "dt4_setup": "error",
                    "dt4_note": str(exc)[:120],
                })
        elif include_day_trading:
            cpr.update({"dt4_enabled": False, "dt4_setup": "disabled"})

        # V3 day-trading: PDH/PWH/PDL/PWL setup engine. Lazy-imported and
        # try-wrapped so a failure (yfinance hiccup, off-hours, missing
        # bars) never breaks the scanner row — fields just stay None.
        # Re-use scanner's already-loaded daily_df (skips one yf call) and
        # bound the whole call so a stuck request can't drag the row at the
        # open (yfinance is regularly 8–10s/call when markets open).
        try:
            if not include_day_trading:
                raise StopIteration
            if not _DAY_TRADING_V3_ENABLED:
                raise RuntimeError("DAY_TRADING_V3_DISABLED")
            from day_trading.v3 import analyze as _dt3_analyze
            from concurrent.futures import ThreadPoolExecutor as _DTPool
            from concurrent.futures import TimeoutError as _DTTimeout
            with _DTPool(max_workers=1) as _ex:
                _fut = _ex.submit(_dt3_analyze, ticker, daily=daily_df)
                try:
                    _dt3 = _fut.result(timeout=6.0)
                except _DTTimeout:
                    _scanner_logger.warning(
                        f"[scanner] {ticker}: v3 analyze timed out after 6s — "
                        f"dt3_* fields will be null"
                    )
                    _dt3 = {"signal": {}, "levels": {}}
            _sig  = _dt3.get("signal") or {}
            _lvl  = _dt3.get("levels") or {}
            _tgts = _sig.get("targets") or []
            # Always set dt3_setup to something so the frontend can render a
            # heartbeat. Map an analyze() error result to "no_setup" so the
            # waiting line shows instead of the block disappearing.
            _setup_val = _sig.get("setup")
            if not _setup_val:
                _setup_val = "no_setup" if _lvl else "error"
                _soft_err = _dt3.get("error")
                if not _sig.get("rationale"):
                    _sig["rationale"] = (
                        _soft_err or "v3: no signal produced "
                        "(timeout / disabled / missing bars)"
                    )
                # Soft errors (analyze() returned {"error": ...} instead of
                # raising) used to be invisible because no exception fired.
                # Log them now so the cause shows in the backend console.
                if _setup_val == "error" and _soft_err:
                    _scanner_logger.warning(
                        f"[scanner] {ticker}: v3 soft-error — {_soft_err}"
                    )
            cpr.update({
                "dt3_setup":      _setup_val,
                "dt3_side":       _sig.get("side"),
                "dt3_grade":      _sig.get("grade"),
                "dt3_level":      _sig.get("level"),
                "dt3_level_val":  _sig.get("level_val"),
                "dt3_entry":      _sig.get("entry"),
                "dt3_stop":       _sig.get("stop"),
                "dt3_t1":         _tgts[0] if len(_tgts) >= 1 else None,
                "dt3_t2":         _tgts[1] if len(_tgts) >= 2 else None,
                "dt3_rr":         _sig.get("rr"),
                "dt3_rationale":  _sig.get("rationale"),
                "dt3_pdh":        _lvl.get("pdh"),
                "dt3_pdl":        _lvl.get("pdl"),
                "dt3_pwh":        _lvl.get("pwh"),
                "dt3_pwl":        _lvl.get("pwl"),
            })
        except StopIteration:
            pass
        except Exception as _dt3_err:
            # Loud-but-bounded: log the cause so silent v3 disappearance has
            # a name. Still surface a heartbeat to the UI so the user sees
            # "v3 errored" instead of an invisible column.
            _scanner_logger.warning(
                f"[scanner] {ticker}: v3 raised — "
                f"{type(_dt3_err).__name__}: {str(_dt3_err)[:160]}"
            )
            cpr.update({
                "dt3_setup":      "error",
                "dt3_rationale":  f"{type(_dt3_err).__name__}: "
                                  f"{str(_dt3_err)[:120]}",
            })

        # Short interest (best-effort)
        short_pct = None
        # Sector resolution: ETFs use the static map; for stocks prefer the
        # value baked into `fundamentals` (already fetched + cached for the
        # day), so sector populates without needing SHORT_FLOAT enabled.
        sector = _sector_for_ticker(ticker)
        if not is_etf:
            fund_sector = (fundamentals.get("sector") or "").strip()
            if fund_sector and fund_sector != "N/A":
                sector = fund_sector
        if include_fundamentals and _SCAN_INCLUDE_SHORT_FLOAT and not is_etf:
            try:
                info = yf.Ticker(ticker).info
                v = info.get("shortPercentOfFloat")
                if v is not None:
                    short_pct = round(float(v) * 100, 1)
                # yfinance info has the freshest sector — let it win if set.
                sector = _sector_for_ticker(ticker, info) or sector
            except Exception:
                pass
        elif not is_etf:
            short_pct = fundamentals.get("short_pct_float")

        # Options strategy (Alpaca-only; keep off the scan hot path unless enabled).
        opt_strategy = opt_summary = opt_debit = opt_profit = opt_source = opt_quote_ts = None
        opt_legs = opt_width = opt_exp_short = opt_exp_long = opt_alt = None
        opt_liquid: list = []
        opt_disabled_reason: Optional[str] = None
        if include_options and _SCAN_INCLUDE_OPTIONS and not is_etf:
            try:
                strat = get_options_strategy(ticker, price, direction, ALPACA_API_KEY, ALPACA_API_SECRET)
                if strat is None:
                    # Most common: empty/invalid creds → _fetch_contracts_alpaca
                    # returns nothing → options.py:392 returns None. Make it
                    # visible per-ticker so the cause stops being a mystery.
                    opt_disabled_reason = "no contracts (auth/empty chain)"
                    _scanner_logger.warning(
                        f"[scanner] {ticker}: options=None — likely Alpaca "
                        f"auth failed or no contracts. dir={direction}"
                    )
                elif strat.get("summary"):
                    opt_strategy  = strat.get("strategy")
                    opt_summary   = strat.get("summary")
                    opt_debit     = strat.get("net_debit")
                    opt_profit    = strat.get("max_profit")
                    opt_source    = strat.get("source")
                    opt_quote_ts  = strat.get("quote_ts")
                    opt_legs      = strat.get("legs")
                    opt_width     = strat.get("width")
                    opt_exp_short = strat.get("exp_short")
                    opt_exp_long  = strat.get("exp_long")
                    opt_alt       = strat.get("alt")
                else:
                    opt_disabled_reason = "no summary built"
            except Exception as _opt_err:
                opt_disabled_reason = f"strategy raised: {type(_opt_err).__name__}: {str(_opt_err)[:120]}"
                _scanner_logger.warning(
                    f"[scanner] {ticker}: options strategy raised — {opt_disabled_reason}"
                )

        # OTM liquid options (Alpaca-only; optional because it adds one API call).
        if include_options and _SCAN_INCLUDE_OPTIONS and not is_etf:
            try:
                bias = get_options_bias(ticker, price, ALPACA_API_KEY, ALPACA_API_SECRET)
                opt_liquid = bias.get("otm_liquid", [])[:5]
            except Exception as _bias_err:
                _scanner_logger.warning(
                    f"[scanner] {ticker}: options bias raised — "
                    f"{type(_bias_err).__name__}: {str(_bias_err)[:120]}"
                )

        # Backtest only: one forward-bar fetch powers both metrics.
        # Next-day close stays long-only (UI labels it so); the swing-plan
        # sim is direction-aware by verdict (long unless bearish).
        bt_scan_date = bt_next_date = bt_next_close = bt_next_chg_pct = None
        bt_next_positive = None
        bt_swing_outcome = bt_swing_r = bt_swing_bars = None
        if as_of:
            scan_d  = _bar_date(daily_df)
            horizon = max(3, min(int(trade.get("t1_days") or 10), 10))
            fwd = _forward_bars(ticker, scan_d, horizon)
            if fwd is not None and not fwd.empty:
                bt_scan_date = scan_d.isoformat()
                ccf = _col(fwd, "close")
                nd_close = round(float(fwd.iloc[0][ccf]), 2)
                if price > 0:
                    bt_next_date     = _idx_date(fwd.index[0]).isoformat()
                    bt_next_close    = nd_close
                    bt_next_chg_pct  = round((nd_close - price) / price * 100, 2)
                    bt_next_positive = bool(nd_close > price)
                sim = _simulate_swing(
                    fwd, direction,
                    trade.get("entry"), trade.get("stop_loss"),
                    trade.get("target1"),
                )
                bt_swing_outcome = sim["outcome"]
                bt_swing_r       = sim["r_mult"]
                bt_swing_bars    = sim["bars"]

        _row = {
            "ticker":       ticker,
            "sector":       sector,
            "price":        price,
            "verdict":      verdict,
            **flip_info,
            "confidence":   confidence,
            "score":        score,
            "direction":    direction,
            "entry_grade":  grade["entry_grade"],
            "entry_label":  grade["entry_label"],
            "grade_color":  grade["grade_color"],
            "expected_wr":  grade["expected_wr"],
            "mtf_rank":     signal["rank"],
            "mtf_signal":   signal["signal"],
            "mtf_action":   signal["action"],
            "mtf_key":      signal["key"],
            "weekly_bias":  weekly,
            "daily_bias":   daily_b,
            "vol_trend":    vol_profile.get("vol_trend", "N/A"),
            "vol_surge":    vol_profile.get("vol_surge", False),
            "breakout_score": strategy_sig.get("breakout_score", 0),
            "dist_from_high": strategy_sig.get("dist_from_high", None),
            "short_pct":    short_pct,
            "entry":        trade.get("entry"),
            "stop_loss":    trade.get("stop_loss"),
            "target1":      trade.get("target1"),
            "target2":      trade.get("target2"),
            "t1_days":      trade.get("t1_days"),
            "t1_days_min":  trade.get("t1_days_min"),
            "t1_days_max":  trade.get("t1_days_max"),
            "t1_days_text": trade.get("t1_days_text"),
            "t1_days_basis": trade.get("t1_days_basis"),
            "t2_days":      trade.get("t2_days"),
            "t2_days_min":  trade.get("t2_days_min"),
            "t2_days_max":  trade.get("t2_days_max"),
            "t2_days_text": trade.get("t2_days_text"),
            "t2_days_basis": trade.get("t2_days_basis"),
            "risk_pct":     trade.get("risk_pct"),
            "rr_t1":        trade.get("rr_t1"),
            "atr":          trade.get("atr"),
            "swing_invalidation":      trade.get("swing_invalidation"),
            "swing_invalidation_text": trade.get("swing_invalidation_text"),
            "opt_strategy":  opt_strategy,
            "opt_summary":   opt_summary,
            "opt_debit":     opt_debit,
            "opt_profit":    opt_profit,
            "opt_source":    opt_source,
            "opt_quote_ts":  opt_quote_ts,
            "opt_legs":      opt_legs,
            "opt_width":     opt_width,
            "opt_exp_short": opt_exp_short,
            "opt_exp_long":  opt_exp_long,
            "opt_alt":       opt_alt,
            "opt_liquid":    opt_liquid,
            "btd_state":     btd["btd_state"],
            "btd_zone":      btd["btd_zone"],
            "btd_reason":    btd["btd_reason"],
            "btd_size":      btd["btd_size"],
            "ema11":         btd["ema11"],
            "ema20":         btd["ema20"],
            "ema50":         btd["ema50"],
            "ema200":        btd["ema200"],
            "ema50_slope_pct": btd["ema50_slope_pct"],
            "w30ma":         w30["w30ma"],
            "w30ma_curl":    w30["w30ma_curl"],
            "w30ma_slope_pct": w30["w30ma_slope_pct"],
            "w30ma_reason":  w30["w30ma_reason"],
            "wk_atr":        wkatr["wk_atr"],
            "wk_atr_pct":    wkatr["wk_atr_pct"],
            "news":          news_label,
            "news_good":     news_good,
            "news_bad":      news_bad,
            "news_headlines": news_headlines,
            "next_earnings": next_earnings,
            "bt_scan_date":     bt_scan_date,
            "bt_next_date":     bt_next_date,
            "bt_next_close":    bt_next_close,
            "bt_next_chg_pct":  bt_next_chg_pct,
            "bt_next_positive": bt_next_positive,
            "bt_swing_outcome": bt_swing_outcome,
            "bt_swing_r":       bt_swing_r,
            "bt_swing_bars":    bt_swing_bars,
            "signals":       fundamental_signals,
            **valuation,
            **fib_targets,
            **cpr,
            **lre,
            **_compute_swing_levels(daily_df),
            "error":         None,
        }
        # Telegram alert on fresh V3 fire — gated by Actionable / Exceptional
        # / Rank 1 (all subsume mtf_rank==1). Daily dedup is inside the helper
        # so this is safe to call on every scan.
        _tier = _v3_qualifying_tier(_row) if include_day_trading else None
        if _tier:
            _v3_alert_once(ticker, _row, tier=_tier)
        return _row
    except Exception as e:
        return {"ticker": ticker, "error": str(e)[:120], "score": 0}


# ── Parallel scan yielding results as they complete ───────────────────────────

def scan_watchlist_stream(tickers: list[str], max_workers: int = 12) -> Iterator[dict]:
    """Yields scan results one-by-one as each ticker finishes."""
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(scan_single, t): t for t in tickers}
        for fut in as_completed(futures):
            yield fut.result()
