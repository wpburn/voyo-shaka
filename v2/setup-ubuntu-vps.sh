#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "run this script as root, for example: sudo bash v2/setup-ubuntu-vps.sh" >&2
  exit 1
fi

APP_USER="${APP_USER:-${SUDO_USER:-ubuntu}}"
APP_DIR="${APP_DIR:-/opt/voyo-shaka}"
APP_PORT="${APP_PORT:-8090}"
INSTALL_UFW="${INSTALL_UFW:-0}"

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  gnupg

install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
fi
chmod a+r /etc/apt/keyrings/docker.gpg

. /etc/os-release
cat >/etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable
EOF

apt-get update
apt-get install -y --no-install-recommends \
  containerd.io \
  docker-buildx-plugin \
  docker-ce \
  docker-ce-cli \
  docker-compose-plugin

systemctl enable --now docker

if id "${APP_USER}" >/dev/null 2>&1; then
  usermod -aG docker "${APP_USER}" || true
fi

install -d -m 0755 "${APP_DIR}"
install -d -m 0755 "${APP_DIR}/data"

if [ "${INSTALL_UFW}" = "1" ]; then
  apt-get install -y --no-install-recommends ufw
  ufw allow OpenSSH
  ufw allow "${APP_PORT}/tcp"
  ufw --force enable
fi

echo
echo "Docker installed."
docker --version
docker compose version
echo
echo "App directory prepared at: ${APP_DIR}"
echo "Data directory prepared at: ${APP_DIR}/data"
echo
echo "Next step on this server:"
echo "  GHCR_USER=your-github-user GHCR_PAT=your-token bash pull-run-ghcr.sh"
echo
echo "If you added ${APP_USER} to the docker group, log out and back in before using docker without sudo."
