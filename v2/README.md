# Voyo Live (v2)

Single-file Deno 2 server that exposes Voyo Romania live channels as plain HLS playlists for VLC/IPTV apps.

## Run

```sh
cd v2
deno run --allow-read --allow-write --allow-net --allow-env voyo.ts
```

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

- `http://<host>:8090/` — channel list + copy buttons
- `http://<host>:8090/live.m3u8` — combined VLC playlist
- `http://<host>:8090/live/<channel-id>.m3u8` — single channel
- DRM channels are flagged 🔒 but copy is allowed; non-DRM-aware players will fail to decode them.
