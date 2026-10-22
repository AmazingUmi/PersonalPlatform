#!/bin/sh
set -eu

: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"

# Keep raw credentials out of shell interpolation and encode each URL part.
# This deployment always connects to its private Compose database service.
DATABASE_URL="$(node -e '
  const encode = (name) => encodeURIComponent(process.env[name]);
  process.stdout.write(
    `postgresql://${encode("POSTGRES_USER")}:${encode("POSTGRES_PASSWORD")}@database:5432/${encode("POSTGRES_DB")}`,
  );
')"
export DATABASE_URL

exec "$@"
