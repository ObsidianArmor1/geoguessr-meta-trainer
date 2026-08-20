"use strict";

// Local delivery benchmark for a fully materialised Pack V2. This measures the
// decoder/routing overhead and exact bytes requested; internet latency belongs
// to the eventual object host and is intentionally not mixed into this number.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { performance } = require("perf_hooks");

const repo = path.resolve(__dirname, "../..");
const packPath = process.argv[2] || path.join(repo, "lodestar-range-pack-v2");
const sampleCount = Number(process.argv[3] || 250);
if (!fs.existsSync(path.join(packPath, "manifest.json"))) {
  throw new Error(`Pack V2 manifest is missing: ${packPath}`);
}

require("../src/lodestar-pack-v2.js");
const pack = globalThis.LodestarPackV2;
const manifest = JSON.parse(fs.readFileSync(path.join(packPath, "manifest.json")));
const inventory = JSON.parse(fs.readFileSync(path.join(packPath, manifest.inventory)));
const descriptors = [];
for (const bucket of inventory.buckets) {
  if (!bucket.rows) continue;
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(packPath, bucket.index)));
  const count = raw.readUInt32LE(8);
  for (let record = 0; record < count; record += Math.max(1, Math.floor(count / 3))) {
    const offset = 12 + record * 32;
    const panoId = raw.subarray(offset, offset + 16).toString("base64url");
    descriptors.push(panoId);
    if (descriptors.length >= sampleCount) break;
  }
  if (descriptors.length >= sampleCount) break;
}

let fullBytes = 0;
let rangeBytes = 0;
let requests = 0;
function arrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}
pack.configure({
  baseUrl: packPath,
  transport: async (url, options = {}) => {
    requests += 1;
    if (options.range) {
      const length = options.range.end - options.range.start + 1;
      const handle = fs.openSync(url, "r");
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, options.range.start);
      fs.closeSync(handle);
      rangeBytes += length;
      return { buffer: arrayBuffer(buffer), status: 206 };
    }
    const buffer = fs.readFileSync(url);
    fullBytes += buffer.length;
    return { buffer: arrayBuffer(buffer), status: 200 };
  },
});

(async () => {
  if (global.gc) global.gc();
  const before = process.memoryUsage().rss;
  const durations = [];
  for (const panoId of descriptors) {
    const started = performance.now();
    const result = await pack.query(panoId, 300);
    if (!result || result.matches.length !== 300) throw new Error(`bad row ${panoId}`);
    durations.push(performance.now() - started);
  }
  if (global.gc) global.gc();
  const after = process.memoryUsage().rss;
  durations.sort((a, b) => a - b);
  const quantile = (fraction) => durations[Math.min(
    durations.length - 1, Math.floor(fraction * durations.length))];
  console.log(JSON.stringify({
    rowsQueried: descriptors.length,
    requests,
    fullBytes,
    rangeBytes,
    totalBytes: fullBytes + rangeBytes,
    bytesPerQuery: (fullBytes + rangeBytes) / descriptors.length,
    rangeBytesPerQuery: rangeBytes / descriptors.length,
    localLatencyMs: {
      median: quantile(0.5),
      p90: quantile(0.9),
      p99: quantile(0.99),
    },
    rssBefore: before,
    rssAfter: after,
    rssDelta: after - before,
  }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
