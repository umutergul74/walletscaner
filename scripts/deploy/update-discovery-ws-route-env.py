#!/usr/bin/env python3
"""Atomically activate one reviewed Walletscaner discovery WebSocket split.

The updater is interruption-safe and idempotent. It refuses an unexpected
ingestion image or conflicting route instead of rewriting unrelated env state.
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
from urllib.parse import urlparse


IMAGE_KEY = "WALLETSCANER_INGEST_IMAGE"
URL_KEY = "SOLANA_DISCOVERY_WS_SECONDARY_URL"
PROGRAMS_KEY = "SOLANA_DISCOVERY_WS_SECONDARY_PROGRAMS_JSON"
MANAGED_KEYS = {IMAGE_KEY, URL_KEY, PROGRAMS_KEY}
ENV_LINE = re.compile(r"^([A-Z][A-Z0-9_]*)=(.*)$")


def render_update(
    original: str,
    expected_image: str,
    image: str,
    secondary_url: str,
    secondary_programs: list[str],
    expected_secondary_url: str | None = None,
    expected_secondary_programs: list[str] | None = None,
) -> tuple[str, list[dict[str, str | None]]]:
    programs = secondary_programs
    if (
        not isinstance(programs, list)
        or not programs
        or any(not isinstance(value, str) or not value.strip() for value in programs)
        or len(set(programs)) != len(programs)
    ):
        raise ValueError("Secondary programs must be a non-empty unique JSON string array.")
    normalized_programs = json.dumps(programs, separators=(",", ":"))
    parsed_url = urlparse(secondary_url)
    if parsed_url.scheme != "wss" or not parsed_url.hostname:
        raise ValueError("Secondary discovery endpoint must be an absolute wss:// URL.")
    if (expected_secondary_url is None) != (expected_secondary_programs is None):
        raise ValueError("Expected secondary URL and programs must be provided together.")
    if expected_secondary_programs is not None:
        if (
            not expected_secondary_programs
            or any(not value.strip() for value in expected_secondary_programs)
            or len(set(expected_secondary_programs)) != len(expected_secondary_programs)
        ):
            raise ValueError("Expected secondary programs must be a non-empty unique list.")
        expected_parsed_url = urlparse(expected_secondary_url or "")
        if expected_parsed_url.scheme != "wss" or not expected_parsed_url.hostname:
            raise ValueError("Expected secondary endpoint must be an absolute wss:// URL.")

    newline = "\r\n" if "\r\n" in original else "\n"
    had_trailing_newline = original.endswith(("\n", "\r"))
    lines = original.splitlines()
    positions: dict[str, int] = {}
    current: dict[str, str] = {}
    for index, line in enumerate(lines):
        match = ENV_LINE.match(line)
        if not match or match.group(1) not in MANAGED_KEYS:
            continue
        key = match.group(1)
        if key in positions:
            raise ValueError(f"Environment file contains duplicate {key} entries.")
        positions[key] = index
        current[key] = match.group(2)

    current_image = current.get(IMAGE_KEY)
    if current_image not in {expected_image, image}:
        raise ValueError(
            f"Unexpected {IMAGE_KEY}: expected {expected_image!r} or already-applied {image!r}."
        )
    intended = {
        IMAGE_KEY: image,
        URL_KEY: secondary_url,
        PROGRAMS_KEY: normalized_programs,
    }
    expected_route = {
        URL_KEY: expected_secondary_url,
        PROGRAMS_KEY: (
            json.dumps(expected_secondary_programs, separators=(",", ":"))
            if expected_secondary_programs is not None
            else None
        ),
    }
    for key in (URL_KEY, PROGRAMS_KEY):
        if key not in current or current[key] == intended[key]:
            continue
        if expected_route[key] is None or current[key] != expected_route[key]:
            raise ValueError(f"Conflicting pre-existing {key}; refusing to overwrite it.")

    changes: list[dict[str, str | None]] = []
    for key, value in intended.items():
        old_value = current.get(key)
        if old_value == value:
            continue
        changes.append({"key": key, "from": old_value, "to": value})
        if key in positions:
            lines[positions[key]] = f"{key}={value}"
        else:
            lines.append(f"{key}={value}")

    rendered = newline.join(lines)
    if had_trailing_newline or lines:
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--expected-image", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--secondary-url", required=True)
    parser.add_argument("--secondary-program", action="append", default=[])
    parser.add_argument("--expected-secondary-url")
    parser.add_argument("--expected-secondary-program", action="append")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    path = args.env_file.resolve(strict=True)
    original = path.read_text(encoding="utf-8")
    rendered, changes = render_update(
        original,
        args.expected_image,
        args.image,
        args.secondary_url,
        args.secondary_program,
        args.expected_secondary_url,
        args.expected_secondary_program,
    )
    if args.apply and changes:
        atomic_replace(path, rendered, path.stat().st_mode)
        if path.read_text(encoding="utf-8") != rendered:
            raise RuntimeError("Atomic environment update did not read back exactly.")

    print(
        json.dumps(
            {
                "type": "walletscaner-discovery-ws-route-env",
                "mode": "apply" if args.apply else "dry-run",
                "beforeSha256": hashlib.sha256(original.encode()).hexdigest(),
                "afterSha256": hashlib.sha256(rendered.encode()).hexdigest(),
                "changes": changes,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
