"""
NDJSON JSON-RPC 2.0 over stdin/stdout (IPC-1..IPC-10, LIF-1).
Duplicates original stdout fd for protocol frames and redirects sys.stdout + fd 1 to stderr
so stray print() calls never corrupt NDJSON protocol frames (IPC-2).
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Callable, Dict, Optional, TextIO

from energybaseline.config.settings import resolve_database
from energybaseline.sql.guard import validate_readonly_sql

PROTOCOL_VERSION = "1.0"
SIDECAR_VERSION = "5.2.0"
MAX_FRAME_BYTES = 1024 * 1024  # 1 MiB (IPC-1)

ALLOWLISTED_METHODS = {
    "system.status",
    "system.health",
    "system.sbom",
    "sql.run_query",
    "sql.test_connection",
}


class SidecarIpcServer:
    def __init__(self, proto_out: TextIO, app_home: Optional[str] = None) -> None:
        self.proto_out = proto_out
        self.app_home = app_home
        self.cancelled_ids: set[Any] = set()
        self.db_resolution = resolve_database(app_home)

    def send_frame(self, payload: Dict[str, Any]) -> None:
        raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        encoded = raw.encode("utf-8")
        if len(encoded) > MAX_FRAME_BYTES:
            err_frame = {
                "jsonrpc": "2.0",
                "id": payload.get("id"),
                "error": {
                    "code": -32004,
                    "app_code": "VALIDATION",
                    "message": f"Frame exceeded {MAX_FRAME_BYTES} bytes limit (IPC-1).",
                },
            }
            self.proto_out.write(json.dumps(err_frame) + "\n")
            self.proto_out.flush()
            return
        self.proto_out.write(raw + "\n")
        self.proto_out.flush()

    def handle_hello(self, msg: Dict[str, Any]) -> bool:
        proto = str(msg.get("protocol_version", ""))
        if proto != PROTOCOL_VERSION:
            self.send_frame(
                {
                    "type": "sidecar.fatal",
                    "app_code": "PROTOCOL_VERSION",
                    "message": f"Protocol mismatch: expected {PROTOCOL_VERSION}, got {proto}",
                    "log_path": str(self.app_home or "") + "/logs/sidecar.log",
                }
            )
            return False

        if msg.get("app_home"):
            self.app_home = str(msg["app_home"])
            self.db_resolution = resolve_database(self.app_home)

        self.send_frame(
            {
                "type": "sidecar.ready",
                "pid": os.getpid(),
                "protocol_version": PROTOCOL_VERSION,
                "sidecar_version": SIDECAR_VERSION,
                "db": {
                    "ok": True,
                    "url_masked": self.db_resolution.url_masked,
                    "fallback": self.db_resolution.fallback,
                    "fallback_tier": self.db_resolution.fallback_tier,
                    "writable": self.db_resolution.fallback_tier != "memory_sqlite",
                    "warning": self.db_resolution.warning,
                },
            }
        )
        return True

    def dispatch_rpc(self, req: Dict[str, Any]) -> None:
        req_id = req.get("id")
        method = req.get("method", "")
        params = req.get("params") or {}

        if method == "rpc_cancel":
            target_id = params.get("id")
            self.cancelled_ids.add(target_id)
            self.send_frame({"jsonrpc": "2.0", "id": req_id, "result": {"cancelled": target_id}})
            return

        if method not in ALLOWLISTED_METHODS:
            self.send_frame(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": -32601,
                        "app_code": "VALIDATION",
                        "message": f"Method '{method}' is not in sidecar allowlist.",
                    },
                }
            )
            return

        if method == "system.status":
            self.send_frame(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "pid": os.getpid(),
                        "protocol_version": PROTOCOL_VERSION,
                        "sidecar_version": SIDECAR_VERSION,
                        "db_url_masked": self.db_resolution.url_masked,
                        "fallback": self.db_resolution.fallback,
                        "matplotlib_loaded": "matplotlib" in sys.modules,
                    },
                }
            )
        elif method == "system.health":
            res = resolve_database(self.app_home)
            self.send_frame(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "ok": True,
                        "url": res.url_masked,
                        "fallback": res.fallback,
                        "writable": res.fallback_tier != "memory_sqlite",
                        "warning": res.warning,
                    },
                }
            )
        elif method == "sql.run_query":
            sql = str(params.get("sql", ""))
            decision = validate_readonly_sql(sql)
            if not decision.allowed:
                self.send_frame(
                    {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {
                            "code": -32002,
                            "app_code": "DATA_REFUSED",
                            "message": decision.reason,
                        },
                    }
                )
                return
            self.send_frame(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {"allowed": True, "root_type": decision.root_type},
                }
            )
        elif method == "system.sbom":
            self.send_frame(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {"format": "CycloneDX-1.5", "components_count": 14},
                }
            )

    def serve_forever(self, stdin: TextIO) -> int:
        # First line may be hello handshake (IPC-8)
        for raw_line in stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as exc:
                self.send_frame(
                    {
                        "jsonrpc": "2.0",
                        "id": None,
                        "error": {"code": -32700, "app_code": "VALIDATION", "message": f"Invalid JSON: {exc}"},
                    }
                )
                continue

            if "protocol_version" in msg and "method" not in msg:
                ok = self.handle_hello(msg)
                if not ok:
                    return 2
            else:
                self.dispatch_rpc(msg)

        # Stdin EOF -> authoritative graceful shutdown (LIF-1)
        return 0


def isolate_protocol_stdout() -> TextIO:
    """Duplicate fd 1 for NDJSON protocol frames and redirect sys.stdout + fd 1 to stderr (IPC-2)."""
    proto_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(proto_fd, "w", encoding="utf-8", buffering=1)
