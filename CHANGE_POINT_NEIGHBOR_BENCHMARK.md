# Persistent similarity-curve boundaries

## Decision

Beta 11 exposes a coordinate-blind, per-round semantic-boundary test while
preserving an explicit abstention path. It does not replace the map-wide click
posterior and does not claim that every detected numerical boundary has an
obvious human name.

## Detector

1. Retrieve 512 C-RADIOv4-H fused panorama candidates.
2. Recompute all retrieved-pair cosine similarities in float32.
3. Convert cosine distance to symmetric self-tuned distance using each
   panorama's 64th-neighbor scale.
4. Sort and log the normalized distances.
5. At candidate ranks 16–288, compare the 12 gaps before the boundary with the
   12 gaps after it.
6. Require both `after mean / before mean >= 3` and
   `after median / before median >= 3`.
7. Use the strongest point in the first contiguous qualifying region. If no
   region qualifies, abstain and retain the prior self-tuned set as a diffuse
   teaching/click fallback.

The median condition is important: a single anomalous panorama cannot pass it.
No coordinates enter selection.

## Full-map result

| Measure | Balanced World | Balanced USA |
|---|---:|---:|
| Panoramas | 49,417 | 49,440 |
| Sustained boundary detected | 11,227 (22.72%) | 11,310 (22.88%) |
| Abstained | 38,190 | 38,130 |
| Median detected-set size | 184 | 186 |
| Median displayed size, including diffuse fallbacks | 101 | 103 |
| Displayed range | 8–288 | 8–288 |
| More than one qualifying region | 2,123 | 2,118 |

On detected rows, the new set has median Jaccard overlap of about 0.46 with the
old fixed-ratio core. It is usually broader: median distance from the revealed
panorama to a shown match is about 943 km versus 801 km on World, and 472 km
versus 439 km on USA. That is consistent with the detector finding a broader
visual category after a dense nearest shell, but it is not evidence by itself
that the category is more useful.

A visual audit sampled four size bands on each map. The audited sets remained
recognizably coherent across boreal roads, open agricultural roads, arid
landscapes, low-density southern US roads, and desert commercial corridors.
Examples just outside a boundary were often still broadly related, which is
why the UI reports a measured slope boundary rather than calling it ground
truth.

## Interpretation and remaining risk

This is a high-precision operational boundary, not a solved semantic ontology.
Its existence depends on the 12-neighbor measurement scale; smaller windows
are more willing to call local fluctuations and larger windows are more
conservative. The public release therefore:

- shows the measured score;
- calls detected sets `coherent visual matches` rather than named metas;
- calls abstained sets `diffuse nearest examples`;
- keeps the nine-image teaching board available on both kinds of round;
- leaves the broader map-wide posterior in the click recommendation.

The next rigorous refinement is a multi-scale agreement test, followed by
player feedback on whether detected boundaries make the V-board more
interpretable. Beta 11 keeps enough per-row metadata to make that refinement
without recomputing embeddings.
