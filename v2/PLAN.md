# Voyo v2 Plan

## Goal

Get DRM channels working in VLC through the local server, using a cross-platform pipeline that can run on macOS first and then be moved to Ubuntu or Docker without redesign.

## Current Status

### Confirmed working

- Non-DRM browser playback works through `/play/<id>`.
- DRM browser playback works in Edge/Chrome through `/play/<id>`.
- The Widevine license proxy at `/license/<id>` works.
- The CDM sidecar `cdm.py` works and returns content keys.
- Non-DRM VLC playback works through `/live/<id>.m3u8`.

### Confirmed not working

- DRM VLC playback through `/vlc/<id>/index.m3u8` does not work with the current implementation.
- DRM browser playback does not work in the VS Code built-in browser because Electron does not expose a usable Widevine CDM.

### Important conclusions

- The browser DRM path and the VLC DRM path are separate systems.
- The `.wvd` file only matters for the server-side DRM path via `cdm.py`.
- `ffmpeg -decryption_key` is not sufficient for the current DASH+CENC/Widevine case.
- `mp4decrypt` is the right decryptor to use next.
- `ffmpeg` should still be kept for final HLS muxing/remuxing.

## Root Cause Of Current VLC DRM Failure

The current `/vlc` implementation in [voyo.ts](/Users/flav/Downloads/iptvro_v2-main/v2/voyo.ts:249) assumes that one `ffmpeg` process can:

1. open the remote DASH manifest
2. decrypt encrypted DASH media using a single `-decryption_key`
3. remux the result to HLS for VLC

That assumption is wrong for the tested Widevine stream.

Problems:

- Widevine DASH uses CENC-encrypted fragmented MP4 streams.
- `ffmpeg -decryption_key` is not a reliable solution here.
- The current code only passes one key, while real streams may require multiple keys or per-track handling.
- Even when keys are valid, the DASH+CENC path is not equivalent to a simple encrypted HLS flow.

## Target Architecture

Build a proper server-side DRM pipeline for `/vlc/<id>/index.m3u8`:

1. Resolve DRM stream metadata from Voyo.
2. Fetch and parse the MPD.
3. Get content keys from `cdm.py`.
4. Select audio and video representations.
5. Download init segments and media fragments.
6. Decrypt fragments with `mp4decrypt`.
7. Remux decrypted media to HLS with `ffmpeg`.
8. Serve local HLS to VLC from `/vlc/<id>/index.m3u8`.

## Tooling Decision

### Keep

- `cdm.py` for license exchange and content key extraction
- `ffmpeg` for muxing/remuxing to HLS
- Deno server in `voyo.ts`

### Add

- `mp4decrypt` from Bento4 for fragment decryption

### Why `mp4decrypt`

- It supports KID/key-based decryption cleanly.
- It matches the output shape already returned by `cdm.py`: `[{ kid, key }]`.
- It is available on macOS and can be used on Linux/Ubuntu too.
- It is a better fit than trying to force more behavior out of `ffmpeg -decryption_key`.

## Implementation Plan

### Phase 1: Preserve Current Browser Path

Do not destabilize the working browser flow while rewriting VLC DRM.

Tasks:

- Leave `/play/<id>` and `/license/<id>` behavior unchanged.
- Leave non-DRM `/live/<id>.m3u8` behavior unchanged.
- Keep current diagnostics in `/play/<id>` until VLC DRM is stable.

Success criteria:

- Non-DRM `/play` still works.
- DRM `/play` still works in Edge/Chrome.

### Phase 2: Introduce DRM Pipeline Abstractions

Refactor the current `/vlc` implementation away from a single-process `ffmpeg` assumption.

Tasks:

- Replace the current `startPipe()` design with a multi-step pipeline manager.
- Add explicit state for:
  - stream info
  - keys
  - MPD data
  - selected representations
  - local working directory
  - child processes
- Keep idle cleanup behavior for stale pipes.

Success criteria:

- `/vlc` can manage a per-channel working directory and lifecycle cleanly.

### Phase 3: MPD Parsing

Implement MPD parsing for the DRM DASH manifest.

Tasks:

- Fetch the MPD from the resolved DRM stream URL.
- Extract:
  - base URLs
  - video/audio adaptation sets
  - representation IDs
  - initialization segment URLs
  - media segment URL templates or segment lists
- Choose a single audio representation and a single video representation initially.

Notes:

