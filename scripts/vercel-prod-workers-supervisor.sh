#!/usr/bin/env bash
# Keeps payment-worker and orchestrator-worker alive against the real Vercel/Neon production
# database. They connect to the same DB the deployed api-gateway writes to, which the local-only
# dev workers never do, so without this a production run just sits stuck forever with no worker
# watching it. Restarts either process a few seconds after it exits for any reason (a dropped
# pooled connection, a transient network blip) instead of leaving production unattended.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export DATABASE_URL="postgresql://neondb_owner:REDACTED-ROTATED-CREDENTIAL@ep-icy-leaf-avbxe6rb-pooler.c-11.us-east-1.aws.neon.tech/neondb?channel_binding=require&sslmode=require"
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
