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

pack.configure({
  baseUrl: output,
  transport: async (url, options = {}) => {
    if (options.range) {
      const length = options.range.end - options.range.start + 1;
      const handle = fs.openSync(url, "r");
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, options.range.start);
      fs.closeSync(handle);
      return { buffer: arrayBuffer(buffer), status: 206 };
    }
    return { buffer: arrayBuffer(fs.readFileSync(url)), status: 200 };
  },
});

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

  fs.rmSync(output, { recursive: true, force: true });
  process.stdout.write("Lodestar Pack V2 exact-parity test passed\n");
})().catch((error) => {
  fs.rmSync(output, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
