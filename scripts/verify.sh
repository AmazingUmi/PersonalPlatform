#!/usr/bin/env bash
# Full local acceptance run for Personal Platform v0.1.
# Runs install, generate, check, build, unit + integration tests, migrations,
# then boots the backend and smoke-tests the health endpoints and the three
# validation apps. DB-dependent steps are skipped (with a clear message) when
# PostgreSQL is not reachable.
#
#   SKIP_INSTALL=1 scripts/verify.sh   # skip `npm ci` if already installed
set -euo pipefail
cd "$(dirname "$0")/.."

TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgresql://personal_platform:change-me-for-local-development@127.0.0.1:5432/personal_platform_test}"
DATABASE_URL="${DATABASE_URL:-postgresql://personal_platform:change-me-for-local-development@localhost:5432/personal_platform}"
BACKEND_PORT="${BACKEND_PORT:-8901}"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

db_reachable() {
  node -e '
    const { Client } = require("pg");
    const c = new Client({ connectionString: process.argv[1] });
    c.connect().then(() => { console.log("up"); c.end(); }).catch(() => { console.log("down"); });
  ' "$1"
}

step "install"
if [ "${SKIP_INSTALL:-0}" != "1" ]; then npm ci; fi

step "generate app module tables"
npm run generate:apps

step "type check"
npm run check

step "build"
npm run build

step "unit tests"
npm test

if [ "$(db_reachable "$TEST_DATABASE_URL")" != "up" ]; then
  echo ""
  echo "!! PostgreSQL not reachable at $TEST_DATABASE_URL"
  echo "!! Skipping migrations, integration tests and the backend smoke test."
  echo "!! Start Postgres (or Docker Compose) and re-run to complete full acceptance."
  exit 0
fi

step "migrations"
DATABASE_URL="$TEST_DATABASE_URL" npm run migration:up

step "integration tests"
TEST_DATABASE_URL="$TEST_DATABASE_URL" npm run test:integration

step "backend smoke test"
PORT="$BACKEND_PORT" DATABASE_URL="$DATABASE_URL" \
  npm run start --workspace @personal-platform/backend > /tmp/pp-backend.log 2>&1 &
BACKEND_PID=$!
trap 'kill "$BACKEND_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:$BACKEND_PORT/api/core/health/live" > /dev/null 2>&1; then break; fi
  sleep 1
done

curl -fsS "http://localhost:$BACKEND_PORT/api/core/health/live"
echo ""
curl -fsS "http://localhost:$BACKEND_PORT/api/core/health/ready"
echo ""
APPS_JSON="$(curl -fsS "http://localhost:$BACKEND_PORT/api/core/apps")"
echo "$APPS_JSON"
node -e '
  const body = JSON.parse(process.argv[1]);
  const ids = body.items.map((a) => a.id).sort();
  const expect = ["assets", "mini_game", "tasks"];
  if (JSON.stringify(ids) !== JSON.stringify(expect)) {
    console.error(`expected apps ${expect}, got ${ids}`);
    process.exit(1);
  }
  if (!body.items.every((a) => a.status === "enabled")) {
    console.error("expected all apps enabled");
    process.exit(1);
  }
  console.log("OK: three validation apps enabled");
' "$APPS_JSON"

kill "$BACKEND_PID" 2>/dev/null || true
trap - EXIT

echo ""
echo "All runnable acceptance steps passed."
echo "Note: Docker Compose startup was not exercised (Docker is not required by this script)."
