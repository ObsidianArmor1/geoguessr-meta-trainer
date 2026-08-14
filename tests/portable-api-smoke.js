#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const fs = require("fs/promises");
const path = require("path");
const PortableMetaApi = require("../src/portable-api.js");

async function main() {
  const dataRoot = path.resolve(process.argv[2] || path.join(__dirname, "..", "data"));
  const api = new PortableMetaApi({
    baseUrl: "https://portable.test",
    transport: async (url) => {
      const bytes = await fs.readFile(path.join(dataRoot, new URL(url).pathname.slice(1)));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  });
  const registry = await api.registry();
  assert.ok(registry.maps.length >= 1, "registry contains at least one map");
  for (const entry of registry.maps) {
    const map = await api.loadMap(entry.datasetKey);
    assert.equal(map.core.panoramas.length, entry.panoramas);
    if (map.manifest.neighborBoundary) {
      let detectedIndex = -1;
      let diffuseIndex = -1;
      for (let mapIndex = 0; mapIndex < entry.panoramas; mapIndex += 1) {
        const boundary = await api.boundaryRow(map, mapIndex);
        if (boundary.detected && detectedIndex < 0) detectedIndex = mapIndex;
        if (!boundary.detected && diffuseIndex < 0) diffuseIndex = mapIndex;
        if (detectedIndex >= 0 && diffuseIndex >= 0) break;
      }
      assert.ok(detectedIndex >= 0, "map contains a detected semantic boundary");
      assert.ok(diffuseIndex >= 0, "map contains an abstained semantic boundary");
      const detected = await api.request(
        `/api/neighborhood/${detectedIndex}?dataset=${encodeURIComponent(entry.datasetKey)}`,
      );
      const diffuse = await api.request(
        `/api/neighborhood/${diffuseIndex}?dataset=${encodeURIComponent(entry.datasetKey)}`,
      );
      assert.equal(detected.boundary.detected, true);
      assert.ok(detected.boundary.score >= 3);
      assert.equal(
        detected.posterior.displayPolicy,
        "sustained per-round similarity-curve change point",
      );
      assert.equal(diffuse.boundary.detected, false);
      assert.equal(
        diffuse.posterior.displayPolicy,
        "diffuse self-tuned nearest examples; no sustained change point",
      );
    }
    const indices = [0, Math.floor(entry.panoramas / 2), entry.panoramas - 1];
    for (const mapIndex of indices) {
      const row = map.core.panoramas[mapIndex];
      const review = await api.request(
        `/api/neighborhood?pano_id=${encodeURIComponent(row.p)}&map_key=${encodeURIComponent(entry.aliases.at(-1))}`,
      );
      assert.equal(review.matched, true);
      assert.equal(review.location.mapIndex, mapIndex);
      assert.equal("metas" in review, false, "active review path is similarity-only");
      assert.ok(review.visualNeighborhood.visualMatches.length >= 8);
      assert.ok(review.visualNeighborhood.visualMatches.length <= (
        map.manifest.neighborSummary?.counts?.maximum || 512
      ));
      if (map.manifest.neighborBoundary) {
        assert.equal(typeof review.visualNeighborhood.boundary.detected, "boolean");
        assert.ok(Number.isFinite(review.visualNeighborhood.boundary.score));
        assert.ok(review.visualNeighborhood.boundary.qualifyingRuns >= 0);
      }
      if (map.manifest.panoramaProjection) {
        assert.equal(review.visualNeighborhood.posterior.mapLocations, entry.panoramas - 1);
        assert.equal(review.visualNeighborhood.posterior.semanticMaximumFraction, null);
        assert.equal(review.visualNeighborhood.posterior.exactCoreWeight, 0.5);
        assert.equal(
          review.visualNeighborhood.posterior.displayPolicy,
          review.visualNeighborhood.boundary?.detected
            ? "sustained per-round similarity-curve change point"
            : "diffuse self-tuned nearest examples; no sustained change point",
        );
        assert.equal(review.visualNeighborhood.posterior.broadDistributionUsedForClick, true);
        assert.ok(review.visualNeighborhood.posterior.displayedMass > 0);
      }
      const recommendation = await api.request(
        `/api/neighborhood/${mapIndex}?dataset=${encodeURIComponent(entry.datasetKey)}`,
      );
      assert.ok(Number.isFinite(recommendation.weightedClick.expectedScore));
      if (map.manifest.visualBoards) {
        const board = await api.request(
          `/api/visual-board/${mapIndex}?dataset=${encodeURIComponent(entry.datasetKey)}&guess_lat=${row.a}&guess_lng=${row.o}`,
        );
        assert.equal(board.mapIndex, mapIndex);
        assert.ok(board.modes.length >= 1);
        if (map.manifest.viewProjection) {
          assert.ok(board.modes.every((mode) => mode.guessMatch));
          assert.ok(board.modes.every((mode) => mode.entries.length === 7));
          assert.ok(board.modes.every((mode) => mode.guessMatch.view.startsWith(
            "https://streetviewpixels-pa.googleapis.com/v1/thumbnail?",
          )));
        } else {
          assert.ok(board.modes.every((mode) => mode.entries.length === 8));
        }
      }
    }
    const guessRow = map.core.panoramas[Math.min(250, entry.panoramas - 1)];
    const comparison = await api.request(
      `/api/guess-neighborhood/0?dataset=${encodeURIComponent(entry.datasetKey)}`
      + `&guess_lat=${guessRow.a}&guess_lng=${guessRow.o}`,
    );
    assert.equal(comparison.datasetKey, entry.datasetKey);
    assert.equal(comparison.anchor.mapIndex, Math.min(250, entry.panoramas - 1));
    assert.ok(comparison.anchor.distanceFromGuessKm < 0.001);
    assert.ok(comparison.visualNeighborhood.visualMatches.length >= 8);
    assert.ok(comparison.overlap.sharedLocations >= 0);
    assert.ok(comparison.overlap.jaccard >= 0 && comparison.overlap.jaccard <= 1);
    const origin = map.core.panoramas[0];
    const identical = await api.request(
      `/api/guess-neighborhood/0?dataset=${encodeURIComponent(entry.datasetKey)}`
      + `&guess_lat=${origin.a}&guess_lng=${origin.o}`,
    );
    assert.equal(identical.anchor.mapIndex, 0);
    assert.equal(identical.overlap.jaccard, 1);
    assert.equal(identical.overlap.sharedLocations, identical.overlap.trueLocations);
  }
  process.stdout.write(`portable smoke passed for ${registry.maps.length} map(s)\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
