#!/usr/bin/env bash
# ============================================================
#  server-status.sh — Sunucudaki servislerin durumunu gösterir
#  Kullanım:  bash scripts/server-status.sh
# ============================================================
set -euo pipefail

SERVER_USER="${DEPLOY_USER:-root}"
SERVER_HOST="${DEPLOY_HOST:-46.101.142.68}"
APP_DIR="/opt/walletscaner"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Sunucu Durum Kontrolü — ${SERVER_HOST}                 ║"
echo "╚══════════════════════════════════════════════════════════╝"

echo ""
echo "▶ Container Durumları:"
ssh "${SERVER_USER}@${SERVER_HOST}" "cd ${APP_DIR} && docker compose -f docker-compose.server.yml ps"

echo ""
echo "▶ Market Watch Son 30 Satır Log:"
ssh "${SERVER_USER}@${SERVER_HOST}" "cd ${APP_DIR} && docker compose -f docker-compose.server.yml logs --tail=30 market-watch"

echo ""
echo "▶ Disk Kullanımı:"
ssh "${SERVER_USER}@${SERVER_HOST}" "df -h / | tail -1"

echo ""
echo "▶ Market Watch Rapor Durumu:"
ssh "${SERVER_USER}@${SERVER_HOST}" "ls -lh ${APP_DIR}/reports/market-watch-*.json ${APP_DIR}/reports/market-watch-*.md 2>/dev/null || echo '  Henüz rapor yok'"

echo ""
echo "▶ State Dosyası Boyutu:"
ssh "${SERVER_USER}@${SERVER_HOST}" "ls -lh ${APP_DIR}/reports/market-watch-state.json 2>/dev/null || echo '  Henüz state yok'"
