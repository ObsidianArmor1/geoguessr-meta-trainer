"use strict";

const assert = require("node:assert/strict");
const UniversalSimilarity = require("../src/universal-similarity.js");

const normalized = UniversalSimilarity.unit(Float32Array.from([3, 4]));
assert.ok(Math.abs(normalized[0] - 0.6) < 1e-6);
assert.ok(Math.abs(normalized[1] - 0.8) < 1e-6);

const best = UniversalSimilarity.topKHeap(
  Float32Array.from([0.2, 0.9, -0.1, 0.5, 0.8]),
  3,
);
assert.deepEqual(best.map((row) => row.row), [1, 4, 3]);
assert.ok(best[0].score > best[1].score && best[1].score > best[2].score);

const url = UniversalSimilarity.thumbnail("abc", 270, 448, 256);
assert.match(url, /panoid=abc/);
assert.match(url, /yaw=270/);
assert.match(url, /thumbfov=90/);

console.log("universal-similarity tests passed");
