#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-run

type Json = Record<string, unknown>;
type DeviceProfileName = "phone" | "androidtv";
type FocusSatConfig = {
  user: string;
  pass: string;
  port: number;
  cdmUrl: string;
  mp4decrypt: string;
  shakaPackager: string;
  dataDir: string;
  deviceProfile: DeviceProfileName;
  androidTvDeviceType: string;
  playerName: string;
  playerVersion: string;
  playerSmartLib: boolean;
  playerLive: boolean;
};
type SessionState = {
  deviceId: string;
  provisionData?: string;
  ssoToken: string;
  bearerToken: string | null;
  updatedAt: string;
  deviceEvicted?: string;
  deviceProfile?: DeviceProfileName;
};
type FocusSatChannel = {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  drm: boolean;
  streamKind: "dash-widevine" | "dash" | "unknown";
  raw: Json;
};
type StreamInfo = {
  channelId: string;
  manifestUrl: string;
  isDrm: boolean;
  drm?: { licenseUrl: string; headers: Record<string, string> };
  expiresAt: number;
};
type ContentKey = { kid: string; key: string };
type TrackKind = "audio" | "video";
type ParsedSegment = {
  id: string;
  url: string;
  number: number | null;
  time: number | null;
  duration: number;
};
type ParsedRepresentation = {
  kind: TrackKind;
  representationId: string;
  bandwidth: number;
  codecs: string;
  mimeType: string;
  language?: string;
  timescale: number;
  initUrl: string;
  segments: ParsedSegment[];
};
type ParsedMpd = {
  minimumUpdatePeriodMs: number;
  audio: ParsedRepresentation[];
  video: ParsedRepresentation[];
};
type LocalSegment = ParsedSegment & {
  encryptedPath: string;
  decryptedPath: string;
  downloadedAt: number;
  writtenAt: number | null;
};
type TrackRuntime = {
  kind: TrackKind;
  source: ParsedRepresentation;
  initEncryptedPath: string;
  initDecryptedPath: string;
  initPrepared: boolean;
  initWritten: boolean;
  segments: LocalSegment[];
  sentSegmentIds: Set<string>;
};
type ChannelDirs = {
  enc: string;
  dec: string;
  pipes: string;
  out: string;
  logs: string;
};
type DrmState = {
  channelId: string;
  workDir: string;
  dirs: ChannelDirs;
  pipePaths: { audio: string; video: string };
  ready: Promise<string>;
  readyResolve: (value: string) => void;
  readyReject: (reason: unknown) => void;
  readySettled: boolean;
  lastAccess: number;
  lastProgressAt: number;
  lastRefreshAt: number;
  stopRequested: boolean;
  closed: boolean;
  streamInfo: StreamInfo | null;
  keys: ContentKey[];
  audio: TrackRuntime | null;
  video: TrackRuntime | null;
  manifest: ParsedMpd | null;
  manifestXml: string | null;
  syncIntervalMs: number;
  consecutiveFailures: number;
  nextRetryDelayMs: number;
  lastError: string | null;
  packager: Deno.ChildProcess | null;
  packagerStatus: Promise<Deno.CommandStatus> | null;
  audioFile: Deno.FsFile | null;
  videoFile: Deno.FsFile | null;
  audioWriter: WritableStreamDefaultWriter<Uint8Array> | null;
  videoWriter: WritableStreamDefaultWriter<Uint8Array> | null;
  loop: Promise<void> | null;
};

const BRAND = "fsro";
const LOGIN_HOST = "m7.login.solocoo.tv";
const API_HOST = "tvapi.solocoo.tv";
const LOGIN_URL = `https://${LOGIN_HOST}/login`;
const API_BASE = `https://${API_HOST}`;
const APP_VERSION = "12.7.1";
const CLIENT_KEY = "android.t3HFsLbBa08";
const HMAC_KEY_HEX = "49a056ab6e76c13069cf0af2328c8e3f3c07089ef110acaa";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const LOGIN_USER_AGENT = "okhttp/4.9.1 Android/9";
const STREAM_TTL_MS = 4 * 60 * 1000;
const CHANNEL_TTL_MS = 12 * 60 * 60 * 1000;
const KEY_TTL_MS = 30 * 60 * 1000;
const PIPE_IDLE_MS = 60 * 1000;
const PIPE_SYNC_FALLBACK_MS = 3_000;
const PIPE_SEGMENT_WINDOW = 8;
const PIPE_SEGMENT_RETENTION = 18;
const PLAYLIST_WAIT_TIMEOUT_MS = 25_000;
const PIPE_NO_PROGRESS_MS = 60_000;
const PIPE_RETRY_DELAYS_MS = [3_000, 6_000, 12_000, 20_000] as const;
const DRM_RESTART_COOLDOWN_MS = [
  10_000,
  20_000,
  30_000,
  60_000,
  120_000,
  180_000,
] as const;

const APP_DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const ENV_FILE = `${APP_DIR}/.env`;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

class RestartCooldownError extends HttpError {
  constructor(public retryAfterSec: number, message: string) {
    super(503, message);
  }
}

function parseDotEnv(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }
  return values;
}

async function loadEnvFile(): Promise<Map<string, string>> {
  try {
    return parseDotEnv(await Deno.readTextFile(ENV_FILE));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return new Map();
    throw e;
  }
}

const fileEnv = await loadEnvFile();

function env(name: string, fallback = ""): string {
  return Deno.env.get(name) ?? fileEnv.get(name) ?? fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (!value) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function parseDeviceProfile(value: string): DeviceProfileName {
  const normalized = value.trim().toLowerCase();
  if (normalized === "phone" || normalized === "androidtv") {
    return normalized;
  }
  throw new Error(
    `unsupported FOCUSSAT_DEVICE_PROFILE: ${value}; use phone or androidtv`,
  );
}

function resolvePath(path: string): string {
  if (!path) return path;
  if (path.startsWith("/")) return path;
  return `${APP_DIR}/${path}`.replaceAll("/./", "/");
}

function resolveExecutable(command: string): string {
  if (!command.includes("/")) return command;
  return resolvePath(command);
}

const config: FocusSatConfig = {
  user: env("FOCUSSAT_USER"),
  pass: env("FOCUSSAT_PASS"),
  port: Number(env("FOCUSSAT_PORT", "8092")) || 8092,
  cdmUrl: env("FOCUSSAT_CDM_URL", "http://127.0.0.1:8091").replace(/\/$/, ""),
  mp4decrypt: resolveExecutable(env("FOCUSSAT_MP4DECRYPT", "mp4decrypt")),
  shakaPackager: resolveExecutable(env("FOCUSSAT_SHAKA_PACKAGER", "packager")),
  dataDir: resolvePath(env("FOCUSSAT_DATA_DIR", "./data")),
  deviceProfile: parseDeviceProfile(env("FOCUSSAT_DEVICE_PROFILE", "phone")),
  androidTvDeviceType: env("FOCUSSAT_ANDROIDTV_DEVICE_TYPE", "STB"),
  playerName: env("FOCUSSAT_PLAYER_NAME", "RxPlayer"),
  playerVersion: env("FOCUSSAT_PLAYER_VERSION", "3.29.0"),
  playerSmartLib: envBool("FOCUSSAT_PLAYER_SMART_LIB", true),
  playerLive: envBool("FOCUSSAT_PLAYER_LIVE", false),
};

const SESSION_PATH = `${config.dataDir}/session.json`;
const CHANNELS_PATH = `${config.dataDir}/channels.json`;
const LIVE_DIR = `${config.dataDir}/live`;
const LOG_DIR = `${config.dataDir}/logs`;
const streamCache = new Map<string, StreamInfo>();
const keyCache = new Map<string, { keys: ContentKey[]; expiresAt: number }>();
const drmStates = new Map<string, DrmState>();
const drmStarts = new Map<string, Promise<DrmState>>();
const restartCooldowns = new Map<
  string,
  { failures: number; retryAfterAt: number; reason: string }
>();
let mp4decryptChecked = false;
let packagerChecked = false;
let cdmChecked = false;

function bytesFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function urlSafeBase64(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

async function sha256Base64(payload: string): Promise<string> {
  return urlSafeBase64(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload)),
  );
}

