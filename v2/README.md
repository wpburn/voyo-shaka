# Voyo Live (v2)

Single-file Deno 2 server that exposes Voyo Romania live channels as plain HLS playlists for VLC/IPTV apps.

## Run

```sh
cd v2
deno run --allow-read --allow-write --allow-net --allow-env --allow-run voyo.ts
```

`--allow-run` is only needed for experimental helper paths. The normal server works for non-DRM channels and the in-browser Shaka player.

Or build a standalone binary (no Deno required at runtime):

```sh
deno compile --allow-read --allow-write --allow-net --allow-env --output voyo voyo.ts
./voyo
```

Open <http://localhost:8090>. `voyo.json` is read/written next to the executable (or next to the script in dev mode); override with `VOYO_CONFIG_DIR=/path/to/dir`, change port with `VOYO_PORT=9000`. On first run it migrates credentials from `../configs/voyo.json` if present, otherwise it creates an empty `voyo.json` — fill in `credentials.username` / `credentials.password` and restart.

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

VLC doesn't speak Widevine, but if you have a Widevine **L3** device file you can decrypt server-side and serve plain HLS that VLC plays directly. Capped at L3 quality (~720p on Voyo's mobile profile, which is what the headers in `voyo.ts` already pretend to be).

You need: `ffmpeg` on PATH, Python 3.10+, and an L3 `.wvd` device file (drop it next to the script as `l3.wvd`, or set `VOYO_CDM_DEVICE=/path/to/your.wvd`).

```sh
# one-time
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# every run — starts cdm.py then voyo.ts and tears both down on Ctrl+C
./start.sh
```

Or run them separately:

```sh
# terminal 1
python3 cdm.py

# terminal 2
deno run --allow-read --allow-write --allow-net --allow-env --allow-run voyo.ts
```

Then in VLC: open `http://<host>:8090/vlc/<channel-id>/index.m3u8`, or import `http://<host>:8090/live.m3u8` to get every channel (DRM included). Two or more concurrent channels are fine — each gets its own ffmpeg, killed automatically after 60s of nobody pulling segments.

**Knobs:**

| env | default | what |
| --- | --- | --- |
| `VOYO_CDM_URL`  | `http://127.0.0.1:8091` | where `voyo.ts` looks for the sidecar |
| `VOYO_CDM_PORT` | `8091`                  | sidecar listen port |
| `VOYO_CDM_DEVICE` | `./l3.wvd`            | path to your L3 device file |
| `VOYO_FFMPEG`   | `ffmpeg`                | ffmpeg binary path |

**Caveats:**
- L1 (HD/4K) is intentionally not supported — would require a rooted-Android TEE proxy, not worth the operational pain. Stick with L3.
- `ffmpeg -decryption_key` accepts a single key. If you hit a Voyo channel with separate audio/video KIDs, swap ffmpeg for `shaka-packager` in the `startPipe` function (commented hint in `voyo.ts`).
- The `.wvd` file is yours to provide — none ships here. `pip install pywidevine` then `pywidevine create-device -k private_key.pem -c client_id.bin -t ANDROID -l 3 -o .` if you have separate files.
- `live/` (transient HLS chunks) is git-ignored; it's recreated under the config dir at runtime.

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
