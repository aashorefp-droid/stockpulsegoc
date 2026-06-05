"""
Runtime configuration — secrets come ONLY from environment variables.

No secret values are committed here. For local dev, put them in a gitignored
`.env` (see `.env.example`); in production set them in the Render dashboard
(Environment, sync:false). Missing required secrets are logged loudly at
startup but do not hard-crash the process (dependent features degrade).
"""
import os
import logging

logger = logging.getLogger(__name__)

# ── .env loading for local dev — dependency-free (works without python-dotenv) ──
def _load_env_file(path: str) -> int:
    """Minimal KEY=VALUE parser. Only sets vars not already in the env."""
    n = 0
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                k = k.strip()
                v = v.strip().rstrip(",").strip().strip('"').strip("'")
                # Skip empty values — a placeholder line like `KEY=` would
                # otherwise pollute os.environ and shadow a real value coming
                # from a different layer (e.g. streamlit/config.py's
                # os.getenv defaults). Only non-empty values are loaded.
                if k and v and k not in os.environ:
                    os.environ[k] = v
                    n += 1
    except Exception:
        pass
    return n


_here = os.path.dirname(os.path.abspath(__file__))
for _p in (
    os.path.join(_here, ".env"),               # chatgpt/backend/.env
    os.path.join(_here, "..", ".env"),         # chatgpt/.env
    os.path.join(_here, "..", "..", ".env"),   # repo-root/.env
):
    if os.path.exists(_p):
        _load_env_file(_p)
        break  # first one wins


# ── Local-dev fallback: streamlit/config.py ─────────────────────────────────
# If the user keeps live keys in the streamlit-root config.py (gitignored),
# import it once and use those values when an env var isn't otherwise set.
# Production (Render) has env vars set and this file isn't present, so the
# import quietly fails and _req() still reports `missing`.
_legacy_cfg = None
_legacy_cfg_path = os.path.normpath(os.path.join(_here, "..", "..", "config.py"))
if os.path.exists(_legacy_cfg_path):
    try:
        import importlib.util as _ilu
        _spec = _ilu.spec_from_file_location("_stockpulse_legacy_cfg",
                                              _legacy_cfg_path)
        _legacy_cfg = _ilu.module_from_spec(_spec)
        _spec.loader.exec_module(_legacy_cfg)  # type: ignore[union-attr]
        logger.info("config: loaded local-dev fallback from %s",
                    _legacy_cfg_path)
    except Exception as _e:
        logger.warning("config: legacy config.py present but failed to "
                       "import (%s) — env-only mode", _e)
        _legacy_cfg = None


_missing: list[str] = []


def _req(name: str) -> str:
    """Required secret — env first, then streamlit/config.py fallback for
    local dev. Records (doesn't raise) when unset everywhere."""
    v = os.getenv(name, "").strip()
    if not v and _legacy_cfg is not None:
        v = str(getattr(_legacy_cfg, name, "") or "").strip()
    if not v:
        _missing.append(name)
    return v


def _opt(name: str, default: str) -> str:
    """Non-secret operational setting with a safe committed default."""
    return os.getenv(name, default)


# ── Secrets (env only — never commit values) ────────────────────────────────
ALPACA_API_KEY      = _req("ALPACA_API_KEY")
ALPACA_API_SECRET   = _req("ALPACA_API_SECRET")
POLYGON_API_KEY     = _req("POLYGON_API_KEY")

WATCHLIST_BOT_TOKEN = _req("WATCHLIST_BOT_TOKEN")
WATCHLIST_CHAT_ID   = _req("WATCHLIST_CHAT_ID")

GMAIL_USER          = _req("GMAIL_USER")
GMAIL_APP_PASSWORD  = _req("GMAIL_APP_PASSWORD")

# ── Non-secret operational config (safe to keep defaults in repo) ───────────
ALPACA_DATA_BASE    = _opt("ALPACA_DATA_BASE", "https://data.alpaca.markets")
GMAIL_IMAP_HOST     = _opt("GMAIL_IMAP_HOST", "imap.gmail.com")
TOS_EMAIL_FROM      = _opt("TOS_EMAIL_FROM", "thinkorswim.com")
TOS_EMAIL_SUBJECT   = _opt("TOS_EMAIL_SUBJECT", "Alert: New symbol")  # "" = any
TOS_LOOKBACK_DAYS   = int(_opt("TOS_LOOKBACK_DAYS", "2"))

# ── Telegram alerts and topic routing ───────────────────────────────────────
TELEGRAM_BOT_TOKEN = _opt("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = _opt("TELEGRAM_CHAT_ID", "")
TELEGRAM_GROUP_CHAT_ID = _opt("TELEGRAM_GROUP_CHAT_ID", "")
TELEGRAM_MESSAGE_THREAD_ID = _opt("TELEGRAM_MESSAGE_THREAD_ID", "")
TELEGRAM_SWING_MESSAGE_THREAD_ID = _opt("TELEGRAM_SWING_MESSAGE_THREAD_ID", "")
TELEGRAM_SPY_INTRADAY_MESSAGE_THREAD_ID = _opt("TELEGRAM_SPY_INTRADAY_MESSAGE_THREAD_ID", "")
TELEGRAM_EARNINGS_MESSAGE_THREAD_ID = _opt("TELEGRAM_EARNINGS_MESSAGE_THREAD_ID", "")
TELEGRAM_MOMENTUM_MESSAGE_THREAD_ID = _opt("TELEGRAM_MOMENTUM_MESSAGE_THREAD_ID", "")
TELEGRAM_MACRO_MESSAGE_THREAD_ID = _opt("TELEGRAM_MACRO_MESSAGE_THREAD_ID", "")
TELEGRAM_BREAKOUT_MESSAGE_THREAD_ID = _opt("TELEGRAM_BREAKOUT_MESSAGE_THREAD_ID", "50")

if _missing:
    logger.warning(
        "config: missing env var(s): %s — dependent features will be "
        "disabled until set (Render dashboard env / local .env).",
        ", ".join(_missing),
    )
