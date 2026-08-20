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
assert.match(source, /@require\s+.*\/lodestar-pack-v2\.js/);
assert.match(source, /@require\s+.*\/cradio-client\.js/);
assert.doesNotMatch(source, /@require\s+.*onnxruntime-web/,
  "the rejected browser-inference runtime must not return to page startup");
assert.doesNotMatch(source, /@require\s+.*universal-similarity\.js/,
  "arbitrary-map inference is Lodestar static lookup or exact Modal C-RADIO");

assert.match(source, /const useSimilarityReview = Boolean\(cloudPanoId\) && \(cloudConfigured \|\| packAvailable\)/,
  "a known Lodestar pano must work without a Modal credential");
assert.match(source, /if \(knownMap\) return criticalRequest/,
  "legacy known-map data remains a fallback when a pano is outside Lodestar");
assert.match(source, /GM_registerMenuCommand\("Copy trainer diagnostics"/,
  "diagnostics are discoverable even when the post-round UI cannot render");
assert.match(source, /id="omt-copy-diagnostics"/,
  "an offline round exposes a one-click diagnostic report");
assert.match(source, /if \(state\.review && state\.overlays\.length === 0/,
  "late-mounted result maps render without requiring the drawer to be open");
const diagnosticBody = source.slice(
  source.indexOf("function trainerDiagnostics()"),
  source.indexOf("async function writeClipboard"),
);
assert.doesNotMatch(diagnosticBody, /TOKEN_KEY|cradioClient\.token\(/,
  "the copied diagnostics must not serialize the private Modal token");
assert.match(source, /className = "omt-match-tooltip-stills"/,
  "dot previews retain a stable thumbnail layer while live Street View loads");
assert.match(source, /host\.appendChild\(grid\);\s*for \(const \[live, heading\] of mounts\)/,
  "all four high-resolution cells mount before expensive Street View construction begins");
assert.doesNotMatch(source, /gallery\.innerHTML = urls\.map/,
  "thumbnail completion must not delete an already-mounted native Street View layer");

process.stdout.write("userscript architecture contract passed\n");
