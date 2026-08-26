"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawnSync } = require("child_process");

const repo = path.resolve(__dirname, "../..");
const v1 = path.join(repo, "lodestar-neighbors");
const output = fs.mkdtempSync(path.join(os.tmpdir(), "lodestar-pack-v2-test-"));

const built = spawnSync("python3", [
  path.join(repo, "corpus_builder_v2/build_static_pack_v2.py"),
  "--rows", "64",
  "--bucket-bits", "4",
  "--progress-every", "64",
  "--out", output,
  "--replace",
], { cwd: repo, encoding: "utf8" });
assert.equal(built.status, 0, built.stderr || built.stdout);

require("../src/lodestar-pack-v2.js");
const pack = globalThis.LodestarPackV2;
assert.ok(pack, "Pack V2 is exported");

function arrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

const testTransport = async (url, options = {}) => {
  if (options.range) {
    const length = options.range.end - options.range.start + 1;
    const handle = fs.openSync(url, "r");
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, options.range.start);
    fs.closeSync(handle);
    return { buffer: arrayBuffer(buffer), status: 206 };
  }
  return { buffer: arrayBuffer(fs.readFileSync(url)), status: 200 };
};
const testConfig = {
  baseUrl: output,
  transport: testTransport,
};
pack.configure(testConfig);

