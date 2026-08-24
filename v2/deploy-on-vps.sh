#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/.env}"
SSH_TARGET="${SSH_TARGET:-lui-alexhost-voyo}"
REMOTE_DIR="${REMOTE_DIR:-/root/voyo}"
HTTPS_DOMAIN="${HTTPS_DOMAIN:-vyoo.duckdns.org}"
PLATFORMS="${PLATFORMS:-linux/amd64}"
SKIP_BUILD=0

usage() {
  echo "usage: $0 [--skip-build]" >&2
}

for arg in "$@"; do
  case "${arg}" in
    --skip-build)
      SKIP_BUILD=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

GHCR_USER="${GHCR_USER:-}"
GHCR_PAT="${GHCR_PAT:-}"

if [ -z "${GHCR_USER}" ]; then
  echo "GHCR_USER is required in ${ENV_FILE} or the environment" >&2
  exit 1
fi

if [ -z "${GHCR_PAT}" ]; then
  echo "GHCR_PAT is required in ${ENV_FILE} or the environment" >&2
  exit 1
fi

if ! [[ "${HTTPS_DOMAIN}" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "HTTPS_DOMAIN must be a hostname without a scheme, path, or port" >&2
  exit 1
fi

if [ "${SKIP_BUILD}" = "0" ]; then
  echo "==> Building and pushing the runtime image for ${PLATFORMS}"
  PLATFORMS="${PLATFORMS}" \
    GHCR_USER="${GHCR_USER}" \
    GHCR_PAT="${GHCR_PAT}" \
    bash "${SCRIPT_DIR}/build-push-ghcr.sh"
else
  echo "==> Skipping image build"
fi

printf -v REMOTE_DIR_QUOTED '%q' "${REMOTE_DIR}"
echo "==> Preparing ${SSH_TARGET}:${REMOTE_DIR}"
ssh "${SSH_TARGET}" "mkdir -p ${REMOTE_DIR_QUOTED}"

echo "==> Copying the VPS deployment script"
scp "${SCRIPT_DIR}/pull-run-ghcr.sh" \
  "${SSH_TARGET}:${REMOTE_DIR}/pull-run-ghcr.sh"

CREDENTIAL_FILE="$(mktemp)"
cleanup() {
  rm -f "${CREDENTIAL_FILE}"
}
trap cleanup EXIT
chmod 600 "${CREDENTIAL_FILE}"
printf 'GHCR_USER=%q\nGHCR_PAT=%q\n' "${GHCR_USER}" "${GHCR_PAT}" >"${CREDENTIAL_FILE}"

echo "==> Updating the private VPS environment"
scp -q "${CREDENTIAL_FILE}" \
  "${SSH_TARGET}:${REMOTE_DIR}/.deploy-credentials.env"

printf -v HTTPS_DOMAIN_QUOTED '%q' "${HTTPS_DOMAIN}"
ssh "${SSH_TARGET}" \
  "bash -s -- ${REMOTE_DIR_QUOTED} ${HTTPS_DOMAIN_QUOTED}" <<'REMOTE_SCRIPT'
set -euo pipefail

REMOTE_DIR="$1"
HTTPS_DOMAIN="$2"
cd "${REMOTE_DIR}"

cleanup_credentials() {
  rm -f .deploy-credentials.env
}
trap cleanup_credentials EXIT

set -a
# shellcheck disable=SC1091
source ./.deploy-credentials.env
set +a

touch .env
chmod 600 .env
sed -i '/^\(export \)\?GHCR_USER=/d' .env
sed -i '/^\(export \)\?GHCR_PAT=/d' .env
sed -i '/^\(export \)\?HTTPS_DOMAIN=/d' .env
printf 'GHCR_USER=%q\n' "${GHCR_USER}" >>.env
printf 'GHCR_PAT=%q\n' "${GHCR_PAT}" >>.env
printf 'HTTPS_DOMAIN=%q\n' "${HTTPS_DOMAIN}" >>.env

chmod +x pull-run-ghcr.sh

if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 8090/tcp
fi

set -a
# shellcheck disable=SC1091
source ./.env
set +a

bash ./pull-run-ghcr.sh
REMOTE_SCRIPT

echo
echo "Deployment complete:"
echo "  HTTPS:      https://${HTTPS_DOMAIN}/"
echo "  Direct HTTP remains available on port 8090."
