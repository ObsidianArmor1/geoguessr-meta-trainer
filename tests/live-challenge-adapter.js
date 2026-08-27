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
assert.equal(
  adapter.challengeIdFromUrl("https://game-server.geoguessr.com/api/live-challenge/party-game/guess"),
  "party-game",
  "Live Challenge submission subroutes retain their challenge identity",
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
assert.equal(adapter.resultMounted({
  querySelectorAll() {
    return [{ isConnected: true, getBoundingClientRect: () => ({ width: 0, height: 0 }), getClientRects: () => [] }];
  },
}), false, "a hidden result subtree does not keep the review alive during gameplay");
assert.equal(adapter.resultMounted({
  querySelectorAll() {
    return [{ isConnected: true, getBoundingClientRect: () => ({ width: 750, height: 350 }) }];
  },
}), true, "a visible Live Challenge result map enables the fallback");

const hiddenResultAncestor = { parentElement: null };
const hiddenResult = {
  isConnected: true,
  hidden: false,
  parentElement: hiddenResultAncestor,
  closest() { return null; },
  getBoundingClientRect: () => ({ width: 750, height: 350 }),
};
assert.equal(adapter.resultMounted({
  defaultView: {
    getComputedStyle(element) {
      return element === hiddenResultAncestor
        ? { display: "none", visibility: "visible", opacity: "1" }
        : { display: "block", visibility: "visible", opacity: "1" };
    },
  },
  querySelectorAll() { return [hiddenResult]; },
}), false, "a stale result inside a hidden ancestor cannot expose review UI");

assert.equal(adapter.resultMounted({
  querySelectorAll() {
    return [{
      isConnected: true,
      hidden: false,
      closest(query) { return query.includes("aria-hidden") ? { hidden: true } : null; },
      getBoundingClientRect: () => ({ width: 750, height: 350 }),
    }];
  },
}), true, "accessibility-only aria-hidden state cannot suppress a visibly mounted result");

assertFixture("public");
assertFixture("party");

const completedParty = fixture("party");
assert.deepEqual(adapter.lifecycle(completedParty.payload, "party-player"), {
  announcedRound: 3,
  guessedRound: 3,
  phase: "result",
});
const playingParty = structuredClone(completedParty.payload);
playingParty.players[1].roundResults.pop();
assert.deepEqual(adapter.lifecycle(playingParty, "party-player"), {
  announcedRound: 3,
  guessedRound: 2,
  phase: "playing",
});

const keyedPlayerPayload = {
  currentRoundNumber: 1,
  rounds: [{ location: { panoId: "nested-guess-pano", lat: 20, lng: 30 } }],
  guessesByPlayer: {
    "party-player": [{ roundNumber: 1, answer: { position: { latitude: 40, longitude: -70 } } }],
  },
};
assert.deepEqual(
  adapter.normalizeRound(keyedPlayerPayload, "keyed", "party-player").playerGuess,
  { lat: 40, lng: -70 },
  "profile-keyed nested answer positions recover the player's own guess",
);

const indexedGuessesPayload = {
  currentRoundNumber: 3,
  rounds: [1, 2, 3].map((number) => ({
    location: { panoId: `indexed-${number}`, lat: number, lng: number },
  })),
  players: [{
    id: "party-player",
    guesses: [
      { position: { lat: 10, lng: 11 } },
      { position: { lat: 20, lng: 21 } },
      { position: { lat: 30, lng: 31 } },
    ],
  }],
};
assert.deepEqual(
  adapter.normalizeRound(indexedGuessesPayload, "indexed", "party-player").playerGuess,
  { lat: 30, lng: 31 },
  "profile guess arrays use their round index when entries omit roundNumber",
);

const unidentifiedPlayers = {
  currentRoundNumber: 2,
  rounds: [
    { location: { panoId: "old", lat: 1, lng: 2 } },
    { location: { panoId: "current", lat: 3, lng: 4 } },
  ],
  players: [
    { guesses: [{ lat: 10, lng: 10 }, { lat: 41.12345, lng: -72.54321 }] },
    { guesses: [{ lat: 41.12345, lng: -72.54321 }, { lat: 50, lng: 50 }] },
  ],
};
assert.deepEqual(
  adapter.matchingGuess(unidentifiedPlayers, 2, { lat: 41.12346, lng: -72.5432 }),
  { lat: 41.12345, lng: -72.54321 },
  "the placed pin identifies the current-round player guess without a profile ID",
);
assert.equal(
  adapter.matchingGuess(unidentifiedPlayers, 1, { lat: 50, lng: 50 }),
  null,
  "a coordinate submitted in another round cannot impersonate the current guess",
);
assert.deepEqual(adapter.submittedGuess(JSON.stringify({ guess: {
  latitude: 12.3,
  longitude: -45.6,
} })), { lat: 12.3, lng: -45.6 },
"an outgoing Live Challenge request reveals the submitted pin");
assert.deepEqual(adapter.submittedGuess("lat=12.3&lng=-45.6"), { lat: 12.3, lng: -45.6 });
assert.equal(adapter.submittedGuess("not-json"), null);

const storedGuess = adapter.storedGuessRecord(
  "party-game",
  3,
  { latitude: 12.3, longitude: -45.6 },
  1_000,
);
assert.deepEqual(storedGuess, {
  challengeId: "party-game",
  roundNumber: 3,
  guess: { lat: 12.3, lng: -45.6 },
  submittedAt: 1_000,
});
assert.deepEqual(adapter.restoredGuess(JSON.stringify(storedGuess), "party-game", 3, {
  now: 2_000,
  maxAgeMs: 2_000,
}), { lat: 12.3, lng: -45.6 }, "the exact party round survives a same-tab reload");
assert.equal(adapter.restoredGuess(storedGuess, "party-game", 4, {
  now: 2_000,
  maxAgeMs: 2_000,
}), null, "a previous round guess cannot leak into the next round");
assert.equal(adapter.restoredGuess(storedGuess, "another-game", 3, {
  now: 2_000,
  maxAgeMs: 2_000,
}), null, "a guess cannot leak into another Live Challenge");
assert.equal(adapter.restoredGuess(storedGuess, "party-game", 3, {
  now: 4_000,
  maxAgeMs: 2_000,
}), null, "an expired submitted guess is discarded");

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

const ownedReview = { location: { panoId: "current-pano" } };
assert.equal(adapter.reviewMatchesRequest(
  ownedReview,
  "5:current-pano",
  "5:current-pano",
  "current-pano",
), true, "a review explicitly owns its matching round and panorama");
assert.equal(adapter.outcomeCompletesRound(
  { status: "pending" },
  ownedReview,
  "5:current-pano",
  "5:current-pano",
  "current-pano",
), false, "an in-flight duplicate cannot mark a Live round complete");
assert.equal(adapter.outcomeCompletesRound(
  { status: "ready" },
  ownedReview,
  "4:old-pano",
  "5:current-pano",
  "current-pano",
), false, "an old review cannot mark the current Live round complete");
assert.equal(adapter.outcomeCompletesRound(
  { status: "ready" },
  ownedReview,
  "5:current-pano",
  "5:current-pano",
  "different-pano",
), false, "a wrong-panorama response cannot mark the current Live round complete");

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
