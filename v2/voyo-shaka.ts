#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-run
// Voyo Live Shaka — single-file Deno 2 server.
// Routes:  GET /  • GET /api/channels  • POST /api/login
//          • GET /live/:id.m3u8           — non-DRM, HLS pass-through
//          • GET /live.m3u8               — combined VLC playlist (?mode=all includes DRM)
//          • GET /vlc/:id/index.m3u8      — server-decrypted DRM live via Shaka Packager
//          • GET /api/keys/:id            — debug: hex content keys from sidecar
//          • GET /play/:id, /mosaic       — in-browser Shaka players (Chrome Widevine)
//          • GET /proxy?url=              — generic CORS/header passthrough used by /live

import { crypto as stdCrypto } from "jsr:@std/crypto/crypto";

// === Types ===
type Channel = {
  id: string;
  contentId?: string | null;
  name: string;
  img: string;
  slug: string;
  kind?: "channel" | "event";
  sourceUrl?: string | null;
  streamKind?: "drm" | "hls" | "unknown";
  lastCheckedAt?: string | null;
  lastError?: string | null;
};
type StreamInfo = { url: string; isDrm: boolean; drm?: { url: string; headers: Record<string, string> } };
type Creds = { username: string; password: string };
type Session = { token: string | null; uuid: string | null; issuedAt: string | null };
type Config = {
  credentials: Creds;
  session: Session;
  channels: Channel[];
  manualEvents: Channel[];
  channelsUpdatedAt: string | null;
};

const VOYO_CONTENT_TYPES = ["show", "tvshow", "movie", "episode", "trailer", "bonus", "channel", "livechannel", "live"] as const;
const VOYO_TYPED_CONTENT_ID_RE = new RegExp(`^(${VOYO_CONTENT_TYPES.join("|")})([.-])(\\d+)$`, "i");
const VOYO_URL_TYPE_MAP: Record<string, typeof VOYO_CONTENT_TYPES[number]> = {
  "episodul": "episode",
  "episode": "episode",
  "bonusul": "bonus",
  "bonus": "bonus",
  "trailerul": "trailer",
  "trailer": "trailer",
  "filmul": "movie",
  "film": "movie",
  "serialul": "tvshow",
  "serial": "tvshow",
  "emisiunea": "show",
  "emisiune": "show",
  "canalul": "channel",
  "canal": "channel",
  "live": "live",
  "livechannel": "livechannel",
};

// === Constants ===
const PORT = Number(Deno.env.get("VOYO_PORT") ?? 8090);

function resolveExecutable(command: string): string {
  if (!command.includes("/")) return command;
  return command.startsWith("/") ? command : `${Deno.cwd()}/${command}`.replaceAll("/./", "/");
}

function defaultConfigDir(): string {
  const env = Deno.env.get("VOYO_CONFIG_DIR");
  if (env) return env;
  // Detect dev vs compiled: in `deno run`, Deno.execPath() points at the deno binary itself;
  // in a compiled binary it points at our own executable.
  const exe = Deno.execPath();
  const exeName = exe.substring(exe.lastIndexOf("/") + 1).toLowerCase();
  const isCompiled = exeName !== "deno" && exeName !== "deno.exe";
  if (isCompiled) return exe.substring(0, exe.lastIndexOf("/")) || ".";
  return new URL(".", import.meta.url).pathname.replace(/\/$/, "");
}
const CONFIG_DIR = defaultConfigDir();
const CONFIG_PATH = `${CONFIG_DIR}/voyo.json`;
const LEGACY_CONFIG_PATH = `${CONFIG_DIR}/../configs/voyo.json`;
const API_BASE = "https://apivoyo.cms.protvplus.ro";
const AUTH_REFRESH_MS = 6 * 60 * 60 * 1000;
const CHANNELS_REFRESH_MS = 12 * 60 * 60 * 1000;
const SALT_B64 = "ZGtkZjM1ZzYhIHtjb250ZW50fXxwbGF5c3xuZzhyNWUzMSF8e3NlcnZlclRpbWV9ISNpM2R0JjQzQA==";
const UI_BASIC_AUTH_USER = Deno.env.get("VOYO_UI_BASIC_AUTH_USER") ?? "adm";
const UI_BASIC_AUTH_PASS = Deno.env.get("VOYO_UI_BASIC_AUTH_PASS") ?? "fvoyo";
const PRESERVE_LIVE_DIR = /^(1|true|yes)$/i.test(Deno.env.get("VOYO_PRESERVE_LIVE_DIR") ?? "");

function deviceHeaders(uuid: string, token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
    "Content-Type": "application/json",
    "X-Device-Id": uuid,
    "User-Agent":
      "Voyo/5.18.5 (net.cme.voyo.ro; build:2295; Android 12; Model:moto g(7) power) okhttp/4.9.1",
    "X-AppBuildNumber": "2295",
    "X-Version": "5.18.5",
    "X-DeviceName": "IPTV_RO",
    "X-DeviceModel": "moto g(7) power",
    "X-DeviceManufacturer": "motorola",
    "X-DeviceOSVersion": "32",
    "X-DeviceOS": "Android",
    "X-DeviceType": "mobile",
  };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function slugify(name: string): string {
  return name.normalize("NFKD").replace(/[^\w]/g, " ").trim().replaceAll(" ", "-").replace("--", "-").toLowerCase();
}

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

function isUiProtectedRoute(path: string, method: string): boolean {
  if (method === "GET" && (path === "/" || path === "/mosaic")) return true;
  if (method === "POST" && path === "/api/login") return true;
  if (method === "POST" && path === "/api/events") return true;
  if (method === "DELETE" && path.startsWith("/api/events/")) return true;
  if (method === "GET" && (path.startsWith("/play/") || path.startsWith("/api/channels") || path.startsWith("/api/stream/"))) {
    return true;
  }
  if (method === "GET" &&
    (path.startsWith("/api/keys/") || path.startsWith("/api/drm-state/") || path.startsWith("/api/drm-manifest/") ||
      path.startsWith("/api/drm-log/"))) {
    return true;
  }
  return false;
}

function unauthorizedBasicAuthResponse(): Response {
  return new Response("authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Voyo UI", charset="UTF-8"' },
  });
}

