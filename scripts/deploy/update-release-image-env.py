#!/usr/bin/env python3
"""Atomically update only reviewed Walletscaner release-image keys.

Dry-run is the default. Every changed key must provide its exact expected current
value, so retrying after an interruption either proves the intended pre-state or
fails without touching the environment file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import tempfile
from pathlib import Path


ALLOWED_KEYS = {
    "WALLETSCANER_INGEST_IMAGE",
    "WALLETSCANER_OPERATIONS_IMAGE",
    "WALLETSCANER_RESEARCH_IMAGE",
    "WALLETSCANER_SIGNAL_IMAGE",
}
ENV_LINE = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")


def parse_assignment(raw: str) -> tuple[str, str]:
    key, separator, value = raw.partition("=")
    if not separator or key not in ALLOWED_KEYS or not value:
        allowed = ", ".join(sorted(ALLOWED_KEYS))
        raise argparse.ArgumentTypeError(
            f"Expected an allowed non-empty KEY=VALUE assignment ({allowed})."
        )
    return key, value


def parse_assignments(values: list[str], label: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    for raw in values:
        key, value = parse_assignment(raw)
        if key in parsed:
            raise ValueError(f"Duplicate {label} assignment for {key}.")
        parsed[key] = value
    return parsed


def render_update(
    original: str, expected: dict[str, str], replacements: dict[str, str]
) -> tuple[str, list[dict[str, str]]]:
    if not replacements:
        raise ValueError("At least one --set assignment is required.")
    if set(expected) != set(replacements):
        raise ValueError("Every --set key must have exactly one matching --expected key.")

    newline = "\r\n" if "\r\n" in original else "\n"
    had_trailing_newline = original.endswith(("\n", "\r"))
    lines = original.splitlines()
    positions: dict[str, int] = {}
    current: dict[str, str] = {}

    for index, line in enumerate(lines):
        match = ENV_LINE.match(line)
        if not match or match.group(1) not in ALLOWED_KEYS:
            continue
        key = match.group(1)
        if key in positions:
            raise ValueError(f"Environment file contains duplicate {key} entries.")
        positions[key] = index
        current[key] = match.group(2)

    missing = sorted(set(replacements) - set(positions))
    if missing:
        raise ValueError(f"Environment file is missing required keys: {', '.join(missing)}.")

    changes: list[dict[str, str]] = []
    for key in sorted(replacements):
        if current[key] != expected[key]:
            raise ValueError(
                f"Pre-state mismatch for {key}: expected {expected[key]!r}, "
                f"found {current[key]!r}."
            )
        lines[positions[key]] = f"{key}={replacements[key]}"
        changes.append({"key": key, "from": current[key], "to": replacements[key]})

    rendered = newline.join(lines)
    if had_trailing_newline:
        rendered += newline
    return rendered, changes


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


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--expected", action="append", default=[])
    parser.add_argument("--set", dest="replacements", action="append", default=[])
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    path = args.env_file.resolve(strict=True)
    expected = parse_assignments(args.expected, "expected")
    replacements = parse_assignments(args.replacements, "replacement")
    original = path.read_text(encoding="utf-8")
    rendered, changes = render_update(original, expected, replacements)

    result = {
        "type": "walletscaner-release-image-env",
        "mode": "apply" if args.apply else "dry-run",
        "path": str(path),
        "beforeSha256": sha256_text(original),
        "afterSha256": sha256_text(rendered),
        "changes": changes,
    }
    if args.apply:
        atomic_replace(path, rendered, path.stat().st_mode)
        if path.read_text(encoding="utf-8") != rendered:
            raise RuntimeError("Atomic environment update did not read back exactly.")
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
