# Ztorrent accelerator backend setup

Ztorrent v0.2 requires the backend. GitHub Pages is only the control panel.

## Recommended host

Use a Linux VPS or dedicated server with:

- Docker + Docker Compose
- public IPv4
- at least 2 CPU cores / 2 GB RAM
- SSD or NVMe storage
- enough monthly bandwidth for the downloads you intend to serve
- inbound TCP + UDP port 6888 for BitTorrent
- HTTPS reverse proxy for the API

For very fast links (1 Gbit/s and above), prefer NVMe storage and 4+ GB RAM.

## 1. Configure

```bash
cp .env.example .env
openssl rand -hex 32
```

Paste the generated value into `ARIA2_RPC_SECRET`.

The defaults are intentionally aggressive:

```env
ARIA2_HTTP_CONNECTIONS=16
ARIA2_SPLIT=16
ARIA2_MIN_SPLIT_SIZE=1M
ARIA2_BT_MAX_PEERS=200
ARIA2_DISK_CACHE=512M
ARIA2_FILE_ALLOCATION=falloc
ARIA2_MAX_CONCURRENT_DOWNLOADS=8
```

`16` is the aria2 maximum for `max-connection-per-server`. More than this cannot be forced through that aria2 setting. A source can still impose its own aggregate rate limit, and Ztorrent does not bypass provider-enforced limits.

If the host filesystem does not support `falloc`, use:

```env
ARIA2_FILE_ALLOCATION=none
```

If the server has little RAM, lower:

```env
ARIA2_DISK_CACHE=128M
```

## 2. Start

```bash
docker compose up -d --build
```

Check:

```bash
curl http://127.0.0.1:8080/health
```

A ready system reports `aria2_ok: true` and returns the active speed profile.

## 3. Put HTTPS in front of port 8080

Do not expose aria2 RPC port 6800 publicly. Only expose the Go API through HTTPS.

Example Caddy configuration:

```caddy
ztorrent-api.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## 4. Connect GitHub Pages

Edit `config.js`:

```js
window.ZTORRENT_CONFIG = {
  API_BASE_URL: "https://ztorrent-api.example.com",
  REQUIRE_ACCELERATOR: true,
  POLL_INTERVAL_MS: 750
};
```

Commit and push. The Pages workflow redeploys automatically.

## What the MAX SPEED profile does

HTTP/HTTPS:

- 16 connections per server
- 16 split pieces
- 1 MiB minimum split size
- unlimited aria2 download limit
- HTTP keep-alive + pipelining
- immediate retry strategy
- resumable downloads

BitTorrent:

- DHT enabled
- peer exchange enabled
- local peer discovery enabled
- up to 200 peers per torrent
- metadata saved
- TCP and UDP listening port 6888
- small upload cap by default to leave bandwidth for receiving data

Webpage URLs:

- fetches up to 4 MiB of HTML
- extracts likely direct-download links
- safely resolves relative links
- rejects private/internal targets
- probes up to 40 candidates
- samples up to 512 KiB from candidates
- automatically chooses the highest-scoring candidate

The backend never circumvents authentication, DRM, paywalls, or explicit provider rate restrictions.
