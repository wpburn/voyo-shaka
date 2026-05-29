# Voyo Shaka Plan

## Goal

Create a new `voyo-shaka.ts` alongside the existing `voyo.ts`.

The new file should:

- keep the working browser flow unchanged
- keep the existing Voyo auth/channel/stream resolution behavior
- implement the VLC DRM path with Shaka Packager instead of the current custom packaging path
- be simpler than the current `voyo.ts`
- isolate the Shaka-specific logic so it is easier to debug, test, and move to Linux or Docker
- require HTTP Basic Auth on UI/browser pages with:
  - username: `adm`
  - password: `fvoyo`
- keep direct stream URLs unauthenticated so VLC/IPTV clients can play them without credentials

The purpose of `voyo-shaka.ts` is not to replace `voyo.ts` immediately.
It is a clean second implementation focused on a smaller, better-defined DRM packaging path.

## Current Baseline

### Confirmed working today

- Non-DRM browser playback works.
- DRM browser playback works in Chrome/Edge through the Widevine license proxy.
- `cdm.py` works and returns usable content keys.
- The current server-side DRM path now works in VLC.

### Why still build `voyo-shaka.ts`

- The current `voyo.ts` accumulated multiple implementation pivots while proving the DRM path.
- The current file mixes:
  - auth/session logic
  - browser routes
  - non-DRM HLS passthrough
  - DRM download/decrypt logic
  - local playlist generation
- A second implementation is the right place to simplify the DRM packaging path without destabilizing the working baseline.

## Main Design Decision

Use Shaka Packager as the HLS packager for the DRM VLC flow.

### Why Shaka Packager

- It is purpose-built for DASH/HLS packaging.
- It has first-class live packaging support.
- It supports raw-key decryption/encryption workflows.
- It accepts regular files, pipes, and UDP streams as inputs.
- It is a better long-term packaging dependency than continuing to hand-maintain live HLS playlists.

### Important limitation

Shaka Packager is not an MPD client in the way we need here.
The official input model is stream descriptors over files, pipes, or UDP streams, not "consume a remote Widevine MPD and fetch/decrypt it for me."

That means `voyo-shaka.ts` still needs to own:

1. stream resolution from Voyo
2. MPD parsing
3. key retrieval from `cdm.py`
4. fragment download
5. fragment decryption

Shaka Packager should only own:

6. packaging local decrypted elementary MP4/fMP4 inputs into HLS

This is the key architecture rule for the rewrite.

## Non-Goals

- Do not rewrite `cdm.py`.
- Do not redesign browser DRM playback.
- Do not replace the existing `voyo.ts` during the first pass.
- Do not add multi-quality ABR packaging in the first implementation.
- Do not optimize for low-latency HLS in the first implementation.
- Do not containerize until the new Shaka path is proven locally.

## File Strategy

Add a new file:

- `v2/voyo-shaka.ts`

Keep existing files:

- `v2/voyo.ts`
- `v2/cdm.py`
- `v2/start.sh`

Recommended follow-up once `voyo-shaka.ts` is stable:

- extract shared auth/config/Voyo API helpers into a small shared module
- keep the DRM packaging path split by runtime:
  - `voyo.ts` as the proven baseline
  - `voyo-shaka.ts` as the cleaner Shaka-based path

For the first implementation, duplication is acceptable if it keeps `voyo-shaka.ts` easier to reason about.

## Access Control Requirement

`voyo-shaka.ts` must enforce HTTP Basic Auth only for interactive UI/browser-facing routes.

### Protect with Basic Auth

- `GET /`
- `GET /play/:id`
- `GET /mosaic`
- `GET /api/channels`
- `POST /api/login`
- `GET /api/stream/:id`
- optional debug routes such as:
  - `/api/keys/:id`
  - `/api/drm-state/:id`
  - `/api/drm-manifest/:id`
  - `/api/drm-log/:id`

### Do not protect

- `GET /live.m3u8`
- `GET /live/:id.m3u8`
- `GET /vlc/:id/index.m3u8`
- sibling media files under `/vlc/:id/...`
- `POST /license/:id`

### Why this split exists

- browsers and humans should not expose the UI accidentally
- VLC, IPTV apps, and HLS clients should not need credentials
- the Widevine browser flow must continue to work once the UI authenticates and loads the player page

### Implementation rule

Do not scatter auth checks through route bodies.
Add one small helper:

- `isUiProtectedRoute(path, method)`
- `requireBasicAuth(req)`