function requireBasicAuth(req: Request): Response | null {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Basic ")) return unauthorizedBasicAuthResponse();
  const encoded = auth.slice("Basic ".length).trim();
  let decoded = "";
  try {
    decoded = atob(encoded);
  } catch {
    return unauthorizedBasicAuthResponse();
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return unauthorizedBasicAuthResponse();
  const username = decoded.slice(0, idx);
  const password = decoded.slice(idx + 1);
  if (username !== UI_BASIC_AUTH_USER || password !== UI_BASIC_AUTH_PASS) {
    return unauthorizedBasicAuthResponse();
  }
  return null;
}

// === Voyo API ===
async function login(creds: Creds): Promise<{ token: string; uuid: string }> {
  const uuid = crypto.randomUUID();
  const res = await fetch(`${API_BASE}/api/v1/auth-sessions`, {
    method: "POST",
    headers: deviceHeaders(uuid),
    body: JSON.stringify(creds),
  });
  const data = await res.json().catch(() => ({}));
  if (!data?.credentials?.accessToken) {
    throw new HttpError(res.status, `login failed: ${data?.message ?? res.status}`);
  }
  return { token: data.credentials.accessToken, uuid };
}

async function listChannels(token: string, uuid: string): Promise<Channel[]> {
  const res = await fetch(`${API_BASE}/api/v1/overview?category=livetv`, {
    headers: deviceHeaders(uuid, token),
  });
  if (!res.ok) throw new HttpError(res.status, `channels: ${res.status}`);
  const data = await res.json();
  return (data.liveTvs ?? []).map((c: { id: string; name: string; logo?: string }) => ({
    id: c.id,
    name: c.name,
    img: c.logo?.replace("{WIDTH}x{HEIGHT}", "1920x1080") ?? "",
    slug: slugify(c.name),
  }));
}

async function resolveStream(channelId: string, token: string, uuid: string): Promise<StreamInfo> {
  const headers = deviceHeaders(uuid, token);
  const tRes = await fetch(`${API_BASE}/api/v1/server/time`, { headers });
  if (!tRes.ok) throw new HttpError(tRes.status, `server/time: ${tRes.status}`);
  const { localTime, encoded } = await tRes.json();

  const salt = atob(SALT_B64).replace("{content}", channelId).replace("{serverTime}", localTime);
  const hash = toHex(await stdCrypto.subtle.digest("MD5", new TextEncoder().encode(salt)));

  const url =
    `${API_BASE}/api/v1/content/${channelId}/plays?acceptVideo=hls%2Cdai%2Cdash%2Cdrm-widevine&t=${encoded}&s=${hash}`;
  const sRes = await fetch(url, { method: "POST", headers });
  const data = await sRes.json().catch(() => ({}));
  if (!sRes.ok || !data?.url) {
    throw new HttpError(sRes.status, `stream: ${data?.message ?? sRes.status}`);
  }

  const info: StreamInfo = { url: data.url, isDrm: data.videoType !== "hls" };
  if (data.drm) {
    info.drm = {
      url: data.drm.licenseUrl,
      headers: (data.drm.licenseRequestHeaders ?? []).reduce(
        (acc: Record<string, string>, { name, value }: { name: string; value: string }) => ({ ...acc, [name]: value }),
        {},
      ),
    };
  }
  return info;
}

function titleCaseWords(input: string): string {
  return input
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function humanizeSlug(slug: string): string {
  const decoded = decodeURIComponent(slug).replaceAll("-", " ").trim();
  return decoded ? titleCaseWords(decoded) : "Manual Event";
}

function normalizeTypedContentId(value: string): string | null {
  const match = VOYO_TYPED_CONTENT_ID_RE.exec(value.trim());
  if (!match) return null;
  return `${match[1].toLowerCase()}.${match[3]}`;
}

function extractNumericContentTail(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const match = VOYO_TYPED_CONTENT_ID_RE.exec(trimmed);
  return match?.[3] ?? null;
}

function inferEventContentId(value: string): string {
  return normalizeTypedContentId(value) ?? `episode.${extractNumericContentTail(value) ?? value.trim()}`;
}

function publicContentRouteId(value: string): string {
  const normalized = normalizeTypedContentId(value);
  if (!normalized) return value.trim();
  const match = VOYO_TYPED_CONTENT_ID_RE.exec(normalized);
  return match ? `${match[1].toLowerCase()}-${match[3]}` : value.trim();
}

function publicRoutePathFor(channel: Pick<Channel, "id" | "contentId" | "kind">): string {
  const normalized = channel.kind === "event" && channel.contentId ? normalizeTypedContentId(channel.contentId) : null;
  const match = normalized ? VOYO_TYPED_CONTENT_ID_RE.exec(normalized) : null;
  return match ? `${match[1].toLowerCase()}/${match[3]}` : channel.id;
}

function contentRouteAliases(channel: Pick<Channel, "id" | "contentId">): string[] {
  const aliases = new Set<string>([channel.id]);
  const normalized = channel.contentId ? normalizeTypedContentId(channel.contentId) : null;
  if (normalized) {
    aliases.add(normalized);
    aliases.add(publicContentRouteId(normalized));
  }
  return [...aliases].filter(Boolean);
}

function normalizeRequestedContentKey(value: string): string {
  const decoded = decodeURIComponent(value.trim());
  const routeMatch = /^([a-z]+)\/(\d+)$/i.exec(decoded);
  if (routeMatch && VOYO_CONTENT_TYPES.includes(routeMatch[1].toLowerCase() as typeof VOYO_CONTENT_TYPES[number])) {
    return `${routeMatch[1].toLowerCase()}.${routeMatch[2]}`;
  }
  return normalizeTypedContentId(decoded) ?? decoded;
}

function parseVoyoUrlContent(url: URL): { type: typeof VOYO_CONTENT_TYPES[number]; rawId: string; slug: string } | null {
  const match = /\/([^/]+)\/(\d+)(?:-([^/?#]+))?/i.exec(url.pathname);
  if (!match) return null;
  const type = VOYO_URL_TYPE_MAP[match[1].toLowerCase()];
  if (!type) return null;
  return { type, rawId: match[2], slug: match[3] ?? match[2] };
}

function parseManualEventInput(input: string): Channel {
  const value = input.trim();
  if (!value) throw new Error("enter a Voyo event URL or content ID");
  const typed = normalizeTypedContentId(value);
  const numeric = extractNumericContentTail(value);
  if (typed) {
    const routeId = publicContentRouteId(typed);
    return {
      id: routeId,
      contentId: typed,
      name: `Event ${numeric ?? typed}`,
      img: "",
      slug: routeId.startsWith("event-") ? routeId : `event-${routeId}`,
      kind: "event",
      sourceUrl: null,
      streamKind: "unknown",
      lastCheckedAt: null,
      lastError: null,
    };
  }
  if (/^\d+$/.test(value)) {
    const contentId = inferEventContentId(value);
    return {
      id: publicContentRouteId(contentId),
      contentId,
      name: `Event ${value}`,
      img: "",
      slug: `event-${publicContentRouteId(contentId)}`,
      kind: "event",
      sourceUrl: null,
      streamKind: "unknown",
      lastCheckedAt: null,
      lastError: null,
    };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid URL");
  }
  const parsedUrl = parseVoyoUrlContent(url);
  if (!parsedUrl) throw new Error("unsupported Voyo URL path; use a typed ID like episode-134030");
  const contentId = `${parsedUrl.type}.${parsedUrl.rawId}`;
  const routeId = publicContentRouteId(contentId);
  const slug = parsedUrl.slug ? `event-${parsedUrl.slug}` : `event-${routeId}`;
  return {
    id: routeId,
    contentId,
    name: humanizeSlug(parsedUrl.slug),
    img: "",
    slug,
    kind: "event",
    sourceUrl: url.toString(),
    streamKind: "unknown",
    lastCheckedAt: null,
    lastError: null,
  };
}

async function fetchPublicPageMeta(pageUrl: string): Promise<Partial<Channel>> {
  const res = await fetch(pageUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) return {};
  const html = await res.text();
  const metaContent = (property: string) =>
    new RegExp(`<meta[^>]+(?:property|name)="${property}"[^>]+content="([^"]+)"`, "i").exec(html)?.[1] ?? null;
  const title = metaContent("og:title") ?? metaContent("twitter:title");
  const image = metaContent("og:image") ?? metaContent("twitter:image");
  return {
    name: title ? title.split("|")[0].trim() : undefined,
    img: image ?? undefined,
  };
}

function contentIdFor(channel: Pick<Channel, "id" | "contentId"> | string): string {
  return typeof channel === "string" ? channel : channel.contentId ?? channel.id;
}

async function probeStreamKind(
  cacheKey: string,
  contentId = cacheKey,
): Promise<{ streamKind: "drm" | "hls" | "unknown"; lastError: string | null }> {
  try {
    const info = await getStreamInfo(cacheKey, true, contentId);
    return { streamKind: info.isDrm ? "drm" : "hls", lastError: null };
  } catch (e) {
    return { streamKind: "unknown", lastError: (e as Error).message };
  }
}

// === Stream info cache (signed URLs expire; keep live playback fresh) ===
const STREAM_TTL_MS = 30 * 60 * 1000;
const STREAM_REFRESH_RETRY_MS = 60 * 1000;
const streamCache = new Map<string, { info: StreamInfo; expiresAt: number }>();
const streamRefreshes = new Map<string, Promise<StreamInfo>>();

function isTemporaryStreamRefreshError(error: unknown): boolean {
  if (!(error instanceof HttpError)) return true;
  return error.status === 401 || error.status === 403 || error.status === 429 || error.status >= 500;
}

function refreshStreamInfo(cacheKey: string, contentId: string): Promise<StreamInfo> {
  const inFlight = streamRefreshes.get(cacheKey);
  if (inFlight) return inFlight;

  const refresh = withAuth((t, u) => resolveStream(contentId, t, u))
    .then((info) => {
      streamCache.set(cacheKey, { info, expiresAt: Date.now() + STREAM_TTL_MS });
      return info;
    })
    .finally(() => {
      if (streamRefreshes.get(cacheKey) === refresh) streamRefreshes.delete(cacheKey);
    });
  streamRefreshes.set(cacheKey, refresh);
  return refresh;
}

async function getStreamInfo(cacheKey: string, force = false, contentId = cacheKey): Promise<StreamInfo> {
  const hit = streamCache.get(cacheKey);
  if (!force && hit && hit.expiresAt > Date.now()) return hit.info;

  try {
    return await refreshStreamInfo(cacheKey, contentId);
  } catch (error) {
    if (!force && hit && isTemporaryStreamRefreshError(error)) {
      const now = Date.now();
      if (hit.expiresAt <= now) {
        hit.expiresAt = now + STREAM_REFRESH_RETRY_MS;
        console.warn(`[stream-cache] refresh failed for ${cacheKey}; using cached stream:`, (error as Error).message);
      }
      return hit.info;
    }
    throw error;
  }
}

// === Widevine: PSSH extraction + CDM sidecar client + key cache ===
const CDM_PORT = Deno.env.get("VOYO_CDM_PORT") ?? "8091";
const CDM_URL = Deno.env.get("VOYO_CDM_URL") ?? `http://127.0.0.1:${CDM_PORT}`;
const KEY_TTL_MS = 30 * 60 * 1000;
const WIDEVINE_SYSTEM_ID = "edef8ba9-79d6-4ace-a3c8-27dceb5404f0";

type ContentKey = { kid: string; key: string };
const keyCache = new Map<string, { keys: ContentKey[]; expiresAt: number }>();

async function extractPssh(mpdUrl: string): Promise<string> {
  const res = await fetch(mpdUrl, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36" },
  });
  if (!res.ok) throw new HttpError(res.status, `MPD fetch: ${res.status}`);
  const xml = await res.text();
  // Match any Widevine-like ContentProtection block (various UUID suffixes in the wild)
  const cpRe = new RegExp(
    `<ContentProtection[^>]*schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-[0-9a-f]+"[^>]*>([\\s\\S]*?)</ContentProtection>`,
    "gi",
  );
  let m: RegExpExecArray | null;
  while ((m = cpRe.exec(xml)) !== null) {
    const psshM = /<(?:[\w-]+:)?pssh[^>]*>\s*([A-Za-z0-9+/=]+)\s*<\/(?:[\w-]+:)?pssh>/i.exec(m[1]);
    if (psshM) return psshM[1].trim();
  }
  throw new Error("no Widevine PSSH found in MPD");
}

async function getKeys(cacheKey: string, force = false, contentId = cacheKey): Promise<ContentKey[]> {
  if (!force) {
    const hit = keyCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.keys;
  }
  const info = await getStreamInfo(cacheKey, force, contentId);
  if (!info.drm) throw new Error(`channel ${cacheKey} is not DRM`);
  const pssh = await extractPssh(info.url);
  let res: Response;
  try {
    res = await fetch(`${CDM_URL}/keys`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pssh, licenseUrl: info.drm.url, headers: info.drm.headers }),
    });
  } catch (e) {
    throw new Error(`CDM sidecar unreachable at ${CDM_URL} — is cdm.py running? (${(e as Error).message})`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new HttpError(res.status, `CDM: ${body || res.status}`);
  }
  const keys = await res.json() as ContentKey[];
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("CDM returned no content keys");
  keyCache.set(cacheKey, { keys, expiresAt: Date.now() + KEY_TTL_MS });
  return keys;
}

// === DRM pipeline: fetch MPD → download/decrypt fragments → feed named pipes → package with Shaka ===
const MP4DECRYPT = resolveExecutable(Deno.env.get("VOYO_MP4DECRYPT") ?? "mp4decrypt");
const SHAKA_PACKAGER = resolveExecutable(Deno.env.get("VOYO_SHAKA_PACKAGER") ?? "packager");
const LIVE_DIR = `${CONFIG_DIR}/live-shaka`;
const PIPE_IDLE_MS = 60 * 1000;
const PIPE_SYNC_FALLBACK_MS = 3_000;
const PIPE_SEGMENT_WINDOW = 8;
const PIPE_SEGMENT_RETENTION = 18;
const SHAKA_SEGMENT_DURATION = 6;
const SHAKA_LIVE_WINDOW = 30;
const SHAKA_PRESERVED_SEGMENTS = 6;
const PLAYLIST_WAIT_TIMEOUT_MS = 25_000;
const PIPE_NO_PROGRESS_MS = 60 * 1000;
const PIPE_RETRY_DELAYS_MS = [3_000, 6_000, 12_000] as const;
const PIPE_RETRY_CAP_MS = 20_000;
const PIPE_RETRY_JITTER_RATIO = 0.2;
const DRM_RESTART_COOLDOWN_MS = [10_000, 10_000, 20_000, 20_000, 30_000, 60_000, 60_000, 120_000, 180_000] as const;
const DRM_RESTART_COOLDOWN_CAP_MS = 180_000;

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
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};
type ChannelDirs = {
  enc: string;
  dec: string;
  pipes: string;
  out: string;
  logs: string;
};
type PipePaths = {
  audio: string;
  video: string;
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
type PackagerHandle = {
  process: Deno.ChildProcess;
  status: Promise<Deno.CommandStatus>;
  stdoutTask: Promise<void>;
  stderrTask: Promise<void>;
};
type DrmChannelState = {
  channelId: string;
  contentId: string;
  workDir: string;
  dirs: ChannelDirs;
  pipePaths: PipePaths;
  ready: Promise<string>;
  readyResolve: Deferred<string>["resolve"];
  readyReject: Deferred<string>["reject"];
  readySettled: boolean;
  lastAccess: number;
  createdAt: number;
  lastRefreshAt: number;
  lastError: string | null;
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
  lastProgressAt: number;
  lastAttemptAt: number;
  nextRetryDelayMs: number;
  downloadLoopState: "starting" | "running" | "error" | "stopped";
  loop: Promise<void> | null;
  packager: PackagerHandle | null;
  audioPipeFile: Deno.FsFile | null;
  videoPipeFile: Deno.FsFile | null;
  audioWriter: WritableStreamDefaultWriter<Uint8Array> | null;
  videoWriter: WritableStreamDefaultWriter<Uint8Array> | null;
};

const drmStates = new Map<string, DrmChannelState>();
const drmStateStarts = new Map<string, Promise<DrmChannelState>>();
const drmRestartCooldowns = new Map<string, { failures: number; retryAfterAt: number; lastReason: string; updatedAt: number }>();
let mp4decryptChecked = false;
let shakaPackagerChecked = false;
let cdmReachableChecked = false;

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterDelayMs(baseMs: number): number {
  const jitter = (Math.random() * 2 - 1) * PIPE_RETRY_JITTER_RATIO;
  return Math.max(1_000, Math.round(baseMs * (1 + jitter)));
}

function retryDelayMsForFailures(failures: number): number {
  const base = PIPE_RETRY_DELAYS_MS[failures - 1] ?? PIPE_RETRY_CAP_MS;
  return Math.min(PIPE_RETRY_CAP_MS, jitterDelayMs(base));
}

function restartCooldownMsForFailures(failures: number): number {
  return DRM_RESTART_COOLDOWN_MS[failures - 1] ?? DRM_RESTART_COOLDOWN_CAP_MS;
}

function recordRestartCooldown(channelId: string, reason: string): { failures: number; retryAfterAt: number } {
  const current = drmRestartCooldowns.get(channelId);
  const failures = (current?.failures ?? 0) + 1;
  const retryAfterAt = Date.now() + restartCooldownMsForFailures(failures);
  drmRestartCooldowns.set(channelId, { failures, retryAfterAt, lastReason: reason, updatedAt: Date.now() });
  return { failures, retryAfterAt };
}

function clearRestartCooldown(channelId: string): void {
  drmRestartCooldowns.delete(channelId);
}

function getRestartCooldown(channelId: string): { failures: number; retryAfterAt: number; lastReason: string; updatedAt: number } | null {
  const entry = drmRestartCooldowns.get(channelId);
  if (!entry) return null;
  if (entry.retryAfterAt <= Date.now()) return entry;
  return entry;
}

function enforceRestartCooldown(channelId: string): void {
  const cooldown = drmRestartCooldowns.get(channelId);
  if (!cooldown) return;
  const remainingMs = cooldown.retryAfterAt - Date.now();
  if (remainingMs <= 0) return;
  const retryAfterSec = Math.max(1, Math.ceil(remainingMs / 1000));
  throw new RestartCooldownError(
    retryAfterSec,
    `restart cooldown active for ${channelId}; retry after ${retryAfterSec}s (${cooldown.lastReason})`,
  );
}

function responseForError(error: unknown, fallbackStatus = 500, asJson = false): Response {
  if (error instanceof RestartCooldownError) {
    const headers = { "Retry-After": String(error.retryAfterSec) };
    return asJson
      ? Response.json({ error: error.message, retryAfterSec: error.retryAfterSec }, { status: error.status, headers })
      : new Response(error.message, { status: error.status, headers });
  }
  if (error instanceof HttpError) {
    return asJson
      ? Response.json({ error: error.message }, { status: error.status })
      : new Response(error.message, { status: error.status });
  }
  const message = (error as Error).message;
  return asJson
    ? Response.json({ error: message }, { status: fallbackStatus })
    : new Response(message, { status: fallbackStatus });
}

function playbackUnavailableResponse(): Response {
  return new Response("stream temporarily unavailable", {
    status: 503,
    headers: { "Retry-After": "60" },
  });
}

function responseForPlaybackError(error: unknown): Response {
  if (error instanceof RestartCooldownError) return responseForError(error);
  if (isTemporaryStreamRefreshError(error)) return playbackUnavailableResponse();
  return responseForError(error);
}

async function clearDir(dir: string): Promise<void> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      await Deno.remove(`${dir}/${entry.name}`, { recursive: true }).catch(() => {});
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

async function waitForNonEmptyFile(path: string, timeoutMs: number): Promise<void> {
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

async function ensureDir(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
}

async function appendLog(path: string, line: string): Promise<void> {
  await Deno.writeTextFile(path, `${line}\n`, { create: true, append: true });
}

function stateLogPath(state: DrmChannelState, name = "pipeline.log"): string {
  return `${state.dirs.logs}/${name}`;
}

async function logState(state: DrmChannelState, message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(`[shaka ${state.channelId}] ${message}`);
  await appendLog(stateLogPath(state), line).catch(() => {});
}

function resolveStateReady(state: DrmChannelState, playlistPath: string): void {
  if (state.readySettled) return;
  state.readySettled = true;
  state.readyResolve(playlistPath);
}

function rejectStateReady(state: DrmChannelState, error: unknown): void {
  if (state.readySettled) return;
  state.readySettled = true;
  state.readyReject(error);
}

function decodeXmlText(text: string): string {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

function parseXmlAttributes(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([:\w-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    attrs[m[1]] = decodeXmlText(m[2]);
  }
  return attrs;
}

function findXmlBlocks(xml: string, tag: string): Array<{ attrs: Record<string, string>; inner: string }> {
  const blocks: Array<{ attrs: Record<string, string>; inner: string }> = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)(?:>([\\s\\S]*?)<\\/${tag}>|\\/>)`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    blocks.push({ attrs: parseXmlAttributes(m[1]), inner: m[2] ?? "" });
  }
  return blocks;
}

function findXmlText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return m ? decodeXmlText(m[1].trim()) : null;
}

function parseIsoDurationMs(input: string | undefined): number | null {
  if (!input) return null;
  const m = /^P(?:([0-9.]+)D)?(?:T(?:([0-9.]+)H)?(?:([0-9.]+)M)?(?:([0-9.]+)S)?)?$/i.exec(input.trim());
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const mins = Number(m[3] ?? 0);
  const secs = Number(m[4] ?? 0);
  return Math.round((((days * 24) + hours) * 60 + mins) * 60 * 1000 + secs * 1000);
}

function fillTemplate(
  template: string,
  representationId: string,
  bandwidth: number,
  number: number | null,
  time: number | null,
): string {
  return template.replaceAll(/\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g, (_m, token, widthRaw) => {
    const width = Number(widthRaw ?? 0);
    const pad = (value: string) => width > 0 ? value.padStart(width, "0") : value;
    switch (token) {
      case "RepresentationID":
        return representationId;
      case "Bandwidth":
        return pad(String(bandwidth));
      case "Number":
        if (number == null) throw new Error(`template requires $Number$ but no segment number exists for ${representationId}`);
        return pad(String(number));
      case "Time":
        if (time == null) throw new Error(`template requires $Time$ but no segment time exists for ${representationId}`);
        return pad(String(time));
      default:
        return "";
    }
  });
}

function parseSegmentTimeline(inner: string): Array<{ time: number | null; duration: number; repeat: number }> {
  const timeline: Array<{ time: number | null; duration: number; repeat: number }> = [];
  const tlMatch = /<SegmentTimeline\b[^>]*>([\s\S]*?)<\/SegmentTimeline>/i.exec(inner);
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

function parseSegmentTemplate(xml: string): { attrs: Record<string, string>; inner: string } | null {
  const m = /<SegmentTemplate\b([^>]*)(?:\/>|>([\s\S]*?)<\/SegmentTemplate>)/i.exec(xml);
  if (!m) return null;
  return { attrs: parseXmlAttributes(m[1]), inner: m[2] ?? "" };
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
  const timescale = Number(attrs.timescale ?? timescaleFallback) || timescaleFallback || 1;
  const urls: ParsedSegment[] = [];
  const timelineEntries = parseSegmentTimeline(inner);
  const segUrlRe = /<SegmentURL\b([^>]*)\/?>/gi;
  let idx = 0;
  let segUrlMatch: RegExpExecArray | null;
  while ((segUrlMatch = segUrlRe.exec(inner)) !== null) {
    const segAttrs = parseXmlAttributes(segUrlMatch[1]);
    const media = segAttrs.media;
    if (!media) continue;
    const tl = timelineEntries[idx];
    urls.push({
      id: `list-${idx}`,
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
    segments: urls,
  };
}

function buildSegmentsFromTemplate(
  templateAttrs: Record<string, string>,
  templateInner: string,
  representationId: string,
  bandwidth: number,
  baseUrl: string,
  timeShiftBufferDepthMs: number | null,
  periodElapsedMs: number | null,
): { timescale: number; initUrl: string; segments: ParsedSegment[] } | null {
  const initialization = templateAttrs.initialization;
  const media = templateAttrs.media;
  if (!initialization || !media) return null;
  const timescale = Number(templateAttrs.timescale ?? "1") || 1;
  const startNumber = Number(templateAttrs.startNumber ?? "1") || 1;
  const mediaUsesNumber = /\$Number(?:%0\d+d)?\$/.test(media);
  const mediaUsesTime = /\$Time(?:%0\d+d)?\$/.test(media);
  const initUrl = new URL(fillTemplate(initialization, representationId, bandwidth, startNumber, null), baseUrl).toString();
  const timeline = parseSegmentTimeline(templateInner);
  if (timeline.length === 0) {
    const duration = Number(templateAttrs.duration ?? "");
    if (!mediaUsesNumber || !Number.isFinite(duration) || duration <= 0) return null;
    const durationMs = duration / timescale * 1000;
    const segmentCount = timeShiftBufferDepthMs != null
      ? Math.min(PIPE_SEGMENT_WINDOW, Math.max(1, Math.floor(timeShiftBufferDepthMs / durationMs)))
      : PIPE_SEGMENT_WINDOW;
    const liveOffset = periodElapsedMs != null ? Math.max(0, Math.floor(periodElapsedMs / durationMs)) : segmentCount - 1;
    const firstNumber = startNumber + Math.max(0, liveOffset - segmentCount + 1);
    return {
      timescale,
      initUrl,
      segments: Array.from({ length: segmentCount }, (_, index) => {
        const number = firstNumber + index;
        return {
          id: `n-${number}`,
          url: new URL(fillTemplate(media, representationId, bandwidth, number, null), baseUrl).toString(),
          number,
          time: null,
          duration,
        };
      }),
    };
  }
  const segments: ParsedSegment[] = [];
  let segmentNumber = startNumber;
  let currentTime = timeline[0]?.time ?? 0;
  for (const entry of timeline) {
    if (entry.time != null) currentTime = entry.time;
    const repeat = entry.repeat < 0 ? 0 : entry.repeat;
    for (let i = 0; i <= repeat; i++) {
      const number = mediaUsesNumber ? segmentNumber : null;
      const time = currentTime;
      const id = mediaUsesTime ? `t-${time}` : `n-${segmentNumber}`;
      segments.push({
        id,
        url: new URL(fillTemplate(media, representationId, bandwidth, number, time), baseUrl).toString(),
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
  timeShiftBufferDepthMs: number | null,
  periodElapsedMs: number | null,
): ParsedRepresentation | null {
  const repAttrs = representation.attrs;
  const adaptAttrs = adaptation.attrs;
  const representationId = repAttrs.id;
  if (!representationId) return null;
  const bandwidth = Number(repAttrs.bandwidth ?? adaptAttrs.bandwidth ?? "0") || 0;
  const mimeType = repAttrs.mimeType ?? adaptAttrs.mimeType ?? `${kind}/mp4`;
  const codecs = repAttrs.codecs ?? adaptAttrs.codecs ?? "";
  const language = adaptAttrs.lang;
  const repBase = findXmlText(representation.inner, "BaseURL") ?? "";
  const resolvedBase = repBase ? new URL(repBase, baseUrl).toString() : baseUrl;

  const repTemplate = parseSegmentTemplate(representation.inner);
  const adaptTemplate = parseSegmentTemplate(adaptation.inner);
  const mergedTemplateAttrs = { ...(adaptTemplate?.attrs ?? {}), ...(repTemplate?.attrs ?? {}) };
  const templateInner = repTemplate?.inner || adaptTemplate?.inner || "";
  const fromTemplate = Object.keys(mergedTemplateAttrs).length > 0
    ? buildSegmentsFromTemplate(
      mergedTemplateAttrs,
      templateInner,
      representationId,
      bandwidth,
      resolvedBase,
      timeShiftBufferDepthMs,
      periodElapsedMs,
    )
    : null;
  const fromList = fromTemplate ??
    parseSegmentList(
      representation.inner,
      representationId,
      bandwidth,
      resolvedBase,
      Number(mergedTemplateAttrs.timescale ?? "1") || 1,
    ) ??
    parseSegmentList(
      adaptation.inner,
      representationId,
      bandwidth,
      resolvedBase,
      Number(mergedTemplateAttrs.timescale ?? "1") || 1,
    );
  if (!fromList) return null;

  return {
    kind,
    representationId,
    bandwidth,
    codecs,
    mimeType,
    language,
    timescale: fromList.timescale,
    initUrl: fromList.initUrl,
    segments: fromList.segments,
  };
}

function parseMpdXml(xml: string, mpdUrl: string): ParsedMpd {
  const mpdOpen = /<MPD\b([^>]*)>/i.exec(xml);
  const mpdAttrs = mpdOpen ? parseXmlAttributes(mpdOpen[1]) : {};
  const timeShiftBufferDepthMs = parseIsoDurationMs(mpdAttrs.timeShiftBufferDepth);
  const mpdBase = findXmlText(xml, "BaseURL");
  const baseUrl = mpdBase ? new URL(mpdBase, mpdUrl).toString() : mpdUrl;
  const period = findXmlBlocks(xml, "Period")[0];
  if (!period) throw new Error("MPD has no Period");
  const availabilityStartTimeMs = Date.parse(mpdAttrs.availabilityStartTime ?? "");
  const publishTimeMs = Date.parse(mpdAttrs.publishTime ?? "");
  const periodStartMs = parseIsoDurationMs(period.attrs.start) ?? 0;
  const periodElapsedMs = Number.isFinite(availabilityStartTimeMs) && Number.isFinite(publishTimeMs)
    ? Math.max(0, publishTimeMs - availabilityStartTimeMs - periodStartMs)
    : null;
  const periodBase = findXmlText(period.inner, "BaseURL");
  const resolvedPeriodBase = periodBase ? new URL(periodBase, baseUrl).toString() : baseUrl;

  const audio: ParsedRepresentation[] = [];
  const video: ParsedRepresentation[] = [];
  for (const adaptation of findXmlBlocks(period.inner, "AdaptationSet")) {
    const mimeType = adaptation.attrs.mimeType ?? "";
    const contentType = adaptation.attrs.contentType ??
      (mimeType.startsWith("audio/") ? "audio" : mimeType.startsWith("video/") ? "video" : "");
    const kind = contentType === "audio" || contentType === "video" ? contentType : null;
    if (!kind) continue;
    const adaptationBase = findXmlText(adaptation.inner, "BaseURL");
    const resolvedAdaptationBase = adaptationBase ? new URL(adaptationBase, resolvedPeriodBase).toString() : resolvedPeriodBase;
    for (const representation of findXmlBlocks(adaptation.inner, "Representation")) {
      const parsed = resolveRepresentation(
        kind,
        representation,
        adaptation,
        resolvedAdaptationBase,
        timeShiftBufferDepthMs,
        periodElapsedMs,
      );
      if (!parsed || parsed.segments.length === 0) continue;
      (kind === "audio" ? audio : video).push(parsed);
    }
  }

  return {
    minimumUpdatePeriodMs: parseIsoDurationMs(mpdAttrs.minimumUpdatePeriod) ?? PIPE_SYNC_FALLBACK_MS,
    audio,
    video,
  };
}

async function fetchMpdSnapshot(mpdUrl: string): Promise<{ xml: string; parsed: ParsedMpd }> {
  const res = await fetch(mpdUrl, { headers: proxyFetchHeaders() });
  if (!res.ok) throw new HttpError(res.status, `MPD fetch: ${res.status}`);
  const xml = await res.text();
  return { xml, parsed: parseMpdXml(xml, mpdUrl) };
}

function chooseRepresentation(list: ParsedRepresentation[], preferredId?: string): ParsedRepresentation | null {
  if (preferredId) {
    const keep = list.find((item) => item.representationId === preferredId);
    if (keep) return keep;
  }
  return [...list].sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? null;
}

function segmentFileStem(kind: TrackKind, segment: ParsedSegment): string {
  if (segment.number != null) return `${kind}-n${String(segment.number).padStart(8, "0")}`;
  return `${kind}-t${String(segment.time ?? 0).padStart(12, "0")}`;
}

function createTrackRuntime(kind: TrackKind, source: ParsedRepresentation, dirs: ChannelDirs): TrackRuntime {
  return {
    kind,
    source,
    initEncryptedPath: `${dirs.enc}/${kind}-init.mp4.enc`,
    initDecryptedPath: `${dirs.dec}/${kind}-init.mp4`,
    initPrepared: false,
    initWritten: false,
    segments: [],
    sentSegmentIds: new Set<string>(),
  };
}

function mergeTrackRuntime(
  kind: TrackKind,
  current: TrackRuntime | null,
  next: ParsedRepresentation,
  dirs: ChannelDirs,
): TrackRuntime {
  if (!current) return createTrackRuntime(kind, next, dirs);
  if (current.source.representationId !== next.representationId) {
    throw new Error(`${kind} representation changed from ${current.source.representationId} to ${next.representationId}; rebuild required`);
  }
  current.source = next;
  return current;
}

async function downloadToFile(url: string, path: string): Promise<void> {
  const res = await fetch(url, { headers: proxyFetchHeaders() });
  if (!res.ok) throw new HttpError(res.status, `download ${res.status}: ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const tmp = `${path}.tmp`;
  await Deno.writeFile(tmp, bytes);
  await Deno.rename(tmp, path);
}

async function ensureCommandAvailable(command: string, label: string): Promise<void> {
  try {
    await new Deno.Command(command, {
      args: [],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(`${label} not found: configure ${label === "mp4decrypt" ? "VOYO_MP4DECRYPT" : "VOYO_SHAKA_PACKAGER"} or install ${label}`);
    }
    throw e;
  }
}

async function ensureMp4decrypt(): Promise<void> {
  if (mp4decryptChecked) return;
  await ensureCommandAvailable(MP4DECRYPT, "mp4decrypt");
  mp4decryptChecked = true;
}

async function ensureShakaPackager(): Promise<void> {
  if (shakaPackagerChecked) return;
  await ensureCommandAvailable(SHAKA_PACKAGER, "packager");
  shakaPackagerChecked = true;
}

async function ensureCdmHealthy(): Promise<void> {
  if (cdmReachableChecked) return;
  let res: Response;
  try {
    res = await fetch(`${CDM_URL}/health`);
  } catch (e) {
    throw new Error(`CDM sidecar unreachable at ${CDM_URL}: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`CDM sidecar health failed: HTTP ${res.status}`);
  cdmReachableChecked = true;
}

async function decryptFile(
  inputPath: string,
  outputPath: string,
  keys: ContentKey[],
  fragmentsInfoPath?: string,
): Promise<void> {
  const args = keys.flatMap((item) => ["--key", `${item.kid}:${item.key}`]);
  if (fragmentsInfoPath) args.push("--fragments-info", fragmentsInfoPath);
  args.push(inputPath, `${outputPath}.tmp`);
  const out = await new Deno.Command(MP4DECRYPT, {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    const stderr = new TextDecoder().decode(out.stderr).trim();
    throw new Error(`mp4decrypt failed for ${inputPath}: ${stderr || `exit ${out.code}`}`);
  }
  await Deno.rename(`${outputPath}.tmp`, outputPath);
}

async function ensureTrackInitPrepared(state: DrmChannelState, track: TrackRuntime): Promise<void> {
  if (track.initPrepared) return;
  await downloadToFile(track.source.initUrl, track.initEncryptedPath);
  await decryptFile(track.initEncryptedPath, track.initDecryptedPath, state.keys);
  track.initPrepared = true;
  await logState(state, `${track.kind}: prepared init segment`);
}

function isExpiredStreamError(error: unknown): boolean {
  // 404 covers expired signed segment URLs and segments that rolled off the
  // live window between the manifest fetch and the download.
  return error instanceof HttpError &&
    (error.status === 401 || error.status === 403 || error.status === 404);
}

async function refreshDrmState(state: DrmChannelState, force = false): Promise<void> {
  const info = await getStreamInfo(state.channelId, force, state.contentId);
  if (!info.drm) throw new Error("channel is not DRM — use /live/<id>.m3u8");
  const snapshot = await fetchMpdSnapshot(info.url);
  const video = chooseRepresentation(snapshot.parsed.video, state.video?.source.representationId);
  const audio = chooseRepresentation(snapshot.parsed.audio, state.audio?.source.representationId);
  if (!video || !audio) throw new Error("MPD did not expose both audio and video representations");
  state.streamInfo = info;
  state.manifest = snapshot.parsed;
  state.manifestXml = snapshot.xml;
  state.video = mergeTrackRuntime("video", state.video, video, state.dirs);
  state.audio = mergeTrackRuntime("audio", state.audio, audio, state.dirs);
  state.syncIntervalMs = Math.max(1_000, snapshot.parsed.minimumUpdatePeriodMs);
  state.lastRefreshAt = Date.now();
}

async function syncTrackSegments(state: DrmChannelState, track: TrackRuntime): Promise<boolean> {
  await ensureTrackInitPrepared(state, track);
  const desired = track.source.segments.slice(-PIPE_SEGMENT_WINDOW);
  const keepIds = new Set(track.source.segments.slice(-PIPE_SEGMENT_RETENTION).map((segment) => segment.id));
  const knownIds = new Set(track.segments.map((segment) => segment.id));
  let madeProgress = false;

  for (const segment of desired) {
    if (knownIds.has(segment.id)) continue;
    const stem = segmentFileStem(track.kind, segment);
    const encryptedPath = `${state.dirs.enc}/${stem}.m4s.enc`;
    const decryptedPath = `${state.dirs.dec}/${stem}.m4s`;
    await downloadToFile(segment.url, encryptedPath);
    await decryptFile(encryptedPath, decryptedPath, state.keys, track.initEncryptedPath);
    track.segments.push({
      ...segment,
      encryptedPath,
      decryptedPath,
      downloadedAt: Date.now(),
      writtenAt: null,
    });
    knownIds.add(segment.id);
    state.lastProgressAt = Date.now();
    madeProgress = true;
  }

  const order = new Map(track.source.segments.map((segment, index) => [segment.id, index]));
  const survivors: LocalSegment[] = [];
  for (const segment of track.segments) {
    if (keepIds.has(segment.id) || segment.writtenAt === null) {
      survivors.push(segment);
      continue;
    }
    await Deno.remove(segment.encryptedPath).catch(() => {});
    await Deno.remove(segment.decryptedPath).catch(() => {});
  }
  survivors.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  track.segments = survivors;
  return madeProgress;
}

async function writeFileToWriter(path: string, writer: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
  const bytes = await Deno.readFile(path);
  await writer.write(bytes);
}

async function feedTrack(state: DrmChannelState, track: TrackRuntime, writer: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
  if (!track.initPrepared) throw new Error(`${track.kind} init not prepared`);
  if (!track.initWritten) {
    await writeFileToWriter(track.initDecryptedPath, writer);
    track.initWritten = true;
    await logState(state, `${track.kind}: wrote init to pipe`);
  }

  const order = new Map(track.source.segments.map((segment, index) => [segment.id, index]));
  const pending = track.segments
    .filter((segment) => !track.sentSegmentIds.has(segment.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  for (const segment of pending) {
    await writeFileToWriter(segment.decryptedPath, writer);
    track.sentSegmentIds.add(segment.id);
    segment.writtenAt = Date.now();
  }
}

async function createNamedPipe(path: string): Promise<void> {
  await Deno.remove(path).catch(() => {});
  const out = await new Deno.Command("mkfifo", {
    args: [path],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    const stderr = new TextDecoder().decode(out.stderr).trim();
    throw new Error(`mkfifo failed for ${path}: ${stderr || `exit ${out.code}`}`);
  }
}

async function pipeStreamToLog(stream: ReadableStream<Uint8Array> | null, path: string): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) await Deno.writeTextFile(path, decoder.decode(value, { stream: true }), { create: true, append: true });
    }
    const tail = decoder.decode();
    if (tail) await Deno.writeTextFile(path, tail, { create: true, append: true });
  } finally {
    reader.releaseLock();
  }
}

function buildPackagerArgs(state: DrmChannelState): string[] {
  if (!state.audio || !state.video) throw new Error("packager started before tracks were resolved");
  const audioName = (state.audio.source.language ?? "audio").replaceAll(",", "_");
  return [
    `in=${state.pipePaths.audio},stream=audio,init_segment=audio/init.mp4,segment_template=audio/$Number$.m4s,playlist_name=audio.m3u8,hls_group_id=audio,hls_name=${audioName},bw=${Math.max(1, state.audio.source.bandwidth)}`,
    `in=${state.pipePaths.video},stream=video,init_segment=video/init.mp4,segment_template=video/$Number$.m4s,playlist_name=video.m3u8,bw=${Math.max(1, state.video.source.bandwidth)}`,
    "--hls_master_playlist_output",
    "index.m3u8",
    "--hls_playlist_type",
    "LIVE",
    "--segment_duration",
    String(SHAKA_SEGMENT_DURATION),
    "--fragment_duration",
    String(SHAKA_SEGMENT_DURATION),
    "--time_shift_buffer_depth",
    String(SHAKA_LIVE_WINDOW),
    "--preserved_segments_outside_live_window",
    String(SHAKA_PRESERVED_SEGMENTS),
  ];
}

async function startPackager(state: DrmChannelState): Promise<void> {
  await ensureDir(`${state.dirs.out}/audio`);
  await ensureDir(`${state.dirs.out}/video`);
  await createNamedPipe(state.pipePaths.audio);
  await createNamedPipe(state.pipePaths.video);

  const process = new Deno.Command(SHAKA_PACKAGER, {
    args: buildPackagerArgs(state),
    cwd: state.dirs.out,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const stdoutPath = stateLogPath(state, "packager.stdout.log");
  const stderrPath = stateLogPath(state, "packager.stderr.log");
  state.packager = {
    process,
    status: process.status,
    stdoutTask: pipeStreamToLog(process.stdout, stdoutPath),
    stderrTask: pipeStreamToLog(process.stderr, stderrPath),
  };

  state.audioPipeFile = await Deno.open(state.pipePaths.audio, { write: true });
  state.videoPipeFile = await Deno.open(state.pipePaths.video, { write: true });
  state.audioWriter = state.audioPipeFile.writable.getWriter();
  state.videoWriter = state.videoPipeFile.writable.getWriter();
  await logState(state, `started Shaka Packager: ${SHAKA_PACKAGER}`);

  void state.packager.status.then(async (status) => {
    if (state.stopRequested || state.closed) return;
    const message = `packager exited with code ${status.code}`;
    state.lastError = message;
    await logState(state, message);
    rejectStateReady(state, new Error(message));
  });
}

function outputPathFor(state: DrmChannelState, relativePath: string): string | null {
  const clean = relativePath.split("/").filter(Boolean);
  if (clean.length === 0) return null;
  if (clean.some((part) => part === "." || part === "..")) return null;
  return `${state.dirs.out}/${clean.join("/")}`;
}

async function runSyncCycle(state: DrmChannelState, forceRefresh: boolean): Promise<boolean> {
  await refreshDrmState(state, forceRefresh);
  if (!state.audio || !state.video || !state.audioWriter || !state.videoWriter) {
    throw new Error("DRM state is not fully initialized");
  }
  const audioProgress = await syncTrackSegments(state, state.audio);
  const videoProgress = await syncTrackSegments(state, state.video);
  await feedTrack(state, state.audio, state.audioWriter);
  await feedTrack(state, state.video, state.videoWriter);
  return audioProgress || videoProgress;
}

async function syncDrmStateOnce(state: DrmChannelState): Promise<boolean> {
  try {
    return await runSyncCycle(state, false);
  } catch (error) {
    if (!isExpiredStreamError(error)) throw error;
    const status = (error as HttpError).status;
    await logState(state, `upstream ${status}; force-refreshing stream info and retrying sync once`);
    return await runSyncCycle(state, true);
  }
}

async function disposeState(state: DrmChannelState, reason: string, cleanupDir = true): Promise<void> {
  if (state.closed) return;
  state.closed = true;
  state.stopRequested = true;
  state.downloadLoopState = "stopped";
  await logState(state, `stopping: ${reason}`);
  rejectStateReady(state, new Error(reason));
  drmStates.delete(state.channelId);

  try {
    await state.audioWriter?.close();
  } catch {}
  try {
    await state.videoWriter?.close();
  } catch {}
  try {
    state.audioPipeFile?.close();
  } catch {}
  try {
    state.videoPipeFile?.close();
  } catch {}

  try {
    state.packager?.process.kill("SIGTERM");
  } catch {}
  try {
    await state.packager?.status;
  } catch {}

  if (cleanupDir) await Deno.remove(state.workDir, { recursive: true }).catch(() => {});
}

async function disposeAllDrmStates(reason: string, cleanupDir = true): Promise<void> {
  const states = [...drmStates.values()];
  await Promise.all(states.map((state) => disposeState(state, reason, cleanupDir).catch(() => {})));
}

async function runDrmLoop(state: DrmChannelState): Promise<void> {
  while (!state.stopRequested) {
    state.lastAttemptAt = Date.now();
    try {
      state.downloadLoopState = "running";
      const madeProgress = await syncDrmStateOnce(state);
      state.consecutiveFailures = 0;
      state.lastError = null;
      state.nextRetryDelayMs = state.syncIntervalMs;
      clearRestartCooldown(state.channelId);
      const playlistPath = outputPathFor(state, "index.m3u8");
      if (playlistPath && !state.readySettled && await exists(playlistPath)) {
        resolveStateReady(state, playlistPath);
      }
      if (!madeProgress && Date.now() - state.lastProgressAt > PIPE_NO_PROGRESS_MS) {
        recordRestartCooldown(state.channelId, `no upstream progress for ${Math.round(PIPE_NO_PROGRESS_MS / 1000)}s`);
        await disposeState(state, `no upstream progress for ${Math.round(PIPE_NO_PROGRESS_MS / 1000)}s`);
        return;
      }
    } catch (e) {
      state.downloadLoopState = "error";
      state.lastError = (e as Error).message;
      await logState(state, `sync failed: ${state.lastError}`);
      if (!state.readySettled) {
        recordRestartCooldown(state.channelId, state.lastError);
        await disposeState(state, state.lastError);
        return;
      }
      if (/rebuild required|packager exited|Broken pipe|closed/i.test(state.lastError)) {
        recordRestartCooldown(state.channelId, state.lastError);
        await disposeState(state, state.lastError);
        return;
      }
      if (Date.now() - state.lastProgressAt > PIPE_NO_PROGRESS_MS) {
        recordRestartCooldown(state.channelId, `no upstream progress for ${Math.round(PIPE_NO_PROGRESS_MS / 1000)}s`);
        await disposeState(state, `no upstream progress for ${Math.round(PIPE_NO_PROGRESS_MS / 1000)}s`);
        return;
      }
      state.consecutiveFailures += 1;
      state.nextRetryDelayMs = retryDelayMsForFailures(state.consecutiveFailures);
      await logState(state, `retrying in ${state.nextRetryDelayMs}ms after failure ${state.consecutiveFailures}`);
      await sleep(state.nextRetryDelayMs);
      continue;
    }
    await sleep(state.syncIntervalMs);
  }
}

async function startDrmState(channel: Pick<Channel, "id" | "contentId"> | string): Promise<DrmChannelState> {
  await ensureMp4decrypt();
  await ensureShakaPackager();
  await ensureCdmHealthy();
  const entry = typeof channel === "string" ? resolveRequestedChannel(channel) : channel;
  const channelId = typeof channel === "string" ? entry?.id ?? channel : channel.id;
  const resolvedContentId = contentIdFor(entry ?? channelId);

  const workDir = `${LIVE_DIR}/${channelId}`;
  const dirs: ChannelDirs = {
    enc: `${workDir}/enc`,
    dec: `${workDir}/dec`,
    pipes: `${workDir}/pipes`,
    out: `${workDir}/out`,
    logs: `${workDir}/logs`,
  };
  await ensureDir(workDir);
  await clearDir(workDir);
  await Promise.all([ensureDir(dirs.enc), ensureDir(dirs.dec), ensureDir(dirs.pipes), ensureDir(dirs.out), ensureDir(dirs.logs)]);
  let keys: ContentKey[];
  try {
    keys = await getKeys(channelId, false, resolvedContentId);
  } catch (e) {
    recordRestartCooldown(channelId, (e as Error).message);
    throw e;
  }

  const ready = deferred<string>();
  void ready.promise.catch(() => {});
  const state: DrmChannelState = {
    channelId,
    contentId: resolvedContentId,
    workDir,
    dirs,
    pipePaths: { audio: `${dirs.pipes}/audio.pipe`, video: `${dirs.pipes}/video.pipe` },
    ready: ready.promise,
    readyResolve: ready.resolve,
    readyReject: ready.reject,
    readySettled: false,
    lastAccess: Date.now(),
    createdAt: Date.now(),
    lastRefreshAt: 0,
    lastError: null,
    stopRequested: false,
    closed: false,
    streamInfo: null,
    keys,
    audio: null,
    video: null,
    manifest: null,
    manifestXml: null,
    syncIntervalMs: PIPE_SYNC_FALLBACK_MS,
    consecutiveFailures: 0,
    lastProgressAt: Date.now(),
    lastAttemptAt: 0,
    nextRetryDelayMs: PIPE_SYNC_FALLBACK_MS,
    downloadLoopState: "starting",
    loop: null,
    packager: null,
    audioPipeFile: null,
    videoPipeFile: null,
    audioWriter: null,
    videoWriter: null,
  };
  drmStates.set(channelId, state);

  try {
    await logState(state, "starting DRM pipeline");
    await refreshDrmState(state);
    await startPackager(state);
    state.lastAttemptAt = Date.now();
    await syncDrmStateOnce(state);
    state.lastError = null;
    state.nextRetryDelayMs = state.syncIntervalMs;
    clearRestartCooldown(channelId);
    await waitForNonEmptyFile(`${state.dirs.out}/index.m3u8`, PLAYLIST_WAIT_TIMEOUT_MS);
    resolveStateReady(state, `${state.dirs.out}/index.m3u8`);
    state.loop = runDrmLoop(state);
    return state;
  } catch (e) {
    recordRestartCooldown(channelId, (e as Error).message);
    await disposeState(state, (e as Error).message);
    throw e;
  }
}

async function ensureDrmState(channelId: string): Promise<DrmChannelState> {
  const entry = resolveRequestedChannel(channelId);
  const resolvedId = entry?.id ?? channelId;
  enforceRestartCooldown(resolvedId);
  const existing = drmStates.get(resolvedId);
  if (existing) {
    existing.lastAccess = Date.now();
    await existing.ready;
    return existing;
  }
  const pending = drmStateStarts.get(resolvedId);
  if (pending) {
    const state = await pending;
    state.lastAccess = Date.now();
    return state;
  }
  const startPromise = startDrmState(entry ?? channelId);
  drmStateStarts.set(resolvedId, startPromise);
  try {
    const state = await startPromise;
    state.lastAccess = Date.now();
    return state;
  } finally {
    drmStateStarts.delete(resolvedId);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, state] of drmStates) {
    if (now - state.lastAccess > PIPE_IDLE_MS) {
      void disposeState(state, `idle ${Math.round((now - state.lastAccess) / 1000)}s`, true).catch(() => {
        drmStates.delete(id);
      });
    }
  }
}, 15_000);

async function collectFiles(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) out.push(...await collectFiles(`${root}/${entry.name}`, rel));
      else out.push(rel);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return out.sort();
}

function mimeTypeFor(path: string): string {
  if (path.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (path.endsWith(".mpd")) return "application/dash+xml";
  if (path.endsWith(".m4s") || path.endsWith(".mp4")) return "video/mp4";
  if (path.endsWith(".ts")) return "video/mp2t";
  if (path.endsWith(".log")) return "text/plain; charset=utf-8";
  if (path.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function serveDrmOutputFile(channelId: string, relativePath: string): Promise<Response> {
  const state = drmStates.get(channelId);
  if (state) state.lastAccess = Date.now();
  const baseState = state ?? {
    dirs: { out: `${LIVE_DIR}/${channelId}/out` },
  } as DrmChannelState;
  const path = outputPathFor(baseState, relativePath);
  if (!path) return new Response("bad path", { status: 400 });
  try {
    const file = await Deno.open(path, { read: true });
    return new Response(file.readable, {
      headers: { "Content-Type": mimeTypeFor(relativePath), "Cache-Control": "no-store" },
    });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return new Response("not found", { status: 404 });
    throw e;
  }
}

// === Config store with mutex ===
let writeLock: Promise<unknown> = Promise.resolve();
let config: Config;

const emptyConfig: Config = {
  credentials: { username: "", password: "" },
  session: { token: null, uuid: null, issuedAt: null },
  channels: [],
  manualEvents: [],
  channelsUpdatedAt: null,
};

function normalizeConfig(data: Partial<Config>): Config {
  const normalizeChannel = (entry: Partial<Channel>, fallbackKind?: "channel" | "event"): Channel => {
    const kind = entry.kind ?? fallbackKind;
    const contentId = entry.contentId ?? (kind === "event" && entry.id ? inferEventContentId(entry.id) : null);
    const id = kind === "event" && contentId ? publicContentRouteId(contentId) : (entry.id ?? "");
    return {
      id,
      contentId,
      name: entry.name ?? "",
      img: entry.img ?? "",
      slug: entry.slug ?? slugify(entry.name ?? id),
      kind,
      sourceUrl: entry.sourceUrl ?? null,
      streamKind: entry.streamKind ?? "unknown",
      lastCheckedAt: entry.lastCheckedAt ?? null,
      lastError: entry.lastError ?? null,
    };
  };
  return {
    ...emptyConfig,
    ...data,
    credentials: {
      username: data.credentials?.username ?? emptyConfig.credentials.username,
      password: data.credentials?.password ?? emptyConfig.credentials.password,
    },
    session: {
      token: data.session?.token ?? emptyConfig.session.token,
      uuid: data.session?.uuid ?? emptyConfig.session.uuid,
      issuedAt: data.session?.issuedAt ?? emptyConfig.session.issuedAt,
    },
    channels: Array.isArray(data.channels) ? data.channels.map((entry) => normalizeChannel(entry, "channel")) : [],
    manualEvents: Array.isArray(data.manualEvents) ? data.manualEvents.map((entry) => normalizeChannel(entry, "event")) : [],
    channelsUpdatedAt: data.channelsUpdatedAt ?? null,
  };
}

function migrateFromV1(data: { auth?: { username?: string; password?: string } }): Config {
  return {
    ...emptyConfig,
    credentials: { username: data.auth?.username ?? "", password: data.auth?.password ?? "" },
  };
}

async function loadConfig(): Promise<{ config: Config; mutated: boolean }> {
  try {
    const data = JSON.parse(await Deno.readTextFile(CONFIG_PATH));
    if (data.credentials) {
      const normalized = normalizeConfig(data);
      const mutated = JSON.stringify(normalized) !== JSON.stringify(data);
      return { config: normalized, mutated };
    }
    if (data.auth?.username) {
      console.log(`[config] migrating v1-shaped ${CONFIG_PATH} → v2`);
      return { config: migrateFromV1(data), mutated: true };
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  try {
    const legacy = JSON.parse(await Deno.readTextFile(LEGACY_CONFIG_PATH));
    if (legacy.auth?.username) {
      console.log(`[config] migrating credentials from ${LEGACY_CONFIG_PATH}`);
      return { config: migrateFromV1(legacy), mutated: true };
    }
  } catch { /* no legacy */ }
  console.log(`[config] creating empty ${CONFIG_PATH}`);
  return { config: structuredClone(emptyConfig), mutated: true };
}

function saveConfig(): Promise<void> {
  const snapshot = JSON.stringify(config, null, 2);
  writeLock = writeLock.then(async () => {
    const tmp = `${CONFIG_PATH}.tmp`;
    await Deno.writeTextFile(tmp, snapshot);
    await Deno.rename(tmp, CONFIG_PATH);
  });
  return writeLock as Promise<void>;
}

// === Auth refresh (lazy + on 401 retry) ===
async function ensureAuth(force = false): Promise<{ token: string; uuid: string }> {
  const issued = config.session.issuedAt ? new Date(config.session.issuedAt).getTime() : 0;
  const fresh = !force && config.session.token && config.session.uuid && Date.now() - issued < AUTH_REFRESH_MS;
  if (fresh) return { token: config.session.token!, uuid: config.session.uuid! };
  if (!config.credentials.username || !config.credentials.password) {
    throw new Error("missing credentials in config.json");
  }
  console.log("[auth] logging in…");
  const { token, uuid } = await login(config.credentials);
  config.session = { token, uuid, issuedAt: new Date().toISOString() };
  await saveConfig();
  return { token, uuid };
}

async function withAuth<T>(fn: (token: string, uuid: string) => Promise<T>): Promise<T> {
  let { token, uuid } = await ensureAuth();
  try {
    return await fn(token, uuid);
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      console.log("[auth] 401 — refreshing");
      ({ token, uuid } = await ensureAuth(true));
      return await fn(token, uuid);
    }
    throw e;
  }
}

async function getChannels(force = false): Promise<Channel[]> {
  const stale = !config.channelsUpdatedAt ||
    Date.now() - new Date(config.channelsUpdatedAt).getTime() > CHANNELS_REFRESH_MS;
  if (force || stale || config.channels.length === 0) {
    const list = await withAuth((t, u) => listChannels(t, u));
    config.channels = list;
    config.channelsUpdatedAt = new Date().toISOString();
    await saveConfig();
  }
  return getEntries(force);
}

function allEntries(): Channel[] {
  return [...config.manualEvents, ...config.channels];
}

async function refreshManualEvents(force = false): Promise<void> {
  let mutated = false;
  for (const entry of config.manualEvents) {
    const resolvedContentId = contentIdFor(entry);
    if (entry.contentId !== resolvedContentId) {
      entry.contentId = resolvedContentId;
      mutated = true;
    }
    const checkedAt = entry.lastCheckedAt ? new Date(entry.lastCheckedAt).getTime() : 0;
    const stale = !checkedAt || (Date.now() - checkedAt > 5 * 60 * 1000);
    if (!force && !stale) continue;
    const probed = await probeStreamKind(entry.id, resolvedContentId);
    if (entry.streamKind !== probed.streamKind || entry.lastError !== probed.lastError || force) {
      entry.streamKind = probed.streamKind;
      entry.lastError = probed.lastError;
      entry.lastCheckedAt = new Date().toISOString();
      mutated = true;
    }
  }
  if (mutated) await saveConfig();
}

async function getEntries(force = false): Promise<Channel[]> {
  if (config.manualEvents.length > 0) await refreshManualEvents(force);
  return allEntries();
}

async function addManualEvent(value: string): Promise<Channel> {
  const parsed = parseManualEventInput(value);
  const parsedContentId = contentIdFor(parsed);
  const existing = config.manualEvents.find((entry) =>
    entry.id === parsed.id ||
    contentIdFor(entry) === parsedContentId ||
    contentRouteAliases(entry).includes(parsed.id)
  );
  const base = existing ?? parsed;
  base.contentId = parsed.contentId ?? base.contentId ?? inferEventContentId(base.id);
  if (parsed.sourceUrl) base.sourceUrl = parsed.sourceUrl;
  if (parsed.slug) base.slug = parsed.slug;
  if (!existing || !existing.name || /^Event \d+$/.test(existing.name)) {
    base.name = parsed.name;
  }
  if (base.sourceUrl) {
    try {
      const meta = await fetchPublicPageMeta(base.sourceUrl);
      if (meta.name) base.name = meta.name;
      if (meta.img) base.img = meta.img;
    } catch {
      // Public metadata is only a best-effort enhancement.
    }
  }
  const probed = await probeStreamKind(base.id, contentIdFor(base));
  base.streamKind = probed.streamKind;
  base.lastError = probed.lastError;
  base.lastCheckedAt = new Date().toISOString();
  base.kind = "event";
  if (!existing) config.manualEvents.unshift(base);
  await saveConfig();
  return base;
}

async function removeManualEvent(requested: string): Promise<boolean> {
  const normalizedRequested = normalizeTypedContentId(requested);
  const existing = config.manualEvents.find((entry) =>
    entry.id === requested ||
    entry.slug === requested ||
    contentRouteAliases(entry).includes(requested) ||
    (!!normalizedRequested && contentIdFor(entry) === normalizedRequested)
  );
  if (!existing) return false;
  config.manualEvents = config.manualEvents.filter((entry) => entry.id !== existing.id);
  streamCache.delete(existing.id);
  keyCache.delete(existing.id);
  clearRestartCooldown(existing.id);
  const state = drmStates.get(existing.id);
  if (state) await disposeState(state, "manual event removed");
  await saveConfig();
  return true;
}

// === HLS rewriting ===
function isM3u8(url: string, contentType: string | null): boolean {
  if (contentType?.includes("mpegurl")) return true;
  return /\.m3u8(\?|$)/i.test(url);
}

function isDashManifest(url: string, contentType: string | null): boolean {
  if (contentType?.includes("dash+xml") || contentType?.includes("application/xml") || contentType?.includes("text/xml")) {
    return true;
  }
  return /\.mpd(\?|$)/i.test(url);
}

function rewritePlaylist(body: string, baseUrl: string, proxyOrigin = ""): string {
  const proxyBase = `${proxyOrigin}/proxy?url=`;
  const proxy = (abs: string) => `${proxyBase}${encodeURIComponent(abs)}`;
  return body.split(/\r?\n/).map((line) => {
    if (!line) return line;
    if (line.startsWith("#")) {
      // rewrite URI="..." attributes inside tags (keys, maps, etc.)
      return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${proxy(new URL(u, baseUrl).toString())}"`);
    }
    return proxy(new URL(line, baseUrl).toString());
  }).join("\n");
}

function rewriteDashManifest(xml: string, baseUrl: string): string {
  let rewritten = xml.replace(/<BaseURL>([\s\S]*?)<\/BaseURL>/gi, (_m, value) => {
    const trimmed = String(value).trim();
    if (!trimmed) return "<BaseURL></BaseURL>";
    return `<BaseURL>${new URL(trimmed, baseUrl).toString()}</BaseURL>`;
  });
  rewritten = rewritten.replace(/\b(initialization|media|sourceURL|index)="([^"]+)"/g, (_m, attr, value) => {
    if (!value || value.startsWith("data:") || value.startsWith("urn:")) return `${attr}="${value}"`;
    return `${attr}="${new URL(value, baseUrl).toString()}"`;
  });
  return rewritten;
}

