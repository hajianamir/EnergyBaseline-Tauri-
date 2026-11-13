"""
Single database configuration and zero-fail SQLite fallback resolver (DB-1..DB-11).
Only this module reads DB environment variables; all other modules call get_database_url().
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import sqlite3
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger("energybaseline.db")

ENV_PRIORITY = (
    "EB_DATABASE_URL",
    "DATABASE_URL",
    "POSTGRES_URL",
    "DB_CONNECTION_STRING",
    "DB_URI",
)

CANONICAL_DEFAULT_URL = "sqlite:///./data/app.db"


@dataclass
class DbResolution:
    url: str
    url_masked: str
    fallback: bool
    fallback_tier: str  # "primary" | "app_home_sqlite" | "temp_sqlite" | "memory_sqlite"
    warning: Optional[str]
    sqlite_path: Optional[Path]


def mask_url_credentials(url: str) -> str:
    return re.sub(r"://([^:/?#]+):([^@/?#]+)@", r"://\1:***@", url)


def resolve_app_home(explicit_app_home: Optional[str] = None) -> Path:
    if explicit_app_home and explicit_app_home.strip():
        return Path(explicit_app_home.strip())
    env_home = os.environ.get("APP_HOME", "").strip()
    if env_home:
        return Path(env_home)
    exe_dir = Path(__file__).resolve().parents[3]
    if (exe_dir / "portable.flag").exists():
        return exe_dir
    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    if local_app_data:
        return Path(local_app_data) / "EnergyBaseline"
    return Path.home() / ".local" / "share" / "EnergyBaseline"


def _resolve_sqlite_relative(url: str, app_home: Path) -> Path:
    # Handle sqlite:///./data/app.db or sqlite:///relative.db against APP_HOME, never CWD (DB-3)
    raw = url[len("sqlite:///") :]
    if raw == ":memory:":
        return Path(":memory:")
    p = Path(raw)
    if not p.is_absolute():
        return (app_home / p).resolve()
    return p


def _sqlite_url(path: Path) -> str:
    if str(path) == ":memory:":
        return "sqlite:///:memory:"
    # as_posix keeps SQLAlchemy URLs valid on Windows (C:/..., not C:\\...).
    return f"sqlite:///{path.as_posix()}"


def _probe_non_sqlite(url: str, timeout_sec: float = 3.0) -> tuple[bool, str]:
    # Non-SQLite URL probe (DB-6); without external driver or unreachable host -> degrade cleanly
    try:
        from urllib.parse import urlparse
        import socket

        parsed = urlparse(url)
        host = parsed.hostname or "localhost"
        port = parsed.port or (5432 if "postgres" in (parsed.scheme or "") else 3306)
        with socket.create_connection((host, port), timeout=timeout_sec):
            return True, "reachable"
    except Exception as exc:
        return False, str(exc)


def _test_sqlite_writable(db_path: Path) -> tuple[bool, str]:
    try:
        if str(db_path) != ":memory:":
            db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(db_path), timeout=5.0)
        try:
            conn.execute("PRAGMA journal_mode=WAL;")
            conn.execute("PRAGMA foreign_keys=ON;")
            conn.execute("PRAGMA busy_timeout=5000;")
            conn.execute("PRAGMA synchronous=NORMAL;")
            conn.execute(
                "CREATE TABLE IF NOT EXISTS health (id INTEGER PRIMARY KEY, checked_at TEXT NOT NULL)"
            )
            now = datetime.now(timezone.utc).isoformat()
            conn.execute("INSERT OR REPLACE INTO health (id, checked_at) VALUES (1, ?)", (now,))
            conn.commit()
            row = conn.execute("SELECT checked_at FROM health WHERE id = 1").fetchone()
            if not row:
                return False, "Sentinel read-back failed"
            return True, "ok"
        finally:
            conn.close()
    except Exception as exc:
        return False, str(exc)


def resolve_database(explicit_app_home: Optional[str] = None) -> DbResolution:
    app_home = resolve_app_home(explicit_app_home)
    configured: Optional[str] = None
    for key in ENV_PRIORITY:
        val = os.environ.get(key, "")
        if val and val.strip():
            configured = val.strip()
            break

    candidate_url = configured or CANONICAL_DEFAULT_URL

    # Tier 1: Configured non-SQLite URL
    if not candidate_url.startswith("sqlite:"):
        ok, err = _probe_non_sqlite(candidate_url, timeout_sec=3.0)
        if ok:
            masked = mask_url_credentials(candidate_url)
            logger.info("db.url_resolved url=%s fallback=false", masked)
            return DbResolution(
                url=candidate_url,
                url_masked=masked,
                fallback=False,
                fallback_tier="primary",
                warning=None,
                sqlite_path=None,
            )
        warning_msg = f"External DB unreachable ({err}); degraded to local SQLite under APP_HOME."
        candidate_url = CANONICAL_DEFAULT_URL
        fallback = True
    else:
        warning_msg = None
        fallback = False

    # Tier 2: SQLite under APP_HOME (or an explicitly configured in-memory URL).
    sqlite_path = _resolve_sqlite_relative(candidate_url, app_home)
    ok, err = _test_sqlite_writable(sqlite_path)
    if ok and str(sqlite_path) == ":memory:":
        memory_warning = "Configured in-memory SQLite is volatile; data will be lost when the app closes."
        logger.warning("db.url_resolved url=sqlite:///:memory: fallback=true tier=memory")
        return DbResolution(
            url="sqlite:///:memory:",
            url_masked="sqlite:///:memory:",
            fallback=True,
            fallback_tier="memory_sqlite",
            warning=memory_warning,
            sqlite_path=None,
        )
    if ok:
        resolved_url = _sqlite_url(sqlite_path)
        masked = mask_url_credentials(resolved_url)
        logger.info("db.url_resolved url=%s fallback=%s", masked, str(fallback).lower())
        return DbResolution(
            url=resolved_url,
            url_masked=masked,
            fallback=fallback,
            fallback_tier="app_home_sqlite" if fallback else "primary",
            warning=warning_msg,
            sqlite_path=sqlite_path,
        )

    # Tier 3: %TEMP%/EnergyBaseline fallback (DB-5)
    temp_path = Path(tempfile.gettempdir()) / "EnergyBaseline" / "data" / "app.db"
    ok_temp, err_temp = _test_sqlite_writable(temp_path)
    if ok_temp:
        resolved_url = _sqlite_url(temp_path)
        logger.warning("db.url_resolved url=%s fallback=true tier=temp", resolved_url)
        return DbResolution(
            url=resolved_url,
            url_masked=resolved_url,
            fallback=True,
            fallback_tier="temp_sqlite",
            warning=" ".join(filter(None, [
                warning_msg,
                f"APP_HOME unwritable ({err}); using temporary storage ({temp_path}) — data may be lost.",
            ])),
            sqlite_path=temp_path,
        )

    # Tier 4: In-memory SQLite (Zero-fail boot guaranteed)
    logger.error("db.url_resolved url=sqlite:///:memory: fallback=true tier=memory")
    return DbResolution(
        url="sqlite:///:memory:",
        url_masked="sqlite:///:memory:",
        fallback=True,
        fallback_tier="memory_sqlite",
        warning=" ".join(filter(None, [
            warning_msg,
            f"Disk storage unavailable ({err_temp}); running on volatile in-memory SQLite.",
        ])),
        sqlite_path=None,
    )


def get_database_url(explicit_app_home: Optional[str] = None) -> str:
    return resolve_database(explicit_app_home).url


def get_engine_url(explicit_app_home: Optional[str] = None) -> str:
    return get_database_url(explicit_app_home)


def online_sqlite_backup(src_db: Path, dest_zip_member_path: Path) -> None:
    """PER-4 / DB-10: Use SQLite online backup API, never raw file copy of a live WAL DB."""
    dest_zip_member_path.parent.mkdir(parents=True, exist_ok=True)
    src = sqlite3.connect(str(src_db), timeout=5.0)
    dst = sqlite3.connect(str(dest_zip_member_path))
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
