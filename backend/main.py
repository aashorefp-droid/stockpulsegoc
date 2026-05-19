import os
import logging
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)


def _configure_yfinance() -> None:
    cache_setting = os.getenv("YFINANCE_CACHE_DIR", "").strip()
    cache_dir = Path(cache_setting) if cache_setting else Path(tempfile.gettempdir()) / "py-yfinance"
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
        import yfinance as yf
        yf.set_tz_cache_location(str(cache_dir))
        logging.getLogger("yfinance").setLevel(logging.WARNING)
    except Exception as exc:
        logger.warning("yfinance cache configuration skipped: %s", exc)


_configure_yfinance()

from backend.routers import analysis, scanner, earnings, tracker, macro, telegram
from backend.routers import scheduler as scheduler_router
from backend.services.scheduler import scheduler, setup_scheduler


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_scheduler()
    scheduler.start()
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(title="StockPulse API", version="1.0.0", lifespan=lifespan)

_cors_env = os.getenv("CORS_ORIGINS", "")
_cors_origins = (
    [o.strip() for o in _cors_env.split(",") if o.strip()]
    if _cors_env
    else ["http://localhost:3000", "http://localhost:3001",
          "http://localhost:3002", "http://localhost:3003"]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

app.include_router(analysis.router)
app.include_router(scanner.router)
app.include_router(earnings.router)
app.include_router(tracker.router)
app.include_router(scheduler_router.router)
app.include_router(macro.router)
app.include_router(telegram.router)


@app.get("/health")
def health():
    from backend.services.scheduler import scheduler as sched
    from backend.db import gex_store
    return {
        "status":          "ok",
        "scheduler":       sched.running,
        "polling_active":  sched.get_job("eps_poll") is not None,
        "spy_gamma_job":   (
            sched.get_job("spy_gamma_open") is not None
            or sched.get_job("spy_gamma_close") is not None
        ),
        "sector_gamma_job": (
            sched.get_job("sector_gamma_open") is not None
            or sched.get_job("sector_gamma_close") is not None
        ),
        "gex_store":       gex_store.backend_name(),
    }
