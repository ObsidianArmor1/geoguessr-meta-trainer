#!/usr/bin/env python3
"""Turn a deep visual k-NN search into variable-size similarity neighborhoods.

The cutoff is deliberately coordinate blind.  It uses self-tuning distances:
each pairwise cosine distance is divided by the geometric mean of the two
panoramas' local visual scales.  Dense, common appearances can therefore keep
more matches while isolated appearances stop before an arbitrary fixed rank.
Coordinates are not read by this program.
"""

from __future__ import annotations

import argparse
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from neighbor_change_points import persistent_slope_change


def retrieve_candidates(
    embeddings_path: Path,
    output: Path,
    depth: int,
    workers: int,
) -> None:
    import faiss

    faiss.omp_set_num_threads(max(1, workers))
    values = np.load(embeddings_path, mmap_mode="r").astype(np.float32)
    faiss.normalize_L2(values)
    index = faiss.IndexHNSWFlat(
        values.shape[1], 32, faiss.METRIC_INNER_PRODUCT
    )
    index.hnsw.efConstruction = 200
    index.hnsw.efSearch = 768
    index.add(values)
    indices = np.empty((len(values), depth), np.int32)
    similarities = np.empty((len(values), depth), np.float32)
    for start in range(0, len(values), 1_024):
        stop = min(len(values), start + 1_024)
        scores, found = index.search(values[start:stop], depth + 16)
        for local, map_index in enumerate(range(start, stop)):
            keep = found[local] != map_index
            indices[map_index] = found[local, keep][:depth]
            similarities[map_index] = scores[local, keep][:depth]
        print(f"retrieved {stop:,}/{len(values):,}", flush=True)

    output.mkdir(parents=True, exist_ok=True)
    np.save(output / "candidate_indices.i32.npy", indices)
    np.save(output / "candidate_similarities.f16.npy", similarities.astype(np.float16))
    rng = np.random.default_rng(20260814)
    queries = np.sort(rng.choice(len(values), min(64, len(values)), replace=False))
    exact = faiss.IndexFlatIP(values.shape[1])
    exact.add(values)
    _scores, exact_found = exact.search(values[queries], depth + 1)
    recalls_100 = []
    recalls_depth = []
    for row, map_index in enumerate(queries):
        truth = exact_found[row][exact_found[row] != map_index][:depth]
        recalls_100.append(
            len(np.intersect1d(indices[map_index, :100], truth[:100])) / 100
        )
        recalls_depth.append(
            len(np.intersect1d(indices[map_index], truth)) / depth
        )
    audit = {
        "panoramas": int(len(values)),
        "dimensions": int(values.shape[1]),
        "candidateDepth": depth,
        "queries": int(len(queries)),
        "meanRecallAt100": float(np.mean(recalls_100)),
        "minimumRecallAt100": float(np.min(recalls_100)),
        "meanRecallAtDepth": float(np.mean(recalls_depth)),
        "minimumRecallAtDepth": float(np.min(recalls_depth)),
    }
    (output / "retrieval-audit.json").write_text(json.dumps(audit, indent=2) + "\n")


