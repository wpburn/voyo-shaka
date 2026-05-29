# Voyo Live (v2)

Single-file Deno 2 server that exposes Voyo Romania live channels as plain HLS playlists for VLC/IPTV apps.

This folder now has two entry points:

- `voyo.ts` for the original baseline
- `voyo-shaka.ts` for the parallel Shaka Packager implementation

## Run

```sh
cd v2
deno run --allow-read --allow-write --allow-net --allow-env --allow-run voyo.ts
```

Shaka variant:

```sh
cd v2
deno run --allow-read --allow-write --allow-net --allow-env --allow-run voyo-shaka.ts
```

## Docker

There is a dedicated container setup for the working Shaka path:

- compose file: [docker-compose.shaka.yaml](/Users/flav/Downloads/iptvro_v2-main/v2/docker-compose.shaka.yaml)
- image build: [docker/Dockerfile](/Users/flav/Downloads/iptvro_v2-main/v2/docker/Dockerfile)

It is designed for:

- Ubuntu 24 Docker hosts
- Docker Desktop on Apple Silicon or Intel Macs

The image:

- runs `voyo-shaka.ts`
- starts `cdm.py` in the same container
- builds `mp4decrypt` from pinned Bento4 source
- downloads the official Shaka Packager Linux binary for the target architecture
- caches Deno dependencies at build time, so normal container startup does not fetch code from the network

Helper scripts in this folder:

- [setup-ubuntu-vps.sh](/Users/flav/Downloads/iptvro_v2-main/v2/setup-ubuntu-vps.sh) installs Docker Engine, Buildx, and Compose on a fresh Ubuntu 24 server
- [build-push-ghcr.sh](/Users/flav/Downloads/iptvro_v2-main/v2/build-push-ghcr.sh) builds and pushes a private GHCR runtime image from your Mac
- [pull-run-ghcr.sh](/Users/flav/Downloads/iptvro_v2-main/v2/pull-run-ghcr.sh) pulls that image on Ubuntu and starts the container

### Docker quick start

From the repo root:

```sh
cd /path/to/iptvro_v2-main
mkdir -p v2/data
cp v2/l3.wvd v2/data/l3.wvd
cp v2/voyo.json v2/data/voyo.json
docker compose -f v2/docker-compose.shaka.yaml up --build -d
```

If your `l3.wvd` and `voyo.json` live somewhere else, copy those files into `v2/data/` instead of the sample paths above.

Check that the container is up:

```sh
docker compose -f v2/docker-compose.shaka.yaml ps
docker compose -f v2/docker-compose.shaka.yaml logs -f
```

Basic HTTP checks:

```sh
curl -i http://127.0.0.1:8090/
curl -i http://127.0.0.1:8090/vlc/channel-179/index.m3u8
curl -u adm:fvoyo http://127.0.0.1:8090/api/stream/channel-179
```

Open:

- UI: `http://localhost:8090/`
- VLC: `http://localhost:8090/vlc/channel-179/index.m3u8`

Stop the stack:

```sh
docker compose -f v2/docker-compose.shaka.yaml down
```

Rebuild from scratch after image changes:

```sh
docker compose -f v2/docker-compose.shaka.yaml up --build -d
```

Remove the stack and local image:

```sh
docker compose -f v2/docker-compose.shaka.yaml down --rmi local
```

Run on another host port, for example `8095`:

```sh
VOYO_HOST_PORT=8095 docker compose -f v2/docker-compose.shaka.yaml up --build -d
```

Run with custom UI credentials:

```sh
VOYO_UI_BASIC_AUTH_USER=myuser \
VOYO_UI_BASIC_AUTH_PASS=mypass \
docker compose -f v2/docker-compose.shaka.yaml up --build -d
```

### GHCR boxed-image flow

Safe default: push only the runtime image to GHCR, then copy `l3.wvd` and `voyo.json` once to the Ubuntu server.

Store your GHCR credentials in a local `.env` file that is **not committed**:

```sh
cd /path/to/iptvro_v2-main/v2
cat > .env <<'EOF'
GHCR_USER=prog-322
GHCR_PAT=your-new-ghcr-token
EOF
```

Load that file into the shell before using the helper scripts:

```sh
cd /path/to/iptvro_v2-main
set -a
source v2/.env
set +a
```

If the Ubuntu VPS is `x86_64`, push an `amd64` runtime image from your Mac:

```sh
cd /path/to/iptvro_v2-main
set -a
source v2/.env
set +a
PLATFORMS=linux/amd64 \
bash v2/build-push-ghcr.sh
```

The script pushes:

- `ghcr.io/<user>/voyo-shaka:runtime` as the reusable base image
- `ghcr.io/<user>/voyo-shaka:<timestamp>-runtime` as a versioned runtime tag

If you want a true multi-arch image later, use:

```sh
cd /path/to/iptvro_v2-main
set -a
source v2/.env
set +a
PLATFORMS=linux/amd64,linux/arm64 \
bash v2/build-push-ghcr.sh
```

Prepare a fresh Ubuntu 24 VPS:

