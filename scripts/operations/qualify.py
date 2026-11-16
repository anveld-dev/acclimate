#!/usr/bin/env python3
"""Qualify backups using only randomly named disposable databases."""

import argparse
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.parse
import uuid
from connection import connection_env

ROOT = Path(__file__).resolve().parents[2]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument("--pg-bin", type=Path, required=True)
a = p.parse_args()
url = os.environ.get("DATABASE_URL", "")
parts = urllib.parse.urlsplit(url)
if (
    parts.scheme not in ("postgres", "postgresql")
    or not parts.hostname
    or not parts.path.strip("/")
):
    p.error("DATABASE_URL must be a PostgreSQL URL naming an existing database")


def db_url(name):
    return urllib.parse.urlunsplit(parts._replace(path="/" + name))


def command(name, *args, database=url, **kwargs):
    env = connection_env(database)
    return subprocess.run([str(a.pg_bin / name), *args], env=env, check=True, **kwargs)


def sql(statement, database):
    return command(
        "psql",
        "-X",
        "-qAt",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        statement,
        database=database,
        capture_output=True,
        text=True,
    ).stdout


names = ["acclimate_ops_" + uuid.uuid4().hex for _ in range(3)]
created = []
try:
    for name in names:
        sql(f'CREATE DATABASE "{name}"', url)
        created.append(name)
    source, restored, failed = map(db_url, names)
    for migration in sorted((ROOT / "migrations").glob("*.sql")):
        command(
            "psql",
            "-X",
            "-q",
            "-v",
            "ON_ERROR_STOP=1",
            "-f",
            str(migration),
            database=source,
            stdout=subprocess.DEVNULL,
        )
    sql(
        """
      INSERT INTO bundles(id,project_id,name) VALUES ('00000000-0000-0000-0000-000000000001','ops','backup fixture');
      INSERT INTO versions(id,project_id,bundle_id,digest,payload,created_by) VALUES
       ('00000000-0000-0000-0000-000000000002','ops','00000000-0000-0000-0000-000000000001','digest',decode('00ff0a726573746f7265','hex'),'author');
      INSERT INTO channels VALUES ('ops','00000000-0000-0000-0000-000000000001','stable',1,'00000000-0000-0000-0000-000000000002');
      INSERT INTO promotions(id,project_id,bundle_id,channel,revision,version_id,unevaluated_reason,reviewer) VALUES
       ('00000000-0000-0000-0000-000000000003','ops','00000000-0000-0000-0000-000000000001','stable',1,'00000000-0000-0000-0000-000000000002','fixture','reviewer');
      INSERT INTO comparisons(id,project_id,bundle_id,body,complete,submitter) VALUES
       ('00000000-0000-0000-0000-000000000004','ops','00000000-0000-0000-0000-000000000001','{"evidence":"saved"}',true,'reviewer');
    """,
        source,
    )

    def backup(action, archive, database, expect=True):
        env = os.environ.copy()
        env["DATABASE_URL"] = database
        result = subprocess.run(
            [
                "python3",
                str(ROOT / "scripts/operations/backup.py"),
                action,
                str(archive),
                "--pg-bin",
                str(a.pg_bin),
            ],
            env=env,
            capture_output=True,
            text=True,
        )
        if (result.returncode == 0) != expect:
            raise RuntimeError(
                f"{action} unexpected exit {result.returncode}: {result.stderr}"
            )

    with tempfile.TemporaryDirectory(prefix="acclimate-ops-") as temp:
        archive = Path(temp) / "backup.dump"
        backup("dump", archive, source)
        assert archive.stat().st_mode & 0o777 == 0o600
        backup("restore", archive, restored)
        tables = sql(
            "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
            source,
        ).splitlines()
        assert (
            tables
            == sql(
                "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
                restored,
            ).splitlines()
        )
        for table in tables:
            query = f"SELECT coalesce(jsonb_agg(t ORDER BY t::text),'[]'::jsonb)::text FROM (SELECT row_to_json(x)::jsonb AS t FROM \"{table}\" x) rows"
            assert sql(query, source) == sql(query, restored), f"changed table {table}"
        backup("restore", archive, restored, expect=False)
        # An existing type forces a failure during restore after SQL execution starts.
        sql("CREATE TYPE bundles AS ENUM ('conflict')", failed)
        backup("restore", archive, failed, expect=False)
        assert (
            sql(
                "SELECT count(*) FROM pg_tables WHERE schemaname='public'", failed
            ).strip()
            == "0"
        )
        broken = Path(temp) / "broken.dump"
        broken.write_bytes(archive.read_bytes()[:64])
        backup("restore", broken, failed, expect=False)
        assert (
            sql(
                "SELECT count(*) FROM pg_tables WHERE schemaname='public'", failed
            ).strip()
            == "0"
        )
    print(
        "Qualified private archive, exact table data, nonempty-target rejection and failed restore rollback"
    )
finally:
    for name in reversed(created):
        sql(f'DROP DATABASE "{name}"', url)
