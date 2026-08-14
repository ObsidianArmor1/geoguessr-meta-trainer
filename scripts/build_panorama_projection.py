#!/usr/bin/env python3
"""Build a compact map-wide visual index for browser-side posterior scoring."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import struct
from pathlib import Path

import numpy as np


MAGIC = b"OMTPPJ01"
VERSION = 1
PADDED_DIMENSIONS = 4096
DEFAULT_SEED = 20_260_814


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fast_hadamard(array: np.ndarray) -> np.ndarray:
    step = 1
    while step < array.shape[1]:
        shaped = array.reshape(len(array), -1, step * 2)
        left = shaped[:, :, :step].copy()
        right = shaped[:, :, step:].copy()
        shaped[:, :, :step] = left + right
        shaped[:, :, step:] = left - right
        step *= 2
    return array


def build(
    manifest_path: Path,
    dimensions: int,
    quantization_scale: float,
    seed: int,
) -> None:
    manifest = json.loads(manifest_path.read_text())
    root = manifest_path.parent
    embedding_path = root / manifest["trainer_artifacts"]["fusedEmbeddings"]
    source = np.load(embedding_path, mmap_mode="r")
    if dimensions % 2:
        raise ValueError("projection dimensions must be even")
    rng = np.random.default_rng(seed)
    signs = rng.choice(np.asarray([-1.0, 1.0], np.float32), PADDED_DIMENSIONS)
    selected = np.sort(
        rng.choice(PADDED_DIMENSIONS, dimensions, replace=False)
    ).astype(np.int32)
    quantized = np.empty((len(source), dimensions), np.int8)
    for start in range(0, len(source), 1_024):
        stop = min(len(source), start + 1_024)
        padded = np.zeros((stop - start, PADDED_DIMENSIONS), np.float32)
        padded[:, : source.shape[1]] = np.asarray(source[start:stop], np.float32)
        padded *= signs
        projected = fast_hadamard(padded)[:, selected]
        projected /= np.maximum(
            np.linalg.norm(projected, axis=1, keepdims=True), 1e-8
        )
        quantized[start:stop] = np.clip(
            np.rint(projected * quantization_scale), -7, 7
        ).astype(np.int8)
        print(f"projected {stop:,}/{len(source):,}", flush=True)

    norms_squared = np.sum(
        quantized.astype(np.int32) ** 2, axis=1
    ).astype(np.uint16)
    codes = (quantized.astype(np.int16) + 7).astype(np.uint8)
    packed = codes[:, 0::2] | (codes[:, 1::2] << 4)
    output = root / "trainer" / "portable-panorama-projection-v1"
    output.mkdir(parents=True, exist_ok=True)
    path = output / "index.bin.gz"
    temporary = path.with_suffix(path.suffix + ".tmp")
    header = struct.pack(
        "<8sIIIf", MAGIC, VERSION, len(source), dimensions, quantization_scale
    )
    body = b"".join((
        header,
        np.asarray(norms_squared, dtype="<u2").tobytes(),
        packed.tobytes(),
    ))
    with temporary.open("wb") as raw:
        with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=6, mtime=0) as stream:
            stream.write(body)
    temporary.replace(path)
    payload = {
        "format": "geoguessr-portable-panorama-projection",
        "version": VERSION,
        "datasetKey": manifest["dataset_key"],
        "panoramas": int(len(source)),
        "sourceDimensions": int(source.shape[1]),
        "dimensions": dimensions,
        "seed": seed,
        "method": "signed fast Hadamard projection, row normalization, signed int4",
        "quantizationScale": quantization_scale,
        "posterior": {
            "method": "map-wide softmax over projected cosine similarity",
            "temperature": 0.02,
            "exactCoreWeight": 0.50,
            "displayMass": 0.90,
            "maximumDotFraction": 0.10,
            "semanticMaximumFraction": None,
        },
        "index": {
            "file": path.name,
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
        },
    }
    temporary_manifest = output / "manifest.json.tmp"
    temporary_manifest.write_text(json.dumps(payload, separators=(",", ":")))
    temporary_manifest.replace(output / "manifest.json")
    print(json.dumps(payload, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--dimensions", type=int, default=512)
    parser.add_argument("--quantization-scale", type=float, default=48.0)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args()
    if args.dimensions < 128 or args.dimensions > PADDED_DIMENSIONS:
        raise SystemExit("--dimensions must be between 128 and 4096")
    build(
        args.manifest.resolve(), args.dimensions,
        args.quantization_scale, args.seed,
    )


if __name__ == "__main__":
    main()
