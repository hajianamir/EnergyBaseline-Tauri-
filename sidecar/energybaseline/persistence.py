"""Atomic local session persistence with versioned SQLite migrations and hash-chained audit."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from energybaseline.config.settings import online_sqlite_backup

LOGGER = logging.getLogger("energybaseline.persistence")
CURRENT_SCHEMA_VERSION = 2
MAX_SESSION_BYTES = 512 * 1024
GENESIS_HASH = "0" * 64
MAX_SESSION_ID_LENGTH = 128
MAX_JSON_DEPTH = 64
MAX_JSON_NODES = 100_000
_SESSION_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z", re.ASCII)
_SENSITIVE_KEYS = frozenset(
    {
        "password",
        "passwd",
        "secret",
        "clientsecret",
        "token",
        "accesstoken",
        "refreshtoken",
        "apikey",
        "privatekey",
        "authorization",
        "credential",
        "credentials",
        "databaseurl",
        "connectionstring",
    }
)


class SessionStoreError(Exception):
    """A safe, caller-facing persistence error with JSON-RPC error metadata."""

    def __init__(self, code: int, app_code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.app_code = app_code
        self.message = message


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _strict_json_loads(raw: str) -> Any:
    def reject_constant(value: str) -> None:
        raise ValueError(f"Non-standard JSON number {value} is not permitted.")

    return json.loads(raw, parse_constant=reject_constant)


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _integrity_error(message: str) -> SessionStoreError:
    return SessionStoreError(-32007, "INTEGRITY", message)


def _validate_session_id(session_id: Any) -> str:
    if (
        not isinstance(session_id, str)
        or len(session_id) > MAX_SESSION_ID_LENGTH
        or _SESSION_ID_RE.fullmatch(session_id) is None
    ):
        raise SessionStoreError(
            -32602,
            "VALIDATION",
            f"session_id must be 1–{MAX_SESSION_ID_LENGTH} ASCII letters, digits, underscores, or hyphens "
            "and start with a letter or digit.",
        )
    return session_id


def _validate_payload(payload: Any) -> tuple[str, str]:
    if not isinstance(payload, dict):
        raise SessionStoreError(-32602, "VALIDATION", "Session payload must be a JSON object.")

    remaining_nodes = [MAX_JSON_NODES]

    def visit(value: Any, depth: int) -> None:
        remaining_nodes[0] -= 1
        if remaining_nodes[0] < 0:
            raise SessionStoreError(-32602, "VALIDATION", "Session payload has too many values.")
        if depth > MAX_JSON_DEPTH:
            raise SessionStoreError(-32602, "VALIDATION", "Session payload is nested too deeply.")
        if isinstance(value, dict):
            for key, child in value.items():
                if not isinstance(key, str) or not key or len(key) > 512:
                    raise SessionStoreError(-32602, "VALIDATION", "Session payload contains an invalid object key.")
                normalized_key = re.sub(r"[^a-z0-9]", "", key.casefold())
                if normalized_key in _SENSITIVE_KEYS:
                    raise SessionStoreError(
                        -32602,
                        "VALIDATION",
                        "Session payload must not contain credentials or connection secrets.",
                    )
                visit(child, depth + 1)
        elif isinstance(value, list):
            for child in value:
                visit(child, depth + 1)
        elif value is None or isinstance(value, (str, bool, int)):
            return
        elif isinstance(value, float) and math.isfinite(value):
            return
        else:
            raise SessionStoreError(-32602, "VALIDATION", "Session payload contains a value that is not valid JSON.")

    try:
        visit(payload, 0)
        serialized = _canonical_json(payload)
        encoded = serialized.encode("utf-8")
    except SessionStoreError:
        raise
    except (TypeError, ValueError, RecursionError, UnicodeError) as exc:
        raise SessionStoreError(-32602, "VALIDATION", "Session payload is not valid UTF-8 JSON.") from exc

    if len(encoded) > MAX_SESSION_BYTES:
        raise SessionStoreError(
            -32602,
            "VALIDATION",
            f"Session payload exceeds the {MAX_SESSION_BYTES}-byte limit.",
        )
    return serialized, hashlib.sha256(encoded).hexdigest()


def _verify_stored_payload(raw_payload: Any, expected_sha256: Any) -> str:
    if not isinstance(raw_payload, str) or not isinstance(expected_sha256, str):
        raise _integrity_error("Stored session payload metadata is invalid.")
    actual_sha256 = hashlib.sha256(raw_payload.encode("utf-8")).hexdigest()
    if not hmac.compare_digest(actual_sha256, expected_sha256):
        raise _integrity_error("Stored session payload failed its SHA-256 integrity check.")
    return actual_sha256


def _stored_revision(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value < 2**53:
        raise _integrity_error("Stored session revision is outside the safe integer range.")
    return value


def _assert_audited_session_state(
    session_id: str,
    revision: int,
    payload_sha256: str,
    audited_state: Optional[dict[str, Any]],
) -> None:
    if (
        audited_state is None
        or audited_state.get("revision") != revision
        or audited_state.get("payload_sha256") != payload_sha256
    ):
        raise _integrity_error(f"Session '{session_id}' does not match its latest hash-chained audit event.")


def _audit_hash(sequence: int, created_at: str, event_json: str, previous_hash: str) -> str:
    chain_record = {
        "sequence": sequence,
        "created_at": created_at,
        "event_json": event_json,
        "previous_hash": previous_hash,
    }
    return hashlib.sha256(_canonical_json(chain_record).encode("utf-8")).hexdigest()


def _verify_audit_chain(
    conn: sqlite3.Connection,
    target_session_id: Optional[str] = None,
) -> tuple[int, str, Optional[dict[str, Any]]]:
    rows = conn.execute(
        "SELECT sequence, created_at, event_json, previous_hash, event_hash "
        "FROM audit_log ORDER BY sequence"
    ).fetchall()
    previous_hash = GENESIS_HASH
    previous_sequence = 0
    session_state: Optional[dict[str, Any]] = None
    for row in rows:
        sequence = row["sequence"]
        if not isinstance(sequence, int) or sequence != previous_sequence + 1:
            raise _integrity_error("The audit log has a missing, duplicated, or reordered sequence.")
        created_at = row["created_at"]
        event_json = row["event_json"]
        stored_previous_hash = row["previous_hash"]
        if (
            not isinstance(created_at, str)
            or not isinstance(event_json, str)
            or not isinstance(stored_previous_hash, str)
        ):
            raise _integrity_error("The audit log contains invalid record metadata.")
        if stored_previous_hash != previous_hash:
            raise _integrity_error("The audit log hash chain is broken.")
        try:
            event = _strict_json_loads(event_json)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise _integrity_error("The audit log contains invalid event JSON.") from exc
        if not isinstance(event, dict):
            raise _integrity_error("The audit log contains a non-object event.")
        if event.get("action") in ("session.save", "session.migrate"):
            event_session_id = event.get("session_id")
            event_revision = event.get("revision")
            event_digest = event.get("payload_sha256")
            if (
                not isinstance(event_session_id, str)
                or isinstance(event_revision, bool)
                or not isinstance(event_revision, int)
                or not 1 <= event_revision < 2**53
                or not isinstance(event_digest, str)
                or re.fullmatch(r"[0-9a-f]{64}", event_digest) is None
            ):
                raise _integrity_error("The audit log contains an invalid session-state event.")
            if event_session_id == target_session_id:
                session_state = {"revision": event_revision, "payload_sha256": event_digest}
        expected_hash = _audit_hash(sequence, created_at, event_json, previous_hash)
        actual_hash = row["event_hash"]
        if not isinstance(actual_hash, str) or not hmac.compare_digest(expected_hash, actual_hash):
            raise _integrity_error("The audit log hash verification failed.")
        previous_sequence = sequence
        previous_hash = actual_hash
    return previous_sequence, previous_hash, session_state


def _append_audit_event(
    conn: sqlite3.Connection,
    event: dict[str, Any],
    verified_head: Optional[tuple[int, str]] = None,
) -> tuple[int, str]:
    sequence, previous_hash = verified_head or _verify_audit_chain(conn)[:2]
    sequence += 1
    created_at = _now_utc()
    event_json = _canonical_json(event)
    event_hash = _audit_hash(sequence, created_at, event_json, previous_hash)
    conn.execute(
        "INSERT INTO audit_log(sequence, created_at, event_json, previous_hash, event_hash) "
        "VALUES (?, ?, ?, ?, ?)",
        (sequence, created_at, event_json, previous_hash, event_hash),
    )
    return sequence, event_hash


class SessionStore:
    """Versioned SQLite session store; memory fallback is explicitly process-local."""

    def __init__(self, database_path: Optional[Path] = None, *, in_memory: bool = False) -> None:
        if in_memory == (database_path is not None):
            raise ValueError("Provide exactly one of database_path or in_memory=True.")
        self.database_path = database_path.resolve() if database_path is not None else None
        self.in_memory = in_memory
        self._memory_connection = (
            sqlite3.connect(":memory:", timeout=5.0, isolation_level=None)
            if in_memory
            else None
        )
        self.schema_version: Optional[int] = None

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        if self._memory_connection is not None:
            conn = self._memory_connection
            close_after = False
        else:
            assert self.database_path is not None
            self.database_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(str(self.database_path), timeout=5.0, isolation_level=None)
            close_after = True
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=5000")
            conn.execute("PRAGMA synchronous=NORMAL")
            if not self.in_memory:
                conn.execute("PRAGMA journal_mode=WAL")
            yield conn
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            if close_after:
                conn.close()

    def _create_pre_migration_backup(self, old_version: int) -> Optional[Path]:
        path = self.database_path
        if path is None or not path.is_file():
            return None
        backup_dir = path.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup_path = backup_dir / (
            f"pre-migration-v{old_version}-to-v{CURRENT_SCHEMA_VERSION}-{uuid.uuid4().hex}.db"
        )
        online_sqlite_backup(path, backup_path)
        return backup_path

    @staticmethod
    def _migrate_0_to_1(conn: sqlite3.Connection) -> None:
        conn.execute(
            "CREATE TABLE sessions ("
            "session_id TEXT PRIMARY KEY, "
            "revision INTEGER NOT NULL CHECK(revision > 0), "
            "payload_json TEXT NOT NULL, "
            "updated_at TEXT NOT NULL"
            ")"
        )
        conn.execute(
            "CREATE TABLE audit_log ("
            "sequence INTEGER PRIMARY KEY AUTOINCREMENT, "
            "created_at TEXT NOT NULL, "
            "event_json TEXT NOT NULL, "
            "previous_hash TEXT NOT NULL, "
            "event_hash TEXT NOT NULL UNIQUE"
            ")"
        )
        conn.execute("PRAGMA user_version=1")
        _append_audit_event(
            conn,
            {"action": "schema.migrate", "from_version": 0, "to_version": 1},
        )

    @staticmethod
    def _migrate_1_to_2(conn: sqlite3.Connection) -> None:
        audit_head = _verify_audit_chain(conn)[:2]
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(sessions)")}
        required = {"session_id", "revision", "payload_json", "updated_at"}
        if not required.issubset(columns) or "payload_sha256" in columns:
            raise _integrity_error("The version 1 session schema is incomplete or unexpected.")

        conn.execute("ALTER TABLE sessions ADD COLUMN payload_sha256 TEXT NOT NULL DEFAULT ''")
        rows = conn.execute(
            "SELECT session_id, revision, payload_json FROM sessions ORDER BY session_id"
        ).fetchall()
        migrated_sessions: list[tuple[str, int, str]] = []
        for row in rows:
            try:
                session_id = _validate_session_id(row["session_id"])
                revision = row["revision"]
                if isinstance(revision, bool) or not isinstance(revision, int) or not 1 <= revision < 2**53:
                    raise ValueError("Legacy session revision is outside the safe integer range.")
                raw_payload = row["payload_json"]
                if not isinstance(raw_payload, str):
                    raise ValueError("Legacy session payload is not text.")
                payload = _strict_json_loads(raw_payload)
                _validate_payload(payload)
                payload_bytes = raw_payload.encode("utf-8")
            except (SessionStoreError, TypeError, ValueError, UnicodeError) as exc:
                raise _integrity_error("A legacy session record is invalid or exceeds current safety limits.") from exc
            payload_sha256 = hashlib.sha256(payload_bytes).hexdigest()
            conn.execute(
                "UPDATE sessions SET payload_sha256=? WHERE session_id=?",
                (payload_sha256, session_id),
            )
            migrated_sessions.append((session_id, revision, payload_sha256))

        conn.execute(
            "CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log "
            "BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END"
        )
        conn.execute(
            "CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log "
            "BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END"
        )
        conn.execute("PRAGMA user_version=2")
        audit_head = _append_audit_event(
            conn,
            {"action": "schema.migrate", "from_version": 1, "to_version": 2},
            verified_head=audit_head,
        )
        for session_id, revision, payload_sha256 in migrated_sessions:
            audit_head = _append_audit_event(
                conn,
                {
                    "action": "session.migrate",
                    "payload_sha256": payload_sha256,
                    "revision": revision,
                    "session_id": session_id,
                },
                verified_head=audit_head,
            )

    def initialize(self) -> int:
        with self._connection() as conn:
            initial_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
            if initial_version > CURRENT_SCHEMA_VERSION:
                raise _integrity_error("The session database was created by a newer application version.")
            if initial_version == CURRENT_SCHEMA_VERSION:
                self._assert_current_schema(conn)
                _verify_audit_chain(conn)
                self.schema_version = initial_version
                return initial_version

        backup_path = self._create_pre_migration_backup(initial_version)
        try:
            with self._connection() as conn:
                conn.execute("BEGIN IMMEDIATE")
                version = int(conn.execute("PRAGMA user_version").fetchone()[0])
                if version > CURRENT_SCHEMA_VERSION:
                    raise _integrity_error("The session database was created by a newer application version.")
                while version < CURRENT_SCHEMA_VERSION:
                    if version == 0:
                        self._migrate_0_to_1(conn)
                        version = 1
                    elif version == 1:
                        self._migrate_1_to_2(conn)
                        version = 2
                    else:
                        raise _integrity_error("No safe migration exists for the session database version.")
                self._assert_current_schema(conn)
                _verify_audit_chain(conn)
                conn.commit()
                self.schema_version = version
                return version
        except Exception:
            if backup_path is not None and self.database_path is not None:
                try:
                    online_sqlite_backup(backup_path, self.database_path)
                except Exception:
                    LOGGER.exception("Could not restore the pre-migration SQLite backup")
            raise

    @staticmethod
    def _assert_current_schema(conn: sqlite3.Connection) -> None:
        session_columns = {row["name"] for row in conn.execute("PRAGMA table_info(sessions)")}
        audit_columns = {row["name"] for row in conn.execute("PRAGMA table_info(audit_log)")}
        if not {"session_id", "revision", "payload_json", "updated_at", "payload_sha256"}.issubset(session_columns):
            raise _integrity_error("The session database schema is incomplete.")
        if not {"sequence", "created_at", "event_json", "previous_hash", "event_hash"}.issubset(audit_columns):
            raise _integrity_error("The audit database schema is incomplete.")
        triggers = {
            row["name"]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='trigger'")
        }
        if not {"audit_log_no_update", "audit_log_no_delete"}.issubset(triggers):
            raise _integrity_error("The audit log immutability guards are missing.")

    def save(
        self,
        session_id: Any,
        payload: Any,
        expected_revision: Any = 0,
    ) -> dict[str, Any]:
        session_id = _validate_session_id(session_id)
        if (
            isinstance(expected_revision, bool)
            or not isinstance(expected_revision, int)
            or expected_revision < 0
            or expected_revision >= 2**53 - 1
        ):
            raise SessionStoreError(-32602, "VALIDATION", "expected_revision must be a non-negative safe integer.")
        payload_json, payload_sha256 = _validate_payload(payload)
        updated_at = _now_utc()

        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                audit_head = _verify_audit_chain(conn, session_id)
                row = conn.execute(
                    "SELECT revision, payload_json, payload_sha256 FROM sessions WHERE session_id=?",
                    (session_id,),
                ).fetchone()
                if row is None:
                    if audit_head[2] is not None:
                        raise _integrity_error("A previously saved session is missing from the database.")
                    current_revision = 0
                else:
                    current_revision = _stored_revision(row["revision"])
                    current_sha256 = _verify_stored_payload(row["payload_json"], row["payload_sha256"])
                    _assert_audited_session_state(
                        session_id,
                        current_revision,
                        current_sha256,
                        audit_head[2],
                    )
                if current_revision != expected_revision:
                    raise SessionStoreError(
                        -32005,
                        "CONFLICT",
                        f"Session revision conflict: expected {expected_revision}, "
                        f"current revision is {current_revision}.",
                    )
                revision = current_revision + 1
                conn.execute(
                    "INSERT INTO sessions(session_id, revision, payload_json, updated_at, payload_sha256) "
                    "VALUES (?, ?, ?, ?, ?) "
                    "ON CONFLICT(session_id) DO UPDATE SET "
                    "revision=excluded.revision, payload_json=excluded.payload_json, "
                    "updated_at=excluded.updated_at, payload_sha256=excluded.payload_sha256",
                    (session_id, revision, payload_json, updated_at, payload_sha256),
                )
                sequence, audit_hash = _append_audit_event(
                    conn,
                    {
                        "action": "session.save",
                        "payload_sha256": payload_sha256,
                        "revision": revision,
                        "session_id": session_id,
                    },
                    verified_head=audit_head[:2],
                )
                conn.commit()
            except Exception:
                if conn.in_transaction:
                    conn.rollback()
                raise
        return {
            "session_id": session_id,
            "revision": revision,
            "updated_at": updated_at,
            "sha256": payload_sha256,
            "audit_sequence": sequence,
            "audit_hash": audit_hash,
            "schema_version": CURRENT_SCHEMA_VERSION,
        }

    def load(self, session_id: Any) -> dict[str, Any]:
        session_id = _validate_session_id(session_id)
        with self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                audit_head = _verify_audit_chain(conn, session_id)
                row = conn.execute(
                    "SELECT revision, payload_json, updated_at, payload_sha256 "
                    "FROM sessions WHERE session_id=?",
                    (session_id,),
                ).fetchone()
                if row is None:
                    if audit_head[2] is not None:
                        raise _integrity_error("A previously saved session is missing from the database.")
                    raise SessionStoreError(-32006, "NOT_FOUND", "Session was not found.")
                revision = _stored_revision(row["revision"])
                payload_sha256 = _verify_stored_payload(row["payload_json"], row["payload_sha256"])
                _assert_audited_session_state(session_id, revision, payload_sha256, audit_head[2])
                try:
                    payload = _strict_json_loads(row["payload_json"])
                except (TypeError, ValueError, json.JSONDecodeError) as exc:
                    raise _integrity_error("Stored session payload is not valid JSON.") from exc
                if not isinstance(payload, dict):
                    raise _integrity_error("Stored session payload is not a JSON object.")
                try:
                    _validate_payload(payload)
                except SessionStoreError as exc:
                    raise _integrity_error("Stored session payload violates current safety limits.") from exc
                sequence, audit_hash = _append_audit_event(
                    conn,
                    {
                        "action": "session.load",
                        "payload_sha256": payload_sha256,
                        "revision": revision,
                        "session_id": session_id,
                    },
                    verified_head=audit_head[:2],
                )
                conn.commit()
            except Exception:
                if conn.in_transaction:
                    conn.rollback()
                raise
        return {
            "session_id": session_id,
            "revision": revision,
            "updated_at": row["updated_at"],
            "payload": payload,
            "sha256": payload_sha256,
            "audit_sequence": sequence,
            "audit_hash": audit_hash,
            "schema_version": CURRENT_SCHEMA_VERSION,
        }

    def verify_audit_log(self) -> dict[str, Any]:
        with self._connection() as conn:
            sequence, head_hash, _ = _verify_audit_chain(conn)
        return {"events": sequence, "head_hash": head_hash}

    def close(self) -> None:
        if self._memory_connection is not None:
            self._memory_connection.close()
            self._memory_connection = None
