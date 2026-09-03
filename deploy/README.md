# Free backend deployment (Oracle Cloud Always Free)

This is the recommended zero-monthly-cost deployment for Ztorrent because it gives the backend a real VM, public IP, Docker, TCP/UDP networking and persistent block storage.

## Create the VM

In Oracle Cloud create an **Always Free eligible Ampere A1** Ubuntu VM in your home region. A practical allocation is **2 OCPUs / 12 GB RAM** (within Oracle's documented Always Free A1 allowance when available).

Give the VM a public IPv4 address. In its VCN security list or NSG allow inbound:

- TCP 22 — SSH
- TCP 80 — HTTPS certificate bootstrap
- TCP 443 — HTTPS API
- UDP 443 — HTTP/3/QUIC for Caddy
- TCP 6888 — BitTorrent
- UDP 6888 — BitTorrent/DHT

Do **not** expose port 6800. aria2 RPC stays inside Docker only.

## Install Ztorrent

SSH into the Ubuntu VM and run:

```bash
git clone https://github.com/matthewcodergamer/Ztorrent.git
cd Ztorrent
sudo bash deploy/oci-free-install.sh
```

The installer:

1. installs Docker + Compose,
2. creates a random aria2 RPC secret,
3. applies the MAX SPEED profile,
4. creates persistent directories under `/opt/ztorrent`,
5. starts aria2 + the Go API + Caddy,
6. creates a free `sslip.io` hostname from the VM's public IP,
7. enables HTTPS automatically,
8. prints the final backend URL.

Example output:

```text
Backend URL: https://ztorrent-203-0-113-25.sslip.io
```

`sslip.io` resolves hostnames containing an IP address back to that IP, so a separate paid domain is not required.

## Connect the mandatory backend

Put the printed URL into `config.js`:

```js
window.ZTORRENT_CONFIG = {
  API_BASE_URL: "https://ztorrent-203-0-113-25.sslip.io",
  REQUIRE_ACCELERATOR: true,
  POLL_INTERVAL_MS: 750
};
```

Commit the change to `main`. GitHub Pages redeploys automatically.

## Verify

```bash
curl https://YOUR-ZTORRENT-DOMAIN/health
```

You want:

```json
{"ok":true,"aria2_ok":true}
```

If `aria2_ok` is false:

```bash
docker compose -f docker-compose.yml -f docker-compose.oci.yml logs --tail=200 aria2 api
```

## Speed profile

The defaults intentionally push aria2 to its useful HTTP ceiling without trying to defeat remote provider limits:

```env
ARIA2_HTTP_CONNECTIONS=16
ARIA2_SPLIT=16
ARIA2_MIN_SPLIT_SIZE=1M
ARIA2_BT_MAX_PEERS=200
ARIA2_DISK_CACHE=512M
ARIA2_FILE_ALLOCATION=falloc
ARIA2_MAX_CONCURRENT_DOWNLOADS=8
```

A source/server can still be slower than your internet connection. Ztorrent can maximize the path available to it, but it cannot force a remote server or torrent swarm to provide bandwidth it does not have or does not permit.
