# IPTV & VOD Media grabbing RO Providers

# Disclaimer

This script is not affiliated in any shape or form or commissioned/supported by
any providers used. For more information about their platforms, visit their
respective official website.

This script offers a way to retrieve the streams using the credentials PROVIDED
BY YOU.

THIS SCRIPT DOES NOT OFFER FREE IPTV.

THERE IS NO WARRANTY FOR THE SCRIPT, IT MIGHT NOT WORK AT ALL AND IT CAN BREAK
AND STOP WORKING AT ANY TIME.

---

This project is written in TypeScript and runs on Deno. It allows you to access
romanian media providers with the provided credentials and provides stream URLs
for the available media.

## Prerequisites

Before running this project, you must have Deno installed. You can download it
[here](https://deno.land/#installation).

## Providers

| Name        | Authentication Required |
| ----------- | ----------------------- |
| Digi24      | No                      |
| Digi-Online | Yes                     |
| AntenaPlay  | Yes                     |
| Voyo        | Yes                     |
| Pro-Plus    | Yes                     |

## Usage

See the [wiki](https://github.com/redmusicxd/iptvro_v2/wiki) for API
documentation

This service exposes a simple HTTP API.

Default URL (Docker): `http://127.0.0.1:8090`

### Install (Docker image)

Pull the image:

`docker pull ghcr.io/rednblkx/iptvro_v2:main`

Run it:

`docker run -d --name iptvro --restart unless-stopped --init -p 8090:3000 -v ./logs:/app/logs -v ./configs:/app/configs ghcr.io/rednblkx/iptvro_v2:main`

As the image runs as non-root user (UID 1000, GID 1000), you need to make sure
the `configs` and `logs` directories have the right permissions:

`mkdir -p configs logs && chown -R 1000:1000 configs logs`

### Install (build from git) – recommended for VPS

This repository includes a one-command installer that builds a local image and runs it:

`git clone https://github.com/ProXtech-pro/iptvro_v2.git && cd iptvro_v2`

`PORT=8090 NAME=iptvro CACHE_MAX_ENTRIES=2000 bash scripts/vps_reinstall.sh`

Then run diagnostics:

`bash scripts/check_iptv.sh 8090`

### Install (Deno, without Docker)

`deno run --allow-read --allow-write --allow-env --allow-net src/index.ts`

On first run, a `configs/` dir will be created with one `.json` per provider.

### VPS troubleshooting / reinstall (Docker)

Most VPS issues come from (1) port 3000 already used, (2) broken/old image, or (3) volume permissions (the container runs as UID/GID 1000).

- Ensure folders exist and are writable by UID 1000:
	- `mkdir -p configs logs`
	- `sudo chown -R 1000:1000 configs logs`
- Update to the latest image and restart:
	- `docker compose pull && docker compose up -d`
- Check if the container is restarting / unhealthy:
	- `docker compose ps`
	- `docker compose logs --tail=200 -f`
- If it fails to start, check if port 3000 is already in use:
	- `sudo lsof -i :3000` (or change the mapping in `docker-compose.yaml`, e.g. `8090:3000`)
- Quick endpoint check from the VPS host:
	- `curl -sS http://127.0.0.1:3000/modules | head`

If you paste the output of `docker compose ps` and the last ~200 lines from `docker compose logs --tail=200`, I can tell you exactly what broke.

### VPS reinstall from git (recommended)

If you want the latest fixes without waiting for the prebuilt GHCR image to update, build and run from this repository on your VPS:

- `git clone https://github.com/rednblkx/iptvro_v2.git && cd iptvro_v2`
- `bash scripts/vps_reinstall.sh`

This will build a local image, create/mount `configs/` + `logs/`, set UID/GID 1000 permissions, and run the container on port `8090`.

After install, run diagnostics:

- `bash scripts/check_iptv.sh 8090`

### AntenaPlay credentials (recommended)

AntenaPlay requires valid credentials.

- Set them in `configs/antena-play.json` under `auth.username` and `auth.password` (this avoids putting credentials in shell history).
- Do not commit real credentials into git; keep `configs/` only on the VPS and mount it into the container.

This repo ships an example file you can copy:

- `cp configs/antena-play.example.jsonc configs/antena-play.json`
- Edit `configs/antena-play.json` and fill `auth.username` + `auth.password` on the VPS only.
- Then refresh tokens via API:
	- `curl -sS -X POST -H 'content-type: application/json' -d '{}' http://localhost:8090/antena-play/login`
- Then update channels:
	- `curl -sS http://localhost:8090/antena-play/updatechannels`
- Validate:
	- `curl -sS http://localhost:8090/antena-play/live | head`

#### AntenaPlay 403 on VPS (common)

If `/antena-play/login` fails with an error like `no token, status 403` (or the upstream check in `scripts/check_iptv.sh` shows HTTP 403), AntenaPlay is likely blocking your VPS/datacenter IP range.

What to do:

- Try a different VPS provider/region (ideally different ASN), then re-run `bash scripts/check_iptv.sh 8090`.
- Use a VPN/proxy with residential egress (or run this app from your home connection).

Note: wrong credentials usually return HTTP 401, not 403.

---

## How to access Live channels

1) List supported modules:

`GET /modules`

2) (Recommended) refresh channel list after login:

