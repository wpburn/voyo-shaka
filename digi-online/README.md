# Digi Online Live

Standalone Digi Online live TV app. It runs separately from the Voyo v2 server and FocusSat app, and defaults to port `8093`.

## Setup

1. Copy `env.example` to `.env`.
2. Set `DIGI_ONLINE_USER` and `DIGI_ONLINE_PASS`.
3. Confirm the local CDM sidecar is running, usually at `http://127.0.0.1:8091`, when testing DRM-to-HLS output.
4. Install or configure:
   - `DIGI_ONLINE_MP4DECRYPT` for Bento4 `mp4decrypt`
   - `DIGI_ONLINE_SHAKA_PACKAGER` for Shaka Packager
   - a Widevine L3 device file for the CDM sidecar

Do not commit `.env`, Widevine device files, registered device/session files, channel caches, generated HLS output, decrypted fragments, or logs. This folder ignores those runtime artifacts locally.

## Environment

```env
DIGI_ONLINE_USER=your-digi-username
DIGI_ONLINE_PASS=your-digi-password
DIGI_ONLINE_PORT=8093
DIGI_ONLINE_CDM_URL=http://127.0.0.1:8091
DIGI_ONLINE_MP4DECRYPT=mp4decrypt
DIGI_ONLINE_SHAKA_PACKAGER=packager
DIGI_ONLINE_DATA_DIR=./data
```

The app stores `session.json`, `channels.json`, generated live output, decrypted fragments, and logs below `DIGI_ONLINE_DATA_DIR` unless a different path is configured.

## Run

```sh
cd digi-online
./start.sh
```

Equivalent Deno command:

```sh
deno run --allow-read --allow-write --allow-net --allow-env --allow-run main.ts
```

Open `http://127.0.0.1:8093`.

## Endpoints

- `GET /` channel UI
- `POST /api/login` explicit Digi device registration refresh
- `GET /api/channels?force=1` channel catalog refresh
- `GET /api/stream/{id}` stream metadata for browser playback
- `GET /play/{id}` Shaka player page
- `POST /license/{id}` Widevine license proxy
- `GET /live.m3u8` combined IPTV playlist
- `GET /vlc/{id}/index.m3u8` server-side DRM-to-HLS output

## CDM Sidecar

Start the CDM helper separately. The existing Voyo helper can be reused when it exposes:

- `GET /health`
- `POST /keys` with JSON `{ "pssh": "...", "licenseUrl": "...", "headers": {} }`

Place the Widevine L3 `.wvd` file where the CDM helper expects it. Do not commit it to this folder.

## Verification

With valid Digi credentials:

```sh
curl -X POST http://127.0.0.1:8093/api/login
curl http://127.0.0.1:8093/api/channels
curl http://127.0.0.1:8093/live.m3u8
```

Use a channel ID returned by `/api/channels`:

```sh
curl "http://127.0.0.1:8093/api/stream/{id}"
open "http://127.0.0.1:8093/play/{id}"
curl "http://127.0.0.1:8093/vlc/{id}/index.m3u8"
```

Browser playback requires a Widevine-capable browser for DRM channels. VLC/IPTV DRM output requires the CDM sidecar, `mp4decrypt`, and Shaka Packager.
