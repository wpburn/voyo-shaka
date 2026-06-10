#!/usr/bin/python3
import sys
import os
import o11
import json
import base64
import hashlib
import hmac
import secrets
import string
import datetime
from bs4 import BeautifulSoup
from pywidevine.cdm import Cdm
from pywidevine.device import Device
from pywidevine.pssh import PSSH

# ─── hardcoded config ────────────────────────────────────────────────────────
SCRIPT_DIR  = os.path.abspath(os.path.dirname(__file__))
WVD_PATH    = os.path.join(SCRIPT_DIR, 'WVD.wvd')
CONFIG_PATH = os.path.join(SCRIPT_DIR, 'solcotv_config.json')

USER_AGENT  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'

# Solocoo signature scheme — HMAC key and client key are baked into the
# Android app; same across all Solocoo-powered brands.
HMAC_KEY   = bytes.fromhex('49a056ab6e76c13069cf0af2328c8e3f3c07089ef110acaa')
CLIENT_KEY = 'android.t3HFsLbBa08'
APP_VERSION = '12.7.1'

# Platform → backend host pair + brand code.
# The CanalPlus family (canalat, canaldigitaal, canalplushu) share a single
# brand identifier "m7cp" and use distinct login/API hosts from the others.
PLATFORM_PROFILES = {
    'skylinkcz':     {'brand': 'slcz',  'login_host': 'm7.login.solocoo.tv',    'api_host': 'tvapi.solocoo.tv'},
    'skylinksk':     {'brand': 'slsk',  'login_host': 'm7.login.solocoo.tv',    'api_host': 'tvapi.solocoo.tv'},
    'vlaanderen':    {'brand': 'tvv',   'login_host': 'm7.login.solocoo.tv',    'api_host': 'tvapi.solocoo.tv'},
    'focussat':      {'brand': 'fsro',  'login_host': 'm7.login.solocoo.tv',    'api_host': 'tvapi.solocoo.tv'},
    'directone':     {'brand': 'upchu', 'login_host': 'm7.login.solocoo.tv',    'api_host': 'tvapi.solocoo.tv'},
    'canalat':       {'brand': 'm7cp',  'login_host': 'm7cp.login.solocoo.tv',  'api_host': 'tvapi-hlm2.solocoo.tv'},
    'canaldigitaal': {'brand': 'm7cp',  'login_host': 'm7cp.login.solocoo.tv',  'api_host': 'tvapi-hlm2.solocoo.tv'},
    'canalplushu':   {'brand': 'm7cp',  'login_host': 'm7cp.login.solocoo.tv',  'api_host': 'tvapi-hlm2.solocoo.tv'},
}

DEFAULT_PLATFORM = 'focussat'
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

# Platform argv can override the config file (useful for testing)
platform_arg = o11.parse_params(sys.argv, 'platform')


# ─── config loading ──────────────────────────────────────────────────────────

def _load_config():
    """Read solcotv_config.json. Auto-create with defaults if missing."""
    if not os.path.exists(CONFIG_PATH):
        try:
            default = {
                'platform': DEFAULT_PLATFORM,
                '_comment_platform': (
                    'One of: skylinkcz, skylinksk, vlaanderen, focussat, '
                    'directone, canalat, canaldigitaal, canalplushu'
                ),
            }
            with open(CONFIG_PATH, 'w') as f:
                json.dump(default, f, indent=2)
            print(f'Created default config at {CONFIG_PATH}', file=sys.stderr)
            return default
        except Exception as e:
            print(f'Failed creating config: {e}', file=sys.stderr)
            return {'platform': DEFAULT_PLATFORM}

    try:
        with open(CONFIG_PATH, 'r') as f:
            return json.load(f)
    except Exception as e:
        print(f'Failed loading config (using defaults): {e}', file=sys.stderr)
        return {'platform': DEFAULT_PLATFORM}


_config = _load_config()

# Resolve platform: argv > config > default
platform = (platform_arg or _config.get('platform') or DEFAULT_PLATFORM).lower()
if platform not in PLATFORM_PROFILES:
    print(f'Invalid platform: {platform}', file=sys.stderr)
    print(f'Valid: {", ".join(PLATFORM_PROFILES.keys())}', file=sys.stderr)
    sys.exit(1)

PROFILE     = PLATFORM_PROFILES[platform]
LOGIN_HOST  = PROFILE['login_host']
API_HOST    = PROFILE['api_host']
BRAND       = PROFILE['brand']

LOGIN_URL = f'https://{LOGIN_HOST}/login'
API_BASE  = f'https://{API_HOST}'

# o11 session setup
o11Session = o11.session(bind=bind, proxy=proxy, worker=worker)
req = o11Session.get_session()
if doh != '':
    o11.dns(doh)

