# Adaptive visual neighborhoods

The public trainer does not treat either rank 100 or a percentage of the map
as a semantic boundary. It now has two complementary visual layers.

## Per-round semantic boundary

The 3,840-dimensional C-RADIOv4-H panorama embeddings first retrieve 512 exact
visual candidates. Candidate similarities are recomputed in float32 before
boundary detection; float16 is adequate for transport but its small plateaus
can manufacture false derivatives. Distances are made locally comparable with:

```text
(2 - 2*cosine(i,j)) / sqrt(scale(i) * scale(j)) <= 1.10
```

`scale(i)` is panorama `i`'s distance to its 64th visual neighbor. For each
round, the 512 normalized distances are sorted and converted to log-distance.
At every possible boundary, the slope across the 12 preceding neighbors is
compared with the slope across the 12 following neighbors. A semantic boundary
exists only when **both** mean slope and median slope increase by at least 3×.
Requiring the median prevents one unusually distant panorama from creating a
boundary. The strongest point in the first contiguous qualifying region is
used.

This test deliberately abstains. It detects a sustained boundary on 11,227 of
49,417 Balanced World panoramas (22.72%) and 11,310 of 49,440 Balanced USA
panoramas (22.88%). Detected sets have median sizes of 184 and 186. When no
change point exists, the trainer labels the result as diffuse and retains the
older self-tuned nearest set for examples and click support; it does not call
that fallback a coherent semantic family.

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
On detected rounds it draws the per-round slope-bounded set. On abstained
rounds it draws the diffuse self-tuned fallback and says that no clear boundary
was found. Across both cases the displayed count is 8–288; medians are 101 on
Balanced World and 103 on Balanced USA. The much broader uncertainty
distribution still contributes to the recommended click.

The int4 projection retains approximately 84% and 81% of the original exact
Top-100 neighbors on World and USA. It does not replace the exact core; its job
is to model the broader visual range compactly. Coordinates are opened only
after visual scoring, when the posterior is aggregated into geographic cells
for the recommended click.

The V board is a teaching surface, not the semantic-boundary oracle. It can
still fill its comparison grid from the nearest examples even on an abstained
round. Dots are painted on one canvas and hover targets use a fixed reusable
element pool. The map-wide index is downloaded and cached during the round.