async function makeAuthorization(
  url: string,
  payload: string,
  timestamp = Math.round(Date.now() / 1000).toString(),
): Promise<string> {
  const payloadHash = await sha256Base64(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    arrayBufferFromBytes(bytesFromHex(HMAC_KEY_HEX)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${url}${payloadHash}${timestamp}`),
  );
  return `Client key=${CLIENT_KEY},time=${timestamp},sig=${urlSafeBase64(sig)}`;
}

function randomDeviceId(length = 20): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((byte) => chars[byte % chars.length]).join("");
}

function deviceInfo(deviceId: string): Json {
  const profile = config.deviceProfile === "androidtv"
    ? {
      deviceModel: "Chromecast Google TV",
      deviceOem: "Google",
      devicePrettyName: "Chromecast with Google TV",
      deviceType: config.androidTvDeviceType,
      featureLevel: 6,
      osVersion: "Android 12 (31)",
    }
    : {
      deviceModel: "samsung SM-G955F",
      deviceOem: "samsung",
      devicePrettyName: "Galaxy S8+",
      deviceType: "AndroidPhone",
      featureLevel: 4,
      osVersion: "Android 9 (28)",
    };
  return {
    ...profile,
    deviceSerial: deviceId,
    environment: "",
    brand: BRAND,
    appVersion: APP_VERSION,
  };
}

function playerPayload(): Json {
  const capabilities: Json = {
    mediaTypes: ["DASH"],
    drmSystems: ["Widevine"],
    smartLib: config.playerSmartLib,
  };
  if (config.playerLive) capabilities.live = true;
  return {
    player: {
      name: config.playerName,
      version: config.playerVersion,
      capabilities,
    },
  };
}

function tvapiHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function loginHeaders(authorization?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=UTF-8",
    "Connection": "Keep-Alive",
    "Accept-Encoding": "gzip",
    "User-Agent": LOGIN_USER_AGENT,
  };
  if (authorization) headers.Authorization = authorization;
  return headers;
}

function mediaHeaders(req?: Request): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "*/*",
    "User-Agent": USER_AGENT,
  };
  const range = req?.headers.get("range");
  if (range) headers.Range = range;
  return headers;
}

function compactDiagnostic(data: Json, rawBody = ""): string {
  const parts: string[] = [];
  for (
    const key of [
      "label",
      "message",
      "Message",
      "error",
      "errorCode",
      "code",
      "reason",
    ]
  ) {
    const value = data[key];
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`${key}=${value}`);
    }
  }
  const solution = asRecord(data.solution);
  const solutionType = solution.type ?? solution.name ?? solution.label;
  if (
    typeof solutionType === "string" || typeof solutionType === "number"
  ) {
    parts.push(`solution=${solutionType}`);
  }
  if (parts.length === 0 && rawBody.trim()) {
    parts.push(`body=${rawBody.trim().slice(0, 300)}`);
  }
  return redact(parts.join(", "));
}

function redact(value: string): string {
  let out = value;
  for (const secret of [config.user, config.pass]) {
    if (secret) out = out.replaceAll(secret, "[redacted]");
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  out = out.replace(
    /("?(?:ssoToken|sso_token|token|bearerToken|provisionData)"?\s*[:=]\s*)"?[^",}\s]+/gi,
    "$1[redacted]",
  );
  return out;
}

function log(message: string): void {
  console.log(`[focussat] ${redact(message)}`);
}

async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDir(path.slice(0, path.lastIndexOf("/")));
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await Deno.rename(tmp, path);
}

async function readResponseJson(
  res: Response,
): Promise<{ data: Json; rawBody: string }> {
  const rawBody = await res.text().catch(() => "");
  if (!rawBody) return { data: {}, rawBody };
  try {
    return { data: JSON.parse(rawBody) as Json, rawBody };
  } catch {
    return { data: {}, rawBody };
  }
}

async function provisionDevice(deviceId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/v1/provision`, {
    method: "POST",
    headers: tvapiHeaders(),
    body: JSON.stringify(deviceInfo(deviceId)),
  });
  const { data, rawBody } = await readResponseJson(res);
  const provisionData =
    (((data.session as Json | undefined)?.provisionData) ?? "") as string;
  if (!res.ok || !provisionData) {
    const diagnostic = compactDiagnostic(data, rawBody);
    throw new HttpError(
      res.status,
      `provision failed: HTTP ${res.status}${
        diagnostic ? ` (${diagnostic})` : ""
      }`,
    );
  }
  return provisionData;
}

async function getTicket(
  deviceId: string,
  provisionData: string,
): Promise<string> {
  const payload = JSON.stringify({
    deviceInfo: deviceInfo(deviceId),
    provisionData,
  });
  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: loginHeaders(await makeAuthorization(LOGIN_URL, payload)),
    body: payload,
  });
  const { data, rawBody } = await readResponseJson(res);
  const ticket = data.ticket as string | undefined;
  if (!res.ok || !ticket) {
    const diagnostic = compactDiagnostic(data, rawBody);
    throw new HttpError(
      res.status,
      `ticket failed: HTTP ${res.status}${
        diagnostic ? ` (${diagnostic})` : ""
      }`,
    );
  }
  return ticket;
}

async function exchangeCredentials(
  deviceId: string,
  ticket: string,
): Promise<string> {
  if (!config.user || !config.pass) {
    throw new Error("missing FOCUSSAT_USER or FOCUSSAT_PASS");
  }
  const payload = JSON.stringify({
    ticket,
    userInput: { username: config.user, password: config.pass },
  });
  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: loginHeaders(await makeAuthorization(LOGIN_URL, payload)),
    body: payload,
  });
  const { data, rawBody } = await readResponseJson(res);
  const message = `${data.label ?? data.Message ?? data.message ?? ""}`;
  if (/invalid\.credentials|validation failed/i.test(message)) {
    throw new HttpError(401, "invalid FocusSat credentials");
  }
  const ssoToken = data.ssoToken as string | undefined;
  if (!res.ok || !ssoToken) {
    const diagnostic = compactDiagnostic(data, rawBody);
    throw new HttpError(
      res.status,
      `login failed: HTTP ${res.status}${diagnostic ? ` (${diagnostic})` : ""}`,
    );
  }
  return ssoToken;
}

async function exchangeSession(
  deviceId: string,
  ssoToken: string,
  provisionData?: string,
  removeDevice?: string,
): Promise<
  { status: "ok"; token: string; ssoToken: string } | {
    status: "limit";
    devices: string[];
  }
> {
  const body = deviceInfo(deviceId);
  body.ssoToken = ssoToken;
  if (provisionData) body.provisionData = provisionData;
  if (removeDevice) body.removeDevice = removeDevice;
  const res = await fetch(`${API_BASE}/v1/session`, {
    method: "POST",
    headers: tvapiHeaders(),
    body: JSON.stringify(body),
  });
  const { data, rawBody } = await readResponseJson(res);
  if (typeof data.token === "string" && typeof data.ssoToken === "string") {
    return { status: "ok", token: data.token, ssoToken: data.ssoToken };
  }
  const devicesRaw =
    (((data.solution as Json | undefined)?.deviceList as Json | undefined)
      ?.devices ?? []) as Json[];
  const devices = Array.isArray(devicesRaw)
    ? devicesRaw.map((item) => `${item.deviceId ?? ""}`).filter(Boolean)
    : [];
  if (devices.length > 0) return { status: "limit", devices };
  const diagnostic = compactDiagnostic(data, rawBody);
  throw new HttpError(
    res.status,
    `session failed: HTTP ${res.status}${diagnostic ? ` (${diagnostic})` : ""}`,
  );
}

async function saveSession(state: SessionState): Promise<void> {
  await writeJson(SESSION_PATH, state);
}

async function performLogin(): Promise<SessionState> {
  const deviceId = randomDeviceId();
  const provisionData = await provisionDevice(deviceId);
  const ticket = await getTicket(deviceId, provisionData);
  const ssoToken = await exchangeCredentials(deviceId, ticket);
  let session = await exchangeSession(deviceId, ssoToken, provisionData);
  let evicted: string | undefined;
  if (session.status === "limit") {
    evicted = session.devices[0];
    if (!evicted) {
      throw new Error(
        "device limit reached but no removable device was returned",
      );
    }
    log(`device limit reached; evicting ${evicted.slice(0, 12)}...`);
    session = await exchangeSession(deviceId, ssoToken, provisionData, evicted);
  }
  if (session.status !== "ok") throw new Error("session exchange failed");
  const state: SessionState = {
    deviceId,
    provisionData,
    ssoToken: session.ssoToken,
    bearerToken: session.token,
    updatedAt: new Date().toISOString(),
    deviceEvicted: evicted,
    deviceProfile: config.deviceProfile,
  };
  await saveSession(state);
  return state;
}

