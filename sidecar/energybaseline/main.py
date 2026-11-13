"""
EnergyBaseline Python Sidecar entry point (SCR-1..SCR-7).
"""

from __future__ import annotations

import logging
import multiprocessing
import os
import sys
import tempfile
from pathlib import Path

# Ensure package import works whether launched directly or frozen via PyInstaller onedir.
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from energybaseline.ipc.protocol import SidecarIpcServer, isolate_protocol_stdout  # noqa: E402


def _configure_logging() -> str:
    configured = os.environ.get("ENERGYBASELINE_LOG_PATH", "").strip()
    app_home = os.environ.get("APP_HOME", "").strip()
    candidates = []
    if configured:
        candidates.append(Path(configured))
    if app_home:
        candidates.append(Path(app_home) / "logs" / "sidecar.log")
    candidates.append(Path(tempfile.gettempdir()) / "EnergyBaseline" / "logs" / "sidecar.log")

    for log_path in candidates:
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            handler = logging.FileHandler(log_path, encoding="utf-8")
            logging.basicConfig(
                level=logging.INFO,
                format="%(asctime)s %(levelname)s %(name)s %(message)s",
                handlers=[handler],
                force=True,
            )
            return str(log_path)
        except OSError:
            continue

    # Logging must never prevent the stdio service from booting. Stderr is a
    # development-only fallback; release builds discard logs if no file is writable.
    if os.environ.get("ENERGYBASELINE_DEBUG") == "1":
        logging.basicConfig(
            level=logging.WARNING,
            format="%(asctime)s %(levelname)s %(name)s %(message)s",
            stream=sys.stderr,
            force=True,
        )
        return "stderr"
    logging.basicConfig(
        level=logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=[logging.NullHandler()],
        force=True,
    )
    return "unavailable"


def main() -> int:
    multiprocessing.freeze_support()
    try:
        multiprocessing.set_start_method("spawn", force=True)
    except RuntimeError:
        pass

    log_path = _configure_logging()
    proto_out = isolate_protocol_stdout()
    # A debug-only marker proves stdout is isolated from the NDJSON protocol.
    if os.environ.get("ENERGYBASELINE_DEBUG") == "1":
        print("sidecar.booting (redirected to stderr)")
    logging.getLogger("energybaseline").info("sidecar.booting")
    server = SidecarIpcServer(proto_out=proto_out, app_home=os.environ.get("APP_HOME"), log_path=log_path)
    return server.serve_forever(sys.stdin)


if __name__ == "__main__":
    raise SystemExit(main())
