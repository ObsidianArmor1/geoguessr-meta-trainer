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
          if (magic !== "OMTNBR01" || view.getUint32(8, true) !== 1) {
            throw new Error("Unsupported portable neighbor chunk");
          }
          const start = view.getUint32(12, true);
          const rows = view.getUint32(16, true);
          const neighbors = view.getUint32(20, true);
          const indexOffset = 24;
          const similarityOffset = indexOffset + rows * neighbors * 4;
          return { buffer, view, start, rows, neighbors, indexOffset, similarityOffset };
        })());
      }
      const loaded = await this.chunkPromises.get(key);
      const local = mapIndex - loaded.start;
      const indices = new Int32Array(loaded.neighbors);
      const similarities = new Float64Array(loaded.neighbors);
      for (let index = 0; index < loaded.neighbors; index += 1) {
        indices[index] = loaded.view.getInt32(
          loaded.indexOffset + (local * loaded.neighbors + index) * 4,
          true,
        );
        similarities[index] = halfToFloat(loaded.view.getUint16(
          loaded.similarityOffset + (local * loaded.neighbors + index) * 2,
          true,
        ));
      }
      return { indices, similarities };
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
      const origin = map.core.panoramas[mapIndex];
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
        representation: "raw C-RADIOv4-H fused panorama embedding",
        neighbors: visualMatches.length,
        mapDiagonalKm: map.projection.diagonalKm,
        coordinateBlind: true,
        radii,
        radiusProfile: "map-scale-aware",
        medianDistanceKm: quantile(0.5),
        nearestTenthDistanceKm: quantile(0.1),
        similarityRange: { strongest, weakest },
        weightedClick: null,
        visualMatches,
      };
      return { result, indices, calibrated };
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
            weightedClick: this.optimizeWeightedClick(
              map,
              computed.indices,
              computed.calibrated,
            ),
          })));
        }
        return this.weightedNeighborhoodPromises.get(key);
      }
      const result = { ...computed.result };
      return result;
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
        top100: new Map(neighborhood.visualMatches.map((match) => [match.mapIndex, match.rank])),
      };
    }

    guessLocalMatch(context, currentSlot) {
      if (!context) return null;
      const { map, pool, distances, current, candidates, top100 } = context;
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
        globalPanoRank: top100.get(candidate) || null,
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
        if (!resolved) return { matched: false, matchMethod: "unmatched", datasetKey: datasetHint };
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
