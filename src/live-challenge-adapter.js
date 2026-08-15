(function (root) {
  "use strict";

  const LIVE_CHALLENGE_PATH = /^\/(?:api\/)?live-challenge\/([^/?#]+)\/?$/;
  const PARTY_LOBBY_PATH = /^\/party\/lobby\/[^/?#]+\/?$/;
  const RESULT_SELECTORS = Object.freeze([
    '[class*="result-map_roundPin"]',
    '[class*="result-map_round-pin"]',
    '[data-qa="correct-location-pin"]',
    '[data-qa="round-result"] [class*="result-map"]',
    '[data-testid="round-result"] [class*="result-map"]',
  ]);

  function pathnameFromUrl(value) {
    try {
      return new URL(value, "https://www.geoguessr.com").pathname;
    } catch (_error) {
      return "";
    }
  }

  function challengeIdFromUrl(value) {
    return pathnameFromUrl(value).match(LIVE_CHALLENGE_PATH)?.[1] || null;
  }

  function challengeIdForPage(pathname, resourceUrls = [], trackedChallenge = null) {
    const routeId = challengeIdFromUrl(pathname);
    if (routeId) return routeId;
    if (!PARTY_LOBBY_PATH.test(pathnameFromUrl(pathname))) return null;
    for (let index = resourceUrls.length - 1; index >= 0; index -= 1) {
      const id = challengeIdFromUrl(resourceUrls[index]);
      if (id) return id;
    }
    return trackedChallenge?.partyLobbyPath === pathnameFromUrl(pathname)
      ? trackedChallenge.id
      : null;
  }

  function decodePanoId(value) {
    const encoded = String(value || "");
    if (encoded.length < 32 || encoded.length % 2 || !/^[0-9a-f]+$/i.test(encoded)) {
      return encoded;
    }
    let decoded = "";
    for (let index = 0; index < encoded.length; index += 2) {
      decoded += String.fromCharCode(parseInt(encoded.slice(index, index + 2), 16));
    }
    return /^[\x20-\x7e]+$/.test(decoded) ? decoded : encoded;
  }

  function coordinates(value) {
    const latitude = Number(value?.lat ?? value?.latitude);
    const longitude = Number(value?.lng ?? value?.longitude ?? value?.lon);
    return Number.isFinite(latitude) && Number.isFinite(longitude)
      ? { lat: latitude, lng: longitude }
      : null;
  }

  function scalar(value) {
    if (value == null || typeof value === "object") return "";
    return String(value);
  }

  function mapKey(data) {
    const candidates = [
      data?.options?.mapSlug,
      data?.options?.map?.slug,
      data?.options?.map?.id,
      data?.options?.mapId,
      data?.mapSlug,
      data?.mapId,
      data?.map?.slug,
      data?.map?.id,
      data?.game?.options?.mapSlug,
      data?.game?.map?.slug,
      data?.game?.map?.id,
    ];
    return candidates.map(scalar).find(Boolean) || "";
  }

  function profileId(profile) {
    const value = profile?.user?.id ?? profile?.id ?? profile?.userId
      ?? profile?.profileId ?? profile?.player?.id;
    return value == null ? null : String(value);
  }

  function roundNumber(data) {
    const rounds = Array.isArray(data?.rounds) ? data.rounds : [];
    const raw = Number(
      data?.currentRoundNumber ?? data?.roundNumber ?? data?.currentRound ?? data?.round,
    );
    if (Number.isInteger(raw) && raw > 0) return raw;
    return Math.max(rounds.length, 1);
  }

  function roundAt(data, number) {
    const rounds = Array.isArray(data?.rounds) ? data.rounds : [];
    return rounds[number - 1] || data?.currentRound || data?.round || null;
  }

  function panoramaForRound(sourceRound) {
    return sourceRound?.question?.panoramaQuestionPayload?.panorama
      ?? sourceRound?.question?.panorama
      ?? sourceRound?.panoramaQuestionPayload?.panorama
      ?? sourceRound?.panorama
      ?? sourceRound?.location
      ?? null;
  }

  function belongsToProfile(value, wantedProfileId) {
    if (!wantedProfileId || !value || typeof value !== "object") return false;
    const candidates = [
      value.id,
      value.userId,
      value.playerId,
      value.profileId,
      value.user?.id,
      value.profile?.id,
      value.player?.id,
    ];
    return candidates.some((item) => item != null && String(item) === String(wantedProfileId));
  }

  function statedRound(value) {
    const direct = Number(value?.roundNumber ?? value?.round);
    if (Number.isFinite(direct)) return direct;
    const index = Number(value?.roundIndex);
    return Number.isFinite(index) ? index + 1 : null;
  }

  function playerGuess(data, sourceRound, number, wantedProfileId = null) {
    const direct = [
      sourceRound?.player_guess,
      sourceRound?.playerGuess,
      sourceRound?.guess,
      data?.player?.guesses?.[number - 1],
      data?.currentPlayer?.guesses?.[number - 1],
      data?.me?.guesses?.[number - 1],
    ];
    for (const value of direct) {
      const result = coordinates(value);
      if (result) return result;
    }
    if (!wantedProfileId) return null;

    const candidates = [];
    const seen = new Set();
    const visit = (value, path, inheritedProfile, inheritedRound, depth) => {
      if (!value || typeof value !== "object" || depth > 10 || seen.has(value)) return;
      seen.add(value);
      const inProfile = inheritedProfile || belongsToProfile(value, wantedProfileId);
      const result = coordinates(value);
      const pathText = path.join(".").toLowerCase();
      const itemRound = statedRound(value);
      const effectiveRound = itemRound ?? inheritedRound;
      if (
        inProfile
        && result
        && /(guess|answer|result)/.test(pathText)
        && !/(question|panorama|correct)/.test(pathText)
        && (effectiveRound == null || effectiveRound === number)
      ) {
        candidates.push({ result, depth });
      }
      for (const [key, item] of Object.entries(value)) {
        visit(item, [...path, key], inProfile, effectiveRound, depth + 1);
      }
    };
    visit(data, [], false, null, 0);
    candidates.sort((left, right) => left.depth - right.depth);
    return candidates[0]?.result || null;
  }

  function numberFrom(value, paths) {
    for (const path of paths) {
      let current = value;
      for (const key of path) current = current?.[key];
      if (current == null) continue;
      const numeric = Number(current);
      if (Number.isFinite(numeric)) return numeric;
    }
    return null;
  }

  function roundOutcome(data, sourceRound, number, wantedProfileId = null) {
    const profiles = [];
    const seen = new Set();
    const visit = (value, inheritedProfile, inheritedRound, depth) => {
      if (!value || typeof value !== "object" || depth > 9 || seen.has(value)) return;
      seen.add(value);
      const inProfile = inheritedProfile || belongsToProfile(value, wantedProfileId);
      const itemRound = statedRound(value);
      const effectiveRound = itemRound ?? inheritedRound;
      if (inProfile && (effectiveRound == null || effectiveRound === number)) profiles.push(value);
      for (const item of Object.values(value)) visit(item, inProfile, effectiveRound, depth + 1);
    };
    if (wantedProfileId) visit(data, false, null, 0);
    const sources = [...profiles, sourceRound].filter(Boolean);
    for (const source of sources) {
      const score = numberFrom(source, [
        ["score", "amount"], ["score"], ["points"], ["roundScore"],
      ]);
      const distanceMeters = numberFrom(source, [
        ["distance", "meters", "amount"], ["distance", "meters"],
        ["distanceMeters"], ["distanceInMeters"],
      ]);
      const timeSeconds = numberFrom(source, [
        ["time"], ["timeSeconds"], ["duration"],
      ]);
      if (score != null || distanceMeters != null || timeSeconds != null) {
        return { score, distanceMeters, timeSeconds };
      }
    }
    return { score: null, distanceMeters: null, timeSeconds: null };
  }

  function normalizeRound(data, challengeId, wantedProfileId = null) {
    const number = roundNumber(data);
    const sourceRound = roundAt(data, number);
    const panorama = panoramaForRound(sourceRound);
    if (!panorama) return null;
    const panoId = decodePanoId(panorama.panoId ?? panorama.panoid ?? panorama.id);
    const location = coordinates(panorama);
    if (!panoId && !location) return null;
    return {
      roundNumber: number,
      roundKey: `${challengeId}:${number}`,
      mapId: mapKey(data),
      location: {
        panoId,
        lat: location?.lat ?? null,
        lng: location?.lng ?? null,
      },
      playerGuess: playerGuess(data, sourceRound, number, wantedProfileId),
      outcome: roundOutcome(data, sourceRound, number, wantedProfileId),
    };
  }

  function buildEventState(liveRound, challengeId) {
    const rounds = Array.from({ length: liveRound.roundNumber }, () => ({}));
    rounds[liveRound.roundNumber - 1] = {
      eventKey: liveRound.roundKey,
      gameId: challengeId,
      datasetKey: liveRound.mapId,
      mapId: liveRound.mapId,
      location: liveRound.location,
      player_guess: liveRound.playerGuess,
      score: liveRound.outcome?.score == null ? null : { amount: liveRound.outcome.score },
      distance: liveRound.outcome?.distanceMeters == null
        ? null
        : { meters: { amount: liveRound.outcome.distanceMeters } },
      time: liveRound.outcome?.timeSeconds ?? null,
    };
    return {
      mapId: liveRound.mapId,
      map: { id: liveRound.mapId },
      rounds,
    };
  }

  function resultMounted(rootNode) {
    return Boolean(rootNode?.querySelector?.(RESULT_SELECTORS.join(",")));
  }

  const api = {
    LIVE_CHALLENGE_PATH,
    PARTY_LOBBY_PATH,
    RESULT_SELECTORS,
    pathnameFromUrl,
    challengeIdFromUrl,
    challengeIdForPage,
    decodePanoId,
    coordinates,
    mapKey,
    profileId,
    playerGuess,
    normalizeRound,
    buildEventState,
    resultMounted,
  };

  root.OMTLiveChallenge = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
