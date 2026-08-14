#!/usr/bin/env python3
"""Small deterministic tests for semantic slope-boundary abstention."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from neighbor_change_points import persistent_slope_change  # noqa: E402


def curve(gaps: np.ndarray) -> np.ndarray:
    return np.exp(np.r_[np.log(0.5), np.log(0.5) + np.cumsum(gaps)])


depth = 320
smooth_gaps = 0.004 / np.sqrt(np.arange(1, depth))
single_gap = smooth_gaps.copy()
single_gap[79] += 0.20
sustained = np.full(depth - 1, 0.001, np.float64)
sustained[80:96] = 0.0045
values = np.stack((curve(smooth_gaps), curve(single_gap), curve(sustained)))
result = persistent_slope_change(
    values,
    window=12,
    score_threshold=3.0,
    minimum_boundary=16,
    maximum_boundary=288,
)
assert result.detected.tolist() == [False, False, True]
assert 76 <= result.counts[2] <= 84
assert result.scores[2] >= 3.0
print("neighbor change-point tests passed")
