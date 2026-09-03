#!/usr/bin/env bash
set -Eeuo pipefail

if [ "${EUID}" -ne 0 ]; then
  echo "Run this installer with sudo: sudo bash deploy/oci-free-install.sh"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  apt-get update
  apt-get install -y curl ca-certificates
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg openssl ufw

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

mkdir -p /opt/ztorrent/downloads /opt/ztorrent/aria2 /opt/ztorrent/caddy-data /opt/ztorrent/caddy-config
chmod 755 /opt/ztorrent
chmod 775 /opt/ztorrent/downloads /opt/ztorrent/aria2 /opt/ztorrent/caddy-data /opt/ztorrent/caddy-config

PUBLIC_IP="${PUBLIC_IP:-$(curl -4fsS --max-time 10 https://api.ipify.org || true)}"
if [ -z "$PUBLIC_IP" ]; then
  echo "Could not detect the public IPv4 address. Re-run with: sudo PUBLIC_IP=x.x.x.x bash deploy/oci-free-install.sh"
  exit 1
fi

DASHED_IP="${PUBLIC_IP//./-}"
ZT_DOMAIN="${ZT_DOMAIN:-ztorrent-${DASHED_IP}.sslip.io}"
RPC_SECRET="${ARIA2_RPC_SECRET:-$(openssl rand -hex 32)}"

cat > .env <<ENVEOF
ARIA2_RPC_SECRET=${RPC_SECRET}
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
ZTORRENT_DOMAIN=${ZT_DOMAIN}
ENVEOF
chmod 600 .env

ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw allow 6888/tcp >/dev/null
ufw allow 6888/udp >/dev/null
ufw --force enable >/dev/null

cat > /etc/sysctl.d/99-ztorrent.conf <<'SYSCTL'
net.core.somaxconn=4096
net.ipv4.tcp_fin_timeout=15
net.ipv4.tcp_keepalive_time=120
net.ipv4.ip_local_port_range=10240 65535
fs.file-max=1048576
SYSCTL
sysctl --system >/dev/null || true

cat > /etc/security/limits.d/99-ztorrent.conf <<'LIMITS'
* soft nofile 262144
* hard nofile 262144
root soft nofile 262144
root hard nofile 262144
LIMITS

systemctl enable --now docker

docker compose -f docker-compose.yml -f docker-compose.oci.yml pull
docker compose -f docker-compose.yml -f docker-compose.oci.yml up -d --build

HEALTH_URL="https://${ZT_DOMAIN}/health"
echo
printf '%s\n' "============================================================"
printf '%s\n' "Ztorrent backend deployment started"
printf '%s\n' "Backend URL: https://${ZT_DOMAIN}"
printf '%s\n' "Health URL:  ${HEALTH_URL}"
printf '%s\n' ""
printf '%s\n' "IMPORTANT: In Oracle Cloud, allow inbound:"
printf '%s\n' "  TCP 80, TCP 443, UDP 443"
printf '%s\n' "  TCP 6888, UDP 6888"
printf '%s\n' ""
printf '%s\n' "Then set config.js API_BASE_URL to:"
printf '%s\n' "  https://${ZT_DOMAIN}"
printf '%s\n' "============================================================"
