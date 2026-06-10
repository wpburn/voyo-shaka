#!/usr/bin/python3
import sys
import os
import o11
import json
import base64
import secrets
import string
from urllib.parse import urlparse, parse_qs
from bs4 import BeautifulSoup
from pywidevine.cdm import Cdm
from pywidevine.device import Device
from pywidevine.pssh import PSSH

# ─── hardcoded config ────────────────────────────────────────────────────────
SCRIPT_DIR = os.path.abspath(os.path.dirname(__file__))
WVD_PATH   = os.path.join(SCRIPT_DIR, 'WVD.wvd')
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'

# Solocoo backend (shared with FocusSat / Skylink / Vlaanderen etc.)
TVAPI_HOST   = 'https://tvapi.solocoo.tv'
LICENSE_HOST = 'https://license.solocoo.tv'

# Orange Romania OAuth + Solocoo shim hosts
ORANGE_AUTH_BASE   = 'https://www.orange.ro/accounts'
TVGO_BASE          = 'https://tvgo.orange.ro'
TVGO_SOLIPHONE     = TVGO_BASE + '/soliphone'

# Orange OAuth client params — extracted from the public web bundle
OAUTH_CLIENT_ID    = '8ea5139a-199e-40e8-8ea4-40abfd1390f1'
OAUTH_SCOPE        = 'oauth.userinfo.extended orangetvgo.access'
OAUTH_REDIRECT_URI = 'https://tvgo.orange.ro/auth'

# OAuth state value. Hardcoded in the original. Orange doesn't appear to
# validate this strictly. Keeping the literal value to match original
# behavior; rotate it if Orange ever starts enforcing freshness.
OAUTH_STATE = '1705542731139.PC'

# Solocoo brand code for Orange Romania
BRAND = 'oro'
# ─────────────────────────────────────────────────────────────────────────────

# argv parameters
user      = o11.parse_params(sys.argv, 'user')
password  = o11.parse_params(sys.argv, 'password')
device    = o11.parse_params(sys.argv, 'device')

id        = o11.parse_params(sys.argv, 'id')
action    = o11.parse_params(sys.argv, 'action')

bind      = o11.parse_params(sys.argv, 'bind')
proxy     = o11.parse_params(sys.argv, 'proxy')
doh       = o11.parse_params(sys.argv, 'doh')
worker    = o11.parse_params(sys.argv, 'worker')

cdm       = o11.parse_params(sys.argv, 'cdm')
drm       = o11.parse_params(sys.argv, 'drm')
kid       = o11.parse_params(sys.argv, 'kid')
pssh      = o11.parse_params(sys.argv, 'pssh')
challenge = o11.parse_params(sys.argv, 'challenge')

heartbeaturl    = o11.parse_params(sys.argv, 'heartbeaturl')
heartbeatparams = o11.parse_params(sys.argv, 'heartbeatparams')

o11Session = o11.session(bind=bind, proxy=proxy, worker=worker)
req = o11Session.get_session()
if doh != '':
    o11.dns(doh)

if challenge == 'cert':
    challenge = 'CAQ='

authFile = '/orangetv_ro.tokens'

headers = {}


# ─── auth state on disk ──────────────────────────────────────────────────────

def _auth_path():
    return SCRIPT_DIR + authFile


def _load_auth():
    try:
        with open(_auth_path(), 'r') as f:
            return json.load(f)
    except Exception:
        return None


def _save_auth(data):
    try:
        with open(_auth_path(), 'w') as f:
            json.dump(data, f, indent=2)
        return True
    except Exception as e:
        print('Failed saving auth:', e, file=sys.stderr)
        return False


def _generate_device_id(length=20):
    chars = string.ascii_letters + string.digits
    return ''.join(secrets.choice(chars) for _ in range(length))


# ─── header builders ─────────────────────────────────────────────────────────

def _orange_html_headers():
    return {
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Referer':    TVGO_BASE + '/',
        'User-Agent': USER_AGENT,
    }


def _orange_form_headers():
    return {
        'Accept':       'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin':       'https://www.orange.ro',
        'User-Agent':   USER_AGENT,
    }


def _tvgo_json_headers():
    return {
        'Accept':       'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        'Origin':       TVGO_BASE,
        'User-Agent':   USER_AGENT,
    }


def _tvgo_form_headers():
    return {
        'accept':       'application/json, text/plain, */*',
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'origin':       TVGO_BASE,
        'user-agent':   USER_AGENT,
    }


