# Adaptive visual neighborhoods

The public trainer no longer treats rank 100 as a semantic boundary. It first
retrieves 512 visual candidates from the coordinate-blind C-RADIOv4-H fused
panorama embeddings, then retains a variable number using symmetric,
self-tuning cosine distance:

```text
(2 - 2*cosine(i,j)) / sqrt(scale(i) * scale(j)) <= 1.10
```

`scale(i)` is panorama `i`'s distance to its 64th visual neighbor. Using both
endpoints' local scales prevents a dense, common appearance and a rare,
isolated appearance from sharing an arbitrary raw-similarity cutoff. Location
is not used during retrieval or selection. A minimum of eight neighbors keeps
the recommendation and comparison UI defined for the tiny fraction of rows
whose natural cutoff is smaller.

## Resulting size spectrum

| Map | Minimum | p10 | Median | p90 | Maximum | Above 100 |
|---|---:|---:|---:|---:|---:|---:|
| Balanced World 50k | 8 | 49 | 92 | 138 | 273 | 40.3% |
| Balanced USA 50k | 8 | 46 | 93 | 145 | 285 | 42.3% |

Only 77 World rows and 141 USA rows need the eight-neighbor operational floor.
The deeper HNSW retrieval audit measured 100.0% World recall and 99.95% USA
recall at the former rank-100 boundary; recall across all 512 candidates was
99.98% and 99.95%, respectively.

On a deterministic 1,200-panorama diagnostic sample per map, the adaptive
recommendation preserved the fixed-100 score level: 3,947 vs 3,963 average
points on World and 3,406 vs 3,402 on USA. This score check opens coordinates
only after visual selection; it does not alter neighborhood membership.

The portable `OMTNBR02` format stores row offsets plus flat neighbor and
similarity arrays, so the browser downloads only the chunk containing the
current panorama while supporting a different count for every row.
