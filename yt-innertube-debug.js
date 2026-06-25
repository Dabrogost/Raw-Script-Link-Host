yt-innertube-debug.js text/javascript
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
  const encoder = new TextEncoder();

  function log(...args) {
    console.log("%c[yt-i-debug]", "font-weight:bold;color:#c70", ...args);
  }

  function shouldLog(url) {
    return String(url || "").includes("/youtubei/");
  }

  function isPlayerUrl(url) {
    return String(url || "").includes("/youtubei/v1/player");
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

  async function toArrayBuffer(value) {
    if (value == null) return null;

    if (typeof value === "string") {
      return encoder.encode(value).buffer;
    }

    if (value instanceof URLSearchParams) {
      return encoder.encode(value.toString()).buffer;
    }

    if (value instanceof ArrayBuffer) {
      return value;
    }

    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }

    if (typeof Blob !== "undefined" && value instanceof Blob) {
      return await value.arrayBuffer();
    }

    if (typeof FormData !== "undefined" && value instanceof FormData) {
      const obj = {};
      for (const [key, val] of value.entries()) {
        obj[key] = typeof val === "string" ? val : `[${bodyType(val)}]`;
      }
      return encoder.encode(JSON.stringify(obj)).buffer;
    }

    if (value instanceof Request) {
      return await value.clone().arrayBuffer();
    }

    if (typeof value.arrayBuffer === "function" && typeof value.clone === "function") {
      return await value.clone().arrayBuffer();
    }

    return null;
  }

  async function decompressGzipBytes(bytes) {
    if (
      typeof DecompressionStream !== "function" ||
      bytes.byteLength < 2 ||
      bytes[0] !== 0x1f ||
      bytes[1] !== 0x8b
    ) {
      return null;
    }

    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  }

  async function bodyToText(value) {
    try {
      if (value == null) return "";

      if (typeof value === "string") return value;

      const buffer = await toArrayBuffer(value);
      if (!buffer) return "";

      const bytes = new Uint8Array(buffer);
      const decompressed = await decompressGzipBytes(bytes);

      if (decompressed != null) return decompressed;

      return decoder.decode(bytes);
    } catch (err) {
      return `[body read failed: ${err?.name || "error"} ${err?.message || ""}]`;
    }
  }

  function safeJson(text) {
    try {
      if (typeof text !== "string" || !text.trim()) return null;

      let cleaned = text.trim();

      if (cleaned.startsWith(")]}'")) {
        const newline = cleaned.indexOf("\n");
        cleaned = newline >= 0 ? cleaned.slice(newline + 1).trim() : cleaned.slice(4).trim();
      }

      return JSON.parse(cleaned);
    } catch {
      return null;
    }
  }

  function summarizeJson(json) {
    const client = json?.context?.client || {};
    const playbackContext = json?.playbackContext || {};
    const serviceIntegrity = json?.serviceIntegrityDimensions || {};

    return {
      videoId: json?.videoId || "",
      clientName: client.clientName || "",
      clientVersion: client.clientVersion || "",
      hl: client.hl || "",
      gl: client.gl || "",
      visitorData: !!client.visitorData,
      hasPlaybackContext: !!json?.playbackContext,
      hasServiceIntegrity: !!json?.serviceIntegrityDimensions,
      hasPoToken: !!serviceIntegrity.poToken,
      hasContentPlaybackContext: !!playbackContext.contentPlaybackContext,
      topKeys: json ? Object.keys(json).slice(0, 50) : [],
      clientKeys: client ? Object.keys(client).slice(0, 80) : [],
      playbackContextKeys: playbackContext ? Object.keys(playbackContext).slice(0, 50) : [],
      serviceIntegrityKeys: serviceIntegrity ? Object.keys(serviceIntegrity).slice(0, 50) : [],
    };
  }

  function redactedHeaders(headersLike) {
    const out = {};

    try {
      const headers = new Headers(headersLike || undefined);

      for (const [key, value] of headers.entries()) {
        const lower = key.toLowerCase();

        if (lower === "authorization" || lower === "cookie") {
          out[key] = "[present]";
        } else if (lower === "x-goog-visitor-id") {
          out[key] = value ? `[present length=${value.length}]` : "";
        } else if (
          lower === "content-type" ||
          lower === "content-encoding" ||
          lower === "x-origin" ||
          lower === "x-goog-authuser" ||
          lower === "x-youtube-client-name" ||
          lower === "x-youtube-client-version"
        ) {
          out[key] = value;
        }
      }
    } catch {}

    return out;
  }

  function redactedXHRHeader(name, value) {
    const lower = String(name || "").toLowerCase();

    if (lower === "authorization" || lower === "cookie") {
      return "[present]";
    }

    if (lower === "x-goog-visitor-id") {
      return value ? `[present length=${String(value).length}]` : "";
    }

    return String(value || "");
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
        headers = redactedHeaders(init?.headers || input.headers);

        if (init && "body" in init) {
          body = init.body;
        } else {
          body = input;
        }
      } else {
        url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || "");
        method = String(init?.method || input?.method || "GET");
        headers = redactedHeaders(init?.headers || input?.headers);

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
      bodyTextPreview: typeof text === "string" ? text.slice(0, 500) : "",
      bodyJson: json,
    };
  }

  function makeRow({ type, method, url, headers, bodyType, bodyText, bodyJson }) {
    return {
      time: new Date().toLocaleTimeString(),
      type,
      method,
      url,
      headers: headers || {},
      bodyType,
      bodyTextLength: typeof bodyText === "string" ? bodyText.length : 0,
      bodyTextPreview: typeof bodyText === "string" ? bodyText.slice(0, 500) : "",
      bodySummary: summarizeJson(bodyJson),
      body: bodyJson,
    };
  }

  XMLHttpRequest.prototype.open = function ytDebugOpen(method, url) {
    try {
      this.__ytDebug = {
        type: "xhr",
        method: String(method || "GET"),
        url: String(url || ""),
        headers: {},
      };
    } catch {}

    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function ytDebugSetRequestHeader(name, value) {
    try {
      if (this.__ytDebug) {
        const lower = String(name || "").toLowerCase();

        if (
          lower === "authorization" ||
          lower === "cookie" ||
          lower === "content-type" ||
          lower === "content-encoding" ||
          lower === "x-origin" ||
          lower === "x-goog-authuser" ||
          lower === "x-goog-visitor-id" ||
          lower === "x-youtube-client-name" ||
          lower === "x-youtube-client-version"
        ) {
          this.__ytDebug.headers[name] = redactedXHRHeader(name, value);
        }
      }
    } catch {}

    return nativeSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function ytDebugSend(body) {
    try {
      const meta = this.__ytDebug;

      if (meta && shouldLog(meta.url)) {
        const currentBodyType = bodyType(body);

        Promise.resolve(bodyToText(body)).then(text => {
          const json = safeJson(text);

          const row = makeRow({
            type: "xhr",
            method: meta.method,
            url: meta.url,
            headers: meta.headers,
            bodyType: currentBodyType,
            bodyText: text,
            bodyJson: json,
          });

          rows.push(row);
          log(row);
        }).catch(() => {});
      }
    } catch {}

    return nativeSend.apply(this, arguments);
  };

  g.fetch = function ytDebugFetch(input, init) {
    try {
      readFetchMeta(input, init).then(meta => {
        if (!shouldLog(meta.url)) return;

        const row = makeRow({
          type: "fetch",
          method: meta.method,
          url: meta.url,
          headers: meta.headers,
          bodyType: meta.bodyType,
          bodyText: meta.bodyTextPreview,
          bodyJson: meta.bodyJson,
        });

        row.bodyTextLength = meta.bodyTextLength;
        row.bodyTextPreview = meta.bodyTextPreview;

        rows.push(row);
        log(row);
      }).catch(() => {});
    } catch {}

    return nativeFetch.apply(this, arguments);
  };

  g.__YT_INNERTUBE_DEBUG__ = {
    rows,

    all() {
      return rows;
    },

    playerRows() {
      return rows.filter(r => isPlayerUrl(r.url));
    },

    latest() {
      return rows[rows.length - 1] || null;
    },

    latestPlayer() {
      const list = this.playerRows();
      return list[list.length - 1] || null;
    },

    playerBodies() {
      return this.playerRows().map(r => r.body).filter(Boolean);
    },

    latestPlayerBody() {
      const row = this.latestPlayer();
      return row?.body || null;
    },

    safeRows() {
      return rows.map(r => ({
        time: r.time,
        type: r.type,
        method: r.method,
        url: r.url,
        headers: r.headers,
        bodyType: r.bodyType,
        bodyTextLength: r.bodyTextLength,
        bodyTextPreview: r.bodyTextPreview,
        bodySummary: r.bodySummary,
      }));
    },

    copy() {
      copy(JSON.stringify(rows, null, 2));
      console.log(`[yt-i-debug] copied ${rows.length} full row(s)`);
    },

    copySafe() {
      const safe = this.safeRows();
      copy(JSON.stringify(safe, null, 2));
      console.log(`[yt-i-debug] copied ${safe.length} safe row(s)`);
    },

    copyPlayers() {
      const list = this.playerRows();
      copy(JSON.stringify(list, null, 2));
      console.log(`[yt-i-debug] copied ${list.length} full player row(s)`);
    },

    copyPlayersSafe() {
      const list = this.playerRows().map(r => ({
        time: r.time,
        type: r.type,
        method: r.method,
        url: r.url,
        headers: r.headers,
        bodyType: r.bodyType,
        bodyTextLength: r.bodyTextLength,
        bodyTextPreview: r.bodyTextPreview,
        bodySummary: r.bodySummary,
      }));

      copy(JSON.stringify(list, null, 2));
      console.log(`[yt-i-debug] copied ${list.length} safe player row(s)`);
    },

    clear() {
      rows.length = 0;
      console.log("[yt-i-debug] cleared");
    },

    stop() {
      XMLHttpRequest.prototype.open = nativeOpen;
      XMLHttpRequest.prototype.send = nativeSend;
      XMLHttpRequest.prototype.setRequestHeader = nativeSetRequestHeader;
      g.fetch = nativeFetch;
      console.log("[yt-i-debug] stopped");
    },
  };

  console.log("[yt-i-debug] installed gzip-aware version. Click a fresh video, then run __YT_INNERTUBE_DEBUG__.copyPlayersSafe()");
})();
