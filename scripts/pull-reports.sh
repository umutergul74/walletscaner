#!/usr/bin/env bash
# ============================================================
#  pull-reports.sh — Sunucudan raporları lokale çeker
#  Kullanım:  bash scripts/pull-reports.sh
# ============================================================
set -euo pipefail

SERVER_USER="${DEPLOY_USER:-root}"
SERVER_HOST="${DEPLOY_HOST:-46.101.142.68}"
APP_DIR="/opt/walletscaner"

echo "▶ Sunucudan raporlar çekiliyor..."
mkdir -p reports

rsync -avz \
  "${SERVER_USER}@${SERVER_HOST}:${APP_DIR}/reports/" \
  ./reports/

echo ""
echo "✅ Raporlar çekildi. Bakmak için:"
echo "   cat reports/market-watch-latest.md"
echo "   cat reports/market-watch-latest.json | head -100"
