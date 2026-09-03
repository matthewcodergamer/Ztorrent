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
ARIA2_FILE_ALLOCATION=none
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

# Codespaces runs Docker on containerized/dev storage. Avoid full-file
# preallocation and repair ownership on the persistent aria2 volumes before
# starting the downloader. aria2 error code 16 means it could not create or
# truncate its output file.
if grep -q '^ARIA2_FILE_ALLOCATION=' .env; then
  sed -i 's/^ARIA2_FILE_ALLOCATION=.*/ARIA2_FILE_ALLOCATION=none/' .env
else
  printf '\nARIA2_FILE_ALLOCATION=none\n' >> .env
fi

echo "Repairing aria2 download/config volume ownership..."
docker compose run --rm storage-init

echo "Codespaces storage mode: ARIA2_FILE_ALLOCATION=none"
echo "aria2 filesystem identity: PUID=65534 PGID=65534"
echo "HTTP compatibility mode: signed/session URLs use conservative single-stream transport; normal direct URLs keep the configured parallel profile."
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

    grep -q '^ARIA2_FILE_ALLOCATION=none$' .env

    if ! docker compose exec -T --user 65534:65534 aria2 sh -c 'touch /downloads/.ztorrent-write-test && rm -f /downloads/.ztorrent-write-test'; then
      echo "STORAGE WRITE TEST FAILED: aria2 still cannot create files in /downloads."
      echo "Run: docker compose logs --tail=100 storage-init aria2"
      exit 1
    fi

    echo "SELF-TEST PASS: UI + gateway + /health + /v1/analyze + speed telemetry are working."
    echo "STORAGE PASS: Codespaces no-preallocation mode is active."
    echo "STORAGE WRITE PASS: the actual aria2 user can create files in /downloads."
    echo "COMPATIBILITY PASS: signed/session HTTP URLs use conservative transport and aria2 error codes are exposed."
    echo
    echo "Ztorrent is running on private port 8080."

    if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
      APP_URL="https://${CODESPACE_NAME}-8080.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
      echo
      echo "PRIVATE APP URL:"
      echo "  ${APP_URL}/?v=9"
      echo "HEALTH CHECK:"
      echo "  ${APP_URL}/health"
    else
      echo "Open the Codespaces PORTS tab and open port 8080."
    fi

    echo
    echo "Keep port 8080 visibility PRIVATE."
    echo "If aria2 ever reports code 16 again, the startup write test will fail before you try a download."
    exit 0
  fi
  sleep 1
done

echo "The containers started, but Ztorrent did not become ready in 60 seconds."
echo "Run: docker compose ps"
echo "Then: docker compose logs --tail=100 storage-init gateway api aria2 telemetry"
exit 1
