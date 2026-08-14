#!/usr/bin/env python3
"""Precompute the exact view-level comparison boards used by the local trainer."""

from __future__ import annotations

import argparse
import gzip
import json
import multiprocessing as mp
import os
import sys
import types
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "geoguessr-meta-trainer"))
sys.path.insert(0, str(ROOT))

from server import ReviewData, haversine_distances_km  # noqa: E402
from meta_foundry.neighbor_posterior import calibrated_neighbor_weights  # noqa: E402


_REVIEW: ReviewData | None = None


def _fast_neighborhood(
    self: ReviewData, map_index: int, include_weighted_click: bool = False
) -> dict:
    """Board-only neighborhood without the O(N) locality-statistics pass."""
    del include_weighted_click
    indices = np.asarray(self.ambiguity_neighbor_indices[map_index], np.int32)
    similarities = np.asarray(
        self.ambiguity_neighbor_similarities[map_index], np.float32
    )
    coordinates = self.coordinates[indices]
    _weights, details = calibrated_neighbor_weights(
        similarities, self.xy[indices], self.neighbor_calibration
    )
    group_ids = details.pop("groupIds")
    normalized = details.pop("normalizedWeights")
    distances = haversine_distances_km(
        coordinates,
        float(self.coordinates[map_index, 0]),
        float(self.coordinates[map_index, 1]),
    )
    weakest = float(similarities[-1])
    span = max(float(similarities[0]) - weakest, 1e-8)
    matches = []
    for position, (neighbor, similarity, coordinate, distance) in enumerate(
        zip(indices, similarities, coordinates, distances, strict=True)
    ):
        matches.append(
            {
                "mapIndex": int(neighbor),
                "panoId": self.panoramas[int(neighbor)]["p"],
                "rank": position + 1,
                "latitude": float(coordinate[0]),
                "longitude": float(coordinate[1]),
                "similarity": float(similarity),
                "relativeStrength": float((similarity - weakest) / span),
                "posteriorWeight": float(normalized[position]),
                "geographicGroup": int(group_ids[position]),
                "distanceKm": float(distance),
            }
        )
    return {"visualMatches": matches}


def _initialize(manifest_path: str) -> None:
    global _REVIEW
    os.environ.setdefault("OMP_NUM_THREADS", "1")
    os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
    os.environ.setdefault("MKL_NUM_THREADS", "1")
    manifest = Path(manifest_path)
    payload = json.loads(manifest.read_text())
    review_path = manifest.parent / payload["artifacts"]["review_index"]
    _REVIEW = ReviewData(review_path, None, manifest)
    _REVIEW.visual_neighborhood = types.MethodType(_fast_neighborhood, _REVIEW)


def _compact(board: dict) -> dict:
    return {
        "d": board["defaultMode"],
        "m": [
            {
                "i": mode["id"],
                "l": mode["label"],
                "c": mode["currentSlot"],
                "s": mode["support"],
                "w": mode["weightedSupport"],
                "h": mode["coherence"],
                "a": mode["alignment"],
                "r": mode["reciprocalSupport"],
                "g": mode["independentAreas"],
                "e": [
                    [
                        entry["mapIndex"],
                        entry["rank"],
                        entry["slot"],
                        entry["viewSimilarity"],
                        int(entry["reciprocal"]),
                    ]
                    for entry in mode["entries"]
                ],
            }
            for mode in board["modes"]
        ],
    }


def _build_chunk(task: tuple[int, int]) -> tuple[int, list[dict]]:
    assert _REVIEW is not None
    start, stop = task
    return start, [_compact(_REVIEW.visual_board(index)) for index in range(start, stop)]


def _write_chunk(path: Path, rows: list[dict]) -> None:
    body = json.dumps(rows, separators=(",", ":")).encode()
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6, mtime=0) as stream:
            stream.write(body)
    temporary.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--workers", type=int, default=max(1, min(6, os.cpu_count() or 1)))
    parser.add_argument("--chunk-rows", type=int, default=256)
    args = parser.parse_args()
    manifest = args.manifest.resolve()
    payload = json.loads(manifest.read_text())
    count = int(payload["counts"]["panoramas"])
    output = manifest.parent / "trainer" / "portable-boards-v1"
    output.mkdir(parents=True, exist_ok=True)
    tasks = []
    for start in range(0, count, args.chunk_rows):
        path = output / f"{start // args.chunk_rows:05d}.json.gz"
        if not path.is_file():
            tasks.append((start, min(count, start + args.chunk_rows)))
    context = mp.get_context("spawn")
    if tasks:
        with context.Pool(
            args.workers, initializer=_initialize, initargs=(str(manifest),)
        ) as pool:
            for completed, (start, rows) in enumerate(
                pool.imap_unordered(_build_chunk, tasks), 1
            ):
                _write_chunk(output / f"{start // args.chunk_rows:05d}.json.gz", rows)
                print(f"[{completed}/{len(tasks)}] rows {start}-{start + len(rows) - 1}", flush=True)
    files = sorted(output.glob("*.json.gz"))
    manifest_out = {
        "format": "geoguessr-portable-visual-boards",
        "version": 1,
        "datasetKey": payload["dataset_key"],
        "panoramas": count,
        "chunkRows": args.chunk_rows,
        "chunks": [
            {"file": path.name, "bytes": path.stat().st_size}
            for path in files
        ],
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest_out, separators=(",", ":")), encoding="utf-8"
    )
    print(json.dumps(manifest_out, indent=2))


if __name__ == "__main__":
    main()
