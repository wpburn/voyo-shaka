#!/usr/bin/env bash
set -euo pipefail

PORT="${1:-8090}"

detect_container() {
  if [[ -n "${CONTAINER_NAME:-}" ]]; then
    echo "${CONTAINER_NAME}";
    return 0;
  fi
  if docker ps --format '{{.Names}}' | grep -qx "iptvro"; then
    echo "iptvro"; return 0;
  fi
  if docker ps --format '{{.Names}}' | grep -qx "iptv_ro"; then
    echo "iptv_ro"; return 0;
  fi
  # Fallback: find first container running the GHCR image.
  docker ps --format '{{.Names}}\t{{.Image}}' | awk '$2 ~ /ghcr\.io\/rednblkx\/iptvro_v2/ {print $1; exit 0}'
}

CONTAINER_NAME="$(detect_container || true)"
BASE_URL="http://127.0.0.1:${PORT}"

detect_mount_source() {
  local container="$1"
  local dest="$2"
  docker inspect -f "{{range .Mounts}}{{if eq .Destination \"${dest}\"}}{{.Source}}{{end}}{{end}}" "$container" 2>/dev/null || true
}

hr() { echo "------------------------------------------"; }

echo "=========================================="
echo "DIAGNOSTIC IPTVRO_V2 - PORT ${PORT}"
echo "=========================================="

hr
echo "1) DOCKER CONTAINER"
if [[ -n "${CONTAINER_NAME}" ]] && docker ps --format '{{.Names}}' | grep -qx "${CONTAINER_NAME}"; then
  echo "OK: container '${CONTAINER_NAME}' is running"
else
  echo "ERROR: iptvro_v2 container not running (or name not detected)"
  echo "Running containers:"; docker ps --format '  - {{.Names}} ({{.Image}})'
  exit 2
fi

RESTART_POLICY="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "${CONTAINER_NAME}")"
echo "Restart policy: ${RESTART_POLICY:-<none>}"
if [[ -z "${RESTART_POLICY}" ]]; then
  echo "WARN: no restart policy; recommended: docker update --restart unless-stopped ${CONTAINER_NAME}"
fi

RESTART_COUNT="$(docker inspect -f '{{.RestartCount}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
echo "Restart count: ${RESTART_COUNT:-?}"

MEM_USAGE="$(docker stats --no-stream --format '{{.MemUsage}}' "${CONTAINER_NAME}" 2>/dev/null || true)"
if [[ -n "${MEM_USAGE}" ]]; then
  echo "Memory usage: ${MEM_USAGE}"
fi

CONFIGS_MOUNT="$(detect_mount_source "${CONTAINER_NAME}" "/app/configs")"
LOGS_MOUNT="$(detect_mount_source "${CONTAINER_NAME}" "/app/logs")"
if [[ -n "${CONFIGS_MOUNT}" ]]; then
  echo "Configs mount: ${CONFIGS_MOUNT} -> /app/configs"
else
  echo "Configs mount: <not detected> (container may be using internal /app/configs)"
fi
if [[ -n "${LOGS_MOUNT}" ]]; then
  echo "Logs mount: ${LOGS_MOUNT} -> /app/logs"
fi

hr
echo "2) PORT CHECK"
if ss -lntp 2>/dev/null | grep -q ":${PORT} "; then
  ss -lntp 2>/dev/null | grep ":${PORT} " || true
else
  echo "WARN: nothing listening on :${PORT} (maybe firewall or container not publishing?)"
fi

hr
echo "3) API CHECK (/modules)"
if curl -fsS "${BASE_URL}/modules" >/dev/null; then
  echo "OK: ${BASE_URL}/modules"
else
  echo "ERROR: cannot reach ${BASE_URL}/modules"
  echo "Last logs:"; docker logs --tail=120 "${CONTAINER_NAME}" || true
  exit 3
fi

hr
echo "4) ANTENA-PLAY CREDENTIALS"
# Credentials should be stored in the mounted configs folder (recommended) to avoid leaking in shell history.
# The file is: configs/antena-play.json on the VPS host (mounted to /app/configs/antena-play.json in container).

CONFIG_PATH_GUESS_1="$(pwd)/configs/antena-play.json"
CONFIG_PATH_GUESS_2="/root/configs/antena-play.json"
CONFIG_PATH_GUESS_3=""
if [[ -n "${CONFIGS_MOUNT}" ]]; then
  CONFIG_PATH_GUESS_3="${CONFIGS_MOUNT}/antena-play.json"
fi
CONFIG_PATH=""
if [[ -f "${CONFIG_PATH_GUESS_1}" ]]; then CONFIG_PATH="${CONFIG_PATH_GUESS_1}"; fi
if [[ -z "${CONFIG_PATH}" && -f "${CONFIG_PATH_GUESS_2}" ]]; then CONFIG_PATH="${CONFIG_PATH_GUESS_2}"; fi
if [[ -z "${CONFIG_PATH}" && -n "${CONFIG_PATH_GUESS_3}" && -f "${CONFIG_PATH_GUESS_3}" ]]; then CONFIG_PATH="${CONFIG_PATH_GUESS_3}"; fi

if [[ -n "${CONFIG_PATH}" ]]; then
  echo "Found ${CONFIG_PATH}"
  # Best-effort parse without jq.
  USERNAME="$(python3 - <<'PY' "${CONFIG_PATH}" 2>/dev/null || true
import json,sys
p=sys.argv[1]
try:
  j=json.load(open(p,'r',encoding='utf-8'))
  print((j.get('auth') or {}).get('username') or '')
except Exception:
  print('')
