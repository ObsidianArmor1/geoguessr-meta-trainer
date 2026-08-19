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
  const MANIFEST_URL =
    "https://raw.githubusercontent.com/ObsidianArmor1/lodestar-neighbors/main/manifest.json";
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
  let manifestPromise = null;
  const chunkCache = new Map();          // chunk index -> decoded arrays

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
    const clamped = Math.max(MIN_MATCHES, Math.min(count, similarities.length));
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

  async function query(panoId, count) {
    const started = Date.now();
    const dir = await directory();
    const row = dir.rowOf.get(String(panoId));
    if (row === undefined) return null;          // not in the corpus: caller falls back
    const info = dir.info;
    const k = info.neighborsPerPanorama;
    const wanted = Math.max(1, Math.min(Number(count) || k, k));
    const chunk = await chunkFor(row, info);
    const offset = (row - chunk.start) * k;
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
      });
    }
    const similarities = matches.map((match) => match.similarity);
    const steering = adaptiveCount(similarities);
    return {
      status: "complete",
      panoId: String(panoId),
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

  root.LodestarPack = { query, directory, boundary, adaptiveCount, sphericalClick, half };
})(typeof window !== "undefined" ? window : globalThis);
