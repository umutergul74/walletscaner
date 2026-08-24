#!/usr/bin/env python3
"""Atomically update Walletscaner's role-separated archive settings from JSON on stdin."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


# Backblaze application keys use the base64 alphabet and can contain `/` or
# `+`. Keep the accepted set deliberately narrower than arbitrary printable
# text so a credential can never inject a new .env line or a comment.
KEY_PATTERN = re.compile(r"^[A-Za-z0-9_+/=-]{8,128}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--activate", action="store_true")
    parser.add_argument(
        "--execute",
        action="store_true",
        help=(
            "Enable real archive transport. Requires --activate; retirement stays disabled "
            "unless --enable-retirement also passes its separate approval gate."
        ),
    )
    parser.add_argument(
        "--preserve-credentials",
        action="store_true",
        help="Update only non-secret archive policy values; leave credential lines untouched.",
    )
    parser.add_argument(
        "--enable-retirement",
        action="store_true",
        help=(
            "Persist the maintenance retirement runtime gate after the database future-canary "
            "policy has been approved. Requires real transport and the exact approval phrase."
        ),
    )
    parser.add_argument("--retirement-approval", default="")
    return parser.parse_args()


def load_updates(
    activate: bool,
    execute: bool,
    preserve_credentials: bool,
    enable_retirement: bool,
    retirement_approval: str,
) -> dict[str, str]:
    if execute and not activate:
        raise ValueError("--execute requires --activate")
    if enable_retirement and (not activate or not execute):
        raise ValueError("--enable-retirement requires --activate --execute")
    if enable_retirement and retirement_approval != "approve-future-only-chain-payload-retirement":
        raise ValueError("--enable-retirement requires the exact retirement approval phrase")
    credentials: dict[str, str] = {}
    if not preserve_credentials:
        payload = json.load(sys.stdin)
        credentials = {
            "ARCHIVE_WRITE_ACCESS_KEY_ID": str(payload.get("writeAccessKeyId", "")).strip(),
            "ARCHIVE_WRITE_SECRET_ACCESS_KEY": str(payload.get("writeSecretAccessKey", "")).strip(),
            "ARCHIVE_READ_ACCESS_KEY_ID": str(payload.get("readAccessKeyId", "")).strip(),
            "ARCHIVE_READ_SECRET_ACCESS_KEY": str(payload.get("readSecretAccessKey", "")).strip(),
        }
        for name, value in credentials.items():
            if not KEY_PATTERN.fullmatch(value):
                raise ValueError(f"{name} has an invalid shape")

    settings = {
        "ARCHIVE_ENABLED": "true" if activate else "false",
        "ARCHIVE_RETIREMENT_ENABLED": "true" if enable_retirement else "false",
        "ARCHIVE_PROVIDER": "s3-compatible",
        "ARCHIVE_ENDPOINT": "https://s3.eu-central-003.backblazeb2.com",
        "ARCHIVE_REGION": "eu-central-003",
        "ARCHIVE_BUCKET": "walletscaner",
        "ARCHIVE_PREFIX": "walletscanner-prod",
        "ARCHIVE_REQUEST_TIMEOUT_MS": "600000",
        "ARCHIVE_MAX_ATTEMPTS": "5",
        "ARCHIVE_DRY_RUN": "false" if execute else "true",
        "ARCHIVE_STAGING_DIR": "/app/archive-staging",
        "ARCHIVE_SETTLE_HOURS": "6",
        "ARCHIVE_LEASE_SECONDS": "1800",
        "ARCHIVE_RETRY_SECONDS": "300",
        "ARCHIVE_MAX_SEGMENTS_PER_RUN": "1",
        "ARCHIVE_MAX_RUN_SECONDS": "7200",
        "ARCHIVE_MIN_FREE_BYTES": "1073741824",
        "ARCHIVE_OBJECT_LOCK_MIN_REMAINING_DAYS": "7",
        "ARCHIVE_OBJECT_LOCK_EVIDENCE_MODE": "attested-default-policy",
        "ARCHIVE_OBJECT_LOCK_DEFAULT_MODE": "GOVERNANCE",
        "ARCHIVE_OBJECT_LOCK_DEFAULT_DAYS": "30",
        "ARCHIVE_ZSTD_COMMAND": "zstd",
        "ARCHIVE_WRITER_INTERVAL_SECONDS": "3600",
        "ARCHIVE_VERIFIER_INITIAL_DELAY_SECONDS": "300",
        "ARCHIVE_VERIFIER_INTERVAL_SECONDS": "900",
        "ARCHIVE_SCHEDULER_FAILURE_DELAY_SECONDS": "900",
    }
    return {**credentials, **settings}


def update_env(path: Path, updates: dict[str, str]) -> None:
    path = path.resolve(strict=True)
    original = path.read_text(encoding="utf-8")
    seen: set[str] = set()
    output: list[str] = []
    for line in original.splitlines():
        candidate = line.strip()
        if candidate and not candidate.startswith("#") and "=" in candidate:
            key = candidate.split("=", 1)[0].strip()
            if key in updates:
                if key not in seen:
                    output.append(f"{key}={updates[key]}")
                    seen.add(key)
                continue
        output.append(line)
    if output and output[-1] != "":
        output.append("")
    for key, value in updates.items():
        if key not in seen:
            output.append(f"{key}={value}")

    current_mode = stat.S_IMODE(path.stat().st_mode)
    temp_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n", dir=path.parent, delete=False
        ) as handle:
            temp_name = handle.name
            handle.write("\n".join(output) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_name, current_mode)
        os.replace(temp_name, path)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


def main() -> None:
    args = parse_args()
    update_env(
        args.env_file,
        load_updates(
            args.activate,
            args.execute,
            args.preserve_credentials,
            args.enable_retirement,
            args.retirement_approval,
        ),
    )
    print(
        "archive-config=updated|credentials-set="
        f"{'preserved' if args.preserve_credentials else 'true'}|"
        f"enabled={'true' if args.activate else 'false'}|"
        f"dry-run={'false' if args.execute else 'true'}|"
        f"retirement={'true' if args.enable_retirement else 'false'}"
    )


if __name__ == "__main__":
    main()
