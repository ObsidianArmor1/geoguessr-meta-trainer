# GeoGuessr Visual Meta Trainer

Browser-local post-round visual study. These maps have full precomputed packs:

- [Balanced World 50k](https://www.geoguessr.com/maps/6a7d99296a64847f955da936)
- [Balanced USA 50k](https://www.geoguessr.com/maps/6a7d9951e250d15ffed33065)

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [the userscript](https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/main/src/geoguessr-meta-trainer.user.js).
3. Press **Install**, then play a Street View map normally.

The review appears only after a round is over. `M` toggles the similarity map,
`G` toggles the guess comparison, and `V` opens the visual-comparison board.
The visible **Guess** and **Colors** controls persist their state between rounds.
The optional **Guess comparison** layer
draws the revealed location's visual matches as filled red points and the
visual neighborhood of the nearest stored panorama to the player's guess as
filled cobalt points. Shared locations use a single split red/cobalt point, and
the review reports their overlap.

The match set is now selected per round from the shape of its ranked visual
similarity curve. A boundary is shown only when the mean and median slope both
change persistently; otherwise the review explicitly labels the nearest
examples as diffuse instead of pretending that every panorama has a crisp
visual meta.

## How it runs

Balanced World and Balanced USA use their map-specific precomputed lookup
packs. On other maps, the browser downloads two compact vision encoders plus a
compressed Balanced World reference corpus, embeds the revealed panorama after
the round, and searches that corpus locally. The arbitrary-map path sends no
image or embedding to a query server. Assets are cached in IndexedDB and review
thumbnails are requested live by panorama ID.

The universal pilot publishes FP32 query graphs. Chrome and Edge on macOS use
WebGPU and are the recommended fast path. Browsers without ONNX Runtime WebGPU
support, including Firefox, use a tested single-thread WASM compatibility path;
it produces the same retrieval but currently takes roughly 12–14 seconds per
panorama on the development Mac instead of roughly 3 seconds. The equivalent
FP16 graphs are preserved as source artifacts, but current ONNX Runtime WebGPU
rejects their mixed `f32 * f16` shader path.

The World 50K corpus is a first pilot, not a claim of universal geographic
coverage. Its purpose is to make the existing similarity workflow usable on
unseen maps while the much larger, deliberately balanced reference corpus is
built and validated.

Optional private cloud queries are supported for arbitrary maps through the
exact C-RADIOv4-H World-50K pilot. In Tampermonkey, open the userscript menu and
choose **Configure C-RADIO cloud** to set, replace, clear, or check the joined
`wk-….ws-…` proxy token. The token stays in Tampermonkey storage and is sent
only as a bearer authorization header. Cloud requests are prefetched during
play and cached locally; known portable maps continue to use their local packs.

No companion app, Python server, account, LAN connection, or manual map
selection is required for local mode. Local learning state remains in the
browser; this release has no analytics service.

The earlier clustering-family interface and all of its data are preserved at
the [`family-meta-trainer-v1`](https://github.com/ObsidianArmor1/geoguessr-meta-trainer/tree/family-meta-trainer-v1)
tag for a future optional add-on. They are not part of the active post-round
interface or request path.