- Start with the simplest supported path needed for the tested live channel.
- Do not over-generalize before channel-179 works.

Success criteria:

- The server can resolve actual init/media URLs for a live DRM channel.

### Phase 4: Local Fragment Download

Download the encrypted assets needed for playback.

Tasks:

- Create a local working directory per active DRM channel.
- Download the current init segments for audio and video.
- Download media fragments on a rolling basis.
- Handle signed URL expiry by refreshing stream info if needed.

Notes:

- This can start with a small sliding window.
- The local store can be transient and cleaned up with the pipe.

Success criteria:

- The server can maintain a local encrypted fragment queue.

### Phase 5: Decrypt With `mp4decrypt`

Use `mp4decrypt` to decrypt init segments and media fragments.

Tasks:

- Add environment variable support:
  - `VOYO_MP4DECRYPT`
- Verify `mp4decrypt` exists at startup or fail with a clear error.
- For each KID/key from `cdm.py`, pass:
  - `--key <kid>:<key>`
- Produce decrypted local outputs for audio and video fragments.

Success criteria:

- Decrypted local fragments are generated successfully for the live DRM channel.

### Phase 6: Remux To HLS With `ffmpeg`

Turn the decrypted media into VLC-friendly HLS.

Tasks:

- Feed decrypted audio/video into `ffmpeg`.
- Generate:
  - `index.m3u8`
  - `.ts` or fMP4 HLS segments
- Keep output under the existing `/vlc/<id>/...` serving model.

Notes:

- Prefer the simplest robust HLS output VLC accepts.
- Start with one channel and one quality level.

Success criteria:

- VLC can open `/vlc/channel-179/index.m3u8` and play the DRM channel.

### Phase 7: Reliability Work

Make the local implementation resilient enough for normal use.

Tasks:

- Handle expired signed URLs by refreshing manifest data.
- Handle child process exit cleanly.
- Improve logging for:
  - MPD parse failures
  - download failures
  - decrypt failures
  - remux failures
- Keep temporary files bounded and clean them on pipe shutdown.

Success criteria:

- The DRM VLC path can survive normal live playback behavior.

### Phase 8: Dockerization

Once local macOS behavior is proven, package the working stack into Docker.

Tasks:

- Add a `Dockerfile`.
- Include:
  - Deno
  - Python
  - `pywidevine` dependencies
  - `ffmpeg`
  - Bento4 `mp4decrypt`
- Mount:
  - `.wvd` device file
  - config/work directory
- Expose:
  - `8090`
  - `8091`

Notes:

- Docker is the portability step, not the debugging step.
- First make the pipeline work locally, then freeze it into a container.

Success criteria:

- The same VLC DRM flow works inside Docker on Ubuntu-class environments.

## Suggested Environment Variables

- `VOYO_CDM_URL`
- `VOYO_CDM_PORT`
- `VOYO_CDM_DEVICE`
- `VOYO_FFMPEG`
- `VOYO_MP4DECRYPT`
- `VOYO_CONFIG_DIR`

## Validation Plan

### Browser validation

- Confirm non-DRM `/play/channel-1` works in Edge/Chrome.
- Confirm DRM `/play/channel-179` works in Edge/Chrome.
- Confirm VS Code browser still fails DRM with a clear Widevine message.

### VLC validation

- Confirm non-DRM `/live/channel-1.m3u8` works in VLC.
- Confirm DRM `/vlc/channel-179/index.m3u8` starts generating local HLS output.
- Confirm VLC can play the generated DRM HLS stream.

### Operational validation

- Open two channels concurrently and ensure process isolation works.
- Let a channel go idle and verify cleanup behavior.
- Restart the server and confirm the next request can rebuild state cleanly.

## Risks

- MPD structure may vary across channels.
- Audio and video may use separate KIDs.
- Signed URLs may expire during long sessions.
- Live segment timing may need careful handling to avoid gaps.
- VLC may be sensitive to HLS output format choices.

## Out Of Scope For First Pass

- Multiple quality levels for DRM VLC playback
- Perfect adaptive bitrate support in VLC path
- Generalized support for every possible MPD layout before channel-179 works
- Docker before the local pipeline is proven

## Immediate Next Step

Start Phase 2 and replace the current `/vlc` `ffmpeg -decryption_key` approach with a pipeline manager built around:

- MPD parsing
- local fragment download
- `mp4decrypt`
- `ffmpeg` remux to HLS
