"""`SATB` binary container: JSON header + 16-byte aligned little-endian typed blobs.

Layout (see FORMAT.md):
    0  4 bytes  magic b"SATB"
    4  uint32   container version (1)
    8  uint32   header byte length H (padded with spaces so that 12 + H is a multiple of 16)
   12  H bytes  UTF-8 JSON header: {"kind": str, ..., "blobs": [{name, dtype, shape,
               offset, byteLength}]} with offsets counted from the start of the file
   ..  blobs, each starting at a multiple of 16
"""

import json
import struct

import numpy as np

MAGIC = b"SATB"
VERSION = 1
ALIGN = 16
DTYPES = {"float32": "<f4", "uint32": "<u4", "int32": "<i4", "uint16": "<u2", "uint8": "u1"}
KINDS = {
    ("f", 4): "float32",
    ("u", 4): "uint32",
    ("i", 4): "int32",
    ("u", 2): "uint16",
    ("u", 1): "uint8",
}


def _pad(n: int) -> int:
    return (-n) % ALIGN


def encode(kind: str, meta: dict, blobs: dict[str, np.ndarray]) -> bytes:
    arrays = []
    entries = []
    for name, array in blobs.items():
        dtype = KINDS.get((array.dtype.kind, array.dtype.itemsize))
        if dtype is None:
            raise ValueError(f"Unsupported dtype {array.dtype} for blob {name}")
        data = np.ascontiguousarray(array, dtype=DTYPES[dtype]).tobytes()
        arrays.append(data)
        entries.append(
            {"name": name, "dtype": dtype, "shape": list(array.shape), "byteLength": len(data)}
        )
    # Offsets depend on the header length, which depends on the offsets' digits: iterate.
    header_len = 0
    for _ in range(8):
        start = 12 + header_len
        start += _pad(start)
        offset = start
        for entry, data in zip(entries, arrays, strict=True):
            entry["offset"] = offset
            offset += len(data) + _pad(len(data))
        text = json.dumps({"kind": kind, **meta, "blobs": entries}, separators=(",", ":"))
        raw = text.encode()
        new_len = len(raw) + _pad(12 + len(raw))
        if new_len == header_len:
            break
        header_len = new_len
    else:  # pragma: no cover - converges in two passes
        raise RuntimeError("Header length did not converge")
    out = bytearray(MAGIC + struct.pack("<II", VERSION, header_len))
    out += raw + b" " * (header_len - len(raw))
    for entry, data in zip(entries, arrays, strict=True):
        if len(out) != entry["offset"]:
            raise RuntimeError("Blob offset mismatch")
        out += data + b"\0" * _pad(len(data))
    return bytes(out)


def decode(data: bytes) -> tuple[dict, dict[str, np.ndarray]]:
    if data[:4] != MAGIC:
        raise ValueError("Not a SATB container")
    version, header_len = struct.unpack_from("<II", data, 4)
    if version != VERSION:
        raise ValueError(f"Unsupported SATB version {version}")
    header = json.loads(data[12 : 12 + header_len].decode())
    blobs = {}
    for entry in header["blobs"]:
        count = int(np.prod(entry["shape"])) if entry["shape"] else 1
        blobs[entry["name"]] = np.frombuffer(
            data, dtype=DTYPES[entry["dtype"]], count=count, offset=entry["offset"]
        ).reshape(entry["shape"])
    return header, blobs
