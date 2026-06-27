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

    webCreator: {
      key: "webCreator",
      clientName: "WEB_CREATOR",
      clientVersion: "1.20260625.01.00",
      clientHeaderName: "62",
      notes: "Probe found classic adaptive direct URL pairs",
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
    classicPatchMode: "mweb-progressive-auto",
    allowCipherUrlWithoutDecipher: false,
    patchPolicy: "always",
    hybridStartup: {
      enabled: true,
      handoffAtSeconds: 5,
      handoffCooldownMs: 30000,
      autoHandoff: true,
      warmupMaxWaitMs: 12000,
    },
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

  const handoffState = {
    attemptedByVideoId: new Map(),
    pendingTimer: null,
    activeVideoId: "",
    activePatchVideoId: "",
    inProgress: false,

    warmupByVideoId: new Map(),

    replay: {
      armed: false,
      videoId: "",
      expiresAt: 0,
      playerJson: null,
      nextJson: null,
      playerHits: 0,
      nextHits: 0,
      startedAt: 0,
      resumeAt: 0,
    },
  };

  const HYBRID_SESSION_KEY = "__yt_source_swap_hybrid_handoff__";

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

  function getCurrentUrlVideoId() {
    try {
      return new URL(location.href).searchParams.get("v") || "";
    } catch {
      return "";
    }
  }

  function getCurrentEffectiveVideoId() {
    return getCurrentUrlVideoId() || getCurrentPageVideoId() || "";
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

  function getMoviePlayer() {
    return (
      document.getElementById("movie_player") ||
      document.querySelector("#movie_player") ||
      document.querySelector("ytd-player #movie_player") ||
      null
    );
  }

  function isVisiblePatchedMweb360Source() {
    const v = document.querySelector("video");
    const src = String(v?.currentSrc || "");

    if (!v || !src) return false;
    if (!/googlevideo\.com\/videoplayback/i.test(src)) return false;

    let url = null;

    try {
      url = new URL(src);
    } catch {
      return false;
    }

    const itag = url.searchParams.get("itag") || "";
    const hasSabr =
      url.searchParams.has("sabr") ||
      /(?:[?&]|%26)sabr(?:=|%3D)1/i.test(src);

    return itag === "18" && !hasSabr;
  }

  function scheduleFocusedPatchedPlaybackStart(videoId, reason = "patched-mweb-360-ready") {
    const delays = [250, 750, 1500, 2500];

    for (const delayMs of delays) {
      setTimeout(() => {
        const currentVideoId = getCurrentEffectiveVideoId();
        if (videoId && currentVideoId && currentVideoId !== videoId) return;

        const player = getMoviePlayer();
        const v = document.querySelector("video");

        const playerState =
          player && typeof player.getPlayerState === "function"
            ? player.getPlayerState()
            : null;

        const isPatchedMweb360 = isVisiblePatchedMweb360Source();

        remember({
          event: "patched-playback-start-check",
          reason,
          delayMs,
          videoId,
          currentVideoId,
          playerState,
          isPatchedMweb360,
          videoState: summarizeVideoElementState(),
        });

        if (!player || typeof player.playVideo !== "function") return;
        if (!v) return;
        if (!v.paused) return;
        if (v.error) return;
        if (!isPatchedMweb360) return;

        try {
          player.playVideo();

          remember({
            event: "patched-playback-start-attempt",
            reason,
            delayMs,
            videoId,
            currentVideoId,
            playerState,
            videoState: summarizeVideoElementState(),
          });
        } catch (err) {
          remember({
            event: "patched-playback-start-failed",
            reason,
            delayMs,
            videoId,
            currentVideoId,
            error: `${err?.name || "Error"}: ${err?.message || String(err)}`,
            videoState: summarizeVideoElementState(),
          });
        }
      }, delayMs);
    }
  }

  function playerEndpointUrl() {
    return `${location.origin}/youtubei/v1/player?prettyPrint=false`;
  }

  function nextEndpointUrl() {
    return `${location.origin}/youtubei/v1/next?prettyPrint=false`;
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

  function buildNextReplayFromContainerBody(bodyJson) {
    const source =
      bodyJson?.watchNextRequest ||
      bodyJson?.nextRequest ||
      bodyJson?.watchNextEndpoint ||
      null;

    if (!source || typeof source !== "object") {
      return null;
    }

    const nextBody = cloneJson(source);

    if (!nextBody.context) {
      nextBody.context = cloneJson(bodyJson.context || {});
    }

    if (!nextBody.context?.client && bodyJson.context?.client) {
      nextBody.context = nextBody.context || {};
      nextBody.context.client = cloneJson(bodyJson.context.client);
    }

    return nextBody;
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

  function makeOriginalClientWarmupHeaders(originalHeaders, bodyJson, { gzip }) {
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

    if (client.clientVersion && !headers.has("x-youtube-client-version")) {
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

  function isClassicNonSabrUrl(url) {
    return !!url && !/(?:[?&]|%26)sabr(?:=|%3D)1/i.test(String(url));
  }

  function hasDirectClassicUrl(format) {
    return isClassicNonSabrUrl(format?.url || "");
  }

  function getFormatItag(format) {
    return String(format?.itag || "");
  }

  function isItag18(format) {
    return getFormatItag(format) === "18";
  }

  function getCipherString(format) {
    return format?.signatureCipher || format?.cipher || "";
  }

  function hasRawClassicCipher(format) {
    const cipher = getCipherString(format);
    if (!cipher) return false;

    const parsed = parseCipherString(cipher);
    return isClassicNonSabrUrl(parsed.url);
  }

  function hasDirectClassicUrlOrCipher(format) {
    return hasDirectClassicUrl(format) || hasRawClassicCipher(format);
  }

  function classifyProgressiveCandidate(format) {
    if (!isItag18(format)) return "";

    if (hasDirectClassicUrl(format)) {
      return "direct-url";
    }

    if (hasRawClassicCipher(format)) {
      return "raw-cipher";
    }

    return "";
  }

  function hasMwebProgressiveAutoCandidate(streamingData) {
    const formats = Array.isArray(streamingData?.formats) ? streamingData.formats : [];

    return formats.some(format =>
      classifyProgressiveCandidate(format) === "direct-url" ||
      classifyProgressiveCandidate(format) === "raw-cipher"
    );
  }

  function hasPatchedProgressiveAutoCandidate(streamingData) {
    const formats = Array.isArray(streamingData?.formats) ? streamingData.formats : [];

    return (
      formats.length === 1 &&
      formats.some(format =>
        classifyProgressiveCandidate(format) === "direct-url" ||
        classifyProgressiveCandidate(format) === "raw-cipher"
      )
    );
  }

  function cloneMwebProgressiveAutoStreamingData(streamingData) {
    const clean = cloneJson(streamingData || {});

    delete clean.serverAbrStreamingUrl;
    delete clean.sabrStreamingUrl;
    delete clean.serverAbrStreamingUrlConfig;

    const formats = Array.isArray(clean.formats) ? clean.formats : [];

    const direct = formats.find(format =>
      classifyProgressiveCandidate(format) === "direct-url"
    );

    const rawCipher = formats.find(format =>
      classifyProgressiveCandidate(format) === "raw-cipher"
    );

    const selected = direct || rawCipher || null;

    const selection = {
      selectedMode: direct ? "direct-url" : rawCipher ? "raw-cipher" : "",
      selectedItag: selected ? String(selected.itag || "") : "",
      hadDirectCandidate: !!direct,
      hadRawCipherCandidate: !!rawCipher,
    };

    clean.formats = selected ? [cloneJson(selected)] : [];
    clean.adaptiveFormats = [];

    return {
      streamingData: clean,
      selection,
    };
  }

  function makeSyntheticPlayerWithStreamingData(basePlayer, streamingData) {
    const cloned = cloneJson(basePlayer || {});
    let sourceSwapSelection = null;

    const result = cloneMwebProgressiveAutoStreamingData(streamingData);
    cloned.streamingData = result.streamingData;
    sourceSwapSelection = result.selection;

    return {
      player: cloned,
      sourceSwapSelection,
    };
  }

  function hasSelectedProgressiveItag18(streamingData) {
    const formats = Array.isArray(streamingData?.formats) ? streamingData.formats : [];

    return (
      formats.length === 1 &&
      formats.some(format => {
        const kind = classifyProgressiveCandidate(format);
        return kind === "direct-url" || kind === "raw-cipher";
      })
    );
  }

  function hasMeaningfulAdState(adState) {
    return (
      adState.playerAds > 0 ||
      adState.adPlacements > 0 ||
      adState.adSlots > 0 ||
      adState.hasAdBreakHeartbeatParams ||
      adState.hasAdBreakParams ||
      adState.hasAdInferredBlockingStatus
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

      const canUseAuto = hasMwebProgressiveAutoCandidate(streamingData);

      if (!details.hasAnyClassicUrl && !canUseAuto) {
        continue;
      }

      const syntheticResult = makeSyntheticPlayerWithStreamingData(match.value, streamingData);
      const synthetic = syntheticResult.player;
      const sourceSwapSelection = syntheticResult.sourceSwapSelection;
      const summary = summarizePlayerResponse(synthetic);

      const baseUsable = playerSummaryIsUsable(summary);

      const progressiveAutoOk =
        summary.status === "OK" &&
        !summary.hasSabr &&
        !summary.hasServerAbr &&
        hasPatchedProgressiveAutoCandidate(synthetic.streamingData);

      const acceptedBy =
        progressiveAutoOk
          ? "progressiveAutoOk"
          : baseUsable
            ? "playerSummaryIsUsable"
            : "";

      if (acceptedBy) {
        return {
          path: match.path,
          value: synthetic,
          summary,
          originalSummary: match.summary,
          streamingDetails: details,
          mode: "mweb-progressive-auto",
          acceptedBy,
          sourceSwapSelection,
        };
      }
    }

    return null;
  }

  function selectTargetPlayerForCurrentMode(root, wantedVideoId = "") {
    let targetPlayer = findBestUsablePlayerObjectForVideo(root, wantedVideoId);
    let targetSelectionMode = "direct-usable";

    if (!targetPlayer && config.allowClassicOnlyFromSabrTargets) {
      const classicOnlyTarget = findClassicOnlyCandidateForVideo(root, wantedVideoId);

      if (classicOnlyTarget) {
        targetPlayer = classicOnlyTarget;
        targetSelectionMode = classicOnlyTarget.mode;
      }
    }

    return {
      targetPlayer,
      targetSelectionMode,
    };
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

  function isHybridStartupMode() {
    return !!config.hybridStartup?.enabled;
  }

  function readPersistedHybridHandoff() {
    try {
      const raw = sessionStorage.getItem(HYBRID_SESSION_KEY);
      if (!raw) return null;

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;

      return {
        videoId: String(parsed.videoId || ""),
        expiresAt: Number(parsed.expiresAt || 0),
        resumeAt: Number(parsed.resumeAt || 0),
        createdAt: Number(parsed.createdAt || 0),
      };
    } catch {
      return null;
    }
  }

  function clearPersistedHybridHandoff() {
    try {
      sessionStorage.removeItem(HYBRID_SESSION_KEY);
    } catch {}
  }

  clearPersistedHybridHandoff();

  function persistHybridHandoff(videoId, resumeAt) {
    if (!videoId) return;

    const now = Date.now();
    const ttlMs = Number(config.hybridStartup?.handoffCooldownMs || 30000);

    try {
      sessionStorage.setItem(HYBRID_SESSION_KEY, JSON.stringify({
        videoId,
        resumeAt: Number(resumeAt || 0),
        createdAt: now,
        expiresAt: now + ttlMs,
      }));
    } catch {}
  }

  function getActivePersistedHybridBypass(videoId) {
    const persisted = readPersistedHybridHandoff();

    if (!persisted?.videoId) return null;

    if (Date.now() > persisted.expiresAt) {
      clearPersistedHybridHandoff();
      return null;
    }

    if (videoId && persisted.videoId !== videoId) {
      return null;
    }

    return persisted;
  }

  function getWatchUrlWithTimestamp(videoId, seconds) {
    const url = new URL(location.href);
    url.pathname = "/watch";
    url.searchParams.set("v", videoId);
    url.searchParams.set("t", `${Math.max(0, Math.floor(seconds))}s`);
    return url.toString();
  }

  function hasHandoffRecently(videoId) {
    if (!videoId) return false;

    const persisted = getActivePersistedHybridBypass(videoId);
    if (persisted) return true;

    if (!handoffState.attemptedByVideoId.has(videoId)) {
      return false;
    }

    const last = handoffState.attemptedByVideoId.get(videoId);
    const age = performance.now() - last;

    return age >= 0 && age < Number(config.hybridStartup.handoffCooldownMs || 30000);
  }

  function markHandoffAttempted(videoId) {
    if (!videoId) return;
    handoffState.attemptedByVideoId.set(videoId, performance.now());
  }

  function clearHandoffTimer() {
    if (handoffState.pendingTimer) {
      clearInterval(handoffState.pendingTimer);
      handoffState.pendingTimer = null;
    }
  }

  function startHybridWebWarmup(meta, videoId) {
    if (!isHybridStartupMode()) return null;
    if (!videoId) return null;

    const existing = handoffState.warmupByVideoId.get(videoId);
    if (existing) return existing;

    const record = {
      videoId,
      startedAt: performance.now(),
      completedAt: 0,
      complete: false,
      ok: false,
      error: "",
      results: [],
    };

    handoffState.warmupByVideoId.set(videoId, record);

    remember({
      event: "hybrid-warmup-start",
      videoId,
      endpoint: meta.endpoint || endpointForUrl(meta.url),
      hasPlayerRequest: !!meta.bodyJson?.playerRequest,
      pageVideoId: getCurrentPageVideoId(),
      urlVideoId: getCurrentUrlVideoId(),
      effectiveVideoId: getCurrentEffectiveVideoId(),
    });

    queueMicrotask(async () => {
      try {
        const results = [];

        const playerBody = meta.bodyJson?.playerRequest
          ? buildPlayerReplayFromContainerBody(meta.bodyJson)
          : null;

        const nextBody = buildNextReplayFromContainerBody(meta.bodyJson);

        if (playerBody) {
          const playerWarmup = await fetchOriginalClientWarmupEndpoint(meta, {
            sourceMode: "web-player-from-container-warmup",
            url: playerEndpointUrl(),
            bodyJson: playerBody,
          });

          results.push(playerWarmup);
        }

        if (nextBody) {
          const nextWarmup = await fetchOriginalClientWarmupEndpoint(meta, {
            sourceMode: "web-next-from-container-warmup",
            url: nextEndpointUrl(),
            bodyJson: nextBody,
          });

          results.push(nextWarmup);
        }

        if (!playerBody && !nextBody) {
          const sameEndpointWarmup = await fetchOriginalClientWarmupEndpoint(meta, {
            sourceMode: "web-same-endpoint-warmup",
            url: meta.url,
            bodyJson: meta.bodyJson,
          });

          results.push(sameEndpointWarmup);
        }

        record.results = results;
        record.ok = results.some(result => result.ok);
        record.complete = true;
        record.completedAt = performance.now();

        remember({
          event: "hybrid-warmup-complete",
          videoId,
          ok: record.ok,
          durationMs: Math.round(record.completedAt - record.startedAt),
          results,
        });
      } catch (err) {
        record.ok = false;
        record.complete = true;
        record.completedAt = performance.now();
        record.error = `${err?.name || "Error"}: ${err?.message || String(err)}`;

        remember({
          event: "hybrid-warmup-error",
          videoId,
          durationMs: Math.round(record.completedAt - record.startedAt),
          error: record.error,
        });
      }
    });

    return record;
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function attemptAggressiveWarmReplayHandoff(videoId, warmup) {
    const effectiveId = getCurrentEffectiveVideoId();
    if (effectiveId && effectiveId !== videoId) {
      return { attempted: false, ok: false, reason: "video-changed" };
    }

    const playerWarmup = (warmup?.results || []).find(r =>
      r?.ok && r?.json && (r.sourceMode || "").includes("player")
    );

    const nextWarmup = (warmup?.results || []).find(r =>
      r?.ok && r?.json && (r.sourceMode || "").includes("next")
    );

    if (!playerWarmup?.json) {
      remember({
        event: "aggressive-handoff-not-available",
        reason: "no-warmed-player-json",
        videoId,
        warmupResults: warmup?.results || [],
        videoState: summarizeVideoElementState(),
      });

      return { attempted: false, ok: false, reason: "no-warmed-player-json" };
    }

    const playerJson = cloneJson(playerWarmup.json);

    try {
      stripPlayerAdState(playerJson);
      const players = findPlayerLikeObjects(playerJson);
      for (const p of players) {
        if (p.value) stripPlayerAdState(p.value);
      }
    } catch {}

    handoffState.replay.armed = true;
    handoffState.replay.videoId = videoId;
    handoffState.replay.expiresAt = performance.now() + 8000;
    handoffState.replay.playerJson = playerJson;
    handoffState.replay.nextJson = nextWarmup?.json ? cloneJson(nextWarmup.json) : null;
    handoffState.replay.playerHits = 0;
    handoffState.replay.nextHits = 0;
    handoffState.replay.startedAt = performance.now();
    handoffState.replay.resumeAt = Number(document.querySelector("video")?.currentTime || 0);

    remember({
      event: "aggressive-handoff-armed",
      videoId,
      resumeAt: handoffState.replay.resumeAt,
      hasPlayerJson: !!handoffState.replay.playerJson,
      hasNextJson: !!handoffState.replay.nextJson,
      videoState: summarizeVideoElementState(),
    });

    const player = getMoviePlayer();
    const resumeAt = handoffState.replay.resumeAt;

    remember({
      event: "aggressive-handoff-start",
      videoId,
      resumeAt,
      videoState: summarizeVideoElementState(),
    });

    if (player && typeof player.loadVideoById === "function") {
      try {
        player.loadVideoById({
          videoId,
          startSeconds: Math.max(0, resumeAt),
          suggestedQuality: "hd720",
        });

        remember({
          event: "aggressive-loadVideoById-called",
          videoId,
          resumeAt,
          videoState: summarizeVideoElementState(),
        });
      } catch (err) {
        remember({
          event: "aggressive-loadVideoById-failed",
          videoId,
          resumeAt,
          error: `${err?.name || "Error"}: ${err?.message || String(err)}`,
          videoState: summarizeVideoElementState(),
        });

        handoffState.replay.armed = false;

        return { attempted: true, ok: false, reason: "loadVideoById-failed" };
      }
    } else {
      remember({
        event: "aggressive-handoff-failed",
        reason: "no-loadVideoById",
        videoId,
        videoState: summarizeVideoElementState(),
      });

      handoffState.replay.armed = false;

      return { attempted: true, ok: false, reason: "no-loadVideoById" };
    }

    const probeDelays = [250, 750, 1500, 3000, 6000];

    for (const delayMs of probeDelays) {
      await delay(delayMs - (probeDelays.indexOf(delayMs) ? probeDelays[probeDelays.indexOf(delayMs) - 1] : 0));

      remember({
        event: "aggressive-handoff-probe",
        videoId,
        delayMs,
        replayState: {
          armed: handoffState.replay.armed,
          playerHits: handoffState.replay.playerHits,
          nextHits: handoffState.replay.nextHits,
        },
        videoState: summarizeVideoElementState(),
      });
    }

    remember({
      event: "aggressive-handoff-complete",
      videoId,
      replayState: {
        playerHits: handoffState.replay.playerHits,
        nextHits: handoffState.replay.nextHits,
      },
      videoState: summarizeVideoElementState(),
    });

    return {
      attempted: true,
      ok: true,
      reason: "aggressive-warm-replay-handoff-tested",
    };
  }

  function scheduleBackgroundWarmupReadyCheck(videoId) {
    if (!isHybridStartupMode()) return;
    if (!videoId) return;
    if (handoffState.inProgress) return;

    clearHandoffTimer();

    handoffState.activePatchVideoId = videoId;

    remember({
      event: "background-warmup-ready-check-scheduled",
      videoId,
      handoffAtSeconds: config.hybridStartup.handoffAtSeconds,
      pageVideoId: getCurrentPageVideoId(),
      urlVideoId: getCurrentUrlVideoId(),
      effectiveVideoId: getCurrentEffectiveVideoId(),
    });

    handoffState.pendingTimer = setInterval(async () => {
      const v = document.querySelector("video");
      const pageVideoId = getCurrentPageVideoId();
      const urlVideoId = getCurrentUrlVideoId();
      const effectiveVideoId = getCurrentEffectiveVideoId();

      if (!v) return;

      if (effectiveVideoId && effectiveVideoId !== videoId) {
        clearHandoffTimer();
        remember({
          event: "hybrid-handoff-cancelled",
          reason: "video-changed",
          scheduledVideoId: videoId,
          pageVideoId,
          urlVideoId,
          effectiveVideoId,
        });
        return;
      }

      if (v.error) {
        clearHandoffTimer();
        remember({
          event: "hybrid-handoff-cancelled",
          reason: "video-error-before-handoff",
          videoId,
          videoState: summarizeVideoElementState(),
        });
        return;
      }

      const currentTime = Number(v.currentTime || 0);
      const readyState = Number(v.readyState || 0);
      const targetSeconds = Number(config.hybridStartup.handoffAtSeconds || 5);

      if (readyState < 2 || currentTime < targetSeconds) {
        return;
      }

      const warmup = handoffState.warmupByVideoId.get(videoId);
      const warmupAgeMs = warmup
        ? Math.round(performance.now() - warmup.startedAt)
        : 0;

      if (!warmup || !warmup.complete) {
        const maxWaitMs = Number(config.hybridStartup?.warmupMaxWaitMs || 12000);

        if (warmupAgeMs < maxWaitMs) {
          if (!warmup?.waitingLogged) {
            if (warmup) warmup.waitingLogged = true;

            remember({
              event: "hybrid-handoff-waiting-for-warmup",
              videoId,
              warmupAgeMs,
              maxWaitMs,
              videoState: summarizeVideoElementState(),
            });
          }

          return;
        }

        clearHandoffTimer();

        remember({
          event: "hybrid-handoff-cancelled",
          reason: "warmup-timeout",
          videoId,
          warmupAgeMs,
          maxWaitMs,
          videoState: summarizeVideoElementState(),
        });

        return;
      }

      if (!warmup.ok) {
        clearHandoffTimer();

        remember({
          event: "hybrid-handoff-cancelled",
          reason: "warmup-failed",
          videoId,
          warmup,
          videoState: summarizeVideoElementState(),
        });

        return;
      }

      remember({
        event: "background-warmup-ready",
        videoId,
        warmupAgeMs,
        warmupDurationMs: warmup.completedAt
          ? Math.round(warmup.completedAt - warmup.startedAt)
          : null,
        warmupResults: warmup.results,
      });

      clearHandoffTimer();

      handoffState.inProgress = false;

      remember({
        event: "web-warmup-ready",
        videoId,
        warmupResults: warmup.results,
        videoState: summarizeVideoElementState(),
      });

      const swapResult = await attemptAggressiveWarmReplayHandoff(videoId, warmup);

      if (swapResult.attempted && swapResult.ok) {
        remember({
          event: "source-swap-attempted",
          reason: swapResult.reason || "direct-video-src-swap",
          videoId,
          videoState: summarizeVideoElementState(),
        });
      } else if (swapResult.attempted && !swapResult.ok) {
        remember({
          event: "source-swap-failed",
          reason: swapResult.reason || swapResult.error || "unknown",
          videoId,
          videoState: summarizeVideoElementState(),
        });
      } else {
        remember({
          event: "source-swap-not-attempted",
          reason: swapResult.reason || "no-true-seamless-swap-implemented",
          videoId,
          videoState: summarizeVideoElementState(),
        });
      }
    }, 250);
  }

  async function fetchOriginalClientWarmupEndpoint(meta, options = {}) {
    const targetUrl = options.url || meta.url;
    const sourceBodyJson = options.bodyJson || meta.bodyJson;
    const sourceMode = options.sourceMode || "same-endpoint";
    const bodyText = JSON.stringify(sourceBodyJson);

    let gzip = true;
    let body = await gzipString(bodyText);

    if (!body) {
      gzip = false;
      body = bodyText;
    }

    const headers = makeOriginalClientWarmupHeaders(meta.rawHeaders, sourceBodyJson, {
      gzip,
    });

    const started = performance.now();

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
      httpStatus: resp.status,
      statusText: resp.statusText,
      ok: resp.ok,
      durationMs: Math.round(performance.now() - started),
      gzip,
      json,
      responseText: json ? JSON.stringify(json) : text,
      summary: endpointSummary.direct,
      endpointSummary,
      hasServerAbr: !!endpointSummary?.direct?.hasServerAbr,
      hasSabr: !!endpointSummary?.direct?.hasSabr,
      hasStreamingData: !!endpointSummary?.direct?.hasStreamingData,
      textPreview: json ? "" : text.slice(0, 300),
    };
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

    const sourceVideoId = getBodyVideoId(meta.bodyJson) || getCurrentPageVideoId();
    const persistedHybridBypass = getActivePersistedHybridBypass(sourceVideoId);

    if (persistedHybridBypass) {
      return [false, "hybrid-persisted-bypass-after-handoff"];
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

    let lastTargetPlayer = null;

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
      patchPolicy: config.patchPolicy,
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

    let selectedTarget = selectTargetPlayerForCurrentMode(targetResult.json, wantedVideoId);
    let targetPlayer = selectedTarget.targetPlayer;
    let targetSelectionMode = selectedTarget.targetSelectionMode;

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

        const selectedPlayerTarget = selectTargetPlayerForCurrentMode(playerResult.json, wantedVideoId);
        let playerTarget = selectedPlayerTarget.targetPlayer;

        if (playerTarget) {
          targetSelectionMode = selectedPlayerTarget.targetSelectionMode;
        }

        const firstPlayerTarget = findFirstPlayerObject(playerResult.json);
        lastTargetPlayer = firstPlayerTarget || null;
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

    // Compute modern ad state before mutating streamingData.
    const adStateBeforeStrip = summarizeAdState(modernPlayer.value);

    if (
      config.patchPolicy === "ad-state-only" &&
      !hasMeaningfulAdState(adStateBeforeStrip)
    ) {
      counters.fallback++;
      counters.lastReason = "patch-policy-no-ad-state";

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
        targetSelectionMode,
        classicPatchMode: config.classicPatchMode,
      });

      return originalResp;
    }

    // Patch only after policy passes.
    modernPlayer.value.streamingData = cloneJson(targetPlayer.value.streamingData);
    stripPlayerAdState(modernPlayer.value);
    const adStateAfterStrip = summarizeAdState(modernPlayer.value);

    const patchedSummary = summarizePlayerResponse(modernPlayer.value);

    const patchedProgressiveFallbackOk =
      patchedSummary.status === "OK" &&
      !patchedSummary.hasSabr &&
      !patchedSummary.hasServerAbr &&
      hasSelectedProgressiveItag18(modernPlayer.value.streamingData);

    const patchedUsable =
      patchedProgressiveFallbackOk ||
      playerSummaryIsUsable(patchedSummary);

    // Require the patch to be usable AND ad-state to be fully clean.
    if (
      !targetResult.ok ||
      !targetPlayer ||
      !modernPlayer?.value ||
      !patchedUsable ||
      patchedSummary.hasSabr ||
      patchedSummary.hasServerAbr ||
      adStateAfterStrip.playerAds !== 0 ||
      adStateAfterStrip.adSlots !== 0 ||
      adStateAfterStrip.hasAdBreakHeartbeatParams
    ) {
      counters.fallback++;
      counters.lastReason = "patched-response-invalid";

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
      progressiveAutoSelection: targetPlayer.sourceSwapSelection || null,
      acceptedBy: targetPlayer.acceptedBy || "",
    });

    scheduleFocusedPatchedPlaybackStart(wantedVideoId || getCurrentEffectiveVideoId());

    lastPatch = {
      time: performance.now(),
      targetProfile: targetResult.targetProfile,
      sourceMode: targetResult.sourceMode,
      requestVideoId: wantedVideoId,
      targetSelectionMode,
      classicPatchMode: config.classicPatchMode,
      patchPolicy: config.patchPolicy,
      progressiveAutoSelection: targetPlayer.sourceSwapSelection || null,
    };

    const patchSnapshot = cloneJson(lastPatch);

    setTimeout(() => {
      remember({
        event: "video-state-after-patch",
        delayMs: 1000,
        pageVideoId: getCurrentPageVideoId(),
        patchAgeMs: Number.isFinite(patchSnapshot.time)
          ? Math.round(performance.now() - patchSnapshot.time)
          : null,
        recentPatch: patchSnapshot,
        videoState: summarizeVideoElementState(),
      });
    }, 1000);

    setTimeout(() => {
      remember({
        event: "video-state-after-patch",
        delayMs: 5000,
        pageVideoId: getCurrentPageVideoId(),
        patchAgeMs: Number.isFinite(patchSnapshot.time)
          ? Math.round(performance.now() - patchSnapshot.time)
          : null,
        recentPatch: patchSnapshot,
        videoState: summarizeVideoElementState(),
      });
    }, 5000);

    if (
      isHybridStartupMode() &&
      config.hybridStartup.autoHandoff !== false &&
      config.classicPatchMode === "mweb-progressive-auto" &&
      targetPlayer.acceptedBy === "progressiveAutoOk"
    ) {
      startHybridWebWarmup(meta, wantedVideoId || getCurrentEffectiveVideoId());
    }

    if (
      isHybridStartupMode() &&
      config.hybridStartup.autoHandoff !== false &&
      config.classicPatchMode === "mweb-progressive-auto" &&
      targetPlayer.acceptedBy === "progressiveAutoOk"
    ) {
      scheduleBackgroundWarmupReadyCheck(wantedVideoId || getCurrentEffectiveVideoId());
    }

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

  function getRecentPatchInfo(maxAgeMs = 15000) {
    if (!lastPatch?.targetProfile || !Number.isFinite(lastPatch.time)) {
      return {
        maybeFromPatch: false,
        recentPatchAgeMs: null,
        recentPatch: null,
      };
    }

    const age = performance.now() - lastPatch.time;

    if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
      return {
        maybeFromPatch: false,
        recentPatchAgeMs: Number.isFinite(age) ? Math.round(age) : null,
        recentPatch: null,
      };
    }

    return {
      maybeFromPatch: true,
      recentPatchAgeMs: Math.round(age),
      recentPatch: cloneJson(lastPatch),
    };
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
        const patchInfo = getRecentPatchInfo();

        if (!resp.ok) {
          remember({
            event: "media-error",
            status: resp.status,
            statusText: resp.statusText,
            activeTargetProfile: getTargetProfile().key,
            classicPatchMode: config.classicPatchMode,
            ...patchInfo,
            ...summarizeMediaUrl(rawUrl),
          });
        } else {
          remember({
            event: "media-ok",
            status: resp.status,
            activeTargetProfile: getTargetProfile().key,
            classicPatchMode: config.classicPatchMode,
            ...patchInfo,
            ...summarizeMediaUrl(rawUrl),
          });
        }

        return resp;
      }

      meta = await readFetchMeta(input, init);

      if (
        handoffState.replay.armed &&
        performance.now() < handoffState.replay.expiresAt
      ) {
        const endpoint = meta.endpoint || endpointForUrl(meta.url);
        const requestVideoId = getBodyVideoId(meta.bodyJson);

        if (
          requestVideoId === handoffState.replay.videoId &&
          endpoint === "player" &&
          handoffState.replay.playerJson
        ) {
          handoffState.replay.playerHits++;

          remember({
            event: "aggressive-replay-hit",
            endpoint: "player",
            transport: meta.transport,
            videoId: handoffState.replay.videoId,
            ageMs: Math.round(performance.now() - handoffState.replay.startedAt),
          });

          return new Response(JSON.stringify(handoffState.replay.playerJson), {
            status: 200,
            statusText: "OK",
            headers: {
              "content-type": "application/json; charset=utf-8",
              "x-yt-source-swap-aggressive-replay": "player",
            },
          });
        }

        if (
          requestVideoId === handoffState.replay.videoId &&
          endpoint === "next" &&
          handoffState.replay.nextJson
        ) {
          handoffState.replay.nextHits++;

          remember({
            event: "aggressive-replay-hit",
            endpoint: "next",
            transport: meta.transport,
            videoId: handoffState.replay.videoId,
            ageMs: Math.round(performance.now() - handoffState.replay.startedAt),
          });

          return new Response(JSON.stringify(handoffState.replay.nextJson), {
            status: 200,
            statusText: "OK",
            headers: {
              "content-type": "application/json; charset=utf-8",
              "x-yt-source-swap-aggressive-replay": "next",
            },
          });
        }
      }

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

  let lastObservedVideoId = "";

  setInterval(() => {
    const current = getCurrentEffectiveVideoId();

    if (!current || current === lastObservedVideoId) return;

    const previous = lastObservedVideoId;
    lastObservedVideoId = current;

    if (previous && current !== previous) {
      clearHandoffTimer();
      handoffState.inProgress = false;
      handoffState.activeVideoId = current;

      remember({
        event: "hybrid-video-change",
        previousVideoId: previous,
        currentVideoId: current,
        pageVideoId: getCurrentPageVideoId(),
        urlVideoId: getCurrentUrlVideoId(),
      });
    }
  }, 500);

  g.fetch = sourceSwapFetch;

  g.__YT_SOURCE_SWAP_TEST__ = {
    config,
    profiles: CLIENT_PROFILES,
    counters,
    events,

    stats() {
      return {
        config: { ...config, endpoints: { ...config.endpoints } },
        counters: { ...counters },
        lastEvent: events[events.length - 1] || null,
      };
    },

    clear() {
      events.length = 0;

      for (const key of Object.keys(counters)) {
        if (typeof counters[key] === "number") counters[key] = 0;
        else counters[key] = "";
      }

      console.log("[yt-source-swap] cleared");

      lastPatch = {
        time: -Infinity,
        targetProfile: "",
        sourceMode: "",
        requestVideoId: "",
      };

      clearHandoffTimer();
      handoffState.inProgress = false;
      handoffState.activeVideoId = "";
      handoffState.activePatchVideoId = "";
      handoffState.warmupByVideoId.clear();
      handoffState.replay.armed = false;
      handoffState.replay.playerJson = null;
      handoffState.replay.nextJson = null;
    },

    clearHybridMemory() {
      handoffState.attemptedByVideoId.clear();
      handoffState.inProgress = false;
      clearHandoffTimer();
      clearPersistedHybridHandoff();
      handoffState.warmupByVideoId.clear();
      console.log("[yt-source-swap] cleared hybrid handoff memory");
    },

    hybridStatus() {
      const pageVideoId = getCurrentPageVideoId();
      const urlVideoId = getCurrentUrlVideoId();
      const effectiveVideoId = getCurrentEffectiveVideoId();
      const persisted = readPersistedHybridHandoff();

      return {
        pageVideoId,
        urlVideoId,
        effectiveVideoId,
        config: cloneJson(config.hybridStartup),
        handoffInProgress: handoffState.inProgress,
        activeVideoId: handoffState.activeVideoId,
        activePatchVideoId: handoffState.activePatchVideoId,
        persisted,
        persistedApplies: !!getActivePersistedHybridBypass(effectiveVideoId),
      };
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
