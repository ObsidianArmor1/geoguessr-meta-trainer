#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");

require("../src/lodestar-pack.js");
const pack = globalThis.LodestarPack;

assert.ok(pack, "LodestarPack is exported in a non-browser runtime");

// IEEE-754 half decoding is the basis of every stored similarity and scale.
assert.equal(pack.half(0x3c00), 1);
assert.equal(pack.half(0xbc00), -1);
assert.equal(pack.half(0x0000), 0);
assert.equal(pack.half(0x7c00), Infinity);
assert.ok(Number.isNaN(pack.half(0x7e00)));

// The strong core is relative to each row's top match, never a global cutoff.
const dense = [0.95, 0.94, 0.93, 0.925, 0.924, 0.90, 0.89, 0.88, 0.87, 0.86, 0.85, 0.84];
const denseCore = pack.adaptiveCount(dense);
assert.equal(denseCore.count, 10, "the minimum stabilizes a very small core");
assert.equal(denseCore.detected, true);
assert.match(denseCore.rule, /0\.025/);

const broad = [0.95, 0.949, 0.948, 0.947, 0.946, 0.945, 0.944, 0.943, 0.942, 0.941, 0.94, 0.80];
assert.equal(pack.adaptiveCount(broad).count, 11, "all matches inside the row-relative margin survive");

// Sparse rows still retain the minimum core, capped by available matches.
assert.equal(pack.adaptiveCount([0.95, 0.80, 0.70]).count, 3);
assert.equal(pack.adaptiveCount([]).count, 0);

// The recommended click uses a spherical mean, so an antimeridian cloud does
// not incorrectly point halfway around the world near Greenwich.
const antimeridian = pack.sphericalClick([
  { latitude: 10, longitude: 179 },
  { latitude: 10, longitude: -179 },
], 2);
assert.ok(Math.abs(antimeridian[0] - 10) < 0.1);
assert.ok(Math.abs(Math.abs(antimeridian[1]) - 180) < 0.2);

assert.ok(pack.haversineKm(0, 0, 0, 1) > 111);
assert.ok(pack.haversineKm(0, 0, 0, 1) < 112);

// Too-short lists deliberately fall back instead of inventing a slope break.
assert.deepEqual(pack.boundary([0.9, 0.8]), {
  detected: false,
  count: 2,
  score: 0,
});

process.stdout.write("Lodestar static-pack tests passed\n");
