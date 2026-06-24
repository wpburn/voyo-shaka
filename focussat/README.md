# FocusSat Live

Standalone FocusSat/Solocoo live TV app. It runs separately from the Voyo v2 server and defaults to port `8092`.

## Setup

1. Copy `env.example` to `.env`.
2. Set `FOCUSSAT_USER` and `FOCUSSAT_PASS`.
3. Confirm the local CDM sidecar is running, usually at `http://127.0.0.1:8091`.
4. Install or configure:
   - `FOCUSSAT_MP4DECRYPT` for Bento4 `mp4decrypt`
   - `FOCUSSAT_SHAKA_PACKAGER` for Shaka Packager
   - a Widevine L3 device file for the CDM sidecar

Do not commit `.env`, Widevine device files, token files, generated HLS output, or logs. This folder ignores those runtime artifacts locally.

## Run

```sh
cd focussat
./start.sh
```

Equivalent Deno command:

```sh
deno run --allow-read --allow-write --allow-net --allow-env --allow-run main.ts
```

Open `http://127.0.0.1:8092`.

## Quality Profile Testing

The default Solocoo identity is an Android phone profile. To test whether the
upstream manifest offers a higher ladder for Android TV, set:

```env
FOCUSSAT_DEVICE_PROFILE=androidtv
FOCUSSAT_ANDROIDTV_DEVICE_TYPE=STB
FOCUSSAT_PLAYER_NAME=Shaka Player
FOCUSSAT_PLAYER_VERSION=4.15.8
FOCUSSAT_PLAYER_SMART_LIB=true
FOCUSSAT_PLAYER_LIVE=true
```

Restart the FocusSat app and force a fresh login:

```sh
curl -X POST http://127.0.0.1:8092/api/login
curl 'http://127.0.0.1:8092/api/stream/JaZvThH1csARoKTtTBhLWS3PXaC9B93PaNaFu8S0?force=1'
curl http://127.0.0.1:8092/vlc/JaZvThH1csARoKTtTBhLWS3PXaC9B93PaNaFu8S0/index.m3u8
ffprobe -v error -show_entries stream=index,codec_type,width,height,bit_rate -of json \
  http://127.0.0.1:8092/vlc/JaZvThH1csARoKTtTBhLWS3PXaC9B93PaNaFu8S0/index.m3u8
```

Compare the `RESOLUTION=` line in the HLS master and the `ffprobe` video
height against the default `phone` profile. The app stores the profile in the
session file, so changing `FOCUSSAT_DEVICE_PROFILE` automatically causes the
next auth refresh to provision a matching device.

If Android TV returns `session failed: HTTP 400`, Solocoo is rejecting that
device payload for session creation. If the diagnostic mentions
`provisionData missing or invalid`, restart the app after updating to the
latest code because the app now forwards provision data into `/v1/session`.
If the diagnostic says `deviceType` could not be converted, try these values
one at a time:

```env
FOCUSSAT_ANDROIDTV_DEVICE_TYPE=STB
FOCUSSAT_ANDROIDTV_DEVICE_TYPE=SetTopBox
FOCUSSAT_ANDROIDTV_DEVICE_TYPE=AndroidSTB
FOCUSSAT_ANDROIDTV_DEVICE_TYPE=SmartTV
FOCUSSAT_ANDROIDTV_DEVICE_TYPE=TV
```

If Android TV still returns HTTP 400, treat that auth device profile as
unsupported for this account/API flow and test the player/capability payload
independently by reverting only:

```env
FOCUSSAT_DEVICE_PROFILE=phone
```

and keeping:

```env
FOCUSSAT_PLAYER_NAME=Shaka Player
FOCUSSAT_PLAYER_VERSION=4.15.8
FOCUSSAT_PLAYER_SMART_LIB=true
FOCUSSAT_PLAYER_LIVE=true
```

## Endpoints

- `GET /` channel UI
- `POST /api/login` explicit login/session refresh
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

Place the Widevine L3 `.wvd` file where the CDM helper expects it, not in this folder unless it stays ignored.
