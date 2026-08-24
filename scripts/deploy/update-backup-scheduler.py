#!/usr/bin/env python3
"""Atomically install the bounded start-to-start PostgreSQL backup scheduler."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
from datetime import datetime, timezone


ANCHOR = '''        sleep "$${POSTGRES_BACKUP_INITIAL_DELAY_SECONDS:-86400}"
        while true; do
'''
REPLACEMENT = '''        sleep "$${POSTGRES_BACKUP_INITIAL_DELAY_SECONDS:-86400}"
        sleep_until_next_cycle() {
          interval="$${POSTGRES_BACKUP_INTERVAL_SECONDS:-86400}"
          now=$$(date +%s)
          elapsed=$$((now - cycle_started_at))
          remaining=$$((interval - elapsed))
          if [ "$${remaining}" -lt 60 ]; then
            remaining=60
          fi
          echo "backup scheduler: next cycle in $${remaining}s"
          sleep "$${remaining}"
        }
        while true; do
          cycle_started_at=$$(date +%s)
'''
OLD_SLEEP = '            sleep "$${POSTGRES_BACKUP_INTERVAL_SECONDS:-86400}"'
OLD_FINAL_SLEEP = '          sleep "$${POSTGRES_BACKUP_INTERVAL_SECONDS:-86400}"'


def update_content(original: str) -> str:
    if "sleep_until_next_cycle()" in original:
        return original
    if original.count(ANCHOR) != 1:
        raise ValueError("Expected exactly one PostgreSQL backup scheduler anchor")
    lines = original.splitlines()
    if lines.count(OLD_SLEEP) != 3:
        raise ValueError("Expected exactly three bounded backup skip sleeps")
    if lines.count(OLD_FINAL_SLEEP) != 1:
        raise ValueError("Expected exactly one final backup interval sleep")
    updated = original.replace(ANCHOR, REPLACEMENT, 1)
    updated = updated.replace(OLD_SLEEP, "            sleep_until_next_cycle")
    updated = updated.replace(OLD_FINAL_SLEEP, "          sleep_until_next_cycle", 1)
    return updated


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: update-backup-scheduler.py PATH")
    path = Path(sys.argv[1]).resolve(strict=True)
    if path != Path("/opt/walletscaner/docker-compose.server.yml"):
        raise SystemExit(f"Refusing unexpected Compose path: {path}")
    original = path.read_text(encoding="utf-8")
    updated = update_content(original)
    if updated == original:
        print("backup-scheduler=already-current")
        return 0

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = path.with_name(f"{path.name}.bak.backup-scheduler.{stamp}")
    shutil.copy2(path, backup)
    mode = stat.S_IMODE(path.stat().st_mode)
    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n", dir=path.parent, delete=False
        ) as handle:
            temporary_name = handle.name
            handle.write(updated)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, mode)
        os.replace(temporary_name, path)
    finally:
        if temporary_name and os.path.exists(temporary_name):
            os.unlink(temporary_name)
    print(f"backup-scheduler=updated|rollback={backup.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
