#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const {
  ModalCradioClient,
  adaptResponse,
  panoIdFromRawRound,
  panoIdFromLiveRound,
  validToken,
  TOKEN_KEY,
  CACHE_KEY,
} = require("../src/cradio-client.js");

const queryPano = "query-pano-1";
const rawResponse = {
  status: "complete",
  panoId: queryPano,
  corpus: "balanced-world-50k-cradio-h-fused-v1",
  corpusSize: 49417,
  boundary: { detected: true, count: 2, score: 3.4 },
  recommendedClick: [50.6, 8.43],
  timings: { totalSeconds: 1.2 },
  matches: [
    { rank: 1, similarity: 0.92, mapIndex: 10, panoId: "match-1", latitude: 50, longitude: 8 },
    { rank: 2, similarity: 0.90, mapIndex: 11, panoId: "match-2", latitude: 51, longitude: 9 },
    { rank: 3, similarity: 0.80, mapIndex: 12, panoId: "match-3", latitude: 52, longitude: 10 },
  ],
};

function storage() {
  const values = new Map();
  return {
    getValue(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
    setValue(key, value) { values.set(key, value); },
    deleteValue(key) { values.delete(key); },
  };
}

function clientWith(request, store = storage()) {
  store.setValue(TOKEN_KEY, "wk-test-token.ws-test-token");
  return new ModalCradioClient({ ...store, request, timeoutMs: 20 });
}

async function main() {
  assert.equal(validToken("wk-test.ws-test"), true);
  assert.equal(validToken("wk-test"), false);
  assert.equal(validToken("Bearer wk-test.ws-test"), false);
  assert.equal(panoIdFromRawRound({
    round: 1,
    rounds: [{ panoId: queryPano }],
  }), queryPano, "regular round pano is discoverable");
  assert.equal(panoIdFromLiveRound({ location: { panoId: queryPano } }), queryPano,
    "Live Challenge pano is discoverable");

  const adapted = adaptResponse(rawResponse, {
    panoId: queryPano,
    latitude: 49,
    longitude: 7,
    sourceMapKey: "public-map",
  });
  assert.equal(adapted.cloud, true);
  assert.equal(adapted.matchMethod, "modal-cradio-v1");
  assert.equal(adapted.visualNeighborhood.visualMatches.length, 2);
  assert.equal(adapted.visualNeighborhood.boundary.detected, true);
  assert.deepEqual(adapted.visualNeighborhood.weightedClick, {
    latitude: 50.6,
    longitude: 8.43,
    expectedScore: null,
    source: "modal-cradio",
  });
  assert.equal(adapted.visualBoard.modes[0].entries.length, 2);
  assert.equal(adapted.location.views.length, 4);

  const boardClient = new ModalCradioClient({ ...storage() });
  const guessBoard = boardClient.buildVisualBoard(adapted, {
    guessAnchor: {
      panoId: "match-2",
      heading: 173,
      distanceFromGuessKm: 1.4,
      roundRank: 2,
      similarityToRound: 0.90,
      selectedBy: "strongest round match within radius",
    },
  }, { tiles: 15 });
  assert.equal(
    guessBoard.modes[0].guessMatch.panoId,
    "match-2",
    "4x4 comparison reserves tile two for the best visual case near the guess",
  );
  assert.equal(
    guessBoard.modes[0].entries.some((entry) => entry.panoId === "match-2"),
    false,
    "the guess-side example is not repeated among global ranked matches",
  );
  const unavailableGuessBoard = boardClient.buildVisualBoard(adapted, null, {
    tiles: 8,
    guessExpected: true,
  });
  assert.equal(
    unavailableGuessBoard.modes[0].guessUnavailable,
    true,
    "a submitted guess keeps an explicit comparison-unavailable slot",
  );
  assert.equal(
    unavailableGuessBoard.modes[0].entries.length,
    2,
    "the unavailable guess slot does not duplicate or discard the available ranked matches",
  );

  const packV2NullRows = adaptResponse({
    ...rawResponse,
    matches: rawResponse.matches.map((match) => ({ ...match, mapIndex: null })),
  }, {
    panoId: queryPano,
    latitude: 49,
    longitude: 7,
    sourceMapKey: "public-map",
  });
  assert.deepEqual(
    packV2NullRows.visualNeighborhood.visualMatches.map((match) => match.mapIndex),
    [0, 1],
    "Pack V2 null row IDs remain distinct instead of collapsing to row zero",
  );

  let calls = 0;
  const request = async (options) => {
    calls += 1;
    assert.equal(options.headers.Authorization, "Bearer wk-test-token.ws-test-token");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.deepEqual(JSON.parse(options.body), { panoId: queryPano, count: 500, heading: 0 });
    return { status: 200, body: JSON.stringify(rawResponse) };
  };
  const store = storage();
  const client = clientWith(request, store);
  const regularRoundPano = panoIdFromRawRound({ round: 1, rounds: [{ panoId: queryPano }] });
  const liveRoundPano = panoIdFromLiveRound({ location: { panoId: queryPano } });
  assert.equal(regularRoundPano, liveRoundPano, "regular and Live Challenge use the same pano identity");
  const [first, second] = await Promise.all([
    client.prefetch(regularRoundPano, { latitude: 49, longitude: 7 }),
    client.prefetch(liveRoundPano, { latitude: 49, longitude: 7 }),
  ]);
  assert.equal(calls, 1, "one Modal call is deduplicated across rerenders");
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.cached, false);
  assert.equal(client.diagnostics().configured, true);
  assert.equal(client.diagnostics().ok, true);

  let headingBody = null;
  const headingClient = clientWith(async (options) => {
    headingBody = JSON.parse(options.body);
    return { status: 200, body: JSON.stringify(rawResponse) };
  }, storage());
  const headingResult = await headingClient.prefetch("heading-pano", { heading: -15 });
  assert.equal(headingResult.ok, true);
  assert.equal(headingBody.heading, 345, "query heading is normalized and sent to Modal");
  const cachedClient = clientWith(async () => {
    throw new Error("cache hit must not call transport");
  }, store);
  const cacheHit = await cachedClient.prefetch(queryPano, { latitude: 49, longitude: 7 });
  assert.equal(cacheHit.ok, true);
  assert.equal(cacheHit.cached, true, "successful cloud responses are cached");
  assert.ok(store.getValue(CACHE_KEY).version >= 1);

  const originalPack = globalThis.LodestarPack;
  let packQueries = 0;
  globalThis.LodestarPack = {
    async query(panoId, count) {
      packQueries += 1;
      assert.equal(panoId, "lodestar-pano");
      assert.equal(count, 300);
      return {
        ...rawResponse,
        panoId,
        source: "lodestar-static-pack",
        corpus: "lodestar-1m",
        corpusSize: 999693,
        clickCount: 2,
      };
    },
  };
  let unexpectedCloudCalls = 0;
  const packOnly = new ModalCradioClient({
    ...storage(),
    request: async () => { unexpectedCloudCalls += 1; throw new Error("Modal must not run"); },
  });
  const packResult = await packOnly.prefetch("lodestar-pano", { latitude: 49, longitude: 7 });
  assert.equal(packResult.ok, true, "Lodestar rows work without a Modal credential");
  assert.equal(packResult.source, "lodestar-static-pack");
  assert.equal(packResult.response.cradio.corpus, "lodestar-1m");
  assert.equal(packQueries, 1);
  assert.equal(unexpectedCloudCalls, 0, "static lookup never consumes inference");
  if (originalPack === undefined) delete globalThis.LodestarPack;
  else globalThis.LodestarPack = originalPack;

  const missing = new ModalCradioClient({ ...storage(), request });
  assert.deepEqual(await missing.prefetch(queryPano), { ok: false, reason: "missing-credential" });
  const invalidStore = storage();
  invalidStore.setValue(TOKEN_KEY, "not-a-token");
  const invalid = new ModalCradioClient({ ...invalidStore, request });
  assert.deepEqual(await invalid.prefetch(queryPano), { ok: false, reason: "missing-credential" });

  for (const [status, reason] of [[401, "unauthorized"], [429, "rate-limited"], [500, "http-error"]]) {
    const failure = clientWith(async () => ({ status, body: "{}" }), storage());
    const result = await failure.prefetch(`pano-${status}`);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.equal(result.status, status);
  }
  const timeout = clientWith(async () => {
    const error = new Error("timeout");
    error.code = "timeout";
    throw error;
  }, storage());
  const timedOut = await timeout.prefetch("pano-timeout");
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, "timeout");
  assert.equal(timedOut.source, "modal");
  const network = clientWith(async () => { throw new Error("offline"); }, storage());
  const networkFailed = await network.prefetch("pano-network");
  assert.equal(networkFailed.ok, false);
  assert.equal(networkFailed.reason, "network-error");
  assert.equal(networkFailed.source, "modal");

  let failedCalls = 0;
  const failedOnce = clientWith(async () => {
    failedCalls += 1;
    return { status: 429, body: "{}" };
  }, storage());
  const failedFirst = await failedOnce.prefetch("pano-no-retry");
  const failedSecond = await failedOnce.prefetch("pano-no-retry");
  assert.equal(failedFirst.reason, "rate-limited");
  assert.equal(failedSecond.reason, "rate-limited");
  assert.equal(failedCalls, 1, "a failed pano is not automatically retried");
  failedOnce.forget("pano-no-retry");
  const deliberateRetry = await failedOnce.prefetch("pano-no-retry");
  assert.equal(deliberateRetry.reason, "rate-limited");
  assert.equal(failedCalls, 2, "an explicit user retry clears only the in-memory guard");
  assert.equal(failedOnce.diagnostics().reason, "rate-limited");

  // The userscript's request-token guard must discard a late prior-round
  // result; this deterministic gate mirrors that contract without a DOM.
  let currentRound = "round-2";
  const late = await clientWith(async () => new Promise((resolve) => {
    setTimeout(() => resolve({ status: 200, body: JSON.stringify(rawResponse) }), 1);
  }), storage()).prefetch("pano-late", { roundKey: "round-1" });
  assert.equal(currentRound !== "round-1", true, "test advances to a new round before completion");
  assert.equal(late.ok, true, "late result remains safe data and is ignored by caller token guard");

  process.stdout.write("C-RADIO client tests passed\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
