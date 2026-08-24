#!/usr/bin/env python3
"""Atomically replace only the reviewed Solana-ingestion CPU ceiling."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import tempfile
from pathlib import Path


SERVICE_HEADER = "  solana-ingestion:"
OLD_LIMIT = '    cpus: "0.15"'
NEW_LIMIT = '    cpus: "0.20"'
NEXT_SERVICE = re.compile(r"^  [a-zA-Z0-9-]+:\s*$")


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def render_update(original: str, expected_sha256: str) -> tuple[str, dict[str, str]]:
    actual_sha256 = sha256_text(original)
    if actual_sha256 != expected_sha256.lower():
        raise ValueError(
            f"Compose pre-state SHA mismatch: expected {expected_sha256.lower()}, "
            f"found {actual_sha256}."
        )

    newline = "\r\n" if "\r\n" in original else "\n"
    had_trailing_newline = original.endswith(("\n", "\r"))
    lines = original.splitlines()
    headers = [index for index, line in enumerate(lines) if line == SERVICE_HEADER]
    if len(headers) != 1:
        raise ValueError("Expected exactly one solana-ingestion service block.")
    start = headers[0]
    end = next(
        (index for index in range(start + 1, len(lines)) if NEXT_SERVICE.match(lines[index])),
        len(lines),
    )
    block = lines[start:end]
    if block.count(OLD_LIMIT) != 1 or NEW_LIMIT in block:
        raise ValueError("Solana-ingestion CPU limit is not the exact reviewed 0.15 pre-state.")
    block[block.index(OLD_LIMIT)] = NEW_LIMIT
    lines[start:end] = block

    rendered = newline.join(lines)
    if had_trailing_newline:
        rendered += newline
    if rendered.count(NEW_LIMIT) < 1:
        raise RuntimeError("Rendered Compose file does not contain the intended CPU limit.")
    return rendered, {
        "beforeSha256": actual_sha256,
        "afterSha256": sha256_text(rendered),
        "from": "0.15",
        "to": "0.20",
    }


def atomic_replace(path: Path, rendered: str, original_mode: int) -> None:
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="",
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
    parser.add_argument("--compose-file", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    path = args.compose_file.resolve(strict=True)
    original = path.read_text(encoding="utf-8")
    rendered, change = render_update(original, args.expected_sha256)
    result = {
        "type": "walletscaner-ingestion-cpu-limit",
        "mode": "apply" if args.apply else "dry-run",
        "path": str(path),
        "change": change,
    }
    if args.apply:
        atomic_replace(path, rendered, path.stat().st_mode)
        if path.read_text(encoding="utf-8") != rendered:
            raise RuntimeError("Atomic Compose update did not read back exactly.")
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