if challenge == 'cert':
    challenge = 'CAQ='

authFile = '/solcotv_' + platform + '.tokens'

headers = {}


# ─── auth helpers ────────────────────────────────────────────────────────────

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


# ─── Solocoo signature scheme ────────────────────────────────────────────────

def _urlsafe_b64_nopad(b):
    """The Solocoo Android app's custom base64 = standard urlsafe b64 w/o padding."""
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode('utf-8')


def _now_unix():
    return str(round(datetime.datetime.now(datetime.timezone.utc).timestamp()))


def _make_authorization(url, payload, timestamp=None):
    """
    Build the Solocoo signed Authorization header.

    sig = urlsafe_b64( HMAC-SHA256( HMAC_KEY, url + b64(SHA256(payload)) + time ) )
    """
    if timestamp is None:
        timestamp = _now_unix()

    payload_hash = _urlsafe_b64_nopad(hashlib.sha256(payload.encode('utf-8')).digest())
    msg = (url + payload_hash + timestamp).encode('utf-8')
    sig = _urlsafe_b64_nopad(hmac.new(HMAC_KEY, msg, hashlib.sha256).digest())

    return f'Client key={CLIENT_KEY},time={timestamp},sig={sig}'


# ─── HTTP header helpers ─────────────────────────────────────────────────────

def _tvapi_headers(token=None):
    h = {
        'accept':       'application/json, text/plain, */*',
        'content-type': 'application/json',
        'user-agent':   USER_AGENT,
    }
    if token:
        h['authorization'] = 'Bearer ' + token
    return h


def _login_headers():
    return {
        'Content-Type':    'application/json; charset=UTF-8',
        'Connection':      'Keep-Alive',
        'Accept-Encoding': 'gzip',
        'User-Agent':      'okhttp/4.9.1 Android/9',
    }


def _media_headers():
    return {
        'accept':     '*/*',
        'user-agent': USER_AGENT,
    }


# ─── device info payload ─────────────────────────────────────────────────────

def _device_info(device_id):
    return {
        'deviceModel':      'samsung SM-G955F',
        'deviceOem':        'samsung',
        'devicePrettyName': 'Galaxy S8+',
        'deviceSerial':     device_id,
        'deviceType':       'AndroidPhone',
        'environment':      '',
        'featureLevel':     4,
        'osVersion':        'Android 9 (28)',
        'brand':            BRAND,
        'appVersion':       APP_VERSION,
    }


def _generate_device_id(length=20):
    chars = string.ascii_letters + string.digits
    return ''.join(secrets.choice(chars) for _ in range(length))


# ─── auth flow: provision → ticket → login → session ─────────────────────────

def _get_provision_data(device_id):
    body = _device_info(device_id)
    r = None
    try:
        r = req.post(API_BASE + '/v1/provision',
                     headers=_tvapi_headers(), json=body)
        r.raise_for_status()
        d = r.json()
        return d.get('session', {}).get('provisionData')
    except Exception as e:
        print('Provision failed:', e, file=sys.stderr)
        if r is not None:
            print(r.text[:400], file=sys.stderr)
        return None


def _get_ticket(device_id, provision_data):
    body = {'deviceInfo': _device_info(device_id), 'provisionData': provision_data}
    payload = json.dumps(body).replace(' ', '')
    h = _login_headers()
    h['Authorization'] = _make_authorization(LOGIN_URL, payload)
    r = None
    try:
        r = req.post(LOGIN_URL, headers=h, data=payload)
        r.raise_for_status()
        d = r.json()
        return d.get('ticket')
    except Exception as e:
        print('Ticket fetch failed:', e, file=sys.stderr)
        if r is not None:
            print(r.text[:400], file=sys.stderr)
        return None


def _do_login(username, pw, device_id):
    """Exchange (username, password, device_id) for an ssoToken."""
    provision = _get_provision_data(device_id)
    if not provision:
        return None

    ticket = _get_ticket(device_id, provision)
    if not ticket:
        return None

    body = {
        'ticket':    ticket,
        'userInput': {'username': username, 'password': pw},
    }
    payload = json.dumps(body)
    h = _login_headers()
    h['Authorization'] = _make_authorization(LOGIN_URL, payload)
    r = None
    try:
        r = req.post(LOGIN_URL, headers=h, data=payload)
        d = r.json()
        # Detect credential errors before raising so we can fail cleanly
        if (('label' in d and 'invalid.credentials' in d.get('label', '')) or
            ('Message' in d and 'validation failed' in d.get('Message', ''))):
            print('Invalid credentials', file=sys.stderr)
            return None
        r.raise_for_status()
        return d.get('ssoToken')
    except Exception as e:
        print('Login failed:', e, file=sys.stderr)
        if r is not None:
            print(r.text[:400], file=sys.stderr)
        return None


