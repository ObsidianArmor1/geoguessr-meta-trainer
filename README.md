# GeoGuessr Visual Similarity Trainer

A post-round learning userscript that shows which panoramas in a global visual
reference corpus look most like the revealed location, where those references
occur, and how their suggested click compares with the player's guess.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open the [raw userscript](https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/main/src/geoguessr-meta-trainer.user.js).
3. Install it and play GeoGuessr normally.

The interface appears only after the round ends. Its visible controls expose
the same actions as the keyboard shortcuts, including the similarity map, guess
comparison, visual-comparison board, match count, colors, layout, and
four-direction Street View previews. Settings persist between rounds.

## Current retrieval architecture

The reference corpus is **Lodestar 2.0**: 1,999,685 validated, embedded Street
View panoramas represented by C-RADIOv4-H.

For a panorama already in Lodestar, the userscript performs no inference. It:

1. resolves the panorama through one small compressed hash-bucket index;
2. requests its self-contained roughly 8 KB row with an HTTP byte range;
3. reads that panorama's precomputed global top-300 visual matches; and
4. renders the cloud, strong core, suggested click, previews, and comparison
   board locally.

Hash indexes and geographic assets are cached in IndexedDB; recently decoded
rows are retained in bounded memory. Pack V1 remains a conservative automatic
fallback. The pack is independent of the GeoGuessr map: any map containing a
known panorama can use the same row.

For a panorama outside Lodestar, the static lookup returns no row. If the user
has configured the private Modal credential, the script sends the panorama ID,
spawn heading, and requested match count to the C-RADIO service. The service
embeds the four views and searches the same global corpus. Successful responses
are cached locally. There is no active browser-ONNX inference fallback.

Use Tampermonkey's **Configure C-RADIO cloud** command to set, replace, clear,
or inspect the joined `wk-….ws-…` proxy token. The credential stays in
Tampermonkey storage and is sent only in the request's authorization header.
Known Lodestar rows never consume Modal inference.

## Reliability and diagnostics

Tampermonkey's **Copy trainer diagnostics** command produces a non-sensitive
JSON report containing:

- userscript, browser, and capability versions;
- GeoGuessr event-framework and map-capture status;
- whether the panorama was present in Lodestar;
- Pack V2 manifest, IndexedDB, byte-range, and decode outcomes;
- Modal status without its credential;
- requested/decoded match counts, timing, and rendering-layer counts.
- round-ownership keys for the review, blue cloud, V board, and map overlays.

The same action appears beside any post-round error. **Retry** deliberately
retries a failed completed round; routine rerenders still never retry paid
Modal inference. If retrieval succeeded but the result map mounted late, the
trainer now paints automatically on that map's first idle event. The
Tampermonkey menu's **Retry current trainer round** can also request a redraw.

### Pack V2 migration

`src/lodestar-pack-v2.js` implements the range-addressable successor to the
global directory. A known pano fetches one small hash-bucket index and one
self-contained ~8 KB row range, so cold bytes and browser memory no longer grow
with the corpus. It also carries a lazy static geographic index for guess-side
comparison. The verified public default is the immutable Hugging Face dataset
[`riot1/lodestar-balanced-2m-neighbors-v2`](https://huggingface.co/datasets/riot1/lodestar-balanced-2m-neighbors-v2),
pinned to revision `cb2f79b29f1b6dbe6c7c1eb954fbc9556900da91` and manifest generation
`b6f99168d869873c`; it contains 1,999,685 rows with 300 neighbors per row.
`lodestar-pack.js` keeps V1 as an automatic rollback path, and
`LodestarPackV2.configure(null)` deliberately disables V2.

## What the review means

- Every displayed point is a visually similar reference panorama, not a claim
  that the round must be there.
- All requested matches can be shown, while only the strong similarity core
  steers the suggested click.
- The round and guess clouds are independently toggleable. Their overlap shows
  whether the two places share visual references.
- V-board base cells use heading-aware corpus views requested at the displayed
  cell's aspect ratio and the thumbnail endpoint's useful resolution ceiling.
  The comparison grid can be 3×3 or 4×4; the near-guess example keeps
  the second cell while the remaining cells show the strongest global matches.
  Every displayed view uses one maximum-size thumbnail, avoiding request-heavy
  stitched mosaics and passive native-renderer resource pressure.
  Shift + hover enlarges a cell. The compact board can stay road-facing while
  the shared Shift-enlargement setting shows four maximum-size thumbnails and
  upgrades each direction to cached native Street View tiles.
- The near-guess comparison considers every corpus view within 10 km. If that
  yields fewer than 160 views, it expands to the nearest 160, up to a 100 km
  cap. It chooses the view visually closest to the round—exact top-300
  similarity when available, otherwise a labeled projection estimate. Outside
  the cap, the comparison is shown as unavailable.
- Similarity between arbitrary known corpus rows uses a 256-dimensional
  projected estimate when neither row contains the other in its exact top-300.
  That estimate is labelled separately from exact neighbor-table similarity.

Regular single-player rounds and public/private-party Live Challenge result
screens share the same completed-round pipeline: static/Modal retrieval, round
and guess clouds, adaptive recommendation, hover and Shift previews, the visual
comparison board, saved controls/colors, outcome receipt, and diagnostics. A
Live Challenge-specific adapter supplies identity and result state only; it
does not maintain a reduced review UI. Live polling bypasses browser caches,
and every derived visual artifact is accepted or repainted only when its round
identity matches the current result. This prevents an old round from surviving
a missed `round_start`, a delayed lookup, or a replaced result-map subtree.
Result visibility follows rendered geometry rather than accessibility or
transition-ancestor flags, which GeoGuessr may apply to a result that remains
visibly on screen.

## Development

```sh
npm run check
npm run test:cradio
npm run test:lodestar
npm run test:lodestar-v2
npm run benchmark:lodestar-v2 -- ../lodestar-range-pack-v2 250
npm run test:live-challenge
npm run test:smoke
```

The version in `package.json`, the userscript metadata header, and the internal
`USERSCRIPT_VERSION` constant must move together.

The earlier clustering-family interface and its data are preserved at the
[`family-meta-trainer-v1`](https://github.com/ObsidianArmor1/geoguessr-meta-trainer/tree/family-meta-trainer-v1)
tag. It is not part of the active request or post-round interface.
