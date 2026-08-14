# GeoGuessr Visual Meta Trainer

Post-round visual study for these custom maps:

- [Balanced World 50k](https://www.geoguessr.com/maps/6a7d99296a64847f955da936)
- [Balanced USA 50k](https://www.geoguessr.com/maps/6a7d9951e250d15ffed33065)

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [the userscript](https://raw.githubusercontent.com/ObsidianArmor1/geoguessr-meta-trainer/main/src/geoguessr-meta-trainer.user.js).
3. Press **Install**, then play either supported map normally.

The review appears only after a round is over. `M` toggles the similarity map
and `V` opens the visual-comparison board. The optional **Guess comparison** layer
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

The expensive vision work is precomputed. On first use, the browser downloads
the active map's compact lookup pack from this repository and caches it in
IndexedDB. It does not download the original model, the training images, or the
full model embeddings. Review thumbnails are requested live by panorama ID.

No companion app, Python server, account, API key, LAN connection, or manual
map selection is required. Local learning state remains in the browser; this
release has no analytics service.

The earlier clustering-family interface and all of its data are preserved at
the [`family-meta-trainer-v1`](https://github.com/ObsidianArmor1/geoguessr-meta-trainer/tree/family-meta-trainer-v1)
tag for a future optional add-on. They are not part of the active post-round
interface or request path.
