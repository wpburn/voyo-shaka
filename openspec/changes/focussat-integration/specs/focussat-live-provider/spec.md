## ADDED Requirements

### Requirement: Standalone FocusSat application
The system SHALL provide a standalone root-level `focussat/` TypeScript application for FocusSat live TV without requiring changes to the existing Voyo v2 entry points.

#### Scenario: FocusSat app is isolated from Voyo
- **WHEN** the FocusSat implementation is added
- **THEN** it resides under `focussat/` and the existing Voyo v2 server files remain behaviorally unchanged

#### Scenario: FocusSat app runs independently
- **WHEN** the operator starts the FocusSat app from the `focussat/` folder
- **THEN** it starts its own local HTTP server using FocusSat-specific configuration

### Requirement: Environment-based credential configuration
The system SHALL read FocusSat credentials and runtime settings from a local environment file or environment variables and MUST NOT require credentials to be committed to the repository.

#### Scenario: Credentials are loaded from local environment
- **WHEN** `FOCUSSAT_USER` and `FOCUSSAT_PASS` are present in `focussat/.env` or the process environment
- **THEN** the FocusSat app uses them for Solocoo authentication

#### Scenario: Example configuration is safe to commit
- **WHEN** the FocusSat folder is created
- **THEN** it includes a committed example environment file without real secrets and ignores local secret, token, Widevine, and live-output artifacts

### Requirement: Solocoo FocusSat authentication
The system SHALL authenticate FocusSat accounts through the Solocoo FocusSat flow using TypeScript-native HTTP calls and MUST persist rotated session state locally.

#### Scenario: Successful login
- **WHEN** valid FocusSat credentials are supplied
- **THEN** the app provisions a device, obtains a ticket, exchanges credentials for an `ssoToken`, exchanges the `ssoToken` for a bearer token, and stores the rotated session state locally

#### Scenario: Session refresh rotates token
- **WHEN** a non-login operation needs an API bearer token
- **THEN** the app exchanges the stored `ssoToken` for a fresh bearer token and persists the returned rotated `ssoToken`

#### Scenario: Device limit response
- **WHEN** Solocoo returns a device-limit response with removable devices
- **THEN** the app retries the session exchange with `removeDevice` and reports the eviction without logging credentials

### Requirement: FocusSat channel catalog
The system SHALL expose the entitled FocusSat live channel catalog through a local API and playlist-friendly metadata model.

#### Scenario: Channel list is requested
- **WHEN** a client requests the local channel API
- **THEN** the app fetches `/v1/bouquet`, filters out channels without playable sources, and returns channel IDs, names, slugs, images when available, and DRM stream kind metadata

#### Scenario: Channel playlist is requested
- **WHEN** a client requests the combined local M3U playlist
- **THEN** the app returns an M3U playlist containing playable FocusSat channels with local playback URLs

### Requirement: FocusSat stream resolution
The system SHALL resolve a FocusSat channel into a playable DASH/Widevine stream using the Solocoo play endpoint.

#### Scenario: DRM stream is resolved
- **WHEN** a known channel ID is requested for playback
- **THEN** the app calls `/v1/assets/{id}/play` with DASH and Widevine capabilities and returns the DASH manifest URL plus the Widevine license URL

#### Scenario: Signed stream URLs expire
- **WHEN** a cached stream URL is expired or rejected by the upstream service
- **THEN** the app refreshes stream information once before returning an error to the client

### Requirement: Browser playback
The system SHALL support local browser playback for FocusSat DRM channels through a Shaka-compatible player page and a local license proxy.

#### Scenario: Player page loads a DRM channel
- **WHEN** a user opens the local player page for a FocusSat channel in a Widevine-capable browser
- **THEN** the page loads the resolved DASH manifest and uses the local license proxy for Widevine license requests

#### Scenario: License challenge is proxied
- **WHEN** the browser posts a Widevine challenge to the local license endpoint
- **THEN** the app forwards the challenge to the FocusSat license URL and returns the binary license response to the browser

### Requirement: VLC and IPTV playback
The system SHALL provide VLC/IPTV-compatible local playlist endpoints for FocusSat channels and MUST support server-side DRM-to-HLS output for DRM channels when required tools are configured.

#### Scenario: VLC playlist requested for DRM channel
- **WHEN** a client requests `/vlc/{channel}/index.m3u8` for a DRM channel
- **THEN** the app resolves the stream, obtains content keys through the configured local CDM helper, decrypts live fragments, packages them as local HLS, and serves the generated playlist

#### Scenario: Required DRM tooling missing
- **WHEN** VLC playback is requested but the CDM helper, Widevine device, decrypt tool, or packager is unavailable
- **THEN** the app returns a clear local error describing the missing dependency

### Requirement: Operational safety
The system SHALL avoid logging secrets and SHALL keep generated runtime state separate from committed source files.

#### Scenario: Upstream error is logged
- **WHEN** an upstream FocusSat or Solocoo call fails
- **THEN** the app logs status and bounded diagnostic context without printing passwords, bearer tokens, `ssoToken` values, or license challenge bodies

#### Scenario: Runtime files are generated
- **WHEN** the app writes tokens, cache files, decrypted fragments, generated HLS output, logs, or Widevine device files
- **THEN** those files are written under ignored paths and are not required for source control
