## Context

The repo currently has a working Voyo v2 TypeScript server with browser playback, M3U endpoints, CDM sidecar integration, and server-side DRM-to-HLS behavior. The repo also contains a Python SolcoTVPro implementation that already documents the Solocoo flow for FocusSat, but the new FocusSat implementation should be standalone, root-level, and TypeScript-only.

FocusSat should therefore be built as a separate `focussat/` app. This keeps the current Voyo files stable while allowing the FocusSat flow to reuse proven runtime concepts: a local HTTP server, cached channel metadata, signed stream resolution, browser Shaka playback, local Widevine license proxying, and optional server-side decrypted HLS for VLC/IPTV clients.

## Goals / Non-Goals

**Goals:**

- Provide a fully working root-level `focussat/` TypeScript app.
- Port the Solocoo FocusSat flow into TypeScript without shelling out to the Python provider.
- Store user credentials in `focussat/.env` and provide a committed `focussat/env.example`.
- Expose FocusSat channels and playback through local endpoints similar to the Voyo v2 server.
- Preserve current Voyo v2 behavior by avoiding edits to existing Voyo entry points.

**Non-Goals:**

- Do not create a generic multi-provider framework for Voyo and FocusSat in this change.
- Do not require the existing Python SolcoTVPro provider at runtime.
- Do not commit real credentials, token files, Widevine device files, or generated live output.
- Do not support every Solocoo brand initially; scope the app to FocusSat.

## Decisions

### Build a separate root-level app

Create `focussat/` at the repository root instead of `v2/focussat` or shared Voyo modules. This isolates risk from the current Voyo runtime and makes FocusSat independently runnable, configurable, and deployable.

Alternative considered: refactor Voyo v2 into shared provider modules. That would reduce duplication later, but it raises regression risk for the currently used Voyo server and is not necessary for a first working FocusSat app.

### Port Solocoo auth directly to TypeScript

Implement the Solocoo FocusSat client in TypeScript:

- brand `fsro`
- login host `m7.login.solocoo.tv`
- API host `tvapi.solocoo.tv`
- app/device payloads compatible with the existing Solocoo flow
- signed `Authorization: Client ...` login headers
- `ssoToken` persistence and rotation on every session exchange
- device-limit handling through `removeDevice`

Alternative considered: invoke `v2/SolcoTVPro/solcotv_o11.py` from the TypeScript server. That is faster to prototype, but it splits state management and error handling across runtimes and violates the TypeScript-only requirement.

### Keep local secrets environment-based

Use `focussat/.env` for `FOCUSSAT_USER`, `FOCUSSAT_PASS`, port values, CDM sidecar URL, and tool paths. Commit `focussat/env.example` rather than `.env.example`, because the repository ignores `.env.*` patterns.

Runtime tokens should be written under `focussat/data/` or another ignored runtime directory. If needed, add a `focussat/.gitignore` that ignores `.env`, `data/`, live output, and `*.wvd`.

### Reuse the Voyo playback shape without importing Voyo behavior

Implement FocusSat endpoints with familiar names:

- `GET /` for local UI
- `POST /api/login` for explicit login/refresh
- `GET /api/channels`
- `GET /api/stream/:id`
- `POST /license/:id` for browser Widevine license proxying
- `GET /live.m3u8`
- `GET /vlc/:id/index.m3u8` for VLC/IPTV server-side HLS output

The internals should be FocusSat-specific. Stream resolution calls `/v1/assets/{id}/play` and returns a DASH URL plus `drm.licenseUrl`; license requests use Solocoo's license URL without additional authorization headers unless FocusSat returns headers that must be forwarded.

### Start with the proven MPD path

The server-side VLC path should initially target the MPD structure already supported by the Voyo Shaka pipeline: DASH live manifests exposing audio/video representations, initialization segments, and segment templates or segment lists. If FocusSat exposes a different MPD shape, add parser support in the FocusSat app rather than changing Voyo files.

## Risks / Trade-offs

- Solocoo API shapes may drift -> keep API response validation explicit and include bounded diagnostic errors without logging secrets.
- FocusSat may enforce geo or subscription entitlement checks -> surface login/channel/play errors clearly and document proxy/VPN expectations without baking proxy credentials into code.
- Device-limit eviction may sign out another registered device -> document the behavior and make it visible in logs.
- Copying playback pipeline concepts duplicates some Voyo code -> acceptable for isolation; future shared modules can be proposed after FocusSat is working.
- Server-side DRM playback depends on a valid local Widevine L3 device and external packager/decrypt tools -> provide clear startup checks and browser playback as a separate verification path.

## Migration Plan

1. Add the `focussat/` app and docs without changing existing Voyo files.
2. Run FocusSat locally on its own port with its own `.env`.
3. Verify login, channel list, browser playback, and one VLC/IPTV DRM channel.
4. If deployment is needed, add FocusSat-specific Docker or start scripts only after the local app is proven.

Rollback is deleting or disabling the new `focussat/` folder; existing Voyo v2 behavior remains unchanged.

## Open Questions

None for the initial implementation. Use `8092` as the default FocusSat HTTP port to avoid Voyo `8090` and the CDM sidecar `8091`, and include server-side VLC/IPTV DRM output in the first working target.