async function ensureBearer(forceLogin = false): Promise<string> {
  let state = forceLogin ? null : await readJson<SessionState>(SESSION_PATH);
  if (
    !state?.deviceId || !state?.ssoToken ||
    state.deviceProfile !== config.deviceProfile
  ) {
    state = await performLogin();
  }
  let session = await exchangeSession(
    state.deviceId,
    state.ssoToken,
    state.provisionData,
  );
  let evicted: string | undefined;
  if (session.status === "limit") {
    evicted = session.devices[0];
    if (!evicted) {
      throw new Error(
        "device limit reached but no removable device was returned",
      );
    }
    log(`device limit reached; evicting ${evicted.slice(0, 12)}...`);
    session = await exchangeSession(
      state.deviceId,
      state.ssoToken,
      state.provisionData,
      evicted,
    );
  }
  if (session.status !== "ok") throw new Error("session exchange failed");
  await saveSession({
    deviceId: state.deviceId,
    provisionData: state.provisionData,
    ssoToken: session.ssoToken,
    bearerToken: session.token,
    updatedAt: new Date().toISOString(),
    deviceEvicted: evicted ?? state.deviceEvicted,
    deviceProfile: config.deviceProfile,
  });
  return session.token;
}

function slugify(value: string): string {
  return value.normalize("NFKD").replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "")
    .toLowerCase() || "channel";
}

function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Json
    : {};
}

function pickString(obj: Json, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function findImage(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImage(item);
      if (found) return found;
    }
  }
  if (typeof value === "object") {
    const obj = value as Json;
    for (const key of ["url", "href", "imageUrl", "logo", "src"]) {
      const candidate = obj[key];
      if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) {
        return candidate;
      }
    }
    for (const candidate of Object.values(obj)) {
      const found = findImage(candidate);
      if (found) return found;
    }
  }
  return null;
}

function normalizeChannel(raw: Json): FocusSatChannel | null {
  const info = asRecord(raw.assetInfo);
  const id = pickString(info, ["id", "assetId"]) ??
    pickString(raw, ["id", "assetId", "channelId"]);
  const name = pickString(info, ["title", "name"]) ??
    pickString(raw, ["title", "name"]);
  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  if (!id || !name || sources.length === 0) return null;
  const imageUrl = findImage(info.images) ?? findImage(info.logo) ??
    findImage(raw.images) ?? findImage(raw.logo);
  const sourceText = JSON.stringify(sources).toLowerCase();
  const drm = /widevine|drm|dash/.test(sourceText);
  return {
    id,
    name: name.replace(/\//g, "-"),
    slug: slugify(name),
    imageUrl,
    drm,
    streamKind: drm ? "dash-widevine" : "unknown",
    raw,
  };
}

async function fetchChannels(): Promise<FocusSatChannel[]> {
  const token = await ensureBearer();
  const res = await fetch(`${API_BASE}/v1/bouquet`, {
    headers: tvapiHeaders(token),
  });
  if (!res.ok) {
    throw new HttpError(res.status, `bouquet failed: HTTP ${res.status}`);
  }
  const data = await res.json().catch(() => ({})) as Json;
  const channelsRaw = Array.isArray(data.channels) ? data.channels : [];
  return channelsRaw.map((item) => normalizeChannel(asRecord(item))).filter((
    item,
  ): item is FocusSatChannel => !!item);
}

async function getChannels(force = false): Promise<FocusSatChannel[]> {
  const cached = await readJson<
    { updatedAt: string; channels: FocusSatChannel[] }
  >(CHANNELS_PATH);
  const fresh = cached?.updatedAt &&
    Date.now() - new Date(cached.updatedAt).getTime() < CHANNEL_TTL_MS;
  if (!force && fresh && Array.isArray(cached?.channels)) {
    return cached.channels;
  }
  const channels = await fetchChannels();
  await writeJson(CHANNELS_PATH, {
    updatedAt: new Date().toISOString(),
    channels,
  });
  return channels;
}

async function findChannel(requested: string): Promise<FocusSatChannel | null> {
  const decoded = decodeURIComponent(requested);
  const channels = await getChannels();
  return channels.find((channel) =>
    channel.id === decoded || channel.slug === decoded
  ) ?? null;
}

async function resolveStream(
  channelId: string,
  force = false,
): Promise<StreamInfo> {
  const hit = streamCache.get(channelId);
  if (!force && hit && hit.expiresAt > Date.now()) return hit;
  const token = await ensureBearer();
  const body = JSON.stringify(playerPayload());
  const res = await fetch(
    `${API_BASE}/v1/assets/${encodeURIComponent(channelId)}/play`,
    {
      method: "POST",
      headers: tvapiHeaders(token),
      body,
    },
  );
  const data = await res.json().catch(() => ({})) as Json;
  const manifestUrl = data.url as string | undefined;
  const drm = asRecord(data.drm);
  const licenseUrl = drm.licenseUrl as string | undefined;
  if (!res.ok || !manifestUrl) {
    throw new HttpError(res.status, `play failed: HTTP ${res.status}`);
  }
  const info: StreamInfo = {
    channelId,
    manifestUrl,
    isDrm: !!licenseUrl,
    drm: licenseUrl
      ? {
        licenseUrl,
        headers: normalizeLicenseHeaders(drm.licenseRequestHeaders),
      }
      : undefined,
    expiresAt: Date.now() + STREAM_TTL_MS,
  };
  streamCache.set(channelId, info);
  return info;
}

function normalizeLicenseHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {
    "Accept": "*/*",
    "Content-Type": "application/octet-stream",
    "User-Agent": USER_AGENT,
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      const obj = asRecord(item);
      const name = obj.name;
      const headerValue = obj.value;
      if (typeof name === "string" && typeof headerValue === "string") {
        headers[name] = headerValue;
      }
    }
  } else if (value && typeof value === "object") {
    for (
      const [key, headerValue] of Object.entries(
        value as Record<string, unknown>,
      )
    ) {
      if (typeof headerValue === "string") headers[key] = headerValue;
    }
  }
  return headers;
}

function decodeXmlText(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function parseXmlAttributes(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([:\w-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) attrs[m[1]] = decodeXmlText(m[2]);
  return attrs;
}

function findXmlBlocks(
  xml: string,
  tag: string,
): Array<{ attrs: Record<string, string>; inner: string }> {
  const blocks: Array<{ attrs: Record<string, string>; inner: string }> = [];
  const re = new RegExp(
    `<${tag}\\b([^>]*?)(?:>([\\s\\S]*?)<\\/${tag}>|\\/>)`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    blocks.push({ attrs: parseXmlAttributes(m[1]), inner: m[2] ?? "" });
  }
  return blocks;
}

function findXmlText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(
    xml,
  );
  return m ? decodeXmlText(m[1].trim()) : null;
}

function parseIsoDurationMs(input: string | undefined): number | null {
  if (!input) return null;
  const m =
    /^P(?:([0-9.]+)D)?(?:T(?:([0-9.]+)H)?(?:([0-9.]+)M)?(?:([0-9.]+)S)?)?$/i
      .exec(input.trim());
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3] ?? 0);
  const secs = Number(m[4] ?? 0);
  return Math.round((((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000);
}

function fillTemplate(
  template: string,
  representationId: string,
  bandwidth: number,
  number: number | null,
  time: number | null,
): string {
  return template.replaceAll(
    /\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g,
    (_m, token, widthRaw) => {
      const width = Number(widthRaw ?? 0);
      const pad = (value: string) =>
        width > 0 ? value.padStart(width, "0") : value;
      if (token === "RepresentationID") return representationId;
      if (token === "Bandwidth") return pad(String(bandwidth));
      if (token === "Number") {
        if (number == null) {
          throw new Error(`template requires Number for ${representationId}`);
        }
        return pad(String(number));
      }
      if (time == null) {
        throw new Error(`template requires Time for ${representationId}`);
      }
      return pad(String(time));
    },
  );
}

function parseSegmentTimeline(
  inner: string,
): Array<{ time: number | null; duration: number; repeat: number }> {
  const timeline: Array<
    { time: number | null; duration: number; repeat: number }
  > = [];
  const tlMatch = /<SegmentTimeline\b[^>]*>([\s\S]*?)<\/SegmentTimeline>/i.exec(
    inner,
  );
  if (!tlMatch) return timeline;
  const re = /<S\b([^>]*)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tlMatch[1])) !== null) {
    const attrs = parseXmlAttributes(m[1]);
    const duration = Number(attrs.d ?? "");
    if (!Number.isFinite(duration) || duration <= 0) continue;
    timeline.push({
      time: attrs.t != null ? Number(attrs.t) : null,
      duration,
      repeat: attrs.r != null ? Number(attrs.r) : 0,
    });
  }
  return timeline;
}

