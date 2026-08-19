// ==UserScript==
// @name         GeoGuessr Meta Trainer
// @namespace    sightline-orlando-meta
// @version      2.2.0-beta.7
// @description  Post-round visual similarity for any Street View map, from a precomputed million-panorama corpus.
// @homepageURL  https://github.com/ObsidianArmor1/geoguessr-meta-trainer
// @supportURL   https://github.com/ObsidianArmor1/geoguessr-meta-trainer/issues
// @match        https://www.geoguessr.com/*
// @require      https://raw.githubusercontent.com/miraclewhips/geoguessr-event-framework/5e449d6b64c828fce5d2915772d61c7f95263e34/geoguessr-event-framework.js
// @require      https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/ort.webgpu.min.js
// @require      https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/f1006b4177886b80a3921ccc27030dd9f3a9721b/src/universal-similarity.js
// @require      https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/main/src/portable-api.js
// @require      https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/main/src/live-challenge-adapter.js
// @require      https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/main/src/lodestar-pack.js
// @require      https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/main/src/cradio-client.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @connect      streetviewpixels-pa.googleapis.com
// @connect      obsidianarmor1--geoguessr-cradio-pilot-v1-pilot-query.modal.run
// @connect      obsidianarmor1--geoguessr-cradio-lodestar-v1-pilot-query.modal.run
// @updateURL    https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/main/src/geoguessr-meta-trainer.user.js
// @downloadURL  https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/main/src/geoguessr-meta-trainer.user.js
// @run-at       document-start
// @license      MIT
// ==/UserScript==

// Integration credits:
// - GeoGuessr Event Framework, copyright (c) 2023 miraclewhips, MIT License.
// - Google Maps MVCObject capture pattern adapted from GeoGuessr Path Logger Plus,
//   copyright (c) 2026 Odinman9847, MIT License.
// - Party-lobby Live Challenge discovery follows the maintained Learnable Meta
//   userscript by likeon (MIT): route/resource tracking plus the authenticated
//   Live Challenge state endpoint.

