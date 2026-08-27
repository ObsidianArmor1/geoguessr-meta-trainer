(function (root) {
  "use strict";

  const LIVE_CHALLENGE_PATH = /^\/(?:api\/)?live-challenge\/([^/?#]+)(?:\/[^?#]*)?\/?$/;
  const PARTY_LOBBY_PATH = /^\/party\/lobby\/[^/?#]+\/?$/;
  const RESULT_SELECTORS = Object.freeze([
    '[class*="result-map_roundPin"]',
    '[class*="result-map_round-pin"]',
    '[class*="result-map_correctLocation"]',
    '[data-qa="correct-location-pin"]',
    '[data-testid="correct-location-pin"]',
    '[data-qa="round-result"] [class*="result-map"]',
    '[data-testid="round-result"] [class*="result-map"]',
    '[data-qa="round-result"]',
    '[data-testid="round-result"]',
    '[class*="result-map_map"]',
    '[class*="round-result"] [class*="map"]',
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

  function isLiveChallengePage(pathname, resourceUrls = [], trackedChallenge = null) {
    return Boolean(challengeIdForPage(pathname, resourceUrls, trackedChallenge));
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
    const candidates = [
      value,
      value?.position,
      value?.guess,
      value?.answer,
      value?.pin,
      value?.guessLocation,
      value?.coordinates,
    ];
    for (const candidate of candidates) {
      const latitude = Number(candidate?.lat ?? candidate?.latitude);
      const longitude = Number(candidate?.lng ?? candidate?.longitude ?? candidate?.lon);
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        return { lat: latitude, lng: longitude };
      }
    }
    return null;
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
    const value = profile?.user?.id ?? profile?.user?.userId ?? profile?.id ?? profile?.userId
      ?? profile?.profileId ?? profile?.profile?.id ?? profile?.player?.id
      ?? profile?.player?.playerId;
    return value == null ? null : String(value);
  }

  function announcedRoundNumber(data) {
    const rounds = Array.isArray(data?.rounds) ? data.rounds : [];
    const raw = Number(
      data?.currentRoundNumber ?? data?.roundNumber ?? data?.currentRound ?? data?.round,
    );
    if (Number.isInteger(raw) && raw > 0) return raw;
    return Math.max(rounds.length, 1);
  }

  function completedRoundNumber(data, wantedProfileId = null) {
    const rounds = Array.isArray(data?.rounds) ? data.rounds : [];
    const announced = announcedRoundNumber(data);
    const upper = Math.min(Math.max(announced, rounds.length), rounds.length);

    // Prefer the newest round that actually contains this player's submitted
    // guess. This tolerates payloads in which round arrays and the announced
    // round update at slightly different moments during the result transition.
    for (let number = upper; number >= 1; number -= 1) {
      const sourceRound = roundAt(data, number);
      if (!panoramaForRound(sourceRound)) continue;
      if (playerGuess(data, sourceRound, number, wantedProfileId)) return number;
    }

    // The API's round number is 1-based; roundAt performs the index conversion.
    return Math.min(announced, Math.max(rounds.length, 1));
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
    if (!value || typeof value !== "object") return false;
    if (value.isCurrentUser === true || value.isMe === true || value.me === true) return true;
    if (!wantedProfileId) return false;
    const candidates = [
      value.id,
      value.userId,
      value.playerId,
      value.profileId,
      value.accountId,
      value.user?.id,
      value.user?.userId,
      value.profile?.id,
      value.player?.id,
      value.player?.playerId,
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
      const collectionName = String(path[path.length - 1] || "").toLowerCase();
      if (
        inProfile
        && Array.isArray(value)
        && /(guesses|answers|roundresults|results)/.test(collectionName)
      ) {
        const indexed = coordinates(value[number - 1]);
        if (indexed) candidates.push({ result: indexed, depth: -100 });
      }
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
        visit(
          item,
          [...path, key],
          inProfile || String(key) === String(wantedProfileId),
          effectiveRound,
          depth + 1,
        );
      }
    };
    visit(data, [], false, null, 0);
    candidates.sort((left, right) => left.depth - right.depth);
    return candidates[0]?.result || null;
  }

  function latestGuessedRoundNumber(data, wantedProfileId = null) {
    const rounds = Array.isArray(data?.rounds) ? data.rounds : [];
    for (let number = rounds.length; number >= 1; number -= 1) {
      if (playerGuess(data, roundAt(data, number), number, wantedProfileId)) return number;
    }
    return 0;
  }

  function lifecycle(data, wantedProfileId = null) {
    const announcedRound = announcedRoundNumber(data);
    const guessedRound = latestGuessedRoundNumber(data, wantedProfileId);
    return {
      announcedRound,
      guessedRound,
      phase: guessedRound >= announcedRound ? "result" : "playing",
    };
  }

  function matchingGuess(data, number, target) {
    const wanted = coordinates(target);
    if (!wanted) return null;
    const matches = [];
    const seen = new Set();
    const visit = (value, path, inheritedRound, depth) => {
      if (!value || typeof value !== "object" || depth > 12 || seen.has(value)) return;
      seen.add(value);
      const pathText = path.join(".").toLowerCase();
      const itemRound = statedRound(value);
      const effectiveRound = itemRound ?? inheritedRound;
      const candidate = coordinates(value);
      if (
        candidate
        && /(guess|answer|result)/.test(pathText)
        && !/(question|panorama|correct)/.test(pathText)
        && (effectiveRound == null || effectiveRound === number)
      ) {
        const delta = Math.hypot(candidate.lat - wanted.lat, candidate.lng - wanted.lng);
        if (delta <= 0.001) matches.push({ candidate, delta });
      }
      const collectionName = String(path[path.length - 1] || "").toLowerCase();
      for (const [key, item] of Object.entries(value)) {
        const indexedRound = Array.isArray(value)
          && /(guesses|answers|roundresults|results)/.test(collectionName)
          && /^\d+$/.test(key)
          ? Number(key) + 1
          : effectiveRound;
        visit(item, [...path, key], indexedRound, depth + 1);
      }
    };
    visit(data, [], null, 0);
    matches.sort((left, right) => left.delta - right.delta);
    return matches[0]?.candidate || null;
  }

  function submittedGuess(body) {
    let value = body;
    if (value && typeof value.get === "function") {
      const rawLatitude = value.get("lat") ?? value.get("latitude");
      const rawLongitude = value.get("lng") ?? value.get("longitude") ?? value.get("lon");
      const latitude = Number(rawLatitude);
      const longitude = Number(rawLongitude);
      if (rawLatitude != null && rawLongitude != null
          && Number.isFinite(latitude) && Number.isFinite(longitude)) {
        return { lat: latitude, lng: longitude };
      }
    }
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch (_error) {
        const params = new URLSearchParams(value);
        const rawLatitude = params.get("lat") ?? params.get("latitude");
        const rawLongitude = params.get("lng") ?? params.get("longitude") ?? params.get("lon");
        const latitude = Number(rawLatitude);
        const longitude = Number(rawLongitude);
        return rawLatitude != null && rawLongitude != null
          && Number.isFinite(latitude) && Number.isFinite(longitude)
          ? { lat: latitude, lng: longitude }
          : null;
      }
    }
    const seen = new Set();
    const visit = (item, depth) => {
      if (!item || typeof item !== "object" || depth > 8 || seen.has(item)) return null;
      seen.add(item);
      const direct = coordinates(item);
      if (direct) return direct;
      for (const [key, child] of Object.entries(item)) {
        if (/(correct|answer|question|panorama)/i.test(key)) continue;
        const found = visit(child, depth + 1);
        if (found) return found;
      }
      return null;
    };
    return visit(value, 0);
  }

  function storedGuessRecord(challengeId, roundNumber, guess, submittedAt = Date.now()) {
    const normalizedGuess = coordinates(guess);
    const normalizedRound = Number(roundNumber);
    const normalizedTime = Number(submittedAt);
    if (!scalar(challengeId) || !Number.isInteger(normalizedRound) || normalizedRound < 1
        || !normalizedGuess || !Number.isFinite(normalizedTime)) return null;
    return {
      challengeId: String(challengeId),
      roundNumber: normalizedRound,
      guess: normalizedGuess,
      submittedAt: normalizedTime,
    };
  }

  function restoredGuess(recordValue, challengeId, roundNumber, options = {}) {
    let record = recordValue;
    if (typeof record === "string") {
      try {
        record = JSON.parse(record);
      } catch (_error) {
        return null;
      }
    }
    const wantedRound = Number(roundNumber);
    const now = Number(options.now ?? Date.now());
    const maxAgeMs = Number(options.maxAgeMs ?? 6 * 60 * 60 * 1000);
    const submittedAt = Number(record?.submittedAt);
    if (!record || String(record.challengeId || "") !== String(challengeId || "")
        || !Number.isInteger(wantedRound) || Number(record.roundNumber) !== wantedRound
        || !Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0
        || !Number.isFinite(submittedAt) || submittedAt > now
        || now - submittedAt > maxAgeMs) return null;
    return coordinates(record.guess);
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

  function normalizeRoundAt(data, challengeId, number, wantedProfileId = null) {
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

  function normalizeRound(data, challengeId, wantedProfileId = null) {
    return normalizeRoundAt(
      data,
      challengeId,
      completedRoundNumber(data, wantedProfileId),
      wantedProfileId,
    );
  }

  function normalizeActiveRound(data, challengeId) {
    return normalizeRoundAt(data, challengeId, announcedRoundNumber(data), null);
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

  function reviewMatchesRequest(review, reviewRoundKey, requestKey, panoId = "") {
    if (!review || !requestKey || reviewRoundKey !== requestKey) return false;
    const expectedPanoId = decodePanoId(panoId);
    const reviewPanoId = decodePanoId(review.location?.panoId);
    return !expectedPanoId || !reviewPanoId || expectedPanoId === reviewPanoId;
  }

  function outcomeCompletesRound(outcome, review, reviewRoundKey, requestKey, panoId = "") {
    return outcome?.status === "ready"
      && reviewMatchesRequest(review, reviewRoundKey, requestKey, panoId);
  }

  function resultMountStatus(rootNode) {
    const selector = RESULT_SELECTORS.join(",");
    if (typeof rootNode?.querySelectorAll !== "function") {
      const mounted = Boolean(rootNode?.querySelector?.(selector));
      return {
        mounted,
        candidates: mounted ? 1 : 0,
        connected: mounted ? 1 : 0,
        largestWidth: null,
        largestHeight: null,
      };
    }
    const elements = Array.from(rootNode.querySelectorAll(selector));
    let connected = 0;
    let mounted = false;
    let largestWidth = 0;
    let largestHeight = 0;
    for (const element of elements) {
      if (!element?.isConnected) continue;
      connected += 1;
      const rect = element.getBoundingClientRect?.();
      if (rect) {
        largestWidth = Math.max(largestWidth, Number(rect.width) || 0);
        largestHeight = Math.max(largestHeight, Number(rect.height) || 0);
      }
      if ((rect && rect.width > 80 && rect.height > 60)
          || element.getClientRects?.().length) mounted = true;
    }
    return { mounted, candidates: elements.length, connected, largestWidth, largestHeight };
  }

  function resultMounted(rootNode) {
    return resultMountStatus(rootNode).mounted;
  }

  const api = {
    LIVE_CHALLENGE_PATH,
    PARTY_LOBBY_PATH,
    RESULT_SELECTORS,
    pathnameFromUrl,
    challengeIdFromUrl,
    challengeIdForPage,
    isLiveChallengePage,
    decodePanoId,
    coordinates,
    mapKey,
    profileId,
    playerGuess,
    completedRoundNumber,
    latestGuessedRoundNumber,
    lifecycle,
    matchingGuess,
    submittedGuess,
    storedGuessRecord,
    restoredGuess,
    normalizeRound,
    normalizeActiveRound,
    buildEventState,
    reviewMatchesRequest,
    outcomeCompletesRound,
    resultMountStatus,
    resultMounted,
  };

  root.OMTLiveChallenge = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
