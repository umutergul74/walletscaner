#!/usr/bin/env python3
"""Atomically update only the bounded exact-pool observation capacity.

Dry-run is the default. The whole-file hash and exact current value are both
required so an interrupted or stale production rollout fails without touching
the environment file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import tempfile
from pathlib import Path


KEY = "RPC_TRADE_MAX_ACTIVE_POOLS"


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def bounded_capacity(raw: str, label: str) -> str:
    try:
        parsed = int(raw)
    except ValueError as error:
        raise ValueError(f"{label} must be an integer between 0 and 20.") from error
    if str(parsed) != raw or parsed < 0 or parsed > 20:
        raise ValueError(f"{label} must be an integer between 0 and 20.")
    return str(parsed)


def render(original: bytes, expected_current: str, replacement: str) -> bytes:
    text = original.decode("utf-8")
    newline = "\r\n" if "\r\n" in text else "\n"
    trailing = text.endswith(("\n", "\r"))
    lines = text.splitlines()
    positions = [index for index, line in enumerate(lines) if line.startswith(f"{KEY}=")]
    if len(positions) != 1:
        raise ValueError(f"Expected exactly one {KEY} entry; found {len(positions)}.")
    expected = bounded_capacity(expected_current, "expected current capacity")
    target = bounded_capacity(replacement, "replacement capacity")
    index = positions[0]
    current = lines[index].split("=", 1)[1]
    if current != expected:
        raise ValueError(f"Pre-state mismatch for {KEY}: expected {expected!r}, found {current!r}.")
    lines[index] = f"{KEY}={target}"
    rendered = newline.join(lines)
    if trailing:
        rendered += newline
    return rendered.encode("utf-8")


def atomic_replace(path: Path, rendered: bytes, original_mode: int) -> None:
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=f".{path.name}.", suffix=".tmp", dir=path.parent, delete=False
        ) as handle:
            temporary_path = Path(handle.name)
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_path, stat.S_IMODE(original_mode))
        os.replace(temporary_path, path)
        temporary_path = None
        if os.name == "posix":
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--expected-file-sha256", required=True)
    parser.add_argument("--expected-current", required=True)
    parser.add_argument("--set", dest="replacement", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    path = args.env_file.resolve(strict=True)
    original = path.read_bytes()
    before_hash = sha256_bytes(original)
    if before_hash != args.expected_file_sha256.lower():
        raise ValueError(
            f"Environment hash mismatch: expected {args.expected_file_sha256.lower()}, "
            f"found {before_hash}."
        )
    rendered = render(original, args.expected_current, args.replacement)
    result = {
        "type": "walletscaner-trade-observation-capacity-env",
        "mode": "apply" if args.apply else "dry-run",
        "path": str(path),
        "beforeSha256": before_hash,
        "afterSha256": sha256_bytes(rendered),
        "change": {"key": KEY, "from": args.expected_current, "to": args.replacement},
    }
    if args.apply:
        atomic_replace(path, rendered, path.stat().st_mode)
        if path.read_bytes() != rendered:
            raise RuntimeError("Atomic environment update did not read back exactly.")
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
