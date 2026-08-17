#!/usr/bin/env bash
# Restarts the BOT Chain testnet demo target, opens an HTTP/2 quick tunnel, and republishes the
# stable marketplace entry against the new public hostname. The BOT API/workers remain separate
# processes using .env.botchain and are intentionally not restarted here.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> stopping the previous BOT target and its quick tunnel"
pkill -f "cloudflared tunnel.*http://127.0.0.1:3012" 2>/dev/null || true
pkill -f "node --env-file=.env.botchain apps/x402-demo-target/dist/server.js" 2>/dev/null || true

echo "==> building and starting BOT target on :3012"
pnpm --filter @shipyard402/x402-demo-target build
# .env.botchain's PORT belongs to the API gateway (:3011). Existing process environment wins over
# Node's --env-file values, so explicitly isolate the target on :3012.
nohup env PORT=3012 node --env-file=.env.botchain apps/x402-demo-target/dist/server.js > /tmp/botchain-target.log 2>&1 &

for _ in $(seq 1 30); do
  if curl -sS -o /dev/null http://127.0.0.1:3012/health 2>/dev/null; then
    break
  fi
  sleep 1
done
curl -fsS -o /dev/null http://127.0.0.1:3012/health

echo "==> opening Cloudflare quick tunnel over HTTP/2"
: > /tmp/cloudflared-bot-target.log
nohup cloudflared tunnel --protocol http2 --url http://127.0.0.1:3012 > /tmp/cloudflared-bot-target.log 2>&1 &

BOT_TARGET_URL=""
for _ in $(seq 1 30); do
  BOT_TARGET_URL=$(rg -o 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cloudflared-bot-target.log | head -1 || true)
  [ -n "$BOT_TARGET_URL" ] && break
  sleep 1
done
if [ -z "$BOT_TARGET_URL" ]; then
  echo "cloudflared did not report a tunnel URL; inspect /tmp/cloudflared-bot-target.log" >&2
  exit 1
fi

echo "==> publishing BOT marketplace target: $BOT_TARGET_URL"
BOT_TARGET_BASE_URL="$BOT_TARGET_URL" node scripts/testnet/relist-botchain-target.mjs

echo "==> BOT target ready: $BOT_TARGET_URL/paid/resource"
