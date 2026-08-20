(function (root) {
  "use strict";

  // Global neighbours from static files. No server, no GPU, no inference: the
  // corpus-wide top-300 for all 999,693 panoramas is precomputed, so a lookup
  // is one ~0.5 MB chunk fetch and some offset arithmetic.
  //
  // The older per-map packs ranked each panorama against its own map, because
  // the corpus WAS the map. Here a location's references come from the whole
  // corpus wherever they are, and a map is just a list of panoramas that have
  // rows in this table - which is why no per-map artifact exists.
  const DIRECTORY_URL =
    "https://raw.githubusercontent.com/ObsidianArmor1/lodestar-neighbors/main/directory.bin.gz";
  // Chunks come from the CDN rather than raw: one fetch per round across many
  // players is exactly what a CDN is for. The directory cannot - it is 23 MB
  // and jsDelivr refuses files over 20 MB.
  const CHUNK_BASE =
    "https://cdn.jsdelivr.net/gh/ObsidianArmor1/lodestar-neighbors@main/neighbors/";
  const HEADINGS_URL =
    "https://raw.githubusercontent.com/ObsidianArmor1/lodestar-neighbors/main/headings.bin.gz";
  const MANIFEST_URL =
    "https://raw.githubusercontent.com/ObsidianArmor1/lodestar-neighbors/main/manifest.json";
  const PROJECTION_BASE =
    "https://cdn.jsdelivr.net/gh/ObsidianArmor1/lodestar-neighbors@main/projection/";
  const DB_NAME = "lodestar-pack-v1";
  const STORE = "blobs";
  const ID_BYTES = 22;
  const COORD_SCALE = 1e6;
  const MAX_CACHED_CHUNKS = 64;
  // EVERY neighbour is drawn. The corpus exists so the cloud reads as a
  // continuous shape rather than a handful of discrete pins, and truncating it
  // to a few dozen puts the discreteness back. Marker size already encodes
  // similarity, so the weak tail shows as small and the strong core as large -
  // the shape carries the information that a cutoff would throw away.
  //
  // The margin below no longer decides what is displayed. It decides how many
  // matches steer the SUGGESTED CLICK, which is a different question: a click
  // averaged over all 300 gets dragged toward wherever the weak tail happens to
  // sit. Keep everything within SIMILARITY_MARGIN of THAT location's own best
  // match, which on 3,000 sampled rows selects 10 / 31 / 110 matches at the
  // 10th / 50th / 90th percentile.
  //
  // The margin is relative rather than absolute because rank-1 similarity spans
  // 0.911 to 0.965 across locations: a fixed 0.95 cutoff selects nothing at all
  // for 68% of them.
  const SIMILARITY_MARGIN = 0.025;
  const MIN_MATCHES = 10;

  let directoryPromise = null;
  let headingsPromise = null;
  let manifestPromise = null;
  const chunkCache = new Map();          // chunk index -> decoded arrays
  const projectionCache = new Map();     // chunk index -> decoded codes + scales

  function request(url, responseType) {
    if (typeof GM_xmlhttpRequest === "function") {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          responseType: responseType === "json" ? "json" : "arraybuffer",
          timeout: 60000,
          onload: (response) => {
            if (response.status >= 200 && response.status < 300) {
              resolve(responseType === "json" ? response.response : response.response);
            } else {
              reject(new Error(`${url} -> HTTP ${response.status}`));
            }
          },
          onerror: () => reject(new Error(`${url} -> network error`)),
          ontimeout: () => reject(new Error(`${url} -> timeout`)),
        });
      });
    }
    return fetch(url).then((response) => {
      if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
      return responseType === "json" ? response.json() : response.arrayBuffer();
    });
  }

  async function gunzip(buffer) {
    if (typeof DecompressionStream !== "function") {
      throw new Error("this browser cannot gunzip (DecompressionStream missing)");
    }
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Response(stream).arrayBuffer();
  }

  function withStore(mode, work) {
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
    } catch (error) {
      // A blocked or full IndexedDB must not break play - refetching is slower,
      // not wrong.
    }
    const fresh = await produce();
    try {
      await withStore("readwrite", (store) => store.put(fresh, key));
    } catch (error) { /* see above */ }
    return fresh;
  }

  function manifest() {
    if (!manifestPromise) manifestPromise = request(MANIFEST_URL, "json");
    return manifestPromise;
  }

  // The directory is the routing table: a panorama's POSITION in it is its row,
  // and neighbour indices are positions in this same list. One 23 MB download,
  // then every lookup is local.
  function directory() {
    if (directoryPromise) return directoryPromise;
    directoryPromise = (async () => {
      const info = await manifest();
      const packed = await cached("directory", () => request(DIRECTORY_URL, "arraybuffer"));
      const plain = await gunzip(packed);
      const rows = info.rows;
      const ids = new Uint8Array(plain, 0, rows * ID_BYTES);
      // 999,693 x 22 bytes is not a multiple of 4, so the coordinates do not
      // begin on an alignment Int32Array will accept - a typed-array view over
      // that offset throws. Copying the tail costs 7.6 MB once per session.
      const coords = new Int32Array(plain.slice(rows * ID_BYTES));
      const decoder = new TextDecoder("ascii");
      const rowOf = new Map();
      for (let row = 0; row < rows; row += 1) {
        rowOf.set(decoder.decode(ids.subarray(row * ID_BYTES, (row + 1) * ID_BYTES)), row);
      }
      return { rows, ids, coords, rowOf, decoder, info };
    })();
    return directoryPromise;
  }

  async function chunkFor(row, info) {
    const index = Math.floor(row / info.chunkRows);
    if (chunkCache.has(index)) {
      const hit = chunkCache.get(index);
      chunkCache.delete(index);
      chunkCache.set(index, hit);                 // move to most-recent
      return hit;
    }
    const record = info.neighborChunks[index];
    const packed = await cached(`chunk:${record.file}`,
      () => request(CHUNK_BASE + record.file, "arraybuffer"));
    const plain = await gunzip(packed);
    const k = info.neighborsPerPanorama;
    const count = record.rows;
    const decoded = {
      start: record.start,
      rows: count,
      indices: new Int32Array(plain, 0, count * k),
      similarities: new Uint16Array(plain, count * k * 4, count * k),
    };
    chunkCache.set(index, decoded);
    while (chunkCache.size > MAX_CACHED_CHUNKS) {
      chunkCache.delete(chunkCache.keys().next().value);
    }
    return decoded;
  }

  // float16 -> float32. The pack stores similarities the way the table does.
  function half(bits) {
    const sign = (bits & 0x8000) ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
    if (exponent === 31) return fraction ? NaN : sign * Infinity;
    return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
  }

  // Neighbourhood size for one location, by similarity margin.
  //
  // This replaces the change-point detector the Modal service uses. That
  // detector looked for a sustained slope break in ranked cosine-distance
  // space, and on the 49k pilot corpus it found one. On a million panoramas
  // the curve is smooth - there is almost always something at every similarity
  // level - so it never fires, and every location fell back to a flat 100.
  // `boundary` is kept below for reference and for comparing against Modal.
  function adaptiveCount(similarities) {
    if (!similarities.length) return { detected: false, count: 0, score: 0 };
    const best = similarities[0];
    let count = 0;
    while (count < similarities.length && similarities[count] >= best - SIMILARITY_MARGIN) {
      count += 1;
    }
    const clamped = Math.min(
      similarities.length,
      Math.max(MIN_MATCHES, count),
    );
    return {
      detected: true,
      count: clamped,
      score: best - similarities[clamped - 1],
      rule: `within ${SIMILARITY_MARGIN} of top-1`,
    };
  }

  // Ported from the Modal service so the static path can be compared against
  // it: a sustained slope break in ranked cosine-distance space.
  function boundary(similarities) {
    const window = 12;
    const lower = 16;
    const upper = Math.min(288, similarities.length - window - 1);
    if (upper <= lower) {
      return { detected: false, count: Math.min(100, similarities.length), score: 0 };
    }
    const values = similarities.map((s) => Math.log(Math.max(1 - s, 1e-8)));
    const gaps = [];
    for (let i = 1; i < values.length; i += 1) gaps.push(values[i] - values[i - 1]);
    const mean = (list) => list.reduce((sum, v) => sum + v, 0) / list.length;
    const median = (list) => {
      const sorted = list.slice().sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    const candidates = [];
    for (let rank = lower; rank <= upper; rank += 1) {
      const before = gaps.slice(rank - window, rank);
      const after = gaps.slice(rank, rank + window);
      candidates.push([rank, Math.min(
        mean(after) / Math.max(mean(before), 1e-9),
        median(after) / Math.max(median(before), 1e-9),
      )]);
    }
    let first = candidates.findIndex(([, score]) => score >= 3);
    if (first < 0) {
      return { detected: false, count: Math.min(100, similarities.length), score: 0 };
    }
    let stop = first + 1;
    while (stop < candidates.length && candidates[stop][1] >= 3) stop += 1;
    let best = candidates[first];
    for (let i = first; i < stop; i += 1) if (candidates[i][1] > best[1]) best = candidates[i];
    return { detected: true, count: best[0], score: best[1] };
  }

  // Rank-weighted spherical mean, stable across the antimeridian.
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
      const lat = (match.latitude * Math.PI) / 180;
      const lng = (match.longitude * Math.PI) / 180;
      const weight = weights[index] / weightSum;
      x += weight * Math.cos(lat) * Math.cos(lng);
      y += weight * Math.cos(lat) * Math.sin(lng);
      z += weight * Math.sin(lat);
    });
    const norm = Math.hypot(x, y, z) || 1;
    x /= norm; y /= norm; z /= norm;
    return [
      (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI,
      (Math.atan2(y, x) * 180) / Math.PI,
    ];
  }

  // Nearest corpus panorama to a coordinate. The directory holds every row's
  // position, so this is a scan over 999,693 pairs of int32s - a few tens of
  // milliseconds - and needs no server and no index.
  //
  // This is what the guess-side cloud is built on: the 50k-era feature took the
  // nearest panorama in the MAP to the player's guess and drew its
  // neighbourhood. The corpus is no longer the map, so "nearest in the map"
  // becomes "nearest in the corpus", which is strictly more available.
  // Each panorama's own spawn heading, fetched only when something needs to be
  // rendered. View 0 of the corpus looks along the road at this heading, so a
  // match displayed here matches the framing it was embedded at - which is what
  // makes a side-by-side comparison honest rather than two arbitrary crops.
  function headings() {
    if (headingsPromise) return headingsPromise;
    headingsPromise = (async () => {
      const info = await manifest();
      if (!info.headings) return null;
      const packed = await cached("headings", () => request(HEADINGS_URL, "arraybuffer"));
      const plain = await gunzip(packed);
      return new Uint16Array(plain);
    })().catch((error) => {
      console.warn("[lodestar] headings unavailable:", error && error.message);
      return null;
    });
    return headingsPromise;
  }

  async function headingOf(row) {
    const table = await headings();
    return table ? table[row] / 100 : null;
  }

  async function nearest(latitude, longitude, options = {}) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    const dir = await directory();
    const target = [latitude, longitude];
    const cosLat = Math.cos((latitude * Math.PI) / 180);
    let bestRow = -1;
    let bestScore = Infinity;
    // squared degrees, longitude scaled by cos(latitude): monotone in true
    // distance over any plausible search area, and avoids 1M trig calls
    for (let row = 0; row < dir.rows; row += 1) {
      const dLat = dir.coords[row * 2] / COORD_SCALE - latitude;
      const dLng = (dir.coords[row * 2 + 1] / COORD_SCALE - longitude) * cosLat;
      const score = dLat * dLat + dLng * dLng;
      if (score < bestScore) { bestScore = score; bestRow = row; }
    }
    if (bestRow < 0) return null;
    const found = {
      row: bestRow,
      panoId: dir.decoder.decode(
        dir.ids.subarray(bestRow * ID_BYTES, (bestRow + 1) * ID_BYTES)),
      latitude: dir.coords[bestRow * 2] / COORD_SCALE,
      longitude: dir.coords[bestRow * 2 + 1] / COORD_SCALE,
    };
    // Its own spawn heading, so a caller can frame it along the road like every
    // other panorama. Without this the guess tile fell back to 0 and pointed
    // due north while the rest of the board looked down the street.
    found.heading = await headingOf(bestRow);
    found.distanceKm = haversineKm(target[0], target[1], found.latitude, found.longitude);
    if (Number.isFinite(options.withinKm) && found.distanceKm > options.withinKm) return null;
    return found;
  }

  function haversineKm(aLat, aLng, bLat, bLng) {
    const r = Math.PI / 180;
    const dLat = (bLat - aLat) * r;
    const dLng = (bLng - aLng) * r;
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // The projected vector for one row, decoded from its chunk.
  //
  // The neighbour table is exact but covers only each panorama's 300 closest,
  // so two panoramas that are not in each other's lists have no stored
  // similarity at all. These codes give one for any pair: 256 int8 values and a
  // scale per panorama, from a basis fitted to the corpus. Measured mean error
  // 0.0145 against the true cosine, so it is an estimate and should be
  // presented as one.
  async function projectedVector(row) {
    const info = await manifest();
    const projection = info.projection;
    if (!projection) return null;
    const index = Math.floor(row / projection.chunkRows);
    let decoded = projectionCache.get(index);
    if (!decoded) {
      const record = projection.chunks[index];
      if (!record) return null;
      const packed = await cached(`projection:${record.file}`,
        () => request(PROJECTION_BASE + record.file, "arraybuffer"));
      const plain = await gunzip(packed);
      const dims = projection.dimensions;
      const count = record.rows;
      decoded = {
        start: record.start,
        dims,
        codes: new Int8Array(plain, 0, count * dims),
        // the scales follow the codes; count * dims is a multiple of 2, so this
        // offset is safe for a 16-bit view
        scales: new Uint16Array(plain.slice(count * dims)),
      };
      projectionCache.set(index, decoded);
      while (projectionCache.size > 12) {
        projectionCache.delete(projectionCache.keys().next().value);
      }
    }
    const offset = (row - decoded.start) * decoded.dims;
    const scale = half(decoded.scales[row - decoded.start]);
    const vector = new Float32Array(decoded.dims);
    let norm = 0;
    for (let i = 0; i < decoded.dims; i += 1) {
      const value = decoded.codes[offset + i] * scale;
      vector[i] = value;
      norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < decoded.dims; i += 1) vector[i] /= norm;
    return vector;
  }

  // Estimated cosine similarity between any two panoramas in the corpus.
  async function similarityBetweenV1(panoIdA, panoIdB) {
    const dir = await directory();
    const rowA = dir.rowOf.get(String(panoIdA));
    const rowB = dir.rowOf.get(String(panoIdB));
    if (rowA === undefined || rowB === undefined) return null;
    const [a, b] = await Promise.all([projectedVector(rowA), projectedVector(rowB)]);
    if (!a || !b) return null;
    let total = 0;
    for (let i = 0; i < a.length; i += 1) total += a[i] * b[i];
    return total;
  }

  async function queryV1(panoId, count) {
    const dir = await directory();
    const row = dir.rowOf.get(String(panoId));
    if (row === undefined) return null;          // not in the corpus: caller falls back
    return queryRow(row, count);
  }

  async function query(panoId, count) {
    const v2 = root.LodestarPackV2;
    if (v2 && v2.available && v2.available()) {
      try {
        const result = await v2.query(panoId, count);
        if (result) return result;
      } catch (error) {
        console.warn("[lodestar] Pack V2 query failed; using V1:", error && error.message);
      }
    }
    return queryV1(panoId, count);
  }

  async function nearestPreferred(latitude, longitude, options) {
    const v2 = root.LodestarPackV2;
    if (v2 && v2.available && v2.available() && v2.nearest) {
      try {
        const result = await v2.nearest(latitude, longitude, options);
        if (result) return result;
      } catch (error) {
        console.warn("[lodestar] Pack V2 spatial lookup failed; using V1:", error && error.message);
      }
    }
    return nearest(latitude, longitude, options);
  }

  async function similarityBetween(panoIdA, panoIdB) {
    const v2 = root.LodestarPackV2;
    if (v2 && v2.available && v2.available() && v2.similarityBetween) {
      try {
        const result = await v2.similarityBetween(panoIdA, panoIdB);
        if (Number.isFinite(result)) return result;
      } catch (error) {
        console.warn("[lodestar] Pack V2 projection failed; using V1:", error && error.message);
      }
    }
    return similarityBetweenV1(panoIdA, panoIdB);
  }

  async function queryRow(row, count) {
    const started = Date.now();
    const dir = await directory();
    const panoId = dir.decoder.decode(dir.ids.subarray(row * ID_BYTES, (row + 1) * ID_BYTES));
    const info = dir.info;
    const k = info.neighborsPerPanorama;
    const wanted = Math.max(1, Math.min(Number(count) || k, k));
    const chunk = await chunkFor(row, info);
    const offset = (row - chunk.start) * k;
    const heading = await headings();
    const matches = [];
    for (let rank = 0; rank < wanted; rank += 1) {
      const target = chunk.indices[offset + rank];
      matches.push({
        rank: rank + 1,
        similarity: half(chunk.similarities[offset + rank]),
        mapIndex: target,
        panoId: dir.decoder.decode(
          dir.ids.subarray(target * ID_BYTES, (target + 1) * ID_BYTES)),
        latitude: dir.coords[target * 2] / COORD_SCALE,
        longitude: dir.coords[target * 2 + 1] / COORD_SCALE,
        // the framing this panorama was embedded at, for like-for-like display
        heading: heading ? heading[target] / 100 : null,
      });
    }
    const similarities = matches.map((match) => match.similarity);
    const steering = adaptiveCount(similarities);
    return {
      status: "complete",
      panoId: String(panoId),
      heading: heading ? heading[row] / 100 : null,
      // where the queried panorama itself is, so distances to its matches can
      // be measured without the caller having to know
      latitude: dir.coords[row * 2] / COORD_SCALE,
      longitude: dir.coords[row * 2 + 1] / COORD_SCALE,
      cacheHit: false,
      source: "lodestar-static-pack",
      corpus: info.corpus,
      corpusSize: info.rows,
      neighborsPerPanorama: k,
      // count = every match: the client slices to this, so the whole cloud draws
      boundary: {
        detected: true,
        count: matches.length,
        score: similarities[0] - similarities[similarities.length - 1],
        rule: "full cloud",
      },
      // ...while the click is steered by the strong core only
      clickCount: steering.count,
      clickRule: steering.rule,
      recommendedClick: sphericalClick(matches, steering.count),
      matches,
      timings: { totalSeconds: (Date.now() - started) / 1000 },
    };
  }

  root.LodestarPack = {
    query, queryRow, nearest: nearestPreferred, directory, headings, headingOf, boundary,
    adaptiveCount, sphericalClick, half, haversineKm,
    projectedVector, similarityBetween,
  };
})(typeof window !== "undefined" ? window : globalThis);
