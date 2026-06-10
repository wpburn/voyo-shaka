# SolcoTV (Solocoo Multi-Platform) — o11 Pro Integration Manual

## Overview

`SolcoTV.py` is a single-script o11 integration for **eight Solocoo-powered OTT services** across Europe. Solocoo is a white-label streaming platform; the same backend serves multiple operators under different brand identifiers, with two distinct backend host pairs.

| Platform value | Service | Country | Backend |
|---|---|---|---|
| `focussat` | FocusSat | Romania | m7 |
| `skylinkcz` | Skylink | Czech Republic | m7 |
| `skylinksk` | Skylink | Slovakia | m7 |
| `vlaanderen` | TV Vlaanderen | Belgium | m7 |
| `directone` | DirectOne | Hungary | m7 |
| `canalat` | CanalPlus | Austria | m7cp |
| `canaldigitaal` | Canal Digitaal / CanalPlus | Netherlands | m7cp |
| `canalplushu` | CanalPlus | Hungary | m7cp |

The script auto-routes between the two backend host pairs based on the platform:
- **m7 backend:** `m7.login.solocoo.tv` + `tvapi.solocoo.tv` (Skylink CZ/SK, Vlaanderen, FocusSat, DirectOne)
- **m7cp backend:** `m7cp.login.solocoo.tv` + `tvapi-hlm2.solocoo.tv` (CanalPlus AT/NL/HU)

Unlike browser-cookie-based scripts in this toolchain (Kayo, TodTR, SkyCh), Solocoo has a real username/password login endpoint — no manual cookie capture is required.

## Files

| File | Location | Purpose |
|---|---|---|
| `solcotv_o11.py` | panel `scripts/` directory | The script itself |
| `solcotv_config.json` | alongside the script, **created automatically on first run** | Platform selection |
| `WVD.wvd` | alongside the script | Widevine device file (only required for `cdm=external`) |
| `requirements.txt` | alongside the script (optional) | Pip install reference |
| `solcotv_<platform>.tokens` | created at runtime, alongside the script | Cached auth state — one file per platform |

## Installation

1. Drop `SolcoTV.py` into your panel's scripts directory (the same place `o11.py` lives).
2. Install dependencies:
   ```
   pip3 install -r solcotv_requirements.txt
   ```
   On Python 3.11.
3. If you intend to use the local CDM path (`cdm=external`), drop your `WVD.wvd` next to the script.
4. Verify `o11.py` is importable from the same directory.
5. Run the script once with no special arguments (e.g. `python3 SolcoTV.py action=channels`) — it will create `solcotv_config.json` with default platform (`focussat`) and exit. Edit that file to your actual platform before running login.

## Configuration

### `solcotv_config.json`

```json
{
  "platform": "focussat",
  "_comment_platform": "One of: skylinkcz, skylinksk, vlaanderen, focussat, directone, canalat, canaldigitaal, canalplushu"
}
```

Set `platform` to the value matching your subscription. The script reads this file on every invocation. If the file is missing, it's auto-created with `focussat` as the default — change it before logging in.

The `_comment_platform` field is informational; the script ignores any keys that aren't `platform`.

### Switching platforms

If you need to run multiple Solocoo services from the same panel (e.g. FocusSat *and* CanalDigitaal), you have two options:

1. **One script, multiple `tokens` files.** The script writes auth state to `solcotv_<platform>.tokens` — so logging in to FocusSat and then logging in to CanalDigitaal (after editing the config) doesn't overwrite either auth. The panel would need to invoke the script with different `platform=` argv overrides per call.

2. **Multiple script copies.** Drop two copies of `SolcoTV.py` with two separate config files in different directories. Simpler if your panel doesn't pass `platform=` cleanly per-call.

The `platform=` argv parameter, if present, **overrides the config file** — this is useful for ad-hoc testing without editing JSON.

## Authentication

### One-time login

```
python3 SolcoTV.py action=login user=YOUR_EMAIL password=YOUR_PASSWORD
```

To override the configured platform for this call:
```
python3 SolcoTV.py action=login user=YOUR_EMAIL password=YOUR_PASSWORD platform=skylinkcz
```

On success: `logged in successfully (platform=<platform>)` to stderr, exit code 0, and `solcotv_<platform>.tokens` appears next to the script.

### How the auth flow works

1. A fresh 20-character device ID is generated.
2. `/v1/provision` is POSTed with the device info, returning `provisionData`.
3. `<login_host>/login` is POSTed with `deviceInfo + provisionData`, signed with the Solocoo Authorization header, returning a `ticket`.
4. `<login_host>/login` is POSTed again with `ticket + userInput{username, password}`, signed, returning an `ssoToken`.
5. `<api_host>/v1/session` is POSTed with `ssoToken + deviceInfo`, returning a bearer `token` and a **rotated** `ssoToken`.

