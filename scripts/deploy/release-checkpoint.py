#!/usr/bin/env python3
"""Maintain an atomic, revision-checked, non-secret production rollout ledger."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


STATUSES = {"planned", "in_progress", "completed", "failed"}
SENSITIVE_KEY = re.compile(
    r"(?:secret|password|credential|private|token|webhook|access[_-]?key)", re.IGNORECASE
)
SAFE_NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,79}$")
MAX_HISTORY = 100


def parse_key_value(raw: str) -> tuple[str, str]:
    key, separator, value = raw.partition("=")
    if not separator or not key or not value:
        raise argparse.ArgumentTypeError("Evidence must be KEY=VALUE.")
    if not SAFE_NAME.fullmatch(key):
        raise argparse.ArgumentTypeError(f"Unsafe evidence key: {key!r}.")
    if SENSITIVE_KEY.search(key):
        raise argparse.ArgumentTypeError(f"Sensitive evidence key is forbidden: {key!r}.")
    if len(value) > 512:
        raise argparse.ArgumentTypeError(f"Evidence value is too long for {key!r}.")
    return key, value


def parse_evidence(values: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for raw in values:
        key, value = parse_key_value(raw)
        if key in result:
            raise ValueError(f"Duplicate evidence key: {key}.")
        result[key] = value
    return result


def load_ledger(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    parsed = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(parsed, dict) or parsed.get("schemaVersion") != 1:
        raise ValueError("Unsupported or malformed rollout ledger.")
    if not isinstance(parsed.get("revision"), int) or parsed["revision"] < 1:
        raise ValueError("Rollout ledger revision is invalid.")
    if not isinstance(parsed.get("current"), dict):
        raise ValueError("Rollout ledger current phase is invalid.")
    if not isinstance(parsed.get("history"), list):
        raise ValueError("Rollout ledger history is invalid.")
    return parsed


def validate_transition(
    previous: dict[str, Any] | None, phase: str, status: str
) -> None:
    if previous is None:
        if status not in {"planned", "in_progress"}:
            raise ValueError("A new ledger must begin planned or in_progress.")
        return

    current = previous["current"]
    previous_phase = current.get("phase")
    previous_status = current.get("status")
    if previous_status not in STATUSES:
        raise ValueError("Existing rollout status is invalid.")

    if phase != previous_phase:
        if previous_status not in {"completed", "failed"}:
            raise ValueError("Cannot begin a new phase before the current phase terminates.")
        if status not in {"planned", "in_progress"}:
            raise ValueError("A new phase must begin planned or in_progress.")
        return

    allowed = {
        "planned": {"in_progress", "failed"},
        "in_progress": {"completed", "failed"},
        "failed": {"in_progress"},
        "completed": set(),
    }
    if status not in allowed[previous_status]:
        raise ValueError(
            f"Invalid same-phase transition: {previous_status} -> {status}."
        )


def build_ledger(args: argparse.Namespace) -> tuple[dict[str, Any], str | None]:
    path = args.file.resolve()
    previous = load_ledger(path)
    previous_revision = 0 if previous is None else previous["revision"]
    if previous_revision != args.expected_revision:
        raise ValueError(
            f"Revision mismatch: expected {args.expected_revision}, found {previous_revision}."
        )
    if previous is not None and previous.get("release") != args.release:
        raise ValueError("Release identifier does not match the existing ledger.")
    if previous is None and not args.objective:
        raise ValueError("--objective is required for a new ledger.")

    validate_transition(previous, args.phase, args.status)
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    evidence = parse_evidence(args.evidence)
    objective = args.objective or previous["objective"]
    history = [] if previous is None else list(previous["history"])
    previous_current = None if previous is None else dict(previous["current"])
    if previous_current is not None:
        history.append(previous_current)
    history = history[-MAX_HISTORY:]

    ledger = {
        "schemaVersion": 1,
        "release": args.release,
        "revision": previous_revision + 1,
        "objective": objective,
        "updatedAt": now,
        "current": {
            "phase": args.phase,
            "status": args.status,
            "updatedAt": now,
            "nextAction": args.next_action,
            "rollbackRef": args.rollback_ref,
            "evidence": evidence,
        },
        "history": history,
    }
    before = None if previous is None else canonical_json(previous)
    return ledger, before


def canonical_json(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"


def sha256(value: str | None) -> str | None:
    if value is None:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def atomic_replace(path: Path, rendered: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    existing_mode = path.stat().st_mode if path.exists() else 0o600
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
            delete=False,
        ) as handle:
            temporary = Path(handle.name)
            handle.write(rendered)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, stat.S_IMODE(existing_mode))
        os.replace(temporary, path)
        temporary = None
        if os.name == "posix":
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--release", required=True)
    parser.add_argument("--phase", required=True)
    parser.add_argument("--status", required=True, choices=sorted(STATUSES))
    parser.add_argument("--expected-revision", required=True, type=int)
    parser.add_argument("--objective")
    parser.add_argument("--next-action", required=True)
    parser.add_argument("--rollback-ref", required=True)
    parser.add_argument("--evidence", action="append", default=[])
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    for label, value in (("release", args.release), ("phase", args.phase)):
        if not SAFE_NAME.fullmatch(value):
            raise ValueError(f"Unsafe {label}: {value!r}.")
    if args.expected_revision < 0:
        raise ValueError("Expected revision cannot be negative.")

    ledger, before = build_ledger(args)
    rendered = canonical_json(ledger)
    if args.apply:
        atomic_replace(args.file.resolve(), rendered)
        if args.file.resolve().read_text(encoding="utf-8") != rendered:
            raise RuntimeError("Atomic ledger update did not read back exactly.")

    print(
        json.dumps(
            {
                "type": "walletscaner-release-checkpoint",
                "mode": "apply" if args.apply else "dry-run",
                "release": args.release,
                "revision": ledger["revision"],
                "phase": args.phase,
                "status": args.status,
                "beforeSha256": sha256(before),
                "afterSha256": sha256(rendered),
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
