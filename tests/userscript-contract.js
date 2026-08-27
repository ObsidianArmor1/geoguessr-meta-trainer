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
assert.match(source, /state\.overlayMap !== map[\s\S]{0,100}state\.overlayRoundKey !== state\.reviewRoundKey/,
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
assert.match(source, /await handleRoundEnd\(\s*liveChallengeAdapter\.buildEventState\(liveRound, challengeId\)/,
  "Live Challenge enters the same complete round-end pipeline as single-player");
assert.doesNotMatch(source, /framework\.events\.addEventListener\("round_end"[\s\S]{0,800}LIVE_CHALLENGE_PATH[\s\S]{0,300}return;/,
  "Live Challenge must not be excluded from the shared full-feature round_end path");
assert.match(source, /if \(state\.roundRequestKey === requestKey && state\.roundRequestQuality >= requestQuality\) \{[\s\S]{0,220}status: "pending"/,
  "the API fallback and event framework share a quality-aware deduplication gate");
const roundEndBody = source.slice(
  source.indexOf("async function handleRoundEnd(eventState)"),
  source.indexOf("function prefetchModalFromEventState(eventState)"),
);
assert.ok(
  roundEndBody.indexOf("if (state.roundRequestKey === requestKey && state.roundRequestQuality >= requestQuality) {")
    < roundEndBody.indexOf("const token = ++state.requestToken;"),
  "an ignored duplicate round-end event must not invalidate the useful request already in flight",
);
assert.doesNotMatch(source, /if \(state\.liveChallengeResultVisible\) clearRound\(\)/,
  "a transient Live Challenge result subtree must not tear down completed review state");
assert.doesNotMatch(source, /frameworkEnded/,
  "the single-player event framework's default state must not impersonate a Live result");
assert.match(source, /liveChallengeAdapter\.lifecycle\(data, profileId\)/,
  "Live Challenge derives gameplay/result phase from its authenticated payload");
assert.match(source, /if \(apiPlaying \|\| partyAwaitingResult \|\| \(!apiResult && !mounted\)\)/,
  "an advancing or not-yet-revealed Live round clears the full post-round interface");
assert.match(source, /window\.setInterval\(queueCheck, 1000\)/,
  "Live round transitions have a bounded fallback when GeoGuessr emits no usable event");
assert.match(source, /function clearCompletedReviewForActiveRound\(roundNumber, locationValue\)/,
  "an authoritative active-round identity clears stale post-round recommendations");
assert.match(source, /if \(state\.roundRequestKey \|\| state\.review \|\| state\.root \|\| state\.visualBoard[\s\S]{0,150}clearRound\(\);[\s\S]{0,300}const activeRound = liveState\.activeRound/,
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
assert.match(source, /round && !round\.playerGuess && recoveredGuess/,
  "a recovered Live Challenge guess reaches the shared round-end pipeline without replacing API truth");
assert.match(source, /\|\| state\.pendingPlayerGuess;/,
  "the shared review retains a final submitted-pin fallback for blue comparisons");
assert.match(source, /if \(!state\.root\?\.isConnected\) render\(\)/,
  "a GeoGuessr Live subtree replacement remounts an already-built review");
assert.match(source, /state\.roundRequestQuality = -1;/,
  "a completed Live lookup that produced no interface remains retryable");
assert.match(source, /credentials: "include", cache: "no-store"/,
  "Live Challenge polling bypasses browser HTTP caches");
assert.match(source, /const pageFetch = pageWindow\.fetch\?\.bind\(pageWindow\)/,
  "trainer polling uses a stable fetch that cannot trigger its own request observer");
assert.match(source, /const dataPromise = pageFetch\(/,
  "Live API polling does not recursively queue itself through the GeoGuessr fetch hook");
assert.match(source, /if \(lookupInFlight\) \{\s*checkAfterLookup = true;/,
  "a transition observed during a Live lookup is replayed when that lookup finishes");
assert.match(source, /liveChallengeAdapter\.outcomeCompletesRound\([\s\S]{0,300}state\.liveChallengeLastRoundKey = liveRound\.roundKey/,
  "a duplicate or stale lookup cannot mark a Live round complete");
assert.match(roundEndBody, /clearReviewArtifacts\("new-round-result"\)/,
  "an authoritative new result clears every prior-round artifact before lookup");
assert.match(roundEndBody, /ownsRoundRequest\(token, requestKey\)/,
  "async round-end work commits only while it still owns the current request");
assert.match(roundEndBody, /Similarity response belonged to another panorama/,
  "a response for the wrong panorama is rejected before rendering");
assert.match(source, /guessNeighborhoodRoundKey === reviewRoundKey/,
  "blue-dot data is reused only by the round that produced it");
assert.match(source, /visualBoardRoundKey !== state\.reviewRoundKey/,
  "the V board refuses to render content owned by another round");
assert.match(source, /state\.overlayMap !== map[\s\S]{0,100}state\.overlayRoundKey !== state\.reviewRoundKey/,
  "overlays attached to a replaced Live result map are repainted");
assert.match(source, /\.omt-board-current > img,\.omt-board-match > img \{[^}]*object-fit:cover/,
  "single-direction V-board thumbnails fill their cells instead of becoming a letterboxed square");
assert.match(source, /image\.src = boardThumbnail \? resolved : fitViewToBox/,
  "V-board thumbnails retain the canonical embedding aspect on every browser");
assert.match(source, /role: "nearGuessUnavailable"/,
  "the V-board receipt records an unavailable near-guess comparison explicitly");
assert.match(source, /No nearby view is available for this guess\./,
  "the V-board explains why a submitted guess has no nearby comparison tile");
assert.match(source, /src\/cradio-client\.js\?v=2\.2\.0-beta\.80/,
  "Tampermonkey receives a fresh comparison client when its board behavior changes");
assert.match(source, /const partyAwaitingResult = PARTY_LOBBY_PATH\.test\(location\.pathname\) && !mounted;/,
  "a private party does not treat this player's submitted guess as the round result");
assert.match(source, /if \(apiPlaying \|\| partyAwaitingResult \|\| \(!apiResult && !mounted\)\)/,
  "the Live poll clears review UI until GeoGuessr exposes the private-party result");
assert.match(source, /if \(PARTY_LOBBY_PATH\.test\(location\.pathname\) && !liveChallengeResultMounted\(\)\) return;/,
  "an early private-party framework round_end cannot bypass the visible-result privacy gate");
assert.match(source, /pageWindow\.sessionStorage\.setItem\(LIVE_GUESS_SESSION_KEY/,
  "a submitted Live Challenge guess survives a same-tab reload");
assert.match(source, /restoredGuess\([\s\S]{0,250}challengeId,[\s\S]{0,100}roundNumber/,
  "reload recovery is keyed to the exact challenge and round");
assert.match(source, /if \(round && !round\.playerGuess && recoveredGuess\) round\.playerGuess = recoveredGuess/,
  "the recovered submitted guess reaches the shared review pipeline without replacing API truth");
assert.match(source, /src\/lodestar-pack-v2\.js\?v=2\.2\.0-beta\.80/,
  "Tampermonkey receives the cache-preserving Pack V2 client in this release");
assert.match(source, /prefetchGuessSide\(guess\.lat, guess\.lng, \{ immediate: true \}\)/,
  "submitting a guess starts its blue-cloud warm immediately");
assert.match(source, /pack\.prefetchNearbyVisual\(latitude, longitude, \{[\s\S]{0,180}targetCandidates: 160/,
  "guess submission warms the adaptive local visual pool before review");
assert.match(source, /maximumKm: 100/,
  "adaptive near-guess warming remains bounded for ocean and sparse guesses");
assert.match(source, /best of \$\{mode\.guessMatch\.candidatePool\}<\/b> corpus views\$\{guessPoolScope\}/,
  "the V-board receipt reports the actual adaptive pool and radius");
assert.doesNotMatch(source, /127\.0\.0\.1|localhost|PRIVATE_LAYER_STORAGE_KEY|configurePrivateLocalLayer/,
  "the public userscript has no Florida/loopback integration or permission");
assert.doesNotMatch(source, /privateLocalLayer/,
  "public diagnostics contain no private Florida layer state");
const tileImagesBody = source.slice(
  source.indexOf("function tileImages("),
  source.indexOf("// The enlarged view, built in one place"),
);
assert.match(tileImagesBody, /data-src="\$\{esc\(corpusViewUrl\(panoId, heading\)\)\}"/,
  "normal V-board cells use the canonical heading-aware panorama thumbnail");
assert.doesNotMatch(tileImagesBody, /corpusTileUrl|omt-board-direct|\[\[3, 1\], \[4, 1\], \[3, 2\], \[4, 2\]\]/,
  "normal V-board cells do not use fixed raw panorama tile columns");
assert.match(tileImagesBody, /\[0, 90, 180, 270\]\.map\([\s\S]*corpusViewUrl\(panoId, Number\(heading\) \+ offset\)/,
  "four-direction board mode retains heading-aware thumbnails");
assert.match(source, /void hydrateImages\(element\);/,
  "the heading-aware thumbnail board still uses normal image hydration");
assert.doesNotMatch(source, /corpusTileUrl|omt-board-direct|hydrateBoardDirectTiles/,
  "fixed direct-tile replacement and its stale hydration path are removed");
assert.match(source, /Visual similarity temporarily unavailable \(public corpus request failed\)/,
  "a public-pack failure is not concealed by an unrelated Modal fallback status");

process.stdout.write("userscript architecture contract passed\n");