The script persists `device_id`, `sso_token`, and `platform` to disk. The bearer token is short-lived and is re-fetched on every non-login action.

### Device limit handling

If your account already has the maximum number of registered devices, the `/v1/session` call returns a `solution.deviceList.devices` array instead of a token. Unlike the simpler "adopt the existing device" approach used by some scripts, this version follows the **official Solocoo eviction flow**:

1. First `/v1/session` call returns the device list.
2. Script picks the first device in the list and makes a *second* `/v1/session` call with `removeDevice=<that_device_id>` in the body.
3. The server evicts that slot and grants the session with the new device.

The originally-evicted device (typically an old phone or browser) will be signed out the next time it tries to call the API. If you want to evict a specific device rather than the first one, currently you'd need to edit the script — but for most users the first device in the list is the right choice (Solocoo orders by least-recently-used).

### How the ssoToken stays fresh

Every non-login action invocation:

1. Reads `device_id` and `sso_token` from the auth file.
2. POSTs `/v1/session` to exchange the ssoToken for a fresh bearer token.
3. Receives a rotated ssoToken alongside the bearer.
4. Writes the rotated ssoToken back to the auth file.
5. Uses the bearer for the actual API call.

As long as the panel calls the script regularly, the chain self-maintains indefinitely. The script has an **auto-relogin tail**: if any action errors, it tries a fresh login (using `user`/`password` from argv if present) and retries the action. In practice, the panel only passes credentials on the explicit login action, so a broken chain still typically requires a manual re-login.

## Actions

### `action=login user=<email> password=<password> [platform=<id>]`

Performs the full provision/ticket/login/session flow.

### `action=channels`

Fetches `/v1/bouquet` and emits o11 channel JSON. Channels with empty `sources` arrays are filtered out (these are channels the account has no rights to). Each entry uses `SessionManifest=True` and `UseCdm=True`.

### `action=manifest id=<channel_id>`

Calls `/v1/assets/<channel_id>/play` for the bearer token, picks the DASH URL and `drm.licenseUrl`, follows the manifest URL for redirects, and extracts the Widevine PSSH from the resolved MPD.

Caches `manifest_url`, `license_url`, and `pssh` to the auth file for the subsequent `cdm` call.

### `action=cdm cdm=internal challenge=<base64>`

License relay. POSTs the challenge to the cached `licenseUrl` (always `license.solocoo.tv`) with no extra auth headers — Solocoo's license endpoint authorizes via the challenge payload itself.

Diagnostic logging is always emitted to stderr in the form:
```
License HTTP <status>, body_bytes=<n>, first8=<hex>
```

### `action=cdm cdm=external pssh=<base64>`

Local CDM. Uses `WVD.wvd` to build the challenge, POSTs to the license server, parses the response with pywidevine, and emits `kid:key` lines on stdout. If `pssh=` is omitted, falls back to the PSSH cached during the manifest action.

### `action=heartbeat`

No-op. Exits immediately.

## Optional argv parameters

| Param | Default | Purpose |
|---|---|---|
| `platform=<id>` | from config | Override the configured platform for this call. |
| `bind`, `proxy`, `doh`, `worker` | empty | Standard o11 network plumbing. |
| `device=<id>` | (generated) | Parsed but unused. The script generates its own device ID. |

## DRM technical notes

- **License server has no auth headers.** Unusual but accurate — Solocoo's `license.solocoo.tv` endpoint accepts the Widevine challenge directly, with session authorization baked into the challenge payload by the API. No `Authorization`, no cookies on the license POST.
- **PSSH is inline in the MPD.** Standard `<cenc:pssh>` element under `urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed`.
- **Manifest URL has session-bound query params.** The `url` returned by `/v1/assets/{id}/play` is a CDN URL with signing parameters. These must not be stripped — segment fetches authenticate against them.
- **The signature scheme.** `Authorization: Client key=android.t3HFsLbBa08,time=<unix>,sig=<sig>`. The sig is HMAC-SHA256 of `url + base64(SHA256(body)) + time` using a hardcoded key embedded in the Solocoo Android app. Both base64 operations use URL-safe alphabet with padding stripped. Same scheme across all eight platforms.
- **Two backend host pairs.** Per the platform table at the top: m7 brands hit `tvapi.solocoo.tv` and `m7.login.solocoo.tv`; m7cp brands (CanalPlus family) hit `tvapi-hlm2.solocoo.tv` and `m7cp.login.solocoo.tv`. Auto-routed based on the `platform` value — you don't configure hosts directly.