(function () {
  "use strict";

  const DATA_BASE = "https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/main/data";
  const USERSCRIPT_VERSION = "2.1.0-beta.7";
  // ONNX Runtime's classic browser bundle declares `var ort` in the shared
  // userscript wrapper. Tampermonkey does not necessarily reflect that lexical
  // binding onto `globalThis`, while the separately required universal module
  // resolves dependencies through `globalThis`. Bridge the two explicitly.
  const browserVisionRuntime = typeof ort !== "undefined" ? ort : globalThis.ort;
  if (browserVisionRuntime && !globalThis.ort) globalThis.ort = browserVisionRuntime;
  const portableTransport = (url) => new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: "GET",
      url,
      responseType: "arraybuffer",
      // The first arbitrary-map run downloads two browser models. GitHub's
      // raw-file throughput can occasionally take longer than 30 seconds on
      // otherwise healthy connections; do not turn that into a false outage.
      timeout: 120000,
      onload: (response) => {
        if (response.status >= 200 && response.status < 300) resolve(response.response);
        else reject(new Error(`Portable trainer returned ${response.status}`));
      },
      onerror: () => reject(new Error("Could not download the portable trainer data")),
      ontimeout: () => reject(new Error("Portable trainer data download timed out")),
    });
  });
  const portableApi = new globalThis.OMTPortableAPI({
    baseUrl: DATA_BASE,
    transport: portableTransport,
  });
  const PENDING_EXPOSURE_STORAGE_KEY = "omt-pending-visual-exposure-v1";
  const INSTALL_ID_STORAGE_KEY = "omt-learner-install-id-v1";
  const EXPOSURE_SEQUENCE_STORAGE_KEY = "omt-learner-sequence-v1";
  const randomId = () => (
    crypto.randomUUID?.()
    || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
  const INSTALL_ID = (() => {
    const existing = localStorage.getItem(INSTALL_ID_STORAGE_KEY);
    if (existing) return existing;
    const created = randomId();
    localStorage.setItem(INSTALL_ID_STORAGE_KEY, created);
    return created;
  })();
  const TAB_ID = randomId();
  function nextLearnerSequence() {
    let previous = 0;
    try {
      previous = Number(localStorage.getItem(EXPOSURE_SEQUENCE_STORAGE_KEY)) || 0;
    } catch (_error) {}
    const next = Math.max(0, Math.floor(previous)) + 1;
    try {
      localStorage.setItem(EXPOSURE_SEQUENCE_STORAGE_KEY, String(next));
    } catch (_error) {}
    return next;
  }
  const MAP_LAYER_STORAGE_KEY = "omt-map-layers-v1";
  const MAP_COLOR_STORAGE_KEY = "omt-map-colors-v1";
  const DEFAULT_MAP_COLORS = {
    neighborDots: "#ff334f",
    neighborClick: "#ff00a8",
    guessDots: "#244cff",
  };
  const LEGACY_GUESS_DOT_COLOR = "#9b6cff";
  const liveChallengeAdapter = globalThis.OMTLiveChallenge;
  if (!liveChallengeAdapter) throw new Error("Live Challenge adapter did not load");
  const cradioAdapter = globalThis.OMTModalCradio;
  if (!cradioAdapter) throw new Error("Modal C-RADIO client did not load");
  const cradioClient = new cradioAdapter.ModalCradioClient();

  function configureCloudRadio() {
    const status = cradioClient.tokenStatus();
    const action = window.prompt(
      `C-RADIO cloud is ${status.configured ? "configured" : "not configured"}. `
        + "Enter SET to add/replace the private proxy token, CLEAR to remove it, or STATUS.",
      "SET",
    );
    if (!action) return;
    const command = String(action).trim().toLowerCase();
    if (command === "status") {
      window.alert(`C-RADIO cloud: ${cradioClient.tokenStatus().configured ? "configured" : "not configured"}.`);
      return;
    }
    if (command === "clear") {
      cradioClient.clearToken();
      window.alert("C-RADIO cloud token cleared.");
      return;
    }
    if (command !== "set" && command !== "replace") {
      window.alert("Choose SET, CLEAR, or STATUS.");
      return;
    }
    const token = window.prompt("Paste the joined wk-….ws-… proxy token. It is stored only in Tampermonkey storage.");
    if (!token) return;
    try {
      cradioClient.setToken(token);
      window.alert("C-RADIO cloud token saved.");
    } catch (_error) {
      window.alert("That token format was not accepted. No token was saved.");
    }
  }

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("Configure C-RADIO cloud", configureCloudRadio);
  }
  const { LIVE_CHALLENGE_PATH, PARTY_LOBBY_PATH } = liveChallengeAdapter;
  const prewarmedRoundKeys = new Set();
  const modalRoundPromises = new Map();
  const pageWindow = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  const mapLayerPreferences = readMapLayerPreferences();
  const mapColorPreferences = readMapColorPreferences();
  const state = {
    review: null,
    fastNeighborhood: null,
    guessNeighborhood: null,
    active: 0,
    detail: new Map(),
    drawerOpen: false,
    feedback: readFeedback(),
    round: null,
    playerGuess: null,
    requestToken: 0,
    root: null,
    shadow: null,
    imageUrls: new Map(),
    imagePromises: new Map(),
    maps: new Set(),
    overlays: [],
    originalMapView: null,
    pinIcons: null,
    // Clustering-family review is preserved at the family-meta-trainer-v1 Git
    // tag. The active trainer is deliberately similarity-only.
    showBestMeta: false,
    showVisualNeighbors: mapLayerPreferences.showVisualNeighbors,
    showGuessNeighbors: mapLayerPreferences.showGuessNeighbors,
    neighborDotColor: mapColorPreferences.neighborDots,
    neighborClickColor: mapColorPreferences.neighborClick,
    guessDotColor: mapColorPreferences.guessDots,
    matchTooltip: null,
    matchTooltipPoint: null,
    matchTooltipNative: [],
    matchTooltipTimer: 0,
    matchTooltipToken: 0,
    hoveredMatchKey: null,
    matchTooltipShift: false,
    shiftHeld: false,
    visualBoardShiftUpdate: null,
    matchTooltipClientX: 0,
    matchTooltipClientY: 0,
    visualBoard: null,
    visualBoardKey: null,
    visualBoardPromise: null,
    visualBoardWarmPromise: null,
    visualBoardMode: "consensus",
    visualBoardOpen: false,
    visualBoardModifierCleanup: null,
    offlineRetryTimer: 0,
    pendingTimer: 0,
    liveChallengeResultVisible: false,
    liveChallengeLastRoundKey: "",
    liveChallengePendingKey: "",
    liveChallengeProfileId: null,
    liveChallengeProfilePromise: null,
    loggedRoundEvents: new Set(),
    roundIdentity: null,
    visualExposure: null,
    finalizedExposureKeys: new Set(),
    universalPrewarmPromise: null,
  };

  function readFeedback() {
    try {
      return JSON.parse(localStorage.getItem("omt-feedback-v1") || "{}");
    } catch (_error) {
      return {};
    }
  }

  function readMapLayerPreferences() {
    try {
      const stored = JSON.parse(localStorage.getItem(MAP_LAYER_STORAGE_KEY) || "null");
      if (stored && typeof stored.showVisualNeighbors === "boolean") {
        return {
          showBestMeta: false,
          // In the old three-mode control, `false` meant family-only rather
          // than an intentionally clear map. Migrate that state to Similar.
          showVisualNeighbors: stored.similarityOnly === true
            ? stored.showVisualNeighbors
            : true,
          showGuessNeighbors: stored.showGuessNeighbors === true,
        };
      }
    } catch (_error) {}
    return { showBestMeta: false, showVisualNeighbors: true, showGuessNeighbors: false };
  }

  function saveMapLayerPreferences() {
    localStorage.setItem(MAP_LAYER_STORAGE_KEY, JSON.stringify({
      showBestMeta: false,
      showVisualNeighbors: state.showVisualNeighbors,
      showGuessNeighbors: state.showGuessNeighbors,
      similarityOnly: true,
    }));
  }

  function normalizeColor(value, fallback) {
    return /^#[0-9a-f]{6}$/i.test(String(value || ""))
      ? String(value).toLowerCase()
      : fallback;
  }

  function readMapColorPreferences() {
    try {
      const stored = JSON.parse(localStorage.getItem(MAP_COLOR_STORAGE_KEY) || "null");
      const storedGuessDots = normalizeColor(stored?.guessDots, DEFAULT_MAP_COLORS.guessDots);
      return {
        neighborDots: normalizeColor(stored?.neighborDots, DEFAULT_MAP_COLORS.neighborDots),
        neighborClick: normalizeColor(stored?.neighborClick, DEFAULT_MAP_COLORS.neighborClick),
        // Migrate only the former shipped default. Any genuinely customized
        // color remains untouched.
        guessDots: storedGuessDots === LEGACY_GUESS_DOT_COLOR
          ? DEFAULT_MAP_COLORS.guessDots
          : storedGuessDots,
      };
    } catch (_error) {
      return { ...DEFAULT_MAP_COLORS };
    }
  }

  function saveMapColorPreferences() {
    localStorage.setItem(MAP_COLOR_STORAGE_KEY, JSON.stringify({
      neighborDots: state.neighborDotColor,
      neighborClick: state.neighborClickColor,
      guessDots: state.guessDotColor,
    }));
  }

  function colorRgb(hex) {
    const value = normalizeColor(hex, "#000000").slice(1);
    return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  }

  function colorRgba(hex, alpha) {
    const [red, green, blue] = colorRgb(hex);
    return `rgba(${red},${green},${blue},${alpha})`;
  }

  function syncMapColorVariables() {
    if (!state.root) return;
    state.root.style.setProperty("--omt-neighbor-dot", state.neighborDotColor);
    state.root.style.setProperty("--omt-neighbor-click", state.neighborClickColor);
    state.root.style.setProperty("--omt-guess-dot", state.guessDotColor);
  }

  function esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function mapRankLabel(meta) {
    if (!Number.isFinite(meta.globalMatchRank)) return `${meta.matchStrength || 0}/100 match`;
    return `#${meta.globalMatchRank.toLocaleString()} visual match map-wide`;
  }

  function mapLegend(neighborhood) {
    const guess = state.showVisualNeighbors && state.showGuessNeighbors
      ? state.guessNeighborhood
      : null;
    const overlap = guess?.overlap;
    return `<div class="omt-legend">${state.showVisualNeighbors && neighborhood?.visualMatches?.length ? `<i class="omt-legend-match omt-legend-round-match"></i> closest matches <i class="omt-legend-match omt-legend-tail-match"></i> wider distribution <i class="omt-legend-pin omt-legend-pin-neighbors"></i> suggested click` : ""}${guess ? `<i class="omt-legend-match omt-legend-guess-match"></i> guess matches <i class="omt-legend-match omt-legend-shared-match"></i> shared${overlap ? ` (${overlap.sharedLocations})` : ""}` : ""}<i class="omt-legend-current"></i> round</div>`;
  }

  function request(path, options = {}) {
    return portableApi.request(path, options);
  }

  function warmMapForRound(eventState) {
    const datasetKey = [
      eventState?.map?.id,
      eventState?.mapId,
      eventState?.mapKey,
      eventState?.datasetKey,
    ].find((value) => typeof value === "string" && value.length);
    if (!datasetKey) return;
    // The 50k-location core is the largest cold-start cost. Begin downloading
    // and parsing it when play starts instead of after the guess is submitted.
    portableApi.prewarmMap(datasetKey).catch(() => {
      // On an unseen map, prepare the location-free browser models and static
      // World pilot corpus. Geographic search still waits for round end.
      if (!state.universalPrewarmPromise) {
        const begin = () => portableApi.prewarmUniversal().catch((error) => {
          console.warn("Meta Trainer: universal corpus prewarm failed", error);
        }).finally(() => { state.universalPrewarmPromise = null; });
        state.universalPrewarmPromise = new Promise((resolve) => {
          const run = () => Promise.resolve(begin()).finally(resolve);
          if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 5000 });
          else window.setTimeout(run, 1500);
        });
      }
    });
  }

  function decodedPanoId(value) {
    const text = String(value || "");
    if (!text || text.length % 2 || !/^[0-9a-f]+$/i.test(text)) return text;
    let decoded = "";
    for (let index = 0; index < text.length; index += 2) {
      decoded += String.fromCharCode(parseInt(text.slice(index, index + 2), 16));
    }
    return /^[\x20-\x7e]+$/.test(decoded) ? decoded : text;
  }

  function prefetchModalRound(panoId, context = {}) {
    if (!panoId || !cradioClient.configured()) return Promise.resolve({ ok: false, reason: "not-configured" });
    const id = String(panoId);
    if (modalRoundPromises.has(id)) return modalRoundPromises.get(id);
    const pending = cradioClient.prefetch(id, context).catch(() => ({ ok: false, reason: "network-error" }));
    modalRoundPromises.set(id, pending);
    if (modalRoundPromises.size > 128) {
      modalRoundPromises.delete(modalRoundPromises.keys().next().value);
    }
    return pending;
  }

  async function prefetchModalForMap(panoId, context = {}) {
    if (!panoId || !cradioClient.configured()) {
      return { ok: false, reason: "not-configured" };
    }
    const sourceMapKey = context.sourceMapKey;
    if (sourceMapKey) {
      const knownMap = await portableApi.isKnownMap(sourceMapKey).catch(() => false);
      if (knownMap) return { ok: false, reason: "known-map" };
    }
    return prefetchModalRound(panoId, context);
  }

  function prewarmRawRound(data) {
    const roundNumber = Number(data?.round);
    const guesses = data?.player?.guesses;
    // A raw game response contains the current location during play. Use it
    // only to prepare private caches; no trainer UI is exposed before round_end.
    if (!Number.isInteger(roundNumber) || !Array.isArray(guesses)
        || guesses.length >= roundNumber) return;
    const location = data?.rounds?.[roundNumber - 1];
    const datasetKey = typeof data?.map === "string" ? data.map : data?.map?.id;
    const panoId = decodedPanoId(location?.panoId);
    const latitude = Number(location?.lat);
    const longitude = Number(location?.lng);
    if (panoId) {
      prefetchModalForMap(panoId, {
        latitude,
        longitude,
        sourceMapKey: datasetKey,
        datasetKey: "balanced-world-50k",
      });
    }
    if (!datasetKey || (!panoId && (!Number.isFinite(latitude) || !Number.isFinite(longitude)))) return;
    const key = `${data.token || "game"}:${roundNumber}:${panoId || `${latitude},${longitude}`}`;
    if (prewarmedRoundKeys.has(key)) return;
    prewarmedRoundKeys.add(key);
    if (prewarmedRoundKeys.size > 30) prewarmedRoundKeys.delete(prewarmedRoundKeys.values().next().value);
    const params = new URLSearchParams({ map_key: datasetKey });
    if (panoId) params.set("pano_id", panoId);
    if (Number.isFinite(latitude)) params.set("lat", latitude);
    if (Number.isFinite(longitude)) params.set("lng", longitude);
    portableApi.prewarmMap(datasetKey).then(() => request(`/api/neighborhood?${params}`)).then(async (review) => {
      if (!review?.matched) return;
      const dataset = encodeURIComponent(review.datasetKey);
      const mapIndex = review.location.mapIndex;
      const [, board] = await Promise.all([
        request(`/api/neighborhood/${mapIndex}?dataset=${dataset}`),
        request(`/api/visual-board/${mapIndex}?dataset=${dataset}`),
      ]);
      // The V-board thumbnails are also predictable before the result page.
      // Decode them opportunistically so opening V remains immediate.
      await warmVisualBoard(board);
    }).catch(() => {
      // Unknown maps have no precomputed row to fetch. Compute the exact
      // universal query privately during play; UniversalSimilarity retains the
      // promise/result, so post-round review reuses it instead of starting the
      // browser models after the guess. No trainer UI is shown here.
      if (panoId && !cradioClient.configured()) {
        portableApi.precomputeUniversalRound(panoId).catch((error) => {
          console.warn("Meta Trainer: during-round universal analysis failed", error);
        });
      } else {
        warmMapForRound({ mapId: datasetKey });
      }
    });
  }

  async function criticalRequest(path, options = {}) {
    const attempts = options.attempts || 3;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await request(path, options);
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) {
          await new Promise((resolve) => window.setTimeout(
            resolve,
            100 * 2 ** attempt,
          ));
        }
      }
    }
    throw lastError;
  }

  async function imageUrl(path) {
    if (/^https:\/\/streetviewpixels-pa\.googleapis\.com\//.test(path)) return path;
    const viewMatch = String(path).match(/^\/api\/view\/(\d+)\/(\d+)(?:\?(.*))?$/);
    if (viewMatch) {
      const query = new URLSearchParams(viewMatch[3] || "");
      const datasetKey = query.get("dataset") || state.review?.datasetKey;
      return portableApi.viewUrl(datasetKey, Number(viewMatch[1]), Number(viewMatch[2]));
    }
    if (state.imageUrls.has(path)) return state.imageUrls.get(path);
    if (state.imagePromises.has(path)) return state.imagePromises.get(path);
    let pending;
    pending = (async () => {
      const parsed = new URL(path);
      if (parsed.protocol !== "portable-meta-examples:") {
        throw new Error(`Unsupported portable image ${path}`);
      }
      const datasetKey = parsed.hostname;
      const detectorIndex = Number(parsed.pathname.slice(1));
      const currentMapIndexValue = parsed.searchParams.get("map_index");
      const currentMapIndex = currentMapIndexValue === null
        ? null
        : Number(currentMapIndexValue);
      const map = await portableApi.loadMap(datasetKey);
      const examples = await portableApi.exampleViews(
        map,
        detectorIndex,
        Number.isInteger(currentMapIndex) ? currentMapIndex : null,
      );
      const canvas = document.createElement("canvas");
      canvas.width = 1440;
      canvas.height = 830;
      const context = canvas.getContext("2d");
      context.fillStyle = "#101612";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#f4f1e8";
      context.font = "600 18px system-ui, sans-serif";
      context.fillText("This round + eight representative views", 14, 30);
      const images = await Promise.all(examples.map((example) => new Promise((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = example.view;
      })));
      images.forEach((image, position) => {
        const x = (position % 3) * 480;
        const y = 50 + Math.floor(position / 3) * 260;
        context.drawImage(image, x, y, 480, 260);
        context.fillStyle = "rgba(4,12,8,.86)";
        context.fillRect(x, y, 230, 28);
        context.fillStyle = "#fff";
        context.font = "500 14px system-ui, sans-serif";
        const example = examples[position];
        context.fillText(
          example.current ? `This round · ${example.heading}°` : `Location ${example.mapIndex + 1} · ${example.heading}°`,
          x + 8,
          y + 19,
        );
      });
      const blob = await new Promise((resolve, reject) => canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error("Could not render examples")),
        "image/jpeg",
        0.88,
      ));
      const url = URL.createObjectURL(blob);
      if (state.imagePromises.get(path) !== pending) {
        URL.revokeObjectURL(url);
        throw new Error("Image preload was superseded");
      }
      state.imageUrls.set(path, url);
      return url;
    })().finally(() => {
      if (state.imagePromises.get(path) === pending) state.imagePromises.delete(path);
    });
    state.imagePromises.set(path, pending);
    return pending;
  }

  function datasetSuffix(review = state.review) {
    const key = review?.datasetKey;
    return key ? `?dataset=${encodeURIComponent(key)}` : "";
  }

  function representativeViewsPath(meta, review = state.review) {
    const query = new URLSearchParams();
    if (review?.datasetKey) query.set("dataset", review.datasetKey);
    if (Number.isInteger(review?.location?.mapIndex)) {
      query.set("map_index", String(review.location.mapIndex));
    }
    const value = query.toString();
    return `${meta.assets.examples}${value ? `?${value}` : ""}`;
  }

  function viewSuffix(point) {
    const query = new URLSearchParams();
    if (point.datasetKey) query.set("dataset", point.datasetKey);
    if (point.panoId) query.set("pano_id", point.panoId);
    const value = query.toString();
    return value ? `?${value}` : "";
  }

  function releaseImages() {
    for (const url of state.imageUrls.values()) URL.revokeObjectURL(url);
    state.imageUrls.clear();
    state.imagePromises.clear();
  }

  function ensureRoot() {
    if (state.root?.isConnected) return;
    const host = document.createElement("div");
    host.id = "orlando-meta-trainer-root";
    document.documentElement.appendChild(host);
    state.root = host;
    state.shadow = host.attachShadow({ mode: "open" });
    syncMapColorVariables();
  }

  const legacyStyles = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    button, select { font: inherit; }
    .omt { --ink:#f7f5ee; --muted:#aab7ad; --panel:#102019; --panel2:#172b21; --line:#ffffff24; --lime:#bfe86d; --gold:#f2c45d; font-family:Inter,Arial,sans-serif; color:var(--ink); }
    .omt-launch { position:fixed; z-index:2147483000; top:18px; right:18px; min-height:48px; border:1px solid #ffffff35; border-radius:999px; padding:10px 17px; color:#fff; background:#102019eb; box-shadow:0 8px 30px #0007; cursor:pointer; font-weight:800; backdrop-filter:blur(12px); }
    .omt-launch b { color:var(--lime); }
    .omt-launch.offline { color:#ffd5c7; border-color:#cf6b4f; }
    .omt-launch.empty { color:#d5dbd6; }
    .omt-compare-launch { position:fixed; z-index:2147483000; top:76px; right:18px; min-height:38px; border:1px solid #bfe86d78; border-radius:999px; padding:8px 13px; color:#eaffc7; background:#102019eb; box-shadow:0 7px 22px #0006; cursor:pointer; font-weight:800; backdrop-filter:blur(12px); }
    .omt-compare-launch kbd,.omt-compare-button kbd { margin-left:7px; padding:2px 5px; border:1px solid #ffffff36; border-radius:4px; color:#fff; background:#ffffff10; font:700 10px Arial,sans-serif; }
    .omt-compare-button { width:100%; margin-top:9px; border:1px solid #bfe86d70; border-radius:7px; padding:11px 13px; color:#eaffc7; background:#172b21; cursor:pointer; font-weight:800; }
    .omt-compare-button:hover,.omt-compare-launch:hover { border-color:#bfe86d; background:#203a2b; }
    .omt-drawer { position:fixed; z-index:2147483001; top:0; right:0; bottom:84px; width:min(620px,48vw); min-width:480px; display:flex; flex-direction:column; background:var(--panel); box-shadow:-18px 0 55px #0009; border-left:1px solid var(--line); }
    .omt-head { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:18px 20px; border-bottom:1px solid var(--line); }
    .omt-head small { display:block; color:var(--lime); font-size:11px; font-weight:900; letter-spacing:.13em; text-transform:uppercase; }
    .omt-head strong { display:block; margin-top:3px; font-size:19px; }
    .omt-filter-summary { margin-top:4px; color:var(--muted); font-size:10px; line-height:1.35; }
    .omt-icon { border:1px solid var(--line); border-radius:9px; padding:8px 11px; color:#fff; background:#ffffff0c; cursor:pointer; }
    .omt-scroll { overflow:auto; padding:0 0 30px; }
    .omt-nav { position:sticky; top:0; z-index:2; display:grid; grid-template-columns:42px 1fr 42px; align-items:center; gap:8px; padding:10px 16px; background:#102019f2; border-bottom:1px solid var(--line); backdrop-filter:blur(10px); }
    .omt-nav button { height:36px; border:1px solid var(--line); border-radius:8px; color:#fff; background:#ffffff0d; cursor:pointer; }
    .omt-nav button:disabled { opacity:.3; cursor:default; }
    .omt-nav select { min-width:0; width:100%; height:36px; padding:0 9px; border:1px solid var(--line); border-radius:8px; color:#fff; background:var(--panel2); }
    .omt-more { display:block; width:calc(100% - 32px); margin:10px 16px 0; min-height:38px; border:1px solid #bfe86d66; border-radius:9px; color:var(--lime); background:#bfe86d0c; cursor:pointer; }
    .omt-section { padding:20px; border-bottom:1px solid var(--line); }
    .omt-kicker { color:var(--gold); font-size:11px; font-weight:900; letter-spacing:.11em; text-transform:uppercase; }
    .omt-strength { display:inline-block; margin:0 0 9px; padding:5px 8px; border:1px solid #bfe86d66; border-radius:999px; color:var(--lime); background:#bfe86d10; font-size:11px; font-weight:800; }
    .omt-title { margin:7px 0 8px; font-family:Georgia,serif; font-size:31px; font-weight:400; line-height:1.02; }
    .omt-description { margin:0; color:var(--muted); line-height:1.45; }
    .omt-metrics { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:16px; }
    .omt-neighborhood { display:grid; grid-template-columns:repeat(4,1fr); gap:7px; }
    .omt-metric { padding:11px; border:1px solid var(--line); background:#ffffff08; }
    .omt-metric b,.omt-metric span { display:block; }
    .omt-metric b { color:var(--lime); font-size:18px; }
    .omt-metric span { margin-top:3px; color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:.06em; }
    .omt-label { display:flex; justify-content:space-between; gap:12px; align-items:baseline; margin-bottom:10px; }
    .omt-label h3 { margin:0; font-size:14px; }
    .omt-label span { color:var(--muted); font-size:11px; }
    .omt-views { display:grid; grid-template-columns:1fr 1fr; gap:7px; }
    .omt-view { position:relative; min-height:142px; padding:0; overflow:hidden; border:1px solid var(--line); background:#08120d; cursor:zoom-in; }
    .omt-view img { display:block; width:100%; height:142px; object-fit:cover; }
    .omt-view span { position:absolute; right:6px; bottom:5px; padding:3px 6px; border-radius:5px; background:#07100bd8; color:#fff; font-size:10px; }
    .omt-view-evidence { position:absolute; left:0; right:0; bottom:0; height:5px; background:#0009; }
    .omt-view-evidence i { display:block; height:100%; background:var(--lime); }
    .omt-view-contribution { position:absolute; left:6px; bottom:10px; padding:3px 6px; border-radius:5px; color:#102019; background:var(--lime); font-size:10px; font-weight:900; }
    .omt-evidence { width:100%; min-height:250px; padding:0; border:1px solid var(--line); background:#08120d; cursor:zoom-in; }
    .omt-evidence img { display:block; width:100%; max-height:440px; object-fit:contain; }
    .omt-map-row { display:grid; grid-template-columns:1fr auto; gap:14px; align-items:center; }
    .omt-map-row strong { display:block; color:var(--lime); font-size:19px; }
    .omt-map-row span { display:block; color:var(--muted); margin-top:3px; }
    .omt-click-lines { display:grid; gap:12px; }
    .omt-click-lines > div + div { padding-top:11px; border-top:1px solid var(--line); }
    .omt-fit { border:1px solid var(--lime); border-radius:8px; padding:10px 12px; color:var(--lime); background:transparent; cursor:pointer; font-weight:800; }
    .omt-map-actions { display:flex; gap:9px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
    .omt-layer-toggle { display:flex; align-items:center; gap:6px; min-height:38px; padding:7px 9px; border:1px solid var(--line); border-radius:8px; color:var(--muted); background:#ffffff08; cursor:pointer; font-size:11px; font-weight:800; white-space:nowrap; }
    .omt-layer-toggle:has(input:checked) { color:var(--ink); border-color:#bfe86d70; background:#bfe86d0d; }
    .omt-layer-toggle input { width:16px; height:16px; margin:0; accent-color:var(--lime); cursor:pointer; }
    .omt-layer-toggle kbd { padding:2px 4px; border:1px solid #ffffff2b; border-radius:4px; color:var(--muted); background:#0003; font:9px/1.1 ui-monospace,SFMono-Regular,monospace; }
    .omt-color-setting { display:flex; align-items:center; gap:6px; min-height:38px; padding:6px 8px; border:1px solid var(--line); border-radius:8px; color:var(--muted); background:#ffffff08; font-size:11px; font-weight:800; white-space:nowrap; }
    .omt-color-setting input { width:27px; height:24px; padding:1px; overflow:hidden; border:1px solid #ffffff36; border-radius:5px; background:transparent; cursor:pointer; }
    .omt-feedback { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; }
    .omt-feedback button { min-height:45px; padding:7px; border:1px solid var(--line); border-radius:8px; color:#fff; background:#ffffff0b; cursor:pointer; font-size:11px; font-weight:800; }
    .omt-feedback button.active { color:#102019; background:var(--lime); border-color:var(--lime); }
    .omt-note { color:var(--muted); font-size:11px; line-height:1.45; }
    .omt-lightbox { position:fixed; z-index:2147483002; inset:0; display:grid; place-items:center; padding:55px 26px 26px; background:#030805f5; }
    .omt-lightbox img { max-width:96vw; max-height:90vh; object-fit:contain; }
    .omt-lightbox button { position:absolute; top:14px; right:16px; border:1px solid #ffffff42; border-radius:8px; padding:9px 12px; color:#fff; background:#ffffff10; cursor:pointer; }
    .omt-visual-board { position:fixed; z-index:2147483006; inset:0; display:flex; flex-direction:column; color:#f5f3eb; background:#050906fa; font-family:Arial,sans-serif; }
    .omt-board-head { flex:none; display:flex; align-items:center; gap:14px; min-height:68px; padding:10px 16px; border-bottom:1px solid #ffffff24; background:#0d1711; }
    .omt-board-head h2 { margin:0; font:700 21px/1.1 Georgia,serif; }
    .omt-board-head p { margin:4px 0 0; color:#aebbb2; font-size:11px; }
    .omt-board-tabs { display:flex; gap:6px; margin-left:auto; }
    .omt-board-tabs button,.omt-board-close { border:1px solid #ffffff2d; border-radius:6px; padding:9px 12px; color:#dce5de; background:#16231b; cursor:pointer; font-weight:700; }
    .omt-board-tabs button.active { border-color:#baf265; color:#071008; background:#baf265; }
    .omt-board-close { margin-left:4px; color:#fff; background:#ffffff0d; }
    .omt-board-body { min-height:0; flex:1; padding:10px; }
    .omt-board-current,.omt-board-match { position:relative; min-width:0; min-height:0; overflow:hidden; border:1px solid #ffffff20; border-radius:5px; background:#020402; }
    .omt-board-current img,.omt-board-match img { width:100%; height:100%; display:block; object-fit:contain; }
    .omt-board-current strong,.omt-board-match span { position:absolute; left:0; top:0; padding:6px 9px; color:#fff; background:#07100be8; font-size:12px; }
    .omt-board-current strong { color:#c8ff70; font-size:14px; }
    .omt-board-grid { width:100%; height:100%; min-width:0; min-height:0; display:grid; grid-template-columns:repeat(3,1fr); grid-template-rows:repeat(3,1fr); gap:6px; }
    button.omt-board-match { padding:0; cursor:pointer; }
    .omt-board-match em { position:absolute; right:0; bottom:0; padding:4px 7px; color:#d8e1da; background:#07100bdc; font:normal 10px/1.2 Arial,sans-serif; }
    .omt-board-peek { position:fixed; z-index:4; inset:62px 2vw 40px; display:flex; flex-direction:column; min-width:0; min-height:0; overflow:hidden; border:1px solid #c8ff7075; border-radius:8px; background:#020402f8; box-shadow:0 18px 80px #000e; pointer-events:none; }
    .omt-board-peek img { display:block; width:100%; min-height:0; flex:1; object-fit:cover; }
    .omt-board-peek div { flex:none; display:flex; justify-content:space-between; gap:20px; padding:8px 11px; color:#fff; background:#0d1711; font-size:12px; }
    .omt-board-peek span { color:#aebbb2; }
    .omt-board-foot { flex:none; display:flex; align-items:center; gap:18px; min-height:42px; padding:7px 16px; border-top:1px solid #ffffff24; color:#bdc8bf; background:#0d1711; font-size:11px; }
    .omt-board-foot b { color:#e9f3eb; }
    .omt-board-warning { margin-left:auto; color:#e6c66f; }
    .omt-board-loading { position:fixed; z-index:2147483006; inset:0; display:grid; place-items:center; color:#dfffae; background:#050906f7; font:700 18px Arial,sans-serif; }
    .omt-spinner { min-height:160px; display:grid; place-items:center; color:var(--muted); }
    .omt-match-tooltip { position:fixed; z-index:2147483003; width:min(600px,calc(100vw - 16px)); overflow:hidden; border:1px solid var(--omt-neighbor-dot,#ff334f); border-radius:10px; color:#fff; background:#102019f5; box-shadow:0 12px 35px #0009; pointer-events:none; backdrop-filter:blur(10px); }
    .omt-match-tooltip-head { display:flex; justify-content:space-between; gap:12px; padding:9px 10px; font-size:11px; }
    .omt-match-tooltip-head b { color:var(--omt-neighbor-dot,#ff536b); font-size:13px; }
    .omt-match-tooltip-head span { color:var(--muted); text-align:right; }
    .omt-match-tooltip-images { display:grid; grid-template-columns:1fr 1fr; height:336px; background:#08120d; }
    .omt-match-tooltip-images img { display:block; width:100%; height:168px; object-fit:cover; }
    .omt-match-tooltip-loading { height:100%; display:grid; place-items:center; grid-column:1 / -1; color:var(--muted); font-size:11px; }
    .omt-match-tooltip-foot { padding:7px 10px; border-top:1px solid var(--line); color:var(--lime); font-size:10px; font-weight:800; text-align:center; }
    .omt-legend { position:fixed; z-index:2147482999; left:15px; bottom:98px; padding:8px 11px; border:1px solid #ffffff30; border-radius:8px; color:#fff; background:#102019e8; box-shadow:0 7px 25px #0005; font-size:11px; }
    .omt-legend-dot { display:inline-block; width:10px; height:10px; margin:0 5px 0 1px; border:2px solid #fff; border-radius:50%; background:#287f88; box-shadow:0 0 0 1px #183f43; }
    .omt-legend-current { display:inline-block; width:11px; height:11px; margin:0 5px 0 9px; border:3px solid #bfe86d; border-radius:50%; background:#102019; }
    .omt-legend-pin { position:relative; display:inline-block; width:12px; height:15px; margin:0 4px -3px 8px; border:2px solid #15191c; border-radius:9px 9px 9px 1px; background:#fff; transform:rotate(-45deg); }
    .omt-legend-pin::after { content:""; position:absolute; width:3px; height:3px; left:2.5px; top:2.5px; border-radius:50%; background:#15191c; }
    .omt-legend-pin-neighbors { width:14px; height:14px; margin:0 5px -2px 10px; border:2px solid #fff; border-radius:2px; background:var(--omt-neighbor-click,#ff00a8); box-shadow:0 0 0 2px #15191c; transform:rotate(45deg); }
    .omt-legend-pin-neighbors::after { display:none; }
    .omt-recommendation-receipt { position:fixed; z-index:2147483001; left:50%; bottom:106px; display:flex; gap:8px; max-width:calc(100vw - 32px); transform:translateX(-50%); color:#fff; font:600 12px/1.1 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; pointer-events:none; }
    .omt-recommendation-receipt div { display:flex; align-items:baseline; gap:8px; padding:7px 11px; border:1px solid #ffffff24; border-radius:7px; color:#fff; background:#17142cf2; box-shadow:0 5px 16px #0008; white-space:nowrap; }
    .omt-recommendation-receipt div::before { content:""; width:6px; height:6px; border-radius:50%; background:#9290a8; }
    .omt-recommendation-receipt div.omt-neighbor-result::before { background:var(--omt-neighbor-click,#ff00a8); }
    .omt-recommendation-receipt span { color:#bbb8ca; font-size:11px; }
    .omt-recommendation-receipt strong { color:#fff; font-size:16px; font-variant-numeric:tabular-nums; }
    .omt-recommendation-receipt em { color:#d1cedc; font-size:12px; font-style:normal; font-variant-numeric:tabular-nums; }
    @media(max-width:850px){.omt-drawer{width:100vw;min-width:0;bottom:74px}.omt-launch{top:10px;right:10px}.omt-views{grid-template-columns:1fr}.omt-view,.omt-view img{height:190px}.omt-feedback,.omt-neighborhood{grid-template-columns:1fr 1fr}}
  `;

  // The trainer is an analysis instrument inside GeoGuessr, not a standalone
  // branded product. This stylesheet deliberately keeps the frame neutral and
  // reserves strong color for map evidence selected by the player.
  const styles = `
    :host { all:initial; }
    * { box-sizing:border-box; }
    button,select,input { font:inherit; }
    button { -webkit-tap-highlight-color:transparent; }
    .omt {
      --bg:#17181b; --bg-raised:#202126; --bg-soft:#292a30;
      --text:#f1f2f4; --muted:#a4a6ad; --faint:#777981;
      --line:#ffffff1f; --line-strong:#ffffff38; --active:#f1f2f4;
      --lime:#f1f2f4; --ink:#f1f2f4; --panel:#17181b; --panel2:#202126;
      color:var(--text); font:13px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;
    }
    .omt kbd { display:inline-grid; place-items:center; min-width:19px; height:19px; margin-left:6px; padding:0 5px; border:1px solid #ffffff2b; border-radius:4px; color:#c7c9ce; background:#0003; font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .omt-dock { position:fixed; z-index:2147483000; top:12px; right:12px; display:flex; align-items:stretch; overflow:hidden; border:1px solid var(--line-strong); border-radius:9px; background:#17181bf2; box-shadow:0 8px 28px #0008; backdrop-filter:blur(12px); }
    .omt-dock button { min-height:40px; padding:8px 12px; border:0; border-left:1px solid var(--line); color:#d9dbe0; background:transparent; cursor:pointer; font-weight:650; }
    .omt-dock button:first-child { border-left:0; }
    .omt-dock button:hover { background:#ffffff12; }
    .omt-dock button.active { color:#fff; background:#ffffff17; }
    .omt-dock button:disabled { color:#777981; cursor:default; background:transparent; }
    .omt-dock .omt-dock-primary { color:#101114; background:#f1f2f4; }
    .omt-dock .omt-dock-primary:hover { background:#fff; }
    .omt-dock .omt-dock-primary kbd { color:#44464d; border-color:#0003; background:#0000000b; }
    .omt-dock-count { display:inline-grid; place-items:center; min-width:19px; height:19px; margin-left:7px; padding:0 5px; border-radius:999px; color:#111216; background:#e7e8eb; font-size:10px; }
    .omt-dock-status { min-height:40px; display:flex; align-items:center; padding:8px 12px; color:#b7b9bf; }
    .omt-dock-status::before { content:""; width:7px; height:7px; margin-right:8px; border-radius:50%; background:#c97a64; }
    .omt-dock-status.pending::before { background:#71a7ff; animation:omt-pulse 1.1s ease-in-out infinite alternate; }
    @keyframes omt-pulse { to { opacity:.32; } }
    .omt-dock-settings { position:relative; display:flex; align-items:stretch; border-left:1px solid var(--line); }
    .omt-dock-settings summary { display:flex; align-items:center; min-height:40px; padding:8px 12px; color:#d9dbe0; cursor:pointer; font-weight:650; list-style:none; }
    .omt-dock-settings summary::-webkit-details-marker { display:none; }
    .omt-dock-settings[open] summary { background:#ffffff12; }
    .omt-dock-settings-panel { position:fixed; z-index:2147483002; top:58px; right:12px; display:grid; grid-template-columns:repeat(3,auto); gap:8px; padding:10px; border:1px solid var(--line-strong); border-radius:8px; background:#17181bf5; box-shadow:0 8px 28px #0008; }
    .omt-drawer { position:fixed; z-index:2147483001; top:10px; right:10px; bottom:94px; width:min(600px,47vw); min-width:500px; display:flex; flex-direction:column; overflow:hidden; border:1px solid var(--line-strong); border-radius:10px; background:#17181bf7; box-shadow:0 18px 60px #000b; backdrop-filter:blur(16px); }
    .omt-head { flex:none; display:flex; align-items:center; justify-content:space-between; min-height:54px; gap:12px; padding:10px 12px 10px 16px; border-bottom:1px solid var(--line); }
    .omt-head small { display:block; color:var(--muted); font-size:10px; letter-spacing:.04em; }
    .omt-head strong { display:block; margin-top:1px; color:var(--text); font-size:15px; font-weight:700; }
    .omt-icon { width:34px; height:34px; border:1px solid var(--line); border-radius:6px; color:#dfe0e3; background:#ffffff09; cursor:pointer; font-size:18px; }
    .omt-icon:hover { background:#ffffff13; }
    .omt-toolbar { flex:none; display:grid; grid-template-columns:1fr auto auto; gap:6px; padding:8px; border-bottom:1px solid var(--line); background:#1d1e22; }
    .omt-toolbar button,.omt-compare-button,.omt-fit { min-height:36px; border:1px solid var(--line); border-radius:6px; padding:7px 10px; color:#e3e4e7; background:#ffffff08; cursor:pointer; font-weight:650; }
    .omt-toolbar button:hover,.omt-compare-button:hover,.omt-fit:hover { border-color:var(--line-strong); background:#ffffff10; }
    .omt-toolbar .omt-compare-button { margin:0; color:#111216; border-color:#f1f2f4; background:#f1f2f4; }
    .omt-toolbar .omt-compare-button kbd { color:#37383d; border-color:#0003; background:#0000000a; }
    .omt-scroll { min-height:0; overflow:auto; padding:0 0 18px; scrollbar-color:#55575f transparent; }
    .omt-section { padding:16px; border-bottom:1px solid var(--line); }
    .omt-section:last-child { border-bottom:0; }
    .omt-section-head,.omt-label { display:flex; align-items:baseline; justify-content:space-between; gap:12px; margin-bottom:10px; }
    .omt-section-head h3,.omt-label h3 { margin:0; color:#f0f1f3; font-size:12px; font-weight:700; letter-spacing:.01em; }
    .omt-section-head span,.omt-label span { color:var(--faint); font-size:10px; text-align:right; }
    .omt-result-row { display:grid; grid-template-columns:1fr 1fr; overflow:hidden; margin-bottom:10px; border:1px solid var(--line); border-radius:7px; background:#ffffff05; }
    .omt-result-row div { padding:11px 12px; }
    .omt-result-row div + div { border-left:1px solid var(--line); }
    .omt-result-row b,.omt-result-row span { display:block; }
    .omt-result-row b { color:#fff; font-size:21px; font-variant-numeric:tabular-nums; }
    .omt-result-row span { margin-top:2px; color:var(--muted); font-size:10px; }
    .omt-neighborhood { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; }
    .omt-metric { min-width:0; padding:9px; border:1px solid var(--line); border-radius:5px; background:#ffffff04; }
    .omt-metric b,.omt-metric span { display:block; }
    .omt-metric b { color:#f0f1f3; font-size:16px; font-variant-numeric:tabular-nums; }
    .omt-metric span { margin-top:2px; overflow-wrap:anywhere; color:var(--muted); font-size:9px; line-height:1.25; text-transform:none; letter-spacing:0; }
    .omt-note { margin:9px 0 0; color:var(--muted); font-size:10px; line-height:1.45; }
    .omt-map-actions { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
    .omt-layer-toggle,.omt-color-setting { min-height:34px; display:flex; align-items:center; gap:6px; padding:6px 8px; border:1px solid var(--line); border-radius:6px; color:var(--muted); background:#ffffff05; cursor:pointer; font-size:10px; font-weight:650; white-space:nowrap; }
    .omt-layer-toggle:has(input:checked) { color:#f0f1f3; border-color:#ffffff45; background:#ffffff0d; }
    .omt-layer-toggle input { width:14px; height:14px; margin:0; accent-color:#d7d8dc; }
    .omt-color-setting input { width:24px; height:22px; padding:1px; border:0; border-radius:4px; background:transparent; cursor:pointer; }
    .omt-click-lines { display:grid; gap:7px; margin-top:10px; }
    .omt-click-lines > div { display:grid; grid-template-columns:auto 1fr; column-gap:10px; padding:9px 10px; border:1px solid var(--line); border-radius:6px; background:#ffffff04; }
    .omt-click-lines strong { grid-row:1 / 3; align-self:center; color:#f2f3f4; font-size:12px; }
    .omt-click-lines span { display:block; color:var(--muted); font-size:10px; }
    .omt-family-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:12px; }
    .omt-family-head h2 { margin:0; color:#f1f2f4; font-size:20px; line-height:1.15; font-weight:700; }
    .omt-family-head p { margin:4px 0 0; color:var(--muted); font-size:10px; }
    .omt-strength { display:inline-block; flex:none; padding:4px 7px; border:1px solid var(--line); border-radius:5px; color:#cfd1d6; background:#ffffff05; font-size:10px; font-weight:650; }
    .omt-nav { display:grid; grid-template-columns:34px 1fr 34px; gap:5px; margin-bottom:10px; }
    .omt-nav button,.omt-nav select { height:34px; border:1px solid var(--line); border-radius:5px; color:#e8e9eb; background:#24252a; }
    .omt-nav button { cursor:pointer; }
    .omt-nav button:disabled { opacity:.28; }
    .omt-nav select { min-width:0; width:100%; padding:0 8px; }
    .omt-more { width:100%; min-height:34px; margin:0 0 10px; border:1px solid var(--line); border-radius:5px; color:#c6c8cd; background:#ffffff05; cursor:pointer; font-size:11px; }
    .omt-metrics { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; margin-top:10px; }
    .omt-kicker { color:var(--faint); font-size:10px; }
    .omt-title { margin:0; font:700 20px/1.15 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; }
    .omt-description { margin:5px 0 0; color:var(--muted); font-size:11px; line-height:1.4; }
    .omt-views { display:grid; grid-template-columns:1fr 1fr; gap:5px; }
    .omt-view { position:relative; min-height:150px; padding:0; overflow:hidden; border:1px solid var(--line); border-radius:4px; background:#0c0d0f; cursor:zoom-in; }
    .omt-view img { display:block; width:100%; height:150px; object-fit:cover; }
    .omt-view span { position:absolute; right:5px; bottom:5px; padding:2px 5px; border-radius:3px; color:#fff; background:#0b0c0edb; font-size:9px; }
    .omt-view-contribution { position:absolute; left:5px; bottom:7px; padding:2px 5px; border-radius:3px; color:#111216; background:#f0f1f3; font-size:9px; }
    .omt-view-evidence { position:absolute; left:0; right:0; bottom:0; height:3px; background:#0009; }
    .omt-view-evidence i { display:block; height:100%; background:#f0f1f3; }
    .omt-evidence { width:100%; min-height:180px; padding:0; overflow:hidden; border:1px solid var(--line); border-radius:5px; background:#0c0d0f; cursor:zoom-in; }
    .omt-evidence img { display:block; width:100%; max-height:410px; object-fit:contain; }
    .omt-feedback { display:grid; grid-template-columns:repeat(4,1fr); gap:5px; }
    .omt-feedback button { min-height:34px; padding:6px; border:1px solid var(--line); border-radius:5px; color:#cfd1d5; background:#ffffff05; cursor:pointer; font-size:10px; }
    .omt-feedback button.active { color:#111216; border-color:#eceef0; background:#eceef0; }
    .omt-system-details { margin-top:10px; color:var(--faint); font-size:9px; }
    .omt-system-details summary { cursor:pointer; }
    .omt-lightbox { position:fixed; z-index:2147483005; inset:0; display:grid; place-items:center; padding:48px 24px 24px; background:#08090bf5; }
    .omt-lightbox img { max-width:96vw; max-height:90vh; object-fit:contain; }
    .omt-lightbox button { position:absolute; top:12px; right:14px; border:1px solid var(--line-strong); border-radius:6px; padding:7px 10px; color:#fff; background:#25262b; cursor:pointer; }
    .omt-spinner { min-height:140px; display:grid; place-items:center; color:var(--muted); }
    .omt-visual-board { position:fixed; z-index:2147483006; inset:0; display:flex; flex-direction:column; color:#eff0f2; background:#0c0d0f; font:12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; }
    .omt-board-head { flex:none; min-height:58px; display:flex; align-items:center; gap:12px; padding:8px 10px 8px 14px; border-bottom:1px solid #ffffff1c; background:#17181b; }
    .omt-board-head h2 { margin:0; font-size:15px; line-height:1.15; font-weight:700; }
    .omt-board-head p { margin:2px 0 0; color:#8f9198; font-size:10px; }
    .omt-board-tabs { display:flex; gap:4px; margin-left:auto; }
    .omt-board-tabs button,.omt-board-close { min-height:32px; border:1px solid #ffffff22; border-radius:5px; padding:6px 9px; color:#cfd1d5; background:#ffffff06; cursor:pointer; font-weight:650; }
    .omt-board-tabs button.active { color:#101114; border-color:#eceef0; background:#eceef0; }
    .omt-board-close { margin-left:2px; }
    .omt-board-body { min-height:0; flex:1; padding:5px; }
    .omt-board-grid { width:100%; height:100%; min-width:0; min-height:0; display:grid; grid-template-columns:repeat(3,1fr); grid-template-rows:repeat(3,1fr); gap:4px; }
    .omt-board-current,.omt-board-match { position:relative; min-width:0; min-height:0; overflow:hidden; border:1px solid #ffffff1c; border-radius:3px; background:#050607; }
    .omt-board-current { border:2px solid #e8e9ec; }
    .omt-board-match.omt-board-guess { border:2px solid #e6a64c; }
    .omt-board-match.omt-board-guess span { color:#ffd993; }
    .omt-board-current img,.omt-board-match img { display:block; width:100%; height:100%; object-fit:contain; }
    .omt-board-current strong,.omt-board-match span { position:absolute; left:0; top:0; padding:4px 6px; color:#fff; background:#090a0cdd; font-size:10px; }
    .omt-board-current strong { color:#fff; font-size:11px; }
    button.omt-board-match { padding:0; cursor:pointer; }
    .omt-board-match em { position:absolute; right:0; bottom:0; padding:3px 5px; color:#d5d7db; background:#090a0cdd; font:normal 9px/1.2 inherit; }
    .omt-board-peek { position:fixed; z-index:4; inset:62px 2vw 40px; display:flex; flex-direction:column; min-width:0; min-height:0; overflow:hidden; border:1px solid #ffffff4a; border-radius:5px; background:#060709fa; box-shadow:0 20px 80px #000f; pointer-events:none; }
    .omt-board-peek-media { position:relative; min-height:0; flex:1; overflow:hidden; background:#050607; }
    .omt-board-peek-media > img { display:block; width:100%; height:100%; object-fit:cover; }
    .omt-native-pano { position:absolute; inset:0; z-index:1; opacity:0; transition:opacity .22s ease-out; background:#050607; }
    .omt-native-pano.omt-native-pano-ready { opacity:1; }
    .omt-board-peek-caption { flex:none; display:flex; justify-content:space-between; gap:20px; padding:7px 9px; color:#fff; background:#17181b; font-size:10px; }
    .omt-board-peek span { color:#8f9198; }
    .omt-board-foot { flex:none; min-height:37px; display:flex; align-items:center; gap:15px; padding:6px 10px; overflow:auto; border-top:1px solid #ffffff1c; color:#999ba2; background:#17181b; font-size:9px; white-space:nowrap; }
    .omt-board-foot b { color:#e6e7ea; }
    .omt-board-warning { margin-left:auto; color:#8f9198; }
    .omt-board-loading { position:fixed; z-index:2147483006; inset:0; display:grid; place-items:center; color:#d9dadd; background:#0c0d0ff7; font:600 14px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; }
    .omt-match-tooltip { position:fixed; z-index:2147483003; width:min(600px,calc(100vw - 16px)); overflow:hidden; border:1px solid var(--omt-neighbor-dot,#ff334f); border-radius:7px; color:#fff; background:#17181bf7; box-shadow:0 12px 40px #000c; pointer-events:none; backdrop-filter:blur(10px); }
    .omt-match-tooltip-head { display:flex; justify-content:space-between; gap:12px; padding:7px 9px; font-size:10px; }
    .omt-match-tooltip-head b { color:var(--omt-neighbor-dot,#ff536b); font-size:11px; }
    .omt-match-tooltip-head span { color:var(--muted); text-align:right; }
    .omt-match-tooltip-images { position:relative; display:grid; grid-template-columns:1fr 1fr; height:336px; background:#090a0c; }
    .omt-match-tooltip-images img { display:block; width:100%; height:168px; object-fit:cover; }
    .omt-match-tooltip-native { position:absolute; inset:0; z-index:2; display:none; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; gap:2px; pointer-events:none; }
    .omt-match-tooltip-native .omt-native-pano { position:relative; inset:auto; min-width:0; min-height:0; }
    .omt-match-tooltip-loading { height:100%; display:grid; place-items:center; grid-column:1 / -1; color:var(--muted); font-size:10px; }
    .omt-match-tooltip-foot { padding:6px 9px; border-top:1px solid var(--line); color:#c8cad0; font-size:9px; text-align:center; }
    .omt-match-tooltip.omt-match-tooltip-expanded { inset:62px 2vw 40px !important; width:auto; display:grid; grid-template-rows:auto minmax(0,1fr) auto; border-color:#ffffff4a; border-radius:5px; background:#060709fa; box-shadow:0 20px 80px #000f; backdrop-filter:none; }
    .omt-match-tooltip-expanded .omt-match-tooltip-images { min-height:0; height:auto; grid-template-columns:1fr 1fr; grid-template-rows:1fr 1fr; }
    .omt-match-tooltip-expanded .omt-match-tooltip-images img { min-width:0; min-height:0; height:100%; object-fit:cover; }
    .omt-match-tooltip-expanded .omt-match-tooltip-native { display:grid; }
    .omt-legend { position:fixed; z-index:2147482999; left:12px; bottom:96px; padding:6px 8px; border:1px solid #ffffff2c; border-radius:5px; color:#d8dade; background:#17181be8; box-shadow:0 5px 20px #0006; font-size:9px; }
    .omt-legend-dot { display:inline-block; width:8px; height:8px; margin:0 4px 0 1px; border:1px solid #fff; border-radius:50%; background:#767981; }
    .omt-legend-match { display:inline-block; width:8px; height:8px; margin:0 4px 0 8px; border:1px solid #fff; border-radius:50%; vertical-align:-1px; }
    .omt-legend-round-match { background:var(--omt-neighbor-dot,#ff334f); }
    .omt-legend-tail-match { background:var(--omt-neighbor-dot,#ff334f); opacity:.45; }
    .omt-legend-guess-match { background:var(--omt-guess-dot,#244cff); }
    .omt-legend-shared-match { background:linear-gradient(90deg,var(--omt-neighbor-dot,#ff334f) 0 50%,var(--omt-guess-dot,#244cff) 50%); }
    .omt-legend-current { display:inline-block; width:9px; height:9px; margin:0 4px 0 7px; border:2px solid #fff; border-radius:50%; background:#17181b; }
    .omt-legend-pin { position:relative; display:inline-block; width:10px; height:12px; margin:0 3px -2px 6px; border:1px solid #111; border-radius:7px 7px 7px 1px; background:#fff; transform:rotate(-45deg); }
    .omt-legend-pin::after { content:""; position:absolute; width:2px; height:2px; left:3px; top:3px; border-radius:50%; background:#111; }
    .omt-legend-pin-neighbors { width:11px; height:11px; margin:0 4px -2px 7px; border:1px solid #fff; border-radius:1px; background:var(--omt-neighbor-click,#ff00a8); box-shadow:0 0 0 1px #111; transform:rotate(45deg); }
    .omt-legend-pin-neighbors::after { display:none; }
    .omt-recommendation-receipt { position:fixed; z-index:2147483001; left:50%; bottom:106px; display:flex; gap:8px; max-width:calc(100vw - 24px); transform:translateX(-50%); color:#fff; font:600 12px/1.1 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif; pointer-events:none; }
    .omt-recommendation-receipt div { display:flex; align-items:baseline; gap:8px; min-width:0; padding:7px 11px; border:1px solid #ffffff24; border-radius:7px; color:#fff; background:#17142cf2; box-shadow:0 5px 16px #0008; white-space:nowrap; backdrop-filter:none; }
    .omt-recommendation-receipt div::before { content:""; flex:0 0 auto; width:6px; height:6px; border-radius:50%; background:#9290a8; }
    .omt-recommendation-receipt div.omt-neighbor-result::before { background:var(--omt-neighbor-click,#ff00a8); }
    .omt-recommendation-receipt span { margin:0; color:#bbb8ca; font-size:11px; font-weight:600; }
    .omt-recommendation-receipt strong { color:#fff; font-size:16px; line-height:1; font-weight:800; font-variant-numeric:tabular-nums; }
    .omt-recommendation-receipt em { color:#d1cedc; font-size:12px; font-style:normal; font-weight:650; font-variant-numeric:tabular-nums; }
    @media(max-width:850px) {
      .omt-dock { top:8px; right:8px; max-width:calc(100vw - 16px); }
      .omt-dock button { padding:7px 9px; }
      .omt-drawer { inset:8px 8px 78px; width:auto; min-width:0; }
      .omt-neighborhood,.omt-feedback { grid-template-columns:1fr 1fr; }
      .omt-recommendation-receipt { bottom:98px; gap:6px; }
      .omt-recommendation-receipt span { display:none; }
      .omt-views { grid-template-columns:1fr; }
      .omt-view,.omt-view img { height:190px; }
      .omt-board-head p,.omt-board-foot span:nth-child(n+3) { display:none; }
    }
  `;

  function haversineKm(firstLatitude, firstLongitude, secondLatitude, secondLongitude) {
    const radians = (value) => value * Math.PI / 180;
    const deltaLatitude = radians(secondLatitude - firstLatitude);
    const deltaLongitude = radians(secondLongitude - firstLongitude);
    const first = radians(firstLatitude);
    const second = radians(secondLatitude);
    const value = Math.sin(deltaLatitude / 2) ** 2
      + Math.cos(first) * Math.cos(second) * Math.sin(deltaLongitude / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, value))));
  }

  function formatOutcomeDistance(distanceKm) {
    if (distanceKm < 1) return `${Math.round(distanceKm * 1000).toLocaleString()} m`;
    if (distanceKm < 10) return `${distanceKm.toFixed(1)} km`;
    return `${Math.round(distanceKm).toLocaleString()} km`;
  }

  function realizedRecommendation(click, neighborhood) {
    const location = state.review?.location;
    const diagonal = Number(neighborhood?.mapDiagonalKm);
    if (!click || !location || !Number.isFinite(diagonal) || diagonal <= 0) return null;
    const latitude = Number(click.latitude ?? click.a);
    const longitude = Number(click.longitude ?? click.o);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const distanceKm = haversineKm(
      latitude,
      longitude,
      Number(location.latitude),
      Number(location.longitude),
    );
    return {
      distanceKm,
      score: 5000 * Math.exp(-10 * distanceKm / diagonal),
    };
  }

  function recommendationReceipt() {
    const review = state.review;
    const neighborhood = review?.visualNeighborhood;
    if (!review || !neighborhood) return "";
    const receipts = [];
    if (state.showVisualNeighbors) {
      const outcome = realizedRecommendation(neighborhood.weightedClick, neighborhood);
      if (outcome) {
        receipts.push(`<div class="omt-neighbor-result"><span>Visual click</span><strong>${Math.round(outcome.score).toLocaleString()} pts</strong><em>${formatOutcomeDistance(outcome.distanceKm)}</em></div>`);
      }
    }
    return receipts.length
      ? `<div class="omt-recommendation-receipt" aria-label="Recommended click result">${receipts.join("")}</div>`
      : "";
  }

  function mapModeLabel() {
    if (state.showVisualNeighbors) return "Similar";
    return "Map clear";
  }

  function familyDisplayTitle(meta) {
    const title = String(meta?.title || "").trim();
    const generic = title.match(/^(?:whole-scene visual pattern|directional scene pattern|visual family)\s*[·:-]\s*(.+)$/i);
    if (generic) return `Family ${generic[1]}`;
    return title || `Family ${String(meta?.id || "").slice(-6)}`;
  }

  function usefulFamilyDescription(meta) {
    const description = String(meta?.description || "").trim();
    if (!description) return "";
    if (/^(?:a blindly discovered|a recurring visual|a learned visual)/i.test(description)) return "";
    return description;
  }

  function trainerDock(review) {
    const compare = review.visualNeighborhood
      ? `<button class="omt-dock-primary" id="omt-compare-launch">Compare views <kbd>V</kbd></button>`
      : "";
    const mode = review.visualNeighborhood
      ? `<button id="omt-mode-cycle" title="Toggle similarity map">${mapModeLabel()} <kbd>M</kbd></button>`
      : "";
    const guess = review.visualNeighborhood && !review.universal
      ? `<button id="omt-guess-cycle" class="${state.showGuessNeighbors ? "active" : ""}" title="Compare the visual neighborhood near your guess with the revealed location" ${state.playerGuess ? "" : "disabled"}>Guess ${state.showGuessNeighbors ? "on" : "off"} <kbd>G</kbd></button>`
      : "";
    const settings = review.visualNeighborhood
      ? `<details class="omt-dock-settings"><summary>Colors</summary><div class="omt-dock-settings-panel"><label class="omt-color-setting">Round <input type="color" id="omt-dock-dot-color" value="${state.neighborDotColor}"></label><label class="omt-color-setting">Guess <input type="color" id="omt-dock-guess-dot-color" value="${state.guessDotColor}"></label><label class="omt-color-setting">Click <input type="color" id="omt-dock-click-color" value="${state.neighborClickColor}"></label></div></details>`
      : "";
    return `<div class="omt-dock">${compare}${mode}${guess}${settings}</div>`;
  }

  function bindDockUi() {
    state.shadow.getElementById("omt-compare-launch")?.addEventListener("click", openVisualBoard);
    state.shadow.getElementById("omt-mode-cycle")?.addEventListener("click", cycleMapLayers);
    state.shadow.getElementById("omt-guess-cycle")?.addEventListener("click", () => {
      setGuessComparison(!state.showGuessNeighbors);
    });
    state.shadow.getElementById("omt-dock-dot-color")?.addEventListener("input", (event) => {
      setMapColor("dots", event.target.value);
    });
    state.shadow.getElementById("omt-dock-guess-dot-color")?.addEventListener("input", (event) => {
      setMapColor("guess", event.target.value);
    });
    state.shadow.getElementById("omt-dock-click-color")?.addEventListener("input", (event) => {
      setMapColor("click", event.target.value);
    });
  }

  function render() {
    ensureRoot();
    const review = state.review;
    if (!review) return;
    // The active trainer has one focused learning loop: similarity evidence.
    // Family review remains recoverable from family-meta-trainer-v1.
    state.shadow.innerHTML = `<style>${styles}</style><div class="omt">${trainerDock(review)}${state.overlays.length ? mapLegend(review.visualNeighborhood) : ""}${recommendationReceipt()}</div>`;
    bindDockUi();
    if (state.visualBoardOpen) queueMicrotask(renderVisualBoard);
    return;
    const metas = review.metas || [];
    if (!metas.length) {
      state.shadow.innerHTML = `<style>${styles}</style><div class="omt">${trainerDock(review, metas)}${recommendationReceipt()}</div>`;
      bindDockUi();
      return;
    }
    const meta = metas[state.active];
    const summary = review.reviewSummary || {};
    const fallback = meta.matchMode === "nearest";
    if (!state.drawerOpen) {
      state.shadow.innerHTML = `<style>${styles}</style><div class="omt">${trainerDock(review, metas)}${state.overlays.length ? mapLegend(meta, fallback, review.visualNeighborhood) : ""}${recommendationReceipt(meta)}</div>`;
      bindDockUi();
      if (state.visualBoardOpen) queueMicrotask(renderVisualBoard);
      return;
    }
    const expected = (meta.click || state.detail.get(meta.id)?.click)?.s?.expected;
    const selectedFeedback = state.feedback[meta.id] || "";
    const optionHtml = metas.map((item, index) => `<option value="${index}" ${index === state.active ? "selected" : ""}>${index + 1}. ${esc(familyDisplayTitle(item))} · ${item.matchMode === "nearest" ? `${item.matchStrength || 0}/100` : `#${(item.globalMatchRank || 1).toLocaleString()}`}</option>`).join("");
    const viewEvidence = meta.explanation?.view;
    const viewShares = viewEvidence?.positiveShares || [0, 0, 0, 0];
    const viewContributions = viewEvidence?.contributions || [0, 0, 0, 0];
    const viewHtml = review.location.views.map((path, slot) => {
      const share = Math.max(0, Number(viewShares[slot]) || 0);
      const contribution = Number(viewContributions[slot]) || 0;
      const evidence = viewEvidence
        ? `<b class="omt-view-contribution">${Math.round(share * 100)}%</b><div class="omt-view-evidence"><i style="width:${Math.round(share * 100)}%"></i></div>`
        : "";
      const label = viewEvidence
        ? `Current location · heading ${review.location.headings[slot]}° · ${Math.round(share * 100)}% of positive view evidence · signed score contribution ${contribution.toFixed(3)}`
        : `Current location · heading ${review.location.headings[slot]}°`;
      return `<button class="omt-view" data-image="${esc(path)}" data-label="${esc(label)}"><img data-src="${esc(path)}" alt="Current panorama heading ${review.location.headings[slot]} degrees">${evidence}<span>${review.location.headings[slot]}°</span></button>`;
    }).join("");
    const regionEvidence = meta.explanation?.region;
    const regionHtml = regionEvidence ? `<section class="omt-section"><div class="omt-section-head"><h3>Image regions</h3><span>red supports · cyan opposes</span></div><button class="omt-evidence" data-image="${esc(regionEvidence.asset)}" data-label="${esc(familyDisplayTitle(meta))} · score-driving image regions"><img data-src="${esc(regionEvidence.asset)}" alt="Image regions contributing to ${esc(familyDisplayTitle(meta))}"></button><p class="omt-note">Masking the highlighted region changed the family score by ${regionEvidence.topMaskDrop.toFixed(3)}; a random region of the same size changed it by ${regionEvidence.randomMedianDrop.toFixed(3)}.</p></section>` : "";
    const representativeViews = representativeViewsPath(meta, review);
    const filtered = [
      summary.fallbackUsed ? "No confident match; showing the nearest visual family" : "",
      summary.hiddenRedundantMatches ? `${summary.hiddenRedundantMatches} repeated detector variant${summary.hiddenRedundantMatches === 1 ? "" : "s"} combined` : "",
      summary.hiddenNearDuplicates ? `${summary.hiddenNearDuplicates} near-identical match${summary.hiddenNearDuplicates === 1 ? "" : "es"} combined for this round` : "",
      summary.hiddenWeakMatches ? `${summary.hiddenWeakMatches} borderline match${summary.hiddenWeakMatches === 1 ? "" : "es"} hidden` : "",
      summary.hiddenByAttentionBudget ? `${summary.hiddenByAttentionBudget} additional strong match${summary.hiddenByAttentionBudget === 1 ? "" : "es"} deferred` : "",
      summary.scheduledLessons ? `${summary.scheduledLessons} balanced lesson${summary.scheduledLessons === 1 ? "" : "s"} assigned here` : "",
    ].filter(Boolean).join(" · ");
    const agreement = meta.activeVariants > 1 ? `${meta.activeVariants} variants` : "1 variant";
    const strengthLabel = fallback ? `${meta.matchStrength || 0}/100 nearest match` : `round rank #${(meta.globalMatchRank || 1).toLocaleString()}`;
    const evidenceNote = fallback
      ? `Closest learned family (${meta.matchStrength || 0}/100 match). The examples show the family's clearest cases.`
      : `This round ranks #${(meta.globalMatchRank || 1).toLocaleString()} in the family and is stronger than ${meta.matchPercentile || "?"}% of its accepted locations.`;
    const neighborhood = review.visualNeighborhood;
    const neighborClick = neighborhood?.weightedClick;
    const guessComparison = state.showGuessNeighbors ? state.guessNeighborhood : null;
    const clickLines = [
      state.showBestMeta && expected
        ? `<div><strong>Family click</strong><span>${expected.a.toFixed(5)}, ${expected.o.toFixed(5)}</span><span>${Math.round(expected.e).toLocaleString()} average points within this family</span></div>`
        : "",
      state.showVisualNeighbors && neighborClick
        ? `<div><strong>${review.cloud ? "C-RADIO click" : "Similar-view click"}</strong><span>${neighborClick.latitude.toFixed(5)}, ${neighborClick.longitude.toFixed(5)}</span><span>${Number.isFinite(neighborClick.expectedScore) ? `${Math.round(neighborClick.expectedScore).toLocaleString()} expected points` : "exact cloud recommendation"}</span></div>`
        : "",
    ].filter(Boolean).join("");
    const neighborhoodHtml = neighborhood ? (() => {
      const formatRadius = (radius) => radius < 1
        ? `${Math.round(radius * 1000)} m`
        : `${radius.toLocaleString()} km`;
      const radiusHtml = neighborhood.radii.map((item) => {
        const distance = formatRadius(item.radiusKm);
        return `<div class="omt-metric"><b>${item.matches}/${neighborhood.neighbors}</b><span>matches within ${distance}</span></div>`;
      }).join("");
      const reference = neighborhood.radii[Math.min(1, neighborhood.radii.length - 1)];
      const densityNote = reference
        ? `At ${formatRadius(reference.radiusKm)}, nearby visual matches occur ${reference.densityAdjustedRatio.toFixed(1)}× as often as this map's sampling alone would predict.`
        : "";
      const outcome = realizedRecommendation(neighborClick, neighborhood);
      const result = outcome
        ? `<div class="omt-result-row"><div><b>${Math.round(outcome.score).toLocaleString()}</b><span>points from the similar-view click</span></div><div><b>${formatOutcomeDistance(outcome.distanceKm)}</b><span>from the revealed location</span></div></div>`
        : "";
      const posterior = neighborhood.posterior;
      const boundary = neighborhood.boundary;
      const posteriorLabel = boundary?.detected
        ? `sustained slope boundary · ${boundary.score.toFixed(1)}×`
        : "diffuse nearest examples · no clear boundary";
      const posteriorNote = posterior
        ? `${boundary?.detected ? "The displayed set ends where both mean and median similarity-curve slope change persistently." : "No defensible similarity-curve step was found, so the displayed set remains the self-tuned diffuse neighborhood."} The recommended click also uses the broader map-wide distribution (effective support: ${Math.round(posterior.effectiveLocations).toLocaleString()} locations).`
        : "";
      const heading = boundary?.detected ? "coherent visual matches" : "nearest visual examples";
      return `<section class="omt-section"><div class="omt-section-head"><h3>${neighborhood.neighbors.toLocaleString()} ${heading}</h3><span>${esc(posteriorLabel)}</span></div>${result}<div class="omt-neighborhood">${radiusHtml}</div><p class="omt-note">${esc(posteriorNote)} Median shown-match distance: ${neighborhood.medianDistanceKm.toFixed(1)} km. Closest tenth: ${neighborhood.nearestTenthDistanceKm.toFixed(1)} km. ${esc(densityNote)}</p></section>`;
    })() : "";
    const guessComparisonHtml = guessComparison ? (() => {
      const overlap = guessComparison.overlap;
      const anchorDistance = Number(guessComparison.anchor.distanceFromGuessKm);
      const distance = anchorDistance < 1
        ? `${Math.round(anchorDistance * 1000)} m`
        : `${anchorDistance.toFixed(1)} km`;
      return `<p class="omt-note"><b>${overlap.sharedLocations.toLocaleString()} shared locations</b> between the two visual cores (${Math.round(overlap.jaccard * 100)}% overlap). Guess-side anchor: the nearest stored map panorama, ${distance} from your click.</p>`;
    })() : state.showGuessNeighbors && state.playerGuess
      ? `<p class="omt-note">Loading the visual neighborhood around your guess…</p>`
      : "";
    state.shadow.innerHTML = `
      <style>${styles}</style><div class="omt">
        <aside class="omt-drawer" aria-label="Post-round visual evidence">
          <header class="omt-head"><div><small>${esc(review.datasetDisplayName || "Current map")} · location ${review.location.mapIndex + 1}</small><strong>Round evidence</strong></div><button class="omt-icon" id="omt-close" aria-label="Close review">×</button></header>
          <div class="omt-toolbar"><button class="omt-compare-button" id="omt-compare">Compare views <kbd>V</kbd></button><button id="omt-mode-cycle">${mapModeLabel()} <kbd>M</kbd></button><button class="omt-fit" id="omt-fit">Fit map</button></div>
          <div class="omt-scroll">
            ${neighborhoodHtml}
            <section class="omt-section"><div class="omt-section-head"><h3>Map overlays</h3><span>saved between rounds</span></div><div class="omt-map-actions"><label class="omt-layer-toggle"><input type="checkbox" id="omt-best-meta" ${state.showBestMeta ? "checked" : ""}>Families</label><label class="omt-layer-toggle"><input type="checkbox" id="omt-neighbors" ${state.showVisualNeighbors ? "checked" : ""}>Round matches</label><label class="omt-layer-toggle" title="Compare the visual neighborhood near your guess with the revealed location"><input type="checkbox" id="omt-guess-neighbors" ${state.showGuessNeighbors ? "checked" : ""} ${state.playerGuess ? "" : "disabled"}>Guess comparison</label><label class="omt-color-setting">Round <input type="color" id="omt-dot-color" value="${state.neighborDotColor}"></label><label class="omt-color-setting">Guess <input type="color" id="omt-guess-dot-color" value="${state.guessDotColor}"></label><label class="omt-color-setting">Click <input type="color" id="omt-click-color" value="${state.neighborClickColor}"></label></div>${guessComparisonHtml}<div class="omt-click-lines">${clickLines || ""}</div></section>
            <section class="omt-section"><div class="omt-section-head"><h3>Matched families</h3><span>${metas.length} shown${review.moreMetas?.length ? ` · ${review.moreMetas.length} more` : ""}</span></div><nav class="omt-nav"><button id="omt-prev" ${state.active === 0 ? "disabled" : ""}>←</button><select id="omt-select" aria-label="Active family">${optionHtml}</select><button id="omt-next" ${state.active === metas.length - 1 ? "disabled" : ""}>→</button></nav>${review.moreMetas?.length ? `<button class="omt-more" id="omt-more">Add next family (${review.moreMetas.length} remaining)</button>` : ""}<div class="omt-family-head"><div><h2>${esc(familyDisplayTitle(meta))}</h2><p>${agreement}</p></div><span class="omt-strength">${esc(strengthLabel)}</span></div><div class="omt-metrics"><div class="omt-metric"><b>${(meta.bits || 0).toFixed(2)}</b><span>location bits</span></div><div class="omt-metric"><b>${meta.members.toLocaleString()}</b><span>family locations</span></div><div class="omt-metric"><b>${Number.isFinite(meta.repeatability) ? `${Math.round(meta.repeatability * 100)}%` : "—"}</b><span>replicated</span></div></div>${usefulFamilyDescription(meta) ? `<p class="omt-description">${esc(usefulFamilyDescription(meta))}</p>` : ""}${filtered ? `<details class="omt-system-details"><summary>Filtering details</summary>${esc(filtered)}</details>` : ""}</section>
            <section class="omt-section"><div class="omt-section-head"><h3>This round</h3><span>${viewEvidence ? "family evidence by direction" : "four stored directions"}</span></div><div class="omt-views">${viewHtml}</div></section>
            <section class="omt-section"><div class="omt-section-head"><h3>Family examples</h3><span>this round + eight representative views</span></div><button class="omt-evidence" data-image="${esc(representativeViews)}" data-label="${esc(familyDisplayTitle(meta))} · representative views"><img data-src="${esc(representativeViews)}" alt="Representative views for ${esc(familyDisplayTitle(meta))}"></button><p class="omt-note">${esc(evidenceNote)}</p></section>
            ${regionHtml}
            <section class="omt-section"><div class="omt-section-head"><h3>Your assessment</h3><span>stored locally</span></div><div class="omt-feedback">${[["recognized","Recognized"],["unclear","Unclear"],["artifact","Bad match"],["duplicate","Duplicate"]].map(([value,label]) => `<button data-feedback="${value}" class="${selectedFeedback === value ? "active" : ""}">${label}</button>`).join("")}</div></section>
          </div>
        </aside>${mapLegend(meta, fallback, neighborhood)}
      </div>`;
    bindUi();
    hydrateImages();
    if (state.visualBoardOpen) queueMicrotask(renderVisualBoard);
  }

  function renderOffline(message) {
    ensureRoot();
    state.shadow.innerHTML = `<style>${styles}</style><div class="omt"><div class="omt-dock"><div class="omt-dock-status" title="${esc(message)}">${esc(message || "Trainer data unavailable")}</div></div></div>`;
  }

  function renderPending(message = "Analyzing visual similarity…") {
    ensureRoot();
    state.shadow.innerHTML = `<style>${styles}</style><div class="omt"><div class="omt-dock"><div class="omt-dock-status pending">${esc(message)}</div></div></div>`;
  }

  function bindUi() {
    state.shadow.getElementById("omt-launch")?.addEventListener("click", () => {
      state.drawerOpen = !state.drawerOpen;
      if (state.drawerOpen) openDrawer(); else closeDrawer();
    });
    state.shadow.getElementById("omt-compare")?.addEventListener("click", openVisualBoard);
    state.shadow.getElementById("omt-close").addEventListener("click", closeDrawer);
    state.shadow.getElementById("omt-prev")?.addEventListener("click", () => selectMeta(state.active - 1));
    state.shadow.getElementById("omt-next")?.addEventListener("click", () => selectMeta(state.active + 1));
    state.shadow.getElementById("omt-select").addEventListener("change", (event) => selectMeta(Number(event.target.value)));
    state.shadow.getElementById("omt-more")?.addEventListener("click", addMoreMeta);
    state.shadow.getElementById("omt-fit").addEventListener("click", () => showMetaOnMap(true));
    state.shadow.getElementById("omt-mode-cycle")?.addEventListener("click", cycleMapLayers);
    state.shadow.getElementById("omt-best-meta")?.addEventListener("change", (event) => {
      setMapLayer("meta", event.target.checked);
    });
    state.shadow.getElementById("omt-neighbors")?.addEventListener("change", (event) => {
      setMapLayer("neighbors", event.target.checked);
    });
    state.shadow.getElementById("omt-guess-neighbors")?.addEventListener("change", (event) => {
      setGuessComparison(event.target.checked);
    });
    state.shadow.getElementById("omt-dot-color")?.addEventListener("input", (event) => {
      setMapColor("dots", event.target.value);
    });
    state.shadow.getElementById("omt-click-color")?.addEventListener("input", (event) => {
      setMapColor("click", event.target.value);
    });
    state.shadow.getElementById("omt-guess-dot-color")?.addEventListener("input", (event) => {
      setMapColor("guess", event.target.value);
    });
    for (const button of state.shadow.querySelectorAll("[data-feedback]")) {
      button.addEventListener("click", () => saveFeedback(button.dataset.feedback));
    }
    for (const button of state.shadow.querySelectorAll("[data-image]")) {
      button.addEventListener("click", () => openLightbox(button.dataset.image, button.dataset.label));
    }
  }

  function setMapColor(kind, value) {
    if (kind === "dots") {
      state.neighborDotColor = normalizeColor(value, state.neighborDotColor);
    } else if (kind === "guess") {
      state.guessDotColor = normalizeColor(value, state.guessDotColor);
    } else {
      state.neighborClickColor = normalizeColor(value, state.neighborClickColor);
      state.pinIcons = null;
    }
    saveMapColorPreferences();
    syncMapColorVariables();
    if (state.review || state.fastNeighborhood) showMetaOnMap(false);
  }

  function setGuessComparison(enabled) {
    // The universal (corpus) path used to bail out here: it had no map data to
    // search for a panorama near the guess. The static pack carries every
    // corpus coordinate, so it is served by loadGuessNeighborhood below.
    state.showGuessNeighbors = Boolean(enabled);
    saveMapLayerPreferences();
    if (state.showGuessNeighbors && !state.showVisualNeighbors) {
      state.showVisualNeighbors = true;
      saveMapLayerPreferences();
    }
    render();
    if (state.showGuessNeighbors) {
      loadGuessNeighborhood(state.requestToken);
    } else {
      showMetaOnMap(false);
    }
  }

  function setMapLayer(layer, enabled) {
    if (layer !== "neighbors") return;
    setMapLayerMode(enabled);
  }

  function setMapLayerMode(showVisualNeighbors) {
    state.showBestMeta = false;
    state.showVisualNeighbors = showVisualNeighbors;
    saveMapLayerPreferences();
    render();
    showMetaOnMap(false);
    if (!state.drawerOpen) render();
  }

  function cycleMapLayers() {
    setMapLayerMode(!state.showVisualNeighbors);
  }

  function handleLayerHotkeys(event) {
    if (event.code === "Escape" && state.visualBoardOpen) {
      event.preventDefault();
      closeVisualBoard();
      return;
    }
    if (!state.review || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.composedPath?.()[0] || event.target;
    if (target?.matches?.("input, select, textarea, [contenteditable=true]")) return;
    if (event.code === "KeyM") {
      event.preventDefault();
      event.stopPropagation();
      cycleMapLayers();
    } else if (event.code === "KeyV") {
      event.preventDefault();
      event.stopPropagation();
      if (state.visualBoardOpen) closeVisualBoard(); else openVisualBoard();
    } else if (event.code === "KeyG" && state.playerGuess && !state.review.universal) {
      event.preventDefault();
      event.stopPropagation();
      setGuessComparison(!state.showGuessNeighbors);
    }
  }

  function exposureHasFocus() {
    return document.visibilityState === "visible" && document.hasFocus();
  }

  function shortContentDigest(slots) {
    const coordinate = (value) => (
      Number.isFinite(Number(value)) ? Number(value).toFixed(6) : ""
    );
    const signature = slots.map((slot) => {
      const ref = slot.ref || {};
      return [
        slot.slotIndex,
        slot.role,
        ref.receiptRank ?? "",
        ref.panoId ?? "",
        coordinate(ref.latitude),
        coordinate(ref.longitude),
        ref.viewSlot ?? "",
        slot.heading ?? "",
      ].join("|");
    }).join(";");
    let hash = 0x811c9dc5;
    for (let index = 0; index < signature.length; index += 1) {
      hash ^= signature.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32:${hash.toString(16).padStart(8, "0")}`;
  }

  function boardContentForMode(mode, boardEntries) {
    const location = state.review?.location || {};
    const slots = [{
      slotIndex: 0,
      role: "roundView",
      ref: {
        panoId: location.panoId,
        latitude: location.latitude,
        longitude: location.longitude,
        viewSlot: mode.currentSlot,
      },
      heading: mode.currentHeading,
      contentStatus: "pending",
    }];
    for (const [index, item] of boardEntries.entries()) {
      const receiptRank = item.kind === "guess-local"
        ? item.globalPanoRank
        : item.rank;
      const ref = Number.isFinite(receiptRank)
        ? { receiptRank, viewSlot: item.slot }
        : {
            panoId: item.panoId,
            latitude: item.latitude,
            longitude: item.longitude,
            viewSlot: item.slot,
          };
      slots.push({
        slotIndex: index + 1,
        role: item.kind === "guess-local" ? "nearGuessMatch" : "globalMatch",
        ref,
        heading: item.heading,
        contentStatus: "pending",
      });
    }
    while (slots.length < 9) {
      slots.push({
        slotIndex: slots.length,
        role: "empty",
        ref: null,
        heading: null,
        contentStatus: "placeholder",
      });
    }
    return {
      mode: mode.id,
      renderedAtMs: Date.now(),
      policyVersion: "visual-board-3x3-near-guess-v1",
      declaredSlots: 9,
      contentDigest: shortContentDigest(slots),
      contentChangedDuringMode: false,
      slots,
    };
  }

  function registerBoardContent(content) {
    const exposure = state.visualExposure;
    if (!exposure || !content) return;
    const existing = exposure.boardContent.find((item) => item.mode === content.mode);
    if (!existing) {
      exposure.boardContent.push(content);
    } else if (existing.contentDigest !== content.contentDigest) {
      existing.contentChangedDuringMode = true;
    }
  }

  function markBoardContentStatus(mode, digest, slotIndex, status) {
    const content = state.visualExposure?.boardContent.find(
      (item) => item.mode === mode && item.contentDigest === digest
    );
    const slot = content?.slots?.[slotIndex];
    if (slot) slot.contentStatus = status;
  }

  function monotonicNow() {
    return typeof performance?.now === "function" ? performance.now() : Date.now();
  }

  function exposurePayload(
    exposure = state.visualExposure,
    nowMs = Date.now(),
    nowMono = monotonicNow(),
  ) {
    if (!exposure) return null;
    const intervals = exposure.intervals.map((interval) => ({ ...interval }));
    let totalDwellMs = exposure.totalDwellMs;
    let focusedDwellMs = exposure.focusedDwellMs;
    let overflowIntervals = exposure.overflowIntervals;
    const overflowModes = [...exposure.overflowModes];
    if (exposure.active) {
      const active = exposure.active;
      const focused = active.focusedMs + (
        active.focusedStartMono == null
          ? 0
          : Math.max(0, nowMono - active.focusedStartMono)
      );
      const durationMs = Math.max(0, nowMono - active.enterAtMono);
      const interval = {
        mode: active.mode,
        enterAtMs: active.enterAtMs,
        exitAtMs: Math.max(active.enterAtMs, nowMs),
        durationMs,
        focusedMs: Math.min(focused, durationMs),
      };
      totalDwellMs += durationMs;
      focusedDwellMs += interval.focusedMs;
      if (intervals.length < 20) intervals.push(interval);
      else {
        overflowIntervals += 1;
        if (!overflowModes.includes(interval.mode)) overflowModes.push(interval.mode);
      }
    }
    return {
      ...exposure.identity,
      intervals,
      boardContent: exposure.boardContent.map((content) => ({
        ...content,
        slots: content.slots.map((slot) => ({
          ...slot,
          ref: slot.ref ? { ...slot.ref } : null,
        })),
      })),
      overflowModes,
      overflowIntervals,
      totalDwellMs,
      focusedDwellMs,
      durationClock: "performance-now-monotonic",
      userscriptVersion: USERSCRIPT_VERSION,
    };
  }

  function pendingVisualExposures() {
    try {
      const stored = JSON.parse(
        localStorage.getItem(PENDING_EXPOSURE_STORAGE_KEY) || "[]"
      );
      if (Array.isArray(stored)) return stored.filter((item) => item?.eventKey);
      return stored?.eventKey ? [stored] : [];
    } catch (_error) {
      return [];
    }
  }

  function storePendingVisualExposure(payload) {
    if (!payload?.eventKey) return;
    const pending = pendingVisualExposures().filter(
      (item) => item.eventKey !== payload.eventKey
    );
    pending.push(payload);
    localStorage.setItem(
      PENDING_EXPOSURE_STORAGE_KEY,
      JSON.stringify(pending.slice(-100)),
    );
  }

  function removePendingVisualExposure(eventKey) {
    const pending = pendingVisualExposures().filter(
      (item) => item.eventKey !== eventKey
    );
    if (pending.length) {
      localStorage.setItem(PENDING_EXPOSURE_STORAGE_KEY, JSON.stringify(pending));
    } else {
      localStorage.removeItem(PENDING_EXPOSURE_STORAGE_KEY);
    }
  }

  function persistVisualExposure() {
    const payload = exposurePayload();
    if (!payload) return;
    payload.boardOpened = true;
    payload.finalized = false;
    payload.finalizationReason = "checkpoint";
    payload.lastCheckpointAtMs = Date.now();
    payload.dwellStatus = "checkpoint-lower-bound";
    payload.checkpointPolicy = "close-focus-visibility";
    try {
      storePendingVisualExposure(payload);
    } catch (_error) {}
  }

  function endActiveVisualExposure({ persist = true } = {}) {
    const exposure = state.visualExposure;
    const active = exposure?.active;
    if (!exposure || !active) return;
    const nowMs = Date.now();
    const nowMono = monotonicNow();
    if (active.focusedStartMono != null) {
      active.focusedMs += Math.max(0, nowMono - active.focusedStartMono);
    }
    const durationMs = Math.max(0, nowMono - active.enterAtMono);
    const interval = {
      mode: active.mode,
      enterAtMs: active.enterAtMs,
      exitAtMs: Math.max(active.enterAtMs, nowMs),
      durationMs,
      focusedMs: Math.min(
        active.focusedMs,
        durationMs,
      ),
    };
    exposure.totalDwellMs += durationMs;
    exposure.focusedDwellMs += interval.focusedMs;
    if (exposure.intervals.length < 20) exposure.intervals.push(interval);
    else {
      exposure.overflowIntervals += 1;
      if (!exposure.overflowModes.includes(interval.mode)) {
        exposure.overflowModes.push(interval.mode);
      }
    }
    exposure.active = null;
    if (persist) persistVisualExposure();
  }

  function startVisualExposure(mode, content = null) {
    if (!state.roundIdentity || !state.visualBoardOpen) return;
    if (!state.visualExposure) {
      state.visualExposure = {
        identity: { ...state.roundIdentity },
        intervals: [],
        overflowModes: [],
        overflowIntervals: 0,
        totalDwellMs: 0,
        focusedDwellMs: 0,
        boardContent: [],
        active: null,
      };
    }
    registerBoardContent(content);
    if (state.visualExposure.active?.mode === mode) return;
    // Mode changes can be rapid. Keep the exact interval in memory without a
    // synchronous localStorage write on the interaction path.
    endActiveVisualExposure({ persist: false });
    const nowMs = Date.now();
    const nowMono = monotonicNow();
    state.visualExposure.active = {
      mode,
      enterAtMs: nowMs,
      enterAtMono: nowMono,
      focusedMs: 0,
      focusedStartMono: exposureHasFocus() ? nowMono : null,
    };
  }

  function updateVisualExposureFocus() {
    const active = state.visualExposure?.active;
    if (!active) return;
    const nowMono = monotonicNow();
    if (exposureHasFocus()) {
      if (active.focusedStartMono == null) active.focusedStartMono = nowMono;
    } else if (active.focusedStartMono != null) {
      active.focusedMs += Math.max(0, nowMono - active.focusedStartMono);
      active.focusedStartMono = null;
    }
    persistVisualExposure();
  }

  async function flushVisualExposure(finalizationReason = "round-ended") {
    const identity = state.roundIdentity;
    if (!identity || state.finalizedExposureKeys.has(identity.eventKey)) return;
    state.finalizedExposureKeys.add(identity.eventKey);
    if (state.visualExposure) endActiveVisualExposure({ persist: false });
    const boardOpened = Boolean(state.visualExposure);
    const payload = state.visualExposure
      ? exposurePayload()
      : {
          ...identity,
          intervals: [],
          boardContent: [],
          overflowModes: [],
          overflowIntervals: 0,
          totalDwellMs: 0,
          focusedDwellMs: 0,
          durationClock: "performance-now-monotonic",
          userscriptVersion: USERSCRIPT_VERSION,
        };
    state.visualExposure = null;
    if (!payload) return;
    payload.boardOpened = boardOpened;
    payload.finalized = true;
    payload.finalizationReason = finalizationReason;
    payload.lastCheckpointAtMs = Date.now();
    payload.dwellStatus = "complete";
    payload.checkpointPolicy = "close-focus-visibility";
    storePendingVisualExposure(payload);
    try {
      await request("/api/visual-exposure", { method: "POST", body: payload });
      removePendingVisualExposure(payload.eventKey);
    } catch (_error) {
      // The bounded payload remains in local storage for the next page load.
    }
  }

  async function flushPendingVisualExposure() {
    for (const pending of pendingVisualExposures()) {
      const payload = pending.finalized === false
        ? {
            ...pending,
            finalized: true,
            finalizationReason: "recovered-checkpoint",
            dwellStatus: "right-censored-lower-bound",
          }
        : pending;
      try {
        await request("/api/visual-exposure", { method: "POST", body: payload });
        removePendingVisualExposure(payload.eventKey);
      } catch (_error) {
        break;
      }
    }
  }

  function closeVisualBoard() {
    endActiveVisualExposure();
    state.visualBoardOpen = false;
    state.visualBoardModifierCleanup?.();
    state.visualBoardModifierCleanup = null;
    state.visualBoardShiftUpdate = null;
    state.shadow?.querySelector(".omt-visual-board,.omt-board-loading")?.remove();
  }

  function disposeNativePanoramas(panoramas) {
    const maps = pageWindow.google?.maps;
    for (const panorama of panoramas || []) {
      try {
        maps?.event?.clearInstanceListeners?.(panorama);
        panorama.setVisible?.(false);
        panorama.unbindAll?.();
      } catch (_error) {}
    }
    if (Array.isArray(panoramas)) panoramas.length = 0;
  }

  function nativeStreetView(container, panoId, heading) {
    const maps = pageWindow.google?.maps;
    if (!container || !panoId || !maps?.StreetViewPanorama) return null;
    const panorama = new maps.StreetViewPanorama(container, {
      pano: String(panoId),
      pov: { heading: Number(heading) || 0, pitch: 0 },
      zoom: 1,
      addressControl: false,
      clickToGo: false,
      disableDefaultUI: true,
      disableDoubleClickZoom: true,
      fullscreenControl: false,
      linksControl: false,
      motionTracking: false,
      motionTrackingControl: false,
      panControl: false,
      scrollwheel: false,
      showRoadLabels: false,
      zoomControl: false,
    });
    let revealTimer = 0;
    const reveal = () => {
      const status = panorama.getStatus?.();
      if (!maps.StreetViewStatus || status === maps.StreetViewStatus.OK) {
        window.clearTimeout(revealTimer);
        // `pano_changed` and OK status precede the first painted tile by a few
        // frames in some browsers. Keep the correctly filled thumbnail under
        // it briefly, then crossfade instead of exposing the renderer's black
        // backing surface.
        revealTimer = window.setTimeout(() => {
          if (container.isConnected) container.classList.add("omt-native-pano-ready");
        }, 140);
      }
    };
    maps.event?.addListenerOnce?.(panorama, "status_changed", reveal);
    maps.event?.addListenerOnce?.(panorama, "pano_changed", () => {
      window.setTimeout(reveal, 50);
    });
    window.setTimeout(reveal, 850);
    return panorama;
  }

  function renderVisualBoard() {
    if (!state.visualBoardOpen || !state.shadow || !state.visualBoard) return;
    state.visualBoardModifierCleanup?.();
    state.visualBoardModifierCleanup = null;
    state.shadow.querySelector(".omt-visual-board,.omt-board-loading")?.remove();
    const board = state.visualBoard;
    const mode = board.modes.find((item) => item.id === state.visualBoardMode)
      || board.modes[0];
    state.visualBoardMode = mode.id;
    const literal = mode.id === "literal";
    const modeLabels = { consensus: "Main group", alternate: "Other group", literal: "Nearest 8" };
    const tabs = board.modes.map((item) => `<button data-board-mode="${esc(item.id)}" class="${item.id === mode.id ? "active" : ""}">${esc(modeLabels[item.id] || item.label)}</button>`).join("");
    const boardEntries = mode.guessMatch
      ? [mode.guessMatch, ...mode.entries]
      : mode.entries;
    const boardContent = boardContentForMode(mode, boardEntries);
    const contentDigest = boardContent.contentDigest;
    const matches = boardEntries.map((item, index) => {
      const contentAttributes = `data-board-content-mode="${esc(mode.id)}" data-board-content-digest="${esc(contentDigest)}" data-board-slot="${index + 1}"`;
      if (item.kind === "guess-local") {
        const distance = item.distanceFromGuessKm < 1
          ? `${Math.round(item.distanceFromGuessKm * 1000)} m`
          : `${item.distanceFromGuessKm.toFixed(1)} km`;
        const rank = Number.isFinite(item.globalPanoRank)
          ? `global pano match #${item.globalPanoRank}`
          : "outside the adaptive visual set";
        const label = `Best visual case near your guess · heading ${item.heading}°`;
        const detail = `${Number(item.viewSimilarity).toFixed(3)} view similarity · ${distance} from guess · ${rank}`;
        return `<button class="omt-board-match omt-board-guess" data-board-entry="${item.mapIndex}" data-board-kind="guess-local" data-board-pano="${esc(item.panoId)}" data-board-heading="${Number(item.heading) || 0}" data-board-inspect data-board-label="${esc(label)}" data-board-detail="${esc(detail)}" aria-label="${esc(label)}. ${esc(detail)}"><img data-src="${esc(item.view)}" ${contentAttributes} alt="Best visual match near your guess"><span>Near your guess · ${item.heading}°</span><em>${esc(detail)}</em></button>`;
      }
      const distance = item.distanceKm < 1
        ? `${Math.round(item.distanceKm * 1000)} m`
        : `${item.distanceKm.toFixed(1)} km`;
      const label = `Visual match #${item.rank} · heading ${item.heading}°${item.reciprocal ? " · mutual match" : ""}`;
      const detail = `${Number(item.viewSimilarity).toFixed(3)} view similarity · ${distance}`;
      return `<button class="omt-board-match" data-board-entry="${item.mapIndex}" data-board-pano="${esc(item.panoId)}" data-board-heading="${Number(item.heading) || 0}" data-board-inspect data-board-label="${esc(label)}" data-board-detail="${esc(detail)}" aria-label="${esc(label)}. ${esc(detail)}"><img data-src="${esc(item.view)}" ${contentAttributes} alt="Visual match ${item.rank}"><span>#${item.rank} · ${item.heading}°${item.reciprocal ? " · mutual" : ""}</span><em>${esc(detail)}</em></button>`;
    }).join("");
    const interpretation = literal
      ? "Eight closest views, without filtering for agreement."
      : mode.id === "alternate"
        ? "Another shared look among the nearest visual candidates."
        : "Most consistent shared look among the nearest visual candidates.";
    const element = document.createElement("div");
    element.className = "omt-visual-board";
    const guessReceipt = mode.guessMatch
      ? `<span><b>best of ${mode.guessMatch.candidatePool}</b> locations near your guess</span>`
      : "";
    element.innerHTML = `<header class="omt-board-head"><div><h2>Visual comparison</h2><p>${esc(interpretation)} Shift + hover to enlarge; click a match to open it.</p></div><nav class="omt-board-tabs">${tabs}</nav><button class="omt-board-close">Close <kbd>V</kbd></button></header><main class="omt-board-body"><div class="omt-board-grid"><div class="omt-board-current" tabindex="0" data-board-pano="${esc(board.panoId)}" data-board-heading="${Number(mode.currentHeading) || 0}" data-board-inspect data-board-label="This round · heading ${mode.currentHeading}°" data-board-detail="Current panorama direction used for this comparison"><img data-src="${esc(mode.currentView)}" data-board-content-mode="${esc(mode.id)}" data-board-content-digest="${esc(contentDigest)}" data-board-slot="0" alt="Current round heading ${mode.currentHeading}"><strong>This round · ${mode.currentHeading}°</strong></div>${matches}</div></main><footer class="omt-board-foot">${guessReceipt}<span><b>${literal ? "nearest visual views" : `${mode.support}/100`}</b> in this group</span><span><b>${mode.reciprocalSupport}</b> mutual matches</span><span><b>${mode.independentAreas}</b> separate areas</span><span><b>${Math.round(mode.coherence * 100)}%</b> visual agreement</span><span class="omt-board-warning">Visual similarity is evidence, not certainty.</span></footer>`;
    state.shadow.appendChild(element);
    element.querySelector(".omt-board-close").addEventListener("click", closeVisualBoard);
    for (const button of element.querySelectorAll("[data-board-mode]")) {
      button.addEventListener("click", () => {
        state.visualBoardMode = button.dataset.boardMode;
        renderVisualBoard();
      });
    }
    for (const button of element.querySelectorAll("[data-board-entry]")) {
      button.addEventListener("click", () => {
        const item = boardEntries.find((entry) => (
          entry.mapIndex === Number(button.dataset.boardEntry)
          && (entry.kind || "global") === (button.dataset.boardKind || "global")
        ));
        if (!item) return;
        openMatchInGoogleMaps({
          lat: item.latitude,
          lng: item.longitude,
          panoId: item.panoId,
        });
      });
    }
    let peekPanoramas = [];
    const hidePeek = () => {
      disposeNativePanoramas(peekPanoramas);
      element.querySelector(".omt-board-peek")?.remove();
    };
    const showPeek = (tile) => {
      hidePeek();
      const source = tile.querySelector("img");
      if (!source) return;
      const peek = document.createElement("div");
      peek.className = "omt-board-peek";
      peek.innerHTML = `<div class="omt-board-peek-media"><img alt="${esc(tile.dataset.boardLabel || "Enlarged comparison view")}"><div class="omt-native-pano" aria-label="High-resolution Street View"></div></div><div class="omt-board-peek-caption"><b>${esc(tile.dataset.boardLabel || "Comparison view")}</b><span>${esc(tile.dataset.boardDetail || "")}</span></div>`;
      element.appendChild(peek);
      const image = peek.querySelector("img");
      if (source.currentSrc || source.src) {
        image.src = source.currentSrc || source.src;
      } else if (source.dataset.src) {
        imageUrl(source.dataset.src).then((url) => {
          if (peek.isConnected) image.src = url;
        }).catch(() => hidePeek());
      }
      const panorama = nativeStreetView(
        peek.querySelector(".omt-native-pano"),
        tile.dataset.boardPano,
        Number(tile.dataset.boardHeading),
      );
      if (panorama) peekPanoramas.push(panorama);
    };
    let hoveredTile = null;
    const updatePeekForShift = (held) => {
      if (held && hoveredTile) showPeek(hoveredTile);
      else hidePeek();
    };
    state.visualBoardShiftUpdate = updatePeekForShift;
    for (const tile of element.querySelectorAll("[data-board-inspect]")) {
      tile.addEventListener("pointerenter", (event) => {
        hoveredTile = tile;
        if (state.shiftHeld || event.shiftKey) showPeek(tile);
      });
      tile.addEventListener("pointermove", (event) => {
        if (state.shiftHeld || event.shiftKey) {
          if (!element.querySelector(".omt-board-peek")) showPeek(tile);
        } else {
          hidePeek();
        }
      });
      tile.addEventListener("pointerleave", () => {
        if (hoveredTile === tile) hoveredTile = null;
        hidePeek();
      });
      tile.addEventListener("blur", hidePeek);
    }
    state.visualBoardModifierCleanup = () => {
      if (state.visualBoardShiftUpdate === updatePeekForShift) {
        state.visualBoardShiftUpdate = null;
      }
      hidePeek();
    };
    startVisualExposure(mode.id, boardContent);
    hydrateImages(element);
  }

  async function warmVisualBoard(board) {
    const mode = board.modes.find((item) => item.id === (board.defaultMode || "consensus"))
      || board.modes[0];
    const paths = [
      mode.currentView,
      ...(mode.guessMatch ? [mode.guessMatch.view] : []),
      ...mode.entries.map((item) => item.view),
    ];
    await Promise.all(paths.map(async (path) => {
      const src = await imageUrl(path);
      const image = new Image();
      image.src = src;
      try {
        await image.decode();
      } catch (_error) {
        // The displayed image still gets a normal load attempt if eager decode
        // is unsupported by a browser.
      }
    }));
  }

  function preloadVisualBoard(
    datasetKey,
    mapIndex,
    token = state.requestToken,
    playerGuess = state.playerGuess,
  ) {
    const guessKey = playerGuess
      ? `${playerGuess.lat.toFixed(6)},${playerGuess.lng.toFixed(6)}`
      : "no-guess";
    const key = `${datasetKey}:${mapIndex}:${guessKey}`;
    if (state.visualBoardKey === key && state.visualBoard) {
      return Promise.resolve(state.visualBoard);
    }
    if (state.visualBoardKey === key && state.visualBoardPromise) {
      return state.visualBoardPromise;
    }
    state.visualBoardKey = key;
    if (state.review?.universal && state.review.visualBoard) {
      state.visualBoard = state.review.visualBoard;
      state.visualBoardMode = state.visualBoard.defaultMode || "literal";
      state.visualBoardWarmPromise = warmVisualBoard(state.visualBoard).catch((error) => {
        console.warn("Meta Trainer: could not preload universal board images", error);
      });
      return Promise.resolve(state.visualBoard);
    }
    const query = new URLSearchParams();
    if (datasetKey) query.set("dataset", datasetKey);
    if (playerGuess) {
      query.set("guess_lat", playerGuess.lat);
      query.set("guess_lng", playerGuess.lng);
    }
    let pending;
    pending = request(`/api/visual-board/${mapIndex}?${query}`).then((board) => {
      if (token !== state.requestToken || state.visualBoardKey !== key) return null;
      state.visualBoard = board;
      state.visualBoardMode = board.defaultMode || "consensus";
      state.visualBoardWarmPromise = warmVisualBoard(board).catch((error) => {
        console.warn("Meta Trainer: could not preload visual-board images", error);
      });
      return board;
    }).finally(() => {
      if (state.visualBoardPromise === pending) state.visualBoardPromise = null;
    });
    state.visualBoardPromise = pending;
    return pending;
  }

  async function openVisualBoard() {
    if (!state.review || !state.shadow) return;
    state.visualBoardOpen = true;
    if (state.visualBoard?.mapIndex === state.review.location.mapIndex
        && state.visualBoard?.datasetKey === state.review.datasetKey) {
      renderVisualBoard();
      return;
    }
    state.shadow.querySelector(".omt-visual-board,.omt-board-loading")?.remove();
    const loading = document.createElement("div");
    loading.className = "omt-board-loading";
    loading.textContent = "Finding coherent visual interpretations…";
    state.shadow.appendChild(loading);
    try {
      const board = await preloadVisualBoard(
        state.review.datasetKey,
        state.review.location.mapIndex,
      );
      if (!board) return;
      if (!state.visualBoardOpen || !state.review
          || board.mapIndex !== state.review.location.mapIndex
          || board.datasetKey !== state.review.datasetKey) return;
      state.visualBoard = board;
      state.visualBoardMode = board.defaultMode || "consensus";
      renderVisualBoard();
    } catch (error) {
      loading.textContent = `Visual comparison unavailable: ${error.message}`;
      window.setTimeout(() => {
        closeVisualBoard();
      }, 2500);
    }
  }

  function positionMatchTooltip(tooltip, clientX, clientY) {
    state.matchTooltipClientX = clientX;
    state.matchTooltipClientY = clientY;
    if (tooltip.classList.contains("omt-match-tooltip-expanded")) return;
    const width = Math.min(600, window.innerWidth - 16);
    const estimatedHeight = 396;
    const left = Math.max(8, Math.min(clientX + 15, window.innerWidth - width - 8));
    const top = clientY + estimatedHeight + 18 < window.innerHeight
      ? clientY + 14
      : Math.max(8, clientY - estimatedHeight - 14);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideMatchTooltip() {
    clearTimeout(state.matchTooltipTimer);
    state.matchTooltipTimer = 0;
    state.matchTooltipToken += 1;
    state.hoveredMatchKey = null;
    disposeNativePanoramas(state.matchTooltipNative);
    state.matchTooltip?.remove();
    state.matchTooltip = null;
    state.matchTooltipPoint = null;
  }

  async function ensureMatchTooltipHighResolution(tooltip, point) {
    if (!tooltip?.isConnected || tooltip.dataset.nativeRequested === "true") return;
    tooltip.dataset.nativeRequested = "true";
    try {
      let row;
      if (point.current && point.panoId && Array.isArray(point.headings)) {
        row = { p: point.panoId, h: point.headings };
      } else {
        const datasetKey = point.datasetKey || state.review?.datasetKey;
        const map = await portableApi.loadMap(datasetKey);
        row = map.core.panoramas[Number(point.mapIndex)];
      }
      if (!row || !tooltip.isConnected || state.matchTooltip !== tooltip) return;
      const host = tooltip.querySelector(".omt-match-tooltip-images");
      if (!host) return;
      const grid = document.createElement("div");
      grid.className = "omt-match-tooltip-native";
      for (const heading of row.h.slice(0, 4)) {
        const cell = document.createElement("div");
        cell.className = "omt-native-pano";
        cell.setAttribute("aria-label", `High-resolution Street View heading ${heading}°`);
        grid.appendChild(cell);
        const panorama = nativeStreetView(cell, row.p, heading);
        if (panorama) state.matchTooltipNative.push(panorama);
      }
      host.appendChild(grid);
    } catch (_error) {
      // The ordinary thumbnail grid remains visible if native Street View is
      // unavailable for an unofficial panorama or transient Maps API state.
    }
  }

  function queueMatchTooltip(point, clientX, clientY, shiftKey = false) {
    // PointerEvent.shiftKey is not reliable on every Google Maps overlay.
    // Once keyboard keydown says Shift is held, preserve that state until the
    // document-level keyup instead of allowing pointerenter to clear it.
    state.matchTooltipShift = state.shiftHeld || Boolean(shiftKey);
    const key = point.current
      ? `current:${point.mapIndex}`
      : point.family
        ? `family:${point.mapIndex}`
        : `${point.comparisonSide || "round"}:${point.mapIndex}:${point.rank}`;
    if (state.hoveredMatchKey === key && state.matchTooltip?.isConnected) {
      positionMatchTooltip(state.matchTooltip, clientX, clientY);
      return;
    }
    hideMatchTooltip();
    state.hoveredMatchKey = key;
    state.matchTooltipTimer = window.setTimeout(() => {
      showMatchTooltip(point, clientX, clientY);
    }, 120);
  }

  async function showMatchTooltip(point, clientX, clientY) {
    const key = point.current
      ? `current:${point.mapIndex}`
      : point.family
        ? `family:${point.mapIndex}`
        : `${point.comparisonSide || "round"}:${point.mapIndex}:${point.rank}`;
    if (!state.shadow || state.hoveredMatchKey !== key) return;
    const token = ++state.matchTooltipToken;
    const tooltip = document.createElement("div");
    tooltip.className = "omt-match-tooltip";
    if (point.comparisonSide === "guess") tooltip.style.borderColor = state.guessDotColor;
    if (point.comparisonSide === "both") tooltip.style.borderColor = "#ffffff";
    tooltip.classList.toggle("omt-match-tooltip-expanded", state.matchTooltipShift);
    const distance = point.distanceKm < 1
      ? `${Math.round(point.distanceKm * 1000)} m away`
      : `${point.distanceKm.toFixed(1)} km away`;
    const visualHeading = point.comparisonSide === "both"
      ? `<b>Shared visual match</b><span>round #${point.roundRank} · similarity ${point.roundSimilarity.toFixed(3)}<br>guess #${point.guessRank} · similarity ${point.guessSimilarity.toFixed(3)}</span>`
      : point.comparisonSide === "guess"
        ? `<b style="color:${esc(state.guessDotColor)}">Guess-side visual match #${point.guessRank || point.rank}</b><span>${esc(distance)} from its anchor<br>similarity ${Number(point.guessSimilarity || point.similarity).toFixed(3)}</span>`
        : `<b style="color:${esc(state.neighborDotColor)}">Round visual match #${point.roundRank || point.rank}</b><span>${esc(distance)}<br>similarity ${Number(point.roundSimilarity || point.similarity).toFixed(3)} · click influence ${(Number(point.roundPosteriorWeight || point.posteriorWeight || 0) * 100).toFixed(1)}%</span>`;
    const heading = point.current
      ? `<b>This round</b><span>GeoGuessr's revealed location<br>four stored directions</span>`
      : point.family
        ? `<b>${esc(point.familyLabel || "Meta location")}</b><span>one of ${Number(point.familyMembers || 0).toLocaleString()} accepted locations<br>four stored directions</span>`
        : visualHeading;
    const footer = point.current
      ? "Hovering GeoGuessr's icon · hold Shift to enlarge · click to open this panorama ↗"
      : "Hold Shift to enlarge · click the dot to open this panorama in Google Maps ↗";
    tooltip.innerHTML = `<div class="omt-match-tooltip-head">${heading}</div><div class="omt-match-tooltip-images"><div class="omt-match-tooltip-loading">Loading four directions…</div></div><div class="omt-match-tooltip-foot">${footer}</div>`;
    positionMatchTooltip(tooltip, clientX, clientY);
    state.shadow.appendChild(tooltip);
    state.matchTooltip = tooltip;
    state.matchTooltipPoint = point;
    if (state.matchTooltipShift) ensureMatchTooltipHighResolution(tooltip, point);
    try {
      const urls = point.current && Array.isArray(point.viewUrls)
        ? point.viewUrls
        : await Promise.all([0, 1, 2, 3].map((slot) =>
          imageUrl(`/api/view/${point.mapIndex}/${slot}${viewSuffix(point)}`)
        ));
      if (token !== state.matchTooltipToken || !tooltip.isConnected) return;
      const imageLabel = point.current
        ? "This round"
        : point.family
          ? (point.familyLabel || "Meta location")
          : `${point.comparisonSide === "both" ? "Shared" : point.comparisonSide === "guess" ? "Guess-side" : "Round"} visual match ${point.rank}`;
      tooltip.querySelector(".omt-match-tooltip-images").innerHTML = urls.map((url, slot) => `<img src="${esc(url)}" alt="${esc(imageLabel)}, direction ${slot + 1}">`).join("");
    } catch (_error) {
      if (token === state.matchTooltipToken && tooltip.isConnected) {
        tooltip.querySelector(".omt-match-tooltip-loading").textContent = "Preview unavailable";
      }
    }
  }

  function openMatchInGoogleMaps(point) {
    const params = new URLSearchParams({
      api: "1",
      map_action: "pano",
      viewpoint: `${point.lat},${point.lng}`,
    });
    if (point.panoId) params.set("pano", point.panoId);
    const url = `https://www.google.com/maps/@?${params}`;
    if (typeof GM_openInTab === "function") {
      GM_openInTab(url, { active: true, insert: true, setParent: true });
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  function handleMatchTooltipModifier(event) {
    if (event.key !== "Shift") return;
    const held = event.type === "keydown";
    state.shiftHeld = held;
    state.matchTooltipShift = held;
    state.visualBoardShiftUpdate?.(held);
    const tooltip = state.matchTooltip;
    if (!tooltip?.isConnected) return;
    tooltip.classList.toggle("omt-match-tooltip-expanded", state.matchTooltipShift);
    if (held && state.matchTooltipPoint) {
      ensureMatchTooltipHighResolution(tooltip, state.matchTooltipPoint);
    }
    if (!state.matchTooltipShift) {
      positionMatchTooltip(
        tooltip,
        state.matchTooltipClientX,
        state.matchTooltipClientY,
      );
    }
  }

  function releaseShiftModifier() {
    if (!state.shiftHeld && !state.matchTooltipShift) return;
    state.shiftHeld = false;
    state.matchTooltipShift = false;
    state.visualBoardShiftUpdate?.(false);
    const tooltip = state.matchTooltip;
    if (tooltip?.isConnected) {
      tooltip.classList.remove("omt-match-tooltip-expanded");
      positionMatchTooltip(
        tooltip,
        state.matchTooltipClientX,
        state.matchTooltipClientY,
      );
    }
  }

  async function hydrateImages(scope = state.shadow) {
    const images = [...scope.querySelectorAll("img[data-src]")];
    await Promise.all(images.map(async (image) => {
      const path = image.dataset.src;
      const contentMode = image.dataset.boardContentMode;
      const contentDigest = image.dataset.boardContentDigest;
      const contentSlot = Number(image.dataset.boardSlot);
      image.removeAttribute("data-src");
      try {
        image.src = await imageUrl(path);
        if (typeof image.decode === "function") await image.decode();
        if (contentMode && Number.isInteger(contentSlot)) {
          markBoardContentStatus(
            contentMode,
            contentDigest,
            contentSlot,
            image.isConnected ? "rendered" : "removedBeforeLoad",
          );
        }
      } catch (_error) {
        image.alt = `${image.alt} (image unavailable)`;
        if (contentMode && Number.isInteger(contentSlot)) {
          markBoardContentStatus(
            contentMode,
            contentDigest,
            contentSlot,
            "failedToLoad",
          );
        }
      }
    }));
  }

  async function openLightbox(path, label) {
    const box = document.createElement("div");
    box.className = "omt-lightbox";
    box.innerHTML = `<button>Close ×</button><div class="omt-spinner">Loading full-size image…</div>`;
    state.shadow.appendChild(box);
    const close = () => box.remove();
    box.addEventListener("click", close);
    box.querySelector("button").addEventListener("click", close);
    try {
      const img = document.createElement("img");
      img.alt = label;
      img.src = await imageUrl(path);
      img.addEventListener("click", (event) => event.stopPropagation());
      box.querySelector(".omt-spinner").replaceWith(img);
    } catch (_error) {
      box.querySelector(".omt-spinner").textContent = "Image unavailable.";
    }
  }

  async function openDrawer() {
    const shouldFit = state.overlays.length === 0;
    state.drawerOpen = true;
    render();
    try {
      await loadActiveDetail();
      render();
      showMetaOnMap(shouldFit);
    } catch (error) {
      console.error("Meta Trainer: could not load distribution", error);
    }
  }

  function closeDrawer() {
    state.drawerOpen = false;
    render();
  }

  async function selectMeta(index) {
    if (!state.review || index < 0 || index >= state.review.metas.length) return;
    clearOverlays();
    state.active = index;
    render();
    try {
      await loadActiveDetail();
      showMetaOnMap(false);
    } catch (error) {
      console.error("Meta Trainer: could not load distribution", error);
    }
  }

  async function loadActiveDetail() {
    const meta = state.review?.metas?.[state.active];
    if (!meta || state.detail.has(meta.id)) return;
    const detail = await request(`/api/meta/${encodeURIComponent(meta.id)}${datasetSuffix()}`);
    state.detail.set(meta.id, detail);
  }

  async function addMoreMeta() {
    const preview = state.review?.moreMetas?.shift();
    if (!preview) return;
    try {
      const detail = await request(`/api/meta/${encodeURIComponent(preview.id)}${datasetSuffix()}`);
      const meta = { ...detail, ...preview, click: detail.click, idealAverageScore: detail.idealAverageScore, uplift: detail.uplift };
      state.review.metas.push(meta);
      state.detail.set(meta.id, detail);
      await selectMeta(state.review.metas.length - 1);
    } catch (error) {
      state.review.moreMetas.unshift(preview);
      console.error("Meta Trainer: could not load additional clue", error);
    }
  }

  async function saveFeedback(action) {
    const meta = state.review.metas[state.active];
    state.feedback[meta.id] = action;
    localStorage.setItem("omt-feedback-v1", JSON.stringify(state.feedback));
    render();
    try {
      await request("/api/feedback", {
        method: "POST",
        body: {
          candidateId: meta.id,
          action,
          panoId: state.review.location.panoId,
          mapIndex: state.review.location.mapIndex,
          datasetKey: state.review.datasetKey,
          round: state.round,
        },
      });
    } catch (_error) {
      // Local storage remains authoritative if a passive history write fails.
    }
  }

  function mapCandidates() {
    return Array.from(state.maps).filter((map) => {
      try {
        const div = map.getDiv?.();
        const rect = div?.getBoundingClientRect();
        return div?.isConnected && rect && rect.width > 250 && rect.height > 180;
      } catch (_error) {
        return false;
      }
    });
  }

  function resultMap() {
    const candidates = mapCandidates();
    return candidates.sort((a, b) => {
      const ar = a.getDiv().getBoundingClientRect();
      const br = b.getDiv().getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    })[0] || null;
  }

  function clearOverlays() {
    for (const overlay of state.overlays) {
      try { overlay.setMap(null); } catch (_error) {}
    }
    state.overlays = [];
  }

  function distributionOverlay(maps, map, coordinates, options = {}) {
    if (!maps.OverlayView) return null;
    const mercatorY = (latitude) => {
      const sine = Math.sin(latitude * Math.PI / 180);
      return 0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI);
    };
    class CanvasPointOverlay extends maps.OverlayView {
      constructor() {
        super();
        this.mode = options.mode || "distribution";
        this.current = options.current || null;
        this.points = coordinates.map((value) => {
          if (Array.isArray(value)) {
            return { lat: value[0], lng: value[1], y: mercatorY(value[0]), strength: 1 };
          }
          return {
            lat: value.latitude,
            lng: value.longitude,
            y: mercatorY(value.latitude),
            strength: Number(value.relativeStrength || 0),
            rank: Number(value.rank || 0),
            mapIndex: Number(value.mapIndex),
            panoId: value.panoId || "",
            similarity: Number(value.similarity || 0),
            posteriorWeight: Number(value.posteriorWeight || 0),
            geographicGroup: Number(value.geographicGroup || 0),
            distanceKm: Number(value.distanceKm || 0),
            // Bind map-index ownership when the overlay is created. Fast dots
            // can be hovered before the full review has populated state.review.
            datasetKey: value.datasetKey || options.datasetKey || "",
            comparisonSide: value.comparisonSide || options.comparisonSide || "round",
            core: value.core === true,
            roundRank: Number(value.roundRank || 0),
            guessRank: Number(value.guessRank || 0),
            roundSimilarity: Number(value.roundSimilarity || 0),
            guessSimilarity: Number(value.guessSimilarity || 0),
            roundDistanceKm: Number(value.roundDistanceKm || 0),
            guessDistanceKm: Number(value.guessDistanceKm || 0),
            roundStrength: Number(value.roundStrength || 0),
            guessStrength: Number(value.guessStrength || 0),
            roundPosteriorWeight: Number(value.roundPosteriorWeight || 0),
            family: this.mode === "family",
            familyLabel: options.familyLabel || "",
            familyMembers: Number(options.familyMembers || coordinates.length),
          };
        });
        this.canvas = null;
        this.frame = 0;
        this.hitLayer = null;
        this.neighborHitPool = [];
        this.familyHitPool = [];
        this.currentHitButton = null;
        this.setMap(map);
      }
      onAdd() {
        this.canvas = document.createElement("canvas");
        this.canvas.style.position = "absolute";
        this.canvas.style.pointerEvents = "none";
        this.canvas.style.zIndex = "10";
        this.canvas.dataset.omtPointCount = String(this.points.length);
        this.canvas.setAttribute("aria-hidden", "true");
        const pane = this.getPanes().overlayMouseTarget || this.getPanes().overlayLayer;
        pane.appendChild(this.canvas);
        if (this.mode === "neighbors") {
          this.hitLayer = document.createElement("div");
          this.hitLayer.style.position = "absolute";
          this.hitLayer.style.zIndex = "11";
          this.hitLayer.style.pointerEvents = "none";
          const interactivePoints = Math.min(1_000, this.points.length);
          for (let index = 0; index < interactivePoints; index += 1) {
            const button = document.createElement("button");
            button.type = "button";
            button.style.position = "absolute";
            button.style.display = "none";
            button.style.padding = "0";
            button.style.border = "0";
            button.style.borderRadius = "50%";
            button.style.background = "transparent";
            button.style.cursor = "pointer";
            button.style.pointerEvents = "auto";
            button.addEventListener("pointerenter", (event) => {
              if (button.omtPoint) queueMatchTooltip(button.omtPoint, event.clientX, event.clientY, event.shiftKey);
            });
            button.addEventListener("pointermove", (event) => {
              if (button.omtPoint) queueMatchTooltip(button.omtPoint, event.clientX, event.clientY, event.shiftKey);
            });
            button.addEventListener("pointerleave", hideMatchTooltip);
            button.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (button.omtPoint) openMatchInGoogleMaps(button.omtPoint);
            });
            this.neighborHitPool.push(button);
            this.hitLayer.appendChild(button);
          }
          if (this.current) {
            const point = { ...this.current, current: true, rank: 0, distanceKm: 0, similarity: 1 };
            const button = document.createElement("button");
            button.type = "button";
            button.title = "This round — hover to preview; click to open Street View";
            button.setAttribute("aria-label", button.title);
            button.style.position = "absolute";
            button.style.display = "none";
            button.style.padding = "0";
            button.style.border = "0";
            button.style.borderRadius = "50%";
            button.style.background = "transparent";
            button.style.cursor = "pointer";
            button.style.pointerEvents = "auto";
            button.addEventListener("pointerenter", (event) => queueMatchTooltip(point, event.clientX, event.clientY, event.shiftKey));
            button.addEventListener("pointermove", (event) => queueMatchTooltip(point, event.clientX, event.clientY, event.shiftKey));
            button.addEventListener("pointerleave", hideMatchTooltip);
            button.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              openMatchInGoogleMaps(point);
            });
            this.currentHitButton = button;
            this.hitLayer.appendChild(button);
          }
          pane.appendChild(this.hitLayer);
        }
        if (this.mode === "family") {
          this.hitLayer = document.createElement("div");
          this.hitLayer.style.position = "absolute";
          this.hitLayer.style.zIndex = "11";
          this.hitLayer.style.pointerEvents = "none";
          // The distribution remains a single canvas. Reuse a bounded set of
          // invisible buttons for visible locations so even very broad metas
          // do not create thousands of permanent DOM nodes.
          // This fully covers the normal discovered-family range (typically a
          // few hundred to roughly one thousand members). Exceptional map-wide
          // families are sampled only while zoomed all the way out.
          for (let index = 0; index < 1200; index += 1) {
            const button = document.createElement("button");
            button.type = "button";
            button.style.position = "absolute";
            button.style.display = "none";
            button.style.padding = "0";
            button.style.border = "0";
            button.style.borderRadius = "50%";
            button.style.background = "transparent";
            button.style.cursor = "pointer";
            button.style.pointerEvents = "auto";
            button.addEventListener("pointerenter", (event) => {
              if (button.omtPoint) queueMatchTooltip(button.omtPoint, event.clientX, event.clientY, event.shiftKey);
            });
            button.addEventListener("pointermove", (event) => {
              if (button.omtPoint) queueMatchTooltip(button.omtPoint, event.clientX, event.clientY, event.shiftKey);
            });
            button.addEventListener("pointerleave", hideMatchTooltip);
            button.addEventListener("click", (event) => {
              if (!button.omtPoint) return;
              event.preventDefault();
              event.stopPropagation();
              openMatchInGoogleMaps(button.omtPoint);
            });
            this.familyHitPool.push(button);
            this.hitLayer.appendChild(button);
          }
          pane.appendChild(this.hitLayer);
        }
      }
      draw() {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => this.paint());
      }
      paint() {
        if (!this.canvas || !this.getMap()) return;
        const started = performance.now();
        const projection = this.getProjection();
        const center = this.getMap().getCenter?.();
        const mapDiv = this.getMap().getDiv?.();
        if (!projection || !center || !mapDiv) return;
        const centerPixel = projection.fromLatLngToDivPixel(center);
        const width = Math.max(1, Math.ceil(mapDiv.clientWidth));
        const height = Math.max(1, Math.ceil(mapDiv.clientHeight));
        const left = centerPixel.x - width / 2;
        const top = centerPixel.y - height / 2;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        this.canvas.style.left = `${left}px`;
        this.canvas.style.top = `${top}px`;
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
        if (this.hitLayer) {
          this.hitLayer.style.left = `${left}px`;
          this.hitLayer.style.top = `${top}px`;
          this.hitLayer.style.width = `${width}px`;
          this.hitLayer.style.height = `${height}px`;
          for (const button of this.neighborHitPool) {
            button.style.display = "none";
            button.omtPoint = null;
          }
          for (const button of this.familyHitPool) {
            button.style.display = "none";
            button.omtPoint = null;
          }
          if (this.currentHitButton) this.currentHitButton.style.display = "none";
        }
        if (this.canvas.width !== Math.ceil(width * ratio) || this.canvas.height !== Math.ceil(height * ratio)) {
          this.canvas.width = Math.ceil(width * ratio);
          this.canvas.height = Math.ceil(height * ratio);
        }
        const context = this.canvas.getContext("2d");
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, width, height);
        const zoom = this.getMap().getZoom?.() ?? 10;
        const worldWidth = 256 * (2 ** zoom);
        const centerY = mercatorY(center.lat());
        const viewportPoint = (point) => {
          // Use the nearest wrapped copy of a longitude to the map center.
          // This remains valid when bounds cross the antimeridian or the
          // viewport is wide enough to include the full world.
          const longitudeDelta = ((point.lng - center.lng() + 540) % 360) - 180;
          return {
            x: width / 2 + longitudeDelta / 360 * worldWidth,
            y: height / 2 + (point.y - centerY) * worldWidth,
          };
        };
        const baseRadius = this.points.length <= 100 ? 5.2
          : this.points.length <= 500 ? 4.3
          : this.points.length <= 2_500 ? 3.3
          : this.points.length <= 10_000 ? 2.5
          : 1.8;
        const radius = Math.max(1.6, Math.min(6.4, baseRadius + (zoom - 10) * 0.18));
        let visible = 0;
        if (this.mode === "neighbors") {
          const rankedPoints = [...this.points].sort((a, b) => (b.rank || 0) - (a.rank || 0));
          const visibleHitTargets = [];
          const neighborBaseRadius = Math.max(2.7, Math.min(
            4.2,
            (this.points.length <= 100 ? 3.8 : this.points.length <= 300 ? 3.5 : 3.1)
              + (zoom - 8) * 0.07,
          ));
          for (const point of rankedPoints) {
            const pixel = viewportPoint(point);
            if (pixel.x < -18 || pixel.x > width + 18 || pixel.y < -18 || pixel.y > height + 18) continue;
            visible += 1;
            const { x, y } = pixel;
            const strength = Math.max(0, Math.min(1, point.strength));
            // One size for every dot. Core and tail are told apart by opacity
            // and outline only: the core is solid and outlined, the tail
            // translucent, so the cloud keeps a single visual scale and the
            // shape comes from where the solid dots sit.
            const pointRadius = neighborBaseRadius * (0.88 + strength * 0.20);
            context.globalAlpha = point.core ? 1 : 0.45;
            if (point.comparisonSide === "both") {
              // One split marker communicates overlap without stacking rings or
              // privileging whichever layer happened to paint last.
              context.beginPath();
              context.arc(x, y, pointRadius, 0, Math.PI * 2);
              context.fillStyle = state.neighborDotColor;
              context.fill();
              context.beginPath();
              context.moveTo(x, y - pointRadius);
              context.arc(x, y, pointRadius, -Math.PI / 2, Math.PI / 2);
              context.closePath();
              context.fillStyle = state.guessDotColor;
              context.fill();
            } else {
              context.beginPath();
              context.arc(x, y, pointRadius, 0, Math.PI * 2);
              context.fillStyle = point.comparisonSide === "guess"
                ? state.guessDotColor
                : state.neighborDotColor;
              context.fill();
            }
            context.beginPath();
            context.arc(x, y, pointRadius, 0, Math.PI * 2);
            context.strokeStyle = point.core
              ? "rgba(255,255,255,0.9)"
              : "rgba(255,255,255,0.22)";
            context.lineWidth = point.core ? 1.2 : 0.6;
            context.stroke();
            context.globalAlpha = 1;
            const hitRadius = Math.max(9, pointRadius + 4);
            visibleHitTargets.push({ point, x, y, hitRadius });
          }
          visibleHitTargets.sort((left, right) => left.point.rank - right.point.rank);
          for (let index = 0; index < this.neighborHitPool.length; index += 1) {
            const button = this.neighborHitPool[index];
            const target = visibleHitTargets[index];
            if (!target) {
              button.style.display = "none";
              button.omtPoint = null;
              continue;
            }
            button.omtPoint = target.point;
            const side = target.point.comparisonSide === "both"
              ? "Shared round/guess"
              : target.point.comparisonSide === "guess" ? "Guess-side" : "Round";
            button.title = `${side} visual match — preview; click to open Street View`;
            button.setAttribute("aria-label", button.title);
            button.style.display = "block";
            button.style.left = `${target.x - target.hitRadius}px`;
            button.style.top = `${target.y - target.hitRadius}px`;
            button.style.width = `${target.hitRadius * 2}px`;
            button.style.height = `${target.hitRadius * 2}px`;
          }
          if (this.current) {
            const pixel = viewportPoint({
              lng: this.current.longitude,
              y: mercatorY(this.current.latitude),
            });
            const { x, y } = pixel;
            if (this.currentHitButton) {
              const hitRadius = 18;
              this.currentHitButton.style.display = "block";
              this.currentHitButton.style.left = `${x - hitRadius}px`;
              this.currentHitButton.style.top = `${y - hitRadius}px`;
              this.currentHitButton.style.width = `${hitRadius * 2}px`;
              this.currentHitButton.style.height = `${hitRadius * 2}px`;
            }
          }
        } else {
          const visibleFamilyPoints = [];
          context.beginPath();
          for (const point of this.points) {
            const pixel = viewportPoint(point);
            if (pixel.x < -radius || pixel.x > width + radius || pixel.y < -radius || pixel.y > height + radius) continue;
            visible += 1;
            const { x, y } = pixel;
            if (this.mode === "family") visibleFamilyPoints.push({ point, x, y });
            context.moveTo(x + radius, y);
            context.arc(x, y, radius, 0, Math.PI * 2);
          }
          context.fillStyle = this.points.length <= 2_500
            ? "rgba(40, 127, 136, 0.92)"
            : "rgba(55, 101, 106, 0.76)";
          context.fill();
          context.strokeStyle = this.points.length <= 2_500
            ? "rgba(255, 255, 255, 0.96)"
            : "rgba(255, 255, 255, 0.68)";
          context.lineWidth = this.points.length <= 500 ? 1.8 : 1.0;
          context.stroke();
          if (this.mode === "family" && this.familyHitPool.length && visibleFamilyPoints.length) {
            const count = Math.min(this.familyHitPool.length, visibleFamilyPoints.length);
            const step = visibleFamilyPoints.length / count;
            const hitRadius = Math.max(8, radius + 4);
            for (let index = 0; index < count; index += 1) {
              const visiblePoint = visibleFamilyPoints[Math.floor(index * step)];
              const button = this.familyHitPool[index];
              button.omtPoint = visiblePoint.point;
              button.title = `${visiblePoint.point.familyLabel || "Meta location"} — preview; click to open Street View`;
              button.setAttribute("aria-label", button.title);
              button.style.display = "block";
              button.style.left = `${visiblePoint.x - hitRadius}px`;
              button.style.top = `${visiblePoint.y - hitRadius}px`;
              button.style.width = `${hitRadius * 2}px`;
              button.style.height = `${hitRadius * 2}px`;
            }
          }
        }
        this.canvas.dataset.omtVisiblePoints = String(visible);
        this.canvas.dataset.omtPaintMs = (performance.now() - started).toFixed(1);
      }
      onRemove() {
        cancelAnimationFrame(this.frame);
        if (this.mode === "neighbors" || this.mode === "family") {
          hideMatchTooltip();
        }
        this.hitLayer?.remove();
        this.hitLayer = null;
        this.neighborHitPool = [];
        this.familyHitPool = [];
        this.currentHitButton = null;
        this.canvas?.remove();
        this.canvas = null;
      }
    }
    return new CanvasPointOverlay();
  }

  function makePinDataUrl(stroke, centerFill) {
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 52;
    const context = canvas.getContext("2d");
    context.scale(1.25, 1.25);
    context.lineJoin = "round";
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(16, 2.2);
    context.bezierCurveTo(8.2, 2.2, 3.2, 7.5, 3.2, 14.2);
    context.bezierCurveTo(3.2, 22.2, 10.4, 29.1, 16, 39.3);
    context.bezierCurveTo(21.6, 29.1, 28.8, 22.2, 28.8, 14.2);
    context.bezierCurveTo(28.8, 7.5, 23.8, 2.2, 16, 2.2);
    context.closePath();
    context.fillStyle = "#ffffff";
    context.fill();
    context.lineWidth = 2.4;
    context.strokeStyle = stroke;
    context.stroke();
    context.beginPath();
    context.arc(16, 14.2, 4.4, 0, Math.PI * 2);
    context.fillStyle = centerFill;
    context.fill();
    return canvas.toDataURL("image/png");
  }

  function makeDiamondDataUrl(fill) {
    const canvas = document.createElement("canvas");
    canvas.width = 56;
    canvas.height = 56;
    const context = canvas.getContext("2d");
    context.beginPath();
    context.moveTo(28, 5);
    context.lineTo(51, 28);
    context.lineTo(28, 51);
    context.lineTo(5, 28);
    context.closePath();
    context.fillStyle = fill;
    context.fill();
    context.strokeStyle = "#15191c";
    context.lineWidth = 8;
    context.stroke();
    context.strokeStyle = "#ffffff";
    context.lineWidth = 4;
    context.stroke();
    context.beginPath();
    context.arc(28, 28, 5, 0, Math.PI * 2);
    context.fillStyle = "#15191c";
    context.fill();
    return canvas.toDataURL("image/png");
  }

  function pinIcons(maps) {
    if (state.pinIcons) return state.pinIcons;
    const icon = (url) => ({
      url,
      size: new maps.Size(40, 52),
      scaledSize: new maps.Size(25, 33),
      anchor: new maps.Point(12.5, 32.5),
    });
    state.pinIcons = {
      ideal: icon(makePinDataUrl("#15191c", "#15191c")),
      neighborsIdeal: {
        url: makeDiamondDataUrl(state.neighborClickColor),
        size: new maps.Size(56, 56),
        scaledSize: new maps.Size(44, 44),
        anchor: new maps.Point(22, 22),
      },
    };
    return state.pinIcons;
  }

  function saveMapView(map) {
    if (state.originalMapView) return;
    const center = map.getCenter?.();
    state.originalMapView = center ? { lat: center.lat(), lng: center.lng(), zoom: map.getZoom?.() } : null;
  }

  function restoreMapView() {
    const map = resultMap();
    if (map && state.originalMapView) {
      map.setCenter({ lat: state.originalMapView.lat, lng: state.originalMapView.lng });
      if (state.originalMapView.zoom != null) map.setZoom(state.originalMapView.zoom);
    }
    state.originalMapView = null;
  }

  function showMetaOnMap(fit) {
    const map = resultMap();
    const context = state.review || state.fastNeighborhood;
    const meta = state.review?.metas?.[state.active];
    const detail = meta && state.detail.get(meta.id);
    const maps = pageWindow.google?.maps;
    // Neighbor dots do not depend on the heavier meta-detail request. In Both
    // mode, paint those immediately and add the meta layer when it is ready.
    if (!map || !context || !maps) return;
    clearOverlays();
    saveMapView(map);
    const bounds = new maps.LatLngBounds();
    const icons = pinIcons(maps);
    if (state.showBestMeta && detail) {
      const distribution = distributionOverlay(maps, map, detail.distribution, {
        mode: "family",
        datasetKey: context.datasetKey,
        familyLabel: familyDisplayTitle(meta),
        familyMembers: detail.distribution.length,
      });
      if (distribution) state.overlays.push(distribution);
      for (const point of detail.distribution) {
        const lat = Array.isArray(point) ? point[0] : point.latitude;
        const lng = Array.isArray(point) ? point[1] : point.longitude;
        bounds.extend({ lat, lng });
      }
    }
    const visualMatches = context.visualNeighborhood?.visualMatches || [];
    const guessComparison = state.showVisualNeighbors && state.showGuessNeighbors
      ? state.guessNeighborhood
      : null;
    const guessMatches = guessComparison?.visualNeighborhood?.visualMatches || [];
    if (state.showVisualNeighbors && visualMatches.length) {
      const combined = new Map();
      const coreCount = Number(context.visualNeighborhood?.coreCount)
        || Math.min(50, visualMatches.length);
      for (const match of visualMatches) {
        combined.set(match.mapIndex, {
          ...match,
          core: Number(match.rank) <= coreCount,
          comparisonSide: "round",
          roundRank: match.rank,
          roundSimilarity: match.similarity,
          roundDistanceKm: match.distanceKm,
          roundStrength: match.relativeStrength,
          roundPosteriorWeight: match.posteriorWeight,
        });
      }
      for (const match of guessMatches) {
        const existing = combined.get(match.mapIndex);
        if (existing) {
          Object.assign(existing, {
            comparisonSide: "both",
            guessRank: match.rank,
            guessSimilarity: match.similarity,
            guessDistanceKm: match.distanceKm,
            guessStrength: match.relativeStrength,
            relativeStrength: Math.max(existing.relativeStrength, match.relativeStrength),
            rank: Math.min(existing.rank, match.rank),
          });
        } else {
          combined.set(match.mapIndex, {
            ...match,
            comparisonSide: "guess",
            guessRank: match.rank,
            guessSimilarity: match.similarity,
            guessDistanceKm: match.distanceKm,
            guessStrength: match.relativeStrength,
          });
        }
      }
      const combinedMatches = [...combined.values()];
      const neighbors = distributionOverlay(maps, map, combinedMatches, {
        mode: "neighbors",
        datasetKey: context.datasetKey,
        current: {
          mapIndex: context.location.mapIndex,
          panoId: context.location.panoId,
          latitude: context.location.latitude,
          longitude: context.location.longitude,
          lat: context.location.latitude,
          lng: context.location.longitude,
          datasetKey: context.datasetKey,
          headings: context.location.headings,
          viewUrls: context.location.views,
        },
      });
      if (neighbors) state.overlays.push(neighbors);
      for (const neighbor of combinedMatches) {
        bounds.extend({ lat: neighbor.latitude, lng: neighbor.longitude });
      }
    }
    const expected = state.showBestMeta ? detail?.click?.s?.expected : null;
    if (expected && maps.Marker) {
      const marker = new maps.Marker({
        map,
        position: { lat: expected.a, lng: expected.o },
        icon: icons.ideal,
        title: `Ideal average-score click: ${expected.n || "map coordinate"}`,
        // Recommendation pins are labels, not interaction targets. Let pointer
        // events fall through to an overlapping panorama preview button.
        clickable: false,
        zIndex: 1000,
      });
      state.overlays.push(marker);
      bounds.extend({ lat: expected.a, lng: expected.o });
    }
    const neighborClick = state.showVisualNeighbors
      ? context.visualNeighborhood?.weightedClick
      : null;
    if (neighborClick && maps.Marker) {
      const marker = new maps.Marker({
        map,
        position: { lat: neighborClick.latitude, lng: neighborClick.longitude },
        icon: icons.neighborsIdeal,
        title: `${context.cloud ? "Exact C-RADIO" : "Adaptive visual"} click${Number.isFinite(neighborClick.expectedScore) ? ` · ${Math.round(neighborClick.expectedScore).toLocaleString()} expected points` : ""}`,
        // Keep every visual-match dot hoverable when the recommendation lands on it.
        clickable: false,
        zIndex: 1001,
      });
      state.overlays.push(marker);
      bounds.extend({ lat: neighborClick.latitude, lng: neighborClick.longitude });
    }
    bounds.extend({ lat: context.location.latitude, lng: context.location.longitude });
    if (fit && !bounds.isEmpty()) {
      const drawerWidth = state.shadow?.querySelector(".omt-drawer")?.getBoundingClientRect().width || 0;
      const padding = window.innerWidth > 850
        ? { top: 55, right: Math.ceil(drawerWidth + 45), bottom: 105, left: 55 }
        : 55;
      map.fitBounds(bounds, padding);
    }
  }

  function setupMapCapture() {
    const timer = setInterval(() => {
      const MVCObject = pageWindow.google?.maps?.MVCObject;
      if (!MVCObject) return;
      clearInterval(timer);
      if (pageWindow.__OMT_MAP_INTERCEPTED) return;
      pageWindow.__OMT_MAP_INTERCEPTED = true;
      const originalSet = MVCObject.prototype.set;
      MVCObject.prototype.set = function (key, value) {
        const result = originalSet.apply(this, [key, value]);
        if (!this.__OMT_TRACKED && typeof this.setZoom === "function" && typeof this.getBounds === "function" && typeof this.getDiv === "function") {
          this.__OMT_TRACKED = true;
          state.maps.add(this);
          this.addListener?.("idle", () => {
            if (state.drawerOpen && state.overlays.length === 0) showMetaOnMap(false);
          });
        }
        return result;
      };
    }, 10);
  }

  function clearRound() {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = 0;
    flushVisualExposure("next-round");
    state.requestToken += 1;
    state.review = null;
    state.fastNeighborhood = null;
    state.guessNeighborhood = null;
    state.active = 0;
    state.detail.clear();
    state.drawerOpen = false;
    state.visualBoard = null;
    state.visualBoardKey = null;
    state.visualBoardPromise = null;
    state.visualBoardWarmPromise = null;
    state.visualBoardMode = "consensus";
    state.visualBoardOpen = false;
    state.visualBoardModifierCleanup?.();
    state.visualBoardModifierCleanup = null;
    state.round = null;
    state.playerGuess = null;
    state.roundIdentity = null;
    clearOverlays();
    restoreMapView();
    releaseImages();
    state.root?.remove();
    state.root = null;
    state.shadow = null;
  }

  async function applyStoredMapMode(token) {
    // The neighborhood response already contains everything needed to paint
    // similarity evidence; there is no family-detail request in this build.
    if (state.showVisualNeighbors) showMetaOnMap(false);
    // GeoGuessr may emit round_end just before its result map finishes mounting.
    // Retry briefly so the persisted mode appears without opening the drawer.
    for (let attempt = 0; attempt < 24 && token === state.requestToken; attempt += 1) {
      showMetaOnMap(false);
      if (state.overlays.length) {
        render();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
  }

  function buildRoundIdentity(eventState, round, review) {
    const explicitGameId = [
      round.gameId,
      eventState?.current_game_id,
      eventState?.currentGameId,
      eventState?.token,
    ].find((value) => value != null && String(value).length);
    const gameId = String(explicitGameId || location.pathname || "unavailable");
    const keySource = explicitGameId ? "game-id-round-pano" : "route-round-pano";
    const guessKey = state.playerGuess
      ? `${state.playerGuess.lat.toFixed(6)},${state.playerGuess.lng.toFixed(6)}`
      : "guess-unavailable";
    const eventKey = String(round.eventKey || [
      "round-v2",
      gameId,
      state.round,
      review.location.panoId,
      guessKey,
    ].join(":"));
    return {
      eventKey,
      keySource: round.eventKey ? "live-challenge-round-key" : keySource,
      gameId,
      installId: INSTALL_ID,
      tabId: TAB_ID,
      learnerSequence: nextLearnerSequence(),
      datasetKey: review.datasetKey,
      round: state.round,
      panoId: review.location.panoId,
      resultObservedAtMs: Date.now(),
    };
  }

  async function recordRoundOutcome(round, review) {
    const identity = state.roundIdentity;
    if (!identity) return;
    const { eventKey } = identity;
    if (state.loggedRoundEvents.has(eventKey)) return;
    const score = Number(round.score?.amount);
    const distanceMeters = Number(round.distance?.meters?.amount);
    const timeSeconds = Number(round.time);
    await request("/api/round-event", {
      method: "POST",
      body: {
        ...identity,
        mapIndex: review.location.mapIndex,
        playerGuess: state.playerGuess
          ? { latitude: state.playerGuess.lat, longitude: state.playerGuess.lng }
          : null,
        score: Number.isFinite(score) ? score : null,
        distanceMeters: Number.isFinite(distanceMeters) ? distanceMeters : null,
        timeSeconds: Number.isFinite(timeSeconds) ? timeSeconds : null,
        source: LIVE_CHALLENGE_PATH.test(location.pathname) || PARTY_LOBBY_PATH.test(location.pathname)
          ? "live-challenge"
          : "standard-round",
        userscriptVersion: USERSCRIPT_VERSION,
      },
    });
    state.loggedRoundEvents.add(eventKey);
    if (state.loggedRoundEvents.size > 500) {
      const oldest = state.loggedRoundEvents.values().next().value;
      state.loggedRoundEvents.delete(oldest);
    }
  }

  async function loadNeighborRecommendation(token) {
    const review = state.review;
    if (!review?.visualNeighborhood || review.visualNeighborhood.weightedClick) return;
    try {
      const neighborhood = await request(
        `/api/neighborhood/${review.location.mapIndex}${datasetSuffix(review)}`
      );
      if (token !== state.requestToken || state.review !== review) return;
      review.visualNeighborhood = neighborhood;
      render();
      if (state.showVisualNeighbors) showMetaOnMap(false);
    } catch (error) {
      console.error("Meta Trainer: could not load neighbor recommendation", error);
    }
  }

  async function loadGuessNeighborhood(token) {
    const review = state.review;
    const guess = state.playerGuess;
    if (!state.showGuessNeighbors || !review || !guess) return;
    if (review.universal) {
      // Corpus path: no dataset to query, so the pack answers directly.
      try {
        const comparison = await cradioClient.guessNeighborhood(
          guess,
          { sourceMapKey: review.sourceMapKey },
          review.visualNeighborhood?.visualMatches || [],
        );
        if (token !== state.requestToken || state.review !== review
            || !state.showGuessNeighbors) return;
        if (!comparison) return;
        state.guessNeighborhood = comparison;
        render();
        showMetaOnMap(false);
      } catch (error) {
        console.error("Meta Trainer: could not load guess-side cloud", error);
      }
      return;
    }
    try {
      const query = new URLSearchParams({
        dataset: review.datasetKey,
        guess_lat: guess.lat,
        guess_lng: guess.lng,
      });
      const comparison = await request(
        `/api/guess-neighborhood/${review.location.mapIndex}?${query}`,
      );
      if (token !== state.requestToken || state.review !== review
          || !state.showGuessNeighbors) return;
      state.guessNeighborhood = comparison;
      render();
      showMetaOnMap(false);
    } catch (error) {
      console.error("Meta Trainer: could not load guess-side visual neighborhood", error);
    }
  }

  async function applyFastNeighborhood(token) {
    for (let attempt = 0; attempt < 24 && token === state.requestToken; attempt += 1) {
      if (!state.showVisualNeighbors || (!state.fastNeighborhood && !state.review)) return;
      showMetaOnMap(false);
      if (state.overlays.length) return;
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
  }

  function pathnameFromUrl(value) {
    return liveChallengeAdapter.pathnameFromUrl(value);
  }

  function liveChallengeIdFromUrl(value) {
    return liveChallengeAdapter.challengeIdFromUrl(value);
  }

  function liveChallengeIdForPage(trackedChallenge) {
    return liveChallengeAdapter.challengeIdForPage(
      location.pathname,
      performance.getEntriesByType("resource").map((entry) => entry.name),
      trackedChallenge,
    );
  }

  async function liveChallengeProfileId() {
    if (state.liveChallengeProfileId) return state.liveChallengeProfileId;
    if (state.liveChallengeProfilePromise) return state.liveChallengeProfilePromise;
    state.liveChallengeProfilePromise = pageWindow.fetch(
      "https://www.geoguessr.com/api/v3/profiles",
      { method: "GET", credentials: "include" }
    ).then(async (response) => {
      if (!response.ok) return null;
      const profile = await response.json();
      state.liveChallengeProfileId = liveChallengeAdapter.profileId(profile);
      return state.liveChallengeProfileId;
    }).catch(() => null).finally(() => {
      state.liveChallengeProfilePromise = null;
    });
    return state.liveChallengeProfilePromise;
  }

  function normalizedLiveChallengeRound(data, challengeId, profileId = null) {
    return liveChallengeAdapter.normalizeRound(data, challengeId, profileId);
  }

  async function fetchLiveChallengeRound(challengeId) {
    const dataPromise = pageWindow.fetch(
      `https://game-server.geoguessr.com/api/live-challenge/${encodeURIComponent(challengeId)}`,
      { method: "GET", credentials: "include" }
    ).then(async (response) => {
      if (!response.ok) throw new Error(`Live Challenge returned ${response.status}`);
      return response.json();
    });
    const [data, profileId] = await Promise.all([
      dataPromise,
      liveChallengeProfileId(),
    ]);
    return normalizedLiveChallengeRound(data, challengeId, profileId);
  }

  async function prewarmLiveChallengeRound(challengeId) {
    try {
      const response = await pageWindow.fetch(
        `https://game-server.geoguessr.com/api/live-challenge/${encodeURIComponent(challengeId)}`,
        { method: "GET", credentials: "include" },
      );
      if (!response.ok) return;
      const liveRound = normalizedLiveChallengeRound(
        await response.json(), challengeId, null,
      );
      if (!liveRound?.location?.panoId) return;
      prefetchModalForMap(liveRound.location.panoId, {
        latitude: liveRound.location.lat,
        longitude: liveRound.location.lng,
        sourceMapKey: liveRound.mapId,
        datasetKey: "balanced-world-50k",
      });
      if (!liveRound.mapId) return;
      const key = `live:${liveRound.roundKey}:${liveRound.location.panoId || "coordinate"}`;
      if (prewarmedRoundKeys.has(key)) return;
      prewarmedRoundKeys.add(key);
      if (prewarmedRoundKeys.size > 30) {
        prewarmedRoundKeys.delete(prewarmedRoundKeys.values().next().value);
      }
      warmMapForRound({ mapId: liveRound.mapId });
      const params = new URLSearchParams({ map_key: liveRound.mapId });
      if (liveRound.location.panoId) params.set("pano_id", liveRound.location.panoId);
      if (Number.isFinite(liveRound.location.lat)) params.set("lat", liveRound.location.lat);
      if (Number.isFinite(liveRound.location.lng)) params.set("lng", liveRound.location.lng);
      // Preindexed maps use their precomputed row. On any other map, privately
      // compute and cache the universal query now so the Live Challenge result
      // screen does not pay browser-inference latency.
      try {
        await portableApi.prewarmMap(liveRound.mapId);
      } catch (_error) {
        if (liveRound.location.panoId && !cradioClient.configured()) {
          await portableApi.precomputeUniversalRound(liveRound.location.panoId);
        }
        return;
      }
      const review = await request(`/api/neighborhood?${params}`);
      if (!review?.matched) return;
      const dataset = encodeURIComponent(review.datasetKey);
      const mapIndex = review.location.mapIndex;
      const [, board] = await Promise.all([
        request(`/api/neighborhood/${mapIndex}?dataset=${dataset}`),
        request(`/api/visual-board/${mapIndex}?dataset=${dataset}`),
      ]);
      await warmVisualBoard(board);
    } catch (_error) {
      // This path is cache-only. The post-round request remains authoritative.
    }
  }

  function liveChallengeResultMounted() {
    return liveChallengeAdapter.resultMounted(document);
  }

  function initializeLiveChallengeAdapter() {
    let trackedChallenge = null;
    let checkQueued = false;
    let lookupInFlight = false;
    let prewarmRequestedForActiveRound = false;

    const trackResource = (url) => {
      if (!PARTY_LOBBY_PATH.test(location.pathname)) return;
      const id = liveChallengeIdFromUrl(url);
      if (id) trackedChallenge = { id, partyLobbyPath: location.pathname };
    };

    for (const entry of performance.getEntriesByType("resource")) trackResource(entry.name);
    if (typeof PerformanceObserver !== "undefined") {
      const resourceObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) trackResource(entry.name);
      });
      resourceObserver.observe({ entryTypes: ["resource"] });
    }

    const checkResult = async () => {
      checkQueued = false;
      const challengeId = liveChallengeIdForPage(trackedChallenge);
      const mounted = Boolean(challengeId) && liveChallengeResultMounted();
      if (!mounted) {
        if (state.liveChallengeResultVisible) clearRound();
        state.liveChallengeResultVisible = false;
        state.liveChallengePendingKey = "";
        if (challengeId && !prewarmRequestedForActiveRound) {
          prewarmRequestedForActiveRound = true;
          prewarmLiveChallengeRound(challengeId);
          // Party state can advance a moment after the result view disappears.
          window.setTimeout(() => prewarmLiveChallengeRound(challengeId), 500);
        }
        return;
      }
      prewarmRequestedForActiveRound = false;
      state.liveChallengeResultVisible = true;
      if (lookupInFlight) return;
      lookupInFlight = true;
      try {
        const liveRound = await fetchLiveChallengeRound(challengeId);
        if (!liveRound) return;
        if (
          liveRound.roundKey === state.liveChallengeLastRoundKey
          || liveRound.roundKey === state.liveChallengePendingKey
        ) return;
        state.liveChallengePendingKey = liveRound.roundKey;
        await handleRoundEnd(liveChallengeAdapter.buildEventState(liveRound, challengeId));
        state.liveChallengeLastRoundKey = liveRound.roundKey;
      } catch (error) {
        console.error("Meta Trainer: Live Challenge round lookup failed", error);
        window.setTimeout(queueCheck, 650);
      } finally {
        lookupInFlight = false;
        state.liveChallengePendingKey = "";
      }
    };

    const queueCheck = () => {
      if (checkQueued) return;
      checkQueued = true;
      window.setTimeout(checkResult, 40);
    };
    const observer = new MutationObserver(queueCheck);
    const begin = () => {
      observer.observe(document.body, { childList: true, subtree: true });
      queueCheck();
    };
    if (document.body) begin();
    else document.addEventListener("DOMContentLoaded", begin, { once: true });
    window.addEventListener("popstate", queueCheck);
    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      const result = originalPushState.apply(this, args);
      queueCheck();
      return result;
    };
    const originalReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const result = originalReplaceState.apply(this, args);
      queueCheck();
      return result;
    };
  }

  async function handleRoundEnd(eventState) {
    clearTimeout(state.offlineRetryTimer);
    clearTimeout(state.pendingTimer);
    const token = ++state.requestToken;
    const rounds = eventState?.rounds || [];
    const round = rounds[rounds.length - 1];
    if (!round?.location) return;
    state.round = rounds.length;
    const rawGuess = round.player_guess || round.playerGuess || round.guess;
    const guessLat = Number(rawGuess?.lat ?? rawGuess?.latitude);
    const guessLng = Number(rawGuess?.lng ?? rawGuess?.longitude);
    state.playerGuess = Number.isFinite(guessLat) && Number.isFinite(guessLng)
      ? { lat: guessLat, lng: guessLng }
      : null;
    const params = new URLSearchParams();
    const datasetKey = [
      round.datasetKey,
      round.mapKey,
      round.mapId,
      round.map?.id,
      eventState?.datasetKey,
      eventState?.mapKey,
      eventState?.mapId,
      eventState?.map?.id,
    ].find((value) => typeof value === "string" && value.length);
    const cloudPanoId = decodedPanoId(round.location.panoId);
    if (cloudPanoId) params.set("pano_id", cloudPanoId);
    if (Number.isFinite(round.location.lat)) params.set("lat", round.location.lat);
    if (Number.isFinite(round.location.lng)) params.set("lng", round.location.lng);
    if (datasetKey) params.set("map_key", datasetKey);
    const roundScore = Number(round.score?.amount);
    const roundDistanceM = Number(round.distance?.meters?.amount);
    if (Number.isFinite(roundScore)) params.set("round_score", roundScore);
    if (Number.isFinite(roundDistanceM)) params.set("round_distance_m", roundDistanceM);
    const cloudConfigured = cradioClient.configured();
    const inferredDiagonalKm = Number.isFinite(roundScore) && roundScore > 0 && roundScore < 5000
        && Number.isFinite(roundDistanceM) && roundDistanceM > 0
      ? -10 * (roundDistanceM / 1000) / Math.log(roundScore / 5000)
      : null;
    const knownMap = datasetKey
      ? await portableApi.isKnownMap(datasetKey).catch(() => false)
      : false;
    const useCloudReview = cloudConfigured && Boolean(cloudPanoId) && !knownMap;
    const cloudRequest = useCloudReview
      ? prefetchModalRound(cloudPanoId, {
        latitude: round.location.lat,
        longitude: round.location.lng,
        sourceMapKey: datasetKey,
        datasetKey: "balanced-world-50k",
        mapDiagonalKm: inferredDiagonalKm,
      })
      : Promise.resolve({ ok: false, reason: knownMap ? "known-map" : "missing-pano" });
    // A configured Modal request is single-shot: the endpoint's uncached-call
    // guard makes automatic retries unsafe. Known portable maps retain their
    // fast local path, while arbitrary maps use exact cloud results.
    const reviewRequest = useCloudReview
      ? cloudRequest.then((result) => {
        if (!result?.ok || !result.response) {
          const why = [result?.reason, result?.status].filter(Boolean).join(" ");
          throw new Error(why ? `C-RADIO similarity unavailable (${why})` : "C-RADIO similarity unavailable");
        }
        return result.response;
      })
      : criticalRequest(`/api/neighborhood?${params}`);
    state.pendingTimer = window.setTimeout(() => {
      if (token === state.requestToken && !state.review) {
        renderPending(useCloudReview
          ? "C-RADIO similarity warming…"
          : "Analyzing visual similarity…");
      }
    }, 250);
    try {
      const review = await reviewRequest;
      clearTimeout(state.pendingTimer);
      state.pendingTimer = 0;
      if (token !== state.requestToken) return;
      if (!review.matched) {
        renderOffline("This round did not expose a Street View panorama");
        return;
      }
      state.review = review;
      state.roundIdentity = buildRoundIdentity(eventState, round, review);
      state.fastNeighborhood = null;
      clearTimeout(state.offlineRetryTimer);
      state.drawerOpen = false;
      render();
      if (state.showGuessNeighbors) loadGuessNeighborhood(token);
      recordRoundOutcome(round, review).catch(() => {
        // Passive local history must never affect the post-round interface.
      });
      // Start the expensive view-level grouping and decode the default nine
      // images while the player is still reading the ordinary round result.
      // Pressing V later therefore reveals prepared content instead of
      // initiating work on the interaction path.
      preloadVisualBoard(review.datasetKey, review.location.mapIndex, token).catch((error) => {
        console.warn("Meta Trainer: visual-board preload failed", error);
      });
      applyStoredMapMode(token);
      loadNeighborRecommendation(token);
    } catch (error) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = 0;
      if (token === state.requestToken) {
        // The cloud branch discarded error.message and rendered a fixed string,
        // so the reason added upstream never reached the screen.
        console.warn("Meta Trainer: cloud review failed", error);
        renderOffline(
          useCloudReview
            ? (error && error.message ? error.message : "C-RADIO similarity unavailable")
            : error.message,
        );
        if (!useCloudReview) {
          state.offlineRetryTimer = setTimeout(() => {
            if (token === state.requestToken) handleRoundEnd(eventState);
          }, 650);
        }
      }
    }
  }

  function prefetchModalFromEventState(eventState) {
    const rounds = Array.isArray(eventState?.rounds) ? eventState.rounds : [];
    const roundNumber = Number(eventState?.round || eventState?.currentRound || rounds.length);
    const round = rounds[roundNumber - 1] || eventState?.location || eventState?.roundData;
    const panoId = decodedPanoId(round?.panoId ?? round?.panoid ?? round?.location?.panoId);
    if (!panoId) return;
    const latitude = Number(round?.lat ?? round?.latitude ?? round?.location?.lat);
    const longitude = Number(round?.lng ?? round?.longitude ?? round?.location?.lng);
    const datasetKey = [
      eventState?.map,
      eventState?.mapId,
      eventState?.datasetKey,
      typeof eventState?.map === "object" ? eventState.map.id : null,
    ].find((value) => typeof value === "string" && value.length);
    prefetchModalForMap(panoId, {
      latitude,
      longitude,
      sourceMapKey: datasetKey,
      datasetKey: "balanced-world-50k",
    });
  }

  async function initializeEvents() {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const framework = pageWindow.GeoGuessrEventFramework;
      if (framework) {
        await framework.init();
        framework.events.addEventListener("round_start", (event) => {
          clearRound();
          warmMapForRound(event.detail);
          prefetchModalFromEventState(event.detail);
        });
        framework.events.addEventListener("round_end", (event) => handleRoundEnd(event.detail));
        pageWindow.GEFFetchEvents?.addEventListener("received_data", (event) => {
          prewarmRawRound(event.detail);
        });
        if (framework.state?.round_in_progress) {
          warmMapForRound(framework.state);
          prefetchModalFromEventState(framework.state);
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    console.error("Meta Trainer: GeoGuessr Event Framework did not initialize");
  }

  setupMapCapture();
  document.addEventListener("keydown", handleLayerHotkeys, true);
  document.addEventListener("keydown", handleMatchTooltipModifier, true);
  document.addEventListener("keyup", handleMatchTooltipModifier, true);
  window.addEventListener("blur", releaseShiftModifier, true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") releaseShiftModifier();
  }, true);
  document.addEventListener("visibilitychange", updateVisualExposureFocus, true);
  window.addEventListener("focus", updateVisualExposureFocus, true);
  window.addEventListener("blur", updateVisualExposureFocus, true);
  window.addEventListener("pagehide", () => {
    flushVisualExposure("pagehide");
  }, true);
  flushPendingVisualExposure();
  initializeLiveChallengeAdapter();
  initializeEvents();
})();
