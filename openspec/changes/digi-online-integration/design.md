## Context

The repository now has a standalone `focussat/` Deno TypeScript app that runs separately from Voyo and exposes local UI/API, browser playback, M3U, license proxy, and server-side DRM-to-HLS endpoints. The older Digi Online implementation lives in `src/modules/digi-online.ts` as a module for the legacy server. It already captures the provider-specific Digi API behavior:

- credentials are exchanged through Digi API v13 with the password MD5 hash
- a generated device ID is registered through `devices.php`
- the returned local auth token is the registered device ID
- channels come from `categorieschannels.php`
- stream resolution calls `streams_l_3.php?action=getStream` with platform/app/device parameters and returns `stream.abr` plus optional `stream.proxy`
- Digi requests use the mobile-style `okhttp/4.8.1` user agent and the API basic authorization header used by the legacy module

The new Digi work should follow the standalone app shape used by FocusSat but keep all Digi API logic in `digi-online/`. The initial target is a complete root-level Digi Online solution, not a shared provider framework.

## Goals / Non-Goals

**Goals:**

- Provide a fully working root-level `digi-online/` TypeScript app.
- Port the legacy Digi Online API v13 auth, device registration, channel listing, and stream resolution flow into the standalone app.
- Store Digi credentials in `digi-online/.env` or process environment, with a committed safe example file.
- Persist registered device/session state locally under ignored runtime data paths.
- Expose Digi live channels through local HTTP endpoints similar to `focussat/`.
- Support browser DASH/Widevine playback through a Shaka-compatible page and local license proxy.
- Support IPTV/VLC clients through combined M3U and, where needed, server-side DRM-to-HLS output using the local CDM helper and packaging toolchain.
- Keep FocusSat and Voyo behavior unchanged by default.

**Non-Goals:**

- Do not revive or extend the legacy `src/modules/digi-online.ts` integration as the primary runtime.
- Do not create a generic provider abstraction shared by FocusSat, Digi, and Voyo in this change.
- Do not commit real credentials, registered device IDs, tokens, Widevine device files, generated HLS output, or logs.
- Do not add Digi VOD support unless the live implementation exposes a verified VOD path later.
- Do not bypass Digi entitlement, geo, DRM, or account limits.

## Decisions

### Build a separate root-level app

Create `digi-online/` at the repository root with `main.ts`, `README.md`, `env.example`, `start.sh`, and local ignore rules. This matches the operational shape of `focussat/` and lets Digi run, fail, and be deployed independently.

Alternative considered: update `src/modules/digi-online.ts`. That would preserve the old module API, but it would not deliver the standalone playback endpoints now expected from FocusSat-style provider folders.

### Use Digi API v13 compatibility first

Implement the same API contract proven by the legacy module before attempting newer endpoints:

- `user.php?action=registerUser&user={username}&pass={md5(password)}`
- `devices.php?action=registerDevice&i={deviceId}&c={hash}&pass={md5(password)}&dmo=iptvro&dma=Kodeative&o=REL_12&user={username}`
- `categorieschannels.php`
- `streams_l_3.php?action=getStream&id_stream={id}&platform=iOS&version_app=release&i={deviceId}&s=app&quality=all&iosStream=1`

Keep the API basic authorization value and mobile user-agent behavior local to the Digi client implementation. Log response status and bounded error messages, but redact credentials, password hashes, generated hashes, device IDs where practical, and DRM/license bodies.

Alternative considered: discover and switch to a newer Digi API. That may become useful later, but starting with the known legacy flow reduces implementation risk and gives a working baseline.

### Persist the registered device ID as session state

Store the generated Digi device ID and metadata in `digi-online/data/session.json`. On startup, reuse it for stream resolution when available. Provide explicit login/refresh behavior to register a new device when credentials are provided or when the current device is rejected.

Alternative considered: register a new device on every startup. That is simpler, but it risks hitting Digi device limits and makes troubleshooting account/device state harder.

### Mirror FocusSat local endpoints

Use familiar local endpoints with Digi-specific semantics:

- `GET /` channel UI
- `POST /api/login`
- `GET /api/channels?force=1`
- `GET /api/stream/{id}`
- `GET /play/{id}`
- `POST /license/{id}`
- `GET /live.m3u8`
- `GET /vlc/{id}/index.m3u8`

Default `DIGI_ONLINE_PORT` should be `8093` so it does not collide with Voyo `8090`, the CDM sidecar `8091`, or FocusSat `8092`.

Alternative considered: expose different provider-specific route names. Shared route names make client setup and operator documentation consistent across provider folders.

### Treat `stream.proxy` as the provider license/proxy URL

The legacy module returned `stream.proxy` as DRM URL metadata. The standalone app should preserve that behavior by mapping Digi stream resolution to local stream info containing a DASH manifest URL and, when present, a Widevine license/proxy URL. Browser playback should use a local license endpoint so CORS, request headers, and stream refresh behavior remain controlled by the app.

Alternative considered: expose the provider license/proxy URL directly to the browser. Local proxying is more consistent with FocusSat and keeps refresh/error handling server-side.

### Reuse playback pipeline ideas, not runtime code ownership

The Digi app may copy or adapt FocusSat/Voyo MPD parsing, local CDM calls, fragment decryption, and Shaka Packager output logic as needed. It should remain self-contained until there is a separate proposal to extract shared DRM/HLS helpers.

Alternative considered: immediately factor shared DRM code into common modules. That could reduce duplication, but it increases blast radius across working providers.

## Risks / Trade-offs

- Digi API compatibility can drift -> Keep endpoint constants centralized, validate response shapes, and return clear upstream diagnostics.
- Device registration can hit account device limits -> Reuse persisted device IDs and make re-registration explicit from `/api/login`.
- `stream.abr` and `stream.proxy` shapes may vary by channel -> Normalize stream responses defensively and include unsupported-channel errors when required fields are absent.
- DRM-to-HLS depends on the same local Widevine/CDM/decrypt/packager assumptions as FocusSat -> Document the dependencies and expose startup/runtime checks before attempting VLC output.
- Copying FocusSat playback code duplicates maintenance surface -> Accept duplication for provider isolation; revisit shared helpers after Digi and FocusSat are both stable.
- Geo, subscription, or entitlement failures are account/environment dependent -> Surface exact HTTP status and bounded provider messages without embedding proxy or credential assumptions.

## Migration Plan

1. Add the `digi-online/` app and docs without changing existing FocusSat or Voyo entry points.
2. Configure `digi-online/.env` from `env.example`, using default port `8093`.
3. Start the existing local CDM sidecar separately when testing DRM-to-HLS.
4. Verify login/device registration, channel catalog, stream resolution, browser playback, M3U generation, and one VLC/IPTV HLS channel.
5. Roll back by stopping or deleting the new `digi-online/` folder; existing provider runtimes remain unchanged.

## Open Questions

None for the initial proposal. Use Digi API v13 from `src/modules/digi-online.ts` as the compatibility target and validate behavior during implementation with real credentials.