def recompute_candidate_similarities(
    embeddings_path: Path,
    candidate_indices: np.ndarray,
    output_path: Path,
    batch_rows: int,
) -> None:
    """Re-score retrieved pairs in float32 for reliable slope measurement."""

    embeddings = np.load(embeddings_path, mmap_mode="r")
    if len(embeddings) != len(candidate_indices):
        raise ValueError("embedding and candidate rows disagree")
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    values = np.lib.format.open_memmap(
        temporary,
        mode="w+",
        dtype=np.float32,
        shape=candidate_indices.shape,
    )
    for start in range(0, len(embeddings), batch_rows):
        stop = min(len(embeddings), start + batch_rows)
        query = np.asarray(embeddings[start:stop], np.float32)
        query /= np.maximum(np.linalg.norm(query, axis=1, keepdims=True), 1e-8)
        indices = np.asarray(candidate_indices[start:stop], np.int32)
        candidates = np.asarray(embeddings[indices], np.float32)
        candidates /= np.maximum(
            np.linalg.norm(candidates, axis=2, keepdims=True), 1e-8
        )
        values[start:stop] = np.einsum(
            "bd,bkd->bk", query, candidates, optimize=True
        )
        if stop % 1_024 < batch_rows or stop == len(embeddings):
            print(f"rescored {stop:,}/{len(embeddings):,}", flush=True)
    values.flush()
    del values
    temporary.replace(output_path)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--embeddings", type=Path)
    parser.add_argument("--calibration", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scale-rank", type=int, default=64)
    parser.add_argument("--distance-ratio", type=float, default=1.10)
    parser.add_argument("--minimum", type=int, default=8)
    parser.add_argument("--candidate-depth", type=int, default=512)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument(
        "--selection-method",
        choices=("fixed-ratio", "persistent-slope-change"),
        default="fixed-ratio",
    )
    parser.add_argument("--slope-window", type=int, default=12)
    parser.add_argument("--slope-score-threshold", type=float, default=3.0)
    parser.add_argument("--slope-minimum-boundary", type=int, default=16)
    parser.add_argument("--slope-maximum-boundary", type=int, default=288)
    parser.add_argument("--similarity-batch-rows", type=int, default=8)
    parser.add_argument("--recompute-float32-similarities", action="store_true")
    args = parser.parse_args()

    candidate_index_path = args.candidates / "candidate_indices.i32.npy"
    candidate_similarity_path = args.candidates / "candidate_similarities.f16.npy"
    if not candidate_index_path.is_file() or not candidate_similarity_path.is_file():
        if args.embeddings is None:
            raise SystemExit("candidate arrays are missing; pass --embeddings to retrieve them")
        retrieve_candidates(
            args.embeddings, args.candidates, args.candidate_depth, args.workers
        )

    candidate_indices = np.load(candidate_index_path, mmap_mode="r")
    float32_similarity_path = args.candidates / "candidate_similarities.f32.npy"
    if args.recompute_float32_similarities:
        if args.embeddings is None:
            raise SystemExit("--recompute-float32-similarities requires --embeddings")
        recompute_candidate_similarities(
            args.embeddings,
            candidate_indices,
            float32_similarity_path,
            args.similarity_batch_rows,
        )
    similarity_source = (
        float32_similarity_path
        if float32_similarity_path.is_file()
        else candidate_similarity_path
    )
    candidate_similarities = np.load(similarity_source, mmap_mode="r")
    if candidate_indices.shape != candidate_similarities.shape:
        raise ValueError("candidate index and similarity matrices disagree")
    if candidate_indices.ndim != 2:
        raise ValueError("candidate arrays must be two-dimensional")
    rows, candidates = candidate_indices.shape
    if not 1 <= args.scale_rank <= candidates:
        raise ValueError("--scale-rank is outside the candidate depth")
    if not 1 <= args.minimum <= candidates:
        raise ValueError("--minimum is outside the candidate depth")

    # Squared Euclidean distance between unit-normalized embeddings is
    # 2 - 2*cosine.  The source retrieval stores cosine similarities.
    similarities = np.asarray(candidate_similarities, np.float32)
    distances = np.maximum(2.0 - 2.0 * similarities, 1e-7)
    local_scale = distances[:, args.scale_rank - 1]
    normalized = distances / np.sqrt(
        local_scale[:, None] * local_scale[np.asarray(candidate_indices, np.int32)]
    )
    natural_ratio_counts = np.sum(
        normalized <= args.distance_ratio, axis=1
    ).astype(np.int32)
    ratio_counts = np.maximum(natural_ratio_counts, args.minimum).astype(np.int32)
    change_points = None
    if args.selection_method == "persistent-slope-change":
        if similarity_source.suffixes[-2:] != [".f32", ".npy"]:
            raise SystemExit(
                "persistent slope changes require candidate_similarities.f32.npy; "
                "pass --embeddings and --recompute-float32-similarities"
            )
        change_points = persistent_slope_change(
            normalized,
            window=args.slope_window,
            score_threshold=args.slope_score_threshold,
            minimum_boundary=args.slope_minimum_boundary,
            maximum_boundary=args.slope_maximum_boundary,
        )
        # Abstention is real: a no-step row uses the previous diffuse visual
        # neighborhood for display/clicking, but is explicitly marked below.
        counts = np.where(
            change_points.detected, change_points.counts, ratio_counts
        ).astype(np.int32)
    else:
        counts = ratio_counts
    offsets = np.empty(rows + 1, np.int64)
    offsets[0] = 0
    np.cumsum(counts, out=offsets[1:])
    flat_indices = np.empty(int(offsets[-1]), np.int32)
    flat_similarities = np.empty(int(offsets[-1]), np.float16)
    for row in range(rows):
        start, stop = int(offsets[row]), int(offsets[row + 1])
        count = stop - start
        if change_points is None or not change_points.detected[row]:
            selected = np.flatnonzero(normalized[row] <= args.distance_ratio)
            if len(selected) < args.minimum:
                selected = np.arange(args.minimum)
        else:
            selected = np.argsort(normalized[row])[:count]
        # Preserve the intuitive raw-similarity rank inside the selected set.
        selected = selected[
            np.argsort(-similarities[row, selected], kind="stable")
        ][:count]
        flat_indices[start:stop] = candidate_indices[row, selected]
        flat_similarities[start:stop] = candidate_similarities[row, selected]

    args.output.mkdir(parents=True, exist_ok=True)
    np.save(args.output / "neighbor_offsets.i64.npy", offsets)
    np.save(args.output / "neighbor_indices.i32.npy", flat_indices)
    np.save(args.output / "neighbor_similarities.f16.npy", flat_similarities)
    if change_points is not None:
        np.save(
            args.output / "neighbor_boundary_detected.u8.npy",
            change_points.detected.astype(np.uint8),
        )
        np.save(
            args.output / "neighbor_boundary_scores.f16.npy",
            change_points.scores.astype(np.float16),
        )
        np.save(
            args.output / "neighbor_boundary_runs.u8.npy",
            change_points.qualifying_runs,
        )
    shutil.copyfile(
        args.calibration,
        args.output / "neighbor_weight_calibration_v1.json",
    )
    quantiles = [0, 0.01, 0.10, 0.25, 0.50, 0.75, 0.90, 0.99, 1]
    summary = {
        "format": "adaptive-visual-neighborhood",
        "version": 2 if change_points is not None else 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "panoramas": int(rows),
        "coordinateBlind": True,
        "candidateDepth": int(candidates),
        "selection": {
            "method": args.selection_method,
            "distanceFormula": "(2-2*cosine(i,j))/sqrt(scale(i)*scale(j))",
            "localScaleRank": args.scale_rank,
            "distanceRatio": args.distance_ratio,
            "minimumOperationalNeighbors": args.minimum,
            "coordinatesUsed": False,
        },
        "counts": {
            "mean": float(np.mean(counts)),
            "median": float(np.median(counts)),
            "minimum": int(np.min(counts)),
            "maximum": int(np.max(counts)),
            "above100": int(np.sum(counts > 100)),
            "above100Fraction": float(np.mean(counts > 100)),
            "minimumFallbackRows": int(
                np.sum(natural_ratio_counts < args.minimum)
            ),
            "quantiles": {
                str(value): float(result)
                for value, result in zip(quantiles, np.quantile(counts, quantiles), strict=True)
            },
        },
        "artifacts": {
            "offsets": "neighbor_offsets.i64.npy",
            "neighbors": "neighbor_indices.i32.npy",
            "similarities": "neighbor_similarities.f16.npy",
            "calibration": "neighbor_weight_calibration_v1.json",
        },
    }
    if change_points is not None:
        detected_counts = change_points.counts[change_points.detected]
        summary["selection"].update({
            "slopeWindow": args.slope_window,
            "slopeScore": "min(afterMean/beforeMean, afterMedian/beforeMedian)",
            "slopeScoreThreshold": args.slope_score_threshold,
            "slopeMinimumBoundary": args.slope_minimum_boundary,
            "slopeMaximumBoundary": args.slope_maximum_boundary,
            "abstentionFallback": "fixed-ratio diffuse neighborhood",
            "similarityPrecision": "float32",
        })
        summary["changePoints"] = {
            "detectedRows": int(np.sum(change_points.detected)),
            "detectedFraction": float(np.mean(change_points.detected)),
            "abstainedRows": int(np.sum(~change_points.detected)),
            "multipleQualifyingRuns": int(
                np.sum(change_points.qualifying_runs > 1)
            ),
            "detectedCountMedian": (
                float(np.median(detected_counts)) if len(detected_counts) else None
            ),
        }
        summary["artifacts"].update({
            "boundaryDetected": "neighbor_boundary_detected.u8.npy",
            "boundaryScores": "neighbor_boundary_scores.f16.npy",
            "boundaryRuns": "neighbor_boundary_runs.u8.npy",
        })
    (args.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
