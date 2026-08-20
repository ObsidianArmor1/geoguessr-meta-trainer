(function (root) {
  "use strict";

  // Pack V2 resolves one panorama without loading a corpus-sized directory.
  // It is deliberately separate from LodestarPack V1 until parity and hosting
  // benchmarks pass; the userscript can then prefer V2 and retain V1 as a
  // rollback path without changing any review/UI code.
  const DB_NAME = "lodestar-pack-v2";
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

  let settings = null;
  let manifestPromise = null;
  const indexCache = new Map();
  const rowCache = new Map();
  const geoTileCache = new Map();
  let occupancyPromise = null;

  function configure(options) {
    settings = options ? { ...options } : null;
    manifestPromise = null;
    indexCache.clear();
    rowCache.clear();
    geoTileCache.clear();
    occupancyPromise = null;
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

  function transport(url, options = {}) {
    if (settings && typeof settings.transport === "function") {
      return settings.transport(url, options);
    }
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          headers: options.range
            ? { Range: `bytes=${options.range.start}-${options.range.end}` }
            : undefined,
          responseType: "arraybuffer",
          timeout: 60000,
          onload: (response) => {
            if (response.status >= 200 && response.status < 300) {
              resolve({ buffer: response.response, status: response.status });
            } else {
              reject(new Error(`${url} -> HTTP ${response.status}`));
            }
          },
          onerror: () => reject(new Error(`${url} -> network error`)),
          ontimeout: () => reject(new Error(`${url} -> timeout`)),
        });
      });
    }
    const headers = options.range
      ? { Range: `bytes=${options.range.start}-${options.range.end}` }
      : undefined;
    return fetch(url, { headers }).then(async (response) => {
      if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
      return { buffer: await response.arrayBuffer(), status: response.status };
    });
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
    try {
      const stored = await withStore("readonly", (store) => store.get(key));
      if (stored) return stored;
    } catch (error) { /* refetching is a safe fallback */ }
    const fresh = await produce();
    try {
      await withStore("readwrite", (store) => store.put(fresh, key));
    } catch (error) { /* cache failure is not a lookup failure */ }
    return fresh;
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
      const url = settings.manifestUrl || resolveUrl("manifest.json");
      manifestPromise = (settings.manifest
        ? Promise.resolve(settings.manifest)
        : transport(url).then(({ buffer }) => JSON.parse(new TextDecoder().decode(buffer))))
        .then((value) => {
          if (value.format !== "lodestar-range-row-pack" || value.version !== 2) {
            throw new Error("Unsupported Lodestar Pack V2 manifest");
          }
          return value;
        });
    }
    return manifestPromise;
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
    if (rowCache.has(key)) return rowCache.get(key);
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
    const descriptor = await locate(panoId);
    if (!descriptor) return null;
    const parsed = await rowFor(descriptor);
    const wanted = Math.max(1, Math.min(Number(count) || parsed.matches.length, parsed.matches.length));
    const matches = parsed.matches.slice(0, wanted);
    const similarities = matches.map((match) => match.similarity);
    const steering = adaptiveCount(similarities);
    return {
      status: "complete",
      panoId: String(panoId),
      heading: parsed.heading,
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      cacheHit: false,
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
    const tiles = await Promise.all(cells.map(([latCell, lngCell]) => geoTile(info, latCell, lngCell)));
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

  root.LodestarPackV2 = {
    configure, available, manifest, locate, query, projectedVector, similarityBetween,
    nearest, haversineKm,
    encodePanoramaId, decodePanoramaId, bucketOf, parseIndex, parseRow,
    adaptiveCount, sphericalClick, half,
  };
})(typeof window !== "undefined" ? window : globalThis);