```sh
scp v2/setup-ubuntu-vps.sh user@your-server:
ssh user@your-server
sudo bash setup-ubuntu-vps.sh
```

Copy your runtime files to the server:

```sh
scp v2/l3.wvd v2/voyo.json user@your-server:/tmp/
ssh user@your-server
sudo mkdir -p /opt/voyo-shaka/data
sudo mv /tmp/l3.wvd /opt/voyo-shaka/data/l3.wvd
sudo mv /tmp/voyo.json /opt/voyo-shaka/data/voyo.json
sudo chown -R $USER:$USER /opt/voyo-shaka
exit
```

Pull and run the runtime image on that server:

```sh
scp v2/pull-run-ghcr.sh user@your-server:
ssh user@your-server
cat > .env <<'EOF'
GHCR_USER=prog-322
GHCR_PAT=your-new-ghcr-token
EOF
set -a
source .env
set +a
bash pull-run-ghcr.sh
```

Custom host port and UI credentials:

```sh
set -a
source .env
set +a
HOST_PORT=8095 \
UI_USER=myuser \
UI_PASS=mypass \
bash pull-run-ghcr.sh
```

Optional risky mode: build a boxed image that contains `l3.wvd` and `voyo.json` inside the image itself.

```sh
cd /path/to/iptvro_v2-main
set -a
source v2/.env
set +a
PUSH_BOXED=1 \
bash v2/build-push-ghcr.sh
```

Then on the server:

```sh
set -a
source .env
set +a
IMAGE_TAG=latest \
bash pull-run-ghcr.sh
```

Warning: the boxed image contains your `l3.wvd` and `voyo.json`. Anyone who can pull that image can extract those files.

### Docker notes

- The container stores config and generated output under `/data`.
- `VOYO_CDM_DEVICE` defaults to `/data/l3.wvd`.
- The compose file publishes only port `8090`; the CDM sidecar stays internal to the container.
- On Apple Silicon, the setup is intended to build and run natively as `linux/arm64`.

`--allow-run` is only needed for experimental helper paths. The normal server works for non-DRM channels and the in-browser Shaka player.

Or build a standalone binary (no Deno required at runtime):

```sh
deno compile --allow-read --allow-write --allow-net --allow-env --output voyo voyo.ts
./voyo
```

For the Shaka build, replace `voyo.ts` with `voyo-shaka.ts` and choose a different output name.

Open <http://localhost:8090>. `voyo.json` is read/written next to the executable (or next to the script in dev mode); override with `VOYO_CONFIG_DIR=/path/to/dir`, change port with `VOYO_PORT=9000`. On first run it migrates credentials from `../configs/voyo.json` if present, otherwise it creates an empty `voyo.json` — fill in `credentials.username` / `credentials.password` and restart.

`voyo-shaka.ts` also protects the UI/browser routes with HTTP Basic Auth by default:

- username: `adm`
- password: `fvoyo`

Override with `VOYO_UI_BASIC_AUTH_USER` and `VOYO_UI_BASIC_AUTH_PASS`.

### Cross-compile

`deno compile --target=…` produces a binary for another OS/arch. Supported targets (from any host):

```sh
# Linux x86_64
deno compile --target x86_64-unknown-linux-gnu  --allow-read --allow-write --allow-net --allow-env --output voyo-linux-x64 voyo.ts
# Linux ARM64
deno compile --target aarch64-unknown-linux-gnu --allow-read --allow-write --allow-net --allow-env --output voyo-linux-arm64 voyo.ts
# Windows x86_64
deno compile --target x86_64-pc-windows-msvc    --allow-read --allow-write --allow-net --allow-env --output voyo-win-x64.exe voyo.ts
# macOS Intel
deno compile --target x86_64-apple-darwin       --allow-read --allow-write --allow-net --allow-env --output voyo-mac-x64 voyo.ts
# macOS Apple Silicon
deno compile --target aarch64-apple-darwin      --allow-read --allow-write --allow-net --allow-env --output voyo-mac-arm64 voyo.ts
```

Caveats: Linux targets are glibc (no musl/Alpine); the snapshot for each new target is downloaded on first build.

## URLs

- `http://<host>:8090/` — channel list, copy buttons, mosaic builder
- `http://<host>:8090/live.m3u8` — combined VLC playlist. `?mode=all` (default) includes DRM channels via `/vlc/…` (needs CDM sidecar); `?mode=hls` for non-DRM only.
- `http://<host>:8090/live/<channel-id>.m3u8` — single channel HLS (non-DRM only)
- `http://<host>:8090/vlc/<channel-id>/index.m3u8` — **DRM channel decrypted on the server, plain HLS for VLC** (needs `cdm.py` running)
- `http://<host>:8090/api/keys/<channel-id>` — debug: hex content keys from sidecar (`?force=1` to bypass cache)
- `http://<host>:8090/play/<channel-id>` — in-browser Shaka player; works for DRM in Chrome/Edge (Widevine via license proxy)
- `http://<host>:8090/mosaic?ids=<id1>,<id2>,…` — grid of independent players, each its own audio-output picker
- `http://<host>:8090/api/stream/<channel-id>` — JSON `{manifestUrl, isDrm, licenseUrl}` for custom players
- `http://<host>:8090/license/<channel-id>` — Widevine license proxy (POST challenge → license bytes; injects upstream auth headers)

