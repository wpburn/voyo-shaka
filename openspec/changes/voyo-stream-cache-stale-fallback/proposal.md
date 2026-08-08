## Why

The Voyo Shaka service currently turns a transient `/plays` refresh failure into a client-visible error even when it still has a working signed stream URL. This interrupts active FFmpeg and VLC playback and allows concurrent cache misses to amplify the refresh failure.

## What Changes

- Reuse cached stream information when a scheduled refresh fails temporarily.
- Ensure concurrent refreshes for the same channel share one Voyo `/plays` request.
- Delay the next refresh briefly after a temporary failure instead of retrying on every player request.
- When a cached HLS master or variant is rejected with `401` or `403`, force one stream refresh and retry once.
- Return `503 Retry-After` when playback cannot recover instead of exposing Voyo's `403` to the player.

## Capabilities

### New Capabilities

- `voyo-resilient-stream-refresh`: Defines resilient cached stream resolution and HLS recovery behavior for the Voyo Shaka service.

### Modified Capabilities

None.

## Impact

- Affects `v2/voyo-shaka.ts`, specifically stream-info caching and regular HLS playlist generation.
- Changes failure responses from transient upstream `403` errors to continued playback when cached media works, or `503 Retry-After` when it does not.
- Adds no external dependency and does not change authentication behavior.
