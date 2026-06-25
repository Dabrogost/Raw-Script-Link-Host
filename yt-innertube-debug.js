yt-innertube-debug.js text/javascript
(() => {
  const g = globalThis;

  if (g.__YT_INNERTUBE_DEBUG__?.stop) {
    g.__YT_INNERTUBE_DEBUG__.stop();
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeFetch = g.fetch;

  const rows = [];

  function shouldLog(url) {
    return String(url || "").includes("/youtubei/");
  }

  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function summarizeBody(body) {
    const json = typeof body === "string" ? safeJson(body) : null;

    return {
      videoId: json?.videoId || "",
      clientName: json?.context?.client?.clientName || "",
      clientVersion: json?.context?.client?.clientVersion || "",
      visitorData: !!json?.context?.client?.visitorData,
      hasPlaybackContext: !!json?.playbackContext,
      hasServiceIntegrity: !!json?.serviceIntegrityDimensions,
      topKeys: json ? Object.keys(json).slice(0, 20) : [],
    };
  }

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__ytDebug = {
      type: "xhr",
      method: String(method || "GET"),
      url: String(url || ""),
      body: null,
    };

    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    try {
      const meta = this.__ytDebug;

      if (meta && shouldLog(meta.url)) {
        meta.body = body;

        const row = {
          time: new Date().toLocaleTimeString(),
          type: "xhr",
          method: meta.method,
          url: meta.url,
          bodySummary: summarizeBody(body),
        };

        rows.push(row);
        console.log("%c[yt-i-debug]", "font-weight:bold;color:#c70", row);
      }
    } catch {}

    return nativeSend.apply(this, arguments);
  };

  g.fetch = function(input, init) {
    try {
      const url = typeof input === "string" ? input : input?.url || "";

      if (shouldLog(url)) {
        const body = init?.body || "";

        const row = {
          time: new Date().toLocaleTimeString(),
          type: "fetch",
          method: init?.method || "GET",
          url,
          bodySummary: summarizeBody(body),
        };

        rows.push(row);
        console.log("%c[yt-i-debug]", "font-weight:bold;color:#c70", row);
      }
    } catch {}

    return nativeFetch.apply(this, arguments);
  };

  g.__YT_INNERTUBE_DEBUG__ = {
    rows,
    copy() {
      copy(JSON.stringify(rows, null, 2));
    },
    stop() {
      XMLHttpRequest.prototype.open = nativeOpen;
      XMLHttpRequest.prototype.send = nativeSend;
      g.fetch = nativeFetch;
      console.log("[yt-i-debug] stopped");
    },
  };

  console.log("[yt-i-debug] installed. Click a fresh video, then run __YT_INNERTUBE_DEBUG__.copy()");
})();
