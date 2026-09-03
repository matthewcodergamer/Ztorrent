# Ztorrent v0.2

Ztorrent is a backend-powered universal download gateway for **authorized downloads**.

Paste a direct HTTP(S) URL, normal webpage, magnet, `.torrent`, or Metalink. The backend resolves the source, extracts likely direct-download links from webpages, probes candidates, chooses the strongest sampled path, and sends the transfer through a tuned aria2 engine.

## Important change in v0.2

**The accelerator backend is no longer optional.**

GitHub Pages is only the control panel. If the Go API + aria2 backend is not online, the download button stays disabled. Ztorrent no longer silently falls back to weaker browser-only downloading.

```text
GitHub Pages UI
      |
      v
Ztorrent Go API
      |
      +-- URL resolver
      +-- webpage link extractor
      +-- candidate probing / sampling
      +-- SSRF protection
      |
      v
aria2
  +-- segmented HTTP/S
  +-- BitTorrent / DHT / PEX
  +-- Metalink mirrors
      |
      v
persistent SSD/NVMe cache
      |
      v
resumable HTTPS -> device
```

## MAX SPEED defaults

- HTTP connections per server: **16**
- Split pieces: **16**
- Minimum split size: **1 MiB**
- aria2 download limit: **unlimited**
- Torrent peer ceiling: **200**
- Disk cache: **512 MiB**
- Concurrent backend jobs: **8**
- HTTP keep-alive + pipelining: enabled
- DHT + peer exchange + local peer discovery: enabled
- Retry wait: 1 second
- Source probe/link extraction: automatic

`max-connection-per-server=16` is aria2's maximum value. Ztorrent cannot force a provider to send faster than the provider, CDN, torrent swarm, server network, disk, or user connection can actually supply. It also does not bypass provider-enforced rate limits.

## Webpage link extraction

When the pasted source resolves to HTML, Ztorrent automatically:

1. reads up to 4 MiB of the page,
2. finds likely direct-download links,
3. resolves relative URLs,
4. rejects local/private network targets,
5. probes up to 40 candidates,
6. briefly samples candidate throughput,
7. ranks the results,
8. automatically selects the strongest candidate.

No separate "extract links" mode is required.

## Backend setup

See [`BACKEND_SETUP.md`](./BACKEND_SETUP.md).

Quick start:

```bash
cp .env.example .env
# set a long random ARIA2_RPC_SECRET
docker compose up -d --build
curl http://127.0.0.1:8080/health
```

Then put the API behind HTTPS and set `API_BASE_URL` in `config.js`.

## API

```text
GET  /health
POST /v1/analyze
POST /v1/jobs
GET  /v1/jobs/{gid}
POST /v1/jobs/{gid}/pause
POST /v1/jobs/{gid}/resume
POST /v1/jobs/{gid}/cancel
GET  /v1/jobs/{gid}/file
```

## GitHub Pages

The repository includes `.github/workflows/pages.yml`. Pushes to `main` redeploy the static control panel automatically.

Expected Pages URL:

`https://matthewcodergamer.github.io/Ztorrent/`

## Security / scope

Ztorrent blocks localhost/private/special-network HTTP targets and does not implement login bypasses, DRM circumvention, paywall bypasses, or explicit provider rate-limit evasion. Use it only for files you own or are authorized to retrieve.
