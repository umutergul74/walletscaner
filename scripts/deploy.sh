#!/usr/bin/env bash
# ============================================================
#  deploy.sh — Projeyi sunucuya deploy eder
#  Kullanım:  bash scripts/deploy.sh
# ============================================================
set -euo pipefail

SERVER_USER="${DEPLOY_USER:-root}"
SERVER_HOST="${DEPLOY_HOST:-46.101.142.68}"
APP_DIR="/opt/walletscaner"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  Memecoin Alpha — Server Deploy                         ║"
echo "║  Target: ${SERVER_USER}@${SERVER_HOST}:${APP_DIR}       ║"
echo "╚══════════════════════════════════════════════════════════╝"

# ── 1. Sunucuda gerekli dizinleri oluştur ────────────────────
echo ""
echo "▶ [1/5] Sunucuda dizin ve bağımlılıklar hazırlanıyor..."
ssh "${SERVER_USER}@${SERVER_HOST}" bash <<'REMOTE_SETUP'
set -euo pipefail

# Docker yoksa kur
if ! command -v docker &>/dev/null; then
  echo "  → Docker kuruluyor..."
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable docker
  systemctl start docker
  echo "  ✓ Docker kuruldu"
else
  echo "  ✓ Docker zaten kurulu"
fi

# Proje dizini
mkdir -p /opt/walletscaner/reports /opt/walletscaner/logs
echo "  ✓ Dizinler hazır"
REMOTE_SETUP

# ── 2. Dosyaları sunucuya aktar ──────────────────────────────
echo ""
echo "▶ [2/5] Proje dosyaları aktarılıyor..."
rsync -az --delete \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='dist' \
  --exclude='coverage' \
  --exclude='.env' \
  --exclude='.env.local' \
  --exclude='reports/*.json' \
  --exclude='reports/*.md' \
  --exclude='reports/*.csv' \
  --exclude='reports/*.html' \
  --exclude='.git' \
  --exclude='.gemini' \
  --exclude='.agents' \
  ./ "${SERVER_USER}@${SERVER_HOST}:${APP_DIR}/"

echo "  ✓ Dosyalar aktarıldı"

# ── 3. env dosyasını aktar ───────────────────────────────────
echo ""
echo "▶ [3/5] .env.server aktarılıyor..."
scp .env.server "${SERVER_USER}@${SERVER_HOST}:${APP_DIR}/.env.server"
echo "  ✓ .env.server aktarıldı"

# ── 4. Docker Compose ile servisleri başlat ──────────────────
echo ""
echo "▶ [4/5] Servisler başlatılıyor (docker compose)..."
ssh "${SERVER_USER}@${SERVER_HOST}" bash <<REMOTE_START
set -euo pipefail
cd ${APP_DIR}

# Eski container'ları durdur
docker compose -f docker-compose.server.yml down --remove-orphans 2>/dev/null || true

# Yeniden build et ve başlat
docker compose -f docker-compose.server.yml up -d --build

echo ""
echo "  ✓ Tüm servisler başlatıldı"
REMOTE_START

# ── 5. Durum kontrolü ───────────────────────────────────────
echo ""
echo "▶ [5/5] Servis durumları kontrol ediliyor..."
ssh "${SERVER_USER}@${SERVER_HOST}" "cd ${APP_DIR} && docker compose -f docker-compose.server.yml ps"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  ✅ Deploy tamamlandı!                                  ║"
echo "║                                                          ║"
echo "║  Market Watch:  7/24 çalışıyor (CYCLES=0)               ║"
echo "║  API:           http://46.101.142.68:4010                ║"
echo "║  Dashboard:     http://46.101.142.68:3010                ║"
echo "║                                                          ║"
echo "║  Loglar:        ssh root@46.101.142.68                   ║"
echo "║                 cd /opt/walletscaner                     ║"
echo "║                 docker compose -f docker-compose.server.yml logs -f market-watch ║"
echo "╚══════════════════════════════════════════════════════════╝"
