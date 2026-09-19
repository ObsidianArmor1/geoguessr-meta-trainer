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
assert.equal(adapter.challengeIdForPage(
  "/party/lobby/ROOM",
  [
    "https://game-server.geoguessr.com/api/live-challenge/game-b",
    "https://game-server.geoguessr.com/api/live-challenge/game-a",
  ],
  { id: "game-b", partyLobbyPath: "/party/lobby/ROOM" },
), "game-b", "authoritative current traffic outranks stale trainer Resource Timing entries");
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
assert.deepEqual(adapter.resultMountStatus({
  querySelectorAll() {
    return [
      { isConnected: false },
      { isConnected: true, getBoundingClientRect: () => ({ width: 750, height: 350 }) },
    ];
  },
}), {
  mounted: true,
  candidates: 2,
  connected: 1,
  largestWidth: 750,
  largestHeight: 350,
}, "result diagnostics expose whether selectors or rendered geometry failed");

const transitionResultAncestor = { parentElement: null };
const transitionResult = {
  isConnected: true,
  hidden: false,
  parentElement: transitionResultAncestor,
  closest() { return null; },
  getBoundingClientRect: () => ({ width: 750, height: 350 }),
};
assert.equal(adapter.resultMounted({
  defaultView: {
    getComputedStyle(element) {
      return element === transitionResultAncestor
        ? { display: "none", visibility: "visible", opacity: "1" }
        : { display: "block", visibility: "visible", opacity: "1" };
    },
  },
  querySelectorAll() { return [transitionResult]; },
}), true, "transition-ancestor semantics cannot suppress a visibly rendered result");

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
assert.equal(adapter.submittedRoundNumber(JSON.stringify({ roundNumber: 2 })), 2);
assert.equal(adapter.submittedRoundNumber("lat=12.3&lng=-45.6&round=3"), 3);
assert.equal(adapter.submittedRoundNumber(JSON.stringify({ guess: { lat: 1, lng: 2 } })), null);

const trainerPollNonce = "runtime-only-nonce";
const oldGamePollUrl = adapter.trainerPollUrl("game-a", trainerPollNonce);
const parsedPollUrl = new URL(oldGamePollUrl);
assert.equal(parsedPollUrl.pathname, "/api/live-challenge/game-a",
  "the trainer marker leaves the known GET endpoint path unchanged");
assert.equal(parsedPollUrl.searchParams.get(adapter.TRAINER_POLL_QUERY), trainerPollNonce,
  "the trainer-only nonce is carried solely as an ordinary query parameter");
assert.equal(adapter.challengeIdFromUrl(oldGamePollUrl), "game-a",
  "the endpoint's existing challenge parser tolerates the marked query form");
assert.equal(adapter.isTrainerPollUrl(oldGamePollUrl, trainerPollNonce), true);
assert.equal(adapter.isTrainerPollUrl(oldGamePollUrl, "another-runtime"), false);
assert.deepEqual(adapter.classifyChallengeResource(oldGamePollUrl, {
  source: "performance",
  initiatorType: "fetch",
  trainerPollNonce,
  fetchTrackingInstalled: false,
}), { challengeId: "game-a", kind: "trainer-poll" },
  "the nonce deterministically classifies a poll even when fetch hooks are unavailable");
assert.deepEqual(adapter.classifyChallengeResource(
  "https://game-server.geoguessr.com/api/live-challenge/game-b",
  {
    source: "performance",
    initiatorType: "fetch",
    trainerPollNonce,
    fetchTrackingInstalled: true,
  },
), { challengeId: "game-b", kind: "observed-duplicate" },
"a hooked GeoGuessr fetch's later Resource Timing entry is not a second discovery event");

const epochs = adapter.createChallengeEpoch();
const gameA = epochs.observe("game-a", "fetch");
const delayedGameAPoll = epochs.capture();
assert.deepEqual(gameA, { challengeId: "game-a", epoch: 1, changed: true, ignored: false });
const gameB = epochs.observe("game-b", "fetch");
assert.deepEqual(gameB, { challengeId: "game-b", epoch: 2, changed: true, ignored: false },
  "game A round 5 to game B round 1 on one lobby creates a new game epoch");
