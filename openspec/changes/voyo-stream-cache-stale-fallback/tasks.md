## 1. Resilient Stream Cache

- [x] 1.1 Add temporary-error classification, a one-minute retry cooldown, and per-channel single-flight refreshes to `getStreamInfo()`.
- [x] 1.2 Increase the normal stream refresh interval to 30 minutes while preserving forced-refresh behavior.

## 2. HLS Recovery

- [x] 2.1 Refactor regular HLS playlist fetching so cached master or variant `401/403` responses force one refresh and one retry.
- [x] 2.2 Return `503 Retry-After: 60` from playback routes when required stream resolution or forced HLS recovery cannot succeed.

## 3. Verification

- [x] 3.1 Run Deno type checking for `v2/voyo-shaka.ts` and resolve any errors.
- [x] 3.2 Validate the OpenSpec change and review the final diff for scoped behavior and unchanged `withAuth()` semantics.
