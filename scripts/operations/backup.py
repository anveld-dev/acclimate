#!/usr/bin/env python3
"""Private PostgreSQL custom-format backup and transactional empty-database restore."""

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
from connection import connection_env


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["dump", "restore"])
    parser.add_argument("archive", type=Path)
    parser.add_argument(
        "--pg-bin",
        type=Path,
        help="directory containing matching PostgreSQL client binaries",
    )
    args = parser.parse_args()
    if not os.environ.get("DATABASE_URL"):
        parser.error(
            "DATABASE_URL must identify the source (dump) or empty target (restore)"
        )
    env = connection_env(os.environ["DATABASE_URL"])

    def binary(name):
        return str(args.pg_bin / name) if args.pg_bin else name

    def run(name, *arguments, **kwargs):
        return subprocess.run([binary(name), *arguments], env=env, check=True, **kwargs)

    def query(sql):
        return run(
            "psql",
            "-X",
            "-A",
            "-t",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            sql,
            capture_output=True,
            text=True,
        ).stdout.strip()

    server = int(query("SHOW server_version_num")) // 10000
    for tool in ("psql", "pg_dump", "pg_restore"):
        version = run(tool, "--version", capture_output=True, text=True).stdout
        match = re.search(r"\b(\d+)(?:\.\d+)", version)
        if not match or int(match.group(1)) != server:
            raise RuntimeError(
                f"{tool} must match PostgreSQL server major {server}: {version.strip()}"
            )
    if args.action == "dump":
        # Never overwrite an existing archive or briefly expose it with permissive mode.
        fd = os.open(args.archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "wb") as out:
                run("pg_dump", "--format=custom", "--no-owner", "--no-acl", stdout=out)
        except BaseException:
            args.archive.unlink(missing_ok=True)
            raise
    else:
        if (
            query(
                "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN ('r','p','v','m','S','f')"
            )
            != "0"
        ):
            raise RuntimeError("restore target is not empty")
        run(
            "pg_restore",
            "--exit-on-error",
            "--single-transaction",
            "--no-owner",
            "--no-acl",
            "--dbname=",
            str(args.archive),
        )
    print(f"{args.action} completed with PostgreSQL {server}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"backup operation failed: {exc}", file=sys.stderr)
        sys.exit(1)
