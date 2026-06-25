// yt-stream-spoof-probe.user.js
// Dev-only Chroma user script.
// Match: *://www.youtube.com/*
// Run at: document_start
// World: MAIN

(() => {
  const g = globalThis;

  if (g.__CHROMA_YT_STREAM_SPOOF_PROBE__?.stop) {
    g.__CHROMA_YT_STREAM_SPOOF_PROBE__.stop();
  }

  const nativeFetch = g.fetch;
  const INTERNAL_HEADER = "X-Chroma-Stream-Probe";
  const logs = [];

  const CONFIG = {
    enabled: true,
    replace: false, // keep false for v1
    timeoutMs: 2500,
    maxClients: 3,
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

  function log(...args) {
    console.log("%c[chroma-stream-probe]", "font-weight:bold;color:#7a4cff", ...args);
  }

  function warn(...args) {
    console.warn("[chroma-stream-probe]", ...args);
  }

  function getUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.href;
    if (input?.url) return input.url;
    return "";
  }

  function isPlayerUrl(url) {
    try {
      const u = new URL(String(url), location.href);
      return (
        u.hostname.endsWith("youtube.com") &&
        u.pathname.includes("/youtubei/v1/player")
      );
    } catch {
      return false;
    }
  }

  function hasInternalHeader(input, init) {
    try {
      const headers = new Headers(init?.headers || input?.headers || undefined);
      return headers.has(INTERNAL_HEADER);
    } catch {
      return false;
    }
  }

  async function readRequestJson(input, init) {
    try {
      if (typeof init?.body === "string") return JSON.parse(init.body);

      if (input instanceof Request) {
        const text = await input.clone().text();
        return text ? JSON.parse(text) : null;
      }
    } catch {}

    return null;
  }

  function getVideoId(body) {
    return body?.videoId || body?.playerRequest?.videoId || null;
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
      formats: formats.length,
      adaptiveFormats: adaptive.length,
      hasServerAbr: typeof sd.serverAbrStreamingUrl === "string",
      hasSabr: hasSabr(sd),
      hasAudio: all.some(f => String(f.mimeType || "").includes("audio")),
      hasVideo: all.some(f => String(f.mimeType || "").includes("video")),
      maxHeight: Math.max(0, ...all.map(f => Number(f.height || 0))),
      itags: all.map(f => f.itag).filter(Boolean).slice(0, 16),
    };
  }

  function makeSpoofBody(client, originalBody, videoId) {
    const originalClient = originalBody?.context?.client || {};

    const clientObj = {
      clientName: client.clientName,
      clientVersion: client.clientVersion,
      hl: originalClient.hl || "en",
      gl: originalClient.gl || "US",
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

  async function probeClient(url, client, originalBody, videoId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);

    try {
      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      headers.set("X-YouTube-Client-Name", client.clientName);
      headers.set("X-YouTube-Client-Version", client.clientVersion);
      headers.set(INTERNAL_HEADER, "1");

      const res = await nativeFetch(url, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify(makeSpoofBody(client, originalBody, videoId)),
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

  async function probeAll(url, originalBody, videoId) {
    const results = [];

    for (const client of CLIENTS.slice(0, CONFIG.maxClients)) {
      const result = await probeClient(url, client, originalBody, videoId);
      results.push(result);

      if (result.ok && result.nonSabr) break;
    }

    return results;
  }

  g.fetch = async function chromaStreamProbeFetch(input, init) {
    const url = getUrl(input);

    if (
      !CONFIG.enabled ||
      hasInternalHeader(input, init) ||
      !isPlayerUrl(url)
    ) {
      return nativeFetch.apply(this, arguments);
    }

    const originalBody = await readRequestJson(input, init);
    const videoId = getVideoId(originalBody);

    const response = await nativeFetch.apply(this, arguments);

    if (!videoId) return response;

    try {
      const json = await response.clone().json();
      const normal = summarize(json);

      const results = await probeAll(url, originalBody, videoId);

      const record = {
        time: new Date().toLocaleTimeString(),
        videoId,
        normal,
        results,
      };

      logs.push(record);

      log("probe result", record);

      console.table(results.map(r => ({
        client: r.client,
        ok: r.ok,
        nonSabr: r.nonSabr,
        reason: r.reason,
        status: r.summary?.status,
        formats: r.summary?.formats,
        adaptiveFormats: r.summary?.adaptiveFormats,
        hasSabr: r.summary?.hasSabr,
        hasServerAbr: r.summary?.hasServerAbr,
        hasAudio: r.summary?.hasAudio,
        hasVideo: r.summary?.hasVideo,
        maxHeight: r.summary?.maxHeight,
      })));
    } catch (err) {
      warn("probe failed", err);
    }

    return response;
  };

  g.__CHROMA_YT_STREAM_SPOOF_PROBE__ = {
    config: CONFIG,
    logs,

    enable() {
      CONFIG.enabled = true;
      log("enabled");
    },

    disable() {
      CONFIG.enabled = false;
      log("disabled");
    },

    stop() {
      g.fetch = nativeFetch;
      log("stopped");
    },
  };

  log("installed. Click a fresh video. Inspect with __CHROMA_YT_STREAM_SPOOF_PROBE__.logs");
})();