function entryLikelyDrm(entry: Channel): boolean {
  if (entry.streamKind === "drm") return true;
  if (entry.streamKind === "hls") return false;
  if (entry.kind === "event") return true;
  return /drm|cetin|widevine/i.test(entry.name);
}

function proxyFetchHeaders(req?: Request): HeadersInit {
  const stableUa =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
  const headers: Record<string, string> = {
    // Upstream HLS edges vary responses by client context. Deno's default UA can produce
    // unusable child playlists, while embedded-browser UAs (Electron/VS Code) can be rejected.
    // Use a stable desktop Chrome UA for all upstream media fetches.
    "User-Agent": stableUa,
    "Accept": "*/*",
  };
  const range = req?.headers.get("range");
  if (range) headers["Range"] = range;
  return headers;
}

async function buildLivePlaylistFromInfo(
  channelId: string,
  proxyOrigin: string,
  info: StreamInfo,
): Promise<Response> {
  if (info.isDrm) {
    return new Response(
      `channel ${channelId} is DRM (DASH+Widevine); open /play/${channelId} in Chrome instead`,
      { status: 415 },
    );
  }
  const masterRes = await fetch(info.url, { headers: proxyFetchHeaders() });
  if (!masterRes.ok) return new Response(`upstream ${masterRes.status}`, { status: masterRes.status });
  const masterBody = await masterRes.text();
  if (!masterBody.trimStart().startsWith("#EXTM3U")) {
    return new Response(`upstream is not HLS (got ${masterBody.slice(0, 40)}…)`, { status: 415 });
  }

  let baseUrl = info.url;
  let body = masterBody;

  if (/#EXT-X-STREAM-INF/i.test(masterBody)) {
    const lines = masterBody.split(/\r?\n/);
    let best: { bw: number; uri: string } | null = null;
    for (let i = 0; i < lines.length; i++) {
      const m = /#EXT-X-STREAM-INF.*?BANDWIDTH=(\d+)/i.exec(lines[i]);
      if (!m) continue;
      const uri = (lines[i + 1] ?? "").trim();
      if (!uri || uri.startsWith("#")) continue;
      const bw = Number(m[1]);
      if (!best || bw > best.bw) best = { bw, uri };
    }
    if (best) {
      baseUrl = new URL(best.uri, info.url).toString();
      const varRes = await fetch(baseUrl, { headers: proxyFetchHeaders() });
      if (!varRes.ok) return new Response(`variant ${varRes.status}`, { status: varRes.status });
      body = await varRes.text();
    }
  }

  return new Response(rewritePlaylist(body, baseUrl, proxyOrigin), {
    headers: { "Content-Type": "application/vnd.apple.mpegurl" },
  });
}

