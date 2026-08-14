"""Coordinate-blind change points for ranked visual-neighbor curves."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class ChangePointResult:
    """One semantic boundary decision per query panorama."""

    counts: np.ndarray
    detected: np.ndarray
    scores: np.ndarray
    qualifying_runs: np.ndarray


def persistent_slope_change(
    normalized_distances: np.ndarray,
    *,
    window: int = 12,
    score_threshold: float = 3.0,
    minimum_boundary: int = 16,
    maximum_boundary: int = 288,
) -> ChangePointResult:
    """Find the first sustained acceleration in each sorted distance curve.

    A boundary is not created by one large adjacent gap.  At every candidate
    rank, both the *mean* and the *median* slope across the following ``window``
    neighbors must exceed their counterparts in the preceding window by
    ``score_threshold``.  The score is the weaker of those two ratios.

    The first contiguous qualifying region is used.  Its strongest point is
    returned, which avoids placing the boundary at the noisy first threshold
    crossing.  Rows with no qualifying region explicitly abstain.
    """

    values = np.asarray(normalized_distances, dtype=np.float32)
    if values.ndim != 2:
        raise ValueError("normalized_distances must be two-dimensional")
    if window < 3:
        raise ValueError("window must be at least 3")
    depth = values.shape[1]
    lower = max(int(minimum_boundary), window)
    upper = min(int(maximum_boundary), depth - window - 1)
    if upper <= lower:
        raise ValueError("candidate depth is too small for the requested windows")

    ordered = np.sort(values, axis=1)
    log_values = np.log(np.maximum(ordered, 1e-8))
    gaps = np.diff(log_values, axis=1)
    ranks = np.arange(lower, upper + 1, dtype=np.int32)

    cumulative = np.pad(
        np.cumsum(gaps, axis=1, dtype=np.float64),
        ((0, 0), (1, 0)),
    )
    before_mean = (cumulative[:, ranks] - cumulative[:, ranks - window]) / window
    after_mean = (cumulative[:, ranks + window] - cumulative[:, ranks]) / window

    # The median condition makes the detector insensitive to one unusually
    # large gap.  This loop is only over the small rank axis and keeps memory
    # bounded for 50k x 512 candidate matrices.
    before_median = np.empty_like(before_mean, dtype=np.float32)
    after_median = np.empty_like(after_mean, dtype=np.float32)
    for column, rank in enumerate(ranks):
        before_median[:, column] = np.median(
            gaps[:, rank - window:rank], axis=1
        )
        after_median[:, column] = np.median(
            gaps[:, rank:rank + window], axis=1
        )

    # Exact float32 similarities should make slopes positive.  The floor only
    # protects completely flat numerical plateaus and cannot manufacture a hit.
    epsilon = 1e-9
    mean_ratio = after_mean / np.maximum(before_mean, epsilon)
    median_ratio = after_median / np.maximum(before_median, epsilon)
    scores = np.minimum(mean_ratio, median_ratio)
    qualifies = scores >= score_threshold

    rows = values.shape[0]
    detected = np.any(qualifies, axis=1)
    counts = np.zeros(rows, dtype=np.int32)
    selected_scores = np.zeros(rows, dtype=np.float32)
    qualifying_runs = np.zeros(rows, dtype=np.uint8)
    for row in range(rows):
        hits = np.flatnonzero(qualifies[row])
        if not len(hits):
            continue
        qualifying_runs[row] = np.uint8(
            min(255, 1 + np.count_nonzero(np.diff(hits) > 1))
        )
        first_start = int(hits[0])
        first_stop = first_start + 1
        while first_stop < qualifies.shape[1] and qualifies[row, first_stop]:
            first_stop += 1
        local = first_start + int(
            np.argmax(scores[row, first_start:first_stop])
        )
        counts[row] = int(ranks[local])
        selected_scores[row] = float(scores[row, local])

    return ChangePointResult(
        counts=counts,
        detected=detected,
        scores=selected_scores,
        qualifying_runs=qualifying_runs,
    )
