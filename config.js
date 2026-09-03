// Ztorrent runtime configuration.
// In a private Codespaces deployment the UI and API share the same origin.
// GitHub Pages remains locked until a real accelerator backend is configured.
const inCodespaces = window.location.hostname.endsWith(".app.github.dev");
window.ZTORRENT_CONFIG = {
  API_BASE_URL: inCodespaces ? window.location.origin : "",
  REQUIRE_ACCELERATOR: true,
  POLL_INTERVAL_MS: 750
};
