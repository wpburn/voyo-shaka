# Orange TV Romania (OrangeTVRo) — o11 Integration Manual

## Overview

`OrangeTVRo.py` integrates Orange Romania's TV GO service (`tvgo.orange.ro`) into the o11 pro panel as a Widevine-DRM live channel source. It exposes the standard o11 action set (`login`, `channels`, `manifest`, `cdm`, `heartbeat`) with both internal license relay and external CDM key extraction supported.

This is a different product from Spanish OrangeTV (covered by the earlier `orangetv.py` script). Romania's Orange TV runs on a hybrid stack: an **Orange OAuth provider** at `www.orange.ro/accounts` for credential verification, followed by a series of `tvgo.orange.ro/soliphone/*` shim endpoints, terminating in a standard **Solocoo backend** at `tvapi.solocoo.tv` for the actual playback. The five-step login is the most involved auth flow in this toolchain.

## Files

| File | Location | Purpose |
|---|---|---|
| `OrangeTVRo.py` | panel `scripts/` directory | The script itself |
| `WVD.wvd` | alongside the script | Widevine device file (only required for `cdm=external`) |
| `requirements.txt` | alongside the script (optional) | Pip install reference |
| `orangetv_ro.tokens` | created at runtime, alongside the script | Cached auth state |

## Installation

1. Drop `OrangeTVRo.py` into your panel's scripts directory (the same place `o11.py` lives).
2. Install dependencies:
   ```
   pip install -r requirements.txt
   ```
   On Python 3.11.
3. If you intend to use the local CDM path (`cdm=external`), drop your `WVD.wvd` next to the script.
4. Verify `o11.py` is importable from the same directory.

## Authentication

### One-time login

```
python3 OrangeTVRo.py action=login user=YOUR_EMAIL password=YOUR_PASSWORD
```

On success: `logged in successfully` to stderr, exit code 0, and `orangetv_ro.tokens` is created next to the script containing the ssoToken and device ID.

### The five-step login flow

Orange Romania's auth model bridges two systems — Orange's identity provider and Solocoo's playback platform. The script automates all five hops:

1. **GET `orange.ro/accounts/auth`** with OAuth params (client_id, scope, redirect URI). Returns an HTML page containing a hidden `__RequestVerificationToken` CSRF input plus an `ak` value in the URL.
2. **POST `orange.ro/accounts/login-user`** with username/password + the CSRF tokens. Orange validates credentials and redirects with an OAuth `code` in the query string.
3. **POST `tvgo.orange.ro/soliphone/challenge.aspx`** with the OAuth code and device info. Returns `{id, secret}` which together form an opaque session credential.
4. **POST `tvgo.orange.ro/soliphone/login.aspx`** with `secret` + `device_id`. Establishes session cookies.
5. **GET `tvgo.orange.ro/soliphone/capi.aspx?z=ssotoken`** retrieves the `ssotoken` value.

Finally the script POSTs `tvapi.solocoo.tv/v1/session` with the ssotoken as `sapiToken` (note: not `ssoToken`) to obtain the Solocoo bearer. Only `sso_token` and `device_id` are persisted — the intermediate OAuth code, secret, and aspx cookies are throw-away.

### Device limit handling

Orange's flow has its own device-limit response separate from Solocoo's. If `challenge.aspx` returns an error with a `devices` list, the script adopts the first existing device ID and continues. If the final Solocoo session call returns a device-limit response, the script adopts that device ID and retries. Unlike SolcoTV's `removeDevice` flow, Orange's Solocoo backend doesn't accept explicit eviction — adoption is the only option.

### How the chain stays alive

Every non-login action invocation:

1. Reads `sso_token` and `device_id` from `orangetv_ro.tokens`.
2. POSTs `/v1/session` to exchange the ssoToken for a fresh bearer.
3. Uses the bearer for the actual API call.

The ssoToken is long-lived but **not rotated** — the same value is reused indefinitely until Orange invalidates it server-side. When that eventually happens (password change, account suspension, or just long enough idle), the auto-relogin tail re-runs the full five-step flow using `user`/`password` from argv — provided they're passed on the failing call.

In practice, panels only pass credentials on the explicit login action, so a broken chain will require running `action=login` manually.

## Actions

### `action=login user=<email> password=<password>`

Runs the full five-step OAuth + Solocoo handshake. Required once per chain bootstrap.

### `action=channels`

Fetches `/v1/bouquet` and emits o11 channel JSON. Each entry uses `SessionManifest=True` and `UseCdm=True`.

### `action=manifest id=<channel_id>`

Calls `/v1/assets/<channel_id>/play` for the bearer token, picks the DASH URL and `drm.licenseUrl`, follows the manifest URL for redirects, and extracts the Widevine PSSH from the resolved MPD.

Caches `manifest_url`, `license_url`, and `pssh` to the auth file for the subsequent `cdm` call.

### `action=cdm cdm=internal challenge=<base64>`

License relay. POSTs the challenge to `license.solocoo.tv` (cached licenseUrl) with no extra auth headers — Solocoo's license endpoint authorizes via the challenge payload.

Diagnostic logging is always emitted to stderr in the form:
```
License HTTP <status>, body_bytes=<n>, first8=<hex>
```

### `action=cdm cdm=external pssh=<base64>`

