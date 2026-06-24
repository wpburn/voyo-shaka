## ADDED Requirements

### Requirement: Standalone Digi Online application
The system SHALL provide a standalone root-level `digi-online/` TypeScript application for Digi Online live TV without requiring changes to the existing FocusSat app or Voyo v2 entry points.

#### Scenario: Digi app is isolated from existing providers
- **WHEN** the Digi Online implementation is added
- **THEN** it resides under `digi-online/` and the existing `focussat/` and Voyo v2 runtime files remain behaviorally unchanged

#### Scenario: Digi app runs independently
- **WHEN** the operator starts the Digi Online app from the `digi-online/` folder
- **THEN** it starts its own local HTTP server using Digi-specific configuration

### Requirement: Environment-based Digi configuration
The system SHALL read Digi Online credentials and runtime settings from a local environment file or process environment and MUST NOT require credentials to be committed to the repository.

#### Scenario: Credentials are loaded from local environment
- **WHEN** `DIGI_ONLINE_USER` and `DIGI_ONLINE_PASS` are present in `digi-online/.env` or the process environment
- **THEN** the Digi Online app uses them for Digi API authentication and device registration

#### Scenario: Example configuration is safe to commit
- **WHEN** the Digi Online folder is created
- **THEN** it includes a committed example environment file without real secrets and ignores local secret, session, Widevine, generated live-output, and log artifacts

#### Scenario: Default port avoids existing local services
- **WHEN** no custom `DIGI_ONLINE_PORT` is configured
- **THEN** the Digi Online app listens on port `8093`

### Requirement: Digi API authentication and device registration
The system SHALL authenticate Digi Online accounts through the Digi API v13 flow and MUST persist the registered device state locally.

#### Scenario: Successful login
- **WHEN** valid Digi Online credentials are supplied
- **THEN** the app hashes the password with MD5, registers the user through `user.php`, generates a compatible device ID and registration hash, registers the device through `devices.php`, and stores the registered device ID locally

#### Scenario: Missing credentials
- **WHEN** login is requested without a username or password
- **THEN** the app returns a clear local error without calling Digi Online APIs

#### Scenario: Provider rejects login
- **WHEN** Digi Online returns an error during user or device registration
- **THEN** the app returns the bounded provider error and does not log the raw password, password hash, registration hash, or full device token

#### Scenario: Existing registered device is available
- **WHEN** the app needs stream access and a persisted registered device ID exists
- **THEN** the app reuses that device ID unless an explicit login refresh or upstream rejection requires re-registration

### Requirement: Digi channel catalog
The system SHALL expose the Digi Online live channel catalog through a local API and playlist-friendly metadata model.

#### Scenario: Channel list is requested
- **WHEN** a client requests the local channel API
- **THEN** the app fetches Digi `categorieschannels.php`, normalizes channels into local IDs, display names, slugs, and image URLs, and returns only usable live channel entries

#### Scenario: Channel catalog refresh is forced
- **WHEN** a client requests the channel API with a force-refresh option
- **THEN** the app bypasses the local catalog cache and fetches a fresh channel list from Digi Online

#### Scenario: Channel playlist is requested
- **WHEN** a client requests the combined local M3U playlist
- **THEN** the app returns an M3U playlist containing playable Digi Online channels with local playback URLs

### Requirement: Digi stream resolution
The system SHALL resolve a Digi channel into a playable stream using the Digi API v13 stream endpoint and the registered device ID.

#### Scenario: Stream is resolved
- **WHEN** a known channel ID is requested for playback
- **THEN** the app calls `streams_l_3.php?action=getStream` with platform, app, quality, and registered device parameters and returns the provider ABR stream URL plus DRM proxy URL when provided

#### Scenario: Stream endpoint returns provider error
- **WHEN** Digi Online returns a non-empty stream error
- **THEN** the app returns a clear local error containing bounded provider diagnostic text

#### Scenario: Registered device is missing
- **WHEN** stream resolution is requested before a device ID is available
- **THEN** the app performs login when credentials are configured or returns an actionable authentication-required error

#### Scenario: Cached stream data expires or is rejected
- **WHEN** a cached stream URL is expired or rejected by the upstream service
- **THEN** the app refreshes stream information once before returning an error to the client

### Requirement: Browser playback
The system SHALL support local browser playback for Digi Online channels through a Shaka-compatible player page and a local license proxy when DRM metadata is present.

#### Scenario: Player page loads a DRM channel
- **WHEN** a user opens the local player page for a Digi DRM channel in a Widevine-capable browser
- **THEN** the page loads the resolved DASH manifest and uses the local license proxy for Widevine license requests

#### Scenario: Player page loads a non-DRM channel
- **WHEN** a user opens the local player page for a Digi channel that does not require DRM
- **THEN** the page loads the resolved stream without configuring a Widevine license proxy

#### Scenario: License challenge is proxied
- **WHEN** the browser posts a Widevine challenge to the local license endpoint
- **THEN** the app forwards the challenge to the resolved Digi license/proxy URL and returns the binary license response to the browser

#### Scenario: Browser playback fails
- **WHEN** stream resolution, Widevine availability, or license proxying fails
- **THEN** the player page displays an actionable local error without exposing secrets or binary license data

### Requirement: VLC and IPTV playback
The system SHALL provide VLC/IPTV-compatible local playlist endpoints for Digi Online channels and MUST support server-side DRM-to-HLS output for DRM channels when required tools are configured.

#### Scenario: VLC playlist requested for DRM channel
- **WHEN** a client requests `/vlc/{channel}/index.m3u8` for a DRM channel
- **THEN** the app resolves the stream, obtains content keys through the configured local CDM helper, decrypts live fragments, packages them as local HLS, and serves the generated playlist

#### Scenario: VLC playlist requested for non-DRM channel
- **WHEN** a client requests VLC playback for a non-DRM channel
- **THEN** the app returns or redirects to a playlist-compatible local stream path without requiring CDM key extraction

#### Scenario: Required DRM tooling is missing
- **WHEN** VLC playback is requested for a DRM channel but the CDM helper, decrypt tool, or packager is unavailable
- **THEN** the app returns a clear local error describing the missing dependency

#### Scenario: DRM pipeline is idle
- **WHEN** a generated HLS pipeline has not been accessed for the configured idle interval
- **THEN** the app stops the channel pipeline and keeps generated runtime files under ignored paths

### Requirement: Operational safety
The system SHALL avoid logging secrets and SHALL keep generated runtime state separate from committed source files.

#### Scenario: Upstream error is logged
- **WHEN** an upstream Digi API or license call fails
- **THEN** the app logs status and bounded diagnostic context without printing passwords, password hashes, registration hashes, bearer-like tokens, full device IDs, or license challenge bodies

#### Scenario: Runtime files are generated
- **WHEN** the app writes session state, cache files, decrypted fragments, generated HLS output, logs, or Widevine device files
- **THEN** those files are written under ignored paths and are not required for source control

#### Scenario: Existing provider runtimes are present
- **WHEN** Digi Online runtime files are generated or cleaned up
- **THEN** the app only touches paths under `digi-online/` or explicitly configured Digi runtime paths
