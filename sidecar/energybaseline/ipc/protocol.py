"""
NDJSON JSON-RPC 2.0 over stdin/stdout (IPC-1..IPC-10, LIF-1).

The original stdout descriptor is duplicated for protocol frames, then fd 1 and
sys.stdout are redirected to stderr so stray prints cannot corrupt the stream.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional, TextIO

from energybaseline.config.settings import resolve_database
from energybaseline.sql.guard import validate_readonly_sql

PROTOCOL_VERSION = "1.0"
SIDECAR_VERSION = "5.2.0"
MAX_FRAME_BYTES = 1024 * 1024  # 1 MiB (IPC-1)
LOGGER = logging.getLogger("energybaseline.ipc")

# Keep this in sync with the Rust compile-time method allowlist (SCR-7 / ARC-6).
ALLOWLISTED_METHODS = {
    "data.ingest",
    "data.window",
    "vsg.get",
    "vsg.set",
    "vsg.preset_save",
    "vsg.preset_load",
    "tcp.get",
    "tcp.set",
    "tcp.estimate",
    "tcp.reevaluate",
    "analysis.run",
    "analysis.cancel",
    "diagnostics.run",
    "model.predict",
    "model.export",
    "model.card",
    "report.generate",
    "report.diff",
    "sql.test_connection",
    "sql.run_query",
    "session.save",
    "session.load",
    "system.status",
    "system.health",
    "system.sbom",
}


def _is_valid_id(value: Any) -> bool:
    # JSON-RPC IDs may be strings, numbers, or null, but not arrays or objects.
    return value is None or isinstance(value, (str, int, float)) and not isinstance(value, bool)


class SidecarIpcServer:
    def __init__(
        self,
        proto_out: TextIO,
        app_home: Optional[str] = None,
        log_path: Optional[str] = None,
    ) -> None:
        self.proto_out = proto_out
        self.app_home = app_home or os.environ.get("APP_HOME")
        self.log_path = str(
            log_path
            or os.environ.get("ENERGYBASELINE_LOG_PATH")
            or Path(self.app_home or Path.home()) / "logs" / "sidecar.log"
        )
        self.cancelled_ids: set[Any] = set()
        # Do not touch the filesystem until the shell has supplied the canonical
        # APP_HOME in its hello frame.
        self.db_resolution = None
        self.db_error: Optional[str] = None
        self.handshaken = False

    def send_frame(self, payload: Dict[str, Any]) -> None:
        raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
        if len(raw.encode("utf-8")) > MAX_FRAME_BYTES:
            raw = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": payload.get("id"),
                    "error": {
                        "code": -32004,
                        "app_code": "VALIDATION",
                        "message": f"Frame exceeded {MAX_FRAME_BYTES} bytes limit (IPC-1).",
                        "log_ref": self.log_path,
                    },
                },
                separators=(",", ":"),
            )
        self.proto_out.write(raw + "\n")
        self.proto_out.flush()

    def _error(
        self,
        req_id: Any,
        code: int,
        app_code: str,
        message: str,
    ) -> None:
        self.send_frame(
            {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": code,
                    "app_code": app_code,
                    "message": message,
                    "log_ref": self.log_path,
                },
            }
        )

    def handle_hello(self, msg: Dict[str, Any]) -> bool:
        proto = str(msg.get("protocol_version", ""))
        if proto != PROTOCOL_VERSION:
            self.send_frame(
                {
                    "type": "sidecar.fatal",
                    "app_code": "PROTOCOL_VERSION",
                    "message": f"Protocol mismatch: expected {PROTOCOL_VERSION}, got {proto}",
                    "log_path": self.log_path,
                }
            )
            return False

        app_home = msg.get("app_home")
        if not isinstance(app_home, str) or not app_home.strip():
            self.send_frame(
                {
                    "type": "sidecar.fatal",
                    "app_code": "VALIDATION",
                    "message": "The hello frame must include a non-empty app_home.",
                    "log_path": self.log_path,
                }
            )
            return False

        self.app_home = app_home
        try:
            self.db_resolution = resolve_database(self.app_home)
            self.db_error = None
        except Exception as exc:
            # A resolver exception is reported as an unavailable DB, not an IPC crash.
            LOGGER.exception("Database resolver failed during handshake")
            self.db_resolution = None
            self.db_error = str(exc)

        db = self._db_status()
        self.handshaken = True
        self.send_frame(
            {
                "type": "sidecar.ready",
                "pid": os.getpid(),
                "protocol_version": PROTOCOL_VERSION,
                "sidecar_version": SIDECAR_VERSION,
                "db": db,
                "log_path": self.log_path,
            }
        )
        return True

    def _db_status(self) -> Dict[str, Any]:
        resolution = self.db_resolution
        if resolution is None:
            return {
                "ok": False,
                "url_masked": "unavailable",
                "fallback": True,
                "fallback_tier": "unavailable",
                "writable": False,
                "warning": "Database initialization failed; see the sidecar log.",
            }
        return {
            "ok": True,
            "url_masked": resolution.url_masked,
            "fallback": resolution.fallback,
            "fallback_tier": resolution.fallback_tier,
            "writable": True,
            "warning": resolution.warning,
        }

    def _send_progress(self, req_id: Any, *, stage: str, percent: int) -> None:
        # The system.status slice is intentionally a single completion notification;
        # longer operations must coalesce updates to no more than 10 Hz.
        self.send_frame(
            {
                "jsonrpc": "2.0",
                "method": "sidecar.progress",
                "params": {
                    "request_id": req_id,
                    "target": "system",
                    "stage": stage,
                    "percent": percent,
                },
            }
        )

    def dispatch_rpc(self, req: Dict[str, Any]) -> None:
        req_id = req.get("id")
        if req.get("jsonrpc") != "2.0":
            self._error(req_id, -32600, "VALIDATION", "Request must use JSON-RPC 2.0.")
            return
        if not _is_valid_id(req_id):
            self._error(None, -32600, "VALIDATION", "Request id must be a string, number, or null.")
            return

        method = req.get("method")
        if not isinstance(method, str) or not method:
            self._error(req_id, -32600, "VALIDATION", "Request method must be a non-empty string.")
            return
        params = req.get("params", {})
        if params is None:
            params = {}
        if not isinstance(params, dict):
            self._error(req_id, -32602, "VALIDATION", "Request params must be a JSON object.")
            return

        if method == "rpc_cancel":
            target_id = params.get("id")
            if not _is_valid_id(target_id):
                self._error(req_id, -32602, "VALIDATION", "Cancellation id must be a string, number, or null.")
                return
            self.cancelled_ids.add(target_id)
            self.send_frame(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {"cancelled": target_id},
                }
            )
            return

        if not self.handshaken:
            self._error(req_id, -32001, "INTERNAL", "Sidecar handshake has not completed.")
            return

        if method not in ALLOWLISTED_METHODS:
            self._error(req_id, -32601, "VALIDATION", f"Method '{method}' is not on the sidecar allowlist.")
            return

        if method == "system.status":
            if req_id in self.cancelled_ids:
                self.cancelled_ids.discard(req_id)
                self._error(req_id, -32800, "CANCELLED", "The request was cancelled.")
                return
            self._send_progress(req_id, stage="status", percent=100)
            self.send_frame(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "pid": os.getpid(),
                        "protocol_version": PROTOCOL_VERSION,
                        "sidecar_version": SIDECAR_VERSION,
                        "db": self._db_status(),
                        "db_error": self.db_error,
                        "matplotlib_loaded": "matplotlib" in sys.modules,
                        "log_path": self.log_path,
                    },
                }
            )
            return

        if method == "system.health":
            try:
                resolution = resolve_database(self.app_home)
            except Exception as exc:
                self._error(req_id, -32003, "INTERNAL", "Database health check failed; see the sidecar log.")
                LOGGER.exception("Database health check failed")
                return
            self.send_frame(
                {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "ok": True,
                        "url_masked": resolution.url_masked,
                        "fallback": resolution.fallback,
                        "fallback_tier": resolution.fallback_tier,
                        "writable": True,
                        "warning": resolution.warning,
                        "log_path": self.log_path,
                    },
                }
            )
            return

        if method == "sql.run_query":
            sql = str(params.get("sql", ""))
            decision = validate_readonly_sql(sql)
            if not decision.allowed:
                self._error(req_id, -32002, "DATA_REFUSED", decision.reason)
                return
            self._error(
                req_id,
                -32601,
                "VALIDATION",
                "Read-only SQL passed safety validation, but query execution is not implemented in this build.",
            )
            return

        # The rest of SCR-7 is intentionally reserved for later vertical slices.
        # Return an error rather than hanging callers or returning fabricated data.
        self._error(req_id, -32601, "VALIDATION", f"Method '{method}' is allowlisted but not implemented yet.")

    def serve_forever(self, stdin: TextIO) -> int:
        # The first line is the hello handshake (IPC-8); thereafter only RPC frames are accepted.
        for raw_line in stdin:
            line = raw_line.rstrip("\r\n")
            if not line:
                continue
            if len(line.encode("utf-8")) > MAX_FRAME_BYTES:
                self._error(None, -32004, "VALIDATION", f"Inbound frame exceeds {MAX_FRAME_BYTES} bytes (IPC-1).")
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as exc:
                self._error(None, -32700, "VALIDATION", f"Invalid JSON frame: {exc.msg}.")
                continue
            if not isinstance(msg, dict):
                self._error(None, -32600, "VALIDATION", "Each NDJSON frame must be a JSON object.")
                continue

            if "protocol_version" in msg and "method" not in msg:
                if not self.handle_hello(msg):
                    return 2
            else:
                self.dispatch_rpc(msg)

        # Stdin EOF is the authoritative graceful-shutdown signal (LIF-1).
        return 0


def isolate_protocol_stdout() -> TextIO:
    """Duplicate original fd 1 for NDJSON, then redirect sys.stdout and fd 1 to stderr."""
    proto_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(proto_fd, "w", encoding="utf-8", buffering=1)
