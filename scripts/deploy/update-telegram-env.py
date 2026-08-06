#!/usr/bin/env python3
"""Atomically update Walletscaner's Telegram settings from JSON on stdin."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


TOKEN_PATTERN = re.compile(r"^[0-9]{8,12}:[A-Za-z0-9_-]{30,}$")
CHAT_PATTERN = re.compile(r"^-?[0-9]+$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    return parser.parse_args()


def load_updates() -> dict[str, str]:
    payload = json.load(sys.stdin)
    token = str(payload.get("telegramBotToken", "")).strip()
    chat_id = str(payload.get("telegramChatId", "")).strip()
    if not TOKEN_PATTERN.fullmatch(token):
        raise ValueError("telegramBotToken has an invalid shape")
    if not CHAT_PATTERN.fullmatch(chat_id):
        raise ValueError("telegramChatId must be an integer")
    return {
        "TELEGRAM_BOT_TOKEN": token,
        "TELEGRAM_CHAT_ID": chat_id,
        "TELEGRAM_NOTIFIER_POLL_INTERVAL_MS": "30000",
        "TELEGRAM_STATUS_INTERVAL_MINUTES": "360",
        "TELEGRAM_POOL_MAX_AGE_MINUTES": "30",
        "TELEGRAM_INITIAL_LOOKBACK_MINUTES": "5",
        "TELEGRAM_NOTIFICATION_CLAIM_LIMIT": "1",
    }


def update_env(path: Path, updates: dict[str, str]) -> None:
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
    updates = load_updates()
    update_env(args.env_file, updates)
    print("telegram-config=updated|token-set=true|chat-set=true")


if __name__ == "__main__":
    main()