def _tvapi_headers(token=None):
    h = {
        'accept':       'application/json, text/plain, */*',
        'content-type': 'application/json',
        'user-agent':   USER_AGENT,
    }
    if token:
        h['authorization'] = 'Bearer ' + token
    return h


def _media_headers():
    return {
        'accept':     '*/*',
        'user-agent': USER_AGENT,
    }


# ─── device info payload ─────────────────────────────────────────────────────

def _device_info(device_id):
    """Orange Romania-specific device info shape for the Solocoo session call."""
    return {
        'osVersion':         'Windows 10',
        'deviceModel':       'Chrome',
        'deviceType':        'PC',
        'deviceSerial':      device_id,
        'deviceOem':         'Chrome',
        'devicePrettyName':  'Chrome 137.0.0.0',
        'appVersion':        '10.6',
        'language':          'en_US',
        'brand':             BRAND,
        'memberId':          '1',
        'featureLevel':      4,
    }


# ─── auth: five-step Orange OAuth → Solocoo handshake ────────────────────────

def _get_verification_token():
    """
    Step 1: GET /accounts/auth with OAuth params. Returns the CSRF token
    from the hidden form input plus the 'ak' value parsed from the
    response URL's query string.
    """
    h = _orange_html_headers()
    params = {
        'response_type': 'code',
        'client_id':     OAUTH_CLIENT_ID,
        'scope':         OAUTH_SCOPE,
        'access_type':   'offline',
        'redirect_uri':  OAUTH_REDIRECT_URI,
        'state':         OAUTH_STATE,
    }
    r = None
    try:
        r = req.get(ORANGE_AUTH_BASE + '/auth', headers=h, params=params)
        r.raise_for_status()
        soup = BeautifulSoup(r.content, features='lxml')
        inp = soup.find('input', {'name': '__RequestVerificationToken'})
        if not inp or not inp.get('value'):
            print('No __RequestVerificationToken in response', file=sys.stderr)
            return None, None
        ak = r.url.split('=')[-1]
        return inp['value'], ak
    except Exception as e:
        print('Verification token fetch failed:', e, file=sys.stderr)
        if r is not None:
            print(r.text[:400], file=sys.stderr)
        return None, None


def _do_orange_login(verification_token, ak, username, pw):
    """
    Step 2: POST /accounts/login-user with credentials + CSRF token.
    Returns the OAuth 'code' parsed from the redirect URL.
    """
    h = _orange_form_headers()
    params = {'ak': ak, 'ud': '1'}
    body = {
        '__RequestVerificationToken': verification_token,
        'UserDirectory':              '1',
        'username':                   username,
        'password':                   pw,
        'g-recaptcha-response':       '',
    }
    r = None
    try:
        r = req.post(ORANGE_AUTH_BASE + '/login-user',
                     headers=h, params=params, data=body)
        # Don't raise — login failures may render as 200s with error pages
        parsed = urlparse(r.url)
        query  = parse_qs(parsed.query)
        codes  = query.get('code', [])
        if not codes:
            print('No code in redirect URL — check credentials', file=sys.stderr)
            print(f'Final URL: {r.url}', file=sys.stderr)
            return None
        return codes[0]
    except Exception as e:
        print('Orange login failed:', e, file=sys.stderr)
        if r is not None:
            print(r.text[:400], file=sys.stderr)
        return None


def _get_secret(code, device_id):
    """
    Step 3: POST /soliphone/challenge.aspx with the OAuth code and device
    info. Returns ('<id>\\t<secret>', device_id_to_use).

    If the response contains an error with a 'devices' list (device limit
    hit), the device_id is replaced with the first device's ID and the
    secret is still returned for that device.
    """
    h = _tvgo_json_headers()
    body = {
        'autotype':  'ro',
        'app':       BRAND,
        'prettyname': 'Firefox',
        'model':     'web',
        'serial':    device_id,
        'oauthcode': code,
        'apikey':    '',
        'state':     OAUTH_STATE,
    }
    r = None
    try:
        r = req.post(TVGO_SOLIPHONE + '/challenge.aspx', headers=h, json=body)
        r.raise_for_status()
        d = r.json()

        # Device-limit branch: if 'error' is present, the response also
        # includes 'devices' with an existing device ID to reuse.
        if 'error' in d:
            devices = d.get('devices', [])
            if devices and devices[0].get('id'):
                old_id = device_id
                device_id = devices[0]['id']
                print(f'Device limit hit; reusing existing device_id={device_id[:12]}...',
                      file=sys.stderr)

        sid = d.get('id', '')
        sec = d.get('secret', '')
        if not sid or not sec:
            print('challenge: missing id or secret', file=sys.stderr)
            print(r.text[:400], file=sys.stderr)
            return None, device_id

        return f'{sid}\t{sec}', device_id
    except Exception as e:
        print('Get secret failed:', e, file=sys.stderr)
        if r is not None:
            print(r.text[:400], file=sys.stderr)
        return None, device_id


