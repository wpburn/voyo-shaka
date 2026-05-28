#!/usr/bin/env bash
set -euo pipefail

# Reinstall iptvro_v2 from this git repo on a VPS.
#
# Usage:
#   bash scripts/vps_reinstall.sh
#   PORT=8090 NAME=iptvro CACHE_MAX_ENTRIES=2000 bash scripts/vps_reinstall.sh

PORT="${PORT:-8090}"
NAME="${NAME:-iptvro}"
IMAGE="${IMAGE:-iptvro_v2:local}"
CACHE_MAX_ENTRIES="${CACHE_MAX_ENTRIES:-2000}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[1/5] Building image '${IMAGE}' from ${ROOT_DIR}" >&2
docker build -t "${IMAGE}" "${ROOT_DIR}"

echo "[2/5] Ensuring bind mount dirs exist" >&2
mkdir -p "${ROOT_DIR}/configs" "${ROOT_DIR}/logs"

# Seed example configs if missing (do not overwrite existing configs).
if [[ ! -f "${ROOT_DIR}/configs/antena-play.json" && -f "${ROOT_DIR}/configs/antena-play.example.jsonc" ]]; then
  cp "${ROOT_DIR}/configs/antena-play.example.jsonc" "${ROOT_DIR}/configs/antena-play.json"
  echo "Seeded configs/antena-play.json from example (credentials empty)" >&2
fi

echo "[3/5] Fixing permissions for UID/GID 1000" >&2
if command -v sudo >/dev/null 2>&1; then
  sudo chown -R 1000:1000 "${ROOT_DIR}/configs" "${ROOT_DIR}/logs" || true
else
  chown -R 1000:1000 "${ROOT_DIR}/configs" "${ROOT_DIR}/logs" || true
fi

echo "[4/5] Replacing container '${NAME}' on port ${PORT}" >&2
docker rm -f "${NAME}" >/dev/null 2>&1 || true

docker run -d \
  --name "${NAME}" \
  --restart unless-stopped \
  --init \
  -p "${PORT}:3000" \
  -e "CACHE_MAX_ENTRIES=${CACHE_MAX_ENTRIES}" \
  -v "${ROOT_DIR}/configs:/app/configs" \
  -v "${ROOT_DIR}/logs:/app/logs" \
  "${IMAGE}"

echo "[5/5] Quick health check" >&2
sleep 2
curl -fsS "http://127.0.0.1:${PORT}/modules" >/dev/null
echo "OK: running at http://127.0.0.1:${PORT}" >&2
