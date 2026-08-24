#!/usr/bin/env python3
"""Atomically apply the reviewed bounded RPC-trade latency profile."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import tempfile
from pathlib import Path


CHANGES = {
    "SOLANA_TRANSACTION_FETCH_DELAY_MS": ("1000", "0"),
    "RPC_TRADE_BACKFILL_PAGE_LIMIT": ("5", "500"),
    "RPC_TRADE_MAX_BACKFILL_PAGES": ("1", "4"),
}


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def render_update(original: bytes, expected_sha256: str) -> tuple[bytes, dict[str, object]]:
    actual_sha256 = sha256_bytes(original)
    if actual_sha256 != expected_sha256.lower():
        raise ValueError(
            f"Environment pre-state SHA mismatch: expected {expected_sha256.lower()}, "
            f"found {actual_sha256}."
        )

    text = original.decode("utf-8")
    newline = "\r\n" if "\r\n" in text else "\n"
    had_trailing_newline = text.endswith(("\n", "\r"))
    lines = text.splitlines()
    rendered_lines = list(lines)
    recorded_changes: list[dict[str, str]] = []

    for key, (before, after) in CHANGES.items():
        matches = [
            index
            for index, line in enumerate(lines)
            if line.split("=", 1)[0].strip() == key and "=" in line
        ]
        if len(matches) != 1:
            raise ValueError(f"Expected exactly one {key} assignment, found {len(matches)}.")
        index = matches[0]
        current = lines[index].split("=", 1)[1]
        if current != before:
            raise ValueError(f"{key} is not the exact reviewed pre-state {before!r}.")
        rendered_lines[index] = f"{key}={after}"
        recorded_changes.append({"key": key, "from": before, "to": after})

    rendered_text = newline.join(rendered_lines)
    if had_trailing_newline:
        rendered_text += newline
    rendered = rendered_text.encode("utf-8")
    return rendered, {
        "beforeSha256": actual_sha256,
        "afterSha256": sha256_bytes(rendered),
        "changes": recorded_changes,
    }


def atomic_replace(path: Path, rendered: bytes, original_mode: int) -> None:
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
            delete=False,
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
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    path = args.env_file.resolve(strict=True)
    original = path.read_bytes()
    rendered, change = render_update(original, args.expected_sha256)
    result = {
        "type": "walletscaner-ingestion-trade-latency",
        "mode": "apply" if args.apply else "dry-run",
        "path": str(path),
        "change": change,
    }
    if args.apply:
        atomic_replace(path, rendered, path.stat().st_mode)
        if path.read_bytes() != rendered:
            raise RuntimeError("Atomic environment update did not read back exactly.")
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
