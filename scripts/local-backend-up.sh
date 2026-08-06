#!/usr/bin/env bash
# Brings up the parts of the backend that still run locally (payment-worker,
# orchestrator-worker, x402-demo-target) after a reboot or restart, and re-tunnels
# x402-demo-target with cloudflared since its previous public URL stops working the moment
# the tunnel process dies. api-gateway and web-dashboard are NOT started here -- they're
# real Vercel deployments now (see docs/evidence/) and don't need this machine at all.
#
# What this does, in order:
#   1. Starts docker-compose's postgres + ipfs if they're not already up.
#   2. Starts x402-demo-target locally.
#   3. Opens a fresh cloudflared quick tunnel to it and captures the new public URL --
#      this URL is NOT stable (no owned domain to pin a named tunnel to; see the session's
#      own conversation record for why), so it's written into .env fresh every run.
#   4. Restarts payment-worker and orchestrator-worker so they pick up that new URL.
#
# Usage: ./scripts/local-backend-up.sh

set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> docker-compose: postgres + ipfs"
docker-compose up -d --wait postgres ipfs

echo "==> stopping any previous local processes"
pkill -f "cloudflared tunnel --url http://127.0.0.1:3002" 2>/dev/null || true
pkill -f "x402-demo-target.*tsx watch" 2>/dev/null || true
pkill -f "payment-worker.*tsx watch" 2>/dev/null || true
pkill -f "orchestrator-worker.*tsx watch" 2>/dev/null || true
sleep 1

echo "==> starting x402-demo-target on :3002"
PORT=3002 nohup pnpm --filter @shipyard402/x402-demo-target dev > /tmp/x402-demo-target-dev.log 2>&1 &
disown

echo -n "==> waiting for it to respond"
for _ in $(seq 1 30); do
  if curl -s -o /dev/null http://127.0.0.1:3002/paid/resource 2>/dev/null; then
    echo " ready"
    break
  fi
  echo -n "."
  sleep 1
done

echo "==> opening a cloudflared tunnel to it"
nohup cloudflared tunnel --url http://127.0.0.1:3002 > /tmp/cloudflared-demo-target.log 2>&1 &
disown

TUNNEL_URL=""
for _ in $(seq 1 30); do
  TUNNEL_URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/cloudflared-demo-target.log | head -1 || true)
  [ -n "$TUNNEL_URL" ] && break
  sleep 1
done
if [ -z "$TUNNEL_URL" ]; then
  echo "cloudflared did not report a tunnel URL in time -- check /tmp/cloudflared-demo-target.log" >&2
  exit 1
fi
TUNNEL_HOST="${TUNNEL_URL#https://}"
echo "==> tunnel is up: $TUNNEL_URL"

echo "==> writing DEMO_TARGET_BASE_URL / DEMO_TARGET_HOST into .env"
python3 - "$TUNNEL_URL" "$TUNNEL_HOST" <<'PYEOF'
import re
import sys

url, host = sys.argv[1], sys.argv[2]
with open('.env') as f:
    content = f.read()
content = re.sub(r'^DEMO_TARGET_BASE_URL=.*$', f'DEMO_TARGET_BASE_URL={url}', content, flags=re.M)
content = re.sub(r'^DEMO_TARGET_HOST=.*$', f'DEMO_TARGET_HOST={host}', content, flags=re.M)
with open('.env', 'w') as f:
    f.write(content)
PYEOF

echo "==> starting payment-worker"
nohup pnpm --filter @shipyard402/payment-worker dev > /tmp/payment-worker-dev.log 2>&1 &
disown

echo "==> starting orchestrator-worker"
nohup pnpm --filter @shipyard402/orchestrator-worker dev > /tmp/orchestrator-worker-dev.log 2>&1 &
disown

sleep 5
echo
echo "==> done. x402-demo-target public URL this run: $TUNNEL_URL"
echo "    (this changes every run -- nothing else needs to know about it, only .env, which this script just updated)"
echo "    Logs: /tmp/x402-demo-target-dev.log /tmp/payment-worker-dev.log /tmp/orchestrator-worker-dev.log /tmp/cloudflared-demo-target.log"
