yt-source-swap-test.js text/javascript
(() => {
  const g = globalThis;

  if (g.__YT_SOURCE_SWAP_TEST__?.stop) {
    g.__YT_SOURCE_SWAP_TEST__.stop();
  }

  const nativeFetch = g.fetch;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");

  const events = [];
  const maxEvents = 100;

  const config = {
    enabled: true,
    targetVersion: "1.20160315",
    requireNonSabr: true,
    logVerbose: true,
  };

  const counters = {
    seen: 0,
    ignored: 0,
    attempts: 0,
    success: 0,
    fallback: 0,
    errors: 0,
    lastVideoId: "",
    lastReason: "",
  };

  function log(...args) {
    if (config.logVerbose) {
      console.log("%c[yt-source-swap]", "font-weight:bold;color:#2b7", ...args);
    }
  }

  function warn(...args) {
    console.warn("%c[yt-source-swap]", "font-weight:bold;color:#d80", ...args);
  }

  function remember(event) {
    events.push({
      time: new Date().toLocaleTimeString(),
      ...event,
    });

    while (events.length > maxEvents) {
      events.shift();
    }
  }

  function isPlayerUrl(url) {
    return String(url || "").includes("/youtubei/v1/player");
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

  async function gzipString(text) {
    if (typeof CompressionStream !== "function") {
      return null;
    }

    const stream = new Blob([encoder.encode(text)]).stream().pipeThrough(new CompressionStream("gzip"));
    return await new Response(stream).arrayBuffer();
  }

  async function bodyToText(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;

    const buffer = await toArrayBuffer(value);
    if (!buffer) return "";

    const bytes = new Uint8Array(buffer);
    const decompressed = await decompressGzipBytes(bytes);

    if (decompressed != null) return decompressed;

    return decoder.decode(bytes);
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

  function makeReplayHeaders(originalHeaders, bodyJson, { gzip, versionOverride }) {
    const headers = new Headers();

    for (const [key, value] of Object.entries(originalHeaders || {})) {
      const lower = key.toLowerCase();

      if (
        lower === "host" ||
        lower === "cookie" ||
        lower === "content-length" ||
        lower === "accept-encoding" ||
        lower === "referer" ||
        lower === "origin" ||
        lower === "connection" ||
        lower === "user-agent" ||
        lower.startsWith("sec-")
      ) {
        continue;
      }

      if (lower === "content-encoding") continue;

      try {
        headers.set(key, value);
      } catch {}
    }

    headers.set("content-type", "application/json");

    if (gzip) {
      headers.set("content-encoding", "gzip");
    } else {
      headers.delete("content-encoding");
    }

    const client = bodyJson?.context?.client || {};

    headers.set("x-youtube-client-name", "1");
    headers.set("x-youtube-client-version", versionOverride || client.clientVersion || config.targetVersion);

    if (client.visitorData && !headers.has("x-goog-visitor-id")) {
      headers.set("x-goog-visitor-id", client.visitorData);
    }

    if (!headers.has("x-origin")) {
      headers.set("x-origin", location.origin);
    }

    return headers;
  }

  async function readFetchMeta(input, init) {
    let url = "";
    let method = "GET";
    let body = null;
    let rawHeaders = {};

    if (input instanceof Request) {
      url = input.url;
      method = String(init?.method || input.method || "GET");
      rawHeaders = rawHeadersObject(init?.headers || input.headers);

      if (init && "body" in init) {
        body = init.body;
      } else {
        body = input;
      }
    } else {
      url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || "");
      method = String(init?.method || input?.method || "GET");
      rawHeaders = rawHeadersObject(init?.headers || input?.headers);

      if (init && "body" in init) {
        body = init.body;
      } else if (input?.body) {
        body = input;
      }
    }

    const text = await bodyToText(body);
    const json = safeJson(text);

    return {
      url,
      method,
      rawHeaders,
      bodyType: bodyType(body),
      bodyTextLength: text.length,
      bodyJson: json,
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
      playableInEmbed: status.playableInEmbed ?? null,
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

  function makeReplacementResponse(json) {
    return new Response(JSON.stringify(json), {
      status: 200,
      statusText: "OK",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-chroma-source-swap": "web-old-version",
      },
    });
  }

  async function fetchOldWebPlayer(meta) {
    const originalBody = meta.bodyJson;
    const swappedBody = cloneJson(originalBody);

    if (!swappedBody?.context?.client) {
      throw new Error("No context.client in player body");
    }

    swappedBody.context.client.clientName = "WEB";
    swappedBody.context.client.clientVersion = config.targetVersion;

    const bodyText = JSON.stringify(swappedBody);

    let gzip = true;
    let body = await gzipString(bodyText);

    if (!body) {
      gzip = false;
      body = bodyText;
    }

    const headers = makeReplayHeaders(meta.rawHeaders, swappedBody, {
      gzip,
      versionOverride: config.targetVersion,
    });

    const started = performance.now();

    const resp = await nativeFetch(meta.url, {
      method: "POST",
      headers,
      body,
      credentials: "include",
      mode: "same-origin",
      cache: "no-store",
      referrer: location.href,
      referrerPolicy: "strict-origin-when-cross-origin",
    });

    const text = await resp.text();
    const json = safeJson(text);
    const summary = summarizePlayerResponse(json);

    return {
      httpStatus: resp.status,
      ok: resp.ok,
      durationMs: Math.round(performance.now() - started),
      gzip,
      json,
      summary,
      textPreview: json ? "" : text.slice(0, 500),
    };
  }

  function shouldAttemptSwap(meta) {
    if (!config.enabled) return [false, "disabled"];
    if (!isPlayerUrl(meta.url)) return [false, "not-player"];
    if (String(meta.method).toUpperCase() !== "POST") return [false, "not-post"];
    if (!meta.bodyJson) return [false, "no-json-body"];

    const client = meta.bodyJson?.context?.client;

    if (!client) return [false, "no-client"];
    if (client.clientName !== "WEB") return [false, `client-${client.clientName || "missing"}`];
    if (client.clientVersion === config.targetVersion) return [false, "already-target-version"];
    if (!meta.bodyJson.videoId) return [false, "no-video-id"];

    return [true, "ok"];
  }

  async function sourceSwapFetch(input, init) {
    let meta = null;

    try {
      meta = await readFetchMeta(input, init);
      counters.seen++;

      const [shouldAttempt, reason] = shouldAttemptSwap(meta);

      if (!shouldAttempt) {
        counters.ignored++;
        counters.lastReason = reason;
        return nativeFetch.apply(this, arguments);
      }

      counters.attempts++;
      counters.lastVideoId = meta.bodyJson.videoId;
      counters.lastReason = "attempting";

      remember({
        event: "attempt",
        videoId: meta.bodyJson.videoId,
        originalClientName: meta.bodyJson.context.client.clientName,
        originalClientVersion: meta.bodyJson.context.client.clientVersion,
        targetVersion: config.targetVersion,
        bodyType: meta.bodyType,
        bodyTextLength: meta.bodyTextLength,
      });

      const result = await fetchOldWebPlayer(meta);
      const validReplacement =
        result.ok &&
        result.summary?.status === "OK" &&
        result.summary?.hasStreamingData &&
        (!config.requireNonSabr || !result.summary?.hasSabr);

      remember({
        event: validReplacement ? "replace" : "fallback",
        videoId: meta.bodyJson.videoId,
        httpStatus: result.httpStatus,
        durationMs: result.durationMs,
        gzip: result.gzip,
        summary: result.summary,
        textPreview: result.textPreview,
      });

      if (validReplacement) {
        counters.success++;
        counters.lastReason = "replaced";

        log("replacing /player response", {
          videoId: meta.bodyJson.videoId,
          durationMs: result.durationMs,
          summary: result.summary,
        });

        return makeReplacementResponse(result.json);
      }

      counters.fallback++;
      counters.lastReason = "replacement-invalid";

      warn("replacement invalid; falling back to original", {
        videoId: meta.bodyJson.videoId,
        summary: result.summary,
        textPreview: result.textPreview,
      });

      return nativeFetch.apply(this, arguments);
    } catch (err) {
      counters.errors++;
      counters.fallback++;
      counters.lastReason = `${err?.name || "Error"}: ${err?.message || String(err)}`;

      remember({
        event: "error",
        videoId: meta?.bodyJson?.videoId || "",
        error: counters.lastReason,
      });

      warn("failed open; falling back to original", err);

      return nativeFetch.apply(this, arguments);
    }
  }

  g.fetch = sourceSwapFetch;

  g.__YT_SOURCE_SWAP_TEST__ = {
    config,
    counters,
    events,

    stats() {
      return {
        config: { ...config },
        counters: { ...counters },
        lastEvent: events[events.length - 1] || null,
      };
    },

    enable() {
      config.enabled = true;
      console.log("[yt-source-swap] enabled");
    },

    disable() {
      config.enabled = false;
      console.log("[yt-source-swap] disabled");
    },

    clear() {
      events.length = 0;

      for (const key of Object.keys(counters)) {
        if (typeof counters[key] === "number") counters[key] = 0;
        else counters[key] = "";
      }

      console.log("[yt-source-swap] cleared");
    },

    copyEvents() {
      copy(JSON.stringify(events, null, 2));
      console.log(`[yt-source-swap] copied ${events.length} event(s)`);
    },

    copyStats() {
      copy(JSON.stringify(this.stats(), null, 2));
      console.log("[yt-source-swap] copied stats");
    },

    stop() {
      g.fetch = nativeFetch;
      console.log("[yt-source-swap] stopped");
    },
  };

  console.log("[yt-source-swap] installed. Use __YT_SOURCE_SWAP_TEST__.stats()");
})();
