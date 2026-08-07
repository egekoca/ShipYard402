#!/usr/bin/env bash
# Keeps payment-worker and orchestrator-worker alive against the real Vercel/Neon production
# database. They connect to the same DB the deployed api-gateway writes to, which the local-only
# dev workers never do, so without this a production run just sits stuck forever with no worker
# watching it. Restarts either process a few seconds after it exits for any reason (a dropped
# pooled connection, a transient network blip) instead of leaving production unattended.
#
# Never hardcode the connection string here -- this file is committed to a public repo. Pass it
# in the environment instead, e.g.:
#   DATABASE_URL="$(vercel env pull --environment=production -y /dev/stdout 2>/dev/null | grep '^DATABASE_URL=' | cut -d= -f2- | tr -d '"')" \
#     ./scripts/vercel-prod-workers-supervisor.sh
set -uo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set. Pass the real Neon production connection string in the environment," >&2
  echo "never hardcode it in this file. See the comment at the top of this script." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DATABASE_URL
export DATABASE_TLS=true

run_payment_worker() {
  export PAYMENT_WORKER_ID=payment-worker:vercel-prod
  while true; do
    echo "[$(date '+%H:%M:%S')] starting payment-worker"
    (cd "$REPO_ROOT/apps/payment-worker" && pnpm dev)
    echo "[$(date '+%H:%M:%S')] payment-worker exited, restarting in 3s"
    sleep 3
  done
}

run_orchestrator_worker() {
  export ORCHESTRATOR_WORKER_ID=orchestrator-worker:vercel-prod
  while true; do
    echo "[$(date '+%H:%M:%S')] starting orchestrator-worker"
    (cd "$REPO_ROOT/apps/orchestrator-worker" && pnpm dev)
    echo "[$(date '+%H:%M:%S')] orchestrator-worker exited, restarting in 3s"
    sleep 3
  done
}

run_payment_worker &
PAYMENT_PID=$!
run_orchestrator_worker &
ORCHESTRATOR_PID=$!

trap 'kill $PAYMENT_PID $ORCHESTRATOR_PID 2>/dev/null' EXIT
wait
