#!/usr/bin/env python3
"""Voyo CDM sidecar — Widevine L3 license helper for voyo.ts.

Listens on http://127.0.0.1:8091 by default. Stays local — never expose this port.

Setup:
    python3 -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt
    # Drop your L3 device file next to this script as l3.wvd
    # (or pass --device /path/to/your.wvd, or set VOYO_CDM_DEVICE)
    python3 cdm.py

API:
    GET  /health        → {"ok": true, "device": "<path>"}
    POST /keys          → [{"kid": "<hex>", "key": "<hex>"}, ...]
        body: {"pssh": "<base64>", "licenseUrl": "<url>", "headers": {...}}
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from pywidevine.cdm import Cdm
    from pywidevine.device import Device
    from pywidevine.pssh import PSSH
except ImportError:
    sys.exit(
        "missing pywidevine — install with:\n"
        "    pip install -r requirements.txt"
    )

DEVICE: Device | None = None
DEVICE_PATH: str = ""


def fetch_license(url: str, body: bytes, headers: dict) -> bytes:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.read()


def get_keys(pssh_b64: str, license_url: str, headers: dict) -> list[dict]:
    assert DEVICE is not None
    cdm = Cdm.from_device(DEVICE)
    sid = cdm.open()
    try:
        pssh = PSSH(pssh_b64)
        challenge = cdm.get_license_challenge(sid, pssh)
        license_bytes = fetch_license(license_url, challenge, headers)
        cdm.parse_license(sid, license_bytes)
        return [
            {"kid": k.kid.hex, "key": k.key.hex()}
            for k in cdm.get_keys(sid)
            if k.type == "CONTENT"
        ]
    finally:
        cdm.close(sid)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # noqa: A003 — overriding BaseHTTPRequestHandler
        sys.stderr.write(f"[cdm] {self.address_string()} — {fmt % args}\n")

    def _json(self, status: int, obj) -> None:
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            self._json(200, {"ok": True, "device": DEVICE_PATH})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/keys":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            req = json.loads(self.rfile.read(length) or b"{}")
            pssh = req["pssh"]
            license_url = req["licenseUrl"]
            headers = req.get("headers") or {}
            keys = get_keys(pssh, license_url, headers)
            if not keys:
                self._json(502, {"error": "license returned no content keys"})
                return
            self._json(200, keys)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:500]
            self._json(502, {"error": f"license server {e.code}: {body}"})
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": f"{type(e).__name__}: {e}"})


def main() -> None:
    global DEVICE, DEVICE_PATH
    parser = argparse.ArgumentParser(description="Voyo Widevine CDM sidecar")
    parser.add_argument(
        "--device",
        default=os.environ.get("VOYO_CDM_DEVICE", "./l3.wvd"),
        help="path to .wvd device file (default ./l3.wvd, or $VOYO_CDM_DEVICE)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("VOYO_CDM_PORT", "8091")),
        help="listen port (default 8091, or $VOYO_CDM_PORT)",
    )
    args = parser.parse_args()

    if not os.path.exists(args.device):
        sys.exit(
            f"device file not found: {args.device}\n"
            "  → drop a Widevine L3 .wvd here, or pass --device /path/to/your.wvd\n"
            "  → to convert separate private_key.pem + client_id.bin into a .wvd:\n"
            "      pywidevine create-device -k private_key.pem -c client_id.bin -t ANDROID -l 3 -o ."
        )

    DEVICE_PATH = os.path.abspath(args.device)
    DEVICE = Device.load(args.device)

    print(f"cdm sidecar → http://127.0.0.1:{args.port}  (device: {DEVICE_PATH})")
    print("press ctrl+c to quit")
    try:
        ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
