## Why

Digi Online should be added as a standalone provider app like the new FocusSat implementation, instead of extending the older `src/modules/digi-online.ts` module or coupling it to the current Voyo/FocusSat runtime. The legacy module already documents the core Digi API flow, but the new solution needs a complete local app with browser, IPTV, and VLC-friendly playback behavior.

## What Changes

- Add a new root-level `digi-online/` TypeScript implementation for Digi Online live TV.
- Port the Digi Online login, device registration, channel catalog, stream resolution, and Widevine proxy behavior from the legacy `src/modules/digi-online.ts` flow.
- Keep Digi credentials and runtime settings in a local environment file inside `digi-online`, excluded from source control.
- Expose a local HTTP UI/API, combined M3U playlist, browser playback page, license proxy endpoint, and server-side DRM-to-HLS path comparable to `focussat/`.
- Persist Digi device/session state locally so successful logins can reuse the registered device ID until refresh or re-login is required.
- Do not modify the working FocusSat app or Voyo v2 entry points as part of this change unless a shared ignore/documentation update is strictly necessary.

## Capabilities

### New Capabilities

- `digi-online-live-provider`: Standalone Digi Online live TV provider that authenticates with Digi API v13, exposes channels, resolves DASH/Widevine streams, and serves browser/IPTV/VLC-compatible playback from the root-level `digi-online` app.

### Modified Capabilities

None.

## Impact

- Adds a new root-level `digi-online` folder containing TypeScript source, runtime configuration examples, startup script, local ignore rules, and provider-specific documentation.
- Adds local-only environment configuration for Digi credentials, port, CDM sidecar URL, decrypt tool path, packager path, and runtime data directory.
- Reuses or adapts selected FocusSat/Voyo playback patterns for local HTTP endpoints, Shaka browser playback, license proxying, content-key extraction, and generated HLS output while keeping provider API code separate.
- Requires network access to Digi Online API endpoints and a valid Digi account with live TV entitlement.
- Requires a Widevine-capable browser for browser DRM playback and a local CDM/decrypt/packager toolchain for server-side DRM-to-HLS output.