def _get_session(sso_token, device_id, remove_device=None):
    """
    Exchange an ssoToken for a bearer token.

    Solocoo may return one of two shapes:
      1. Success:      {"token": "...", "ssoToken": "<rotated>"}
      2. Device limit: {"solution": {"deviceList": {"devices": [...]}}}

    Returns (status, payload):
      ('ok',    (token, rotated_sso_token))
      ('limit', [list_of_device_ids_to_remove])
      ('error', None)

    If `remove_device` is passed, it's included in the request so the server
    will evict that slot and (usually) grant the session.
    """
    body = _device_info(device_id)
    body['ssoToken'] = sso_token
    if remove_device:
        body['removeDevice'] = remove_device
    payload = json.dumps(body).replace(' ', '')

    r = None
    try:
        r = req.post(API_BASE + '/v1/session',
                     headers=_tvapi_headers(), data=payload)
        # Don't raise immediately — the device-list response is also a 200
        d = r.json()

        if 'token' in d and 'ssoToken' in d:
            return 'ok', (d['token'], d['ssoToken'])

        devices = d.get('solution', {}).get('deviceList', {}).get('devices', [])
        if devices:
            return 'limit', [dev.get('deviceId', '') for dev in devices if dev.get('deviceId')]

        print('Unexpected /v1/session response:', file=sys.stderr)
        print(r.text[:400], file=sys.stderr)
        return 'error', None
    except Exception as e:
        print('Session exchange failed:', e, file=sys.stderr)
        if r is not None:
            print(r.text[:400], file=sys.stderr)
        return 'error', None


def login():
    """Full login flow with device-limit handling."""
    print(f'logging in (platform={platform})...', file=sys.stderr)
    if not user or not password:
        print('user and password required for login', file=sys.stderr)
        return 'error'

    device_id = _generate_device_id()
    sso = _do_login(user, password, device_id)
    if not sso:
        return 'error'

    status, payload = _get_session(sso, device_id)

    if status == 'limit':
        # Evict the first device in the list and retry. The server-side
        # session call expects the slot-eviction flag in the same payload
        # as the new device's info.
        device_to_remove = payload[0] if payload else ''
        if not device_to_remove:
            print('Device limit hit but no eviction candidate returned',
                  file=sys.stderr)
            return 'error'
        print(f'Device limit reached; evicting {device_to_remove[:12]}...',
              file=sys.stderr)
        status, payload = _get_session(sso, device_id, remove_device=device_to_remove)

    if status != 'ok':
        return 'error'

    token, rotated_sso = payload
    if not _save_auth({
        'device_id': device_id,
        'sso_token': rotated_sso,
        'platform':  platform,
    }):
        return 'error'

    print(f'logged in successfully (platform={platform})', file=sys.stderr)


def get_bearer():
    """
    Get a fresh bearer token by exchanging the cached ssoToken.
    Persists the rotated ssoToken on success.
    Returns (bearer_token, device_id) or (None, None).
    """
    auth = _load_auth()
    if not auth:
        return None, None
    sso       = auth.get('sso_token', '')
    device_id = auth.get('device_id', '')
    if not sso or not device_id:
        return None, None

    status, payload = _get_session(sso, device_id)
    if status != 'ok':
        return None, None

    token, rotated_sso = payload
    auth['sso_token'] = rotated_sso
    _save_auth(auth)
    return token, device_id


# ─── content + manifest ──────────────────────────────────────────────────────

def _get_channels(token):
    h = _tvapi_headers(token=token)
    r = None
    try:
        r = req.get(API_BASE + '/v1/bouquet', headers=h)
        r.raise_for_status()
        d = r.json()
        # Filter out channels with empty sources (no rights / not entitled)
        return [c for c in d.get('channels', []) if c.get('sources')]
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
        r = req.post(f'{API_BASE}/v1/assets/{channel_id}/play',
                     headers=_tvapi_headers(token=token), data=payload)
        r.raise_for_status()
        d = r.json()
        url = d.get('url', '')
        lic_url = d.get('drm', {}).get('licenseUrl', '')
        if not url or not lic_url:
            print('play: missing url or drm.licenseUrl in response', file=sys.stderr)
            print(r.text[:400], file=sys.stderr)
            return None, None
        return url, lic_url
    except Exception as e:
        print('Get play failed:', e, file=sys.stderr)
        if r is not None:
            print(r.text[:400], file=sys.stderr)
        return None, None


def _get_pssh_and_resolved_url(manifest_url):
    """Follow redirects, parse the MPD for the Widevine PSSH, return both."""
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
