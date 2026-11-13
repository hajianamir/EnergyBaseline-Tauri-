import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SIDECAR_DIR = REPO_ROOT / "sidecar"
sys.path.insert(0, str(SIDECAR_DIR))

from energybaseline.config.settings import (  # noqa: E402
    mask_url_credentials,
    online_sqlite_backup,
    resolve_database,
)
from energybaseline.sql.guard import validate_readonly_sql  # noqa: E402


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
    def test_handshake_stray_print_isolation_and_stdin_eof(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            proc = subprocess.Popen(
                [sys.executable, str(SIDECAR_DIR / "energybaseline" / "main.py")],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
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
            stdout_data, stderr_data = proc.communicate(input=f"{hello}\n{rpc_status}\n{rpc_bad}\n", timeout=10)
            self.assertEqual(proc.returncode, 0)
            self.assertIn("sidecar.booting", stderr_data)
            lines = [json.loads(line) for line in stdout_data.strip().splitlines() if line.strip()]
            self.assertEqual(lines[0]["type"], "sidecar.ready")
            self.assertFalse(lines[1]["result"]["matplotlib_loaded"])
            self.assertEqual(lines[2]["error"]["code"], -32601)

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
