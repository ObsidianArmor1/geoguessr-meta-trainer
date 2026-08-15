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

process.stdout.write("live challenge adapter fixtures passed\n");
