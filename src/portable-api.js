(function (root) {
  "use strict";

  const DB_NAME = "geoguessr-meta-trainer-portable-v1";
  const DB_VERSION = 1;
  const ASSET_STORE = "assets";
  const EVENT_STORE = "events";
  const textDecoder = new TextDecoder();

  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function halfToFloat(value) {
    const sign = (value & 0x8000) ? -1 : 1;
    const exponent = (value >> 10) & 0x1f;
    const fraction = value & 0x03ff;
    if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
    if (exponent === 31) return fraction ? NaN : sign * Infinity;
    return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
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

  function specificityBits(memberCount, panoramaCount) {
    return Math.log2(Math.max(panoramaCount, 1) / clamp(memberCount, 1, panoramaCount));
  }

  function globalMatchRank(memberCount, percentile) {
    const members = Math.max(Math.trunc(memberCount), 1);
    const accepted = clamp(Math.trunc(percentile), 1, 100);
    return Math.min(members, Math.ceil((100 - accepted) * members / 100) + 1);
  }

  function streetViewThumbnail(panorama, slot, width = 640, height = 360) {
    const heading = panorama.h[slot];
    const query = new URLSearchParams({
      cb_client: "apiv3",
      w: String(width),
      h: String(height),
      pitch: "0",
      panoid: panorama.p,
      yaw: String(heading),
      thumbfov: "90",
    });
    return `https://streetviewpixels-pa.googleapis.com/v1/thumbnail?${query}`;
  }

  function reviewPriority(bits, members, percentile, panoramas, minimum) {
    const information = Math.max(Number(bits) || 0, 0);
    if (!information || percentile < minimum) return 0;
    const span = Math.max(101 - minimum, 1);
    const exemplar = Math.sqrt(clamp((percentile - minimum + 1) / span, 0, 1));
    const specificity = Math.max(specificityBits(members, panoramas), 1e-6);
    return information ** (1 / 3) * specificity ** (2 / 3) * exemplar;
  }

  function interpolate(value, xs, ys) {
    if (value <= xs[0]) return ys[0];
    if (value >= xs[xs.length - 1]) return ys[ys.length - 1];
    let low = 0;
    let high = xs.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (xs[middle] <= value) low = middle;
      else high = middle;
    }
    const span = xs[high] - xs[low];
    const ratio = span ? (value - xs[low]) / span : 0;
    return ys[low] + ratio * (ys[high] - ys[low]);
  }

  function openDatabase() {
    if (typeof indexedDB === "undefined") return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(ASSET_STORE)) {
          database.createObjectStore(ASSET_STORE);
        }
        if (!database.objectStoreNames.contains(EVENT_STORE)) {
          database.createObjectStore(EVENT_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbGet(database, store, key) {
    if (!database) return undefined;
    return new Promise((resolve, reject) => {
      const request = database.transaction(store, "readonly").objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function idbPut(database, store, value, key) {
    if (!database) return;
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(store, "readwrite");
      const request = key === undefined
        ? transaction.objectStore(store).put(value)
        : transaction.objectStore(store).put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async function gunzip(buffer) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("This browser does not support gzip decompression streams");
    }
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer();
  }

  function projectedCoordinates(core) {
    const count = core.panoramas.length;
    let meanLat = 0;
    let meanLng = 0;
    for (const row of core.panoramas) {
      meanLat += row.a;
      meanLng += row.o;
    }
    meanLat /= count;
    meanLng /= count;
    const cosine = Math.cos(meanLat * Math.PI / 180);
    const xy = new Float64Array(count * 2);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < count; index += 1) {
      const row = core.panoramas[index];
      const x = (row.o - meanLng) * 111.320 * cosine;
      const y = (row.a - meanLat) * 110.574;
      xy[index * 2] = x;
      xy[index * 2 + 1] = y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return {
      meanLat,
      meanLng,
      cosine,
      xy,
      bounds: [minX, minY, maxX, maxY],
      diagonalKm: Math.hypot(maxX - minX, maxY - minY),
    };
  }

  class PortableMetaApi {
    constructor(options) {
      this.baseUrl = String(options.baseUrl || "").replace(/\/$/, "");
      this.transport = options.transport || (async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Portable trainer returned ${response.status}`);
        return response.arrayBuffer();
      });
      this.databasePromise = openDatabase().catch(() => null);
      this.registryPromise = null;
      this.routingPromise = null;
      this.maps = new Map();
      this.chunkPromises = new Map();
      this.boardChunkPromises = new Map();
      this.neighborhoodPromises = new Map();
      this.weightedNeighborhoodPromises = new Map();
      this.reviewPromises = new Map();
      this.projectionChunkPromises = new Map();
      this.panoramaProjectionPromises = new Map();
      this.boundaryPromises = new Map();
      this.universal = root.OMTUniversalSimilarity
        ? new root.OMTUniversalSimilarity({
          baseUrl: this.baseUrl,
          asset: this.asset.bind(this),
          json: this.json.bind(this),
          transport: this.transport,
          registry: this.registry.bind(this),
        })
        : null;
    }

    url(path) {
      return `${this.baseUrl}/${String(path).replace(/^\//, "")}`;
    }

    async asset(path, fingerprint, persistent = true) {
      const key = `${path}#${fingerprint || "unversioned"}`;
      const database = await this.databasePromise;
      if (persistent) {
        const cached = await idbGet(database, ASSET_STORE, key).catch(() => undefined);
        if (cached instanceof ArrayBuffer) return cached;
        if (cached?.buffer instanceof ArrayBuffer) return cached.buffer;
      }
      const buffer = await this.transport(this.url(path));
      if (!(buffer instanceof ArrayBuffer)) {
        throw new Error("Portable trainer transport did not return an ArrayBuffer");
      }
      if (persistent) await idbPut(database, ASSET_STORE, buffer, key).catch(() => {});
      return buffer;
    }

    async json(path, fingerprint, compressed = false, persistent = true) {
      let buffer = await this.asset(path, fingerprint, persistent);
      if (compressed) buffer = await gunzip(buffer);
      return JSON.parse(textDecoder.decode(buffer));
    }

    async registry() {
      if (!this.registryPromise) {
        this.registryPromise = this.json("registry.json", Date.now(), false, false);
      }
      return this.registryPromise;
    }

    async routing() {
      if (!this.routingPromise) {
        this.routingPromise = this.registry().then((registry) => this.json(
          registry.routing.file,
          registry.routing.sha256,
          true,
          true,
        ));
      }
      return this.routingPromise;
    }

    async loadMap(datasetKey) {
      if (this.maps.has(datasetKey)) return this.maps.get(datasetKey);
      const pending = (async () => {
        const registry = await this.registry();
        const entry = registry.maps.find((item) => (
          item.datasetKey === datasetKey || item.aliases?.includes(datasetKey)
        ));
        if (!entry) throw new Error(`Unsupported portable map: ${datasetKey}`);
        const manifest = await this.json(entry.manifest, entry.manifestSha256);
        const core = await this.json(
          `maps/${entry.datasetKey}/${manifest.core.file}`,
          manifest.core.sha256,
          true,
        );
        const byPano = new Map();
        core.panoramas.forEach((row, index) => byPano.set(row.p, index));
        return {
          entry,
          manifest,
          core,
          byPano,
          projection: projectedCoordinates(core),
        };
      })();
      this.maps.set(datasetKey, pending);
      try {
        const loaded = await pending;
        this.maps.set(loaded.entry.datasetKey, Promise.resolve(loaded));
        return loaded;
      } catch (error) {
        this.maps.delete(datasetKey);
        throw error;
      }
    }

    async viewUrl(datasetKey, mapIndex, slot) {
      const map = await this.loadMap(datasetKey);
      const row = map.core.panoramas[Number(mapIndex)];
      const viewSlot = Number(slot);
      if (!row || !Number.isInteger(viewSlot) || viewSlot < 0 || viewSlot >= row.h.length) {
        throw new Error(`Unknown panorama view ${datasetKey}/${mapIndex}/${slot}`);
      }
      return streetViewThumbnail(row, viewSlot);
    }

    async resolve(panoId, datasetHint, latitude, longitude) {
      const registry = await this.registry();
      let direct = null;
      if (datasetHint) {
        direct = registry.maps.find((item) => (
          item.datasetKey === datasetHint || item.aliases?.includes(datasetHint)
        ));
      }
      if (direct) {
        const map = await this.loadMap(direct.datasetKey);
        const exact = panoId ? map.byPano.get(panoId) : undefined;
        if (exact !== undefined) return { map, mapIndex: exact, method: "panoId", distance: 0 };
      }
      if (panoId) {
        const routing = await this.routing();
        const matches = routing[panoId] || [];
        let match = matches[0];
        if (direct) match = matches.find((item) => item[0] === registry.maps.indexOf(direct));
        if (match) {
          const map = await this.loadMap(registry.maps[match[0]].datasetKey);
          return { map, mapIndex: match[1], method: "panoId", distance: 0 };
        }
      }
      if (direct && Number.isFinite(latitude) && Number.isFinite(longitude)) {
        const map = await this.loadMap(direct.datasetKey);
        let bestIndex = -1;
        let bestDistance = Infinity;
        for (let index = 0; index < map.core.panoramas.length; index += 1) {
          const row = map.core.panoramas[index];
          const distance = haversineKm(latitude, longitude, row.a, row.o);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
          }
        }
        if (bestDistance <= 0.08) {
          return { map, mapIndex: bestIndex, method: "coordinate", distance: bestDistance * 1000 };
        }
      }
      return null;
    }

    async neighborRow(map, mapIndex) {
      const chunkIndex = Math.floor(mapIndex / map.manifest.chunkRows);
      const chunk = map.manifest.neighborChunks[chunkIndex];
      const key = `${map.entry.datasetKey}:${chunk.file}`;
      if (!this.chunkPromises.has(key)) {
        this.chunkPromises.set(key, (async () => {
          let buffer = await this.asset(
            `maps/${map.entry.datasetKey}/neighbors/${chunk.file}`,
            chunk.sha256,
          );
          buffer = await gunzip(buffer);
          const view = new DataView(buffer);
          const magic = textDecoder.decode(new Uint8Array(buffer, 0, 8));
          const version = view.getUint32(8, true);
          if (!((magic === "OMTNBR01" && version === 1)
              || (magic === "OMTNBR02" && version === 2))) {
            throw new Error("Unsupported portable neighbor chunk");
          }
          const start = view.getUint32(12, true);
          const rows = view.getUint32(16, true);
          const count = view.getUint32(20, true);
          if (version === 1) {
            const indexOffset = 24;
            const similarityOffset = indexOffset + rows * count * 4;
            return {
              buffer, view, version, start, rows, neighbors: count,
              indexOffset, similarityOffset,
            };
          }
          const offsetsOffset = 24;
          const indexOffset = offsetsOffset + (rows + 1) * 4;
          const similarityOffset = indexOffset + count * 4;
          return {
            buffer, view, version, start, rows, edges: count,
            offsetsOffset, indexOffset, similarityOffset,
          };
        })());
      }
      const loaded = await this.chunkPromises.get(key);
      const local = mapIndex - loaded.start;
      const rowStart = loaded.version === 1
        ? local * loaded.neighbors
        : loaded.view.getUint32(loaded.offsetsOffset + local * 4, true);
      const rowStop = loaded.version === 1
        ? rowStart + loaded.neighbors
        : loaded.view.getUint32(loaded.offsetsOffset + (local + 1) * 4, true);
      const neighbors = rowStop - rowStart;
      const indices = new Int32Array(neighbors);
      const similarities = new Float64Array(neighbors);
      for (let index = 0; index < neighbors; index += 1) {
        indices[index] = loaded.view.getInt32(
          loaded.indexOffset + (rowStart + index) * 4,
          true,
        );
        similarities[index] = halfToFloat(loaded.view.getUint16(
          loaded.similarityOffset + (rowStart + index) * 2,
          true,
        ));
      }
      return { indices, similarities };
    }

    async boundaryRow(map, mapIndex) {
      const descriptor = map.manifest.neighborBoundary;
      if (!descriptor) return null;
      const key = map.entry.datasetKey;
      if (!this.boundaryPromises.has(key)) {
        this.boundaryPromises.set(key, (async () => {
          let buffer = await this.asset(
            `maps/${key}/boundaries/${descriptor.file}`,
            descriptor.sha256,
          );
          buffer = await gunzip(buffer);
          const view = new DataView(buffer);
          const magic = textDecoder.decode(new Uint8Array(buffer, 0, 8));
          const version = view.getUint32(8, true);
          const rows = view.getUint32(12, true);
          if (magic !== "OMTBND01" || version !== 1
              || rows !== map.core.panoramas.length) {
            throw new Error("Unsupported visual-boundary pack");
          }
          return {
            view,
            rows,
            detectedOffset: 16,
            scoreOffset: 16 + rows,
            runsOffset: 16 + rows * 3,
          };
        })());
      }
      const loaded = await this.boundaryPromises.get(key);
      return {
        detected: Boolean(loaded.view.getUint8(loaded.detectedOffset + mapIndex)),
        score: halfToFloat(loaded.view.getUint16(
          loaded.scoreOffset + mapIndex * 2, true,
        )),
        qualifyingRuns: loaded.view.getUint8(loaded.runsOffset + mapIndex),
        method: "persistent slope change",
      };
    }

    async panoramaProjection(map) {
      const descriptor = map.manifest.panoramaProjection;
      if (!descriptor) return null;
      const key = map.entry.datasetKey;
      if (!this.panoramaProjectionPromises.has(key)) {
        this.panoramaProjectionPromises.set(key, (async () => {
          let buffer = await this.asset(
            `maps/${key}/panorama-projection/${descriptor.index.file}`,
            descriptor.index.sha256,
          );
          buffer = await gunzip(buffer);
          const view = new DataView(buffer);
          const magic = textDecoder.decode(new Uint8Array(buffer, 0, 8));
          const version = view.getUint32(8, true);
          const panoramas = view.getUint32(12, true);
          const dimensions = view.getUint32(16, true);
          const quantizationScale = view.getFloat32(20, true);
          if (magic !== "OMTPPJ01" || version !== 1
              || panoramas !== map.core.panoramas.length
              || dimensions !== descriptor.dimensions) {
            throw new Error("Unsupported portable panorama projection");
          }
          const normOffset = 24;
          const vectorOffset = normOffset + panoramas * 2;
          return {
            buffer, view, panoramas, dimensions, quantizationScale,
            normOffset, vectorOffset, bytesPerRow: dimensions / 2,
          };
        })());
      }
      return this.panoramaProjectionPromises.get(key);
    }

    async prewarmMap(datasetKey) {
      const map = await this.loadMap(datasetKey);
      if (map.manifest.panoramaProjection) await this.panoramaProjection(map);
      return map;
    }

    async prewarmUniversal() {
      if (!this.universal) throw new Error("Universal visual search did not load");
      return this.universal.prewarm();
    }

    universalWeights(count) {
      const weights = Float64Array.from(
        { length: count }, (_value, index) => 1 / Math.sqrt(index + 1),
      );
      const total = weights.reduce((sum, value) => sum + value, 0);
      for (let index = 0; index < weights.length; index += 1) weights[index] /= total;
      return weights;
    }

    universalBoundary(matches) {
      const window = 12;
      const lower = 16;
      const upper = Math.min(288, matches.length - window - 1);
      if (upper <= lower) {
        return { detected: false, count: Math.min(100, matches.length), score: 0, qualifyingRuns: 0 };
      }
      const values = matches.map((match) => Math.log(Math.max(1 - match.similarity, 1e-8)));
      const gaps = values.slice(1).map((value, index) => value - values[index]);
      const median = (items) => {
        const sorted = [...items].sort((left, right) => left - right);
        const middle = sorted.length >> 1;
        return sorted.length % 2
          ? sorted[middle]
          : (sorted[middle - 1] + sorted[middle]) / 2;
      };
      const candidates = [];
      for (let rank = lower; rank <= upper; rank += 1) {
        const before = gaps.slice(rank - window, rank);
        const after = gaps.slice(rank, rank + window);
        const beforeMean = before.reduce((sum, value) => sum + value, 0) / window;
        const afterMean = after.reduce((sum, value) => sum + value, 0) / window;
        const meanRatio = afterMean / Math.max(beforeMean, 1e-9);
        const medianRatio = median(after) / Math.max(median(before), 1e-9);
        candidates.push({ rank, score: Math.min(meanRatio, medianRatio) });
      }
      const hits = candidates.map((row, index) => row.score >= 3 ? index : -1)
        .filter((index) => index >= 0);
      if (!hits.length) {
        return { detected: false, count: Math.min(100, matches.length), score: 0, qualifyingRuns: 0 };
      }
      let qualifyingRuns = 1;
      for (let index = 1; index < hits.length; index += 1) {
        if (hits[index] > hits[index - 1] + 1) qualifyingRuns += 1;
      }
      const start = hits[0];
      let stop = start + 1;
      while (stop < candidates.length && candidates[stop].score >= 3) stop += 1;
      let selected = candidates[start];
      for (let index = start + 1; index < stop; index += 1) {
        if (candidates[index].score > selected.score) selected = candidates[index];
      }
      return {
        detected: true,
        count: selected.rank,
        score: selected.score,
        qualifyingRuns,
        method: "persistent slope change on browser-local OPQ similarity",
      };
    }

    async universalBoard(map, query, visualMatches, latitude, longitude) {
      const entries = await Promise.all(visualMatches.slice(0, 8).map(async (match) => {
        let slot = 0;
        try {
          const source = await this.visualBoardSource(map, match.mapIndex);
          const mode = source.m.find((item) => item.i === source.d) || source.m[0];
          if (Number.isInteger(mode?.c)) slot = mode.c;
        } catch (_error) {}
        const row = map.core.panoramas[match.mapIndex];
        return {
          ...match,
          slot,
          heading: row.h[slot],
          view: streetViewThumbnail(row, slot),
          viewSimilarity: match.similarity,
          reciprocal: false,
        };
      }));
      const independentAreas = new Set(entries.map((entry) => (
        `${Math.round(entry.latitude * 2) / 2}:${Math.round(entry.longitude * 2) / 2}`
      ))).size;
      const strongest = entries[0]?.similarity || 0;
      const weakest = entries[entries.length - 1]?.similarity || strongest;
      const agreement = clamp(1 - Math.max(0, strongest - weakest), 0, 1);
      return {
        datasetKey: map.entry.datasetKey,
        mapIndex: -1,
        universal: true,
        panoId: query.panoId,
        neighborsConsidered: visualMatches.length,
        defaultMode: "literal",
        warning: "Visual agreement is evidence, not proof of a geographic meta.",
        queryLocation: { latitude, longitude },
        modes: [{
          id: "literal",
          label: "Nearest 8",
          currentSlot: 0,
          currentHeading: query.headings[0],
          currentView: query.viewUrls[0],
          support: entries.length,
          weightedSupport: entries.length,
          coherence: agreement,
          alignment: agreement,
          reciprocalSupport: 0,
          independentAreas,
          entries,
        }],
      };
    }

    async universalReview(
      panoId, latitude, longitude, sourceMapKey, roundScore = null, roundDistanceM = null,
    ) {
      if (!this.universal || !panoId) return null;
      const descriptor = await this.universal.descriptor();
      const map = await this.loadMap(descriptor.datasetKey || "balanced-world-50k");
      const query = await this.universal.query(panoId, [0, 90, 180, 270], 500);
      const ranked = query.matches.filter((match) => match.panoId !== panoId);
      const boundary = this.universalBoundary(ranked);
      const candidates = ranked.slice(0, boundary.count);
      if (!candidates.length) return null;
      const strongest = candidates[0].similarity;
      const weakest = candidates[candidates.length - 1].similarity;
      const span = Math.max(strongest - weakest, 1e-8);
      const normalized = this.universalWeights(candidates.length);
      const indices = Int32Array.from(candidates.map((match) => match.mapIndex));
      const calibrated = {
        normalized,
        groupIds: Int32Array.from({ length: candidates.length }, (_value, index) => index),
        details: {
          absoluteTopMatchConfidence: null,
          geographicGroups: candidates.length,
          effectiveGeographicGroups: 1 / normalized.reduce(
            (sum, value) => sum + value ** 2, 0,
          ),
          largestGeographicGroupWeight: Math.max(...normalized),
          spatialDeduplicationRadiusKm: null,
        },
      };
      const visualMatches = candidates.map((match, position) => ({
        datasetKey: map.entry.datasetKey,
        mapIndex: match.mapIndex,
        panoId: match.panoId,
        rank: position + 1,
        latitude: match.latitude,
        longitude: match.longitude,
        similarity: match.similarity,
        relativeStrength: clamp((match.similarity - weakest) / span, 0, 1),
        posteriorWeight: normalized[position],
        geographicGroup: position,
        distanceKm: Number.isFinite(latitude) && Number.isFinite(longitude)
          ? haversineKm(latitude, longitude, match.latitude, match.longitude)
          : null,
      }));
      const score = Number(roundScore);
      const distanceKm = Number(roundDistanceM) / 1000;
      const inferredDiagonalKm = Number.isFinite(score) && score > 0 && score < 5000
          && Number.isFinite(distanceKm) && distanceKm > 0
        ? -10 * distanceKm / Math.log(score / 5000)
        : null;
      const mapDiagonalKm = Number.isFinite(inferredDiagonalKm) && inferredDiagonalKm > 0
        ? inferredDiagonalKm
        : map.projection.diagonalKm;
      const scoringMap = mapDiagonalKm === map.projection.diagonalKm
        ? map
        : { ...map, projection: { ...map.projection, diagonalKm: mapDiagonalKm } };
      const allDistances = Number.isFinite(latitude) && Number.isFinite(longitude)
        ? map.core.panoramas.map((row) => haversineKm(latitude, longitude, row.a, row.o))
        : [];
      const radii = this.localityRadii(mapDiagonalKm).map((radiusKm) => {
        const matches = visualMatches.filter((row) => (
          Number.isFinite(row.distanceKm) && row.distanceKm <= radiusKm
        )).length;
        const mapLocations = allDistances.filter((distance) => distance <= radiusKm).length;
        const expected = visualMatches.length * mapLocations
          / Math.max(map.core.panoramas.length, 1);
        const bits = Math.log2((matches + 0.5) / (expected + 0.5));
        return {
          radiusKm, matches, mapLocations,
          densityAdjustedRatio: 2 ** bits,
          densityAdjustedBits: bits,
        };
      });
      const distances = visualMatches.map((row) => row.distanceKm)
        .filter(Number.isFinite).sort((left, right) => left - right);
      const quantile = (fraction) => distances.length
        ? distances[Math.floor((distances.length - 1) * fraction)]
        : null;
      const visualNeighborhood = {
        representation: "browser-local DINOv2/DINOv3 ensemble against the World 50K pilot corpus",
        neighbors: visualMatches.length,
        mapDiagonalKm,
        coordinateBlind: true,
        universal: true,
        corpusLabel: query.corpusLabel,
        boundary,
        radii,
        radiusProfile: "world-scale",
        medianDistanceKm: quantile(0.5),
        nearestTenthDistanceKm: quantile(0.1),
        similarityRange: { strongest, weakest },
        posterior: {
          mapLocations: map.core.panoramas.length,
          effectiveLocations: 1 / normalized.reduce((sum, value) => sum + value ** 2, 0),
          displayedLocations: visualMatches.length,
          displayedMass: 1,
          displayPolicy: boundary.detected
            ? "persistent similarity-curve boundary in the World 50K pilot corpus"
            : "diffuse nearest references; no sustained similarity boundary",
          broadDistributionUsedForClick: false,
          semanticMaximumFraction: null,
          temperature: null,
          exactCoreWeight: 1,
        },
        weightedClick: this.optimizeWeightedClick(scoringMap, indices, calibrated),
        visualMatches,
      };
      const visualBoard = await this.universalBoard(
        map, query, visualMatches, latitude, longitude,
      );
      return {
        matched: true,
        universal: true,
        datasetKey: map.entry.datasetKey,
        datasetDisplayName: `${query.corpusLabel} · arbitrary-map query`,
        sourceMapKey,
        matchMethod: "browser-visual-query",
        matchDistanceM: null,
        location: {
          mapIndex: -1,
          panoId,
          latitude,
          longitude,
          headings: query.headings,
          views: query.viewUrls,
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
          hiddenNearDuplicates: 0,
          minimumExemplarPercentile: null,
          maximumClues: 0,
          scheduledLessons: 0,
        },
        universalTiming: query.timing,
        visualNeighborhood,
        visualBoard,
        metas: [],
        moreMetas: [],
      };
    }

    async projectedPosterior(map, mapIndex) {
      const projection = await this.panoramaProjection(map);
      if (!projection) return null;
      const descriptor = map.manifest.panoramaProjection.posterior;
      const { view, panoramas, dimensions, normOffset, vectorOffset, bytesPerRow } = projection;
      const query = new Int8Array(dimensions);
      const queryOffset = vectorOffset + mapIndex * bytesPerRow;
      for (let packed = 0; packed < bytesPerRow; packed += 1) {
        const value = view.getUint8(queryOffset + packed);
        query[packed * 2] = (value & 15) - 7;
        query[packed * 2 + 1] = (value >>> 4) - 7;
      }
      const queryNorm = Math.sqrt(view.getUint16(normOffset + mapIndex * 2, true));
      const scores = new Float32Array(panoramas);
      let maximum = -Infinity;
      for (let row = 0; row < panoramas; row += 1) {
        if (row === mapIndex) { scores[row] = -1; continue; }
        const offset = vectorOffset + row * bytesPerRow;
        let dot = 0;
        for (let packed = 0; packed < bytesPerRow; packed += 1) {
          const value = view.getUint8(offset + packed);
          dot += query[packed * 2] * ((value & 15) - 7);
          dot += query[packed * 2 + 1] * ((value >>> 4) - 7);
        }
        const norm = Math.sqrt(view.getUint16(normOffset + row * 2, true));
        const score = dot / Math.max(queryNorm * norm, 1e-8);
        scores[row] = score;
        if (score > maximum) maximum = score;
      }
      const temperature = Number(descriptor.temperature || 0.02);
      const weights = new Float32Array(panoramas);
      let total = 0;
      for (let row = 0; row < panoramas; row += 1) {
        if (row === mapIndex) continue;
        const weight = Math.exp((scores[row] - maximum) / temperature);
        weights[row] = weight;
        total += weight;
      }
      let squareSum = 0;
      let maximumWeight = 0;
      for (let row = 0; row < panoramas; row += 1) {
        weights[row] /= total;
        squareSum += weights[row] ** 2;
        maximumWeight = Math.max(maximumWeight, weights[row]);
      }
      return {
        weights,
        effectiveLocations: 1 / Math.max(squareSum, 1e-12),
        maximumWeight,
        temperature,
      };
    }

    calibratedWeights(map, indices, similarities) {
      const calibration = map.manifest.neighborCalibration;
      const knots = calibration.calibrationKnots;
      const confidence = interpolate(
        similarities[0], knots.similarity, knots.probabilityWithinRadius,
      );
      const settings = calibration.posteriorSettings;
      const span = Math.max(similarities[0] - similarities[similarities.length - 1], 1e-8);
      const base = Array.from(similarities, (similarity) => (
        settings.weightFloor
        + confidence * clamp((similarity - similarities[similarities.length - 1]) / span, 0, 1)
          ** settings.relativeSimilarityPower
      ));
      const remaining = new Set(indices.map((_value, index) => index));
      const groups = [];
      while (remaining.size) {
        const anchor = remaining.values().next().value;
        const anchorIndex = indices[anchor];
        const ax = map.projection.xy[anchorIndex * 2];
        const ay = map.projection.xy[anchorIndex * 2 + 1];
        const group = [];
        for (const position of remaining) {
          const candidate = indices[position];
          const distance = Math.hypot(
            map.projection.xy[candidate * 2] - ax,
            map.projection.xy[candidate * 2 + 1] - ay,
          );
          if (distance <= settings.spatialDeduplicationRadiusKm) group.push(position);
        }
        group.forEach((position) => remaining.delete(position));
        groups.push(group);
      }
      const weights = new Float64Array(indices.length);
      const groupIds = new Int32Array(indices.length);
      groups.forEach((group, groupId) => {
        const total = Math.max(...group.map((position) => base[position]));
        const denominator = group.reduce((sum, position) => sum + base[position], 0);
        group.forEach((position) => {
          weights[position] = total * base[position] / denominator;
          groupIds[position] = groupId;
        });
      });
      const totalWeight = weights.reduce((sum, value) => sum + value, 0);
      const normalized = Float64Array.from(weights, (value) => value / totalWeight);
      const groupMass = groups.map((group) => (
        group.reduce((sum, position) => sum + normalized[position], 0)
      ));
      return {
        weights,
        normalized,
        groupIds,
        details: {
          absoluteTopMatchConfidence: confidence,
          geographicGroups: groups.length,
          effectiveGeographicGroups: 1 / groupMass.reduce((sum, value) => sum + value ** 2, 0),
          largestGeographicGroupWeight: Math.max(...groupMass),
          spatialDeduplicationRadiusKm: settings.spatialDeduplicationRadiusKm,
        },
      };
    }

    localityRadii(diagonalKm) {
      if (diagonalKm <= 300) return [0.5, 1, 2, 5];
      if (diagonalKm <= 15000) return [10, 25, 100, 500];
      return [50, 100, 500, 2000];
    }

    async computeNeighborhood(map, mapIndex) {
      const { indices, similarities } = await this.neighborRow(map, mapIndex);
      const boundary = await this.boundaryRow(map, mapIndex).catch(() => null);
      const origin = map.core.panoramas[mapIndex];
      let posterior = null;
      if (map.manifest.panoramaProjection) {
        try { posterior = await this.projectedPosterior(map, mapIndex); } catch (_error) {}
      }
      // The full projected posterior is useful for estimating where to click, but its
      // weak long tail is not a useful collection of examples to draw or study.
      // Keep the visible dots to the high-fidelity, self-tuned exact-neighbor core.
      const displayIndices = Array.from(indices);
      const displaySimilarities = Array.from(similarities);
      const strongest = displaySimilarities[0];
      const weakest = displaySimilarities[displaySimilarities.length - 1];
      const span = Math.max(strongest - weakest, 1e-8);
      const calibrated = this.calibratedWeights(map, indices, similarities);
      if (posterior) {
        const coreWeight = Number(
          map.manifest.panoramaProjection.posterior.exactCoreWeight ?? 0.50,
        );
        const broadWeight = 1 - coreWeight;
        posterior.clickWeights = Float32Array.from(
          posterior.weights, (weight) => weight * broadWeight,
        );
        for (let position = 0; position < indices.length; position += 1) {
          posterior.clickWeights[indices[position]] += (
            coreWeight * calibrated.normalized[position]
          );
        }
        let clickSquareSum = 0;
        let clickMaximum = 0;
        for (const weight of posterior.clickWeights) {
          clickSquareSum += weight ** 2;
          clickMaximum = Math.max(clickMaximum, weight);
        }
        posterior.clickEffectiveLocations = 1 / Math.max(clickSquareSum, 1e-12);
        posterior.clickMaximumWeight = clickMaximum;
        posterior.exactCoreWeight = coreWeight;
      }
      const visualMatches = displayIndices.map((neighborIndex, position) => {
        const row = map.core.panoramas[neighborIndex];
        return {
          datasetKey: map.entry.datasetKey,
          mapIndex: neighborIndex,
          panoId: row.p,
          rank: position + 1,
          latitude: row.a,
          longitude: row.o,
          similarity: displaySimilarities[position],
          relativeStrength: clamp((displaySimilarities[position] - weakest) / span, 0, 1),
          posteriorWeight: posterior
            ? posterior.clickWeights[neighborIndex]
            : calibrated.normalized[position],
          geographicGroup: calibrated.groupIds[position],
          distanceKm: haversineKm(origin.a, origin.o, row.a, row.o),
        };
      });
      const allDistances = map.core.panoramas.map((row) => (
        haversineKm(origin.a, origin.o, row.a, row.o)
      ));
      const radii = this.localityRadii(map.projection.diagonalKm).map((radiusKm) => {
        const matches = visualMatches.filter((row) => row.distanceKm <= radiusKm).length;
        const mapLocations = Math.max(
          0, allDistances.filter((distance) => distance <= radiusKm).length - 1,
        );
        const expected = visualMatches.length * mapLocations
          / Math.max(map.core.panoramas.length - 1, 1);
        const bits = Math.log2((matches + 0.5) / (expected + 0.5));
        return {
          radiusKm,
          matches,
          mapLocations,
          densityAdjustedRatio: 2 ** bits,
          densityAdjustedBits: bits,
        };
      });
      const sortedDistances = visualMatches.map((row) => row.distanceKm).sort((a, b) => a - b);
      const quantile = (fraction) => sortedDistances[Math.floor((sortedDistances.length - 1) * fraction)];
      const result = {
        representation: posterior
          ? "map-wide quantized C-RADIOv4-H projection with exact-neighbor core"
          : "raw C-RADIOv4-H fused panorama embedding",
        neighbors: visualMatches.length,
        mapDiagonalKm: map.projection.diagonalKm,
        coordinateBlind: true,
        boundary,
        radii,
        radiusProfile: "map-scale-aware",
        medianDistanceKm: quantile(0.5),
        nearestTenthDistanceKm: quantile(0.1),
        similarityRange: { strongest, weakest },
        posterior: posterior ? {
          mapLocations: map.core.panoramas.length - 1,
          effectiveLocations: posterior.effectiveLocations,
          displayedLocations: visualMatches.length,
          displayedMass: displayIndices.reduce(
            (sum, index) => sum + posterior.weights[index], 0,
          ),
          displayPolicy: boundary?.detected
            ? "sustained per-round similarity-curve change point"
            : "diffuse self-tuned nearest examples; no sustained change point",
          broadDistributionUsedForClick: true,
          semanticMaximumFraction: null,
          temperature: posterior.temperature,
          exactCoreWeight: posterior.exactCoreWeight,
        } : null,
        weightedClick: null,
        visualMatches,
      };
      return { result, indices, calibrated, posterior };
    }

    async neighborhood(map, mapIndex, includeWeightedClick) {
      const key = `${map.entry.datasetKey}:${mapIndex}`;
      if (!this.neighborhoodPromises.has(key)) {
        this.neighborhoodPromises.set(key, this.computeNeighborhood(map, mapIndex));
      }
      const computed = await this.neighborhoodPromises.get(key);
      if (includeWeightedClick) {
        if (!this.weightedNeighborhoodPromises.has(key)) {
          this.weightedNeighborhoodPromises.set(key, Promise.resolve().then(() => ({
            ...computed.result,
            weightedClick: computed.posterior
              ? this.optimizePosteriorClick(map, computed.posterior)
              : this.optimizeWeightedClick(map, computed.indices, computed.calibrated),
          })));
        }
        return this.weightedNeighborhoodPromises.get(key);
      }
      const result = { ...computed.result };
      return result;
    }

    optimizePosteriorClick(map, posterior) {
      const binsAcross = 32;
      const binsDown = 32;
      const bins = binsAcross * binsDown;
      const mass = new Float64Array(bins);
      const sphereX = new Float64Array(bins);
      const sphereY = new Float64Array(bins);
      const sphereZ = new Float64Array(bins);
      let latitudeMinimum = Infinity;
      let latitudeMaximum = -Infinity;
      let longitudeSin = 0;
      let longitudeCos = 0;
      for (const row of map.core.panoramas) {
        latitudeMinimum = Math.min(latitudeMinimum, row.a);
        latitudeMaximum = Math.max(latitudeMaximum, row.a);
        longitudeSin += Math.sin(row.o * Math.PI / 180);
        longitudeCos += Math.cos(row.o * Math.PI / 180);
      }
      const longitudeCenter = Math.atan2(longitudeSin, longitudeCos) * 180 / Math.PI;
      const longitudeDeltas = map.core.panoramas.map((row) => (
        ((row.o - longitudeCenter + 540) % 360) - 180
      ));
      let longitudeMinimum = Infinity;
      let longitudeMaximum = -Infinity;
      for (const value of longitudeDeltas) {
        longitudeMinimum = Math.min(longitudeMinimum, value);
        longitudeMaximum = Math.max(longitudeMaximum, value);
      }
      const latitudeSpan = Math.max(latitudeMaximum - latitudeMinimum, 1e-8);
      const longitudeSpan = Math.max(longitudeMaximum - longitudeMinimum, 1e-8);
      for (let index = 0; index < map.core.panoramas.length; index += 1) {
        const weight = (posterior.clickWeights || posterior.weights)[index];
        if (!weight) continue;
        const point = map.core.panoramas[index];
        const column = Math.min(binsAcross - 1, Math.max(
          0, Math.floor((longitudeDeltas[index] - longitudeMinimum) / longitudeSpan * binsAcross),
        ));
        const row = Math.min(binsDown - 1, Math.max(
          0, Math.floor((point.a - latitudeMinimum) / latitudeSpan * binsDown),
        ));
        const bin = row * binsAcross + column;
        const latitude = point.a * Math.PI / 180;
        const longitude = point.o * Math.PI / 180;
        mass[bin] += weight;
        sphereX[bin] += weight * Math.cos(latitude) * Math.cos(longitude);
        sphereY[bin] += weight * Math.cos(latitude) * Math.sin(longitude);
        sphereZ[bin] += weight * Math.sin(latitude);
      }
      const targets = [];
      for (let bin = 0; bin < bins; bin += 1) {
        if (mass[bin] <= 0) continue;
        const longitude = Math.atan2(sphereY[bin], sphereX[bin]);
        const latitude = Math.atan2(
          sphereZ[bin], Math.hypot(sphereX[bin], sphereY[bin]),
        );
        targets.push([latitude * 180 / Math.PI, longitude * 180 / Math.PI, mass[bin]]);
      }
      const sigma = map.manifest.neighborCalibration.posteriorSettings.locationUncertaintySigmaKm;
      const expected = (point) => {
        let score = 0;
        for (const target of targets) {
          score += target[2] * this.scoreDistance(
            haversineKm(point[0], point[1], target[0], target[1]),
            map.projection.diagonalKm,
            sigma,
          );
        }
        return score;
      };
      let best = targets[0];
      let expectedScore = -Infinity;
      for (const target of targets) {
        const score = expected(target);
        if (score > expectedScore) { best = target; expectedScore = score; }
      }
      return {
        latitude: best[0],
        longitude: best[1],
        expectedScore,
        effectiveNeighbors: posterior.clickEffectiveLocations || posterior.effectiveLocations,
        maximumWeight: posterior.clickMaximumWeight || posterior.maximumWeight,
        minimumWeight: 0,
        smoothingSigmaKm: sigma,
        geographicGroups: targets.length,
        effectiveGeographicGroups: targets.length,
        largestGeographicGroupWeight: Math.max(...targets.map((target) => target[2])),
        spatialDeduplicationRadiusKm: null,
        weighting: "uncapped map-wide visual posterior blended with the exact visual core and aggregated to a deterministic geographic grid",
      };
    }

    scoreDistance(distanceKm, diagonalKm, sigmaKm) {
      if (!sigmaKm) return 5000 * Math.exp(-10 * distanceKm / diagonalKm);
      // Deterministic 3×3 normal quadrature is close to the server's 7×7
      // Gauss-Hermite smoothing while keeping browser interaction inexpensive.
      const offsets = [-1.224744871 * sigmaKm, 0, 1.224744871 * sigmaKm];
      const weights = [1 / 6, 2 / 3, 1 / 6];
      let result = 0;
      for (let x = 0; x < 3; x += 1) {
        for (let y = 0; y < 3; y += 1) {
          const distance = Math.hypot(distanceKm - offsets[x], offsets[y]);
          result += weights[x] * weights[y] * 5000 * Math.exp(-10 * distance / diagonalKm);
        }
      }
      return result;
    }

    optimizeWeightedClick(map, indices, calibrated) {
      const targets = Array.from(indices, (index) => [
        map.projection.xy[index * 2], map.projection.xy[index * 2 + 1],
      ]);
      const bounds = map.projection.bounds;
      const spans = [bounds[2] - bounds[0], bounds[3] - bounds[1]];
      let spacing = Math.max(2, Math.sqrt(spans[0] * spans[1] / 1024));
      while ((Math.floor(spans[0] / spacing) + 1) * (Math.floor(spans[1] / spacing) + 1) > 1024) {
        spacing *= 1.05;
      }
      const sigma = map.manifest.neighborCalibration.posteriorSettings.locationUncertaintySigmaKm;
      const expected = (point) => {
        let score = 0;
        for (let index = 0; index < targets.length; index += 1) {
          score += calibrated.normalized[index] * this.scoreDistance(
            Math.hypot(point[0] - targets[index][0], point[1] - targets[index][1]),
            map.projection.diagonalKm,
            sigma,
          );
        }
        return score;
      };
      const choose = (candidates) => {
        let best = candidates[0];
        let bestScore = -Infinity;
        for (const candidate of candidates) {
          const score = expected(candidate);
          if (score > bestScore) {
            best = candidate;
            bestScore = score;
          }
        }
        return [best, bestScore];
      };
      const coarse = [...targets];
      for (let x = bounds[0]; x <= bounds[2] + spacing * 0.5; x += spacing) {
        for (let y = bounds[1]; y <= bounds[3] + spacing * 0.5; y += spacing) coarse.push([x, y]);
      }
      let [center] = choose(coarse);
      const localGrid = (point, radius, step) => {
        const result = [];
        for (let x = point[0] - radius; x <= point[0] + radius + step * 0.5; x += step) {
          for (let y = point[1] - radius; y <= point[1] + radius + step * 0.5; y += step) {
            result.push([x, y]);
          }
        }
        return result;
      };
      [center] = choose(localGrid(center, 2, 0.25));
      const [point, expectedScore] = choose(localGrid(center, 0.30, 0.05));
      return {
        latitude: point[1] / 110.574 + map.projection.meanLat,
        longitude: point[0] / (111.320 * map.projection.cosine) + map.projection.meanLng,
        expectedScore,
        effectiveNeighbors: 1 / calibrated.normalized.reduce((sum, value) => sum + value ** 2, 0),
        maximumWeight: Math.max(...calibrated.normalized),
        minimumWeight: Math.min(...calibrated.normalized),
        smoothingSigmaKm: sigma,
        weighting: "portable calibrated similarity, geographic deduplication, and deterministic smoothing",
        ...calibrated.details,
      };
    }

    detectorPublic(map, detectorIndex, percentile, matchMode, activeVariants) {
      const detector = map.core.detectors[detectorIndex];
      const click = detector.c || null;
      const expected = click?.s?.expected || {};
      const payload = {
        id: detector.i,
        title: detector.t,
        subtitle: detector.s,
        description: detector.x,
        bits: detector.b,
        repeatability: detector.r,
        members: detector.m,
        prevalence: detector.p,
        specificityBits: Math.round(specificityBits(detector.m, map.core.panoramas.length) * 1000) / 1000,
        idealAverageScore: detector.a ?? expected.e ?? 0,
        uplift: detector.u ?? expected.u ?? 0,
        frontier: detector.f ?? 1,
        conceptFamily: detector.g ?? detectorIndex,
        familyDetectors: detector.gs ?? 1,
        activeVariants: activeVariants || 0,
        operatingPoint: detector.op,
        sizeBand: detector.sz,
        evidenceTier: detector.rr,
        replicationTier: detector.rt,
        click,
        assets: {
          examples: `portable-meta-examples://${map.entry.datasetKey}/${detectorIndex}`,
          catalogMap: "",
          clickMap: "",
        },
        matchMode: matchMode || "catalog",
      };
      if (percentile != null) {
        payload.matchPercentile = percentile;
        payload.topMatchPercent = Math.max(1, 101 - percentile);
        payload.globalMatchRank = globalMatchRank(detector.m, percentile);
        payload.globalTopMatchPercent = 100 * payload.globalMatchRank / map.core.panoramas.length;
        payload.matchStrength = percentile;
      }
      return payload;
    }

    memberJaccard(map, left, right) {
      const a = map.core.members[left] || [];
      const b = map.core.members[right] || [];
      let ai = 0;
      let bi = 0;
      let intersection = 0;
      while (ai < a.length && bi < b.length) {
        if (a[ai] === b[bi]) { intersection += 1; ai += 1; bi += 1; }
        else if (a[ai] < b[bi]) ai += 1;
        else bi += 1;
      }
      return intersection / Math.max(a.length + b.length - intersection, 1);
    }

    async review(map, mapIndex, method, distance) {
      const panorama = map.core.panoramas[mapIndex];
      const detectorIndices = panorama.d || [];
      const percentiles = panorama.q || detectorIndices.map(() => 100);
      const policy = map.core.reviewPolicy || {};
      const minimum = Number(policy.minimumExemplarPercentile || 80);
      const maximum = Number(policy.maximumCluesPerRound || 3);
      const byFamily = new Map();
      detectorIndices.forEach((detectorIndex, position) => {
        const detector = map.core.detectors[detectorIndex];
        const percentile = Number(percentiles[position] || 100);
        const family = Number(detector.g ?? detectorIndex);
        const priority = reviewPriority(
          detector.b, detector.m, percentile, map.core.panoramas.length, minimum,
        );
        const key = [priority, specificityBits(detector.m, map.core.panoramas.length), percentile, detector.b];
        const group = byFamily.get(family) || { family, active: 0, best: null, key: [-1, -1, -1, -1] };
        group.active += 1;
        if (percentile >= minimum && key.some((value, index) => (
          value > group.key[index] && key.slice(0, index).every((prior, priorIndex) => prior === group.key[priorIndex])
        ))) {
          group.key = key;
          group.best = [detectorIndex, percentile];
        }
        byFamily.set(family, group);
      });
      const compareKey = (left, right) => {
        for (let index = 0; index < left.key.length; index += 1) {
          if (left.key[index] !== right.key[index]) return right.key[index] - left.key[index];
        }
        return 0;
      };
      const strong = Array.from(byFamily.values()).filter((group) => group.best).sort(compareKey);
      const available = [];
      let hiddenNearDuplicates = 0;
      for (const group of strong) {
        if (available.some((prior) => (
          this.memberJaccard(map, group.best[0], prior.best[0]) >= Number(policy.panoramaDuplicateJaccard || 0.85)
        ))) {
          hiddenNearDuplicates += 1;
          continue;
        }
        available.push(group);
        if (available.length >= maximum + 12) break;
      }
      const shown = available.slice(0, maximum);
      const deferred = available.slice(maximum);
      let metas = shown.map((group) => this.detectorPublic(
        map, group.best[0], group.best[1], "strong", group.active,
      ));
      const moreMetas = deferred.map((group) => this.detectorPublic(
        map, group.best[0], group.best[1], "strong", group.active,
      ));
      let fallbackUsed = false;
      if (!metas.length && panorama.n != null) {
        const representative = map.core.families[panorama.n]?.r ?? panorama.n;
        metas = [this.detectorPublic(
          map, representative, panorama.rp || 1, "nearest", 0,
        )];
        fallbackUsed = true;
      }
      const visualNeighborhood = await this.neighborhood(map, mapIndex, false);
      return {
        matched: true,
        datasetKey: map.entry.datasetKey,
        datasetDisplayName: map.entry.displayName,
        matchMethod: method,
        matchDistanceM: distance,
        location: {
          mapIndex,
          panoId: panorama.p,
          latitude: panorama.a,
          longitude: panorama.o,
          headings: panorama.h,
          views: panorama.h.map((_heading, slot) => streetViewThumbnail(panorama, slot)),
        },
        reviewSummary: {
          rawDetectorMatches: detectorIndices.length,
          conceptMatches: byFamily.size,
          strongConceptMatches: strong.length,
          shown: metas.length,
          fallbackUsed,
          hiddenRedundantMatches: detectorIndices.length - byFamily.size,
          hiddenWeakMatches: byFamily.size - strong.length,
          hiddenByAttentionBudget: Math.max(0, strong.length - shown.length - hiddenNearDuplicates),
          hiddenNearDuplicates,
          minimumExemplarPercentile: minimum,
          maximumClues: maximum,
          scheduledLessons: 0,
        },
        visualNeighborhood,
        metas,
        moreMetas,
      };
    }

    async meta(map, detectorIndex) {
      const payload = this.detectorPublic(map, detectorIndex);
      payload.distribution = (map.core.members[detectorIndex] || []).map((index) => {
        const row = map.core.panoramas[index];
        return {
          latitude: row.a,
          longitude: row.o,
          mapIndex: index,
          panoId: row.p,
          datasetKey: map.entry.datasetKey,
        };
      });
      payload.datasetKey = map.entry.datasetKey;
      return payload;
    }

    async exampleViews(map, detectorIndex, currentMapIndex) {
      const detector = map.core.detectors[detectorIndex];
      if (!detector) throw new Error(`Unknown detector index ${detectorIndex}`);
      const seen = new Set();
      const examples = [];
      const candidateIndices = [];
      for (const pair of detector.e || []) {
        const mapIndex = Number(pair[0]);
        if (Number.isInteger(mapIndex) && !candidateIndices.includes(mapIndex)) {
          candidateIndices.push(mapIndex);
        }
        if (candidateIndices.length >= 12) break;
      }
      let selectedSlots = null;
      if (map.manifest.viewProjection && candidateIndices.length) {
        try {
          const requested = Number.isInteger(currentMapIndex)
            ? [currentMapIndex, ...candidateIndices.filter((index) => index !== currentMapIndex)]
            : candidateIndices;
          const projected = await this.projectedViews(map, requested);
          const byIndex = new Map(requested.map((index, position) => [index, projected[position]]));
          const dimensions = map.manifest.viewProjection.dimensions;
          const center = new Float64Array(dimensions);
          for (const mapIndex of candidateIndices) {
            const vectors = byIndex.get(mapIndex);
            if (!vectors) continue;
            for (let slot = 0; slot < 4; slot += 1) {
              for (let dimension = 0; dimension < dimensions; dimension += 1) {
                center[dimension] += vectors[slot * dimensions + dimension] / 127;
              }
            }
          }
          const denominator = Math.max(candidateIndices.length * 4, 1);
          const globalMean = map.manifest.viewProjection.globalMean || [];
          for (let dimension = 0; dimension < dimensions; dimension += 1) {
            center[dimension] = center[dimension] / denominator - Number(globalMean[dimension] || 0);
          }
          selectedSlots = new Map();
          for (const mapIndex of requested) {
            const vectors = byIndex.get(mapIndex);
            let bestSlot = 0;
            let bestScore = -Infinity;
            for (let slot = 0; slot < 4; slot += 1) {
              let score = 0;
              for (let dimension = 0; dimension < dimensions; dimension += 1) {
                score += vectors[slot * dimensions + dimension] * center[dimension];
              }
              if (score > bestScore) { bestScore = score; bestSlot = slot; }
            }
            selectedSlots.set(mapIndex, bestSlot);
          }
        } catch (_error) {}
      }

      // The board's main-group direction is a strong, map-independent default
      // for the current round. Detector-specific exemplar directions follow.
      if (Number.isInteger(currentMapIndex)
          && currentMapIndex >= 0
          && currentMapIndex < map.core.panoramas.length) {
        let slot = selectedSlots?.get(currentMapIndex) ?? 0;
        if (!selectedSlots) {
          try {
            const board = await this.visualBoardSource(map, currentMapIndex);
            const mode = board.m.find((item) => item.i === board.d) || board.m[0];
            if (mode && Number.isInteger(mode.c)) slot = mode.c;
          } catch (_error) {}
        }
        const row = map.core.panoramas[currentMapIndex];
        examples.push({
          mapIndex: currentMapIndex,
          slot,
          heading: row.h[slot],
          current: true,
          view: streetViewThumbnail(row, slot),
        });
        seen.add(currentMapIndex);
      }

      for (const mapIndex of candidateIndices) {
        if (examples.length >= 9) break;
        const slot = selectedSlots?.get(mapIndex) ?? 0;
        if (!Number.isInteger(mapIndex) || seen.has(mapIndex)) continue;
        const row = map.core.panoramas[mapIndex];
        if (!row || slot < 0 || slot >= row.h.length) continue;
        examples.push({
          mapIndex,
          slot,
          heading: row.h[slot],
          current: false,
          view: streetViewThumbnail(row, slot),
        });
        seen.add(mapIndex);
      }
      return examples;
    }

    async visualBoard(map, mapIndex) {
      const neighborhood = await this.neighborhood(map, mapIndex, false);
      const current = map.core.panoramas[mapIndex];
      const source = await this.visualBoardSource(map, mapIndex);
      const matchByIndex = new Map(
        neighborhood.visualMatches.map((match) => [match.mapIndex, match]),
      );
      const modes = source.m.map((mode) => ({
        id: mode.i,
        label: mode.l,
        currentSlot: mode.c,
        currentHeading: current.h[mode.c],
        currentView: streetViewThumbnail(current, mode.c),
        support: mode.s,
        weightedSupport: mode.w,
        coherence: mode.h,
        alignment: mode.a,
        reciprocalSupport: mode.r,
        independentAreas: mode.g,
        entries: mode.e.map(([entryIndex, rank, slot, viewSimilarity, reciprocal]) => {
          const row = map.core.panoramas[entryIndex];
          const match = matchByIndex.get(entryIndex) || {
            datasetKey: map.entry.datasetKey,
            mapIndex: entryIndex,
            panoId: row.p,
            rank,
            latitude: row.a,
            longitude: row.o,
            similarity: viewSimilarity,
            relativeStrength: 0,
            posteriorWeight: 0,
            geographicGroup: -1,
            distanceKm: haversineKm(current.a, current.o, row.a, row.o),
          };
          return {
            ...match,
            rank,
            slot,
            heading: row.h[slot],
            view: streetViewThumbnail(row, slot),
            viewSimilarity,
            reciprocal: Boolean(reciprocal),
          };
        }),
      }));
      return {
        datasetKey: map.entry.datasetKey,
        mapIndex,
        panoId: current.p,
        neighborsConsidered: 100,
        defaultMode: source.d,
        warning: "Visual agreement is evidence, not proof of a geographic meta.",
        modes,
      };
    }

    projectionLookup(map) {
      if (map.projectionLookup) return map.projectionLookup;
      const descriptor = map.manifest.viewProjection;
      if (!descriptor) return null;
      const lookup = new Int32Array(map.core.panoramas.length);
      lookup.fill(-1);
      descriptor.chunks.forEach((chunk, chunkIndex) => {
        (chunk.mapIndices || []).forEach((mapIndex, localIndex) => {
          lookup[mapIndex] = (chunkIndex << 16) | localIndex;
        });
      });
      map.projectionLookup = lookup;
      return lookup;
    }

    async projectionChunk(map, chunkIndex) {
      const descriptor = map.manifest.viewProjection;
      const chunk = descriptor?.chunks?.[chunkIndex];
      if (!chunk) throw new Error("Portable view projection chunk is unavailable");
      const key = `${map.entry.datasetKey}:projection:${chunk.file}`;
      if (!this.projectionChunkPromises.has(key)) {
        this.projectionChunkPromises.set(key, (async () => {
          let buffer = await this.asset(
            `maps/${map.entry.datasetKey}/view-projection/${chunk.file}`,
            chunk.sha256,
          );
          buffer = await gunzip(buffer);
          const view = new DataView(buffer);
          const magic = textDecoder.decode(new Uint8Array(buffer, 0, 8));
          const version = view.getUint32(8, true);
          const panoramas = view.getUint32(12, true);
          const views = view.getUint32(16, true);
          const dimensions = view.getUint32(20, true);
          if (magic !== "OMTVPR01" || version !== 1 || views !== 4
              || dimensions !== descriptor.dimensions) {
            throw new Error("Unsupported portable view projection chunk");
          }
          const mapIndices = new Int32Array(buffer, 24, panoramas);
          const vectors = new Int8Array(buffer, 24 + panoramas * 4);
          return { mapIndices, vectors, panoramas, views, dimensions };
        })());
      }
      return this.projectionChunkPromises.get(key);
    }

    async projectedViews(map, mapIndices) {
      const lookup = this.projectionLookup(map);
      if (!lookup) throw new Error("Guess-local view matching is unavailable for this map");
      const descriptor = map.manifest.viewProjection;
      const chunks = new Map();
      for (const mapIndex of mapIndices) {
        const packed = lookup[mapIndex];
        if (packed < 0) throw new Error(`Missing projected views for panorama ${mapIndex}`);
        const chunkIndex = packed >>> 16;
        if (!chunks.has(chunkIndex)) chunks.set(chunkIndex, this.projectionChunk(map, chunkIndex));
      }
      const loaded = new Map();
      for (const [chunkIndex, promise] of chunks) loaded.set(chunkIndex, await promise);
      return Array.from(mapIndices, (mapIndex) => {
        const packed = lookup[mapIndex];
        const chunk = loaded.get(packed >>> 16);
        const local = packed & 0xffff;
        if (chunk.mapIndices[local] !== mapIndex) {
          throw new Error(`Corrupt projected-view lookup for panorama ${mapIndex}`);
        }
        const start = local * 4 * descriptor.dimensions;
        return chunk.vectors.subarray(start, start + 4 * descriptor.dimensions);
      });
    }

    async guessLocalContext(map, mapIndex, latitude, longitude, neighborhood) {
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !map.manifest.viewProjection) {
        return null;
      }
      const distances = map.core.panoramas.map((row, index) => (
        index === mapIndex ? Infinity : haversineKm(latitude, longitude, row.a, row.o)
      ));
      const positions = Array.from({ length: distances.length }, (_value, index) => index);
      positions.sort((left, right) => distances[left] - distances[right]);
      const pool = positions.slice(0, Math.min(160, Math.max(0, positions.length - 1)));
      if (!pool.length) return null;
      const [current, ...candidates] = await this.projectedViews(map, [mapIndex, ...pool]);
      return {
        map,
        pool,
        distances,
        current,
        candidates,
        neighborhoodRanks: new Map(
          neighborhood.visualMatches.map((match) => [match.mapIndex, match.rank]),
        ),
      };
    }

    guessLocalMatch(context, currentSlot) {
      if (!context) return null;
      const { map, pool, distances, current, candidates, neighborhoodRanks } = context;
      const dimensions = map.manifest.viewProjection.dimensions;
      const currentOffset = currentSlot * dimensions;
      let bestPosition = 0;
      let bestSlot = 0;
      let bestScore = -Infinity;
      candidates.forEach((vectors, position) => {
        for (let slot = 0; slot < 4; slot += 1) {
          let score = 0;
          const offset = slot * dimensions;
          for (let dimension = 0; dimension < dimensions; dimension += 1) {
            score += vectors[offset + dimension] * current[currentOffset + dimension];
          }
          if (score > bestScore) {
            bestScore = score;
            bestPosition = position;
            bestSlot = slot;
          }
        }
      });
      const candidate = pool[bestPosition];
      const row = map.core.panoramas[candidate];
      return {
        kind: "guess-local",
        mapIndex: candidate,
        panoId: row.p,
        latitude: row.a,
        longitude: row.o,
        slot: bestSlot,
        heading: row.h[bestSlot],
        view: streetViewThumbnail(row, bestSlot),
        viewSimilarity: clamp(bestScore / (127 * 127), -1, 1),
        distanceFromGuessKm: distances[candidate],
        candidatePool: pool.length,
        poolRadiusKm: distances[pool[pool.length - 1]],
        globalPanoRank: neighborhoodRanks.get(candidate) || null,
        approximateProjection: true,
      };
    }

    async visualBoardWithGuess(map, mapIndex, board, latitude, longitude) {
      const neighborhood = await this.neighborhood(map, mapIndex, false);
      const context = await this.guessLocalContext(
        map, mapIndex, latitude, longitude, neighborhood,
      );
      const modes = board.modes.map((mode) => {
        const guessMatch = this.guessLocalMatch(context, mode.currentSlot);
        return guessMatch ? {
          ...mode,
          guessMatch,
          entries: mode.entries.filter((entry) => entry.mapIndex !== guessMatch.mapIndex).slice(0, 7),
        } : mode;
      });
      return {
        ...board,
        playerGuess: { latitude, longitude },
        modes,
      };
    }

    async guessNeighborhood(map, mapIndex, latitude, longitude) {
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const trueNeighborhood = await this.neighborhood(map, mapIndex, false);
      let selected = { index: -1, distanceKm: Infinity };
      for (let index = 0; index < map.core.panoramas.length; index += 1) {
        const row = map.core.panoramas[index];
        const distanceKm = haversineKm(latitude, longitude, row.a, row.o);
        if (distanceKm < selected.distanceKm) selected = { index, distanceKm };
      }
      if (selected.index < 0) return null;
      const anchor = map.core.panoramas[selected.index];
      const boundary = await this.boundaryRow(map, selected.index).catch(() => null);
      const { indices, similarities } = await this.neighborRow(map, selected.index);
      const strongest = similarities[0];
      const weakest = similarities[similarities.length - 1];
      const span = Math.max(strongest - weakest, 1e-8);
      const calibrated = this.calibratedWeights(map, indices, similarities);
      const visualMatches = Array.from(indices, (neighborIndex, position) => {
        const row = map.core.panoramas[neighborIndex];
        return {
          datasetKey: map.entry.datasetKey,
          mapIndex: neighborIndex,
          panoId: row.p,
          rank: position + 1,
          latitude: row.a,
          longitude: row.o,
          similarity: similarities[position],
          relativeStrength: clamp((similarities[position] - weakest) / span, 0, 1),
          posteriorWeight: calibrated.normalized[position],
          geographicGroup: calibrated.groupIds[position],
          distanceKm: haversineKm(anchor.a, anchor.o, row.a, row.o),
        };
      });
      const visualNeighborhood = {
        representation: boundary?.detected
          ? "raw C-RADIOv4-H persistent slope-bounded neighborhood"
          : "raw C-RADIOv4-H diffuse self-tuned neighborhood",
        neighbors: visualMatches.length,
        coordinateBlind: true,
        boundary,
        visualMatches,
      };
      const trueIndices = new Set(
        trueNeighborhood.visualMatches.map((match) => match.mapIndex),
      );
      const guessIndices = new Set(
        visualNeighborhood.visualMatches.map((match) => match.mapIndex),
      );
      let sharedLocations = 0;
      for (const index of guessIndices) if (trueIndices.has(index)) sharedLocations += 1;
      const unionLocations = trueIndices.size + guessIndices.size - sharedLocations;
      return {
        datasetKey: map.entry.datasetKey,
        guess: { latitude, longitude },
        anchor: {
          mapIndex: selected.index,
          panoId: anchor.p,
          latitude: anchor.a,
          longitude: anchor.o,
          distanceFromGuessKm: selected.distanceKm,
          selection: "nearest stored map panorama to the guess",
        },
        overlap: {
          sharedLocations,
          trueLocations: trueIndices.size,
          guessLocations: guessIndices.size,
          unionLocations,
          jaccard: sharedLocations / Math.max(unionLocations, 1),
          trueCoverage: sharedLocations / Math.max(trueIndices.size, 1),
          guessCoverage: sharedLocations / Math.max(guessIndices.size, 1),
        },
        visualNeighborhood,
      };
    }

    async visualBoardSource(map, mapIndex) {
      const descriptor = map.manifest.visualBoards;
      if (!descriptor) throw new Error("Portable comparison boards are unavailable for this map");
      const chunkIndex = Math.floor(mapIndex / descriptor.chunkRows);
      const chunk = descriptor.chunks[chunkIndex];
      const key = `${map.entry.datasetKey}:board:${chunk.file}`;
      if (!this.boardChunkPromises.has(key)) {
        this.boardChunkPromises.set(key, this.json(
          `maps/${map.entry.datasetKey}/boards/${chunk.file}`,
          chunk.sha256,
          true,
        ));
      }
      const rows = await this.boardChunkPromises.get(key);
      return rows[mapIndex - chunkIndex * descriptor.chunkRows];
    }

    async storeEvent(path, body) {
      const database = await this.databasePromise;
      const event = {
        key: `${path}:${body?.eventKey || crypto.randomUUID?.() || Date.now()}:${Date.now()}`,
        path,
        recordedAt: new Date().toISOString(),
        body,
      };
      await idbPut(database, EVENT_STORE, event).catch(() => {});
      return { ok: true, local: true };
    }

    async request(path, options = {}) {
      const url = new URL(path, "https://portable.invalid");
      if ((options.method || "GET").toUpperCase() === "POST") {
        return this.storeEvent(url.pathname, options.body || {});
      }
      if (url.pathname === "/api/health") {
        const registry = await this.registry();
        return { ok: true, portable: true, maps: registry.maps };
      }
      const datasetHint = url.searchParams.get("dataset") || url.searchParams.get("map_key");
      if (url.pathname === "/api/review" || url.pathname === "/api/neighborhood") {
        const latitudeValue = url.searchParams.get("lat");
        const longitudeValue = url.searchParams.get("lng");
        const latitude = latitudeValue === null ? null : Number(latitudeValue);
        const longitude = longitudeValue === null ? null : Number(longitudeValue);
        const resolved = await this.resolve(
          url.searchParams.get("pano_id"),
          datasetHint,
          Number.isFinite(latitude) ? latitude : null,
          Number.isFinite(longitude) ? longitude : null,
        );
        if (!resolved) {
          const universal = await this.universalReview(
            url.searchParams.get("pano_id"),
            Number.isFinite(latitude) ? latitude : null,
            Number.isFinite(longitude) ? longitude : null,
            datasetHint,
            url.searchParams.get("round_score"),
            url.searchParams.get("round_distance_m"),
          );
          return universal || {
            matched: false, matchMethod: "unmatched", datasetKey: datasetHint,
          };
        }
        if (url.pathname === "/api/review") {
          const reviewKey = `${resolved.map.entry.datasetKey}:${resolved.mapIndex}`;
          if (!this.reviewPromises.has(reviewKey)) {
            this.reviewPromises.set(reviewKey, this.review(
              resolved.map,
              resolved.mapIndex,
              resolved.method,
              resolved.distance,
            ));
          }
          const review = await this.reviewPromises.get(reviewKey);
          return {
            ...review,
            matchMethod: resolved.method,
            matchDistanceM: resolved.distance,
          };
        }
        const row = resolved.map.core.panoramas[resolved.mapIndex];
        return {
          matched: true,
          datasetKey: resolved.map.entry.datasetKey,
          matchMethod: resolved.method,
          matchDistanceM: resolved.distance,
          location: {
            mapIndex: resolved.mapIndex,
            panoId: row.p,
            latitude: row.a,
            longitude: row.o,
          },
          visualNeighborhood: await this.neighborhood(resolved.map, resolved.mapIndex, false),
        };
      }
      const neighborhoodMatch = url.pathname.match(/^\/api\/neighborhood\/(\d+)$/);
      if (neighborhoodMatch) {
        const map = await this.loadMap(datasetHint);
        return this.neighborhood(map, Number(neighborhoodMatch[1]), true);
      }
      const guessNeighborhoodMatch = url.pathname.match(/^\/api\/guess-neighborhood\/(\d+)$/);
      if (guessNeighborhoodMatch) {
        const map = await this.loadMap(datasetHint);
        const latitude = Number(url.searchParams.get("guess_lat"));
        const longitude = Number(url.searchParams.get("guess_lng"));
        const comparison = await this.guessNeighborhood(
          map, Number(guessNeighborhoodMatch[1]), latitude, longitude,
        );
        if (!comparison) throw new Error("A valid player guess is required");
        return comparison;
      }
      const boardMatch = url.pathname.match(/^\/api\/visual-board\/(\d+)$/);
      if (boardMatch) {
        const map = await this.loadMap(datasetHint);
        const board = await this.visualBoard(map, Number(boardMatch[1]));
        const guessLatitudeValue = url.searchParams.get("guess_lat");
        const guessLongitudeValue = url.searchParams.get("guess_lng");
        const guessLatitude = guessLatitudeValue === null ? null : Number(guessLatitudeValue);
        const guessLongitude = guessLongitudeValue === null ? null : Number(guessLongitudeValue);
        return this.visualBoardWithGuess(
          map,
          Number(boardMatch[1]),
          board,
          guessLatitude,
          guessLongitude,
        );
      }
      if (url.pathname.startsWith("/api/meta/")) {
        const map = await this.loadMap(datasetHint);
        const id = decodeURIComponent(url.pathname.slice("/api/meta/".length));
        const detectorIndex = map.core.detectors.findIndex((row) => row.i === id);
        if (detectorIndex < 0) throw new Error(`Unknown detector ${id}`);
        return this.meta(map, detectorIndex);
      }
      throw new Error(`Unsupported portable route: ${url.pathname}`);
    }
  }

  root.OMTPortableAPI = PortableMetaApi;
  if (typeof module !== "undefined" && module.exports) module.exports = PortableMetaApi;
})(typeof globalThis !== "undefined" ? globalThis : this);