PY
)"
  PASSWORD="$(python3 - <<'PY' "${CONFIG_PATH}" 2>/dev/null || true
import json,sys
p=sys.argv[1]
try:
  j=json.load(open(p,'r',encoding='utf-8'))
  print((j.get('auth') or {}).get('password') or '')
except Exception:
  print('')
PY
)"

  if [[ -n "${USERNAME}" && -n "${PASSWORD}" ]]; then
    echo "OK: username/password are set in config (values hidden)"
  else
    echo "WARN: username/password missing in config. Edit ${CONFIG_PATH} and set: auth.username + auth.password"
    echo "      then run: curl -sS -X POST -H 'content-type: application/json' -d '{}' ${BASE_URL}/antena-play/login"
  fi
else
  echo "WARN: could not find configs/antena-play.json in common locations."
  echo "      Ensure you run docker with a bind mount: -v <host_configs_dir>:/app/configs"
  echo "      Or restore the file into the detected mount: ${CONFIGS_MOUNT:-<unknown>}"
fi

hr
echo "4b) CACHE FILE (possible OOM cause)"
CACHE_PATH=""
if [[ -f "$(pwd)/configs/cache.json" ]]; then CACHE_PATH="$(pwd)/configs/cache.json"; fi
if [[ -z "${CACHE_PATH}" && -f "/root/configs/cache.json" ]]; then CACHE_PATH="/root/configs/cache.json"; fi
if [[ -z "${CACHE_PATH}" && -n "${CONFIGS_MOUNT}" && -f "${CONFIGS_MOUNT}/cache.json" ]]; then CACHE_PATH="${CONFIGS_MOUNT}/cache.json"; fi
if [[ -n "${CACHE_PATH}" ]]; then
  ls -lh "${CACHE_PATH}" | sed 's/^/  /'
  python3 - <<'PY' "${CACHE_PATH}" 2>/dev/null || true
import json,sys
p=sys.argv[1]
try:
  j=json.load(open(p,'r',encoding='utf-8'))
  print(f"entries: {len(j) if isinstance(j,list) else 'n/a'}")
except Exception as e:
  print(f"entries: n/a ({e})")
PY
  echo "Tip: if this file is huge, set env CACHE_MAX_ENTRIES (e.g. 2000) and/or delete cache.json to recover."
else
  echo "No cache.json found in common locations."
fi

hr
echo "5) ANTENA-PLAY LOGIN (POST /antena-play/login)"
echo
LOGIN_CODE="$(curl -sS -o /tmp/iptv_login.json -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "${BASE_URL}/antena-play/login" || true)"
echo "HTTP ${LOGIN_CODE}"
python3 - <<'PY' /tmp/iptv_login.json 2>/dev/null || cat /tmp/iptv_login.json | head -c 200
import json,sys
j=json.load(open(sys.argv[1],'r',encoding='utf-8'))
data=j.get('data')
has_token = isinstance(data, list) and len(data) > 0 and bool(data[0])
err = j.get('error')
if isinstance(err, str) and len(err) > 180:
  err = err[:180] + '...'
print({
  "status": j.get("status"),
  "module": j.get("module"),
  "has_token": has_token,
  "error": err,
})
PY

hr
echo "5b) ANTENA-PLAY UPSTREAM CHECK (direct to restapi.antenaplay.ro; dummy creds)"
echo "Tip: if this is 403 from a VPS but 401/200 from home, the VPS IP range is likely blocked."

UPSTREAM_HEADERS=(
  -H 'content-type: application/x-www-form-urlencoded'
  -H 'api-request-source: ios'
  -H 'user-agent: AntenaPlay/3.2.5 (ro.antenaplay.app; build:88; iOS 12.5.1) Alamofire/4.9.1'
)
UPSTREAM_DATA='email=test@example.com&password=wrong'
UPSTREAM_URL='https://restapi.antenaplay.ro/v1/auth/login'

http_code() {
  local ipflag="$1"
  local code
  code="$(curl "${ipflag}" -sS -o /dev/null -w '%{http_code}' --connect-timeout 6 --max-time 12 -X POST "${UPSTREAM_URL}" "${UPSTREAM_HEADERS[@]}" --data "${UPSTREAM_DATA}" 2>/dev/null || true)"
  echo "${code:-000}"
}

UPSTREAM_V4="$(http_code -4)"
UPSTREAM_V6="$(http_code -6)"
echo "Upstream IPv4 HTTP: ${UPSTREAM_V4:-<failed>}"
echo "Upstream IPv6 HTTP: ${UPSTREAM_V6:-<failed>}"
if [[ "${UPSTREAM_V4}" != "000" && "${UPSTREAM_V6}" == "000" ]]; then
  echo "Note: IPv6 check failed (no IPv6/AAAA route), IPv4 is what matters here."
fi

hr
echo "6) ANTENA-PLAY UPDATE CHANNELS"
UC_CODE="$(curl -sS -o /tmp/iptv_uc.json -w '%{http_code}' "${BASE_URL}/antena-play/updatechannels" || true)"
echo "HTTP ${UC_CODE}"
head -c 300 /tmp/iptv_uc.json || true
echo

hr
echo "7) ANTENA-PLAY LIVE LIST"
LIVE_CODE="$(curl -sS -o /tmp/iptv_live.json -w '%{http_code}' "${BASE_URL}/antena-play/live" || true)"
echo "HTTP ${LIVE_CODE}"
head -c 300 /tmp/iptv_live.json || true
echo

hr
echo "Done. If something fails, also send: docker logs --tail=200 ${CONTAINER_NAME}"