And gate protected routes near the top of the request handler.

### Credentials

Hardcode for the first version exactly as requested:

- username: `adm`
- password: `fvoyo`

Recommended follow-up after the first working version:

- allow override through environment variables
- keep the same defaults for local compatibility

## Route Surface

`voyo-shaka.ts` should expose the same core public routes as `voyo.ts` where practical:

- `GET /`
- `GET /api/channels`
- `POST /api/login`
- `GET /api/stream/:id`
- `POST /license/:id`
- `GET /play/:id`
- `GET /mosaic`
- `GET /live/:id.m3u8`
- `GET /live.m3u8`
- `GET /vlc/:id/index.m3u8`

Optional debug routes for the Shaka rewrite:

- `GET /api/keys/:id`
- `GET /api/drm-state/:id`
- `GET /api/drm-manifest/:id`
- `GET /api/drm-log/:id`

The public VLC URL must remain:

- `/vlc/<channel-id>/index.m3u8`

That preserves compatibility with VLC, IPTV apps, and existing bookmarks.

## Target Architecture

### High-level flow

For a DRM channel request:

1. Resolve stream info from Voyo.
2. Fetch the MPD.
3. Parse the selected audio/video representations.
4. Ask `cdm.py` for content keys.
5. Create a local working directory for the channel.
6. Download init segments and rolling encrypted media fragments.
7. Decrypt those fragments with `mp4decrypt`.
8. Feed the decrypted streams into Shaka Packager.
9. Let Shaka generate and maintain the HLS playlists.
10. Serve Shaka’s output files under `/vlc/<id>/...`.

### Separation of responsibilities

`voyo-shaka.ts` should have four clear layers:

1. Core Voyo layer
   - login
   - session refresh
   - channel listing
   - stream resolution

2. Browser layer
   - `/play`
   - `/license`
   - `/api/stream`
   - `/mosaic`

3. DRM acquisition layer
   - MPD parsing
   - key retrieval
   - fragment download
   - fragment decryption

4. Packaging layer
   - named pipes or local rolling inputs
   - Shaka Packager process management
   - HLS output serving

This split is mandatory.
The rewrite should not bury Shaka process orchestration inside route handlers.

## Recommended Shaka Input Model

### Preferred approach: named pipes per track

Use two named pipes:

- one for decrypted video input
- one for decrypted audio input

For each channel:

1. create a working directory
2. create `video.pipe` and `audio.pipe`
3. start one Shaka Packager process bound to those two inputs
4. write:
   - decrypted init segment first
   - then decrypted media fragments in chronological order
5. let Shaka generate:
   - `index.m3u8`
   - `video.m3u8`
   - `audio.m3u8`
   - local fMP4 HLS segments

### Why this is the preferred design

- It matches Shaka Packager’s supported input model.
- It gives Shaka a continuous stream, which is what live packaging expects.
- It avoids asking Shaka to interpret a synthetic MPD.
- It moves HLS playlist correctness to the packager.
- It keeps the local server responsible only for acquisition/decryption.

### Avoid in the first version

- Periodically restarting Shaka Packager for every fragment batch
- Feeding Shaka a synthetic MPD
- Reconstructing full flat MP4 files on every update
- Reusing `ffmpeg` as an intermediate pipe unless Shaka proves unable to read the chosen stream form

## Packaging Output Model

Shaka Packager should own the HLS output directory for each DRM channel.

Per channel, expected outputs:

- `index.m3u8`
- `audio.m3u8`
- `video.m3u8`
- init files
- HLS media segments

The HTTP server should only:

- ensure the pipeline exists on playlist request
- update last-access timestamps
- serve files from the channel work directory

The server should not rewrite Shaka-generated HLS playlists.

## Tooling

### Keep

- Deno for the server
- `cdm.py` for Widevine license exchange and key extraction
- `mp4decrypt` for content decryption

### Add

- Shaka Packager executable, expected as `packager`

### Environment variables

Required or recommended:

- `VOYO_CONFIG_DIR`
- `VOYO_PORT`
- `VOYO_CDM_URL`
- `VOYO_CDM_PORT`
- `VOYO_CDM_DEVICE`
- `VOYO_MP4DECRYPT`
- `VOYO_SHAKA_PACKAGER`
- `VOYO_UI_BASIC_AUTH_USER`
- `VOYO_UI_BASIC_AUTH_PASS`

Suggested default:

