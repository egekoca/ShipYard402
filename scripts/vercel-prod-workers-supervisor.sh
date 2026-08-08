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

# `pnpm dev` (tsx watch --env-file-if-exists=../../.env) used to load the repo-root .env for us --
# GOATX402_*, OPENAI_API_KEY, IPFS_API_URL, SHIPYARD_RUN_REGISTRY_ADDRESS, signer paths, etc. Plain
# `node dist/main.js` does not, so it has to happen here instead. DATABASE_URL is saved and
# restored around it: .env's own DATABASE_URL is the local dev Postgres one, and it must lose to
# the real prod Neon URL this script was started with.
PROD_DATABASE_URL="$DATABASE_URL"
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi
export DATABASE_URL="$PROD_DATABASE_URL"
export DATABASE_TLS=true

# Compiled start (node dist/main.js), not `pnpm dev` (tsx watch): a file-watcher has no business
# running unattended against production, and it means an unrelated edit elsewhere in the repo
# can never accidentally restart a live worker mid-run. This does mean a source change only
# reaches the running workers once this script (re)builds -- see the build below, which runs once
# per supervisor start, i.e. once per `launchctl kickstart`.
# Goes through turbo, not a plain `pnpm --filter ... build`, specifically so a change to a shared
# packages/* dependency (goat-network-config, policy-engine, etc.) also gets rebuilt here -- turbo's
# `dependsOn: ["^build"]` in turbo.json walks the dependency graph even when the filter only names
# these two apps. A plain pnpm filter would happily rebuild only the two apps themselves and leave
# a stale packages/* dist/ in place, silently.
echo "[$(date '+%H:%M:%S')] building payment-worker and orchestrator-worker (and their dependencies)"
if ! (cd "$REPO_ROOT" && pnpm exec turbo run build --filter=@shipyard402/payment-worker --filter=@shipyard402/orchestrator-worker); then
  echo "[$(date '+%H:%M:%S')] build failed -- refusing to start workers against stale or half-built dist/" >&2
  exit 1
fi

run_payment_worker() {
  export PAYMENT_WORKER_ID=payment-worker:vercel-prod
  while true; do
    echo "[$(date '+%H:%M:%S')] starting payment-worker"
    (cd "$REPO_ROOT/apps/payment-worker" && pnpm start)
    echo "[$(date '+%H:%M:%S')] payment-worker exited, restarting in 3s"
    sleep 3
  done
}

run_orchestrator_worker() {
  export ORCHESTRATOR_WORKER_ID=orchestrator-worker:vercel-prod
  while true; do
    echo "[$(date '+%H:%M:%S')] starting orchestrator-worker"
    (cd "$REPO_ROOT/apps/orchestrator-worker" && pnpm start)
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
