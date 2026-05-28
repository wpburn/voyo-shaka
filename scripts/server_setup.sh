#!/usr/bin/env bash
set -euo pipefail

# IPTVRO v2 - Ubuntu 24.04 VPS Setup
# Installs Docker, Docker Compose, and starts the IPTVRO stack.
# Usage: curl -sSL <url> | bash  OR  bash server_setup.sh

APP_DIR="/opt/iptvro"

echo "==> Updating system packages"
apt-get update && apt-get upgrade -y

echo "==> Installing prerequisites"
apt-get install -y ca-certificates curl gnupg

echo "==> Adding Docker GPG key and repository"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list

echo "==> Installing Docker Engine"
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "==> Enabling and starting Docker"
systemctl enable --now docker

echo "==> Verifying Docker installation"
docker --version
docker compose version

echo "==> Setting up application directory at ${APP_DIR}"
mkdir -p "${APP_DIR}/configs" "${APP_DIR}/logs"
chown -R 1000:1000 "${APP_DIR}/configs" "${APP_DIR}/logs"

if [ ! -f "${APP_DIR}/docker-compose.yaml" ]; then
  cat > "${APP_DIR}/docker-compose.yaml" << 'EOF'
version: "3"

services:
  iptv_ro:
    container_name: iptvro
    image: ghcr.io/rednblkx/iptvro_v2:main
    init: true
    restart: unless-stopped
    environment:
      - CACHE_MAX_ENTRIES=${CACHE_MAX_ENTRIES:-2000}
      - DEBUG=${DEBUG:-false}
    ports:
      - "${HOST_PORT:-8090}:3000"
    volumes:
      - ./logs:/app/logs
      - ./configs:/app/configs
    healthcheck:
      test:
        [
          "CMD",
          "deno",
          "eval",
          "const r = await fetch('http://127.0.0.1:3000/modules'); if (!r.ok) Deno.exit(1);",
        ]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 20s
EOF
  echo "    Created docker-compose.yaml"
else
  echo "    docker-compose.yaml already exists, skipping"
fi

echo "==> Pulling latest image"
cd "${APP_DIR}"
docker compose pull

echo "==> Starting IPTVRO"
docker compose up -d

echo ""
echo "============================================"
echo "  Setup complete!"
echo "  App running at http://$(hostname -I | awk '{print $1}'):8090"
echo ""
echo "  Useful commands:"
echo "    cd ${APP_DIR}"
echo "    docker compose logs -f        # live logs"
echo "    docker compose restart         # restart"
echo "    docker compose down && docker compose up -d  # full restart"
echo ""
echo "  Config files: ${APP_DIR}/configs/"
echo "  Log files:    ${APP_DIR}/logs/"
echo "  Enable debug: DEBUG=true docker compose up -d"
echo "============================================"