- `VOYO_SHAKA_PACKAGER=packager`
- `VOYO_UI_BASIC_AUTH_USER=adm`
- `VOYO_UI_BASIC_AUTH_PASS=fvoyo`

Startup validation should fail early if:

- `cdm.py` is unreachable
- `mp4decrypt` is missing
- Shaka Packager is missing

## Data Model For `voyo-shaka.ts`

Recommended internal types:

- `Channel`
- `StreamInfo`
- `ContentKey`
- `ParsedMpd`
- `Representation`
- `DrmChannelState`
- `ShakaPipeline`

Recommended `DrmChannelState` fields:

- `channelId`
- `workDir`
- `streamInfo`
- `keys`
- `audioRepresentation`
- `videoRepresentation`
- `lastAccess`
- `createdAt`
- `lastRefreshAt`
- `lastError`
- `downloadLoopState`
- `packagerProcess`
- `pipePaths`
- `outputFiles`

## Implementation Plan

### Phase 1: Create `voyo-shaka.ts` Skeleton

Tasks:

- Copy only the minimum stable baseline from `voyo.ts`.
- Keep:
  - config loading
  - login/session refresh
  - channel listing
  - stream resolution
  - browser routes
  - non-DRM `/live` passthrough
- Omit all current DRM packaging logic from the copy.
- Add a placeholder `/vlc` implementation that returns `501 Not Implemented` until the Shaka pipeline is wired.
- Add the Basic Auth gate for protected UI/browser routes.

Success criteria:

- `voyo-shaka.ts` starts cleanly.
- Browser routes still work.
- Non-DRM VLC path still works.
- DRM VLC path is isolated and empty rather than partially implemented.
- Protected pages challenge for credentials.
- Public stream URLs remain accessible without credentials.

### Phase 2: Extract Shared DRM Acquisition Helpers

Tasks:

- Reuse or cleanly port:
  - PSSH extraction
  - key retrieval from `cdm.py`
  - stream cache
  - MPD fetch
- Rewrite the MPD parser with a smaller scope:
  - only support the live Voyo MPD shape actually observed
  - one video rep
  - one audio rep
- Keep the parser in a dedicated section or module.

Success criteria:

- Given a DRM channel, the code can produce:
  - manifest URL
  - license URL
  - selected audio/video reps
  - init URLs
  - media segment URLs
  - keys

### Phase 3: Build Local DRM Work Directory Model

Tasks:

- Create one directory per active DRM channel.
- Keep deterministic filenames.
- Add subpaths for:
  - encrypted fragments
  - decrypted fragments
  - Shaka inputs
  - Shaka outputs
  - logs
- Add bounded retention rules.

Recommended layout:

- `live-shaka/<channel-id>/enc/...`
- `live-shaka/<channel-id>/dec/...`
- `live-shaka/<channel-id>/pipes/...`
- `live-shaka/<channel-id>/out/...`
- `live-shaka/<channel-id>/logs/...`

Success criteria:

- All channel-local state lives in one directory tree.
- Cleanup can remove one channel without side effects.

### Phase 4: Implement Download + Decrypt Loop

Tasks:

- Download encrypted init segments.
- Download encrypted media fragments on a rolling basis.
- Decrypt init segments.
- Decrypt media fragments using:
  - `--key <kid>:<key>`
  - `--fragments-info <init-file>`
- Preserve chronological ordering.
- Detect duplicate segment URLs or sequence numbers.
- Refresh the signed stream URL when needed.

Success criteria:

- The pipeline produces valid local decrypted audio/video fragments continuously.

### Phase 5: Implement Shaka Input Feed

Tasks:

- Create named pipes for audio and video.
- Start a single Shaka Packager process per active channel.
- Feed:
  - init first
  - fragments in order
- Ensure the writer side handles:
  - backpressure
  - slow consumer behavior
  - broken pipe detection
- Keep writes single-threaded per track to preserve order.

Success criteria:

- A running channel continuously feeds valid audio/video input into Shaka Packager.

### Phase 6: Implement Shaka Packager Process Management

Tasks:

- Add `VOYO_SHAKA_PACKAGER` lookup.
- Validate the binary at startup.
- Build an explicit command generator.
- Capture stdout/stderr into per-channel logs.
- Restart or rebuild the channel pipeline only on well-defined failure classes.

Expected Shaka outputs:

- HLS master playlist
- HLS media playlists
- fMP4 media segments

Success criteria:

