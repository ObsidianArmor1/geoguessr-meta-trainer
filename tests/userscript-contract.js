#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/geoguessr-meta-trainer.user.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const metadataVersion = source.match(/^\/\/ @version\s+([^\s]+)$/m)?.[1];
const runtimeVersion = source.match(/const USERSCRIPT_VERSION = "([^"]+)";/)?.[1];
assert.equal(metadataVersion, pkg.version, "metadata version follows package.json");
assert.equal(runtimeVersion, pkg.version, "runtime version follows package.json");

assert.match(source, /@require\s+.*\/lodestar-pack\.js/);
assert.match(source, /@require\s+.*\/cradio-client\.js/);
assert.doesNotMatch(source, /@require\s+.*onnxruntime-web/,
  "the rejected browser-inference runtime must not return to page startup");
assert.doesNotMatch(source, /@require\s+.*universal-similarity\.js/,
  "arbitrary-map inference is Lodestar static lookup or exact Modal C-RADIO");

assert.match(source, /const useSimilarityReview = Boolean\(cloudPanoId\) && \(cloudConfigured \|\| packAvailable\)/,
  "a known Lodestar pano must work without a Modal credential");
assert.match(source, /if \(knownMap\) return criticalRequest/,
  "legacy known-map data remains a fallback when a pano is outside Lodestar");

process.stdout.write("userscript architecture contract passed\n");
