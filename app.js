(() => {
  "use strict";

  const cfg = window.ZTORRENT_CONFIG || {};
  const codespacesOrigin = window.location.hostname.endsWith(".app.github.dev") ? window.location.origin : "";
  const API = String(cfg.API_BASE_URL || codespacesOrigin || "").replace(/\/+$/, "");
  const POLL_MS = Math.max(500, Number(cfg.POLL_INTERVAL_MS || 750));
  const $ = id => document.getElementById(id);

  const ui = {
    form: $("gatewayForm"), input: $("sourceInput"), paste: $("pasteButton"), clear: $("clearButton"), analyze: $("analyzeButton"), workspace: $("workspace"),
    mode: $("modePill"), install: $("installButton"), jobTitle: $("jobTitle"), jobType: $("jobType"), filename: $("jobFilename"), state: $("stateBadge"),
    progress: $("progressBar"), progressNumber: $("progressNumber"), sourceSpeed: $("sourceSpeed"), sourceSpeedHint: $("sourceSpeedHint"), deliverySpeed: $("deliverySpeed"),
    deliverySpeedHint: $("deliverySpeedHint"), connections: $("connections"), connectionsHint: $("connectionsHint"), remaining: $("remaining"), sizeHint: $("sizeHint"),
    diagnostics: $("diagnostics"), engineName: $("engineName"), engineDescription: $("engineDescription"), integrityName: $("integrityName"), integrityDescription: $("integrityDescription"),
    download: $("downloadButton"), pause: $("pauseButton"), resume: $("resumeButton"), cancel: $("cancelButton"), toast: $("toast")
  };

  let currentJob = null;
  let pollTimer = null;
  let installPrompt = null;
  let backendHealth = null;
  let busy = false;
  let currentBaseline = null;
  let currentSource = "";
  let jobStartedAt = 0;

  function toast(message) {
    if (!ui.toast) return;
    ui.toast.textContent = message;
    ui.toast.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => ui.toast.classList.remove("show"), 3200);
  }

  function prettyBytes(n) {
    n = Number(n);
    if (!Number.isFinite(n) || n < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
  }

  function prettySpeed(n) { return Number.isFinite(Number(n)) ? `${prettyBytes(Number(n))}/s` : "—"; }
  function prettyDuration(seconds) {
    seconds = Math.max(0, Math.round(Number(seconds) || 0));
    if (!seconds) return "—";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
  }
  function showWorkspace() { ui.workspace.hidden = false; ui.workspace.scrollIntoView({ behavior: "smooth", block: "start" }); }
  function state(label, tone = "ok") { ui.state.textContent = String(label).toUpperCase(); ui.state.style.color = tone === "bad" ? "var(--danger)" : tone === "warn" ? "#e4c272" : "var(--accent)"; }
  function setProgress(value) { const n = Math.max(0, Math.min(100, Number(value) || 0)); ui.progress.style.width = `${n}%`; ui.progressNumber.textContent = `${n.toFixed(n < 10 && n > 0 ? 1 : 0)}%`; }

  function diag(label, value, tone = "ok", key = "") {
    const row = document.createElement("div");
    row.className = "diagnostic";
    if (key) row.dataset.diagKey = key;
    const left = document.createElement("span");
    const right = document.createElement("span");
    right.className = tone;
    left.textContent = label;
    right.textContent = value;
    row.append(left, right);
    ui.diagnostics.appendChild(row);
    return row;
  }

  function diagSet(key, label, value, tone = "ok") {
    let row = ui.diagnostics.querySelector(`[data-diag-key="${key}"]`);
    if (!row) row = diag(label, value, tone, key);
    const parts = row.querySelectorAll("span");
    if (parts[0]) parts[0].textContent = label;
    if (parts[1]) { parts[1].textContent = value; parts[1].className = tone; }
  }

  function looksSigned(source) {
    try {
      const u = new URL(source);
      return ["token", "api-key", "apikey", "signature", "sig", "expires", "expiry", "auth", "key"].some(k => u.searchParams.has(k));
    } catch { return false; }
  }

  function setBusy(on, label = "Analyze & accelerate") {
    busy = on;
    ui.analyze.disabled = on;
    const span = ui.analyze.querySelector("span");
    if (span) span.textContent = on ? label : "Analyze & accelerate";
    ui.form.setAttribute("aria-busy", on ? "true" : "false");
  }

  function resetJobUi() {
    clearInterval(pollTimer);
    pollTimer = null;
    currentJob = null;
    currentBaseline = null;
    currentSource = "";
    jobStartedAt = 0;
    ui.diagnostics.innerHTML = "";
    ui.download.hidden = ui.pause.hidden = ui.resume.hidden = ui.cancel.hidden = true;
    ui.download.disabled = false;
    ui.jobTitle.textContent = "Analyzing source";
    ui.filename.textContent = "Resolving…";
    ui.jobType.textContent = "AUTO DETECT";
    ui.sourceSpeed.textContent = ui.deliverySpeed.textContent = ui.connections.textContent = ui.remaining.textContent = "—";
    ui.sourceSpeedHint.textContent = "Waiting for source";
    ui.deliverySpeedHint.textContent = "Backend delivery after caching";
    ui.connectionsHint.textContent = "Automatic";
    ui.sizeHint.textContent = "Size unknown";
    ui.engineName.textContent = "Mandatory accelerator";
    ui.engineDescription.textContent = "All downloads run through the Ztorrent backend and aria2.";
    setProgress(0);
    state("Analyzing");
  }

  async function fetchJSON(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...options, signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      return body;
    } catch (error) {
      if (error && error.name === "AbortError") throw new Error("Request timed out. The Codespace may be waking up or the source is not responding.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function baselineProbe(source) {
    if (!/^https?:\/\//i.test(source)) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${API}/v1/baseline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal
      });
      const body = await response.json().catch(() => ({}));
      return { ...body, http_ok: response.ok };
    } catch (error) {
      return { ok: false, error: error?.name === "AbortError" ? "baseline timed out" : (error?.message || "baseline failed"), signed_like: looksSigned(source), hint: "Could not measure a one-connection baseline from the backend." };
    } finally {
      clearTimeout(timer);
    }
  }

  function renderBaseline(b) {
    currentBaseline = b;
    if (!b) return;
    if (b.ok && Number(b.bps) > 0) {
      diagSet("baseline", "Regular speed · 1 connection", prettySpeed(b.bps), "ok");
      diagSet("baseline-sample", "Baseline sample", `${prettyBytes(b.bytes || 0)} in ${Math.max(1, Math.round((b.elapsed_ms || 0) / 100) / 10)}s`, "ok");
    } else {
      diagSet("baseline", "Regular speed · 1 connection", "Could not measure", "warn");
      if (b.http_status) diagSet("baseline-http", "Baseline HTTP status", String(b.http_status), "bad");
      if (b.hint) diagSet("baseline-hint", "Source diagnosis", b.hint, b.signed_like ? "bad" : "warn");
    }
  }

  async function checkBackend(showError = false) {
    const text = ui.mode.querySelector("span");
    if (!API) {
      backendHealth = null;
      ui.mode.classList.remove("backend");
      text.textContent = "Backend required";
      if (showError) renderBackendRequired("This page is not running from the private Codespaces gateway.");
      return false;
    }
    try {
      const h = await fetchJSON(`${API}/health`, {}, 10000);
      if (!h.ok || !h.aria2_ok) throw new Error(!h.aria2_ok ? "aria2 RPC is offline" : "Backend health check failed");
      backendHealth = h;
      ui.mode.classList.add("backend");
      text.textContent = "Accelerator online";
      return true;
    } catch (error) {
      backendHealth = null;
      ui.mode.classList.remove("backend");
      text.textContent = "Accelerator offline";
      if (showError) renderBackendRequired(error.message || "Backend unavailable");
      return false;
    }
  }

  function renderBackendRequired(reason = "Backend unavailable") {
    resetJobUi();
    showWorkspace();
    state("Setup required", "bad");
    ui.jobTitle.textContent = "Accelerator backend unavailable";
    ui.filename.textContent = "Ztorrent will not silently fall back to browser-only downloading";
    diag("Backend", reason, "bad");
    diag("Expected URL", API || "private Codespaces port 8080", "warn");
    diag("Try", "Refresh once, then run bash start.sh if needed", "warn");
    ui.engineName.textContent = "No browser fallback";
    ui.engineDescription.textContent = "The full server-side engine must be online before a download starts.";
  }

  async function backendAnalyze(source) {
    return fetchJSON(`${API}/v1/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source })
    }, 30000);
  }

  function renderAnalysis(a) {
    const labels = { magnet: "BITTORRENT MAGNET", torrent: "TORRENT FILE", metalink: "METALINK", http: "HTTP / HTTPS", webpage: "WEBPAGE / LINK EXTRACTOR" };
    const typeLabel = labels[a.type] || String(a.type || "SOURCE").toUpperCase();
    ui.jobType.textContent = typeLabel;
    ui.filename.textContent = a.filename || "download";
    ui.jobTitle.textContent = a.type === "webpage" ? "Fastest download link found" : "Source resolved";
    ui.engineName.textContent = a.engine || "aria2";
    ui.engineDescription.textContent = a.type === "webpage" ? "Ztorrent scanned the page, probed likely download targets and selected the strongest sampled direct source automatically." : "The backend owns the transfer; the browser only controls and receives the finished file.";
    ui.integrityName.textContent = a.etag ? "ETag locked" : a.type === "magnet" ? "Torrent piece hashes" : "Source guarded";
    if (a.size) { ui.remaining.textContent = prettyBytes(a.size); ui.sizeHint.textContent = `${prettyBytes(a.size)} total`; }
    if (a.sample_bps) { ui.sourceSpeed.textContent = prettySpeed(a.sample_bps); ui.sourceSpeedHint.textContent = "Pre-download source sample"; }
    diag("Source type", typeLabel, "ok");
    if (a.size) diag("File size", prettyBytes(a.size), "ok");
    if (a.range_supported) diag("HTTP byte ranges", "SUPPORTED — parallel fetching enabled", "ok");
    else if (a.type === "http" || a.type === "webpage") diag("HTTP byte ranges", "Not advertised", "warn");
    const p = a.profile || backendHealth?.profile;
    if (p) {
      diag("HTTP connections", `${p.http_connections} per server`, "ok");
      diag("aria2 split", `${p.split} pieces / ${p.min_split_size} minimum`, "ok");
      diag("Torrent peer ceiling", p.bt_max_peers, "ok");
    }
    if (Array.isArray(a.candidates)) {
      diag("Download links found", String(a.candidates.length), a.candidates.length ? "ok" : "warn");
      a.candidates.slice(0, 4).forEach((c, i) => diag(`#${i + 1} ${c.filename || "candidate"}`, `${c.sample_bps ? prettySpeed(c.sample_bps) : "unmeasured"}${c.range_supported ? " • ranges" : ""}`, i === 0 ? "ok" : "warn"));
    }
    if (a.note) diag("Analyzer", a.note, "warn");
  }

  async function createBackendJob(source) {
    const b = await fetchJSON(`${API}/v1/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source })
    }, 20000);
    currentJob = b;
    currentSource = source;
    jobStartedAt = Date.now();
    ui.jobTitle.textContent = "Accelerating at backend maximum";
    ui.cancel.hidden = false;
    ui.pause.hidden = false;
    state("Downloading");
    await pollBackendJob();
    pollTimer = setInterval(pollBackendJob, POLL_MS);
  }

  async function pollBackendJob() {
    if (!currentJob?.id) return;
    try {
      const j = await fetchJSON(`${API}/v1/jobs/${encodeURIComponent(currentJob.id)}`, {}, 10000);
      currentJob = j;
      const total = Number(j.total_bytes || 0);
      const done = Number(j.completed_bytes || 0);
      const speed = Number(j.download_speed || 0);
      const remainingBytes = total > 0 ? Math.max(0, total - done) : 0;
      const elapsedSec = jobStartedAt ? (Date.now() - jobStartedAt) / 1000 : 0;

      setProgress(total > 0 ? done / total * 100 : 0);
      ui.filename.textContent = j.filename || ui.filename.textContent;
      ui.sourceSpeed.textContent = prettySpeed(speed);
      ui.sourceSpeedHint.textContent = j.status === "active" ? "Live accelerated source → aria2 throughput" : "Current engine state";
      ui.connections.textContent = String(j.connections ?? "—");
      ui.connectionsHint.textContent = j.is_torrent ? `${j.seeders || 0} seeders • active peers above` : `Active HTTP connections (max ${j.profile?.http_connections || 16})`;
      ui.remaining.textContent = total ? prettyBytes(remainingBytes) : "—";
      ui.sizeHint.textContent = total ? `${prettyBytes(done)} of ${prettyBytes(total)}` : "Waiting for metadata";

      diagSet("accelerated-live", "Accelerated live speed", prettySpeed(speed), speed > 0 ? "ok" : "warn");
      if (currentBaseline?.ok && Number(currentBaseline.bps) > 0) {
        const gain = speed > 0 ? speed / Number(currentBaseline.bps) : 0;
        diagSet("speed-gain", "Speed gain vs regular", gain > 0 ? `${gain.toFixed(gain >= 10 ? 1 : 2)}×` : "Waiting for bytes", gain > 1 ? "ok" : "warn");
      }
      if (total > 0) {
        const eta = speed > 0 ? remainingBytes / speed : 0;
        diagSet("transfer", "Downloaded / total", `${prettyBytes(done)} / ${prettyBytes(total)}`, done > 0 ? "ok" : "warn");
        diagSet("eta", "ETA at current speed", speed > 0 ? prettyDuration(eta) : "Waiting for source", speed > 0 ? "ok" : "warn");
      }

      if (j.status === "active" && speed <= 0 && done <= 0 && elapsedSec >= 8) {
        const signed = currentBaseline?.signed_like || looksSigned(currentSource);
        const hint = currentBaseline?.hint || (signed
          ? "No file bytes are arriving. This signed/session URL may be valid only for the original browser/account/IP and may not be portable to Codespaces."
          : "No file bytes are arriving from the source. The remote server may be stalled, rejecting the request, or waiting before sending data.");
        diagSet("stall", "Stall diagnosis", hint, signed ? "bad" : "warn");
      }

      if (j.status === "complete") {
        state("Complete");
        ui.jobTitle.textContent = "Cached and ready";
        ui.download.hidden = false;
        ui.pause.hidden = ui.resume.hidden = ui.cancel.hidden = true;
        ui.deliverySpeed.textContent = "READY";
        ui.deliverySpeedHint.textContent = "Resumable HTTPS from backend cache";
        ui.download.onclick = () => startDelivery(j.id, total);
        clearInterval(pollTimer);
        pollTimer = null;
        setProgress(100);
      } else if (j.status === "paused") {
        state("Paused", "warn");
        ui.pause.hidden = true;
        ui.resume.hidden = false;
      } else if (j.status === "error" || j.status === "removed") {
        state("Error", "bad");
        ui.jobTitle.textContent = "Download stopped";
        clearInterval(pollTimer);
        pollTimer = null;
        diagSet("engine-error", "Engine", j.error_message || "Download failed", "bad");
        const signed = currentBaseline?.signed_like || looksSigned(currentSource);
        if (signed) {
          diagSet("source-diagnosis", "Source diagnosis", currentBaseline?.hint || "This looks like a signed/session URL. A link issued to Safari can be rejected when reused from a different machine/IP such as Codespaces.", "bad");
        }
      } else {
        state(j.status || "Downloading");
        ui.pause.hidden = false;
        ui.resume.hidden = true;
      }
    } catch (error) {
      ui.sourceSpeedHint.textContent = error.message || "Backend status temporarily unavailable";
    }
  }

  function startDelivery(id, total) {
    ui.deliverySpeed.textContent = "STARTING";
    ui.deliverySpeedHint.textContent = "Your browser is receiving the cached file";
    window.location.href = `${API}/v1/jobs/${encodeURIComponent(id)}/file`;
    setTimeout(() => { if (total) ui.deliverySpeedHint.textContent = "Delivery speed is controlled by backend → device network path"; }, 1200);
  }

  async function jobAction(action) {
    if (!currentJob?.id) return;
    await fetchJSON(`${API}/v1/jobs/${encodeURIComponent(currentJob.id)}/${action}`, { method: "POST" }, 10000);
    await pollBackendJob();
  }

  async function submit(source) {
    if (busy) return;
    resetJobUi();
    showWorkspace();
    setBusy(true, "Checking backend…");
    try {
      if (!await checkBackend(true)) return;
      setBusy(true, "Analyzing source…");
      const analysis = await backendAnalyze(source);
      renderAnalysis(analysis);
      const downloadSource = analysis.download_source || source;
      if (analysis.type === "webpage" && !analysis.download_source) {
        state("No direct file", "warn");
        ui.jobTitle.textContent = "No downloadable target verified";
        return;
      }
      if (downloadSource !== source) diag("Selected source", "Fastest verified page candidate", "ok");

      if (/^https?:\/\//i.test(downloadSource)) {
        setBusy(true, "Measuring regular speed…");
        renderBaseline(await baselineProbe(downloadSource));
      }

      setBusy(true, "Starting download…");
      await createBackendJob(downloadSource);
    } catch (error) {
      state("Error", "bad");
      ui.jobTitle.textContent = "Could not start";
      ui.filename.textContent = "The request failed before a job was created";
      diagSet("start-error", "Error", error.message || "Unknown error", "bad");
      toast(error.message || "Could not start download");
    } finally {
      setBusy(false);
    }
  }

  ui.form.addEventListener("submit", event => {
    event.preventDefault();
    const source = ui.input.value.trim();
    if (!source) { toast("Paste a URL, webpage or magnet first."); ui.input.focus(); return; }
    submit(source);
  });

  ui.analyze.disabled = false;
  ui.paste.addEventListener("click", async () => {
    try { ui.input.value = await navigator.clipboard.readText(); ui.input.dispatchEvent(new Event("input")); }
    catch { toast("Clipboard access was blocked. Paste manually."); }
  });
  ui.clear.addEventListener("click", () => { ui.input.value = ""; ui.workspace.hidden = true; clearInterval(pollTimer); currentJob = null; currentBaseline = null; currentSource = ""; setBusy(false); });
  ui.input.addEventListener("input", () => { ui.input.style.height = "auto"; ui.input.style.height = `${Math.min(ui.input.scrollHeight, 132)}px`; });
  ui.pause.addEventListener("click", () => jobAction("pause").catch(e => toast(e.message)));
  ui.resume.addEventListener("click", () => jobAction("resume").catch(e => toast(e.message)));
  ui.cancel.addEventListener("click", () => jobAction("cancel").catch(e => toast(e.message)));
  window.addEventListener("error", e => toast(`UI error: ${e.message || "unknown error"}`));
  window.addEventListener("unhandledrejection", e => toast(`Request error: ${e.reason?.message || e.reason || "unknown error"}`));
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; ui.install.hidden = false; });
  ui.install.addEventListener("click", async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; ui.install.hidden = true; });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js?v=4").catch(() => {});
  checkBackend(false);
})();