(() => {
  "use strict";

  const rawFetch = window.fetch.bind(window);
  const state = {
    baselineBps: 0,
    baselineStatus: "Waiting for test",
    baselineHint: "A one-connection sample will run before acceleration.",
    signedLike: false,
    analysis: null,
    job: null,
    startedAt: 0,
    zeroSince: 0
  };

  const fmtBytes = (n) => {
    n = Number(n);
    if (!Number.isFinite(n) || n < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
  };
  const fmtSpeed = (n) => Number(n) > 0 ? `${fmtBytes(Number(n))}/s` : "0 B/s";
  const fmtTime = (seconds) => {
    seconds = Math.max(0, Math.round(Number(seconds) || 0));
    if (!seconds) return "—";
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
  };

  function ensurePanel() {
    let panel = document.getElementById("ztSpeedCompare");
    if (panel) return panel;
    const grid = document.querySelector(".metric-grid");
    if (!grid) return null;

    const style = document.createElement("style");
    style.textContent = `
      #ztSpeedCompare{margin-top:16px;border:1px solid rgba(140,255,193,.17);border-radius:22px;overflow:hidden;background:rgba(8,28,22,.42)}
      .zt-compare-head{padding:16px 18px;border-bottom:1px solid rgba(140,255,193,.12);display:flex;align-items:center;justify-content:space-between;gap:12px}
      .zt-compare-head strong{font-size:15px;letter-spacing:.04em}.zt-compare-head span{font-size:11px;letter-spacing:.15em;color:#79f2b2;font-weight:800}
      .zt-compare-grid{display:grid;grid-template-columns:1fr 1fr}
      .zt-compare-cell{padding:18px;min-height:112px;border-right:1px solid rgba(140,255,193,.11);border-bottom:1px solid rgba(140,255,193,.11)}
      .zt-compare-cell:nth-child(2n){border-right:0}.zt-compare-cell:nth-last-child(-n+2){border-bottom:0}
      .zt-compare-cell small{display:block;color:#78958a;font-size:11px;letter-spacing:.12em;font-weight:800;text-transform:uppercase;margin-bottom:8px}
      .zt-compare-cell strong{display:block;font-size:27px;color:#effff5;line-height:1.1}.zt-compare-cell p{margin:8px 0 0;color:#78958a;font-size:13px;line-height:1.45}
      .zt-stall{display:none;padding:14px 18px;border-top:1px solid rgba(255,173,173,.18);background:rgba(73,22,22,.18);color:#ffb3b3;font-size:13px;line-height:1.5}
      .zt-stall.show{display:block}.zt-good{color:#79f2b2!important}.zt-warn{color:#f4cf7b!important}
      @media(max-width:560px){.zt-compare-grid{grid-template-columns:1fr 1fr}.zt-compare-cell{padding:16px 14px}.zt-compare-cell strong{font-size:23px}}
    `;
    document.head.appendChild(style);

    panel = document.createElement("section");
    panel.id = "ztSpeedCompare";
    panel.innerHTML = `
      <div class="zt-compare-head"><strong>Speed comparison</strong><span>LIVE TELEMETRY</span></div>
      <div class="zt-compare-grid">
        <div class="zt-compare-cell"><small>Regular · 1 connection</small><strong id="ztBaseline">Testing…</strong><p id="ztBaselineHint">Sampling the same source before acceleration.</p></div>
        <div class="zt-compare-cell"><small>Accelerated now</small><strong id="ztAccelerated">0 B/s</strong><p id="ztAccelHint">Live aria2 throughput.</p></div>
        <div class="zt-compare-cell"><small>Speed gain</small><strong id="ztGain">—</strong><p id="ztGainHint">Accelerated ÷ regular baseline.</p></div>
        <div class="zt-compare-cell"><small>Downloaded / ETA</small><strong id="ztDownloaded">0 B</strong><p id="ztEta">Waiting for bytes…</p></div>
      </div>
      <div class="zt-stall" id="ztStall"></div>`;
    grid.insertAdjacentElement("afterend", panel);
    return panel;
  }

  function text(id, value, cls="") {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value;
    el.classList.remove("zt-good", "zt-warn");
    if (cls) el.classList.add(cls);
  }

  function updatePanel() {
    if (!ensurePanel()) return;
    text("ztBaseline", state.baselineBps > 0 ? fmtSpeed(state.baselineBps) : state.baselineStatus, state.baselineBps > 0 ? "zt-good" : "zt-warn");
    text("ztBaselineHint", state.baselineHint);

    const j = state.job || {};
    const live = Number(j.download_speed || 0);
    text("ztAccelerated", fmtSpeed(live), live > 0 ? "zt-good" : "");
    text("ztAccelHint", `${Number(j.connections || 0)} active connection${Number(j.connections || 0) === 1 ? "" : "s"}${j.is_torrent ? ` · ${Number(j.seeders || 0)} seeders` : ""}`);

    if (state.baselineBps > 0 && live > 0) {
      const gain = live / state.baselineBps;
      text("ztGain", `${gain.toFixed(gain >= 10 ? 0 : 1)}×`, gain > 1.05 ? "zt-good" : "");
      text("ztGainHint", gain > 1.05 ? "Parallel/source engine is outperforming the single connection." : "No meaningful acceleration yet; the source may be the bottleneck.");
    } else {
      text("ztGain", "—");
      text("ztGainHint", state.baselineBps > 0 ? "Waiting for accelerated bytes." : "Baseline unavailable until the source can be sampled.");
    }

    const analysisSize = Number(state.analysis?.size || 0);
    const total = Number(j.total_bytes || analysisSize || 0);
    const done = Number(j.completed_bytes || 0);
    text("ztDownloaded", total > 0 ? `${fmtBytes(done)} / ${fmtBytes(total)}` : fmtBytes(done));
    const remaining = Math.max(0, total - done);
    text("ztEta", live > 0 && remaining > 0 ? `ETA ${fmtTime(remaining / live)} · ${fmtBytes(remaining)} remaining` : total > 0 ? `${fmtBytes(remaining)} remaining` : "Waiting for size/metadata…");

    const stall = document.getElementById("ztStall");
    if (!stall) return;
    const status = String(j.status || "").toLowerCase();
    const active = status === "active";
    const failed = status === "error" || status === "removed";

    if (failed) {
      let msg;
      if (state.baselineBps > 0) {
        msg = `The same backend successfully sampled this source at ${fmtSpeed(state.baselineBps)}, but aria2 stopped before receiving the file. That points to the aria2 transfer/storage path rather than basic network reachability. Codespaces now uses no-preallocation mode; rebuild and retry an authorized source.`;
      } else if (state.signedLike) {
        msg = "The source looks like a signed/session URL and the backend could not establish a usable transfer. It may be tied to another browser/session/IP or the remote site may reject automation.";
      } else {
        msg = `aria2 stopped before the transfer completed${j.error_message ? `: ${j.error_message}` : "."}`;
      }
      stall.textContent = msg;
      stall.classList.add("show");
      return;
    }

    if (active && live <= 0) {
      if (!state.zeroSince) state.zeroSince = Date.now();
      const seconds = Math.floor((Date.now() - state.zeroSince) / 1000);
      if (seconds >= 8) {
        let msg;
        if (state.baselineBps > 0) {
          msg = `The baseline reached ${fmtSpeed(state.baselineBps)}, but aria2 has received no bytes for ${seconds}s. The engine may be negotiating or the source may reject parallel requests.`;
        } else {
          msg = `No file bytes have arrived for ${seconds}s. The backend is connected, but the remote source is not delivering data yet.`;
          if (state.signedLike) msg += " This source looks like a signed/session URL; it may work only from the original browser/session and not from the Codespaces server.";
          else msg += " The source may be negotiating, temporarily stalled, limiting the server, or rejecting the backend request.";
        }
        stall.textContent = msg;
        stall.classList.add("show");
      }
    } else {
      state.zeroSince = 0;
      stall.classList.remove("show");
      stall.textContent = "";
    }
  }

  async function runBaseline(source) {
    if (!/^https?:\/\//i.test(source)) {
      state.baselineBps = 0;
      state.baselineStatus = "N/A";
      state.baselineHint = /^magnet:/i.test(source) ? "Torrent speed depends on peers; there is no HTTP single-connection baseline." : "Baseline is available for HTTP(S) sources.";
      updatePanel();
      return;
    }
    state.baselineBps = 0;
    state.baselineStatus = "Testing…";
    state.baselineHint = "Measuring one backend connection before parallel acceleration.";
    state.signedLike = false;
    updatePanel();
    try {
      const r = await rawFetch("/v1/baseline", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({source}), cache:"no-store"});
      const b = await r.json().catch(() => ({}));
      state.signedLike = !!b.signed_like;
      if (!r.ok || !b.ok || !Number(b.bps)) {
        state.baselineStatus = "Unavailable";
        state.baselineHint = b.hint || b.error || `Baseline probe failed (${r.status}).`;
      } else {
        state.baselineBps = Number(b.bps);
        state.baselineStatus = fmtSpeed(b.bps);
        state.baselineHint = `${b.range_supported ? "Range-capable" : "Single stream"} · ${fmtBytes(b.bytes || 0)} sampled in ${Math.max(1, Number(b.elapsed_ms || 0))} ms`;
      }
    } catch (e) {
      state.baselineStatus = "Unavailable";
      state.baselineHint = `Baseline service error: ${e?.message || "connection failed"}`;
    }
    updatePanel();
  }

  window.fetch = async function(input, init) {
    const response = await rawFetch(input, init);
    try {
      const u = new URL(typeof input === "string" ? input : input.url, window.location.href);
      const method = String(init?.method || (typeof input !== "string" && input.method) || "GET").toUpperCase();
      if (u.pathname === "/v1/analyze" && method === "POST") {
        response.clone().json().then(a => { state.analysis = a; if (a?.sample_bps && !state.baselineBps) state.baselineBps = Number(a.sample_bps); updatePanel(); }).catch(() => {});
      } else if (/^\/v1\/jobs\/[^/]+$/.test(u.pathname) && method === "GET") {
        response.clone().json().then(j => { state.job = j; updatePanel(); }).catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  document.addEventListener("DOMContentLoaded", () => {
    ensurePanel();
    const form = document.getElementById("gatewayForm");
    const input = document.getElementById("sourceInput");
    if (form && input) {
      form.addEventListener("submit", () => {
        const source = input.value.trim();
        state.analysis = null;
        state.job = null;
        state.startedAt = Date.now();
        state.zeroSince = 0;
        runBaseline(source);
      }, true);
    }
    setInterval(updatePanel, 1000);
  });
})();
