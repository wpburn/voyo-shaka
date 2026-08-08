## Context

`v2/voyo-shaka.ts` caches Voyo stream information for five minutes. Once that TTL passes, the next request blocks on a new `/plays` request and propagates its error status even though the cached signed media URL may still work. Concurrent requests can also perform duplicate refreshes. The service is a small, single-process Deno application, so the solution should remain in-memory and easy to maintain.

## Goals / Non-Goals

**Goals:**

- Keep serving a cached stream URL when a scheduled Voyo refresh fails temporarily.
- Coalesce concurrent refreshes for the same channel.
- Avoid hammering `/plays` immediately after a failed refresh.
- Recover once when a cached HLS master or variant is actually rejected.
- Return a retryable service error rather than Voyo's `403` when playback cannot recover.

**Non-Goals:**

- Persistent or distributed caching.
- Background refresh timers or a general retry framework.
- Changing Voyo authentication or treating every `403` as an authentication failure.
- Adding channel-aware recovery to the generic `/proxy` segment route.

## Decisions

### Use synchronous stale-on-error refresh

Keep the existing `{ info, expiresAt }` cache entry. When an entry expires, the requesting call attempts a refresh. If that refresh fails with a temporary API or network error, the call returns the previous `StreamInfo` and moves `expiresAt` forward by one minute as a retry cooldown.

This is simpler than stale-while-revalidate scheduling and still prevents a transient `/plays` failure from interrupting playback. The normal refresh interval will be 30 minutes to avoid unnecessary `/plays` traffic.

### Coalesce refreshes with one promise map

Maintain `Map<string, Promise<StreamInfo>>` keyed by the canonical stream cache key. Both ordinary and forced callers join the same in-flight refresh. The promise is removed when it settles.

### Do not use stale fallback for forced refreshes

An ordinary expired-cache refresh may fall back to stale data. A forced refresh occurs only after the cached HLS URL itself returned `401` or `403`; returning that same stale value would create a loop. Forced refreshes therefore propagate failure to the playlist recovery path.

### Retry HLS construction once

Regular HLS playlist construction will fetch the master and selected variant with cached stream information. If either returns `401` or `403`, it will force one stream-info refresh and repeat playlist construction once. Failure to refresh or a second rejection returns `503` with `Retry-After: 60`.

### Keep authentication semantics unchanged

`withAuth()` continues to force login only for `401`. A `403` from `/plays` is treated as a temporary stream refresh failure when stale data exists, not as proof that the login session is invalid.

## Risks / Trade-offs

- A cached URL may eventually stop working while refreshes continue failing. → The server validates the master and variant during playlist construction and stops using stale information once either is rejected.
- The one-minute cooldown delays recovery after a brief failure. → Actual media rejection still triggers the forced recovery path, while healthy cached media remains uninterrupted.
- Generic `/proxy` child playlist and segment requests cannot identify their channel. → Keep this change scoped to the master and selected variant fetched by `buildLivePlaylist()`.

## Migration Plan

Deploy as an in-place update with no configuration or data migration. Roll back by restoring the previous `v2/voyo-shaka.ts`; all added state is process-local.

## Open Questions

None.
