// ==UserScript==
// @name         GeoGuessr Meta Trainer
// @namespace    sightline-orlando-meta
// @version      2.2.0-beta.87
// @description  Post-round visual similarity for any Street View map, from a precomputed 2-million-panorama corpus.
// @homepageURL  https://github.com/ObsidianArmor1/geoguessr-meta-trainer
// @supportURL   https://github.com/ObsidianArmor1/geoguessr-meta-trainer/issues
// @match        https://www.geoguessr.com/*
// @require      https://raw.githubusercontent.com/miraclewhips/geoguessr-event-framework/5e449d6b64c828fce5d2915772d61c7f95263e34/geoguessr-event-framework.js
// @require      https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/main/src/portable-api.js
// @require      https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/main/src/live-challenge-adapter.js?v=2.2.0-beta.87
// @require      https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/main/src/lodestar-pack-v2.js?v=2.2.0-beta.87
// @require      https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/main/src/lodestar-pack.js?v=2.2.0-beta.87
// @require      https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/main/src/cradio-client.js?v=2.2.0-beta.87
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @connect      huggingface.co
// @connect      hf.co
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
  const USERSCRIPT_VERSION = "2.2.0-beta.87";
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
  const LIVE_GUESS_SESSION_KEY = "omt-live-challenge-guess-v1";
  const LIVE_GUESS_MAX_AGE_MS = 6 * 60 * 60 * 1000;
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
    // Bands default to 40% of full strength. At 100% the overlay is three
    // filled levels per cloud plus 300 dots, which reads as overwhelming on a
    // detailed basemap; 40% keeps the shape legible and lets the map through.
    bandIntensity: 0.4,
    // How many of the ranked matches are drawn. The static pack stores 300 per
    // panorama, which is the ceiling without rebuilding it - so this is a slice
    // of a row already in hand, and changing it costs no fetch and no refetch.
    matchCount: 300,
    // Dots and clouds are separate layers: either can be turned off, so the map
    // can show individual matches, the shape of the distribution, or both.
    showDots: true,
    // 2, 3 and 4 draw square boards containing the round plus 3, 8 or 15
    // comparison views respectively.
    boardGrid: 3,
    // Each board tile as the road-aligned view only, or as all four directions
    // the corpus was embedded from.
    boardAllDirections: false,
    // The same choice for the preview that appears when hovering a dot...
    dotPreviewAllDirections: true,
    // ...and independently for what shift enlarges it to, so a compact hover
    // can open into the whole panorama.
    dotShiftAllDirections: true,
  };
  const MATCH_COUNT_MIN = 20;
  const MATCH_COUNT_MAX = 300;
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
    GM_registerMenuCommand("Copy trainer diagnostics", copyTrainerDiagnostics);
    GM_registerMenuCommand("Retry current trainer round", retryCurrentRound);
    GM_registerMenuCommand("Set matches shown per round", () => {
      const answer = window.prompt(
        `How many of the ranked matches to draw (${MATCH_COUNT_MIN}-${MATCH_COUNT_MAX})?`,
        String(state.matchCount),
      );
      if (answer !== null) setMatchCount(answer);
    });
  }
  const { LIVE_CHALLENGE_PATH, PARTY_LOBBY_PATH } = liveChallengeAdapter;
  const prewarmedRoundKeys = new Set();
  const modalRoundPromises = new Map();
  const pageWindow = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
  // Keep an unwrapped fetch for the trainer's own polling. The request observer
  // below deliberately queues checks after GeoGuessr's traffic; routing our own
  // poll through it would make every poll immediately schedule another poll.
  const pageFetch = pageWindow.fetch?.bind(pageWindow);
  const mapLayerPreferences = readMapLayerPreferences();
  const mapColorPreferences = readMapColorPreferences();
  const state = {
    review: null,
    reviewRoundKey: "",
    fastNeighborhood: null,
    guessNeighborhood: null,
    guessNeighborhoodRoundKey: "",
    guessNeighborhoodPromise: null,
    guessNeighborhoodPromiseKey: "",
    active: 0,
    detail: new Map(),
    drawerOpen: false,
    feedback: readFeedback(),
    round: null,
    playerGuess: null,
    pendingPlayerGuess: null,
    liveChallengeChallengeId: null,
    liveChallengeAnnouncedRound: null,
    requestToken: 0,
    root: null,
    shadow: null,
    imageUrls: new Map(),
    imagePromises: new Map(),
    maps: new Set(),
    overlays: [],
    overlayRoundKey: "",
    overlayMap: null,
    originalMapView: null,
    pinIcons: null,
    // Clustering-family review is preserved at the family-meta-trainer-v1 Git
    // tag. The active trainer is deliberately similarity-only.
    showBestMeta: false,
    showVisualNeighbors: mapLayerPreferences.showVisualNeighbors,
    showGuessNeighbors: mapLayerPreferences.showGuessNeighbors,
    neighborDotColor: mapColorPreferences.neighborDots,
    // How strongly the similarity-mass bands are painted, 0 turns them off and
    // leaves the dots alone. Three filled bands per cloud, two clouds and 300
    // dots is a lot of ink at full strength, and how much is too much depends
    // on the map underneath and the player.
    bandIntensity: mapColorPreferences.bandIntensity,
    matchCount: mapColorPreferences.matchCount,
    showDots: mapColorPreferences.showDots,
    boardGrid: mapColorPreferences.boardGrid,
    boardAllDirections: mapColorPreferences.boardAllDirections,
    dotPreviewAllDirections: mapColorPreferences.dotPreviewAllDirections,
    dotShiftAllDirections: mapColorPreferences.dotShiftAllDirections,
    settingsOpen: false,
    neighborClickColor: mapColorPreferences.neighborClick,
    guessDotColor: mapColorPreferences.guessDots,
    matchTooltip: null,
    matchTooltipPoint: null,
    matchTooltipNative: [],
    boardWarmTimer: 0,
    boardPrewarmTimer: 0,
    dockColorsOpen: false,
    guessPrefetchKey: "",
    guessPrefetchTimer: 0,
    guessPrefetchPromise: null,
    matchTooltipTimer: 0,
    matchTooltipToken: 0,
    hoveredMatchKey: null,
    matchTooltipShift: false,
    shiftHeld: false,
    visualBoardShiftUpdate: null,
    matchTooltipClientX: 0,
    matchTooltipClientY: 0,
    visualBoard: null,
    visualBoardRoundKey: "",
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
    roundRequestKey: "",
    roundRequestQuality: -1,
    liveChallengeProfileId: null,
    liveChallengeProfilePromise: null,
    loggedRoundEvents: new Set(),
    roundIdentity: null,
    visualExposure: null,
    finalizedExposureKeys: new Set(),
    lastRoundEventState: null,
    diagnostics: {
      bootedAt: Date.now(),
      phase: "booting",
      eventFramework: "waiting",
      eventSource: null,
      lastError: null,
      errors: [],
      round: null,
      retrieval: null,
      guessLookup: null,
      boardImagery: null,
      rendering: null,
      updatedAt: Date.now(),
    },
  };

  function diagnosticError(error, phase = state.diagnostics.phase) {
    const message = String(error?.message || error || "unknown error").slice(0, 300);
    state.diagnostics.lastError = { phase, message, at: new Date().toISOString() };
    state.diagnostics.errors.push(state.diagnostics.lastError);
    if (state.diagnostics.errors.length > 8) state.diagnostics.errors.shift();
    state.diagnostics.updatedAt = Date.now();
  }

  function diagnosticPhase(phase, values = {}) {
    state.diagnostics.phase = phase;
    Object.assign(state.diagnostics, values, { updatedAt: Date.now() });
  }

  function trainerDiagnostics() {
    const pack = pageWindow.LodestarPackV2 || window.LodestarPackV2;
    const eligibleMaps = typeof mapCandidates === "function" ? mapCandidates().length : 0;
    const capabilities = {
      gmXmlHttpRequest: typeof GM_xmlhttpRequest === "function",
      indexedDB: typeof indexedDB !== "undefined",
      decompressionStream: typeof DecompressionStream === "function",
      googleMaps: Boolean(pageWindow.google?.maps),
      eventFramework: Boolean(pageWindow.GeoGuessrEventFramework),
      performanceObserver: typeof PerformanceObserver === "function",
      canvas2d: (() => {
        try { return Boolean(document.createElement("canvas").getContext("2d")); }
        catch (_error) { return false; }
      })(),
    };
    return {
      report: "GeoGuessr Meta Trainer diagnostics",
      generatedAt: new Date().toISOString(),
      userscriptVersion: USERSCRIPT_VERSION,
      route: `${location.origin}${location.pathname}`,
      browser: navigator.userAgent,
      capabilities,
      runtime: {
        ...state.diagnostics,
        errors: [...state.diagnostics.errors],
        rootMounted: Boolean(state.root?.isConnected),
        trackedMaps: state.maps.size,
        eligibleMaps,
        overlays: state.overlays.length,
        ownership: {
          request: state.roundRequestKey || null,
          review: state.reviewRoundKey || null,
          reviewPanoId: state.review?.location?.panoId || null,
          guess: state.guessNeighborhoodRoundKey || null,
          board: state.visualBoardRoundKey || null,
          boardPanoId: state.visualBoard?.panoId || null,
          overlays: state.overlayRoundKey || null,
          overlaysOnCurrentMap: Boolean(state.overlayMap && state.overlayMap === resultMap()),
        },
        nativeStreetViewPool: {
          renderers: nativePanoCache.size,
          limit: NATIVE_PANO_POOL_LIMIT,
        },
      },
      cloud: cradioClient.diagnostics?.() || {
        configured: cradioClient.configured(),
      },
      packV2: pack?.diagnostics?.() || {
        loaded: Boolean(pack),
        diagnosticsUnavailable: true,
      },
    };
  }

  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_error) {
      try {
        const field = document.createElement("textarea");
        field.value = text;
        field.style.cssText = "position:fixed;left:-9999px;top:0";
        document.documentElement.appendChild(field);
        field.select();
        const copied = document.execCommand("copy");
        field.remove();
        return copied;
      } catch (_fallbackError) {
        return false;
      }
    }
  }

  async function copyTrainerDiagnostics() {
    const text = JSON.stringify(trainerDiagnostics(), null, 2);
    const copied = await writeClipboard(text);
    if (copied) window.alert("Trainer diagnostics copied. No credential or install ID is included.");
    else window.prompt("Copy these trainer diagnostics:", text);
  }

  function retryCurrentRound() {
    if (state.review) {
      clearOverlays();
      diagnosticPhase("retrying-render");
      applyStoredMapMode(state.requestToken);
      return;
    }
    const eventState = state.lastRoundEventState;
    const panoId = state.diagnostics.round?.panoId;
    if (!eventState) {
      window.alert("There is no completed round to retry yet.");
      return;
    }
    if (panoId) {
      cradioClient.forget?.(panoId);
      modalRoundPromises.delete(String(panoId));
    }
    diagnosticPhase("manual-retry", { lastError: null });
    handleRoundEnd(eventState);
  }

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

  function normalizeBoardGrid(value) {
    const number = Number(value);
    return number === 2 || number === 3 || number === 4 ? number : 3;
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
        bandIntensity: normalizeIntensity(stored?.bandIntensity, DEFAULT_MAP_COLORS.bandIntensity),
        matchCount: normalizeMatchCount(stored?.matchCount, DEFAULT_MAP_COLORS.matchCount),
        showDots: stored?.showDots !== false,
        boardGrid: normalizeBoardGrid(stored?.boardGrid),
        boardAllDirections: stored?.boardAllDirections === true,
        dotPreviewAllDirections: stored?.dotPreviewAllDirections !== false,
        dotShiftAllDirections: stored?.dotShiftAllDirections !== false,
      };
    } catch (_error) {
      return { ...DEFAULT_MAP_COLORS };
    }
  }

  // `Number(null)` and `Number("")` are 0, which is finite - so an absent or
  // blank stored value would read as a real zero and clamp to the minimum
  // rather than falling back. For the band intensity that meant a stored null
  // silently turning the clouds off.
  function numberOr(value, fallback) {
    if (value === null || value === undefined || value === "") return fallback;
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeMatchCount(value, fallback) {
    const number = numberOr(value, NaN);
    return Number.isFinite(number)
      ? Math.max(MATCH_COUNT_MIN, Math.min(MATCH_COUNT_MAX, Math.round(number)))
      : fallback;
  }

  function normalizeIntensity(value, fallback) {
    const number = numberOr(value, NaN);
    return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
  }

  function saveMapColorPreferences() {
    localStorage.setItem(MAP_COLOR_STORAGE_KEY, JSON.stringify({
      neighborDots: state.neighborDotColor,
      neighborClick: state.neighborClickColor,
      guessDots: state.guessDotColor,
      bandIntensity: state.bandIntensity,
      matchCount: state.matchCount,
      showDots: state.showDots,
      boardGrid: state.boardGrid,
      boardAllDirections: state.boardAllDirections,
      dotPreviewAllDirections: state.dotPreviewAllDirections,
      dotShiftAllDirections: state.dotShiftAllDirections,
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
    // The legend follows the layers, each independently
    const guess = state.showGuessNeighbors ? state.guessNeighborhood : null;
    const overlap = guess?.overlap;
    const round = state.showVisualNeighbors && neighborhood?.visualMatches?.length
      ? `<i class="omt-legend-match omt-legend-round-match"></i> closest matches <i class="omt-legend-match omt-legend-tail-match"></i> wider distribution <i class="omt-legend-pin omt-legend-pin-neighbors"></i> suggested click`
      : "";
    const guessKeys = guess
      ? `<i class="omt-legend-match omt-legend-guess-match"></i> guess matches <i class="omt-legend-match omt-legend-shared-match"></i> shared${overlap ? ` (${overlap.sharedLocations})` : ""}`
      : "";
    // No key for the round marker: that is GeoGuessr's own icon, which the
    // player already knows. A legend earns its space by naming what this
    // script added.
    if (!round && !guessKeys) return "";
    return `<div class="omt-legend">${round}${guessKeys}</div>`;
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
    // Legacy map-specific packs can still be warmed while a round is active.
    // Unknown maps use Lodestar/Modal through prefetchModalForMap instead;
    // browser inference was removed after retrieval-quality validation failed.
    portableApi.prewarmMap(datasetKey).catch(() => {
      // An unknown map has no legacy pack to warm. Its pano prefetch is already
      // running independently and will use static Lodestar first, Modal second.
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

  function reviewRequestKey(roundNumber, locationValue) {
    const panoId = decodedPanoId(locationValue?.panoId ?? locationValue?.panoid);
    if (panoId) return `${roundNumber}:${panoId}`;
    const latitude = Number(locationValue?.lat ?? locationValue?.latitude);
    const longitude = Number(locationValue?.lng ?? locationValue?.longitude);
    return `${roundNumber}:${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  }

  function ownsRoundRequest(token, requestKey) {
    return token === state.requestToken && requestKey === state.roundRequestKey;
  }

  function reviewMatchesRequest(requestKey, panoId = "") {
    return liveChallengeAdapter.reviewMatchesRequest(
      state.review,
      state.reviewRoundKey,
      requestKey,
      panoId,
    );
  }

  function clearCompletedReviewForActiveRound(roundNumber, locationValue) {
    if (!state.review || !state.reviewRoundKey) return;
    if (reviewRequestKey(roundNumber, locationValue) !== state.reviewRoundKey) clearRound();
  }

  function prefetchModalRound(panoId, context = {}) {
    // The static pack needs no credential, so gating this on a configured Modal
    // token skipped the round-start prefetch entirely for anyone playing off
    // the pack - the whole cloud was then fetched at round end instead.
    const packAvailable = Boolean(pageWindow.LodestarPack || window.LodestarPack);
    if (!panoId || (!cradioClient.configured() && !packAvailable)) {
      return Promise.resolve({ ok: false, reason: "not-configured" });
    }
    const id = String(panoId);
    if (modalRoundPromises.has(id)) return modalRoundPromises.get(id);
    const pending = cradioClient.prefetch(id, context)
      .catch(() => ({ ok: false, reason: "network-error" }));
    modalRoundPromises.set(id, pending);
    if (modalRoundPromises.size > 128) {
      modalRoundPromises.delete(modalRoundPromises.keys().next().value);
    }
    return pending;
  }

  async function prefetchModalForMap(panoId, context = {}) {
    const packAvailable = Boolean(pageWindow.LodestarPack || window.LodestarPack);
    if (!panoId || (!cradioClient.configured() && !packAvailable)) {
      return { ok: false, reason: "not-configured" };
    }
    // The global static table is map-independent. Do not suppress it merely
    // because this map also has a legacy map-specific pack.
    if (packAvailable) return prefetchModalRound(panoId, context);
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
    clearCompletedReviewForActiveRound(roundNumber, location);
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
      // Unknown maps have no legacy row. Lodestar/Modal prefetch above is the
      // only current arbitrary-map retrieval path.
      warmMapForRound({ mapId: datasetKey });
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

  // The same viewing direction the corpus was embedded with: fov 90, pitch 0,
  // and offsets from the panorama's own spawn heading. The 448x256 default is
  // the embedding input; display surfaces may request the same view at a size
  // and aspect ratio better suited to their box.
  function corpusViewUrl(panoId, heading, width = 448, height = 256, view = {}) {
    const query = new URLSearchParams({
      cb_client: "apiv3",
      w: String(width),
      h: String(height),
      pitch: String(Number(view.pitch) || 0),
      thumbfov: String(Number(view.fov) || 90),
      panoid: String(panoId),
      yaw: String(((Number(heading) || 0) % 360 + 360) % 360),
    });
    return `https://streetviewpixels-pa.googleapis.com/v1/thumbnail?${query}`;
  }

  // Refit a Street View thumbnail to the box it will be drawn in.
  //
  // Google's endpoint honors the requested aspect ratio but caps the returned
  // image near 280px tall. Use the full 640px request budget on the box's long
  // edge and derive the other edge from the same aspect ratio. Independently
  // clamping both dimensions can turn a wide V-board cell into a near-square
  // response, while retaining 448x256 makes a large cell visibly soft.
  // Heading, pitch and horizontal FOV remain unchanged; only display geometry
  // changes. Similarity is still computed from the fixed corpus embedding.
  function fitViewToBox(url, boxWidth, boxHeight) {
    if (!/^https:\/\/streetviewpixels-pa\.googleapis\.com\//.test(url)) return url;
    if (!(boxWidth > 0) || !(boxHeight > 0)) return url;
    const aspect = boxWidth / boxHeight;
    const width = aspect >= 1 ? 640 : Math.max(1, Math.round(640 * aspect));
    const height = aspect >= 1 ? Math.max(1, Math.round(640 / aspect)) : 640;
    try {
      const next = new URL(url);
      next.searchParams.set("w", String(width));
      next.searchParams.set("h", String(height));
      return next.toString();
    } catch (_error) {
      return url;
    }
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
    bindShadowDelegates();
    syncMapColorVariables();
  }

  // Every control in the dock is handled here, on the shadow root, which is the
  // only node that survives a render.
  //
  // render() replaces the whole shadow tree, and it runs from a dozen places
  // including map idle - so a listener attached to a button lives until the
  // next render, and a click that starts before one and finishes after it lands
  // on an element that no longer exists. That is why the Colors and Settings
  // panels could not be opened at all: the summary was replaced mid-click, so
  // the toggle never completed.
  //
  // <details> is also driven from state rather than its own DOM flag, since
  // that flag would be lost with the element that holds it.
  function bindShadowDelegates() {
    const shadow = state.shadow;
    if (!shadow || shadow.__omtDelegated) return;
    shadow.__omtDelegated = true;

    shadow.addEventListener("click", (event) => {
      const path = event.composedPath();
      const hit = (selector) => path.find((node) => node?.matches?.(selector));
      if (hit("#omt-dock-settings-toggle")) {
        state.settingsOpen = !state.settingsOpen;
        state.dockColorsOpen = false;
        render();
        return;
      }
      if (hit("#omt-dock-colors-toggle")) {
        state.dockColorsOpen = !state.dockColorsOpen;
        state.settingsOpen = false;
        render();
        return;
      }
      if (hit("#omt-compare-launch")) return openVisualBoard();
      if (hit("#omt-mode-cycle")) return cycleMapLayers();
      if (hit("#omt-guess-cycle")) return setGuessComparison(!state.showGuessNeighbors);
      if (hit("#omt-copy-diagnostics")) return copyTrainerDiagnostics();
      if (hit("#omt-retry-round")) return retryCurrentRound();
    });

    const onValue = (event) => {
      const target = event.target;
      const id = target?.id;
      if (!id) return;
      switch (id) {
        case "omt-set-dots":
          state.showDots = target.checked;
          break;
        case "omt-set-clouds":
        case "omt-band-intensity":
          state.bandIntensity = normalizeIntensity(Number(target.value) / 100, 0.4);
          break;
        case "omt-set-matches":
        case "omt-match-count":
          return setMatchCount(target.value);
        case "omt-set-grid":
          state.boardGrid = normalizeBoardGrid(target.value);
          state.visualBoard = null;
          state.visualBoardRoundKey = "";
          saveMapColorPreferences();
          if (state.visualBoardOpen) openVisualBoard();
          return;
        case "omt-set-board-quad":
          state.boardAllDirections = target.checked;
          state.visualBoard = null;
          state.visualBoardRoundKey = "";
          saveMapColorPreferences();
          if (state.visualBoardOpen) openVisualBoard();
          return;
        case "omt-set-dot-quad":
          state.dotPreviewAllDirections = target.checked;
          break;
        case "omt-set-dot-shift-quad":
          state.dotShiftAllDirections = target.checked;
          break;
        case "omt-dot-color":
        case "omt-dock-dot-color":
          return setMapColor("dots", target.value);
        case "omt-guess-dot-color":
        case "omt-dock-guess-dot-color":
          return setMapColor("guess", target.value);
        case "omt-click-color":
        case "omt-dock-click-color":
          return setMapColor("click", target.value);
        default:
          return;
      }
      saveMapColorPreferences();
      showMetaOnMap(false);
    };
    shadow.addEventListener("input", onValue);
    shadow.addEventListener("change", onValue);
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
    .omt-dock-status-actions { display:flex; align-items:stretch; border-left:1px solid var(--line); }
    .omt-dock-status-actions button { min-height:40px; padding:8px 10px; border:0; border-left:1px solid var(--line); color:#d9dbe0; background:transparent; cursor:pointer; font-weight:650; }
    .omt-dock-status-actions button:first-child { border-left:0; }
    .omt-dock-status-actions button:hover { background:#ffffff12; }
    @keyframes omt-pulse { to { opacity:.32; } }
    .omt-dock-swatch { display:inline-block; width:9px; height:9px; margin-right:6px; border:1px solid #ffffff55; border-radius:50%; }
    .omt-dock button.active .omt-dock-swatch { box-shadow:0 0 0 2px #ffffff35; }
    .omt-floating-panel { position:fixed; z-index:2147483002; top:60px; right:12px; padding:11px; border:1px solid var(--line-strong); border-radius:9px; background:#17181bf7; box-shadow:0 10px 30px #0009; }
    .omt-settings-panel { display:flex; flex-direction:column; gap:9px; min-width:262px; }
    .omt-colors-panel { display:grid; grid-template-columns:repeat(3,auto); gap:8px; }
    .omt-dock button.active { color:#fff; background:#ffffff14; }
    .omt-setting { display:flex; align-items:center; justify-content:space-between; gap:10px; color:#d9dbe0; font-size:11px; font-weight:650; white-space:nowrap; }
    .omt-setting input[type=checkbox] { order:-1; margin:0 6px 0 0; }
    .omt-setting input[type=range] { width:96px; }
    .omt-setting input[type=number] { width:62px; padding:3px 5px; border:1px solid var(--line); border-radius:5px; color:#fff; background:#ffffff10; }
    .omt-setting select { padding:3px 5px; border:1px solid var(--line); border-radius:5px; color:#fff; background:#17181b; }
    .omt-setting-action { min-height:32px; border:1px solid var(--line); border-radius:6px; color:#dfe0e3; background:#ffffff08; cursor:pointer; font-weight:650; }
    .omt-setting-action:hover { border-color:var(--line-strong); background:#ffffff10; }
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
    .omt-board-match.omt-board-unavailable { display:grid; place-content:center; gap:7px; padding:18px; border-style:dashed; color:#c8cbd0; text-align:center; }
    .omt-board-match.omt-board-unavailable span { position:static; padding:0; color:#ffd993; background:none; font-weight:700; }
    .omt-board-match.omt-board-unavailable p { margin:0; max-width:180px; color:#aeb2b8; font-size:11px; line-height:1.35; }
    /* Heading, pitch and FOV stay canonical while hydration requests the cell's
       aspect ratio at Google's useful resolution ceiling. */
    .omt-board-current > img,.omt-board-match > img { display:block; width:100%; height:100%; object-fit:cover; object-position:center; }
    .omt-board-mosaic { position:absolute; z-index:1; inset:0; display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); grid-template-rows:repeat(2,minmax(0,1fr)); gap:0; overflow:hidden; opacity:0; transition:opacity .14s ease-out; pointer-events:none; }
    .omt-board-mosaic.ready { opacity:1; }
    .omt-board-mosaic-cell { position:relative; min-width:0; min-height:0; overflow:hidden; background:#050607; }
    .omt-board-mosaic-cell img { position:absolute; left:-10%; top:0; display:block; width:120%; height:100%; max-width:none; object-fit:fill; }
    /* Four-direction grids. minmax(0,1fr) rather than 1fr, because the implicit
       minimum of 1fr is the image's intrinsic 256px - which makes the rows
       uneven and overflows the box. These rules belong in THIS sheet: the file
       carries an older one too, and rules added there are simply never
       applied. */
    .omt-board-quad { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); grid-template-rows:minmax(0,1fr) minmax(0,1fr); gap:1px; width:100%; height:100%; }
    .omt-board-quad img { display:block; width:100%; height:100%; min-width:0; min-height:0; object-fit:cover; }
    .omt-peek-quad { position:absolute; inset:0; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); grid-template-rows:minmax(0,1fr) minmax(0,1fr); gap:2px; }
    .omt-peek-cell { position:relative; min-width:0; min-height:0; overflow:hidden; background:#050607; }
    .omt-peek-quad img { display:block; width:100%; height:100%; min-width:0; min-height:0; object-fit:cover; }
    .omt-board-current strong,.omt-board-match span { position:absolute; z-index:2; left:0; top:0; padding:4px 6px; color:#fff; background:#090a0cdd; font-size:10px; }
    .omt-board-current strong { color:#fff; font-size:11px; }
    button.omt-board-match { padding:0; cursor:pointer; }
    .omt-board-match em { position:absolute; z-index:2; right:0; bottom:0; padding:3px 5px; color:#d5d7db; background:#090a0cdd; font:normal 9px/1.2 inherit; }
    .omt-board-peek { position:fixed; z-index:4; inset:62px 2vw 40px; display:flex; flex-direction:column; min-width:0; min-height:0; overflow:hidden; border:1px solid #ffffff4a; border-radius:5px; background:#060709fa; box-shadow:0 20px 80px #000f; pointer-events:none; }
    .omt-board-peek-media { position:relative; min-height:0; flex:1; overflow:hidden; background:#050607; }
    .omt-board-peek-media > img { display:block; width:100%; height:100%; object-fit:cover; }
    .omt-native-pano { position:absolute; inset:0; z-index:1; opacity:0; transition:opacity .22s ease-out; background:#050607; pointer-events:none; }
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
    .omt-match-tooltip-images { position:relative; height:336px; background:#090a0c; }
    .omt-match-tooltip-stills,.omt-match-tooltip-native { position:absolute; inset:0; display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); grid-template-rows:minmax(0,1fr) minmax(0,1fr); gap:2px; }
    .omt-match-tooltip-stills.omt-single,.omt-match-tooltip-native.omt-single { grid-template-columns:1fr; grid-template-rows:1fr; }
    .omt-match-tooltip-cell { position:relative; min-width:0; min-height:0; overflow:hidden; background:#090a0c; }
    .omt-match-tooltip-cell > img { position:absolute; inset:0; display:block; width:100%; height:100%; object-fit:cover; opacity:0; transition:opacity .12s ease-out; }
    .omt-match-tooltip-cell > img.omt-loaded { opacity:1; }
    .omt-match-tooltip-loading-slot { position:absolute; inset:0; display:grid; place-items:center; color:#777981; background:#090a0c; font-size:9px; }
    /* one direction fills the frame instead of leaving three empty cells */
    .omt-match-tooltip-images.omt-single { height:250px; }
    .omt-match-tooltip-native { z-index:2; display:none; pointer-events:none; }
    .omt-match-tooltip-native .omt-native-pano { position:absolute; inset:0; min-width:0; min-height:0; }
    .omt-match-tooltip-foot { padding:6px 9px; border-top:1px solid var(--line); color:#c8cad0; font-size:9px; text-align:center; }
    .omt-match-tooltip.omt-match-tooltip-expanded { inset:62px 2vw 40px !important; width:auto; display:grid; grid-template-rows:auto minmax(0,1fr) auto; border-color:#ffffff4a; border-radius:5px; background:#060709fa; box-shadow:0 20px 80px #000f; backdrop-filter:none; }
    .omt-match-tooltip-expanded .omt-match-tooltip-images { min-height:0; height:auto; }
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
      ? `<button id="omt-mode-cycle" class="${state.showVisualNeighbors ? "active" : ""}" title="Show or hide the round's cloud"><i class="omt-dock-swatch" style="background:${esc(state.neighborDotColor)}"></i>Round <kbd>M</kbd></button>`
      : "";
    // The guess cloud is available on the corpus path too - it was gated here
    // and on the G key long after the feature itself stopped needing a dataset,
    // so the only way to toggle it was the checkbox in the drawer.
    const guess = review.visualNeighborhood
      ? `<button id="omt-guess-cycle" class="${state.showGuessNeighbors ? "active" : ""}" title="Show or hide the cloud around your guess" ${state.playerGuess ? "" : "disabled"}><i class="omt-dock-swatch" style="background:${esc(state.guessDotColor)}"></i>Guess <kbd>G</kbd></button>`
      : "";
    const display = review.visualNeighborhood
      ? `<button id="omt-dock-settings-toggle" class="${state.settingsOpen ? "active" : ""}">Settings</button>`
      : "";
    const settings = review.visualNeighborhood
      ? `<button id="omt-dock-colors-toggle" class="${state.dockColorsOpen ? "active" : ""}">Colors</button>`
      : "";
    // The panels are siblings of the dock, not children of it. The dock has a
    // backdrop-filter, which makes it the containing block for any fixed-
    // position descendant, and an overflow:hidden that then clips it - so a
    // panel inside the dock was positioned against the dock and cut away,
    // which is why these buttons appeared to do nothing.
    return `<div class="omt-dock">${compare}${mode}${guess}${display}${settings}</div>`
      + (state.settingsOpen && review.visualNeighborhood ? settingsPanel() : "")
      + (state.dockColorsOpen && review.visualNeighborhood ? colorsPanel() : "");
  }

  function settingsPanel() {
    return `<div class="omt-floating-panel omt-settings-panel">`
      + `<label class="omt-setting"><input type="checkbox" id="omt-set-dots" ${state.showDots ? "checked" : ""}>Dots</label>`
      + `<label class="omt-setting">Clouds <input type="range" id="omt-set-clouds" min="0" max="100" step="5" value="${Math.round(state.bandIntensity * 100)}"></label>`
      + `<label class="omt-setting">Matches per round <input type="number" id="omt-set-matches" min="${MATCH_COUNT_MIN}" max="${MATCH_COUNT_MAX}" step="10" value="${state.matchCount}"></label>`
      + `<label class="omt-setting">Comparison grid <select id="omt-set-grid"><option value="2"${state.boardGrid === 2 ? " selected" : ""}>2 x 2</option><option value="3"${state.boardGrid === 3 ? " selected" : ""}>3 x 3</option><option value="4"${state.boardGrid === 4 ? " selected" : ""}>4 x 4</option></select></label>`
      + `<label class="omt-setting"><input type="checkbox" id="omt-set-board-quad" ${state.boardAllDirections ? "checked" : ""}>Comparison shows all four directions</label>`
      + `<label class="omt-setting"><input type="checkbox" id="omt-set-dot-quad" ${state.dotPreviewAllDirections ? "checked" : ""}>Dot preview shows all four directions</label>`
      + `<label class="omt-setting"><input type="checkbox" id="omt-set-dot-shift-quad" ${state.dotShiftAllDirections ? "checked" : ""}>Shift enlarges a dot to all four</label>`
      + `<button class="omt-setting-action" id="omt-copy-diagnostics">Copy diagnostics</button>`
      + `</div>`;
  }

  function colorsPanel() {
    return `<div class="omt-floating-panel omt-colors-panel">`
      + `<label class="omt-color-setting">Round <input type="color" id="omt-dock-dot-color" value="${state.neighborDotColor}"></label>`
      + `<label class="omt-color-setting">Guess <input type="color" id="omt-dock-guess-dot-color" value="${state.guessDotColor}"></label>`
      + `<label class="omt-color-setting">Click <input type="color" id="omt-dock-click-color" value="${state.neighborClickColor}"></label>`
      + `</div>`;
  }

  // Kept as a hook for anything that genuinely needs rebinding after a render.
  // Dock controls are handled by delegation instead - see bindShadowDelegates -
  // because listeners bound here die with the markup on the next render.
  function bindDockUi() {}


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
            <section class="omt-section"><div class="omt-section-head"><h3>Map overlays</h3><span>saved between rounds</span></div><div class="omt-map-actions"><label class="omt-layer-toggle"><input type="checkbox" id="omt-best-meta" ${state.showBestMeta ? "checked" : ""}>Families</label><label class="omt-layer-toggle"><input type="checkbox" id="omt-neighbors" ${state.showVisualNeighbors ? "checked" : ""}>Round matches</label><label class="omt-layer-toggle" title="Compare the visual neighborhood near your guess with the revealed location"><input type="checkbox" id="omt-guess-neighbors" ${state.showGuessNeighbors ? "checked" : ""} ${state.playerGuess ? "" : "disabled"}>Guess comparison</label><label class="omt-color-setting">Round <input type="color" id="omt-dot-color" value="${state.neighborDotColor}"></label><label class="omt-color-setting">Guess <input type="color" id="omt-guess-dot-color" value="${state.guessDotColor}"></label><label class="omt-color-setting">Click <input type="color" id="omt-click-color" value="${state.neighborClickColor}"></label><label class="omt-color-setting" title="How strongly the similarity-mass bands are painted. Zero shows dots only.">Cloud <input type="range" id="omt-band-intensity" min="0" max="100" step="5" value="${Math.round(state.bandIntensity * 100)}" style="width:74px"></label><label class="omt-color-setting" title="How many of the ranked matches to draw. The pack stores 300 per panorama.">Matches <input type="number" id="omt-match-count" min="${MATCH_COUNT_MIN}" max="${MATCH_COUNT_MAX}" step="10" value="${state.matchCount}" style="width:52px"></label></div>${guessComparisonHtml}<div class="omt-click-lines">${clickLines || ""}</div></section>
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
    diagnosticPhase("offline");
    if (message) diagnosticError(message, "round-review");
    state.shadow.innerHTML = `<style>${styles}</style><div class="omt"><div class="omt-dock"><div class="omt-dock-status" title="${esc(message)}">${esc(message || "Trainer data unavailable")}</div><div class="omt-dock-status-actions"><button id="omt-retry-round" title="Retry this completed round deliberately">Retry</button><button id="omt-copy-diagnostics" title="Copy a non-sensitive diagnostic report">Diagnostics</button></div></div></div>`;
  }

  function renderPending(message = "Analyzing visual similarity…") {
    ensureRoot();
    diagnosticPhase("retrieving");
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
    state.shadow.getElementById("omt-match-count")?.addEventListener("change", (event) => {
      setMatchCount(event.target.value);
    });
    state.shadow.getElementById("omt-band-intensity")?.addEventListener("input", (event) => {
      state.bandIntensity = normalizeIntensity(Number(event.target.value) / 100, 0.4);
      saveMapColorPreferences();
      showMetaOnMap(false);
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
    // Turning the guess cloud on used to force the round cloud on with it, from
    // when this was an overlay ON the round matches rather than a layer of its
    // own. With a button for each, G is expected to move one of them.
    render();
    if (state.showGuessNeighbors) {
      loadGuessNeighborhood(state.requestToken);
    } else {
      showMetaOnMap(false);
    }
  }

  function setMatchCount(value) {
    const next = normalizeMatchCount(value, state.matchCount);
    if (next === state.matchCount) return;
    state.matchCount = next;
    saveMapColorPreferences();
    render();
    showMetaOnMap(false);
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
    // Only text entry should swallow a hotkey. Checkboxes, ranges and selects
    // do not consume letters, and refusing V while the settings panel had focus
    // meant opening the panel disabled the comparison board.
    if (target?.matches?.("textarea, [contenteditable=true], input[type=text], "
      + "input[type=number], input[type=search], input[type=email], input[type=url]")) return;
    if (event.code === "KeyM") {
      event.preventDefault();
      event.stopPropagation();
      cycleMapLayers();
    } else if (event.code === "KeyV") {
      event.preventDefault();
      event.stopPropagation();
      if (state.visualBoardOpen) closeVisualBoard(); else openVisualBoard();
    } else if (event.code === "KeyG" && state.playerGuess) {
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
    const declaredSlots = state.boardGrid * state.boardGrid;
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
      if (item.kind === "guess-unavailable") {
        slots.push({
          slotIndex: index + 1,
          role: "nearGuessUnavailable",
          ref: null,
          heading: null,
          contentStatus: "placeholder",
        });
        continue;
      }
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
    while (slots.length < declaredSlots) {
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
      gridSize: state.boardGrid,
      renderedAtMs: Date.now(),
      policyVersion: "visual-board-adaptive-grid-near-guess-v2",
      declaredSlots,
      contentDigest: shortContentDigest(slots),
      contentChangedDuringMode: false,
      slots,
    };
  }

  function registerBoardContent(content) {
    const exposure = state.visualExposure;
    if (!exposure || !content) return;
    const existing = exposure.boardContent.find((item) => (
      item.mode === content.mode && item.gridSize === content.gridSize
    ));
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
    window.clearTimeout(state.boardWarmTimer);
    const board = state.shadow?.querySelector(".omt-visual-board,.omt-board-loading");
    // A peek may be open with a live widget inside it; move the widgets out
    // before the board is removed, or closing V destroys what was just built.
    releaseNativeStreetViews(board);
    board?.remove();
  }

  // Live Street View widgets, kept between hovers.
  //
  // Every peek used to construct a StreetViewPanorama and dispose the previous
  // one, so going back to a tile already viewed rebuilt the widget and reloaded
  // its tiles - about half a second of blur each time, even for a panorama seen
  // seconds earlier. Widgets are now moved rather than destroyed: off-screen
  // when not shown, back into place when hovered again, still rendered.
  //
  // They are parked off-screen rather than hidden, because a display:none
  // panorama stops rendering and has to repaint on return - which is the thing
  // being avoided.
  // A four-direction peek mounts four widgets at once. Retain exactly one
  // peek's worth and RETARGET those renderers for later panoramas. The previous
  // 12-widget cache eventually evicted GeoGuessr's own Google Maps WebGL
  // renderer in Firefox, leaving our canvas dots on a blank beige basemap.
  const NATIVE_PANO_POOL_LIMIT = 4;
  const nativePanoCache = new Map();
  let nativePanoAttic = null;

  function nativePanoKey(panoId, heading) {
    return `${panoId}@${Math.round(Number(heading) || 0)}`;
  }

  // The parking area is sized to match the peek, because Street View chooses
  // its tile resolution from the size of the element it is built in. Building
  // in a small box and then moving into a near-fullscreen peek gave a widget
  // that upscaled low-resolution tiles - softer than before these were warmed
  // at all, when each was constructed directly in the peek at full size.
  function peekSize() {
    // matches `.omt-board-peek { inset: 62px 2vw 40px }` less the caption
    return {
      width: Math.max(320, Math.round(window.innerWidth * 0.96)),
      height: Math.max(240, window.innerHeight - 62 - 40 - 34),
    };
  }

  function nativePanoAtticElement() {
    if (!nativePanoAttic || !nativePanoAttic.isConnected) {
      nativePanoAttic = document.createElement("div");
      nativePanoAttic.setAttribute("aria-hidden", "true");
      nativePanoAttic.style.cssText =
        "position:fixed;left:-20000px;top:0;pointer-events:none;";
      document.body.appendChild(nativePanoAttic);
    }
    const { width, height } = peekSize();
    // keep it current: a window resized between warming and hovering would
    // otherwise leave the widgets built for the old dimensions
    if (nativePanoAttic.dataset.width !== String(width)) {
      nativePanoAttic.style.width = `${width}px`;
      nativePanoAttic.style.height = `${height}px`;
      nativePanoAttic.dataset.width = String(width);
    }
    return nativePanoAttic;
  }

  function armNativePanoReveal(container, panorama) {
    const maps = pageWindow.google?.maps;
    const generation = Number(container.dataset.omtNativeGeneration || 0) + 1;
    container.dataset.omtNativeGeneration = String(generation);
    container.classList.remove("omt-native-pano-ready");
    let revealTimer = 0;
    const reveal = () => {
      if (Number(container.dataset.omtNativeGeneration) !== generation) return;
      const status = panorama.getStatus?.();
      if (!maps?.StreetViewStatus || status === maps.StreetViewStatus.OK) {
        window.clearTimeout(revealTimer);
        // `pano_changed` and OK status precede the first painted tile by a few
        // frames. Keep the correctly filled thumbnail beneath it during that
        // interval instead of exposing the renderer's black backing surface.
        revealTimer = window.setTimeout(() => {
          if (container.isConnected
              && Number(container.dataset.omtNativeGeneration) === generation) {
            container.classList.add("omt-native-pano-ready");
          }
        }, 140);
      }
    };
    maps?.event?.addListenerOnce?.(panorama, "status_changed", reveal);
    maps?.event?.addListenerOnce?.(panorama, "pano_changed", () => {
      window.setTimeout(reveal, 50);
    });
    window.setTimeout(reveal, 850);
  }

  function retargetNativeStreetView(entry, panoId, heading) {
    if (!entry?.host || !entry.panorama) return null;
    armNativePanoReveal(entry.host, entry.panorama);
    entry.panorama.setPov?.({ heading: Number(heading) || 0, pitch: 0 });
    entry.panorama.setPano?.(String(panoId));
    pageWindow.google?.maps?.event?.trigger?.(entry.panorama, "resize");
    return entry.panorama;
  }

  // Mounts a panorama in place of `slot`, reusing a live one when possible.
  function mountNativeStreetView(slot, panoId, heading) {
    if (!slot || !panoId) return null;
    const key = nativePanoKey(panoId, heading);
    const cached = nativePanoCache.get(key);
    if (cached && cached.host) {
      cached.usedAt = Date.now();
      if (cached.host === slot) return cached.panorama;
      slot.replaceWith(cached.host);
      // the widget was last laid out at the attic's size, so tell it to re-fit
      pageWindow.google?.maps?.event?.trigger?.(cached.panorama, "resize");
      return cached.panorama;
    }

    // Once four contexts exist, recycle the least-recently-used renderer. This
    // keeps total GPU contexts constant even after Shift-hovering hundreds of
    // panoramas; only its target pano and POV change.
    if (nativePanoCache.size >= NATIVE_PANO_POOL_LIMIT) {
      const [oldKey, reusable] = [...nativePanoCache.entries()]
        .sort((a, b) => a[1].usedAt - b[1].usedAt)[0] || [];
      if (reusable) {
        nativePanoCache.delete(oldKey);
        reusable.usedAt = Date.now();
        slot.replaceWith(reusable.host);
        retargetNativeStreetView(reusable, panoId, heading);
        nativePanoCache.set(key, reusable);
        return reusable.panorama;
      }
    }
    const panorama = nativeStreetView(slot, panoId, heading);
    if (panorama) {
      nativePanoCache.set(key, { host: slot, panorama, usedAt: Date.now() });
    }
    return panorama;
  }

  // Park every cached widget still inside `scope`, so removing `scope` does not
  // take the widgets with it.
  function releaseNativeStreetViews(scope) {
    if (!scope) return;
    for (const entry of nativePanoCache.values()) {
      if (entry.host && scope.contains?.(entry.host)) nativePanoAtticElement().appendChild(entry.host);
    }
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

  function disposeNativePanoPool() {
    const entries = [...nativePanoCache.values()];
    disposeNativePanoramas(entries.map((entry) => entry.panorama));
    for (const entry of entries) entry.host?.remove();
    nativePanoCache.clear();
    nativePanoAttic?.remove();
    nativePanoAttic = null;
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
    armNativePanoReveal(container, panorama);
    return panorama;
  }

  // A tile's imagery: the road-aligned view, or all four directions the corpus
  // was embedded from. Four thumbnails cost four requests but show the whole
  // panorama, which is what the dot previews have always done.
  function tileImages(panoId, heading, attributes, alt) {
    if (!state.boardAllDirections || !panoId || !Number.isFinite(Number(heading))) {
      const base = `<img data-src="${esc(corpusViewUrl(panoId, heading))}" ${attributes} alt="${esc(alt)}">`;
      if (state.boardGrid !== 2 || !panoId || !Number.isFinite(Number(heading))) return base;
      // Six narrower perspective thumbnails form a ~1020x560 source for a
      // typical 2x2 cell. Each visible column represents 30 degrees of the
      // canonical 90-degree view; a small horizontal crop removes the overlap
      // from the 36-degree source pieces. Two pitch bands cover ~50 degrees
      // vertically at the cell's aspect ratio. This avoids both the endpoint's
      // single-image ceiling and the attribution chrome of four embedded live
      // renderers while keeping true-north headings explicit.
      // On this thumbnail endpoint negative pitch is the upper band and
      // positive pitch is the lower band. Keep that API-specific ordering
      // explicit so the road cannot appear above the sky again.
      const pieces = [-12.5, 12.5].flatMap((pitch) => [-30, 0, 30].map((offset) => (
        `<div class="omt-board-mosaic-cell"><img data-src="${esc(corpusViewUrl(
          panoId,
          Number(heading) + offset,
          467,
          320,
          { fov: 36, pitch },
        ))}" alt=""></div>`
      ))).join("");
      return `${base}<div class="omt-board-mosaic" aria-hidden="true">${pieces}</div>`;
    }
    return `<div class="omt-board-quad">` + [0, 90, 180, 270].map((offset, slot) =>
      `<img data-src="${esc(corpusViewUrl(panoId, Number(heading) + offset))}" ${attributes} `
      + `alt="${esc(alt)}, direction ${slot + 1}">`).join("") + `</div>`;
  }

  // The enlarged view, built in one place so its two modes cannot half-apply.
  //
  // Both were previously assembled inside the peek's markup by removing the
  // parts the other mode needed, which left a single-view image and a Street
  // View container sitting under the four-way grid.
  function buildBoardPeek(tile) {
    const peek = document.createElement("div");
    peek.className = "omt-board-peek";
    const label = esc(tile.dataset.boardLabel || "Comparison view");
    // The board and map-dot controls are intentionally independent. Using the
    // dot setting here made the default one-direction board allocate all four
    // Street View renderers for every Shift peek, evicting the previously
    // cached board panorama and bringing its half-second reload back.
    const media = state.boardAllDirections
      ? `<div class="omt-peek-quad"></div>`
      : `<img alt="${label}"><div class="omt-native-pano" aria-label="High-resolution Street View"></div>`;
    peek.innerHTML = `<div class="omt-board-peek-media">${media}</div>`
      + `<div class="omt-board-peek-caption"><b>${label}</b>`
      + `<span>${esc(tile.dataset.boardDetail || "")}</span></div>`;
    return peek;
  }

  function fillBoardPeek(peek, tile) {
    const panoId = tile.dataset.boardPano;
    const heading = Number(tile.dataset.boardHeading) || 0;
    const quad = peek.querySelector(".omt-peek-quad");
    if (quad) {
      // Four live Street View widgets, one per direction, rather than four
      // thumbnails. The thumbnail endpoint caps around 562x280 whatever is
      // requested, which is soft across half a screen; the widget renders the
      // real tiles. Each cell keeps a thumbnail underneath as the thing to look
      // at while its panorama loads, and the panorama fades in over it - the
      // same crossfade the single-direction peek uses.
      const box = quad.getBoundingClientRect();
      for (let slot = 0; slot < 4; slot += 1) {
        const bearing = heading + slot * 90;
        const cell = document.createElement("div");
        cell.className = "omt-peek-cell";
        const still = document.createElement("img");
        still.alt = `${tile.dataset.boardLabel || "Comparison view"}, direction ${slot + 1}`;
        still.src = fitViewToBox(corpusViewUrl(panoId, bearing), box.width / 2, box.height / 2);
        const live = document.createElement("div");
        live.className = "omt-native-pano";
        live.setAttribute("aria-label", `High-resolution Street View, direction ${slot + 1}`);
        cell.append(still, live);
        quad.appendChild(cell);
        mountNativeStreetView(live, panoId, bearing);
      }
      return;
    }
    const image = peek.querySelector("img");
    const source = tile.querySelector("img");
    const box = image.getBoundingClientRect();
    if (panoId) {
      image.src = fitViewToBox(corpusViewUrl(panoId, heading), box.width, box.height);
    } else if (source?.currentSrc || source?.src) {
      image.src = source.currentSrc || source.src;
    } else if (source?.dataset.src) {
      imageUrl(source.dataset.src).then((url) => {
        if (peek.isConnected) image.src = url;
      }).catch(() => {});
    }
    mountNativeStreetView(peek.querySelector(".omt-native-pano"), panoId, heading);
  }

  function revealBoardMosaics(scope) {
    const waitForImage = (image) => new Promise((resolve, reject) => {
      const decode = async () => {
        try {
          if (typeof image.decode === "function") await image.decode();
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      if (image.complete && image.naturalWidth > 0) {
        void decode();
        return;
      }
      image.addEventListener("load", () => void decode(), { once: true });
      image.addEventListener("error", reject, { once: true });
    });
    const mosaics = [...scope.querySelectorAll(".omt-board-mosaic")];
    if (!mosaics.length) return;
    const receipt = {
      status: "loading",
      mode: "six-piece-thumbnail-mosaic",
      views: mosaics.length,
      requestedPieces: mosaics.length * 6,
      readyViews: 0,
      failedViews: 0,
      at: new Date().toISOString(),
    };
    state.diagnostics.boardImagery = receipt;
    const settle = () => {
      if (receipt.readyViews + receipt.failedViews !== receipt.views) return;
      receipt.status = receipt.failedViews
        ? (receipt.readyViews ? "partial" : "failed")
        : "complete";
    };
    for (const mosaic of mosaics) {
      Promise.all([...mosaic.querySelectorAll("img")].map(waitForImage)).then(() => {
        if (mosaic.isConnected) {
          mosaic.classList.add("ready");
          receipt.readyViews += 1;
        } else {
          receipt.failedViews += 1;
        }
        settle();
      }).catch(() => {
        // The canonical single thumbnail remains visible if any one piece is
        // unavailable; never reveal a partial stitched view.
        receipt.failedViews += 1;
        settle();
        mosaic.remove();
      });
    }
  }

  function renderVisualBoard() {
    if (!state.visualBoardOpen || !state.shadow || !state.visualBoard) return;
    const boardPanoId = decodedPanoId(state.visualBoard.panoId);
    const reviewPanoId = decodedPanoId(state.review?.location?.panoId);
    if (!state.review || state.visualBoardRoundKey !== state.reviewRoundKey
        || (boardPanoId && reviewPanoId && boardPanoId !== reviewPanoId)) {
      state.visualBoard = null;
      state.visualBoardRoundKey = "";
      queueMicrotask(() => {
        if (state.visualBoardOpen && state.review) openVisualBoard();
      });
      return;
    }
    state.visualBoardModifierCleanup?.();
    state.visualBoardModifierCleanup = null;
    const previousBoard = state.shadow.querySelector(".omt-visual-board,.omt-board-loading");
    releaseNativeStreetViews(previousBoard);
    previousBoard?.remove();
    const board = state.visualBoard;
    const mode = board.modes.find((item) => item.id === state.visualBoardMode)
      || board.modes[0];
    state.visualBoardMode = mode.id;
    const literal = mode.id === "literal";
    const modeLabels = { consensus: "Main group", alternate: "Other group", literal: "Nearest views" };
    const tabs = board.modes.map((item) => `<button data-board-mode="${esc(item.id)}" class="${item.id === mode.id ? "active" : ""}">${esc(modeLabels[item.id] || item.label)}</button>`).join("");
    const availableEntries = mode.guessMatch
      ? [mode.guessMatch, ...mode.entries]
      : mode.guessUnavailable
        ? [{ kind: "guess-unavailable", mapIndex: -3 }, ...mode.entries]
        : mode.entries;
    // The round owns the first cell. The near-guess comparison, when present,
    // remains cell two; then take only as many global matches as this grid can
    // display. This also bounds older map-specific boards that return eight
    // entries regardless of the user's selected grid size.
    const boardEntries = availableEntries.slice(0, state.boardGrid * state.boardGrid - 1);
    const boardContent = boardContentForMode(mode, boardEntries);
    const contentDigest = boardContent.contentDigest;
    const matches = boardEntries.map((item, index) => {
      const contentAttributes = `data-board-content-mode="${esc(mode.id)}" data-board-content-digest="${esc(contentDigest)}" data-board-slot="${index + 1}"`;
      if (item.kind === "guess-unavailable") {
        return '<div class="omt-board-match omt-board-guess omt-board-unavailable" role="note" aria-label="No nearby view is available for your guess"><span>Near your guess</span><p>No nearby view is available for this guess.</p></div>';
      }
      if (item.kind === "guess-local") {
        const distance = item.distanceFromGuessKm < 1
          ? `${Math.round(item.distanceFromGuessKm * 1000)} m`
          : `${item.distanceFromGuessKm.toFixed(1)} km`;
        // Only the ranks are worth the space. Whether the number came from a
        // stored neighbour list or from the projection is a detail of how it
        // was obtained, not something to act on.
        const rank = Number.isFinite(item.globalPanoRank)
          ? `#${item.globalPanoRank} most similar to this round`
          : Number.isFinite(item.reciprocalRank)
            ? `this round is #${item.reciprocalRank} most similar to it`
            : "";
        const label = "Best visual case near your guess";
        // A similarity of 0.000 was being printed for an anchor whose likeness
        // to the round had never been measured, which reads as "nothing alike"
        // rather than "not measured".
        // null and undefined must not survive Number(): both coerce to 0, which
        // would print "0.0% similar" for something never measured.
        const strength = item.viewSimilarity === null || item.viewSimilarity === undefined
          || !Number.isFinite(Number(item.viewSimilarity))
          ? ""
          : `${similarityText(item.viewSimilarity)} · `;
        const detail = `${strength}${distance} from guess${rank ? ` · ${rank}` : ""}`;
        return `<button class="omt-board-match omt-board-guess" data-board-entry="${item.mapIndex}" data-board-kind="guess-local" data-board-pano="${esc(item.panoId)}" data-board-heading="${Number(item.heading) || 0}" data-board-inspect data-board-label="${esc(label)}" data-board-detail="${esc(detail)}" aria-label="${esc(label)}. ${esc(detail)}">${tileImages(item.panoId, item.heading, contentAttributes, "Best visual match near your guess")}<span>Near your guess</span><em>${esc(detail)}</em></button>`;
      }
      const distance = item.distanceKm < 1
        ? `${Math.round(item.distanceKm * 1000)} m`
        : `${item.distanceKm.toFixed(1)} km`;
      const label = `Visual match #${item.rank}${item.reciprocal ? " · mutual match" : ""}`;
      const detail = `${similarityText(item.viewSimilarity)} · ${distance}`;
      return `<button class="omt-board-match" data-board-entry="${item.mapIndex}" data-board-pano="${esc(item.panoId)}" data-board-heading="${Number(item.heading) || 0}" data-board-inspect data-board-label="${esc(label)}" data-board-detail="${esc(detail)}" aria-label="${esc(label)}. ${esc(detail)}">${tileImages(item.panoId, item.heading, contentAttributes, `Visual match ${item.rank}`)}<span>#${item.rank}${item.reciprocal ? " · mutual" : ""}</span><em>${esc(detail)}</em></button>`;
    }).join("");
    const interpretation = board.corpus
      ? "Closest panoramas in the corpus, each shown along its own road direction."
      : literal
      ? "Closest views, without filtering for agreement."
      : mode.id === "alternate"
        ? "Another shared look among the nearest visual candidates."
        : "Most consistent shared look among the nearest visual candidates.";
    const element = document.createElement("div");
    element.className = "omt-visual-board";
    const guessPoolRadiusValue = mode.guessMatch?.poolRadiusKm;
    const guessPoolRadius = guessPoolRadiusValue === null || guessPoolRadiusValue === undefined
      ? null : Number(guessPoolRadiusValue);
    const guessPoolScope = Number.isFinite(guessPoolRadius)
      ? ` within ${guessPoolRadius < 10 ? guessPoolRadius.toFixed(1) : Math.round(guessPoolRadius)} km`
      : " near your guess";
    const guessReceipt = mode.guessMatch
      ? `<span><b>best of ${mode.guessMatch.candidatePool}</b> corpus views${guessPoolScope}</span>`
      : mode.guessUnavailable
        ? "<span><b>No nearby comparison</b> available for your guess</span>"
        : "";
    element.innerHTML = `<header class="omt-board-head"><div><h2>Visual comparison</h2><p>${esc(interpretation)} Shift + hover to enlarge; click a match to open it.</p></div><nav class="omt-board-tabs">${tabs}</nav><button class="omt-board-close">Close <kbd>V</kbd></button></header><main class="omt-board-body"><div class="omt-board-grid" style="grid-template-columns:repeat(${state.boardGrid},1fr);grid-template-rows:repeat(${state.boardGrid},1fr)"><div class="omt-board-current" tabindex="0" data-board-pano="${esc(board.panoId)}" data-board-heading="${Number(mode.currentHeading) || 0}" data-board-inspect data-board-label="This round" data-board-detail="The panorama this round spawned on">${tileImages(board.panoId, mode.currentHeading, `data-board-content-mode="${esc(mode.id)}" data-board-content-digest="${esc(contentDigest)}" data-board-slot="0"`, "This round")}<strong>This round</strong></div>${matches}</div></main><footer class="omt-board-foot">${guessReceipt}${board.corpus
        ? `<span><b>${mode.support}</b> of ${mode.supportOf} in the close core</span><span><b>${mode.independentAreas}</b> separate areas</span>`
        : `<span><b>${literal ? "nearest visual views" : `${mode.support}/100`}</b> in this group</span><span><b>${mode.reciprocalSupport}</b> mutual matches</span><span><b>${mode.independentAreas}</b> separate areas</span><span><b>${Math.round(mode.coherence * 100)}%</b> visual agreement</span>`}<span class="omt-board-warning">Visual similarity is evidence, not certainty.</span></footer>`;
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
    const hidePeek = () => {
      const peek = element.querySelector(".omt-board-peek");
      // move the live widget out before the peek is removed, or it goes with it
      releaseNativeStreetViews(peek);
      peek?.remove();
    };
    const showPeek = (tile) => {
      hidePeek();
      if (!tile?.dataset?.boardPano && !tile.querySelector("img")) return;
      const peek = buildBoardPeek(tile);
      element.appendChild(peek);
      fillBoardPeek(peek, tile);
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
    // Establish the complete heading-aware thumbnail board before interaction
    // can construct an enlarged native Street View view.
    revealBoardMosaics(element);
    void hydrateImages(element);
  }

  async function warmVisualBoard(board) {
    const mode = board.modes.find((item) => item.id === (board.defaultMode || "consensus"))
      || board.modes[0];
    const availableEntries = state.boardGrid * state.boardGrid - 1;
    const reservedGuessSlot = Boolean(mode.guessMatch || mode.guessUnavailable);
    const paths = [
      mode.currentView,
      ...(mode.guessMatch ? [mode.guessMatch.view] : []),
      ...mode.entries
        .slice(0, Math.max(0, availableEntries - (reservedGuessSlot ? 1 : 0)))
        .map((item) => item.view),
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
    const review = state.review;
    const reviewRoundKey = state.reviewRoundKey;
    const guessKey = playerGuess
      ? `${playerGuess.lat.toFixed(6)},${playerGuess.lng.toFixed(6)}`
      : "no-guess";
    const key = `${reviewRoundKey}:${datasetKey}:${mapIndex}:${guessKey}`;
    if (state.visualBoardKey === key && state.visualBoard
        && state.visualBoardRoundKey === reviewRoundKey) {
      return Promise.resolve(state.visualBoard);
    }
    if (state.visualBoardKey === key && state.visualBoardPromise) {
      return state.visualBoardPromise;
    }
    state.visualBoardKey = key;
    if (state.review?.universal && state.review.visualBoard) {
      state.visualBoard = state.review.visualBoard;
      state.visualBoardRoundKey = reviewRoundKey;
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
      if (token !== state.requestToken || state.visualBoardKey !== key
          || state.review !== review || state.reviewRoundKey !== reviewRoundKey) return null;
      state.visualBoard = board;
      state.visualBoardRoundKey = reviewRoundKey;
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
    const review = state.review;
    const reviewRoundKey = state.reviewRoundKey;
    const token = state.requestToken;
    // The second corpus tile teaches from the player's guess, regardless of
    // whether the separate guess-cloud map overlay is visible. Previously that
    // tile was conditional on `showGuessNeighbors`, so hiding the purple dots
    // silently replaced it with global match #1.
    const needsGuessExample = Boolean(
      review.universal && state.playerGuess && !state.guessNeighborhood,
    );
    if (!needsGuessExample && state.visualBoardRoundKey === reviewRoundKey
        && state.visualBoard?.panoId === review.location.panoId
        && state.visualBoard?.corpus === Boolean(state.review.universal)
        && (state.visualBoard?.corpus
          || (state.visualBoard?.mapIndex === state.review.location.mapIndex
            && state.visualBoard?.datasetKey === state.review.datasetKey))) {
      renderVisualBoard();
      return;
    }
    const previousBoard = state.shadow.querySelector(".omt-visual-board,.omt-board-loading");
    releaseNativeStreetViews(previousBoard);
    previousBoard?.remove();
    const loading = document.createElement("div");
    loading.className = "omt-board-loading";
    loading.textContent = "Finding coherent visual interpretations…";
    state.shadow.appendChild(loading);
    try {
      if (needsGuessExample) {
        loading.textContent = "Finding the best visual case near your guess…";
        await loadGuessNeighborhood(token);
        if (token !== state.requestToken || state.review !== review
            || state.reviewRoundKey !== reviewRoundKey
            || !state.visualBoardOpen) return;
      }
      // The corpus path has no dataset and no map index, so /api/visual-board
      // cannot serve it. Build the board from the round's own matches and the
      // guess-side anchor instead.
      const board = review.universal
        ? cradioClient.buildVisualBoard(
            review,
            state.guessNeighborhood,
            // A square board reserves its first cell for the round itself.
            {
              tiles: state.boardGrid * state.boardGrid - 1,
              guessExpected: Boolean(state.playerGuess),
            },
          )
        : await preloadVisualBoard(
            review.datasetKey,
            review.location.mapIndex,
          );
      if (!board) return;
      if (!state.visualBoardOpen || state.review !== review
          || state.reviewRoundKey !== reviewRoundKey || token !== state.requestToken) return;
      if (!board.corpus && (board.mapIndex !== state.review.location.mapIndex
          || board.datasetKey !== state.review.datasetKey)) return;
      state.visualBoard = board;
      state.visualBoardRoundKey = reviewRoundKey;
      state.visualBoardMode = board.defaultMode || "consensus";
      renderVisualBoard();
    } catch (error) {
      loading.textContent = `Visual comparison unavailable: ${error.message}`;
      window.setTimeout(() => {
        closeVisualBoard();
      }, 2500);
    }
  }

  // One shape for every match tooltip.
  //
  // The three variants had drifted apart: the shared one showed no distance at
  // all, the guess-side one said "from its anchor" and left the rank out of the
  // detail line, and the round-side one printed its rank twice. Same facts in
  // the same order every time - rank first, because that is the question being
  // asked of a dot, then similarity, then how far away and from what.
  //
  // Distance means something different on each side - from the round, or from
  // the panorama the guess cloud is built around - so it now says which.
  // Similarity as a percentage. Cosine values live in a narrow band - the
  // interesting range across a board is roughly 0.85 to 0.95 - so a decimal
  // place is kept, or every tile would read 90-something percent and the
  // ordering would be invisible.
  function similarityText(value) {
    return `${(Number(value) * 100).toFixed(1)}% similar`;
  }

  function matchTooltipHeading(point, distance) {
    const roundRank = Number(point.roundRank || point.rank) || 0;
    const guessRank = Number(point.guessRank || point.rank) || 0;
    const roundSimilarity = Number(point.roundSimilarity || point.similarity) || 0;
    const guessSimilarity = Number(point.guessSimilarity || point.similarity) || 0;
    if (point.comparisonSide === "both") {
      return `<b>In both clouds</b><span>`
        + `#${roundRank} most similar to this round · ${similarityText(roundSimilarity)}<br>`
        + `#${guessRank} most similar to your guess anchor · ${similarityText(guessSimilarity)}</span>`;
    }
    if (point.comparisonSide === "guess") {
      return `<b style="color:${esc(state.guessDotColor)}">#${guessRank} most similar to your guess anchor</b>`
        + `<span>${similarityText(guessSimilarity)} · ${esc(distance)} from the anchor</span>`;
    }
    return `<b style="color:${esc(state.neighborDotColor)}">#${roundRank} most similar to this round</b>`
      + `<span>${similarityText(roundSimilarity)} · ${esc(distance)} from the round</span>`;
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
    releaseNativeStreetViews(state.matchTooltip);
    state.matchTooltipNative.length = 0;
    state.matchTooltip?.remove();
    state.matchTooltip = null;
    state.matchTooltipPoint = null;
  }

  function tooltipStillCell(label) {
    const cell = document.createElement("div");
    cell.className = "omt-match-tooltip-cell";
    const loading = document.createElement("span");
    loading.className = "omt-match-tooltip-loading-slot";
    loading.textContent = label;
    cell.appendChild(loading);
    return cell;
  }

  function prepareTooltipStills(gallery, count) {
    if (!gallery) return null;
    gallery.classList.toggle("omt-single", count === 1);
    let stills = gallery.querySelector(":scope > .omt-match-tooltip-stills");
    if (!stills) {
      stills = document.createElement("div");
      stills.className = "omt-match-tooltip-stills";
      gallery.prepend(stills);
    }
    stills.classList.toggle("omt-single", count === 1);
    stills.replaceChildren(...Array.from(
      { length: count },
      (_, slot) => tooltipStillCell(`Loading direction ${slot + 1}…`),
    ));
    return stills;
  }

  function fillTooltipStills(gallery, urls, imageLabel) {
    const stills = prepareTooltipStills(gallery, urls.length);
    if (!stills) return;
    [...stills.children].forEach((cell, slot) => {
      const loading = cell.querySelector(".omt-match-tooltip-loading-slot");
      const image = document.createElement("img");
      image.alt = `${imageLabel}, direction ${slot + 1}`;
      image.addEventListener("load", () => {
        image.classList.add("omt-loaded");
        loading?.remove();
      }, { once: true });
      image.addEventListener("error", () => {
        if (loading) loading.textContent = "Preview unavailable";
      }, { once: true });
      cell.appendChild(image);
      image.src = urls[slot];
    });
  }

  async function ensureMatchTooltipHighResolution(tooltip, point) {
    if (!tooltip?.isConnected || tooltip.dataset.nativeRequested === "true") return;
    tooltip.dataset.nativeRequested = "true";
    try {
      let row;
      if (point.current && point.panoId && Array.isArray(point.headings)) {
        row = { p: point.panoId, h: point.headings };
      } else if (Number.isFinite(point.heading) && point.panoId) {
        // Shift-to-enlarge went through the dataset too, so it failed wherever
        // the preview did. The offsets are the spawn heading plus the same ones
        // the corpus was embedded with - and how many of them is its own
        // setting, so a one-image hover can enlarge into all four.
        const offsets = state.dotShiftAllDirections ? [0, 90, 180, 270] : [0];
        row = { p: point.panoId, h: offsets.map((offset) => (point.heading + offset) % 360) };
      } else {
        const datasetKey = point.datasetKey || state.review?.datasetKey;
        const map = await portableApi.loadMap(datasetKey);
        row = map.core.panoramas[Number(point.mapIndex)];
      }
      if (!row || !tooltip.isConnected || state.matchTooltip !== tooltip) return;
      const host = tooltip.querySelector(".omt-match-tooltip-images");
      if (!host) return;
      const grid = document.createElement("div");
      grid.className = state.dotShiftAllDirections
        ? "omt-match-tooltip-native"
        : "omt-match-tooltip-native omt-single";
      const box = host.getBoundingClientRect();
      const headings = row.h.slice(0, state.dotShiftAllDirections ? 4 : 1);
      const mounts = [];
      for (const heading of headings) {
        const cell = tooltipStillCell("Loading high resolution…");
        const still = document.createElement("img");
        still.alt = `Street View heading ${heading}°`;
        still.addEventListener("load", () => {
          still.classList.add("omt-loaded");
          cell.querySelector(".omt-match-tooltip-loading-slot")?.remove();
        }, { once: true });
        still.src = fitViewToBox(
          corpusViewUrl(row.p, heading),
          box.width / (headings.length === 1 ? 1 : 2),
          box.height / (headings.length === 1 ? 1 : 2),
        );
        const live = document.createElement("div");
        live.className = "omt-native-pano";
        live.setAttribute("aria-label", `High-resolution Street View heading ${heading}°`);
        cell.append(still, live);
        grid.appendChild(cell);
        mounts.push([live, heading]);
      }
      // Put every correctly sized thumbnail cell on screen before constructing
      // the first live panorama. StreetViewPanorama creation is synchronous and
      // expensive enough that doing it inside the construction loop left only
      // the first quadrant present for several frames.
      host.appendChild(grid);
      for (const [live, heading] of mounts) {
        const panorama = mountNativeStreetView(live, row.p, heading);
        if (panorama) state.matchTooltipNative.push(panorama);
      }
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
      ? `${Math.round(point.distanceKm * 1000)} m`
      : `${point.distanceKm.toFixed(1)} km`;
    const visualHeading = matchTooltipHeading(point, distance);
    const heading = point.current
      ? `<b>This round</b><span>GeoGuessr's revealed location<br>four stored directions</span>`
      : point.family
        ? `<b>${esc(point.familyLabel || "Meta location")}</b><span>one of ${Number(point.familyMembers || 0).toLocaleString()} accepted locations<br>four stored directions</span>`
        : visualHeading;
    const footer = point.current
      ? "Hovering GeoGuessr's icon · hold Shift to enlarge · click to open this panorama ↗"
      : "Hold Shift to enlarge · click the dot to open this panorama in Google Maps ↗";
    tooltip.innerHTML = `<div class="omt-match-tooltip-head">${heading}</div><div class="omt-match-tooltip-images"></div><div class="omt-match-tooltip-foot">${footer}</div>`;
    positionMatchTooltip(tooltip, clientX, clientY);
    state.shadow.appendChild(tooltip);
    state.matchTooltip = tooltip;
    state.matchTooltipPoint = point;
    const initialDirections = state.dotPreviewAllDirections
      || (state.matchTooltipShift && state.dotShiftAllDirections) ? 4 : 1;
    prepareTooltipStills(
      tooltip.querySelector(".omt-match-tooltip-images"),
      initialDirections,
    );
    if (state.matchTooltipShift) ensureMatchTooltipHighResolution(tooltip, point);
    try {
      // /api/view is served by a map dataset. The corpus path has none, so
      // every match preview failed there and read "Preview unavailable". The
      // pack carries each panorama's own spawn heading, which is all four
      // directions need: the corpus was embedded at 0/90/180/270 from it.
      const urls = point.current && Array.isArray(point.viewUrls)
        ? point.viewUrls
        : Number.isFinite(point.heading) && point.panoId
          ? (state.dotPreviewAllDirections ? [0, 90, 180, 270] : [0])
            .map((offset) => corpusViewUrl(point.panoId, point.heading + offset))
          : await Promise.all([0, 1, 2, 3].map((slot) =>
            imageUrl(`/api/view/${point.mapIndex}/${slot}${viewSuffix(point)}`)
          ));
      if (token !== state.matchTooltipToken || !tooltip.isConnected) return;
      const imageLabel = point.current
        ? "This round"
        : point.family
          ? (point.familyLabel || "Meta location")
          : `${point.comparisonSide === "both" ? "Shared" : point.comparisonSide === "guess" ? "Guess-side" : "Round"} visual match ${point.rank}`;
      const gallery = tooltip.querySelector(".omt-match-tooltip-images");
      fillTooltipStills(gallery, urls, imageLabel);
    } catch (_error) {
      if (token === state.matchTooltipToken && tooltip.isConnected) {
        tooltip.querySelectorAll(".omt-match-tooltip-loading-slot").forEach((slot) => {
          slot.textContent = "Preview unavailable";
        });
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
        const mosaicPiece = Boolean(image.closest(".omt-board-mosaic"));
        const box = image.getBoundingClientRect();
        const resolved = await imageUrl(path);
        // Mosaic source geometry is deliberate: each 467x320 request returns
        // about 409x280, then its 36-degree view is cropped to the central 30
        // degrees. Re-fitting it to the CSS-overflowing img would change that
        // source aspect and reduce the two-row vertical coverage. Every normal
        // board, tooltip and peek image still uses the box-fitting max request.
        image.src = mosaicPiece ? resolved : fitViewToBox(resolved, box.width, box.height);
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

  function mapLike(value) {
    return Boolean(value
      && typeof value.fitBounds === "function"
      && typeof value.getBounds === "function"
      && typeof value.getDiv === "function");
  }

  function trackMap(map) {
    if (!mapLike(map)) return null;
    state.maps.add(map);
    if (map.__OMT_TRACKED) return map;
    map.__OMT_TRACKED = true;
    map.addListener?.("idle", () => {
      // Result maps in every mode can mount after the review is ready. Live
      // Challenge is especially prone to this because its compact map is a
      // separate React subtree. Paint on the first usable idle event.
      if (state.review && (state.overlays.length === 0 || state.overlayMap !== map
          || state.overlayRoundKey !== state.reviewRoundKey)
          && (state.showVisualNeighbors || state.showGuessNeighbors)) {
        showMetaOnMap(false);
      }
    });
    if (state.review && (state.showVisualNeighbors || state.showGuessNeighbors)) {
      queueMicrotask(() => {
        if (state.review && (state.overlays.length === 0 || state.overlayMap !== resultMap()
            || state.overlayRoundKey !== state.reviewRoundKey)) showMetaOnMap(false);
      });
    }
    map.addListener?.("click", (event) => {
      const latitude = event?.latLng?.lat?.();
      const longitude = event?.latLng?.lng?.();
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        if (!state.review) state.pendingPlayerGuess = { lat: latitude, lng: longitude };
        prefetchGuessSide(latitude, longitude);
      }
    });
    return map;
  }

  function reactMapFromElement(element) {
    if (!element) return null;
    const reactKey = Object.keys(element).find((name) => (
      name.startsWith("__reactFiber") || name.startsWith("__reactInternalInstance")
    ));
    let fiber = reactKey ? element[reactKey] : null;
    for (let depth = 0; fiber && depth < 12; depth += 1, fiber = fiber.return) {
      const state = fiber.memoizedState;
      const candidates = [
        fiber.stateNode,
        fiber.memoizedProps?.map,
        state?.current?.instance,
        state?.memoizedState?.current?.instance,
        fiber.updateQueue?.lastEffect?.deps?.[0],
      ];
      const effect = fiber.updateQueue?.lastEffect;
      if (effect?.next && effect.next !== effect) candidates.push(effect.next?.deps?.[0]);
      const match = candidates.find(mapLike);
      if (match) return match;
    }
    return null;
  }

  function discoverReactResultMaps() {
    // Some GeoGuessr result maps are constructed before the Google MVCObject
    // hook below is installed. The maintained Learnable Meta integration uses
    // this React-owned instance as its fallback; without it Live Challenge can
    // have a complete review and no map on which to draw it.
    const selectors = [
      '[data-qa="result-view-top"] [class*="coordinate-result-map_map"]',
      '[data-testid="round-result"] [class*="result-map"]',
      '[data-qa="round-result"] [class*="result-map"]',
      '[class*="result-map_map"]',
      '[class*="result-map"]',
    ];
    const seen = new Set();
    for (const element of document.querySelectorAll(selectors.join(","))) {
      if (seen.size >= 30) break;
      for (let candidate = element, depth = 0;
        candidate && depth < 4;
        candidate = candidate.parentElement, depth += 1) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        const map = reactMapFromElement(candidate);
        if (map) {
          trackMap(map);
          break;
        }
      }
    }
  }

  function mapCandidates() {
    discoverReactResultMaps();
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
      const resultSelector = liveChallengeAdapter.RESULT_SELECTORS.join(",");
      const aResult = a.getDiv().matches?.('[class*="result-map"]')
        || a.getDiv().querySelector?.(resultSelector) ? 1 : 0;
      const bResult = b.getDiv().matches?.('[class*="result-map"]')
        || b.getDiv().querySelector?.(resultSelector) ? 1 : 0;
      return (bResult - aResult) * 1e12 + br.width * br.height - ar.width * ar.height;
    })[0] || null;
  }

  function clearOverlays() {
    for (const overlay of state.overlays) {
      try { overlay.setMap(null); } catch (_error) {}
    }
    state.overlays = [];
    state.overlayRoundKey = "";
    state.overlayMap = null;
  }

  // ---- similarity-mass contours -------------------------------------------
  //
  // Three hundred dots at continental scale overlap into a smear, and the thing
  // that smear hides is the shape: a cloud holding 31% of its mass in one
  // region and 17% in another is a different round from one holding 80% in a
  // single place. The bands say it directly - each encloses a share of the
  // SIMILARITY MASS, not a count, so they are weighted by the same posterior
  // that steers the suggested click.
  //
  // The bandwidth is in screen pixels rather than degrees, so the cloud stays
  // coherent while zooming instead of dissolving into separate blobs.
  const MASS_BANDS = [0.95, 0.8, 0.5];
  const BAND_ALPHA = [0.13, 0.2, 0.3];
  // Everything below is allocated once. The overlay redraws on every pan frame,
  // so anything allocated per call - the field, the histogram, the offscreen
  // canvas, the segment list - is garbage collected at 60 Hz.
  // Cell size trades cost against the crispness of the isolines, and the bands
  // are smoothed on the way up anyway. 9 px keeps the look and cuts the grid to
  // 18k cells from 40k. Sigma is held at ~25 px so the cloud's shape does not
  // change with this number.
  const BAND_CELL = 9;
  const BAND_SIGMA = 25 / 9;
  const BAND_REACH = Math.ceil(BAND_SIGMA * 2.6);
  const BAND_KERNEL = (() => {
    const span = BAND_REACH * 2 + 1;
    const kernel = new Float32Array(span * span);
    const denominator = 2 * BAND_SIGMA * BAND_SIGMA;
    for (let dy = -BAND_REACH; dy <= BAND_REACH; dy += 1) {
      for (let dx = -BAND_REACH; dx <= BAND_REACH; dx += 1) {
        kernel[(dy + BAND_REACH) * span + (dx + BAND_REACH)] =
          Math.exp(-(dx * dx + dy * dy) / denominator);
      }
    }
    return kernel;
  })();
  // 4,096 buckets rather than 1,024: at 1,024 the outer band enclosed 96.7%
  // of the mass where 95% was asked for, because a bucket at the sparse end
  // holds a lot of cells. Still one linear pass, and 16 KB.
  const MASS_HISTOGRAM = new Float32Array(4096);
  let bandFieldBuffer = new Float32Array(0);
  let bandSegments = new Float32Array(4096);
  let bandCanvas = null;
  let bandImage = null;
  let bandPixels = null;

  function bandField(size) {
    if (bandFieldBuffer.length < size) bandFieldBuffer = new Float32Array(size);
    else bandFieldBuffer.fill(0, 0, size);
    return bandFieldBuffer;
  }

  function rgbOf(hex) {
    const value = String(hex || "").replace("#", "");
    const full = value.length === 3
      ? value.split("").map((c) => c + c).join("")
      : value.padEnd(6, "0").slice(0, 6);
    const number = parseInt(full, 16);
    return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
  }

  // Density values enclosing given shares of the total mass, densest first.
  //
  // One descending pass over the sorted cells: the tightest share is reached
  // first and has the highest cut, and each later share continues from there.
  // Walking the shares the other way round makes every band land on the same
  // threshold, because the running total has already passed them all.
  function massThresholds(field, total, shares) {
    // A histogram, not a sort. Sorting 40,000 cells cost 7 ms per cloud per
    // frame; bucketing them is one linear pass, and the thresholds only need to
    // be accurate to a band edge that is then smoothed and stroked anyway.
    //
    // Densest-first is still required: taking the shares the other way round
    // makes every band land on the same cut, because the running total has
    // already passed them all.
    let peak = 0;
    for (let i = 0; i < field.length; i += 1) if (field[i] > peak) peak = field[i];
    if (!(peak > 0)) return shares.map(() => Infinity);
    const buckets = MASS_HISTOGRAM.length;
    const mass = MASS_HISTOGRAM;
    mass.fill(0);
    const scale = (buckets - 1) / peak;
    for (let i = 0; i < field.length; i += 1) {
      const value = field[i];
      if (value > 0) mass[(value * scale) | 0] += value;
    }
    const ascending = [...shares].sort((a, b) => a - b);
    const cuts = [];
    let running = 0;
    let bucket = buckets - 1;
    for (const share of ascending) {
      const want = share * total;
      while (bucket > 0 && running < want) {
        running += mass[bucket];
        bucket -= 1;
      }
      cuts.push(bucket / scale);
    }
    return cuts;
  }


  // Isolines for one threshold, by marching squares over the density grid.
  //
  // The filled bands alone read as a heatmap: smoothing blurs the three levels
  // into one gradient and the boundaries - the informative part, since each is
  // a stated share of the mass - disappear. A stroked line puts them back.
  function isolineSegments(field, columns, rows, threshold) {
    // Marching squares, written to a reused flat buffer.
    //
    // The first version built four closures and a fifteen-entry object literal
    // per cell - 40,000 cells x 3 thresholds x 2 clouds, every frame - which
    // cost 8 ms a cloud in allocation alone. Same output, no allocation.
    let count = 0;
    const push = (ax, ay, bx, by) => {
      if (count + 4 > bandSegments.length) {
        const grown = new Float32Array(bandSegments.length * 2);
        grown.set(bandSegments);
        bandSegments = grown;
      }
      bandSegments[count] = ax;
      bandSegments[count + 1] = ay;
      bandSegments[count + 2] = bx;
      bandSegments[count + 3] = by;
      count += 4;
    };
    for (let y = 0; y < rows - 1; y += 1) {
      const row = y * columns;
      const next = row + columns;
      for (let x = 0; x < columns - 1; x += 1) {
        const tl = field[row + x];
        const tr = field[row + x + 1];
        const br = field[next + x + 1];
        const bl = field[next + x];
        const code = (tl >= threshold ? 8 : 0) | (tr >= threshold ? 4 : 0)
          | (br >= threshold ? 2 : 0) | (bl >= threshold ? 1 : 0);
        if (code === 0 || code === 15) continue;
        // crossing positions along each edge, computed only where used
        const topX = x + (threshold - tl) / ((tr - tl) || 1e-9);
        const bottomX = x + (threshold - bl) / ((br - bl) || 1e-9);
        const leftY = y + (threshold - tl) / ((bl - tl) || 1e-9);
        const rightY = y + (threshold - tr) / ((br - tr) || 1e-9);
        switch (code) {
          case 1: case 14: push(x, leftY, bottomX, y + 1); break;
          case 2: case 13: push(bottomX, y + 1, x + 1, rightY); break;
          case 3: case 12: push(x, leftY, x + 1, rightY); break;
          case 4: case 11: push(topX, y, x + 1, rightY); break;
          case 6: case 9: push(topX, y, bottomX, y + 1); break;
          case 7: case 8: push(x, leftY, topX, y); break;
          case 5: push(x, leftY, topX, y); push(bottomX, y + 1, x + 1, rightY); break;
          case 10: push(x, leftY, bottomX, y + 1); push(topX, y, x + 1, rightY); break;
          default: break;
        }
      }
    }
    return count;
  }


  function drawMassBands(context, width, height, samples, hex, intensity = 1) {
    // Below a handful of points a density estimate says more about the
    // bandwidth than about the data, so draw nothing and let the dots speak.
    if (!samples.length || samples.length < 12 || width < 8 || height < 8) return;
    if (!(intensity > 0)) return;
    const columns = Math.ceil(width / BAND_CELL);
    const rows = Math.ceil(height / BAND_CELL);
    const field = bandField(columns * rows);
    // The kernel is the same every frame, so it is computed once and looked up
    // rather than calling Math.exp ~160,000 times per cloud per frame. Samples
    // land on the nearest cell centre; at this cell size that is under 4 px of
    // positional rounding, invisible under a 25 px smoothing kernel.
    const reach = BAND_REACH;
    const span = reach * 2 + 1;
    let total = 0;
    for (const sample of samples) {
      const gx0 = Math.round(sample.x / BAND_CELL);
      const gy0 = Math.round(sample.y / BAND_CELL);
      const weight = sample.weight;
      const top = Math.max(-reach, -gy0);
      const bottom = Math.min(reach, rows - 1 - gy0);
      const left = Math.max(-reach, -gx0);
      const right = Math.min(reach, columns - 1 - gx0);
      for (let dy = top; dy <= bottom; dy += 1) {
        const rowStart = (gy0 + dy) * columns + gx0;
        const kernelRow = (dy + reach) * span + reach;
        for (let dx = left; dx <= right; dx += 1) {
          const value = weight * BAND_KERNEL[kernelRow + dx];
          field[rowStart + dx] += value;
          total += value;
        }
      }
    }
    if (!(total > 0)) return;
    const [inner, middle, outer] = massThresholds(field, total, MASS_BANDS);
    const [r, g, b] = rgbOf(hex);
    if (!bandCanvas || bandCanvas.width !== columns || bandCanvas.height !== rows) {
      bandCanvas = document.createElement("canvas");
      bandCanvas.width = columns;
      bandCanvas.height = rows;
      bandImage = bandCanvas.getContext("2d").createImageData(columns, rows);
      bandPixels = new Uint32Array(bandImage.data.buffer);
    }
    const image = bandImage;
    const pixels = bandPixels;
    pixels.fill(0);
    // One 32-bit store per cell rather than four byte stores. Endianness is
    // handled by packing little-endian ABGR, which is what a Uint32 view over
    // ImageData is on every platform this runs on.
    const rgb = (b << 16) | (g << 8) | r;
    const shades = [
      ((Math.round(BAND_ALPHA[0] * intensity * 255) << 24) | rgb) >>> 0,
      ((Math.round(BAND_ALPHA[1] * intensity * 255) << 24) | rgb) >>> 0,
      ((Math.round(BAND_ALPHA[2] * intensity * 255) << 24) | rgb) >>> 0,
    ];
    const cells = columns * rows;
    for (let i = 0; i < cells; i += 1) {
      const value = field[i];
      if (value < outer) continue;
      pixels[i] = value >= inner ? shades[2] : value >= middle ? shades[1] : shades[0];
    }
    bandCanvas.getContext("2d").putImageData(image, 0, 0);
    context.save();
    context.imageSmoothingEnabled = true;      // smooth bands, not visible cells
    context.imageSmoothingQuality = "high";
    context.drawImage(bandCanvas, 0, 0, width, height);
    context.restore();

    // and the boundaries themselves, so each band is legible as a line
    const scaleX = width / columns;
    const scaleY = height / rows;
    context.save();
    context.lineJoin = "round";
    [[middle, 0.46 * intensity, 0.9], [inner, 0.7 * intensity, 1.1]].forEach(
      ([threshold, alpha, lineWidth]) => {
        const count = isolineSegments(field, columns, rows, threshold);
        if (!count) return;
        context.beginPath();
        for (let i = 0; i < count; i += 4) {
          context.moveTo((bandSegments[i] + 0.5) * scaleX, (bandSegments[i + 1] + 0.5) * scaleY);
          context.lineTo((bandSegments[i + 2] + 0.5) * scaleX, (bandSegments[i + 3] + 0.5) * scaleY);
        }
        context.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        context.lineWidth = lineWidth;
        context.stroke();
      });
    context.restore();
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
            // the panorama's own spawn heading, so a preview can be built
            // without a dataset behind /api/view
            heading: Number.isFinite(Number(value.heading)) ? Number(value.heading) : null,
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
            button.removeAttribute("title");
            button.setAttribute("aria-label",
              "This round — hover to preview; click to open Street View");
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
          // Bands first, so the dots sit on top of their own distribution.
          // Round-side and guess-side are separate fields in their own colours:
          // two clouds compared is the whole point of the guess comparison.
          const roundSamples = [];
          const guessSamples = [];
          for (const point of this.points) {
            const pixel = viewportPoint(point);
            if (pixel.x < -60 || pixel.x > width + 60
              || pixel.y < -60 || pixel.y > height + 60) continue;
            const rank = Number(point.roundRank || point.rank || 0);
            const guessRank = Number(point.guessRank || point.rank || 0);
            if (point.comparisonSide !== "guess") {
              roundSamples.push({
                x: pixel.x,
                y: pixel.y,
                weight: Number(point.roundPosteriorWeight || point.posteriorWeight)
                  || 1 / (rank + 10),
              });
            }
            if (point.comparisonSide === "guess" || point.comparisonSide === "both") {
              guessSamples.push({
                x: pixel.x,
                y: pixel.y,
                weight: Number(point.posteriorWeight) || 1 / (guessRank + 10),
              });
            }
          }
          drawMassBands(context, width, height, roundSamples, state.neighborDotColor,
            state.bandIntensity);
          drawMassBands(context, width, height, guessSamples, state.guessDotColor,
            state.bandIntensity);

          // Dots are a layer like the bands: with them off the map shows the
          // shape of the distribution and nothing else. The hit targets go with
          // them, since an invisible dot is not something to hover.
          for (const point of state.showDots ? rankedPoints : []) {
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
            // No `title`: the browser's own tooltip duplicates the preview
            // panel this script shows on hover, and drifts in over the top of
            // it. The aria-label carries the same text for screen readers
            // without rendering anything.
            button.removeAttribute("title");
            button.setAttribute("aria-label",
              `${side} visual match — preview; click to open Street View`);
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
              button.removeAttribute("title");
              button.setAttribute("aria-label",
                `${visiblePoint.point.familyLabel || "Meta location"} — preview; click to open Street View`);
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

  // Google Maps' Marker `clickable: false` still owns a mouse target in some
  // renderer/browser combinations. That invisible hit region covered nearby
  // panorama buttons whenever the recommended click landed on a dot. Draw the
  // same icon in a pointer-transparent OverlayView instead: visually above the
  // cloud, but completely absent from hit testing.
  function passiveMapIcon(maps, map, position, icon, label, zIndex = 1000) {
    if (!maps?.OverlayView || !map || !position || !icon?.url) return null;
    class PassiveIconOverlay extends maps.OverlayView {
      constructor() {
        super();
        this.image = null;
        this.setMap(map);
      }
      onAdd() {
        this.image = document.createElement("img");
        this.image.src = icon.url;
        this.image.alt = "";
        this.image.setAttribute("aria-hidden", "true");
        this.image.dataset.omtPassiveMapIcon = label || "recommendation";
        this.image.style.cssText = `position:absolute;pointer-events:none;user-select:none;z-index:${zIndex};`;
        const width = Number(icon.scaledSize?.width || icon.size?.width) || 32;
        const height = Number(icon.scaledSize?.height || icon.size?.height) || 32;
        this.image.style.width = `${width}px`;
        this.image.style.height = `${height}px`;
        (this.getPanes().overlayMouseTarget || this.getPanes().overlayLayer)
          .appendChild(this.image);
      }
      draw() {
        if (!this.image) return;
        const point = this.getProjection()?.fromLatLngToDivPixel(
          new maps.LatLng(position.lat, position.lng),
        );
        if (!point) return;
        const width = Number(icon.scaledSize?.width || icon.size?.width) || 32;
        const height = Number(icon.scaledSize?.height || icon.size?.height) || 32;
        const anchorX = Number(icon.anchor?.x);
        const anchorY = Number(icon.anchor?.y);
        this.image.style.left = `${point.x - (Number.isFinite(anchorX) ? anchorX : width / 2)}px`;
        this.image.style.top = `${point.y - (Number.isFinite(anchorY) ? anchorY : height / 2)}px`;
      }
      onRemove() {
        this.image?.remove();
        this.image = null;
      }
    }
    return new PassiveIconOverlay();
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
    if (!map || !context || !maps) {
      state.diagnostics.rendering = {
        status: "waiting-for-map",
        googleMaps: Boolean(maps),
        context: Boolean(context),
        trackedMaps: state.maps.size,
        eligibleMaps: mapCandidates().length,
        overlays: state.overlays.length,
        at: new Date().toISOString(),
      };
      state.diagnostics.updatedAt = Date.now();
      return;
    }
    clearOverlays();
    state.overlayMap = map;
    state.overlayRoundKey = state.review ? state.reviewRoundKey : "fast-neighborhood";
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
    // The row holds 300; this draws the strongest `matchCount` of them. Slicing
    // here rather than at fetch time means the setting applies instantly to a
    // round already on screen, with nothing to re-request or re-cache.
    const shown = state.matchCount;
    const visualMatches = state.showVisualNeighbors
      ? (context.visualNeighborhood?.visualMatches || []).slice(0, shown)
      : [];
    // Independent of the round layer: the guess cloud used to be drawn only
    // when the round cloud was on, so "guess alone" could not be shown at all.
    const guessComparison = state.showGuessNeighbors ? state.guessNeighborhood : null;
    const guessMatches = (guessComparison?.visualNeighborhood?.visualMatches || [])
      .slice(0, shown);
    if (visualMatches.length || guessMatches.length) {
      const combined = new Map();
      // The core cannot exceed what is drawn: at a small count every dot shown
      // is a close match, and marking none of them as core would be wrong.
      const coreCount = Math.min(
        Number(context.visualNeighborhood?.coreCount) || Math.min(50, visualMatches.length),
        visualMatches.length,
      );
      const matchIdentity = (match) => match.panoId
        ? `pano:${match.panoId}`
        : `row:${match.mapIndex}`;
      for (const match of visualMatches) {
        combined.set(matchIdentity(match), {
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
        const identity = matchIdentity(match);
        const existing = combined.get(identity);
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
          combined.set(identity, {
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
    if (expected) {
      const marker = passiveMapIcon(
        maps,
        map,
        { lat: expected.a, lng: expected.o },
        icons.ideal,
        `Ideal average-score click: ${expected.n || "map coordinate"}`,
        1000,
      );
      if (marker) state.overlays.push(marker);
      bounds.extend({ lat: expected.a, lng: expected.o });
    }
    const neighborClick = state.showVisualNeighbors
      ? context.visualNeighborhood?.weightedClick
      : null;
    if (neighborClick) {
      const marker = passiveMapIcon(
        maps,
        map,
        { lat: neighborClick.latitude, lng: neighborClick.longitude },
        icons.neighborsIdeal,
        `${context.cloud ? "Exact C-RADIO" : "Adaptive visual"} click${Number.isFinite(neighborClick.expectedScore) ? ` · ${Math.round(neighborClick.expectedScore).toLocaleString()} expected points` : ""}`,
        1001,
      );
      if (marker) state.overlays.push(marker);
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
    state.diagnostics.rendering = {
      status: state.overlays.length ? "complete" : "empty",
      trackedMaps: state.maps.size,
      eligibleMaps: mapCandidates().length,
      requestedRoundMatches: visualMatches.length,
      requestedGuessMatches: guessMatches.length,
      overlays: state.overlays.length,
      roundKey: state.overlayRoundKey || null,
      currentMap: state.overlayMap === resultMap(),
      fit: Boolean(fit),
      at: new Date().toISOString(),
    };
    state.diagnostics.updatedAt = Date.now();
  }

  // Warm what the guess-side cloud will need, from a pin that may still move.
  //
  // Only the fetches are done here, never the drawing: the guess is not final
  // until the round ends, and a moved pin simply warms a different chunk. The
  // work is idempotent and cached, so repeated clicks cost nothing after the
  // first in a neighbourhood.
  function prefetchGuessSide(latitude, longitude, options = {}) {
    const pack = pageWindow.LodestarPack || window.LodestarPack;
    if (!pack?.nearest) return;
    const key = `${latitude.toFixed(3)},${longitude.toFixed(3)}`;
    const immediate = options.immediate === true;
    if (state.guessPrefetchKey === key && state.guessPrefetchPromise) return;
    if (state.guessPrefetchKey === key && !immediate && state.guessPrefetchTimer) return;
    state.guessPrefetchKey = key;
    window.clearTimeout(state.guessPrefetchTimer);
    state.guessPrefetchTimer = 0;
    const warm = () => {
      state.guessPrefetchTimer = 0;
      let pending;
      pending = (async () => {
        if (pack.prefetchNearbyVisual) {
          await pack.prefetchNearbyVisual(latitude, longitude, {
            minimumKm: 10,
            targetCandidates: 160,
            maximumKm: 100,
          });
          return;
        }
        const anchor = await pack.nearest(latitude, longitude, { withinKm: 100 });
        if (!anchor) return;
        // pulls the anchor's row range into the cache, which is the slow part
        await pack.query(anchor.panoId, 300);
      })().catch(() => {
        // a warm that fails costs nothing; the real load will try again
      }).finally(() => {
        if (state.guessPrefetchPromise === pending) state.guessPrefetchPromise = null;
      });
      state.guessPrefetchPromise = pending;
    };
    if (immediate) warm();
    else state.guessPrefetchTimer = window.setTimeout(warm, 250);
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
        if (typeof this.setZoom === "function") trackMap(this);
        return result;
      };
    }, 10);
  }

  function clearReviewArtifacts(reason = "next-round") {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = 0;
    flushVisualExposure(reason);
    state.review = null;
    state.reviewRoundKey = "";
    state.fastNeighborhood = null;
    state.guessNeighborhood = null;
    state.guessNeighborhoodRoundKey = "";
    state.guessNeighborhoodPromise = null;
    state.guessNeighborhoodPromiseKey = "";
    state.active = 0;
    state.detail.clear();
    state.drawerOpen = false;
    state.visualBoard = null;
    state.visualBoardRoundKey = "";
    state.visualBoardKey = null;
    state.visualBoardPromise = null;
    state.visualBoardWarmPromise = null;
    state.visualBoardMode = "consensus";
    state.visualBoardOpen = false;
    state.visualBoardModifierCleanup?.();
    state.visualBoardModifierCleanup = null;
    state.roundIdentity = null;
    state.diagnostics.guessLookup = null;
    state.diagnostics.boardImagery = null;
    state.diagnostics.rendering = null;
    clearOverlays();
    restoreMapView();
    releaseImages();
    state.root?.remove();
    state.root = null;
    state.shadow = null;
  }

  function clearRound() {
    state.requestToken += 1;
    clearReviewArtifacts("next-round");
    state.round = null;
    state.playerGuess = null;
    state.pendingPlayerGuess = null;
    state.lastRoundEventState = null;
    state.roundRequestKey = "";
    state.roundRequestQuality = -1;
    state.diagnostics.round = null;
    state.diagnostics.retrieval = null;
    diagnosticPhase("round-in-progress", { lastError: null });
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
    if (token === state.requestToken && state.review && state.showVisualNeighbors
        && state.overlays.length === 0) {
      state.diagnostics.rendering = {
        status: "map-not-ready-after-eager-retries",
        trackedMaps: state.maps.size,
        eligibleMaps: mapCandidates().length,
        overlays: 0,
        at: new Date().toISOString(),
      };
      state.diagnostics.updatedAt = Date.now();
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
    const reviewRoundKey = state.reviewRoundKey;
    const guess = state.playerGuess;
    if (!review || !reviewRoundKey || !guess) return null;
    if (state.guessNeighborhood && state.guessNeighborhoodRoundKey === reviewRoundKey) {
      // The board may have warmed this while the map layer was hidden. If the
      // player later enables the layer, use that cached result immediately.
      if (state.showGuessNeighbors) {
        render();
        showMetaOnMap(false);
      }
      return state.guessNeighborhood;
    }
    if (state.guessNeighborhoodPromise
        && state.guessNeighborhoodPromiseKey === reviewRoundKey) {
      return state.guessNeighborhoodPromise;
    }
    state.guessNeighborhood = null;
    state.guessNeighborhoodRoundKey = "";
    const guessLookupStarted = Date.now();
    state.diagnostics.guessLookup = {
      status: "loading",
      durationMs: null,
      matches: 0,
      timing: null,
      error: null,
      at: new Date().toISOString(),
    };

    // This data has two independent consumers: the optional guess map overlay
    // and the always-useful comparison-board tile. Load it once and let either
    // consumer use it; visibility must never control whether it exists.
    let pending;
    pending = (async () => {
      try {
        let comparison;
        if (review.universal) {
          // Corpus path: no dataset to query, so the pack answers directly.
          comparison = await cradioClient.guessNeighborhood(
            guess,
            { sourceMapKey: review.sourceMapKey, roundPanoId: review.location?.panoId },
            review.visualNeighborhood?.visualMatches || [],
          );
        } else {
          const query = new URLSearchParams({
            dataset: review.datasetKey,
            guess_lat: guess.lat,
            guess_lng: guess.lng,
          });
          comparison = await request(
            `/api/guess-neighborhood/${review.location.mapIndex}?${query}`,
          );
        }
        if (token !== state.requestToken || state.review !== review
            || state.reviewRoundKey !== reviewRoundKey) return null;
        if (!comparison) {
          state.diagnostics.guessLookup = {
            ...state.diagnostics.guessLookup,
            status: "unavailable",
            durationMs: Date.now() - guessLookupStarted,
          };
          return null;
        }
        state.guessNeighborhood = comparison;
        state.guessNeighborhoodRoundKey = reviewRoundKey;
        state.diagnostics.guessLookup = {
          ...state.diagnostics.guessLookup,
          status: "complete",
          durationMs: Date.now() - guessLookupStarted,
          matches: comparison.visualNeighborhood?.visualMatches?.length || 0,
          timing: comparison.guessTiming || null,
        };
        // A corpus board built before this lookup completed is incomplete. Make
        // the next render rebuild it with the near-guess tile in slot two.
        if (review.universal && state.visualBoard?.panoId === review.location?.panoId) {
          state.visualBoard = null;
          state.visualBoardRoundKey = "";
        }
        if (state.showGuessNeighbors) {
          render();
          showMetaOnMap(false);
        }
        return comparison;
      } catch (error) {
        if (token === state.requestToken && state.review === review
            && state.reviewRoundKey === reviewRoundKey) {
          state.diagnostics.guessLookup = {
            ...state.diagnostics.guessLookup,
            status: "failed",
            durationMs: Date.now() - guessLookupStarted,
            error: String(error?.message || error).slice(0, 240),
          };
        }
        console.error(
          review.universal
            ? "Meta Trainer: could not load guess-side cloud"
            : "Meta Trainer: could not load guess-side visual neighborhood",
          error,
        );
        return null;
      } finally {
        if (state.guessNeighborhoodPromise === pending) {
          state.guessNeighborhoodPromise = null;
          state.guessNeighborhoodPromiseKey = "";
        }
      }
    })();
    state.guessNeighborhoodPromise = pending;
    state.guessNeighborhoodPromiseKey = reviewRoundKey;
    return pending;
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

  function rememberLiveChallengeGuess(challengeId, roundNumber, guess) {
    const record = liveChallengeAdapter.storedGuessRecord(
      challengeId,
      roundNumber,
      guess,
    );
    if (!record) return null;
    try {
      pageWindow.sessionStorage.setItem(LIVE_GUESS_SESSION_KEY, JSON.stringify(record));
    } catch (_error) {}
    return record.guess;
  }

  function rememberedLiveChallengeGuess(challengeId, roundNumber) {
    try {
      return liveChallengeAdapter.restoredGuess(
        pageWindow.sessionStorage.getItem(LIVE_GUESS_SESSION_KEY),
        challengeId,
        roundNumber,
        { maxAgeMs: LIVE_GUESS_MAX_AGE_MS },
      );
    } catch (_error) {
      return null;
    }
  }

  async function liveChallengeProfileId() {
    if (state.liveChallengeProfileId) return state.liveChallengeProfileId;
    if (state.liveChallengeProfilePromise) return state.liveChallengeProfilePromise;
    state.liveChallengeProfilePromise = pageFetch(
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

  async function fetchLiveChallengeState(challengeId) {
    const dataPromise = pageFetch(
      `https://game-server.geoguessr.com/api/live-challenge/${encodeURIComponent(challengeId)}`,
      { method: "GET", credentials: "include", cache: "no-store" }
    ).then(async (response) => {
      if (!response.ok) throw new Error(`Live Challenge returned ${response.status}`);
      return response.json();
    });
    const [data, profileId] = await Promise.all([
      dataPromise,
      liveChallengeProfileId(),
    ]);
    const lifecycle = liveChallengeAdapter.lifecycle(data, profileId);
    state.liveChallengeChallengeId = challengeId;
    state.liveChallengeAnnouncedRound = lifecycle.announcedRound;
    const storedGuess = rememberedLiveChallengeGuess(challengeId, lifecycle.announcedRound);
    const pendingMatch = state.pendingPlayerGuess
      ? liveChallengeAdapter.matchingGuess(data, lifecycle.announcedRound, state.pendingPlayerGuess)
      : null;
    const round = normalizedLiveChallengeRound(data, challengeId, profileId);
    const apiGuess = round?.playerGuess || null;
    const recoveredGuess = pendingMatch || storedGuess;
    if (round && !round.playerGuess && recoveredGuess) round.playerGuess = recoveredGuess;
    const guessSource = apiGuess
      ? "api"
      : pendingMatch ? "submitted-match" : storedGuess ? "session" : null;
    return {
      data,
      profileId,
      lifecycle: recoveredGuess
        ? { ...lifecycle, guessedRound: lifecycle.announcedRound, phase: "result" }
        : lifecycle,
      round,
      activeRound: liveChallengeAdapter.normalizeActiveRound(data, challengeId),
      pendingMatch,
      storedGuess,
      guessSource,
    };
  }

  function liveChallengeResultMounted() {
    return liveChallengeAdapter.resultMounted(document);
  }

  function initializeLiveChallengeAdapter() {
    let trackedChallenge = null;
    let checkQueued = false;
    let lookupInFlight = false;
    let checkAfterLookup = false;
    let lastPrewarmedRoundKey = "";
    let queueCheck = () => {};

    const captureSubmittedGuess = (url, body) => {
      const challengeId = liveChallengeIdFromUrl(url);
      if (!challengeId) return;
      const guess = liveChallengeAdapter.submittedGuess(body);
      if (!guess) return;
      state.pendingPlayerGuess = guess;
      if (state.liveChallengeChallengeId === challengeId) {
        rememberLiveChallengeGuess(challengeId, state.liveChallengeAnnouncedRound, guess);
      }
      state.guessPrefetchKey = "";
      prefetchGuessSide(guess.lat, guess.lng, { immediate: true });
      queueCheck();
    };

    const trackResource = (url) => {
      if (!PARTY_LOBBY_PATH.test(location.pathname)) return;
      const id = liveChallengeIdFromUrl(url);
      if (id) {
        trackedChallenge = { id, partyLobbyPath: location.pathname };
        queueCheck();
      }
    };

    for (const entry of performance.getEntriesByType("resource")) trackResource(entry.name);
    if (typeof PerformanceObserver !== "undefined") {
      const resourceObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) trackResource(entry.name);
      });
      resourceObserver.observe({ entryTypes: ["resource"] });
    }

    // Resource Timing can omit cross-origin names in privacy-hardened browsers.
    // Observe request URLs directly as a passive fallback; bodies, responses,
    // party tokens and credentials remain untouched.
    if (!pageWindow.__OMT_LIVE_REQUEST_TRACKING) {
      pageWindow.__OMT_LIVE_REQUEST_TRACKING = true;
      const originalFetch = pageWindow.fetch;
      if (typeof originalFetch === "function") {
        try {
          pageWindow.fetch = function (input, init) {
            const url = typeof input === "string" ? input : input?.url;
            trackResource(url);
            captureSubmittedGuess(url, init?.body);
            if (!init?.body && typeof input?.clone === "function") {
              input.clone().text().then((body) => captureSubmittedGuess(url, body)).catch(() => {});
            }
            const request = originalFetch.call(this, input, init);
            request.finally(queueCheck).catch(() => {});
            return request;
          };
        } catch (_error) {
          // PerformanceObserver remains available when a browser locks fetch.
        }
      }
      const xhr = pageWindow.XMLHttpRequest?.prototype;
      if (xhr?.open) {
        const originalOpen = xhr.open;
        try {
          xhr.open = function (method, url, ...args) {
            this.__OMT_LIVE_URL = url;
            trackResource(url);
            return originalOpen.call(this, method, url, ...args);
          };
          const originalSend = xhr.send;
          if (originalSend) {
            xhr.send = function (body) {
              captureSubmittedGuess(this.__OMT_LIVE_URL, body);
              const result = originalSend.call(this, body);
              this.addEventListener?.("loadend", queueCheck, { once: true });
              return result;
            };
          }
        } catch (_error) {
          // PerformanceObserver remains available when XHR is non-writable.
        }
      }
    }

    const checkResult = async () => {
      checkQueued = false;
      const challengeId = liveChallengeIdForPage(trackedChallenge);
      if (!challengeId) return;
      if (lookupInFlight) {
        checkAfterLookup = true;
        return;
      }
      lookupInFlight = true;
      try {
        const liveState = await fetchLiveChallengeState(challengeId);
        const resultMount = liveChallengeAdapter.resultMountStatus(document);
        const mounted = resultMount.mounted;
        const apiResult = liveState.lifecycle.phase === "result";
        const apiPlaying = liveState.lifecycle.guessedRound > 0
          && liveState.lifecycle.guessedRound < liveState.lifecycle.announcedRound;
        // In a private party, the API records this player's guess immediately,
        // while GeoGuessr can still be showing "waiting for all players". That
        // is not an authoritative round end: exposing the recommendation or
        // comparison board then can help another player who is still guessing.
        // The visible result map is the safe boundary. The one-second poll
        // below will build the review as soon as GeoGuessr mounts it.
        const partyAwaitingResult = PARTY_LOBBY_PATH.test(location.pathname) && !mounted;
        state.diagnostics.liveChallenge = {
          challengeId,
          announcedRound: liveState.lifecycle.announcedRound,
          guessedRound: liveState.lifecycle.guessedRound,
          phase: apiResult ? "result" : apiPlaying ? "playing" : "unknown",
          visibleResult: mounted,
          resultCandidates: resultMount.candidates,
          connectedResultCandidates: resultMount.connected,
          largestResultCandidate: {
            width: resultMount.largestWidth,
            height: resultMount.largestHeight,
          },
          hasProfileId: Boolean(liveState.profileId),
          hasPendingGuess: Boolean(state.pendingPlayerGuess),
          matchedPendingGuess: Boolean(liveState.pendingMatch),
          hasStoredGuess: Boolean(liveState.storedGuess),
          guessSource: liveState.guessSource,
          at: new Date().toISOString(),
        };
        if (apiPlaying || partyAwaitingResult || (!apiResult && !mounted)) {
          state.liveChallengeResultVisible = false;
          state.liveChallengePendingKey = "";
          if (state.roundRequestKey || state.review || state.root || state.visualBoard
              || state.guessNeighborhood || state.overlays.length) clearRound();
          const activeRound = liveState.activeRound;
          if (activeRound?.location) {
            if (activeRound.location.panoId) {
              prefetchModalForMap(activeRound.location.panoId, {
                latitude: activeRound.location.lat,
                longitude: activeRound.location.lng,
                sourceMapKey: activeRound.mapId,
                datasetKey: "balanced-world-50k",
              });
            }
            warmMapForRound({ mapId: activeRound.mapId });
            lastPrewarmedRoundKey = activeRound.roundKey;
          }
          return;
        }
        state.liveChallengeResultVisible = true;
        const liveRound = liveState.round;
        if (!liveRound) return;
        const expectedRequestKey = reviewRequestKey(
          liveRound.roundNumber,
          liveRound.location,
        );
        if (liveRound.roundKey !== lastPrewarmedRoundKey) {
          // If the active-round warm missed, the authoritative result fetch is
          // still fed through the same cache before the review is assembled.
          prefetchModalForMap(liveRound.location.panoId, {
            latitude: liveRound.location.lat,
            longitude: liveRound.location.lng,
            sourceMapKey: liveRound.mapId,
            datasetKey: "balanced-world-50k",
          });
          lastPrewarmedRoundKey = liveRound.roundKey;
        }
        if (liveRound.roundKey === state.liveChallengePendingKey) return;
        if (liveRound.roundKey === state.liveChallengeLastRoundKey
            && reviewMatchesRequest(expectedRequestKey, liveRound.location.panoId)) {
          // GeoGuessr can replace the entire Live result subtree without a new
          // round. Reattach the trainer and repaint its overlays rather than
          // treating the already-processed round as permanently finished.
          if (!state.root?.isConnected) render();
          const map = resultMap();
          if ((state.overlays.length === 0 || state.overlayMap !== map
              || state.overlayRoundKey !== state.reviewRoundKey)
              && (state.showVisualNeighbors || state.showGuessNeighbors)) {
            showMetaOnMap(false);
          }
          return;
        }
        if (liveRound.roundKey === state.liveChallengeLastRoundKey) {
          // A completed lookup that left no review is recoverable. Permit the
          // shared pipeline to rebuild it on the next authoritative poll.
          state.roundRequestKey = "";
          state.roundRequestQuality = -1;
        }
        state.liveChallengePendingKey = liveRound.roundKey;
        const outcome = await handleRoundEnd(
          liveChallengeAdapter.buildEventState(liveRound, challengeId),
        );
        if (liveChallengeAdapter.outcomeCompletesRound(
          outcome,
          state.review,
          state.reviewRoundKey,
          expectedRequestKey,
          liveRound.location.panoId,
        )) {
          state.liveChallengeLastRoundKey = liveRound.roundKey;
        } else {
          window.setTimeout(queueCheck, outcome?.status === "pending" ? 120 : 650);
        }
      } catch (error) {
        console.error("Meta Trainer: Live Challenge round lookup failed", error);
        diagnosticError(error, "live-challenge-round-lookup");
        window.setTimeout(queueCheck, 650);
      } finally {
        lookupInFlight = false;
        state.liveChallengePendingKey = "";
        if (checkAfterLookup) {
          checkAfterLookup = false;
          queueCheck();
        }
      }
    };

    queueCheck = () => {
      if (checkQueued) return;
      checkQueued = true;
      window.setTimeout(checkResult, 40);
    };
    const observer = new MutationObserver(queueCheck);
    const begin = () => {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "data-qa", "data-testid"],
      });
      queueCheck();
      window.setInterval(queueCheck, 1000);
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
    const reviewStartedAt = Date.now();
    const rounds = eventState?.rounds || [];
    const round = rounds[rounds.length - 1];
    if (!round?.location) return { status: "unavailable" };
    const requestPanoId = decodedPanoId(round.location.panoId);
    const requestKey = reviewRequestKey(rounds.length, round.location);
    const rawRequestGuess = round.player_guess || round.playerGuess || round.guess;
    const requestQuality = 1
      + (rawRequestGuess ? 2 : 0)
      + (Number.isFinite(Number(round.score?.amount ?? round.score)) ? 1 : 0)
      + (Number.isFinite(Number(round.distance?.meters?.amount ?? round.distanceMeters)) ? 1 : 0);
    if (state.roundRequestKey === requestKey && state.roundRequestQuality >= requestQuality) {
      return reviewMatchesRequest(requestKey, requestPanoId)
        ? { status: "ready", requestKey }
        : { status: "pending", requestKey };
    }
    // Duplicate round_end signals are normal: the event framework and Live
    // adapter can both report the same completed round. Do not invalidate the
    // useful request already in flight until this event has passed the quality
    // gate. Previously an equal/lower-quality duplicate incremented the token,
    // returned here, and caused the original result to be discarded as stale.
    const previousRequestKey = state.roundRequestKey;
    const token = ++state.requestToken;
    if (requestKey !== previousRequestKey && requestKey !== state.reviewRoundKey) {
      // round_start is not reliable in private-party Live Challenges. A new
      // authoritative result therefore invalidates every old visual artifact
      // before lookup begins, so a slow/failing request can never leave the
      // previous round's dots, recommendation, or V board visible.
      clearReviewArtifacts("new-round-result");
    } else {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = 0;
    }
    state.roundRequestKey = requestKey;
    state.roundRequestQuality = requestQuality;
    state.lastRoundEventState = eventState;
    state.round = rounds.length;
    const rawGuess = round.player_guess || round.playerGuess || round.guess
      || state.pendingPlayerGuess;
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
    const cloudPanoId = requestPanoId;
    if (cloudPanoId) params.set("pano_id", cloudPanoId);
    if (Number.isFinite(round.location.lat)) params.set("lat", round.location.lat);
    if (Number.isFinite(round.location.lng)) params.set("lng", round.location.lng);
    if (datasetKey) params.set("map_key", datasetKey);
    const roundScore = Number(round.score?.amount);
    const roundDistanceM = Number(round.distance?.meters?.amount);
    if (Number.isFinite(roundScore)) params.set("round_score", roundScore);
    if (Number.isFinite(roundDistanceM)) params.set("round_distance_m", roundDistanceM);
    const cloudConfigured = cradioClient.configured();
    const packAvailable = Boolean(pageWindow.LodestarPack || window.LodestarPack);
    diagnosticPhase("round-ended", {
      eventSource: LIVE_CHALLENGE_PATH.test(location.pathname) || PARTY_LOBBY_PATH.test(location.pathname)
        ? "live-challenge" : "standard",
      lastError: null,
    });
    state.diagnostics.round = {
      number: rounds.length,
      panoId: cloudPanoId || null,
      datasetKey: datasetKey || null,
      hasGuess: Boolean(state.playerGuess),
      hasCoordinates: Number.isFinite(round.location.lat) && Number.isFinite(round.location.lng),
    };
    state.diagnostics.retrieval = {
      status: "starting",
      packLoaded: packAvailable,
      modalConfigured: cloudConfigured,
      knownMap: null,
      source: null,
      requestedMatches: 300,
      decodedMatches: 0,
      cacheHit: null,
      durationMs: null,
    };
    const inferredDiagonalKm = Number.isFinite(roundScore) && roundScore > 0 && roundScore < 5000
        && Number.isFinite(roundDistanceM) && roundDistanceM > 0
      ? -10 * (roundDistanceM / 1000) / Math.log(roundScore / 5000)
      : null;
    const knownMap = datasetKey
      ? await portableApi.isKnownMap(datasetKey).catch(() => false)
      : false;
    if (!ownsRoundRequest(token, requestKey)) return { status: "stale", requestKey };
    state.diagnostics.retrieval.knownMap = knownMap;
    const useSimilarityReview = Boolean(cloudPanoId) && (cloudConfigured || packAvailable);
    const cloudRequest = useSimilarityReview
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
    const reviewRequest = useSimilarityReview
      ? cloudRequest.then((result) => {
        if (!result?.ok || !result.response) {
          // If a known legacy map contains a panorama that is absent from the
          // static corpus and Modal is unavailable, its old local pack remains
          // a safe fallback. Unknown maps have no such fallback.
          if (knownMap) return criticalRequest(`/api/neighborhood?${params}`);
          const clientDiagnostic = cradioClient.diagnostics?.() || {};
          if (clientDiagnostic.packError) {
            throw new Error("Visual similarity temporarily unavailable (public corpus request failed)");
          }
          const why = [result?.reason, result?.status].filter(Boolean).join(" ");
          throw new Error(why ? `C-RADIO similarity unavailable (${why})` : "C-RADIO similarity unavailable");
        }
        return result.response;
      })
      : criticalRequest(`/api/neighborhood?${params}`);
    const pendingTimer = window.setTimeout(() => {
      if (ownsRoundRequest(token, requestKey) && !state.review) {
        renderPending(useSimilarityReview
          ? "C-RADIO similarity warming…"
          : "Analyzing visual similarity…");
      }
    }, 250);
    state.pendingTimer = pendingTimer;
    try {
      const review = await reviewRequest;
      clearTimeout(pendingTimer);
      if (state.pendingTimer === pendingTimer) state.pendingTimer = 0;
      if (!ownsRoundRequest(token, requestKey)) return { status: "stale", requestKey };
      if (!review.matched) {
        renderOffline("This round did not expose a Street View panorama");
        return { status: "unavailable", requestKey };
      }
      const responsePanoId = decodedPanoId(review.location?.panoId);
      if (requestPanoId && responsePanoId && requestPanoId !== responsePanoId) {
        throw new Error(`Similarity response belonged to another panorama (${responsePanoId})`);
      }
      const clientDiagnostic = cradioClient.diagnostics?.() || {};
      const decodedMatches = review.visualNeighborhood?.visualMatches?.length || 0;
      state.diagnostics.retrieval = {
        ...state.diagnostics.retrieval,
        status: "complete",
        source: clientDiagnostic.source || (review.cloud ? "cloud" : "legacy-pack"),
        decodedMatches,
        cacheHit: review.cradio?.cacheHit === true || clientDiagnostic.cached === true,
        corpus: review.cradio?.corpus || null,
        corpusSize: review.cradio?.corpusSize || null,
        durationMs: Date.now() - reviewStartedAt,
        failureReason: null,
      };
      diagnosticPhase("review-ready");
      state.review = review;
      state.reviewRoundKey = requestKey;
      state.roundIdentity = buildRoundIdentity(eventState, round, review);
      state.fastNeighborhood = null;
      clearTimeout(state.offlineRetryTimer);
      state.drawerOpen = false;
      render();
      // The guess-side lookup also supplies tile two of the visual comparison.
      // Warm it on every corpus round even when its map overlay is switched off.
      if ((review.universal && state.playerGuess) || state.showGuessNeighbors) {
        loadGuessNeighborhood(token);
      }
      recordRoundOutcome(round, review).catch(() => {
        // Passive local history must never affect the post-round interface.
      });
      // Start the expensive view-level grouping and decode the default nine
      // images while the player is still reading the ordinary round result.
      // Pressing V later therefore reveals prepared content instead of
      // initiating work on the interaction path.
      if (!review.universal) {
        preloadVisualBoard(review.datasetKey, review.location.mapIndex, token).catch((error) => {
          console.warn("Meta Trainer: visual-board preload failed", error);
        });
      }
      applyStoredMapMode(token);
      loadNeighborRecommendation(token);
      return { status: "ready", requestKey };
    } catch (error) {
      clearTimeout(pendingTimer);
      if (state.pendingTimer === pendingTimer) state.pendingTimer = 0;
      const requestStillOwned = ownsRoundRequest(token, requestKey);
      if (requestStillOwned) {
        if (state.roundRequestKey === requestKey) {
          state.roundRequestKey = "";
          state.roundRequestQuality = -1;
        }
        const clientDiagnostic = cradioClient.diagnostics?.() || {};
        state.diagnostics.retrieval = {
          ...state.diagnostics.retrieval,
          status: "failed",
          source: clientDiagnostic.source || null,
          durationMs: Date.now() - reviewStartedAt,
          failureReason: String(error?.message || error).slice(0, 300),
          httpStatus: clientDiagnostic.status || null,
          packError: clientDiagnostic.packError || null,
        };
        // The cloud branch discarded error.message and rendered a fixed string,
        // so the reason added upstream never reached the screen.
        console.warn("Meta Trainer: cloud review failed", error);
        renderOffline(
          useSimilarityReview
            ? (error && error.message ? error.message : "C-RADIO similarity unavailable")
            : error.message,
        );
        if (!useSimilarityReview) {
          state.offlineRetryTimer = setTimeout(() => {
            if (token === state.requestToken) handleRoundEnd(eventState);
          }, 650);
        }
      }
      return { status: requestStillOwned ? "failed" : "stale", requestKey };
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
        try {
          await framework.init();
        } catch (error) {
          diagnosticPhase("event-framework-retrying", { eventFramework: "init-failed" });
          diagnosticError(error, "event-framework-init");
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        diagnosticPhase("event-framework-ready", { eventFramework: "ready" });
        framework.events.addEventListener("round_start", (event) => {
          clearRound();
          warmMapForRound(event.detail);
          prefetchModalFromEventState(event.detail);
        });
        framework.events.addEventListener("round_end", (event) => {
          // Use the same complete review pipeline in every mode. The Live
          // Challenge adapter is now only a fallback/enrichment source; the
          // request-key quality gate in handleRoundEnd prevents races.
          // Private-party GeoGuessr emits this event when the local player
          // submits, before every player has finished. Its visible result map
          // is the authoritative privacy boundary; the Live poll will invoke
          // the shared pipeline once that map exists.
          if (PARTY_LOBBY_PATH.test(location.pathname) && !liveChallengeResultMounted()) return;
          handleRoundEnd(event.detail);
        });
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
    diagnosticPhase("event-framework-failed", { eventFramework: "missing" });
    diagnosticError("GeoGuessr Event Framework did not initialize", "startup");
    console.error("Meta Trainer: GeoGuessr Event Framework did not initialize");
  }

  setupMapCapture();
  document.addEventListener("webglcontextlost", (event) => {
    const trainerRenderer = Boolean(event.target?.closest?.(".omt-native-pano"));
    diagnosticError(
      "A page WebGL rendering context was lost",
      trainerRenderer ? "trainer-streetview-webgl" : "page-webgl",
    );
  }, true);
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
    disposeNativePanoPool();
  }, true);
  flushPendingVisualExposure();
  initializeLiveChallengeAdapter();
  initializeEvents();
})();
