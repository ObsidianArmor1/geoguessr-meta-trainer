"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const repo = path.resolve(__dirname, "../..");
const v1Path = path.join(repo, "lodestar-neighbors");
const source = fs.readFileSync(path.join(__dirname, "../src/lodestar-pack-v2.js"), "utf8");
const userscript = fs.readFileSync(path.join(__dirname, "../src/geoguessr-meta-trainer.user.js"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
const expected = {
  baseUrl: "https://huggingface.co/datasets/riot1/lodestar-balanced-2m-neighbors-v2/resolve/cb2f79b29f1b6dbe6c7c1eb954fbc9556900da91",
  revision: "cb2f79b29f1b6dbe6c7c1eb954fbc9556900da91",
  generation: "b6f99168d869873c",
  corpus: "lodestar-balanced-2m",
  corpusRows: 1999685,
  neighborsPerPanorama: 300,
};

require("../src/lodestar-pack-v2.js");
const v2 = globalThis.LodestarPackV2;
assert.deepEqual(v2.defaultConfig(), {
  ...expected,
  cacheName: "lodestar-pack-v2-balanced-2m-b6f99168d869873c",
});
assert.equal(pkg.version, "2.2.0-beta.85");
assert.match(userscript, /^\/\/ @version\s+2\.2\.0-beta\.85$/m);
assert.match(userscript, /const USERSCRIPT_VERSION = "2\.2\.0-beta\.85";/);
assert.match(expected.baseUrl, /^https:\/\/huggingface\.co\/datasets\/riot1\/lodestar-balanced-2m-neighbors-v2\/resolve\/[a-f0-9]{40}$/,
  "default source is a public immutable Hugging Face revision");
assert.doesNotMatch(expected.baseUrl, /(?:hf_|wk-)[A-Za-z0-9_-]{20,}/,
  "public source URL has no credential-like token");
assert.doesNotMatch(`${source}\n${userscript}`, /(?:hf_|wk-)[A-Za-z0-9_-]{20,}/,
  "no credential-like token may be committed");

const verifiedManifest = {
  format: "lodestar-range-row-pack",
  version: 2,
  corpus: expected.corpus,
  generation: expected.generation,
  corpusRows: expected.corpusRows,
  neighborsPerPanorama: expected.neighborsPerPanorama,
};
v2.configure({ baseUrl: expected.baseUrl, manifest: verifiedManifest });
(async () => {
  assert.deepEqual(await v2.manifest(), verifiedManifest);

  v2.configure({
    baseUrl: expected.baseUrl,
    manifest: { ...verifiedManifest, corpusRows: 999693 },
  });
  await assert.rejects(v2.manifest(), /does not match verified 2M corpus/);
  v2.configure({
    baseUrl: expected.baseUrl,
    manifest: { ...verifiedManifest, generation: "stale-generation" },
  });
  await assert.rejects(v2.manifest(), /does not match verified 2M corpus/,
    "stale skewed-pack generation is rejected");
  v2.configure({
    baseUrl: expected.baseUrl,
    manifest: { ...verifiedManifest, corpus: "lodestar-2m" },
  });
  await assert.rejects(v2.manifest(), /does not match verified 2M corpus/,
    "stale skewed-pack corpus is rejected");
  v2.configure(null);
  assert.equal(v2.available(), false, "configure(null) deliberately disables V2");
  await assert.rejects(v2.manifest(), /not configured/);

  const manifest = JSON.parse(fs.readFileSync(path.join(v1Path, "manifest.json")));
  const directoryPacked = fs.readFileSync(path.join(v1Path, manifest.directory.file));
  const directory = zlib.gunzipSync(directoryPacked);
  const sourcePano = directory.subarray(0, manifest.rows * manifest.idBytes)
    .subarray(0, manifest.idBytes).toString("ascii");
  global.fetch = async (url) => {
    const text = String(url);
    let body;
    if (text.endsWith("/manifest.json")) body = Buffer.from(JSON.stringify(manifest));
    else if (text.endsWith("/directory.bin.gz")) body = directoryPacked;
    else if (text.endsWith("/headings.bin.gz")) {
      body = fs.readFileSync(path.join(v1Path, "headings.bin.gz"));
    } else {
      const match = text.match(/\/neighbors\/([^/]+)$/);
      assert.ok(match, `unexpected V1 request ${text}`);
      body = fs.readFileSync(path.join(v1Path, "neighbors", match[1]));
    }
    return new Response(body, { status: 200 });
  };
  globalThis.LodestarPackV2 = {
    available: () => true,
    query: async () => { throw new Error("simulated 2M failure"); },
  };
  require("../src/lodestar-pack.js");
  const fallback = await globalThis.LodestarPack.query(sourcePano, 3);
  assert.equal(fallback.source, "lodestar-static-pack");
  assert.equal(fallback.corpus, "lodestar-1m");
  assert.equal(fallback.corpusSize, 999693);
  assert.equal(fallback.matches.length, 3);

  await assert.rejects(
    globalThis.LodestarPack.query("not-in-either-pack", 3),
    /simulated 2M failure/,
    "a failed V2 lookup is not misclassified as an ordinary corpus miss when V1 has no row",
  );

  globalThis.LodestarPackV2 = {
    available: () => true,
    query: async () => ({ source: "public-pack", matches: [] }),
    nearest: async () => new Promise(() => {}),
  };
  void globalThis.LodestarPack.nearest(0, 0);
  const unblockedRound = await Promise.race([
    globalThis.LodestarPack.query("public-id", 3),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("round lookup queued behind guess-side warming")), 50,
    )),
  ]);
  assert.equal(unblockedRound.source, "public-pack",
    "a stalled guess-side warm must not block the authoritative round lookup");
  assert.equal((await globalThis.LodestarPack.query("public-id", 3)).source, "public-pack",
    "the active wrapper queries the public Pack V2 directly");
  assert.equal("configurePrivateLayer" in globalThis.LodestarPack, false,
    "the public pack wrapper exposes no local-layer injection hook");
  process.stdout.write("Lodestar 2M public activation/default/disable/fallback tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