function parseSegmentTemplate(
  xml: string,
): { attrs: Record<string, string>; inner: string } | null {
  const m = /<SegmentTemplate\b([^>]*)(?:\/>|>([\s\S]*?)<\/SegmentTemplate>)/i
    .exec(xml);
  return m ? { attrs: parseXmlAttributes(m[1]), inner: m[2] ?? "" } : null;
}

function parseSegmentList(
  xml: string,
  representationId: string,
  bandwidth: number,
  baseUrl: string,
  timescaleFallback: number,
): { timescale: number; initUrl: string; segments: ParsedSegment[] } | null {
  const m = /<SegmentList\b([^>]*)>([\s\S]*?)<\/SegmentList>/i.exec(xml);
  if (!m) return null;
  const attrs = parseXmlAttributes(m[1]);
  const inner = m[2];
  const initAttrs = /<Initialization\b([^>]*)\/?>/i.exec(inner)?.[1];
  const initSource = initAttrs ? parseXmlAttributes(initAttrs).sourceURL : null;
  if (!initSource) return null;
  const timescale = Number(attrs.timescale ?? timescaleFallback) ||
    timescaleFallback || 1;
  const timelineEntries = parseSegmentTimeline(inner);
  const segments: ParsedSegment[] = [];
  const segUrlRe = /<SegmentURL\b([^>]*)\/?>/gi;
  let idx = 0;
  let segMatch: RegExpExecArray | null;
  while ((segMatch = segUrlRe.exec(inner)) !== null) {
    const media = parseXmlAttributes(segMatch[1]).media;
    if (!media) continue;
    const tl = timelineEntries[idx];
    segments.push({
      id: `list-${representationId}-${idx}`,
      url: new URL(media, baseUrl).toString(),
      number: idx + 1,
      time: tl?.time ?? null,
      duration: tl?.duration ?? 1,
    });
    idx += 1;
  }
  return {
    timescale,
    initUrl: new URL(initSource, baseUrl).toString(),
    segments,
  };
}

function buildSegmentsFromTemplate(
  attrs: Record<string, string>,
  inner: string,
  representationId: string,
  bandwidth: number,
  baseUrl: string,
): { timescale: number; initUrl: string; segments: ParsedSegment[] } | null {
  if (!attrs.initialization || !attrs.media) return null;
  const timescale = Number(attrs.timescale ?? "1") || 1;
  const startNumber = Number(attrs.startNumber ?? "1") || 1;
  const mediaUsesNumber = /\$Number(?:%0\d+d)?\$/.test(attrs.media);
  const mediaUsesTime = /\$Time(?:%0\d+d)?\$/.test(attrs.media);
  const initUrl = new URL(
    fillTemplate(
      attrs.initialization,
      representationId,
      bandwidth,
      startNumber,
      null,
    ),
    baseUrl,
  ).toString();
  const timeline = parseSegmentTimeline(inner);
  if (timeline.length === 0) return null;
  const segments: ParsedSegment[] = [];
  let segmentNumber = startNumber;
  let currentTime = timeline[0]?.time ?? 0;
  for (const entry of timeline) {
    if (entry.time != null) currentTime = entry.time;
    const repeat = entry.repeat < 0 ? 0 : entry.repeat;
    for (let i = 0; i <= repeat; i++) {
      const number = mediaUsesNumber ? segmentNumber : null;
      const time = currentTime;
      segments.push({
        id: mediaUsesTime ? `t-${time}` : `n-${segmentNumber}`,
        url: new URL(
          fillTemplate(attrs.media, representationId, bandwidth, number, time),
          baseUrl,
        ).toString(),
        number,
        time,
        duration: entry.duration,
      });
      segmentNumber += 1;
      currentTime += entry.duration;
    }
  }
  return { timescale, initUrl, segments };
}

function resolveRepresentation(
  kind: TrackKind,
  representation: { attrs: Record<string, string>; inner: string },
  adaptation: { attrs: Record<string, string>; inner: string },
  baseUrl: string,
): ParsedRepresentation | null {
  const representationId = representation.attrs.id;
  if (!representationId) return null;
  const bandwidth = Number(
    representation.attrs.bandwidth ?? adaptation.attrs.bandwidth ?? "0",
  ) || 0;
  const mimeType = representation.attrs.mimeType ?? adaptation.attrs.mimeType ??
    `${kind}/mp4`;
  const codecs = representation.attrs.codecs ?? adaptation.attrs.codecs ?? "";
  const repBase = findXmlText(representation.inner, "BaseURL") ?? "";
  const resolvedBase = repBase ? new URL(repBase, baseUrl).toString() : baseUrl;
  const repTemplate = parseSegmentTemplate(representation.inner);
  const adaptTemplate = parseSegmentTemplate(adaptation.inner);
  const mergedAttrs = {
    ...(adaptTemplate?.attrs ?? {}),
    ...(repTemplate?.attrs ?? {}),
  };
  const templateInner = repTemplate?.inner || adaptTemplate?.inner || "";
  const parsed = Object.keys(mergedAttrs).length > 0
    ? buildSegmentsFromTemplate(
      mergedAttrs,
      templateInner,
      representationId,
      bandwidth,
      resolvedBase,
    )
    : null;
  const fromList = parsed ??
    parseSegmentList(
      representation.inner,
      representationId,
      bandwidth,
      resolvedBase,
      Number(mergedAttrs.timescale ?? "1") || 1,
    ) ??
    parseSegmentList(
      adaptation.inner,
      representationId,
      bandwidth,
      resolvedBase,
      Number(mergedAttrs.timescale ?? "1") || 1,
    );
  if (!fromList || fromList.segments.length === 0) return null;
  return {
    kind,
    representationId,
    bandwidth,
    codecs,
    mimeType,
    language: adaptation.attrs.lang,
    timescale: fromList.timescale,
    initUrl: fromList.initUrl,
    segments: fromList.segments,
  };
}

function parseMpdXml(xml: string, mpdUrl: string): ParsedMpd {
  const mpdAttrs = parseXmlAttributes(/<MPD\b([^>]*)>/i.exec(xml)?.[1] ?? "");
  const mpdBase = findXmlText(xml, "BaseURL");
  const baseUrl = mpdBase ? new URL(mpdBase, mpdUrl).toString() : mpdUrl;
  const period = findXmlBlocks(xml, "Period")[0];
  if (!period) throw new Error("MPD has no Period");
  const periodBase = findXmlText(period.inner, "BaseURL");
  const resolvedPeriodBase = periodBase
    ? new URL(periodBase, baseUrl).toString()
    : baseUrl;
  const audio: ParsedRepresentation[] = [];
  const video: ParsedRepresentation[] = [];
  for (const adaptation of findXmlBlocks(period.inner, "AdaptationSet")) {
    const mimeType = adaptation.attrs.mimeType ?? "";
    const contentType = adaptation.attrs.contentType ??
      (mimeType.startsWith("audio/")
        ? "audio"
        : mimeType.startsWith("video/")
        ? "video"
        : "");
    if (contentType !== "audio" && contentType !== "video") continue;
    const adaptationBase = findXmlText(adaptation.inner, "BaseURL");
    const resolvedAdaptationBase = adaptationBase
      ? new URL(adaptationBase, resolvedPeriodBase).toString()
      : resolvedPeriodBase;
    for (
      const representation of findXmlBlocks(adaptation.inner, "Representation")
    ) {
      const parsed = resolveRepresentation(
        contentType,
        representation,
        adaptation,
        resolvedAdaptationBase,
      );
      if (parsed) (contentType === "audio" ? audio : video).push(parsed);
    }
  }
  return {
    minimumUpdatePeriodMs: parseIsoDurationMs(mpdAttrs.minimumUpdatePeriod) ??
      PIPE_SYNC_FALLBACK_MS,
    audio,
    video,
  };
}

