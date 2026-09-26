#!/usr/bin/env bash
# Local dev — no Docker, no AWS. Just uvicorn + vite, pointed at a Supabase
# Cloud dev project (the free tier gives you 2 projects: one for prod, one
# for dev — better parity than a local Docker Supabase, and nothing to run).
#
# One-time setup:
#   1. Create a dev project at https://supabase.com/dashboard
#   2. cd finance-backend && supabase link --project-ref <dev-project-ref> \
#        && supabase db push
#   3. Copy finance-backend/sync-service/.env.example to .env (not committed)
#      and fill in: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
#      (from the dev project's API settings), plus Plaid / AI keys as needed.
#   4. ./scripts/local-dev.sh
set -euo pipefail
cd "$(dirname "$0")/.."

die() { echo "✗ $1" >&2; exit 1; }

# Load the service .env if present (gitignored, never committed).
if [ -f finance-backend/sync-service/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . finance-backend/sync-service/.env
  set +a
fi

[ -n "${SUPABASE_URL:-}" ] \
  || die "SUPABASE_URL is not set. Create a dev Supabase project, run the migrations (see header), and put the API keys in finance-backend/sync-service/.env"
[ -n "${SUPABASE_ANON_KEY:-}" ] \
  || die "SUPABASE_ANON_KEY is not set (Supabase dashboard → Project Settings → API)."
[ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] \
  || die "SUPABASE_SERVICE_ROLE_KEY is not set (Supabase dashboard → Project Settings → API)."
case "$SUPABASE_URL" in
  *localhost*|*127.0.0.1*)
    die "SUPABASE_URL points at localhost, but local dev no longer runs Supabase via Docker. Point it at your Supabase Cloud dev project." ;;
esac

command -v node >/dev/null 2>&1 || die "node not found (need 20+)."
command -v npm  >/dev/null 2>&1 || die "npm not found."
command -v python3 >/dev/null 2>&1 || die "python3 not found (need 3.11+)."

# uvicorn: prefer the shared venv from scripts/setup-local.sh, else PATH.
SHARED="${POCKETLENS_LOCAL_DIR:-$HOME/.pocketlens}"
UVICORN=""
if [ -x "$SHARED/venv/bin/uvicorn" ]; then
  UVICORN="$SHARED/venv/bin/uvicorn"
elif command -v uvicorn >/dev/null 2>&1; then
  UVICORN="uvicorn"
else
  die "uvicorn not found. Install: python3 -m pip install uvicorn (or run scripts/setup-local.sh)"
fi

# Fernet key for Plaid secrets at rest — shared key file wins, env fallback.
if [ -f "$SHARED/credentials-enc.key" ]; then
  CREDENTIALS_ENC_KEY="$(cat "$SHARED/credentials-enc.key")"
fi
[ -n "${CREDENTIALS_ENC_KEY:-}" ] \
  || die "CREDENTIALS_ENC_KEY is not set. Generate one: python3 -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""

cleanup() { kill 0 2>/dev/null; }
trap cleanup EXIT INT TERM

echo "▸ sync-service on :8000…"
(cd finance-backend/sync-service && \
  SUPABASE_URL="$SUPABASE_URL" \
  SUPABASE_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
  CREDENTIALS_ENC_KEY="$CREDENTIALS_ENC_KEY" \
  "$UVICORN" api:app --host 0.0.0.0 --port 8000) &

echo "▸ web on :5173…"
(cd web && \
  VITE_SUPABASE_URL="$SUPABASE_URL" \
  VITE_SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
  VITE_BACKEND_URL=http://localhost:8000 \
  npm run dev) &

sleep 3
# Best-effort LAN IP for reaching the backend from other devices — cross-platform.
LAN_IP=$( { ipconfig getifaddr en0 2>/dev/null \
  || hostname -I 2>/dev/null | awk '{print $1}' \
  || ip route get 1 2>/dev/null | awk '{print $7; exit}'; } | head -n1)
LAN_IP=${LAN_IP:-<your-lan-ip>}
echo ""
echo "── local dev (no Docker) ───────────────────────────────"
echo "  web        http://localhost:5173"
echo "  backend    http://localhost:8000   (LAN: http://$LAN_IP:8000)"
echo "  supabase   $SUPABASE_URL   (Cloud dev project)"
echo "────────────────────────────────────────────────────────"
wait