def _do_aspx_login(secret, device_id):
    """
    Step 4: POST /soliphone/login.aspx with the secret + device_id.
    Establishes the session cookies needed for the next step.
    Returns True on success.
    """
    h = _tvgo_form_headers()
    body = {
        'secret': secret,
        'uid':    device_id,
        'app':    BRAND,
    }
    r = None
    try:
        r = req.post(TVGO_SOLIPHONE + '/login.aspx', headers=h, data=body)
        r.raise_for_status()
        return True
    except Exception as e:
        print('ASPX login failed:', e, file=sys.stderr)
        if r is not None:
            print(r.text[:400], file=sys.stderr)
        return False


def _get_sso_token(device_id):
    """
    Step 5: GET /soliphone/capi.aspx?z=ssotoken&u=<device_id>. Returns
    the ssotoken to be passed to Solocoo as 'sapiToken'.
    """
    h = {
        'accept':     'application/json, text/plain, */*',
        'user-agent': USER_AGENT,
    }
    params = {'z': 'ssotoken', 'u': device_id}
    r = None
    try:
        r = req.get(TVGO_SOLIPHONE + '/capi.aspx', headers=h, params=params)
        r.raise_for_status()
        d = r.json()
        return d.get('ssotoken', '')
    except Exception as e:
        print('Get sso token failed:', e, file=sys.stderr)
        if r is not None:
            print(r.text[:400], file=sys.stderr)
        return ''


# ─── Solocoo session exchange ────────────────────────────────────────────────

def _get_session_token(sso_token, device_id):
    """
    Exchange the Orange-issued ssotoken for a Solocoo bearer.
    Returns ('ok', bearer_token) on success,
            ('limit', existing_device_id) if hit device limit,
            ('error', None) otherwise.

    Critical detail: the Solocoo session endpoint expects the field
    named 'sapiToken' for Orange Romania — NOT 'ssoToken' (which is what
    FocusSat/Skylink/Vlaanderen use).
    """
    body = _device_info(device_id)
    body['sapiToken'] = sso_token
    payload = json.dumps(body).replace(' ', '')

    r = None
    try:
        r = req.post(TVAPI_HOST + '/v1/session',
                     headers=_tvapi_headers(), data=payload)
        d = r.json()

        if 'token' in d:
            return 'ok', d['token']

        devices = d.get('solution', {}).get('deviceList', {}).get('devices', [])
        if devices and devices[0].get('deviceId'):
            return 'limit', devices[0]['deviceId']

        print('Unexpected /v1/session response:', file=sys.stderr)
        print(r.text[:400], file=sys.stderr)
        return 'error', None
    except Exception as e:
        print('Session exchange failed:', e, file=sys.stderr)
        if r is not None:
            print(r.text[:400], file=sys.stderr)
        return 'error', None


# ─── login / token management ────────────────────────────────────────────────

def login():
    """Full five-step Orange OAuth → Solocoo handshake."""
    print('logging in...', file=sys.stderr)
    if not user or not password:
        print('user and password required for login', file=sys.stderr)
        return 'error'

    device_id = _generate_device_id()

    # Step 1: Orange CSRF
    verification_token, ak = _get_verification_token()
    if not verification_token or not ak:
        return 'error'

    # Step 2: Orange username/password → OAuth code
    code = _do_orange_login(verification_token, ak, user, password)
    if not code:
        return 'error'

    # Step 3: OAuth code → soliphone secret
    secret, device_id = _get_secret(code, device_id)
    if not secret:
        return 'error'

    # Step 4: soliphone login (sets cookies)
    if not _do_aspx_login(secret, device_id):
        return 'error'

    # Step 5: fetch the ssotoken
    sso_token = _get_sso_token(device_id)
    if not sso_token:
        return 'error'

    # Final: exchange for a Solocoo bearer to validate the chain
    status, payload = _get_session_token(sso_token, device_id)
    if status == 'limit':
        # Adopt the existing device ID and retry. Unlike SolcoTV's
        # removeDevice flow, Orange's Solocoo backend doesn't seem to
        # accept removeDevice — just use the existing slot.
        device_id = payload
        print(f'Solocoo device limit hit; adopting {device_id[:12]}...',
              file=sys.stderr)
        status, payload = _get_session_token(sso_token, device_id)

    if status != 'ok':
        return 'error'

    if not _save_auth({
        'sso_token':  sso_token,
        'device_id':  device_id,
    }):
        return 'error'

    print('logged in successfully', file=sys.stderr)