async function fetchMpd(
  mpdUrl: string,
): Promise<{ xml: string; parsed: ParsedMpd }> {
  const res = await fetch(mpdUrl, { headers: mediaHeaders() });
  if (!res.ok) {
    throw new HttpError(res.status, `MPD fetch failed: HTTP ${res.status}`);
  }
  const xml = await res.text();
  return { xml, parsed: parseMpdXml(xml, res.url || mpdUrl) };
}

function extractPssh(xml: string): string {
  const cpBlocks = findXmlBlocks(xml, "ContentProtection");
  for (const block of cpBlocks) {
    const scheme = (block.attrs.schemeIdUri ?? "").toLowerCase();
    if (!scheme.includes("edef8ba9-79d6-4ace-a3c8-27dcd51d21ed")) continue;
    const pssh =
      /<(?:[\w-]+:)?pssh[^>]*>\s*([A-Za-z0-9+/=]+)\s*<\/(?:[\w-]+:)?pssh>/i
        .exec(block.inner)?.[1];
    if (pssh) return pssh.trim();
  }
  const fallback =
    /<(?:[\w-]+:)?pssh[^>]*>\s*([A-Za-z0-9+/=]+)\s*<\/(?:[\w-]+:)?pssh>/i.exec(
      xml,
    )?.[1];
  if (fallback) return fallback.trim();
  throw new Error("no Widevine PSSH found in MPD");
}

