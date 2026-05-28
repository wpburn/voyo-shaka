# Python VOD export

This folder contains a small client that talks to the running IPTVRO_V2 API and exports VOD lists.

## What it does

- Calls `POST /{module}/login`
- Calls `GET /{module}/updatechannels`
- Collects all pages from `GET /{module}/vod?page=N` (or search mode)
- Optional: fetches episodes per show and builds a **library** structure (films/series, seasons/episodes)
- Optional: fetches **stream URL** per episode (for download/ffmpeg)
- Exports:
  - `out/{module}_vod_shows.json`
  - `out/{module}_vod_by_category.json`
  - `out/{module}_vod_shows.csv`
  - `out/{module}_vod_library.json` (when `--with-episodes`)
  - `out/{module}_vod_streams_by_episode.json` (when `--with-streams`)

## Cache (important)

By default the script uses a disk cache to minimize requests:

- Default cache dir: `out/.cache`
- Default TTL: 6 hours

Disable cache:

```powershell
python vod_export.py --no-cache ...
```

## Windows quick start

From a PowerShell terminal:

```powershell
cd scripts\python
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python vod_export.py --base-url http://SERVER_IP:8090 --module antena-play --out-dir out
```

## Recommended flow (library + links + MP4)

1) Build the library (fetch all episodes; best for film/serial classification):

```powershell
python vod_export.py --base-url http://SERVER_IP:8090 --module antena-play --out-dir out --with-episodes --episodes-max-pages 0
```

2) Also fetch stream links (cached):

```powershell
python vod_export.py --base-url http://SERVER_IP:8090 --module antena-play --out-dir out --with-episodes --episodes-max-pages 0 --with-streams
```

3) Download/remux MP4 using ffmpeg (start with a small limit first):

```powershell
python vod_export.py --base-url http://SERVER_IP:8090 --module antena-play --out-dir out --with-episodes --episodes-max-pages 0 --with-streams --download-mp4 --media-dir out\media --max-downloads 10
```

Optional (also fetch a few pages of episodes per show):

```powershell
python vod_export.py --base-url http://SERVER_IP:8090 --module antena-play --out-dir out --with-episodes --episodes-max-pages 2
```

Fetch ALL episode pages per show (recommended for correct film/serial classification):

```powershell
python vod_export.py --base-url http://SERVER_IP:8090 --module antena-play --out-dir out --with-episodes --episodes-max-pages 0
```

Fetch episodes + stream URLs (more requests, but cached):

```powershell
python vod_export.py --base-url http://SERVER_IP:8090 --module antena-play --out-dir out --with-episodes --with-streams
```

Download/remux to MP4 with ffmpeg (on the machine that runs this script):

```powershell
python vod_export.py --base-url http://SERVER_IP:8090 --module antena-play --out-dir out --with-episodes --with-streams --download-mp4 --media-dir out\media --max-downloads 10
```

## Linux quick start (server)

```bash
cd scripts/python
python3 -m pip install -r requirements.txt
python3 vod_export.py --base-url http://127.0.0.1:8090 --module antena-play --out-dir out --with-episodes --episodes-max-pages 0 --with-streams
```

## Notes

- Credentials are **not** passed from this script. The server reads them from its `configs/antena-play.json`.
- If the API is exposed publicly, protect it (reverse proxy auth / VPN), because `/{module}/login` triggers provider login.

## Grouping logic

- Heuristic: a show with 1 episode is treated as **film**, otherwise **serial**.
- Seasons/episodes are derived from the episode title where possible (patterns like `S01E02`, `Sezon 1 Episodul 2`).
