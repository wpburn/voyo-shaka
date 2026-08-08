## ADDED Requirements

### Requirement: Cached stream refresh tolerates temporary failures
The service SHALL retain and return cached Voyo stream information when its scheduled refresh fails because of a network error or an upstream `401`, `403`, `429`, or `5xx` response.

#### Scenario: Temporary refresh failure with cached stream information
- **WHEN** cached stream information has reached its refresh time and Voyo rejects the refresh temporarily
- **THEN** the service returns the cached stream information and does not expose the refresh status to the player

#### Scenario: Refresh succeeds
- **WHEN** cached stream information has reached its refresh time and Voyo returns new stream information
- **THEN** the service replaces the cached entry and returns the new stream information

#### Scenario: Temporary refresh failure without cached stream information
- **WHEN** Voyo rejects a required stream refresh and no cached stream information is available
- **THEN** the playback endpoint returns `503` with a `Retry-After` header instead of Voyo's status

### Requirement: Stream refreshes are coalesced per channel
The service SHALL allow at most one in-flight Voyo stream refresh for a given cache key.

#### Scenario: Concurrent requests encounter an expired cache entry
- **WHEN** multiple requests attempt to refresh the same channel concurrently
- **THEN** they share one Voyo refresh promise

#### Scenario: Refresh settles
- **WHEN** the shared refresh succeeds or fails
- **THEN** the service removes its in-flight promise so a later refresh can run

### Requirement: Failed refreshes use a short retry cooldown
The service SHALL defer another scheduled refresh for one minute after returning cached stream information because of a temporary refresh failure.

#### Scenario: Player requests continue after a failed refresh
- **WHEN** another player request arrives during the retry cooldown
- **THEN** the service returns cached stream information without calling Voyo `/plays` again

### Requirement: Rejected cached HLS URLs receive one forced recovery attempt
The service SHALL force one stream-info refresh and retry regular HLS playlist construction once when the cached master or selected variant returns `401` or `403`.

#### Scenario: Forced refresh recovers playback
- **WHEN** a cached master or variant is rejected and the forced refresh produces a working URL
- **THEN** the service returns the playlist generated from the refreshed stream information

#### Scenario: Forced recovery fails
- **WHEN** the forced refresh fails or the refreshed master or variant is also rejected
- **THEN** the service returns `503` with `Retry-After: 60` and does not return Voyo's `403`

### Requirement: Stream refresh does not broaden authentication retries
The service MUST continue to force authentication refresh only in response to `401`.

#### Scenario: Voyo stream resolution returns 403
- **WHEN** the `/plays` endpoint returns `403`
- **THEN** the service does not force a Voyo login solely because of that response
