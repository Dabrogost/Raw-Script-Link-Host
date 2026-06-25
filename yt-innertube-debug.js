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
  const probes = [];
  const rawByRow = new WeakMap();

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

    if (typeof value === "string") return encoder.encode(value).buffer;
    if (value instanceof URLSearchParams) return encoder.encode(value.toString()).buffer;
    if (value instanceof ArrayBuffer) return value;

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

  async function gzipString(text) {
    if (typeof CompressionStream !== "function") {
      throw new Error("CompressionStream unavailable");
    }

    const stream = new Blob([encoder.encode(text)]).stream().pipeThrough(new CompressionStream("gzip"));
    return await new Response(stream).arrayBuffer();
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

  function cloneJson(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function summarizeRequestJson(json) {
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

  function summarizePlayerResponse(json) {
    const status = json?.playabilityStatus || {};
    const streamingData = json?.streamingData || {};
    const formats = Array.isArray(streamingData.formats) ? streamingData.formats : [];
    const adaptiveFormats = Array.isArray(streamingData.adaptiveFormats) ? streamingData.adaptiveFormats : [];
    const allFormats = formats.concat(adaptiveFormats);

    const urls = allFormats
      .map(f => f.url || f.signatureCipher || f.cipher || "")
      .filter(Boolean);

    const hasServerAbr = !!streamingData.serverAbrStreamingUrl;
    const hasSabr =
      hasServerAbr ||
      urls.some(u => /(?:[?&]|%26)sabr(?:=|%3D)1/i.test(String(u)));

    const heights = allFormats
      .map(f => Number(f.height || 0))
      .filter(Boolean);

    return {
      status: status.status || "",
      reason: status.reason || "",
      playableInEmbed: json?.playabilityStatus?.playableInEmbed ?? null,
      formats: formats.length,
      adaptiveFormats: adaptiveFormats.length,
      hasStreamingData: !!json?.streamingData,
      hasServerAbr,
      hasSabr,
      hasDashManifestUrl: !!streamingData.dashManifestUrl,
      hasHlsManifestUrl: !!streamingData.hlsManifestUrl,
      hasAudio: allFormats.some(f => String(f.mimeType || "").includes("audio")),
      hasVideo: allFormats.some(f => String(f.mimeType || "").includes("video")),
      maxHeight: heights.length ? Math.max(...heights) : 0,
      itags: allFormats.map(f => f.itag).filter(Boolean).slice(0, 40),
      expiresInSeconds: streamingData.expiresInSeconds || "",
      adPlacements: Array.isArray(json?.adPlacements) ? json.adPlacements.length : 0,
      playerAds: Array.isArray(json?.playerAds) ? json.playerAds.length : 0,
      hasAdBreakHeartbeatParams: !!json?.adBreakHeartbeatParams,
      topKeys: json ? Object.keys(json).slice(0, 60) : [],
    };
  }

  function rawHeadersObject(headersLike) {
    const out = {};

    try {
      const headers = new Headers(headersLike || undefined);

      for (const [key, value] of headers.entries()) {
        out[key] = value;
      }
    } catch {}

    return out;
  }

  function redactedHeaders(headersLike) {
    const out = {};
    const raw = rawHeadersObject(headersLike);

    for (const [key, value] of Object.entries(raw)) {
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

    return out;
  }

  function redactedXHRHeader(name, value) {
    const lower = String(name || "").toLowerCase();

    if (lower === "authorization" || lower === "cookie") return "[present]";
    if (lower === "x-goog-visitor-id") return value ? `[present length=${String(value).length}]` : "";

    return String(value || "");
  }

  async function readFetchMeta(input, init) {
    let url = "";
    let method = "GET";
    let body = null;
    let rawHeaders = {};
    let safeHeaders = {};

    try {
      if (input instanceof Request) {
        url = input.url;
        method = String(init?.method || input.method || "GET");

        rawHeaders = rawHeadersObject(init?.headers || input.headers);
        safeHeaders = redactedHeaders(init?.headers || input.headers);

        if (init && "body" in init) body = init.body;
        else body = input;
      } else {
        url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || "");
        method = String(init?.method || input?.method || "GET");

        rawHeaders = rawHeadersObject(init?.headers || input?.headers);
        safeHeaders = redactedHeaders(init?.headers || input?.headers);

        if (init && "body" in init) body = init.body;
        else if (input?.body) body = input;
      }
    } catch {}

    const type = bodyType(body);
    const text = await bodyToText(body);
    const json = safeJson(text);

    return {
      url,
      method,
      rawHeaders,
      safeHeaders,
      bodyType: type,
      bodyText: text,
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
      bodySummary: summarizeRequestJson(bodyJson),
      body: bodyJson,
    };
  }

  function makeReplayHeaders(row, bodyJson, { gzip = true, versionOverride = null } = {}) {
    const raw = rawByRow.get(row) || {};
    const originalHeaders = raw.rawHeaders || {};
    const headers = new Headers();

    for (const [key, value] of Object.entries(originalHeaders)) {
      const lower = key.toLowerCase();

      if (
        lower === "host" ||
        lower === "cookie" ||
        lower === "content-length" ||
        lower === "accept-encoding" ||
        lower.startsWith("sec-")
      ) {
        continue;
      }

      if (lower === "content-encoding") continue;

      headers.set(key, value);
    }

    headers.set("content-type", "application/json");

    if (gzip) {
      headers.set("content-encoding", "gzip");
    } else {
      headers.delete("content-encoding");
    }

    const client = bodyJson?.context?.client || {};

    if (client.clientName === "WEB") {
      headers.set("x-youtube-client-name", "1");
    }

    if (versionOverride) {
      headers.set("x-youtube-client-version", versionOverride);
    } else if (client.clientVersion) {
      headers.set("x-youtube-client-version", client.clientVersion);
    }

    if (client.visitorData && !headers.has("x-goog-visitor-id")) {
      headers.set("x-goog-visitor-id", client.visitorData);
    }

    if (!headers.has("x-origin")) {
      headers.set("x-origin", location.origin);
    }

    return headers;
  }

  async function sendPlayerProbe(name, row, bodyJson, options = {}) {
    const gzip = options.gzip !== false;
    const versionOverride = options.versionOverride || null;

    const bodyText = JSON.stringify(bodyJson);
    const body = gzip ? await gzipString(bodyText) : bodyText;

    const headers = makeReplayHeaders(row, bodyJson, { gzip, versionOverride });

    const started = performance.now();

    const result = {
      time: new Date().toLocaleTimeString(),
      name,
      request: {
        videoId: bodyJson?.videoId || "",
        clientName: bodyJson?.context?.client?.clientName || "",
        clientVersion: bodyJson?.context?.client?.clientVersion || "",
        gzip,
        bodyLength: bodyText.length,
      },
      ok: false,
      httpStatus: 0,
      durationMs: 0,
      summary: null,
      error: "",
    };

    try {
      const resp = await nativeFetch(row.url, {
        method: "POST",
        headers,
        body,
        credentials: "include",
        mode: "same-origin",
        cache: "no-store",
        referrer: location.href,
        referrerPolicy: "strict-origin-when-cross-origin",
      });

      result.httpStatus = resp.status;
      result.ok = resp.ok;

      const text = await resp.text();
      const json = safeJson(text);

      result.durationMs = Math.round(performance.now() - started);
      result.summary = summarizePlayerResponse(json);
      result.responseTopKeys = json ? Object.keys(json).slice(0, 60) : [];
      result.responseTextPreview = json ? "" : text.slice(0, 500);
    } catch (err) {
      result.durationMs = Math.round(performance.now() - started);
      result.error = `${err?.name || "Error"}: ${err?.message || String(err)}`;
    }

    probes.push(result);
    log("probe", result);
    return result;
  }

  XMLHttpRequest.prototype.open = function ytDebugOpen(method, url) {
    try {
      this.__ytDebug = {
        type: "xhr",
        method: String(method || "GET"),
        url: String(url || ""),
        rawHeaders: {},
        safeHeaders: {},
      };
    } catch {}

    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function ytDebugSetRequestHeader(name, value) {
    try {
      if (this.__ytDebug) {
        this.__ytDebug.rawHeaders[String(name || "")] = String(value || "");

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
          this.__ytDebug.safeHeaders[name] = redactedXHRHeader(name, value);
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
            headers: meta.safeHeaders,
            bodyType: currentBodyType,
            bodyText: text,
            bodyJson: json,
          });

          rawByRow.set(row, {
            rawHeaders: meta.rawHeaders,
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
          headers: meta.safeHeaders,
          bodyType: meta.bodyType,
          bodyText: meta.bodyText,
          bodyJson: meta.bodyJson,
        });

        rawByRow.set(row, {
          rawHeaders: meta.rawHeaders,
          bodyText: meta.bodyText,
          bodyJson: meta.bodyJson,
        });

        rows.push(row);
        log(row);
      }).catch(() => {});
    } catch {}

    return nativeFetch.apply(this, arguments);
  };

  g.__YT_INNERTUBE_DEBUG__ = {
    rows,
    probes,

    all() {
      return rows;
    },

    playerRows() {
      return rows.filter(r => isPlayerUrl(r.url) && r.body);
    },

    latest() {
      return rows[rows.length - 1] || null;
    },

    latestPlayer() {
      const list = this.playerRows();
      return list[list.length - 1] || null;
    },

    latestPlayerBody() {
      return this.latestPlayer()?.body || null;
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

    async probeControlGzip() {
      const row = this.latestPlayer();
      if (!row) throw new Error("No captured /youtubei/v1/player row with decoded body");
      const body = cloneJson(row.body);
      return await sendPlayerProbe("CONTROL_EXACT_GZIP", row, body, { gzip: true });
    },

    async probeControlJson() {
      const row = this.latestPlayer();
      if (!row) throw new Error("No captured /youtubei/v1/player row with decoded body");
      const body = cloneJson(row.body);
      return await sendPlayerProbe("CONTROL_EXACT_JSON", row, body, { gzip: false });
    },

    async probeWebOldGzip() {
      const row = this.latestPlayer();
      if (!row) throw new Error("No captured /youtubei/v1/player row with decoded body");

      const body = cloneJson(row.body);
      body.context.client.clientName = "WEB";
      body.context.client.clientVersion = "1.20160315";

      return await sendPlayerProbe("WEB_OLD_VERSION_GZIP", row, body, {
        gzip: true,
        versionOverride: "1.20160315",
      });
    },

    async probeWebOldJson() {
      const row = this.latestPlayer();
      if (!row) throw new Error("No captured /youtubei/v1/player row with decoded body");

      const body = cloneJson(row.body);
      body.context.client.clientName = "WEB";
      body.context.client.clientVersion = "1.20160315";

      return await sendPlayerProbe("WEB_OLD_VERSION_JSON", row, body, {
        gzip: false,
        versionOverride: "1.20160315",
      });
    },

    async probeSequenceLight() {
      const out = [];
      out.push(await this.probeControlGzip());

      if (!out[0].ok || out[0].summary?.status !== "OK") {
        out.push(await this.probeControlJson());
        return out;
      }

      out.push(await this.probeWebOldGzip());
      return out;
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

    copyProbes() {
      copy(JSON.stringify(probes, null, 2));
      console.log(`[yt-i-debug] copied ${probes.length} probe result(s)`);
    },

    clear() {
      rows.length = 0;
      probes.length = 0;
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

  console.log("[yt-i-debug] installed replay version. Capture a video, then run __YT_INNERTUBE_DEBUG__.probeControlGzip()");
})();