def get_bearer():
    """
    Get a fresh Solocoo bearer token by exchanging the cached ssoToken.
    Returns (bearer, device_id) or (None, None).
    """
    auth = _load_auth()
    if not auth:
        return None, None
    sso       = auth.get('sso_token', '')
    device_id = auth.get('device_id', '')
    if not sso or not device_id:
        return None, None

    status, payload = _get_session_token(sso, device_id)
    if status != 'ok':
        return None, None
    return payload, device_id


# ─── content + manifest ──────────────────────────────────────────────────────

def _get_channels(token):
    r = None
    try:
        r = req.get(TVAPI_HOST + '/v1/bouquet', headers=_tvapi_headers(token=token))
        r.raise_for_status()
        d = r.json()
        return d.get('channels', []) or []
    except Exception as e:
        print('Get channels failed:', e, file=sys.stderr)
        if r is not None:
            print(r.text[:400], file=sys.stderr)
        return []


def _get_play(token, channel_id):
    body = {
        'player': {
            'name':    'RxPlayer',
            'version': '3.29.0',
            'capabilities': {
                'mediaTypes':  ['DASH'],
                'drmSystems':  ['Widevine'],
                'smartLib':    True,
            },
        },
    }
    payload = json.dumps(body).replace(' ', '')
    r = None
    try:
        r = req.post(f'{TVAPI_HOST}/v1/assets/{channel_id}/play',
                     headers=_tvapi_headers(token=token), data=payload)
        r.raise_for_status()
        d = r.json()
        url = d.get('url', '')
        lic_url = d.get('drm', {}).get('licenseUrl', '')
        if not url or not lic_url:
            print('play: missing url or drm.licenseUrl', file=sys.stderr)
            print(r.text[:400], file=sys.stderr)
            return None, None
        return url, lic_url
    except Exception as e:
        print('Get play failed:', e, file=sys.stderr)
        if r is not None:
            print(r.text[:400], file=sys.stderr)
        return None, None


def _get_pssh_and_resolved_url(manifest_url):
    r = None
    try:
        r = req.get(manifest_url, headers=_media_headers())
        r.raise_for_status()
        resolved = r.url
        soup = BeautifulSoup(r.content, features='xml')
        pssh_b64 = ''
        for cp in soup.find_all('ContentProtection'):
            if cp.get('schemeIdUri', '').lower() == 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed':
                tag = cp.find('cenc:pssh')
                if tag and tag.text:
                    pssh_b64 = tag.text
                    break
        return pssh_b64, resolved
    except Exception as e:
        print('PSSH extraction failed:', e, file=sys.stderr)
        if r is not None:
            print(r.text[:400], file=sys.stderr)
        return '', manifest_url


# ─── license helpers ─────────────────────────────────────────────────────────

def _post_license(license_url, challenge_bytes):
    h = {
        'accept':       '*/*',
        'content-type': 'application/octet-stream',
        'user-agent':   USER_AGENT,
    }
    return req.post(license_url, headers=h, data=challenge_bytes)


def _do_wv_cdm(pssh_b64, license_url):
    licence = None
    try:
        device_obj = Device.load(WVD_PATH)
        wv_cdm     = Cdm.from_device(device_obj)
        sid        = wv_cdm.open()
        wv_chal    = wv_cdm.get_license_challenge(sid, PSSH(pssh_b64))

        licence = _post_license(license_url, wv_chal)
        licence.raise_for_status()

        wv_cdm.parse_license(sid, licence.content)

        keys = []
        for key in wv_cdm.get_keys(sid):
            if key.type != 'SIGNING':
                keys.append(f'{key.kid.hex}:{key.key.hex()}')
        wv_cdm.close(sid)
        return keys
    except Exception as e:
        print('CDM failed:', e, file=sys.stderr)
        if licence is not None:
            try:
                print(f'License HTTP {licence.status_code}: {licence.text[:400]}',
                      file=sys.stderr)
            except Exception:
                pass
        return None