Local CDM. Uses `WVD.wvd` to build the challenge, POSTs to the license server, parses the response with pywidevine, and emits `kid:key` lines on stdout. If `pssh=` is omitted, falls back to the PSSH cached during the manifest action.

### `action=heartbeat`

No-op. Exits immediately.

## Optional argv parameters

| Param | Purpose |
|---|---|
| `bind`, `proxy`, `doh`, `worker` | Standard o11 network plumbing. |
| `device=<id>` | Parsed but unused. The script generates its own device ID. |

## DRM technical notes

- **`sapiToken`, not `ssoToken`.** Orange Romania's Solocoo session endpoint expects the token field named `sapiToken` — this is the brand-specific divergence from FocusSat/Skylink/Vlaanderen which all use `ssoToken`. If you ever port the script to a new Solocoo brand, double-check the field name.
- **Brand code is `oro`.** Used in the `brand` field of device info and `app` field of the soliphone calls. Distinct from FocusSat's `fsro`.
- **License server is shared.** `license.solocoo.tv` serves all Solocoo brands; no special headers, no Bearer auth — challenge bytes go directly.
- **PSSH is inline in the MPD.** Standard `<cenc:pssh>` element.
- **Manifest URL has session-bound query params.** The `url` from `/v1/assets/{id}/play` is a CDN URL with signing parameters. These must not be stripped — segment fetches authenticate against them.
- **OAuth state value is hardcoded.** `1705542731139.PC` — a literal from the original script (a timestamp from January 2024). Orange doesn't appear to validate this strictly. If they ever start enforcing freshness, regenerate it per call.
- **`g-recaptcha-response` is empty.** Sent as `''`. Orange's login endpoint doesn't currently enforce reCAPTCHA for username/password flow. If they enable it, the script will start failing at step 2 and would need a captcha-solving integration to recover.

## Troubleshooting

**`user and password required for login`**
You ran `action=login` without credentials.

**`No __RequestVerificationToken in response`**
Step 1 failed to render the login page. Most often: geo-block (Orange Romania is RO-only — route via a `proxy=` argv exiting in Romania), or the OAuth params have changed.

**`No code in redirect URL — check credentials`**
Step 2 failed. Username/password rejected, or reCAPTCHA was triggered (visible as a captcha challenge in the response HTML). Verify credentials by signing in via the web app.

**`challenge: missing id or secret`**
Step 3 failed. The OAuth code from step 2 was accepted but Orange's soliphone shim couldn't issue session credentials. Often transient; retry. If persistent, the account may be in a partial-registration state — check by signing in via the web app.

**`Device limit hit; reusing existing device_id=...`**
Informational. Orange hit the device cap and the script adopted an existing slot.

**`ASPX login failed`**
Step 4 failed. Network-level issue or the soliphone shim is down. Stderr will show the response body.

**`Get sso token failed`**
Step 5 failed. The aspx session cookies from step 4 didn't carry through to step 5. With curl_cffi this should be automatic; if it persists, check that no proxy or intermediate device is stripping cookies.

**`Unexpected /v1/session response`**
Final Solocoo session call returned a JSON shape the script doesn't recognize. The first 400 bytes are printed in stderr.

**`License HTTP 403`** in the cdm diagnostic line
The session payload in the challenge has expired. Make sure the panel calls `manifest` immediately before `cdm` — Solocoo's license sessions are short.

**`License response did not start with CA`**
Solocoo returned 200 but with a non-license body. Body is printed in stderr.

**Login fails with no clear error after months of working**
Orange occasionally rotates their OAuth client_id, scopes, or redirect_uri. Inspect a fresh browser login session and update the OAuth constants at the top of the script.

## Notes on conversion choices

- **Five-step login preserved exactly.** Each step is a separate function with explicit error returns so failures are diagnosable at the boundary they occurred. The original used a `requests.Session()` to thread cookies through the chain; curl_cffi via `req` does the same automatically.
- **OAuth `state` value left hardcoded.** Matches original behavior. Orange doesn't appear to validate it. If/when they do, regeneration is a one-line change.
- **`sapiToken` field name preserved.** This is the brand-specific Solocoo divergence — getting it wrong would silently break the session exchange.
- **Device-limit branches at TWO points.** Orange's flow can hit device limits at step 3 (`challenge.aspx`) and at the final Solocoo session call. Both are handled. The first adopts the existing device ID immediately; the second adopts it and retries the session call.
- **Manifest URL query preserved.** Original stripped `?...` for xaccel's `decryption_key=` URL convention. The o11 panel handles keys separately and needs the CDN signing query.
- **License URL caching for cdm.** Standard pattern — both cdm modes reuse the cached license URL.
- **ssoToken cached, not rotated.** Unlike other Solocoo brands (FocusSat, Skylink) where the session exchange rotates the ssoToken, Orange Romania's flow doesn't rotate it — the same ssoToken is used until it dies.
- **Hardcoded literal `\t` in secret string preserved.** The original used `f'{data["id"]}\t{data["secret"]}'` with a literal tab character. The soliphone backend expects this exact format.
- **Removed:** `ascii_clear`, `pwinput`, `signal_handler`, `channel_picker`, `manual_selection`, `updater`, all `xaccel.*` calls, `config.json` integration, the menu prompt — all panel-incompatible.
- **No emoji in stderr.** Per the o11 framework conventions inherited from the existing scripts in this toolchain.
