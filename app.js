(() => {
  "use strict";
  const cfg = window.ZTORRENT_CONFIG || {};
  const API = String(cfg.API_BASE_URL || "").replace(/\/+$/, "");
  const POLL_MS = Math.max(500, Number(cfg.POLL_INTERVAL_MS || 750));
  const $ = (id) => document.getElementById(id);
  const ui = {
    form: $("gatewayForm"), input: $("sourceInput"), paste: $("pasteButton"), clear: $("clearButton"), analyze: $("analyzeButton"), workspace: $("workspace"),
    mode: $("modePill"), install: $("installButton"), jobTitle: $("jobTitle"), jobType: $("jobType"), filename: $("jobFilename"), state: $("stateBadge"),
    progress: $("progressBar"), progressNumber: $("progressNumber"), sourceSpeed: $("sourceSpeed"), sourceSpeedHint: $("sourceSpeedHint"), deliverySpeed: $("deliverySpeed"),
    deliverySpeedHint: $("deliverySpeedHint"), connections: $("connections"), connectionsHint: $("connectionsHint"), remaining: $("remaining"), sizeHint: $("sizeHint"),
    diagnostics: $("diagnostics"), engineName: $("engineName"), engineDescription: $("engineDescription"), integrityName: $("integrityName"), integrityDescription: $("integrityDescription"),
    download: $("downloadButton"), pause: $("pauseButton"), resume: $("resumeButton"), cancel: $("cancelButton"), toast: $("toast")
  };
  let currentJob = null, pollTimer = null, installPrompt = null, backendHealth = null;

  function toast(message) { ui.toast.textContent = message; ui.toast.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => ui.toast.classList.remove("show"), 2600); }
  function prettyBytes(n) { n = Number(n); if (!Number.isFinite(n) || n < 0) return "—"; const u=["B","KB","MB","GB","TB"]; let i=0; while(n>=1024&&i<u.length-1){n/=1024;i++} return `${n>=100||i===0?n.toFixed(0):n.toFixed(1)} ${u[i]}`; }
  function prettySpeed(n) { return Number.isFinite(Number(n)) ? `${prettyBytes(Number(n))}/s` : "—"; }
  function showWorkspace(){ ui.workspace.hidden=false; ui.workspace.scrollIntoView({behavior:"smooth",block:"start"}); }
  function state(label,tone="ok"){ ui.state.textContent=String(label).toUpperCase(); ui.state.style.color=tone==="bad"?"var(--danger)":tone==="warn"?"#e4c272":"var(--accent)"; }
  function setProgress(value){ const n=Math.max(0,Math.min(100,Number(value)||0)); ui.progress.style.width=`${n}%`; ui.progressNumber.textContent=`${n.toFixed(n<10&&n>0?1:0)}%`; }
  function diag(label,value,tone="ok"){ const row=document.createElement("div"); row.className="diagnostic"; const left=document.createElement("span"),right=document.createElement("span"); right.className=tone; left.textContent=label; right.textContent=value; row.append(left,right); ui.diagnostics.appendChild(row); }
  function resetJobUi(){ clearInterval(pollTimer); pollTimer=null; currentJob=null; ui.diagnostics.innerHTML=""; ui.download.hidden=ui.pause.hidden=ui.resume.hidden=ui.cancel.hidden=true; ui.download.disabled=false; ui.jobTitle.textContent="Analyzing source"; ui.filename.textContent="Resolving…"; ui.jobType.textContent="AUTO DETECT"; ui.sourceSpeed.textContent=ui.deliverySpeed.textContent=ui.connections.textContent=ui.remaining.textContent="—"; ui.sourceSpeedHint.textContent="Waiting for source"; ui.deliverySpeedHint.textContent="Backend delivery after caching"; ui.connectionsHint.textContent="Automatic"; ui.sizeHint.textContent="Size unknown"; ui.engineName.textContent="Mandatory accelerator"; ui.engineDescription.textContent="All downloads run through the Ztorrent backend and aria2."; setProgress(0); state("Analyzing"); }

  async function checkBackend(showError=false){
    const text=ui.mode.querySelector("span");
    if(!API){ ui.mode.classList.remove("backend"); text.textContent="Backend required"; ui.analyze.disabled=true; if(showError) renderBackendRequired(); return false; }
    try{
      const r=await fetch(`${API}/health`,{cache:"no-store"}); const h=await r.json().catch(()=>({}));
      if(!r.ok||!h.ok||!h.aria2_ok) throw new Error(!h.aria2_ok?"aria2 RPC is offline":`HTTP ${r.status}`);
      backendHealth=h; ui.mode.classList.add("backend"); text.textContent="Accelerator online"; ui.analyze.disabled=false; return true;
    }catch(e){ backendHealth=null; ui.mode.classList.remove("backend"); text.textContent="Accelerator offline"; ui.analyze.disabled=true; if(showError) renderBackendRequired(e.message); return false; }
  }

  function renderBackendRequired(reason="API_BASE_URL is not configured"){
    resetJobUi(); showWorkspace(); state("Setup required","bad"); ui.jobTitle.textContent="Accelerator backend required"; ui.filename.textContent="Ztorrent will not fall back to browser-only downloading";
    diag("Backend",reason,"bad"); diag("Required stack","Go API + aria2 + persistent storage","warn"); diag("Next step","Deploy backend, then set API_BASE_URL in config.js","warn");
    ui.engineName.textContent="No browser fallback"; ui.engineDescription.textContent="This build requires the full server-side engine so large files and normal BitTorrent peers never silently drop to a weaker browser path.";
  }

  async function backendAnalyze(source){ const r=await fetch(`${API}/v1/analyze`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({source})}); const b=await r.json().catch(()=>({})); if(!r.ok)throw new Error(b.error||`Analyze failed (${r.status})`); return b; }
  function renderAnalysis(a){
    const labels={magnet:"BITTORRENT MAGNET",torrent:"TORRENT FILE",metalink:"METALINK",http:"HTTP / HTTPS",webpage:"WEBPAGE / LINK EXTRACTOR"};
    const typeLabel=labels[a.type]||String(a.type||"SOURCE").toUpperCase(); ui.jobType.textContent=typeLabel; ui.filename.textContent=a.filename||"download"; ui.jobTitle.textContent=a.type==="webpage"?"Fastest download link found":"Source resolved";
    ui.engineName.textContent=a.engine||"aria2"; ui.engineDescription.textContent=a.type==="webpage"?"Ztorrent scanned the page, probed likely download targets and selected the strongest sampled direct source automatically.":"The backend owns the transfer; the browser only controls and receives the finished file.";
    ui.integrityName.textContent=a.etag?"ETag locked":a.type==="magnet"?"Torrent piece hashes":"Source guarded";
    if(a.size){ui.remaining.textContent=prettyBytes(a.size);ui.sizeHint.textContent=`${prettyBytes(a.size)} total`;}
    if(a.sample_bps){ui.sourceSpeed.textContent=prettySpeed(a.sample_bps);ui.sourceSpeedHint.textContent="Pre-download source sample";}
    diag("Source type",typeLabel,"ok"); if(a.size)diag("File size",prettyBytes(a.size),"ok");
    if(a.range_supported)diag("HTTP byte ranges","SUPPORTED — parallel fetching enabled","ok"); else if(a.type==="http"||a.type==="webpage")diag("HTTP byte ranges","Not advertised","warn");
    const p=a.profile||backendHealth?.profile; if(p){diag("HTTP connections",`${p.http_connections} per server`,"ok");diag("aria2 split",`${p.split} pieces / ${p.min_split_size} minimum`,"ok");diag("Torrent peer ceiling",p.bt_max_peers,"ok");}
    if(Array.isArray(a.candidates)){diag("Download links found",String(a.candidates.length),a.candidates.length?"ok":"warn");a.candidates.slice(0,4).forEach((c,i)=>diag(`#${i+1} ${c.filename||"candidate"}`,`${c.sample_bps?prettySpeed(c.sample_bps):"unmeasured"}${c.range_supported?" • ranges":""}`,i===0?"ok":"warn"));}
    if(a.note)diag("Analyzer",a.note,"warn");
  }
  async function createBackendJob(source){ const r=await fetch(`${API}/v1/jobs`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({source})}); const b=await r.json().catch(()=>({})); if(!r.ok)throw new Error(b.error||`Could not start job (${r.status})`); currentJob=b; ui.jobTitle.textContent="Accelerating at backend maximum"; ui.cancel.hidden=false; ui.pause.hidden=false; state("Downloading"); await pollBackendJob(); pollTimer=setInterval(pollBackendJob,POLL_MS); }
  async function pollBackendJob(){
    if(!currentJob?.id)return;
    try{
      const r=await fetch(`${API}/v1/jobs/${encodeURIComponent(currentJob.id)}`,{cache:"no-store"}); const j=await r.json(); if(!r.ok)throw new Error(j.error||"Status request failed"); currentJob=j;
      const total=Number(j.total_bytes||0),done=Number(j.completed_bytes||0); setProgress(total>0?done/total*100:0); ui.filename.textContent=j.filename||ui.filename.textContent; ui.sourceSpeed.textContent=prettySpeed(j.download_speed); ui.sourceSpeedHint.textContent=j.status==="active"?"Live source → aria2 throughput":"Current engine state";
      ui.connections.textContent=String(j.connections??"—"); ui.connectionsHint.textContent=j.is_torrent?`${j.seeders||0} seeders • active peers above`:`Active HTTP connections (max ${j.profile?.http_connections||16})`; ui.remaining.textContent=total?prettyBytes(Math.max(0,total-done)):"—"; ui.sizeHint.textContent=total?`${prettyBytes(done)} of ${prettyBytes(total)}`:"Waiting for metadata";
      if(j.status==="complete"){state("Complete");ui.jobTitle.textContent="Cached and ready";ui.download.hidden=false;ui.pause.hidden=true;ui.resume.hidden=true;ui.cancel.hidden=true;ui.deliverySpeed.textContent="READY";ui.deliverySpeedHint.textContent="Resumable HTTPS from backend cache";ui.download.onclick=()=>startDelivery(j.id,total);clearInterval(pollTimer);pollTimer=null;setProgress(100);} else if(j.status==="paused"){state("Paused","warn");ui.pause.hidden=true;ui.resume.hidden=false;} else if(j.status==="error"||j.status==="removed"){state("Error","bad");ui.jobTitle.textContent="Download stopped";clearInterval(pollTimer);pollTimer=null;diag("Engine",j.error_message||"Download failed","bad");} else {state(j.status||"Downloading");ui.pause.hidden=false;ui.resume.hidden=true;}
    }catch(e){ui.sourceSpeedHint.textContent="Backend status temporarily unavailable";}
  }
  function startDelivery(id,total){ ui.deliverySpeed.textContent="STARTING";ui.deliverySpeedHint.textContent="Your browser is receiving the cached file"; window.location.href=`${API}/v1/jobs/${encodeURIComponent(id)}/file`; setTimeout(()=>{if(total)ui.deliverySpeedHint.textContent="Delivery speed is controlled by backend → device network path";},1200); }
  async function jobAction(action){if(!currentJob?.id)return;const r=await fetch(`${API}/v1/jobs/${encodeURIComponent(currentJob.id)}/${action}`,{method:"POST"});if(!r.ok){const b=await r.json().catch(()=>({}));throw new Error(b.error||`${action} failed`);}await pollBackendJob();}
  async function submit(source){ resetJobUi();showWorkspace();if(!await checkBackend(true))return;try{const analysis=await backendAnalyze(source);renderAnalysis(analysis);const downloadSource=analysis.download_source||source;if(analysis.type==="webpage"&&!analysis.download_source){state("No direct file","warn");ui.jobTitle.textContent="No downloadable target verified";return;}if(downloadSource!==source)diag("Selected source","Fastest verified page candidate","ok");await createBackendJob(downloadSource);}catch(e){state("Error","bad");ui.jobTitle.textContent="Could not start";ui.filename.textContent="Check the source and try again";diag("Error",e.message||"Unknown error","bad");}}

  ui.form.addEventListener("submit",e=>{e.preventDefault();const source=ui.input.value.trim();if(!source)return toast("Paste a URL, webpage or magnet first.");submit(source);});
  ui.paste.addEventListener("click",async()=>{try{ui.input.value=await navigator.clipboard.readText();ui.input.dispatchEvent(new Event("input"));}catch{toast("Clipboard access was blocked. Paste manually.");}});
  ui.clear.addEventListener("click",()=>{ui.input.value="";ui.workspace.hidden=true;clearInterval(pollTimer);currentJob=null;});
  ui.input.addEventListener("input",()=>{ui.input.style.height="auto";ui.input.style.height=`${Math.min(ui.input.scrollHeight,132)}px`;});
  ui.pause.addEventListener("click",()=>jobAction("pause").catch(e=>toast(e.message))); ui.resume.addEventListener("click",()=>jobAction("resume").catch(e=>toast(e.message))); ui.cancel.addEventListener("click",()=>jobAction("cancel").catch(e=>toast(e.message)));
  window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installPrompt=e;ui.install.hidden=false;}); ui.install.addEventListener("click",async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;ui.install.hidden=true;});
  if("serviceWorker" in navigator)navigator.serviceWorker.register("./sw.js").catch(()=>{}); checkBackend(false);
})();
