yt-stream-spoof-probe.js text/javascript
// yt-stream-spoof-probe.js
// Dev-only Chroma user scriptlet resource.
// Rule:
// www.youtube.com##+js(yt-stream-spoof-probe)

(() => {
  const g = globalThis;

  if (g.__CHROMA_YT_STREAM_SPOOF_PROBE__?.stop) {
    g.__CHROMA_YT_STREAM_SPOOF_PROBE__.stop();
  }

  const nativeFetch = g.fetch;
  const logs = [];
  const STORAGE_KEY = "__chroma_yt_stream_spoof_probe_logs__";

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (Array.isArray(saved)) logs.push(...saved.slice(-50));
  } catch {}

  const CONFIG = {
    enabled: true,
    timeoutMs: 3500,
    maxClients: 3,
    autoProbe: true,
    debounceMs: 750,
  };

  const CLIENTS = [
    {
      key: "WEB_LEGACY",
      clientName: "WEB",
      clientVersion: "1.20160315",
      platform: "DESKTOP",
      requireJS: true,
    },
    {
      key: "VISIONOS",
      clientName: "VISIONOS",
      clientVersion: "0.1",
      platform: "DESKTOP",
      deviceMake: "Apple",
      deviceModel: "RealityDevice14,1",
      osName: "visionOS",
      osVersion: "1.3.21O771",
      requireJS: false,
    },
    {
      key: "ANDROID_VR",
      clientName: "ANDROID_VR",
      clientVersion: "1.65.10",
      platform: "MOBILE",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      osName: "Android",
      osVersion: "14",
      androidSdkVersion: "34",
      requireJS: false,
    },
  ];

  let timer = null;
  let lastProbeKey = "";

  function log(...args) {
    console.log("%c[chroma-stream-probe]", "font-weight:bold;color:#7a4cff", ...args);
  }

  function warn(...args) {
    console.warn("[chroma-stream-probe]", ...args);
  }

  function saveLogs() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(logs.slice(-50)));
    } catch {}
  }

  function pushLog(record) {
    logs.push(record);
    while (logs.length > 50) logs.shift();
    saveLogs();
  }

  function getCurrentVideoId() {
    try {
      const url = new URL(location.href);
      const v = url.searchParams.get("v");
      if (v) return v;
    } catch {}

    try {
      const player = document.querySelector("ytd-watch-flexy")?.getAttribute("video-id");
      if (player) return player;
    } catch {}

    return null;
  }

  function collectStrings(value, out = []) {
    if (!value || out.length > 750) return out;

    if (typeof value === "string") {
      out.push(value);
      return out;
    }

    if (Array.isArray(value)) {
      for (const item of value) collectStrings(item, out);
      return out;
    }

    if (typeof value === "object") {
      for (const item of Object.values(value)) collectStrings(item, out);
    }

    return out;
  }

  function hasSabr(streamingData) {
    return collectStrings(streamingData).some(s => {
      const x = s.toLowerCase();
      return (
        x.includes("sabr=1") ||
        x.includes("sabr%3d1") ||
        x.includes("serverabrstreamingurl")
      );
    });
  }

  function hasUsableStreamingData(playerResponse) {
    const sd = playerResponse?.streamingData;
    if (!sd) return false;

    return (
      (Array.isArray(sd.formats) && sd.formats.length > 0) ||
      (Array.isArray(sd.adaptiveFormats) && sd.adaptiveFormats.length > 0) ||
      typeof sd.serverAbrStreamingUrl === "string"
    );
  }

  function summarize(playerResponse) {
    const sd = playerResponse?.streamingData || {};
    const formats = Array.isArray(sd.formats) ? sd.formats : [];
    const adaptive = Array.isArray(sd.adaptiveFormats) ? sd.adaptiveFormats : [];
    const all = formats.concat(adaptive);

    return {
      status: playerResponse?.playabilityStatus?.status || "",
      reason: playerResponse?.playabilityStatus?.reason || "",
      playableInEmbed: playerResponse?.playabilityStatus?.playableInEmbed ?? null,
      formats: formats.length,
      adaptiveFormats: adaptive.length,
      hasServerAbr: typeof sd.serverAbrStreamingUrl === "string",
      hasSabr: hasSabr(sd),
      hasAudio: all.some(f => String(f.mimeType || "").includes("audio")),
      hasVideo: all.some(f => String(f.mimeType || "").includes("video")),
      maxHeight: Math.max(0, ...all.map(f => Number(f.height || 0))),
      itags: all.map(f => f.itag).filter(Boolean).slice(0, 20),
    };
  }

  function makeSpoofBody(client, videoId) {
    const clientObj = {
      clientName: client.clientName,
      clientVersion: client.clientVersion,
      hl: "en",
      gl: "US",
    };

    if (client.platform) clientObj.platform = client.platform;
    if (client.deviceMake) clientObj.deviceMake = client.deviceMake;
    if (client.deviceModel) clientObj.deviceModel = client.deviceModel;
    if (client.osName) clientObj.osName = client.osName;
    if (client.osVersion) clientObj.osVersion = client.osVersion;
    if (client.androidSdkVersion) clientObj.androidSdkVersion = client.androidSdkVersion;

    const body = {
      context: {
        client: clientObj,
      },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    };

    if (client.requireJS) {
      body.playbackContext = {
        contentPlaybackContext: {
          referer: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
          html5Preference: "HTML5_PREF_WANTS",
        },
        devicePlaybackCapabilities: {
          supportsVp9Encoding: true,
          supportXhr: true,
        },
      };
    }

    return body;
  }

  async function probeClient(client, videoId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);

    try {
      const res = await nativeFetch("/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-YouTube-Client-Name": client.clientName,
          "X-YouTube-Client-Version": client.clientVersion,
        },
        body: JSON.stringify(makeSpoofBody(client, videoId)),
        signal: controller.signal,
      });

      if (!res.ok) {
        return {
          client: client.key,
          ok: false,
          reason: `http_${res.status}`,
        };
      }

      const json = await res.json();
      const summary = summarize(json);

      if (summary.status && summary.status !== "OK") {
        return {
          client: client.key,
          ok: false,
          reason: `playability_${summary.status}`,
          summary,
        };
      }

      if (!hasUsableStreamingData(json)) {
        return {
          client: client.key,
          ok: false,
          reason: "no_usable_streaming_data",
          summary,
        };
      }

      return {
        client: client.key,
        ok: true,
        nonSabr: !summary.hasSabr,
        reason: "",
        summary,
      };
    } catch (err) {
      return {
        client: client.key,
        ok: false,
        reason: err?.name === "AbortError" ? "timeout" : "exception",
        error: String(err?.message || err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function probeNow(reason = "manual") {
    if (!CONFIG.enabled) return null;

    const videoId = getCurrentVideoId();

    if (!videoId) {
      warn("no current video id");
      return null;
    }

    const probeKey = `${videoId}:${reason}:${Date.now()}`;
    lastProbeKey = probeKey;

    log("probing current video", { videoId, reason });

    const results = [];

    for (const client of CLIENTS.slice(0, CONFIG.maxClients)) {
      const result = await probeClient(client, videoId);
      results.push(result);

      if (result.ok && result.nonSabr) break;
    }

    const record = {
      time: new Date().toLocaleTimeString(),
      reason,
      videoId,
      results,
    };

    pushLog(record);

    log("probe result", record);

    console.table(results.map(r => ({
      client: r.client,
      ok: r.ok,
      nonSabr: r.nonSabr,
      reason: r.reason,
      error: r.error,
      status: r.summary?.status,
      formats: r.summary?.formats,
      adaptiveFormats: r.summary?.adaptiveFormats,
      hasSabr: r.summary?.hasSabr,
      hasServerAbr: r.summary?.hasServerAbr,
      hasAudio: r.summary?.hasAudio,
      hasVideo: r.summary?.hasVideo,
      maxHeight: r.summary?.maxHeight,
      itags: r.summary?.itags?.join(","),
    })));

    return record;
  }

  function scheduleProbe(reason) {
    if (!CONFIG.autoProbe) return;

    clearTimeout(timer);

    timer = setTimeout(() => {
      const videoId = getCurrentVideoId();
      if (!videoId) return;

      const key = `${videoId}:${reason}`;
      if (lastProbeKey.startsWith(`${videoId}:`)) return;

      probeNow(reason);
    }, CONFIG.debounceMs);
  }

  function onNavigate() {
    lastProbeKey = "";
    scheduleProbe("navigate");
  }

  document.addEventListener("yt-navigate-finish", onNavigate, true);
  document.addEventListener("yt-page-data-updated", onNavigate, true);
  window.addEventListener("popstate", onNavigate, true);

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function patchedPushState() {
    const result = originalPushState.apply(this, arguments);
    onNavigate();
    return result;
  };

  history.replaceState = function patchedReplaceState() {
    const result = originalReplaceState.apply(this, arguments);
    onNavigate();
    return result;
  };

  g.__CHROMA_YT_STREAM_SPOOF_PROBE__ = {
    config: CONFIG,
    logs,

    probeNow,

    latest() {
      return logs[logs.length - 1] || null;
    },

    clear() {
      logs.length = 0;
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {}
      log("logs cleared");
    },

    copy() {
      const text = JSON.stringify(logs, null, 2);
      try {
        copy(text);
        log(`copied ${logs.length} log(s)`);
      } catch {
        console.log(text);
      }
    },

    stop() {
      clearTimeout(timer);
      document.removeEventListener("yt-navigate-finish", onNavigate, true);
      document.removeEventListener("yt-page-data-updated", onNavigate, true);
      window.removeEventListener("popstate", onNavigate, true);
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
      log("stopped");
    },
  };

  log("installed active-probe version. Use __CHROMA_YT_STREAM_SPOOF_PROBE__.probeNow()");
  scheduleProbe("install");
})();
