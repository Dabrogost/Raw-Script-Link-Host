yt-client-profile-probe.js text/javascript
(() => {
  const g = globalThis;

  if (g.__YT_CLIENT_PROFILE_PROBE__?.stop) {
    g.__YT_CLIENT_PROFILE_PROBE__.stop();
  }

  const nativeFetch = g.fetch;
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");

  const events = [];
  const maxEvents = 500;

  let lastProbeSeed = null;

  const config = {
    enabled: true,
    logIgnoredYoutubei: false,
    interceptFetch: true,
    interceptXhr: true,
    captureEndpoints: {
      getWatch: true,
      player: true,
      next: false,
    },
  };

  const PROBE_PROFILES = {
    mwebCurrent: {
      key: "mwebCurrent",
      clientName: "MWEB",
      clientVersion: "2.20260625.01.00",
      clientHeaderName: "2",
    },

    mwebOld1: {
      key: "mwebOld1",
      clientName: "MWEB",
      clientVersion: "2.20240601.00.00",
      clientHeaderName: "2",
    },

    webEmbeddedCurrent: {
      key: "webEmbeddedCurrent",
      clientName: "WEB_EMBEDDED_PLAYER",
      clientVersion: "2.20260625.01.00",
      clientHeaderName: "56",
    },

    tvHtml5Current: {
      key: "tvHtml5Current",
      clientName: "TVHTML5",
      clientVersion: "7.20260625.00.00",
      clientHeaderName: "7",
    },

    tvHtml5SimplyEmbedded: {
      key: "tvHtml5SimplyEmbedded",
      clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
      clientVersion: "2.0",
      clientHeaderName: "85",
    },

    webCreator: {
      key: "webCreator",
      clientName: "WEB_CREATOR",
      clientVersion: "1.20260625.01.00",
      clientHeaderName: "62",
    },

    webCreatorCurrentLike: {
      key: "webCreatorCurrentLike",
      clientName: "WEB_CREATOR",
      clientVersion: "2.20260625.01.00",
      clientHeaderName: "62",
    },
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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

  function isCaptureEndpointEnabled(endpoint) {
    if (endpoint === "get_watch") return !!config.captureEndpoints.getWatch;
    if (endpoint === "player") return !!config.captureEndpoints.player;
    if (endpoint === "next") return !!config.captureEndpoints.next;
    return false;
  }

  function getCurrentPageVideoId() {
    return (
      document.querySelector("ytd-watch-flexy")?.getAttribute("video-id") ||
      new URL(location.href).searchParams.get("v") ||
      ""
    );
  }

  function getBodyVideoId(bodyJson) {
    return (
      bodyJson?.videoId ||
      bodyJson?.playerRequest?.videoId ||
      bodyJson?.watchNextRequest?.videoId ||
      bodyJson?.watchEndpoint?.videoId ||
      ""
    );
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

  // ---------------------------------------------------------------------------
  // Body reading
  // ---------------------------------------------------------------------------

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

    if (value instanceof Request) {
      return await value.clone().arrayBuffer();
    }

    if (typeof value?.arrayBuffer === "function" && typeof value?.clone === "function") {
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

  // ---------------------------------------------------------------------------
  // Header helpers
  // ---------------------------------------------------------------------------

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

  function makeProbeHeaders(originalHeaders, bodyJson, { gzip, profile }) {
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

    headers.set("x-youtube-client-name", profile.clientHeaderName);
    headers.set("x-youtube-client-version", profile.clientVersion);

    if (client.visitorData && !headers.has("x-goog-visitor-id")) {
      headers.set("x-goog-visitor-id", client.visitorData);
    }

    if (!headers.has("x-origin")) {
      headers.set("x-origin", location.origin);
    }

    return headers;
  }

  // ---------------------------------------------------------------------------
  // Apply profile
  // ---------------------------------------------------------------------------

  function applyClientProfile(bodyJson, profile) {
    const body = cloneJson(bodyJson);

    if (!body?.context?.client) {
      throw new Error("No context.client in youtubei body");
    }

    body.context.client.clientName = profile.clientName;
    body.context.client.clientVersion = profile.clientVersion;

    return body;
  }

  // ---------------------------------------------------------------------------
  // Capture real requests
  // ---------------------------------------------------------------------------

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
    const meta = xhr.__ytClientProfileProbe || {};

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

  function shouldCaptureMeta(meta) {
    if (!config.enabled) return [false, "disabled"];
    if (!meta?.endpoint) return [false, "not-youtubei-target"];
    if (!isCaptureEndpointEnabled(meta.endpoint)) return [false, `endpoint-disabled-${meta.endpoint}`];
    if (String(meta.method || "").toUpperCase() !== "POST") return [false, "not-post"];
    if (!meta.bodyJson) return [false, "no-json-body"];
    if (!meta.bodyJson?.context?.client) return [false, "no-context-client"];
    return [true, "ok"];
  }

  function captureProbeSeed(meta) {
    const requestVideoId = getBodyVideoId(meta.bodyJson);

    lastProbeSeed = {
      time: performance.now(),
      url: meta.url,
      endpoint: meta.endpoint,
      transport: meta.transport,
      rawHeaders: cloneJson(meta.rawHeaders || {}),
      bodyJson: cloneJson(meta.bodyJson),
      requestVideoId,
      pageVideoId: getCurrentPageVideoId(),
      originalClientName: meta.bodyJson?.context?.client?.clientName || "",
      originalClientVersion: meta.bodyJson?.context?.client?.clientVersion || "",
      bodyType: meta.bodyType,
      bodyTextLength: meta.bodyTextLength,
    };

    remember({
      event: "probe-seed-captured",
      endpoint: meta.endpoint,
      transport: meta.transport,
      requestVideoId,
      pageVideoId: lastProbeSeed.pageVideoId,
      originalClientName: lastProbeSeed.originalClientName,
      originalClientVersion: lastProbeSeed.originalClientVersion,
      bodyType: meta.bodyType,
      bodyTextLength: meta.bodyTextLength,
      topKeys: meta.bodyJson ? Object.keys(meta.bodyJson).slice(0, 40) : [],
    });
  }

  // ---------------------------------------------------------------------------
  // Fetch interception
  // ---------------------------------------------------------------------------

  async function probeFetch(input, init) {
    if (!config.interceptFetch) {
      return nativeFetch.apply(this, arguments);
    }

    let meta = null;

    try {
      meta = await readFetchMeta(input, init);

      const [shouldCapture, reason] = shouldCaptureMeta(meta);

      if (shouldCapture) {
        captureProbeSeed(meta);
      } else if (config.logIgnoredYoutubei && meta?.endpoint) {
        remember({
          event: "probe-ignored-youtubei",
          transport: "fetch",
          endpoint: meta.endpoint,
          reason,
          url: meta.url,
          method: meta.method,
          bodyType: meta.bodyType,
          bodyTextLength: meta.bodyTextLength,
          hasBodyJson: !!meta.bodyJson,
          clientName: meta.bodyJson?.context?.client?.clientName || "",
          clientVersion: meta.bodyJson?.context?.client?.clientVersion || "",
        });
      }
    } catch (err) {
      remember({
        event: "probe-capture-error",
        transport: "fetch",
        endpoint: meta?.endpoint || "",
        error: `${err?.name || "Error"}: ${err?.message || String(err)}`,
      });
    }

    return nativeFetch.apply(this, arguments);
  }

  // ---------------------------------------------------------------------------
  // XHR interception
  // ---------------------------------------------------------------------------

  XMLHttpRequest.prototype.open = function probeOpen(method, url) {
    try {
      this.__ytClientProfileProbe = {
        method: String(method || "GET"),
        url: String(url || ""),
        rawHeaders: {},
      };
    } catch {}

    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function probeSetRequestHeader(name, value) {
    try {
      if (this.__ytClientProfileProbe) {
        this.__ytClientProfileProbe.rawHeaders[String(name || "")] = String(value || "");
      }
    } catch {}

    return nativeSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function probeSend(body) {
    const xhr = this;
    const metaSeed = xhr.__ytClientProfileProbe || {};

    if (!config.interceptXhr || !endpointForUrl(metaSeed.url)) {
      return nativeSend.apply(xhr, arguments);
    }

    try {
      Promise.resolve(readXhrMeta(xhr, body)).then(meta => {
        const [shouldCapture, reason] = shouldCaptureMeta(meta);

        if (shouldCapture) {
          captureProbeSeed(meta);
        } else if (config.logIgnoredYoutubei && meta?.endpoint) {
          remember({
            event: "probe-ignored-youtubei",
            transport: "xhr",
            endpoint: meta.endpoint,
            reason,
            url: meta.url,
            method: meta.method,
            bodyType: meta.bodyType,
            bodyTextLength: meta.bodyTextLength,
            hasBodyJson: !!meta.bodyJson,
            clientName: meta.bodyJson?.context?.client?.clientName || "",
            clientVersion: meta.bodyJson?.context?.client?.clientVersion || "",
          });
        }
      }).catch(err => {
        remember({
          event: "probe-capture-error",
          transport: "xhr",
          error: `${err?.name || "Error"}: ${err?.message || String(err)}`,
        });
      });
    } catch {}

    return nativeSend.apply(xhr, arguments);
  };

  // ---------------------------------------------------------------------------
  // Player object discovery
  // ---------------------------------------------------------------------------

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
      maxHeight: heights.length ? Math.max(...heights) : 0,
      itags: allFormats.map(f => f.itag).filter(Boolean).slice(0, 80),
      expiresInSeconds: streamingData.expiresInSeconds || "",
      adPlacements: Array.isArray(json?.adPlacements) ? json.adPlacements.length : 0,
      playerAds: Array.isArray(json?.playerAds) ? json.playerAds.length : 0,
      hasAdBreakHeartbeatParams: !!json?.adBreakHeartbeatParams,
      topKeys: json ? Object.keys(json).slice(0, 60) : [],
    };
  }

  function findPlayerLikeObjects(root) {
    const found = [];
    const seen = new WeakSet();
    let visited = 0;
    const maxVisited = 8000;
    const maxDepth = 14;

    function tryJsonString(value) {
      if (typeof value !== "string") return null;
      const t = value.trim();
      if (!t || t[0] !== "{") return null;
      if (!t.includes("streamingData") && !t.includes("playabilityStatus")) return null;
      return safeJson(t);
    }

    function walk(value, path, depth) {
      if (found.length >= 30) return;
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
          value,
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

  function getPlayerVideoId(playerObj) {
    return playerObj?.videoDetails?.videoId || "";
  }

  // ---------------------------------------------------------------------------
  // Cipher / classic URL helpers
  // ---------------------------------------------------------------------------

  function parseCipherString(cipher) {
    const params = new URLSearchParams(String(cipher || ""));

    return {
      hasCipher: !!cipher,
      url: params.get("url") || "",
      s: params.get("s") || "",
      sp: params.get("sp") || "",
      sig: params.get("sig") || "",
      signature: params.get("signature") || "",
      rawStart: String(cipher || "").slice(0, 300),
    };
  }

  function getCipherString(format) {
    return format?.signatureCipher || format?.cipher || "";
  }

  function isClassicNonSabrUrl(url) {
    return !!url && !/(?:[?&]|%26)sabr(?:=|%3D)1/i.test(String(url));
  }

  function hasDirectClassicUrl(format) {
    return isClassicNonSabrUrl(format?.url || "");
  }

  function hasRawClassicCipher(format) {
    const cipher = getCipherString(format);
    if (!cipher) return false;

    const parsed = parseCipherString(cipher);
    return isClassicNonSabrUrl(parsed.url);
  }

  function getFormatUrlMode(format) {
    if (hasDirectClassicUrl(format)) return "direct-url";
    if (hasRawClassicCipher(format)) return "raw-cipher";
    return "";
  }

  function isUsableClassicFormat(format) {
    return !!getFormatUrlMode(format);
  }

  function isVideoFormat(format) {
    return String(format?.mimeType || "").includes("video/");
  }

  function isAudioFormat(format) {
    return String(format?.mimeType || "").includes("audio/");
  }

  function getFormatHeight(format) {
    return Number(format?.height || 0);
  }

  function getFormatBitrate(format) {
    return Number(format?.bitrate || format?.averageBitrate || 0);
  }

  // ---------------------------------------------------------------------------
  // Format summarizer
  // ---------------------------------------------------------------------------

  function summarizeUsableFormat(format) {
    const mode = getFormatUrlMode(format);
    const cipher = getCipherString(format);
    const parsedCipher = parseCipherString(cipher);
    const rawUrl = format?.url || parsedCipher.url || "";

    let urlInfo = null;

    try {
      if (rawUrl) {
        const u = new URL(rawUrl);
        urlInfo = {
          host: u.hostname,
          itag: u.searchParams.get("itag") || "",
          mime: u.searchParams.get("mime") || "",
          c: u.searchParams.get("c") || "",
          hasSabr: /(?:[?&]|%26)sabr(?:=|%3D)1/i.test(rawUrl),
          urlStart: rawUrl.slice(0, 220),
        };
      }
    } catch {}

    return {
      itag: format?.itag || "",
      mimeType: format?.mimeType || "",
      quality: format?.quality || "",
      qualityLabel: format?.qualityLabel || "",
      height: getFormatHeight(format),
      bitrate: getFormatBitrate(format),
      audioQuality: format?.audioQuality || "",
      audioSampleRate: format?.audioSampleRate || "",
      audioChannels: format?.audioChannels || null,
      mode,
      hasUrl: !!format?.url,
      hasSignatureCipher: !!format?.signatureCipher,
      hasCipher: !!format?.cipher,
      urlInfo,
    };
  }

  function summarizeStreamingDataUrls(streamingData) {
    const formats = Array.isArray(streamingData?.formats) ? streamingData.formats : [];
    const adaptiveFormats = Array.isArray(streamingData?.adaptiveFormats) ? streamingData.adaptiveFormats : [];
    const all = formats.concat(adaptiveFormats);

    const directUrls = all.map(f => f.url || "").filter(Boolean);
    const cipherEntries = all.map(f => f.signatureCipher || f.cipher || "").filter(Boolean);

    const sabrUrlCount = directUrls.filter(u =>
      /(?:[?&]|%26)sabr(?:=|%3D)1/i.test(String(u))
    ).length;

    const classicUrlCount = directUrls.length - sabrUrlCount;

    return {
      formats: formats.length,
      adaptiveFormats: adaptiveFormats.length,
      directUrlCount: directUrls.length,
      cipherEntryCount: cipherEntries.length,
      classicUrlCount,
      sabrUrlCount,
      hasServerAbr: !!streamingData?.serverAbrStreamingUrl,
      hasAnyClassicUrl: classicUrlCount > 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Adaptive candidate analyzer
  // ---------------------------------------------------------------------------

  function summarizeClassicAdaptiveCandidates(playerResponse) {
    const streamingData = playerResponse?.streamingData || {};
    const formats = Array.isArray(streamingData.formats) ? streamingData.formats : [];
    const adaptiveFormats = Array.isArray(streamingData.adaptiveFormats)
      ? streamingData.adaptiveFormats
      : [];

    const usableProgressive = formats
      .filter(format => isUsableClassicFormat(format))
      .map(summarizeUsableFormat)
      .sort((a, b) => Number(b.height || 0) - Number(a.height || 0));

    const usableAdaptiveVideo = adaptiveFormats
      .filter(format => isVideoFormat(format) && isUsableClassicFormat(format))
      .map(summarizeUsableFormat)
      .sort((a, b) => {
        const heightDelta = Number(b.height || 0) - Number(a.height || 0);
        if (heightDelta) return heightDelta;
        return Number(b.bitrate || 0) - Number(a.bitrate || 0);
      });

    const usableAdaptiveAudio = adaptiveFormats
      .filter(format => isAudioFormat(format) && isUsableClassicFormat(format))
      .map(summarizeUsableFormat)
      .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0));

    return {
      streamingSummary: summarizePlayerResponse(playerResponse),
      urlSummary: summarizeStreamingDataUrls(streamingData),

      progressive: {
        usableCount: usableProgressive.length,
        best: usableProgressive[0] || null,
        all: usableProgressive.slice(0, 12),
      },

      adaptiveClassic: {
        usableVideoCount: usableAdaptiveVideo.length,
        usableAudioCount: usableAdaptiveAudio.length,
        bestVideo: usableAdaptiveVideo[0] || null,
        bestAudio: usableAdaptiveAudio[0] || null,
        hasPlayablePair: !!usableAdaptiveVideo.length && !!usableAdaptiveAudio.length,
        videos: usableAdaptiveVideo.slice(0, 12),
        audios: usableAdaptiveAudio.slice(0, 12),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Probe fetch
  // ---------------------------------------------------------------------------

  async function fetchProbeClientEndpoint(seed, profile) {
    const body = applyClientProfile(seed.bodyJson, profile);
    const bodyText = JSON.stringify(body);

    let gzip = true;
    let requestBody = await gzipString(bodyText);

    if (!requestBody) {
      gzip = false;
      requestBody = bodyText;
    }

    const headers = makeProbeHeaders(seed.rawHeaders, body, {
      gzip,
      profile,
    });

    const started = performance.now();

    const resp = await nativeFetch(seed.url, {
      method: "POST",
      headers,
      body: requestBody,
      credentials: "include",
      mode: "same-origin",
      cache: "no-store",
      referrer: location.href,
      referrerPolicy: "strict-origin-when-cross-origin",
    });

    const text = await resp.text();
    const json = safeJson(text);

    return {
      profile,
      httpStatus: resp.status,
      ok: resp.ok,
      durationMs: Math.round(performance.now() - started),
      json,
      textPreview: json ? "" : text.slice(0, 500),
    };
  }

  // ---------------------------------------------------------------------------
  // Probe one profile
  // ---------------------------------------------------------------------------

  async function probeOneProfile(profileInput) {
    if (!lastProbeSeed?.bodyJson) {
      throw new Error("No recent YouTube request captured yet. Navigate to a YouTube video first.");
    }

    const profile =
      typeof profileInput === "string"
        ? PROBE_PROFILES[profileInput]
        : profileInput;

    if (!profile?.clientName || !profile?.clientVersion || !profile?.clientHeaderName) {
      throw new Error(`Invalid probe profile: ${String(profileInput)}`);
    }

    const result = await fetchProbeClientEndpoint(lastProbeSeed, profile);
    const players = findPlayerLikeObjects(result.json);
    const wantedVideoId = lastProbeSeed.requestVideoId;

    const exactPlayer =
      wantedVideoId
        ? players.find(p => getPlayerVideoId(p.value) === wantedVideoId)
        : null;

    const player = exactPlayer || players[0] || null;
    const analysis = player
      ? summarizeClassicAdaptiveCandidates(player.value)
      : null;

    const summary = {
      event: "probe-profile-result",
      profileKey: profile.key || "",
      clientName: profile.clientName,
      clientVersion: profile.clientVersion,
      clientHeaderName: profile.clientHeaderName,
      httpStatus: result.httpStatus,
      ok: result.ok,
      durationMs: result.durationMs,
      seedEndpoint: lastProbeSeed.endpoint,
      requestVideoId: wantedVideoId,
      pageVideoId: getCurrentPageVideoId(),
      seedAgeMs: Math.round(performance.now() - lastProbeSeed.time),
      playerPath: player?.path || "",
      playerCount: players.length,
      matchedExactVideoId: !!exactPlayer,
      status: player?.summary?.status || "",
      reason: player?.summary?.reason || "",
      hasStreamingData: !!player?.value?.streamingData,
      hasServerAbr: !!player?.value?.streamingData?.serverAbrStreamingUrl,
      hasSabr: !!player?.summary?.hasSabr,
      formats: player?.summary?.formats || 0,
      adaptiveFormats: player?.summary?.adaptiveFormats || 0,
      maxHeight: player?.summary?.maxHeight || 0,
      progressive: analysis?.progressive || null,
      adaptiveClassic: analysis?.adaptiveClassic || null,
      topKeys: result.json ? Object.keys(result.json).slice(0, 50) : [],
      textPreview: result.textPreview || "",
    };

    remember(summary);

    return summary;
  }

  // ---------------------------------------------------------------------------
  // Probe multiple profiles slowly
  // ---------------------------------------------------------------------------

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function runProbeProfiles(profileInputs = Object.keys(PROBE_PROFILES), options = {}) {
    const delayMs = Number(options.delayMs ?? 1500);
    const out = [];

    for (const input of profileInputs) {
      try {
        const result = await probeOneProfile(input);
        out.push(result);
        console.log("[yt-client-profile-probe] probe result", result);
      } catch (err) {
        const failure = {
          event: "probe-profile-error",
          profile: typeof input === "string" ? input : input?.key || "",
          error: `${err?.name || "Error"}: ${err?.message || String(err)}`,
        };
        remember(failure);
        out.push(failure);
        console.warn("[yt-client-profile-probe] probe failed", failure);
      }

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  g.fetch = probeFetch;

  g.__YT_CLIENT_PROFILE_PROBE__ = {
    config,
    events,
    probeProfilesConfig: PROBE_PROFILES,

    probeLast() {
      return lastProbeSeed
        ? {
            ageMs: Math.round(performance.now() - lastProbeSeed.time),
            endpoint: lastProbeSeed.endpoint,
            transport: lastProbeSeed.transport,
            requestVideoId: lastProbeSeed.requestVideoId,
            pageVideoId: lastProbeSeed.pageVideoId,
            originalClientName: lastProbeSeed.originalClientName,
            originalClientVersion: lastProbeSeed.originalClientVersion,
            hasBodyJson: !!lastProbeSeed.bodyJson,
            bodyTextLength: lastProbeSeed.bodyTextLength,
          }
        : null;
    },

    async probeProfile(profileInput) {
      const result = await probeOneProfile(profileInput);
      console.log("[yt-client-profile-probe] probeProfile", result);
      return result;
    },

    async probeProfiles(profileInputs, options) {
      return await runProbeProfiles(profileInputs, options);
    },

    clear() {
      events.length = 0;
      console.log("[yt-client-profile-probe] cleared events");
    },

    copyEvents() {
      copy(JSON.stringify(events, null, 2));
      console.log(`[yt-client-profile-probe] copied ${events.length} event(s)`);
    },

    copyLast() {
      copy(JSON.stringify(this.probeLast(), null, 2));
      console.log("[yt-client-profile-probe] copied last seed summary");
    },

    stop() {
      g.fetch = nativeFetch;
      XMLHttpRequest.prototype.open = nativeOpen;
      XMLHttpRequest.prototype.send = nativeSend;
      XMLHttpRequest.prototype.setRequestHeader = nativeSetRequestHeader;
      console.log("[yt-client-profile-probe] stopped");
    },
  };

  console.log("[yt-client-profile-probe] installed. Use __YT_CLIENT_PROFILE_PROBE__.probeLast()");
})();