`GET /<module>/updatechannels`

0) If the module requires authentication, login first:

`POST /<module>/login` (JSON body can be `{}` to use credentials from config, or `{ "username": "...", "password": "..." }`)

3) Get the live channel list (JSON):

`GET /<module>/live`

4) IPTV playlist (M3U) for all live channels in that module:

`GET /<module>/live/index.m3u8`

Use this URL directly in IPTV players (VLC, Kodi, IPTV Smarters, etc.).

5) One channel stream (HLS):

`GET /<module>/live/<channel>/index.m3u8`

6) Open the built-in web player:

`GET /<module>/live/<channel>/index.m3u8/player`

Notes:

- Some providers return HLS playlists that require rewriting. You can request playlist rewriting via:
	`GET /<module>/live/<channel>/index.m3u8?cors=1`
- The service also provides a simple CORS proxy endpoint:
	`/cors/<url>`

Example (AntenaPlay on port 8090):

- `http://<server-ip>:8090/antena-play/live/index.m3u8`
- `http://<server-ip>:8090/antena-play/live/antena1/index.m3u8`

---

## How to access VOD

1) List shows for a module:

`GET /<module>/vod`

For AntenaPlay, each item includes:

- `categoryRaw`: category string reported by the upstream API
- `category`: a simplified group derived from `categoryRaw` (e.g. `filme`, `seriale`, `emisiuni`)

2) Get episodes for one show:

`GET /<module>/vod/<showId>`

3) Get one episode stream (JSON):

`GET /<module>/vod/<showId>/<episodeId>`

4) Get one episode as HLS playlist (for players):

`GET /<module>/vod/<showId>/<episodeId>/index.m3u8`

5) Open the built-in web player:

`GET /<module>/vod/<showId>/<episodeId>/index.m3u8/player`

Tip: You can discover `<showId>` and `<episodeId>` by calling `/vod` and then `/vod/<showId>`.

Example (AntenaPlay on port 8090):

- `http://<server-ip>:8090/antena-play/vod`

### Python: build a VOD library + download MP4

If you want an exported VOD library (films/series, seasons/episodes), cached API collection, and optional MP4 downloads via `ffmpeg`, see:

- `scripts/python/README.md`

---

## Module info

`GET /<module>` returns basic info about the module and the cached channel list (`chList`).

## Caching

The service stores some cached data in `configs/cache.json`. To avoid memory issues on long-running VPS deployments, use the environment variable:

- `CACHE_MAX_ENTRIES` (default 2000)

You can flush cache via:

- `GET /<module>/clearcache` or `GET /clearcache`

## Security note

This API does not implement authentication for clients. If you expose it to the public internet, anyone who can reach it can use your configured provider credentials. Prefer keeping it private (LAN/VPN) or putting it behind a reverse proxy with authentication.

## Permissions

Deno needs the following permissions to run this project:

- `--allow-read`: Allows the application to read files.
- `--allow-write`: Allows the application to write files.
- `--allow-env`: Allows the application to access environment variables.
- `--allow-net`: Allows the application to make network requests.

## Contributing

If you'd like to contribute to this project, please fork the repository and
create a pull request with your changes.

## License

This project is licensed under the MIT license. See the [LICENSE](LICENSE) file
for more details.
