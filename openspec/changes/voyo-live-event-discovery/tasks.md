## 1. Discovery Model and Configuration

- [x] 1.1 Extend the Voyo event/display types with discovery scope, release-date
      label, and live-label metadata without changing persisted manual-event
      compatibility.
- [x] 1.2 Add `VOYO_PREMIER_LEAGUE_CATEGORY_ID` runtime configuration with
      default `334`, keeping Sport fixed to category `6`.

## 2. Voyo Overview Discovery

- [x] 2.1 Add an authenticated overview-category request that reuses
      `withAuth()` and returns the category sections.
- [x] 2.2 Implement isolated `Sport Live` and `Premier League Live` section
      parsing, typed episode-ID normalization, image sizing, metadata mapping,
      and per-snapshot deduplication.
- [x] 2.3 Add independent in-memory Sport and Premier League last-successful
      snapshots with per-scope single-flight forced refreshes and stale fallback
      responses.

## 3. Service Routes and Playback Integration

- [x] 3.1 Add Basic-auth-protected discovery API routes for Sport and Premier
      League, including scope, category ID, fetch timestamp, freshness, entries,
      and refresh errors.
- [x] 3.2 Extend playable-entry lookup with a deduplicated union of discovered
      events while leaving the regular channel response separate.
- [x] 3.3 Verify discovered typed episode IDs work through existing browser
      player, VLC, live playlist, DRM, stream-info, and diagnostic route
      resolution without eager `/plays` probes.

## 4. Operator UI

- [x] 4.1 Add separate Discover Sport and Discover Premier League buttons with
      independent loading and error states.
- [x] 4.2 Render independent Sport and Premier League result sections with
      title, image, release/live labels, freshness status, and the existing
      play/copy/VLC actions.
- [x] 4.3 Ensure a repeated button click forces a new upstream refresh and
      atomically replaces only that section's displayed results.

## 5. Verification and Documentation

- [x] 5.1 Add focused parser/state tests for both carousel shapes, duplicate
      IDs, missing sections, independent refreshes, and last-successful fallback
      behavior.
- [x] 5.2 Run Deno formatting and type checking for `v2/voyo-shaka.ts`, then
      perform authenticated discovery smoke checks for categories `6` and the
      configured Premier League category.
- [x] 5.3 Document the two discovery controls and optional
      `VOYO_PREMIER_LEAGUE_CATEGORY_ID` setting in `v2/README.md` and the Docker
      runtime example.
