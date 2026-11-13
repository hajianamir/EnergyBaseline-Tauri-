import json
import logging
import os
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
from energybaseline.sql.guard import validate_readonly_sql  # noqa: E402
from energybaseline.main import _configure_logging  # noqa: E402


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


class TestSidecarIpc(unittest.TestCase):
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
            stdout_data, _ = proc.communicate(input=f"{hello}\n{status}\n", timeout=20)
            self.assertEqual(proc.returncode, 0)
            frames = [json.loads(line) for line in stdout_data.splitlines() if line.strip()]
            self.assertEqual(frames[0]["type"], "sidecar.ready")
            self.assertEqual(frames[1]["method"], "sidecar.progress")
            self.assertIn("result", frames[2])


class TestSqlGuard(unittest.TestCase):
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
            "WITH c AS (DELETE FROM meters) SELECT * FROM c",
            "SELECT * INTO evil FROM meters",
            "SELECT xp_cmdshell('whoami')",
            "SELECT LOAD_FILE('/etc/shadow')",
            "SELECT * FROM meters INTO OUTFILE '/tmp/pwn'",
            "COPY meters TO '/tmp/x.csv'",
            "ATTACH DATABASE 'x.db' AS x",
            "PRAGMA user_version = 99",
        ):
            self.assertFalse(validate_readonly_sql(q).allowed, q)


if __name__ == "__main__":
    unittest.main()
