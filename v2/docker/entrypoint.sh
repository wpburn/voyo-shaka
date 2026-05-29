#!/usr/bin/env bash
set -euo pipefail

cd /app

export VOYO_CONFIG_DIR="${VOYO_CONFIG_DIR:-/data}"
export VOYO_CDM_PORT="${VOYO_CDM_PORT:-8091}"
export VOYO_CDM_URL="${VOYO_CDM_URL:-http://127.0.0.1:${VOYO_CDM_PORT}}"
export VOYO_CDM_DEVICE="${VOYO_CDM_DEVICE:-/data/l3.wvd}"
export VOYO_MP4DECRYPT="${VOYO_MP4DECRYPT:-/usr/local/bin/mp4decrypt}"
export VOYO_SHAKA_PACKAGER="${VOYO_SHAKA_PACKAGER:-/usr/local/bin/packager}"

mkdir -p "${VOYO_CONFIG_DIR}"

if [ ! -f "${VOYO_CDM_DEVICE}" ]; then
  echo "error: Widevine device file not found at ${VOYO_CDM_DEVICE}" >&2
  echo "mount your l3.wvd into the container, usually under /data/l3.wvd" >&2
  exit 1
fi

python3 /app/cdm.py &
CDM_PID=$!
trap 'kill "${CDM_PID}" 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 100); do
  if curl -sf "${VOYO_CDM_URL}/health" >/dev/null; then
    break
  fi
  sleep 0.1
done

exec deno run --cached-only --allow-read --allow-write --allow-net --allow-env --allow-run /app/voyo-shaka.ts
