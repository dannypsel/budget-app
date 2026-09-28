#!/usr/bin/env bash
# Local e2e: signup + data isolation + onboarding wizard, against the Supabase
# Cloud dev project (no Docker — same stack ./scripts/local-dev.sh uses).
#
# Needs two things running (starts none of them itself, but tells you what's missing):
#   1. sync-service on :8000 pointed at the dev project
#   2. vite on :5173 with VITE_BACKEND_URL=http://localhost:8000
#      (Easier: just run ./scripts/local-dev.sh, which starts 1–2 for you.)
#
# Test config comes from finance-backend/sync-service/.env (the dev project's
# API keys). The signup spec creates throwaway users in the dev project — use
# a dev project, never prod.
set -euo pipefail
cd "$(dirname "$0")/.."          # web/
REPO_ROOT="$(cd .. && pwd)"

# Load the service .env if present (gitignored, never committed).
if [ -f "$REPO_ROOT/finance-backend/sync-service/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/finance-backend/sync-service/.env"
  set +a
fi
[ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_PUBLISHABLE_KEY:-}" ] && [ -n "${SUPABASE_SECRET_KEY:-}" ] \
  || { echo "SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY not set — see scripts/local-dev.sh header"; exit 1; }

curl -sf http://localhost:8000/health >/dev/null \
  || { echo "sync-service not on :8000 — run ./scripts/local-dev.sh first"; exit 1; }
curl -sf http://localhost:5173 >/dev/null \
  || { echo "vite not on :5173 — run ./scripts/local-dev.sh first"; exit 1; }

export E2E_SUPABASE_URL="$SUPABASE_URL"
export E2E_PUBLISHABLE_KEY="$SUPABASE_PUBLISHABLE_KEY"
export E2E_SECRET_KEY="$SUPABASE_SECRET_KEY"
export E2E_BACKEND_URL="http://localhost:8000"

npx playwright test signup isolation wizard "$@"
