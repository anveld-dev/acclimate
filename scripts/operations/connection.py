"""Translate a PostgreSQL URL into libpq environment variables without argv secrets."""

import os
from urllib.parse import urlsplit, unquote, parse_qsl


def connection_env(url):
    parts = urlsplit(url)
    if (
        parts.scheme not in ("postgres", "postgresql")
        or not parts.hostname
        or not parts.path.strip("/")
    ):
        raise ValueError("DATABASE_URL must be a PostgreSQL URL with host and database")
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    env.pop("DATABASE_URL", None)
    env.update(
        PGHOST=parts.hostname,
        PGPORT=str(parts.port or 5432),
        PGDATABASE=unquote(parts.path[1:]),
    )
    if parts.username is not None:
        env["PGUSER"] = unquote(parts.username)
    if parts.password is not None:
        env["PGPASSWORD"] = unquote(parts.password)
    options = {
        "sslmode": "PGSSLMODE",
        "sslrootcert": "PGSSLROOTCERT",
        "sslcert": "PGSSLCERT",
        "sslkey": "PGSSLKEY",
        "connect_timeout": "PGCONNECT_TIMEOUT",
    }
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if key not in options:
            raise ValueError(f"unsupported DATABASE_URL option: {key}")
        env[options[key]] = value
    return env
