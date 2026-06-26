yt-source-swap-test.js text/javascript
(() => {
  const g = globalThis;

  if (g.__YT_SOURCE_SWAP_TEST__?.stop) {
    g.__YT_SOURCE_SWAP_TEST__.stop();
  }

  const nativeFetch = g.fetch;
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");

  const events = [];
  const maxEvents = 250;

  const config = {
    enabled: true,
    targetVersion: "1.20160315",
    requireNonSabr: true,
    requireStreamingDataProof: true,
    logVerbose: true,
    logIgnoredYoutubei: true,
    interceptFetch: true,
    interceptXhr: true,
    endpoints: {
      player: true,
      getWatch: true,
      next: true,
    },
  };

  const counters = {
    seen: 0,
    seenFetch: 0,
    seenXhr: 0,
    ignored: 0,
    attempts: 0,
    attemptsFetch: 0,
    attemptsXhr: 0,
    attemptsPlayer: 0,
    attemptsGetWatch: 0,
    attemptsNext: 0,
    success: 0,
    successFetch: 0,
    successXhr: 0,
    successPlayer: 0,
    successGetWatch: 0,
    successNext: 0,
    fallback: 0,
    errors: 0,
    syntheticXhr: 0,
    lastVideoId: "",
    lastReason: "",
    lastTransport: "",
    lastEndpoint: "",
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

  function endpointForUrl(url) {
    const s = String(url || "");

    if (s.includes("/youtubei/v1/player")) return "player";
    if (s.includes("/youtubei/v1/get_watch")) return "get_watch";
    if (s.includes("/youtubei/v1/next")) return "next";

    return "";
  }

  function isUsefulYoutubeiUrl(url) {
    return !!endpointForUrl(url);
  }

  function isEndpointEnabled(endpoint) {
    if (endpoint === "player") return !!config.endpoints.player;
    if (endpoint === "get_watch") return !!config.endpoints.getWatch;
    if (endpoint === "next") return !!config.endpoints.next;
    return false;
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
      transport: "fetch",
      endpoint: endpointForUrl(url),
      url,
      method,
      rawHeaders,
      bodyType: bodyType(body),
      bodyTextLength: text.length,
      bodyJson: json,
    };
  }

  async function readXhrMeta(xhr, body) {
    const meta = xhr.__ytSourceSwap || {};

    const text = await bodyToText(body);
    const json = safeJson(text);

    return {
      transport: "xhr",
      endpoint: endpointForUrl(meta.url || ""),
      url: meta.url || "",
      method: meta.method || "GET",
      rawHeaders: meta.rawHeaders || {},
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
      itags: allFormats.map(f => f.itag).filter(Boolean).slice(0, 50),
      expiresInSeconds: streamingData.expiresInSeconds || "",
      adPlacements: Array.isArray(json?.adPlacements) ? json.adPlacements.length : 0,
      playerAds: Array.isArray(json?.playerAds) ? json.playerAds.length : 0,
      hasAdBreakHeartbeatParams: !!json?.adBreakHeartbeatParams,
      topKeys: json ? Object.keys(json).slice(0, 60) : [],
    };
  }

  function playerSummaryIsUsable(summary) {
    if (!summary) return false;
    if (summary.status !== "OK") return false;
    if (!summary.hasStreamingData) return false;
    if (config.requireNonSabr && summary.hasSabr) return false;
    return true;
  }

  function findPlayerLikeObjects(root) {
    const found = [];
    const seen = new WeakSet();
    let visited = 0;
    const maxVisited = 6000;
    const maxDepth = 12;

    function tryJsonString(value) {
      if (typeof value !== "string") return null;
      const t = value.trim();
      if (!t || t[0] !== "{") return null;
      if (!t.includes("streamingData") && !t.includes("playabilityStatus")) return null;
      return safeJson(t);
    }

    function walk(value, path, depth) {
      if (found.length >= 20) return;
      if (visited++ > maxVisited) return;
      if (depth > maxDepth) return;

      const parsed = tryJsonString(value);
      if (parsed) {
        walk(parsed, `${path}<json>`, depth + 1);
        return;
      }

      if (!value || typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);

      if (value.playabilityStatus && value.streamingData) {
        found.push({
          path: path || "$",
          summary: summarizePlayerResponse(value),
        });
      }

      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          walk(value[i], `${path}[${i}]`, depth + 1);
        }
        return;
      }

      for (const [key, child] of Object.entries(value)) {
        walk(child, path ? `${path}.${key}` : key, depth + 1);
      }
    }

    walk(root, "", 0);
    return found;
  }

  function summarizeEndpointResponse(json) {
    const direct = summarizePlayerResponse(json);
    const nestedPlayers = findPlayerLikeObjects(json);
    const bestNested = nestedPlayers.find(p => playerSummaryIsUsable(p.summary)) || nestedPlayers[0] || null;
    const directUsable = playerSummaryIsUsable(direct);

    return {
      direct,
      directUsable,
      nestedPlayerCount: nestedPlayers.length,
      nestedPlayers: nestedPlayers.slice(0, 8),
      bestNested,
      bestUsable: directUsable || !!nestedPlayers.find(p => playerSummaryIsUsable(p.summary)),
      topKeys: json ? Object.keys(json).slice(0, 80) : [],
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

  function shouldAttemptSwap(meta) {
    if (!config.enabled) return [false, "disabled"];

    const endpoint = endpointForUrl(meta.url);
    if (!endpoint) return [false, "not-target-endpoint"];
    if (!isEndpointEnabled(endpoint)) return [false, `endpoint-disabled-${endpoint}`];
    if (String(meta.method).toUpperCase() !== "POST") return [false, "not-post"];
    if (!meta.bodyJson) return [false, "no-json-body"];

    const client = meta.bodyJson?.context?.client;

    if (!client) return [false, "no-client"];
    if (client.clientName !== "WEB") return [false, `client-${client.clientName || "missing"}`];
    if (client.clientVersion === config.targetVersion) return [false, "already-target-version"];

    if (endpoint === "player" && !meta.bodyJson.videoId) {
      return [false, "no-video-id"];
    }

    return [true, "ok"];
  }

  function rememberSeenYoutubei(meta, reason = "") {
    if (!config.logIgnoredYoutubei) return;
    if (!isUsefulYoutubeiUrl(meta.url)) return;

    remember({
      event: reason ? "ignored-youtubei" : "seen-youtubei",
      transport: meta.transport,
      endpoint: meta.endpoint || endpointForUrl(meta.url),
      reason,
      url: meta.url,
      method: meta.method,
      bodyType: meta.bodyType,
      bodyTextLength: meta.bodyTextLength,
      hasBodyJson: !!meta.bodyJson,
      videoId: meta.bodyJson?.videoId || "",
      clientName: meta.bodyJson?.context?.client?.clientName || "",
      clientVersion: meta.bodyJson?.context?.client?.clientVersion || "",
      hasPlaybackContext: !!meta.bodyJson?.playbackContext,
      hasServiceIntegrity: !!meta.bodyJson?.serviceIntegrityDimensions,
      topKeys: meta.bodyJson ? Object.keys(meta.bodyJson).slice(0, 40) : [],
    });
  }

  async function fetchOldWebEndpoint(meta) {
    const swappedBody = cloneJson(meta.bodyJson);

    if (!swappedBody?.context?.client) {
      throw new Error("No context.client in youtubei body");
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
    const endpointSummary = summarizeEndpointResponse(json);

    return {
      endpoint: meta.endpoint || endpointForUrl(meta.url),
      httpStatus: resp.status,
      ok: resp.ok,
      durationMs: Math.round(performance.now() - started),
      gzip,
      json,
      responseText: json ? JSON.stringify(json) : text,
      summary: endpointSummary.direct,
      endpointSummary,
      textPreview: json ? "" : text.slice(0, 500),
    };
  }

  function validReplacement(result) {
    if (!result.ok) return false;

    if (!config.requireStreamingDataProof) {
      return true;
    }

    return !!result.endpointSummary?.bestUsable;
  }

  function countAttemptEndpoint(endpoint) {
    if (endpoint === "player") counters.attemptsPlayer++;
    if (endpoint === "get_watch") counters.attemptsGetWatch++;
    if (endpoint === "next") counters.attemptsNext++;
  }

  function countSuccessEndpoint(endpoint) {
    if (endpoint === "player") counters.successPlayer++;
    if (endpoint === "get_watch") counters.successGetWatch++;
    if (endpoint === "next") counters.successNext++;
  }

  async function trySwap(meta) {
    const endpoint = meta.endpoint || endpointForUrl(meta.url);

    counters.attempts++;
    counters.lastVideoId = meta.bodyJson?.videoId || "";
    counters.lastReason = "attempting";
    counters.lastTransport = meta.transport;
    counters.lastEndpoint = endpoint;
    countAttemptEndpoint(endpoint);

    if (meta.transport === "fetch") counters.attemptsFetch++;
    if (meta.transport === "xhr") counters.attemptsXhr++;

    remember({
      event: "attempt",
      transport: meta.transport,
      endpoint,
      videoId: meta.bodyJson?.videoId || "",
      originalClientName: meta.bodyJson?.context?.client?.clientName || "",
      originalClientVersion: meta.bodyJson?.context?.client?.clientVersion || "",
      targetVersion: config.targetVersion,
      bodyType: meta.bodyType,
      bodyTextLength: meta.bodyTextLength,
      topKeys: meta.bodyJson ? Object.keys(meta.bodyJson).slice(0, 40) : [],
    });

    const result = await fetchOldWebEndpoint(meta);
    const ok = validReplacement(result);

    remember({
      event: ok ? "replace" : "fallback",
      transport: meta.transport,
      endpoint,
      videoId: meta.bodyJson?.videoId || "",
      httpStatus: result.httpStatus,
      durationMs: result.durationMs,
      gzip: result.gzip,
      summary: result.summary,
      endpointSummary: {
        directUsable: result.endpointSummary?.directUsable || false,
        nestedPlayerCount: result.endpointSummary?.nestedPlayerCount || 0,
        bestUsable: result.endpointSummary?.bestUsable || false,
        bestNested: result.endpointSummary?.bestNested || null,
        topKeys: result.endpointSummary?.topKeys || [],
      },
      textPreview: result.textPreview,
    });

    if (ok) {
      counters.success++;
      counters.lastReason = "replaced";
      countSuccessEndpoint(endpoint);

      if (meta.transport === "fetch") counters.successFetch++;
      if (meta.transport === "xhr") counters.successXhr++;

      log("replacing youtubei response", {
        transport: meta.transport,
        endpoint,
        videoId: meta.bodyJson?.videoId || "",
        durationMs: result.durationMs,
        summary: result.summary,
        endpointSummary: result.endpointSummary,
      });

      return result;
    }

    counters.fallback++;
    counters.lastReason = "replacement-invalid";

    warn("replacement invalid; falling back", {
      transport: meta.transport,
      endpoint,
      videoId: meta.bodyJson?.videoId || "",
      summary: result.summary,
      endpointSummary: result.endpointSummary,
      textPreview: result.textPreview,
    });

    return null;
  }

  async function sourceSwapFetch(input, init) {
    let meta = null;

    if (!config.interceptFetch) {
      return nativeFetch.apply(this, arguments);
    }

    try {
      meta = await readFetchMeta(input, init);

      counters.seen++;
      counters.seenFetch++;
      counters.lastTransport = "fetch";
      counters.lastEndpoint = meta.endpoint || "";

      const [shouldAttempt, reason] = shouldAttemptSwap(meta);

      if (!shouldAttempt) {
        counters.ignored++;
        counters.lastReason = reason;
        rememberSeenYoutubei(meta, reason);
        return nativeFetch.apply(this, arguments);
      }

      const result = await trySwap(meta);

      if (result) {
        return makeReplacementResponse(result.json);
      }

      return nativeFetch.apply(this, arguments);
    } catch (err) {
      counters.errors++;
      counters.fallback++;
      counters.lastReason = `${err?.name || "Error"}: ${err?.message || String(err)}`;

      remember({
        event: "error",
        transport: "fetch",
        endpoint: meta?.endpoint || "",
        videoId: meta?.bodyJson?.videoId || "",
        error: counters.lastReason,
      });

      warn("fetch failed open; falling back", err);

      return nativeFetch.apply(this, arguments);
    }
  }

  function defineXhrValue(xhr, name, getter) {
    try {
      Object.defineProperty(xhr, name, {
        configurable: true,
        enumerable: true,
        get: getter,
      });
    } catch {}
  }

  function fireXhrEvent(xhr, type, loaded = 0) {
    try {
      const ev =
        typeof ProgressEvent === "function"
          ? new ProgressEvent(type, {
              lengthComputable: true,
              loaded,
              total: loaded,
            })
          : new Event(type);

      xhr.dispatchEvent(ev);
    } catch {
      try {
        xhr.dispatchEvent(new Event(type));
      } catch {}
    }
  }

  function finishSyntheticXhr(xhr, result, url) {
    const responseText = result.responseText || JSON.stringify(result.json || {});
    const responseHeaders = [
      "content-type: application/json; charset=utf-8",
      "x-chroma-source-swap: web-old-version",
    ].join("\r\n");

    const state = {
      readyState: 4,
      status: 200,
      statusText: "OK",
      responseURL: url || location.href,
      responseText,
      responseHeaders,
    };

    let responseValue = responseText;

    try {
      if (xhr.responseType === "json") {
        responseValue = result.json;
      } else if (xhr.responseType === "arraybuffer") {
        responseValue = encoder.encode(responseText).buffer;
      } else if (xhr.responseType === "blob") {
        responseValue = new Blob([responseText], { type: "application/json" });
      }
    } catch {}

    state.response = responseValue;

    defineXhrValue(xhr, "readyState", () => state.readyState);
    defineXhrValue(xhr, "status", () => state.status);
    defineXhrValue(xhr, "statusText", () => state.statusText);
    defineXhrValue(xhr, "responseURL", () => state.responseURL);
    defineXhrValue(xhr, "response", () => state.response);

    if (!xhr.responseType || xhr.responseType === "text") {
      defineXhrValue(xhr, "responseText", () => state.responseText);
    }

    try {
      xhr.getResponseHeader = function getResponseHeader(name) {
        const lower = String(name || "").toLowerCase();
        if (lower === "content-type") return "application/json; charset=utf-8";
        if (lower === "x-chroma-source-swap") return "web-old-version";
        return null;
      };

      xhr.getAllResponseHeaders = function getAllResponseHeaders() {
        return responseHeaders + "\r\n";
      };
    } catch {}

    counters.syntheticXhr++;

    fireXhrEvent(xhr, "readystatechange", responseText.length);
    fireXhrEvent(xhr, "load", responseText.length);
    fireXhrEvent(xhr, "loadend", responseText.length);
  }

  XMLHttpRequest.prototype.open = function ytSourceSwapOpen(method, url) {
    try {
      this.__ytSourceSwap = {
        method: String(method || "GET"),
        url: String(url || ""),
        rawHeaders: {},
      };
    } catch {}

    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function ytSourceSwapSetRequestHeader(name, value) {
    try {
      if (this.__ytSourceSwap) {
        this.__ytSourceSwap.rawHeaders[String(name || "")] = String(value || "");
      }
    } catch {}

    return nativeSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function ytSourceSwapSend(body) {
    const xhr = this;
    const metaSeed = xhr.__ytSourceSwap || {};

    if (!config.interceptXhr || !isUsefulYoutubeiUrl(metaSeed.url)) {
      return nativeSend.apply(xhr, arguments);
    }

    try {
      Promise.resolve(readXhrMeta(xhr, body)).then(async meta => {
        counters.seen++;
        counters.seenXhr++;
        counters.lastTransport = "xhr";
        counters.lastEndpoint = meta.endpoint || "";

        const [shouldAttempt, reason] = shouldAttemptSwap(meta);

        if (!shouldAttempt) {
          counters.ignored++;
          counters.lastReason = reason;
          rememberSeenYoutubei(meta, reason);
          return nativeSend.call(xhr, body);
        }

        try {
          const result = await trySwap(meta);

          if (result) {
            finishSyntheticXhr(xhr, result, meta.url);
            return;
          }

          return nativeSend.call(xhr, body);
        } catch (err) {
          counters.errors++;
          counters.fallback++;
          counters.lastReason = `${err?.name || "Error"}: ${err?.message || String(err)}`;

          remember({
            event: "error",
            transport: "xhr",
            endpoint: meta?.endpoint || "",
            videoId: meta?.bodyJson?.videoId || "",
            error: counters.lastReason,
          });

          warn("xhr failed open; falling back", err);

          return nativeSend.call(xhr, body);
        }
      }).catch(err => {
        counters.errors++;
        counters.fallback++;
        counters.lastReason = `${err?.name || "Error"}: ${err?.message || String(err)}`;
        warn("xhr meta read failed; falling back", err);
        return nativeSend.call(xhr, body);
      });

      return;
    } catch (err) {
      counters.errors++;
      counters.fallback++;
      counters.lastReason = `${err?.name || "Error"}: ${err?.message || String(err)}`;
      warn("xhr wrapper failed open; falling back", err);
      return nativeSend.apply(xhr, arguments);
    }
  };

  g.fetch = sourceSwapFetch;

  g.__YT_SOURCE_SWAP_TEST__ = {
    config,
    counters,
    events,

    stats() {
      return {
        config: { ...config, endpoints: { ...config.endpoints } },
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
      XMLHttpRequest.prototype.open = nativeOpen;
      XMLHttpRequest.prototype.send = nativeSend;
      XMLHttpRequest.prototype.setRequestHeader = nativeSetRequestHeader;
      console.log("[yt-source-swap] stopped");
    },
  };

  console.log("[yt-source-swap] installed player/get_watch/next version. Use __YT_SOURCE_SWAP_TEST__.stats()");
})();