function isRejectedHlsResponse(response: Response): boolean {
  return response.status === 401 || response.status === 403;
}

async function buildLivePlaylist(channelId: string, proxyOrigin: string): Promise<Response> {
  const entry = resolveRequestedChannel(channelId);
  const cacheKey = entry?.id ?? channelId;
  const contentId = contentIdFor(entry ?? channelId);
  let info = await getStreamInfo(cacheKey, false, contentId);
  let response = await buildLivePlaylistFromInfo(channelId, proxyOrigin, info);
  if (!isRejectedHlsResponse(response)) return response;

  console.warn(`[hls] cached stream rejected for ${cacheKey} with ${response.status}; refreshing once`);
  try {
    info = await getStreamInfo(cacheKey, true, contentId);
  } catch (error) {
    console.error(`[hls] forced refresh failed for ${cacheKey}:`, (error as Error).message);
    return playbackUnavailableResponse();
  }

  response = await buildLivePlaylistFromInfo(channelId, proxyOrigin, info);
  if (!isRejectedHlsResponse(response)) return response;

  console.error(`[hls] refreshed stream rejected for ${cacheKey} with ${response.status}`);
  return playbackUnavailableResponse();
}

function findChannel(requested: string): Channel | undefined {
  const decodedRequested = decodeURIComponent(requested);
  const normalizedRequested = normalizeRequestedContentKey(decodedRequested);
  return allEntries().find((channel) =>
    channel.id === decodedRequested ||
    channel.slug === decodedRequested ||
    publicRoutePathFor(channel) === decodedRequested ||
    contentRouteAliases(channel).includes(decodedRequested) ||
    (!!normalizedRequested && contentIdFor(channel) === normalizedRequested)
  );
}