# ─── action handlers ─────────────────────────────────────────────────────────

def do_action():
    if action == 'login':
        result = login()
        sys.exit(0 if result != 'error' else 1)

    if action == 'heartbeat':
        sys.exit()

    bearer, device_id = get_bearer()
    if not bearer:
        return 'error'

    if action == 'channels':
        channels = _get_channels(bearer)
        if not channels:
            return 'error'

        output = {'Channels': []}
        for c in channels:
            info = c.get('assetInfo', {}) or {}
            name = (info.get('title') or 'Unknown').replace('/', '-')
            cid  = info.get('id')
            if cid is None:
                continue
            output['Channels'].append({
                'Name':            name,
                'Mode':            'live',
                'SessionManifest': True,
                'ManifestScript':  'id=' + str(cid),
                'CdmType':         'widevine',
                'UseCdm':          True,
                'Cdm':             'id=' + str(cid),
                'Video':           'best',
                'OnDemand':        True,
                'SpeedUp':         True,
            })
        print(json.dumps(output, indent=2))

    elif action == 'manifest':
        channel_id = id[3:] if id.startswith('id=') else id
        if not channel_id:
            print('manifest: id parameter required', file=sys.stderr)
            return 'error'

        manifest_url, license_url = _get_play(bearer, channel_id)
        if not manifest_url or not license_url:
            return 'error'

        pssh_b64, resolved_url = _get_pssh_and_resolved_url(manifest_url)

        auth = _load_auth() or {}
        auth['manifest_cache'] = {
            'manifest_url': resolved_url,
            'license_url':  license_url,
            'pssh':         pssh_b64,
            'channel_id':   str(channel_id),
        }
        _save_auth(auth)

        output = {
            'Cdn':         [{'Name': 'default', 'ManifestUrl': resolved_url}],
            'ManifestUrl': resolved_url,
            'Headers': {
                'Manifest': _media_headers(),
                'Media':    _media_headers(),
            },
            'Heartbeat': {'Url': '', 'Params': '', 'PeriodMs': 5 * 60 * 1000},
        }
        print(json.dumps(output))

    elif action == 'cdm' and cdm == 'internal':
        auth  = _load_auth() or {}
        cache = auth.get('manifest_cache', {})
        license_url = cache.get('license_url', '')
        if not license_url:
            print('cdm=internal: no license_url cached — run manifest first',
                  file=sys.stderr)
            return 'error'

        licence = None
        try:
            challenge_bytes = base64.b64decode(challenge)
            licence = _post_license(license_url, challenge_bytes)

            print(
                f'License HTTP {licence.status_code}, '
                f'body_bytes={len(licence.content)}, '
                f'first8={licence.content[:8].hex() if licence.content else "empty"}',
                file=sys.stderr
            )

            if licence.status_code != 200 or not licence.content:
                print(f'License request failed: {licence.text[:400]}', file=sys.stderr)
                return 'error'

            response_b64 = base64.b64encode(licence.content).decode('ascii')
            if response_b64.startswith('CA'):
                print(response_b64)
            else:
                print(f'License response did not start with CA: {licence.text[:400]}',
                      file=sys.stderr)
                return 'error'
        except Exception as e:
            print('CDM internal error:', e, file=sys.stderr)
            return 'error'

    elif action == 'cdm' and cdm == 'external':
        auth  = _load_auth() or {}
        cache = auth.get('manifest_cache', {})
        license_url = cache.get('license_url', '')
        pssh_b64    = pssh if pssh else cache.get('pssh', '')

        if not license_url:
            print('cdm=external: no license_url cached — run manifest first',
                  file=sys.stderr)
            return 'error'
        if not pssh_b64:
            print('cdm=external: no PSSH available', file=sys.stderr)
            return 'error'

        keys = _do_wv_cdm(pssh_b64, license_url)
        if not keys:
            return 'error'
        for k in keys:
            print(k)

    else:
        print('invalid action: ' + action, file=sys.stderr)
        return 'error'


# ─── entry point with auto-relogin ───────────────────────────────────────────

if do_action() == 'error':
    print('action failed, attempting fresh login...', file=sys.stderr)
    if login() == 'error':
        sys.exit(1)
    do_action()