## DRM → VLC (server-side Widevine decrypt)

VLC doesn't speak Widevine, but if you have a Widevine **L3** device file you can decrypt server-side and serve plain HLS that VLC plays directly. The `/vlc` path now uses a local multi-step pipeline:

1. fetch the signed DRM MPD
2. resolve keys through `cdm.py`
3. download rolling audio/video fragments
4. decrypt them with `mp4decrypt`
5. feed decrypted audio/video into Shaka Packager
6. serve Shaka-generated live HLS to VLC

Capped at L3 quality (~720p on Voyo's mobile profile, which is what the headers in `voyo.ts` already pretend to be).

You need: `mp4decrypt` from Bento4, Shaka Packager, Python 3.10+, and an L3 `.wvd` device file (drop it next to the script as `l3.wvd`, or set `VOYO_CDM_DEVICE=/path/to/your.wvd`).

```sh
# one-time
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# every run — starts cdm.py then voyo.ts and tears both down on Ctrl+C
./start.sh
```

Shaka one-shot startup:

```sh
./start-shaka.sh
```

Or run them separately:

```sh
# terminal 1
python3 cdm.py

# terminal 2
deno run --allow-read --allow-write --allow-net --allow-env --allow-run voyo.ts
```

Shaka variant:

```sh
# terminal 2
deno run --allow-read --allow-write --allow-net --allow-env --allow-run voyo-shaka.ts
```

Then in VLC: open `http://<host>:8090/vlc/<channel-id>/index.m3u8`, or import `http://<host>:8090/live.m3u8` to get every channel (DRM included). Two or more concurrent channels are fine — each gets its own per-channel Shaka pipeline, cleaned up automatically after inactivity.

**Knobs:**

| env | default | what |
| --- | --- | --- |
| `VOYO_CDM_URL`  | `http://127.0.0.1:8091` | where `voyo.ts` looks for the sidecar |
| `VOYO_CDM_PORT` | `8091`                  | sidecar listen port |
| `VOYO_CDM_DEVICE` | `./l3.wvd`            | path to your L3 device file |
| `VOYO_MP4DECRYPT` | `mp4decrypt`          | Bento4 `mp4decrypt` binary path |
| `VOYO_SHAKA_PACKAGER` | `packager`         | Shaka Packager binary path for `voyo-shaka.ts` |
| `VOYO_UI_BASIC_AUTH_USER` | `adm`          | UI/browser Basic Auth username for `voyo-shaka.ts` |
| `VOYO_UI_BASIC_AUTH_PASS` | `fvoyo`        | UI/browser Basic Auth password for `voyo-shaka.ts` |

**Caveats:**
- L1 (HD/4K) is intentionally not supported — would require a rooted-Android TEE proxy, not worth the operational pain. Stick with L3.
- `mp4decrypt` and Shaka Packager are mandatory for the current VLC DRM path.
- The `.wvd` file is yours to provide — none ships here. `pip install pywidevine` then `pywidevine create-device -k private_key.pem -c client_id.bin -t ANDROID -l 3 -o .` if you have separate files.
- `live-shaka/` (transient Shaka output) is git-ignored; it's recreated under the config dir at runtime.

## OBS — 2 channels, separate audio, 2 platforms

OBS Browser Source ships **without** Widevine CDM, so DRM channels don't play inside OBS Browser Source. Use Window Capture on Chrome instead:

1. Install per-channel virtual audio devices:
   - **macOS**: [BlackHole](https://github.com/ExistentialAudio/BlackHole). Install twice with different names (`BlackHole-A`, `BlackHole-B`), or run the 16ch build and split channels. Create a Multi-Output Device in Audio MIDI Setup so you still hear them.
   - **Windows**: [VB-CABLE](https://vb-audio.com/Cable/) (free pack ships A + B).
2. Open **two Chrome windows**, one per channel: `/play/channel-A` and `/play/channel-B`.
3. In each window: click **Reveal devices** (grants mic perm so device names appear), then pick the matching virtual device from the 🔊 dropdown. The video element calls `setSinkId()` and audio is routed.
4. Launch **two OBS instances** (`open -na "OBS" --args --multi` on macOS; `--multiple` on Windows). Each instance: Window Capture → its Chrome window; Audio Input Capture → its virtual device. Stream to its platform.

For one-window monitoring use `/mosaic?ids=channel-A,channel-B` — same per-cell audio picker via iframes.

### Limits
- `setSinkId` is Chrome/Edge only (Firefox/Safari won't route per-element).
- DRM channels are flagged 🔒. In Chrome they play via `/play/<id>` (browser CDM). In VLC they play via `/vlc/<id>/index.m3u8` if the `cdm.py` sidecar is running with an L3 device.
- Widevine in desktop Chrome is L3 → max ~720p. The server-side path is also L3, same cap.
