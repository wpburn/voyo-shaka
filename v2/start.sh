#!/usr/bin/env bash
# Start the CDM sidecar + voyo.ts in one shot. Kills both on Ctrl+C.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f l3.wvd ] && [ -z "${VOYO_CDM_DEVICE:-}" ]; then
  echo "error: no l3.wvd here and VOYO_CDM_DEVICE not set" >&2
  exit 1
fi

# Use the venv if present, else system python.
PY=python3
if [ -x .venv/bin/python ]; then PY=.venv/bin/python; fi

"$PY" cdm.py &
CDM_PID=$!
trap 'kill $CDM_PID 2>/dev/null || true' EXIT INT TERM

# Wait for sidecar /health.
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:${VOYO_CDM_PORT:-8091}/health" >/dev/null; then break; fi
  sleep 0.1
done

deno run --allow-read --allow-write --allow-net --allow-env --allow-run voyo.ts
