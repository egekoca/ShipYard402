#!/bin/bash
# Wrapper invoked by the com.shipyard402.prod-workers launchd agent. Loads the production
# DATABASE_URL from a gitignored, chmod 600 local file (never commit .env.prod-workers.local)
# and hands off to the supervisor script that keeps payment-worker and orchestrator-worker
# alive against the real Vercel/Neon production database.
# launchd gives this process a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) with no idea where
# nvm's node/pnpm live, unlike an interactive shell that sources ~/.zshrc -- without this the
# supervisor script (and everything it execs) fails immediately with "pnpm: command not found".
export PATH="/Users/ege/.nvm/versions/node/v24.11.1/bin:$PATH"

set -a
source /Users/ege/Desktop/Shipyard402Goat/.env.prod-workers.local
set +a
exec /Users/ege/Desktop/Shipyard402Goat/scripts/vercel-prod-workers-supervisor.sh