function half(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(v1, "manifest.json")));
  const rows = manifest.rows;
  const directory = zlib.gunzipSync(fs.readFileSync(path.join(v1, "directory.bin.gz")));
  const ids = directory.subarray(0, rows * 22);
  const coordinates = directory.subarray(rows * 22);
  const sourcePano = ids.subarray(0, 22).toString("ascii");
  const sourceLatitude = coordinates.readInt32LE(0) / 1e6;
  const sourceLongitude = coordinates.readInt32LE(4) / 1e6;
  const headings = zlib.gunzipSync(fs.readFileSync(path.join(v1, "headings.bin.gz")));
  const sourceHeading = headings.readUInt16LE(0) / 100;

  const record = manifest.neighborChunks[0];
  const chunk = zlib.gunzipSync(fs.readFileSync(path.join(v1, "neighbors", record.file)));
  const count = record.rows * manifest.neighborsPerPanorama;
  const similaritiesOffset = count * 4;

  const result = await pack.query(sourcePano, 300);
  assert.ok(result);
  assert.equal(result.source, "lodestar-static-pack-v2");
  assert.equal(result.panoId, sourcePano);
  assert.equal(result.latitude, sourceLatitude);
  assert.equal(result.longitude, sourceLongitude);
  assert.equal(result.heading, sourceHeading);
  assert.equal(result.matches.length, 300);
  assert.equal(result.cacheHit, false, "the first query requires pack transport");
  const firstDiagnostics = pack.diagnostics();
  assert.equal(firstDiagnostics.lastQuery.status, "complete");
  assert.equal(firstDiagnostics.lastQuery.found, true);
  assert.equal(firstDiagnostics.lastQuery.decodedMatches, 300);
  assert.equal(firstDiagnostics.network.lastRangeStatus, 206);
  assert.ok(firstDiagnostics.network.requests >= 3);
  for (let rank = 0; rank < 300; rank += 1) {
    const target = chunk.readInt32LE(rank * 4);
    const expectedId = ids.subarray(target * 22, (target + 1) * 22).toString("ascii");
    assert.equal(result.matches[rank].panoId, expectedId, `pano id at rank ${rank + 1}`);
    assert.equal(result.matches[rank].latitude,
      coordinates.readInt32LE(target * 8) / 1e6, `latitude at rank ${rank + 1}`);
    assert.equal(result.matches[rank].longitude,
      coordinates.readInt32LE(target * 8 + 4) / 1e6, `longitude at rank ${rank + 1}`);
    assert.equal(result.matches[rank].heading,
      headings.readUInt16LE(target * 2) / 100, `heading at rank ${rank + 1}`);
    assert.equal(result.matches[rank].similarity,
      half(chunk.readUInt16LE(similaritiesOffset + rank * 2)), `similarity at rank ${rank + 1}`);
  }

  const located = await pack.locate(sourcePano);
  assert.equal(located.corpusRow, 0);
  assert.equal(pack.decodePanoramaId(pack.encodePanoramaId(sourcePano)), sourcePano);
  assert.ok((await pack.projectedVector(sourcePano)).length > 0);
  assert.ok((await pack.similarityBetween(sourcePano, sourcePano)) > 0.999);
  const nearest = await pack.nearest(sourceLatitude, sourceLongitude, { withinKm: 1 });
  assert.equal(nearest.panoId, sourcePano);
  assert.ok(nearest.distanceKm < 0.001);
  const repeated = await pack.query(sourcePano, 300);
  assert.equal(repeated.cacheHit, true, "a repeated query is served without transport");
  assert.equal(pack.diagnostics().lastQuery.cacheHit, true);
  assert.ok(pack.diagnostics().cache.memoryHits > 0);

  const publicRequests = pack.diagnostics().network.requests;
  pack.configure({
    baseUrl: "alternate-test",
    manifest: { format: "lodestar-range-row-pack", version: 2 },
    transport: async () => { throw new Error("the alternate test configuration should not fetch"); },
  });
  pack.configure(testConfig);
  const afterLayerSwitch = await pack.query(sourcePano, 300);
  assert.equal(afterLayerSwitch.cacheHit, true,
    "switching away and back preserves the public Pack V2 row cache");
  assert.equal(pack.diagnostics().network.requests, publicRequests,
    "an alternate configuration cannot evict warm public pack data");

  let manifestAttempts = 0;
  pack.configure({
    baseUrl: output,
    transport: async (url) => {
      manifestAttempts += 1;
      if (manifestAttempts === 1) throw new Error("temporary CDN failure");
      return { buffer: arrayBuffer(fs.readFileSync(url)), status: 200 };
    },
  });
  await assert.rejects(pack.manifest(), /temporary CDN failure/);
  assert.equal(pack.diagnostics().manifest, "failed");
  assert.equal((await pack.manifest()).version, 2,
    "a transient manifest failure does not poison later rounds in the tab");
  assert.equal(pack.diagnostics().manifest, "ready");
  assert.equal(manifestAttempts, 2);

  // Concurrent consumers (round review plus guess-side warming) must share
  // identical index and row reads rather than burst duplicate CDN requests.
  let concurrentRequests = 0;
  const concurrentTransport = async (url, options = {}) => {
    concurrentRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return testTransport(url, options);
  };
  pack.configure({ baseUrl: output, transport: concurrentTransport });
  const [concurrentA, concurrentB] = await Promise.all([
    pack.query(sourcePano, 300),
    pack.query(sourcePano, 300),
  ]);
  assert.equal(concurrentA.panoId, sourcePano);
  assert.equal(concurrentB.panoId, sourcePano);
  assert.equal(concurrentRequests, 3,
    "two simultaneous identical queries share manifest, index, and row requests");
  assert.ok(pack.diagnostics().cache.inflightHits >= 2,
    "in-flight request sharing is visible in diagnostics");

  // A brief public-host 429 should recover locally instead of falling through
  // to the unrelated private Modal endpoint and surfacing its 404.
  let rateLimitedRequests = 0;
  pack.configure({
    baseUrl: output,
    retryDelayMs: 0,
    transport: async (url, options = {}) => {
      rateLimitedRequests += 1;
      if (rateLimitedRequests <= 2) {
        const error = new Error(`${url} -> HTTP 429`);
        error.status = 429;
        throw error;
      }
      return testTransport(url, options);
    },
  });
  const recovered = await pack.query(sourcePano, 300);
  assert.equal(recovered.panoId, sourcePano);
  assert.equal(pack.diagnostics().network.retries, 2,
    "Pack V2 retries transient rate limits with bounded backoff");

  fs.rmSync(output, { recursive: true, force: true });
  process.stdout.write("Lodestar Pack V2 exact-parity test passed\n");
})().catch((error) => {
  fs.rmSync(output, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
