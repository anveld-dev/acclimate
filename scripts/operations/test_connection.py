import os
import unittest
from unittest.mock import patch
from connection import connection_env


class ConnectionEnvironmentTest(unittest.TestCase):
    def test_url_target_does_not_inherit_libpq_selectors(self):
        inherited = {
            "PGHOSTADDR": "203.0.113.20",
            "PGSERVICE": "unexpected",
            "PGSERVICEFILE": "/unexpected-service",
            "PGPASSFILE": "/unexpected-passwords",
            "PGOPTIONS": "-c search_path=unexpected",
            "PGPASSWORD": "inherited-fixture",
            "PGSSLMODE": "disable",
            "PATH": "/fixture/tools",
        }
        with patch.dict(os.environ, inherited):
            env = connection_env(
                "postgresql://app@localhost:55432/target?sslmode=require"
            )
        self.assertEqual(
            (env["PGHOST"], env["PGPORT"], env["PGDATABASE"], env["PGUSER"]),
            ("localhost", "55432", "target", "app"),
        )
        self.assertEqual(env["PGSSLMODE"], "require")
        self.assertEqual(env["PATH"], "/fixture/tools")
        for name in inherited:
            if name not in ("PATH", "PGSSLMODE"):
                self.assertNotIn(name, env)
        self.assertNotIn("DATABASE_URL", env)

    def test_explicit_password_and_tls_options_are_retained(self):
        env = connection_env(
            "postgresql://app:fixture%2Bpassword@localhost/db?sslmode=verify-full&connect_timeout=5"
        )
        self.assertEqual(env["PGPASSWORD"], "fixture+password")
        self.assertEqual(env["PGSSLMODE"], "verify-full")
        self.assertEqual(env["PGCONNECT_TIMEOUT"], "5")


if __name__ == "__main__":
    unittest.main()
