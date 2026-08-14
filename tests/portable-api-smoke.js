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
    const indices = [0, Math.floor(entry.panoramas / 2), entry.panoramas - 1];
    for (const mapIndex of indices) {
      const row = map.core.panoramas[mapIndex];
      const review = await api.request(
        `/api/review?pano_id=${encodeURIComponent(row.p)}&map_key=${encodeURIComponent(entry.aliases.at(-1))}`,
      );
      assert.equal(review.matched, true);
      assert.equal(review.location.mapIndex, mapIndex);
      assert.equal(review.visualNeighborhood.visualMatches.length, 100);
      assert.ok(review.location.views.every((url) => url.startsWith(
        "https://streetviewpixels-pa.googleapis.com/v1/thumbnail?",
      )));
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
  }
  process.stdout.write(`portable smoke passed for ${registry.maps.length} map(s)\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
