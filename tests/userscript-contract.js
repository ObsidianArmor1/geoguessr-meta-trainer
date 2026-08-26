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
assert.match(source, /^\/\/ @connect\s+hf\.co$/m,
  "Tampermonkey authorizes Hugging Face's redirected CDN subdomains");
assert.doesNotMatch(source, /^\/\/ @connect\s+\*\.hf\.co$/m,
  "do not use the unreliable wildcard form for Tampermonkey @connect");
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
assert.match(source, /const NATIVE_PANO_POOL_LIMIT = 4;/,
  "native Street View is bounded to one four-direction peek's GPU contexts");
assert.match(source, /if \(nativePanoCache\.size >= NATIVE_PANO_POOL_LIMIT\)/,
  "later Shift hovers recycle an existing Street View renderer");
assert.match(source, /entry\.panorama\.setPano\?\.\(String\(panoId\)\)/,
  "the renderer pool retargets rather than accumulating WebGL contexts");
assert.doesNotMatch(source, /NATIVE_PANO_CACHE_LIMIT = 12/,
  "the context-evicting 12-renderer cache must not return");
assert.match(source, /function passiveMapIcon\(/,
  "recommendation icons use a dedicated non-interactive overlay");
assert.match(source, /pointer-events:none;user-select:none;z-index:/,
  "recommendation icons never capture a nearby panorama's hover target");
assert.doesNotMatch(source, /new maps\.Marker\(/,
  "recommendation pins must not use Google Marker hit regions");
assert.match(source, /await handleRoundEnd\(liveChallengeAdapter\.buildEventState\(liveRound, challengeId\)\)/,
  "Live Challenge enters the same complete round-end pipeline as single-player");
assert.doesNotMatch(source, /framework\.events\.addEventListener\("round_end"[\s\S]{0,800}LIVE_CHALLENGE_PATH[\s\S]{0,300}return;/,
  "Live Challenge must not be excluded from the shared full-feature round_end path");
assert.match(source, /if \(state\.roundRequestKey === requestKey && state\.roundRequestQuality >= requestQuality\) return;/,
  "the API fallback and event framework share a quality-aware deduplication gate");
const roundEndBody = source.slice(
  source.indexOf("async function handleRoundEnd(eventState)"),
  source.indexOf("function prefetchModalFromEventState(eventState)"),
);
assert.ok(
  roundEndBody.indexOf("if (state.roundRequestKey === requestKey && state.roundRequestQuality >= requestQuality) return;")
    < roundEndBody.indexOf("const token = ++state.requestToken;"),
  "an ignored duplicate round-end event must not invalidate the useful request already in flight",
);
assert.doesNotMatch(source, /if \(state\.liveChallengeResultVisible\) clearRound\(\)/,
  "a transient Live Challenge result subtree must not tear down completed review state");
assert.doesNotMatch(source, /frameworkEnded/,
  "the single-player event framework's default state must not impersonate a Live result");
assert.match(source, /liveChallengeAdapter\.lifecycle\(data, profileId\)/,
  "Live Challenge derives gameplay/result phase from its authenticated payload");
assert.match(source, /if \(apiPlaying \|\| \(!apiResult && !mounted\)\)/,
  "an advancing Live round clears the full post-round interface");
assert.match(source, /window\.setInterval\(queueCheck, 1000\)/,
  "Live round transitions have a bounded fallback when GeoGuessr emits no usable event");
assert.match(source, /function clearCompletedReviewForActiveRound\(roundNumber, locationValue\)/,
  "an authoritative active-round identity clears stale post-round recommendations");
assert.match(source, /if \(state\.review\) clearRound\(\);[\s\S]{0,300}const activeRound = liveState\.activeRound/,
  "Live Challenge clears its entire completed review before warming the active round");
assert.match(source, /clearCompletedReviewForActiveRound\(roundNumber, location\)/,
  "raw standard round data also provides a missed-round_start safety net");
assert.match(source, /function discoverReactResultMaps\(\)/,
  "result maps missed by the early Google Maps hook have a React-instance fallback");
assert.match(source, /function trackMap\(map\)/,
  "single-player and Live Challenge maps share overlay, hover, and guess-prefetch wiring");
assert.match(source, /captureSubmittedGuess\(url, init\?\.body\)/,
  "Live Challenge captures the user's authoritative outgoing fetch guess");
assert.match(source, /captureSubmittedGuess\(this\.__OMT_LIVE_URL, body\)/,
  "Live Challenge captures the user's authoritative outgoing XHR guess");
assert.match(source, /liveChallengeAdapter\.matchingGuess\(data, lifecycle\.announcedRound, state\.pendingPlayerGuess\)/,
  "a submitted pin identifies the user's result even when GeoGuessr profile IDs drift");
assert.match(source, /round\.playerGuess = pendingMatch/,
  "the recovered Live Challenge guess reaches the shared round-end pipeline");
assert.match(source, /\|\| state\.pendingPlayerGuess;/,
  "the shared review retains a final submitted-pin fallback for blue comparisons");
assert.match(source, /if \(!state\.root\?\.isConnected\) render\(\)/,
  "a GeoGuessr Live subtree replacement remounts an already-built review");
assert.match(source, /state\.roundRequestQuality = -1;/,
  "a completed Live lookup that produced no interface remains retryable");
assert.match(source, /\.omt-board-current > img,\.omt-board-match > img \{[^}]*object-fit:cover/,
  "single-direction V-board thumbnails fill their cells instead of becoming a letterboxed square");
assert.match(source, /image\.src = boardThumbnail \? resolved : fitViewToBox/,
  "V-board thumbnails retain the canonical embedding aspect on every browser");
assert.match(source, /role: "nearGuessUnavailable"/,
  "the V-board receipt records an unavailable near-guess comparison explicitly");
assert.match(source, /No nearby view is available for this guess\./,
  "the V-board explains why a submitted guess has no nearby comparison tile");

process.stdout.write("userscript architecture contract passed\n");