function resolveRequestedChannel(requested: string): Channel | undefined {
  const existing = findChannel(requested);
  if (existing) return existing;

  const decodedRequested = decodeURIComponent(requested).trim();
  const normalizedRequested = normalizeRequestedContentKey(decodedRequested);
  const transientValue = normalizeTypedContentId(normalizedRequested) ?? (/^\d+$/.test(decodedRequested) ? decodedRequested : null);
  if (transientValue) {
    try {
      return parseManualEventInput(transientValue);
    } catch {
      // Fall through to URL parsing.
    }
  }

  try {
    return parseManualEventInput(decodedRequested);
  } catch {
    return undefined;
  }
}

function serializeTrackState(track: TrackRuntime | null) {
  if (!track) return null;
  return {
    kind: track.kind,
    representationId: track.source.representationId,
    bandwidth: track.source.bandwidth,
    codecs: track.source.codecs,
    mimeType: track.source.mimeType,
    language: track.source.language ?? null,
    timescale: track.source.timescale,
    initUrl: track.source.initUrl,
    initPrepared: track.initPrepared,
    initWritten: track.initWritten,
    queuedSegments: track.segments.length,
    sentSegments: track.sentSegmentIds.size,
    latestSegmentIds: track.segments.slice(-5).map((segment) => segment.id),
  };
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

// === Routing ===
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;
  const host = req.headers.get("host") ?? `localhost:${PORT}`;

  if (isUiProtectedRoute(path, method)) {
    const authResponse = requireBasicAuth(req);
    if (authResponse) return authResponse;
  }

  if (method === "GET" && path === "/") {
    return new Response(INDEX_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (method === "GET" && path === "/api/channels") {
    try {
      const channels = await getChannels(url.searchParams.get("force") === "1");
      return Response.json({ channels, updatedAt: config.channelsUpdatedAt });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  if (method === "POST" && path === "/api/login") {
    try {
      await ensureAuth(true);
      return Response.json({ ok: true, issuedAt: config.session.issuedAt });
    } catch (e) {
      return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  }

  if (method === "POST" && path === "/api/events") {
    try {
      const body = await req.json().catch(() => ({})) as { value?: string };
      const entry = await addManualEvent(body.value ?? "");
      return Response.json({ ok: true, entry });
    } catch (e) {
      return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
    }
  }

  if (method === "DELETE" && path.startsWith("/api/events/")) {
    const requested = decodeURIComponent(path.slice("/api/events/".length));
    try {
      const removed = await removeManualEvent(requested);
      if (!removed) return Response.json({ ok: false, error: `unknown event: ${requested}` }, { status: 404 });
      return Response.json({ ok: true });
    } catch (e) {
      return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
    }
  }

  if (method === "GET" && path === "/live.m3u8") {
    // mode=hls   → only non-DRM (legacy default, safest for VLC if CDM is offline)
    // mode=all   → DRM channels too, via /vlc/<id>/index.m3u8 (needs cdm.py running)
    // mode=vlc   → alias for "all"
    try {
      const mode = url.searchParams.get("mode") ?? "all";
      const includeDrm = mode === "all" || mode === "vlc";
      const channels = await getChannels();
      const lines = ["#EXTM3U"];
      for (const ch of channels) {
        const routePath = publicRoutePathFor(ch);
        const target = entryLikelyDrm(ch)
          ? (includeDrm ? `http://${host}/vlc/${routePath}/index.m3u8` : null)
          : `http://${host}/live/${routePath}.m3u8`;
        if (!target) continue;
        lines.push(`#EXTINF:-1 tvg-id="${ch.id}" tvg-logo="${ch.img}" group-title="Voyo",${ch.name}`);
        lines.push(target);
      }
      return new Response(lines.join("\n") + "\n", {
        headers: { "Content-Type": "application/vnd.apple.mpegurl" },
      });
    } catch (e) {
      return new Response((e as Error).message, { status: 500 });
    }
  }

  if (method === "GET" && path.startsWith("/live/") && path.endsWith(".m3u8")) {
    const requested = decodeURIComponent(path.slice("/live/".length, -".m3u8".length));
    try {
      await getChannels();
      const ch = resolveRequestedChannel(requested);
      if (!ch) return new Response(`unknown channel: ${requested}`, { status: 404 });
      return await buildLivePlaylist(ch.id, url.origin);
    } catch (e) {
      console.error(`[live] ${requested}:`, (e as Error).message);
      return responseForPlaybackError(e);
    }
  }

  // Debug: hex content keys from CDM sidecar. ?force=1 bypasses the cache.
  if (method === "GET" && path.startsWith("/api/keys/")) {
    const requested = decodeURIComponent(path.slice("/api/keys/".length));
    try {
      await getChannels();
      const ch = resolveRequestedChannel(requested);
      if (!ch) return Response.json({ error: `unknown channel: ${requested}` }, { status: 404 });
      const keys = await getKeys(ch.id, url.searchParams.get("force") === "1", contentIdFor(ch));
      return Response.json(keys);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  if (method === "GET" && path.startsWith("/api/drm-state/")) {
    const requested = decodeURIComponent(path.slice("/api/drm-state/".length));
    try {
      await getChannels();
      const ch = resolveRequestedChannel(requested);
      if (!ch) return Response.json({ error: `unknown channel: ${requested}` }, { status: 404 });
      if (url.searchParams.get("ensure") === "1") await ensureDrmState(ch.id);
      const state = drmStates.get(ch.id);
      const restartCooldown = getRestartCooldown(ch.id);
      return Response.json({
        active: !!state,
        restartCooldown: restartCooldown
          ? {
            failures: restartCooldown.failures,
            retryAfterAt: new Date(restartCooldown.retryAfterAt).toISOString(),
            retryAfterSec: Math.max(0, Math.ceil((restartCooldown.retryAfterAt - Date.now()) / 1000)),
            lastReason: restartCooldown.lastReason,
            updatedAt: new Date(restartCooldown.updatedAt).toISOString(),
          }
          : null,
        state: state
          ? {
            channelId: state.channelId,
            workDir: state.workDir,
            lastAccess: new Date(state.lastAccess).toISOString(),
            createdAt: new Date(state.createdAt).toISOString(),
            lastRefreshAt: state.lastRefreshAt ? new Date(state.lastRefreshAt).toISOString() : null,
            lastError: state.lastError,
            downloadLoopState: state.downloadLoopState,
            syncIntervalMs: state.syncIntervalMs,
            consecutiveFailures: state.consecutiveFailures,
            lastProgressAt: new Date(state.lastProgressAt).toISOString(),
            nextRetryDelayMs: state.nextRetryDelayMs,
            streamInfo: state.streamInfo
              ? {
                url: state.streamInfo.url,
                isDrm: state.streamInfo.isDrm,
                licenseUrl: state.streamInfo.drm?.url ?? null,
              }
              : null,
            keys: state.keys.map((item) => ({ kid: item.kid, key: item.key })),
            audio: serializeTrackState(state.audio),
            video: serializeTrackState(state.video),
            outputFiles: await collectFiles(state.dirs.out),
          }
          : null,
      });
    } catch (e) {
      return responseForError(e, 500, true);
    }
  }

  if (method === "GET" && path.startsWith("/api/drm-manifest/")) {
    const requested = decodeURIComponent(path.slice("/api/drm-manifest/".length));
    try {
      await getChannels();
      const ch = resolveRequestedChannel(requested);
      if (!ch) return Response.json({ error: `unknown channel: ${requested}` }, { status: 404 });
      const state = drmStates.get(ch.id);
      if (state?.manifestXml && url.searchParams.get("force") !== "1") {
        return Response.json({
          channelId: ch.id,
          manifestUrl: state.streamInfo?.url ?? null,
          parsed: state.manifest,
          xml: state.manifestXml,
        });
      }
      const info = await getStreamInfo(ch.id, url.searchParams.get("force") === "1", contentIdFor(ch));
      if (!info.drm) return Response.json({ error: `channel ${requested} is not DRM` }, { status: 400 });
      const snapshot = await fetchMpdSnapshot(info.url);
      return Response.json({
        channelId: ch.id,
        manifestUrl: info.url,
        parsed: snapshot.parsed,
        xml: snapshot.xml,
      });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  if (method === "GET" && path.startsWith("/api/drm-log/")) {
    const requested = decodeURIComponent(path.slice("/api/drm-log/".length));
    try {
      await getChannels();
      const ch = resolveRequestedChannel(requested);
      if (!ch) return new Response(`unknown channel: ${requested}`, { status: 404 });
      const kind = url.searchParams.get("file") ?? "pipeline";
      const workDir = `${LIVE_DIR}/${ch.id}`;
      const filePath = kind === "stdout"
        ? `${workDir}/logs/packager.stdout.log`
        : kind === "stderr"
        ? `${workDir}/logs/packager.stderr.log`
        : `${workDir}/logs/pipeline.log`;
      const body = await readTextIfExists(filePath);
      if (body == null) return new Response("log not found", { status: 404 });
      return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    } catch (e) {
      return new Response((e as Error).message, { status: 500 });
    }
  }

  // Server-decrypted HLS for VLC / IPTV apps. /vlc/<id>/index.m3u8 is the public playlist,
  // and sibling files are Shaka Packager output files under the per-channel out/ directory.
  if (method === "GET" && path.startsWith("/vlc/")) {
    const rest = path.slice("/vlc/".length);
    const parts = rest.split("/").filter(Boolean);
    if (parts.length === 1 && parts[0].endsWith(".m3u8")) {
      const id = decodeURIComponent(parts[0].slice(0, -".m3u8".length));
      return Response.redirect(`http://${host}/vlc/${id}/index.m3u8`, 302);
    }
    if (parts.length < 2) return new Response("bad path", { status: 400 });
    const typedRoute = parts.length >= 3 &&
      VOYO_CONTENT_TYPES.includes(parts[0].toLowerCase() as typeof VOYO_CONTENT_TYPES[number]) &&
      /^\d+$/.test(parts[1]);
    const requested = decodeURIComponent(typedRoute ? `${parts[0]}/${parts[1]}` : parts[0]);
    const filename = (typedRoute ? parts.slice(2) : parts.slice(1)).join("/");
    try {
      await getChannels();
      const ch = resolveRequestedChannel(requested);
      if (!ch) return new Response(`unknown channel: ${requested}`, { status: 404 });
      if (filename === "index.m3u8") {
        const info = await getStreamInfo(ch.id, false, contentIdFor(ch));
        if (!info.isDrm) return await buildLivePlaylist(ch.id, url.origin);
        await ensureDrmState(ch.id);
        return await serveDrmOutputFile(ch.id, filename);
      }
      // Child playlists self-heal so clients polling only audio.m3u8/video.m3u8
      // recover after a rebuild instead of looping on 404. With a live pipeline,
      // serve from disk first — no upstream lookups on the healthy path. Without
      // one (torn down, or stale files left by a failed cleanup), restart it
      // before serving, keeping the non-DRM guard on this cold path only.
      if (filename.endsWith(".m3u8")) {
        const pipelineAlive = drmStates.has(ch.id) || drmStateStarts.has(ch.id);
        if (!pipelineAlive) {
          const info = await getStreamInfo(ch.id, false, contentIdFor(ch));
          if (info.isDrm) await ensureDrmState(ch.id);
          return await serveDrmOutputFile(ch.id, filename);
        }
        const res = await serveDrmOutputFile(ch.id, filename);
        if (res.status !== 404) return res;
        await ensureDrmState(ch.id);
        return await serveDrmOutputFile(ch.id, filename);
      }
      return await serveDrmOutputFile(ch.id, filename);
    } catch (e) {
      console.error(`[vlc] ${requested}/${filename}:`, (e as Error).message);
      return responseForPlaybackError(e);
    }
  }

  // JSON stream info for the in-browser player. For DRM channels, licenseUrl is /license/<id>
  // so the browser doesn't need the upstream Voyo bearer token.
  if (method === "GET" && path.startsWith("/api/stream/")) {
    const requested = decodeURIComponent(path.slice("/api/stream/".length));
    try {
      await getChannels();
      const ch = resolveRequestedChannel(requested);
      if (!ch) return Response.json({ error: `unknown channel: ${requested}` }, { status: 404 });
      const info = await getStreamInfo(ch.id, false, contentIdFor(ch));
      return Response.json({
        id: ch.id,
        routePath: publicRoutePathFor(ch),
        name: ch.name,
        manifestUrl: info.url,
        isDrm: info.isDrm,
        licenseUrl: info.drm ? `/license/${publicRoutePathFor(ch)}` : null,
      });
    } catch (e) {
      const ch = resolveRequestedChannel(requested);
      streamCache.delete(ch?.id ?? requested);
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  }

  // Widevine license proxy: forwards the challenge to Voyo's license server with the
  // saved Authorization headers, returns the binary license back to Shaka.
  if (method === "POST" && path.startsWith("/license/")) {
    const requested = decodeURIComponent(path.slice("/license/".length));
    try {
      await getChannels();
      const ch = resolveRequestedChannel(requested);
      if (!ch) return new Response(`unknown channel: ${requested}`, { status: 404 });
      let info = await getStreamInfo(ch.id, false, contentIdFor(ch));
      if (!info.drm) return new Response(`channel ${requested} is not DRM`, { status: 400 });
      const body = await req.arrayBuffer();
      let upstream = await fetch(info.drm.url, { method: "POST", headers: info.drm.headers, body });
      if (upstream.status === 401 || upstream.status === 403) {
        // Signed URL or token went stale — refresh once.
        info = await getStreamInfo(ch.id, true, contentIdFor(ch));
        if (info.drm) upstream = await fetch(info.drm.url, { method: "POST", headers: info.drm.headers, body });
      }
      const ct = upstream.headers.get("content-type") ?? "application/octet-stream";
      return new Response(upstream.body, { status: upstream.status, headers: { "Content-Type": ct } });
    } catch (e) {
      console.error(`[license] ${requested}:`, (e as Error).message);
      return new Response((e as Error).message, { status: 502 });
    }
  }

  if (method === "GET" && path.startsWith("/play/")) {
    return new Response(PLAY_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (method === "GET" && path === "/mosaic") {
    return new Response(MOSAIC_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (method === "GET" && path === "/proxy") {
    const target = url.searchParams.get("url");
    if (!target) return new Response("missing url", { status: 400 });
    try {
      const upstream = await fetch(target, { headers: proxyFetchHeaders(req) });
      const ct = upstream.headers.get("content-type");
      if (isM3u8(target, ct)) {
        const body = await upstream.text();
        return new Response(rewritePlaylist(body, target, url.origin), {
          status: upstream.status,
          headers: { "Content-Type": ct ?? "application/vnd.apple.mpegurl" },
        });
      }
      if (isDashManifest(target, ct)) {
        const body = await upstream.text();
        return new Response(rewriteDashManifest(body, target), {
          status: upstream.status,
          headers: { "Content-Type": ct ?? "application/dash+xml" },
        });
      }
      const headers = new Headers();
      for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"]) {
        const v = upstream.headers.get(h);
        if (v) headers.set(h, v);
      }
      return new Response(upstream.body, { status: upstream.status, headers });
    } catch (e) {
      return new Response((e as Error).message, { status: 502 });
    }
  }

  return new Response("not found", { status: 404 });
}

// === Inline UI ===
const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Voyo Live</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font: 14px/1.45 system-ui, -apple-system, sans-serif; margin: 0; background: #0f1115; color: #e6e9ef; }
  header { padding: 14px 20px; border-bottom: 1px solid #222; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; position: sticky; top: 0; background: #0f1115; z-index: 1; }
  header h1 { font-size: 16px; margin: 0; margin-right: auto; }
  .eventbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .eventbar input { width: min(460px, 44vw); padding: 7px 10px; border-radius: 6px; border: 1px solid #2a3142; background: #10141c; color: #d7e3ff; font: inherit; }
  button { background: #1e2230; border: 1px solid #2a3142; color: #e6e9ef; padding: 6px 12px; border-radius: 6px; cursor: pointer; font: inherit; }
  button:hover { background: #252b3c; }
  button:active { transform: translateY(1px); }
  .combo { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; opacity: .7; }
  .combo a { color: #8ab4f8; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 8px 14px; border-bottom: 1px solid #1a1d24; vertical-align: middle; }
  tr:hover td { background: #161922; }
  img.logo { width: 60px; height: 34px; object-fit: contain; border-radius: 4px; background: #fff; padding: 2px; }
  .name { font-weight: 500; }
  .lock { margin-left: 6px; opacity: .8; font-size: 12px; }
  .actions { text-align: right; white-space: nowrap; }
  .actions a { color: #8ab4f8; margin-right: 10px; font-size: 12px; text-decoration: none; }
  .actions a:hover { text-decoration: underline; }
  .meta { display: block; margin-top: 4px; font-size: 11px; opacity: .62; }
  .meta a { color: #8ab4f8; }
  .manual-url { display: block; width: min(420px, 46vw); margin-top: 8px; margin-left: auto; padding: 6px 8px; border: 1px solid #2a3142; border-radius: 6px; background: #0f1218; color: #d7e3ff; font: 11px/1.3 ui-monospace, SFMono-Regular, monospace; }
  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #2a3142; padding: 10px 18px; border-radius: 6px; opacity: 0; transition: opacity .2s; pointer-events: none; max-width: 80vw; overflow: hidden; text-overflow: ellipsis; }
  .toast.show { opacity: 1; }
  .empty { padding: 40px; text-align: center; opacity: .55; }
  .err { color: #f88; }
</style>
</head>
<body>
<header>
  <h1>Voyo Live</h1>
  <button id="refresh" title="Refresh channels list">↻ Refresh</button>
  <button id="relogin" title="Force a new login">🔑 Re-login</button>
  <button id="mosaic2" title="Open 2 selected channels in a 1x2 mosaic">▦ Mosaic 2</button>
  <span class="combo">VLC playlist: <a id="combo" href="/live.m3u8">/live.m3u8</a></span>
  <div class="eventbar">
    <input id="eventInput" type="text" placeholder="Paste Voyo event URL or content ID">
    <button id="addEvent" title="Add temporary Voyo event">＋ Add event</button>
  </div>
</header>
<table>
  <tbody id="rows"><tr><td colspan="3" class="empty">Loading…</td></tr></tbody>
</table>
<div id="toast" class="toast"></div>
<script>
const rows = document.getElementById('rows');
const toastEl = document.getElementById('toast');
function toast(msg, isErr) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('err', !!isErr);
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 2200);
}
async function load(force) {
  rows.innerHTML = '<tr><td colspan="3" class="empty">Loading…</td></tr>';
  try {
    const r = await fetch('/api/channels' + (force ? '?force=1' : ''));
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    render(data.channels);
  } catch (e) {
    rows.innerHTML = '<tr><td colspan="3" class="empty err">Error: ' + e.message + '</td></tr>';
  }
}
function render(channels) {
  if (!channels.length) { rows.innerHTML = '<tr><td colspan="3" class="empty">No channels yet — try Re-login then Refresh.</td></tr>'; return; }
  const isDrm = (c) => c.streamKind === 'drm' || (c.streamKind !== 'hls' && (c.kind === 'event' || /drm|cetin|widevine/i.test(c.name)));
  const routePath = (c) => {
    if (c.kind === 'event' && c.contentId) {
      const match = /^([a-z]+)[.-](\d+)$/i.exec(c.contentId);
      if (match) return match[1].toLowerCase() + '/' + match[2];
    }
    return c.id;
  };
  const canClipboard = !!(window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText);
  rows.innerHTML = channels.map(c => {
    const drm = isDrm(c);
    const route = routePath(c);
    const img = c.img ? '<img class="logo" src="' + c.img + '" loading="lazy" alt="">' : '';
    const lock = drm ? '<span class="lock" title="DRM — VLC link uses server-side decrypt via cdm.py">🔒</span>' : '';
    const marker = c.kind === 'event' ? '<span class="lock" title="Temporary manual event">📍</span>' : '';
    const meta = c.kind === 'event'
      ? '<span class="meta">' + (c.sourceUrl ? '<a href="' + c.sourceUrl + '" target="_blank">source</a>' : 'manual event') + (c.lastError ? ' • ' + c.lastError : '') + '</span>'
      : '';
    // For DRM channels the VLC-friendly URL is the server-decrypted /vlc/<id>/index.m3u8.
    const hls = drm ? '/vlc/' + route + '/index.m3u8' : '/live/' + route + '.m3u8';
    const fullHls = location.protocol + '//' + location.host + hls;
    const play = '/play/' + route;
    return '<tr>' +
      '<td style="width:80px">' + img + '</td>' +
      '<td><label><input type="checkbox" class="pick" data-id="' + c.id + '" data-name="' + c.name + '"> <span class="name">' + c.name + '</span>' + lock + marker + '</label>' + meta + '</td>' +
      '<td class="actions">' +
        '<a href="' + play + '" target="_blank">▶ Play</a>' +
        '<a href="' + hls + '" target="_blank" data-url="' + hls + '">' + (drm ? '.m3u8 (VLC)' : '.m3u8') + '</a>' +
        '<button data-action="copy" data-id="' + c.id + '" data-url="' + hls + '">' + (canClipboard ? '📋 Copy URL' : '📋 Select URL') + '</button>' +
        (c.kind === 'event' ? '<button data-action="remove-event" data-id="' + c.id + '">✕ Remove</button>' : '') +
        (canClipboard ? '' : '<input class="manual-url" type="text" readonly value="' + fullHls + '" data-manual-url>') +
      '</td>' +
    '</tr>';
  }).join('');
}
rows.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action][data-id]');
  if (!btn) return;
  if (btn.dataset.action === 'remove-event') {
    fetch('/api/events/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
        toast('Removed event');
        load(false);
      })
      .catch((err) => toast('Error: ' + err.message, true));
    return;
  }
  const url = location.protocol + '//' + location.host + (btn.dataset.url || '/live/' + btn.dataset.id + '.m3u8');
  if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('Copied: ' + url));
    return;
  }
  const input = btn.parentElement && btn.parentElement.querySelector('input[data-manual-url]');
  if (input) {
    input.focus();
    input.select();
    toast('Manual copy: selected URL');
  } else {
    toast(url);
  }
});
document.getElementById('addEvent').onclick = async () => {
  const input = document.getElementById('eventInput');
  const value = input.value.trim();
  if (!value) { toast('Paste a Voyo event URL or content ID', true); return; }
  try {
    const r = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
    input.value = '';
    toast('Added event: ' + data.entry.name);
    load(true);
  } catch (e) {
    toast('Error: ' + e.message, true);
  }
};
document.getElementById('eventInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('addEvent').click();
  }
});
document.getElementById('refresh').onclick = () => load(true);
document.getElementById('relogin').onclick = async () => {
  toast('Logging in…');
  try {
    const r = await fetch('/api/login', { method: 'POST' });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'login failed');
    toast('Logged in');
    load(true);
  } catch (e) { toast('Error: ' + e.message, true); }
};
document.getElementById('mosaic2').onclick = () => {
  const picked = [...document.querySelectorAll('input.pick:checked')].map(i => i.dataset.id);
  if (picked.length < 2) { toast('Tick at least 2 channels first', true); return; }
  window.open('/mosaic?ids=' + picked.slice(0, 2).join(','), '_blank');
};
load(false);
</script>
</body>
</html>`;

// Single-channel Shaka player with audio-output-device picker (setSinkId).
// Designed for OBS Window Capture: one channel per Chrome window, route audio to a
// per-channel virtual device (BlackHole on macOS, VB-CABLE on Windows), then have
// OBS pick that device as the audio source. Two windows → two OBS instances → two platforms.
const PLAY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Voyo Player</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.jsdelivr.net/npm/shaka-player@4.11.7/dist/shaka-player.compiled.min.js"></script>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #000; color: #ddd; font: 13px system-ui, -apple-system, sans-serif; }
  .wrap { display: flex; flex-direction: column; height: 100%; }
  video { flex: 1 1 auto; min-height: 0; background: #000; width: 100%; }
  .bar { display: flex; align-items: center; gap: 10px; padding: 6px 10px; background: #111; border-top: 1px solid #222; flex-wrap: wrap; }
  .bar select, .bar button { background: #1e2230; color: #ddd; border: 1px solid #2a3142; border-radius: 4px; padding: 4px 8px; font: inherit; cursor: pointer; }
  .bar select:hover, .bar button:hover { background: #252b3c; }
  .bar .name { margin-right: auto; font-weight: 500; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar label { display: inline-flex; align-items: center; gap: 6px; opacity: .85; }
  .status { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; opacity: .55; }
  .status.err { color: #f88; opacity: 1; }
  .diag { padding: 8px 10px; border-top: 1px solid #171717; background: #0b0b0b; color: #8ab4f8; font: 11px/1.45 ui-monospace, SFMono-Regular, monospace; white-space: pre-wrap; max-height: 132px; overflow: auto; }
  body.embed .bar { padding: 4px 6px; font-size: 11px; }
  body.embed .bar select, body.embed .bar button { padding: 2px 6px; font-size: 11px; }
  body.embed .diag { padding: 6px; font-size: 10px; max-height: 96px; }
</style>
</head>
<body>
<div class="wrap">
  <video id="v" autoplay muted playsinline controls></video>
  <div class="bar">
    <span class="name" id="name">…</span>
    <label>🔊 <select id="sink" title="Audio output device — pick a virtual device (BlackHole / VB-CABLE) per stream"></select></label>
    <button id="pickAudio" title="Grant mic to reveal device names">Reveal devices</button>
    <button id="mute">Unmute</button>
    <span class="status" id="status">…</span>
  </div>
  <div class="diag" id="diag">booting…</div>
</div>
<script>
(async () => {
  const earlyDiag = document.getElementById('diag');
  if (earlyDiag) earlyDiag.textContent = 'script started';
  window.addEventListener('error', (ev) => {
    if (earlyDiag) earlyDiag.textContent = 'window error: ' + (ev.message || 'unknown error');
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason);
    if (earlyDiag) earlyDiag.textContent = 'promise rejection: ' + reason;
  });
  if (new URLSearchParams(location.search).get('embed') === '1') document.body.classList.add('embed');
  const playPrefix = '/play/';
  const id = decodeURIComponent(location.pathname.startsWith(playPrefix)
    ? location.pathname.slice(playPrefix.length)
    : location.pathname);
  const nameEl = document.getElementById('name');
  const statusEl = document.getElementById('status');
  const diagEl = document.getElementById('diag');
  const sinkSel = document.getElementById('sink');
  const muteBtn = document.getElementById('mute');
  const pickBtn = document.getElementById('pickAudio');
  const video = document.getElementById('v');
  const setStatus = (s, err) => { statusEl.textContent = s; statusEl.classList.toggle('err', !!err); };
  const diagLines = [];
  const logDiag = (s) => {
    const line = '[' + new Date().toLocaleTimeString() + '] ' + s;
    diagLines.push(line);
    while (diagLines.length > 12) diagLines.shift();
    diagEl.textContent = diagLines.join('\\n');
    console.log('[play diag]', s);
  };
  const errText = (e) => {
    if (!e) return 'unknown error';
    if (typeof e === 'string') return e;
    if (e.message) return e.message;
    try { return JSON.stringify(e); } catch { return String(e); }
  };
  async function probeWidevine() {
    if (!window.isSecureContext) return { ok: false, reason: 'page is not a secure context' };
    if (typeof navigator.requestMediaKeySystemAccess !== 'function') {
      return { ok: false, reason: 'requestMediaKeySystemAccess unavailable' };
    }
    try {
      await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
        initDataTypes: ['cenc'],
        audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"' }],
        videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }],
        distinctiveIdentifier: 'optional',
        persistentState: 'optional',
        sessionTypes: ['temporary'],
      }]);
      return { ok: true, reason: 'granted' };
    } catch (e) {
      return { ok: false, reason: errText(e) };
    }
  }

  if (typeof shaka === 'undefined') { setStatus('shaka failed to load', true); return; }
  shaka.polyfill.installAll();
  if (!shaka.Player.isBrowserSupported()) { setStatus('browser not supported (need EME/MSE)', true); return; }
  logDiag('origin=' + location.origin + ' secure=' + window.isSecureContext);
  logDiag('ua=' + navigator.userAgent);

  setStatus('resolving…');
  let info;
  try {
    const r = await fetch('/api/stream/' + id.split('/').map(encodeURIComponent).join('/'));
    info = await r.json();
    if (!r.ok || info.error) throw new Error(info.error || ('HTTP ' + r.status));
  } catch (e) { setStatus(e.message, true); return; }
  nameEl.textContent = info.name || id;
  document.title = (info.name || id) + ' — Voyo';
  logDiag('manifest=' + info.manifestUrl);
  logDiag('drm=' + !!info.licenseUrl + (info.licenseUrl ? ' license=' + info.licenseUrl : ''));

  const player = new shaka.Player(video);
  let widevineProbe = null;
  if (info.licenseUrl) {
    player.configure({ drm: { servers: { 'com.widevine.alpha': info.licenseUrl } } });
    widevineProbe = await probeWidevine();
    logDiag('widevine probe=' + (widevineProbe.ok ? 'ok' : ('failed: ' + widevineProbe.reason)));
  }
  const ORIGIN = location.origin;
  const PROXY = ORIGIN + '/proxy?url=';
  const ne = player.getNetworkingEngine();
  ne.registerRequestFilter((type, request) => {
    if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
      logDiag('license request -> ' + request.uris.join(', '));
      return;
    }
    request.uris = request.uris.map((u) => {
      if (u.startsWith(ORIGIN)) return u;
      if (u.startsWith('/proxy?url=')) return ORIGIN + u;
      return PROXY + encodeURIComponent(u);
    });
  });
  ne.registerResponseFilter((type, response) => {
    if (type === shaka.net.NetworkingEngine.RequestType.LICENSE) {
      logDiag('license response <- ' + (response.uri || response.originalUri || 'unknown uri'));
    }
  });
  player.addEventListener('error', (e) => {
    const detail = e.detail || {};
    const extra = Array.isArray(detail.data)
      ? detail.data.map((v) => typeof v === 'string' ? v : JSON.stringify(v)).join(' | ')
      : '';
    logDiag('shaka error ' + detail.code + (extra ? ': ' + extra : ''));
    setStatus('shaka ' + detail.code + ': ' + extra, true);
  });

  setStatus('loading…');
  try {
    await player.load(info.manifestUrl);
    setStatus(info.isDrm ? 'DRM playing' : 'playing');
    logDiag('player.load ok');
  } catch (e) {
    const msg = errText(e);
    if (e && e.code === 6001) {
      const reason = widevineProbe && !widevineProbe.ok
        ? 'Widevine unavailable in this browser/runtime: ' + widevineProbe.reason
        : 'Widevine key system config unavailable in this browser/runtime';
      logDiag(reason);
      setStatus('load: ' + reason, true);
    } else if (e && e.code === 1001 && Array.isArray(e.data)) {
      const uri = e.data[0] || 'unknown uri';
      const status = e.data[1] || 'unknown status';
      const responseText = e.data[4] || '';
      const reason = 'HTTP failure ' + status + ' at ' + uri + (responseText ? ' :: ' + responseText : '');
      logDiag(reason);
      setStatus('load: ' + reason, true);
    } else {
      logDiag('load failed: ' + msg);
      setStatus('load: ' + msg, true);
    }
    return;
  }

  async function refreshSinks(prompt) {
    try {
      if (prompt) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(t => t.stop());
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outs = devices.filter(d => d.kind === 'audiooutput');
      const current = sinkSel.value;
      sinkSel.innerHTML = outs.map(d => '<option value="' + d.deviceId + '">' + (d.label || ('Device ' + d.deviceId.slice(0, 6))) + '</option>').join('');
      if (outs.some(d => d.deviceId === current)) sinkSel.value = current;
    } catch (e) { console.warn('refreshSinks', e); }
  }
  await refreshSinks(false);
  pickBtn.onclick = () => refreshSinks(true);
  sinkSel.onchange = async () => {
    if (typeof video.setSinkId !== 'function') { alert('setSinkId not supported (use Chrome/Edge)'); return; }
    try { await video.setSinkId(sinkSel.value); }
    catch (e) { alert('setSinkId failed: ' + e.message); }
  };
  muteBtn.onclick = () => { video.muted = !video.muted; muteBtn.textContent = video.muted ? 'Unmute' : 'Mute'; };
  navigator.mediaDevices.addEventListener('devicechange', () => refreshSinks(false));
})();
</script>
</body>
</html>`;

// Mosaic page: ?ids=channel-179,channel-183 → grid of N <iframe>s each loading /play/<id>?embed=1.
// Each iframe is fully independent (its own Shaka instance, its own setSinkId picker), so you can
// route each cell's audio to a different virtual device for separate OBS captures.
const MOSAIC_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Voyo Mosaic</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; background: #000; color: #ddd; font: 13px system-ui, -apple-system, sans-serif; }
  .grid { display: grid; height: 100%; gap: 2px; background: #222; }
  .grid.n1 { grid-template: 1fr / 1fr; }
  .grid.n2 { grid-template: 1fr / 1fr 1fr; }
  .grid.n3 { grid-template: 1fr 1fr / 1fr 1fr; }
  .grid.n4 { grid-template: 1fr 1fr / 1fr 1fr; }
  .grid.n5, .grid.n6 { grid-template: 1fr 1fr / 1fr 1fr 1fr; }
  .grid.n7, .grid.n8, .grid.n9 { grid-template: 1fr 1fr 1fr / 1fr 1fr 1fr; }
  iframe { width: 100%; height: 100%; border: 0; background: #000; }
  .empty { padding: 40px; text-align: center; opacity: .55; }
</style>
</head>
<body>
<div id="g" class="grid n1"></div>
<script>
const ids = (new URLSearchParams(location.search).get('ids') || '').split(',').map(s => s.trim()).filter(Boolean);
const g = document.getElementById('g');
if (!ids.length) {
  g.outerHTML = '<div class="empty">add ?ids=channel-X,channel-Y to the URL</div>';
} else {
  g.className = 'grid n' + Math.min(ids.length, 9);
  g.innerHTML = ids.map(id => '<iframe src="/play/' + id.split('/').map(encodeURIComponent).join('/') + '?embed=1" allow="autoplay; encrypted-media; microphone"></iframe>').join('');
}
</script>
</body>
</html>`;

// === Startup ===
{
  const loaded = await loadConfig();
  config = loaded.config;
  if (loaded.mutated) await saveConfig();
  await ensureCdmHealthy();
  await ensureMp4decrypt();
  await ensureShakaPackager();
  console.log(`Voyo v2 Shaka → http://localhost:${PORT}`);
  console.log(`UI Basic Auth → ${UI_BASIC_AUTH_USER}:${UI_BASIC_AUTH_PASS}`);
  console.log(`Live dir cleanup on shutdown → ${PRESERVE_LIVE_DIR ? "preserve" : "delete"}`);
  if (!config.credentials.username) {
    console.log(`⚠  add credentials to ${CONFIG_PATH} then restart`);
  }
  const shutdownController = new AbortController();
  let shuttingDown: Promise<void> | null = null;
  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      console.log(`[shutdown] ${signal} received`);
      shutdownController.abort();
      await disposeAllDrmStates(`${signal} received`, !PRESERVE_LIVE_DIR);
      console.log("[shutdown] cleanup complete");
      Deno.exit(0);
    })();
    return shuttingDown;
  };
  Deno.addSignalListener("SIGINT", () => {
    void gracefulShutdown("SIGINT");
  });
  Deno.addSignalListener("SIGTERM", () => {
    void gracefulShutdown("SIGTERM");
  });
  const server = Deno.serve({ port: PORT, signal: shutdownController.signal }, handle);
  await server.finished;
  if (!shuttingDown) {
    await disposeAllDrmStates("server stopped", !PRESERVE_LIVE_DIR);
  } else {
    await shuttingDown;
  }
}