assert.equal(epochs.owns(delayedGameAPoll), false,
  "a delayed old-game poll cannot commit after game B discovery");
assert.deepEqual(epochs.observe("game-a", "trainer-poll"), {
  challengeId: "game-b", epoch: 2, changed: false, ignored: true,
}, "the trainer's own game-A poll cannot reclaim authoritative challenge identity");
assert.equal(epochs.owns(gameB), true);
const realNow = Date.now;
let delayedPollObservation;
try {
  Date.now = () => 60_000;
  delayedPollObservation = adapter.classifyChallengeResource(oldGamePollUrl, {
    source: "performance",
    initiatorType: "fetch",
    trainerPollNonce,
  });
} finally {
  Date.now = realNow;
}
epochs.observe(delayedPollObservation.challengeId, delayedPollObservation.kind);
assert.equal(epochs.owns(gameB), true,
  "a nonce-marked game-A Resource Timing event remains harmless after any delay");

const gameAGuess = adapter.capturedGuessRecord("game-a", 5, { lat: 41, lng: -122 }, 1_000);
assert.equal(adapter.ownedPendingGuess(gameAGuess, "game-b", 2), null,
  "a game-A round-5 submitted guess cannot attach to game B round 2");
assert.equal(adapter.ownedPendingGuess(gameAGuess, "game-a", 4), null,
  "a submitted guess cannot cross rounds within its game");
const gameBResult = {
  currentRoundNumber: 2,
  rounds: [
    { location: { panoId: "game-b-one", lat: 10, lng: 20 } },
    { location: { panoId: "game-b-two", lat: 30, lng: 40 } },
  ],
  players: [{
    guesses: [
      { lat: 11, lng: 21 },
      { lat: 35.12345, lng: -97.54321 },
    ],
  }],
};
const unboundGameBGuess = adapter.capturedGuessRecord(
  "game-b", null, { lat: 35.12346, lng: -97.5432 }, 2_000,
);
const authoritativeGameBGuess = adapter.matchingPendingGuess(
  gameBResult, "game-b", 2, unboundGameBGuess,
);
assert.deepEqual(authoritativeGameBGuess, { lat: 35.12345, lng: -97.54321 },
  "an unnumbered game-B submission binds only after the authoritative round-2 result");
const boundGameBGuess = adapter.capturedGuessRecord(
  "game-b", 2, authoritativeGameBGuess, 2_000,
);
assert.deepEqual(adapter.ownedPendingGuess(boundGameBGuess, "game-b", 2),
  { lat: 35.12345, lng: -97.54321 },
  "the correctly owned game-B guess remains available to build the blue-dot cloud");
assert.equal(adapter.matchingPendingGuess(gameBResult, "game-a", 2, unboundGameBGuess), null,
  "matching an authoritative payload still requires challenge ownership");

const profileMissingGameBResult = {
  currentRoundNumber: 2,
  rounds: [
    { location: { panoId: "game-b-one", lat: 10, lng: 20 } },
    { location: { panoId: "game-b-two", lat: 30, lng: 40 } },
  ],
  players: [],
};
const earlyGameBGuess = adapter.capturedGuessRecord(
  "game-b", null, { lat: 35.5, lng: -97.5 }, 3_000, gameB.epoch,
);
assert.equal(adapter.matchingPendingGuess(
  profileMissingGameBResult, "game-b", 2, earlyGameBGuess, gameB.epoch,
), null, "the profile-missing payload intentionally provides no coordinate match");
const safelyBoundGameBGuess = adapter.bindPendingGuessRound(
  earlyGameBGuess, "game-b", 2, gameB.epoch,
);
assert.deepEqual(adapter.ownedPendingGuess(
  safelyBoundGameBGuess, "game-b", 2, gameB.epoch,
), { lat: 35.5, lng: -97.5 },
  "an early game-B guess binds to authoritative round 2 within the same epoch");
assert.equal(adapter.bindPendingGuessRound(
  earlyGameBGuess, "game-a", 2, gameB.epoch,
), null, "authoritative round binding cannot cross challenges");
assert.equal(adapter.bindPendingGuessRound(
  earlyGameBGuess, "game-b", 2, gameB.epoch + 1,
), null, "authoritative round binding cannot cross game epochs");

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