- The packager process starts reproducibly.
- Output files appear in the channel output directory.
- `/vlc/<id>/index.m3u8` serves the Shaka-generated master playlist.

### Phase 7: Route Integration

Tasks:

- On `GET /vlc/<id>/index.m3u8`:
  - resolve channel
  - ensure the channel pipeline exists
  - wait for the first usable playlist
  - serve the playlist
- For sibling output files:
  - serve directly
  - reject path traversal
- Do not create any special-case internal manifest route unless it is strictly required.

Success criteria:

- VLC can open the public URL and read only generated output files.
- UI routes still require Basic Auth and stream URLs still do not.

### Phase 8: Reliability

Tasks:

- Add stale-pipeline cleanup.
- Add signed-URL refresh behavior.
- Add graceful shutdown.
- Avoid deleting files while the packager or downloader still references them.
- Keep per-channel log summaries.
- Make all failure messages specific.

Failure categories to log explicitly:

- MPD parse failure
- key fetch failure
- download failure
- decrypt failure
- pipe write failure
- packager start failure
- packager exit
- playlist readiness timeout

Success criteria:

- The channel can run continuously for normal VLC usage.
- The server can recover from transient Voyo URL expiry.

### Phase 9: Validation Matrix

Test locally on macOS first.

Required checks:

- UI root prompts for credentials
- `/play/<id>` prompts for credentials in a browser
- `/live.m3u8` opens without credentials
- `/vlc/channel-179/index.m3u8` opens without credentials
- browser non-DRM playback
- browser DRM playback
- non-DRM VLC playback
- DRM VLC playback for `channel-179`
- two concurrent DRM channels
- idle cleanup and re-open
- stale signed URL refresh
- full restart of `voyo-shaka.ts`

Success criteria:

- The new file is operationally trustworthy, not just technically functional.

### Phase 10: Cutover Criteria

Do not switch users from `voyo.ts` to `voyo-shaka.ts` until all are true:

- `channel-179` plays reliably in VLC
- repeated restarts are stable
- concurrent channels are stable
- logs are understandable
- no manual intervention is required during normal playback

At that point, decide one of:

- keep both files permanently
- replace `voyo.ts`
- extract shared code and keep both runtimes

## Recommended Command Shape

The final Shaka command should be generated by code, not handwritten inline in multiple places.

The plan should assume one audio input and one video input.

Command concerns to encode explicitly:

- input descriptors
- HLS playlist names
- output directory
- segment template
- live playlist settings
- log verbosity

Do not scatter command fragments across the code.

## Logging Plan

Each channel should have:

- in-memory state summary
- structured server logs
- optional per-channel text log file

Useful log events:

- pipeline create
- stream resolve
- MPD parse summary
- key count
- selected reps
- init download complete
- segment download complete
- segment decrypt complete
- Shaka started
- first playlist ready
- idle cleanup
- failure + reason

## Error Handling Rules

- Fail early on missing binaries.
- Fail early on unknown DRM channel IDs.
- Retry only on transient network and signed-URL issues.
- Do not retry infinitely on deterministic parse/decrypt failures.
- Keep errors channel-local whenever possible.
- Never let one bad channel kill the whole server.

## Simplicity Rules For `voyo-shaka.ts`

To keep this rewrite simpler than `voyo.ts`:

- Support only one audio representation initially.
- Support only one video representation initially.
- Support only one DRM channel shape initially.
- Avoid premature module splitting if it hides the execution flow.
- Prefer explicit state transitions over clever abstractions.
- Prefer one responsible code path over fallback layers.
- Prefer clear process supervision over implicit retries.

## Risks

### Risk 1: Shaka input expectations do not match decrypted fragment feed

Mitigation:

- prototype with named pipes first
- if needed, fall back to a growing local fragmented MP4 input file per track

### Risk 2: Voyo live timeline quirks

Mitigation:

- keep initial implementation scoped to the proven channel shape
- log raw timeline decisions clearly

### Risk 3: Overcomplicating the rewrite

Mitigation:

- keep `voyo-shaka.ts` as a narrow runtime
- reuse only stable helpers
- do not re-implement browser UX beyond parity

### Risk 4: Toolchain drift across macOS and Linux

Mitigation:

- validate binary presence on startup
- keep paths configurable
- test the same pipeline structure on Linux only after macOS is stable

## Docker Plan

Docker is a required deliverable for the Shaka rewrite, but only after the local macOS implementation is proven.

The Docker goal is:

