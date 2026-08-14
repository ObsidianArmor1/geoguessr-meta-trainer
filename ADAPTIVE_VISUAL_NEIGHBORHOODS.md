# Adaptive visual neighborhoods

The public trainer does not treat either rank 100 or a percentage of the map
as a semantic boundary. It now has two complementary visual layers.

## Exact core

The 3,840-dimensional C-RADIOv4-H panorama embeddings first retrieve 512 exact
visual candidates. A symmetric, self-tuning distance identifies the strongest
core:

```text
(2 - 2*cosine(i,j)) / sqrt(scale(i) * scale(j)) <= 1.10
```

`scale(i)` is panorama `i`'s distance to its 64th visual neighbor. The exact
core ranges from 8–273 locations on Balanced World and 8–285 on Balanced USA.
It remains the source for precise nearest-neighbor ranks and the V comparison.

## Uncapped map-wide posterior

Every panorama also has a 512-dimensional signed-int4 random projection of the
fused embedding. The complete index is roughly 10.2 MB for each 50k map. The
browser scores the revealed panorama against every other map location and
forms a softmax posterior at temperature 0.02.

The recommended click blends the exact core and the uncapped map-wide
posterior at equal weight. All non-query map locations therefore contribute;
there is no semantic maximum. The exact half protects the high-quality nearest
ranks from projection noise, while the broad half prevents generic looks from
becoming falsely precise.

The dot layer deliberately does **not** draw the posterior's weak long tail.
It shows only the exact adaptive core: 8–273 locations on Balanced World
(median 92) and 8–285 on Balanced USA (median 93). This keeps every visible
point useful as a concrete visual example while the much broader uncertainty
distribution still contributes to the recommended click.

The int4 projection retains approximately 84% and 81% of the original exact
Top-100 neighbors on World and USA. It does not replace the exact core; its job
is to model the broader visual range compactly. Coordinates are opened only
after visual scoring, when the posterior is aggregated into geographic cells
for the recommended click.

Dots are painted on one canvas and hover targets use a fixed reusable element
pool. The map-wide index is downloaded and cached during the round.
