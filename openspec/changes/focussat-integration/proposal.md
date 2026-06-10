## Why

FocusSat support should be added without changing the currently working Voyo v2 server, because the Voyo flow is in active use and should not absorb provider-specific risk. FocusSat uses a Solocoo-backed live TV flow that can be implemented as a standalone root-level TypeScript app with the same local playback goals as the existing Voyo implementation.

## What Changes

- Add a new standalone root-level `focussat` TypeScript implementation for FocusSat live TV.
- Port the FocusSat/Solocoo login, session rotation, channel listing, stream resolution, and Widevine license handling entirely to TypeScript.
- Keep credentials in a local environment file inside `focussat`, excluded from source control.
- Reuse the proven v2 playback model where applicable: HTTP UI/API, channel list, browser playback, VLC/IPTV playlist endpoints, local CDM integration, and server-side DRM-to-HLS output.
- Do not modify the current Voyo entry points as part of this change unless a shared documentation or ignore-file update is strictly necessary.

## Capabilities

### New Capabilities
- `focussat-live-provider`: Standalone FocusSat live TV provider that authenticates with Solocoo, exposes channels, resolves DASH/Widevine streams, and serves browser/VLC-compatible playback from the root-level `focussat` app.

### Modified Capabilities

None.

## Impact

- Adds a new root-level `focussat` folder containing TypeScript source, runtime configuration examples, and provider-specific documentation.
- Adds local-only environment configuration for FocusSat credentials and runtime settings.
- May reuse or copy selected v2 DRM/CDM/Shaka helper patterns, but keeps the existing Voyo files behaviorally unchanged.
- Requires network access to FocusSat/Solocoo APIs and a Widevine L3 device file for server-side DRM extraction, matching the existing v2 DRM assumptions.
