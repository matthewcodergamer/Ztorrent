// Ztorrent runtime configuration.
// In a private Codespaces deployment the UI and API share the same origin.
// GitHub Pages remains locked until a real accelerator backend is configured.
const inCodespaces = window.location.hostname.endsWith(".app.github.dev");
window.ZTORRENT_CONFIG = {
  API_BASE_URL: inCodespaces ? window.location.origin : "",
  REQUIRE_ACCELERATOR: true,
  POLL_INTERVAL_MS: 750
};

// Guard the analyzer response before app.js runs. A normal HTML webpage is not
// itself a verified downloadable file. Older backend responses can retain the
// probed page URL in download_source even when the extractor found 0 candidate
// files; that made the UI launch aria2 against the webpage and sit at 0 B/s.
(() => {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function ztorrentFetch(input, init) {
    const response = await nativeFetch(input, init);
    try {
      const requestUrl = typeof input === "string" ? input : input?.url || "";
      if (!/\/v1\/analyze(?:\?|$)/.test(requestUrl) || !response.ok) return response;

      const data = await response.clone().json();
      const emptyWebpage = data?.type === "webpage" && Array.isArray(data.candidates) && data.candidates.length === 0;
      if (!emptyWebpage) return response;

      delete data.download_source;
      data.filename = data.filename && data.filename !== "download" ? data.filename : "Webpage";
      data.note = "No verified direct downloadable file was found on this webpage. Ztorrent did not start a download job. Pages that generate files through site-specific JavaScript, authentication, or provider APIs need a supported resolver or an authorized direct file URL.";

      const headers = new Headers(response.headers);
      headers.set("content-type", "application/json");
      headers.set("cache-control", "no-store");
      headers.delete("content-length");
      return new Response(JSON.stringify(data), {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch {
      return response;
    }
  };

  // Make the two download stages explicit on mobile:
  // 1) the main button starts the backend download after analysis;
  // 2) the job-card button appears at 100% to transfer the cached file to the device.
  window.addEventListener("DOMContentLoaded", () => {
    const analyzeLabel = document.querySelector("#analyzeButton span");
    if (analyzeLabel) analyzeLabel.textContent = "Analyze & start download";

    const downloadButton = document.getElementById("downloadButton");
    if (downloadButton) downloadButton.textContent = "Download to this device";

    const actions = document.getElementById("jobActions");
    if (actions && !document.getElementById("downloadFlowHint")) {
      const hint = document.createElement("p");
      hint.id = "downloadFlowHint";
      hint.className = "legal-note";
      hint.textContent = "Backend downloading starts automatically after a real file is verified. When caching reaches 100%, “Download to this device” appears here.";
      actions.parentNode.insertBefore(hint, actions);
    }
  });
})();
