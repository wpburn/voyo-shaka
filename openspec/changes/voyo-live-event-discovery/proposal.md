## Why

Voyo adds sports events shortly before they go live, while the current Voyo Shaka UI requires each event URL or content ID to be entered manually. The authenticated Voyo overview API already exposes dedicated Sport and Premier League live sections, so the UI can offer simple on-demand discovery without scraping HTML or running a scheduler.

## What Changes

- Add separate **Discover Sport** and **Discover Premier League** buttons to the Voyo Shaka page.
- Make every button click bypass the corresponding discovery cache, fetch the current Voyo overview category, and replace that category's previously discovered results.
- Use Voyo category `6` for Sport discovery.
- Make the Premier League category ID configurable, with `334` as the default.
- Present discovered events separately from regular live channels and manually added events while reusing the existing playback routes and DRM handling.
- Retain the last successful results when an upstream refresh fails and report that the displayed results are stale.

## Capabilities

### New Capabilities

- `voyo-live-event-discovery`: On-demand discovery, presentation, refresh, and playback integration for Voyo Sport and Premier League live events.

### Modified Capabilities

None.

## Impact

- Affects `v2/voyo-shaka.ts`, including Voyo overview API access, in-memory discovery state, protected API routing, and the embedded index-page UI.
- Adds one runtime configuration value for the Premier League category ID; no database, Caddy, scheduler, or new external dependency is required.
- Uses the existing Voyo authentication/session flow and the existing content-ID normalization, stream resolution, DRM, player, and VLC routes.
