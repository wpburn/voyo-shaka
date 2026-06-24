## 1. Project Scaffold

- [x] 1.1 Create the root-level `focussat/` folder with a TypeScript entry point, README, `env.example`, and local `.gitignore`.
- [x] 1.2 Add startup scripts or documented Deno commands that run the FocusSat app on default port `8092`.
- [x] 1.3 Add environment loading for `FOCUSSAT_USER`, `FOCUSSAT_PASS`, `FOCUSSAT_PORT`, `FOCUSSAT_CDM_URL`, decrypt tool path, packager path, and runtime data directory.
- [x] 1.4 Ensure real `.env`, token/cache files, Widevine device files, generated HLS output, logs, and other runtime artifacts are ignored.

## 2. Solocoo API Client

- [x] 2.1 Implement FocusSat constants for brand `fsro`, login host `m7.login.solocoo.tv`, API host `tvapi.solocoo.tv`, Android-style device info, app version, HMAC key, and client key.
- [x] 2.2 Implement Solocoo URL-safe base64, payload hashing, and signed `Authorization: Client ...` header generation in TypeScript.
- [x] 2.3 Implement `/v1/provision` device provisioning.
- [x] 2.4 Implement signed ticket acquisition from the FocusSat Solocoo login endpoint.
- [x] 2.5 Implement signed username/password exchange for `ssoToken` with clear invalid-credential handling.
- [x] 2.6 Implement `/v1/session` exchange for bearer token plus rotated `ssoToken`.
- [x] 2.7 Implement device-limit handling by retrying `/v1/session` with `removeDevice`.
- [x] 2.8 Persist session state locally and redact credentials, bearer tokens, and `ssoToken` values from logs.

## 3. Channel And Stream Data

- [x] 3.1 Implement `GET /v1/bouquet` channel loading through the Solocoo bearer token.
- [x] 3.2 Normalize FocusSat channels into local IDs, names, slugs, image URLs when present, and DRM stream metadata.
- [x] 3.3 Cache channel data with explicit refresh behavior and a force-refresh path.
- [x] 3.4 Implement `/v1/assets/{id}/play` stream resolution with DASH and Widevine player capabilities.
- [x] 3.5 Cache signed stream information briefly and refresh once on upstream 401 or 403 responses.

## 4. Local HTTP API And UI

- [x] 4.1 Implement `GET /` with a simple FocusSat channel list UI and playback links.
- [x] 4.2 Implement `POST /api/login` to perform or refresh FocusSat login.
- [x] 4.3 Implement `GET /api/channels` with optional force refresh.
- [x] 4.4 Implement `GET /api/stream/{id}` returning manifest URL, DRM flag, and local license URL.
- [x] 4.5 Implement `GET /live.m3u8` returning a combined FocusSat playlist with local channel URLs.

## 5. Browser DRM Playback

- [x] 5.1 Implement a Shaka-compatible `GET /play/{id}` player page for FocusSat channels.
- [x] 5.2 Implement `POST /license/{id}` to forward Widevine challenges to the resolved FocusSat license URL.
- [x] 5.3 Refresh stream information once when license proxying fails because the cached signed stream expired.
- [x] 5.4 Display actionable browser-side errors for unavailable Widevine, stream resolution failure, or license proxy failure.

## 6. VLC And IPTV DRM Output

- [x] 6.1 Port or adapt the MPD parser needed for FocusSat live DASH audio/video representations without changing Voyo files.
- [x] 6.2 Integrate the configured local CDM helper to extract content keys from FocusSat PSSH and license URL.
- [x] 6.3 Add startup checks for CDM helper health, decrypt tool availability, and Shaka Packager availability.
- [x] 6.4 Implement encrypted fragment download, local decryption, and per-channel runtime directories.
- [x] 6.5 Implement Shaka Packager piping/output for local HLS generation.
- [x] 6.6 Implement `GET /vlc/{id}/index.m3u8` and sibling HLS file serving for VLC/IPTV clients.
- [x] 6.7 Add idle cleanup and bounded restart/backoff behavior for active DRM channel pipelines.

## 7. Documentation And Verification

- [x] 7.1 Document `.env` setup using `env.example`, including FocusSat credentials, port `8092`, CDM sidecar URL, and required tools.
- [x] 7.2 Document how to start the CDM helper and where to place the Widevine L3 device file without committing it.
- [x] 7.3 Verify login succeeds with valid FocusSat credentials and stores rotated session state.
- [x] 7.4 Verify `/api/channels` returns entitled FocusSat channels and excludes unplayable entries.
- [x] 7.5 Verify `/api/stream/{id}` returns a DASH manifest URL and license URL for at least one channel.
- [ ] 7.6 Verify `/play/{id}` plays a DRM channel in a Widevine-capable browser.
- [ ] 7.7 Verify `/live.m3u8` imports in an IPTV/VLC client.
- [x] 7.8 Verify `/vlc/{id}/index.m3u8` serves decrypted local HLS for at least one DRM channel.
- [x] 7.9 Confirm existing Voyo v2 files were not behaviorally modified by this change.
