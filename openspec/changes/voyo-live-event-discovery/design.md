## Context

`v2/voyo-shaka.ts` is a small single-process Deno service with an embedded HTML UI. It already authenticates against Voyo, fetches overview data for live TV channels, normalizes typed content IDs, resolves `/plays`, and supports manual event entries through the same player and VLC paths.

The authenticated Voyo overview API exposes the required discovery data without HTML scraping:

- category `6` contains a `Sport Live` carousel;
- category `334` contains a `Premier League Live` carousel;
- carousel items contain typed episode IDs, titles, images, release-date labels, and live labels.

Discovery is an operator action rather than a scheduled feed. The service should therefore remain single-file, in-memory, and dependency-free.

## Goals / Non-Goals

**Goals:**

- Provide independent Sport and Premier League discovery actions.
- Fetch fresh API results on every button click and replace the selected category's previous results.
- Allow the Premier League category ID to change without editing code.
- Reuse current event playback, DRM, VLC, and authentication behavior.
- Keep the last successful category result visible when Voyo temporarily fails.

**Non-Goals:**

- Background polling, cron jobs, notifications, or automatic event start detection.
- HTML scraping of the public Voyo pages.
- Database-backed discovery history or persistence across process restarts.
- Changes to Caddy, the CDM sidecar, or the media pipeline.
- Discovering arbitrary Voyo categories from the UI.

## Decisions

### Use the authenticated overview API

The service will call `/api/v1/overview?category=<id>` through the existing `withAuth()` flow. Sport always uses category `6`. Premier League uses `VOYO_PREMIER_LEAGUE_CATEGORY_ID`, defaulting to `334`.

This is preferred over scraping because the API provides canonical typed content IDs and structured display metadata. It is also preferred over introducing the category ID into `voyo.json`; an environment variable matches the service's existing runtime configuration style and avoids config migration.

### Expose one protected discovery endpoint per scope

The UI will call protected service endpoints for `sport` and `premier-league`. A force-refresh query follows the existing `/api/channels?force=1` convention. The server, not the browser, calls Voyo so credentials and bearer tokens remain server-side.

Each response will identify the scope, category ID, fetch time, freshness state, and normalized entries. Requests for one scope do not clear or modify the other scope.

### Keep independent in-memory discovery snapshots

Maintain one last-successful snapshot per scope. A forced refresh first requests upstream data and replaces that scope only after a valid response is parsed. If the request or parsing fails, retain the old snapshot and return it with a stale indicator and error message. If no successful snapshot exists, return an error with an empty result.

Concurrent refreshes for the same scope will share one in-flight request. Sport and Premier League refreshes may run independently.

This is simpler than persistence and naturally clears obsolete discoveries on restart. It also avoids writing short-lived events into `manualEvents`.

### Select the dedicated live carousel and normalize its entries

For category `6`, select the `Sport Live` content section. For the configured Premier League category, select the `Premier League Live` content section. Section-name matching will be isolated in one parser so an API naming change is easy to adjust.

Normalize each carousel item into the existing `Channel`-compatible event shape:

- preserve the API's typed episode identity while converting `episode-<number>` to the canonical `episode.<number>` content ID used for `/plays`;
- carry title, resolved image size, release-date label, and live label for display;
- mark the entry as an event with unknown stream kind;
- deduplicate by canonical content ID within a snapshot.

Discovery will not probe `/plays` for every item. Future events may not be playable yet, and probing would make discovery slower and more fragile. Playback resolution remains lazy when an operator opens or copies an event stream.

### Separate display lists while sharing playback lookup

The index page will contain separate Sport and Premier League discovery sections controlled by their respective buttons. A discovered episode may legitimately appear in both sections.

Playback lookup will search a deduplicated union of regular channels, manual events, and both discovery snapshots. Existing `/play`, `/vlc`, `/live`, stream-info, DRM, and diagnostic routes can therefore accept discovered event IDs without duplicating media logic. The existing regular channel response remains separate from discovery responses.

## Risks / Trade-offs

- [Voyo renames or removes a live carousel] → Return a clear parsing error, retain the last successful snapshot, and keep section matching isolated.
- [The configurable Premier League category points to a non-Premier-League page] → Require the `Premier League Live` section; do not silently ingest unrelated content.
- [An event is listed before `/plays` becomes available] → Show it as discovered but resolve playback lazily and surface the existing playback error behavior.
- [The same episode appears in both categories] → Allow it in both UI sections but deduplicate the shared playback lookup and any combined playlist output.
- [Discovery state disappears after restart] → Accept this by design; the operator can repopulate it with one button click.

## Migration Plan

Deploy the updated single-file service with no data migration. Optionally set `VOYO_PREMIER_LEAGUE_CATEGORY_ID`; otherwise category `334` is used. Roll back by restoring the previous `v2/voyo-shaka.ts`; no persistent discovery data needs cleanup.

## Open Questions

None.
