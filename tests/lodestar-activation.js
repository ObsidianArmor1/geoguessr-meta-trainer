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
  baseUrl: "https://huggingface.co/datasets/riot1/lodestar-balanced-2m-neighbors-v2/resolve/362e0933a897fff88a54107c6aabf20d18aaa0f4",
  revision: "362e0933a897fff88a54107c6aabf20d18aaa0f4",
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
assert.equal(pkg.version, "2.2.0-beta.69");
assert.match(userscript, /^\/\/ @version\s+2\.2\.0-beta\.69$/m);
assert.match(userscript, /const USERSCRIPT_VERSION = "2\.2\.0-beta\.69";/);
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
    manifest: { ...verifiedManifest, generation: "5a1bbde08350cd12" },
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

  globalThis.LodestarPackV2 = {
    available: () => true,
    query: async () => ({ source: "public-pack", matches: [] }),
  };
  globalThis.LodestarPack.configurePrivateLayer({
    query: async () => ({ source: "private-pack", matches: [] }),
  });
  assert.equal((await globalThis.LodestarPack.query("private-id", 3)).source, "private-pack",
    "configured private layer is tried before public Pack V2");
  globalThis.LodestarPack.configurePrivateLayer({ query: async () => null });
  assert.equal((await globalThis.LodestarPack.query("public-id", 3)).source, "public-pack",
    "private miss falls through to public Pack V2");
  process.stdout.write("Lodestar 2M activation/default/disable/fallback tests passed\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
