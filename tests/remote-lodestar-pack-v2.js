"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const repo = path.resolve(__dirname, "../..");
const baseUrl = process.argv[2];
const packPath = process.argv[3] || path.join(repo, "lodestar-range-pack-v2-2m");
if (!baseUrl) throw new Error("usage: node tests/remote-lodestar-pack-v2.js BASE_URL [LOCAL_PACK]");
if (!fs.existsSync(path.join(packPath, "manifest.json"))) {
  throw new Error(`Local Pack V2 manifest is missing: ${packPath}`);
}

require("../src/lodestar-pack-v2.js");
const pack = globalThis.LodestarPackV2;
const manifest = JSON.parse(fs.readFileSync(path.join(packPath, "manifest.json")));
assert.equal(manifest.corpus, "lodestar-balanced-2m");
assert.equal(manifest.generation, "b6f99168d869873c");
assert.equal(manifest.corpusRows, 1999685);
assert.equal(manifest.neighborsPerPanorama, 300);
const inventory = JSON.parse(fs.readFileSync(path.join(packPath, manifest.inventory)));
const byRow = new Map();
for (const bucket of inventory.buckets) {
  if (!bucket.rows) continue;
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(packPath, bucket.index)));
  const count = raw.readUInt32LE(8);
  for (let record = 0; record < count; record += 1) {
    const offset = 12 + record * 32;
    byRow.set(raw.readUInt32LE(offset + 28), raw.subarray(offset, offset + 16).toString("base64url"));
  }
}
const sampleRows = [0, 12345, 500000, 1000000, 1500000, manifest.corpusRows - 1];
const samplePanos = sampleRows.map((row) => {
  const panoId = byRow.get(row);
  assert.ok(panoId, `missing local index row ${row}`);
  return panoId;
});

function arrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function localTransport(url, options = {}) {
  if (options.range) {
    const length = options.range.end - options.range.start + 1;
    const handle = fs.openSync(url, "r");
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, options.range.start);
    fs.closeSync(handle);
    return { buffer: arrayBuffer(buffer), status: 206 };
  }
  return { buffer: arrayBuffer(fs.readFileSync(url)), status: 200 };
}

async function querySet(transport, url) {
  pack.configure({ baseUrl: url, transport });
  const results = [];
  for (const panoId of samplePanos) {
    const result = await pack.query(panoId, 300);
    assert.ok(result, `missing row ${panoId}`);
    assert.equal(result.matches.length, 300);
    results.push(result);
  }
  return results;
}

function assertSameResult(actual, expected, row) {
  for (const field of ["panoId", "latitude", "longitude", "heading"]) {
    assert.equal(actual[field], expected[field], `${field} row ${row}`);
  }
  assert.equal(actual.matches.length, expected.matches.length);
  for (let rank = 0; rank < expected.matches.length; rank += 1) {
    const wanted = expected.matches[rank];
    const got = actual.matches[rank];
    for (const field of ["rank", "panoId", "latitude", "longitude", "heading", "similarity"]) {
      assert.equal(got[field], wanted[field], `${field} row ${row}, rank ${rank + 1}`);
    }
  }
}

(async () => {
  const localResults = await querySet(localTransport, packPath);
  assert.equal((await pack.projectedVector(samplePanos[0]))?.length, 256,
    "local browser projection payload is compatible");
  const statuses = [];
  let transferred = 0;
  const remoteResults = await querySet(async (url, options = {}) => {
    const headers = options.range
      ? { Range: `bytes=${options.range.start}-${options.range.end}` }
      : undefined;
    const response = await fetch(url, { headers });
    assert.ok(response.ok, `${url} -> HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    const contentRange = response.headers.get("content-range");
    transferred += buffer.byteLength;
    statuses.push({
      status: response.status,
      bytes: buffer.byteLength,
      contentRange,
      range: options.range,
    });
    return { buffer, status: response.status, contentRange };
  }, baseUrl);
  assert.equal((await pack.projectedVector(samplePanos[0]))?.length, 256,
    "remote browser projection payload is compatible");

  for (let index = 0; index < sampleRows.length; index += 1) {
    assertSameResult(remoteResults[index], localResults[index], sampleRows[index]);
  }
  const rowRequests = statuses.filter((entry) => entry.range);
  assert.equal(rowRequests.length, sampleRows.length);
  for (const request of rowRequests) {
    assert.equal(request.status, 206, "host ignored Range");
    assert.equal(request.bytes, request.range.end - request.range.start + 1);
    assert.match(request.contentRange || "", /^bytes \d+-\d+\/\d+$/, "invalid Content-Range");
  }
  process.stdout.write(JSON.stringify({
    corpus: manifest.corpus,
    generation: manifest.generation,
    corpusRows: manifest.corpusRows,
    queries: sampleRows.length,
    sampleRows,
    transferred,
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
