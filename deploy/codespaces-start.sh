#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not available in this Codespace. Rebuild the Codespace with Docker support enabled."
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but the daemon is not ready yet. Wait a few seconds and run this script again."
  exit 1
fi

if [ ! -f .env ]; then
  SECRET="$(openssl rand -hex 32)"
  cat > .env <<EOF
ARIA2_RPC_SECRET=${SECRET}
FRONTEND_ORIGIN=https://matthewcodergamer.github.io
ARIA2_HTTP_CONNECTIONS=16
ARIA2_SPLIT=16
ARIA2_MIN_SPLIT_SIZE=1M
ARIA2_BT_MAX_PEERS=200
ARIA2_DISK_CACHE=512M
ARIA2_FILE_ALLOCATION=falloc
ARIA2_MAX_CONCURRENT_DOWNLOADS=8
ARIA2_MAX_OVERALL_UPLOAD_LIMIT=2M
ARIA2_BT_UPLOAD_LIMIT=2M
ARIA2_IPV6_MODE=false
EOF
  chmod 600 .env
  echo "Created a private .env with a random aria2 RPC secret."
else
  echo "Using existing .env."
fi

echo "Starting Ztorrent private app + API + aria2 + telemetry..."
docker compose up -d --build

echo "Waiting for Ztorrent..."
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8080/health >/tmp/ztorrent-health.json 2>/dev/null; then
    echo
    cat /tmp/ztorrent-health.json
    echo

    echo "Running Ztorrent self-test..."
    curl -fsS http://127.0.0.1:8080/ >/tmp/ztorrent-index.html
    grep -q 'id="gatewayForm"' /tmp/ztorrent-index.html
    docker compose ps --status running telemetry | grep -q telemetry

    curl -fsS \
      -H 'content-type: application/json' \
      -d '{"source":"magnet:?xt=urn:btih:0123456789012345678901234567890123456789&dn=Ztorrent%20self-test"}' \
      http://127.0.0.1:8080/v1/analyze >/tmp/ztorrent-analyze.json
    grep -q '"type":"magnet"' /tmp/ztorrent-analyze.json

    baseline_code="$(curl -sS -o /tmp/ztorrent-baseline.json -w '%{http_code}' \
      -H 'content-type: application/json' \
      -d '{"source":"http://127.0.0.1/test"}' \
      http://127.0.0.1:8080/v1/baseline || true)"
    if [ "$baseline_code" != "400" ]; then
      echo "Telemetry route self-test failed: expected safe rejection HTTP 400, got ${baseline_code}."
      cat /tmp/ztorrent-baseline.json 2>/dev/null || true
      exit 1
    fi

    echo "SELF-TEST PASS: UI + gateway + /health + /v1/analyze + speed telemetry are working."
    echo
    echo "Ztorrent is running on private port 8080."

    if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
      APP_URL="https://${CODESPACE_NAME}-8080.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
      echo
      echo "PRIVATE APP URL:"
      echo "  ${APP_URL}/?v=6"
      echo "HEALTH CHECK:"
      echo "  ${APP_URL}/health"
    else
      echo "Open the Codespaces PORTS tab and open port 8080."
    fi

    echo
    echo "Keep port 8080 visibility PRIVATE."
    echo "The live job shows regular one-connection speed, accelerated live speed, gain, transferred bytes, ETA, and stall/session-link diagnosis."
    exit 0
  fi
  sleep 1
done

echo "The containers started, but Ztorrent did not become ready in 60 seconds."
echo "Run: docker compose ps"
echo "Then: docker compose logs --tail=100 gateway api aria2 telemetry"
exit 1
