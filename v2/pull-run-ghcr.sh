#!/usr/bin/env bash
set -euo pipefail

GHCR_USER="${GHCR_USER:-}"
GHCR_PAT="${GHCR_PAT:-}"
GHCR_IMAGE="${GHCR_IMAGE:-}"
IMAGE_TAG="${IMAGE_TAG:-runtime}"
CONTAINER_NAME="${CONTAINER_NAME:-voyo-shaka}"
APP_DIR="${APP_DIR:-/opt/voyo-shaka}"
HOST_PORT="${HOST_PORT:-8090}"
UI_USER="${UI_USER:-adm}"
UI_PASS="${UI_PASS:-fvoyo}"
PRESERVE_LIVE_DIR="${VOYO_PRESERVE_LIVE_DIR:-0}"
HTTPS_DOMAIN="${HTTPS_DOMAIN:-}"
CADDY_IMAGE="${CADDY_IMAGE:-caddy:2}"
CADDY_CONTAINER_NAME="${CADDY_CONTAINER_NAME:-voyo-caddy}"

for arg in "$@"; do
  case "$arg" in
    --keep-live-data)
      PRESERVE_LIVE_DIR=1
      ;;
    *)
      echo "usage: $0 [--keep-live-data]" >&2
      exit 1
      ;;
  esac
done

if [ -z "${GHCR_USER}" ]; then
  echo "GHCR_USER is required" >&2
  exit 1
fi

if [ -z "${GHCR_IMAGE}" ]; then
  GHCR_IMAGE="ghcr.io/${GHCR_USER}/voyo-shaka"
fi

if [ -z "${GHCR_PAT}" ]; then
  echo "GHCR_PAT is required" >&2
  exit 1
fi

if [ -n "${HTTPS_DOMAIN}" ] && ! [[ "${HTTPS_DOMAIN}" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "HTTPS_DOMAIN must be a hostname without a scheme, path, or port" >&2
  exit 1
fi

IMAGE_REF="${GHCR_IMAGE}:${IMAGE_TAG}"

mkdir -p "${APP_DIR}/data"

if [ "${IMAGE_TAG}" = "runtime" ] || [ "${IMAGE_TAG##*-}" = "runtime" ]; then
  if [ ! -f "${APP_DIR}/data/l3.wvd" ] || [ ! -f "${APP_DIR}/data/voyo.json" ]; then
    echo "runtime image selected, but ${APP_DIR}/data is missing l3.wvd or voyo.json" >&2
    echo "copy both files into ${APP_DIR}/data before running this script," >&2
    echo "or use IMAGE_TAG=latest only if you intentionally built a boxed image." >&2
    exit 1
  fi
fi

echo "${GHCR_PAT}" | docker login ghcr.io -u "${GHCR_USER}" --password-stdin
docker pull "${IMAGE_REF}"

if docker ps -a --format '{{.Names}}' | grep -Fxq "${CONTAINER_NAME}"; then
  docker rm -f "${CONTAINER_NAME}"
fi

docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  -p "${HOST_PORT}:8090" \
  -v "${APP_DIR}/data:/data" \
  -e VOYO_PRESERVE_LIVE_DIR="${PRESERVE_LIVE_DIR}" \
  -e VOYO_UI_BASIC_AUTH_USER="${UI_USER}" \
  -e VOYO_UI_BASIC_AUTH_PASS="${UI_PASS}" \
  "${IMAGE_REF}"

if [ -n "${HTTPS_DOMAIN}" ]; then
  docker pull "${CADDY_IMAGE}"

  if docker ps -a --format '{{.Names}}' | grep -Fxq "${CADDY_CONTAINER_NAME}"; then
    docker rm -f "${CADDY_CONTAINER_NAME}"
  fi

  docker run -d \
    --name "${CADDY_CONTAINER_NAME}" \
    --restart unless-stopped \
    --network host \
    -v voyo-caddy-data:/data \
    -v voyo-caddy-config:/config \
    "${CADDY_IMAGE}" \
    caddy reverse-proxy \
    --from "${HTTPS_DOMAIN}" \
    --to "127.0.0.1:${HOST_PORT}"
fi

sleep 3

echo
echo "Container started: ${CONTAINER_NAME}"
echo "Image:             ${IMAGE_REF}"
echo "UI:                http://$(hostname -I 2>/dev/null | awk '{print $1}'):${HOST_PORT}/"
echo "VLC:               http://$(hostname -I 2>/dev/null | awk '{print $1}'):${HOST_PORT}/vlc/channel-179/index.m3u8"
if [ -n "${HTTPS_DOMAIN}" ]; then
  echo "HTTPS UI:          https://${HTTPS_DOMAIN}/"
fi
echo
docker ps --filter "name=${CONTAINER_NAME}"
if [ -n "${HTTPS_DOMAIN}" ]; then
  docker ps --filter "name=${CADDY_CONTAINER_NAME}"
  echo
  docker logs --tail 30 "${CADDY_CONTAINER_NAME}"
fi
echo
docker logs --tail 50 "${CONTAINER_NAME}"
