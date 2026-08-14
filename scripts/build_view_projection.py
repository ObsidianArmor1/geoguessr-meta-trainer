#!/usr/bin/env python3
"""Build a compact, spatially chunked view representation for guess-local V tiles."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import struct
from pathlib import Path

import numpy as np


MAGIC = b"OMTVPR01"
VERSION = 1
PADDED_DIMENSIONS = 4096
DEFAULT_SEED = 8_132_026


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def unit_rows(array: np.ndarray) -> np.ndarray:
    return array / np.maximum(np.linalg.norm(array, axis=1, keepdims=True), 1e-8)


def morton_order(coordinates: np.ndarray) -> np.ndarray:
    minimum = coordinates.min(axis=0)
    span = np.maximum(coordinates.max(axis=0) - minimum, 1e-8)
    scaled = np.clip(np.rint((coordinates - minimum) / span * 65535), 0, 65535).astype(np.uint32)
    x = scaled[:, 1].copy()
    y = scaled[:, 0].copy()

    def spread(values: np.ndarray) -> np.ndarray:
        result = values.astype(np.uint64)
        result = (result | (result << 8)) & np.uint64(0x00FF00FF)
        result = (result | (result << 4)) & np.uint64(0x0F0F0F0F)
        result = (result | (result << 2)) & np.uint64(0x33333333)
        result = (result | (result << 1)) & np.uint64(0x55555555)
        return result

    code = spread(x) | (spread(y) << 1)
    return np.argsort(code, kind="stable").astype(np.int32)


def fast_hadamard(array: np.ndarray) -> np.ndarray:
    width = array.shape[1]
    step = 1
    while step < width:
        shaped = array.reshape(len(array), -1, step * 2)
        left = shaped[:, :, :step].copy()
        right = shaped[:, :, step:].copy()
        shaped[:, :, :step] = left + right
        shaped[:, :, step:] = left - right
        array = shaped.reshape(len(array), width)
        step *= 2
    return array


def build(manifest_path: Path, output: Path, dimensions: int, chunk_panoramas: int, seed: int) -> None:
    manifest = json.loads(manifest_path.read_text())
    root = manifest_path.parent
    review = json.loads((root / manifest["artifacts"]["review_index"]).read_text())
    artifacts = manifest["trainer_artifacts"]
    summary = np.load(root / artifacts["viewSummaryEmbeddings"], mmap_mode="r")
    spatial = np.load(root / artifacts["viewSpatialEmbeddings"], mmap_mode="r")
    coordinates = np.asarray([[row["a"], row["o"]] for row in review["panoramas"]], np.float32)
    order = morton_order(coordinates)
    rng = np.random.default_rng(seed)
    signs = rng.choice(np.asarray([-1.0, 1.0], np.float32), PADDED_DIMENSIONS)
    selected = np.sort(rng.choice(PADDED_DIMENSIONS, dimensions, replace=False)).astype(np.int32)
    output.mkdir(parents=True, exist_ok=True)
    chunks = []
    global_sum = np.zeros(dimensions, np.float64)
    global_views = 0
    for chunk_index, start in enumerate(range(0, len(order), chunk_panoramas)):
        map_indices = order[start : start + chunk_panoramas]
        rows = (map_indices[:, None] * 4 + np.arange(4)[None, :]).reshape(-1)
        semantic = unit_rows(np.asarray(summary[rows], np.float32))
        structure = unit_rows(np.asarray(spatial[rows], np.float32))
        combined = np.zeros((len(rows), PADDED_DIMENSIONS), np.float32)
        combined[:, : semantic.shape[1]] = semantic / np.sqrt(2.0)
        combined[:, semantic.shape[1] : semantic.shape[1] + structure.shape[1]] = structure / np.sqrt(2.0)
        combined *= signs
        projected = unit_rows(fast_hadamard(combined)[:, selected])
        quantized = np.clip(np.rint(projected * 127.0), -127, 127).astype(np.int8)
        global_sum += quantized.astype(np.float64).sum(axis=0) / 127.0
        global_views += len(quantized)
        filename = f"{chunk_index:05d}.bin.gz"
        path = output / filename
        header = struct.pack("<8sIIII", MAGIC, VERSION, len(map_indices), 4, dimensions)
        body = header + np.asarray(map_indices, dtype="<i4").tobytes() + quantized.tobytes()
        with path.open("wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6, mtime=0) as stream:
                stream.write(body)
        chunks.append({
            "file": filename,
            "panoramas": len(map_indices),
            "mapIndices": map_indices.tolist(),
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
        })
        print(f"[{chunk_index + 1}/{(len(order) + chunk_panoramas - 1) // chunk_panoramas}] {start}-{start + len(map_indices) - 1}", flush=True)
    payload = {
        "format": "geoguessr-portable-view-projection",
        "version": VERSION,
        "datasetKey": manifest["dataset_key"],
        "panoramas": len(order),
        "viewsPerPanorama": 4,
        "dimensions": dimensions,
        "chunkPanoramas": chunk_panoramas,
        "seed": seed,
        "method": "signed fast Hadamard projection, row normalization, signed int8",
        "globalMean": (global_sum / max(global_views, 1)).tolist(),
        "chunks": chunks,
    }
    (output / "manifest.json").write_text(json.dumps(payload, separators=(",", ":")))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--dimensions", type=int, default=256)
    parser.add_argument("--chunk-panoramas", type=int, default=512)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args()
    if args.dimensions < 32 or args.dimensions > PADDED_DIMENSIONS:
        raise SystemExit("--dimensions must be between 32 and 4096")
    output = args.manifest.resolve().parent / "trainer" / "portable-view-projection-v1"
    build(args.manifest.resolve(), output, args.dimensions, args.chunk_panoramas, args.seed)


if __name__ == "__main__":
    main()
