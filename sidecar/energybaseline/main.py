"""
EnergyBaseline Python Sidecar entry point (SCR-1..SCR-7).
"""

from __future__ import annotations

import multiprocessing
import sys
from pathlib import Path

# Ensure package import works whether launched directly or frozen via PyInstaller onedir
_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from energybaseline.ipc.protocol import SidecarIpcServer, isolate_protocol_stdout  # noqa: E402


def main() -> int:
    multiprocessing.freeze_support()
    try:
        multiprocessing.set_start_method("spawn", force=True)
    except RuntimeError:
        pass

    proto_out = isolate_protocol_stdout()
    # Prove stray print() goes to stderr, never corrupting NDJSON protocol stdout (IPC-2)
    print("sidecar.booting (redirected to stderr)")
    server = SidecarIpcServer(proto_out=proto_out)
    return server.serve_forever(sys.stdin)


if __name__ == "__main__":
    raise SystemExit(main())