async function getKeys(
  channelId: string,
  force = false,
): Promise<ContentKey[]> {
  const hit = keyCache.get(channelId);
  if (!force && hit && hit.expiresAt > Date.now()) return hit.keys;
  const info = await resolveStream(channelId, force);
  if (!info.drm) throw new Error(`channel ${channelId} is not DRM`);
  const mpd = await fetchMpd(info.manifestUrl);
  const pssh = extractPssh(mpd.xml);
  let res: Response;
  try {
    res = await fetch(`${config.cdmUrl}/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pssh,
        licenseUrl: info.drm.licenseUrl,
        headers: info.drm.headers,
      }),
    });
  } catch (e) {
    throw new Error(
      `CDM sidecar unreachable at ${config.cdmUrl}: ${(e as Error).message}`,
    );
  }
  if (!res.ok) {
    throw new HttpError(
      res.status,
      `CDM key extraction failed: HTTP ${res.status}`,
    );
  }
  const keys = await res.json().catch(() => []) as ContentKey[];
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("CDM returned no content keys");
  }
  keyCache.set(channelId, { keys, expiresAt: Date.now() + KEY_TTL_MS });
  return keys;
}

function chooseRepresentation(
  list: ParsedRepresentation[],
  preferredId?: string,
): ParsedRepresentation | null {
  if (preferredId) {
    const keep = list.find((item) => item.representationId === preferredId);
    if (keep) return keep;
  }
  return [...list].sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? null;
}

function segmentStem(kind: TrackKind, segment: ParsedSegment): string {
  if (segment.number != null) {
    return `${kind}-n${String(segment.number).padStart(8, "0")}`;
  }
  return `${kind}-t${String(segment.time ?? 0).padStart(12, "0")}`;
}

function createTrack(
  kind: TrackKind,
  source: ParsedRepresentation,
  dirs: ChannelDirs,
): TrackRuntime {
  return {
    kind,
    source,
    initEncryptedPath: `${dirs.enc}/${kind}-init.mp4.enc`,
    initDecryptedPath: `${dirs.dec}/${kind}-init.mp4`,
    initPrepared: false,
    initWritten: false,
    segments: [],
    sentSegmentIds: new Set(),
  };
}

function mergeTrack(
  kind: TrackKind,
  current: TrackRuntime | null,
  next: ParsedRepresentation,
  dirs: ChannelDirs,
): TrackRuntime {
  if (!current) return createTrack(kind, next, dirs);
  if (current.source.representationId !== next.representationId) {
    throw new Error(`${kind} representation changed; restart required`);
  }
  current.source = next;
  return current;
}

async function downloadToFile(url: string, path: string): Promise<void> {
  const res = await fetch(url, { headers: mediaHeaders() });
  if (!res.ok) {
    throw new HttpError(
      res.status,
      `fragment download failed: HTTP ${res.status}`,
    );
  }
  const tmp = `${path}.tmp`;
  await Deno.writeFile(tmp, new Uint8Array(await res.arrayBuffer()));
  await Deno.rename(tmp, path);
}

async function ensureCommand(command: string, label: string): Promise<void> {
  try {
    await new Deno.Command(command, {
      args: [],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(`${label} not found: configure ${label}`);
    }
    throw e;
  }
}

async function ensureMp4decrypt(): Promise<void> {
  if (!mp4decryptChecked) {
    await ensureCommand(config.mp4decrypt, "FOCUSSAT_MP4DECRYPT");
    mp4decryptChecked = true;
  }
}

async function ensurePackager(): Promise<void> {
  if (!packagerChecked) {
    await ensureCommand(config.shakaPackager, "FOCUSSAT_SHAKA_PACKAGER");
    packagerChecked = true;
  }
}

async function ensureCdm(): Promise<void> {
  if (cdmChecked) return;
  let res: Response;
  try {
    res = await fetch(`${config.cdmUrl}/health`);
  } catch (e) {
    throw new Error(
      `CDM sidecar unreachable at ${config.cdmUrl}: ${(e as Error).message}`,
    );
  }
  if (!res.ok) throw new Error(`CDM sidecar health failed: HTTP ${res.status}`);
  cdmChecked = true;
}

async function startupChecks(): Promise<void> {
  for (
    const check of [
      () => ensureCdm(),
      () => ensureMp4decrypt(),
      () => ensurePackager(),
    ]
  ) {
    try {
      await check();
    } catch (e) {
      log(`startup check warning: ${(e as Error).message}`);
    }
  }
}

async function decryptFile(
  inputPath: string,
  outputPath: string,
  keys: ContentKey[],
  fragmentsInfoPath?: string,
): Promise<void> {
  const args = keys.flatMap((key) => ["--key", `${key.kid}:${key.key}`]);
  if (fragmentsInfoPath) args.push("--fragments-info", fragmentsInfoPath);
  args.push(inputPath, `${outputPath}.tmp`);
  const result = await new Deno.Command(config.mp4decrypt, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`mp4decrypt failed: ${stderr || `exit ${result.code}`}`);
  }
  await Deno.rename(`${outputPath}.tmp`, outputPath);
}

async function prepareInit(
  state: DrmState,
  track: TrackRuntime,
): Promise<void> {
  if (track.initPrepared) return;
  await downloadToFile(track.source.initUrl, track.initEncryptedPath);
  await decryptFile(
    track.initEncryptedPath,
    track.initDecryptedPath,
    state.keys,
  );
  track.initPrepared = true;
}

async function clearDir(path: string): Promise<void> {
  try {
    for await (const entry of Deno.readDir(path)) {
      await Deno.remove(`${path}/${entry.name}`, { recursive: true }).catch(
        () => {},
      );
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function appendLog(state: DrmState, message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${redact(message)}\n`;
  await Deno.writeTextFile(`${state.dirs.logs}/pipeline.log`, line, {
    create: true,
    append: true,
  }).catch(() => {});
}

async function pipeToLog(
  stream: ReadableStream<Uint8Array> | null,
  path: string,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        await Deno.writeTextFile(
          path,
          decoder.decode(value, { stream: true }),
          { create: true, append: true },
        );
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function createNamedPipe(path: string): Promise<void> {
  await Deno.remove(path).catch(() => {});
  const result = await new Deno.Command("mkfifo", {
    args: [path],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`mkfifo failed: ${stderr || `exit ${result.code}`}`);
  }
}

function packagerArgs(state: DrmState): string[] {
  if (!state.audio || !state.video) {
    throw new Error("packager requires audio and video tracks");
  }
  const audioName = (state.audio.source.language ?? "audio").replaceAll(
    ",",
    "_",
  );
  return [
    `in=${state.pipePaths.audio},stream=audio,init_segment=audio/init.mp4,segment_template=audio/$Number$.m4s,playlist_name=audio.m3u8,hls_group_id=audio,hls_name=${audioName},bw=${
      Math.max(1, state.audio.source.bandwidth)
    }`,
    `in=${state.pipePaths.video},stream=video,init_segment=video/init.mp4,segment_template=video/$Number$.m4s,playlist_name=video.m3u8,bw=${
      Math.max(1, state.video.source.bandwidth)
    }`,
    "--hls_master_playlist_output",
    "index.m3u8",
    "--hls_playlist_type",
    "LIVE",
    "--segment_duration",
    "6",
    "--fragment_duration",
    "6",
    "--time_shift_buffer_depth",
    "30",
    "--preserved_segments_outside_live_window",
    "6",
  ];
}

async function startPackager(state: DrmState): Promise<void> {
  await ensureDir(`${state.dirs.out}/audio`);
  await ensureDir(`${state.dirs.out}/video`);
  await createNamedPipe(state.pipePaths.audio);
  await createNamedPipe(state.pipePaths.video);
  const process = new Deno.Command(config.shakaPackager, {
    args: packagerArgs(state),
    cwd: state.dirs.out,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  state.packager = process;
  state.packagerStatus = process.status;
  void pipeToLog(process.stdout, `${state.dirs.logs}/packager.stdout.log`);
  void pipeToLog(process.stderr, `${state.dirs.logs}/packager.stderr.log`);
  state.audioFile = await Deno.open(state.pipePaths.audio, { write: true });
  state.videoFile = await Deno.open(state.pipePaths.video, { write: true });
  state.audioWriter = state.audioFile.writable.getWriter();
  state.videoWriter = state.videoFile.writable.getWriter();
  void state.packagerStatus.then((status) => {
    if (!state.stopRequested && !state.closed) {
      state.lastError = `packager exited with code ${status.code}`;
      if (!state.readySettled) state.readyReject(new Error(state.lastError));
    }
  });
}

async function refreshState(state: DrmState, force = false): Promise<void> {
  const info = await resolveStream(state.channelId, force);
  if (!info.drm) throw new Error("channel is not DRM");
  const snapshot = await fetchMpd(info.manifestUrl);
  const audio = chooseRepresentation(
    snapshot.parsed.audio,
    state.audio?.source.representationId,
  );
  const video = chooseRepresentation(
    snapshot.parsed.video,
    state.video?.source.representationId,
  );
  if (!audio || !video) {
    throw new Error("MPD did not expose audio and video tracks");
  }
  state.streamInfo = info;
  state.manifest = snapshot.parsed;
  state.manifestXml = snapshot.xml;
  state.audio = mergeTrack("audio", state.audio, audio, state.dirs);
  state.video = mergeTrack("video", state.video, video, state.dirs);
  state.syncIntervalMs = Math.max(1_000, snapshot.parsed.minimumUpdatePeriodMs);
  state.lastRefreshAt = Date.now();
}

async function syncTrack(
  state: DrmState,
  track: TrackRuntime,
): Promise<boolean> {
  await prepareInit(state, track);
  const desired = track.source.segments.slice(-PIPE_SEGMENT_WINDOW);
  const retain = new Set(
    track.source.segments.slice(-PIPE_SEGMENT_RETENTION).map((segment) =>
      segment.id
    ),
  );
  const known = new Set(track.segments.map((segment) => segment.id));
  let progressed = false;
  for (const segment of desired) {
    if (known.has(segment.id)) continue;
    const stem = segmentStem(track.kind, segment);
    const encryptedPath = `${state.dirs.enc}/${stem}.m4s.enc`;
    const decryptedPath = `${state.dirs.dec}/${stem}.m4s`;
    await downloadToFile(segment.url, encryptedPath);
    await decryptFile(
      encryptedPath,
      decryptedPath,
      state.keys,
      track.initEncryptedPath,
    );
    track.segments.push({
      ...segment,
      encryptedPath,
      decryptedPath,
      downloadedAt: Date.now(),
      writtenAt: null,
    });
    known.add(segment.id);
    state.lastProgressAt = Date.now();
    progressed = true;
  }
  const order = new Map(
    track.source.segments.map((segment, index) => [segment.id, index]),
  );
  const survivors: LocalSegment[] = [];
  for (const segment of track.segments) {
    if (retain.has(segment.id) || segment.writtenAt === null) {
      survivors.push(segment);
    } else {
      await Deno.remove(segment.encryptedPath).catch(() => {});
      await Deno.remove(segment.decryptedPath).catch(() => {});
    }
  }
  survivors.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  track.segments = survivors;
  return progressed;
}

async function feedTrack(
  track: TrackRuntime,
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  if (!track.initWritten) {
    await writer.write(await Deno.readFile(track.initDecryptedPath));
    track.initWritten = true;
  }
  const order = new Map(
    track.source.segments.map((segment, index) => [segment.id, index]),
  );
  const pending = track.segments
    .filter((segment) => !track.sentSegmentIds.has(segment.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  for (const segment of pending) {
    await writer.write(await Deno.readFile(segment.decryptedPath));
    track.sentSegmentIds.add(segment.id);
    segment.writtenAt = Date.now();
  }
}

async function syncStateOnce(state: DrmState): Promise<boolean> {
  try {
    await refreshState(state);
  } catch (e) {
    if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
      await refreshState(state, true);
    } else throw e;
  }
  if (
    !state.audio || !state.video || !state.audioWriter || !state.videoWriter
  ) throw new Error("DRM state not initialized");
  const audioProgress = await syncTrack(state, state.audio);
  const videoProgress = await syncTrack(state, state.video);
  await feedTrack(state.audio, state.audioWriter);
  await feedTrack(state.video, state.videoWriter);
  return audioProgress || videoProgress;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(failures: number): number {
  return PIPE_RETRY_DELAYS_MS[failures - 1] ??
    PIPE_RETRY_DELAYS_MS[PIPE_RETRY_DELAYS_MS.length - 1];
}

function recordCooldown(channelId: string, reason: string): void {
  const current = restartCooldowns.get(channelId);
  const failures = (current?.failures ?? 0) + 1;
  const delay = DRM_RESTART_COOLDOWN_MS[failures - 1] ??
    DRM_RESTART_COOLDOWN_MS[DRM_RESTART_COOLDOWN_MS.length - 1];
  restartCooldowns.set(channelId, {
    failures,
    retryAfterAt: Date.now() + delay,
    reason,
  });
}

function enforceCooldown(channelId: string): void {
  const cooldown = restartCooldowns.get(channelId);
  if (!cooldown) return;
  const remaining = cooldown.retryAfterAt - Date.now();
  if (remaining <= 0) return;
  const retryAfterSec = Math.ceil(remaining / 1000);
  throw new RestartCooldownError(
    retryAfterSec,
    `restart cooldown active; retry after ${retryAfterSec}s (${cooldown.reason})`,
  );
}

async function disposeState(
  state: DrmState,
  reason: string,
  cleanup = true,
): Promise<void> {
  if (state.closed) return;
  state.closed = true;
  state.stopRequested = true;
  drmStates.delete(state.channelId);
  await appendLog(state, `stopping: ${reason}`);
  if (!state.readySettled) state.readyReject(new Error(reason));
  try {
    await state.audioWriter?.close();
  } catch {}
  try {
    await state.videoWriter?.close();
  } catch {}
  try {
    state.audioFile?.close();
    state.videoFile?.close();
  } catch {}
  try {
    state.packager?.kill("SIGTERM");
  } catch {}
  try {
    await state.packagerStatus;
  } catch {}
  if (cleanup) {
    await Deno.remove(state.workDir, { recursive: true }).catch(() => {});
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = await Deno.stat(path);
      if (stat.isFile && stat.size > 0) return;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function runLoop(state: DrmState): Promise<void> {
  while (!state.stopRequested) {
    try {
      const madeProgress = await syncStateOnce(state);
      state.consecutiveFailures = 0;
      state.lastError = null;
      state.nextRetryDelayMs = state.syncIntervalMs;
      restartCooldowns.delete(state.channelId);
      if (
        !madeProgress && Date.now() - state.lastProgressAt > PIPE_NO_PROGRESS_MS
      ) {
        recordCooldown(state.channelId, "no upstream progress");
        await disposeState(state, "no upstream progress");
        return;
      }
      await sleep(state.syncIntervalMs);
    } catch (e) {
      state.consecutiveFailures += 1;
      state.lastError = (e as Error).message;
      state.nextRetryDelayMs = retryDelay(state.consecutiveFailures);
      await appendLog(
        state,
        `sync failed: ${state.lastError}; retrying in ${state.nextRetryDelayMs}ms`,
      );
      if (
        !state.readySettled ||
        /rebuild required|packager exited|Broken pipe|closed/i.test(
          state.lastError,
        )
      ) {
        recordCooldown(state.channelId, state.lastError);
        await disposeState(state, state.lastError);
        return;
      }
      await sleep(state.nextRetryDelayMs);
    }
  }
}

async function startDrmState(channelId: string): Promise<DrmState> {
  await ensureMp4decrypt();
  await ensurePackager();
  await ensureCdm();
  const workDir = `${LIVE_DIR}/${channelId}`;
  const dirs = {
    enc: `${workDir}/enc`,
    dec: `${workDir}/dec`,
    pipes: `${workDir}/pipes`,
    out: `${workDir}/out`,
    logs: `${workDir}/logs`,
  };
  await ensureDir(workDir);
  await clearDir(workDir);
  await Promise.all(Object.values(dirs).map((dir) => ensureDir(dir)));
  const ready = deferred<string>();
  void ready.promise.catch(() => {});
  const state: DrmState = {
    channelId,
    workDir,
    dirs,
    pipePaths: {
      audio: `${dirs.pipes}/audio.pipe`,
      video: `${dirs.pipes}/video.pipe`,
    },
    ready: ready.promise,
    readyResolve: ready.resolve,
    readyReject: ready.reject,
    readySettled: false,
    lastAccess: Date.now(),
    lastProgressAt: Date.now(),
    lastRefreshAt: 0,
    stopRequested: false,
    closed: false,
    streamInfo: null,
    keys: await getKeys(channelId),
    audio: null,
    video: null,
    manifest: null,
    manifestXml: null,
    syncIntervalMs: PIPE_SYNC_FALLBACK_MS,
    consecutiveFailures: 0,
    nextRetryDelayMs: PIPE_SYNC_FALLBACK_MS,
    lastError: null,
    packager: null,
    packagerStatus: null,
    audioFile: null,
    videoFile: null,
    audioWriter: null,
    videoWriter: null,
    loop: null,
  };
  drmStates.set(channelId, state);
  try {
    await appendLog(state, "starting DRM pipeline");
    await refreshState(state);
    await startPackager(state);
    await syncStateOnce(state);
    await waitForFile(`${state.dirs.out}/index.m3u8`, PLAYLIST_WAIT_TIMEOUT_MS);
    state.readySettled = true;
    state.readyResolve(`${state.dirs.out}/index.m3u8`);
    state.loop = runLoop(state);
    return state;
  } catch (e) {
    recordCooldown(channelId, (e as Error).message);
    await disposeState(state, (e as Error).message);
    throw e;
  }
}

async function ensureDrmState(channelId: string): Promise<DrmState> {
  enforceCooldown(channelId);
  const existing = drmStates.get(channelId);
  if (existing) {
    existing.lastAccess = Date.now();
    await existing.ready;
    return existing;
  }
  const pending = drmStarts.get(channelId);
  if (pending) {
    const state = await pending;
    state.lastAccess = Date.now();
    return state;
  }
  const promise = startDrmState(channelId);
  drmStarts.set(channelId, promise);
  try {
    const state = await promise;
    state.lastAccess = Date.now();
    return state;
  } finally {
    drmStarts.delete(channelId);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const state of drmStates.values()) {
    if (now - state.lastAccess > PIPE_IDLE_MS) {
      void disposeState(state, "idle cleanup").catch(() => {});
    }
  }
}, 15_000);

function mimeType(path: string): string {
  if (path.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (path.endsWith(".mpd")) return "application/dash+xml";
  if (path.endsWith(".m4s") || path.endsWith(".mp4")) return "video/mp4";
  if (path.endsWith(".log")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

async function serveOutputFile(
  channelId: string,
  relativePath: string,
): Promise<Response> {
  const state = drmStates.get(channelId);
  if (state) state.lastAccess = Date.now();
  const clean = relativePath.split("/").filter(Boolean);
  if (
    clean.length === 0 || clean.some((part) => part === "." || part === "..")
  ) return new Response("bad path", { status: 400 });
  const path = `${LIVE_DIR}/${channelId}/out/${clean.join("/")}`;
  try {
    const file = await Deno.open(path, { read: true });
    return new Response(file.readable, {
      headers: { "Content-Type": mimeType(path), "Cache-Control": "no-store" },
    });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return new Response("not found", { status: 404 });
    }
    throw e;
  }
}

function responseForError(error: unknown, asJson = false): Response {
  if (error instanceof RestartCooldownError) {
    const headers = { "Retry-After": String(error.retryAfterSec) };
    return asJson
      ? Response.json({
        error: error.message,
        retryAfterSec: error.retryAfterSec,
      }, { status: error.status, headers })
      : new Response(error.message, { status: error.status, headers });
  }
  if (error instanceof HttpError) {
    return asJson
      ? Response.json({ error: error.message }, { status: error.status })
      : new Response(error.message, { status: error.status });
  }
  const message = redact((error as Error).message);
  return asJson
    ? Response.json({ error: message }, { status: 500 })
    : new Response(message, { status: 500 });
}

function channelRoute(channel: FocusSatChannel): string {
  return encodeURIComponent(channel.id);
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const host = req.headers.get("host") ?? `127.0.0.1:${config.port}`;

  if (req.method === "GET" && path === "/") {
    return new Response(INDEX_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (req.method === "POST" && path === "/api/login") {
    try {
      const state = await performLogin();
      return Response.json({
        ok: true,
        updatedAt: state.updatedAt,
        deviceEvicted: state.deviceEvicted ?? null,
      });
    } catch (e) {
      return responseForError(e, true);
    }
  }

  if (req.method === "GET" && path === "/api/channels") {
    try {
      const channels = await getChannels(url.searchParams.get("force") === "1");
      const cached = await readJson<{ updatedAt: string }>(CHANNELS_PATH);
      return Response.json({ channels, updatedAt: cached?.updatedAt ?? null });
    } catch (e) {
      return responseForError(e, true);
    }
  }

  if (req.method === "GET" && path.startsWith("/api/stream/")) {
    const requested = path.slice("/api/stream/".length);
    try {
      const channel = await findChannel(requested);
      if (!channel) {
        return Response.json({ error: "unknown channel" }, { status: 404 });
      }
      const info = await resolveStream(
        channel.id,
        url.searchParams.get("force") === "1",
      );
      return Response.json({
        id: channel.id,
        name: channel.name,
        manifestUrl: info.manifestUrl,
        drm: info.isDrm,
        licenseUrl: info.drm ? `/license/${channelRoute(channel)}` : null,
      });
    } catch (e) {
      return responseForError(e, true);
    }
  }

  if (req.method === "GET" && path === "/live.m3u8") {
    try {
      const channels = await getChannels();
      const lines = ["#EXTM3U"];
      for (const channel of channels) {
        lines.push(
          `#EXTINF:-1 tvg-id="${channel.id}" tvg-logo="${
            channel.imageUrl ?? ""
          }" group-title="FocusSat",${channel.name}`,
        );
        lines.push(`http://${host}/vlc/${channelRoute(channel)}/index.m3u8`);
      }
      return new Response(`${lines.join("\n")}\n`, {
        headers: { "Content-Type": "application/vnd.apple.mpegurl" },
      });
    } catch (e) {
      return responseForError(e);
    }
  }

  if (req.method === "POST" && path.startsWith("/license/")) {
    const requested = path.slice("/license/".length);
    try {
      const channel = await findChannel(requested);
      if (!channel) return new Response("unknown channel", { status: 404 });
      const challenge = await req.arrayBuffer();
      let info = await resolveStream(channel.id);
      if (!info.drm) return new Response("channel is not DRM", { status: 400 });
      let upstream = await fetch(info.drm.licenseUrl, {
        method: "POST",
        headers: info.drm.headers,
        body: challenge,
      });
      if (upstream.status === 401 || upstream.status === 403) {
        info = await resolveStream(channel.id, true);
        if (!info.drm) {
          return new Response("channel is not DRM", { status: 400 });
        }
        upstream = await fetch(info.drm.licenseUrl, {
          method: "POST",
          headers: info.drm.headers,
          body: challenge,
        });
      }
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": upstream.headers.get("content-type") ??
            "application/octet-stream",
        },
      });
    } catch (e) {
      log(`license proxy failed: ${(e as Error).message}`);
      return responseForError(e);
    }
  }

  if (req.method === "GET" && path.startsWith("/play/")) {
    return new Response(PLAY_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (req.method === "GET" && path.startsWith("/vlc/")) {
    const parts = path.slice("/vlc/".length).split("/").filter(Boolean);
    if (parts.length < 2) return new Response("bad path", { status: 400 });
    const requested = parts[0];
    const filename = parts.slice(1).join("/");
    try {
      const channel = await findChannel(requested);
      if (!channel) return new Response("unknown channel", { status: 404 });
      if (filename === "index.m3u8") await ensureDrmState(channel.id);
      return await serveOutputFile(channel.id, filename);
    } catch (e) {
      log(`vlc output failed: ${(e as Error).message}`);
      return responseForError(e);
    }
  }

  if (req.method === "GET" && path.startsWith("/api/keys/")) {
    const requested = path.slice("/api/keys/".length);
    try {
      const channel = await findChannel(requested);
      if (!channel) {
        return Response.json({ error: "unknown channel" }, { status: 404 });
      }
      return Response.json(
        await getKeys(channel.id, url.searchParams.get("force") === "1"),
      );
    } catch (e) {
      return responseForError(e, true);
    }
  }

  if (req.method === "GET" && path.startsWith("/api/drm-state/")) {
    const requested = path.slice("/api/drm-state/".length);
    try {
      const channel = await findChannel(requested);
      if (!channel) {
        return Response.json({ error: "unknown channel" }, { status: 404 });
      }
      if (url.searchParams.get("ensure") === "1") {
        await ensureDrmState(channel.id);
      }
      const state = drmStates.get(channel.id);
      const cooldown = restartCooldowns.get(channel.id);
      return Response.json({
        active: !!state,
        cooldown: cooldown
          ? {
            ...cooldown,
            retryAfterSec: Math.max(
              0,
              Math.ceil((cooldown.retryAfterAt - Date.now()) / 1000),
            ),
          }
          : null,
        state: state
          ? {
            lastAccess: new Date(state.lastAccess).toISOString(),
            lastRefreshAt: state.lastRefreshAt
              ? new Date(state.lastRefreshAt).toISOString()
              : null,
            lastError: state.lastError,
            syncIntervalMs: state.syncIntervalMs,
            consecutiveFailures: state.consecutiveFailures,
            manifestUrl: state.streamInfo?.manifestUrl ?? null,
            outputDir: state.dirs.out,
          }
          : null,
      });
    } catch (e) {
      return responseForError(e, true);
    }
  }

  if (req.method === "GET" && path === "/proxy") {
    const target = url.searchParams.get("url");
    if (!target) return new Response("missing url", { status: 400 });
    try {
      const upstream = await fetch(target, { headers: mediaHeaders(req) });
      const headers = new Headers();
      for (
        const name of [
          "content-type",
          "content-length",
          "content-range",
          "accept-ranges",
          "cache-control",
        ]
      ) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
      }
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (e) {
      return responseForError(e);
    }
  }

  return new Response("not found", { status: 404 });
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FocusSat Live</title>
<style>
  :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#101418; color:#eef2f5; }
  body { margin:0; }
  header { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:16px 20px; border-bottom:1px solid #26313a; background:#151b21; position:sticky; top:0; }
  h1 { font-size:20px; margin:0; font-weight:700; }
  button, a.button { border:1px solid #42515e; background:#202a32; color:#eef2f5; padding:8px 12px; border-radius:6px; cursor:pointer; text-decoration:none; font:inherit; }
  button:hover, a.button:hover { background:#2a3540; }
  main { padding:18px; max-width:1180px; margin:0 auto; }
  #status { color:#a9b5bf; min-height:22px; margin-bottom:14px; }
  .toolbar { display:flex; gap:10px; flex-wrap:wrap; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:12px; }
  .channel { border:1px solid #28343d; border-radius:8px; background:#161d23; overflow:hidden; }
  .thumb { aspect-ratio:16/9; background:#0d1115; display:grid; place-items:center; }
  .thumb img { width:100%; height:100%; object-fit:contain; }
  .body { padding:12px; }
  .name { font-weight:650; margin-bottom:10px; }
  .actions { display:flex; gap:8px; flex-wrap:wrap; }
  code { color:#a9d4ff; }
</style>
</head>
<body>
<header>
  <h1>FocusSat Live</h1>
  <div class="toolbar">
    <button id="login">Login</button>
    <button id="refresh">Refresh Channels</button>
    <a class="button" href="/live.m3u8">M3U</a>
  </div>
</header>
<main>
  <div id="status">Loading channels...</div>
  <div id="channels" class="grid"></div>
</main>
<script>
const statusEl = document.querySelector("#status");
const channelsEl = document.querySelector("#channels");
function setStatus(text) { statusEl.textContent = text; }
async function api(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
  return data;
}
async function load(force=false) {
  setStatus("Loading channels...");
  try {
    const data = await api("/api/channels" + (force ? "?force=1" : ""));
    channelsEl.innerHTML = "";
    for (const ch of data.channels) {
      const el = document.createElement("article");
      el.className = "channel";
      el.innerHTML = \`
        <div class="thumb">\${ch.imageUrl ? \`<img src="\${ch.imageUrl}" alt="">\` : "<span>FocusSat</span>"}</div>
        <div class="body">
          <div class="name"></div>
          <div class="actions">
            <a class="button" href="/play/\${encodeURIComponent(ch.id)}">Play</a>
            <a class="button" href="/vlc/\${encodeURIComponent(ch.id)}/index.m3u8">VLC</a>
          </div>
        </div>\`;
      el.querySelector(".name").textContent = ch.name;
      channelsEl.appendChild(el);
    }
    setStatus(data.channels.length + " channels" + (data.updatedAt ? " · updated " + data.updatedAt : ""));
  } catch (error) {
    setStatus(error.message);
  }
}
document.querySelector("#login").onclick = async () => {
  setStatus("Logging in...");
  try {
    const data = await api("/api/login", { method: "POST" });
    setStatus(data.deviceEvicted ? "Logged in; evicted device " + data.deviceEvicted : "Logged in");
    await load(true);
  } catch (error) {
    setStatus(error.message);
  }
};
document.querySelector("#refresh").onclick = () => load(true);
load(false);
</script>
</body>
</html>`;

const PLAY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FocusSat Player</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.15.8/shaka-player.compiled.min.js"></script>
<style>
  :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background:#0d1115; color:#eef2f5; }
  body { margin:0; min-height:100vh; display:grid; grid-template-rows:auto 1fr auto; }
  header, footer { padding:12px 16px; background:#151b21; border-color:#26313a; }
  header { border-bottom:1px solid #26313a; }
  footer { border-top:1px solid #26313a; color:#a9b5bf; }
  video { width:100%; height:100%; background:#000; }
</style>
</head>
<body>
<header id="title">FocusSat Player</header>
<video id="video" controls autoplay></video>
<footer id="status">Loading...</footer>
<script>
const statusEl = document.querySelector("#status");
const titleEl = document.querySelector("#title");
const channelId = decodeURIComponent(location.pathname.slice("/play/".length));
function status(text) { statusEl.textContent = text; }
async function main() {
  if (!window.shaka) throw new Error("Shaka Player did not load");
  if (!shaka.Player.isBrowserSupported()) throw new Error("This browser does not support the required media/Widevine APIs");
  const res = await fetch("/api/stream/" + encodeURIComponent(channelId));
  const info = await res.json();
  if (!res.ok) throw new Error(info.error || "stream resolution failed");
  titleEl.textContent = info.name || "FocusSat Player";
  const player = new shaka.Player(document.querySelector("#video"));
  player.addEventListener("error", event => status(event.detail?.message || String(event.detail || "playback error")));
  if (info.drm) player.configure({ drm: { servers: { "com.widevine.alpha": info.licenseUrl } } });
  await player.load(info.manifestUrl);
  status("Playing " + info.name);
}
main().catch(error => status(error.message));
</script>
</body>
</html>`;

if (import.meta.main) {
  await ensureDir(config.dataDir);
  await ensureDir(LOG_DIR);
  await startupChecks();
  log(
    `starting on http://127.0.0.1:${config.port} ` +
      `(device=${config.deviceProfile}, player=${config.playerName} ${config.playerVersion})`,
  );
  Deno.serve({ port: config.port }, (req) => handle(req));
}
