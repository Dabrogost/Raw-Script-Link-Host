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

  const CLIENT_PROFILES = {
    oldWeb: {
      key: "oldWeb",
      clientName: "WEB",
      clientVersion: "1.20160315",
      clientHeaderName: "1",
      notes: "Known non-SABR but media 403s",
    },

    webRemix: {
      key: "webRemix",
      clientName: "WEB_REMIX",
      clientVersion: "1.20260623.13.00",
      clientHeaderName: "67",
      notes: "No streamingData from www.youtube.com replay so far",
    },

    mweb: {
      key: "mweb",
      clientName: "MWEB",
      clientVersion: "2.20260625.01.00",
      clientHeaderName: "2",
      notes: "First non-WEB_REMIX candidate",
    },

    webEmbedded: {
      key: "webEmbedded",
      clientName: "WEB_EMBEDDED_PLAYER",
      clientVersion: "2.20260625.01.00",
      clientHeaderName: "56",
      notes: "Candidate header/version; must be console-editable",
    },

    tvHtml5: {
      key: "tvHtml5",
      clientName: "TVHTML5",
      clientVersion: "7.20260625.00.00",
      clientHeaderName: "7",
      notes: "Candidate version; must be console-editable",
    },
  };

  const config = {
    enabled: true,
    targetProfile: "mweb",
    requireNonSabr: true,
    requireStreamingDataProof: true,
    logVerbose: true,
    logIgnoredYoutubei: true,
    logMediaErrors: true,
    interceptFetch: true,
    interceptXhr: true,
    allowClassicOnlyFromSabrTargets: true,
    classicPatchMode: "progressive-only",
    allowCipherUrlWithoutDecipher: false,
    endpoints: {
      player: false,
      getWatch: true,
      next: false,
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

  let lastPatch = {
    time: -Infinity,
    targetProfile: "",
    sourceMode: "",
    requestVideoId: "",
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
      bodyJson?.continuation ||
      ""
    );
  }

  function isMediaUrl(url) {
    return /googlevideo\.com\/videoplayback/i.test(String(url || ""));
  }

  function summarizeMediaUrl(url) {
    try {
      const u = new URL(String(url));
      return {
        host: u.hostname,
        path: u.pathname,
        itag: u.searchParams.get("itag") || "",
        mime: u.searchParams.get("mime") || "",
        c: u.searchParams.get("c") || "",
        hasSabr: /(?:[?&]|%26)sabr(?:=|%3D)1/i.test(String(url)),
        hasRange: /(?:[?&]|%26)range(?:=|%3D)/i.test(String(url)),
        urlStart: String(url).slice(0, 260),
      };
    } catch {
      return {
        urlStart: String(url).slice(0, 260),
      };
    }
  }

  function summarizeVideoElementState() {
    const v = document.querySelector("video");

    if (!v) {
      return {
        hasVideo: false,
      };
    }

    return {
      hasVideo: true,
      currentSrc: v.currentSrc || "",
      readyState: v.readyState,
      networkState: v.networkState,
      paused: v.paused,
      currentTime: v.currentTime,
      duration: v.duration,
      error: v.error
        ? {
            code: v.error.code,
            message: v.error.message,
          }
        : null,
    };
  }

  function playerEndpointUrl() {
    return `${location.origin}/youtubei/v1/player?prettyPrint=false`;
  }

  function buildPlayerReplayFromContainerBody(bodyJson) {
    if (!bodyJson?.playerRequest || typeof bodyJson.playerRequest !== "object") {
      return null;
    }

    const playerBody = cloneJson(bodyJson.playerRequest);

    if (!playerBody.context) {
      playerBody.context = cloneJson(bodyJson.context || {});
    }

    if (!playerBody.context?.client && bodyJson.context?.client) {
      playerBody.context = playerBody.context || {};
      playerBody.context.client = cloneJson(bodyJson.context.client);
    }

    return playerBody;
  }

  function stripPlayerAdState(playerResponse) {
    if (!playerResponse || typeof playerResponse !== "object") return;

    const keys = [
      "adPlacements",
      "adSlots",
      "playerAds",
      "adBreakParams",
      "adBreakHeartbeatParams",
      "adInferredBlockingStatus",
      "adSignalsInfo",
      "playerAttestationRenderer",
      "adSafetyReason",
      "paidContentOverlay",
    ];

    for (const key of keys) {
      delete playerResponse[key];
    }
  }

  function summarizeAdState(playerResponse) {
    if (!playerResponse || typeof playerResponse !== "object") {
      return {
        playerAds: 0,
        adPlacements: 0,
        adSlots: 0,
        hasAdBreakHeartbeatParams: false,
        hasAdBreakParams: false,
        hasAdInferredBlockingStatus: false,
        adKeys: [],
      };
    }

    const adKeys = Object.keys(playerResponse).filter(key =>
      /ad|paid|attestation/i.test(key)
    );

    return {
      playerAds: Array.isArray(playerResponse.playerAds) ? playerResponse.playerAds.length : 0,
      adPlacements: Array.isArray(playerResponse.adPlacements) ? playerResponse.adPlacements.length : 0,
      adSlots: Array.isArray(playerResponse.adSlots) ? playerResponse.adSlots.length : 0,
      hasAdBreakHeartbeatParams: !!playerResponse.adBreakHeartbeatParams,
      hasAdBreakParams: !!playerResponse.adBreakParams,
      hasAdInferredBlockingStatus: !!playerResponse.adInferredBlockingStatus,
      adKeys,
    };
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

  function getTargetProfile() {
    return CLIENT_PROFILES[config.targetProfile] || CLIENT_PROFILES.mweb;
  }

  function applyClientProfile(bodyJson, profile = getTargetProfile()) {
    const body = cloneJson(bodyJson);

    if (!body?.context?.client) {
      throw new Error("No context.client in youtubei body");
    }

    body.context.client.clientName = profile.clientName;
    body.context.client.clientVersion = profile.clientVersion;

    return body;
  }

  function makeReplayHeaders(originalHeaders, bodyJson, { gzip, profile = getTargetProfile() }) {
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

  function findBestUsablePlayerObjectForVideo(root, wantedVideoId = "") {
    const matches = findPlayerLikeObjects(root)
      .filter(p => playerSummaryIsUsable(p.summary));

    if (!matches.length) return null;

    if (wantedVideoId) {
      const exact = matches.find(p => getPlayerVideoId(p.value) === wantedVideoId);
      if (exact) return exact;
    }

    return matches[0];
  }

  function findFirstModernPlayerObject(root) {
    const matches = findPlayerLikeObjects(root);
    return matches[0] || null;
  }

  function findFirstPlayerObject(root) {
    const matches = findPlayerLikeObjects(root);
    return matches[0] || null;
  }

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

  function summarizeFormatEntry(format) {
    const cipher = format?.signatureCipher || format?.cipher || "";
    const parsedCipher = parseCipherString(cipher);
    const directUrl = format?.url || "";

    let directUrlInfo = null;
    let cipherUrlInfo = null;

    try {
      if (directUrl) {
        const u = new URL(directUrl);
        directUrlInfo = {
          host: u.hostname,
          itag: u.searchParams.get("itag") || "",
          mime: u.searchParams.get("mime") || "",
          c: u.searchParams.get("c") || "",
          hasSabr: /(?:[?&]|%26)sabr(?:=|%3D)1/i.test(directUrl),
          urlStart: directUrl.slice(0, 260),
        };
      }
    } catch {}

    try {
      if (parsedCipher.url) {
        const u = new URL(parsedCipher.url);
        cipherUrlInfo = {
          host: u.hostname,
          itag: u.searchParams.get("itag") || "",
          mime: u.searchParams.get("mime") || "",
          c: u.searchParams.get("c") || "",
          hasSabr: /(?:[?&]|%26)sabr(?:=|%3D)1/i.test(parsedCipher.url),
          urlStart: parsedCipher.url.slice(0, 260),
        };
      }
    } catch {}

    return {
      itag: format?.itag || "",
      mimeType: format?.mimeType || "",
      quality: format?.quality || "",
      qualityLabel: format?.qualityLabel || "",
      hasUrl: !!directUrl,
      hasSignatureCipher: !!format?.signatureCipher,
      hasCipher: !!format?.cipher,
      directUrlInfo,
      cipher: {
        hasCipher: parsedCipher.hasCipher,
        hasUrl: !!parsedCipher.url,
        hasS: !!parsedCipher.s,
        sLength: parsedCipher.s.length,
        sp: parsedCipher.sp,
        hasSig: !!parsedCipher.sig,
        hasSignature: !!parsedCipher.signature,
        cipherUrlInfo,
        rawStart: parsedCipher.rawStart,
      },
    };
  }

  function summarizeStreamingDataUrls(streamingData) {
    const formats = Array.isArray(streamingData?.formats) ? streamingData.formats : [];
    const adaptiveFormats = Array.isArray(streamingData?.adaptiveFormats) ? streamingData.adaptiveFormats : [];
    const all = formats.concat(adaptiveFormats);

    const directUrls = all
      .map(f => f.url || "")
      .filter(Boolean);

    const cipherEntries = all
      .map(f => f.signatureCipher || f.cipher || "")
      .filter(Boolean);

    const sabrUrlCount = directUrls.filter(u =>
      /(?:[?&]|%26)sabr(?:=|%3D)1/i.test(String(u))
    ).length;

    const classicUrlCount = directUrls.length - sabrUrlCount;

    const sampleFormats = all.slice(0, 8).map(summarizeFormatEntry);

    return {
      formats: formats.length,
      adaptiveFormats: adaptiveFormats.length,
      directUrlCount: directUrls.length,
      cipherEntryCount: cipherEntries.length,
      classicUrlCount,
      sabrUrlCount,
      hasServerAbr: !!streamingData?.serverAbrStreamingUrl,
      hasAnyClassicUrl: classicUrlCount > 0,
      sampleClassic: directUrls.find(u => !/(?:[?&]|%26)sabr(?:=|%3D)1/i.test(String(u)))?.slice(0, 240) || "",
      sampleSabr: directUrls.find(u => /(?:[?&]|%26)sabr(?:=|%3D)1/i.test(String(u)))?.slice(0, 240) || "",
      sampleFormats,
    };
  }

  function cloneClassicOnlyStreamingData(streamingData) {
    const clean = cloneJson(streamingData || {});

    delete clean.serverAbrStreamingUrl;
    delete clean.sabrStreamingUrl;
    delete clean.serverAbrStreamingUrlConfig;

    return clean;
  }

  function hasDirectClassicUrl(format) {
    const url = format?.url || "";
    if (!url) return false;
    return !/(?:[?&]|%26)sabr(?:=|%3D)1/i.test(String(url));
  }

  function isProgressiveFormat(format) {
    return (
      format?.itag === 18 ||
      format?.itag === "18" ||
      /mp4a/i.test(String(format?.mimeType || "")) ||
      Array.isArray(format?.audioChannels)
    );
  }

  function hasDirectClassicUrlOrCipher(format) {
    if (hasDirectClassicUrl(format)) return true;

    const cipher = format?.signatureCipher || format?.cipher || "";
    if (!cipher) return false;

    const parsed = parseCipherString(cipher);
    if (!parsed.url) return false;

    return !/(?:[?&]|%26)sabr(?:=|%3D)1/i.test(parsed.url);
  }

  function cloneProgressiveOnlyStreamingData(streamingData) {
    const clean = cloneJson(streamingData || {});

    delete clean.serverAbrStreamingUrl;
    delete clean.sabrStreamingUrl;
    delete clean.serverAbrStreamingUrlConfig;

    const formats = Array.isArray(clean.formats) ? clean.formats : [];
    clean.formats = formats.filter(hasDirectClassicUrl);

    clean.adaptiveFormats = [];

    return clean;
  }

  function cloneProgressiveCipherUrlOnlyStreamingData(streamingData) {
    const clean = cloneJson(streamingData || {});

    delete clean.serverAbrStreamingUrl;
    delete clean.sabrStreamingUrl;
    delete clean.serverAbrStreamingUrlConfig;

    const formats = Array.isArray(clean.formats) ? clean.formats : [];

    clean.formats = formats
      .map(format => {
        if (format.url && hasDirectClassicUrl(format)) {
          return format;
        }

        const cipher = format.signatureCipher || format.cipher || "";
        const parsed = parseCipherString(cipher);

        if (!parsed.url) return null;

        const sigValue = parsed.sig || parsed.signature || "";
        const sigParam = parsed.sp || "signature";

        if (!sigValue) return null;

        const url = new URL(parsed.url);

        url.searchParams.set(sigParam, sigValue);

        const cloned = cloneJson(format);
        cloned.url = url.toString();
        delete cloned.signatureCipher;
        delete cloned.cipher;
        return cloned;
      })
      .filter(Boolean);

    clean.adaptiveFormats = [];

    return clean;
  }

  function cloneProgressiveRawCipherStreamingData(streamingData) {
    const clean = cloneJson(streamingData || {});

    delete clean.serverAbrStreamingUrl;
    delete clean.sabrStreamingUrl;
    delete clean.serverAbrStreamingUrlConfig;

    const formats = Array.isArray(clean.formats) ? clean.formats : [];

    clean.formats = formats
      .filter(format =>
        isProgressiveFormat(format) &&
        hasDirectClassicUrlOrCipher(format)
      )
      .map(format => cloneJson(format));

    clean.adaptiveFormats = [];

    return clean;
  }

  function makeSyntheticPlayerWithStreamingData(basePlayer, streamingData) {
    const cloned = cloneJson(basePlayer || {});

    if (config.classicPatchMode === "progressive-only") {
      cloned.streamingData = cloneProgressiveOnlyStreamingData(streamingData);
    } else if (config.classicPatchMode === "progressive-cipher-url-only") {
      cloned.streamingData = cloneProgressiveCipherUrlOnlyStreamingData(streamingData);
    } else if (config.classicPatchMode === "progressive-raw-cipher") {
      cloned.streamingData = cloneProgressiveRawCipherStreamingData(streamingData);
    } else {
      cloned.streamingData = cloneClassicOnlyStreamingData(streamingData);
    }

    return cloned;
  }

  function hasPlayableProgressiveCandidate(streamingData) {
    const formats = Array.isArray(streamingData?.formats) ? streamingData.formats : [];

    return formats.some(format =>
      isProgressiveFormat(format) &&
      hasDirectClassicUrlOrCipher(format)
    );
  }

  function findClassicOnlyCandidateForVideo(root, wantedVideoId = "") {
    const matches = findPlayerLikeObjects(root);

    let candidates = matches;

    if (wantedVideoId) {
      const exact = matches.filter(p => getPlayerVideoId(p.value) === wantedVideoId);
      if (exact.length) candidates = exact;
    }

    for (const match of candidates) {
      const streamingData = match.value?.streamingData;
      if (!streamingData) continue;

      const details = summarizeStreamingDataUrls(streamingData);

      if (!details.hasAnyClassicUrl) continue;

      const synthetic = makeSyntheticPlayerWithStreamingData(match.value, streamingData);
      const summary = summarizePlayerResponse(synthetic);

      const progressiveRawCipherOk =
        config.classicPatchMode === "progressive-raw-cipher" &&
        summary.status === "OK" &&
        !summary.hasSabr &&
        !summary.hasServerAbr &&
        hasPlayableProgressiveCandidate(synthetic.streamingData);

      if (playerSummaryIsUsable(summary) || progressiveRawCipherOk) {
        return {
          path: match.path,
          value: synthetic,
          summary,
          originalSummary: match.summary,
          streamingDetails: details,
          mode: config.classicPatchMode,
        };
      }
    }

    return null;
  }

  function summarizeEndpointResponse(json) {
    const direct = summarizePlayerResponse(json);
    const nestedPlayers = findPlayerLikeObjects(json);
    // Strip value references before storing in the summary (path + summary only)
    const nestedPlayersSafe = nestedPlayers.map(p => ({ path: p.path, summary: p.summary }));
    const bestNested = nestedPlayersSafe.find(p => playerSummaryIsUsable(p.summary)) || nestedPlayersSafe[0] || null;
    const directUsable = playerSummaryIsUsable(direct);

    return {
      direct,
      directUsable,
      nestedPlayerCount: nestedPlayers.length,
      nestedPlayers: nestedPlayersSafe.slice(0, 8),
      bestNested,
      bestUsable: directUsable || !!nestedPlayersSafe.find(p => playerSummaryIsUsable(p.summary)),
      topKeys: json ? Object.keys(json).slice(0, 80) : [],
    };
  }

  function makeReplacementResponse(json) {
    return new Response(JSON.stringify(json), {
      status: 200,
      statusText: "OK",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-chroma-source-swap": "target-client",
      },
    });
  }

  function makeJsonResponseFromOriginal(originalResp, json) {
    const headers = new Headers(originalResp.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("x-chroma-source-swap", "container-streamingData-patch");
    headers.delete("content-length");
    headers.delete("content-encoding");

    return new Response(JSON.stringify(json), {
      status: originalResp.status,
      statusText: originalResp.statusText,
      headers,
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
    const profile = getTargetProfile();

    if (client.clientName !== "WEB") return [false, `client-${client.clientName || "missing"}`];
    if (client.clientName === profile.clientName && client.clientVersion === profile.clientVersion) {
      return [false, "already-target-client"];
    }

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

  async function fetchTargetClientEndpoint(meta, options = {}) {
    const profile = getTargetProfile();
    const sourceMode = options.sourceMode || "same-endpoint";
    const targetUrl = options.url || meta.url;
    const sourceBodyJson = options.bodyJson || meta.bodyJson;
    const swappedBody = applyClientProfile(sourceBodyJson, profile);
    const bodyText = JSON.stringify(swappedBody);

    let gzip = true;
    let body = await gzipString(bodyText);

    if (!body) {
      gzip = false;
      body = bodyText;
    }

    const headers = makeReplayHeaders(meta.rawHeaders, swappedBody, {
      gzip,
      profile,
    });

    const started = performance.now();

    log("replaying target client endpoint", {
      endpoint: endpointForUrl(targetUrl),
      sourceMode,
      targetProfile: profile.key,
      targetClientName: profile.clientName,
      targetClientVersion: profile.clientVersion,
      targetClientHeaderName: profile.clientHeaderName,
    });

    const resp = await nativeFetch(targetUrl, {
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
      endpoint: endpointForUrl(targetUrl),
      sourceMode,
      targetProfile: profile.key,
      targetClientName: profile.clientName,
      targetClientVersion: profile.clientVersion,
      targetClientHeaderName: profile.clientHeaderName,
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

    // Only /player responses may be used as full whole-response replacements.
    if (result.endpoint !== "player") {
      return false;
    }

    if (!config.requireStreamingDataProof) {
      return true;
    }

    return !!result.endpointSummary?.bestUsable;
  }

  async function tryPatchContainerResponse(meta, input, init) {
    const endpoint = meta.endpoint || endpointForUrl(meta.url);

    counters.attempts++;
    counters.lastReason = "attempting-container-patch";
    counters.lastTransport = meta.transport;
    counters.lastEndpoint = endpoint;
    countAttemptEndpoint(endpoint);

    if (meta.transport === "fetch") counters.attemptsFetch++;
    if (meta.transport === "xhr") counters.attemptsXhr++;

    remember({
      event: "attempt-container-patch",
      transport: meta.transport,
      endpoint,
      pageVideoId: getCurrentPageVideoId(),
      requestVideoId: getBodyVideoId(meta.bodyJson),
      originalClientName: meta.bodyJson?.context?.client?.clientName || "",
      originalClientVersion: meta.bodyJson?.context?.client?.clientVersion || "",
      targetProfile: getTargetProfile().key,
      targetClientName: getTargetProfile().clientName,
      targetClientVersion: getTargetProfile().clientVersion,
      targetClientHeaderName: getTargetProfile().clientHeaderName,
      bodyType: meta.bodyType,
      bodyTextLength: meta.bodyTextLength,
      classicPatchMode: config.classicPatchMode,
      topKeys: meta.bodyJson ? Object.keys(meta.bodyJson).slice(0, 40) : [],
    });

    const wantedVideoId = getBodyVideoId(meta.bodyJson);
    const originalResp = await nativeFetch(input, init);
    const originalText = await originalResp.clone().text();
    const originalJson = safeJson(originalText);

    if (!originalResp.ok || !originalJson) {
      counters.fallback++;
      counters.lastReason = "original-container-invalid";
      remember({
        event: "fallback-container-patch",
        transport: meta.transport,
        endpoint,
        reason: counters.lastReason,
        sourceMode: "",
        targetProfile: getTargetProfile().key,
        targetClientName: getTargetProfile().clientName,
        targetClientVersion: getTargetProfile().clientVersion,
        targetHttpStatus: 0,
        targetNestedPlayerCount: 0,
        targetBestUsable: false,
        requestVideoId: wantedVideoId,
        pageVideoId: getCurrentPageVideoId(),
        targetBestPath: "",
        modernPath: "",
        httpStatus: originalResp.status,
      });
      return originalResp;
    }

    let targetResult = await fetchTargetClientEndpoint(meta, {
      sourceMode: "same-endpoint",
    });
    let lastTargetResult = targetResult;
    let targetPlayer = findBestUsablePlayerObjectForVideo(targetResult.json, wantedVideoId);
    let targetSelectionMode = "direct-usable";

    if (!targetPlayer && config.allowClassicOnlyFromSabrTargets) {
      const classicOnlyTarget = findClassicOnlyCandidateForVideo(targetResult.json, wantedVideoId);

      if (classicOnlyTarget) {
        targetPlayer = classicOnlyTarget;
        targetSelectionMode = classicOnlyTarget.mode;
      }
    }

    if (!targetPlayer && endpoint === "get_watch" && meta.bodyJson?.playerRequest) {
      const playerBody = buildPlayerReplayFromContainerBody(meta.bodyJson);

      remember({
        event: "attempt-target-player-from-container",
        transport: meta.transport,
        endpoint,
        targetProfile: getTargetProfile().key,
        requestVideoId: wantedVideoId,
        pageVideoId: getCurrentPageVideoId(),
        hasPlayerBody: !!playerBody,
        playerBodyTopKeys: playerBody ? Object.keys(playerBody).slice(0, 40) : [],
      });

      if (playerBody) {
        const playerResult = await fetchTargetClientEndpoint(meta, {
          sourceMode: "player-from-container",
          url: playerEndpointUrl(),
          bodyJson: playerBody,
        });

        lastTargetResult = playerResult;

        let playerTarget = findBestUsablePlayerObjectForVideo(playerResult.json, wantedVideoId);

        if (!playerTarget && config.allowClassicOnlyFromSabrTargets) {
          const classicOnlyTarget = findClassicOnlyCandidateForVideo(playerResult.json, wantedVideoId);

          if (classicOnlyTarget) {
            playerTarget = classicOnlyTarget;
            targetSelectionMode = classicOnlyTarget.mode;
          }
        }

        const firstPlayerTarget = findFirstPlayerObject(playerResult.json);
        const firstTargetStreamingDetails = firstPlayerTarget?.value?.streamingData
          ? summarizeStreamingDataUrls(firstPlayerTarget.value.streamingData)
          : null;

        remember({
          event: "target-player-from-container-result",
          transport: meta.transport,
          endpoint,
          sourceMode: playerResult.sourceMode,
          targetProfile: playerResult.targetProfile,
          targetClientName: playerResult.targetClientName,
          targetClientVersion: playerResult.targetClientVersion,
          targetClientHeaderName: playerResult.targetClientHeaderName,
          targetHttpStatus: playerResult.httpStatus,
          targetNestedPlayerCount: playerResult.endpointSummary?.nestedPlayerCount || 0,
          targetBestUsable: !!playerTarget,
          targetBestPath: playerTarget?.path || "",
          targetSummary: playerTarget?.summary || null,
          targetSelectionMode,

          firstTargetPath: firstPlayerTarget?.path || "",
          firstTargetSummary: firstPlayerTarget?.summary || null,
          firstTargetStreamingDetails,

          rejectedBecause: firstPlayerTarget
            ? {
                statusNotOk: firstPlayerTarget.summary?.status !== "OK",
                missingStreamingData: !firstPlayerTarget.summary?.hasStreamingData,
                hasSabr: !!firstPlayerTarget.summary?.hasSabr,
                hasServerAbr: !!firstPlayerTarget.summary?.hasServerAbr,
              }
            : null,

          textPreview: playerResult.textPreview || "",
          topKeys: playerResult.json ? Object.keys(playerResult.json).slice(0, 80) : [],
        });

        if (playerTarget) {
          targetResult = playerResult;
          targetPlayer = playerTarget;
        }
      }
    }

    const modernPlayer = findFirstModernPlayerObject(originalJson);

    if (!targetResult.ok || !targetPlayer || !modernPlayer?.value) {
      counters.fallback++;
      counters.lastReason = "no-usable-target-player-for-container-patch";

      remember({
        event: "fallback-container-patch",
        transport: meta.transport,
        endpoint,
        reason: counters.lastReason,
        sourceMode: lastTargetResult?.sourceMode || "",
        targetProfile: lastTargetResult?.targetProfile || getTargetProfile().key,
        targetClientName: lastTargetResult?.targetClientName || getTargetProfile().clientName,
        targetClientVersion: lastTargetResult?.targetClientVersion || getTargetProfile().clientVersion,
        targetHttpStatus: lastTargetResult?.httpStatus || 0,
        targetNestedPlayerCount: lastTargetResult?.endpointSummary?.nestedPlayerCount || 0,
        targetBestUsable: !!targetPlayer,
        requestVideoId: wantedVideoId,
        pageVideoId: getCurrentPageVideoId(),
        modernHasPlayer: !!modernPlayer,
        targetBestPath: targetPlayer?.path || "",
        modernPath: modernPlayer?.path || "",
        targetSelectionMode,
        classicPatchMode: config.classicPatchMode,
      });

      return originalResp;
    }

    // Patch only streamingData; do not copy the target playerResponse wholesale.
    modernPlayer.value.streamingData = cloneJson(targetPlayer.value.streamingData);

    // Strip ad state from the patched modern playerResponse to avoid
    // inconsistent state: modern ad-eligible object + target non-SABR stream.
    const adStateBeforeStrip = summarizeAdState(modernPlayer.value);
    stripPlayerAdState(modernPlayer.value);
    const adStateAfterStrip = summarizeAdState(modernPlayer.value);

    const patchedSummary = summarizePlayerResponse(modernPlayer.value);

    // Require the patch to be usable AND ad-state to be fully clean.
    if (
      !targetResult.ok ||
      !targetPlayer ||
      !modernPlayer?.value ||
      !playerSummaryIsUsable(patchedSummary) ||
      patchedSummary.hasSabr ||
      adStateAfterStrip.playerAds !== 0 ||
      adStateAfterStrip.adSlots !== 0 ||
      adStateAfterStrip.hasAdBreakHeartbeatParams
    ) {
      counters.fallback++;
      counters.lastReason = "patched-container-ad-state-not-clean";

      remember({
        event: "fallback-container-patch",
        transport: meta.transport,
        endpoint,
        reason: counters.lastReason,
        sourceMode: lastTargetResult?.sourceMode || "",
        targetProfile: lastTargetResult?.targetProfile || getTargetProfile().key,
        targetClientName: lastTargetResult?.targetClientName || getTargetProfile().clientName,
        targetClientVersion: lastTargetResult?.targetClientVersion || getTargetProfile().clientVersion,
        targetHttpStatus: lastTargetResult?.httpStatus || 0,
        targetNestedPlayerCount: lastTargetResult?.endpointSummary?.nestedPlayerCount || 0,
        targetBestUsable: !!targetPlayer,
        requestVideoId: wantedVideoId,
        pageVideoId: getCurrentPageVideoId(),
        targetBestPath: targetPlayer?.path || "",
        targetPath: targetPlayer?.path || "",
        modernPath: modernPlayer.path,
        adStateBeforeStrip,
        adStateAfterStrip,
        patchedSummary,
        targetSelectionMode,
        classicPatchMode: config.classicPatchMode,
      });

      return originalResp;
    }

    counters.success++;
    counters.lastReason = "container-patched";
    countSuccessEndpoint(endpoint);

    if (meta.transport === "fetch") counters.successFetch++;
    if (meta.transport === "xhr") counters.successXhr++;

    remember({
      event: "container-patch",
      transport: meta.transport,
      endpoint,
      sourceMode: targetResult.sourceMode,
      targetProfile: targetResult.targetProfile,
      targetClientName: targetResult.targetClientName,
      targetClientVersion: targetResult.targetClientVersion,
      targetClientHeaderName: targetResult.targetClientHeaderName,
      requestVideoId: wantedVideoId,
      pageVideoId: getCurrentPageVideoId(),
      targetHttpStatus: targetResult.httpStatus,
      targetDurationMs: targetResult.durationMs,
      targetPath: targetPlayer.path,
      modernPath: modernPlayer.path,
      targetSelectionMode,
      targetStreamingDetails: targetPlayer.streamingDetails || null,
      targetOriginalSummary: targetPlayer.originalSummary || null,
      targetSummary: targetPlayer.summary,
      patchedSummary,
      adStateBeforeStrip,
      adStateAfterStrip,
      classicPatchMode: config.classicPatchMode,
    });

    lastPatch = {
      time: performance.now(),
      targetProfile: targetResult.targetProfile,
      sourceMode: targetResult.sourceMode,
      requestVideoId: wantedVideoId,
    };

    setTimeout(() => {
      remember({
        event: "video-state-after-patch",
        delayMs: 1000,
        recentPatch: lastPatch,
        videoState: summarizeVideoElementState(),
      });
    }, 1000);

    setTimeout(() => {
      remember({
        event: "video-state-after-patch",
        delayMs: 5000,
        recentPatch: lastPatch,
        videoState: summarizeVideoElementState(),
      });
    }, 5000);

    return makeJsonResponseFromOriginal(originalResp, originalJson);
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
      targetProfile: getTargetProfile().key,
      targetClientName: getTargetProfile().clientName,
      targetClientVersion: getTargetProfile().clientVersion,
      targetClientHeaderName: getTargetProfile().clientHeaderName,
      bodyType: meta.bodyType,
      bodyTextLength: meta.bodyTextLength,
      topKeys: meta.bodyJson ? Object.keys(meta.bodyJson).slice(0, 40) : [],
    });

    const result = await fetchTargetClientEndpoint(meta);
    const ok = validReplacement(result);

    remember({
      event: ok ? "replace" : "fallback",
      transport: meta.transport,
      endpoint,
      videoId: meta.bodyJson?.videoId || "",
      httpStatus: result.httpStatus,
      durationMs: result.durationMs,
      gzip: result.gzip,
      sourceMode: result.sourceMode,
      targetProfile: result.targetProfile,
      targetClientName: result.targetClientName,
      targetClientVersion: result.targetClientVersion,
      targetClientHeaderName: result.targetClientHeaderName,
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
      const rawUrl =
        input instanceof Request
          ? input.url
          : typeof input === "string" || input instanceof URL
            ? String(input)
            : String(input?.url || "");

      if (config.logMediaErrors && isMediaUrl(rawUrl)) {
        const resp = await nativeFetch.apply(this, arguments);
        const recentPatchAgeMs = performance.now() - lastPatch.time;
        const maybeFromPatch =
          !!lastPatch.targetProfile &&
          Number.isFinite(recentPatchAgeMs) &&
          recentPatchAgeMs >= 0 &&
          recentPatchAgeMs < 15000;

        if (!resp.ok) {
          remember({
            event: "media-error",
            status: resp.status,
            statusText: resp.statusText,
            activeTargetProfile: getTargetProfile().key,
            classicPatchMode: config.classicPatchMode,
            maybeFromPatch,
            recentPatchAgeMs: Math.round(recentPatchAgeMs),
            recentPatch: maybeFromPatch ? lastPatch : null,
            ...summarizeMediaUrl(rawUrl),
          });
        } else {
          remember({
            event: "media-ok",
            status: resp.status,
            activeTargetProfile: getTargetProfile().key,
            classicPatchMode: config.classicPatchMode,
            maybeFromPatch,
            recentPatchAgeMs: Math.round(recentPatchAgeMs),
            recentPatch: maybeFromPatch ? lastPatch : null,
            ...summarizeMediaUrl(rawUrl),
          });
        }

        return resp;
      }

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

      const endpoint = meta.endpoint || endpointForUrl(meta.url);

      // get_watch and next are container-patch endpoints, not replacement endpoints.
      if (endpoint === "get_watch" || endpoint === "next") {
        return await tryPatchContainerResponse(meta, input, init);
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
      "x-chroma-source-swap: target-client",
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
        if (lower === "x-chroma-source-swap") return "target-client";
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

        const endpoint = meta.endpoint || endpointForUrl(meta.url);

        // Container patching requires a real fetch-based original response; XHR path is not supported.
        if (endpoint === "get_watch" || endpoint === "next") {
          counters.ignored++;
          counters.lastReason = "container-patch-fetch-only";

          remember({
            event: "ignored-container-xhr",
            transport: "xhr",
            endpoint,
            reason: "container-patch-fetch-only",
          });

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
    profiles: CLIENT_PROFILES,
    counters,
    events,

    setProfile(key) {
      if (!CLIENT_PROFILES[key]) {
        console.warn("[yt-source-swap] unknown profile", key, Object.keys(CLIENT_PROFILES));
        return false;
      }

      config.targetProfile = key;
      console.log("[yt-source-swap] target profile set", key, CLIENT_PROFILES[key]);
      return true;
    },

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

    videoState() {
      const state = summarizeVideoElementState();
      console.log("[yt-source-swap] videoState", state);
      return state;
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
