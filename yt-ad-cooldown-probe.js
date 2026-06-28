// yt-ad-cooldown-probe.js  v4
// Comprehensive browser telemetry probe for YouTube ad cooldown / frequency cap research.
//
// Monitors:
//   - All fetch/XMLHttpRequest traffic (categorised)
//   - PerformanceObserver resource timing (img, script, iframe, video, MSE, sendBeacon, etc.)
//   - navigator.sendBeacon (impression/tracking pings that bypass fetch/XHR)
//   - DOM player ad state (polling + MutationObserver)
//   - Document cookies (snapshots at key moments)
//   - sessionStorage / localStorage changes (patched setItem/removeItem/clear)
//   - Browser identity signals (sign-in, cookies, navigator fingerprint)
//   - Event causality chain: ad API → visual state → skip button → ad end → tracking → next delta
//
// Limitations (documented):
//   - document.cookie only sees non-HttpOnly cookies on the current domain.
//     It will NOT see HttpOnly cookies, cross-domain ad cookies, or response Set-Cookie headers.
//     A blank cookie diff does not mean no server-side identity state changed.
//   - DOM ad detection is heuristic ("visual ad suspicion"), not ground truth.
//     The overlap of multiple signals is what matters.
//   - Media URLs (googlevideo.com/videoplayback) are captured as URL/status only,
//     never with body, to avoid distorting timing.

