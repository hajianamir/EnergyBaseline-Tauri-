"""Test peer using the production protocol while leaving one RPC pending."""

from __future__ import annotations

import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "sidecar"))

from energybaseline.ipc.protocol import (  # noqa: E402
    CONTROL_ALLOWLISTED_METHODS,
    SidecarIpcServer,
    isolate_protocol_stdout,
)


def main() -> int:
    server = SidecarIpcServer(proto_out=isolate_protocol_stdout())
    production_dispatch_rpc = server.dispatch_rpc

    def dispatch_with_pending_fixture(request: dict[str, object]) -> None:
        # test.wait is fixture-only, intentionally unallowlisted, and intentionally
        # receives no response until the Rust bridge sends rpc_cancel. All other
        # traffic, including rpc_cancel, must use production dispatch.
        method = request.get("method")
        if method == "test.wait":
            return
        if method == "rpc_cancel" and method not in CONTROL_ALLOWLISTED_METHODS:
            raise AssertionError("rpc_cancel must be explicitly control-allowlisted")
        production_dispatch_rpc(request)
        if method == "rpc_cancel":
            params = request.get("params")
            target_id = params.get("id") if isinstance(params, dict) else None
            if target_id not in server.cancelled_ids:
                raise AssertionError("rpc_cancel did not reach production dispatch_rpc")

    server.dispatch_rpc = dispatch_with_pending_fixture  # type: ignore[method-assign]
    return server.serve_forever(sys.stdin)


if __name__ == "__main__":
    raise SystemExit(main())
