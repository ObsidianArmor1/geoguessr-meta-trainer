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
    // Distances are measured from the panorama being asked about. The caller
    // usually supplies it, but the guess-side cloud is adapted from a context
    // that has no coordinates at all - so every distance came out as
    // `Number(null || 0)`, which is 0, and every guess-side match claimed to be
    // 0 m from its anchor. The response knows where it is; use that when the
    // context does not say.
    const origin = coordinates(context) || coordinates(raw);
    const datasetKey = String(context.datasetKey || "balanced-world-50k");
    const allMatches = raw.matches.map((item, index) => {
      const point = coordinates(item);
      const similarity = Number(item?.similarity);
      if (!point || !Number.isFinite(similarity)) return null;
      return {
        datasetKey,
        // Pack V2 deliberately omits corpus row numbers. Number(null) is 0,
        // so coercing first made every fresh-pack match appear to own row 0;
        // the map layer then collapsed the entire cloud into one point.
        mapIndex: item.mapIndex !== null && item.mapIndex !== undefined
          && Number.isInteger(Number(item.mapIndex)) ? Number(item.mapIndex) : index,
        panoId: String(item.panoId || ""),
        heading: Number.isFinite(Number(item.heading)) ? Number(item.heading) : null,
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
        displayPolicy: String(raw.source || "").startsWith("lodestar-static-pack")
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
        // the corpus's own heading for this panorama, which view 0 looks along
        spawnHeading: Number.isFinite(Number(raw.heading)) ? Number(raw.heading) : null,
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
      this.lastDiagnostic = {
        phase: "idle", panoId: null, source: null, ok: null, cached: null,
        cacheLayer: null, reason: null, status: null, durationMs: null, packError: null,
      };
    }

    noteDiagnostic(values) {
      this.lastDiagnostic = { ...this.lastDiagnostic, ...values, updatedAt: Date.now() };
    }

    diagnostics() {
      return {
        ...this.lastDiagnostic,
        configured: this.configured(),
        invalidStoredCredential: this.tokenStatus().invalidStoredValue,
        memoryEntries: this.results.size,
        inflight: this.inflight.size,
        persistentEntries: Object.keys(this.readCache().entries).length,
      };
    }

    // Failures remain deduplicated by default so a rerender cannot accidentally
    // consume another paid inference. A deliberate UI retry calls this method
    // first; successful persistent cache entries are preserved unless the
    // caller explicitly asks to remove one.
    forget(panoId, options = {}) {
      const id = String(panoId || "");
      if (!id) return;
      this.results.delete(id);
      if (options.persistent === true) {
        const cache = this.readCache();
        delete cache.entries[id];
        this.writeCache(cache);
      }
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
      if (!id) {
        this.noteDiagnostic({ phase: "complete", panoId: null, ok: false, reason: "missing-pano" });
        return { ok: false, reason: "missing-pano" };
      }
      // The credential check moved into resolve(). The static pack needs no
      // token: a panorama already in the corpus is answered from precomputed
      // neighbours, so playing a Lodestar map requires no account at all.
      if (this.results.has(id)) {
        const result = this.results.get(id);
        this.noteDiagnostic({
          phase: "complete", panoId: id, source: result?.source || this.lastDiagnostic.source,
          cacheLayer: "memory", ok: result?.ok === true, cached: true,
          reason: result?.reason || null, status: result?.status || null,
        });
        return result;
      }
      const cache = this.readCache();
      const cached = cache.entries[id];
      if (cached?.response) {
        try {
          const result = {
            ok: true, cached: true, source: "modal",
            response: adaptResponse(cached.response, { ...context, panoId: id }),
          };
          this.results.set(id, result);
          this.noteDiagnostic({
            phase: "complete", panoId: id, source: "modal", cacheLayer: "persistent",
            ok: true, cached: true, reason: null, status: 200,
          });
          return result;
        } catch (_error) {
          delete cache.entries[id];
          this.writeCache(cache);
        }
      }
      if (this.inflight.has(id)) {
        this.noteDiagnostic({ phase: "loading", panoId: id, source: "inflight", ok: null });
        return this.inflight.get(id);
      }
      this.noteDiagnostic({
        phase: "loading", panoId: id, source: null, ok: null, cached: false,
        cacheLayer: null, reason: null, status: null, durationMs: null, packError: null,
      });
      const started = Date.now();
      const pending = this.resolve(id, context).then((result) => {
        this.results.set(id, result);
        this.noteDiagnostic({
          phase: "complete", panoId: id, ok: result?.ok === true,
          source: result?.source || this.lastDiagnostic.source,
          cached: result?.cached === true, reason: result?.reason || null,
          status: result?.status || (result?.ok ? 200 : null),
          durationMs: Date.now() - started,
        });
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
      if (!this.configured()) {
        this.noteDiagnostic({ source: "none", ok: false, reason: "missing-credential" });
        return { ok: false, reason: "missing-credential" };
      }
      return this.fetch(panoId, context);
    }

    // The guess-side cloud, restored on the corpus path.
    //
    // It existed for the 50k packs and was disabled when play moved to
    // arbitrary maps, because that path had no map data to search - only the
    // round's own Modal result. The static pack carries every corpus
    // coordinate, so the original behaviour is available again: find the
    // panorama nearest the player's guess and draw ITS neighbourhood beside
    // the round's.
    async guessNeighborhood(guess, context = {}, roundMatches = []) {
      const pack = root.LodestarPack;
      if (!pack || !guess) return null;
      const latitude = Number(guess.lat ?? guess.latitude);
      const longitude = Number(guess.lng ?? guess.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      try {
        // Anchor selection, in the order that answers the actual question:
        // "the most similar panorama to this round, near where I guessed".
        //
        // 1. The strongest of the ROUND's own matches inside the radius. This
        //    is exact - the similarity comes from the neighbour table, not an
        //    approximation - and it is the panorama that makes the visual case
        //    for the guess. The old implementation instead took the 160 nearest
        //    panoramas and scored them per view slot, which needs per-view
        //    vectors; those were never written for this corpus (shards carry
        //    only the fused vector), so that route is closed until a
        //    re-extraction retains them.
        // 2. Failing that, the nearest corpus panorama, so the guess side still
        //    shows the local visual character even when nothing similar to the
        //    round is anywhere near.
        const withinKm = Number(context.guessRadiusKm) || 50;
        let anchor = null;
        let anchorRank = null;
        for (const match of roundMatches) {
          const km = pack.haversineKm(latitude, longitude, match.latitude, match.longitude);
          if (km <= withinKm) { anchor = { ...match, distanceKm: km }; anchorRank = match.rank; break; }
        }
        // A guess in the ocean would otherwise anchor to whatever continent is
        // least far away - measured at 1,117 km for a mid-Pacific guess. The
        // original could not do this because it searched only the map's own
        // panoramas; a corpus-wide search needs the cap put back explicitly.
        if (!anchor) {
          anchor = await pack.nearest(latitude, longitude, { withinKm: 100 });
          anchorRank = null;
        }
        if (!anchor) return null;
        const raw = await pack.query(anchor.panoId, 300);
        if (!raw) return null;
        // How similar the anchor actually is to the round.
        //
        // When the anchor came from the round's own matches this is known
        // already. When it is merely the nearest panorama to the guess - which
        // is most guesses, since a guess is rarely within the radius of one of
        // the 300 - it was reported as 0.000, which reads as "nothing alike"
        // rather than "not measured". Cosine similarity is symmetric, so the
        // round may appear in the ANCHOR's row; that gives the exact value for
        // free, out of a row already fetched.
        const roundPanoId = String(context.roundPanoId || "");
        let reciprocal = null;
        if (anchorRank === null && roundPanoId) {
          const found = raw.matches.find((match) => match.panoId === roundPanoId);
          if (found) reciprocal = found;
        }
        // Neither in the other's 300: fall back to the projected estimate,
        // which covers any pair in the corpus. Flagged as an estimate so the
        // display can say so - its mean error is 0.0145.
        let estimated = false;
        let similarityToRound = anchorRank ? anchor.similarity
          : reciprocal ? reciprocal.similarity : null;
        if (similarityToRound === null && roundPanoId && pack.similarityBetween) {
          const guess = await pack.similarityBetween(roundPanoId, anchor.panoId);
          if (Number.isFinite(guess)) {
            similarityToRound = guess;
            estimated = true;
          }
        }
        const adapted = adaptResponse(raw, {
          ...context,
          panoId: raw.panoId,
          // the anchor is the origin for this cloud's distances
          latitude: anchor.latitude,
          longitude: anchor.longitude,
        });
        return {
          ...adapted,
          guessAnchor: {
            panoId: anchor.panoId,
            latitude: anchor.latitude,
            longitude: anchor.longitude,
            distanceFromGuessKm: anchor.distanceKm,
            // raw.heading is the anchor row's own spawn heading, so this holds
            // even if the anchor arrived without one.
            heading: Number.isFinite(Number(anchor.heading)) ? Number(anchor.heading)
              : Number.isFinite(Number(raw.heading)) ? Number(raw.heading) : null,
            // rank in the ROUND's matches, or null when nothing similar to the
            // round was within the radius and this is merely the nearest
            roundRank: anchorRank,
            similarityToRound,
            // where the round sits in the anchor's own ranking, when the anchor
            // is not in the round's
            reciprocalRank: reciprocal ? reciprocal.rank : null,
            // null similarity means genuinely unmeasured: neither panorama is in
            // the other's top 300, so all that is known is that it is weaker
            // than the weakest of those.
            unmeasured: similarityToRound === null,
            estimated,
            selectedBy: anchorRank ? "strongest round match within radius" : "nearest corpus panorama",
            radiusKm: withinKm,
          },
        };
      } catch (error) {
        console.warn("[cradio] guess-side cloud unavailable:", error && error.message);
        return null;
      }
    }

    // A visual board for the corpus path, in the shape the existing renderer
    // already consumes - so hover-to-enlarge, click-to-open and the grid all
    // work unchanged.
    //
    // Tile 1 is the round. Tile 2, when there is one, is the strongest match to
    // the round within the radius of the player's guess: the visual case for
    // where they clicked. The rest are the round's best matches in order.
    //
    // Every panorama is rendered at its OWN spawn heading, which is the framing
    // the corpus was embedded at. The old board instead chose a view slot per
    // candidate, which needed per-view vectors; those were never written for
    // this corpus, and choosing the road-aligned view makes the comparison
    // like-for-like without them.
    buildVisualBoard(review, guessCloud, options = {}) {
      const matches = review?.visualNeighborhood?.visualMatches || [];
      if (!matches.length) return null;
      const tiles = Number(options.tiles) || 8;
      // Prefer the heading the round was actually played at; fall back to the
      // corpus's spawn heading for this panorama, which is the framing every
      // other tile uses. Falling back to 0 would frame the round due north
      // against matches framed along their roads.
      // `??` is wrong here: when the round's heading is unknown the client
      // fills headings[0] with 0, which is a real value and would win, framing
      // the round due north against matches framed along their roads. Take the
      // first heading that is actually informative.
      const roundHeading = [
        review.location?.roundHeading,
        review.location?.headings?.[0],
        review.location?.spawnHeading,
      ].map(Number).find((value) => Number.isFinite(value) && value !== 0) || 0;
      const entry = (match, index) => ({
        mapIndex: match.mapIndex,
        panoId: match.panoId,
        heading: Math.round(Number(match.heading ?? 0)),
        view: thumbnail(match.panoId, Number(match.heading ?? 0)),
        rank: match.rank ?? index + 1,
        viewSimilarity: match.similarity,
        distanceKm: match.distanceKm ?? 0,
        reciprocal: false,
      });
      const anchor = guessCloud?.guessAnchor || null;
      // The board holds `tiles` panoramas beside the round, and the guess tile
      // takes one of those places rather than adding a tenth. It also removes
      // itself from the match list: the anchor is usually one of the round's
      // own matches, and showing it twice wastes a tile.
      const guessMatch = anchor ? {
        kind: "guess-local",
        mapIndex: -2,
        panoId: anchor.panoId,
        heading: Math.round(Number(anchor.heading ?? 0)),
        view: thumbnail(anchor.panoId, Number(anchor.heading ?? 0)),
        distanceFromGuessKm: Number(anchor.distanceFromGuessKm) || 0,
        globalPanoRank: anchor.roundRank,
        // `Number.isFinite(Number(null))` is true, because Number(null) is 0 -
        // so checking the coerced value keeps the very case this is meant to
        // exclude, and prints 0.000 for an unmeasured likeness.
        viewSimilarity: anchor.similarityToRound === null || anchor.similarityToRound === undefined
          ? null : Number(anchor.similarityToRound),
        reciprocalRank: anchor.reciprocalRank ?? null,
        unmeasured: anchor.unmeasured === true,
        estimated: anchor.estimated === true,
        candidatePool: Number(anchor.candidatePool) || matches.length,
      } : null;
      // A submitted guess always owns tile two. If there is no usable corpus
      // panorama near it, keep that place as an explanation instead of
      // silently promoting global match #1 into the guess slot.
      const guessUnavailable = Boolean(options.guessExpected && !guessMatch);
      const reservedGuessSlot = Boolean(guessMatch || guessUnavailable);
      // how many separate places the tiles point at, at a 25 km grain
      const areas = [];
      for (const match of matches.slice(0, reservedGuessSlot ? tiles - 1 : tiles)) {
        if (!areas.some((seat) => haversineKm(seat[0], seat[1], match.latitude, match.longitude) < 25)) {
          areas.push([match.latitude, match.longitude]);
        }
      }
      return {
        corpus: true,
        panoId: review.location?.panoId || "",
        mapIndex: -1,
        datasetKey: review.datasetKey,
        defaultMode: "consensus",
        modes: [{
          id: "consensus",
          label: "Closest matches",
          currentSlot: 0,
          currentHeading: Math.round(roundHeading),
          currentView: thumbnail(review.location?.panoId || "", roundHeading),
          entries: (guessMatch
          ? matches.filter((match) => match.panoId !== guessMatch.panoId).slice(0, tiles - 1)
          : matches.slice(0, reservedGuessSlot ? tiles - 1 : tiles)).map(entry),
          guessMatch,
          guessUnavailable,
          support: review.visualNeighborhood?.coreCount || matches.length,
          supportOf: matches.length,
          reciprocalSupport: null,
          independentAreas: areas.length,
          coherence: null,
        }],
      };
    }

    async fromPack(panoId, context) {
      const pack = root.LodestarPack;
      if (!pack || this.packDisabled) return null;
      try {
        const raw = await pack.query(panoId, 300);
        if (!raw) {
          this.noteDiagnostic({ source: "lodestar-not-found", packError: null });
          return null;                       // outside the corpus: let Modal try
        }
        this.noteDiagnostic({
          source: raw.source || "lodestar-static-pack", ok: true,
          cached: raw.cacheHit === true, packError: null,
        });
        return {
          ok: true,
          cached: raw.cacheHit === true,
          source: raw.source || "lodestar-static-pack",
          response: adaptResponse(raw, { ...context, panoId: String(panoId) }),
        };
      } catch (error) {
        // A pack failure must never end a round: fall through to Modal and say
        // why in the console rather than surfacing "similarity unavailable".
        console.warn("[cradio] static pack unavailable, using Modal:", error && error.message);
        this.noteDiagnostic({ source: "lodestar-failed", packError: String(error?.message || error).slice(0, 240) });
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
        this.noteDiagnostic({ source: "modal", status: response.status, cached: false });
        if (response.status === 401 || response.status === 403) {
          console.warn("[cradio] unauthorized", response.status, this.endpoint, detail);
          return { ok: false, source: "modal", reason: "unauthorized", status: response.status, detail };
        }
        if (response.status === 429) {
          console.warn("[cradio] rate-limited", detail);
          return { ok: false, source: "modal", reason: "rate-limited", status: 429, detail };
        }
        if (response.status < 200 || response.status >= 300) {
          console.warn("[cradio] http-error", response.status, this.endpoint, detail);
          return { ok: false, source: "modal", reason: "http-error", status: response.status, detail };
        }
        const raw = typeof response.body === "string" ? JSON.parse(response.body) : response.body;
        const adapted = adaptResponse(raw, { ...context, panoId });
        const cache = this.readCache();
        cache.entries[panoId] = { storedAt: Date.now(), response: raw };
        this.writeCache(cache);
        return { ok: true, cached: false, source: "modal", response: adapted };
      } catch (error) {
        console.warn("[cradio] request failed", this.endpoint, error && error.message);
        const reason = error?.code === "timeout" ? "timeout" : "network-error";
        this.noteDiagnostic({ source: "modal", ok: false, reason, status: null });
        return { ok: false, source: "modal", reason };
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
