(() => {
  "use strict";

  const nativeFetch = window.fetch.bind(window);

  window.fetch = async function ztorrentFetch(input, init) {
    const response = await nativeFetch(input, init);

    try {
      const url = typeof input === "string" ? input : input?.url || "";
      if (!/\/v1\/analyze(?:\?|$)/.test(url) || !response.ok) return response;

      const data = await response.clone().json();
      const emptyWebpage = data?.type === "webpage" && Array.isArray(data.candidates) && data.candidates.length === 0;
      if (!emptyWebpage) return response;

      // The backend may still carry the probed page URL in download_source.
      // A normal HTML page is not itself a verified downloadable file. Remove
      // that fallback so app.js stops cleanly instead of launching aria2 on
      // the webpage and presenting a fake 0 B/s download.
      delete data.download_source;
      data.filename = data.filename && data.filename !== "download" ? data.filename : "Webpage";
      data.note = "No verified direct downloadable file was found on this webpage. Ztorrent did not start a download job. Pages that generate media/files through site-specific JavaScript, authentication, or provider APIs need a supported resolver or an authorized direct file URL.";

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
})();