(() => {
  const g = globalThis;

  if (g.__YT_AD_COOLDOWN_PROBE__?.stop) {
    g.__YT_AD_COOLDOWN_PROBE__.stop();
  }

  const nativeFetch = g.fetch;
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const nativeSendBeacon = navigator.sendBeacon;

  const nativeStorageSetItem = Storage.prototype.setItem;
  const nativeStorageRemoveItem = Storage.prototype.removeItem;
  const nativeStorageClear = Storage.prototype.clear;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8");

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  const config = {
    enabled: true,

    // Network interception
    interceptFetch: true,
    interceptXhr: true,

    // What to capture
    captureAllYoutubei: true,
    captureAdRelated: true,
    captureTracking: true,
    captureMedia: false,         // Media: URL + status only, NEVER body
    captureOther: false,

    // Response body capture (for youtubei/ad/tracking only; media is excluded)
    captureResponseBodies: true,
    maxResponseBodyLength: 60000,

    // Resource timing via PerformanceObserver
    resourceTiming: true,        // log non-fetch/XHR resource loads

    // navigator.sendBeacon hook
    hookSendBeacon: true,        // log sendBeacon calls (impression/tracking pings)

    // Real storage change monitoring
    hookStorage: true,           // patch setItem / removeItem / clear on both storages

    // Cookie snapshots
    cookieSnapshots: true,
    maxCookieSnapshots: 100,

    // Player state polling (ms, 0 to disable)
    playerPollMs: 500,
    playerPollMaxSnapshots: 1200, // 10 minutes at the default 500ms poll

    // DOM mutation watching for ad containers
    watchAdContainers: true,

    // Max events
    maxEvents: 1000,

    // Debounce
    cookieDebounceMs: 250,
    storageDebounceMs: 250,

    // Hands-off session recorder
    automation: {
      enabled: true,
      hud: true,
      hotkeys: true,
      autoCheckpoints: true,
      autoCheckpointDelayMs: 2500,
      maxCheckpoints: 80,
      downloadPrefix: "yt-ad-cooldown-probe",
      includeRelevantBodyJsonInDumps: true,
    },
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const events = [];
  const networkRows = [];
  const maxNetworkRows = 500;
  const cookieSnapshots = [];
  const playerStateSnapshots = [];
  const storageEvents = [];       // real-time storage change log
  const resourceEntries = [];     // PerformanceObserver resource log
  const maxResourceEntries = 300;
  let playerPollTimer = null;
  let lastCookieSnapshotTime = 0;
  let lastStorageSnapshotTime = 0;
  let adImpressionStartTime = 0;
  let currentAdId = "";
  let adTimeline = [];
  let currentVideoId = "";
  const automationCheckpoints = [];
  const automationState = {
    sessionId: makeSessionId(),
    pendingCheckpointTimer: null,
    pendingCheckpointReasons: [],
    hudRoot: null,
    hudShadow: null,
    hudStatusTimer: null,
    hudUpdateTimer: null,
    hotkeysInstalled: false,
    visible: true,
    lastAction: "installed",
    lastCheckpoint: null,
  };

  // Track the last ad-end time per videoId for delta calculation
  const lastAdEndByVideoId = {};

  // ---------------------------------------------------------------------------
  // URL classification
  // ---------------------------------------------------------------------------

  const URL_PATTERNS = {
    youtubeiPlayer: /\/youtubei\/v1\/player\b/,
    youtubeiGetWatch: /\/youtubei\/v1\/get_watch\b/,
    youtubeiNext: /\/youtubei\/v1\/next\b/,
    youtubeiBrowse: /\/youtubei\/v1\/browse\b/,
    youtubeiSearch: /\/youtubei\/v1\/search\b/,
    youtubeiGuide: /\/youtubei\/v1\/guide\b/,
    youtubeiLogEvent: /\/youtubei\/v1\/log_event\b/,
    youtubeiAttGet: /\/youtubei\/v1\/att\/get\b/,
    youtubeiConfig: /\/youtubei\/v1\/innertube_config\b/,
    youtubeiUpdatedMetadata: /\/youtubei\/v1\/updated_metadata\b/,
    youtubeiReelWatch: /\/youtubei\/v1\/reel\/reel_item_watch\b/,
    youtubeiAccount: /\/youtubei\/v1\/account\//,
    youtubeiNotification: /\/youtubei\/v1\/notification\//,
    youtubeiGeneral: /\/youtubei\//,

    adPagead: /\/pagead\//,
    adDoubleclick: /doubleclick\.net/i,
    adGoogleAds: /googleads\.g\.doubleclick/i,
    adPubads: /pubads\.g\.doubleclick/i,
    adGoogleSyndication: /google\.com\/syndication/i,
    adGoogleTagServices: /googletagservices\.com/i,

    trackingPtracking: /\/ptracking\b/,
    trackingStats: /\/api\/stats\//,
    tracking204: /\/generate_204\b/,
    trackingPlayback: /\/api\/stats\/playback\b/,
    trackingQoe: /\/api\/stats\/qoe\b/,
    trackingWatchtime: /\/api\/stats\/watchtime\b/,
    trackingDelayplay: /\/api\/stats\/delayplay\b/,
    trackingAtc: /\/api\/stats\/atc\b/,
    trackingAttribution: /\/youtubei\/v1\/attribution_link\b/,

    mediaGooglevideo: /googlevideo\.com\/videoplayback/i,
    mediaManifest: /\/manifest\//,

    identityAttestation: /\/attestation\b/,
    identityChallenge: /\/challenge\b/,
    identityServiceIntegrity: /\/youtubei\/v1\/get_authenticity_token\b/,

    otherXhr: /^https?:\/\//,
  };

  function isMediaUrl(s) {
    return URL_PATTERNS.mediaGooglevideo.test(s) || URL_PATTERNS.mediaManifest.test(s);
  }

  function isAdServingUrl(s) {
    return (
      URL_PATTERNS.adPagead.test(s) ||
      URL_PATTERNS.adDoubleclick.test(s) ||
      URL_PATTERNS.adGoogleAds.test(s) ||
      URL_PATTERNS.adPubads.test(s) ||
      URL_PATTERNS.adGoogleSyndication.test(s) ||
      URL_PATTERNS.adGoogleTagServices.test(s)
    );
  }

  function isTrackingUrl(s) {
    return (
      URL_PATTERNS.trackingPtracking.test(s) ||
      URL_PATTERNS.trackingStats.test(s) ||
      URL_PATTERNS.tracking204.test(s) ||
      URL_PATTERNS.trackingPlayback.test(s) ||
      URL_PATTERNS.trackingQoe.test(s) ||
      URL_PATTERNS.trackingWatchtime.test(s) ||
      URL_PATTERNS.trackingDelayplay.test(s) ||
      URL_PATTERNS.trackingAtc.test(s) ||
      URL_PATTERNS.trackingAttribution.test(s)
    );
  }

  function classifyRequest(url, method, bodyJson, responseJson) {
    const s = String(url || "");
    const categories = [];
    const subCategories = [];

    if (URL_PATTERNS.youtubeiPlayer.test(s))               { categories.push("youtubei"); subCategories.push("player"); }
    else if (URL_PATTERNS.youtubeiGetWatch.test(s))        { categories.push("youtubei"); subCategories.push("get_watch"); }
    else if (URL_PATTERNS.youtubeiNext.test(s))            { categories.push("youtubei"); subCategories.push("next"); }
    else if (URL_PATTERNS.youtubeiBrowse.test(s))          { categories.push("youtubei"); subCategories.push("browse"); }
    else if (URL_PATTERNS.youtubeiSearch.test(s))          { categories.push("youtubei"); subCategories.push("search"); }
    else if (URL_PATTERNS.youtubeiGuide.test(s))           { categories.push("youtubei"); subCategories.push("guide"); }
    else if (URL_PATTERNS.youtubeiLogEvent.test(s))        { categories.push("youtubei"); subCategories.push("log_event"); }
    else if (URL_PATTERNS.youtubeiAttGet.test(s))          { categories.push("youtubei"); subCategories.push("att_get"); }
    else if (URL_PATTERNS.youtubeiConfig.test(s))          { categories.push("youtubei"); subCategories.push("innertube_config"); }
    else if (URL_PATTERNS.youtubeiUpdatedMetadata.test(s)) { categories.push("youtubei"); subCategories.push("updated_metadata"); }
    else if (URL_PATTERNS.youtubeiReelWatch.test(s))       { categories.push("youtubei"); subCategories.push("reel_watch"); }
    else if (URL_PATTERNS.youtubeiAccount.test(s))         { categories.push("youtubei"); subCategories.push("account"); }
    else if (URL_PATTERNS.youtubeiNotification.test(s))    { categories.push("youtubei"); subCategories.push("notification"); }
    else if (URL_PATTERNS.youtubeiGeneral.test(s))         { categories.push("youtubei"); subCategories.push("other"); }

    if (isAdServingUrl(s)) categories.push("ad");

    if (isTrackingUrl(s)) categories.push("tracking");

    if (isMediaUrl(s)) categories.push("media");

    if (
      URL_PATTERNS.identityAttestation.test(s) ||
      URL_PATTERNS.identityChallenge.test(s) ||
      URL_PATTERNS.identityServiceIntegrity.test(s)
    ) {
      categories.push("identity");
    }

    if (categories.length === 0 && URL_PATTERNS.otherXhr.test(s)) {
      categories.push("other");
    }

    const jsonToScan = responseJson || bodyJson;
    if (jsonToScan) {
      const found = recursiveFindAdKeys(jsonToScan);
      if (found.length > 0) {
        const hasStrong = found.some(f => f.strength === "strong");
        subCategories.push(hasStrong ? "strong-ad" : "weak-ad-context");
      }
    }

    return {
      categories: categories.length ? categories : ["unknown"],
      subCategories,
      primaryCategory: categories[0] || "unknown",
    };
  }

  // ---------------------------------------------------------------------------
  // Recursive ad-key scanner — searches nested objects & embedded JSON strings
  // ---------------------------------------------------------------------------

  const AD_KEY_PATTERNS = [
    "adPlacements", "playerAds", "adSlots",
    "adBreakHeartbeatParams", "adBreakParams",
    "adInferredBlockingStatus", "adSignalsInfo",
    "adSafetyReason", "paidContentOverlay",
    "playerAttestationRenderer", "adPlacementRenderer",
  ];

  const STRONG_AD_KEYS = new Set([
    "adPlacements", "playerAds", "adSlots",
    "adBreakHeartbeatParams", "adBreakParams",
    "adPlacementRenderer",
  ]);

  const WEAK_AD_KEYS = new Set([
    "adSignalsInfo", "adInferredBlockingStatus",
    "adSafetyReason", "paidContentOverlay",
    "playerAttestationRenderer",
  ]);

  function isStrongAdKey(key) { return STRONG_AD_KEYS.has(key); }
  function isWeakAdKey(key) { return WEAK_AD_KEYS.has(key); }

  function recursiveFindAdKeys(root) {
    const found = [];
    const seen = new WeakSet();
    let visited = 0;
    const maxVisited = 8000;
    const maxDepth = 16;

    function tryJsonString(value) {
      if (typeof value !== "string" || !value.trim()) return null;
      const t = value.trim();
      if (t[0] !== "{" && t[0] !== "[") return null;

      const hasAdKey = AD_KEY_PATTERNS.some(k => t.includes('"' + k + '"'));
      if (!hasAdKey) return null;

      try {
        let cleaned = t;
        if (cleaned.startsWith(")]}'")) {
          const nl = cleaned.indexOf("\n");
          cleaned = nl >= 0 ? cleaned.slice(nl + 1).trim() : cleaned.slice(4).trim();
        }
        return JSON.parse(cleaned);
      } catch {
        return null;
      }
    }

    function walk(value, path, depth) {
      if (found.length >= 60) return;
      if (visited++ > maxVisited) return;
      if (depth > maxDepth) return;

      const parsed = tryJsonString(value);
      if (parsed) {
        walk(parsed, path + "<json>", depth + 1);
        return;
      }

      if (!value || typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);

      const keys = Object.keys(value);

      for (const key of keys) {
        const childPath = path ? path + "." + key : key;
        const child = value[key];

        if (AD_KEY_PATTERNS.includes(key)) {
          const kind =
            Array.isArray(child) ? "array" :
            child && typeof child === "object" ? "object" :
            "primitive";

          found.push({
            path: childPath,
            key,
            type: kind,
            count: Array.isArray(child) ? child.length : undefined,
            present: child != null,
            strength: isStrongAdKey(key) ? "strong" : "weak",
          });
        }

        walk(child, childPath, depth + 1);
      }
    }

    walk(root, "", 0);
    return found;
  }

  function summarizeAdFindings(json) {
    if (!json || typeof json !== "object") return null;

    const found = recursiveFindAdKeys(json);
    if (found.length === 0) return null;

    const byKey = {};
    for (const f of found) {
      if (!byKey[f.key]) byKey[f.key] = [];
      byKey[f.key].push({ path: f.path, type: f.type, count: f.count, strength: f.strength });
    }

    const strongFound = found.filter(f => f.strength === "strong");
    const weakFound = found.filter(f => f.strength === "weak");

    return {
      foundCount: found.length,
      strongCount: strongFound.length,
      weakCount: weakFound.length,
      hasAnyStrong: strongFound.length > 0,
      hasAnyWeak: weakFound.length > 0,
      distinctKeys: Object.keys(byKey),
      strongKeys: [...new Set(strongFound.map(f => f.key))],
      weakKeys: [...new Set(weakFound.map(f => f.key))],
      details: byKey,
    };
  }

  // ---------------------------------------------------------------------------
  // Response header extraction
  // ---------------------------------------------------------------------------

  function summarizeResponseHeaders(response) {
    const out = {};
    try {
      if (!response || !response.headers) return out;

      const interestingPrefixes = [
        "x-frame-options", "x-content-type-options", "content-type",
        "cache-control", "p3p", "set-cookie", "x-ad-", "x-goog-",
        "x-youtube-", "access-control-", "strict-transport-security",
        "referrer-policy", "permissions-policy",
      ];

      if (typeof response.headers.forEach === "function") {
        response.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (interestingPrefixes.some(p => lower.startsWith(p))) {
            out[key] = value;
          }
        });
      } else if (typeof response.headers.entries === "function") {
        for (const [key, value] of response.headers.entries()) {
          const lower = key.toLowerCase();
          if (interestingPrefixes.some(p => lower.startsWith(p))) {
            out[key] = value;
          }
        }
      }
    } catch {}

    return out;
  }

  // ---------------------------------------------------------------------------
  // Body handling
  // ---------------------------------------------------------------------------

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
    if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    if (typeof Blob !== "undefined" && value instanceof Blob) return await value.arrayBuffer();
    if (value instanceof Request) return await value.clone().arrayBuffer();
    if (typeof value?.arrayBuffer === "function" && typeof value?.clone === "function") return await value.clone().arrayBuffer();
    return null;
  }

  async function decompressGzipBytes(bytes) {
    if (typeof DecompressionStream !== "function" || bytes.byteLength < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return null;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
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
  // Cookie snapshot
  // ---------------------------------------------------------------------------

  function snapshotCookies(reason = "", url = "") {
    const now = Date.now();
    if (now - lastCookieSnapshotTime < config.cookieDebounceMs) return -1;

    lastCookieSnapshotTime = now;

    const snapshot = {
      time: new Date().toLocaleTimeString(),
      ms: Math.round(performance.now()),
      reason,
      url: String(url || ""),
      cookieString: document.cookie,
      cookieCount: document.cookie ? document.cookie.split(";").length : 0,
      cookies: parseCookies(document.cookie),
    };

    cookieSnapshots.push(snapshot);
    while (cookieSnapshots.length > config.maxCookieSnapshots) {
      cookieSnapshots.shift();
    }

    return cookieSnapshots.length - 1;
  }

  function parseCookies(cookieString) {
    const result = {};
    if (!cookieString) return result;

    const pairs = cookieString.split(";");
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();

      if (name === "VISITOR_INFO1_LIVE" || name === "VISITOR_PRIVACY_METADATA" || name === "YSC" || name === "GPS") {
        result[name] = value.length > 20 ? value.slice(0, 20) + "..." : value;
      } else if (
        name === "__Secure-3PAPISID" || name === "__Secure-3PSID" ||
        name === "SAPISID" || name === "APISID" || name === "HSID" ||
        name === "SID" || name === "SSID"
      ) {
        result[name] = "[present length=" + value.length + "]";
      } else if (name.startsWith("_") || name.includes("ga") || name.includes("utm")) {
        result[name] = value.length > 30 ? value.slice(0, 30) + "..." : value;
      } else {
        result[name] = value.length > 40 ? value.slice(0, 40) + "..." : value;
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Storage snapshot (passive)
  // ---------------------------------------------------------------------------

  function snapshotStorage(reason = "") {
    const now = Date.now();
    if (now - lastStorageSnapshotTime < config.storageDebounceMs) return;

    lastStorageSnapshotTime = now;

    const snapshot = {
      time: new Date().toLocaleTimeString(),
      ms: Math.round(performance.now()),
      reason,
      sessionStorage: readStorageKeys(sessionStorage, 100),
      localStorage: readStorageKeys(localStorage, 200),
    };

    storageEvents.push({ type: "snapshot", ...snapshot });
    while (storageEvents.length > 500) storageEvents.shift();
  }

  function readStorageKeys(storage, maxLen) {
    const out = {};
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        const value = storage.getItem(key);
        // Only YouTube-relevant keys for localStorage
        if (storage === localStorage && !/^(?:yt|youtube|__yt|__youtube|ytidb|yp|ys|yt\.|yt-|__chroma|__arc|__brave|__sab|polymer|TVHTML5|WEB|MWEB)/i.test(key)) {
          continue;
        }
        out[key] = typeof value === "string"
          ? (value.length > maxLen ? value.slice(0, maxLen) + "..." : value)
          : String(value);
      }
    } catch {}
    return out;
  }

  // ---------------------------------------------------------------------------
  // REAL storage change monitoring — patches setItem / removeItem / clear
  // ---------------------------------------------------------------------------

  // Patches Storage.prototype once.  Detects which storage object was used
  // via `this === localStorage` / `this === sessionStorage`.
  function patchStoragePrototype() {
    Storage.prototype.setItem = function patchedSetItem(key, value) {
      try {
        const label =
          this === localStorage ? "localStorage" :
          this === sessionStorage ? "sessionStorage" :
          "unknownStorage";
        storageEvents.push({
          type: "storage-change",
          time: new Date().toLocaleTimeString(),
          ms: Math.round(performance.now()),
          storage: label,
          action: "setItem",
          key: String(key),
          valuePreview: typeof value === "string"
            ? value.slice(0, 200)
            : String(value).slice(0, 200),
        });
        while (storageEvents.length > 500) storageEvents.shift();
      } catch {}
      return nativeStorageSetItem.apply(this, arguments);
    };

    Storage.prototype.removeItem = function patchedRemoveItem(key) {
      try {
        const label =
          this === localStorage ? "localStorage" :
          this === sessionStorage ? "sessionStorage" :
          "unknownStorage";
        storageEvents.push({
          type: "storage-change",
          time: new Date().toLocaleTimeString(),
          ms: Math.round(performance.now()),
          storage: label,
          action: "removeItem",
          key: String(key),
        });
        while (storageEvents.length > 500) storageEvents.shift();
      } catch {}
      return nativeStorageRemoveItem.apply(this, arguments);
    };

    Storage.prototype.clear = function patchedClear() {
      try {
        const label =
          this === localStorage ? "localStorage" :
          this === sessionStorage ? "sessionStorage" :
          "unknownStorage";
        storageEvents.push({
          type: "storage-change",
          time: new Date().toLocaleTimeString(),
          ms: Math.round(performance.now()),
          storage: label,
          action: "clear",
        });
        while (storageEvents.length > 500) storageEvents.shift();
      } catch {}
      return nativeStorageClear.apply(this, arguments);
    };
  }

  function restoreStoragePrototype() {
    Storage.prototype.setItem = nativeStorageSetItem;
    Storage.prototype.removeItem = nativeStorageRemoveItem;
    Storage.prototype.clear = nativeStorageClear;
  }

  // ---------------------------------------------------------------------------
  // Player state monitoring
  // ---------------------------------------------------------------------------

  function detectAdState() {
    const state = {
      isAdPlaying: false,
      adContainerVisible: false,
      adText: "",
      adOverlayVisible: false,
      adSkipButtonVisible: false,
      skipButtonText: "",
      playerAdClass: "",
      ytAdBadge: false,
      signals: [],   // which signals indicate ad state
    };

    try {
      const player = document.getElementById("movie_player") || document.querySelector("#movie_player");
      if (player) {
        const adClasses = Array.from(player.classList).filter(c =>
          /^(?:ad-created|ad-showing|ad-interrupting|ad-playing|ad-loading)$/i.test(c)
        );
        if (adClasses.length) {
          state.playerAdClass = adClasses.join(" ");
          state.isAdPlaying = true;
          state.signals.push("player-class:" + adClasses[0]);
        }

        if (typeof player.getAdState === "function") {
          try {
            const adState = player.getAdState();
            if (adState !== undefined && adState !== -1) {
              state.isAdPlaying = true;
              state.adStateRaw = adState;
              state.signals.push("getAdState");
            }
          } catch {}
        }

        const adAttr = player.getAttribute("data-ad-playing") || player.getAttribute("ad-interrupting");
        if (adAttr) {
          state.isAdPlaying = true;
          state.adAttrValue = adAttr;
          state.signals.push("data-attr");
        }
      }

      // Ad badge
      const adBadge = document.querySelector(".ytp-ad-simple-ad-badge, .ytp-ad-badge");
      if (adBadge) {
        state.ytAdBadge = true;
        state.adBadgeText = (adBadge.textContent || "").trim();
        state.signals.push("ad-badge");
      }

      // Skip button
      const skipButton = document.querySelector(
        ".ytp-ad-skip-button, .ytp-ad-skip-button-modern, " +
        ".ytp-skip-ad-button, .videoAdUiSkipButton"
      );
      if (skipButton) {
        state.adSkipButtonVisible = true;
        state.skipButtonText = (skipButton.textContent || "").trim();
        state.signals.push("skip-button");
      }

      // Overlay ads
      const overlay = document.querySelector(
        ".ytp-ad-overlay-container:not([style*='display: none']), " +
        ".ytp-ad-player-overlay:not([style*='display: none'])"
      );
      if (overlay) {
        state.adOverlayVisible = true;
        state.signals.push("ad-overlay");
      }

      // Ad containers (may exist even when not actively playing)
      const adContainers = document.querySelectorAll(".video-ads, .ytp-ad-module");
      if (adContainers.length > 0) {
        state.adContainerVisible = true;
        state.adContainerCount = adContainers.length;
        state.signals.push("ad-container");
      }

      // window.yt API
      if (g.yt && g.yt.player && g.yt.player.getAdState) {
        try {
          const adState = g.yt.player.getAdState();
          if (adState !== undefined && adState !== -1) {
            state.isAdPlaying = true;
            state.ytApiAdState = adState;
            state.signals.push("yt-api-getAdState");
          }
        } catch {}
      }
    } catch (e) {
      state.error = e.message;
    }

    return state;
  }

  function snapshotPlayerState(reason = "") {
    const snapshot = {
      time: new Date().toLocaleTimeString(),
      ms: Math.round(performance.now()),
      reason,
      videoId: getCurrentVideoId(),
      url: location.href,
      ...detectAdState(),
    };

    playerStateSnapshots.push(snapshot);
    while (playerStateSnapshots.length > config.playerPollMaxSnapshots) {
      playerStateSnapshots.shift();
    }

    // Ad session start
    if (snapshot.isAdPlaying && !currentAdId) {
      currentAdId = "ad-" + Date.now();
      adImpressionStartTime = performance.now();
      adTimeline.length = 0;  // in-place clear

      const cookieIdx = config.cookieSnapshots ? snapshotCookies("ad-impression-detected", location.href) : -1;

      adTimeline.push({
        phase: "ad-detected",
        time: new Date().toLocaleTimeString(),
        ms: Math.round(performance.now()),
        cookieSnapshotIndex: cookieIdx,
        adId: currentAdId,
        videoId: getCurrentVideoId(),
        signals: snapshot.signals || [],
      });

      remember({
        event: "ad-session-start",
        videoId: getCurrentVideoId(),
        adId: currentAdId,
        adState: snapshot,
      });

      snapshotStorage("ad-session-start");
    }

    // Ad session end
    if (!snapshot.isAdPlaying && currentAdId) {
      const endMs = performance.now();
      const durationS = parseFloat(((endMs - adImpressionStartTime) / 1000).toFixed(1));

      const cookieIdx = config.cookieSnapshots ? snapshotCookies("ad-ended", location.href) : -1;

      adTimeline.push({
        phase: "ad-ended",
        time: new Date().toLocaleTimeString(),
        ms: Math.round(endMs),
        cookieSnapshotIndex: cookieIdx,
        durationSeconds: durationS,
      });

      const vid = getCurrentVideoId();
      if (vid) {
        lastAdEndByVideoId[vid] = performance.now();
      }

      remember({
        event: "ad-session-end",
        videoId: vid,
        adId: currentAdId,
        durationSeconds: durationS,
        timeline: cloneJson(adTimeline),
      });

      snapshotStorage("ad-session-end");

      currentAdId = "";
      adImpressionStartTime = 0;
    }

    return snapshot;
  }

  function startPlayerPolling() {
    if (playerPollTimer || !config.playerPollMs) return;
    playerPollTimer = setInterval(() => {
      if (!config.enabled) return;
      snapshotPlayerState("poll");
    }, config.playerPollMs);
  }

  function stopPlayerPolling() {
    if (playerPollTimer) {
      clearInterval(playerPollTimer);
      playerPollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Client context / fingerprint summary
  // ---------------------------------------------------------------------------

  function summarizeClientContext(json) {
    const client = json?.context?.client || {};
    if (!client || typeof client !== "object") return null;

    const keys = Object.keys(client).sort();
    const staticKeys = keys.filter(k => !["visitorData", "timeZone"].includes(k));
    const dynamicKeys = keys.filter(k => ["visitorData", "timeZone"].includes(k));

    return {
      clientName: client.clientName || "",
      clientVersion: client.clientVersion || "",
      hl: client.hl || "",
      gl: client.gl || "",
      utcOffsetMinutes: client.utcOffsetMinutes,
      timeZone: client.timeZone || "",
      visitorDataLength: typeof client.visitorData === "string" ? client.visitorData.length : 0,
      staticKeyCount: staticKeys.length,
      dynamicKeyCount: dynamicKeys.length,
      allKeys: keys,
      hasDeviceMake: !!client.deviceMake,
      hasDeviceModel: !!client.deviceModel,
      hasOsName: !!client.osName,
      hasOsVersion: !!client.osVersion,
      hasBrowserName: !!client.browserName,
      hasBrowserVersion: !!client.browserVersion,
      hasScreenDensityFloat: !!client.screenDensityFloat,
      hasScreenWidthPoints: !!client.screenWidthPoints,
      hasScreenHeightPoints: !!client.screenHeightPoints,
      hasScreenPixelDensity: !!client.screenPixelDensity,
      hasMemoryTotalKbytes: !!client.memoryTotalKbytes,
      hasConnectionType: !!client.connectionType,
      hasEffectiveConnectionType: !!client.effectiveConnectionType,
      hasUserAgent: !!client.userAgent,
      hasPlatform: !!client.platform,
      hasOriginalUrl: !!client.originalUrl,
      hasMainAppWebInfo: !!client.mainAppWebInfo,
      hasConfigInfo: !!client.configInfo,
      hasWindowDimensions: !!(client.windowWidthPoints || client.windowHeightPoints),
      hasDeviceExperimentIds: !!client.deviceExperimentIds,
    };
  }

  function summarizeServiceIntegrity(json) {
    const si = json?.serviceIntegrityDimensions || {};
    if (!si || typeof si !== "object") return null;
    return {
      hasPoToken: !!si.poToken,
      hasBotguardData: !!si.botguardData,
      siKeys: Object.keys(si),
    };
  }

  function summarizePlaybackContext(json) {
    const pc = json?.playbackContext?.contentPlaybackContext || {};
    if (!pc || typeof pc !== "object") return null;
    const keys = Object.keys(pc);
    return {
      keyCount: keys.length,
      hasSignatureTimestamp: !!pc.signatureTimestamp,
      hasReferer: !!pc.referer,
      hasAutonavState: !!pc.autonavState,
      hasCurrentUrl: !!pc.currentUrl,
      hasLactMilliseconds: !!pc.lactMilliseconds,
      hasVisitorData: !!pc.visitorData,
      keys,
    };
  }

  // ---------------------------------------------------------------------------
  // Network row builder
  // ---------------------------------------------------------------------------

  function makeNetworkRow({
    type,
    method,
    url,
    requestHeaders,
    requestBodyType,
    requestBodyText,
    requestBodyJson,
    responseStatus,
    responseHeaders,
    responseBodyText,
    responseBodyJson,
    responseCloned,
    requestStartMs,
    responseEndMs,
  }) {
    const isMedia = isMediaUrl(String(url || ""));
    const classification = classifyRequest(url, method, requestBodyJson, responseBodyJson);
    const adFindings = summarizeAdFindings(responseBodyJson || requestBodyJson);
    const clientContext = summarizeClientContext(requestBodyJson);
    const serviceIntegrity = summarizeServiceIntegrity(requestBodyJson);
    const playbackContext = summarizePlaybackContext(requestBodyJson);

    const videoId =
      requestBodyJson?.videoId ||
      requestBodyJson?.playerRequest?.videoId ||
      requestBodyJson?.watchNextRequest?.videoId ||
      "";

    const row = {
      time: new Date().toLocaleTimeString(),
      ms: Math.round(performance.now()),
      requestStartMs: requestStartMs ? Math.round(requestStartMs) : undefined,
      responseEndMs: responseEndMs ? Math.round(responseEndMs) : undefined,
      type,
      method,
      url,
      primaryCategory: classification.primaryCategory,
      categories: classification.categories,
      subCategories: classification.subCategories,
      requestBodyType,
      requestBodyLength: typeof requestBodyText === "string" ? requestBodyText.length : 0,
      responseStatus,
      responseCloned: !!responseCloned,
      videoId,
      isMedia,

      // Recursive ad finder output
      adFindings: adFindings || undefined,

      // Context / fingerprinting
      clientContext: clientContext || undefined,
      serviceIntegrity: serviceIntegrity || undefined,
      playbackContext: playbackContext || undefined,

      // Headers (redacted)
      responseHeaders: responseHeaders || undefined,

      // Body preview (for non-media only)
      requestBodyPreview: typeof requestBodyText === "string"
        ? requestBodyText.slice(0, 1000) : "",
      responseBodyPreview: !isMedia && typeof responseBodyText === "string"
        ? responseBodyText.slice(0, 1000) : "",

      // Full bodies (for non-media only)
      requestBodyJson: config.captureResponseBodies ? (requestBodyJson || undefined) : undefined,
      responseBodyJson: (config.captureResponseBodies && !isMedia) ? (responseBodyJson || undefined) : undefined,
    };

    networkRows.push(row);
    while (networkRows.length > maxNetworkRows) {
      networkRows.shift();
    }
    updateAutomationHudSoon();

    // Log events for strong ad-relevant requests only (weak context like adSignalsInfo
    // is recorded on the row but does not trigger ad session timeline entries).
    if (adFindings && adFindings.hasAnyStrong) {
      const cookieIdx = config.cookieSnapshots
        ? snapshotCookies("ad-response-received", url) : -1;

      if (currentAdId) {
        adTimeline.push({
          phase: "ad-api-response",
          time: new Date().toLocaleTimeString(),
          ms: Math.round(performance.now()),
          cookieSnapshotIndex: cookieIdx,
          endpoint: classification.subCategories.join(","),
          adFoundKeys: adFindings.strongKeys,
          adFoundCount: adFindings.strongCount,
          strength: "strong",
        });
      }

      remember({
        event: "ad-api-request",
        ms: responseEndMs,
        primaryCategory: classification.primaryCategory,
        subCategories: classification.subCategories,
        url,
        videoId,
        responseStatus,
        adFindings: {
          foundCount: adFindings.foundCount,
          strongCount: adFindings.strongCount,
          weakCount: adFindings.weakCount,
          distinctKeys: adFindings.distinctKeys,
          strongKeys: adFindings.strongKeys,
          weakKeys: adFindings.weakKeys,
        },
        cookieSnapshotIndex: cookieIdx,
      });
    }

    return row;
  }

  // ---------------------------------------------------------------------------
  // Event helper
  // ---------------------------------------------------------------------------

  function remember(event) {
    event.time = new Date().toLocaleTimeString();
    event.ms = event.ms ?? Math.round(performance.now());
    event.videoId = event.videoId || getCurrentVideoId();
    event.pageUrl = location.href;

    events.push(event);
    while (events.length > config.maxEvents) {
      events.shift();
    }
    try {
      handleAutomationEvent(event);
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // Read request meta (fetch)
  // ---------------------------------------------------------------------------

  async function readFetchMeta(input, init) {
    let url = "";
    let method = "GET";
    let body = null;
    let requestHeaders = {};

    try {
      if (input instanceof Request) {
        url = input.url;
        method = String(init?.method || input.method || "GET");
        requestHeaders = extractHeaders(init?.headers || input.headers);
        if (init && "body" in init) body = init.body;
        else body = input;
      } else {
        url = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || "");
        method = String(init?.method || input?.method || "GET");
        requestHeaders = extractHeaders(init?.headers || input?.headers);
        if (init && "body" in init) body = init.body;
        else if (input?.body) body = input;
      }
    } catch {}

    const text = await bodyToText(body);
    const json = safeJson(text);

    return {
      url,
      method,
      requestHeaders,
      requestBodyType: bodyType(body),
      requestBodyText: text,
      requestBodyJson: json,
    };
  }

  function extractHeaders(headersLike) {
    const out = {};
    try {
      const headers = new Headers(headersLike || undefined);
      for (const [key, value] of headers.entries()) {
        const lower = key.toLowerCase();
        if (lower === "authorization" || lower === "cookie") {
          out[key] = "[present]";
        } else if (lower === "x-goog-visitor-id") {
          out[key] = value ? "[present length=" + value.length + "]" : "";
        } else {
          out[key] = value;
        }
      }
    } catch {}
    return out;
  }

  // ---------------------------------------------------------------------------
  // Read XHR meta
  // ---------------------------------------------------------------------------

  async function readXhrMeta(xhr, body) {
    const meta = xhr.__ytAdCooldownProbe || {};
    const text = await bodyToText(body);
    const json = safeJson(text);

    return {
      url: meta.url || "",
      method: meta.method || "GET",
      requestHeaders: meta.requestHeaders || {},
      requestBodyType: bodyType(body),
      requestBodyText: text,
      requestBodyJson: json,
    };
  }

  // ---------------------------------------------------------------------------
  // URL capture policy
  // ---------------------------------------------------------------------------

  function shouldCaptureUrl(url) {
    const s = String(url || "");
    if (URL_PATTERNS.youtubeiGeneral.test(s) && config.captureAllYoutubei) return true;
    if (isAdServingUrl(s) && config.captureAdRelated) return true;
    if (isTrackingUrl(s) && config.captureTracking) return true;
    if (isMediaUrl(s) && config.captureMedia) return true;
    if (config.captureOther && URL_PATTERNS.otherXhr.test(s)) return true;
    return false;
  }

  function shouldCaptureResponseBody(url) {
    if (!config.captureResponseBodies) return false;
    // NEVER read bodies for media URLs
    if (isMediaUrl(String(url || ""))) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Fetch interception
  // ---------------------------------------------------------------------------

  g.fetch = async function ytAdCooldownFetch(input, init) {
    if (!config.interceptFetch || !config.enabled) {
      return nativeFetch.apply(this, arguments);
    }

    let meta = null;

    try {
      meta = await readFetchMeta(input, init);
    } catch {}

    const requestStartMs = performance.now();
    let response;
    try {
      response = await nativeFetch.apply(this, arguments);
    } catch (err) {
      if (meta) {
        remember({
          event: "network-error",
          url: meta.url,
          method: meta.method,
          error: err?.message || String(err),
        });
      }
      throw err;
    }
    const responseEndMs = performance.now();

    let clonedResponse = null;
    let responseBodyText = "";
    let responseBodyJson = null;
    const wantBody = meta && shouldCaptureResponseBody(meta.url);

    try {
      if (wantBody) {
        clonedResponse = response.clone();
        responseBodyText = await clonedResponse.text();
        if (responseBodyText.length > config.maxResponseBodyLength) {
          responseBodyText = responseBodyText.slice(0, config.maxResponseBodyLength) +
            "\n... [truncated at " + config.maxResponseBodyLength + "]";
        }
        responseBodyJson = safeJson(responseBodyText);
      }
    } catch {}

    if (meta && shouldCaptureUrl(meta.url)) {
      // For media URLs, log URL + status only (no body was read)
      if (isMediaUrl(meta.url)) {
        const row = {
          time: new Date().toLocaleTimeString(),
          ms: Math.round(performance.now()),
          type: "fetch",
          method: meta.method,
          url: meta.url,
          primaryCategory: "media",
          categories: ["media"],
          subCategories: [],
          requestBodyType: meta.requestBodyType,
          requestBodyLength: 0,
          responseStatus: response.status,
          responseCloned: false,
          videoId: "",
          isMedia: true,
        };
        networkRows.push(row);
        while (networkRows.length > maxNetworkRows) networkRows.shift();
      } else {
        makeNetworkRow({
          type: "fetch",
          method: meta.method,
          url: meta.url,
          requestHeaders: meta.requestHeaders,
          requestBodyType: meta.requestBodyType,
          requestBodyText: meta.requestBodyText,
          requestBodyJson: meta.requestBodyJson,
          responseStatus: response.status,
          responseHeaders: summarizeResponseHeaders(response),
          responseBodyText,
          responseBodyJson,
          responseCloned: !!clonedResponse,
          requestStartMs,
          responseEndMs,
        });
      }
    }

    return response;
  };

  // ---------------------------------------------------------------------------
  // XHR interception
  // ---------------------------------------------------------------------------

  XMLHttpRequest.prototype.open = function ytAdCooldownOpen(method, url) {
    try {
      this.__ytAdCooldownProbe = {
        method: String(method || "GET"),
        url: String(url || ""),
        requestHeaders: {},
      };
    } catch {}
    return nativeOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function ytAdCooldownSetRequestHeader(name, value) {
    try {
      if (this.__ytAdCooldownProbe) {
        const lower = String(name || "").toLowerCase();
        if (lower === "authorization" || lower === "cookie") {
          this.__ytAdCooldownProbe.requestHeaders[String(name)] = "[present]";
        } else if (lower === "x-goog-visitor-id") {
          this.__ytAdCooldownProbe.requestHeaders[String(name)] =
            value ? "[present length=" + String(value).length + "]" : "";
        } else {
          this.__ytAdCooldownProbe.requestHeaders[String(name)] = String(value || "");
        }
      }
    } catch {}
    return nativeSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function ytAdCooldownSend(body) {
    const xhr = this;

    if (!config.interceptXhr || !config.enabled) {
      return nativeSend.apply(xhr, arguments);
    }

    let metaPromise = Promise.resolve(null);
    try {
      metaPromise = readXhrMeta(xhr, body);
    } catch {}

    const requestStartMs = performance.now();

    xhr.addEventListener("load", () => {
      metaPromise.then(meta => {
        if (!meta || !shouldCaptureUrl(meta.url)) return;

        const responseEndMs = performance.now();

        // For media URLs, log URL + status only
        if (isMediaUrl(meta.url)) {
          const row = {
            time: new Date().toLocaleTimeString(),
            ms: Math.round(performance.now()),
            type: "xhr",
            method: meta.method,
            url: meta.url,
            primaryCategory: "media",
            categories: ["media"],
            subCategories: [],
            requestBodyType: meta.requestBodyType,
            requestBodyLength: 0,
            responseStatus: xhr.status,
            responseCloned: false,
            videoId: "",
            isMedia: true,
          };
          networkRows.push(row);
          while (networkRows.length > maxNetworkRows) networkRows.shift();
          return;
        }

        let responseBodyText = "";
        let responseBodyJson = null;
        const wantBody = shouldCaptureResponseBody(meta.url);

        if (wantBody) {
          try {
            responseBodyText = xhr.responseText || "";
            if (responseBodyText.length > config.maxResponseBodyLength) {
              responseBodyText = responseBodyText.slice(0, config.maxResponseBodyLength) +
                "\n... [truncated]";
            }
            responseBodyJson = safeJson(responseBodyText);
          } catch {}
        }

        let responseHeaders = {};
        try {
          const headersStr = xhr.getAllResponseHeaders();
          if (headersStr) {
            for (const line of headersStr.trim().split(/[\r\n]+/)) {
              const colon = line.indexOf(":");
              if (colon > 0) {
                responseHeaders[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
              }
            }
          }
        } catch {}

        makeNetworkRow({
          type: "xhr",
          method: meta.method,
          url: meta.url,
          requestHeaders: meta.requestHeaders,
          requestBodyType: meta.requestBodyType,
          requestBodyText: meta.requestBodyText,
          requestBodyJson: meta.requestBodyJson,
          responseStatus: xhr.status,
          responseHeaders,
          responseBodyText,
          responseBodyJson,
          responseCloned: false,
          requestStartMs,
          responseEndMs,
        });
      }).catch(() => {});
    });

    xhr.addEventListener("error", () => {
      metaPromise.then(meta => {
        if (!meta) return;
        remember({
          event: "network-error",
          url: meta.url,
          method: meta.method,
          error: "XHR error event",
        });
      }).catch(() => {});
    });

    return nativeSend.apply(xhr, arguments);
  };

  // ---------------------------------------------------------------------------
  // navigator.sendBeacon hook — catches impression/tracking pings
  // ---------------------------------------------------------------------------

  if (config.hookSendBeacon && nativeSendBeacon) {
    navigator.sendBeacon = function patchedSendBeacon(url, data) {
      try {
        const s = String(url || "");

        let bodyPreview = "";
        if (typeof data === "string") {
          bodyPreview = data.slice(0, 1000);
        } else if (data instanceof URLSearchParams) {
          bodyPreview = data.toString().slice(0, 1000);
        } else if (data instanceof Blob) {
          bodyPreview = "[Blob " + (data.type || "unknown") + " " + data.size + " bytes]";
        } else if (data instanceof FormData) {
          const entries = [];
          for (const [k, v] of data.entries()) entries.push(k + "=" + String(v).slice(0, 50));
          bodyPreview = "[FormData] " + entries.slice(0, 5).join(" ");
        } else if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) {
          bodyPreview = "[binary " + data.byteLength + " bytes]";
        }

        const categories = [];
        if (isAdServingUrl(s)) categories.push("ad");
        if (isTrackingUrl(s)) categories.push("tracking");
        if (URL_PATTERNS.youtubeiGeneral.test(s)) categories.push("youtubei");
        if (categories.length === 0) categories.push("other");

        const isAd = categories.includes("ad") || categories.includes("tracking");

        remember({
          event: "send-beacon",
          url: s,
          bodyType: bodyType(data),
          bodyPreview,
          categories,
        });

        // Also add to resource entries for unified view
        if (isAd || isTrackingUrl(s)) {
          resourceEntries.push({
            time: new Date().toLocaleTimeString(),
            ms: Math.round(performance.now()),
            initiatorType: "beacon",
            name: s,
            categories,
          });
          while (resourceEntries.length > maxResourceEntries) resourceEntries.shift();
        }
      } catch {}

      return nativeSendBeacon.apply(navigator, arguments);
    };
  }

  // ---------------------------------------------------------------------------
  // PerformanceObserver — catches ALL resource loads, including non-JS
  // ---------------------------------------------------------------------------

  let resourceObserver = null;

  function startResourceObserver() {
    if (!config.resourceTiming || resourceObserver) return;

    try {
      resourceObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const s = String(entry.name || "");
          const initiatorType = entry.initiatorType || "";

          // Skip entries we already catch via fetch/XHR (but not sendBeacon)
          if (initiatorType === "fetch" || initiatorType === "xmlhttprequest") continue;

          const categories = [];
          if (isAdServingUrl(s)) categories.push("ad");
          if (isTrackingUrl(s)) categories.push("tracking");
          if (isMediaUrl(s)) categories.push("media");
          if (URL_PATTERNS.youtubeiGeneral.test(s)) categories.push("youtubei");
          if (categories.length === 0) continue; // skip uninteresting

          const re = {
            time: new Date().toLocaleTimeString(),
            startMs: Math.round(entry.startTime),
            responseEndMs: Math.round(entry.responseEnd || entry.startTime + entry.duration),
            initiatorType,
            name: s,
            duration: Math.round(entry.duration),
            transferSize: entry.transferSize || 0,
            categories,
          };

          resourceEntries.push(re);
          while (resourceEntries.length > maxResourceEntries) {
            resourceEntries.shift();
          }
        }
      });

      resourceObserver.observe({ type: "resource", buffered: true });
    } catch {}
  }

  function stopResourceObserver() {
    if (resourceObserver) {
      resourceObserver.disconnect();
      resourceObserver = null;
    }
  }

  // ---------------------------------------------------------------------------
  // DOM ad container watching
  // ---------------------------------------------------------------------------

  let adContainerObserver = null;

  function startAdContainerWatching() {
    if (!config.watchAdContainers || adContainerObserver) return;

    function checkContainers() {
      const state = detectAdState();

      // Only fire on significant visual state changes
      if (state.adSkipButtonVisible && !currentAdId) {
        snapshotPlayerState("dom-skip-button-detected");
        remember({
          event: "dom-ad-skip-detected",
          adState: state,
        });
      }

      if (state.isAdPlaying && !currentAdId) {
        snapshotPlayerState("dom-ad-playing-detected");
        remember({
          event: "dom-ad-playing-detected",
          adState: state,
        });
      }
    }

    checkContainers();

    try {
      adContainerObserver = new MutationObserver(() => {
        checkContainers();
      });

      adContainerObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
      });
    } catch {}
  }

  function stopAdContainerWatching() {
    if (adContainerObserver) {
      adContainerObserver.disconnect();
      adContainerObserver = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation detection
  // ---------------------------------------------------------------------------

  function onNavigate() {
    const newVideoId = getCurrentVideoId();

    if (newVideoId !== currentVideoId) {
      const previousVideoId = currentVideoId;
      const cookieIdx = config.cookieSnapshots ? snapshotCookies("navigation", location.href) : -1;

      remember({
        event: "navigation",
        previousVideoId,
        newVideoId,
        cookieSnapshotIndex: cookieIdx,
      });

      snapshotStorage("navigation");
      currentVideoId = newVideoId;

      if (currentAdId) {
        const endMs = performance.now();
        const durationS = parseFloat(((endMs - adImpressionStartTime) / 1000).toFixed(1));
        const adState = detectAdState();

        if (adState.isAdPlaying) {
          adTimeline.push({
            phase: "ad-navigation-while-active",
            time: new Date().toLocaleTimeString(),
            ms: Math.round(endMs),
            fromVideoId: previousVideoId,
            toVideoId: newVideoId,
            durationSeconds: durationS,
            signals: adState.signals || [],
          });

          remember({
            event: "ad-navigation-while-active",
            adId: currentAdId,
            fromVideoId: previousVideoId,
            toVideoId: newVideoId,
            durationSeconds: durationS,
            adState,
            timeline: cloneJson(adTimeline),
          });

          return;
        }

        adTimeline.push({
          phase: "ad-interrupted-by-navigation",
          time: new Date().toLocaleTimeString(),
          ms: Math.round(endMs),
          durationSeconds: durationS,
        });

        remember({
          event: "ad-interrupted-by-navigation",
          adId: currentAdId,
          fromVideoId: previousVideoId,
          toVideoId: newVideoId,
          durationSeconds: durationS,
          timeline: cloneJson(adTimeline),
        });

        currentAdId = "";
        adImpressionStartTime = 0;
      }
    }
  }

  document.addEventListener("yt-navigate-finish", onNavigate, true);

  const onPopState = () => setTimeout(onNavigate, 100);
  window.addEventListener("popstate", onPopState, true);

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function patchedPushState() {
    const result = originalPushState.apply(this, arguments);
    setTimeout(onNavigate, 100);
    return result;
  };

  history.replaceState = function patchedReplaceState() {
    const result = originalReplaceState.apply(this, arguments);
    setTimeout(onNavigate, 100);
    return result;
  };

  // ---------------------------------------------------------------------------
  // Video ID helpers
  // ---------------------------------------------------------------------------

  function getCurrentVideoId() {
    try {
      const urlId = new URL(location.href).searchParams.get("v");
      if (urlId) return urlId;

      return document.querySelector("ytd-watch-flexy")?.getAttribute("video-id") || "";
    } catch {
      return "";
    }
  }

  // ---------------------------------------------------------------------------
  // Identity snapshot
  // ---------------------------------------------------------------------------

  function getIdentityState() {
    return {
      isSignedIn: detectSignInState(),
      isIncognito: detectIncognito(),
      cookies: {
        visitorInfo: getCookie("VISITOR_INFO1_LIVE"),
        ysc: getCookie("YSC"),
        gps: getCookie("GPS"),
        sapisidPresent: !!getCookie("SAPISID"),
        secure3papisidPresent: !!getCookie("__Secure-3PAPISID"),
      },
      browser: {
        userAgent: navigator.userAgent,
        language: navigator.language,
        languages: navigator.languages,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency || 0,
        deviceMemory: navigator.deviceMemory || 0,
        connectionType: getConnectionType(),
        screenWidth: screen.width,
        screenHeight: screen.height,
        colorDepth: screen.colorDepth,
        timezoneOffset: new Date().getTimezoneOffset(),
        doNotTrack: navigator.doNotTrack,
      },
      storage: {
        sessionStorageKeyCount: getStorageKeyCount("session"),
        localStorageKeyCount: getStorageKeyCount("local"),
      },
    };
  }

  function detectSignInState() {
    try {
      const avatarBtn = document.querySelector("#avatar-btn, #img[src*='yt3.ggpht.com']");
      if (avatarBtn) return "signed-in";
      const signInButton = document.querySelector("a[href*='ServiceLogin']");
      if (signInButton) return "logged-out";
    } catch {}
    if (getCookie("SAPISID") || getCookie("__Secure-3PAPISID") || getCookie("LOGIN_INFO")) {
      return "signed-in";
    }
    return "unknown";
  }

  function detectIncognito() {
    try {
      if (typeof RequestFileSystem === "function") return "likely-normal";
      if (typeof webkitRequestFileSystem === "function") return "likely-normal";
    } catch {}
    return "unknown";
  }

  function getCookie(name) {
    const match = document.cookie.match(new RegExp(
      "(?:^|;\\s*)" + name.replace(/([.*+?^=!:${}()|[\]\/\\])/g, "\\$1") + "=([^;]*)"
    ));
    return match ? match[1] : "";
  }

  function getConnectionType() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn) return "unknown";
    return {
      effectiveType: conn.effectiveType || "",
      type: conn.type || "",
      downlink: conn.downlink,
      rtt: conn.rtt,
      saveData: conn.saveData || false,
    };
  }

  function getStorageKeyCount(type) {
    try {
      return (type === "session" ? sessionStorage : localStorage).length;
    } catch {
      return -1;
    }
  }

  // ---------------------------------------------------------------------------
  // Timing helpers — prefer responseEndMs over row-logged ms for accuracy
  // ---------------------------------------------------------------------------

  function rowEventMs(r) {
    return r.responseEndMs ?? r.ms;
  }

  function resourceEventMs(re) {
    return re.ms ?? re.startMs ?? re.responseEndMs ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Causality chain: ad API → visual → skip → end → tracking → next delta
  // ---------------------------------------------------------------------------

  function buildCausalityChain() {
    const chain = [];

    // Gather ad-session-start and ad-session-end events with their adIds
    const sessions = [];
    for (const evt of events) {
      if (evt.event === "ad-session-start") {
        sessions.push({
          adId: evt.adId,
          videoId: evt.videoId,
          startMs: evt.ms,
          endMs: null,
          steps: [{ phase: "ad-detected", ms: evt.ms }],
        });
      }
      if (evt.event === "ad-session-end" && sessions.length > 0) {
        const sess = sessions[sessions.length - 1];
        if (sess.adId === evt.adId) {
          sess.endMs = evt.ms;
          sess.durationSeconds = evt.durationSeconds;
          sess.steps.push({ phase: "ad-ended", ms: evt.ms });
        }
      }
    }

    // Add ad-api-response events that fall within each session window
    for (const evt of events) {
      if (evt.event !== "ad-api-request" && evt.event !== "ad-navigation-while-active") continue;
      for (const sess of sessions) {
        if (evt.ms >= sess.startMs && (sess.endMs === null || evt.ms <= sess.endMs)) {
          if (evt.event === "ad-api-request") {
            sess.steps.push({
              phase: "ad-api-response",
              ms: evt.ms,
              endpoint: evt.subCategories?.join(",") || "",
              adKeys: evt.adFindings?.distinctKeys || [],
            });
          } else {
            sess.steps.push({
              phase: "navigation-while-active",
              ms: evt.ms,
              fromVideoId: evt.fromVideoId,
              toVideoId: evt.toVideoId,
            });
          }
        }
      }
    }

    // Add resource entries (sendBeacon, img, etc.) within sessions
    for (const re of resourceEntries) {
      const t = resourceEventMs(re);
      for (const sess of sessions) {
        if (t >= sess.startMs && (sess.endMs === null || t <= sess.endMs)) {
          sess.steps.push({
            phase: "resource-" + re.initiatorType,
            ms: t,
            startMs: re.startMs,
            responseEndMs: re.responseEndMs,
            url: re.name,
          });
        }
      }
    }

    // Sort steps within each session and compute deltas
    for (const sess of sessions) {
      sess.steps.sort((a, b) => a.ms - b.ms);

      // Compute causal deltas
      for (let i = 1; i < sess.steps.length; i++) {
        sess.steps[i].deltaFromPreviousMs = Math.round(sess.steps[i].ms - sess.steps[i - 1].ms);
      }

      // Skip cooldown computation for incomplete sessions (no endMs)
      if (sess.endMs == null) {
        sess.nextOpportunityDeltaMs = null;
        sess.nextOpportunityEndpoint = null;
        sess.nextOpportunityHadStrongAdData = null;
        sess.nextOpportunityHadWeakAdContext = null;
        chain.push(sess);
        continue;
      }

      // Compute gap from ad-end to next ad-eligible youtubei player/get_watch/next request.
      // The cooldown signal is in hadStrongAdData=false, not just finding the next ad response.
      const nextOpportunity = networkRows
        .filter(r =>
          rowEventMs(r) > sess.endMs &&
          r.categories.includes("youtubei") &&
          ["player", "get_watch", "next"].some(x => r.subCategories.includes(x))
        )
        .sort((a, b) => rowEventMs(a) - rowEventMs(b))[0];

      sess.nextOpportunityDeltaMs = nextOpportunity
        ? Math.round(rowEventMs(nextOpportunity) - sess.endMs)
        : null;
      sess.nextOpportunityEndpoint = nextOpportunity
        ? nextOpportunity.subCategories.join(",")
        : null;
      sess.nextOpportunityHadStrongAdData = nextOpportunity
        ? !!(nextOpportunity.adFindings && nextOpportunity.adFindings.hasAnyStrong)
        : null;
      sess.nextOpportunityHadWeakAdContext = nextOpportunity
        ? !!(nextOpportunity.adFindings && nextOpportunity.adFindings.hasAnyWeak)
        : null;

      chain.push(sess);
    }

    return chain;
  }

  function buildCooldownTimeline() {
    const timeline = [];

    let lastWasAd = false;
    for (const snap of playerStateSnapshots) {
      if (snap.isAdPlaying !== lastWasAd) {
        timeline.push({
          type: snap.isAdPlaying ? "ad-visual-start" : "ad-visual-end",
          time: snap.time,
          ms: snap.ms,
          videoId: snap.videoId,
          signals: snap.signals || [],
        });
        lastWasAd = snap.isAdPlaying;
      }
    }

    for (const evt of events) {
      if (evt.event === "ad-api-request") {
        timeline.push({
          type: "ad-api",
          time: evt.time,
          ms: evt.ms,
          videoId: evt.videoId,
          adKeys: evt.adFindings?.distinctKeys || [],
        });
      }
      if (evt.event === "ad-session-start") {
        timeline.push({
          type: "ad-session-start",
          time: evt.time,
          ms: evt.ms,
          videoId: evt.videoId,
        });
      }
      if (evt.event === "ad-session-end") {
        timeline.push({
          type: "ad-session-end",
          time: evt.time,
          ms: evt.ms,
          videoId: evt.videoId,
          durationSeconds: evt.durationSeconds,
        });
      }
      if (evt.event === "ad-interrupted-by-navigation") {
        timeline.push({
          type: "ad-interrupted",
          time: evt.time,
          ms: evt.ms,
          fromVideoId: evt.fromVideoId,
          toVideoId: evt.toVideoId,
          durationSeconds: evt.durationSeconds,
        });
      }
      if (evt.event === "ad-navigation-while-active") {
        timeline.push({
          type: "ad-navigation-active",
          time: evt.time,
          ms: evt.ms,
          fromVideoId: evt.fromVideoId,
          toVideoId: evt.toVideoId,
          durationSeconds: evt.durationSeconds,
        });
      }
      if (evt.event === "send-beacon") {
        timeline.push({
          type: "send-beacon",
          time: evt.time,
          ms: evt.ms,
          url: evt.url,
          categories: evt.categories,
        });
      }
    }

    timeline.sort((a, b) => a.ms - b.ms);
    return timeline;
  }

  // ---------------------------------------------------------------------------
  // Ad gap analysis: time between ad-end and next ad-eligible request.
  // Split into same-video and cross-navigation so cooldown at both levels is visible.
  // ---------------------------------------------------------------------------

  function adGapAnalysis() {
    const adEndEvents = events.filter(e => e.event === "ad-session-end");
    const navEvents = events.filter(e => e.event === "navigation");
    const sameVideo = [];
    const crossNavigation = [];

    for (const adEnd of adEndEvents) {
      const gapVideoId = adEnd.videoId;

      // Find the next navigation after this ad end
      const nextNav = navEvents
        .filter(n => n.ms > adEnd.ms && n.previousVideoId === gapVideoId)
        .sort((a, b) => a.ms - b.ms)[0];

      // --- Same-video gap: rows after ad-end but before next navigation ---
      const sameVideoCutoffMs = nextNav ? nextNav.ms : Infinity;

      const sameVideoYoutubei = networkRows
        .filter(r =>
          rowEventMs(r) > adEnd.ms &&
          rowEventMs(r) < sameVideoCutoffMs &&
          r.categories.includes("youtubei") &&
          ["player", "get_watch", "next"].some(x => r.subCategories.includes(x))
        )
        .sort((a, b) => rowEventMs(a) - rowEventMs(b));

      if (sameVideoYoutubei.length > 0) {
        sameVideo.push({
          adId: adEnd.adId,
          videoId: gapVideoId,
          adEndMs: adEnd.ms,
          adDurationSeconds: adEnd.durationSeconds,
          nextYoutubeiDeltaSeconds: parseFloat(((rowEventMs(sameVideoYoutubei[0]) - adEnd.ms) / 1000).toFixed(1)),
          nextYoutubeiEndpoint: sameVideoYoutubei[0].subCategories.join(","),
          nextYoutubeiHadStrongAdData: !!(sameVideoYoutubei[0].adFindings?.hasAnyStrong),
          nextYoutubeiHadWeakAdContext: !!(sameVideoYoutubei[0].adFindings?.hasAnyWeak),
          sameVideoStrongAdCount: sameVideoYoutubei.filter(r => r.adFindings?.hasAnyStrong).length,
          sameVideoNoAdCount: sameVideoYoutubei.filter(r => !r.adFindings || !r.adFindings.hasAnyStrong).length,
          sameVideoTotalRequests: sameVideoYoutubei.length,
        });
      }

      // --- Cross-navigation gap: first youtubei request after navigation ---
      if (nextNav) {
        const crossNavYoutubei = networkRows
          .filter(r =>
            rowEventMs(r) > nextNav.ms &&
            r.categories.includes("youtubei") &&
            ["player", "get_watch", "next"].some(x => r.subCategories.includes(x))
          )
          .sort((a, b) => rowEventMs(a) - rowEventMs(b));

        crossNavigation.push({
          adId: adEnd.adId,
          fromVideoId: gapVideoId,
          toVideoId: nextNav.newVideoId,
          adEndMs: adEnd.ms,
          navigationMs: nextNav.ms,
          adDurationSeconds: adEnd.durationSeconds,
          navDeltaSeconds: parseFloat(((nextNav.ms - adEnd.ms) / 1000).toFixed(1)),
          nextYoutubeiDeltaSeconds: crossNavYoutubei[0]
            ? parseFloat(((rowEventMs(crossNavYoutubei[0]) - adEnd.ms) / 1000).toFixed(1))
            : null,
          nextYoutubeiEndpoint: crossNavYoutubei[0]?.subCategories?.join(",") || null,
          nextYoutubeiHadStrongAdData: crossNavYoutubei[0]
            ? !!(crossNavYoutubei[0].adFindings?.hasAnyStrong)
            : null,
          nextYoutubeiHadWeakAdContext: crossNavYoutubei[0]
            ? !!(crossNavYoutubei[0].adFindings?.hasAnyWeak)
            : null,
          crossNavStrongAdCount: crossNavYoutubei.filter(r => r.adFindings?.hasAnyStrong).length,
          crossNavNoAdCount: crossNavYoutubei.filter(r => !r.adFindings || !r.adFindings.hasAnyStrong).length,
        });
      }
    }

    return { sameVideo, crossNavigation };
  }

  // ---------------------------------------------------------------------------
  // Ad opportunity rows: youtubei requests where an ad COULD appear.
  // Negative result (hadAdData=false) is the cooldown signal.
  // ---------------------------------------------------------------------------

  function adOpportunityRows() {
    return networkRows
      .filter(r =>
        r.categories.includes("youtubei") &&
        ["player", "get_watch", "next"].some(x => r.subCategories.includes(x))
      )
      .map(r => ({
        time: r.time,
        loggedMs: r.ms,
        eventMs: rowEventMs(r),
        videoId: r.videoId,
        endpoint: r.subCategories.join(","),
        hadStrongAdData: !!(r.adFindings && r.adFindings.hasAnyStrong),
        hadWeakAdContext: !!(r.adFindings && r.adFindings.hasAnyWeak),
        strongKeys: r.adFindings?.strongKeys || [],
        weakKeys: r.adFindings?.weakKeys || [],
        foundCount: r.adFindings?.foundCount || 0,
        status: r.responseStatus,
      }));
  }

  // ---------------------------------------------------------------------------
  // Stats / summary
  // ---------------------------------------------------------------------------

  function getStats() {
    const categories = {};
    for (const row of networkRows) {
      const cat = row.primaryCategory;
      categories[cat] = (categories[cat] || 0) + 1;
    }

    const resourceInitiators = {};
    for (const re of resourceEntries) {
      resourceInitiators[re.initiatorType] = (resourceInitiators[re.initiatorType] || 0) + 1;
    }

    return {
      totalNetworkRows: networkRows.length,
      totalEvents: events.length,
      totalCookieSnapshots: cookieSnapshots.length,
      totalPlayerSnapshots: playerStateSnapshots.length,
      totalStorageEvents: storageEvents.length,
      totalResourceEntries: resourceEntries.length,
      currentVideoId,
      currentAdId,
      isAdActive: !!currentAdId,
      networkByCategory: categories,
      resourceByInitiator: resourceInitiators,
      identity: getIdentityState(),
    };
  }

  // ---------------------------------------------------------------------------
  // Filtered query helpers
  // ---------------------------------------------------------------------------

  function getAdRelevantRows() {
    return networkRows.filter(r => r.adFindings && r.adFindings.foundCount > 0);
  }

  function getStrongAdRows() {
    return networkRows.filter(r => r.adFindings && r.adFindings.hasAnyStrong);
  }

  function getRowsByCategory(category) {
    return networkRows.filter(r => r.categories.includes(category));
  }

  // ---------------------------------------------------------------------------
  // Automation / one-click dump helpers
  // ---------------------------------------------------------------------------

  function makeSessionId() {
    return new Date().toISOString().replace(/[:.]/g, "-");
  }

  function safeFilenamePart(value) {
    return String(value || "manual")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "manual";
  }

  function makeDumpFilename(reason) {
    const prefix = config.automation.downloadPrefix || "yt-ad-cooldown-probe";
    return [
      prefix,
      automationState.sessionId,
      safeFilenamePart(reason),
      safeFilenamePart(getCurrentVideoId() || "no-video"),
    ].join("_") + ".json";
  }

  function getActiveAdSessionSummary() {
    const now = performance.now();
    const isAdActive = !!currentAdId;
    return {
      isAdActive,
      currentAdId,
      currentVideoId: getCurrentVideoId(),
      pageUrl: location.href,
      adImpressionStartMs: adImpressionStartTime ? Math.round(adImpressionStartTime) : null,
      activeDurationSeconds: isAdActive && adImpressionStartTime
        ? parseFloat(((now - adImpressionStartTime) / 1000).toFixed(1))
        : 0,
      currentAdTimeline: cloneJson(adTimeline),
      currentPlayerState: detectAdState(),
    };
  }

  function refreshDumpContext(reason) {
    const label = "dump:" + reason;
    snapshotPlayerState(label);
    if (config.cookieSnapshots) snapshotCookies(label, location.href);
    snapshotStorage(label);
  }

  function isAdOpportunityRow(row) {
    return !!(
      row &&
      Array.isArray(row.categories) &&
      Array.isArray(row.subCategories) &&
      row.categories.includes("youtubei") &&
      ["player", "get_watch", "next"].some(x => row.subCategories.includes(x))
    );
  }

  function shouldIncludeBodyJsonInDump(row) {
    if (!config.automation.includeRelevantBodyJsonInDumps || !row || row.isMedia) return false;
    return !!(
      row.adFindings ||
      isAdOpportunityRow(row) ||
      row.primaryCategory === "ad"
    );
  }

  function createFullDump(reason = "manual") {
    const stats = getStats();
    return {
      meta: {
        probe: "yt-ad-cooldown-probe",
        version: "v4",
        reason,
        generatedAt: new Date().toISOString(),
        sessionId: automationState.sessionId,
        pageUrl: location.href,
        checkpointCount: automationCheckpoints.length,
      },
      identity: stats.identity,
      stats,
      activeAdSession: getActiveAdSessionSummary(),
      events: cloneJson(events),
      networkRows: networkRows.map(r => {
        const includeBodyJson = shouldIncludeBodyJsonInDump(r);
        return {
          time: r.time, type: r.type, method: r.method, url: r.url,
          primaryCategory: r.primaryCategory, categories: r.categories,
          subCategories: r.subCategories, adFindings: r.adFindings,
          clientContext: r.clientContext, serviceIntegrity: r.serviceIntegrity,
          playbackContext: r.playbackContext, videoId: r.videoId,
          responseStatus: r.responseStatus, requestStartMs: r.requestStartMs,
          responseEndMs: r.responseEndMs, requestBodyType: r.requestBodyType,
          requestBodyLength: r.requestBodyLength,
          responseHeaders: r.responseHeaders,
          requestBodyPreview: r.requestBodyPreview,
          responseBodyPreview: r.responseBodyPreview,
          requestBodyJson: includeBodyJson ? r.requestBodyJson : undefined,
          responseBodyJson: includeBodyJson ? r.responseBodyJson : undefined,
        };
      }),
      resourceEntries: cloneJson(resourceEntries),
      cookieSnapshots: cloneJson(cookieSnapshots),
      playerStateSnapshots: cloneJson(playerStateSnapshots),
      storageEvents: cloneJson(storageEvents),
      timeline: buildCooldownTimeline(),
      causality: buildCausalityChain(),
      gaps: adGapAnalysis(),
      opportunities: adOpportunityRows(),
      automation: {
        checkpoints: cloneJson(automationCheckpoints),
        lastAction: automationState.lastAction,
        pendingCheckpointReasons: automationState.pendingCheckpointReasons.slice(),
      },
    };
  }

  function copyTextToClipboard(text) {
    try {
      if (typeof copy === "function") {
        copy(text);
        return true;
      }
    } catch {}

    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        navigator.clipboard.writeText(text).catch(() => console.log(text));
        return true;
      }
    } catch {}

    console.log(text);
    return false;
  }

  function downloadJson(data, filename) {
    const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    const blob = new Blob([text], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.rel = "noopener";
    link.style.display = "none";
    document.documentElement.appendChild(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
      link.remove();
    }, 1000);
    return text.length;
  }

  function makeAutomationCheckpoint(reason = "checkpoint") {
    const checkpoint = {
      id: automationState.sessionId + "-" + (automationCheckpoints.length + 1),
      reason,
      time: new Date().toLocaleTimeString(),
      generatedAt: new Date().toISOString(),
      ms: Math.round(performance.now()),
      videoId: getCurrentVideoId(),
      pageUrl: location.href,
      stats: getStats(),
      activeAdSession: getActiveAdSessionSummary(),
      lastEvents: cloneJson(events.slice(-20)),
      lastOpportunities: cloneJson(adOpportunityRows().slice(-20)),
      latestGaps: adGapAnalysis(),
      latestTimeline: cloneJson(buildCooldownTimeline().slice(-40)),
    };

    automationCheckpoints.push(checkpoint);
    while (automationCheckpoints.length > config.automation.maxCheckpoints) {
      automationCheckpoints.shift();
    }

    automationState.lastCheckpoint = checkpoint;
    automationState.lastAction = "checkpoint: " + reason;
    updateAutomationHudSoon();
    return checkpoint;
  }

  function flushAutomationCheckpoint(reason = "manual") {
    if (automationState.pendingCheckpointTimer) {
      clearTimeout(automationState.pendingCheckpointTimer);
      automationState.pendingCheckpointTimer = null;
    }

    const reasons = automationState.pendingCheckpointReasons.splice(0);
    const combinedReason = [...new Set([...reasons, reason])].filter(Boolean).join("+") || reason;
    return makeAutomationCheckpoint(combinedReason);
  }

  function scheduleAutomationCheckpoint(reason, delayMs = config.automation.autoCheckpointDelayMs) {
    if (!config.automation.enabled || !config.automation.autoCheckpoints) return;
    if (reason) automationState.pendingCheckpointReasons.push(reason);

    if (automationState.pendingCheckpointTimer) {
      clearTimeout(automationState.pendingCheckpointTimer);
    }

    automationState.pendingCheckpointTimer = setTimeout(() => {
      automationState.pendingCheckpointTimer = null;
      const reasons = automationState.pendingCheckpointReasons.splice(0);
      makeAutomationCheckpoint([...new Set(reasons)].join("+") || "auto");
    }, delayMs);
  }

  function handleAutomationEvent(event) {
    updateAutomationHudSoon();
    if (!event || !event.event) return;

    const checkpointEvents = new Set([
      "ad-api-request",
      "ad-session-start",
      "ad-session-end",
      "ad-interrupted-by-navigation",
      "ad-navigation-while-active",
      "dom-ad-playing-detected",
      "dom-ad-skip-detected",
      "navigation",
    ]);

    if (checkpointEvents.has(event.event)) {
      scheduleAutomationCheckpoint(event.event);
    }
  }

  function downloadDumpFile(reason = "manual") {
    refreshDumpContext(reason);
    flushAutomationCheckpoint(reason);
    const dump = createFullDump(reason);
    const filename = makeDumpFilename(reason);
    const bytes = downloadJson(dump, filename);
    automationState.lastAction = "downloaded: " + filename;
    updateAutomationHudSoon();
    console.log("[yt-ad-probe] downloaded dump", { filename, bytes });
    return { filename, bytes, checkpointCount: automationCheckpoints.length };
  }

  function copyDumpToClipboard(reason = "manual") {
    refreshDumpContext(reason);
    flushAutomationCheckpoint(reason);
    const text = JSON.stringify(createFullDump(reason), null, 2);
    const copied = copyTextToClipboard(text);
    automationState.lastAction = copied ? "copied dump" : "printed dump";
    updateAutomationHudSoon();
    return text.length;
  }

  function addAutomationMarker(label = "manual") {
    remember({
      event: "manual-marker",
      label,
      identity: getIdentityState(),
    });
    snapshotPlayerState("marker:" + label);
    snapshotCookies("marker:" + label, location.href);
    snapshotStorage("marker:" + label);
    makeAutomationCheckpoint("marker:" + label);
    console.log("%c[yt-ad-probe] marker: " + label, "font-weight:bold;color:#ffcc00");
    return getStats();
  }

  function promptForAutomationMarker() {
    const fallback = "marker-" + new Date().toLocaleTimeString().replace(/[^0-9a-z]+/gi, "-");
    const label = prompt("[yt-ad-probe] Marker label", fallback);
    if (label === null) return null;
    return addAutomationMarker(label || fallback);
  }

  function updateAutomationHudSoon() {
    if (!automationState.hudShadow || automationState.hudUpdateTimer) return;
    automationState.hudUpdateTimer = setTimeout(() => {
      automationState.hudUpdateTimer = null;
      updateAutomationHud();
    }, 250);
  }

  function setHudText(name, value) {
    const el = automationState.hudShadow?.querySelector("[data-field='" + name + "']");
    if (el) el.textContent = String(value);
  }

  function updateAutomationHud() {
    if (!automationState.hudShadow) return;

    const stats = getStats();
    const strongRows = getStrongAdRows().length;
    const adEnds = events.filter(e => e.event === "ad-session-end").length;
    const active = stats.isAdActive ? "ad active" : "watching";
    const lastCheckpoint = automationState.lastCheckpoint
      ? automationState.lastCheckpoint.time + " " + automationState.lastCheckpoint.reason
      : "none";

    setHudText("status", active);
    setHudText("video", stats.currentVideoId || "none");
    setHudText("rows", stats.totalNetworkRows);
    setHudText("events", stats.totalEvents);
    setHudText("ads", adEnds);
    setHudText("strong", strongRows);
    setHudText("checkpoints", automationCheckpoints.length);
    setHudText("lastCheckpoint", lastCheckpoint);
    setHudText("lastAction", automationState.lastAction || "idle");

    const panel = automationState.hudShadow.querySelector(".panel");
    if (panel) panel.classList.toggle("collapsed", !automationState.visible);

    const toggle = automationState.hudShadow.querySelector("[data-action='toggle']");
    if (toggle) toggle.textContent = automationState.visible ? "Hide" : "Show";
  }

  function toggleAutomationHud(forceVisible) {
    automationState.visible = typeof forceVisible === "boolean" ? forceVisible : !automationState.visible;
    updateAutomationHud();
    return automationState.visible;
  }

  function startAutomationHud() {
    if (!config.automation.enabled || !config.automation.hud || automationState.hudRoot) return;
    if (!document.documentElement) return;

    const host = document.createElement("div");
    host.id = "yt-ad-cooldown-probe-hud";
    host.style.position = "fixed";
    host.style.left = "12px";
    host.style.bottom = "12px";
    host.style.zIndex = "2147483647";
    host.style.font = "12px/1.35 Arial, sans-serif";
    host.style.color = "#f8fafc";
    host.style.pointerEvents = "auto";

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        .panel {
          width: 292px;
          border: 1px solid rgba(255,255,255,.18);
          border-radius: 8px;
          background: rgba(18, 22, 28, .94);
          box-shadow: 0 12px 30px rgba(0,0,0,.35);
          overflow: hidden;
          backdrop-filter: blur(8px);
        }
        .top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 8px 9px;
          border-bottom: 1px solid rgba(255,255,255,.12);
        }
        .title {
          font-weight: 700;
          color: #e5f7ff;
        }
        .body {
          padding: 8px 9px 9px;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 6px;
          margin-bottom: 8px;
        }
        .metric {
          min-width: 0;
          border: 1px solid rgba(255,255,255,.12);
          border-radius: 6px;
          padding: 5px 6px;
          background: rgba(255,255,255,.05);
        }
        .metric span {
          display: block;
          color: #93c5fd;
          font-size: 10px;
          text-transform: uppercase;
        }
        .metric strong {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .line {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: #d1d5db;
          margin: 4px 0;
        }
        .actions {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 6px;
          margin-top: 8px;
        }
        button {
          border: 1px solid rgba(255,255,255,.16);
          border-radius: 6px;
          color: #f8fafc;
          background: rgba(255,255,255,.08);
          padding: 5px 6px;
          font: inherit;
          cursor: pointer;
        }
        button:hover {
          background: rgba(255,255,255,.16);
        }
        .primary {
          background: #0f766e;
          border-color: #14b8a6;
        }
        .primary:hover {
          background: #0d9488;
        }
        .collapsed {
          width: auto;
        }
        .collapsed .body {
          display: none;
        }
        .collapsed .top {
          border-bottom: 0;
        }
      </style>
      <div class="panel">
        <div class="top">
          <div class="title">YT ad probe</div>
          <button data-action="toggle" title="Alt+Shift+H">Hide</button>
        </div>
        <div class="body">
          <div class="grid">
            <div class="metric"><span>State</span><strong data-field="status">watching</strong></div>
            <div class="metric"><span>Rows</span><strong data-field="rows">0</strong></div>
            <div class="metric"><span>Ads</span><strong data-field="ads">0</strong></div>
            <div class="metric"><span>Strong</span><strong data-field="strong">0</strong></div>
          </div>
          <div class="line">video: <span data-field="video">none</span></div>
          <div class="line">events: <span data-field="events">0</span> | checkpoints: <span data-field="checkpoints">0</span></div>
          <div class="line">last checkpoint: <span data-field="lastCheckpoint">none</span></div>
          <div class="line">last action: <span data-field="lastAction">idle</span></div>
          <div class="actions">
            <button class="primary" data-action="download" title="Alt+Shift+D">Dump</button>
            <button data-action="copy" title="Alt+Shift+C">Copy</button>
            <button data-action="mark" title="Alt+Shift+M">Mark</button>
            <button data-action="clear">Clear</button>
          </div>
        </div>
      </div>
    `;

    shadow.querySelector("[data-action='download']").addEventListener("click", () => downloadDumpFile("hud"));
    shadow.querySelector("[data-action='copy']").addEventListener("click", () => copyDumpToClipboard("hud"));
    shadow.querySelector("[data-action='mark']").addEventListener("click", () => promptForAutomationMarker());
    shadow.querySelector("[data-action='clear']").addEventListener("click", () => {
      if (confirm("[yt-ad-probe] Clear captured data?")) {
        g.__YT_AD_COOLDOWN_PROBE__?.clear();
      }
    });
    shadow.querySelector("[data-action='toggle']").addEventListener("click", () => toggleAutomationHud());

    document.documentElement.appendChild(host);
    automationState.hudRoot = host;
    automationState.hudShadow = shadow;
    updateAutomationHud();
    automationState.hudStatusTimer = setInterval(updateAutomationHud, 1000);
  }

  function onAutomationKeydown(event) {
    if (!config.automation.enabled || !config.automation.hotkeys) return;
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;

    const key = String(event.key || "").toLowerCase();
    if (!["d", "c", "m", "h", "s"].includes(key)) return;

    event.preventDefault();
    event.stopPropagation();

    if (key === "d") downloadDumpFile("hotkey");
    else if (key === "c") copyDumpToClipboard("hotkey");
    else if (key === "m") promptForAutomationMarker();
    else if (key === "h") toggleAutomationHud();
    else if (key === "s") makeAutomationCheckpoint("hotkey-snapshot");
  }

  function startAutomationHotkeys() {
    if (!config.automation.enabled || !config.automation.hotkeys || automationState.hotkeysInstalled) return;
    document.addEventListener("keydown", onAutomationKeydown, true);
    automationState.hotkeysInstalled = true;
  }

  function startAutomation() {
    if (!config.automation.enabled) return;

    startAutomationHotkeys();
    if (document.body || document.documentElement) {
      startAutomationHud();
    } else {
      document.addEventListener("DOMContentLoaded", startAutomationHud, { once: true });
    }
  }

  function stopAutomation() {
    if (automationState.pendingCheckpointTimer) {
      clearTimeout(automationState.pendingCheckpointTimer);
      automationState.pendingCheckpointTimer = null;
    }
    if (automationState.hudUpdateTimer) {
      clearTimeout(automationState.hudUpdateTimer);
      automationState.hudUpdateTimer = null;
    }
    if (automationState.hudStatusTimer) {
      clearInterval(automationState.hudStatusTimer);
      automationState.hudStatusTimer = null;
    }
    if (automationState.hotkeysInstalled) {
      document.removeEventListener("keydown", onAutomationKeydown, true);
      automationState.hotkeysInstalled = false;
    }
    if (automationState.hudRoot) {
      automationState.hudRoot.remove();
      automationState.hudRoot = null;
      automationState.hudShadow = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  g.__YT_AD_COOLDOWN_PROBE__ = {
    config,
    events,
    networkRows,
    cookieSnapshots,
    playerStateSnapshots,
    resourceEntries,
    storageEvents,
    adTimeline,
    automationCheckpoints,

    stats() {
      const s = getStats();
      console.table(s.networkByCategory);
      if (Object.keys(s.resourceByInitiator).length) {
        console.table(s.resourceByInitiator);
      }
      return s;
    },

    identity() {
      const i = getIdentityState();
      console.log("[yt-ad-probe] identity snapshot", i);
      return i;
    },

    timeline() {
      const t = buildCooldownTimeline();
      console.table(t.map(e => ({
        type: e.type,
        time: e.time,
        videoId: e.videoId || e.fromVideoId || "",
        durationSeconds: e.durationSeconds,
        adKeys: e.adKeys?.join(",") || "",
      })));
      return t;
    },

    causality() {
      const chain = buildCausalityChain();
      for (const sess of chain) {
        console.group("[yt-ad-probe] ad session " + sess.adId);
        console.table(sess.steps.map(s => ({
          phase: s.phase,
          ms: s.ms,
          deltaFromPreviousMs: s.deltaFromPreviousMs,
          endpoint: s.endpoint || "",
          url: s.url || "",
          adKeys: (s.adKeys || []).join(","),
        })));
        console.log(
          "Next opportunity:",
          sess.nextOpportunityDeltaMs !== null ? sess.nextOpportunityDeltaMs + "ms" : "none",
          sess.nextOpportunityEndpoint ? "(" + sess.nextOpportunityEndpoint + ")" : "",
          sess.nextOpportunityHadStrongAdData === true ? "[STRONG ad data]" :
          sess.nextOpportunityHadWeakAdContext === true ? "[weak context]" :
          sess.nextOpportunityHadStrongAdData === false ? "[NO AD DATA = cooldown]" : ""
        );
        console.groupEnd();
      }
      return chain;
    },

    gaps() {
      const g = adGapAnalysis();
      if (g.sameVideo.length) {
        console.log("%c[yt-ad-probe] same-video gaps", "font-weight:bold;color:#00cc66");
        console.table(g.sameVideo.map(r => ({
          videoId: r.videoId,
          adDurationS: r.adDurationSeconds,
          nextYoutubeiDeltaS: r.nextYoutubeiDeltaSeconds,
          nextEndpoint: r.nextYoutubeiEndpoint,
          hadStrongAd: r.nextYoutubeiHadStrongAdData,
          hadWeakCtx: r.nextYoutubeiHadWeakAdContext,
          noAdCount: r.sameVideoNoAdCount,
          totalReqs: r.sameVideoTotalRequests,
        })));
      }
      if (g.crossNavigation.length) {
        console.log("%c[yt-ad-probe] cross-navigation gaps", "font-weight:bold;color:#ffcc00");
        console.table(g.crossNavigation.map(r => ({
          fromVideoId: r.fromVideoId,
          toVideoId: r.toVideoId,
          adDurationS: r.adDurationSeconds,
          navDeltaS: r.navDeltaSeconds,
          nextYoutubeiDeltaS: r.nextYoutubeiDeltaSeconds,
          hadStrongAd: r.nextYoutubeiHadStrongAdData,
          hadWeakCtx: r.nextYoutubeiHadWeakAdContext,
        })));
      }
      return g;
    },

    adRows() {
      return getAdRelevantRows();
    },

    strongAdRows() {
      return getStrongAdRows();
    },

    adSummary() {
      const rows = getAdRelevantRows();
      return rows.map(r => ({
        time: r.time,
        url: r.url.slice(Math.max(0, r.url.indexOf("/youtubei/")), Math.min(r.url.length, r.url.indexOf("/youtubei/") + 50)),
        subCategories: r.subCategories.join(","),
        adFoundKeys: r.adFindings?.distinctKeys?.join(",") || "",
        adFoundCount: r.adFindings?.foundCount || 0,
        status: r.responseStatus,
      }));
    },

    // Ad opportunity rows: all youtubei requests where an ad COULD have appeared.
    // hadAdData=false rows are the cooldown evidence.
    opportunities() {
      const rows = adOpportunityRows();
      console.table(rows.map(r => ({
        time: r.time,
        endpoint: r.endpoint,
        videoId: r.videoId,
        eventMs: r.eventMs,
        strong: r.hadStrongAdData,
        weak: r.hadWeakAdContext,
        strongKeys: r.strongKeys.join(","),
        weakKeys: r.weakKeys.join(","),
        status: r.status,
      })));
      return rows;
    },

    rowsByCategory(category) {
      return getRowsByCategory(category);
    },

    // Resource entries (PerformanceObserver + sendBeacon)
    resourceSummary() {
      return resourceEntries.map(r => ({
        time: r.time,
        initiatorType: r.initiatorType,
        url: r.name.slice(0, 120),
        categories: r.categories.join(","),
      }));
    },

    // Cookie analysis
    cookieDiff(indexA, indexB) {
      const a = cookieSnapshots[indexA];
      const b = cookieSnapshots[indexB];
      if (!a || !b) return null;

      const diff = { added: {}, removed: {}, changed: {} };
      const allKeys = new Set([...Object.keys(a.cookies), ...Object.keys(b.cookies)]);
      for (const key of allKeys) {
        if (!(key in a.cookies)) diff.added[key] = b.cookies[key];
        else if (!(key in b.cookies)) diff.removed[key] = a.cookies[key];
        else if (a.cookies[key] !== b.cookies[key]) diff.changed[key] = { from: a.cookies[key], to: b.cookies[key] };
      }
      return diff;
    },

    lastCookieSnapshot() {
      return cookieSnapshots[cookieSnapshots.length - 1] || null;
    },

    lastPlayerSnapshot() {
      return playerStateSnapshots[playerStateSnapshots.length - 1] || null;
    },

    adSessionActive() {
      return !!currentAdId;
    },

    currentAdTimeline() {
      return cloneJson(adTimeline);
    },

    // Manual phase markers for controlled testing.
    // Use these during a research session to timestamp key moments.
    // Per-video cooldown state: for each video that had an ad end,
    // how long ago and whether any ad-eligible requests since then had ad data.
    videoCooldown() {
      const entries = [];
      for (const [videoId, endMs] of Object.entries(lastAdEndByVideoId)) {
        const secondsAgo = parseFloat(((performance.now() - endMs) / 1000).toFixed(1));
        const requestsSince = networkRows
          .filter(r =>
            rowEventMs(r) > endMs &&
            r.videoId === videoId &&
            r.categories.includes("youtubei") &&
            ["player", "get_watch", "next"].some(x => r.subCategories.includes(x))
          )
          .sort((a, b) => rowEventMs(a) - rowEventMs(b));
        entries.push({
          videoId,
          adEndedSecondsAgo: secondsAgo,
          requestsSinceEnd: requestsSince.length,
          hadStrongAdSince: requestsSince.some(r => r.adFindings?.hasAnyStrong),
          hadWeakCtxSince: requestsSince.some(r => r.adFindings?.hasAnyWeak),
          allHadNoAdSince: requestsSince.length > 0 && requestsSince.every(r => !r.adFindings || !r.adFindings.hasAnyStrong),
        });
      }
      console.table(entries);
      return entries;
    },

    mark(label) {
      return addAutomationMarker(label);
    },

    probeNow(reason = "manual") {
      snapshotPlayerState(reason);
      snapshotCookies(reason, location.href);
      snapshotStorage(reason);
      return getStats();
    },

    checkpoint(reason = "manual") {
      refreshDumpContext("checkpoint:" + reason);
      return makeAutomationCheckpoint(reason);
    },

    checkpoints() {
      console.table(automationCheckpoints.map(c => ({
        time: c.time,
        reason: c.reason,
        videoId: c.videoId,
        rows: c.stats.totalNetworkRows,
        events: c.stats.totalEvents,
      })));
      return automationCheckpoints;
    },

    getFullDump(reason = "manual") {
      refreshDumpContext(reason);
      return createFullDump(reason);
    },

    downloadFullDump(reason = "manual") {
      return downloadDumpFile(reason);
    },

    showHud() {
      startAutomationHud();
      return toggleAutomationHud(true);
    },

    hideHud() {
      return toggleAutomationHud(false);
    },

    toggleHud() {
      return toggleAutomationHud();
    },

    // Clipboard
    copyEvents() {
      const text = JSON.stringify(events, null, 2);
      try { copy(text); } catch { console.log(text); }
      return events.length;
    },

    copyAdRows() {
      const rows = getAdRelevantRows();
      const text = JSON.stringify(rows, null, 2);
      try { copy(text); } catch { console.log(text); }
      return rows.length;
    },

    copyStrongAdRows() {
      const rows = getStrongAdRows();
      const text = JSON.stringify(rows, null, 2);
      try { copy(text); } catch { console.log(text); }
      return rows.length;
    },

    copyTimeline() {
      const t = buildCooldownTimeline();
      const text = JSON.stringify(t, null, 2);
      try { copy(text); } catch { console.log(text); }
      return t.length;
    },

    copyGaps() {
      const g = adGapAnalysis();
      const text = JSON.stringify(g, null, 2);
      try { copy(text); } catch { console.log(text); }
      return (g.sameVideo?.length || 0) + (g.crossNavigation?.length || 0);
    },

    copyCausality() {
      const c = buildCausalityChain();
      const text = JSON.stringify(c, null, 2);
      try { copy(text); } catch { console.log(text); }
      return c.length;
    },

    copyIdentity() {
      const text = JSON.stringify(getIdentityState(), null, 2);
      try { copy(text); } catch { console.log(text); }
      return text.length;
    },

    copyCookieSnapshots() {
      const text = JSON.stringify(cookieSnapshots, null, 2);
      try { copy(text); } catch { console.log(text); }
      return cookieSnapshots.length;
    },

    copyResourceEntries() {
      const text = JSON.stringify(resourceEntries, null, 2);
      try { copy(text); } catch { console.log(text); }
      return resourceEntries.length;
    },

    copyFullDump() {
      return copyDumpToClipboard("manual-copy");
    },

    // Management
    clear() {
      events.length = 0;
      networkRows.length = 0;
      cookieSnapshots.length = 0;
      playerStateSnapshots.length = 0;
      storageEvents.length = 0;
      resourceEntries.length = 0;
      adTimeline.length = 0;
      automationCheckpoints.length = 0;
      if (automationState.pendingCheckpointTimer) {
        clearTimeout(automationState.pendingCheckpointTimer);
        automationState.pendingCheckpointTimer = null;
      }
      automationState.pendingCheckpointReasons.length = 0;
      automationState.lastCheckpoint = null;
      automationState.lastAction = "cleared";
      automationState.sessionId = makeSessionId();
      currentAdId = "";
      adImpressionStartTime = 0;
      lastCookieSnapshotTime = 0;
      lastStorageSnapshotTime = 0;
      for (const key of Object.keys(lastAdEndByVideoId)) {
        delete lastAdEndByVideoId[key];
      }
      updateAutomationHudSoon();
      console.log("[yt-ad-probe] all state cleared");
    },

    stop() {
      stopAutomation();
      stopPlayerPolling();
      stopAdContainerWatching();
      stopResourceObserver();
      document.removeEventListener("yt-navigate-finish", onNavigate, true);
      window.removeEventListener("popstate", onPopState, true);
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
      g.fetch = nativeFetch;
      XMLHttpRequest.prototype.open = nativeOpen;
      XMLHttpRequest.prototype.send = nativeSend;
      XMLHttpRequest.prototype.setRequestHeader = nativeSetRequestHeader;
      if (nativeSendBeacon) navigator.sendBeacon = nativeSendBeacon;
      restoreStoragePrototype();
      console.log("[yt-ad-probe] stopped and all hooks restored");
    },
  };

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  currentVideoId = getCurrentVideoId();

  if (config.hookStorage) {
    patchStoragePrototype();
  }

  if (config.cookieSnapshots) {
    snapshotCookies("probe-installed", location.href);
  }
  snapshotStorage("probe-installed");

  startPlayerPolling();
  startAdContainerWatching();
  startResourceObserver();
  startAutomation();

  remember({
    event: "probe-installed",
    identity: getIdentityState(),
    currentVideoId,
  });

  console.log(
    "%c[yt-ad-probe] v4 installed. Hands-off recorder is running.\n" +
    "  HUD: Dump / Copy / Mark / Clear buttons on the page\n" +
    "  Hotkeys: Alt+Shift+D dump, Alt+Shift+C copy, Alt+Shift+M mark, Alt+Shift+S checkpoint, Alt+Shift+H hide\n" +
    "  Console still works: __YT_AD_COOLDOWN_PROBE__.downloadFullDump(), .copyFullDump(), .stats(), .timeline(), .gaps()",
    "font-weight:bold;color:#00cc66"
  );
})();
