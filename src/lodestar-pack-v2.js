(function (root) {
  "use strict";

  // Pack V2 resolves one panorama without loading a corpus-sized directory.
  // The verified 2M dataset is the production default; configure(null) is the
  // deliberate disable path, and LodestarPack V1 remains the automatic
  // rollback path if a V2 request fails.
  const DEFAULT_BASE_URL =
    "https://huggingface.co/datasets/riot1/lodestar-balanced-2m-neighbors-v2/resolve/cb2f79b29f1b6dbe6c7c1eb954fbc9556900da91";
  const DEFAULT_REVISION = "cb2f79b29f1b6dbe6c7c1eb954fbc9556900da91";
  const DEFAULT_GENERATION = "b6f99168d869873c";
  const DEFAULT_CORPUS = "lodestar-balanced-2m";
  const DEFAULT_CORPUS_ROWS = 1999685;
  const DEFAULT_NEIGHBORS = 300;
  const DB_NAME = "lodestar-pack-v2-balanced-2m-b6f99168d869873c";
  const STORE = "blobs";
  const INDEX_HEADER_BYTES = 12;
  const INDEX_RECORD_BYTES = 32;
  const ROW_HEADER_BYTES = 20;
  const MATCH_BYTES = 28;
  const FLAG_PROJECTION = 1;
  const COORD_SCALE = 1e6;
  const SIMILARITY_MARGIN = 0.025;
  const MIN_MATCHES = 10;
  const MAX_MEMORY_INDEXES = 64;
  const MAX_MEMORY_GEO_TILES = 32;
  const MAX_MEMORY_VISUAL_GEO_TILES = 16;
  const LOCAL_VISUAL_PATH = "local-visual/manifest.json";

  let settings = { baseUrl: DEFAULT_BASE_URL };
  const transportIds = new WeakMap();
  let nextTransportId = 1;
  const configurationStates = new Map();
  let configurationKey = "";
  let manifestPromise = null;
  let indexCache = new Map();
  let rowCache = new Map();
  let geoTileCache = new Map();
  let blobInflight = new Map();
  let rowInflight = new Map();
  let occupancyPromise = null;
  let localVisualManifestPromise = null;
  let localVisualOccupancyPromise = null;
  let localVisualTileCache = new Map();

  function freshRuntime() {
    return {
      configured: available(),
      manifest: "idle",
      manifestError: null,
      cache: {
        hits: 0, misses: 0, readErrors: 0, writeErrors: 0, memoryHits: 0, inflightHits: 0,
      },
      network: {
        requests: 0, rangeRequests: 0, failures: 0, bytes: 0,
        retries: 0, lastStatus: null, lastRangeStatus: null, lastDurationMs: null, lastError: null,
      },
      lastQuery: null,
      localVisual: {
        manifest: "idle", manifestError: null, status: "idle", candidatePool: 0,
        poolRadiusKm: null, loadedCells: 0, selection: null, durationMs: null, error: null,
      },
    };
  }

  let runtime = freshRuntime();

  function settingsKey(value) {
    if (!value) return "disabled";
    let transportId = "default";
    if (typeof value.transport === "function") {
      if (!transportIds.has(value.transport)) transportIds.set(value.transport, nextTransportId++);
      transportId = `transport-${transportIds.get(value.transport)}`;
    }
    const manifestIdentity = value.manifest
      ? JSON.stringify(value.manifest)
      : String(value.manifestUrl || "");
    return `${String(value.baseUrl || "")}|${transportId}|${manifestIdentity}`;
  }

  function saveConfigurationState() {
    if (!configurationKey) return;
    configurationStates.set(configurationKey, {
      manifestPromise,
      indexCache,
      rowCache,
      geoTileCache,
      blobInflight,
      rowInflight,
      occupancyPromise,
      localVisualManifestPromise,
      localVisualOccupancyPromise,
      localVisualTileCache,
      runtime,
    });
  }

  function activateConfigurationState(key) {
    const saved = configurationStates.get(key);
    if (saved) {
      ({
        manifestPromise, indexCache, rowCache, geoTileCache, blobInflight, rowInflight,
        occupancyPromise, localVisualManifestPromise, localVisualOccupancyPromise,
        localVisualTileCache, runtime,
      } = saved);
      runtime.configured = available();
      return;
    }
    manifestPromise = null;
    indexCache = new Map();
    rowCache = new Map();
    geoTileCache = new Map();
    blobInflight = new Map();
    rowInflight = new Map();
    occupancyPromise = null;
    localVisualManifestPromise = null;
    localVisualOccupancyPromise = null;
    localVisualTileCache = new Map();
    runtime = freshRuntime();
  }

  configurationKey = settingsKey(settings);

  function errorText(error) {
    return String(error?.message || error || "unknown error").slice(0, 240);
  }

  function diagnostics() {
    return {
      packVersion: 2,
      configured: available(),
      baseHost: (() => {
        try { return new URL(baseUrl()).host; } catch (_error) { return "custom"; }
      })(),
      manifest: runtime.manifest,
      manifestError: runtime.manifestError,
      cache: { ...runtime.cache },
      network: { ...runtime.network },
      lastQuery: runtime.lastQuery ? { ...runtime.lastQuery } : null,
      localVisual: { ...runtime.localVisual },
    };
  }

  function configure(options) {
    saveConfigurationState();
    settings = options === undefined
      ? { baseUrl: DEFAULT_BASE_URL }
      : (options ? { ...options } : null);
    configurationKey = settingsKey(settings);
    activateConfigurationState(configurationKey);
  }

  function defaultConfig() {
    return {
      baseUrl: DEFAULT_BASE_URL,
      revision: DEFAULT_REVISION,
      generation: DEFAULT_GENERATION,
      corpus: DEFAULT_CORPUS,
      corpusRows: DEFAULT_CORPUS_ROWS,
      neighborsPerPanorama: DEFAULT_NEIGHBORS,
      cacheName: DB_NAME,
    };
  }

  function available() {
    return Boolean(settings && (settings.manifestUrl || settings.baseUrl));
  }

  function baseUrl() {
    return String(settings && settings.baseUrl || "").replace(/\/$/, "");
  }

  function resolveUrl(path) {
    return `${baseUrl()}/${String(path).replace(/^\//, "")}`;
  }

  async function transport(url, options = {}) {
    const ranged = Boolean(options.range);
    const retryDelays = [750, 2000];
    for (let attempt = 0; ; attempt += 1) {
      const started = Date.now();
      runtime.network.requests += 1;
      if (ranged) runtime.network.rangeRequests += 1;
      try {
        let result;
        if (settings && typeof settings.transport === "function") {
          result = await settings.transport(url, options);
        } else if (typeof GM_xmlhttpRequest === "function") {
          result = await new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
              method: "GET",
              url,
              headers: ranged
                ? { Range: `bytes=${options.range.start}-${options.range.end}` }
                : undefined,
              responseType: "arraybuffer",
              timeout: 60000,
              onload: (response) => {
                if (response.status >= 200 && response.status < 300) {
                  resolve({ buffer: response.response, status: response.status });
                } else {
                  const error = new Error(`${url} -> HTTP ${response.status}`);
                  error.status = response.status;
                  reject(error);
                }
              },
              onerror: () => reject(new Error(`${url} -> network error`)),
              ontimeout: () => reject(new Error(`${url} -> timeout`)),
            });
          });
        } else {
          const headers = ranged
            ? { Range: `bytes=${options.range.start}-${options.range.end}` }
            : undefined;
          const response = await fetch(url, { headers });
          if (!response.ok) {
            const error = new Error(`${url} -> HTTP ${response.status}`);
            error.status = response.status;
            throw error;
          }
          result = { buffer: await response.arrayBuffer(), status: response.status };
        }
        const bytes = Number(result?.buffer?.byteLength) || 0;
        runtime.network.bytes += bytes;
        runtime.network.lastStatus = Number(result?.status) || null;
        if (ranged) runtime.network.lastRangeStatus = Number(result?.status) || null;
        runtime.network.lastDurationMs = Date.now() - started;
        runtime.network.lastError = null;
        return result;
      } catch (error) {
        runtime.network.failures += 1;
        runtime.network.lastDurationMs = Date.now() - started;
        runtime.network.lastError = errorText(error);
        if (Number(error?.status) === 429 && attempt < retryDelays.length) {
          runtime.network.retries += 1;
          const delay = settings?.retryDelayMs === 0 ? 0 : retryDelays[attempt];
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
  }

  function withStore(mode, work) {
    if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB missing"));
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction(STORE, mode);
        const result = work(tx.objectStore(STORE));
        tx.oncomplete = () => { db.close(); resolve(result && result.result); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }

  async function cached(key, produce) {
    if (blobInflight.has(key)) {
      runtime.cache.inflightHits += 1;
      return blobInflight.get(key);
    }
    let pending;
    pending = (async () => {
      try {
        const stored = await withStore("readonly", (store) => store.get(key));
        if (stored) {
          runtime.cache.hits += 1;
          return stored;
        }
      } catch (error) {
        runtime.cache.readErrors += 1;
        /* refetching is a safe fallback */
      }
      runtime.cache.misses += 1;
      const fresh = await produce();
      try {
        await withStore("readwrite", (store) => store.put(fresh, key));
      } catch (error) {
        runtime.cache.writeErrors += 1;
        /* cache failure is not a lookup failure */
      }
      return fresh;
    })().finally(() => {
      if (blobInflight.get(key) === pending) blobInflight.delete(key);
    });
    blobInflight.set(key, pending);
    return pending;
  }

  async function gunzip(buffer) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("this browser cannot gunzip (DecompressionStream missing)");
    }
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer();
  }

  function manifest() {
    if (!available()) return Promise.reject(new Error("Pack V2 is not configured"));
    if (!manifestPromise) {
      runtime.manifest = "loading";
      const url = settings.manifestUrl || resolveUrl("manifest.json");
      manifestPromise = (settings.manifest
        ? Promise.resolve(settings.manifest)
        : transport(url).then(({ buffer }) => JSON.parse(new TextDecoder().decode(buffer))))
        .then((value) => {
          if (value.format !== "lodestar-range-row-pack" || value.version !== 2) {
            throw new Error("Unsupported Lodestar Pack V2 manifest");
          }
          if (settings.baseUrl === DEFAULT_BASE_URL
              && (value.corpus !== DEFAULT_CORPUS
                || value.generation !== DEFAULT_GENERATION
                || value.corpusRows !== DEFAULT_CORPUS_ROWS
                || value.neighborsPerPanorama !== DEFAULT_NEIGHBORS)) {
            throw new Error("Default Lodestar Pack V2 manifest does not match verified 2M corpus");
          }
          runtime.manifest = "ready";
          runtime.manifestError = null;
          return value;
        }).catch((error) => {
          // A transient CDN or browser failure must not poison every later
          // round in this tab with the same permanently rejected promise.
          manifestPromise = null;
          runtime.manifest = "failed";
          runtime.manifestError = errorText(error);
          throw error;
        });
    }
    return manifestPromise;
  }

  function localVisualManifest() {
    if (!available()) return Promise.reject(new Error("Pack V2 is not configured"));
    if (!localVisualManifestPromise) {
      runtime.localVisual.manifest = "loading";
      localVisualManifestPromise = Promise.all([
        manifest(),
        transport(resolveUrl(LOCAL_VISUAL_PATH)).then(
          ({ buffer }) => JSON.parse(new TextDecoder().decode(buffer)),
        ),
      ]).then(([packInfo, value]) => {
        if (value.format !== "lodestar-geo-visual-pack" || value.version !== 1
            || value.corpus !== packInfo.corpus || value.generation !== packInfo.generation
            || value.corpusRows !== (packInfo.packedRows || packInfo.corpusRows)
            || value.projectionDimensions !== packInfo.projectionDimensions) {
          throw new Error("Local visual sidecar does not match the active Pack V2 corpus");
        }
        runtime.localVisual.manifest = "ready";
        runtime.localVisual.manifestError = null;
        return value;
      }).catch((error) => {
        localVisualManifestPromise = null;
        runtime.localVisual.manifest = "failed";
        runtime.localVisual.manifestError = errorText(error);
        throw error;
      });
    }
    return localVisualManifestPromise;
  }

  function encodePanoramaId(text) {
    const value = String(text);
    if (!/^[A-Za-z0-9_-]{22}$/.test(value)) return null;
    try {
      const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "==");
      if (binary.length !== 16) return null;
      return Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch (error) {
      return null;
    }
  }

  function decodePanoramaId(bytes) {
    let binary = "";
    for (const value of bytes) binary += String.fromCharCode(value);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function bucketOf(rawId, bits) {
    return ((rawId[0] << 8) | rawId[1]) >>> (16 - bits);
  }

  function bucketName(bucket, width) {
    return bucket.toString(16).padStart(width, "0");
  }

  function pathFromPattern(pattern, bucket, width) {
    return String(pattern).replace("{bucket}", bucketName(bucket, width));
  }

  function geoPath(pattern, latCell, lngCell) {
    return String(pattern)
      .replace("{latCell}", String(latCell).padStart(3, "0"))
      .replace("{lngCell}", String(lngCell).padStart(3, "0"));
  }

  function equalId(bytes, offset, wanted) {
    for (let index = 0; index < 16; index += 1) {
      if (bytes[offset + index] !== wanted[index]) return false;
    }
    return true;
  }

  function parseIndex(buffer, info, expectedBucket) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const magic = new TextDecoder("ascii").decode(bytes.subarray(0, 4));
    if (magic !== "LSI2" || view.getUint8(4) !== 2) throw new Error("Invalid Pack V2 index");
    const bits = view.getUint8(5);
    const recordBytes = view.getUint16(6, true);
    const count = view.getUint32(8, true);
    if (bits !== info.bucketBits || recordBytes !== INDEX_RECORD_BYTES
        || buffer.byteLength !== INDEX_HEADER_BYTES + count * recordBytes) {
      throw new Error(`Malformed Pack V2 index bucket ${expectedBucket}`);
    }
    return { buffer, view, bytes, count, recordBytes };
  }

  async function indexFor(bucket, info) {
    if (indexCache.has(bucket)) {
      runtime.cache.memoryHits += 1;
      const hit = indexCache.get(bucket);
      indexCache.delete(bucket);
      indexCache.set(bucket, hit);
      return hit;
    }
    const path = pathFromPattern(info.indexPattern, bucket, info.bucketHexWidth);
    const packed = await cached(`index:${info.generation || info.corpus}:${bucket}`,
      () => transport(resolveUrl(path)).then((result) => result.buffer));
    const decoded = parseIndex(await gunzip(packed), info, bucket);
    indexCache.set(bucket, decoded);
    while (indexCache.size > MAX_MEMORY_INDEXES) indexCache.delete(indexCache.keys().next().value);
    return decoded;
  }

  async function locate(panoId) {
    const rawId = encodePanoramaId(panoId);
    if (!rawId) return null;
    const info = await manifest();
    const bucket = bucketOf(rawId, info.bucketBits);
    const index = await indexFor(bucket, info);
    for (let record = 0; record < index.count; record += 1) {
      const offset = INDEX_HEADER_BYTES + record * index.recordBytes;
      if (!equalId(index.bytes, offset, rawId)) continue;
      const dataOffset = Number(index.view.getBigUint64(offset + 16, true));
      const length = index.view.getUint32(offset + 24, true);
      const corpusRow = index.view.getUint32(offset + 28, true);
      return { panoId: String(panoId), rawId, bucket, dataOffset, length, corpusRow, info };
    }
    return null;
  }

  function half(bits) {
    const sign = (bits & 0x8000) ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
    if (exponent === 31) return fraction ? NaN : sign * Infinity;
    return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
  }

  function parseRow(buffer, descriptor) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const magic = new TextDecoder("ascii").decode(bytes.subarray(0, 4));
    if (magic !== "LSR2" || view.getUint8(4) !== 2) throw new Error("Invalid Pack V2 row");
    const flags = view.getUint8(5);
    const count = view.getUint16(6, true);
    const latitude = view.getInt32(8, true) / COORD_SCALE;
    const longitude = view.getInt32(12, true) / COORD_SCALE;
    const heading = view.getUint16(16, true) / 100;
    const projectionDimensions = view.getUint16(18, true);
    let offset = ROW_HEADER_BYTES;
    let projection = null;
    if (flags & FLAG_PROJECTION) {
      const scale = half(view.getUint16(offset, true));
      offset += 2;
      const vector = new Float32Array(projectionDimensions);
      let norm = 0;
      for (let index = 0; index < projectionDimensions; index += 1) {
        const value = view.getInt8(offset + index) * scale;
        vector[index] = value;
        norm += value * value;
      }
      offset += projectionDimensions;
      norm = Math.sqrt(norm) || 1;
      for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
      projection = vector;
    } else if (projectionDimensions !== 0) {
      throw new Error("Pack V2 row declares a projection without projection data");
    }
    if (buffer.byteLength !== offset + count * MATCH_BYTES) {
      throw new Error("Malformed Pack V2 row length");
    }
    const idsOffset = offset;
    const coordinatesOffset = idsOffset + count * 16;
    const headingsOffset = coordinatesOffset + count * 8;
    const similaritiesOffset = headingsOffset + count * 2;
    const matches = [];
    for (let rank = 0; rank < count; rank += 1) {
      const rawTarget = bytes.subarray(idsOffset + rank * 16, idsOffset + (rank + 1) * 16);
      matches.push({
        rank: rank + 1,
        similarity: half(view.getUint16(similaritiesOffset + rank * 2, true)),
        mapIndex: null,
        panoId: decodePanoramaId(rawTarget),
        latitude: view.getInt32(coordinatesOffset + rank * 8, true) / COORD_SCALE,
        longitude: view.getInt32(coordinatesOffset + rank * 8 + 4, true) / COORD_SCALE,
        heading: view.getUint16(headingsOffset + rank * 2, true) / 100,
      });
    }
    return {
      panoId: descriptor.panoId,
      corpusRow: descriptor.corpusRow,
      latitude, longitude, heading, projection, matches,
    };
  }

  async function rowFor(descriptor) {
    const key = descriptor.panoId;
    if (rowCache.has(key)) {
      runtime.cache.memoryHits += 1;
      return rowCache.get(key);
    }
    if (rowInflight.has(key)) {
      runtime.cache.inflightHits += 1;
      return rowInflight.get(key);
    }
    let pending;
    pending = (async () => {
      const path = pathFromPattern(
        descriptor.info.rowPattern, descriptor.bucket, descriptor.info.bucketHexWidth);
      const start = descriptor.dataOffset;
      const end = start + descriptor.length - 1;
      const response = await transport(resolveUrl(path), { range: { start, end } });
      let packed = response.buffer;
      // A basic static server may ignore Range and return the whole bucket.  This
      // makes local testing and conservative hosting fallbacks correct, although
      // production hosting must return 206 to preserve the byte budget.
      if (response.status !== 206 && packed.byteLength !== descriptor.length) {
        packed = packed.slice(start, start + descriptor.length);
      }
      if (packed.byteLength !== descriptor.length) throw new Error("Incomplete Pack V2 row range");
      const parsed = parseRow(await gunzip(packed), descriptor);
      rowCache.set(key, parsed);
      while (rowCache.size > 24) rowCache.delete(rowCache.keys().next().value);
      return parsed;
    })().finally(() => {
      if (rowInflight.get(key) === pending) rowInflight.delete(key);
    });
    rowInflight.set(key, pending);
    return pending;
  }

  function adaptiveCount(similarities) {
    if (!similarities.length) return { detected: false, count: 0, score: 0 };
    const best = similarities[0];
    let count = 0;
    while (count < similarities.length && similarities[count] >= best - SIMILARITY_MARGIN) count += 1;
    const clamped = Math.min(similarities.length, Math.max(MIN_MATCHES, count));
    return {
      detected: true,
      count: clamped,
      score: best - similarities[clamped - 1],
      rule: `within ${SIMILARITY_MARGIN} of top-1`,
    };
  }

  function sphericalClick(matches, count) {
    const used = matches.slice(0, Math.max(1, count));
    let weightSum = 0;
    const weights = used.map((_, index) => {
      const weight = 1 / Math.sqrt(index + 1);
      weightSum += weight;
      return weight;
    });
    let x = 0, y = 0, z = 0;
    used.forEach((match, index) => {
      const lat = match.latitude * Math.PI / 180;
      const lng = match.longitude * Math.PI / 180;
      const weight = weights[index] / weightSum;
      x += weight * Math.cos(lat) * Math.cos(lng);
      y += weight * Math.cos(lat) * Math.sin(lng);
      z += weight * Math.sin(lat);
    });
    const norm = Math.hypot(x, y, z) || 1;
    return [
      Math.atan2(z / norm, Math.hypot(x / norm, y / norm)) * 180 / Math.PI,
      Math.atan2(y / norm, x / norm) * 180 / Math.PI,
    ];
  }

  async function query(panoId, count) {
    const started = Date.now();
    const networkBefore = runtime.network.requests;
    const queryDiagnostic = {
      panoId: String(panoId), requestedMatches: Number(count) || null,
      status: "loading", found: null, decodedMatches: 0, cacheHit: null,
      durationMs: null, error: null,
    };
    runtime.lastQuery = queryDiagnostic;
    try {
      const descriptor = await locate(panoId);
      if (!descriptor) {
        Object.assign(queryDiagnostic, {
          status: "not-in-corpus", found: false, cacheHit: runtime.network.requests === networkBefore,
          durationMs: Date.now() - started,
        });
        return null;
      }
      const parsed = await rowFor(descriptor);
      const wanted = Math.max(1, Math.min(Number(count) || parsed.matches.length, parsed.matches.length));
      const matches = parsed.matches.slice(0, wanted);
      const similarities = matches.map((match) => match.similarity);
      const steering = adaptiveCount(similarities);
      const cacheHit = runtime.network.requests === networkBefore;
      Object.assign(queryDiagnostic, {
        status: "complete", found: true, decodedMatches: matches.length, cacheHit,
        durationMs: Date.now() - started, corpus: descriptor.info.corpus,
      });
      return {
        status: "complete",
        panoId: String(panoId),
        heading: parsed.heading,
        latitude: parsed.latitude,
        longitude: parsed.longitude,
        cacheHit,
        source: "lodestar-static-pack-v2",
        corpus: descriptor.info.corpus,
        corpusSize: descriptor.info.corpusRows,
        neighborsPerPanorama: parsed.matches.length,
        boundary: {
          detected: true,
          count: matches.length,
          score: similarities[0] - similarities[similarities.length - 1],
          rule: "full cloud",
        },
        clickCount: steering.count,
        clickRule: steering.rule,
        recommendedClick: sphericalClick(matches, steering.count),
        matches,
        timings: { totalSeconds: (Date.now() - started) / 1000 },
      };
    } catch (error) {
      Object.assign(queryDiagnostic, {
        status: "failed", found: null, cacheHit: runtime.network.requests === networkBefore,
        durationMs: Date.now() - started, error: errorText(error),
      });
      throw error;
    }
  }

  async function projectedVector(panoId) {
    const descriptor = await locate(panoId);
    if (!descriptor) return null;
    return (await rowFor(descriptor)).projection;
  }

  async function similarityBetween(panoIdA, panoIdB) {
    const [a, b] = await Promise.all([projectedVector(panoIdA), projectedVector(panoIdB)]);
    if (!a || !b || a.length !== b.length) return null;
    let total = 0;
    for (let index = 0; index < a.length; index += 1) total += a[index] * b[index];
    return total;
  }

  function haversineKm(aLat, aLng, bLat, bLng) {
    const radians = Math.PI / 180;
    const dLat = (bLat - aLat) * radians;
    const dLng = (bLng - aLng) * radians;
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(aLat * radians) * Math.cos(bLat * radians) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  async function occupancy(info) {
    if (!info.geo) return null;
    if (!occupancyPromise) {
      occupancyPromise = cached(`geo-occupancy:${info.generation || info.corpus}`,
        () => transport(resolveUrl(info.geo.occupancy)).then((result) => result.buffer))
        .then(gunzip).then((buffer) => new Uint8Array(buffer));
    }
    return occupancyPromise;
  }

  function occupied(bitmap, cell) {
    return Boolean(bitmap[cell >>> 3] & (1 << (cell & 7)));
  }

  async function geoTile(info, latCell, lngCell) {
    const key = latCell * info.geo.lngCells + lngCell;
    if (geoTileCache.has(key)) {
      const hit = geoTileCache.get(key);
      geoTileCache.delete(key);
      geoTileCache.set(key, hit);
      return hit;
    }
    const path = geoPath(info.geo.tilePattern, latCell, lngCell);
    const packed = await cached(`geo:${info.generation || info.corpus}:${key}`,
      () => transport(resolveUrl(path)).then((result) => result.buffer));
    const buffer = await gunzip(packed);
    if (buffer.byteLength % info.geo.recordBytes !== 0) throw new Error("Malformed Pack V2 geo tile");
    const tile = { bytes: new Uint8Array(buffer), view: new DataView(buffer) };
    geoTileCache.set(key, tile);
    while (geoTileCache.size > MAX_MEMORY_GEO_TILES) {
      geoTileCache.delete(geoTileCache.keys().next().value);
    }
    return tile;
  }

  // Exact nearest corpus panorama inside a bounded radius. One-degree spatial
  // cells mean an ordinary query fetches at most a small 3x3 neighborhood; an
  // occupancy bitmap prevents requests for empty ocean/desert cells.
  async function nearest(latitude, longitude, options = {}) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const info = await manifest();
    if (!info.geo) return null;
    const radius = Number.isFinite(options.withinKm) ? options.withinKm : 100;
    if (!(radius > 0)) return null;
    const bitmap = await occupancy(info);
    const latDelta = radius / 110.574;
    const extremeLatitude = Math.min(89.999, Math.abs(latitude) + latDelta);
    const longitudeKm = 111.320 * Math.max(1e-6, Math.cos(extremeLatitude * Math.PI / 180));
    const lngDelta = Math.min(180, radius / longitudeKm);
    const latStart = Math.max(0, Math.floor(latitude - latDelta + 90));
    const latStop = Math.min(info.geo.latCells - 1, Math.floor(latitude + latDelta + 90));
    const lngStart = Math.floor(longitude - lngDelta + 180);
    const lngStop = Math.floor(longitude + lngDelta + 180);
    const cells = [];
    for (let latCell = latStart; latCell <= latStop; latCell += 1) {
      if (lngDelta >= 180) {
        for (let lngCell = 0; lngCell < info.geo.lngCells; lngCell += 1) {
          const cell = latCell * info.geo.lngCells + lngCell;
          if (occupied(bitmap, cell)) cells.push([latCell, lngCell]);
        }
      } else {
        for (let rawLng = lngStart; rawLng <= lngStop; rawLng += 1) {
          const lngCell = ((rawLng % info.geo.lngCells) + info.geo.lngCells) % info.geo.lngCells;
          const cell = latCell * info.geo.lngCells + lngCell;
          if (occupied(bitmap, cell)) cells.push([latCell, lngCell]);
        }
      }
    }
    const tiles = [];
    // A guess can touch nine occupied one-degree cells. Loading all nine at
    // once creates a burst that public hosting may rate-limit, so keep three
    // workers: still parallel, but bounded.
    let nextCell = 0;
    const workers = Array.from({ length: Math.min(3, cells.length) }, async () => {
      while (nextCell < cells.length) {
        const [latCell, lngCell] = cells[nextCell++];
        tiles.push(await geoTile(info, latCell, lngCell));
      }
    });
    await Promise.all(workers);
    let best = null;
    for (const tile of tiles) {
      for (let offset = 0; offset < tile.bytes.length; offset += info.geo.recordBytes) {
        const candidateLatitude = tile.view.getInt32(offset + 16, true) / COORD_SCALE;
        const candidateLongitude = tile.view.getInt32(offset + 20, true) / COORD_SCALE;
        const distanceKm = haversineKm(
          latitude, longitude, candidateLatitude, candidateLongitude);
        if (distanceKm > radius || (best && distanceKm >= best.distanceKm)) continue;
        best = {
          panoId: decodePanoramaId(tile.bytes.subarray(offset, offset + 16)),
          latitude: candidateLatitude,
          longitude: candidateLongitude,
          heading: tile.view.getUint16(offset + 24, true) / 100,
          distanceKm,
        };
      }
    }
    return best;
  }

  async function localVisualOccupancy(info) {
    if (!localVisualOccupancyPromise) {
      localVisualOccupancyPromise = cached(
        `local-visual-occupancy:${info.generation}`,
        () => transport(resolveUrl(`local-visual/${info.occupancy}`)).then(
          (result) => result.buffer,
        ),
      ).then(gunzip).then((buffer) => new Uint8Array(buffer));
    }
    return localVisualOccupancyPromise;
  }

  function parseLocalVisualTile(buffer, info, expectedRows = null) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const magic = new TextDecoder("ascii").decode(bytes.subarray(0, 4));
    const version = view.getUint8(4);
    const dimensions = view.getUint16(5, true);
    const rows = view.getUint32(7, true);
    const headerBytes = 11;
    if (magic !== "LGV1" || version !== 1 || dimensions !== info.projectionDimensions
        || (expectedRows !== null && rows !== expectedRows)
        || buffer.byteLength !== headerBytes + rows * info.recordBytes) {
      throw new Error("Malformed local visual tile");
    }
    const records = [];
    for (let row = 0; row < rows; row += 1) {
      const offset = headerBytes + row * info.recordBytes;
      const codes = new Int8Array(buffer, offset + 30, dimensions);
      let normSquared = 0;
      for (let index = 0; index < dimensions; index += 1) {
        normSquared += codes[index] * codes[index];
      }
      records.push({
        panoId: decodePanoramaId(bytes.subarray(offset, offset + 16)),
        latitude: view.getInt32(offset + 16, true) / COORD_SCALE,
        longitude: view.getInt32(offset + 20, true) / COORD_SCALE,
        heading: view.getUint16(offset + 24, true) / 100,
        corpusRow: view.getUint32(offset + 26, true),
        projection: codes,
        projectionNorm: Math.sqrt(normSquared) || 1,
      });
    }
    return records;
  }

  async function localVisualTile(info, latCell, lngCell) {
    const key = latCell * info.lngCells + lngCell;
    if (localVisualTileCache.has(key)) {
      runtime.cache.memoryHits += 1;
      const hit = localVisualTileCache.get(key);
      localVisualTileCache.delete(key);
      localVisualTileCache.set(key, hit);
      return hit;
    }
    const path = geoPath(info.tilePattern, latCell, lngCell);
    const packed = await cached(
      `local-visual:${info.generation}:${key}`,
      () => transport(resolveUrl(`local-visual/${path}`)).then((result) => result.buffer),
    );
    const records = parseLocalVisualTile(await gunzip(packed), info);
    localVisualTileCache.set(key, records);
    while (localVisualTileCache.size > MAX_MEMORY_VISUAL_GEO_TILES) {
      localVisualTileCache.delete(localVisualTileCache.keys().next().value);
    }
    return records;
  }

  function visualCellLowerBound(latitude, longitude, info, latCell, lngCell) {
    const degrees = info.cellDegrees;
    const latMin = -90 + latCell * degrees;
    const latMax = Math.min(90, latMin + degrees);
    const lngMin = -180 + lngCell * degrees;
    const lngMax = Math.min(180, lngMin + degrees);
    const centerLat = (latMin + latMax) / 2;
    const centerLng = (lngMin + lngMax) / 2;
    const centerDistance = haversineKm(latitude, longitude, centerLat, centerLng);
    let cellRadius = 0;
    for (const cornerLat of [latMin, latMax]) {
      for (const cornerLng of [lngMin, lngMax]) {
        cellRadius = Math.max(
          cellRadius,
          haversineKm(centerLat, centerLng, cornerLat, cornerLng),
        );
      }
    }
    // Triangle inequality makes this conservative: a cell can look closer
    // than it really is, which may download one extra tile but cannot omit a
    // candidate that belongs in the adaptive pool.
    return Math.max(0, centerDistance - cellRadius);
  }

  async function nearbyVisual(latitude, longitude, options = {}) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const started = Date.now();
    const minimumKm = Number.isFinite(options.minimumKm) ? options.minimumKm : 10;
    const maximumKm = Number.isFinite(options.maximumKm) ? options.maximumKm : 100;
    const targetCandidates = Math.max(1, Number(options.targetCandidates) || 160);
    const excludedPanoId = String(options.excludePanoId || "");
    Object.assign(runtime.localVisual, {
      status: "loading", candidatePool: 0, poolRadiusKm: null, loadedCells: 0,
      selection: null, durationMs: null, error: null,
    });
    try {
      const info = await localVisualManifest();
      const bitmap = await localVisualOccupancy(info);
      const cells = [];
      for (let cell = 0; cell < info.latCells * info.lngCells; cell += 1) {
        if (!occupied(bitmap, cell)) continue;
        const latCell = Math.floor(cell / info.lngCells);
        const lngCell = cell % info.lngCells;
        const lowerBoundKm = visualCellLowerBound(
          latitude, longitude, info, latCell, lngCell,
        );
        if (lowerBoundKm <= maximumKm) cells.push({ latCell, lngCell, lowerBoundKm });
      }
      cells.sort((left, right) => left.lowerBoundKm - right.lowerBoundKm);
      const candidates = [];
      let loadedCells = 0;
      let pool = null;
      let poolRadiusKm = null;
      for (let cursor = 0; cursor < cells.length;) {
        const batch = cells.slice(cursor, cursor + 2);
        cursor += batch.length;
        const loaded = await Promise.all(batch.map((cell) => (
          localVisualTile(info, cell.latCell, cell.lngCell)
        )));
        loadedCells += batch.length;
        for (const records of loaded) {
          for (const candidate of records) {
            if (candidate.panoId === excludedPanoId) continue;
            const distanceKm = haversineKm(
              latitude, longitude, candidate.latitude, candidate.longitude,
            );
            if (distanceKm <= maximumKm) candidates.push({ ...candidate, distanceKm });
          }
        }
        const nextLowerBound = cells[cursor]?.lowerBoundKm ?? Infinity;
        const local = candidates.filter((candidate) => candidate.distanceKm <= minimumKm);
        if (local.length >= targetCandidates && nextLowerBound > minimumKm) {
          pool = local;
          poolRadiusKm = minimumKm;
          break;
        }
        if (candidates.length >= targetCandidates) {
          const ordered = candidates.slice().sort((a, b) => a.distanceKm - b.distanceKm);
          const targetDistance = ordered[targetCandidates - 1].distanceKm;
          const adaptiveRadius = Math.max(minimumKm, targetDistance);
          if (nextLowerBound > adaptiveRadius) {
            pool = ordered.filter((candidate) => candidate.distanceKm <= adaptiveRadius);
            poolRadiusKm = adaptiveRadius;
            break;
          }
        }
      }
      if (!pool) {
        pool = candidates.filter((candidate) => candidate.distanceKm <= maximumKm);
        poolRadiusKm = pool.length
          ? Math.max(...pool.map((candidate) => candidate.distanceKm))
          : maximumKm;
      }
      if (!pool.length) {
        Object.assign(runtime.localVisual, {
          status: "unavailable", candidatePool: 0, poolRadiusKm, loadedCells,
          durationMs: Date.now() - started,
        });
        return null;
      }

      if (options.prefetchOnly === true) {
        Object.assign(runtime.localVisual, {
          status: "warmed", candidatePool: pool.length, poolRadiusKm, loadedCells,
          selection: null, durationMs: Date.now() - started, error: null,
        });
        return { candidatePool: pool.length, poolRadiusKm, loadedCells, warmed: true };
      }

      const byPano = new Map(pool.map((candidate) => [candidate.panoId, candidate]));
      let best = null;
      for (const match of options.roundMatches || []) {
        const candidate = byPano.get(String(match.panoId));
        if (!candidate) continue;
        best = {
          ...candidate,
          roundRank: Number(match.rank) || null,
          similarityToRound: Number(match.similarity),
          estimated: false,
          selectedBy: "strongest exact round match in adaptive local pool",
        };
        break;
      }
      if (!best) {
        const roundVector = await projectedVector(options.roundPanoId);
        if (!roundVector) throw new Error("Round projection is unavailable");
        let bestScore = -Infinity;
        for (const candidate of pool) {
          let score = 0;
          for (let index = 0; index < roundVector.length; index += 1) {
            score += roundVector[index] * candidate.projection[index];
          }
          score /= candidate.projectionNorm;
          if (score <= bestScore) continue;
          bestScore = score;
          best = {
            ...candidate,
            roundRank: null,
            similarityToRound: score,
            estimated: true,
            selectedBy: "most visually similar projection in adaptive local pool",
          };
        }
      }
      best = {
        ...best,
        candidatePool: pool.length,
        poolRadiusKm,
      };
      Object.assign(runtime.localVisual, {
        status: "complete", candidatePool: pool.length, poolRadiusKm, loadedCells,
        selection: best.selectedBy, durationMs: Date.now() - started, error: null,
      });
      return best;
    } catch (error) {
      Object.assign(runtime.localVisual, {
        status: "failed", durationMs: Date.now() - started, error: errorText(error),
      });
      throw error;
    }
  }

  root.LodestarPackV2 = {
    configure, available, defaultConfig, manifest, locate, query, projectedVector, similarityBetween,
    nearest, nearbyVisual, localVisualManifest, haversineKm,
    encodePanoramaId, decodePanoramaId, bucketOf, parseIndex, parseRow,
    parseLocalVisualTile, adaptiveCount, sphericalClick, half, diagnostics,
  };
})(typeof window !== "undefined" ? window : globalThis);