- build one image containing every runtime dependency needed by `voyo-shaka.ts`
- mount only secrets/config/work data from the host
- start one container and have the stream URLs play without additional setup inside the container

### Required contents of the image

- Deno runtime
- Python 3
- `pywidevine` dependencies from `requirements.txt`
- Bento4 `mp4decrypt`
- Shaka Packager binary
- the app files:
  - `voyo-shaka.ts`
  - `cdm.py`
  - `requirements.txt`
  - any shared helper modules added during the rewrite

### What should remain mounted from the host

- `.wvd` device file
- persistent config dir
- persistent live work dir

### Required container behavior

- one container command should start both:
  - the CDM sidecar
  - `voyo-shaka.ts`
- startup should fail fast if:
  - the `.wvd` file is missing
  - `packager` is missing
  - `mp4decrypt` is missing
- the server should bind on `0.0.0.0`
- the container should expose the main app port
- the sidecar should remain internal to the container unless debugging explicitly needs it exposed

### Recommended Docker structure

Files to add:

- `v2/Dockerfile.shaka`
- `v2/docker-compose.shaka.yml`
- `v2/entrypoint-shaka.sh`
- `v2/.dockerignore`

### Recommended image build approach

- start from a Debian or Ubuntu base, not Alpine
- install:
  - Python
  - pip
  - curl/unzip or tar tooling
  - Shaka Packager
  - Bento4 binaries
  - Deno
- install Python deps from `requirements.txt`
- copy app code into the image
- use a small shell entrypoint that:
  - validates env vars and mounted files
  - starts `cdm.py`
  - waits for sidecar health
  - starts `voyo-shaka.ts`

### Required runtime mounts

- config mount, for example:
  - `/app/data/config`
- work mount, for example:
  - `/app/data/live-shaka`
- `.wvd` mount, for example:
  - `/app/secrets/l3.wvd`

### Required environment variables in Docker

- `VOYO_CONFIG_DIR`
- `VOYO_CDM_DEVICE`
- `VOYO_CDM_URL`
- `VOYO_CDM_PORT`
- `VOYO_MP4DECRYPT`
- `VOYO_SHAKA_PACKAGER`
- `VOYO_UI_BASIC_AUTH_USER`
- `VOYO_UI_BASIC_AUTH_PASS`

### Required default Docker auth behavior

The Docker setup should preserve the same UI auth policy:

- UI pages require Basic Auth
- direct stream URLs remain unauthenticated

### Docker validation checklist

- `docker compose up` starts cleanly
- opening `/` prompts for `adm` / `fvoyo`
- opening `/play/<id>` after auth works in browser
- opening `/live.m3u8` does not ask for credentials
- opening `/vlc/channel-179/index.m3u8` in VLC does not ask for credentials
- restarting the container preserves mounted config and work data
- replacing the mounted `.wvd` does not require rebuilding the image

Include:

- Deno
- Python
- `pywidevine` dependencies
- Bento4 `mp4decrypt`
- Shaka Packager

Mount:

- `.wvd` device file
- config dir
- working dir

Expose:

- server port
- optional sidecar port if kept separate

## Acceptance Criteria

`PLAN_SHAKA.md` is complete only if the final implementation can credibly achieve:

1. `voyo-shaka.ts` starts independently.
2. Browser playback remains working.
3. Non-DRM VLC playback remains working.
4. DRM VLC playback works through `/vlc/<id>/index.m3u8`.
5. Shaka Packager owns HLS playlist generation.
6. The local server owns only acquisition, decryption, supervision, and file serving.
7. The code is easier to understand than the current `voyo.ts`.

## References

- Shaka Packager overview: <https://shaka-project.github.io/shaka-packager/>
- Shaka Packager stream descriptors: <https://shaka-project.github.io/shaka-packager/html/options/stream_descriptors.html>
- Shaka Packager live packaging: <https://shaka-project.github.io/shaka-packager/html/tutorials/live.html>
- Shaka Packager HLS: <https://shaka-project.github.io/shaka-packager/html/tutorials/hls.html>
- Shaka Packager raw-key workflows: <https://shaka-project.github.io/shaka-packager/html/tutorials/raw_key.html>
- Shaka Packager FFmpeg piping tutorial: <https://shaka-project.github.io/shaka-packager/html/tutorials/ffmpeg_piping.html>
- Bento4 `mp4decrypt`: <https://www.bento4.com/documentation/mp4decrypt/>
