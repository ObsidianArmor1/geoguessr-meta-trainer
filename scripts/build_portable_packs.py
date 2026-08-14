#!/usr/bin/env python3
"""Compile trainer artifacts into static, browser-addressable map packs.

The portable packs intentionally exclude model embeddings and Street View image
bytes.  They retain the fixed-map lookup information needed after a round:
panorama identity and coordinates, discovered families, calibrated Top-100
neighbor indices/similarities, and the metadata required to reproduce review
ranking in the browser.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import struct
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


FORMAT = "geoguessr-portable-meta-pack"
VERSION = 1
NEIGHBOR_MAGIC = b"OMTNBR01"


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )


def write_gzip_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(
        payload, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    with path.open("wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6, mtime=0) as stream:
            stream.write(body)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def public_core(review: dict) -> dict:
    panoramas = []
    detector_members = [[] for _ in review["detectors"]]
    for map_index, row in enumerate(review["panoramas"]):
        panorama = {
            "p": row["p"],
            "a": row["a"],
            "o": row["o"],
            "h": row["h"],
            "d": row.get("d", []),
        }
        for key in ("q", "n", "w", "rp"):
            if key in row:
                panorama[key] = row[key]
        panoramas.append(panorama)
        for detector_index in row.get("d", []):
            detector_members[int(detector_index)].append(map_index)

    # Remove paths into the private development tree. Detector evidence is only
    # a compact list of panorama/view references and is safe and useful here.
    detectors = []
    for source in review["detectors"]:
        row = {
            key: value
            for key, value in source.items()
            if key not in {"mp", "cm"}
        }
        detectors.append(row)

    return {
        "format": FORMAT,
        "version": VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "counts": review["counts"],
        "reviewPolicy": review["reviewPolicy"],
        "detectors": detectors,
        "families": review.get("families", []),
        "members": detector_members,
        "panoramas": panoramas,
    }


def write_neighbor_chunks(
    destination: Path,
    indices: np.ndarray,
    similarities: np.ndarray,
    chunk_rows: int,
) -> list[dict]:
    destination.mkdir(parents=True, exist_ok=True)
    if indices.shape != similarities.shape or indices.ndim != 2:
        raise ValueError("neighbor arrays must be equal two-dimensional matrices")
    if indices.dtype != np.int32:
        indices = indices.astype(np.int32)
    if similarities.dtype != np.float16:
        similarities = similarities.astype(np.float16)

    rows, neighbors = indices.shape
    chunks = []
    for start in range(0, rows, chunk_rows):
        stop = min(rows, start + chunk_rows)
        filename = f"{start // chunk_rows:05d}.bin.gz"
        path = destination / filename
        header = struct.pack(
            "<8sIIII", NEIGHBOR_MAGIC, VERSION, start, stop - start, neighbors
        )
        body = b"".join(
            (
                header,
                np.asarray(indices[start:stop], dtype="<i4").tobytes(order="C"),
                np.asarray(similarities[start:stop], dtype="<f2").tobytes(order="C"),
            )
        )
        with path.open("wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6, mtime=0) as stream:
                stream.write(body)
        chunks.append(
            {
                "file": filename,
                "start": start,
                "rows": stop - start,
                "bytes": path.stat().st_size,
                "sha256": sha256(path),
            }
        )
    return chunks


def compile_map(manifest_path: Path, output_root: Path, chunk_rows: int) -> tuple[dict, list[str]]:
    source_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    dataset_key = source_manifest["dataset_key"]
    dataset_root = manifest_path.parent
    artifacts = source_manifest["artifacts"]
    trainer_artifacts = source_manifest.get("trainer_artifacts", {})

    review_path = dataset_root / artifacts["review_index"]
    neighbor_root = dataset_root / artifacts["nearest_neighbors"]
    if not neighbor_root.is_dir():
        neighbor_root = (dataset_root / trainer_artifacts["neighborRoot"]).resolve()
    review = json.loads(review_path.read_text(encoding="utf-8"))
    indices = np.load(neighbor_root / "neighbor_indices.i32.npy", mmap_mode="r")
    similarities = np.load(
        neighbor_root / "neighbor_similarities.f16.npy", mmap_mode="r"
    )
    calibration = json.loads(
        (neighbor_root / "neighbor_weight_calibration_v1.json").read_text()
    )
    neighbor_summary = json.loads((neighbor_root / "summary.json").read_text())

    if len(review["panoramas"]) != len(indices):
        raise ValueError(f"panorama/neighbor mismatch for {dataset_key}")

    destination = output_root / "maps" / dataset_key
    core_path = destination / "core.json.gz"
    write_gzip_json(core_path, public_core(review))
    chunks = write_neighbor_chunks(
        destination / "neighbors", indices, similarities, chunk_rows
    )
    manifest = {
        "format": FORMAT,
        "version": VERSION,
        "datasetKey": dataset_key,
        "displayName": source_manifest.get("display_name", dataset_key),
        "panoramas": len(review["panoramas"]),
        "neighborsPerPanorama": int(indices.shape[1]),
        "chunkRows": chunk_rows,
        "core": {
            "file": "core.json.gz",
            "bytes": core_path.stat().st_size,
            "sha256": sha256(core_path),
        },
        "neighborChunks": chunks,
        "neighborSummary": neighbor_summary,
        "neighborCalibration": calibration,
        "source": {
            "sha256": source_manifest.get("source", {}).get("sha256"),
            "locations": source_manifest.get("source", {}).get("locations"),
        },
        "aliases": [
            value
            for value in (dataset_key, source_manifest.get("geoguessr_map_id"))
            if value
        ],
    }
    boards_root = dataset_root / "trainer" / "portable-boards-v1"
    boards_manifest_path = boards_root / "manifest.json"
    if boards_manifest_path.is_file():
        boards_manifest = json.loads(boards_manifest_path.read_text())
        public_boards = destination / "boards"
        public_boards.mkdir(parents=True, exist_ok=True)
        chunks = []
        for source in sorted(boards_root.glob("*.json.gz")):
            target = public_boards / source.name
            shutil.copyfile(source, target)
            chunks.append(
                {
                    "file": source.name,
                    "bytes": target.stat().st_size,
                    "sha256": sha256(target),
                }
            )
        manifest["visualBoards"] = {
            "format": boards_manifest["format"],
            "version": boards_manifest["version"],
            "chunkRows": boards_manifest["chunkRows"],
            "chunks": chunks,
        }
    projection_root = dataset_root / "trainer" / "portable-view-projection-v1"
    projection_manifest_path = projection_root / "manifest.json"
    if projection_manifest_path.is_file():
        projection_manifest = json.loads(projection_manifest_path.read_text())
        public_projection = destination / "view-projection"
        public_projection.mkdir(parents=True, exist_ok=True)
        projection_chunks = []
        source_chunks = {
            row["file"]: row for row in projection_manifest["chunks"]
        }
        for source in sorted(projection_root.glob("*.bin.gz")):
            target = public_projection / source.name
            shutil.copyfile(source, target)
            projection_chunks.append(
                {
                    **{
                        key: value
                        for key, value in source_chunks[source.name].items()
                        if key not in {"bytes", "sha256"}
                    },
                    "file": source.name,
                    "bytes": target.stat().st_size,
                    "sha256": sha256(target),
                }
            )
        manifest["viewProjection"] = {
            key: projection_manifest[key]
            for key in (
                "format", "version", "panoramas", "viewsPerPanorama",
                "dimensions", "chunkPanoramas", "seed", "method", "globalMean",
            )
        }
        manifest["viewProjection"]["chunks"] = projection_chunks
    manifest_path_out = destination / "manifest.json"
    write_json(manifest_path_out, manifest)
    return {
        "datasetKey": dataset_key,
        "displayName": manifest["displayName"],
        "panoramas": manifest["panoramas"],
        "manifest": f"maps/{dataset_key}/manifest.json",
        "aliases": manifest["aliases"],
        "manifestSha256": sha256(manifest_path_out),
    }, [row["p"] for row in review["panoramas"]]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--chunk-rows", type=int, default=512)
    parser.add_argument("manifests", nargs="+", type=Path)
    args = parser.parse_args()
    if args.chunk_rows < 32:
        raise SystemExit("--chunk-rows must be at least 32")
    args.output.mkdir(parents=True, exist_ok=True)
    compiled = [
        compile_map(path.resolve(), args.output.resolve(), args.chunk_rows)
        for path in args.manifests
    ]
    entries = [entry for entry, _pano_ids in compiled]
    routes: dict[str, list[list[int]]] = {}
    for map_index, (_entry, pano_ids) in enumerate(compiled):
        for row_index, pano_id in enumerate(pano_ids):
            routes.setdefault(pano_id, []).append([map_index, row_index])
    routing_path = args.output / "routing.json.gz"
    write_gzip_json(routing_path, routes)
    write_json(
        args.output / "registry.json",
        {
            "format": "geoguessr-portable-meta-registry",
            "version": VERSION,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "maps": entries,
            "routing": {
                "file": "routing.json.gz",
                "bytes": routing_path.stat().st_size,
                "sha256": sha256(routing_path),
                "panoramaIds": len(routes),
            },
        },
    )
    print(json.dumps({"maps": entries}, indent=2))


if __name__ == "__main__":
    main()
