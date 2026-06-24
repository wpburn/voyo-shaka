## 1. Project Scaffold

- [x] 1.1 Create the root-level `digi-online/` folder with `main.ts`, `README.md`, `env.example`, `start.sh`, and local `.gitignore`.
- [x] 1.2 Add a Deno startup path that runs the Digi app with read, write, net, env, and run permissions.
- [x] 1.3 Add environment loading for `DIGI_ONLINE_USER`, `DIGI_ONLINE_PASS`, `DIGI_ONLINE_PORT`, `DIGI_ONLINE_CDM_URL`, decrypt tool path, packager path, and runtime data directory.
- [x] 1.4 Default `DIGI_ONLINE_PORT` to `8093`.
- [x] 1.5 Ensure `.env`, session/cache files, Widevine device files, generated HLS output, decrypted fragments, and logs are ignored locally.

## 2. Digi API Client

- [x] 2.1 Define Digi API v13 constants for API base URL, basic authorization header, mobile user agent, legacy app/device metadata, and stream query defaults.
- [x] 2.2 Implement MD5 password hashing in Deno TypeScript.
- [x] 2.3 Port the legacy Digi compatible device ID generation from `src/modules/digi-online.ts`.
- [x] 2.4 Port the registration hash generation using username, password hash, device ID, Digi app marker, and returned user hash.
- [x] 2.5 Implement `user.php?action=registerUser` login request with encoded username and password hash.
- [x] 2.6 Implement `devices.php?action=registerDevice` device registration request.
- [x] 2.7 Persist registered device state under the configured Digi data directory.
- [x] 2.8 Reuse persisted device state for stream resolution unless login is forced or the upstream API rejects it.
- [x] 2.9 Add response validation and bounded provider errors for login and device registration failures.
- [x] 2.10 Redact credentials, password hashes, registration hashes, full device IDs, and binary DRM bodies from logs.

## 3. Channel Catalog

- [x] 3.1 Implement Digi channel loading from `categorieschannels.php`.
- [x] 3.2 Normalize Digi channels into local IDs, names, slugs, image URLs, and raw provider metadata.
- [x] 3.3 Filter out malformed or unplayable channel entries.
- [x] 3.4 Cache channel data under the configured Digi data directory.
- [x] 3.5 Add force-refresh support that bypasses the local channel cache.

## 4. Stream Resolution

- [x] 4.1 Implement stream resolution through `streams_l_3.php?action=getStream`.
- [x] 4.2 Include the registered device ID, platform `iOS`, app release marker, `quality=all`, and `iosStream=1` in stream requests.
- [x] 4.3 Normalize `stream.abr` into the local manifest/stream URL field.
- [x] 4.4 Normalize `stream.proxy` into local DRM license/proxy metadata when present.
- [x] 4.5 Return a clear local error when the Digi stream response contains a provider error or lacks a playable URL.
- [x] 4.6 Cache stream metadata briefly and refresh it once on expiry, upstream rejection, or license proxy failure.
- [x] 4.7 Auto-login with configured credentials when stream resolution is requested without a registered device ID.

## 5. Local HTTP API And UI

- [x] 5.1 Implement `GET /` with a Digi Online channel list UI and playback links.
- [x] 5.2 Implement `POST /api/login` to register or refresh the Digi device session.
- [x] 5.3 Implement `GET /api/channels` with optional force refresh.
- [x] 5.4 Implement `GET /api/stream/{id}` returning stream URL, DRM flag, local license URL when applicable, and bounded diagnostics on failure.
- [x] 5.5 Implement `GET /live.m3u8` returning a combined Digi Online playlist with local channel URLs.
- [x] 5.6 Add JSON and plain-text error helpers that preserve HTTP status and avoid secret leakage.

## 6. Browser Playback

- [x] 6.1 Implement a Shaka-compatible `GET /play/{id}` player page for Digi Online channels.
- [x] 6.2 Configure the player to use the local license proxy when stream metadata includes a DRM proxy URL.
- [x] 6.3 Allow non-DRM streams to play without Widevine license configuration.
- [x] 6.4 Implement `POST /license/{id}` to forward Widevine challenges to the resolved Digi license/proxy URL.
- [x] 6.5 Refresh stream information once when license proxying fails because the cached signed stream expired.
- [x] 6.6 Display actionable browser-side errors for unavailable Widevine, stream resolution failure, or license proxy failure.

## 7. VLC And IPTV DRM Output

- [x] 7.1 Adapt the FocusSat/Voyo MPD parser path needed for Digi live DASH audio/video representations without changing existing provider files.
- [x] 7.2 Integrate the configured local CDM helper to extract content keys from Digi PSSH and license/proxy URL.
- [x] 7.3 Add runtime checks for CDM helper health, decrypt tool availability, and Shaka Packager availability.
- [x] 7.4 Implement encrypted fragment download and local decryption in per-channel runtime directories.
- [x] 7.5 Implement Shaka Packager piping/output for local HLS generation.
- [x] 7.6 Implement `GET /vlc/{id}/index.m3u8` and sibling HLS file serving for VLC/IPTV clients.
- [x] 7.7 Handle non-DRM VLC playback without requiring CDM key extraction.
- [x] 7.8 Add idle cleanup and bounded restart/backoff behavior for active DRM channel pipelines.

## 8. Documentation And Verification

- [x] 8.1 Document `.env` setup using `env.example`, including Digi credentials, port `8093`, CDM sidecar URL, and required tools.
- [x] 8.2 Document how to run the Digi Online app and which local endpoints it exposes.
- [x] 8.3 Document how to start the CDM helper and where to place the Widevine L3 device file without committing it.
- [ ] 8.4 Verify login succeeds with valid Digi credentials and stores registered device state.
- [ ] 8.5 Verify `/api/channels` returns Digi channels with IDs, display names, and image URLs where available.
- [ ] 8.6 Verify `/api/stream/{id}` returns a playable stream URL and DRM proxy metadata for at least one entitled channel.
- [ ] 8.7 Verify `/play/{id}` plays a DRM channel in a Widevine-capable browser.
- [ ] 8.8 Verify `/live.m3u8` imports in an IPTV/VLC client.
- [ ] 8.9 Verify `/vlc/{id}/index.m3u8` serves decrypted local HLS for at least one DRM channel when CDM/decrypt/packager tooling is configured.
- [x] 8.10 Confirm existing FocusSat and Voyo files were not behaviorally modified by this change.
