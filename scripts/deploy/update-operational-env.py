#!/usr/bin/env python3
"""Atomically upsert non-secret production resource/retention controls."""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import sys
import tempfile
from datetime import datetime, timezone


VALUES = {
    "WALLETSCANER_INGEST_IMAGE": "walletscaner-worker:pipeline-stability-r3-20260820",
    "WALLETSCANER_OPERATIONS_IMAGE": "walletscaner-worker:pipeline-stability-r4-20260820",
    "WALLETSCANER_SIGNAL_IMAGE": "walletscaner-worker:pipeline-stability-r2-20260820",
    "WALLETSCANER_RESEARCH_IMAGE": "walletscaner-worker:pipeline-stability-r4-20260820",
    "DEXSCREENER_SAMPLE_CONCURRENCY": "2",
    "RPC_TRADE_MAX_ACTIVE_POOLS": "3",
    "RPC_TRADE_TRANSACTION_FETCH_MAX_ATTEMPTS": "6",
    "RPC_TRADE_TRANSACTION_FETCH_RETRY_DELAY_MS": "1000",
    "RPC_TRADE_TRANSACTION_FETCH_RETRY_MAX_DELAY_MS": "8000",
    "RPC_TRADE_MAX_CONCURRENT_TRANSACTION_FETCHES": "128",
    "RPC_TRADE_MAX_QUEUED_SIGNATURES": "2000",
    "RPC_TRADE_QUEUE_PRESSURE_RATIO": "0.8",
    "SOLANA_SEEN_SIGNATURE_LIMIT": "25000",
    "KNOWN_POOL_CACHE_MAX_ENTRIES": "25000",
    "KNOWN_POOL_RETENTION_HOURS": "168",
    "ACTIVE_POOL_MAX_ENTRIES": "1000",
    "POOL_SAMPLING_MAX_POOLS_PER_CYCLE": "120",
    "POOL_STATE_PERSIST_INTERVAL_SECONDS": "300",
    "TOKEN_RISK_CACHE_MAX_ENTRIES": "5000",
    "PRICE_OBSERVATION_RETENTION_DAYS": "2",
    "CHAIN_EVENT_RETENTION_DAYS": "3",
    "SWAP_RETENTION_DAYS": "3",
    "CHAIN_EVENT_RAW_PAYLOAD_RETENTION_HOURS": "48",
    "CHAIN_EVENT_PAYLOAD_PARTITION_FUTURE_DAYS": "8",
    "WALLET_ALPHA_SCORE_RETENTION_DAYS": "7",
    "WALLET_EVIDENCE_RETENTION_DAYS": "95",
    "REJECTED_WALLET_EVIDENCE_RETENTION_DAYS": "3",
    "MAINTENANCE_DELETE_BATCH_SIZE": "5000",
    "MAINTENANCE_INBOX_DELETE_BATCH_SIZE": "500",
    "MAINTENANCE_COMPACT_BATCH_SIZE": "500",
    "MAINTENANCE_MAX_BATCHES_PER_RUN": "50",
    "MAINTENANCE_MAX_RUN_SECONDS": "30",
    "MAINTENANCE_STATEMENT_TIMEOUT_MS": "5000",
    "MAINTENANCE_INVENTORY_STATEMENT_TIMEOUT_MS": "15000",
    "MAINTENANCE_INTERVAL_SECONDS": "1800",
    "MAINTENANCE_NODE_HEAP_MB": "32",
    "MAINTENANCE_DRY_RUN": "false",
    "INGESTION_DISK_PAUSE_PERCENT": "90",
    "INGESTION_DISK_RESUME_PERCENT": "85",
    "INGESTION_MINIMUM_FREE_BYTES": "4294967296",
    "OPERATIONS_MONITOR_INTERVAL_SECONDS": "300",
    "OPERATIONS_MONITOR_NODE_HEAP_MB": "32",
    "OPERATIONS_MAX_DISK_USED_PERCENT": "85",
    "OPERATIONS_CRITICAL_DISK_USED_PERCENT": "92",
    "OPERATIONS_MAX_DATABASE_BYTES": "12884901888",
    "OPERATIONS_STORAGE_RESERVE_BYTES": "8589934592",
    "OPERATIONS_MIN_STORAGE_RUNWAY_DAYS": "14",
    "OPERATIONS_MAX_PRICE_RETENTION_LAG_SECONDS": "3600",
    "OPERATIONS_MAX_CHAIN_PAYLOAD_COMPACTION_LAG_SECONDS": "3600",
    "OPERATIONS_MAX_SWAP_RETENTION_LAG_SECONDS": "3600",
    "POSTGRES_BACKUP_RETENTION_DAYS": "2",
    "POSTGRES_BACKUP_REQUIRE_OFFSITE_ACK": "true",
    "POSTGRES_BACKUP_MIN_FREE_BYTES": "2147483648",
    "EVIDENCE_SAMPLER_INTERVAL_SECONDS": "120",
    "EVIDENCE_SAMPLER_BUCKET_SECONDS": "120",
    "EVIDENCE_SAMPLER_MAX_ACTIVE_TOKENS": "500",
    "EVIDENCE_OUTCOME_WRITE_BATCH_SIZE": "200",
    "WALLET_ALPHA_INTERVAL_SECONDS": "300",
    "WALLET_ALPHA_MIN_TRADE_EVENTS": "6",
    "WALLET_ALPHA_MIN_ENTRIES": "3",
    "WALLET_ALPHA_WORK_BATCH_SIZE": "50",
    "WALLET_ALPHA_MAX_WORK_BATCHES": "2",
    "WALLET_ALPHA_WORK_LEASE_SECONDS": "300",
    "WALLET_ALPHA_PERSISTENCE_CONCURRENCY": "2",
    "WALLET_ALPHA_NODE_HEAP_MB": "112",
    "WALLET_ALPHA_MAX_TRADE_EVENTS_PER_WALLET": "10000",
    "WALLET_ALPHA_MAX_ENTRIES_PER_WALLET": "2000",
    "WALLET_ALPHA_MAX_OUTCOMES_PER_WALLET": "4000",
    "WALLET_ALPHA_OVERSIZED_RETRY_SECONDS": "86400",
    "WALLET_ALPHA_MAX_RUN_SECONDS": "240",
    "PAPER_STRATEGY_VERSION": "qualified-pool-paper-v3-strict-flow",
}


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: update-operational-env.py PATH")
    path = Path(sys.argv[1]).resolve(strict=True)
    original = path.read_text(encoding="utf-8").splitlines()
    seen: set[str] = set()
    updated: list[str] = []
    for line in original:
        key = line.split("=", 1)[0].strip() if "=" in line else ""
        if key in VALUES:
            updated.append(f"{key}={VALUES[key]}")
            seen.add(key)
        else:
            updated.append(line)
    if updated and updated[-1] != "":
        updated.append("")
    for key, value in VALUES.items():
        if key not in seen:
            updated.append(f"{key}={value}")
    updated.append("")

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = path.with_name(f"{path.name}.bak.{stamp}")
    shutil.copy2(path, backup)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write("\n".join(updated))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, path.stat().st_mode)
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)
    print(f"updated {len(VALUES)} operational keys; backup={backup.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
