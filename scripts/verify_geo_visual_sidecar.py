#!/usr/bin/env python3
"""Verify identity, coverage, metadata, and sampled projections in a geo sidecar."""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import struct
from pathlib import Path

import numpy as np


HEADER = struct.Struct("<4sBHI")
PREFIX = struct.Struct("<16siiHI")


def raw_pano_id(value: str) -> bytes:
    encoded = value.encode("ascii")
    return base64.urlsafe_b64decode(encoded + b"=" * (-len(encoded) % 4))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pack", type=Path, required=True)
    parser.add_argument("--core", type=Path, required=True)
    parser.add_argument("--support", type=Path, required=True)
    parser.add_argument("--sample", type=int, default=4096)
    args = parser.parse_args()

    manifest = json.loads((args.pack / "manifest.json").read_text())
    inventory = json.loads((args.pack / "inventory.json").read_text())["tiles"]
    core = np.load(args.core, allow_pickle=False)
    pano_ids = np.asarray(core["pano_id"]).astype(str, copy=False)
    latitudes = np.asarray(core["latitude"])
    longitudes = np.asarray(core["longitude"])
    rows = int(manifest["corpusRows"])
    dimensions = int(manifest["projectionDimensions"])
    if rows != len(pano_ids):
        raise ValueError("sidecar and core row counts differ")
    headings = np.frombuffer(
        gzip.decompress((args.support / "headings.bin.gz").read_bytes()), dtype="<u2",
    )
    seen = np.zeros(rows, dtype=np.bool_)
    rng = np.random.default_rng(20260826)
    sample_rows = set(int(value) for value in rng.choice(rows, min(rows, args.sample), False))
    sampled_codes: dict[int, bytes] = {}
    decoded = 0
    for number, tile in enumerate(inventory, 1):
        path = args.pack / tile["file"]
        packed = path.read_bytes()
        if hashlib.sha256(packed).hexdigest() != tile["sha256"]:
            raise ValueError(f"tile hash mismatch: {path}")
        raw = gzip.decompress(packed)
        magic, version, tile_dimensions, tile_rows = HEADER.unpack_from(raw)
        if (magic, version, tile_dimensions, tile_rows) != (
            b"LGV1", 1, dimensions, int(tile["rows"]),
        ):
            raise ValueError(f"tile header mismatch: {path}")
        if len(raw) != HEADER.size + tile_rows * int(manifest["recordBytes"]):
            raise ValueError(f"tile length mismatch: {path}")
        for local in range(tile_rows):
            offset = HEADER.size + local * int(manifest["recordBytes"])
            raw_id, lat, lng, heading, row = PREFIX.unpack_from(raw, offset)
            if row >= rows or seen[row]:
                raise ValueError(f"duplicate/out-of-range corpus row {row}")
            seen[row] = True
            if lat != round(float(latitudes[row]) * 1_000_000):
                raise ValueError(f"latitude mismatch at row {row}")
            if lng != round(float(longitudes[row]) * 1_000_000):
                raise ValueError(f"longitude mismatch at row {row}")
            if heading != int(headings[row]):
                raise ValueError(f"heading mismatch at row {row}")
            if row in sample_rows:
                if raw_id != raw_pano_id(str(pano_ids[row])):
                    raise ValueError(f"panorama identity mismatch at row {row}")
                sampled_codes[row] = raw[offset + PREFIX.size:offset + PREFIX.size + dimensions]
            decoded += 1
        if number % 1000 == 0:
            print(f"  verified {number:,}/{len(inventory):,} tiles", flush=True)
    if decoded != rows or not seen.all():
        raise ValueError(f"sidecar covers {decoded:,}/{rows:,} rows")

    support_manifest = json.loads((args.support / "manifest.json").read_text())
    projection = support_manifest["projection"]
    by_chunk: dict[int, list[int]] = {}
    for row in sample_rows:
        by_chunk.setdefault(row // int(projection["chunkRows"]), []).append(row)
    for chunk_index, wanted in by_chunk.items():
        record = projection["chunks"][chunk_index]
        raw = gzip.decompress(
            (args.support / projection["directory"] / record["file"]).read_bytes()
        )
        count = int(record["rows"])
        codes = np.frombuffer(raw, dtype=np.int8, count=count * dimensions).reshape(
            count, dimensions
        )
        start = int(record["start"])
        for row in wanted:
            if sampled_codes[row] != codes[row - start].tobytes():
                raise ValueError(f"projection code mismatch at row {row}")

    occupancy_path = args.pack / manifest["occupancy"]
    if hashlib.sha256(occupancy_path.read_bytes()).hexdigest() != manifest["occupancySha256"]:
        raise ValueError("occupancy hash mismatch")
    if sum(int(tile["bytes"]) for tile in inventory) != int(manifest["compressedBytes"]):
        raise ValueError("compressed byte inventory mismatch")
    print(
        f"verified {rows:,} unique rows, {len(inventory):,} tiles, "
        f"and {len(sampled_codes):,} byte-exact projections",
        flush=True,
    )


if __name__ == "__main__":
    main()
