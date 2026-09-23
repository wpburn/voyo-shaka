## ADDED Requirements

### Requirement: Independent discovery controls
The Voyo Shaka index page SHALL provide separate controls for refreshing Sport discoveries and Premier League discoveries.

#### Scenario: Refresh Sport discoveries
- **WHEN** the operator clicks the Sport discovery control
- **THEN** the service requests fresh Sport discovery data and updates only the Sport discovery section

#### Scenario: Refresh Premier League discoveries
- **WHEN** the operator clicks the Premier League discovery control
- **THEN** the service requests fresh Premier League discovery data and updates only the Premier League discovery section

### Requirement: Configured overview categories
The service SHALL request Voyo overview category `6` for Sport discovery and SHALL request the category identified by `VOYO_PREMIER_LEAGUE_CATEGORY_ID` for Premier League discovery, defaulting that configuration to `334`.

#### Scenario: Default Premier League category
- **WHEN** `VOYO_PREMIER_LEAGUE_CATEGORY_ID` is not configured
- **THEN** Premier League discovery requests Voyo overview category `334`

#### Scenario: Overridden Premier League category
- **WHEN** `VOYO_PREMIER_LEAGUE_CATEGORY_ID` contains a valid category ID
- **THEN** Premier League discovery requests that category instead of `334`

### Requirement: Every discovery action refreshes upstream data
Every discovery-button action SHALL bypass the selected scope's cached snapshot, request the current Voyo overview response, and replace that scope's entries only after a successful response is parsed.

#### Scenario: Repeated discovery
- **WHEN** the operator clicks the same discovery control again after a successful discovery
- **THEN** the service performs another upstream request rather than returning the existing snapshot as fresh

#### Scenario: Category results change
- **WHEN** a forced refresh succeeds with entries different from the previous snapshot
- **THEN** the service replaces the selected scope's old entries with exactly the newly discovered entries

#### Scenario: Simultaneous clicks for one scope
- **WHEN** multiple refresh requests for the same discovery scope overlap
- **THEN** the requests share one in-flight upstream refresh

### Requirement: Dedicated live carousel extraction
The service SHALL extract Sport entries from the `Sport Live` section and Premier League entries from the `Premier League Live` section of their respective overview responses.

#### Scenario: Sport live carousel is present
- **WHEN** category `6` contains a `Sport Live` content section
- **THEN** every item in that section is returned as a Sport discovery entry

#### Scenario: Premier League live carousel is present
- **WHEN** the configured Premier League category contains a `Premier League Live` content section
- **THEN** every item in that section is returned as a Premier League discovery entry

#### Scenario: Expected carousel is missing
- **WHEN** a successful Voyo response does not contain the expected live section
- **THEN** the service treats the refresh as failed instead of ingesting another section

### Requirement: Discovered event normalization
The service SHALL normalize discovered carousel items into playable event entries containing a canonical content ID, title, image, release-date label, and live label when supplied by Voyo.

#### Scenario: Typed episode ID is returned
- **WHEN** Voyo returns an item with ID `episode-139785`
- **THEN** the discovery entry uses canonical content ID `episode.139785` and remains addressable through the existing event playback routes

#### Scenario: Duplicate item within a category
- **WHEN** the same canonical content ID occurs more than once in one live carousel
- **THEN** the discovery snapshot contains one entry for that content ID

#### Scenario: Future event is not yet playable
- **WHEN** Voyo lists an upcoming event whose stream is not yet available
- **THEN** discovery still returns the event without requiring a successful `/plays` probe

### Requirement: Separate presentation with shared playback
The UI SHALL display Sport and Premier League discoveries in separate sections, while the service SHALL make their entries available to the existing player, live playlist, VLC, DRM, and stream diagnostic routes.

#### Scenario: Event appears in both discovery scopes
- **WHEN** the same event is present in both Sport and Premier League snapshots
- **THEN** the UI may display it in both sections while shared playback lookup resolves one canonical event entry

#### Scenario: Operator plays a discovered event
- **WHEN** the operator selects a discovered event's existing play or VLC action
- **THEN** the service resolves it through the existing Voyo stream and DRM pipeline

### Requirement: Last-successful fallback
The service SHALL retain the last successful snapshot for each discovery scope when a later forced refresh fails.

#### Scenario: Refresh fails after prior success
- **WHEN** Voyo authentication, network access, response parsing, or the expected-section lookup fails after a scope has a successful snapshot
- **THEN** the service returns that snapshot marked stale together with the refresh error

#### Scenario: First refresh fails
- **WHEN** a scope has no successful snapshot and its refresh fails
- **THEN** the service returns an error and no discovered entries for that scope

### Requirement: Discovery APIs are protected
The service SHALL apply the existing UI Basic authentication requirement to discovery endpoints and SHALL keep Voyo credentials and bearer tokens server-side.

#### Scenario: Unauthenticated discovery request
- **WHEN** a client calls a discovery endpoint without valid UI Basic authentication
- **THEN** the service returns the existing authentication challenge without contacting Voyo
