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
      if (typeof text !== "string" || !text.trim()) return null;
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function summarizeBodyFromJson(json) {
    return {
      videoId: json?.videoId || "",
      clientName: json?.context?.client?.clientName || "",
      clientVersion: json?.context?.client?.clientVersion || "",
      visitorData: !!json?.context?.client?.visitorData,
      hasPlaybackContext: !!json?.playbackContext,
      hasServiceIntegrity: !!json?.serviceIntegrityDimensions,
      hasAttestation: !!json?.serviceIntegrityDimensions?.poToken,
      topKeys: json ? Object.keys(json).slice(0, 30) : [],
      clientKeys: json?.context?.client ? Object.keys(json.context.client).slice(0, 40) : [],
      playbackContextKeys: json?.playbackContext ? Object.keys(json.playbackContext).slice(0, 30) : [],
    };
  }

  function summarizeBodyText(text) {
    return summarizeBodyFromJson(safeJson(text));
  }

  async function readFetchMeta(input, init) {
    let url = "";
    let method = "GET";
    let bodyText = "";

    try {
      if (typeof input === "string" || input instanceof URL) {
        url = String(input);
        method = String(init?.method || "GET");
        if (typeof init?.body === "string") {
          bodyText = init.body;
        } else if (init?.body instanceof URLSearchParams) {
          bodyText = init.body.toString();
        }
      } else if (input instanceof Request) {
        url = input.url;
        method = String(init?.method || input.method || "GET");

        if (typeof init?.body === "string") {
          bodyText = init.body;
        } else if (init?.body instanceof URLSearchParams) {
          bodyText = init.body.toString();
        } else {
          try {
            bodyText = await input.clone().text();
          } catch {
            bodyText = "";
          }
        }
      } else {
        url = input?.url || "";
        method = String(init?.method || input?.method || "GET");
        if (typeof init?.body === "string") bodyText = init.body;
      }
    } catch {}

    return {
      url,
      method,
      bodyText,
      bodyJson: safeJson(bodyText),
    };
  }

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__ytDebug = {
      type: "xhr",
      method: String(method || "GET"),
      url: String(url || ""),
      bodyText: "",
    };

    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    try {
      const meta = this.__ytDebug;

      if (meta && shouldLog(meta.url)) {
        meta.bodyText = typeof body === "string" ? body : "";

        const bodyJson = safeJson(meta.bodyText);

        const row = {
          time: new Date().toLocaleTimeString(),
          type: "xhr",
          method: meta.method,
          url: meta.url,
          bodySummary: summarizeBodyFromJson(bodyJson),
          body: bodyJson,
        };

        rows.push(row);
        console.log("%c[yt-i-debug]", "font-weight:bold;color:#c70", row);
      }
    } catch {}

    return nativeSend.apply(this, arguments);
  };

  g.fetch = function(input, init) {
    try {
      const metaPromise = readFetchMeta(input, init);

      metaPromise.then(meta => {
        if (!shouldLog(meta.url)) return;

        const row = {
          time: new Date().toLocaleTimeString(),
          type: "fetch",
          method: meta.method,
          url: meta.url,
          bodySummary: summarizeBodyFromJson(meta.bodyJson),
          body: meta.bodyJson,
        };

        rows.push(row);
        console.log("%c[yt-i-debug]", "font-weight:bold;color:#c70", row);
      }).catch(() => {});
    } catch {}

    return nativeFetch.apply(this, arguments);
  };

  g.__YT_INNERTUBE_DEBUG__ = {
    rows,

    playerRows() {
      return rows.filter(r => String(r.url).includes("/youtubei/v1/player"));
    },

    latestPlayer() {
      const list = this.playerRows();
      return list[list.length - 1] || null;
    },

    copy() {
      copy(JSON.stringify(rows, null, 2));
      console.log(`[yt-i-debug] copied ${rows.length} row(s)`);
    },

    copyPlayers() {
      const list = this.playerRows();
      copy(JSON.stringify(list, null, 2));
      console.log(`[yt-i-debug] copied ${list.length} player row(s)`);
    },

    clear() {
      rows.length = 0;
      console.log("[yt-i-debug] cleared");
    },

    stop() {
      XMLHttpRequest.prototype.open = nativeOpen;
      XMLHttpRequest.prototype.send = nativeSend;
      g.fetch = nativeFetch;
      console.log("[yt-i-debug] stopped");
    },
  };

  console.log("[yt-i-debug] installed v2. Click a fresh video, then run __YT_INNERTUBE_DEBUG__.copyPlayers()");
})();
