# Ztorrent

**Ztorrent is a universal download gateway for authorized downloads.**

Paste an HTTP(S) URL, magnet link, `.torrent`, or Metalink source. The frontend identifies the source and chooses the strongest available download path.

## Live architecture

```text
GitHub Pages UI
      |
      | Browser Mode
      |-- direct HTTP
      |-- CORS-permitted HTTP range segmentation (small files)
      `-- WebTorrent / WebRTC peers

      |
      `-- Accelerator Mode (configure API_BASE_URL)
             |
             v
       Ztorrent Go API
             |
             v
          aria2 RPC
       /     |      \
    HTTP  BitTorrent Metalink
       \     |      /
        shared cache
             |
       resumable HTTPS
             |
           device
```

GitHub Pages is intentionally only the control plane/static frontend. A static host cannot run aria2, open normal BitTorrent TCP/uTP connections, persist an NVMe cache, or safely assemble multi-gigabyte files server-side.

## What works on GitHub Pages by itself

- URL/magnet classification.
- HTTP capability probing when the remote host permits CORS.
- Direct HTTP download fallback.
- Parallel HTTP `Range` downloads for CORS-enabled files up to the configured browser assembly limit (256 MiB by default).
- Browser BitTorrent through WebTorrent/WebRTC-compatible peers.
- PWA shell/offline loading.
- Honest diagnostics when browser security or the source prevents acceleration.

Large downloads should use Accelerator Mode rather than assembling multi-gigabyte `Blob`s in mobile Safari.

## Accelerator backend

The included Go service talks to aria2 over JSON-RPC and provides:

- HTTP(S) segmented downloading.
- Magnet/torrent support through the normal server-side BitTorrent engine.
- Metalink support.
- Pause/resume/cancel.
- Download progress and throughput.
- Safe single-file HTTPS delivery with byte-range/resume support.
- SSRF protection that rejects localhost/private/special network targets.
- No login, DRM, paywall, or provider-rate-limit bypass logic.

### Run locally / on a VPS

```bash
cp .env.example .env
# edit ARIA2_RPC_SECRET
docker compose up -d --build
```

Then set `API_BASE_URL` in `config.js`:

```js
window.ZTORRENT_CONFIG = {
  API_BASE_URL: "https://your-api-host.example",
  MAX_BROWSER_ASSEMBLY_BYTES: 256 * 1024 * 1024,
  POLL_INTERVAL_MS: 1000
};
```

For production, put the API behind HTTPS (Caddy, Nginx, Cloudflare Tunnel, a cloud load balancer, etc.) and keep aria2 RPC private inside the container network.

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

Create job body:

```json
{"source":"https://example.org/linux.iso"}
```

or:

```json
{"source":"magnet:?xt=urn:btih:..."}
```

## GitHub Pages

`.github/workflows/pages.yml` publishes the static frontend from `main`.

If Pages has never been enabled for this repository, open:

**Repository Settings → Pages → Build and deployment → Source → GitHub Actions**

Once enabled, pushes to `main` deploy automatically.

Expected project URL:

`https://matthewcodergamer.github.io/Ztorrent/`

## Security model

“Paste anything” is dangerous if a backend blindly fetches arbitrary addresses. Ztorrent therefore rejects private/internal HTTP targets before probing or handing a URL to aria2. Production deployments should additionally add authentication/quotas, storage limits, malware scanning where appropriate, per-user job isolation, abuse controls, and automatic cache expiry.

Ztorrent is for files you own or are authorized to retrieve. It does not provide mechanisms to circumvent authentication, DRM, paywalls, or explicit provider restrictions.
