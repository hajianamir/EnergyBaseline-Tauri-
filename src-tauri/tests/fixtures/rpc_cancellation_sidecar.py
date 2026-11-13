"""Test peer using the production protocol while leaving one RPC pending."""

from __future__ import annotations

import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "sidecar"))

from energybaseline.ipc.protocol import SidecarIpcServer, isolate_protocol_stdout  # noqa: E402


def main() -> int:
    server = SidecarIpcServer(proto_out=isolate_protocol_stdout())
    dispatch_rpc = server.dispatch_rpc

    def dispatch_with_pending_fixture(request: dict[str, object]) -> None:
        # Keep this request outstanding until the Rust bridge sends rpc_cancel.
        # All other traffic uses the actual production JSON-RPC implementation.
        if request.get("method") == "test.wait":
            return
        dispatch_rpc(request)

    server.dispatch_rpc = dispatch_with_pending_fixture  # type: ignore[method-assign]
    return server.serve_forever(sys.stdin)


if __name__ == "__main__":
    raise SystemExit(main())
