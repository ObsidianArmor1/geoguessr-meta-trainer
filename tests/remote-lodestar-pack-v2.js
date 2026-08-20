"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const repo = path.resolve(__dirname, "../..");
const v1 = path.join(repo, "lodestar-neighbors");
const baseUrl = process.argv[2];
if (!baseUrl) throw new Error("usage: node tests/remote-lodestar-pack-v2.js BASE_URL");

require("../src/lodestar-pack-v2.js");
const pack = globalThis.LodestarPackV2;
let transferred = 0;
const statuses = [];

pack.configure({
  baseUrl,
  transport: async (url, options = {}) => {
    const headers = options.range
      ? { Range: `bytes=${options.range.start}-${options.range.end}` }
      : undefined;
    const response = await fetch(url, { headers });
    assert.ok(response.ok, `${url} -> HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const contentRange = response.headers.get("content-range");
    transferred += buffer.byteLength;
    statuses.push({
      url, status: response.status, bytes: buffer.byteLength,
      contentRange, range: options.range,
    });
    return { buffer, status: response.status, contentRange };
  },
});

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(v1, "manifest.json")));
  const directory = zlib.gunzipSync(fs.readFileSync(path.join(v1, "directory.bin.gz")));
  const ids = directory.subarray(0, manifest.rows * 22);
  const coordinates = directory.subarray(manifest.rows * 22);
  const headings = zlib.gunzipSync(fs.readFileSync(path.join(v1, "headings.bin.gz")));
  const chunkCache = new Map();
  const sampleRows = [0, 12345, 250000, 543210, 750000, manifest.rows - 1];

  function v1Row(row) {
    const record = manifest.neighborChunks.find((candidate) => (
      row >= candidate.start && row < candidate.start + candidate.rows
    ));
    assert.ok(record, `missing V1 chunk for row ${row}`);
    let chunk = chunkCache.get(record.file);
    if (!chunk) {
      chunk = zlib.gunzipSync(fs.readFileSync(path.join(v1, "neighbors", record.file)));
      chunkCache.set(record.file, chunk);
    }
    const k = manifest.neighborsPerPanorama;
    const rowOffset = (row - record.start) * k;
    const similaritiesOffset = record.rows * k * 4;
    return {
      latitude: coordinates.readInt32LE(row * 8) / 1e6,
      longitude: coordinates.readInt32LE(row * 8 + 4) / 1e6,
      heading: headings.readUInt16LE(row * 2) / 100,
      matches: Array.from({ length: k }, (_, rank) => {
        const target = chunk.readInt32LE((rowOffset + rank) * 4);
        return {
          panoId: ids.subarray(target * 22, (target + 1) * 22).toString("ascii"),
          latitude: coordinates.readInt32LE(target * 8) / 1e6,
          longitude: coordinates.readInt32LE(target * 8 + 4) / 1e6,
          heading: headings.readUInt16LE(target * 2) / 100,
          similarity: pack.half(chunk.readUInt16LE(similaritiesOffset + (rowOffset + rank) * 2)),
        };
      }),
    };
  }

  for (const row of sampleRows) {
    const panoId = ids.subarray(row * 22, (row + 1) * 22).toString("ascii");
    const result = await pack.query(panoId, 300);
    assert.ok(result, `missing row ${row}`);
    assert.equal(result.matches.length, 300);
    const expected = v1Row(row);
    assert.equal(result.latitude, expected.latitude, `source latitude at row ${row}`);
    assert.equal(result.longitude, expected.longitude, `source longitude at row ${row}`);
    assert.equal(result.heading, expected.heading, `source heading at row ${row}`);
    for (let rank = 0; rank < expected.matches.length; rank += 1) {
      const actual = result.matches[rank];
      const wanted = expected.matches[rank];
      assert.equal(actual.panoId, wanted.panoId, `pano id row ${row}, rank ${rank + 1}`);
      assert.equal(actual.latitude, wanted.latitude, `latitude row ${row}, rank ${rank + 1}`);
      assert.equal(actual.longitude, wanted.longitude, `longitude row ${row}, rank ${rank + 1}`);
      assert.equal(actual.heading, wanted.heading, `heading row ${row}, rank ${rank + 1}`);
      assert.equal(actual.similarity, wanted.similarity,
        `similarity row ${row}, rank ${rank + 1}`);
    }
  }
  const rowRequests = statuses.filter((entry) => entry.range);
  assert.equal(rowRequests.length, sampleRows.length);
  for (const request of rowRequests) {
    assert.equal(request.status, 206, `host ignored Range for ${request.url}`);
    assert.equal(request.bytes, request.range.end - request.range.start + 1);
    assert.match(request.contentRange || "", /^bytes \d+-\d+\/\d+$/,
      `missing or invalid Content-Range for ${request.url}`);
    assert.equal(
      request.contentRange,
      `bytes ${request.range.start}-${request.range.end}/${request.contentRange.split("/")[1]}`,
      `incorrect Content-Range for ${request.url}`,
    );
  }
  process.stdout.write(JSON.stringify({
    queries: sampleRows.length,
    transferred,
    transferredPerQuery: transferred / sampleRows.length,
    rowStatuses: rowRequests.map((entry) => ({
      status: entry.status,
      bytes: entry.bytes,
      contentRange: entry.contentRange,
    })),
  }, null, 2) + "\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
