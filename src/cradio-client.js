(function (root) {
  "use strict";

  // Lodestar 1M: 999,693 panoramas, the full frozen corpus. The 49,417-panorama
  // Balanced World pilot stays deployed at ...-pilot-v1-... as the baseline to
  // compare against.
  const ENDPOINT = "https://obsidianarmor1--geoguessr-cradio-lodestar-v1-pilot-query.modal.run";
  const TOKEN_KEY = "omt-cradio-proxy-token-v1";
  const CACHE_KEY = "omt-cradio-cache-v1";
  // Bumped with the corpus behind the endpoint: cached entries hold
  // neighbours from the 100k corpus, and nothing in an entry says so.
  const CACHE_VERSION = 2;
  const MAX_CACHE_ENTRIES = 24;
  // Measured against the Lodestar service: 0.3-0.5s warm, 10.7s cold, and ~45s
  // for the first query after a deployment while the GPU memory snapshot is
  // created. The old 20s limit gave up during that first call and reported
  // "similarity unavailable" for a service that was working, so the ceiling is
  // set above the once-per-deploy case rather than the common one.
  const REQUEST_TIMEOUT_MS = 90_000;
  const TOKEN_PATTERN = /^wk-[A-Za-z0-9._~-]+\.ws-[A-Za-z0-9._~-]+$/;

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function validToken(value) {
    return TOKEN_PATTERN.test(String(value || "").trim());
  }

  function decodePanoId(value) {
    const encoded = String(value || "");
    if (encoded.length < 32 || encoded.length % 2 || !/^[0-9a-f]+$/i.test(encoded)) {
      return encoded;
    }
    let decoded = "";
    for (let index = 0; index < encoded.length; index += 2) {
      decoded += String.fromCharCode(parseInt(encoded.slice(index, index + 2), 16));
    }
    return /^[\x20-\x7e]+$/.test(decoded) ? decoded : encoded;
  }

  function panoIdFromRawRound(data) {
    const roundNumber = Number(data?.round);
    const location = data?.rounds?.[roundNumber - 1];
    const panoId = decodePanoId(location?.panoId ?? location?.panoid ?? location?.id);
    return panoId || null;
  }

  function panoIdFromLiveRound(round) {
    const value = round?.location?.panoId ?? round?.location?.panoid ?? round?.panoId;
    return decodePanoId(value) || null;
  }

  function thumbnail(panoId, heading = 0, width = 448, height = 256) {
    const query = new URLSearchParams({
      cb_client: "apiv3",
      w: String(width),
      h: String(height),
      pitch: "0",
      panoid: panoId,
      yaw: String(heading),
      thumbfov: "90",
    });
    return `https://streetviewpixels-pa.googleapis.com/v1/thumbnail?${query}`;
  }

  function coordinates(value) {
    const latitude = Number(value?.latitude ?? value?.lat);
    const longitude = Number(value?.longitude ?? value?.lng ?? value?.lon);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
      ? { latitude, longitude }
      : null;
  }

  function haversineKm(aLat, aLng, bLat, bLng) {
    const radians = Math.PI / 180;
    const lat1 = aLat * radians;
    const lat2 = bLat * radians;
    const dLat = lat2 - lat1;
    const dLng = (bLng - aLng) * radians;
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.sqrt(clamp(h, 0, 1)));
  }

  function normalizedBoundary(value, matchCount) {
    const count = Number(value?.count);
    return {
      detected: value?.detected === true,
      count: Number.isInteger(count) && count > 0
        ? Math.min(count, matchCount)
        : matchCount,
      score: Number.isFinite(Number(value?.score)) ? Number(value.score) : 0,
    };
  }

  function recommendedClick(value) {
    if (Array.isArray(value) && value.length >= 2) {
      const latitude = Number(value[0]);
      const longitude = Number(value[1]);
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) return { latitude, longitude };
    }
    return coordinates(value);
  }

  function adaptResponse(raw, context = {}) {
    if (!raw || raw.status !== "complete" || !Array.isArray(raw.matches)) {
      throw new Error("Modal C-RADIO response was incomplete");
    }
    const panoId = String(context.panoId || raw.panoId || "");
    if (!panoId) throw new Error("Modal C-RADIO response has no panorama ID");
    const origin = coordinates(context);
    const datasetKey = String(context.datasetKey || "balanced-world-50k");
    const allMatches = raw.matches.map((item, index) => {
      const point = coordinates(item);
      const similarity = Number(item?.similarity);
      if (!point || !Number.isFinite(similarity)) return null;
      return {
        datasetKey,
        mapIndex: Number.isInteger(Number(item.mapIndex)) ? Number(item.mapIndex) : index,
        panoId: String(item.panoId || ""),
        rank: Number.isInteger(Number(item.rank)) ? Number(item.rank) : index + 1,
        latitude: point.latitude,
        longitude: point.longitude,
        similarity,
      };
    }).filter((item) => item && item.panoId && item.panoId !== panoId);
    if (!allMatches.length) throw new Error("Modal C-RADIO response contained no usable matches");
    allMatches.sort((left, right) => left.rank - right.rank);
    const strongest = allMatches[0].similarity;
    const weakest = allMatches[allMatches.length - 1].similarity;
    const span = Math.max(strongest - weakest, 1e-8);
    const totalWeight = allMatches.reduce((sum, item, index) => sum + 1 / (index + 10), 0);
    allMatches.forEach((item, index) => {
      item.rank = index + 1;
      item.relativeStrength = clamp((item.similarity - weakest) / span, 0, 1);
      item.posteriorWeight = (1 / (index + 10)) / totalWeight;
      item.geographicGroup = index;
      item.distanceKm = origin
        ? haversineKm(origin.latitude, origin.longitude, item.latitude, item.longitude)
        : null;
    });
    const boundary = normalizedBoundary(raw.boundary, allMatches.length);
    const visualMatches = allMatches.slice(0, boundary.count);
    const click = recommendedClick(raw.recommendedClick);
    if (!click) throw new Error("Modal C-RADIO response has no recommended click");
    const distances = visualMatches.map((item) => item.distanceKm)
      .filter(Number.isFinite).sort((left, right) => left - right);
    const quantile = (fraction) => distances.length
      ? distances[Math.floor((distances.length - 1) * fraction)]
      : null;
    const radii = [50, 100, 500, 2_000].map((radiusKm) => ({
      radiusKm,
      matches: visualMatches.filter((item) => Number.isFinite(item.distanceKm)
        && item.distanceKm <= radiusKm).length,
      mapLocations: null,
      densityAdjustedRatio: 1,
      densityAdjustedBits: 0,
    }));
    const currentHeadings = [0, 90, 180, 270];
    const currentViews = currentHeadings.map((heading) => thumbnail(panoId, heading));
    const boardEntries = visualMatches.slice(0, 8).map((item) => ({
      ...item,
      slot: 0,
      heading: 0,
      view: thumbnail(item.panoId, 0),
      viewSimilarity: item.similarity,
      reciprocal: false,
    }));
    const independentAreas = new Set(boardEntries.map((item) => (
      `${Math.round(item.latitude * 2) / 2}:${Math.round(item.longitude * 2) / 2}`
    ))).size;
    const agreement = clamp(1 - Math.max(0, strongest - weakest), 0, 1);
    const visualNeighborhood = {
      representation: "exact Modal C-RADIOv4-H World-50K search",
      neighbors: visualMatches.length,
      mapDiagonalKm: Number.isFinite(Number(context.mapDiagonalKm))
        ? Number(context.mapDiagonalKm) : 20_000,
      coordinateBlind: true,
      cloud: true,
      boundary,
      radii,
      radiusProfile: "world-scale",
      medianDistanceKm: quantile(0.5),
      nearestTenthDistanceKm: quantile(0.1),
      similarityRange: { strongest, weakest },
      posterior: {
        mapLocations: Number(raw.corpusSize) || allMatches.length,
        effectiveLocations: 1 / allMatches.reduce((sum, item) => sum + item.posteriorWeight ** 2, 0),
        displayedLocations: visualMatches.length,
        displayedMass: visualMatches.reduce((sum, item) => sum + item.posteriorWeight, 0),
        displayPolicy: raw.source === "lodestar-static-pack"
          ? `full cloud from ${Number(raw.corpusSize).toLocaleString()} panoramas; core ${raw.clickRule || "by similarity margin"}`
          : boundary.detected
            ? "exact Modal C-RADIO slope boundary"
            : "exact Modal C-RADIO nearest references; no sustained boundary",
        broadDistributionUsedForClick: false,
        semanticMaximumFraction: null,
        temperature: null,
        exactCoreWeight: 1,
      },
      weightedClick: {
        latitude: click.latitude,
        longitude: click.longitude,
        expectedScore: null,
        source: "modal-cradio",
      },
      // How many of the drawn matches form the strong core. The whole cloud is
      // drawn - that is the point of the corpus - but the core is what steers
      // the suggested click, and the map draws it differently so the shape is
      // readable instead of a uniform smear.
      coreCount: Math.max(1, Math.min(
        Number(raw.clickCount) || Math.min(50, visualMatches.length),
        visualMatches.length)),
      visualMatches,
    };
    return {
      matched: true,
      cloud: true,
      universal: true,
      datasetKey,
      datasetDisplayName: "World-50K · exact C-RADIO cloud query",
      sourceMapKey: context.sourceMapKey || "",
      matchMethod: "modal-cradio-v1",
      matchDistanceM: null,
      location: {
        mapIndex: -1,
        panoId,
        latitude: origin?.latitude ?? null,
        longitude: origin?.longitude ?? null,
        headings: currentHeadings,
        views: currentViews,
      },
      reviewSummary: {
        rawDetectorMatches: 0,
        conceptMatches: 0,
        strongConceptMatches: 0,
        shown: 0,
        fallbackUsed: false,
        hiddenRedundantMatches: 0,
        hiddenWeakMatches: 0,
        hiddenByAttentionBudget: 0,
        hiddenNearDuplicates: allMatches.length - visualMatches.length,
        minimumExemplarPercentile: null,
        maximumClues: 0,
        scheduledLessons: 0,
      },
      universalTiming: raw.timings || null,
      cradio: {
        cacheHit: raw.cacheHit === true,
        corpus: raw.corpus || "balanced-world-50k-cradio-h-fused-v1",
        corpusSize: Number(raw.corpusSize) || null,
      },
      visualNeighborhood,
      visualBoard: {
        datasetKey,
        mapIndex: -1,
        panoId,
        neighborsConsidered: allMatches.length,
        defaultMode: "literal",
        warning: "Exact C-RADIO similarity is evidence, not geographic certainty.",
        queryLocation: origin,
        modes: [{
          id: "literal",
          label: "Nearest 8",
          currentSlot: 0,
          currentHeading: 0,
          currentView: currentViews[0],
          support: boardEntries.length,
          weightedSupport: boardEntries.length,
          coherence: agreement,
          alignment: agreement,
          reciprocalSupport: 0,
          independentAreas,
          entries: boardEntries,
        }],
      },
      metas: [],
      moreMetas: [],
    };
  }

  function headingOf(context) {
    const value = Number(
      context?.heading ??
      context?.round?.heading ??
      context?.location?.heading ??
      context?.pano?.heading,
    );
    return Number.isFinite(value) ? ((value % 360) + 360) % 360 : 0;
  }

  function defaultValue(name, fallback) {
    return typeof root[name] === "function" ? root[name] : fallback;
  }

  class ModalCradioClient {
    constructor(options = {}) {
      this.endpoint = options.endpoint || ENDPOINT;
      this.getValue = options.getValue || defaultValue("GM_getValue", () => undefined);
      this.setValue = options.setValue || defaultValue("GM_setValue", () => {});
      this.deleteValue = options.deleteValue || defaultValue("GM_deleteValue", () => {});
      this.request = options.request || ModalCradioClient.gmRequest;
      this.timeoutMs = options.timeoutMs || REQUEST_TIMEOUT_MS;
      this.inflight = new Map();
      this.results = new Map();
    }

    token() {
      const value = this.getValue(TOKEN_KEY, "");
      return validToken(value) ? String(value).trim() : "";
    }

    configured() {
      return Boolean(this.token());
    }

    tokenStatus() {
      const stored = this.getValue(TOKEN_KEY, "");
      return {
        configured: validToken(stored),
        invalidStoredValue: Boolean(stored) && !validToken(stored),
      };
    }

    setToken(value) {
      const token = String(value || "").trim();
      if (!validToken(token)) throw new Error("Token must match wk-….ws-…");
      if (token !== this.token()) this.results.clear();
      this.setValue(TOKEN_KEY, token);
      return true;
    }

    clearToken() {
      this.results.clear();
      this.deleteValue(TOKEN_KEY);
    }

    readCache() {
      const value = this.getValue(CACHE_KEY, null);
      return value?.version === CACHE_VERSION && value.entries && typeof value.entries === "object"
        ? value : { version: CACHE_VERSION, entries: {} };
    }

    writeCache(cache) {
      const entries = Object.entries(cache.entries)
        .sort((left, right) => Number(right[1]?.storedAt || 0) - Number(left[1]?.storedAt || 0))
        .slice(0, MAX_CACHE_ENTRIES);
      this.setValue(CACHE_KEY, { version: CACHE_VERSION, entries: Object.fromEntries(entries) });
    }

    async prefetch(panoId, context = {}) {
      const id = String(panoId || "");
      if (!id) return { ok: false, reason: "missing-pano" };
      // The credential check moved into resolve(). The static pack needs no
      // token: a panorama already in the corpus is answered from precomputed
      // neighbours, so playing a Lodestar map requires no account at all.
      if (this.results.has(id)) return this.results.get(id);
      const cache = this.readCache();
      const cached = cache.entries[id];
      if (cached?.response) {
        try {
          const result = { ok: true, cached: true, response: adaptResponse(cached.response, { ...context, panoId: id }) };
          this.results.set(id, result);
          return result;
        } catch (_error) {
          delete cache.entries[id];
          this.writeCache(cache);
        }
      }
      if (this.inflight.has(id)) return this.inflight.get(id);
      const pending = this.resolve(id, context).then((result) => {
        this.results.set(id, result);
        if (this.results.size > 128) this.results.delete(this.results.keys().next().value);
        return result;
      }).finally(() => {
        if (this.inflight.get(id) === pending) this.inflight.delete(id);
      });
      this.inflight.set(id, pending);
      return pending;
    }

    // Static pack first, Modal second. Every panorama in a map cut from
    // Lodestar has precomputed global neighbours, so the GPU is only needed for
    // a panorama outside the corpus - which cannot happen on those maps.
    async resolve(panoId, context) {
      const local = await this.fromPack(panoId, context);
      if (local) return local;
      if (!this.configured()) return { ok: false, reason: "missing-credential" };
      return this.fetch(panoId, context);
    }

    async fromPack(panoId, context) {
      const pack = root.LodestarPack;
      if (!pack || this.packDisabled) return null;
      try {
        const raw = await pack.query(panoId, 300);
        if (!raw) return null;               // outside the corpus: let Modal try
        return {
          ok: true,
          cached: false,
          source: "lodestar-static-pack",
          response: adaptResponse(raw, { ...context, panoId: String(panoId) }),
        };
      } catch (error) {
        // A pack failure must never end a round: fall through to Modal and say
        // why in the console rather than surfacing "similarity unavailable".
        console.warn("[cradio] static pack unavailable, using Modal:", error && error.message);
        return null;
      }
    }

    async fetch(panoId, context) {
      const token = this.token();
      if (!token) return { ok: false, reason: "missing-credential" };
      try {
        const response = await this.request({
          method: "POST",
          url: this.endpoint,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          // The corpus is embedded spawn-relative: four views at 0/90/180/270
          // from the panorama's OWN heading. Without sending it the service
          // falls back to absolute north and compares differently framed
          // images, which degrades retrieval quietly rather than failing.
          body: JSON.stringify({ panoId, count: 500, heading: headingOf(context) }),
          timeout: this.timeoutMs,
        });
        // Every failure used to surface as one generic toast, which made a
        // wrong endpoint, an expired token and a cold-start timeout look
        // identical. Carry the status and a short body excerpt.
        const detail = typeof response.body === "string" ? response.body.slice(0, 160) : "";
        if (response.status === 401 || response.status === 403) {
          console.warn("[cradio] unauthorized", response.status, this.endpoint, detail);
          return { ok: false, reason: "unauthorized", status: response.status, detail };
        }
        if (response.status === 429) {
          console.warn("[cradio] rate-limited", detail);
          return { ok: false, reason: "rate-limited", status: 429, detail };
        }
        if (response.status < 200 || response.status >= 300) {
          console.warn("[cradio] http-error", response.status, this.endpoint, detail);
          return { ok: false, reason: "http-error", status: response.status, detail };
        }
        const raw = typeof response.body === "string" ? JSON.parse(response.body) : response.body;
        const adapted = adaptResponse(raw, { ...context, panoId });
        const cache = this.readCache();
        cache.entries[panoId] = { storedAt: Date.now(), response: raw };
        this.writeCache(cache);
        return { ok: true, cached: false, response: adapted };
      } catch (error) {
        console.warn("[cradio] request failed", this.endpoint, error && error.message);
        const reason = error?.code === "timeout" ? "timeout" : "network-error";
        return { ok: false, reason };
      }
    }

    static gmRequest(options) {
      return new Promise((resolve, reject) => {
        if (typeof root.GM_xmlhttpRequest !== "function") {
          reject(new Error("GM_xmlhttpRequest is unavailable"));
          return;
        }
        root.GM_xmlhttpRequest({
          method: options.method,
          url: options.url,
          headers: options.headers,
          data: options.body,
          timeout: options.timeout,
          responseType: "text",
          onload: (response) => resolve({ status: response.status, body: response.responseText }),
          onerror: () => reject(new Error("network")),
          ontimeout: () => {
            const error = new Error("timeout");
            error.code = "timeout";
            reject(error);
          },
        });
      });
    }
  }

  const api = {
    ENDPOINT,
    TOKEN_KEY,
    CACHE_KEY,
    CACHE_VERSION,
    MAX_CACHE_ENTRIES,
    TOKEN_PATTERN,
    validToken,
    decodePanoId,
    panoIdFromRawRound,
    panoIdFromLiveRound,
    adaptResponse,
    ModalCradioClient,
  };
  root.OMTModalCradio = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
