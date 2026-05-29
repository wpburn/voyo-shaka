#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

GHCR_USER="${GHCR_USER:-}"
GHCR_PAT="${GHCR_PAT:-}"
GHCR_IMAGE="${GHCR_IMAGE:-}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
VERSION_TAG="${VERSION_TAG:-$(date -u +%Y%m%d-%H%M%S)}"
RUNTIME_TAG="${RUNTIME_TAG:-runtime}"
BOXED_TAG="${BOXED_TAG:-latest}"
SOURCE_REPO_URL="${SOURCE_REPO_URL:-https://github.com/${GHCR_USER}/iptvro_v2-main}"
PUSH_BOXED="${PUSH_BOXED:-0}"

if [ -z "${GHCR_USER}" ]; then
  echo "GHCR_USER is required" >&2
  exit 1
fi

if [ -z "${GHCR_IMAGE}" ]; then
  GHCR_IMAGE="ghcr.io/${GHCR_USER}/voyo-shaka"
fi

if [ -n "${GHCR_PAT}" ]; then
  echo "${GHCR_PAT}" | docker login ghcr.io -u "${GHCR_USER}" --password-stdin
else
  echo "GHCR_PAT is not set, assuming docker is already logged in to ghcr.io" >&2
fi

BUILDER_NAME="${BUILDER_NAME:-voyo-shaka-builder}"
if ! docker buildx inspect "${BUILDER_NAME}" >/dev/null 2>&1; then
  docker buildx create --name "${BUILDER_NAME}" --driver docker-container --use >/dev/null
else
  docker buildx use "${BUILDER_NAME}" >/dev/null
fi
docker buildx inspect --bootstrap "${BUILDER_NAME}" >/dev/null

docker buildx build \
  --platform "${PLATFORMS}" \
  --label "org.opencontainers.image.source=${SOURCE_REPO_URL}" \
  -f "${REPO_ROOT}/v2/docker/Dockerfile" \
  -t "${GHCR_IMAGE}:${RUNTIME_TAG}" \
  -t "${GHCR_IMAGE}:${VERSION_TAG}-runtime" \
  --push \
  "${REPO_ROOT}"

echo
echo "Pushed runtime image: ${GHCR_IMAGE}:${RUNTIME_TAG}"
echo "Pushed version tag:   ${GHCR_IMAGE}:${VERSION_TAG}-runtime"

if [ "${PUSH_BOXED}" = "1" ]; then
  L3_PATH="${L3_PATH:-}"
  VOYO_JSON_PATH="${VOYO_JSON_PATH:-}"

  if [ -z "${L3_PATH}" ]; then
    if [ -f "${REPO_ROOT}/v2/data/l3.wvd" ]; then
      L3_PATH="${REPO_ROOT}/v2/data/l3.wvd"
    else
      L3_PATH="${REPO_ROOT}/v2/l3.wvd"
    fi
  fi

  if [ -z "${VOYO_JSON_PATH}" ]; then
    if [ -f "${REPO_ROOT}/v2/data/voyo.json" ]; then
      VOYO_JSON_PATH="${REPO_ROOT}/v2/data/voyo.json"
    else
      VOYO_JSON_PATH="${REPO_ROOT}/v2/voyo.json"
    fi
  fi

  if [ ! -f "${L3_PATH}" ]; then
    echo "l3.wvd not found at ${L3_PATH}" >&2
    exit 1
  fi

  if [ ! -f "${VOYO_JSON_PATH}" ]; then
    echo "voyo.json not found at ${VOYO_JSON_PATH}" >&2
    exit 1
  fi

  TMP_DIR="$(mktemp -d)"
  cleanup() {
    rm -rf "${TMP_DIR}"
  }
  trap cleanup EXIT

  cp "${L3_PATH}" "${TMP_DIR}/l3.wvd"
  cp "${VOYO_JSON_PATH}" "${TMP_DIR}/voyo.json"

  cat >"${TMP_DIR}/Dockerfile" <<EOF
FROM ${GHCR_IMAGE}:${RUNTIME_TAG}
COPY l3.wvd /seed-data/l3.wvd
COPY voyo.json /seed-data/voyo.json
EOF

  echo "warning: building a boxed image that contains l3.wvd and voyo.json" >&2
  echo "warning: anyone who can pull this image can extract those files" >&2

  docker buildx build \
    --platform "${PLATFORMS}" \
    --label "org.opencontainers.image.source=${SOURCE_REPO_URL}" \
    -f "${TMP_DIR}/Dockerfile" \
    -t "${GHCR_IMAGE}:${BOXED_TAG}" \
    -t "${GHCR_IMAGE}:${VERSION_TAG}" \
    --push \
    "${TMP_DIR}"

  echo "Pushed boxed image:   ${GHCR_IMAGE}:${BOXED_TAG}"
  echo "Pushed version tag:   ${GHCR_IMAGE}:${VERSION_TAG}"
else
  echo
  echo "Boxed image push skipped."
  echo "Set PUSH_BOXED=1 only if you intentionally want to upload l3.wvd and voyo.json inside the image."
fi
