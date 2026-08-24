#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const adapter = require("../src/live-challenge-adapter.js");

function fixture(name) {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, "fixtures", `live-challenge-${name}.json`),
    "utf8",
  ));
}

function assertFixture(name) {
  const value = fixture(name);
  const routeChallengeId = adapter.challengeIdForPage(
    value.route,
    name === "party"
      ? [`https://game-server.geoguessr.com/api/live-challenge/${value.expected.challengeId}`]
      : [],
  );
  assert.equal(routeChallengeId, value.expected.challengeId);
  assert.equal(adapter.resultMounted({
    querySelector(query) {
      return query.includes(value.resultSelector) ? { selector: value.resultSelector } : null;
    },
  }), true, `${name} result DOM unlocks post-round normalization`);
  const wantedProfileId = adapter.profileId(value.profile);
  const round = adapter.normalizeRound(
    value.payload,
    value.expected.challengeId,
    wantedProfileId,
  );
  assert.ok(round, `${name} payload normalizes`);
  assert.equal(round.roundKey, `${value.expected.challengeId}:${value.expected.roundNumber}`);
  assert.equal(round.roundNumber, value.expected.roundNumber);
  assert.equal(round.mapId, value.expected.mapId);
  assert.equal(round.location.panoId, value.expected.panoId);
  assert.deepEqual(round.playerGuess, value.expected.guess);
  assert.deepEqual(round.outcome, {
    score: value.expected.score,
    distanceMeters: value.expected.distanceMeters,
    timeSeconds: value.expected.timeSeconds,
  });

  const eventState = adapter.buildEventState(round, value.expected.challengeId);
  const eventRound = eventState.rounds.at(-1);
  assert.equal(eventState.map.id, value.expected.mapId);
  assert.equal(eventRound.eventKey, round.roundKey);
  assert.deepEqual(eventRound.player_guess, value.expected.guess);
  assert.equal(eventRound.score.amount, value.expected.score);
  assert.equal(eventRound.distance.meters.amount, value.expected.distanceMeters);
  assert.equal(eventRound.time, value.expected.timeSeconds);
}

assert.equal(
  adapter.challengeIdFromUrl("https://www.geoguessr.com/live-challenge/public-game?x=1"),
  "public-game",
);
assert.equal(
  adapter.challengeIdFromUrl("https://game-server.geoguessr.com/api/live-challenge/party-game"),
  "party-game",
);
assert.equal(adapter.challengeIdForPage(
  "/party/lobby/ROOM",
  [
    "https://game-server.geoguessr.com/api/live-challenge/old-game",
    "https://game-server.geoguessr.com/api/parties/v2/ROOM/lobby",
    "https://game-server.geoguessr.com/api/live-challenge/current-game",
  ],
), "current-game");
assert.equal(adapter.challengeIdForPage(
  "/maps/example",
  ["https://game-server.geoguessr.com/api/live-challenge/leaked-game"],
), null);
assert.equal(adapter.challengeIdForPage(
  "/party/lobby/ROOM",
  [],
  { id: "tracked-game", partyLobbyPath: "/party/lobby/ROOM" },
), "tracked-game");
assert.equal(adapter.isLiveChallengePage("/live-challenge/public-game"), true);
assert.equal(adapter.isLiveChallengePage(
  "/party/lobby/ROOM",
  [],
  { id: "tracked-game", partyLobbyPath: "/party/lobby/ROOM" },
), true);
assert.equal(adapter.isLiveChallengePage("/game/ordinary-game"), false);

for (const selector of adapter.RESULT_SELECTORS) {
  assert.equal(adapter.resultMounted({
    querySelector(query) { return query.includes(selector) ? { selector } : null; },
  }), true, `${selector} mounts a post-round result`);
}
assert.equal(adapter.resultMounted({ querySelector() { return null; } }), false);

assertFixture("public");
assertFixture("party");

const party = fixture("party");
const noProfile = adapter.normalizeRound(party.payload, "party-game", null);
assert.equal(noProfile.playerGuess, null, "another player's guess is never used without identity");
assert.equal(noProfile.roundNumber, 3,
  "without identity the result fallback preserves GeoGuessr's announced round");

const activePayload = {
  currentRoundNumber: 2,
  rounds: [
    { location: { panoId: "completed", lat: 1, lng: 2 }, playerGuess: { lat: 3, lng: 4 } },
    { location: { panoId: "active", lat: 5, lng: 6 } },
  ],
};
assert.equal(adapter.normalizeRound(activePayload, "game", null).location.panoId, "completed",
  "a submitted guess identifies the completed round during a transition");
assert.equal(adapter.normalizeActiveRound(activePayload, "game").location.panoId, "active",
  "gameplay prefetch still warms the active question");

// This is the exact input contract consumed by the ordinary handleRoundEnd
// path. Live Challenge must not grow a reduced, feature-specific review path.
const parityRound = adapter.buildEventState(
  adapter.normalizeRound(party.payload, "party-game", "party-player"),
  "party-game",
).rounds.at(-1);
assert.ok(parityRound.eventKey);
assert.ok(parityRound.gameId);
assert.ok(parityRound.datasetKey);
assert.ok(parityRound.location.panoId);
assert.ok(Number.isFinite(parityRound.location.lat));
assert.ok(Number.isFinite(parityRound.location.lng));
assert.ok(Number.isFinite(parityRound.player_guess.lat));
assert.ok(Number.isFinite(parityRound.player_guess.lng));
assert.ok(Number.isFinite(parityRound.score.amount));
assert.ok(Number.isFinite(parityRound.distance.meters.amount));
assert.ok(Number.isFinite(parityRound.time));

process.stdout.write("live challenge adapter fixtures passed\n");
