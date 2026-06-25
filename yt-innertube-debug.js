yt-innertube-debug-v3.js text/javascript
(() => {
  const g = globalThis;

  if (g.__YT_INNERTUBE_DEBUG__?.stop) {
    g.__YT_INNERTUBE_DEBUG__.stop();
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const nativeFetch = g.fetch;

  const rows = [];
  const decoder = new TextDecoder("utf-8");

  function shouldLog(url) {
    return String(url || "").includes("/youtubei/");
  }

  function bodyType(value) {
    if (value == null) return "null";
    if (typeof value === "string") return "string";
    if (value instanceof URLSearchParams) return "URLSearchParams";
    if (value instanceof ArrayBuffer) return "ArrayBuffer";
    if (ArrayBuffer.isView(value)) return value.constructor?.name || "ArrayBufferView";
    if (typeof Blob !== "undefined" && value instanceof Blob) return "Blob";
    if (typeof FormData !== "undefined" && value instanceof FormData) return "FormData";
    if (typeof ReadableStream !== "undefined" && value instanceof ReadableStream) return "ReadableStream";
    if (value instanceof Request) return "Request";
    return Object.prototype.toString.call(value);
  }

  async function bodyToText(value) {
    try {
      if (value == null) return "";

      if (typeof value === "string") return value;

      if (value instanceof URLSearchParams) {
        return value.toString();
      }

      if (value instanceof ArrayBuffer) {
        return decoder.decode(value);
      }

      if (ArrayBuffer.isView(value)) {
        return decoder.decode(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      }

      if (typeof Blob !== "undefined" && value instanceof Blob) {
        return await value.text();
      }

      if (typeof FormData !== "undefined" && value instanceof FormData) {
        const obj = {};
        for (const [key, val] of value.entries()) {
          obj[key] = typeof val === "string" ? val : `[${bodyType(val)}]`;
        }
        return JSON.stringify(obj);
      }

      if (value instanceof Request) {
        return await value.clone().text();
      }

      if (typeof value.text === "function" && typeof value.clone === "function") {
        return await value.clone().text();
      }

      return "";
    } catch (err) {
      return `[body read failed: ${err?.name || "error"} ${err?.message || ""}]`;
    }
  }

  function safeJson(text) {
    try {
      if (typeof text !== "string" || !text.trim()) return null;

      let cleaned = text.trim();

      if (cleaned.startsWith(")]}'")) {
        cleaned = cleaned.slice(cleaned.indexOf("\n") + 1).trim();
      }

      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }

  function summarizeJson(json) {
    return {
      videoId: json?.videoId || "",
      clientName: json?.context?.client?.clientName || "",
      clientVersion: json?.context?.client?.clientVersion || "",
      visitorData: !!json?.context?.client?.visitorData,
      hasPlaybackContext: !!json?.playbackContext,
      hasServiceIntegrity: !!json?.serviceIntegrityDimensions,
      hasAttestation: !!json?.serviceIntegrityDimensions?.poToken,
      topKeys: json ? Object.keys(json).slice(0, 40) : [],
      clientKeys: json?.context?.client ? Object.keys(json.context.client).slice(0, 60) : [],
      playbackContextKeys: json?.playbackContext ? Object.keys(json.playbackContext).slice(0, 40) : [],
    };
  }

  function headersToObject(headersLike) {
    const out = {};

    try {
      const headers = new Headers(headersLike || undefined);
      for (const [key, value] of headers.entries()) {
        const lower = key.toLowerCase();
        if (
          lower === "authorization" ||
          lower === "cookie" ||
          lower === "x-origin" ||
          lower === "x-goog-authuser" ||
          lower === "x-goog-visitor-id" ||
          lower === "x-youtube-client-name" ||
          lower === "x-youtube-client-version" ||
          lower === "content-type"
        ) {
          out[key] = lower === "authorization" || lower === "cookie" ? "[present]" : value;
        }
      }
    } catch {}

    return out;
  }

  async function readFetchMeta(input, init) {
    let url = "";
    let method = "GET";
    let body = null;
    let headers = {};

    try {
      if (input instanceof Request) {
        url = input.url;
        method = String(init?.method || input.method || "GET");
        headers = headersToObject(init?.headers || input.headers);

        if (init && "body" in init) {
          body = init.body;
        } else {
          body = input;
        }
      } else {
        url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || "");
        method = String(init?.method || input?.method || "GET");
        headers = headersToObject(init?.headers || input?.headers);

        if (init && "body" in init) {
          body = init.body;
        } else if (input?.body) {
          body = input;
        }
      }
    } catch {}

    const type = bodyType(body);
    const text = await bodyToText(body);
    const json = safeJson(text);

    return {
      url,
      method,
      headers,
      bodyType: type,
      bodyTextLength: typeof text === "string" ? text.length : 0,
      bodyTextPreview: typeof text === "string" ? text.slice(0, 300) : "",
      bodyJson: json,
    };
  }

  XMLHttpRequest.prototype.open = function(method, url) {
    this.__ytDebug = {
      type: "xhr",
      method: String(method || "GET"),
      url: String(url || ""),
      headers: {},
      bodyType: "null",
      bodyText: "",
    };

    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    try {
      if (this.__ytDebug) {
        const lower = String(name || "").toLowerCase();
        if (
          lower === "authorization" ||
          lower === "cookie" ||
          lower === "x-origin" ||
          lower === "x-goog-authuser" ||
          lower === "x-goog-visitor-id" ||
          lower === "x-youtube-client-name" ||
          lower === "x-youtube-client-version" ||
          lower === "content-type"
        ) {
          this.__ytDebug.headers[name] =
            lower === "authorization" || lower === "cookie" ? "[present]" : String(value || "");
        }
      }
    } catch {}

    return nativeSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function(body) {
    try {
      const meta = this.__ytDebug;

      if (meta && shouldLog(meta.url)) {
        Promise.resolve(bodyToText(body)).then(text => {
          const json = safeJson(text);

          const row = {
            time: new Date().toLocaleTimeString(),
            type: "xhr",
            method: meta.method,
            url: meta.url,
            headers: meta.headers,
            bodyType: bodyType(body),
            bodyTextLength: typeof text === "string" ? text.length : 0,
            bodyTextPreview: typeof text === "string" ? text.slice(0, 300) : "",
            bodySummary: summarizeJson(json),
            body: json,
          };

          rows.push(row);
          console.log("%c[yt-i-debug-v3]", "font-weight:bold;color:#c70", row);
        }).catch(() => {});
      }
    } catch {}

    return nativeSend.apply(this, arguments);
  };

  g.fetch = function(input, init) {
    try {
      readFetchMeta(input, init).then(meta => {
        if (!shouldLog(meta.url)) return;

        const row = {
          time: new Date().toLocaleTimeString(),
          type: "fetch",
          method: meta.method,
          url: meta.url,
          headers: meta.headers,
          bodyType: meta.bodyType,
          bodyTextLength: meta.bodyTextLength,
          bodyTextPreview: meta.bodyTextPreview,
          bodySummary: summarizeJson(meta.bodyJson),
          body: meta.bodyJson,
        };

        rows.push(row);
        console.log("%c[yt-i-debug-v3]", "font-weight:bold;color:#c70", row);
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
      console.log(`[yt-i-debug-v3] copied ${rows.length} row(s)`);
    },

    copyPlayers() {
      const list = this.playerRows();
      copy(JSON.stringify(list, null, 2));
      console.log(`[yt-i-debug-v3] copied ${list.length} player row(s)`);
    },

    clear() {
      rows.length = 0;
      console.log("[yt-i-debug-v3] cleared");
    },

    stop() {
      XMLHttpRequest.prototype.open = nativeOpen;
      XMLHttpRequest.prototype.send = nativeSend;
      XMLHttpRequest.prototype.setRequestHeader = nativeSetRequestHeader;
      g.fetch = nativeFetch;
      console.log("[yt-i-debug-v3] stopped");
    },
  };

  console.log("[yt-i-debug-v3] installed. Click a fresh video, then run __YT_INNERTUBE_DEBUG__.copyPlayers()");
})();
