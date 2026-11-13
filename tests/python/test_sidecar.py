import hashlib
import io
import json
import logging
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path, PureWindowsPath
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[2]
SIDECAR_DIR = REPO_ROOT / "sidecar"
sys.path.insert(0, str(SIDECAR_DIR))

from energybaseline.config.settings import (  # noqa: E402
    _sqlite_url,
    mask_url_credentials,
    online_sqlite_backup,
    resolve_database,
)
from energybaseline.sql.guard import _MAX_SQL_BYTES, validate_readonly_sql  # noqa: E402
from energybaseline.main import _configure_logging  # noqa: E402
from energybaseline.persistence import (  # noqa: E402
    CURRENT_SCHEMA_VERSION,
    MAX_SESSION_BYTES,
    SessionStore,
    SessionStoreError,
)
from energybaseline.ipc.protocol import (  # noqa: E402
    ALLOWLISTED_METHODS,
    CONTROL_ALLOWLISTED_METHODS,
    SidecarIpcServer,
)


class TestDbResolver(unittest.TestCase):
    def setUp(self) -> None:
        self._saved_env = dict(os.environ)
        for k in ("EB_DATABASE_URL", "DATABASE_URL", "POSTGRES_URL", "DB_CONNECTION_STRING", "DB_URI", "APP_HOME"):
            os.environ.pop(k, None)

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._saved_env)

    def test_no_env_uses_app_home_sqlite(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            res = resolve_database(tmp)
            self.assertFalse(res.fallback)
            expected_db_path = (Path(tmp).resolve() / "data" / "app.db").resolve()
            self.assertEqual(res.sqlite_path, expected_db_path)
            self.assertTrue(expected_db_path.exists())

    def test_whitespace_env_ignored(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["DATABASE_URL"] = "   \t\n  "
            res = resolve_database(tmp)
            self.assertEqual(res.fallback_tier, "primary")
            self.assertTrue(res.url.startswith("sqlite:///"))

    def test_read_only_app_home_falls_back_to_temp_with_warning(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch(
            "energybaseline.config.settings._test_sqlite_writable",
            side_effect=[(False, "read-only APP_HOME"), (True, "ok")],
        ):
            res = resolve_database(tmp)
            self.assertEqual(res.fallback_tier, "temp_sqlite")
            self.assertTrue(res.fallback)
            self.assertIn("data may be lost", (res.warning or ""))
            self.assertIn((Path(tempfile.gettempdir()) / "EnergyBaseline").as_posix(), res.url)

    def test_in_memory_sqlite_is_always_reported_as_volatile(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["EB_DATABASE_URL"] = "sqlite:///:memory:"
            res = resolve_database(tmp)
            self.assertEqual(res.fallback_tier, "memory_sqlite")
            self.assertTrue(res.fallback)
            self.assertIsNone(res.sqlite_path)
            self.assertIn("volatile", (res.warning or "").lower())

    def test_windows_sqlite_url_uses_forward_slashes(self) -> None:
        path = PureWindowsPath("C:/Users/tester/EnergyBaseline/data/app.db")
        self.assertEqual(
            _sqlite_url(path),
            "sqlite:///C:/Users/tester/EnergyBaseline/data/app.db",
        )

    def test_unreachable_postgres_falls_back_to_sqlite(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["EB_DATABASE_URL"] = "postgresql://user:secret@127.0.0.1:59999/nonexistent"
            res = resolve_database(tmp)
            self.assertTrue(res.fallback)
            self.assertEqual(res.fallback_tier, "app_home_sqlite")
            self.assertIn("unreachable", (res.warning or "").lower())

    def test_mask_credentials(self) -> None:
        masked = mask_url_credentials("postgresql://admin:s3cr3t@db.local:5432/mv")
        self.assertNotIn("s3cr3t", masked)
        self.assertIn("***", masked)

    def test_online_backup_api(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            res = resolve_database(tmp)
            backup_path = Path(tmp) / "backup" / "app_backup.db"
            online_sqlite_backup(res.sqlite_path, backup_path)
            self.assertTrue(backup_path.exists())
            self.assertGreater(backup_path.stat().st_size, 0)

    def test_single_db_env_resolver_rule(self) -> None:
        # DB-1 CI check: only settings.py may reference DB env vars
        hits = []
        for py_file in SIDECAR_DIR.rglob("*.py"):
            if py_file.name == "settings.py":
                continue
            text = py_file.read_text(encoding="utf-8")
            for var in ("EB_DATABASE_URL", "DATABASE_URL", "POSTGRES_URL", "DB_CONNECTION_STRING", "DB_URI"):
                if var in text:
                    hits.append(f"{py_file}:{var}")
        self.assertEqual(hits, [], f"DB-1 violation: {hits}")


class TestSessionStore(unittest.TestCase):
    def test_atomic_session_round_trip_revision_conflict_and_hash_chain(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data" / "app.db"
            store = SessionStore(database)
            self.assertEqual(store.initialize(), CURRENT_SCHEMA_VERSION)
            payload = {"workspace": {"dataset": "meter.csv", "selected_targets": ["electricity"]}}

            saved = store.save("session-01", payload, expected_revision=0)
            self.assertEqual(saved["revision"], 1)
            loaded = store.load("session-01")
            self.assertEqual(loaded["payload"], payload)
            self.assertEqual(loaded["revision"], 1)
            self.assertEqual(loaded["sha256"], saved["sha256"])

            with self.assertRaises(SessionStoreError) as conflict:
                store.save("session-01", {"stale": True}, expected_revision=0)
            self.assertEqual(conflict.exception.app_code, "CONFLICT")
            self.assertEqual(store.load("session-01")["payload"], payload)

            audit = store.verify_audit_log()
            self.assertEqual(audit["events"], 5)  # Two schema migrations, save, and two loads.
            with sqlite3.connect(str(database)) as conn:
                chain_rows = conn.execute(
                    "SELECT previous_hash, event_hash FROM audit_log ORDER BY sequence"
                ).fetchall()
            self.assertEqual(chain_rows[-1][1], audit["head_hash"])
            self.assertEqual(chain_rows[0][0], "0" * 64)
            for previous, current in zip(chain_rows, chain_rows[1:]):
                self.assertEqual(current[0], previous[1])
            store.close()

    def test_in_memory_fallback_keeps_sessions_only_for_the_store_lifetime(self) -> None:
        store = SessionStore(in_memory=True)
        self.assertEqual(store.initialize(), CURRENT_SCHEMA_VERSION)
        store.save("temporary-session", {"volatile": True})
        self.assertTrue(store.load("temporary-session")["payload"]["volatile"])
        store.close()

        restarted_store = SessionStore(in_memory=True)
        restarted_store.initialize()
        with self.assertRaises(SessionStoreError) as missing:
            restarted_store.load("temporary-session")
        self.assertEqual(missing.exception.app_code, "NOT_FOUND")
        restarted_store.close()

    def test_version_one_database_migrates_with_online_backup_and_preserves_session(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data" / "app.db"
            database.parent.mkdir(parents=True)
            payload_json = json.dumps({"workspace": "legacy", "selected": ["kwh"]}, separators=(",", ":"))
            with sqlite3.connect(str(database)) as conn:
                conn.execute(
                    "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, "
                    "payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)"
                )
                conn.execute(
                    "CREATE TABLE audit_log (sequence INTEGER PRIMARY KEY AUTOINCREMENT, "
                    "created_at TEXT NOT NULL, event_json TEXT NOT NULL, previous_hash TEXT NOT NULL, "
                    "event_hash TEXT NOT NULL UNIQUE)"
                )
                conn.execute(
                    "INSERT INTO sessions(session_id, revision, payload_json, updated_at) VALUES (?, ?, ?, ?)",
                    ("legacy-session", 3, payload_json, "2026-01-01T00:00:00Z"),
                )
                conn.execute("PRAGMA user_version=1")

            store = SessionStore(database)
            self.assertEqual(store.initialize(), 2)
            restored = store.load("legacy-session")
            self.assertEqual(restored["payload"], {"workspace": "legacy", "selected": ["kwh"]})
            self.assertEqual(restored["revision"], 3)
            backups = list((database.parent / "backups").glob("pre-migration-v1-to-v2-*.db"))
            self.assertEqual(len(backups), 1)
            with sqlite3.connect(str(backups[0])) as backup:
                self.assertEqual(backup.execute("PRAGMA user_version").fetchone()[0], 1)
                self.assertEqual(
                    backup.execute("SELECT revision FROM sessions WHERE session_id='legacy-session'").fetchone()[0],
                    3,
                )
            self.assertEqual(store.verify_audit_log()["events"], 3)  # Schema migration, session migration, and load.
            store.close()

    def test_failed_legacy_migration_restores_backup_without_dropping_data(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "app.db"
            with sqlite3.connect(str(database)) as conn:
                conn.execute(
                    "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, "
                    "payload_json TEXT NOT NULL, updated_at TEXT NOT NULL)"
                )
                conn.execute(
                    "CREATE TABLE audit_log (sequence INTEGER PRIMARY KEY AUTOINCREMENT, "
                    "created_at TEXT NOT NULL, event_json TEXT NOT NULL, previous_hash TEXT NOT NULL, "
                    "event_hash TEXT NOT NULL UNIQUE)"
                )
                conn.execute(
                    "INSERT INTO sessions(session_id, revision, payload_json, updated_at) VALUES (?, ?, ?, ?)",
                    ("legacy-session", 1, '{"api_key":"must-not-be-migrated"}', "2026-01-01T00:00:00Z"),
                )
                conn.execute("PRAGMA user_version=1")

            store = SessionStore(database)
            with self.assertRaises(SessionStoreError) as failure:
                store.initialize()
            self.assertEqual(failure.exception.app_code, "INTEGRITY")
            with sqlite3.connect(str(database)) as conn:
                self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], 1)
                self.assertNotIn(
                    "payload_sha256",
                    {row[1] for row in conn.execute("PRAGMA table_info(sessions)")},
                )
                self.assertEqual(
                    conn.execute("SELECT payload_json FROM sessions WHERE session_id='legacy-session'").fetchone()[0],
                    '{"api_key":"must-not-be-migrated"}',
                )
            store.close()

    def test_audit_updates_are_blocked_and_hash_tampering_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "app.db"
            store = SessionStore(database)
            store.initialize()
            store.save("session-01", {"ok": True})
            with sqlite3.connect(str(database)) as conn:
                with self.assertRaises(sqlite3.IntegrityError):
                    conn.execute("UPDATE audit_log SET event_json='{}' WHERE sequence=1")
                with self.assertRaises(sqlite3.IntegrityError):
                    conn.execute("DELETE FROM audit_log WHERE sequence=1")
                conn.execute("DROP TRIGGER audit_log_no_update")
                conn.execute("UPDATE audit_log SET event_json='{}' WHERE sequence=1")
                conn.execute(
                    "CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log "
                    "BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END"
                )
            tampered_store = SessionStore(database)
            with self.assertRaises(SessionStoreError) as failure:
                tampered_store.initialize()
            self.assertEqual(failure.exception.app_code, "INTEGRITY")
            store.close()
            tampered_store.close()

    def test_session_data_and_digest_cannot_be_rewritten_away_from_the_audit_chain(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "app.db"
            store = SessionStore(database)
            store.initialize()
            store.save("session-01", {"original": True})
            altered_payload = '{"tampered":true}'
            altered_digest = hashlib.sha256(altered_payload.encode("utf-8")).hexdigest()
            with sqlite3.connect(str(database)) as conn:
                conn.execute(
                    "UPDATE sessions SET payload_json=?, payload_sha256=? WHERE session_id=?",
                    (altered_payload, altered_digest, "session-01"),
                )
            with self.assertRaises(SessionStoreError) as failure:
                store.load("session-01")
            self.assertEqual(failure.exception.app_code, "INTEGRITY")
            store.close()

    def test_payload_validation_rejects_credentials_non_json_and_oversize(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = SessionStore(Path(tmp) / "app.db")
            store.initialize()
            for session_id, payload in (
                ("../outside", {"ok": True}),
                ("session-01", {"api_key": "secret"}),
                ("session-01", {"value": float("nan")}),
                ("session-01", {"value": "x" * MAX_SESSION_BYTES}),
            ):
                with self.subTest(session_id=session_id, size=len(str(payload))):
                    with self.assertRaises(SessionStoreError) as failure:
                        store.save(session_id, payload)
                    self.assertEqual(failure.exception.app_code, "VALIDATION")
            self.assertEqual(store.verify_audit_log()["events"], 2)
            store.close()


class TestSidecarIpc(unittest.TestCase):
    def test_rpc_cancel_is_control_allowlisted_and_dispatched_by_production_server(self) -> None:
        self.assertIn("rpc_cancel", CONTROL_ALLOWLISTED_METHODS)
        self.assertNotIn("rpc_cancel", ALLOWLISTED_METHODS)

        proto_out = io.StringIO()
        server = SidecarIpcServer(proto_out=proto_out)
        server.handshaken = True
        server.dispatch_rpc(
            {
                "jsonrpc": "2.0",
                "id": "cancel-call",
                "method": "rpc_cancel",
                "params": {"id": "pending-request"},
            }
        )

        self.assertIn("pending-request", server.cancelled_ids)
        self.assertEqual(
            json.loads(proto_out.getvalue()),
            {
                "jsonrpc": "2.0",
                "id": "cancel-call",
                "result": {"cancelled": "pending-request"},
            },
        )

    def test_session_save_load_rpc_round_trip_and_stale_revision_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            database = (Path(tmp) / "data" / "app.db").as_posix()
            output = io.StringIO()
            server = SidecarIpcServer(proto_out=output, app_home=tmp)
            try:
                with patch.dict(os.environ, {"EB_DATABASE_URL": f"sqlite:///{database}"}):
                    ready = server.handle_hello({"protocol_version": "1.0", "app_home": tmp})
                self.assertTrue(ready)
                self.assertIsNotNone(server.session_store)
                output.seek(0)
                output.truncate(0)

                server.dispatch_rpc({
                    "jsonrpc": "2.0",
                    "id": "save-1",
                    "method": "session.save",
                    "params": {
                        "session_id": "workspace-1",
                        "expected_revision": 0,
                        "payload": {"selected_target": "electricity", "baseline_year": 2025},
                    },
                })
                saved = json.loads(output.getvalue())
                self.assertEqual(saved["id"], "save-1")
                self.assertEqual(saved["result"]["revision"], 1)
                output.seek(0)
                output.truncate(0)

                server.dispatch_rpc({
                    "jsonrpc": "2.0",
                    "id": "load-1",
                    "method": "session.load",
                    "params": {"session_id": "workspace-1"},
                })
                loaded = json.loads(output.getvalue())
                self.assertEqual(loaded["result"]["payload"]["selected_target"], "electricity")
                self.assertEqual(loaded["result"]["revision"], 1)
                output.seek(0)
                output.truncate(0)

                server.dispatch_rpc({
                    "jsonrpc": "2.0",
                    "id": "stale-save",
                    "method": "session.save",
                    "params": {
                        "session_id": "workspace-1",
                        "expected_revision": 0,
                        "payload": {"selected_target": "gas"},
                    },
                })
                conflict = json.loads(output.getvalue())
                self.assertEqual(conflict["error"]["app_code"], "CONFLICT")
            finally:
                server.close()

            restarted_output = io.StringIO()
            restarted_server = SidecarIpcServer(proto_out=restarted_output, app_home=tmp)
            try:
                with patch.dict(os.environ, {"EB_DATABASE_URL": f"sqlite:///{database}"}):
                    self.assertTrue(
                        restarted_server.handle_hello({"protocol_version": "1.0", "app_home": tmp})
                    )
                restarted_output.seek(0)
                restarted_output.truncate(0)
                restarted_server.dispatch_rpc({
                    "jsonrpc": "2.0",
                    "id": "load-after-restart",
                    "method": "session.load",
                    "params": {"session_id": "workspace-1"},
                })
                resumed = json.loads(restarted_output.getvalue())
                self.assertEqual(resumed["result"]["payload"]["selected_target"], "electricity")
                self.assertEqual(resumed["result"]["revision"], 1)
            finally:
                restarted_server.close()

    def test_logging_stderr_fallback_is_debug_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            not_a_directory = Path(tmp) / "not-a-directory"
            not_a_directory.write_text("blocks log directory creation", encoding="utf-8")
            fallback_environment = {
                "ENERGYBASELINE_LOG_PATH": str(not_a_directory / "sidecar.log"),
                "APP_HOME": str(not_a_directory),
            }
            with patch("energybaseline.main.tempfile.gettempdir", return_value=not_a_directory):
                with patch("energybaseline.main.logging.basicConfig") as basic_config:
                    with patch.dict(os.environ, {**fallback_environment, "ENERGYBASELINE_DEBUG": "1"}):
                        self.assertEqual(_configure_logging(), "stderr")
                    basic_config.assert_called_once()
                    self.assertIs(basic_config.call_args.kwargs["stream"], sys.stderr)

                with patch("energybaseline.main.logging.basicConfig") as basic_config:
                    with patch.dict(os.environ, {**fallback_environment, "ENERGYBASELINE_DEBUG": "0"}):
                        self.assertEqual(_configure_logging(), "unavailable")
                    basic_config.assert_called_once()
                    self.assertNotIn("stream", basic_config.call_args.kwargs)
                    self.assertIsInstance(
                        basic_config.call_args.kwargs["handlers"][0], logging.NullHandler
                    )

    def test_handshake_stray_print_isolation_and_stdin_eof(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env = os.environ.copy()
            env.update({
                "APP_HOME": tmp,
                "ENERGYBASELINE_LOG_PATH": str(Path(tmp) / "sidecar.log"),
                "ENERGYBASELINE_DEBUG": "1",
            })
            proc = subprocess.Popen(
                [sys.executable, str(SIDECAR_DIR / "energybaseline" / "main.py")],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
            assert proc.stdin and proc.stdout and proc.stderr
            hello = json.dumps({
                "protocol_version": "1.0",
                "app_version": "5.2.0",
                "parent_pid": os.getpid(),
                "app_home": tmp,
            })
            rpc_status = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "system.status", "params": {}})
            rpc_bad = json.dumps({"jsonrpc": "2.0", "id": 2, "method": "not.allowlisted", "params": {}})
            rpc_cancel = json.dumps({"jsonrpc": "2.0", "id": "cancel-call", "method": "rpc_cancel", "params": {"id": 3}})
            stdout_data, stderr_data = proc.communicate(
                input=f"{hello}\n{rpc_status}\n{rpc_bad}\n{rpc_cancel}\n", timeout=10
            )
            self.assertEqual(proc.returncode, 0)
            self.assertIn("sidecar.booting", stderr_data)
            lines = [json.loads(line) for line in stdout_data.strip().splitlines() if line.strip()]
            self.assertEqual(lines[0]["type"], "sidecar.ready")
            self.assertEqual(lines[1]["method"], "sidecar.progress")
            self.assertEqual(lines[1]["params"]["percent"], 100)
            self.assertFalse(lines[2]["result"]["matplotlib_loaded"])
            self.assertEqual(lines[3]["error"]["code"], -32601)
            self.assertEqual(lines[4]["result"], {"cancelled": 3})

    def test_release_mode_suppresses_debug_stderr(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env = os.environ.copy()
            env.update({
                "APP_HOME": tmp,
                "ENERGYBASELINE_LOG_PATH": str(Path(tmp) / "sidecar.log"),
                "ENERGYBASELINE_DEBUG": "0",
            })
            proc = subprocess.Popen(
                [sys.executable, str(SIDECAR_DIR / "energybaseline" / "main.py")],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
            hello = json.dumps({
                "protocol_version": "1.0",
                "app_version": "5.2.0",
                "parent_pid": os.getpid(),
                "app_home": tmp,
            })
            stdout_data, stderr_data = proc.communicate(input=f"{hello}\n", timeout=10)
            self.assertEqual(proc.returncode, 0)
            self.assertIn("sidecar.ready", stdout_data)
            self.assertNotIn("sidecar.booting", stdout_data)
            self.assertNotIn("sidecar.booting", stderr_data)

    def test_protocol_version_mismatch_aborts(self) -> None:
        proc = subprocess.Popen(
            [sys.executable, str(SIDECAR_DIR / "energybaseline" / "main.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        hello = json.dumps({"protocol_version": "99.0", "app_version": "5.2.0", "parent_pid": 1, "app_home": ""})
        stdout_data, _ = proc.communicate(input=f"{hello}\n", timeout=10)
        self.assertEqual(proc.returncode, 2)
        frame = json.loads(stdout_data.strip().splitlines()[0])
        self.assertEqual(frame["type"], "sidecar.fatal")
        self.assertEqual(frame["app_code"], "PROTOCOL_VERSION")

    def test_oversized_and_malformed_frames_return_errors_without_crashing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.Popen(
                [sys.executable, str(SIDECAR_DIR / "energybaseline" / "main.py")],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            assert proc.stdin and proc.stdout and proc.stderr
            oversized = '{"jsonrpc":"2.0","id":1,"method":"system.status","params":{"pad":"' + (
                "x" * (1024 * 1024)
            ) + '"}}'
            malformed = '{"jsonrpc":'
            hello = json.dumps({
                "protocol_version": "1.0",
                "app_version": "5.2.0",
                "parent_pid": os.getpid(),
                "app_home": tmp,
            })
            stdout_data, _ = proc.communicate(input=f"{hello}\n{oversized}\n{malformed}\n", timeout=10)
            self.assertEqual(proc.returncode, 0)
            frames = [json.loads(line) for line in stdout_data.splitlines() if line.strip()]
            self.assertEqual(frames[0]["type"], "sidecar.ready")
            self.assertEqual(frames[1]["error"]["app_code"], "VALIDATION")
            self.assertIn("exceeds", frames[1]["error"]["message"])
            self.assertEqual(frames[2]["error"]["code"], -32700)

    def test_system_sbom_serves_build_generated_cyclonedx_15_document(self) -> None:
        sbom_path = REPO_ROOT / "dist" / "sbom.cdx.json"
        self.assertTrue(sbom_path.is_file(), "npm run build should generate dist/sbom.cdx.json")
        document = json.loads(sbom_path.read_text(encoding="utf-8"))
        self.assertEqual(document["bomFormat"], "CycloneDX")
        self.assertEqual(document["specVersion"], "1.5")
        self.assertGreater(len(document["components"]), 14)
        refs = [component["bom-ref"] for component in document["components"]]
        self.assertEqual(len(refs), len(set(refs)), "each SBOM component must have a unique bom-ref")
        named_purls = {(component["name"], component["purl"]) for component in document["components"]}
        self.assertTrue(any(name == "react" and purl.startswith("pkg:npm/") for name, purl in named_purls))
        self.assertTrue(any(name == "numpy" and purl.startswith("pkg:pypi/") for name, purl in named_purls))
        self.assertTrue(any(name == "serde" and purl.startswith("pkg:cargo/") for name, purl in named_purls))

        output = io.StringIO()
        server = SidecarIpcServer(proto_out=output)
        server.handshaken = True
        server.dispatch_rpc({"jsonrpc": "2.0", "id": "sbom-1", "method": "system.sbom", "params": {}})
        frame = json.loads(output.getvalue())
        self.assertEqual(frame["id"], "sbom-1")
        self.assertEqual(frame["result"], document)

    def test_frozen_onedir_sidecar_handshake(self) -> None:
        configured_exe = os.environ.get("ENERGYBASELINE_FROZEN_SIDECAR")
        frozen_exe = (
            Path(configured_exe)
            if configured_exe
            else SIDECAR_DIR / "dist" / "energybaseline_sidecar" / "energybaseline_sidecar.exe"
        )
        if not frozen_exe.exists():
            self.skipTest("PyInstaller onedir sidecar is only present in the Windows packaging job")
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.Popen(
                [str(frozen_exe), "--stdio"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            hello = json.dumps({
                "protocol_version": "1.0",
                "app_version": "5.2.0",
                "parent_pid": os.getpid(),
                "app_home": tmp,
            })
            status = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "system.status", "params": {}})
            sbom = json.dumps({"jsonrpc": "2.0", "id": 2, "method": "system.sbom", "params": {}})
            stdout_data, _ = proc.communicate(input=f"{hello}\n{status}\n{sbom}\n", timeout=20)
            self.assertEqual(proc.returncode, 0)
            frames = [json.loads(line) for line in stdout_data.splitlines() if line.strip()]
            self.assertEqual(frames[0]["type"], "sidecar.ready")
            self.assertEqual(frames[1]["method"], "sidecar.progress")
            self.assertIn("result", frames[2])
            self.assertEqual(frames[3]["result"]["bomFormat"], "CycloneDX")
            self.assertEqual(frames[3]["result"]["specVersion"], "1.5")


class TestSecurityConfig(unittest.TestCase):
    def test_vite_dev_server_uses_requested_loopback_bind_and_port(self) -> None:
        package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(package["scripts"]["dev"], "vite --port=3000 --host=127.0.0.1")

    def test_csp_scopes_inline_styles_to_documented_attribute_exception(self) -> None:
        config = json.loads((REPO_ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8"))
        csp = config["app"]["security"]["csp"]
        directives = {
            parts[0]: parts[1:]
            for directive in csp.split(";")
            if (parts := directive.strip().split())
        }
        self.assertEqual(directives["style-src"], ["'self'"])
        self.assertEqual(directives["style-src-elem"], ["'self'"])
        self.assertEqual(directives["style-src-attr"], ["'unsafe-inline'"])

        security_doc = (REPO_ROOT / "SECURITY.md").read_text(encoding="utf-8")
        self.assertIn("style-src-attr 'unsafe-inline'", security_doc)
        self.assertIn("Mitigation plan", security_doc)
        self.assertIn("ECharts", security_doc)


class TestSqlGuard(unittest.TestCase):
    def test_64_kib_utf8_size_parity_boundary(self) -> None:
        limit = _MAX_SQL_BYTES
        ascii_at_limit = "SELECT 1" + " " * (limit - len("SELECT 1"))
        ascii_over_limit = ascii_at_limit + " "
        self.assertEqual(len(ascii_at_limit.encode("utf-8")), limit)
        self.assertTrue(validate_readonly_sql(ascii_at_limit).allowed)
        self.assertEqual(validate_readonly_sql(ascii_over_limit).rejected_tokens, ["SQL_TOO_LARGE"])

        unicode_at_limit = "SELECT '" + "é" * 32_763 + "a'"
        unicode_over_limit = unicode_at_limit[:-1] + "a'"
        self.assertLess(len(unicode_at_limit), limit)
        self.assertEqual(len(unicode_at_limit.encode("utf-8")), limit)
        self.assertTrue(validate_readonly_sql(unicode_at_limit).allowed)
        self.assertEqual(len(unicode_over_limit.encode("utf-8")), limit + 1)
        self.assertEqual(validate_readonly_sql(unicode_over_limit).rejected_tokens, ["SQL_TOO_LARGE"])

        invalid_unicode = validate_readonly_sql("SELECT " + chr(0xD800))
        self.assertFalse(invalid_unicode.allowed)
        self.assertEqual(invalid_unicode.rejected_tokens, ["INVALID_UNICODE"])

    def test_corpus(self) -> None:
        for q in (
            "SELECT * FROM meters WHERE id = 1",
            "WITH x AS (SELECT timestamp, kwh FROM meters) SELECT * FROM x",
            "SELECT a FROM t1 UNION SELECT a FROM t2",
        ):
            self.assertTrue(validate_readonly_sql(q).allowed, q)

        for q in (
            "DROP TABLE meters",
            "SELECT * FROM meters; DELETE FROM meters",
            "SELECT 1; -- comment\n SELECT 2",
            "WITH c AS (DELETE FROM meters) SELECT * FROM c",
            "SELECT * INTO evil FROM meters",
            "SELECT xp_cmdshell('whoami')",
            "SELECT LOAD_FILE('/etc/shadow')",
            "SELECT load_extension('/tmp/evil.dll')",
            "SELECT readfile('/etc/passwd')",
            "SELECT writefile('/tmp/evil', 'payload')",
            "SELECT pg_read_file('/etc/passwd')",
            "SELECT * FROM meters INTO OUTFILE '/tmp/pwn'",
            "COPY meters TO '/tmp/x.csv'",
            "ATTACH DATABASE 'x.db' AS x",
            "PRAGMA user_version = 99",
            "SELECT 'unterminated",
            "SELECT 'a" + chr(92) + "'; DROP TABLE meters",
            "SELECT 1 /* unterminated comment",
            "SELECT 1 /* outer /* nested */",
            "SELECT 1" + chr(0),
        ):
            self.assertFalse(validate_readonly_sql(q).allowed, q)

        for q in (
            "SELECT 'DELETE; DROP -- is literal'",
            "SELECT 'value''; DELETE FROM meters'",
            "SELECT $$; DROP TABLE meters$$",
            "SELECT 1; -- trailing comment\n",
            "SELECT 1 /* outer /* nested ; DROP */ comment */",
            "SELECT 1 # trailing comment\n",
        ):
            self.assertTrue(validate_readonly_sql(q).allowed, q)


if __name__ == "__main__":
    unittest.main()
