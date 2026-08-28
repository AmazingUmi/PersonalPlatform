#!/usr/bin/env bash
# Backup and restore for the Personal Platform PostgreSQL database.
# Uses DATABASE_URL (or the local dev default) and pg_dump/psql from PATH.
#
#   scripts/backup.sh backup [output_dir]
#   scripts/backup.sh restore <backup_file>

set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgresql://personal_platform:change-me-for-local-development@localhost:5432/personal_platform}"

command="${1:-}"
if [ -z "$command" ]; then
  echo "usage: scripts/backup.sh backup|restore ..." >&2
  exit 1
fi

case "$command" in
  backup)
    out_dir="${2:-backups}"
    mkdir -p "$out_dir"
    out_file="$out_dir/personal_platform_$(date +%Y%m%d_%H%M%S).sql"
    pg_dump "$DATABASE_URL" --no-owner --no-privileges > "$out_file"
    echo "backup written to $out_file"
    ;;
  restore)
    in_file="${2:-}"
    if [ -z "$in_file" ]; then
      echo "usage: scripts/backup.sh restore <backup_file>" >&2
      exit 1
    fi
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 < "$in_file"
    echo "restored from $in_file"
    ;;
  *)
    echo "unknown command: $command" >&2
    echo "usage: scripts/backup.sh backup|restore ..." >&2
    exit 1
    ;;
esac