## Troubleshooting

**`Invalid platform: <name>`**
The platform value isn't in the supported list. Check spelling in `solcotv_config.json` and confirm against the table at the top of this manual.

**`Invalid credentials`**
Username or password is wrong. Solocoo's response includes either `label: invalid.credentials` or `Message: validation failed` — the script detects both and bails cleanly without retrying.

**`Provision failed`** / **`Ticket fetch failed`**
The pre-login endpoints rejected the request. Most common causes:
1. Wrong `platform` for the account (a FocusSat account won't authenticate against `skylinkcz`).
2. Geo-block — Solocoo backends do geo-validate. Route via a `proxy=` argv exiting in the appropriate country.
3. Account is suspended or password-locked on the operator side.

**`Device limit reached; evicting <device_id>...`**
Informational, not an error. The script detected your account is at its device cap and evicted the oldest device to make room. The original owner of that slot will be signed out the next time it calls the API.

**`Unexpected /v1/session response`**
Solocoo returned a JSON shape the script doesn't recognize. The first 400 bytes of the response are printed — paste those and the response can be interpreted. Most likely a new error code or a server-side maintenance window.

**`License HTTP 403`** in the cdm diagnostic line
The session payload in the challenge has expired. Make sure the panel calls `manifest` immediately before `cdm` — Solocoo's license sessions are short.

**`License HTTP 200, body_bytes=0`**
Account hit a concurrent-CDM-session cap. Wait or close existing playbacks.

**`License response did not start with CA`**
Solocoo returned 200 but with a non-license body (typically a JSON error). The body is printed in stderr.

**Channel list is empty after a successful `channels` action**
All channels were filtered out because their `sources` arrays were empty. This usually means the bearer was valid but the account has no live-TV rights — only VOD or recordings. Live-TV access has to be enabled on the operator side.

**Wrong country / wrong channels showing up**
Make sure `platform` in `solcotv_config.json` matches your actual subscription, and that no `platform=` argv is overriding it. CanalDigitaal NL and CanalPlus AT both use `m7cp` brand but have different `platform` values — getting the right one matters for which channel bundle is returned.

## Notes on conversion choices

- **Eight platforms, one script.** The original was a single script with all eight platforms hardcoded but with interactive prompts to choose one. The o11 version moves selection to `solcotv_config.json` with an `argv` override option, and auto-routes the host pair based on the chosen platform.
- **External config file as requested.** Auto-created on first run with the default platform; user edits to switch. The `_comment_platform` field is documentation embedded in the JSON for discoverability.
- **Device-limit eviction done properly.** The original made two `/v1/session` calls: first to get the device list, second with `removeDevice=<id>` to evict. This is the *official* Solocoo Android app flow. The earlier FocusSat conversion in this toolchain used the simpler "adopt the existing device ID" approach — SolcoTV uses the eviction flow, which is more reliable because it doesn't depend on the new login working with a stolen device ID.
- **Signature scheme cleaned up.** The original had ~60 lines of hand-rolled base64 bit-shifting (`p()`, `b()`, `v()`, `L0()`) — functionally `base64.urlsafe_b64encode(...).rstrip(b'=')` plus stdlib `hashlib.sha256` and `hmac.new`. Replaced.
- **Credential error detection preserved.** The original detected `invalid.credentials` and `validation failed` in the login response and quit cleanly rather than retrying. Worth keeping — prevents wasted retry storms on bad passwords.
- **ssoToken rotation persisted on every call.** Critical detail: Solocoo rotates the ssoToken on most `/v1/session` calls. The o11 version writes the rotated ssoToken every time, preventing silent chain breakage.
- **Manifest URL query preserved.** Original stripped `?...` for xaccel's `decryption_key=` URL convention. The o11 panel handles keys separately, so the query stays intact.
- **`appVersion` unified at `12.7.1`.** The original SolcoTV used a single appVersion across all platforms (newer than the earlier FocusSat script which had per-platform versions). Following the latest convention.
- **Auto-create config on first run.** If `solcotv_config.json` is missing, the script creates one with the default platform and prints a notice to stderr. Avoids the "what file do I need to make" friction.
- **Removed:** `ascii_clear`, `signal_handler`, `channel_picker`, `pwinput`, interactive platform prompt, `manual_selection`, `updater`, all `xaccel.*` calls, the menu prompt, the leftover `print(response.status_code, response.content)` debug lines — all panel-incompatible.
- **No emoji in stderr.** Per the o11 framework conventions inherited from the existing scripts in this toolchain.
