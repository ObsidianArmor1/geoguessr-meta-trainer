#!/usr/bin/env python3
"""Repack fixed Pack V2 projections into browser-friendly geographic tiles.

The ordinary geographic index stores only identity and coordinates.  That is
enough to find the closest panorama, but not the most visually similar one in
an adaptive area around a player's guess.  This sidecar colocates each fixed
256-D int8 projection with its geography so the browser can score a whole
local candidate pool after fetching a few immutable tiles.

No embeddings are recomputed.  Codes are copied byte-for-byte from the
verified row-aligned projection support pack.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import json
import shutil
import struct
from collections import OrderedDict
from pathlib import Path

import numpy as np


FORMAT = "lodestar-geo-visual-pack"
VERSION = 1
TILE_HEADER = struct.Struct("<4sBHI")  # magic, version, dimensions, rows
RECORD_PREFIX = struct.Struct("<16siiHI")  # id, lat*1e6, lng*1e6, heading*100, corpus row


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def raw_pano_id(value: str) -> bytes:
    encoded = value.encode("ascii")
    raw = base64.urlsafe_b64decode(encoded + b"=" * (-len(encoded) % 4))
    if len(raw) != 16:
        raise ValueError(f"panorama id does not decode to 16 bytes: {value!r}")
    return raw


class HandlePool:
    def __init__(self, limit: int = 128):
        self.limit = limit
        self.handles: OrderedDict[Path, object] = OrderedDict()

    def get(self, path: Path):
        handle = self.handles.pop(path, None)
        if handle is None:
            path.parent.mkdir(parents=True, exist_ok=True)
            handle = path.open("ab")
        self.handles[path] = handle
        while len(self.handles) > self.limit:
            _old_path, old = self.handles.popitem(last=False)
            old.close()
        return handle

    def close(self) -> None:
        for handle in self.handles.values():
            handle.close()
        self.handles.clear()


def build(args: argparse.Namespace) -> dict:
    if args.out.exists():
        if not args.replace:
            raise FileExistsError(f"output exists (pass --replace): {args.out}")
        shutil.rmtree(args.out)
    args.out.mkdir(parents=True)
    raw_dir = args.out / ".raw"
    tile_dir = args.out / "geo-visual"
    raw_dir.mkdir()
    tile_dir.mkdir()

    support_manifest_path = args.support / "manifest.json"
    support_manifest = json.loads(support_manifest_path.read_text())
    projection = support_manifest["projection"]
    dimensions = int(projection["dimensions"])
    chunk_rows = int(projection["chunkRows"])
    if dimensions <= 0 or dimensions > 4096:
        raise ValueError(f"unsupported projection dimensions: {dimensions}")

    core = np.load(args.core, allow_pickle=False)
    pano_ids = np.asarray(core["pano_id"]).astype(str, copy=False)
    latitude = np.asarray(core["latitude"])
    longitude = np.asarray(core["longitude"])
    total_rows = len(pano_ids)
    rows = total_rows if args.rows is None else min(total_rows, args.rows)
    if int(support_manifest["rows"]) != total_rows:
        raise ValueError("core and projection support row counts differ")

    headings = np.frombuffer(
        gzip.decompress((args.support / "headings.bin.gz").read_bytes()), dtype="<u2",
    )
    if len(headings) != total_rows:
        raise ValueError("heading and core row counts differ")

    lat_cells = round(180 / args.cell_degrees)
    lng_cells = round(360 / args.cell_degrees)
    if not np.isclose(lat_cells * args.cell_degrees, 180) or not np.isclose(
        lng_cells * args.cell_degrees, 360
    ):
        raise ValueError("cell degrees must divide both 180 and 360")
    counts = np.zeros(lat_cells * lng_cells, dtype=np.uint32)
    pool = HandlePool(args.open_files)
    written = 0
    try:
        for chunk_index, record in enumerate(projection["chunks"]):
            start = int(record["start"])
            if start >= rows:
                break
            count = min(int(record["rows"]), rows - start)
            payload = gzip.decompress(
                (args.support / projection["directory"] / record["file"]).read_bytes()
            )
            code_bytes = int(record["rows"]) * dimensions
            codes = np.frombuffer(payload, dtype=np.int8, count=code_bytes).reshape(
                int(record["rows"]), dimensions
            )
            for local in range(count):
                row = start + local
                lat_cell = min(
                    lat_cells - 1,
                    max(0, int(np.floor((float(latitude[row]) + 90) / args.cell_degrees))),
                )
                lng_cell = int(np.floor((float(longitude[row]) + 180) / args.cell_degrees)) % lng_cells
                cell = lat_cell * lng_cells + lng_cell
                prefix = RECORD_PREFIX.pack(
                    raw_pano_id(pano_ids[row]),
                    int(round(float(latitude[row]) * 1_000_000)),
                    int(round(float(longitude[row]) * 1_000_000)),
                    int(headings[row]),
                    row,
                )
                pool.get(raw_dir / f"{lat_cell:03d}-{lng_cell:03d}.bin").write(
                    prefix + codes[local].tobytes()
                )
                counts[cell] += 1
                written += 1
            if chunk_index % 200 == 0 or written == rows:
                print(f"  grouped {written:,}/{rows:,}", flush=True)
    finally:
        pool.close()
    if written != rows:
        raise RuntimeError(f"wrote {written:,} rows, expected {rows:,}")

    inventory = []
    compressed_bytes = 0
    record_bytes = RECORD_PREFIX.size + dimensions
    for cell in np.flatnonzero(counts):
        lat_cell, lng_cell = divmod(int(cell), lng_cells)
        source = raw_dir / f"{lat_cell:03d}-{lng_cell:03d}.bin"
        raw = source.read_bytes()
        expected = int(counts[cell]) * record_bytes
        if len(raw) != expected:
            raise ValueError(f"cell {lat_cell},{lng_cell} has {len(raw)} bytes, expected {expected}")
        packed = gzip.compress(
            TILE_HEADER.pack(b"LGV1", VERSION, dimensions, int(counts[cell])) + raw,
            args.gzip_level,
        )
        target = tile_dir / f"{lat_cell:03d}" / f"{lng_cell:03d}.bin.gz"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(packed)
        compressed_bytes += len(packed)
        inventory.append({
            "latCell": lat_cell,
            "lngCell": lng_cell,
            "rows": int(counts[cell]),
            "file": str(target.relative_to(args.out)),
            "bytes": len(packed),
            "sha256": hashlib.sha256(packed).hexdigest(),
        })
    shutil.rmtree(raw_dir)

    occupancy = np.packbits(counts > 0, bitorder="little").tobytes()
    occupancy_path = args.out / "occupancy.bin.gz"
    occupancy_path.write_bytes(gzip.compress(occupancy, args.gzip_level))
    manifest = {
        "format": FORMAT,
        "version": VERSION,
        "corpus": args.corpus,
        "generation": args.generation,
        "corpusRows": rows,
        "projectionDimensions": dimensions,
        "projectionMethod": projection.get("method"),
        "projectionAccuracy": projection.get("accuracy"),
        "cellDegrees": args.cell_degrees,
        "latCells": lat_cells,
        "lngCells": lng_cells,
        "recordBytes": record_bytes,
        "recordLayout": "<16siiHI + projectionDimensions*i8; raw pano id / coordinates*1e6 / heading*100 / corpus row / normalized projection codes",
        "tileHeader": "<4sBHI magic LGV1 / version / projection dimensions / rows",
        "tilePattern": "geo-visual/{latCell}/{lngCell}.bin.gz",
        "occupiedCells": len(inventory),
        "occupancy": "occupancy.bin.gz",
        "occupancySha256": sha256(occupancy_path),
        "compressedBytes": compressed_bytes,
        "sourceSupportManifestSha256": sha256(support_manifest_path),
    }
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    (args.out / "inventory.json").write_text(json.dumps({
        "format": f"{FORMAT}-inventory", "version": VERSION, "tiles": inventory,
    }, indent=1) + "\n")
    print(
        f"{rows:,} rows in {len(inventory):,} cells; "
        f"{compressed_bytes / 2**20:.1f} MiB compressed",
        flush=True,
    )
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", type=Path, required=True)
    parser.add_argument("--support", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--corpus", default="lodestar-balanced-2m")
    parser.add_argument("--generation", required=True)
    parser.add_argument("--cell-degrees", type=float, default=1.0)
    parser.add_argument("--rows", type=int)
    parser.add_argument("--gzip-level", type=int, default=6)
    parser.add_argument("--open-files", type=int, default=128)
    parser.add_argument("--replace", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    build(parse_args())
