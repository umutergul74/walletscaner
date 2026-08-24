#!/usr/bin/env python3
"""Atomically set the non-secret qualified-pool delivery mode with hash/pre-state guards."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import tempfile
from pathlib import Path


KEY = "QUALIFIED_POOL_DELIVERY_MODE"
ALLOWED_VALUES = {"notify", "shadow"}
ABSENT = "__ABSENT__"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def render(original: str, expected: str, replacement: str) -> str:
    if replacement not in ALLOWED_VALUES:
        raise ValueError(f"Unsupported replacement mode: {replacement}")
    newline = "\r\n" if "\r\n" in original else "\n"
    trailing = original.endswith(("\n", "\r"))
    lines = original.splitlines()
    positions = [index for index, line in enumerate(lines) if line.startswith(f"{KEY}=")]
    if len(positions) > 1:
        raise ValueError(f"Environment file contains duplicate {KEY} entries.")
    current = lines[positions[0]].split("=", 1)[1] if positions else ABSENT
    if current != expected:
        raise ValueError(f"Pre-state mismatch for {KEY}.")
    if positions:
        lines[positions[0]] = f"{KEY}={replacement}"
    else:
        lines.append(f"{KEY}={replacement}")
    rendered = newline.join(lines)
    if trailing or not original:
        rendered += newline
    return rendered


def atomic_replace(path: Path, rendered: str) -> None:
    temporary: Path | None = None
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
            temporary = Path(handle.name)
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, stat.S_IMODE(path.stat().st_mode))
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--expected", required=True, choices=[ABSENT, *sorted(ALLOWED_VALUES)])
    parser.add_argument("--set", dest="replacement", required=True, choices=sorted(ALLOWED_VALUES))
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    path = args.env_file.resolve(strict=True)
    original = path.read_text(encoding="utf-8")
    before_sha = digest(original)
    if before_sha != args.expected_sha256:
        raise ValueError("Environment file SHA-256 no longer matches the reviewed pre-state.")
    rendered = render(original, args.expected, args.replacement)
    result = {
        "type": "walletscaner-qualified-pool-mode",
        "mode": "apply" if args.apply else "dry-run",
        "beforeSha256": before_sha,
        "afterSha256": digest(rendered),
        "change": {"key": KEY, "from": args.expected, "to": args.replacement},
    }
    if args.apply:
        atomic_replace(path, rendered)
        if path.read_text(encoding="utf-8") != rendered:
            raise RuntimeError("Atomic environment update did not read back exactly.")
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
